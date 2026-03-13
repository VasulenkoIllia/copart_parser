import { getPool } from "../../db/mysql";
import env from "../../config/env";
import { logger } from "../../lib/logger";
import { AggregatedInvalidCsvRowReportEntry } from "../reports/run-artifacts";

export async function storeInvalidCsvRows(
  ingestRunId: number,
  entries: AggregatedInvalidCsvRowReportEntry[]
): Promise<void> {
  if (entries.length === 0) {
    return;
  }

  const pool = getPool();
  const placeholders: string[] = [];
  const params: Array<number | string | null> = [];

  for (const entry of entries) {
    placeholders.push("(?, ?, ?, ?, ?, ?, ?)");
    params.push(
      ingestRunId,
      entry.source,
      entry.line,
      entry.reason,
      entry.occurrences,
      entry.sampleRaw || null,
      entry.sampleRecordJson || null
    );
  }

  await pool.query(
    `
      INSERT INTO \`${env.mysql.databaseCore}\`.\`invalid_csv_rows\` (
        ingest_run_id,
        source,
        line_number,
        reason,
        occurrences,
        raw,
        record_json
      )
      VALUES ${placeholders.join(", ")}
    `,
    params
  );
}

export async function tryStoreInvalidCsvRows(
  ingestRunId: number,
  entries: AggregatedInvalidCsvRowReportEntry[]
): Promise<void> {
  try {
    await storeInvalidCsvRows(ingestRunId, entries);
  } catch (error) {
    logger.warn("Failed to store invalid CSV rows", {
      message: error instanceof Error ? error.message : String(error),
      ingestRunId,
      rowCount: entries.length,
    });
  }
}
