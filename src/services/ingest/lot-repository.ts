import { ResultSetHeader, RowDataPacket } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";
import { isRowChangeExcludedField } from "./row-change-exclusions";
import { CsvFieldUpdateStat, CsvRecord, IngestCandidate, IngestCounters, UpsertBatchResult } from "./types";

interface ExistingLotHashRow extends RowDataPacket {
  lot_number: number;
  row_hash: string;
  image_url: string | null;
  csv_payload: unknown;
}

interface ExistingLotSnapshot {
  rowHash: string;
  imageUrl: string | null;
  csvPayload: CsvRecord;
}

interface ColumnNameRow extends RowDataPacket {
  column_name: string;
}

interface CsvFieldColumnMapping {
  field: string;
  column: string;
}

interface EnsureCsvColumnsResult {
  mappings: CsvFieldColumnMapping[];
}

let lotsColumnsCache: Set<string> | null = null;

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
          'sourceUrl', ?,
          'rowsUpdatedImageUrlChanged', ?,
          'rowsUpdatedOtherFields', ?
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
      counters.rowsUpdatedImageUrlChanged,
      counters.rowsUpdatedOtherFields,
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

function normalizeCsvPayload(value: unknown): CsvRecord {
  if (Buffer.isBuffer(value)) {
    return parseCsvPayload(value.toString("utf8"));
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized: CsvRecord = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    normalized[String(key)] = item === undefined || item === null ? "" : String(item).trim();
  }
  return normalized;
}

function parseCsvPayload(value: unknown): CsvRecord {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value === "string") {
    try {
      return normalizeCsvPayload(JSON.parse(value));
    } catch {
      return {};
    }
  }

  return normalizeCsvPayload(value);
}

function getChangedFields(previous: CsvRecord, current: CsvRecord): string[] {
  const keys = new Set<string>([...Object.keys(previous), ...Object.keys(current)]);
  const changedFields: string[] = [];
  for (const key of keys) {
    if (isRowChangeExcludedField(key)) {
      continue;
    }
    const previousHasKey = Object.prototype.hasOwnProperty.call(previous, key);
    const currentHasKey = Object.prototype.hasOwnProperty.call(current, key);
    const previousValue = previousHasKey ? previous[key] : "";
    const currentValue = currentHasKey ? current[key] : "";
    if (previousHasKey !== currentHasKey || previousValue !== currentValue) {
      changedFields.push(key);
    }
  }
  return changedFields;
}

function toUpdatedFieldStats(counters: Map<string, number>): CsvFieldUpdateStat[] {
  return Array.from(counters.entries()).map(([field, lotsUpdated]) => ({
    field,
    lotsUpdated,
  }));
}

function escapeIdentifier(identifier: string): string {
  return `\`${identifier.replace(/`/g, "``")}\``;
}

function csvFieldToColumnName(field: string): string {
  const base = field
    .replace(/\u0000/g, "")
    .replace(/\r?\n/g, " ")
    .trim();
  const normalizedBase = base || "field";
  const column = `csv_${normalizedBase}`;
  if (column.length > 64) {
    throw new Error(`CSV header is too long for MySQL column name: "${field}"`);
  }
  return column;
}

function escapeJsonPathField(field: string): string {
  return field
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'");
}

async function getLotsColumns(): Promise<Set<string>> {
  if (lotsColumnsCache) {
    return lotsColumnsCache;
  }

  const pool = getPool();
  const [rows] = await pool.query<ColumnNameRow[]>(
    `
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'lots'
    `,
    [env.mysql.databaseCore]
  );

  lotsColumnsCache = new Set(rows.map(row => String(row.column_name)));
  return lotsColumnsCache;
}

