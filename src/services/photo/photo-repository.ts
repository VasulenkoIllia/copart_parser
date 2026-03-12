import { createHash } from "crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";
import {
  CheckedLotImage,
  ImageCheckStatus,
  ImageVariant,
  PhotoLotCandidate,
  PhotoRunCounters,
} from "./types";

interface LotCandidateRow extends RowDataPacket {
  lot_number: number;
  yard_number: number | null;
  image_url: string;
  photo_status: "unknown" | "ok" | "partial" | "missing";
  photo_404_count: number;
}

interface NumberRow extends RowDataPacket {
  lot_number: number;
}

export async function createPhotoRun(): Promise<number> {
  const pool = getPool();
  const [result] = await pool.query<ResultSetHeader>(
    `
      INSERT INTO \`${env.mysql.databaseCore}\`.\`photo_runs\` (status)
      VALUES ('running')
    `
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
        lots_partial = ?,
        lots_missing = ?,
        images_upserted = ?,
        images_full_size = ?,
        images_bad_quality = ?,
        http_404_count = ?,
        deleted_lots_count = ?,
        meta_json = JSON_OBJECT(
          'batchSize', ?,
          'fetchConcurrency', ?,
          'workerTotal', ?,
          'workerIndex', ?
        )
      WHERE id = ?
    `,
    [
      counters.lotsScanned,
      counters.lotsProcessed,
      counters.lotsOk,
      counters.lotsPartial,
      counters.lotsMissing,
      counters.imagesUpserted,
      counters.imagesFullSize,
      counters.imagesBadQuality,
      counters.http404Count,
      counters.deletedLotsCount,
      env.photo.batchSize,
      env.photo.fetchConcurrency,
      env.photo.workerTotal,
      env.photo.workerIndex,
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
        lots_partial = ?,
        lots_missing = ?,
        images_upserted = ?,
        images_full_size = ?,
        images_bad_quality = ?,
        http_404_count = ?,
        deleted_lots_count = ?,
        error_message = ?
      WHERE id = ?
    `,
    [
      counters.lotsScanned,
      counters.lotsProcessed,
      counters.lotsOk,
      counters.lotsPartial,
      counters.lotsMissing,
      counters.imagesUpserted,
      counters.imagesFullSize,
      counters.imagesBadQuality,
      counters.http404Count,
      counters.deletedLotsCount,
      errorMessage.slice(0, 65_000),
      runId,
    ]
  );
}

