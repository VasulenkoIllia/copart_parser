import env from "../../config/env";
import { logger } from "../../lib/logger";
import { withAppLock } from "../locks/db-lock";
import { runCsvIngest } from "../ingest/csv-ingest";
import { PIPELINE_REFRESH_LOCK } from "../locks/lock-names";
import { sendTelegramDocuments, sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { runPhotoSync } from "../photo/photo-sync";
import { runPhotoCluster } from "../photo/photo-cluster";
import { CsvIngestRunSummary } from "../ingest/types";
import { fetchLotsWithoutAnyPhotosStats, LotsWithoutAnyPhotosStats } from "../photo/photo-repository";
import { PhotoClusterRunResult, PhotoSyncRunSummary } from "../photo/types";
import { cleanupReportFiles } from "../reports/csv-report";
import { GeneratedReportFile } from "../reports/types";
import { REFRESH_LOT_COMMAND_PRIVATE_EXAMPLE } from "../telegram/refresh-command";

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
  lotsWithoutAnyPhotos: LotsWithoutAnyPhotosStats,
  totalDurationMs: number
): string {
  const photoProcessed = photo.mode === "cluster" ? photo.totalLotsProcessed : photo.lotsProcessed;
  const photoOk = photo.mode === "cluster" ? photo.totalLotsOk : photo.lotsOk;
  const photoMissing = photo.mode === "cluster" ? photo.totalLotsMissing : photo.lotsMissing;
  const photoImagesInserted =
    photo.mode === "cluster" ? photo.totalImagesInserted : photo.imagesInserted;
  const photoImagesUpdated =
    photo.mode === "cluster" ? photo.totalImagesUpdated : photo.imagesUpdated;
  const mmemberAttempted =
    photo.mode === "sync" ? photo.mmemberFallbackAttempted : photo.totalMmemberFallbackAttempted;
  const mmemberOk =
    photo.mode === "sync" ? photo.mmemberFallbackOk : photo.totalMmemberFallbackOk;

  const lines: string[] = [
    "Оновлення Copart завершено",
    "",
    `Лоти: ${formatCount(ingest.rowsValid)} у CSV`,
    `  Нові: ${formatCount(ingest.rowsInserted)} · Оновлені: ${formatCount(ingest.rowsUpdated)} · Без змін: ${formatCount(ingest.rowsUnchanged)}`,
  ];

  if (ingest.rowsInvalid > 0) {
    lines.push(`  Некоректних: ${formatCount(ingest.rowsInvalid)} (${formatPercent(ingest.rowsInvalid, ingest.rowsTotal)})`);
  }

  lines.push(
    "",
    `Фото: ${formatCount(photoOk)} / ${formatCount(photoProcessed)} (${formatPercent(photoOk, photoProcessed)})`,
    `  Нових: ${formatCount(photoImagesInserted)} · Оновлених: ${formatCount(photoImagesUpdated)}`,
  );

  if (photoMissing > 0) {
    const missingNote = photo.http404Report ? " (звіт додано)" : "";
    lines.push(`  Без фото цього циклу: ${formatCount(photoMissing)} лотів${missingNote}`);
  }

  if (mmemberAttempted > 0) {
    const mmemberFailed = mmemberAttempted - mmemberOk;
    lines.push(`  Mmember: ${formatCount(mmemberAttempted)} спроб → ${formatCount(mmemberOk)} ок (${formatCount(mmemberFailed)} невдало)`);
  }

  lines.push(
    "",
    `Лоти без жодного фото: ${formatCount(lotsWithoutAnyPhotos.total)}`,
    `  Прострочені: ${formatCount(lotsWithoutAnyPhotos.missingDueNow)} · Очікуються: ${formatCount(lotsWithoutAnyPhotos.missingDueFuture)} · Невідомо: ${formatCount(lotsWithoutAnyPhotos.unknown)}`,
    "",
    `Час: CSV ${formatDuration(ingest.durationMs)} · Фото ${formatDuration(photo.durationMs)} · Разом ${formatDuration(totalDurationMs)}`,
    "",
    `Команда: ${REFRESH_LOT_COMMAND_PRIVATE_EXAMPLE}`,
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
            candidateMode: "unknown_only",
          })
        : (
            await runPhotoSync({
              notifySuccess: false,
              notifyError: false,
              build404Report: env.telegram.sendSuccessSummary,
              skipGlobalRefreshLock: true,
              candidateMode: "unknown_only",
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
      const lotsWithoutAnyPhotos = await fetchLotsWithoutAnyPhotosStats();
      await sendTelegramMessage(buildPipelineSuccessMessage(ingestResult.summary, photoResult, lotsWithoutAnyPhotos, totalDurationMs));
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
