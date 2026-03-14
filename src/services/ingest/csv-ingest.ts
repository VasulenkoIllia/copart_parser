import { logger } from "../../lib/logger";
import { buildCsvUrl, downloadCsvStream, iterateCsvRows } from "./csv-source";
import {
  completeIngestRunFailure,
  completeIngestRunSuccess,
  createIngestRun,
  hydrateInsertedLotsPhotoStatusFromMedia,
  pruneMissingLots,
  upsertLotsBatch,
} from "./lot-repository";
import { mapCsvRow } from "./row-mapper";
import { CsvIngestExecutionResult, CsvIngestRunSummary, IngestCandidate, IngestCounters } from "./types";
import env from "../../config/env";
import { withAppLock } from "../locks/db-lock";
import { sendTelegramError, sendTelegramMessage } from "../notify/telegram";
import { cleanupReportFiles } from "../reports/csv-report";
import {
  aggregateInvalidRows,
  InvalidCsvRowReportEntry,
  tryCreateInvalidRowsDebugReport,
  tryCreateInvalidRowsReport,
} from "../reports/run-artifacts";
import { GeneratedReportFile } from "../reports/types";
import { tryStoreInvalidCsvRows } from "./invalid-row-repository";

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

async function flushBatch(
  batch: IngestCandidate[],
  runId: number,
  counters: IngestCounters
): Promise<void> {
  if (batch.length === 0) {
    return;
  }

  const seenAt = new Date();
  const chunks = chunk(batch, env.ingest.upsertChunk);
  for (const currentChunk of chunks) {
    const result = await upsertLotsBatch(currentChunk, runId, seenAt);
    counters.rowsInserted += result.inserted;
    counters.rowsUpdated += result.updated;
    counters.rowsUnchanged += result.unchanged;
  }
}

function invalidRowsPercent(counters: IngestCounters): number {
  if (counters.rowsTotal <= 0) {
    return 0;
  }
  return Number(((counters.rowsInvalid / counters.rowsTotal) * 100).toFixed(4));
}