export async function fetchPhotoCandidates(limit: number): Promise<PhotoLotCandidate[]> {
  const pool = getPool();
  const [rows] = await pool.query<LotCandidateRow[]>(
    `
      SELECT
        lot_number,
        yard_number,
        image_url,
        photo_status,
        photo_404_count
      FROM \`${env.mysql.databaseCore}\`.\`lots\`
      WHERE
        deleted_at IS NULL
        AND image_url IS NOT NULL
        AND MOD(lot_number, ?) = ?
        AND (
          photo_status = 'unknown'
          OR (
            photo_status = 'missing'
            AND (next_photo_retry_at IS NULL OR next_photo_retry_at <= CURRENT_TIMESTAMP(3))
          )
          OR (
            photo_status = 'partial'
            AND (
              next_photo_retry_at IS NULL
              OR next_photo_retry_at <= CURRENT_TIMESTAMP(3)
              OR last_photo_check_at IS NULL
              OR last_photo_check_at <= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR)
            )
          )
        )
      ORDER BY COALESCE(next_photo_retry_at, TIMESTAMP '1970-01-01 00:00:00') ASC, last_seen_at DESC
      LIMIT ?
    `,
    [env.photo.workerTotal, env.photo.workerIndex, env.photo.recheckPartialAfterHours, limit]
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

function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
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

export async function markLotPhotoPartial(lotNumber: number): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`lots\`
      SET
        photo_status = 'partial',
        next_photo_retry_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? HOUR),
        last_photo_check_at = CURRENT_TIMESTAMP(3)
      WHERE lot_number = ?
    `,
    [env.photo.recheckPartialAfterHours, lotNumber]
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
        next_photo_retry_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? MINUTE),
        last_photo_check_at = CURRENT_TIMESTAMP(3)
      WHERE lot_number = ?
    `,
    [backoffMinutes, lotNumber]
  );
}

export async function deleteExpired404Lots(): Promise<number> {
  const pool = getPool();

  const [rows] = await pool.query<NumberRow[]>(
    `
      SELECT lot_number
      FROM \`${env.mysql.databaseCore}\`.\`lots\`
      WHERE
        deleted_at IS NULL
        AND photo_status = 'missing'
        AND photo_404_since IS NOT NULL
        AND photo_404_since <= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)
    `,
    [env.photo.deleteAfterDays]
  );

  if (rows.length === 0) {
    return 0;
  }

  const lotNumbers = rows.map(row => Number(row.lot_number));
  const placeholders = lotNumbers.map(() => "?").join(", ");

  await pool.query(
    `DELETE FROM \`${env.mysql.databaseMedia}\`.\`lot_images\` WHERE lot_number IN (${placeholders})`,
    lotNumbers
  );
  await pool.query(
    `DELETE FROM \`${env.mysql.databaseMedia}\`.\`photo_fetch_attempts\` WHERE lot_number IN (${placeholders})`,
    lotNumbers
  );
  await pool.query(
    `DELETE FROM \`${env.mysql.databaseCore}\`.\`lots\` WHERE lot_number IN (${placeholders})`,
    lotNumbers
  );

  return lotNumbers.length;
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
  if (isHdImage) {
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

function pickBestImagesPerSequence(images: CheckedLotImage[]): CheckedLotImage[] {
  const bySequence = new Map<number, CheckedLotImage[]>();
  for (const image of images) {
    if (image.variant === "video") {
      continue;
    }
    const current = bySequence.get(image.sequence) ?? [];
    current.push(image);
    bySequence.set(image.sequence, current);
  }

  const best: CheckedLotImage[] = [];

  for (const sequenceImages of bySequence.values()) {
    const sorted = [...sequenceImages].sort((a, b) => {
      const aQuality = a.isFullSize ? 1 : 0;
      const bQuality = b.isFullSize ? 1 : 0;
      if (aQuality !== bQuality) {
        return bQuality - aQuality;
      }

      const aVariant = variantPriority(a.variant);
      const bVariant = variantPriority(b.variant);
      if (aVariant !== bVariant) {
        return bVariant - aVariant;
      }

      const aPixels = (a.width ?? 0) * (a.height ?? 0);
      const bPixels = (b.width ?? 0) * (b.height ?? 0);
      return bPixels - aPixels;
    });

    best.push(sorted[0]);
  }

  return best;
}

export function selectImagesForStorage(images: CheckedLotImage[]): CheckedLotImage[] {
  const map = new Map<string, CheckedLotImage>();

  for (const image of images) {
    const isGood =
      image.checkStatus === "ok" &&
      image.isFullSize &&
      image.variant !== "thumb" &&
      image.variant !== "video";
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

export function evaluateLotStatus(images: CheckedLotImage[]): {
  status: "ok" | "partial" | "missing";
  fullCount: number;
  badCount: number;
} {
  if (images.length === 0) {
    return { status: "missing", fullCount: 0, badCount: 0 };
  }

  const relevant = pickBestImagesPerSequence(images);
  if (relevant.length === 0) {
    return { status: "missing", fullCount: 0, badCount: images.length };
  }

  let fullCount = 0;
  let badCount = 0;

  for (const image of relevant) {
    const isGood =
      image.checkStatus === "ok" &&
      image.isFullSize &&
      image.variant !== "thumb" &&
      image.variant !== "video";
    if (isGood) {
      fullCount += 1;
    } else {
      badCount += 1;
    }
  }

  if (badCount === 0) {
    return { status: "ok", fullCount, badCount };
  }

  return { status: "partial", fullCount, badCount };
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
