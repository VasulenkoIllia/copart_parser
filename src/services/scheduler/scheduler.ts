import cron from "node-cron";
import env from "../../config/env";
import { logger } from "../../lib/logger";
import { runPhotoCluster } from "../photo/photo-cluster";
import { runPhotoSync } from "../photo/photo-sync";
import {
  fetchLotsWithoutAnyPhotosStats,
  fetchPhotoEndpointIssuesForClusterRun,
  fetchPhotoEndpointIssuesForRun,
  LotsWithoutAnyPhotosStats,
  PhotoEndpointIssueReportRow,
} from "../photo/photo-repository";
import { PhotoClusterRunResult, PhotoSyncRunSummary } from "../photo/types";
import { runFullPipelineOnce } from "../pipeline/run-once";
import { runRetentionCleanup } from "../maintenance/retention";
import { sendTelegramDocuments, sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { cleanupReportFiles } from "../reports/csv-report";
import { tryCreateLotsWithoutAnyPhotosReport, tryCreatePhotoEndpointIssuesReport } from "../reports/run-artifacts";
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

function formatPercent(part: number, total: number): string {
  if (total <= 0) return "0.0%";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} с`;
  return `${minutes} хв ${seconds} с`;
}

interface EndpointIssueStats {
  total: number;
  rateLimited429: number;
  forbidden403: number;
  notFound404: number;
  inventoryIssues: number;
}

function summarizeEndpointIssues(attempts: PhotoEndpointIssueReportRow[]): EndpointIssueStats {
  let rateLimited429 = 0;
  let forbidden403 = 0;
  let notFound404 = 0;
  let inventoryIssues = 0;

  for (const attempt of attempts) {
    if (attempt.httpStatus === 429) {
      rateLimited429 += 1;
    }
    if (attempt.httpStatus === 403) {
      forbidden403 += 1;
    }
    if (attempt.httpStatus === 404) {
      notFound404 += 1;
    }
    if (attempt.endpointSource === "inventoryv2") {
      inventoryIssues += 1;
    }
  }

  return {
    total: attempts.length,
    rateLimited429,
    forbidden403,
    notFound404,
    inventoryIssues,
  };
}

async function fetchEndpointIssuesForSummary(
  summary: PhotoSyncRunSummary | PhotoClusterRunResult
): Promise<PhotoEndpointIssueReportRow[]> {
  return summary.mode === "cluster"
    ? fetchPhotoEndpointIssuesForClusterRun(summary.clusterRunId)
    : fetchPhotoEndpointIssuesForRun(summary.runId);
}

function buildPhotoRetrySuccessMessage(
  summary: PhotoSyncRunSummary | PhotoClusterRunResult,
  lotsWithoutAnyPhotosStats: LotsWithoutAnyPhotosStats,
  endpointIssueStats: EndpointIssueStats,
): string {
  const lotsProcessed = summary.mode === "cluster" ? summary.totalLotsProcessed : summary.lotsProcessed;
  const lotsOk = summary.mode === "cluster" ? summary.totalLotsOk : summary.lotsOk;
  const lotsMissing = summary.mode === "cluster" ? summary.totalLotsMissing : summary.lotsMissing;
  const imagesInserted = summary.mode === "cluster" ? summary.totalImagesInserted : summary.imagesInserted;
  const imagesUpdated = summary.mode === "cluster" ? summary.totalImagesUpdated : summary.imagesUpdated;
  const mmemberAttempted =
    summary.mode === "sync" ? summary.mmemberFallbackAttempted : summary.totalMmemberFallbackAttempted;
  const mmemberOk =
    summary.mode === "sync" ? summary.mmemberFallbackOk : summary.totalMmemberFallbackOk;

  const lines: string[] = [
    "Ретрай фото завершено",
    "",
    `Оброблено: ${formatCount(lotsProcessed)} лотів`,
    `  З фото: ${formatCount(lotsOk)} (${formatPercent(lotsOk, lotsProcessed)}) · Без фото: ${formatCount(lotsMissing)}`,
    `  Нових: ${formatCount(imagesInserted)} · Оновлених: ${formatCount(imagesUpdated)}`,
  ];

  if (mmemberAttempted > 0) {
    const mmemberFailed = mmemberAttempted - mmemberOk;
    lines.push(`  Mmember: ${formatCount(mmemberAttempted)} спроб → ${formatCount(mmemberOk)} ок (${formatCount(mmemberFailed)} невдало)`);
  }

  lines.push(
    "",
    `Лоти без жодного фото: ${formatCount(lotsWithoutAnyPhotosStats.total)}`,
    `  Прострочені: ${formatCount(lotsWithoutAnyPhotosStats.missingDueNow)} · Очікуються: ${formatCount(lotsWithoutAnyPhotosStats.missingDueFuture)} · Невідомо: ${formatCount(lotsWithoutAnyPhotosStats.unknown)}`,
  );

  if (endpointIssueStats.total > 0) {
    lines.push("", `Проблеми API: ${formatCount(endpointIssueStats.total)} (звіт додано)`);
  }

  lines.push("", `Час: ${formatDuration(summary.durationMs)}`);

  return lines.join("\n");
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
                ? await runPhotoCluster({
                    candidateMode: "missing_only",
                  })
                : (
                    await runPhotoSync({
                      notifySuccess: false,
                      notifyError: false,
                      candidateMode: "missing_only",
                    })
                  ).summary ?? null;
            if (!summary || !env.telegram.sendSuccessSummary) {
              return;
            }

            let lotsWithoutAnyPhotosReport: GeneratedReportFile | null = null;
            let endpointIssuesReport: GeneratedReportFile | null = null;
            try {
              const lotsWithoutAnyPhotosStats = await fetchLotsWithoutAnyPhotosStats();
              const endpointIssues = await fetchEndpointIssuesForSummary(summary);
              const endpointIssueStats = summarizeEndpointIssues(endpointIssues);
              lotsWithoutAnyPhotosReport = await tryCreateLotsWithoutAnyPhotosReport(
                "copart_lots_without_any_photos_inventory_retry"
              );
              endpointIssuesReport = await tryCreatePhotoEndpointIssuesReport(
                endpointIssues,
                summary.mode === "cluster"
                  ? `copart_endpoint_issues_cluster_${summary.clusterRunId}`
                  : `copart_endpoint_issues_run_${summary.runId}`
              );
              await sendTelegramMessage(
                buildPhotoRetrySuccessMessage(
                  summary,
                  lotsWithoutAnyPhotosStats,
                  endpointIssueStats,
                )
              );
              await sendTelegramDocuments(
                [lotsWithoutAnyPhotosReport, endpointIssuesReport]
                  .filter((file): file is GeneratedReportFile => Boolean(file))
                  .map(file => ({
                    path: file.path,
                    filename: file.filename,
                    caption:
                      file.filename === lotsWithoutAnyPhotosReport?.filename
                        ? `Лоти без фото (${formatCount(lotsWithoutAnyPhotosStats.total)})`
                        : `Проблеми endpoint (${formatCount(endpointIssueStats.total)})`,
                  }))
              );
            } finally {
              await cleanupReportFiles([lotsWithoutAnyPhotosReport, endpointIssuesReport]);
            }
          },
          { notifyError: true }
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
        `CSV: ${describeCron(env.schedule.ingestCron)}`,
        `Ретрай фото: ${describeCron(photoRetryCron)}`,
        `Очищення: ${env.maintenance.enabled ? describeCron(retentionCron) : "вимкнено"}`,
        `Автостарт: ${env.schedule.runOnStart ? "так" : "ні"} · Bot: ${env.telegram.pollingEnabled ? "увімкнено" : "вимкнено"}`,
      ].join("\n")
    );
  }

  await new Promise<void>(() => {
    // Keep process alive for cron jobs.
  });
}
