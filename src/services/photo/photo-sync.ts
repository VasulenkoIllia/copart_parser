import env from "../../config/env";
import { getProxyPoolSnapshot, httpRequest, prepareProxyPool } from "../../lib/http-client";
import { logger } from "../../lib/logger";
import { normalizeCopartLotImagesUrl } from "../../lib/url-utils";
import { sendTelegramDocuments, sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { withAppLock, withAppLocks } from "../locks/db-lock";
import { getPhotoSyncLockName, LOTS_MEDIA_GATE_LOCK, PIPELINE_REFRESH_LOCK } from "../locks/lock-names";
import { inspectLotImage } from "./image-inspector";
import { fetchMmemberLotImages, logMmemberStats } from "./mmember-client";
import {
  calculateBackoffMinutes,
  clearLotImages,
  completePhotoRunFailure,
  completePhotoRunSuccess,
  createPhotoRun,
  fetchCachedGoodImages,
  fetchPhotoCandidateByLotNumber,
  fetchPhotoCandidates,
  hashUrl,
  logPhotoAttempt,
  markLotPhotoMissingOn404,
  markLotPhotoMissingTemporary,
  markLotPhotoOk,
  replaceLotImages,
  selectImagesForStorage,
  summarizeImageChecks,
  PhotoCandidateMode,
} from "./photo-repository";
import { cleanupReportFiles } from "../reports/csv-report";
import { tryCreatePhoto404ReportForRun } from "../reports/run-artifacts";
import { GeneratedReportFile } from "../reports/types";
import {
  CheckedLotImage,
  LotImagesEndpointPayload,
  ParsedLotImageLink,
  PhotoLotCandidate,
  PhotoRunCounters,
  PhotoSyncExecutionResult,
  PhotoSyncRunSummary,
} from "./types";

interface ProcessLotOptions {
  storageMode?: "replace" | "merge";
}

type ParsedEndpointLinks = {
  fullLinks: ParsedLotImageLink[];
  hdLinks: ParsedLotImageLink[];
  otherLinks: ParsedLotImageLink[];
  imgCount: number;
};

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
    photoLinksProcessed: 0,
    lotsOk: 0,
    lotsMissing: 0,
    imagesUpserted: 0,
    imagesInserted: 0,
    imagesUpdated: 0,
    imagesFullSize: 0,
    imagesStoredHd: 0,
    imagesStoredFull: 0,
    imagesBadQuality: 0,
    http404Count: 0,
    endpoint404Lots: 0,
    mmemberFallbackAttempted: 0,
    mmemberFallbackOk: 0,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function stripUrlQueryAndHash(url: string): string {
  const hashIndex = url.indexOf("#");
  const withoutHash = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  return queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
}

function isFullSuffixImageUrl(url: string): boolean {
  const normalized = stripUrlQueryAndHash(url.trim().toLowerCase());
  return /_ful\.(jpg|jpeg|png|webp)$/.test(normalized);
}

function isHdSuffixImageUrl(url: string): boolean {
  const normalized = stripUrlQueryAndHash(url.trim().toLowerCase());
  return /_hrs\.(jpg|jpeg|png|webp)$/.test(normalized);
}

function isThumbSuffixImageUrl(url: string): boolean {
  const normalized = stripUrlQueryAndHash(url.trim().toLowerCase());
  return normalized.includes("_thb.");
}

function hasAcceptedImageExtension(url: string): boolean {
  const normalized = stripUrlQueryAndHash(url.trim().toLowerCase());
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === normalized.length - 1) {
    return false;
  }
  const extension = normalized.slice(dotIndex + 1);
  return env.photo.acceptedExtensions.some(item => item.toLowerCase() === extension);
}

