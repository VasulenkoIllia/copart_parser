import cron from "node-cron";
import env from "../../config/env";
import { logger } from "../../lib/logger";
import { runPhotoCluster } from "../photo/photo-cluster";
import { runPhotoSync } from "../photo/photo-sync";
import { runFullPipelineOnce } from "../pipeline/run-once";
import { sendTelegramError, sendTelegramMessage } from "../notify/telegram";

async function safeRun(name: string, action: () => Promise<unknown>): Promise<void> {
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
    await sendTelegramError(`${name} JOB FAILED`, error);
  }
}

export async function startScheduler(): Promise<void> {
  const photoRetryCron = env.schedule.photoRetryCron.trim();

  logger.info("Scheduler started", {
    ingestCron: env.schedule.ingestCron,
    photoRetryCron: photoRetryCron || "disabled",
    timezone: env.app.tz,
    runOnStart: env.schedule.runOnStart,
  });

  cron.schedule(
    env.schedule.ingestCron,
    () => {
      void safeRun("PIPELINE_REFRESH", runFullPipelineOnce);
    },
    {
      timezone: env.app.tz,
    }
  );

  if (photoRetryCron) {
    cron.schedule(
      photoRetryCron,
      () => {
        void safeRun("PHOTO_SYNC", () =>
          env.photo.workerTotal > 1 ? runPhotoCluster() : runPhotoSync()
        );
      },
      {
        timezone: env.app.tz,
      }
    );
  }

  if (env.schedule.runOnStart) {
    await safeRun("PIPELINE_REFRESH_ON_START", runFullPipelineOnce);
  }

  if (env.telegram.sendSuccessSummary) {
    await sendTelegramMessage(
      [
        "[SCHEDULER] started",
        `ingest_cron=${env.schedule.ingestCron}`,
        `photo_retry_cron=${photoRetryCron || "disabled"}`,
        `timezone=${env.app.tz}`,
      ].join("\n")
    );
  }

  await new Promise<void>(() => {
    // Keep process alive for cron jobs.
  });
}