async function ensureCsvColumnsForBatch(batch: IngestCandidate[]): Promise<EnsureCsvColumnsResult> {
  const fields = new Set<string>();
  for (const item of batch) {
    for (const field of Object.keys(item.csvPayload)) {
      fields.add(field);
    }
  }

  if (fields.size === 0) {
    return { mappings: [] };
  }

  const mappings = Array.from(fields).map(field => ({
    field,
    column: csvFieldToColumnName(field),
  }));

  const columnToField = new Map<string, string>();
  for (const mapping of mappings) {
    const key = mapping.column.toLowerCase();
    const existingField = columnToField.get(key);
    if (existingField && existingField !== mapping.field) {
      throw new Error(
        `CSV header collision for column "${mapping.column}": "${existingField}" and "${mapping.field}"`
      );
    }
    columnToField.set(key, mapping.field);
  }

  const existingColumns = await getLotsColumns();
  const existingColumnsLookup = new Set(Array.from(existingColumns).map(column => column.toLowerCase()));
  const missingColumns = mappings.filter(mapping => !existingColumnsLookup.has(mapping.column.toLowerCase()));
  if (missingColumns.length > 0) {
    const pool = getPool();
    const clauses = missingColumns
      .map(mapping => `ADD COLUMN ${escapeIdentifier(mapping.column)} TEXT NULL`)
      .join(",\n  ");

    await pool.query(
      `
        ALTER TABLE \`${env.mysql.databaseCore}\`.\`lots\`
        ${clauses}
      `
    );

    for (const mapping of missingColumns) {
      existingColumns.add(mapping.column);
      existingColumnsLookup.add(mapping.column.toLowerCase());
    }
    lotsColumnsCache = existingColumns;

    const setClauses = missingColumns
      .map(
        mapping =>
          `${escapeIdentifier(mapping.column)} = JSON_UNQUOTE(JSON_EXTRACT(csv_payload, '$."${escapeJsonPathField(mapping.field)}"'))`
      )
      .join(",\n          ");

    if (setClauses) {
      await pool.query(
        `
          UPDATE \`${env.mysql.databaseCore}\`.\`lots\`
          SET
            ${setClauses}
        `
      );
    }
  }

  return { mappings };
}

async function stageLotNumbers(lotNumbers: number[], seenAt: Date): Promise<void> {
  if (lotNumbers.length === 0) {
    return;
  }

  const pool = getPool();
  const placeholders: string[] = [];
  const params: Array<number | Date> = [];
  for (const lotNumber of lotNumbers) {
    placeholders.push("(?, ?)");
    params.push(lotNumber, seenAt);
  }

  await pool.query(
    `
      INSERT INTO \`${env.mysql.databaseCore}\`.\`ingest_lot_stage\` (
        lot_number,
        seen_at
      )
      VALUES ${placeholders.join(", ")}
      ON DUPLICATE KEY UPDATE
        seen_at = VALUES(seen_at)
    `,
    params
  );
}

