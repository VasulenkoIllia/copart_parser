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
  runId: number,
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
    valuePlaceholders.push("(?, ?, ?, ?, ?, ?, ?)");
    params.push(
      item.lotNumber,
      item.yardNumber,
      item.imageUrl,
      item.rowHash,
      runId,
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
        row_hash,
        ingest_run_id,
        first_seen_at,
        last_seen_at
      )
      VALUES ${valuePlaceholders.join(", ")}
      ON DUPLICATE KEY UPDATE
        yard_number = VALUES(yard_number),
        photo_status = IF(
          COALESCE(image_url, '') <> COALESCE(VALUES(image_url), ''),
          'unknown',
          photo_status
        ),
        photo_404_count = IF(
          COALESCE(image_url, '') <> COALESCE(VALUES(image_url), ''),
          0,
          photo_404_count
        ),
        photo_404_since = IF(
          COALESCE(image_url, '') <> COALESCE(VALUES(image_url), ''),
          NULL,
          photo_404_since
        ),
        next_photo_retry_at = IF(
          COALESCE(image_url, '') <> COALESCE(VALUES(image_url), ''),
          NULL,
          next_photo_retry_at
        ),
        last_photo_check_at = IF(
          COALESCE(image_url, '') <> COALESCE(VALUES(image_url), ''),
          NULL,
          last_photo_check_at
        ),
        image_url = VALUES(image_url),
        row_hash = VALUES(row_hash),
        ingest_run_id = VALUES(ingest_run_id),
        last_seen_at = VALUES(last_seen_at)
    `,
    params
  );

  return { inserted, updated, unchanged };
}

export async function pruneMissingLots(runId: number): Promise<number> {
  const pool = getPool();
  const [result] = await pool.query<ResultSetHeader>(
    `
      DELETE FROM \`${env.mysql.databaseCore}\`.\`lots\`
      WHERE ingest_run_id <> ?
    `,
    [runId]
  );
  return result.affectedRows;
}

export async function hydrateInsertedLotsPhotoStatusFromMedia(runId: number): Promise<number> {
  const pool = getPool();

  const [result] = await pool.query<ResultSetHeader>(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`lots\` l
      JOIN (
        SELECT lot_number, MAX(last_checked_at) AS max_checked_at
        FROM \`${env.mysql.databaseMedia}\`.\`lot_images\`
        WHERE check_status = 'ok'
          AND is_full_size = 1
          AND variant = 'hd'
        GROUP BY lot_number
      ) m
        ON m.lot_number = l.lot_number
      SET
        l.photo_status = 'ok',
        l.photo_404_count = 0,
        l.photo_404_since = NULL,
        l.next_photo_retry_at = NULL,
        l.last_photo_check_at = COALESCE(m.max_checked_at, CURRENT_TIMESTAMP(3))
      WHERE
        l.ingest_run_id = ?
        AND l.photo_status <> 'ok'
    `,
    [runId]
  );

  return result.affectedRows;
}
