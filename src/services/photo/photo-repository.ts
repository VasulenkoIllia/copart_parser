import { createHash } from "crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";
import {
  CheckedLotImage,
  PhotoClusterRunResult,
  PhotoClusterRunSummary,
  PhotoClusterRunWorkerRow,
  ImageCheckStatus,
  ImageVariant,
  ParsedLotImageLink,
  PhotoLotCandidate,
  PhotoRunCounters,
} from "./types";

interface LotCandidateRow extends RowDataPacket {
  lot_number: number;
  yard_number: number | null;
  image_url: string;
  photo_status: "unknown" | "ok" | "missing";
  photo_404_count: number;
}

interface CachedImageRow extends RowDataPacket {
  sequence: number;
  variant: ImageVariant;
  url: string;
  http_status: number | null;
  content_type: string | null;
  content_length: number | null;
  width: number | null;
  height: number | null;
  is_full_size: number;
  check_status: ImageCheckStatus;
  last_checked_at: Date | string | null;
  url_hash: string;
}

interface ClusterSummaryRow extends RowDataPacket {
  workers_finished: number | null;
  workers_succeeded: number | null;
  workers_failed: number | null;
  total_lots_scanned: number | null;
  total_lots_processed: number | null;
  total_lots_ok: number | null;
  total_lots_missing: number | null;
  total_images_upserted: number | null;
  total_images_full_size: number | null;
  total_images_bad_quality: number | null;
  total_http_404_count: number | null;
  total_endpoint_404_lots: number | null;
}

interface ClusterWorkerRow extends RowDataPacket {
  photo_run_id: number;
  worker_index: number | null;
  worker_total: number | null;
  status: "running" | "success" | "failed";
  lots_scanned: number;
  lots_processed: number;
  lots_ok: number;
  lots_missing: number;
  images_upserted: number;
  images_full_size: number;
  images_bad_quality: number;
  http_404_count: number;
  endpoint_404_lots: number | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  duration_ms: number | null;
  error_message: string | null;
}

function parseOptionalClusterRunId(): number | null {
  const raw = process.env.PHOTO_CLUSTER_RUN_ID;
  if (!raw || !raw.trim()) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export async function createPhotoRun(): Promise<number> {
  const pool = getPool();
  const clusterRunId = parseOptionalClusterRunId();
  const [result] = await pool.query<ResultSetHeader>(
    `
      INSERT INTO \`${env.mysql.databaseCore}\`.\`photo_runs\`
        (cluster_run_id, worker_index, worker_total, status)
      VALUES (?, ?, ?, 'running')
    `,
    [clusterRunId, env.photo.workerIndex, env.photo.workerTotal]
  );
  return result.insertId;
}

export async function createPhotoClusterRun(selectedProxyCount: number): Promise<number> {
  const pool = getPool();
  const [result] = await pool.query<ResultSetHeader>(
    `
      INSERT INTO \`${env.mysql.databaseCore}\`.\`photo_cluster_runs\`
        (status, worker_total, meta_json)
      VALUES (
        'running',
        ?,
        JSON_OBJECT(
          'batchSizePerWorker', ?,
          'fetchConcurrencyPerWorker', ?,
          'selectedProxyCount', ?,
          'proxyMode', ?
        )
      )
    `,
    [
      env.photo.workerTotal,
      env.photo.batchSize,
      env.photo.fetchConcurrency,
      selectedProxyCount,
      env.proxy.mode,
    ]
  );
  return result.insertId;
}

export async function completePhotoRunSuccess(
  runId: number,
  counters: PhotoRunCounters
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`photo_runs\`
      SET
        status = 'success',
        finished_at = CURRENT_TIMESTAMP(3),
        lots_scanned = ?,
        lots_processed = ?,
        lots_ok = ?,
        lots_missing = ?,
        images_upserted = ?,
        images_full_size = ?,
        images_bad_quality = ?,
        http_404_count = ?,
        deleted_lots_count = 0,
        meta_json = JSON_OBJECT(
          'batchSize', ?,
          'fetchConcurrency', ?,
          'workerTotal', ?,
          'workerIndex', ?,
          'clusterRunId', ?,
          'endpoint404Lots', ?
        )
      WHERE id = ?
    `,
    [
      counters.lotsScanned,
      counters.lotsProcessed,
      counters.lotsOk,
      counters.lotsMissing,
      counters.imagesUpserted,
      counters.imagesFullSize,
      counters.imagesBadQuality,
      counters.http404Count,
      env.photo.batchSize,
      env.photo.fetchConcurrency,
      env.photo.workerTotal,
      env.photo.workerIndex,
      parseOptionalClusterRunId(),
      counters.endpoint404Lots,
      runId,
    ]
  );
}

