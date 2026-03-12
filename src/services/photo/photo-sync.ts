import env from "../../config/env";
import { getProxyPoolSnapshot, httpRequest, prepareProxyPool } from "../../lib/http-client";
import { logger } from "../../lib/logger";
import { normalizeCopartLotImagesUrl } from "../../lib/url-utils";
import { sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { withAppLock } from "../locks/db-lock";
import { inspectLotImage } from "./image-inspector";
import {
  calculateBackoffMinutes,
  completePhotoRunFailure,
  completePhotoRunSuccess,
  createPhotoRun,
  deriveVariant,
  fetchCachedGoodImages,
  fetchPhotoCandidates,
  hashUrl,
  logPhotoAttempt,
  markLotPhotoMissingOn404,
  markLotPhotoMissingTemporary,
  markLotPhotoOk,
  replaceLotImages,
  selectImagesForStorage,
  summarizeImageChecks,
} from "./photo-repository";
import {
  CheckedLotImage,
  LotImagesEndpointPayload,
  ParsedLotImageLink,
  PhotoLotCandidate,
  PhotoRunCounters,
  PhotoSyncExecutionResult,
  PhotoSyncRunSummary,
} from "./types";

function logLotResult(meta: Record<string, unknown>): void {
  if (!env.photo.logLotResults) {
    return;
  }
  logger.info("Photo lot result", meta);
}

function createCounters(): PhotoRunCounters {
  return {
    lotsScanned: 0,
    lotsProcessed: 0,
    lotsOk: 0,
    lotsMissing: 0,
    imagesUpserted: 0,
    imagesFullSize: 0,
    imagesBadQuality: 0,
    http404Count: 0,
    endpoint404Lots: 0,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function parseEndpointPayload(
  lotNumber: number,
  payload: unknown
): { links: ParsedLotImageLink[]; imgCount: number } {
  if (!isObject(payload)) {
    return { links: [], imgCount: 0 };
  }

  const data = payload as LotImagesEndpointPayload;
  const imgCount = typeof data.imgCount === "number" ? data.imgCount : 0;

  if (!Array.isArray(data.lotImages)) {
    return { links: [], imgCount };
  }

  const map = new Map<string, ParsedLotImageLink>();

  for (const lotImage of data.lotImages) {
    const sequence = Number.isFinite(Number(lotImage.sequence)) ? Number(lotImage.sequence) : 0;
    const links = Array.isArray(lotImage.link) ? lotImage.link : [];

    for (const link of links) {
      if (!link || !link.url) {
        continue;
      }

      const cleanUrl = String(link.url).trim();
      if (!cleanUrl) {
        continue;
      }

      const variant = deriveVariant(
        cleanUrl,
        Boolean(link.isThumbNail),
        Boolean(link.isHdImage),
        Boolean(link.isEngineSound)
      );

      // Performance mode: process only HD photos.
      if (variant !== "hd") {
        continue;
      }

      const key = `${sequence}:${cleanUrl}`;
      if (!map.has(key)) {
        map.set(key, {
          lotNumber,
          sequence,
          variant,
          url: cleanUrl,
        });
      }
    }
  }

  return { links: Array.from(map.values()), imgCount };
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  let index = 0;

  const runners = Array.from({ length: safeConcurrency }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      await worker(items[current]);
    }
  });

  await Promise.all(runners);
}

async function inspectParsedLinks(links: ParsedLotImageLink[]): Promise<CheckedLotImage[]> {
  if (links.length === 0) {
    return [];
  }

  const lotNumber = links[0].lotNumber;
  const cached = await fetchCachedGoodImages(lotNumber, links);
  const result: CheckedLotImage[] = [];

  for (const link of links) {
    const cacheKey = `${link.sequence}:${hashUrl(link.url)}`;
    const cachedHit = cached.get(cacheKey);
    if (cachedHit) {
      result.push(cachedHit);
      continue;
    }

    const checked = await inspectLotImage(link, async (attemptType, status, code, message) => {
      await logPhotoAttempt(link.lotNumber, link.url, attemptType, status, code, message);
    });
    result.push(checked);
  }

  return result;
}

async function processLot(candidate: PhotoLotCandidate, counters: PhotoRunCounters): Promise<void> {
  const lotStartedAt = Date.now();
  const endpointProtocol = env.proxy.mode === "direct" ? "https" : "http";
  const endpointUrl =
    normalizeCopartLotImagesUrl(candidate.imageUrl, {
      protocol: endpointProtocol,
      defaultCountry: "us",
      defaultBrand: "cprt",
      yardNumber: candidate.yardNumber,
      defaultYardNumber: 1,
    }) ??
    candidate.imageUrl;
  const logResult = (meta: Record<string, unknown>): void => {
    logLotResult({
      ...meta,
      lotDurationMs: Date.now() - lotStartedAt,
    });
  };

  let endpointStatus: number | null = null;
  try {
    const response = await httpRequest<unknown>(
      {
        method: "GET",
        url: endpointUrl,
        timeout: env.photo.httpTimeoutMs,
        maxRedirects: 5,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          Referer: "https://www.copart.com/",
        },
      },
      {
        retries: env.photo.endpointRetries,
        retryDelayMs: 1500,
      }
    );

    endpointStatus = response.status;
    await logPhotoAttempt(candidate.lotNumber, endpointUrl, "lot_images_endpoint", endpointStatus, null, null);

    if (endpointStatus === 404) {
      const backoff = calculateBackoffMinutes(candidate.photo404Count + 1);
      await markLotPhotoMissingOn404(candidate.lotNumber, backoff);
      logResult({
        lotNumber: candidate.lotNumber,
        status: "missing",
        reason: "endpoint_404",
        endpointStatus,
        backoffMinutes: backoff,
      });
      counters.lotsProcessed += 1;
      counters.lotsMissing += 1;
      counters.http404Count += 1;
      counters.endpoint404Lots += 1;
      return;
    }

    if (endpointStatus < 200 || endpointStatus >= 300) {
      const backoff = calculateBackoffMinutes(Math.max(1, candidate.photo404Count + 1));
      await markLotPhotoMissingTemporary(candidate.lotNumber, backoff);
      logResult({
        lotNumber: candidate.lotNumber,
        status: "missing",
        reason: "endpoint_non_2xx",
        endpointStatus,
        backoffMinutes: backoff,
      });
      counters.lotsProcessed += 1;
      counters.lotsMissing += 1;
      return;
    }

    const parsed = parseEndpointPayload(candidate.lotNumber, response.data);
    if (parsed.links.length === 0 || parsed.imgCount === 0) {
      const backoff = calculateBackoffMinutes(Math.max(1, candidate.photo404Count + 1));
      await markLotPhotoMissingTemporary(candidate.lotNumber, backoff);
      logResult({
        lotNumber: candidate.lotNumber,
        status: "missing",
        reason: "empty_payload",
        endpointStatus,
        imgCount: parsed.imgCount,
        parsedLinks: parsed.links.length,
        backoffMinutes: backoff,
      });
      counters.lotsProcessed += 1;
      counters.lotsMissing += 1;
      return;
    }

    const checkedLinks = await inspectParsedLinks(parsed.links);
    const storageImages = selectImagesForStorage(checkedLinks);
    await replaceLotImages(candidate.lotNumber, storageImages, "merge");

    const imageStats = summarizeImageChecks(checkedLinks);

    counters.imagesUpserted += storageImages.length;
    counters.imagesFullSize += storageImages.length;
    counters.imagesBadQuality += imageStats.badQuality;
    counters.http404Count += imageStats.notFound;

    if (storageImages.length > 0) {
      await markLotPhotoOk(candidate.lotNumber);
      logResult({
        lotNumber: candidate.lotNumber,
        status: "ok",
        endpointStatus,
        parsedLinks: parsed.links.length,
        storedGoodImages: storageImages.length,
        badQuality: imageStats.badQuality,
        notFound: imageStats.notFound,
      });
      counters.lotsOk += 1;
    } else {
      const backoff = calculateBackoffMinutes(Math.max(1, candidate.photo404Count + 1));
      await markLotPhotoMissingTemporary(candidate.lotNumber, backoff);
      logResult({
        lotNumber: candidate.lotNumber,
        status: "missing",
        reason: "no_valid_hd_images",
        endpointStatus,
        parsedLinks: parsed.links.length,
        storedGoodImages: storageImages.length,
        badQuality: imageStats.badQuality,
        notFound: imageStats.notFound,
        backoffMinutes: backoff,
      });
      counters.lotsMissing += 1;
    }

    counters.lotsProcessed += 1;
  } catch (error) {
    await logPhotoAttempt(
      candidate.lotNumber,
      endpointUrl,
      "lot_images_endpoint",
      endpointStatus,
      "ENDPOINT_EXCEPTION",
      error instanceof Error ? error.message : String(error)
    );
    const backoff = calculateBackoffMinutes(Math.max(1, candidate.photo404Count + 1));
    await markLotPhotoMissingTemporary(candidate.lotNumber, backoff);
    logResult({
      lotNumber: candidate.lotNumber,
      status: "missing",
      reason: "endpoint_exception",
      endpointStatus,
      backoffMinutes: backoff,
      error: error instanceof Error ? error.message : String(error),
    });
    counters.lotsProcessed += 1;
    counters.lotsMissing += 1;
  }
}