export async function upsertLotsBatch(
  batch: IngestCandidate[],
  runId: number,
  seenAt: Date
): Promise<UpsertBatchResult> {
  if (batch.length === 0) {
    return {
      inserted: 0,
      updated: 0,
      updatedImageUrlChanged: 0,
      updatedOtherFields: 0,
      unchanged: 0,
      updatedFields: [],
    };
  }

  const deduped = new Map<number, IngestCandidate>();
  for (const item of batch) {
    deduped.set(item.lotNumber, item);
  }
  const normalizedBatch = Array.from(deduped.values());
  const { mappings: csvFieldColumns } = await ensureCsvColumnsForBatch(normalizedBatch);

  const pool = getPool();
  const lotNumbers = normalizedBatch.map(item => item.lotNumber);
  await stageLotNumbers(lotNumbers, seenAt);
  const placeholders = lotNumbers.map(() => "?").join(", ");

  const [existingRows] = await pool.query<ExistingLotHashRow[]>(
    `
      SELECT lot_number, row_hash, image_url, csv_payload
      FROM \`${env.mysql.databaseCore}\`.\`lots\`
      WHERE lot_number IN (${placeholders})
    `,
    lotNumbers
  );

  const existingMap = new Map<number, ExistingLotSnapshot>();
  for (const row of existingRows) {
    existingMap.set(Number(row.lot_number), {
      rowHash: row.row_hash,
      imageUrl: row.image_url === null ? null : String(row.image_url),
      csvPayload: parseCsvPayload(row.csv_payload),
    });
  }

  let inserted = 0;
  let updated = 0;
  let updatedImageUrlChanged = 0;
  let updatedOtherFields = 0;
  let unchanged = 0;
  const updatedFields = new Map<string, number>();
  const changedRows: IngestCandidate[] = [];

  for (const item of normalizedBatch) {
    const previous = existingMap.get(item.lotNumber);
    if (!previous) {
      inserted += 1;
      changedRows.push(item);
    } else {
      const changedFields = getChangedFields(previous.csvPayload, item.csvPayload);
      const payloadChanged = changedFields.length > 0;
      const hashChanged = previous.rowHash !== item.rowHash;

      if (!hashChanged && !payloadChanged) {
        unchanged += 1;
      } else {
        updated += 1;
        changedRows.push(item);

        const previousImageUrl = previous.imageUrl;
        const nextImageUrl = item.imageUrl ?? null;
        if (previousImageUrl !== nextImageUrl) {
          updatedImageUrlChanged += 1;
        } else {
          updatedOtherFields += 1;
        }

        for (const field of changedFields) {
          updatedFields.set(field, (updatedFields.get(field) ?? 0) + 1);
        }
      }
    }
  }

  if (changedRows.length > 0) {
    const insertColumns = [
      "lot_number",
      "yard_number",
      "image_url",
      "row_hash",
      "csv_payload",
      ...csvFieldColumns.map(mapping => mapping.column),
      "ingest_run_id",
      "first_seen_at",
      "last_seen_at",
    ];
    const insertColumnsSql = insertColumns.map(column => escapeIdentifier(column)).join(",\n          ");
    const dynamicUpdateSql = csvFieldColumns
      .map(mapping => `${escapeIdentifier(mapping.column)} = VALUES(${escapeIdentifier(mapping.column)})`)
      .join(",\n          ");

    const valuePlaceholders: string[] = [];
    const params: Array<number | string | Date | null> = [];

    for (const item of changedRows) {
      valuePlaceholders.push(`(${new Array(insertColumns.length).fill("?").join(", ")})`);
      const dynamicValues = csvFieldColumns.map(mapping =>
        Object.prototype.hasOwnProperty.call(item.csvPayload, mapping.field) ? item.csvPayload[mapping.field] : null
      );
      params.push(
        item.lotNumber,
        item.yardNumber,
        item.imageUrl,
        item.rowHash,
        JSON.stringify(item.csvPayload),
        ...dynamicValues,
        runId,
        seenAt,
        seenAt
      );
    }

    await pool.query(
      `
        INSERT INTO \`${env.mysql.databaseCore}\`.\`lots\` (
          ${insertColumnsSql}
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
          image_url = VALUES(image_url),
          row_hash = VALUES(row_hash),
          csv_payload = VALUES(csv_payload),
          ${dynamicUpdateSql ? `${dynamicUpdateSql},` : ""}
          ingest_run_id = VALUES(ingest_run_id),
          last_seen_at = VALUES(last_seen_at)
      `,
      params
    );
  }

  return {
    inserted,
    updated,
    updatedImageUrlChanged,
    updatedOtherFields,
    unchanged,
    updatedFields: toUpdatedFieldStats(updatedFields),
  };
}

export async function clearIngestLotStage(): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM \`${env.mysql.databaseCore}\`.\`ingest_lot_stage\``);
}

export async function pruneMissingLots(): Promise<number> {
  const pool = getPool();
  const [result] = await pool.query<ResultSetHeader>(
    `
      DELETE l
      FROM \`${env.mysql.databaseCore}\`.\`lots\` l
      LEFT JOIN \`${env.mysql.databaseCore}\`.\`ingest_lot_stage\` s
        ON s.lot_number = l.lot_number
      WHERE s.lot_number IS NULL
    `
  );
  return result.affectedRows;
}

export async function pruneOrphanLotImages(batchSize: number = env.maintenance.batchSize): Promise<number> {
  const pool = getPool();
  const safeBatchSize = Math.max(1, batchSize);
  let total = 0;

  while (true) {
    const [result] = await pool.query<ResultSetHeader>(
      `
        DELETE FROM \`${env.mysql.databaseMedia}\`.\`lot_images\`
        WHERE id IN (
          SELECT id
          FROM (
            SELECT li.id
            FROM \`${env.mysql.databaseMedia}\`.\`lot_images\` li
            LEFT JOIN \`${env.mysql.databaseCore}\`.\`lots\` l
              ON l.lot_number = li.lot_number
            WHERE l.lot_number IS NULL
            ORDER BY li.id
            LIMIT ?
          ) orphan_ids
        )
      `,
      [safeBatchSize]
    );

    const deleted = Number(result.affectedRows ?? 0);
    total += deleted;
    if (deleted < safeBatchSize) {
      break;
    }
  }

  return total;
}

export async function hydrateInsertedLotsPhotoStatusFromMedia(): Promise<number> {
  const pool = getPool();

  const [result] = await pool.query<ResultSetHeader>(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`lots\` l
      JOIN \`${env.mysql.databaseCore}\`.\`ingest_lot_stage\` s
        ON s.lot_number = l.lot_number
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
        l.photo_status = 'unknown'
        AND l.last_photo_check_at IS NULL
    `
  );

  return result.affectedRows;
}