export async function completePhotoRunFailure(
  runId: number,
  counters: PhotoRunCounters,
  errorMessage: string
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`photo_runs\`
      SET
        status = 'failed',
        finished_at = CURRENT_TIMESTAMP(3),
        lots_scanned = ?,
        lots_processed = ?,
        lots_ok = ?,
        lots_missing = ?,
        images_upserted = ?,
        images_full_size = ?,
        images_bad_quality = ?,
        http_404_count = ?,
        deleted_lots_count = 0,
        error_message = ?,
        meta_json = JSON_OBJECT(
          'batchSize', ?,
          'fetchConcurrency', ?,
          'workerTotal', ?,
          'workerIndex', ?,
          'clusterRunId', ?,
          'endpoint404Lots', ?
        )
      WHERE id = ?
    `,
    [
      counters.lotsScanned,
      counters.lotsProcessed,
      counters.lotsOk,
      counters.lotsMissing,
      counters.imagesUpserted,
      counters.imagesFullSize,
      counters.imagesBadQuality,
      counters.http404Count,
      errorMessage.slice(0, 65_000),
      env.photo.batchSize,
      env.photo.fetchConcurrency,
      env.photo.workerTotal,
      env.photo.workerIndex,
      parseOptionalClusterRunId(),
      counters.endpoint404Lots,
      runId,
    ]
  );
}

export async function fetchPhotoClusterRunSummary(
  clusterRunId: number
): Promise<PhotoClusterRunSummary> {
  const pool = getPool();
  const [rows] = await pool.query<ClusterSummaryRow[]>(
    `
      SELECT
        COUNT(*) AS workers_finished,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS workers_succeeded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS workers_failed,
        COALESCE(SUM(lots_scanned), 0) AS total_lots_scanned,
        COALESCE(SUM(lots_processed), 0) AS total_lots_processed,
        COALESCE(SUM(lots_ok), 0) AS total_lots_ok,
        COALESCE(SUM(lots_missing), 0) AS total_lots_missing,
        COALESCE(SUM(images_upserted), 0) AS total_images_upserted,
        COALESCE(SUM(images_full_size), 0) AS total_images_full_size,
        COALESCE(SUM(images_bad_quality), 0) AS total_images_bad_quality,
        COALESCE(SUM(http_404_count), 0) AS total_http_404_count,
        COALESCE(
          SUM(
            CAST(
              COALESCE(JSON_UNQUOTE(JSON_EXTRACT(meta_json, '$.endpoint404Lots')), '0') AS UNSIGNED
            )
          ),
          0
        ) AS total_endpoint_404_lots
      FROM \`${env.mysql.databaseCore}\`.\`photo_runs\`
      WHERE cluster_run_id = ?
    `,
    [clusterRunId]
  );

  const row = rows[0];
  return {
    workersFinished: Number(row?.workers_finished ?? 0),
    workersSucceeded: Number(row?.workers_succeeded ?? 0),
    workersFailed: Number(row?.workers_failed ?? 0),
    totalLotsScanned: Number(row?.total_lots_scanned ?? 0),
    totalLotsProcessed: Number(row?.total_lots_processed ?? 0),
    totalLotsOk: Number(row?.total_lots_ok ?? 0),
    totalLotsMissing: Number(row?.total_lots_missing ?? 0),
    totalImagesUpserted: Number(row?.total_images_upserted ?? 0),
    totalImagesFullSize: Number(row?.total_images_full_size ?? 0),
    totalImagesBadQuality: Number(row?.total_images_bad_quality ?? 0),
    totalHttp404Count: Number(row?.total_http_404_count ?? 0),
    totalEndpoint404Lots: Number(row?.total_endpoint_404_lots ?? 0),
  };
}

