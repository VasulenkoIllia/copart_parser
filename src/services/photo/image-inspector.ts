import { imageSize } from "image-size";
import env from "../../config/env";
import { httpRequest } from "../../lib/http-client";
import { CheckedLotImage, ImageCheckStatus, ParsedLotImageLink } from "./types";

type AttemptType = "image_head" | "image_get";

type AttemptLogger = (
  attemptType: AttemptType,
  httpStatus: number | null,
  errorCode: string | null,
  errorMessage: string | null
) => Promise<void>;

function parseNumberHeader(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAcceptedImage(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  return contentType.toLowerCase().startsWith("image/");
}

function extensionAllowed(url: string): boolean {
  if (env.photo.acceptedExtensions.length === 0) {
    return true;
  }
  const clean = url.trim().toLowerCase();
  return env.photo.acceptedExtensions.some(ext => clean.endsWith(`.${ext}`));
}

function toStatusFromHttp(httpStatus: number | null): ImageCheckStatus {
  if (httpStatus === 404) {
    return "not_found";
  }
  if (httpStatus && httpStatus >= 200 && httpStatus < 300) {
    return "ok";
  }
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    return "bad_quality";
  }
  return "error";
}

function computeFullSize(
  _variant: ParsedLotImageLink["variant"],
  width: number | null,
  _height: number | null,
  _contentLength: number | null
): boolean {
  if (width === null) {
    return false;
  }
  return width >= env.photo.minWidth;
}

export async function inspectLotImage(
  image: ParsedLotImageLink,
  attemptLogger: AttemptLogger
): Promise<CheckedLotImage> {
  if (image.variant === "video") {
    return {
      ...image,
      httpStatus: 200,
      contentType: "video/mp4",
      contentLength: null,
      width: null,
      height: null,
      isFullSize: false,
      checkStatus: "ok",
      lastCheckedAt: new Date(),
    };
  }

  const cleanUrl = image.url.trim();
  let headStatus: number | null = null;
  let contentType: string | null = null;
  let contentLength: number | null = null;

  if (env.photo.validateByHeadFirst) {
    try {
      const headResponse = await httpRequest(
        {
          method: "HEAD",
          url: cleanUrl,
          timeout: env.photo.httpTimeoutMs,
          maxRedirects: 5,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
            Referer: "https://www.copart.com/",
          },
        },
        {
          retries: env.photo.imageRetries,
          retryDelayMs: 1000,
        }
      );

      headStatus = headResponse.status;
      contentType = (headResponse.headers["content-type"] as string | undefined) ?? null;
      contentLength = parseNumberHeader(headResponse.headers["content-length"]);
      await attemptLogger("image_head", headStatus, null, null);

      if (headStatus === 404) {
        return {
          ...image,
          url: cleanUrl,
          httpStatus: 404,
          contentType,
          contentLength,
          width: null,
          height: null,
          isFullSize: false,
          checkStatus: "not_found",
          lastCheckedAt: new Date(),
        };
      }

      if (headStatus >= 400 && headStatus < 500 && headStatus !== 405) {
        return {
          ...image,
          url: cleanUrl,
          httpStatus: headStatus,
          contentType,
          contentLength,
          width: null,
          height: null,
          isFullSize: false,
          checkStatus: "bad_quality",
          lastCheckedAt: new Date(),
        };
      }
    } catch (error) {
      await attemptLogger(
        "image_head",
        null,
        "HEAD_REQUEST_FAILED",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  let getStatus: number | null = null;
  let width: number | null = null;
  let height: number | null = null;

  try {
    const getResponse = await httpRequest<ArrayBuffer>(
      {
        method: "GET",
        url: cleanUrl,
        responseType: "arraybuffer",
        timeout: env.photo.httpTimeoutMs,
        maxRedirects: 5,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          Referer: "https://www.copart.com/",
          Range: "bytes=0-262143",
        },
      },
      {
        retries: env.photo.imageRetries,
        retryDelayMs: 1000,
      }
    );

    getStatus = getResponse.status;
    contentType =
      contentType ?? ((getResponse.headers["content-type"] as string | undefined) ?? null);
    contentLength =
      contentLength ??
      parseNumberHeader(getResponse.headers["content-length"]) ??
      parseNumberHeader(getResponse.headers["content-range"]);
    await attemptLogger("image_get", getStatus, null, null);

    if (getStatus === 404) {
      return {
        ...image,
        url: cleanUrl,
        httpStatus: getStatus,
        contentType,
        contentLength,
        width: null,
        height: null,
        isFullSize: false,
        checkStatus: "not_found",
        lastCheckedAt: new Date(),
      };
    }

    if (getStatus < 200 || getStatus >= 300) {
      return {
        ...image,
        url: cleanUrl,
        httpStatus: getStatus,
        contentType,
        contentLength,
        width: null,
        height: null,
        isFullSize: false,
        checkStatus: toStatusFromHttp(getStatus),
        lastCheckedAt: new Date(),
      };
    }

    if (!isAcceptedImage(contentType) || !extensionAllowed(cleanUrl)) {
      return {
        ...image,
        url: cleanUrl,
        httpStatus: getStatus,
        contentType,
        contentLength,
        width: null,
        height: null,
        isFullSize: false,
        checkStatus: "bad_quality",
        lastCheckedAt: new Date(),
      };
    }

    const buffer = Buffer.from(getResponse.data);
    const dimensions = imageSize(buffer);
    width = dimensions.width ?? null;
    height = dimensions.height ?? null;
  } catch (error) {
    await attemptLogger(
      "image_get",
      null,
      "GET_REQUEST_FAILED",
      error instanceof Error ? error.message : String(error)
    );
    return {
      ...image,
      url: cleanUrl,
      httpStatus: headStatus,
      contentType,
      contentLength,
      width: null,
      height: null,
      isFullSize: false,
      checkStatus: "error",
      lastCheckedAt: new Date(),
    };
  }

  const isFullSize = computeFullSize(image.variant, width, height, contentLength);
  const checkStatus: ImageCheckStatus =
    image.variant === "thumb" ? "ok" : isFullSize ? "ok" : "bad_quality";

  return {
    ...image,
    url: cleanUrl,
    httpStatus: getStatus ?? headStatus,
    contentType,
    contentLength,
    width,
    height,
    isFullSize,
    checkStatus,
    lastCheckedAt: new Date(),
  };
}
