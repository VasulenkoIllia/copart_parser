import { logger } from "../../lib/logger";
import { buildCsvUrl, downloadCsvStream, iterateCsvRows } from "./csv-source";
import {
  completeIngestRunFailure,
  completeIngestRunSuccess,
  createIngestRun,
  upsertLotsBatch,
} from "./lot-repository";
import { mapCsvRow } from "./row-mapper";
import { IngestCandidate, IngestCounters } from "./types";
import env from "../../config/env";
import { withAppLock } from "../locks/db-lock";
import { sendTelegramError, sendTelegramMessage } from "../notify/telegram";

function getSourceDescriptor(): string {
  if (env.csv.localFile) {
    return `file://${env.csv.localFile}`;
  }
  return buildCsvUrl();
}

function toLoggableSource(descriptor: string): string {
  if (descriptor.startsWith("file://")) {
    return descriptor;
  }
  const url = new URL(descriptor);
  return `${url.origin}${url.pathname}`;
}

function createCounters(): IngestCounters {
  return {
    rowsTotal: 0,
    rowsValid: 0,
    rowsInvalid: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function flushBatch(batch: IngestCandidate[], counters: IngestCounters): Promise<void> {
  if (batch.length === 0) {
    return;
  }

  const seenAt = new Date();
  const chunks = chunk(batch, env.ingest.upsertChunk);
  for (const currentChunk of chunks) {
    const result = await upsertLotsBatch(currentChunk, seenAt);
    counters.rowsInserted += result.inserted;
    counters.rowsUpdated += result.updated;
    counters.rowsUnchanged += result.unchanged;
  }
}

async function executeCsvIngest(): Promise<void> {
  const startedAt = Date.now();
  const sourceUrl = getSourceDescriptor();
  const counters = createCounters();
  const batch: IngestCandidate[] = [];
  const maxRows = env.ingest.maxRows;
  let maxRowsReached = false;

  logger.info("CSV ingest started", {
    sourceUrl: toLoggableSource(sourceUrl),
    batchSize: env.ingest.batchSize,
    upsertChunk: env.ingest.upsertChunk,
    maxRows: maxRows > 0 ? maxRows : "unlimited",
  });

  const runId = await createIngestRun(sourceUrl);

  try {
    const stream = await downloadCsvStream();

    for await (const row of iterateCsvRows(stream, () => {
      counters.rowsTotal += 1;
      counters.rowsInvalid += 1;
    })) {
      counters.rowsTotal += 1;

      const mapped = mapCsvRow(row);
      if (!mapped) {
        counters.rowsInvalid += 1;
        continue;
      }

      if (maxRows > 0 && counters.rowsValid >= maxRows) {
        maxRowsReached = true;
        break;
      }

      counters.rowsValid += 1;
      batch.push(mapped);

      if (batch.length >= env.ingest.batchSize) {
        await flushBatch(batch, counters);
        batch.length = 0;
      }

      if (counters.rowsTotal % env.ingest.progressEveryRows === 0) {
        const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
        logger.info("CSV ingest progress", {
          rowsTotal: counters.rowsTotal,
          rowsValid: counters.rowsValid,
          rowsInvalid: counters.rowsInvalid,
          rowsInserted: counters.rowsInserted,
          rowsUpdated: counters.rowsUpdated,
          rowsUnchanged: counters.rowsUnchanged,
          elapsedSec,
          rowsPerSec: Number((counters.rowsTotal / elapsedSec).toFixed(2)),
          maxRows: maxRows > 0 ? maxRows : null,
        });
      }
    }

    if (maxRowsReached && !stream.destroyed) {
      stream.destroy();
      logger.info("CSV ingest max rows limit reached", {
        maxRows,
        rowsValid: counters.rowsValid,
        rowsTotalSeen: counters.rowsTotal,
      });
    }

    await flushBatch(batch, counters);
    await completeIngestRunSuccess(runId, counters, sourceUrl);

    const durationMs = Date.now() - startedAt;
    const rowsPerSec = counters.rowsTotal > 0 ? Number((counters.rowsTotal / (durationMs / 1000)).toFixed(2)) : 0;
    logger.info("CSV ingest finished", {
      rowsTotal: counters.rowsTotal,
      rowsValid: counters.rowsValid,
      rowsInvalid: counters.rowsInvalid,
      rowsInserted: counters.rowsInserted,
      rowsUpdated: counters.rowsUpdated,
      rowsUnchanged: counters.rowsUnchanged,
      durationMs,
      rowsPerSec,
      maxRows: maxRows > 0 ? maxRows : null,
      maxRowsReached,
    });

    if (env.telegram.sendSuccessSummary) {
      await sendTelegramMessage(
        [
          "[CSV INGEST] success",
          `rows_total=${counters.rowsTotal}`,
          `rows_valid=${counters.rowsValid}`,
          `rows_invalid=${counters.rowsInvalid}`,
          `rows_inserted=${counters.rowsInserted}`,
          `rows_updated=${counters.rowsUpdated}`,
          `rows_unchanged=${counters.rowsUnchanged}`,
        ].join("\n")
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;
    await completeIngestRunFailure(runId, counters, message);
    logger.error("CSV ingest failed", {
      message,
      counters,
      durationMs,
    });
    await sendTelegramError("CSV INGEST FAILED", error);
    throw error;
  }
}

export async function runCsvIngest(): Promise<void> {
  const locked = await withAppLock("csv_ingest", executeCsvIngest);
  if (locked === null) {
    logger.warn("CSV ingest skipped because another run owns the lock");
  }
}