export async function fetchPhotoClusterRunWorkers(
  clusterRunId: number
): Promise<PhotoClusterRunWorkerRow[]> {
  const pool = getPool();
  const [rows] = await pool.query<ClusterWorkerRow[]>(
    `
      SELECT
        id AS photo_run_id,
        worker_index,
        worker_total,
        status,
        lots_scanned,
        lots_processed,
        lots_ok,
        lots_missing,
        images_upserted,
        images_full_size,
        images_bad_quality,
        http_404_count,
        CAST(
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(meta_json, '$.endpoint404Lots')), '0') AS UNSIGNED
        ) AS endpoint_404_lots,
        started_at,
        finished_at,
        TIMESTAMPDIFF(MICROSECOND, started_at, finished_at) DIV 1000 AS duration_ms,
        error_message
      FROM \`${env.mysql.databaseCore}\`.\`photo_runs\`
      WHERE cluster_run_id = ?
      ORDER BY worker_index ASC, id ASC
    `,
    [clusterRunId]
  );

  return rows.map(row => ({
    photoRunId: Number(row.photo_run_id),
    workerIndex: Number(row.worker_index ?? 0),
    workerTotal: Number(row.worker_total ?? 0),
    status: row.status,
    lotsScanned: Number(row.lots_scanned),
    lotsProcessed: Number(row.lots_processed),
    lotsOk: Number(row.lots_ok),
    lotsMissing: Number(row.lots_missing),
    imagesUpserted: Number(row.images_upserted),
    imagesFullSize: Number(row.images_full_size),
    imagesBadQuality: Number(row.images_bad_quality),
    http404Count: Number(row.http_404_count),
    endpoint404Lots: Number(row.endpoint_404_lots ?? 0),
    startedAt:
      row.started_at instanceof Date ? row.started_at : row.started_at ? new Date(row.started_at) : null,
    finishedAt:
      row.finished_at instanceof Date ? row.finished_at : row.finished_at ? new Date(row.finished_at) : null,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    errorMessage: row.error_message ?? null,
  }));
}

export async function fetchPhotoClusterRunResult(
  clusterRunId: number,
  durationMs: number
): Promise<PhotoClusterRunResult> {
  const summary = await fetchPhotoClusterRunSummary(clusterRunId);
  return {
    clusterRunId,
    mode: "cluster",
    workerTotal: env.photo.workerTotal,
    durationMs,
    ...summary,
  };
}

export async function completePhotoClusterRunSuccess(clusterRunId: number): Promise<void> {
  const summary = await fetchPhotoClusterRunSummary(clusterRunId);
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`photo_cluster_runs\`
      SET
        status = 'success',
        finished_at = CURRENT_TIMESTAMP(3),
        workers_finished = ?,
        workers_succeeded = ?,
        workers_failed = ?,
        total_lots_scanned = ?,
        total_lots_processed = ?,
        total_lots_ok = ?,
        total_lots_missing = ?,
        total_images_upserted = ?,
        total_images_full_size = ?,
        total_images_bad_quality = ?,
        total_http_404_count = ?
        ,meta_json = JSON_OBJECT(
          'totalEndpoint404Lots', ?,
          'workerTotal', ?,
          'batchSizePerWorker', ?,
          'fetchConcurrencyPerWorker', ?
        )
      WHERE id = ?
    `,
    [
      summary.workersFinished,
      summary.workersSucceeded,
      summary.workersFailed,
      summary.totalLotsScanned,
      summary.totalLotsProcessed,
      summary.totalLotsOk,
      summary.totalLotsMissing,
      summary.totalImagesUpserted,
      summary.totalImagesFullSize,
      summary.totalImagesBadQuality,
      summary.totalHttp404Count,
      summary.totalEndpoint404Lots,
      env.photo.workerTotal,
      env.photo.batchSize,
      env.photo.fetchConcurrency,
      clusterRunId,
    ]
  );
}

