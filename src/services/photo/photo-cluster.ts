import { spawn } from "child_process";
import axios from "axios";
import { RowDataPacket } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";
import { getActiveProxyUrls, prepareProxyPoolWithHealthcheck } from "../../lib/http-client";
import { logger } from "../../lib/logger";
import { normalizeCopartLotImagesUrl } from "../../lib/url-utils";

interface WorkerRunResult {
  workerIndex: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

interface LotProbeRow extends RowDataPacket {
  lot_number: number;
  yard_number: number | null;
  image_url: string | null;
}

interface LotImagesLink {
  url?: string;
  isThumbNail?: boolean;
  isHdImage?: boolean;
  isEngineSound?: boolean;
}

interface LotImagesPayload {
  lotImages?: Array<{
    sequence?: number;
    link?: LotImagesLink[];
  }>;
}

function scoreLink(link: LotImagesLink): number {
  if (link.isEngineSound) {
    return 0;
  }
  if (link.isThumbNail) {
    return 1;
  }
  if (link.isHdImage) {
    return 4;
  }
  return 3;
}

function pickSamplePhotoUrl(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const data = payload as LotImagesPayload;
  if (!Array.isArray(data.lotImages)) {
    return null;
  }

  const candidates: Array<{ url: string; score: number }> = [];
  for (const image of data.lotImages) {
    if (!Array.isArray(image.link)) {
      continue;
    }
    for (const link of image.link) {
      const cleanUrl = (link?.url ?? "").trim();
      if (!cleanUrl) {
        continue;
      }
      candidates.push({ url: cleanUrl, score: scoreLink(link) });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].url;
}

async function resolvePhotoHealthcheckUrlFromLots(): Promise<string | null> {
  const pool = getPool();
  const [rows] = await pool.query<LotProbeRow[]>(
    `
      SELECT lot_number, yard_number, image_url
      FROM \`${env.mysql.databaseCore}\`.\`lots\`
      WHERE image_url IS NOT NULL
      ORDER BY last_seen_at DESC
      LIMIT ?
    `,
    [env.proxy.autoSelectProbeLots]
  );

  for (const row of rows) {
    const endpointUrl = normalizeCopartLotImagesUrl(String(row.image_url), {
      protocol: "https",
      defaultCountry: "us",
      defaultBrand: "cprt",
      yardNumber: row.yard_number === null ? null : Number(row.yard_number),
      defaultYardNumber: 1,
    });

    if (!endpointUrl) {
      continue;
    }

    try {
      const response = await axios.request({
        method: "GET",
        url: endpointUrl,
        timeout: env.photo.httpTimeoutMs,
        maxRedirects: 5,
        proxy: false,
        validateStatus: () => true,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          Referer: "https://www.copart.com/",
        },
      });

      if (response.status < 200 || response.status >= 300) {
        continue;
      }

      const samplePhotoUrl = pickSamplePhotoUrl(response.data);
      if (samplePhotoUrl) {
        return samplePhotoUrl;
      }
    } catch {
      // Skip this lot and try next probe candidate.
    }
  }

  return null;
}

async function buildWorkerProxyOverrides(): Promise<Record<string, string>> {
  if (env.proxy.mode === "direct" || !env.proxy.autoSelectForPhoto) {
    return {};
  }

  const samplePhotoUrl = await resolvePhotoHealthcheckUrlFromLots();
  if (!samplePhotoUrl) {
    logger.warn("Photo cluster auto proxy selection skipped: no sample photo URL resolved", {
      probeLots: env.proxy.autoSelectProbeLots,
    });
    return {};
  }

  await prepareProxyPoolWithHealthcheck("photo_cluster_auto_select", true, samplePhotoUrl);
  const selectedProxyUrls = getActiveProxyUrls();

  if (selectedProxyUrls.length === 0 && env.proxy.mode === "proxy") {
    throw new Error("Photo cluster auto proxy selection failed: no healthy proxies selected");
  }

  logger.info("Photo cluster auto proxy selection completed", {
    samplePhotoUrl,
    configured: env.proxy.list.length,
    selected: selectedProxyUrls.length,
    topN: env.proxy.preflightTopN,
    minWorking: env.proxy.preflightMinWorking,
    timeoutMs: env.proxy.preflightTimeoutMs,
    concurrency: env.proxy.preflightConcurrency,
  });

  return {
    PROXY_LIST: selectedProxyUrls.join(","),
    PROXY_LIST_FILE: "",
    PROXY_PREFLIGHT_ENABLED: "false",
  };
}

function runWorker(
  workerIndex: number,
  workerTotal: number,
  workerEnvOverrides: Record<string, string>
): Promise<WorkerRunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [process.argv[1], "photo:sync"], {
      env: {
        ...process.env,
        ...workerEnvOverrides,
        PHOTO_WORKER_TOTAL: String(workerTotal),
        PHOTO_WORKER_INDEX: String(workerIndex),
      },
      stdio: "inherit",
    });

    child.once("error", error => {
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      resolve({
        workerIndex,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export async function runPhotoCluster(): Promise<void> {
  const workerTotal = env.photo.workerTotal;
  if (workerTotal < 1) {
    throw new Error("PHOTO_WORKER_TOTAL must be >= 1 for photo:cluster");
  }

  const workerEnvOverrides = await buildWorkerProxyOverrides();

  logger.info("Photo cluster started", {
    workerTotal,
    fetchConcurrencyPerWorker: env.photo.fetchConcurrency,
    batchSizePerWorker: env.photo.batchSize,
    sharding: "MOD(CRC32(CAST(lot_number AS CHAR)), workerTotal) = workerIndex",
    proxyAutoSelectForPhoto: env.proxy.autoSelectForPhoto,
  });

  const startedAt = Date.now();
  const workerPromises: Promise<WorkerRunResult>[] = [];
  for (let workerIndex = 0; workerIndex < workerTotal; workerIndex += 1) {
    workerPromises.push(runWorker(workerIndex, workerTotal, workerEnvOverrides));
  }

  const results = await Promise.all(workerPromises);
  const failed = results.filter(result => result.exitCode !== 0);

  logger.info("Photo cluster finished", {
    workerTotal,
    durationMs: Date.now() - startedAt,
    workerResults: results.map(result => ({
      workerIndex: result.workerIndex,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
    })),
  });

  if (failed.length > 0) {
    throw new Error(
      `photo:cluster failed: ${failed.length}/${workerTotal} workers exited with non-zero code`
    );
  }
}
