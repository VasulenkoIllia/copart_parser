import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import env from "../../config/env";
import { logger } from "../../lib/logger";
import { ParsedLotImageLink } from "./types";

export type ParsedEndpointLinks = {
  fullLinks: ParsedLotImageLink[];
  hdLinks: ParsedLotImageLink[];
  otherLinks: ParsedLotImageLink[];
  imgCount: number;
};

const MMEMBER_HOST = "mmember.copart.com";
const MMEMBER_PATH = "/lots-api/v1/lot-details";

const MOBILE_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "MemberMobile/5 CFNetwork/3860.300.31 Darwin/25.2.0",
  devicename: "iPhone 16 Pro",
  sitecode: "CPRTUS",
  company: "COPART",
  os: "ios",
  languagecode: "en-US",
  clientappversion: "6.7.2",
  deviceid: "5FE63153-B6D9-458F-90FA-287A625BF6D4",
  "ins-sess": "F81006D1-92C3-4F58-A623-4F52711D5C13",
};

interface MmemberLotImage {
  url?: string;
  hdUrl?: string;
  thumbnailUrl?: string;
  sequenceNumber?: number;
  imageLabelCode?: string;
}

interface MmemberResponse {
  lotImages?: MmemberLotImage[];
}

function isVideoUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes("_vful.") || lower.includes("_vhrs.");
}

function isThumbUrl(url: string): boolean {
  return url.toLowerCase().includes("_thb.");
}

function parseMmemberResponse(lotNumber: number, payload: unknown): ParsedEndpointLinks {
  if (!payload || typeof payload !== "object") {
    return { fullLinks: [], hdLinks: [], otherLinks: [], imgCount: 0 };
  }

  const data = payload as MmemberResponse;
  const lotImages = Array.isArray(data.lotImages) ? data.lotImages : [];
  const imgCount = lotImages.length;

  const fullLinks: ParsedLotImageLink[] = [];
  const hdLinks: ParsedLotImageLink[] = [];

  for (const img of lotImages) {
    const sequence = typeof img.sequenceNumber === "number" ? img.sequenceNumber : 0;

    if (img.url) {
      const url = String(img.url).trim();
      if (url && !isVideoUrl(url) && !isThumbUrl(url)) {
        fullLinks.push({ lotNumber, sequence, variant: "full", url });
      }
    }

    if (img.hdUrl) {
      const url = String(img.hdUrl).trim();
      if (url && !isVideoUrl(url) && !isThumbUrl(url)) {
        hdLinks.push({ lotNumber, sequence, variant: "hd", url });
      }
    }
  }

  return { fullLinks, hdLinks, otherLinks: [], imgCount };
}

export async function fetchMmemberLotImages(lotNumber: number): Promise<ParsedEndpointLinks> {
  const proxyUrl = env.mmemberFallback.proxyUrl;
  const timeoutMs = env.mmemberFallback.timeoutMs;

  const body = JSON.stringify({ lotNumber });

  const requestOptions: https.RequestOptions = {
    hostname: MMEMBER_HOST,
    path: MMEMBER_PATH,
    method: "POST",
    headers: {
      ...MOBILE_HEADERS,
      "Content-Length": Buffer.byteLength(body),
    },
  };

  if (proxyUrl) {
    requestOptions.agent = new HttpsProxyAgent(proxyUrl) as unknown as https.Agent;
  }

  return new Promise<ParsedEndpointLinks>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      req.destroy(new Error(`mmember request timeout after ${timeoutMs}ms for lot ${lotNumber}`));
    }, timeoutMs);

    const req = https.request(requestOptions, res => {
      let rawData = "";
      res.on("data", (chunk: Buffer | string) => {
        rawData += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      });
      res.on("end", () => {
        clearTimeout(timeoutId);
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          reject(new Error(`mmember HTTP ${status} for lot ${lotNumber}`));
          return;
        }
        try {
          const parsed = JSON.parse(rawData) as unknown;
          resolve(parseMmemberResponse(lotNumber, parsed));
        } catch (err) {
          reject(
            new Error(
              `mmember JSON parse error for lot ${lotNumber}: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        }
      });
      res.on("error", (err: Error) => {
        clearTimeout(timeoutId);
        reject(err);
      });
    });

    req.on("error", (err: Error) => {
      clearTimeout(timeoutId);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

export function logMmemberStats(attempted: number, succeeded: number): void {
  if (attempted === 0) {
    return;
  }
  logger.info("mmember fallback stats", { attempted, succeeded, failed: attempted - succeeded });
}