export async function completePhotoClusterRunFailure(
  clusterRunId: number,
  errorMessage: string
): Promise<void> {
  const summary = await fetchPhotoClusterRunSummary(clusterRunId);
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`photo_cluster_runs\`
      SET
        status = 'failed',
        finished_at = CURRENT_TIMESTAMP(3),
        workers_finished = ?,
        workers_succeeded = ?,
        workers_failed = ?,
        total_lots_scanned = ?,
        total_lots_processed = ?,
        total_lots_ok = ?,
        total_lots_missing = ?,
        total_images_upserted = ?,
        total_images_full_size = ?,
        total_images_bad_quality = ?,
        total_http_404_count = ?,
        error_message = ?,
        meta_json = JSON_OBJECT(
          'totalEndpoint404Lots', ?,
          'workerTotal', ?,
          'batchSizePerWorker', ?,
          'fetchConcurrencyPerWorker', ?
        )
      WHERE id = ?
    `,
    [
      summary.workersFinished,
      summary.workersSucceeded,
      summary.workersFailed,
      summary.totalLotsScanned,
      summary.totalLotsProcessed,
      summary.totalLotsOk,
      summary.totalLotsMissing,
      summary.totalImagesUpserted,
      summary.totalImagesFullSize,
      summary.totalImagesBadQuality,
      summary.totalHttp404Count,
      errorMessage.slice(0, 65_000),
      summary.totalEndpoint404Lots,
      env.photo.workerTotal,
      env.photo.batchSize,
      env.photo.fetchConcurrency,
      clusterRunId,
    ]
  );
}

export async function fetchPhotoCandidates(limit: number): Promise<PhotoLotCandidate[]> {
  const pool = getPool();
  const [rows] = await pool.query<LotCandidateRow[]>(
    `
      SELECT
        l.lot_number,
        l.yard_number,
        l.image_url,
        l.photo_status,
        l.photo_404_count
      FROM \`${env.mysql.databaseCore}\`.\`lots\` l
      WHERE
        l.image_url IS NOT NULL
        AND MOD(CRC32(CAST(l.lot_number AS CHAR)), ?) = ?
        AND NOT EXISTS (
          SELECT 1
          FROM \`${env.mysql.databaseMedia}\`.\`lot_images\` li
          WHERE li.lot_number = l.lot_number
            AND li.check_status = 'ok'
            AND li.is_full_size = 1
            AND li.variant = 'hd'
        )
        AND (
          l.photo_status = 'unknown'
          OR (
            l.photo_status = 'missing'
            AND (
              l.next_photo_retry_at IS NULL
              OR l.next_photo_retry_at <= CURRENT_TIMESTAMP(3)
            )
          )
        )
      ORDER BY COALESCE(l.next_photo_retry_at, TIMESTAMP '1970-01-01 00:00:00') ASC, l.last_seen_at DESC
      LIMIT ?
    `,
    [env.photo.workerTotal, env.photo.workerIndex, limit]
  );

  return rows.map(row => ({
    lotNumber: Number(row.lot_number),
    yardNumber: row.yard_number === null ? null : Number(row.yard_number),
    imageUrl: String(row.image_url),
    photoStatus: row.photo_status,
    photo404Count: Number(row.photo_404_count || 0),
  }));
}

