import env from "../../config/env";
import { logger } from "../../lib/logger";
import { withAppLock } from "../locks/db-lock";
import { runCsvIngest } from "../ingest/csv-ingest";
import { PIPELINE_REFRESH_LOCK } from "../locks/lock-names";
import { sendTelegramDocuments, sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { runPhotoSync } from "../photo/photo-sync";
import { runPhotoCluster } from "../photo/photo-cluster";
import { CsvFieldUpdateStat, CsvIngestRunSummary } from "../ingest/types";
import { PhotoClusterRunResult, PhotoSyncRunSummary } from "../photo/types";
import { cleanupReportFiles } from "../reports/csv-report";
import { GeneratedReportFile } from "../reports/types";
import {
  REFRESH_LOT_COMMAND_GROUP_EXAMPLE,
  REFRESH_LOT_COMMAND_PRIVATE_EXAMPLE,
} from "../telegram/refresh-command";

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

function summarizeUpdatedFields(stats: CsvFieldUpdateStat[], limit: number): string {
  if (stats.length === 0) {
    return "немає";
  }

  const visible = stats.slice(0, limit).map(stat => `${stat.field}=${formatCount(stat.lotsUpdated)}`);
  if (stats.length > limit) {
    visible.push(`+${formatCount(stats.length - limit)} полів`);
  }

  return visible.join(", ");
}

function buildPipelineSuccessMessage(
  ingest: CsvIngestRunSummary,
  photo: PhotoSyncRunSummary | PhotoClusterRunResult,
  totalDurationMs: number
): string {
  const photoScanned = photo.mode === "cluster" ? photo.totalLotsScanned : photo.lotsScanned;
  const photoProcessed = photo.mode === "cluster" ? photo.totalLotsProcessed : photo.lotsProcessed;
  const photoLinksProcessed =
    photo.mode === "cluster" ? photo.totalPhotoLinksProcessed : photo.photoLinksProcessed;
  const photoOk = photo.mode === "cluster" ? photo.totalLotsOk : photo.lotsOk;
  const photoMissing = photo.mode === "cluster" ? photo.totalLotsMissing : photo.lotsMissing;
  const photoImagesInserted =
    photo.mode === "cluster" ? photo.totalImagesInserted : photo.imagesInserted;
  const photoImagesUpdated =
    photo.mode === "cluster" ? photo.totalImagesUpdated : photo.imagesUpdated;
  const photoImagesStoredHd =
    photo.mode === "cluster" ? photo.totalImagesStoredHd : photo.imagesStoredHd;
  const photoImagesStoredFull =
    photo.mode === "cluster" ? photo.totalImagesStoredFull : photo.imagesStoredFull;
  const endpoint404Lots =
    photo.mode === "cluster" ? photo.totalEndpoint404Lots : photo.endpoint404Lots;
  const http404Total = photo.mode === "cluster" ? photo.totalHttp404Count : photo.http404Count;
  const http404CsvAttached = Boolean(photo.http404Report);

  const csvLines = [
    `Лотів у CSV: ${formatCount(ingest.rowsValid)}`,
    `Нових лотів: ${formatCount(ingest.rowsInserted)}`,
    `Оновлених лотів: ${formatCount(ingest.rowsUpdated)}`,
    `Без змін: ${formatCount(ingest.rowsUnchanged)}`,
    `Оновлено зі зміною image_url: ${formatCount(ingest.rowsUpdatedImageUrlChanged)}`,
    `Оновлено по інших полях: ${formatCount(ingest.rowsUpdatedOtherFields)}`,
    `Некоректних рядків: ${formatCount(ingest.rowsInvalid)}`,
    `Некоректних рядків %: ${formatPercent(ingest.rowsInvalid, ingest.rowsTotal)}`,
    `Видалено зі snapshot: ${formatCount(ingest.prunedLots)}`,
    `Видалено orphan-фото: ${formatCount(ingest.prunedOrphanLotImages)}`,
    `Гідровано з media cache: ${formatCount(ingest.hydratedLotsFromMedia)}`,
    `Змінені CSV поля: ${formatCount(ingest.updatedFields.length)}`,
    `Топ зміни: ${summarizeUpdatedFields(ingest.updatedFields, 5)}`,
  ];

  const photoLines = [
    `Кандидатів на photo-stage: ${formatCount(photoScanned)}`,
    `Опрацьовано лотів: ${formatCount(photoProcessed)}`,
    `Опрацьовано фото-посилань: ${formatCount(photoLinksProcessed)}`,
    `З валідними фото: ${formatCount(photoOk)} (${formatPercent(photoOk, photoProcessed)})`,
    `Без валідних фото: ${formatCount(photoMissing)} (${formatPercent(photoMissing, photoProcessed)})`,
    `Нових фото в БД: ${formatCount(photoImagesInserted)}`,
    `Оновлених фото в БД: ${formatCount(photoImagesUpdated)}`,
    `Збережено HD: ${formatCount(photoImagesStoredHd)}`,
    `Збережено full fallback: ${formatCount(photoImagesStoredFull)}`,
    `Лотів з endpoint 404: ${formatCount(endpoint404Lots)}`,
    `Усього HTTP 404: ${formatCount(http404Total)}`,
  ];

  const lines = ["Оновлення Copart завершено", "", "CSV", ...csvLines, "", "Фото", ...photoLines];

  lines.push(
    "",
    "Файли",
    `CSV HTTP 404: ${http404CsvAttached ? "додано" : "немає"}`
  );

  lines.push(
    "",
    "Час виконання",
    `CSV: ${formatDuration(ingest.durationMs)}`,
    `Фото: ${formatDuration(photo.durationMs)}`,
    `Разом: ${formatDuration(totalDurationMs)}`
  );

  lines.push(
    "",
    "Команда",
    `Приват: ${REFRESH_LOT_COMMAND_PRIVATE_EXAMPLE}`,
    `Група: ${REFRESH_LOT_COMMAND_GROUP_EXAMPLE}`
  );

  return lines.join("\n");
}

async function executeFullPipelineOnce(): Promise<void> {
  const startedAt = Date.now();
  const reportFiles: GeneratedReportFile[] = [];
  logger.info("Pipeline run-once started");
  try {
    const ingestResult = await runCsvIngest({
      notifySuccess: false,
      notifyError: false,
      buildInvalidRowsReport: false,
      skipGlobalRefreshLock: true,
    });
    if (!ingestResult.executed || !ingestResult.summary) {
      logger.warn("Pipeline run-once aborted because CSV ingest lock was unavailable");
      return;
    }
    const photoResult =
      env.photo.workerTotal > 1
        ? await runPhotoCluster({
            build404Report: env.telegram.sendSuccessSummary,
            skipGlobalRefreshLock: true,
          })
        : (
            await runPhotoSync({
              notifySuccess: false,
              notifyError: false,
              build404Report: env.telegram.sendSuccessSummary,
              skipGlobalRefreshLock: true,
            })
          ).summary;

    if (!photoResult) {
      logger.warn("Pipeline run-once aborted because photo stage did not execute");
      return;
    }
    if (photoResult.http404Report) {
      reportFiles.push(photoResult.http404Report);
    }

    const totalDurationMs = Date.now() - startedAt;
    logger.info("Pipeline run-once finished", {
      durationMs: totalDurationMs,
      photoMode: photoResult.mode,
    });
    if (env.telegram.sendSuccessSummary) {
      await sendTelegramMessage(buildPipelineSuccessMessage(ingestResult.summary, photoResult, totalDurationMs));
      await sendTelegramDocuments(
        reportFiles.map(file => ({
          path: file.path,
          filename: file.filename,
        }))
      );
    }
  } catch (error) {
    logger.error("Pipeline run-once failed", {
      durationMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
    });
    await sendTelegramError("PIPELINE RUN-ONCE FAILED", error);
    throw error;
  } finally {
    await cleanupReportFiles(reportFiles);
  }
}

export async function runFullPipelineOnce(): Promise<void> {
  const locked = await withAppLock(PIPELINE_REFRESH_LOCK, executeFullPipelineOnce);
  if (locked === null) {
    logger.warn("Pipeline run-once skipped because another pipeline run owns the lock");
  }
}
