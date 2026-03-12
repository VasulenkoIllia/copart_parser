import { ResultSetHeader, RowDataPacket } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";
import { IngestCandidate, IngestCounters, UpsertBatchResult } from "./types";

interface ExistingLotHashRow extends RowDataPacket {
  lot_number: number;
  row_hash: string;
}

export async function createIngestRun(sourceUrl: string): Promise<number> {
  const pool = getPool();
  const [result] = await pool.query<ResultSetHeader>(
    `
      INSERT INTO \`${env.mysql.databaseCore}\`.\`ingest_runs\`
        (run_type, status, source_url)
      VALUES
        ('csv_ingest', 'running', ?)
    `,
    [sourceUrl]
  );
  return result.insertId;
}

export async function completeIngestRunSuccess(
  runId: number,
  counters: IngestCounters,
  sourceUrl: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`ingest_runs\`
      SET
        status = 'success',
        finished_at = CURRENT_TIMESTAMP(3),
        rows_total = ?,
        rows_valid = ?,
        rows_invalid = ?,
        rows_inserted = ?,
        rows_updated = ?,
        rows_unchanged = ?,
        meta_json = JSON_OBJECT(
          'batchSize', ?,
          'upsertChunk', ?,
          'sourceUrl', ?
        )
      WHERE id = ?
    `,
    [
      counters.rowsTotal,
      counters.rowsValid,
      counters.rowsInvalid,
      counters.rowsInserted,
      counters.rowsUpdated,
      counters.rowsUnchanged,
      env.ingest.batchSize,
      env.ingest.upsertChunk,
      sanitizeSource(sourceUrl),
      runId,
    ]
  );
}

export async function completeIngestRunFailure(
  runId: number,
  counters: IngestCounters,
  errorMessage: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`ingest_runs\`
      SET
        status = 'failed',
        finished_at = CURRENT_TIMESTAMP(3),
        rows_total = ?,
        rows_valid = ?,
        rows_invalid = ?,
        rows_inserted = ?,
        rows_updated = ?,
        rows_unchanged = ?,
        error_message = ?
      WHERE id = ?
    `,
    [
      counters.rowsTotal,
      counters.rowsValid,
      counters.rowsInvalid,
      counters.rowsInserted,
      counters.rowsUpdated,
      counters.rowsUnchanged,
      errorMessage.slice(0, 65_000),
      runId,
    ]
  );
}

function sanitizeSource(source: string): string {
  if (source.startsWith("file://")) {
    return source;
  }

  const url = new URL(source);
  if (url.searchParams.has("authKey")) {
    url.searchParams.set("authKey", "***");
  }
  return url.toString();
}

export async function upsertLotsBatch(
  batch: IngestCandidate[],
  seenAt: Date
): Promise<UpsertBatchResult> {
  if (batch.length === 0) {
    return { inserted: 0, updated: 0, unchanged: 0 };
  }

  const deduped = new Map<number, IngestCandidate>();
  for (const item of batch) {
    deduped.set(item.lotNumber, item);
  }
  const normalizedBatch = Array.from(deduped.values());

  const pool = getPool();
  const lotNumbers = normalizedBatch.map(item => item.lotNumber);
  const placeholders = lotNumbers.map(() => "?").join(", ");

  const [existingRows] = await pool.query<ExistingLotHashRow[]>(
    `
      SELECT lot_number, row_hash
      FROM \`${env.mysql.databaseCore}\`.\`lots\`
      WHERE lot_number IN (${placeholders})
    `,
    lotNumbers
  );

  const existingMap = new Map<number, string>();
  for (const row of existingRows) {
    existingMap.set(Number(row.lot_number), row.row_hash);
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;

  for (const item of normalizedBatch) {
    const previousHash = existingMap.get(item.lotNumber);
    if (!previousHash) {
      inserted += 1;
    } else if (previousHash === item.rowHash) {
      unchanged += 1;
    } else {
      updated += 1;
    }
  }

  const valuePlaceholders: string[] = [];
  const params: Array<number | string | Date | null> = [];

  for (const item of normalizedBatch) {
    valuePlaceholders.push("(?, ?, ?, ?, ?, ?, ?, ?, ?)");
    params.push(
      item.lotNumber,
      item.yardNumber,
      item.imageUrl,
      JSON.stringify(item.rawPayload),
      item.rowHash,
      item.sourceLastUpdatedAt,
      item.sourceCreatedAt,
      seenAt,
      seenAt
    );
  }

  await pool.query(
    `
      INSERT INTO \`${env.mysql.databaseCore}\`.\`lots\` (
        lot_number,
        yard_number,
        image_url,
        raw_payload,
        row_hash,
        source_last_updated_at,
        source_created_at,
        first_seen_at,
        last_seen_at
      )
      VALUES ${valuePlaceholders.join(", ")}
      ON DUPLICATE KEY UPDATE
        yard_number = VALUES(yard_number),
        image_url = VALUES(image_url),
        raw_payload = VALUES(raw_payload),
        row_hash = VALUES(row_hash),
        source_last_updated_at = VALUES(source_last_updated_at),
        source_created_at = VALUES(source_created_at),
        last_seen_at = VALUES(last_seen_at),
        deleted_at = NULL
    `,
    params
  );

  return { inserted, updated, unchanged };
}
