import { ResultSetHeader } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";
import { logger } from "../../lib/logger";
import { withAppLock } from "../locks/db-lock";

export interface RetentionCleanupSummary {
  deletedOrphanLotImages: number;
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

  if (env.maintenance.photoFetchAttemptsRetentionDays > 0) {
    deletedPhotoFetchAttempts = await deleteInBatches(
      `
        DELETE FROM \`${env.mysql.databaseMedia}\`.\`photo_fetch_attempts\`
        WHERE attempted_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)
        ORDER BY id
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
        ORDER BY id
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
          AND COALESCE(finished_at, started_at) < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)
        ORDER BY id
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
          AND COALESCE(finished_at, started_at) < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)
        ORDER BY id
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
          AND COALESCE(finished_at, started_at) < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL ? DAY)
        ORDER BY id
        LIMIT ?
      `,
      [env.maintenance.photoClusterRunsRetentionDays],
      batchSize,
      `${env.mysql.databaseCore}.photo_cluster_runs`
    );
  }

  const summary: RetentionCleanupSummary = {
    deletedOrphanLotImages,
    deletedPhotoFetchAttempts,
    deletedInvalidCsvRows,
    deletedIngestRuns,
    deletedPhotoRuns,
    deletedPhotoClusterRuns,
    durationMs: Date.now() - startedAt,
  };

  logger.info("Retention cleanup finished", {
    deletedOrphanLotImages: summary.deletedOrphanLotImages,
    deletedPhotoFetchAttempts: summary.deletedPhotoFetchAttempts,
    deletedInvalidCsvRows: summary.deletedInvalidCsvRows,
    deletedIngestRuns: summary.deletedIngestRuns,
    deletedPhotoRuns: summary.deletedPhotoRuns,
    deletedPhotoClusterRuns: summary.deletedPhotoClusterRuns,
    durationMs: summary.durationMs,
  });
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

  const locked = await withAppLock("retention_cleanup", executeRetentionCleanup);
  if (locked === null) {
    logger.warn("Retention cleanup skipped because another run owns the lock");
    return { executed: false };
  }

  return {
    executed: true,
    summary: locked,
  };
}