export async function logPhotoAttempt(
  lotNumber: number,
  url: string | null,
  attemptType: "lot_images_endpoint" | "image_head" | "image_get",
  httpStatus: number | null,
  errorCode: string | null,
  errorMessage: string | null
): Promise<void> {
  const shouldLog =
    errorCode !== null ||
    errorMessage !== null ||
    httpStatus === 404 ||
    (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300));

  if (!shouldLog) {
    return;
  }

  const pool = getPool();
  await pool.query(
    `
      INSERT INTO \`${env.mysql.databaseMedia}\`.\`photo_fetch_attempts\`
        (lot_number, url, attempt_type, http_status, error_code, error_message)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    [lotNumber, url, attemptType, httpStatus, errorCode, errorMessage]
  );
}

export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export async function fetchCachedGoodImages(
  lotNumber: number,
  links: ParsedLotImageLink[]
): Promise<Map<string, CheckedLotImage>> {
  if (links.length === 0) {
    return new Map();
  }

  const bySequenceHash = new Map<string, ParsedLotImageLink>();
  const hashes: string[] = [];
  const seenHashes = new Set<string>();

  for (const link of links) {
    const urlHash = hashUrl(link.url);
    bySequenceHash.set(`${link.sequence}:${urlHash}`, link);
    if (!seenHashes.has(urlHash)) {
      seenHashes.add(urlHash);
      hashes.push(urlHash);
    }
  }

  if (hashes.length === 0) {
    return new Map();
  }

  const placeholders = hashes.map(() => "?").join(", ");
  const pool = getPool();
  const [rows] = await pool.query<CachedImageRow[]>(
    `
      SELECT
        sequence,
        variant,
        url,
        url_hash,
        http_status,
        content_type,
        content_length,
        width,
        height,
        is_full_size,
        check_status,
        last_checked_at
      FROM \`${env.mysql.databaseMedia}\`.\`lot_images\`
      WHERE
        lot_number = ?
        AND variant = 'hd'
        AND check_status = 'ok'
        AND is_full_size = 1
        AND url_hash IN (${placeholders})
    `,
    [lotNumber, ...hashes]
  );

  const cached = new Map<string, CheckedLotImage>();
  for (const row of rows) {
    const key = `${Number(row.sequence)}:${String(row.url_hash)}`;
    const link = bySequenceHash.get(key);
    if (!link) {
      continue;
    }

    const lastCheckedAtRaw = row.last_checked_at;
    const lastCheckedAt =
      lastCheckedAtRaw instanceof Date
        ? lastCheckedAtRaw
        : lastCheckedAtRaw
          ? new Date(lastCheckedAtRaw)
          : new Date();

    cached.set(key, {
      lotNumber,
      sequence: Number(row.sequence),
      variant: row.variant,
      url: String(row.url).trim(),
      httpStatus: row.http_status === null ? null : Number(row.http_status),
      contentType: row.content_type ?? null,
      contentLength: row.content_length === null ? null : Number(row.content_length),
      width: row.width === null ? null : Number(row.width),
      height: row.height === null ? null : Number(row.height),
      isFullSize: Number(row.is_full_size) === 1,
      checkStatus: row.check_status,
      lastCheckedAt,
    });
  }

  return cached;
}

export async function replaceLotImages(
  lotNumber: number,
  images: CheckedLotImage[],
  mode: "replace" | "merge" = "replace"
): Promise<void> {
  const pool = getPool();

  if (images.length === 0) {
    if (mode === "replace") {
      await pool.query(
        `DELETE FROM \`${env.mysql.databaseMedia}\`.\`lot_images\` WHERE lot_number = ?`,
        [lotNumber]
      );
    }
    return;
  }

  const placeholders: string[] = [];
  const params: Array<number | string | null | Date> = [];
  const keys: string[] = [];

  for (const image of images) {
    const urlHash = hashUrl(image.url);
    placeholders.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    params.push(
      image.lotNumber,
      image.sequence,
      image.variant,
      image.url,
      urlHash,
      image.httpStatus,
      image.contentType,
      image.contentLength,
      image.width,
      image.height,
      image.isFullSize ? 1 : 0,
      image.checkStatus,
      image.lastCheckedAt
    );
    keys.push(`${image.sequence}:${urlHash}`);
  }

  await pool.query(
    `
      INSERT INTO \`${env.mysql.databaseMedia}\`.\`lot_images\` (
        lot_number,
        sequence,
        variant,
        url,
        url_hash,
        http_status,
        content_type,
        content_length,
        width,
        height,
        is_full_size,
        check_status,
        last_checked_at
      )
      VALUES ${placeholders.join(", ")}
      ON DUPLICATE KEY UPDATE
        variant = VALUES(variant),
        url = VALUES(url),
        http_status = VALUES(http_status),
        content_type = VALUES(content_type),
        content_length = VALUES(content_length),
        width = VALUES(width),
        height = VALUES(height),
        is_full_size = VALUES(is_full_size),
        check_status = VALUES(check_status),
        last_checked_at = VALUES(last_checked_at)
    `,
    params
  );

  if (mode === "replace") {
    const keyPlaceholders = keys.map(() => "?").join(", ");
    await pool.query(
      `
        DELETE FROM \`${env.mysql.databaseMedia}\`.\`lot_images\`
        WHERE lot_number = ?
          AND CONCAT(sequence, ':', url_hash) NOT IN (${keyPlaceholders})
      `,
      [lotNumber, ...keys]
    );
  }
}

export async function markLotPhotoOk(lotNumber: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`lots\`
      SET
        photo_status = 'ok',
        photo_404_count = 0,
        photo_404_since = NULL,
        next_photo_retry_at = NULL,
        last_photo_check_at = CURRENT_TIMESTAMP(3)
      WHERE lot_number = ?
    `,
    [lotNumber]
  );
}

