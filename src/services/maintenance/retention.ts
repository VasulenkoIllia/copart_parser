import { ResultSetHeader } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";
import { logger } from "../../lib/logger";
import { withAppLocks } from "../locks/db-lock";
import { LOTS_MEDIA_GATE_LOCK, PIPELINE_REFRESH_LOCK, RETENTION_CLEANUP_LOCK } from "../locks/lock-names";
import { sendTelegramMessage } from "../notify/telegram";

export interface RetentionCleanupSummary {
  deletedOrphanLotImages: number;
  deletedOrphanPhotoFetchAttempts: number;
  deletedPhotoFetchAttempts: number;
  deletedInvalidCsvRows: number;
  deletedIngestRuns: number;
  deletedPhotoRuns: number;
  deletedPhotoClusterRuns: number;
  durationMs: number;
}

export interface RetentionCleanupExecutionResult {
  executed: boolean;
  summary?: RetentionCleanupSummary;
}

interface RetentionCleanupOptions {
  ignoreEnabledFlag?: boolean;
}

async function deleteInBatches(
  sql: string,
  params: Array<number | string | Date | null>,
  batchSize: number,
  target: string
): Promise<number> {
  const pool = getPool();
  let total = 0;

  while (true) {
    const [result] = await pool.query<ResultSetHeader>(sql, [...params, batchSize]);
    const affectedRows = Number(result.affectedRows ?? 0);
    total += affectedRows;
    if (affectedRows < batchSize) {
      break;
    }
  }

  if (total > 0) {
    logger.info("Retention cleanup deleted rows", {
      target,
      rows: total,
    });
  }

  return total;
}