async function executeCsvIngest(
  options: { notifySuccess?: boolean; notifyError?: boolean; buildInvalidRowsReport?: boolean } = {}
): Promise<CsvIngestRunSummary> {
  const startedAt = Date.now();
  const sourceUrl = getSourceDescriptor();
  const counters = createCounters();
  const batch: IngestCandidate[] = [];
  const invalidRows: InvalidCsvRowReportEntry[] = [];
  const maxRows = env.ingest.maxRows;
  let maxRowsReached = false;
  let prunedLots = 0;
  let hydratedLots = 0;
  let invalidRowsReport: GeneratedReportFile | null = null;
  let invalidRowsDebugReport: GeneratedReportFile | null = null;

  logger.info("CSV ingest started", {
    sourceUrl: toLoggableSource(sourceUrl),
    batchSize: env.ingest.batchSize,
    upsertChunk: env.ingest.upsertChunk,
    maxRows: maxRows > 0 ? maxRows : "unlimited",
    pruneMissingLots: env.ingest.pruneMissingLots,
    pruneMaxInvalidRows: env.ingest.pruneMaxInvalidRows,
    pruneMaxInvalidPercent: env.ingest.pruneMaxInvalidPercent,
  });

  const runId = await createIngestRun(sourceUrl);

  try {
    const stream = await downloadCsvStream();

    for await (const row of iterateCsvRows(stream, meta => {
      counters.rowsTotal += 1;
      counters.rowsInvalid += 1;
      invalidRows.push({
        source: "csv_parse",
        line: meta.line,
        reason: meta.message,
        raw: meta.raw ?? "",
        recordJson: "",
      });
    })) {
      counters.rowsTotal += 1;

      const mapped = mapCsvRow(row.record);
      if (!mapped) {
        counters.rowsInvalid += 1;
        invalidRows.push({
          source: "row_mapper",
          line: row.line,
          reason: "map_csv_row_returned_null",
          raw: row.raw ?? "",
          recordJson: JSON.stringify(row.record),
        });
        continue;
      }

      if (maxRows > 0 && counters.rowsValid >= maxRows) {
        maxRowsReached = true;
        break;
      }

      counters.rowsValid += 1;
      batch.push(mapped);

      if (batch.length >= env.ingest.batchSize) {
        await flushBatch(batch, runId, counters);
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

    await flushBatch(batch, runId, counters);

    hydratedLots = await hydrateInsertedLotsPhotoStatusFromMedia(runId);

    const skipPruneForLimitedRun = maxRows > 0 && maxRowsReached;
    if (env.ingest.pruneMissingLots && !skipPruneForLimitedRun) {
      const invalidPercent = invalidRowsPercent(counters);
      const exceedsInvalidRows = counters.rowsInvalid > env.ingest.pruneMaxInvalidRows;
      const exceedsInvalidPercent = invalidPercent > env.ingest.pruneMaxInvalidPercent;
      if (exceedsInvalidRows || exceedsInvalidPercent) {
        throw new Error(
          [
            "CSV invalid rows threshold exceeded; prune aborted",
            `rows_invalid=${counters.rowsInvalid}`,
            `rows_total=${counters.rowsTotal}`,
            `invalid_percent=${invalidPercent}`,
            `max_invalid_rows=${env.ingest.pruneMaxInvalidRows}`,
            `max_invalid_percent=${env.ingest.pruneMaxInvalidPercent}`,
          ].join("; ")
        );
      }

      prunedLots = await pruneMissingLots(runId);
    } else if (env.ingest.pruneMissingLots && skipPruneForLimitedRun) {
      logger.warn("CSV ingest prune skipped because run used INGEST_MAX_ROWS limit", {
        maxRows,
      });
    }

    await completeIngestRunSuccess(runId, counters, sourceUrl);

    const shouldBuildInvalidRowsReport =
      options.buildInvalidRowsReport ?? ((options.notifySuccess ?? true) && env.telegram.sendSuccessSummary);
    const aggregatedInvalidRows = aggregateInvalidRows(invalidRows);
    await tryStoreInvalidCsvRows(runId, aggregatedInvalidRows);
    if (shouldBuildInvalidRowsReport) {
      invalidRowsReport = await tryCreateInvalidRowsReport(invalidRows);
      invalidRowsDebugReport = await tryCreateInvalidRowsDebugReport(invalidRows);
    }

    const durationMs = Date.now() - startedAt;
    const rowsPerSec = counters.rowsTotal > 0 ? Number((counters.rowsTotal / (durationMs / 1000)).toFixed(2)) : 0;
    logger.info("CSV ingest finished", {
      rowsTotal: counters.rowsTotal,
      rowsValid: counters.rowsValid,
      rowsInvalid: counters.rowsInvalid,
      rowsInserted: counters.rowsInserted,
      rowsUpdated: counters.rowsUpdated,
      rowsUnchanged: counters.rowsUnchanged,
      hydratedLotsFromMedia: hydratedLots,
      prunedLots,
      durationMs,
      rowsPerSec,
      maxRows: maxRows > 0 ? maxRows : null,
      maxRowsReached,
    });

    const summary: CsvIngestRunSummary = {
      runId,
      sourceUrl: toLoggableSource(sourceUrl),
      rowsTotal: counters.rowsTotal,
      rowsValid: counters.rowsValid,
      rowsInvalid: counters.rowsInvalid,
      rowsInserted: counters.rowsInserted,
      rowsUpdated: counters.rowsUpdated,
      rowsUnchanged: counters.rowsUnchanged,
      hydratedLotsFromMedia: hydratedLots,
      prunedLots,
      durationMs,
      maxRows: maxRows > 0 ? maxRows : null,
      maxRowsReached,
      invalidRowsReport,
      invalidRowsDebugReport,
    };

    if ((options.notifySuccess ?? true) && env.telegram.sendSuccessSummary) {
      await sendTelegramMessage(
        [
          "[CSV INGEST] success",
          `rows_total=${counters.rowsTotal}`,
          `rows_valid=${counters.rowsValid}`,
          `rows_invalid=${counters.rowsInvalid}`,
          `rows_inserted=${counters.rowsInserted}`,
          `rows_updated=${counters.rowsUpdated}`,
          `rows_unchanged=${counters.rowsUnchanged}`,
          `hydrated_lots_from_media=${hydratedLots}`,
          `pruned_lots=${prunedLots}`,
        ].join("\n")
      );
      await cleanupReportFiles([invalidRowsReport, invalidRowsDebugReport]);
    }

    return summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;
    await completeIngestRunFailure(runId, counters, message);
    logger.error("CSV ingest failed", {
      message,
      counters,
      durationMs,
    });
    if (options.notifyError ?? true) {
      await sendTelegramError("CSV INGEST FAILED", error);
    }
    throw error;
  }
}

export async function runCsvIngest(
  options: { notifySuccess?: boolean; notifyError?: boolean; buildInvalidRowsReport?: boolean } = {}
): Promise<CsvIngestExecutionResult> {
  const locked = await withAppLock("csv_ingest", () => executeCsvIngest(options));
  if (locked === null) {
    logger.warn("CSV ingest skipped because another run owns the lock");
    return { executed: false };
  }
  return {
    executed: true,
    summary: locked,
  };
}