export async function markLotPhotoMissingOn404(
  lotNumber: number,
  backoffMinutes: number
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`lots\`
      SET
        photo_status = 'missing',
        photo_404_count = photo_404_count + 1,
        photo_404_since = COALESCE(photo_404_since, CURRENT_TIMESTAMP(3)),
        next_photo_retry_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MINUTE),
        last_photo_check_at = CURRENT_TIMESTAMP(3)
      WHERE lot_number = ?
    `,
    [backoffMinutes, lotNumber]
  );
}

export async function markLotPhotoMissingTemporary(
  lotNumber: number,
  backoffMinutes: number
): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`lots\`
      SET
        photo_status = 'missing',
        photo_404_count = photo_404_count + 1,
        next_photo_retry_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MINUTE),
        last_photo_check_at = CURRENT_TIMESTAMP(3)
      WHERE lot_number = ?
    `,
    [backoffMinutes, lotNumber]
  );
}

export function calculateBackoffMinutes(nextAttempt: number): number {
  const base = env.photo.retryBaseDelayMinutes;
  const exp = Math.max(0, nextAttempt - 1);
  const candidate = base * Math.pow(2, exp);
  return Math.min(candidate, env.photo.retryMaxDelayMinutes);
}

export function deriveVariant(
  url: string,
  isThumbNail: boolean | undefined,
  isHdImage: boolean | undefined,
  isEngineSound: boolean | undefined
): ImageVariant {
  const normalized = url.toLowerCase();
  if (normalized.endsWith(".mp4") || isEngineSound) {
    return "video";
  }
  if (isThumbNail) {
    return "thumb";
  }
  if (isHdImage || normalized.includes("_hrs.")) {
    return "hd";
  }
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg") || normalized.endsWith(".png")) {
    return "full";
  }
  return "unknown";
}

function variantPriority(variant: ImageVariant): number {
  switch (variant) {
    case "hd":
      return 4;
    case "full":
      return 3;
    case "unknown":
      return 2;
    case "thumb":
      return 1;
    case "video":
      return 0;
    default:
      return 0;
  }
}

export function selectImagesForStorage(images: CheckedLotImage[]): CheckedLotImage[] {
  const map = new Map<string, CheckedLotImage>();

  for (const image of images) {
    const isGood =
      image.checkStatus === "ok" &&
      image.isFullSize &&
      image.variant === "hd";
    if (!isGood) {
      continue;
    }

    const key = `${image.sequence}:${image.url}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, image);
      continue;
    }

    const existingVariantPriority = variantPriority(existing.variant);
    const imageVariantPriority = variantPriority(image.variant);
    if (imageVariantPriority > existingVariantPriority) {
      map.set(key, image);
      continue;
    }

    const existingPixels = (existing.width ?? 0) * (existing.height ?? 0);
    const imagePixels = (image.width ?? 0) * (image.height ?? 0);
    if (imagePixels > existingPixels) {
      map.set(key, image);
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    if (a.sequence !== b.sequence) {
      return a.sequence - b.sequence;
    }
    const variantDiff = variantPriority(b.variant) - variantPriority(a.variant);
    if (variantDiff !== 0) {
      return variantDiff;
    }
    const aPixels = (a.width ?? 0) * (a.height ?? 0);
    const bPixels = (b.width ?? 0) * (b.height ?? 0);
    return bPixels - aPixels;
  });
}

export function summarizeImageChecks(images: CheckedLotImage[]): {
  total: number;
  fullSize: number;
  badQuality: number;
  notFound: number;
} {
  let fullSize = 0;
  let badQuality = 0;
  let notFound = 0;

  for (const image of images) {
    if (image.isFullSize) {
      fullSize += 1;
    }
    if (image.variant !== "thumb" && image.checkStatus === "bad_quality") {
      badQuality += 1;
    }
    if (image.checkStatus === "not_found") {
      notFound += 1;
    }
  }

  return {
    total: images.length,
    fullSize,
    badQuality,
    notFound,
  };
}

export function normalizeImageCheckStatus(status: number | null): ImageCheckStatus {
  if (status === null) {
    return "error";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status >= 200 && status < 300) {
    return "ok";
  }
  if (status >= 400 && status < 500) {
    return "bad_quality";
  }
  return "error";
}
