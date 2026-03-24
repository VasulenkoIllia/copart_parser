import cron from "node-cron";
import env from "../../config/env";
import { logger } from "../../lib/logger";
import { runPhotoCluster } from "../photo/photo-cluster";
import { runPhotoSync } from "../photo/photo-sync";
import { countLotsWithoutAnyPhotos } from "../photo/photo-repository";
import { PhotoClusterRunResult, PhotoSyncRunSummary } from "../photo/types";
import { runFullPipelineOnce } from "../pipeline/run-once";
import { runRetentionCleanup } from "../maintenance/retention";
import { sendTelegramDocuments, sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { cleanupReportFiles } from "../reports/csv-report";
import { tryCreateLotsWithoutAnyPhotosReport } from "../reports/run-artifacts";
import { GeneratedReportFile } from "../reports/types";
import { startTelegramBotPolling } from "../telegram/bot";

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

function parseCronNumberList(value: string): number[] | null {
  if (!value.trim()) {
    return null;
  }

  const parts = value.split(",").map(item => item.trim()).filter(Boolean);
  if (parts.length === 0) {
    return null;
  }

  const numbers = parts.map(part => Number.parseInt(part, 10));
  if (numbers.some(number => !Number.isFinite(number))) {
    return null;
  }

  return numbers;
}

function describeCron(cronExpr: string): string {
  const trimmed = cronExpr.trim();
  if (!trimmed) {
    return "вимкнено";
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return trimmed;
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    if (/^\d+$/.test(minute)) {
      const minuteValue = Number.parseInt(minute, 10);

      if (hour === "*") {
        return `щогодини о :${pad2(minuteValue)}`;
      }

      if (/^\*\/\d+$/.test(hour)) {
        const interval = Number.parseInt(hour.slice(2), 10);
        return `кожні ${interval} год о :${pad2(minuteValue)}`;
      }

      const hours = parseCronNumberList(hour);
      if (hours && hours.length > 0) {
        return `щодня о ${hours.map(current => `${pad2(current)}:${pad2(minuteValue)}`).join(", ")}`;
      }
    }

    if (/^\*\/\d+$/.test(minute) && hour === "*") {
      const interval = Number.parseInt(minute.slice(2), 10);
      return `щогодини кожні ${interval} хв`;
    }
  }

  return trimmed;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("uk-UA").format(value);
}

function buildPhotoRetrySuccessMessage(
  summary: PhotoSyncRunSummary | PhotoClusterRunResult,
  lotsWithoutAnyPhotosTotal: number,
  lotsWithoutAnyPhotosCsv: string
): string {
  const lotsProcessed = summary.mode === "cluster" ? summary.totalLotsProcessed : summary.lotsProcessed;
  const photoLinksProcessed =
    summary.mode === "cluster" ? summary.totalPhotoLinksProcessed : summary.photoLinksProcessed;
  const lotsOk = summary.mode === "cluster" ? summary.totalLotsOk : summary.lotsOk;
  const lotsMissing = summary.mode === "cluster" ? summary.totalLotsMissing : summary.lotsMissing;
  const imagesInserted = summary.mode === "cluster" ? summary.totalImagesInserted : summary.imagesInserted;
  const imagesUpdated = summary.mode === "cluster" ? summary.totalImagesUpdated : summary.imagesUpdated;
  const imagesStoredHd = summary.mode === "cluster" ? summary.totalImagesStoredHd : summary.imagesStoredHd;
  const imagesStoredFull = summary.mode === "cluster" ? summary.totalImagesStoredFull : summary.imagesStoredFull;
  const endpoint404Lots = summary.mode === "cluster" ? summary.totalEndpoint404Lots : summary.endpoint404Lots;

  return [
    "[PHOTO RETRY] success",
    `mode=${summary.mode}`,
    `lots_processed=${formatCount(lotsProcessed)}`,
    `photo_links_processed=${formatCount(photoLinksProcessed)}`,
    `lots_ok=${formatCount(lotsOk)}`,
    `lots_missing=${formatCount(lotsMissing)}`,
    `images_inserted=${formatCount(imagesInserted)}`,
    `images_updated=${formatCount(imagesUpdated)}`,
    `images_stored_hd=${formatCount(imagesStoredHd)}`,
    `images_stored_full=${formatCount(imagesStoredFull)}`,
    `endpoint_404_lots=${formatCount(endpoint404Lots)}`,
    `lots_without_any_photos_total=${formatCount(lotsWithoutAnyPhotosTotal)}`,
    `lots_without_any_photos_csv=${lotsWithoutAnyPhotosCsv}`,
  ].join("\n");
}

async function safeRun(
  name: string,
  action: () => Promise<unknown>,
  options: { notifyError?: boolean } = {}
): Promise<void> {
  const startedAt = Date.now();
  logger.info(`${name} job started`);
  try {
    await action();
    logger.info(`${name} job finished`, {
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.error(`${name} job failed`, {
      message: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    });
    if (options.notifyError ?? true) {
      await sendTelegramError(`${name} JOB FAILED`, error);
    }
  }
}

export async function startScheduler(): Promise<void> {
  const photoRetryCron = env.schedule.photoRetryCron.trim();
  const retentionCron = env.maintenance.cron.trim();

  logger.info("Scheduler started", {
    ingestCron: env.schedule.ingestCron,
    photoRetryCron: photoRetryCron || "disabled",
    retentionEnabled: env.maintenance.enabled,
    retentionCron: retentionCron || "disabled",
    timezone: env.app.tz,
    runOnStart: env.schedule.runOnStart,
  });

  void startTelegramBotPolling().catch(error => {
    logger.error("Telegram bot polling crashed", {
      message: error instanceof Error ? error.message : String(error),
    });
  });

  cron.schedule(
    env.schedule.ingestCron,
    () => {
      void safeRun("PIPELINE_REFRESH", runFullPipelineOnce, { notifyError: false });
    },
    {
      timezone: env.app.tz,
    }
  );

  if (photoRetryCron) {
    cron.schedule(
      photoRetryCron,
      () => {
        void safeRun(
          "PHOTO_SYNC",
          async () => {
            const summary =
              env.photo.workerTotal > 1
                ? await runPhotoCluster()
                : (await runPhotoSync({ notifySuccess: false, notifyError: false })).summary ?? null;
            if (!summary || !env.telegram.sendSuccessSummary) {
              return;
            }

            let lotsWithoutAnyPhotosReport: GeneratedReportFile | null = null;
            try {
              const lotsWithoutAnyPhotosTotal = await countLotsWithoutAnyPhotos();
              lotsWithoutAnyPhotosReport = await tryCreateLotsWithoutAnyPhotosReport();
              await sendTelegramMessage(
                buildPhotoRetrySuccessMessage(
                  summary,
                  lotsWithoutAnyPhotosTotal,
                  lotsWithoutAnyPhotosReport?.filename ?? "none"
                )
              );
              await sendTelegramDocuments(
                lotsWithoutAnyPhotosReport
                  ? [
                      {
                        path: lotsWithoutAnyPhotosReport.path,
                        filename: lotsWithoutAnyPhotosReport.filename,
                        caption: `Лоти без фото (${formatCount(lotsWithoutAnyPhotosTotal)})`,
                      },
                    ]
                  : []
              );
            } finally {
              await cleanupReportFiles([lotsWithoutAnyPhotosReport]);
            }
          },
          { notifyError: env.photo.workerTotal > 1 }
        );
      },
      {
        timezone: env.app.tz,
      }
    );
  }

  if (env.maintenance.enabled && retentionCron) {
    cron.schedule(
      retentionCron,
      () => {
        void safeRun("RETENTION_CLEANUP", () => runRetentionCleanup());
      },
      {
        timezone: env.app.tz,
      }
    );
  }

  if (env.schedule.runOnStart) {
    await safeRun("PIPELINE_REFRESH_ON_START", runFullPipelineOnce, { notifyError: false });
  }

  if (env.telegram.sendSuccessSummary) {
    await sendTelegramMessage(
      [
        "Планувальник запущено",
        "",
        `Оновлення CSV: ${describeCron(env.schedule.ingestCron)}`,
        `Cron CSV: ${env.schedule.ingestCron}`,
        `Окремий photo retry: ${describeCron(photoRetryCron)}`,
        ...(photoRetryCron ? [`Cron photo retry: ${photoRetryCron}`] : []),
        `Retention cleanup: ${env.maintenance.enabled ? describeCron(retentionCron) : "вимкнено"}`,
        ...(env.maintenance.enabled && retentionCron ? [`Cron retention: ${retentionCron}`] : []),
        `Часова зона: ${env.app.tz}`,
        `Автостарт після рестарту: ${env.schedule.runOnStart ? "так" : "ні"}`,
        `Telegram bot polling: ${env.telegram.pollingEnabled ? "увімкнено" : "вимкнено"}`,
      ].join("\n")
    );
  }

  await new Promise<void>(() => {
    // Keep process alive for cron jobs.
  });
}
