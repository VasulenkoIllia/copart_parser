import { logger } from "../../lib/logger";
import { runCsvIngest } from "../ingest/csv-ingest";
import { sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { runPhotoSync } from "../photo/photo-sync";

export async function runFullPipelineOnce(): Promise<void> {
  const startedAt = Date.now();
  logger.info("Pipeline run-once started");
  try {
    await runCsvIngest();
    await runPhotoSync();
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
