import env from "../../config/env";
import { logger } from "../../lib/logger";
import { withAppLock } from "../locks/db-lock";
import { runCsvIngest } from "../ingest/csv-ingest";
import { sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { runPhotoSync } from "../photo/photo-sync";
import { runPhotoCluster } from "../photo/photo-cluster";
import { CsvIngestRunSummary } from "../ingest/types";
import { PhotoClusterRunResult, PhotoSyncRunSummary } from "../photo/types";

function formatDurationSeconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(2);
}

function buildPipelineSuccessMessage(
  ingest: CsvIngestRunSummary,
  photo: PhotoSyncRunSummary | PhotoClusterRunResult,
  totalDurationMs: number
): string {
  const lines = [
    "[PIPELINE] success",
    `csv_lots=${ingest.rowsValid}`,
    `new_lots=${ingest.rowsInserted}`,
    `updated_lots=${ingest.rowsUpdated}`,
    `unchanged_lots=${ingest.rowsUnchanged}`,
    `invalid_rows=${ingest.rowsInvalid}`,
    `pruned_lots=${ingest.prunedLots}`,
    `hydrated_lots_from_media=${ingest.hydratedLotsFromMedia}`,
    `photo_mode=${photo.mode}`,
    `photo_processed=${photo.mode === "cluster" ? photo.totalLotsProcessed : photo.lotsProcessed}`,
    `photo_ok=${photo.mode === "cluster" ? photo.totalLotsOk : photo.lotsOk}`,
    `photo_missing=${photo.mode === "cluster" ? photo.totalLotsMissing : photo.lotsMissing}`,
    `endpoint_404_lots=${photo.mode === "cluster" ? photo.totalEndpoint404Lots : photo.endpoint404Lots}`,
    `http_404_total=${photo.mode === "cluster" ? photo.totalHttp404Count : photo.http404Count}`,
    `images_upserted=${photo.mode === "cluster" ? photo.totalImagesUpserted : photo.imagesUpserted}`,
  ];

  if (photo.mode === "cluster") {
    lines.push(
      `photo_workers=${photo.workerTotal}`,
      `workers_succeeded=${photo.workersSucceeded}`,
      `workers_failed=${photo.workersFailed}`
    );
  } else {
    lines.push(`photo_worker=${photo.workerIndex}/${photo.workerTotal}`);
  }

  lines.push(
    `ingest_sec=${formatDurationSeconds(ingest.durationMs)}`,
    `photo_sec=${formatDurationSeconds(photo.durationMs)}`,
    `total_sec=${formatDurationSeconds(totalDurationMs)}`
  );

  return lines.join("\n");
}

async function executeFullPipelineOnce(): Promise<void> {
  const startedAt = Date.now();
  logger.info("Pipeline run-once started");
  try {
    const ingestResult = await runCsvIngest({ notifySuccess: false, notifyError: false });
    if (!ingestResult.executed || !ingestResult.summary) {
      logger.warn("Pipeline run-once aborted because CSV ingest lock was unavailable");
      return;
    }

    const photoResult =
      env.photo.workerTotal > 1
        ? await runPhotoCluster()
        : (await runPhotoSync({ notifySuccess: false, notifyError: false })).summary;

    if (!photoResult) {
      logger.warn("Pipeline run-once aborted because photo stage did not execute");
      return;
    }

    const totalDurationMs = Date.now() - startedAt;
    logger.info("Pipeline run-once finished", {
      durationMs: totalDurationMs,
      photoMode: photoResult.mode,
    });
    if (env.telegram.sendSuccessSummary) {
      await sendTelegramMessage(
        buildPipelineSuccessMessage(ingestResult.summary, photoResult, totalDurationMs)
      );
    }
  } catch (error) {
    logger.error("Pipeline run-once failed", {
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    await sendTelegramError("PIPELINE RUN-ONCE FAILED", error);
    throw error;
  }
}

export async function runFullPipelineOnce(): Promise<void> {
  const locked = await withAppLock("pipeline_refresh", executeFullPipelineOnce);
  if (locked === null) {
    logger.warn("Pipeline run-once skipped because another pipeline run owns the lock");
  }
}