function parseEndpointPayload(
  lotNumber: number,
  payload: unknown
): ParsedEndpointLinks {
  if (!isObject(payload)) {
    return { fullLinks: [], hdLinks: [], otherLinks: [], imgCount: 0 };
  }

  const data = payload as LotImagesEndpointPayload;
  const imgCount = typeof data.imgCount === "number" ? data.imgCount : 0;

  if (!Array.isArray(data.lotImages)) {
    return { fullLinks: [], hdLinks: [], otherLinks: [], imgCount };
  }

  const fullMap = new Map<string, ParsedLotImageLink>();
  const hdMap = new Map<string, ParsedLotImageLink>();
  const otherMap = new Map<string, ParsedLotImageLink>();

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

      const normalized = stripUrlQueryAndHash(cleanUrl.toLowerCase());
      if (Boolean(link.isEngineSound) || normalized.endsWith(".mp4")) {
        continue;
      }
      if (Boolean(link.isThumbNail) || isThumbSuffixImageUrl(cleanUrl)) {
        continue;
      }

      const key = `${sequence}:${cleanUrl}`;

      let targetMap: Map<string, ParsedLotImageLink> | null = null;
      let variant: ParsedLotImageLink["variant"] | null = null;
      if (isFullSuffixImageUrl(cleanUrl)) {
        targetMap = fullMap;
        variant = "full";
      } else if (Boolean(link.isHdImage) || isHdSuffixImageUrl(cleanUrl)) {
        targetMap = hdMap;
        variant = "hd";
      } else if (hasAcceptedImageExtension(cleanUrl)) {
        targetMap = otherMap;
        variant = "unknown";
      }

      if (!targetMap || !variant) {
        continue;
      }

      if (!targetMap.has(key)) {
        targetMap.set(key, {
          lotNumber,
          sequence,
          variant,
          url: cleanUrl,
        });
      }
    }
  }

  const allFullLinks = Array.from(fullMap.values());
  const hdLinks = Array.from(hdMap.values());
  const otherLinks = Array.from(otherMap.values());

  return {
    fullLinks: allFullLinks,
    hdLinks,
    otherLinks,
    imgCount,
  };
}

