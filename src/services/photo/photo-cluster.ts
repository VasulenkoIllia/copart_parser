import { spawn } from "child_process";
import axios from "axios";
import { RowDataPacket } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";
import { getActiveProxyUrls, prepareProxyPoolWithHealthcheck } from "../../lib/http-client";
import { logger } from "../../lib/logger";
import { normalizeCopartLotImagesUrl } from "../../lib/url-utils";
import { withAppLocks } from "../locks/db-lock";
import { LOTS_MEDIA_GATE_LOCK, PIPELINE_REFRESH_LOCK } from "../locks/lock-names";
import {
  completePhotoClusterRunFailure,
  completePhotoClusterRunSuccess,
  createPhotoClusterRun,
  fetchPhotoClusterRunResult,
  fetchPhotoClusterRunWorkers,
} from "./photo-repository";
import { PhotoClusterRunResult } from "./types";
import { tryCreatePhoto404ReportForClusterRun } from "../reports/run-artifacts";
import { sendTelegramError } from "../notify/telegram";

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

    if (endpointUrl) {
      return endpointUrl;
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
        PHOTO_SYNC_SKIP_GATE_LOCK: "true",
        PHOTO_WORKER_TOTAL: String(workerTotal),
        PHOTO_WORKER_INDEX: String(workerIndex),
      },
      stdio: "inherit",
    });

    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      logger.warn("Photo cluster worker timed out, sending SIGTERM", {
        workerIndex,
        timeoutMs: env.photo.clusterWorkerTimeoutMs,
      });
      child.kill("SIGTERM");
    }, env.photo.clusterWorkerTimeoutMs);

    child.once("error", error => {
      clearTimeout(timeoutHandle);
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        logger.error("Photo cluster worker killed after timeout", {
          workerIndex,
          exitCode,
          signal,
          durationMs,
          timeoutMs: env.photo.clusterWorkerTimeoutMs,
        });
        reject(
          new Error(
            `Photo cluster worker ${workerIndex} timed out after ${env.photo.clusterWorkerTimeoutMs}ms`
          )
        );
        return;
      }
      logger.info("Photo cluster worker exited", {
        workerIndex,
        exitCode,
        signal,
        durationMs,
      });
      resolve({
        workerIndex,
        exitCode,
        signal,
        durationMs,
      });
    });
  });
}

