import cron from "node-cron";
import env from "../../config/env";
import { logger } from "../../lib/logger";
import { runCsvIngest } from "../ingest/csv-ingest";
import { runPhotoSync } from "../photo/photo-sync";
import { sendTelegramError, sendTelegramMessage } from "../notify/telegram";

async function safeRun(name: string, action: () => Promise<void>): Promise<void> {
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
  logger.info("Scheduler started", {
    ingestCron: env.schedule.ingestCron,
    photoRetryCron: env.schedule.photoRetryCron,
    timezone: env.app.tz,
    runOnStart: env.schedule.runOnStart,
  });

  cron.schedule(
    env.schedule.ingestCron,
    () => {
      void safeRun("CSV_INGEST", runCsvIngest);
    },
    {
      timezone: env.app.tz,
    }
  );

  cron.schedule(
    env.schedule.photoRetryCron,
    () => {
      void safeRun("PHOTO_SYNC", runPhotoSync);
    },
    {
      timezone: env.app.tz,
    }
  );

  if (env.schedule.runOnStart) {
    await safeRun("CSV_INGEST_ON_START", runCsvIngest);
    await safeRun("PHOTO_SYNC_ON_START", runPhotoSync);
  }

  if (env.telegram.sendSuccessSummary) {
    await sendTelegramMessage(
      [
        "[SCHEDULER] started",
        `ingest_cron=${env.schedule.ingestCron}`,
        `photo_retry_cron=${env.schedule.photoRetryCron}`,
        `timezone=${env.app.tz}`,
      ].join("\n")
    );
  }

  await new Promise<void>(() => {
    // Keep process alive for cron jobs.
  });
}