async function executePhotoSync(
  options: { notifySuccess?: boolean; notifyError?: boolean } = {}
): Promise<PhotoSyncRunSummary> {
  const startedAt = Date.now();
  const counters = createCounters();
  const runId = await createPhotoRun();

  try {
    const candidateFetchStartedAt = Date.now();
    const candidates = await fetchPhotoCandidates(env.photo.batchSize);
    counters.lotsScanned = candidates.length;
    const candidateFetchDurationMs = Date.now() - candidateFetchStartedAt;

    logger.info("Photo sync started", {
      lotsScanned: counters.lotsScanned,
      fetchConcurrency: env.photo.fetchConcurrency,
      batchSize: env.photo.batchSize,
      workerTotal: env.photo.workerTotal,
      workerIndex: env.photo.workerIndex,
      candidateFetchDurationMs,
    });

    await runWithConcurrency(candidates, env.photo.fetchConcurrency, async candidate => {
      await processLot(candidate, counters);

      if (
        counters.lotsProcessed > 0 &&
        (counters.lotsProcessed % env.photo.progressEveryLots === 0 ||
          counters.lotsProcessed === counters.lotsScanned)
      ) {
        const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
        logger.info("Photo sync progress", {
          lotsScanned: counters.lotsScanned,
          lotsProcessed: counters.lotsProcessed,
          lotsRemaining: Math.max(0, counters.lotsScanned - counters.lotsProcessed),
          lotsOk: counters.lotsOk,
          lotsMissing: counters.lotsMissing,
          imagesUpserted: counters.imagesUpserted,
          http404Count: counters.http404Count,
          elapsedSec,
          lotsPerMin: Number(((counters.lotsProcessed / elapsedSec) * 60).toFixed(2)),
        });
      }
    });

    await completePhotoRunSuccess(runId, counters);

    const durationMs = Date.now() - startedAt;
    logger.info("Photo sync finished", {
      lotsScanned: counters.lotsScanned,
      lotsProcessed: counters.lotsProcessed,
      lotsOk: counters.lotsOk,
      lotsMissing: counters.lotsMissing,
      imagesUpserted: counters.imagesUpserted,
      imagesFullSize: counters.imagesFullSize,
      imagesBadQuality: counters.imagesBadQuality,
      http404Count: counters.http404Count,
      durationMs,
      lotsPerMin:
        durationMs > 0 ? Number(((counters.lotsProcessed / durationMs) * 60_000).toFixed(2)) : 0,
      imagesPerMin:
        durationMs > 0 ? Number(((counters.imagesUpserted / durationMs) * 60_000).toFixed(2)) : 0,
    });

    const summary: PhotoSyncRunSummary = {
      runId,
      mode: "sync",
      workerTotal: env.photo.workerTotal,
      workerIndex: env.photo.workerIndex,
      lotsScanned: counters.lotsScanned,
      lotsProcessed: counters.lotsProcessed,
      lotsOk: counters.lotsOk,
      lotsMissing: counters.lotsMissing,
      imagesUpserted: counters.imagesUpserted,
      imagesFullSize: counters.imagesFullSize,
      imagesBadQuality: counters.imagesBadQuality,
      http404Count: counters.http404Count,
      endpoint404Lots: counters.endpoint404Lots,
      durationMs,
    };

    if ((options.notifySuccess ?? true) && env.telegram.sendSuccessSummary) {
      await sendTelegramMessage(
        [
          "[PHOTO SYNC] success",
          `lots_scanned=${counters.lotsScanned}`,
          `lots_processed=${counters.lotsProcessed}`,
          `lots_ok=${counters.lotsOk}`,
          `lots_missing=${counters.lotsMissing}`,
          `images_upserted=${counters.imagesUpserted}`,
          `images_full_size=${counters.imagesFullSize}`,
          `images_bad_quality=${counters.imagesBadQuality}`,
          `http_404_count=${counters.http404Count}`,
          `endpoint_404_lots=${counters.endpoint404Lots}`,
        ].join("\n")
      );
    }

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;
    await completePhotoRunFailure(runId, counters, message);
    logger.error("Photo sync failed", {
      message,
      durationMs,
      counters,
    });
    if (options.notifyError ?? true) {
      await sendTelegramError("PHOTO SYNC FAILED", error);
    }
    throw error;
  }
}

export async function runPhotoSync(
  options: { notifySuccess?: boolean; notifyError?: boolean } = {}
): Promise<PhotoSyncExecutionResult> {
  const lockName =
    env.photo.workerTotal > 1 ? `photo_sync_worker_${env.photo.workerIndex}` : "photo_sync";
  const locked = await withAppLock(lockName, async () => {
    await prepareProxyPool("photo_sync_start", true);
    const proxySnapshot = getProxyPoolSnapshot();
    logger.info("Photo sync proxy pool ready", {
      mode: proxySnapshot.mode,
      configured: proxySnapshot.configured,
      selected: proxySnapshot.selected,
      preflightEnabled: proxySnapshot.preflightEnabled,
      preflightCompleted: proxySnapshot.preflightCompleted,
    });

    return executePhotoSync(options);
  });
  if (locked === null) {
    logger.warn("Photo sync skipped because another run owns the lock", {
      lockName,
      workerTotal: env.photo.workerTotal,
      workerIndex: env.photo.workerIndex,
    });
    return { executed: false };
  }
  return {
    executed: true,
    summary: locked,
  };
}