async function executeRetentionCleanup(): Promise<RetentionCleanupSummary> {
  const startedAt = Date.now();
  const batchSize = env.maintenance.batchSize;

  logger.info("Retention cleanup started", {
    batchSize,
    pruneOrphanLotImages: env.maintenance.pruneOrphanLotImages,
    photoFetchAttemptsRetentionDays: env.maintenance.photoFetchAttemptsRetentionDays,
    invalidCsvRowsRetentionDays: env.maintenance.invalidCsvRowsRetentionDays,
    ingestRunsRetentionDays: env.maintenance.ingestRunsRetentionDays,
    photoRunsRetentionDays: env.maintenance.photoRunsRetentionDays,
    photoClusterRunsRetentionDays: env.maintenance.photoClusterRunsRetentionDays,
  });

  let deletedOrphanLotImages = 0;
  let deletedOrphanPhotoFetchAttempts = 0;
  let deletedPhotoFetchAttempts = 0;
  let deletedInvalidCsvRows = 0;
  let deletedIngestRuns = 0;
  let deletedPhotoRuns = 0;
  let deletedPhotoClusterRuns = 0;

  if (env.maintenance.pruneOrphanLotImages) {
    deletedOrphanLotImages = await deleteInBatches(
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
      [],
      batchSize,
      `${env.mysql.databaseMedia}.lot_images (orphan)`
    );
  }

  deletedOrphanPhotoFetchAttempts = await deleteInBatches(
    `
      DELETE FROM \`${env.mysql.databaseMedia}\`.\`photo_fetch_attempts\`
      WHERE id IN (
        SELECT id
        FROM (
          SELECT pfa.id
          FROM \`${env.mysql.databaseMedia}\`.\`photo_fetch_attempts\` pfa
          LEFT JOIN \`${env.mysql.databaseCore}\`.\`lots\` l
            ON l.lot_number = pfa.lot_number
          WHERE l.lot_number IS NULL
          ORDER BY pfa.id
          LIMIT ?
        ) orphan_attempt_ids
      )
    `,
    [],
    batchSize,
    `${env.mysql.databaseMedia}.photo_fetch_attempts (orphan)`
  );

  if (env.maintenance.photoFetchAttemptsRetentionDays > 0) {
    deletedPhotoFetchAttempts = await deleteInBatches(
      `
        DELETE FROM \`${env.mysql.databaseMedia}\`.\`photo_fetch_attempts\`
        WHERE attempted_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)
        ORDER BY attempted_at, id
        LIMIT ?
      `,
      [env.maintenance.photoFetchAttemptsRetentionDays],
      batchSize,
      `${env.mysql.databaseMedia}.photo_fetch_attempts`
    );
  }

  if (env.maintenance.invalidCsvRowsRetentionDays > 0) {
    deletedInvalidCsvRows = await deleteInBatches(
      `
        DELETE FROM \`${env.mysql.databaseCore}\`.\`invalid_csv_rows\`
        WHERE created_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)
        ORDER BY created_at, id
        LIMIT ?
      `,
      [env.maintenance.invalidCsvRowsRetentionDays],
      batchSize,
      `${env.mysql.databaseCore}.invalid_csv_rows`
    );
  }

  if (env.maintenance.ingestRunsRetentionDays > 0) {
    deletedIngestRuns = await deleteInBatches(
      `
        DELETE FROM \`${env.mysql.databaseCore}\`.\`ingest_runs\`
        WHERE
          status IN ('success', 'failed')
          AND finished_at IS NOT NULL
          AND finished_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)
        ORDER BY finished_at, id
        LIMIT ?
      `,
      [env.maintenance.ingestRunsRetentionDays],
      batchSize,
      `${env.mysql.databaseCore}.ingest_runs`
    );
  }

  if (env.maintenance.photoRunsRetentionDays > 0) {
    deletedPhotoRuns = await deleteInBatches(
      `
        DELETE FROM \`${env.mysql.databaseCore}\`.\`photo_runs\`
        WHERE
          status IN ('success', 'failed')
          AND finished_at IS NOT NULL
          AND finished_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)
        ORDER BY finished_at, id
        LIMIT ?
      `,
      [env.maintenance.photoRunsRetentionDays],
      batchSize,
      `${env.mysql.databaseCore}.photo_runs`
    );
  }

  if (env.maintenance.photoClusterRunsRetentionDays > 0) {
    deletedPhotoClusterRuns = await deleteInBatches(
      `
        DELETE FROM \`${env.mysql.databaseCore}\`.\`photo_cluster_runs\`
        WHERE
          status IN ('success', 'failed')
          AND finished_at IS NOT NULL
          AND finished_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)
        ORDER BY finished_at, id
        LIMIT ?
      `,
      [env.maintenance.photoClusterRunsRetentionDays],
      batchSize,
      `${env.mysql.databaseCore}.photo_cluster_runs`
    );
  }

  const summary: RetentionCleanupSummary = {
    deletedOrphanLotImages,
    deletedOrphanPhotoFetchAttempts,
    deletedPhotoFetchAttempts,
    deletedInvalidCsvRows,
    deletedIngestRuns,
    deletedPhotoRuns,
    deletedPhotoClusterRuns,
    durationMs: Date.now() - startedAt,
  };

  logger.info("Retention cleanup finished", {
    deletedOrphanLotImages: summary.deletedOrphanLotImages,
    deletedOrphanPhotoFetchAttempts: summary.deletedOrphanPhotoFetchAttempts,
    deletedPhotoFetchAttempts: summary.deletedPhotoFetchAttempts,
    deletedInvalidCsvRows: summary.deletedInvalidCsvRows,
    deletedIngestRuns: summary.deletedIngestRuns,
    deletedPhotoRuns: summary.deletedPhotoRuns,
    deletedPhotoClusterRuns: summary.deletedPhotoClusterRuns,
    durationMs: summary.durationMs,
  });

  if (env.telegram.sendSuccessSummary) {
    await sendTelegramMessage(
      [
        "[RETENTION CLEANUP] success",
        `deleted_orphan_lot_images=${summary.deletedOrphanLotImages}`,
        `deleted_orphan_photo_fetch_attempts=${summary.deletedOrphanPhotoFetchAttempts}`,
        `deleted_photo_fetch_attempts=${summary.deletedPhotoFetchAttempts}`,
        `deleted_invalid_csv_rows=${summary.deletedInvalidCsvRows}`,
        `deleted_ingest_runs=${summary.deletedIngestRuns}`,
        `deleted_photo_runs=${summary.deletedPhotoRuns}`,
        `deleted_photo_cluster_runs=${summary.deletedPhotoClusterRuns}`,
        `duration_ms=${summary.durationMs}`,
      ].join("\n")
    );
  }

  return summary;
}

export async function runRetentionCleanup(
  options: RetentionCleanupOptions = {}
): Promise<RetentionCleanupExecutionResult> {
  const shouldRun = options.ignoreEnabledFlag || env.maintenance.enabled;
  if (!shouldRun) {
    logger.info("Retention cleanup skipped because disabled in configuration");
    return { executed: false };
  }

  const locked = await withAppLocks(
    [PIPELINE_REFRESH_LOCK, RETENTION_CLEANUP_LOCK, LOTS_MEDIA_GATE_LOCK],
    executeRetentionCleanup
  );
  if (locked === null) {
    logger.warn("Retention cleanup skipped because another run owns the lock");
    return { executed: false };
  }

  return {
    executed: true,
    summary: locked,
  };
}