function countParsedLinks(parsed: ParsedEndpointLinks): number {
  return parsed.fullLinks.length + parsed.hdLinks.length + parsed.otherLinks.length;
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

interface Semaphore {
  acquire: () => Promise<void>;
  release: () => void;
}

function createSemaphore(limit: number): Semaphore {
  let count = 0;
  const queue: Array<() => void> = [];
  return {
    acquire(): Promise<void> {
      return new Promise<void>(resolve => {
        if (count < limit) {
          count++;
          resolve();
        } else {
          queue.push(() => {
            count++;
            resolve();
          });
        }
      });
    },
    release(): void {
      count--;
      const next = queue.shift();
      if (next) {
        next();
      }
    },
  };
}

const mmemberSemaphore: Semaphore = createSemaphore(env.mmemberFallback.concurrency);

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

function toSummary(
  runId: number,
  counters: PhotoRunCounters,
  durationMs: number,
  http404Report: GeneratedReportFile | null
): PhotoSyncRunSummary {
  return {
    runId,
    mode: "sync",
    workerTotal: env.photo.workerTotal,
    workerIndex: env.photo.workerIndex,
    lotsScanned: counters.lotsScanned,
    lotsProcessed: counters.lotsProcessed,
    photoLinksProcessed: counters.photoLinksProcessed,
    lotsOk: counters.lotsOk,
    lotsMissing: counters.lotsMissing,
    imagesUpserted: counters.imagesUpserted,
    imagesInserted: counters.imagesInserted,
    imagesUpdated: counters.imagesUpdated,
    imagesFullSize: counters.imagesFullSize,
    imagesStoredHd: counters.imagesStoredHd,
    imagesStoredFull: counters.imagesStoredFull,
    imagesBadQuality: counters.imagesBadQuality,
    http404Count: counters.http404Count,
    endpoint404Lots: counters.endpoint404Lots,
    mmemberFallbackAttempted: counters.mmemberFallbackAttempted,
    mmemberFallbackOk: counters.mmemberFallbackOk,
    durationMs,
    http404Report,
  };
}

async function processLot(
  candidate: PhotoLotCandidate,
  counters: PhotoRunCounters,
  options: ProcessLotOptions = {}
): Promise<void> {
  const storageMode = options.storageMode ?? "merge";
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
  let endpointErrorMessage: string | null = null;
  try {
    let inventoryPayload: unknown = null;
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
      inventoryPayload = response.data;
      await logPhotoAttempt(candidate.lotNumber, endpointUrl, "lot_images_endpoint", endpointStatus, null, null);
    } catch (error) {
      endpointErrorMessage = error instanceof Error ? error.message : String(error);
      await logPhotoAttempt(
        candidate.lotNumber,
        endpointUrl,
        "lot_images_endpoint",
        endpointStatus,
        "ENDPOINT_EXCEPTION",
        endpointErrorMessage
      );
    }

    let parsed: ParsedEndpointLinks =
      endpointStatus !== null && endpointStatus >= 200 && endpointStatus < 300
        ? parseEndpointPayload(candidate.lotNumber, inventoryPayload)
        : { fullLinks: [], hdLinks: [], otherLinks: [], imgCount: 0 };
    let parsedSource: "inventoryv2" | "mmember" = "inventoryv2";

    // Detect inventoryv2 EMPTY bug: 2xx response with imgCount > 0 but no images in lotImages[]
    // This affects ~1000 older lots (path 0226/ and earlier). Fallback to mmember mobile API.
    const isInventoryv2Empty =
      endpointStatus !== null &&
      endpointStatus >= 200 &&
      endpointStatus < 300 &&
      parsed.imgCount > 0 &&
      countParsedLinks(parsed) === 0;

    if (
      isInventoryv2Empty &&
      env.mmemberFallback.enabled &&
      candidate.photo404Count >= env.mmemberFallback.minAttempts
    ) {
      await mmemberSemaphore.acquire();
      try {
        const mmemberResult = await fetchMmemberLotImages(candidate.lotNumber);
        if (countParsedLinks(mmemberResult) > 0) {
          parsed = mmemberResult;
          parsedSource = "mmember";
          counters.mmemberFallbackOk += 1;
        }
        counters.mmemberFallbackAttempted += 1;
      } catch (err) {
        counters.mmemberFallbackAttempted += 1;
        logger.warn("mmember fallback error", {
          lotNumber: candidate.lotNumber,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        mmemberSemaphore.release();
      }
    }

    const supportedLinksCount = countParsedLinks(parsed);
    if (supportedLinksCount === 0 || parsed.imgCount === 0) {
      if (storageMode === "replace") {
        await clearLotImages(candidate.lotNumber);
      }
      const backoff = calculateBackoffMinutes(Math.max(1, candidate.photo404Count + 1));
      if (endpointStatus === 404) {
        await markLotPhotoMissingOn404(candidate.lotNumber, backoff);
      } else {
        await markLotPhotoMissingTemporary(candidate.lotNumber, backoff);
      }

      const reason =
        endpointStatus === 404
          ? "endpoint_404"
          : endpointStatus !== null && (endpointStatus < 200 || endpointStatus >= 300)
            ? "endpoint_non_2xx"
            : endpointErrorMessage
              ? "endpoint_exception"
              : isInventoryv2Empty
                ? "empty_payload_mmember_failed"
                : "empty_payload";

      logResult({
        lotNumber: candidate.lotNumber,
        status: "missing",
        reason,
        endpointStatus,
        imgCount: parsed.imgCount,
        parsedHdLinks: parsed.hdLinks.length,
        parsedFullLinks: parsed.fullLinks.length,
        parsedOtherLinks: parsed.otherLinks.length,
        linksSource: parsedSource,
        backoffMinutes: backoff,
      });
      counters.lotsProcessed += 1;
      counters.lotsMissing += 1;
      if (endpointStatus === 404) {
        counters.http404Count += 1;
        counters.endpoint404Lots += 1;
      }
      return;
    }

    let checkedLinks: CheckedLotImage[] = [];
    let storageImages: CheckedLotImage[] = [];
    let selectedTier: "full" | "hd" | "other" | "none" = "none";

    const tryTier = async (
      tier: "full" | "hd" | "other",
      links: ParsedLotImageLink[],
      acceptedVariants: Array<CheckedLotImage["variant"]>
    ): Promise<boolean> => {
      if (links.length === 0) {
        return false;
      }
      const checked = await inspectParsedLinks(links);
      counters.photoLinksProcessed += checked.length;
      checkedLinks = [...checkedLinks, ...checked];
      const selected = selectImagesForStorage(checked).filter(image =>
        acceptedVariants.includes(image.variant)
      );
      if (selected.length === 0) {
        return false;
      }
      storageImages = selected;
      selectedTier = tier;
      return true;
    };

    if (!(await tryTier("full", parsed.fullLinks, ["full"]))) {
      if (!(await tryTier("hd", parsed.hdLinks, ["hd"]))) {
        await tryTier("other", parsed.otherLinks, ["unknown", "full"]);
      }
    }

    const replaceSummary = await replaceLotImages(
      candidate.lotNumber,
      storageImages,
      storageImages.length > 0 ? "replace" : storageMode
    );

    const imageStats = summarizeImageChecks(checkedLinks);

    counters.imagesUpserted += storageImages.length;
    counters.imagesInserted += replaceSummary.inserted;
    counters.imagesUpdated += replaceSummary.updated;
    counters.imagesFullSize += storageImages.length;
    counters.imagesStoredHd += storageImages.filter(image => image.variant === "hd").length;
    counters.imagesStoredFull += storageImages.filter(
      image => image.variant === "full" || image.variant === "unknown"
    ).length;
    counters.imagesBadQuality += imageStats.badQuality;
    counters.http404Count += imageStats.notFound;

    if (storageImages.length > 0) {
      const storedVariant = storageImages[0]?.variant ?? "unknown";
      await markLotPhotoOk(candidate.lotNumber);
      logResult({
        lotNumber: candidate.lotNumber,
        status: "ok",
        endpointStatus,
        parsedHdLinks: parsed.hdLinks.length,
        parsedFullLinks: parsed.fullLinks.length,
        parsedOtherLinks: parsed.otherLinks.length,
        linksSource: parsedSource,
        selectedTier,
        storedGoodImages: storageImages.length,
        storedVariant,
        insertedImages: replaceSummary.inserted,
        updatedImages: replaceSummary.updated,
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
        reason: "no_valid_full_hd_or_other_images",
        endpointStatus,
        parsedHdLinks: parsed.hdLinks.length,
        parsedFullLinks: parsed.fullLinks.length,
        parsedOtherLinks: parsed.otherLinks.length,
        linksSource: parsedSource,
        selectedTier,
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
  options: {
    notifySuccess?: boolean;
    notifyError?: boolean;
    build404Report?: boolean;
    candidateMode?: PhotoCandidateMode;
  } = {}
): Promise<PhotoSyncRunSummary> {
  const startedAt = Date.now();
  const counters = createCounters();
  const runId = await createPhotoRun();
  let http404Report: GeneratedReportFile | null = null;

  try {
    const candidateFetchStartedAt = Date.now();
    const candidates = await fetchPhotoCandidates(env.photo.batchSize, {
      mode: options.candidateMode ?? "default",
    });
    counters.lotsScanned = candidates.length;
    const candidateFetchDurationMs = Date.now() - candidateFetchStartedAt;

    logger.info("Photo sync started", {
      lotsScanned: counters.lotsScanned,
      fetchConcurrency: env.photo.fetchConcurrency,
      batchSize: env.photo.batchSize,
      workerTotal: env.photo.workerTotal,
      workerIndex: env.photo.workerIndex,
      candidateMode: options.candidateMode ?? "default",
      candidateFetchDurationMs,
    });

    await runWithConcurrency(candidates, env.photo.fetchConcurrency, async candidate => {
      await processLot(candidate, counters, {
      });

      if (
        counters.lotsProcessed > 0 &&
        (counters.lotsProcessed % env.photo.progressEveryLots === 0 ||
          counters.lotsProcessed === counters.lotsScanned)
      ) {
        const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
        logger.info("Photo sync progress", {
          lotsScanned: counters.lotsScanned,
          lotsProcessed: counters.lotsProcessed,
          photoLinksProcessed: counters.photoLinksProcessed,
          lotsRemaining: Math.max(0, counters.lotsScanned - counters.lotsProcessed),
          lotsOk: counters.lotsOk,
          lotsMissing: counters.lotsMissing,
          imagesUpserted: counters.imagesUpserted,
          imagesInserted: counters.imagesInserted,
          imagesUpdated: counters.imagesUpdated,
          imagesStoredHd: counters.imagesStoredHd,
          imagesStoredFull: counters.imagesStoredFull,
          http404Count: counters.http404Count,
          elapsedSec,
          lotsPerMin: Number(((counters.lotsProcessed / elapsedSec) * 60).toFixed(2)),
        });
      }
    });

    await completePhotoRunSuccess(runId, counters);
    logMmemberStats(counters.mmemberFallbackAttempted, counters.mmemberFallbackOk);

    const shouldBuild404Report =
      options.build404Report ?? ((options.notifySuccess ?? true) && env.telegram.sendSuccessSummary);
    if (shouldBuild404Report) {
      http404Report = await tryCreatePhoto404ReportForRun(runId);
    }

    const durationMs = Date.now() - startedAt;
    logger.info("Photo sync finished", {
      lotsScanned: counters.lotsScanned,
      lotsProcessed: counters.lotsProcessed,
      photoLinksProcessed: counters.photoLinksProcessed,
      lotsOk: counters.lotsOk,
      lotsMissing: counters.lotsMissing,
      imagesUpserted: counters.imagesUpserted,
      imagesInserted: counters.imagesInserted,
      imagesUpdated: counters.imagesUpdated,
      imagesFullSize: counters.imagesFullSize,
      imagesStoredHd: counters.imagesStoredHd,
      imagesStoredFull: counters.imagesStoredFull,
      imagesBadQuality: counters.imagesBadQuality,
      http404Count: counters.http404Count,
      durationMs,
      lotsPerMin:
        durationMs > 0 ? Number(((counters.lotsProcessed / durationMs) * 60_000).toFixed(2)) : 0,
      imagesPerMin:
        durationMs > 0 ? Number(((counters.imagesUpserted / durationMs) * 60_000).toFixed(2)) : 0,
    });

    const summary = toSummary(runId, counters, durationMs, http404Report);

    if ((options.notifySuccess ?? true) && env.telegram.sendSuccessSummary) {
      const mmemberSyncLines =
        counters.mmemberFallbackAttempted > 0
          ? [
              "",
              "— Residential (mmember) fallback —",
              `mmember_fallback_attempted=${counters.mmemberFallbackAttempted}`,
              `mmember_fallback_ok=${counters.mmemberFallbackOk}`,
              `mmember_fallback_failed=${counters.mmemberFallbackAttempted - counters.mmemberFallbackOk}`,
            ]
          : [];

      await sendTelegramMessage(
        [
          "[PHOTO SYNC] success",
          `lots_scanned=${counters.lotsScanned}`,
          `lots_processed=${counters.lotsProcessed}`,
          `photo_links_processed=${counters.photoLinksProcessed}`,
          `configured_parallel_requests=${env.photo.fetchConcurrency * env.photo.workerTotal}`,
          `lots_ok=${counters.lotsOk}`,
          `lots_missing=${counters.lotsMissing}`,
          `images_upserted=${counters.imagesUpserted}`,
          `images_inserted=${counters.imagesInserted}`,
          `images_updated=${counters.imagesUpdated}`,
          `images_stored_hd=${counters.imagesStoredHd}`,
          `images_stored_full=${counters.imagesStoredFull}`,
          `images_full_size=${counters.imagesFullSize}`,
          `images_bad_quality=${counters.imagesBadQuality}`,
          `http_404_count=${counters.http404Count}`,
          `endpoint_404_lots=${counters.endpoint404Lots}`,
          ...mmemberSyncLines,
          `http_404_csv=${http404Report ? http404Report.filename : "none"}`,
        ].join("\n")
      );
      await sendTelegramDocuments(
        http404Report
          ? [
              {
                path: http404Report.path,
                filename: http404Report.filename,
                caption: `HTTP 404 (${http404Report.rowCount})`,
              },
            ]
          : []
      );
      await cleanupReportFiles([http404Report]);
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

export async function runPhotoSyncForLot(
  lotNumber: number,
  options: {
    notifySuccess?: boolean;
    notifyError?: boolean;
    build404Report?: boolean;
    prepareProxyPool?: boolean;
    storageMode?: "replace" | "merge";
  } = {}
): Promise<PhotoSyncRunSummary | null> {
  const candidate = await fetchPhotoCandidateByLotNumber(lotNumber);
  if (!candidate) {
    return null;
  }

  if (options.prepareProxyPool ?? true) {
    await prepareProxyPool("manual_lot_photo_refresh", true);
  }

  const startedAt = Date.now();
  const counters = createCounters();
  counters.lotsScanned = 1;
  const runId = await createPhotoRun();
  let http404Report: GeneratedReportFile | null = null;

  try {
    await processLot(candidate, counters, {
      storageMode: options.storageMode ?? "replace",
    });

    await completePhotoRunSuccess(runId, counters);

    const shouldBuild404Report =
      options.build404Report ?? ((options.notifySuccess ?? true) && env.telegram.sendSuccessSummary);
    if (shouldBuild404Report) {
      http404Report = await tryCreatePhoto404ReportForRun(runId);
    }

    const summary = toSummary(runId, counters, Date.now() - startedAt, http404Report);
    if ((options.notifySuccess ?? true) && env.telegram.sendSuccessSummary) {
      await sendTelegramMessage(
        [
          "[PHOTO SYNC MANUAL LOT] success",
          `lot_number=${lotNumber}`,
          `lots_processed=${summary.lotsProcessed}`,
          `photo_links_processed=${summary.photoLinksProcessed}`,
          `lots_ok=${summary.lotsOk}`,
          `lots_missing=${summary.lotsMissing}`,
          `images_inserted=${summary.imagesInserted}`,
          `images_updated=${summary.imagesUpdated}`,
          `images_stored_hd=${summary.imagesStoredHd}`,
          `images_stored_full=${summary.imagesStoredFull}`,
        ].join("\n")
      );
    }
    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await completePhotoRunFailure(runId, counters, message);
    if (options.notifyError ?? true) {
      await sendTelegramError("PHOTO SYNC MANUAL LOT FAILED", error);
    }
    throw error;
  }
}

export async function runPhotoSync(
  options: {
    notifySuccess?: boolean;
    notifyError?: boolean;
    build404Report?: boolean;
    skipGlobalRefreshLock?: boolean;
    candidateMode?: PhotoCandidateMode;
  } = {}
): Promise<PhotoSyncExecutionResult> {
  const lockName = getPhotoSyncLockName(env.photo.workerTotal, env.photo.workerIndex);
  const skipGateLock = process.env.PHOTO_SYNC_SKIP_GATE_LOCK === "true";
  const skipGlobalRefreshLock =
    options.skipGlobalRefreshLock || process.env.PHOTO_SYNC_SKIP_PIPELINE_LOCK === "true";
  const envCandidateModeRaw = process.env.PHOTO_SYNC_CANDIDATE_MODE;
  const envCandidateMode: PhotoCandidateMode =
    envCandidateModeRaw === "missing_only" || envCandidateModeRaw === "unknown_only"
      ? envCandidateModeRaw
      : "default";
  const candidateMode = options.candidateMode ?? envCandidateMode;
  const executeLocked = async () => {
    await prepareProxyPool("photo_sync_start", true);
    const proxySnapshot = getProxyPoolSnapshot();
    logger.info("Photo sync proxy pool ready", {
      mode: proxySnapshot.mode,
      configured: proxySnapshot.configured,
      selected: proxySnapshot.selected,
      preflightEnabled: proxySnapshot.preflightEnabled,
      preflightCompleted: proxySnapshot.preflightCompleted,
    });

    return executePhotoSync({
      ...options,
      candidateMode,
    });
  };
  const lockNames = [lockName];
  if (!skipGateLock) {
    lockNames.unshift(LOTS_MEDIA_GATE_LOCK);
  }
  if (!skipGlobalRefreshLock) {
    lockNames.unshift(PIPELINE_REFRESH_LOCK);
  }
  const locked =
    lockNames.length === 1 ? await withAppLock(lockName, executeLocked) : await withAppLocks(lockNames, executeLocked);
  if (locked === null) {
    logger.warn("Photo sync skipped because another run owns the lock", {
      lockName,
      skipGateLock,
      skipGlobalRefreshLock,
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