export async function runPhotoCluster(
  options: {
    build404Report?: boolean;
    skipGlobalRefreshLock?: boolean;
    candidateMode?: "default" | "unknown_only" | "missing_only";
  } = {}
): Promise<PhotoClusterRunResult | null> {
  const lockNames = options.skipGlobalRefreshLock
    ? [LOTS_MEDIA_GATE_LOCK]
    : [PIPELINE_REFRESH_LOCK, LOTS_MEDIA_GATE_LOCK];
  const locked = await withAppLocks(lockNames, async () => {
    const workerTotal = env.photo.workerTotal;
    if (workerTotal < 1) {
      throw new Error("PHOTO_WORKER_TOTAL must be >= 1 for photo:cluster");
    }

    const workerEnvOverrides = await buildWorkerProxyOverrides();
    const selectedProxyCount = workerEnvOverrides.PROXY_LIST
      ? workerEnvOverrides.PROXY_LIST.split(",").filter(Boolean).length
      : env.proxy.list.length;
    const clusterRunId = await createPhotoClusterRun(selectedProxyCount);
    const workerEnv = {
      ...workerEnvOverrides,
      PHOTO_CLUSTER_RUN_ID: String(clusterRunId),
      PHOTO_SYNC_SKIP_PIPELINE_LOCK: "true",
      PHOTO_SYNC_CANDIDATE_MODE: options.candidateMode ?? "default",
      TELEGRAM_SEND_SUCCESS_SUMMARY: "false",
      TELEGRAM_SEND_ERROR_ALERTS: "false",
    };

    logger.info("Photo cluster started", {
      clusterRunId,
      workerTotal,
      fetchConcurrencyPerWorker: env.photo.fetchConcurrency,
      batchSizePerWorker: env.photo.batchSize,
      sharding: "MOD(CRC32(CAST(lot_number AS CHAR)), workerTotal) = workerIndex",
      proxyAutoSelectForPhoto: env.proxy.autoSelectForPhoto,
      candidateMode: options.candidateMode ?? "default",
    });

    const startedAt = Date.now();
    let failureMessage: string | null = null;
    try {
      const workerPromises: Promise<WorkerRunResult>[] = [];
      for (let workerIndex = 0; workerIndex < workerTotal; workerIndex += 1) {
        workerPromises.push(runWorker(workerIndex, workerTotal, workerEnv));
      }

      const results = await Promise.all(workerPromises);
      const failed = results.filter(result => result.exitCode !== 0);
      failureMessage =
        failed.length > 0
          ? `photo:cluster failed: ${failed.length}/${workerTotal} workers exited with non-zero code`
          : null;
      if (failed.length > 0) {
        await completePhotoClusterRunFailure(clusterRunId, failureMessage ?? "photo:cluster failed");
      } else {
        await completePhotoClusterRunSuccess(clusterRunId);
      }

      const workers = await fetchPhotoClusterRunWorkers(clusterRunId);
      const summary = await fetchPhotoClusterRunResult(clusterRunId, Date.now() - startedAt);
      if (options.build404Report) {
        summary.http404Report = await tryCreatePhoto404ReportForClusterRun(clusterRunId);
      }
      logger.info("Photo cluster finished", {
        clusterRunId,
        workerTotal,
        durationMs: summary.durationMs,
        workerResults: results.map(result => ({
          workerIndex: result.workerIndex,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
        })),
        workerRuns: workers.map(worker => ({
          photoRunId: worker.photoRunId,
          workerIndex: worker.workerIndex,
          status: worker.status,
          lotsProcessed: worker.lotsProcessed,
          photoLinksProcessed: worker.photoLinksProcessed,
          lotsOk: worker.lotsOk,
          lotsMissing: worker.lotsMissing,
          imagesUpserted: worker.imagesUpserted,
          imagesInserted: worker.imagesInserted,
          imagesUpdated: worker.imagesUpdated,
          imagesStoredHd: worker.imagesStoredHd,
          imagesStoredFull: worker.imagesStoredFull,
          http404Count: worker.http404Count,
          endpoint404Lots: worker.endpoint404Lots,
          durationMs: worker.durationMs,
        })),
      });

      if (summary.totalMmemberFallback407 >= 3) {
        logger.error("mmember proxy auth failure detected (HTTP 407)", {
          clusterRunId,
          workerTotal,
          attempted: summary.totalMmemberFallbackAttempted,
          ok: summary.totalMmemberFallbackOk,
          http407: summary.totalMmemberFallback407,
        });
        await sendTelegramError(
          "MMEMBER PROXY FAILURE",
          new Error(
            `mmember: ${summary.totalMmemberFallback407} requests returned HTTP 407 across ${workerTotal} workers.\n` +
              `Proxy is unpaid, expired, or credentials are wrong.\n` +
              `Check MMEMBER_FALLBACK_PROXY_URL on the server.`
          )
        );
      }

      if (failed.length > 0) {
        throw new Error(failureMessage ?? "photo:cluster failed");
      }
      return summary;
    } catch (error) {
      if (error instanceof Error && error.message !== failureMessage) {
        await completePhotoClusterRunFailure(clusterRunId, error.message);
      } else if (!(error instanceof Error)) {
        await completePhotoClusterRunFailure(clusterRunId, String(error));
      }
      throw error;
    }
  });

  if (locked === null) {
    logger.warn("Photo cluster skipped because another run owns the lock", {
      skipGlobalRefreshLock: Boolean(options.skipGlobalRefreshLock),
    });
    return null;
  }

  return locked;
}
