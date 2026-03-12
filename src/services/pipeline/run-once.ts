import { logger } from "../../lib/logger";
import { withAppLock } from "../locks/db-lock";
import { runCsvIngest } from "../ingest/csv-ingest";
import { sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { runPhotoSync } from "../photo/photo-sync";

async function executeFullPipelineOnce(): Promise<void> {
  const startedAt = Date.now();
  logger.info("Pipeline run-once started");
  try {
    const ingestExecuted = await runCsvIngest();
    if (!ingestExecuted) {
      logger.warn("Pipeline run-once aborted because CSV ingest lock was unavailable");
      return;
    }

    const photoExecuted = await runPhotoSync();
    if (!photoExecuted) {
      logger.warn("Pipeline run-once aborted because photo sync lock was unavailable");
      return;
    }

    logger.info("Pipeline run-once finished", {
      durationMs: Date.now() - startedAt,
    });
    await sendTelegramMessage("[PIPELINE] run-once finished");
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
