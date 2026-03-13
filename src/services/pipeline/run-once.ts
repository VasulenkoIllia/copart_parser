import env from "../../config/env";
import { logger } from "../../lib/logger";
import { withAppLock } from "../locks/db-lock";
import { runCsvIngest } from "../ingest/csv-ingest";
import { sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { runPhotoSync } from "../photo/photo-sync";
import { runPhotoCluster } from "../photo/photo-cluster";
import { CsvIngestRunSummary } from "../ingest/types";
import { PhotoClusterRunResult, PhotoSyncRunSummary } from "../photo/types";

function formatCount(value: number): string {
  return new Intl.NumberFormat("uk-UA").format(value);
}

function formatPercent(part: number, total: number): string {
  if (total <= 0) {
    return "0.0%";
  }
  return `${((part / total) * 100).toFixed(1)}%`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds} с`;
  }

  return `${minutes} хв ${seconds} с`;
}

function buildPipelineSuccessMessage(
  ingest: CsvIngestRunSummary,
  photo: PhotoSyncRunSummary | PhotoClusterRunResult,
  totalDurationMs: number
): string {
  const photoProcessed = photo.mode === "cluster" ? photo.totalLotsProcessed : photo.lotsProcessed;
  const photoOk = photo.mode === "cluster" ? photo.totalLotsOk : photo.lotsOk;
  const photoMissing = photo.mode === "cluster" ? photo.totalLotsMissing : photo.lotsMissing;
  const endpoint404Lots =
    photo.mode === "cluster" ? photo.totalEndpoint404Lots : photo.endpoint404Lots;
  const http404Total = photo.mode === "cluster" ? photo.totalHttp404Count : photo.http404Count;
  const imagesUpserted = photo.mode === "cluster" ? photo.totalImagesUpserted : photo.imagesUpserted;

  const lines = [
    "Оновлення Copart завершено",
    "",
    "CSV",
    `Лотів у CSV: ${formatCount(ingest.rowsValid)}`,
    `Нових лотів: ${formatCount(ingest.rowsInserted)}`,
    `Оновлених лотів: ${formatCount(ingest.rowsUpdated)}`,
    `Без змін: ${formatCount(ingest.rowsUnchanged)}`,
    `Некоректних рядків: ${formatCount(ingest.rowsInvalid)}`,
    `Видалено зі snapshot: ${formatCount(ingest.prunedLots)}`,
    `Одразу закрито з media: ${formatCount(ingest.hydratedLotsFromMedia)}`,
    "",
    "Фото",
    `Опрацьовано лотів: ${formatCount(photoProcessed)}`,
    `З валідними фото: ${formatCount(photoOk)} (${formatPercent(photoOk, photoProcessed)})`,
    `Без валідних фото: ${formatCount(photoMissing)} (${formatPercent(photoMissing, photoProcessed)})`,
    `Лотів з endpoint 404: ${formatCount(endpoint404Lots)}`,
    `Усього HTTP 404: ${formatCount(http404Total)}`,
    `Збережено HD фото: ${formatCount(imagesUpserted)}`,
  ];

  if (photo.mode === "cluster") {
    lines.push(
      "",
      "Кластер",
      `Воркерів: ${formatCount(photo.workerTotal)}`,
      `Успішних: ${formatCount(photo.workersSucceeded)}`,
      `З помилками: ${formatCount(photo.workersFailed)}`
    );
  } else {
    lines.push("", "Воркер", `${photo.workerIndex + 1} з ${photo.workerTotal}`);
  }

  lines.push(
    "",
    "Час виконання",
    `CSV: ${formatDuration(ingest.durationMs)}`,
    `Фото: ${formatDuration(photo.durationMs)}`,
    `Разом: ${formatDuration(totalDurationMs)}`
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
