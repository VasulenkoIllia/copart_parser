import env from "../../config/env";
import { buildCsvUrl, downloadCsvStream, iterateCsvRows } from "../ingest/csv-source";
import {
  completeIngestRunFailure,
  completeIngestRunSuccess,
  createIngestRun,
  fetchCoreLotSnapshot,
  upsertLotsBatch,
} from "../ingest/lot-repository";
import { mapCsvRow } from "../ingest/row-mapper";
import { IngestCandidate, IngestCounters } from "../ingest/types";
import { ActiveAppLock, fetchActiveAppLocks, withAppLocks } from "../locks/db-lock";
import {
  CSV_INGEST_LOCK,
  LOTS_MEDIA_GATE_LOCK,
  MANUAL_LOT_REFRESH_LOCK,
  PIPELINE_REFRESH_LOCK,
  getPhotoSyncLockNames,
} from "../locks/lock-names";
import { logger } from "../../lib/logger";
import { clearLotImages, clearLotPhotoAttempts, resetLotPhotoState } from "../photo/photo-repository";
import { runPhotoSyncForLot } from "../photo/photo-sync";
import { PhotoSyncRunSummary } from "../photo/types";

export type ManualLotRefreshStatus =
  | "success"
  | "blocked_by_global_refresh"
  | "blocked_by_manual_refresh"
  | "lot_not_found_in_core"
  | "lot_not_found_in_source"
  | "success_without_image_url";

export interface ManualLotRefreshResult {
  status: ManualLotRefreshStatus;
  lotNumber: number;
  durationMs: number;
  sourceUrl: string;
  ingestRunId: number | null;
  rowsInserted: number;
  rowsUpdated: number;
  rowsUnchanged: number;
  rowsUpdatedImageUrlChanged: number;
  rowsUpdatedOtherFields: number;
  clearedPhotoAttempts: number;
  clearedImages: number;
  photoSummary: PhotoSyncRunSummary | null;
  blockingLocks: string[];
}

function getPhotoLockNames(): string[] {
  return getPhotoSyncLockNames(env.photo.workerTotal);
}

function getSourceDescriptor(): string {
  if (env.csv.localFile) {
    return `file://${env.csv.localFile}`;
  }

  return buildCsvUrl();
}

function getGuardLockNames(): string[] {
  return [
    MANUAL_LOT_REFRESH_LOCK,
    PIPELINE_REFRESH_LOCK,
    CSV_INGEST_LOCK,
    LOTS_MEDIA_GATE_LOCK,
    ...getPhotoLockNames(),
  ];
}

function getGlobalRefreshLockNames(): string[] {
  return getGuardLockNames().filter(lockName => lockName !== MANUAL_LOT_REFRESH_LOCK);
}

function createIngestCountersFromSingleCandidate(
  upsert: Awaited<ReturnType<typeof upsertLotsBatch>>
): IngestCounters {
  return {
    rowsTotal: 1,
    rowsValid: 1,
    rowsInvalid: 0,
    rowsInserted: upsert.inserted,
    rowsUpdated: upsert.updated,
    rowsUpdatedImageUrlChanged: upsert.updatedImageUrlChanged,
    rowsUpdatedOtherFields: upsert.updatedOtherFields,
    rowsUnchanged: upsert.unchanged,
  };
}

async function findLotCandidateInSource(lotNumber: number): Promise<IngestCandidate | null> {
  const stream = await downloadCsvStream();

  try {
    for await (const row of iterateCsvRows(stream)) {
      const mapped = mapCsvRow(row.record);
      if (mapped && mapped.lotNumber === lotNumber) {
        return mapped;
      }
    }

    return null;
  } finally {
    stream.destroy();
  }
}

function buildBlockedResult(
  lotNumber: number,
  sourceUrl: string,
  blockingLocks: ActiveAppLock[]
): ManualLotRefreshResult {
  const blockingLockNames = blockingLocks.map(lock => lock.lockName);
  const manualBlocked = blockingLockNames.includes(MANUAL_LOT_REFRESH_LOCK);

  return {
    status: manualBlocked ? "blocked_by_manual_refresh" : "blocked_by_global_refresh",
    lotNumber,
    durationMs: 0,
    sourceUrl,
    ingestRunId: null,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsUnchanged: 0,
    rowsUpdatedImageUrlChanged: 0,
    rowsUpdatedOtherFields: 0,
    clearedPhotoAttempts: 0,
    clearedImages: 0,
    photoSummary: null,
    blockingLocks: blockingLockNames,
  };
}

export async function refreshLotFullyByNumber(lotNumber: number): Promise<ManualLotRefreshResult> {
  const startedAt = Date.now();
  const sourceUrl = getSourceDescriptor();
  const existingLot = await fetchCoreLotSnapshot(lotNumber);

  if (!existingLot) {
    return {
      status: "lot_not_found_in_core",
      lotNumber,
      durationMs: Date.now() - startedAt,
      sourceUrl,
      ingestRunId: null,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsUnchanged: 0,
      rowsUpdatedImageUrlChanged: 0,
      rowsUpdatedOtherFields: 0,
      clearedPhotoAttempts: 0,
      clearedImages: 0,
      photoSummary: null,
      blockingLocks: [],
    };
  }

  const sourceCandidate = await findLotCandidateInSource(lotNumber);
  if (!sourceCandidate) {
    return {
      status: "lot_not_found_in_source",
      lotNumber,
      durationMs: Date.now() - startedAt,
      sourceUrl,
      ingestRunId: null,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsUnchanged: 0,
      rowsUpdatedImageUrlChanged: 0,
      rowsUpdatedOtherFields: 0,
      clearedPhotoAttempts: 0,
      clearedImages: 0,
      photoSummary: null,
      blockingLocks: [],
    };
  }

  const preflightBlockingLocks = await fetchActiveAppLocks(getGuardLockNames());
  if (preflightBlockingLocks.length > 0) {
    return buildBlockedResult(lotNumber, sourceUrl, preflightBlockingLocks);
  }

  const lockedResult = await withAppLocks(getGuardLockNames(), async () => {
    const currentLot = await fetchCoreLotSnapshot(lotNumber);
    if (!currentLot) {
      return {
        status: "lot_not_found_in_core" as const,
        ingestRunId: null,
        rowsInserted: 0,
        rowsUpdated: 0,
        rowsUnchanged: 0,
        rowsUpdatedImageUrlChanged: 0,
        rowsUpdatedOtherFields: 0,
        clearedPhotoAttempts: 0,
        clearedImages: 0,
        photoSummary: null,
      };
    }

    let ingestRunId: number | null = null;
    let ingestRunCompleted = false;
    const seenAt = new Date();
    try {
      ingestRunId = await createIngestRun(sourceUrl, "lot_manual_refresh");
      const upsert = await upsertLotsBatch([sourceCandidate], ingestRunId, seenAt);
      await completeIngestRunSuccess(
        ingestRunId,
        createIngestCountersFromSingleCandidate(upsert),
        sourceUrl
      );
      ingestRunCompleted = true;

      await resetLotPhotoState(lotNumber);
      const clearedPhotoAttempts = await clearLotPhotoAttempts(lotNumber);

      if (!sourceCandidate.imageUrl) {
        const clearedImages = await clearLotImages(lotNumber);
        return {
          status: "success_without_image_url" as const,
          ingestRunId,
          rowsInserted: upsert.inserted,
          rowsUpdated: upsert.updated,
          rowsUnchanged: upsert.unchanged,
          rowsUpdatedImageUrlChanged: upsert.updatedImageUrlChanged,
          rowsUpdatedOtherFields: upsert.updatedOtherFields,
          clearedPhotoAttempts,
          clearedImages,
          photoSummary: null,
        };
      }

      const photoSummary = await runPhotoSyncForLot(lotNumber, {
        notifySuccess: false,
        notifyError: false,
        build404Report: false,
        prepareProxyPool: true,
        storageMode: "replace",
      });

      return {
        status: "success" as const,
        ingestRunId,
        rowsInserted: upsert.inserted,
        rowsUpdated: upsert.updated,
        rowsUnchanged: upsert.unchanged,
        rowsUpdatedImageUrlChanged: upsert.updatedImageUrlChanged,
        rowsUpdatedOtherFields: upsert.updatedOtherFields,
        clearedPhotoAttempts,
        clearedImages: 0,
        photoSummary,
      };
    } catch (error) {
      if (ingestRunId !== null && !ingestRunCompleted) {
        await completeIngestRunFailure(
          ingestRunId,
          {
            rowsTotal: 1,
            rowsValid: 0,
            rowsInvalid: 1,
            rowsInserted: 0,
            rowsUpdated: 0,
            rowsUpdatedImageUrlChanged: 0,
            rowsUpdatedOtherFields: 0,
            rowsUnchanged: 0,
          },
          error instanceof Error ? error.message : String(error)
        );
      }
      throw error;
    }
  });

  if (lockedResult === null) {
    const blockingLocks = await fetchActiveAppLocks(getGuardLockNames());
    return buildBlockedResult(lotNumber, sourceUrl, blockingLocks);
  }

  logger.info("Manual lot refresh finished", {
    lotNumber,
    status: lockedResult.status,
    durationMs: Date.now() - startedAt,
    sourceUrl,
  });

  return {
    status: lockedResult.status,
    lotNumber,
    durationMs: Date.now() - startedAt,
    sourceUrl,
    ingestRunId: lockedResult.ingestRunId,
    rowsInserted: lockedResult.rowsInserted,
    rowsUpdated: lockedResult.rowsUpdated,
    rowsUnchanged: lockedResult.rowsUnchanged,
    rowsUpdatedImageUrlChanged: lockedResult.rowsUpdatedImageUrlChanged,
    rowsUpdatedOtherFields: lockedResult.rowsUpdatedOtherFields,
    clearedPhotoAttempts: lockedResult.clearedPhotoAttempts,
    clearedImages: lockedResult.clearedImages,
    photoSummary: lockedResult.photoSummary,
    blockingLocks: [],
  };
}

export async function fetchManualLotRefreshBlockingLocks(): Promise<string[]> {
  const blockingLocks = await fetchActiveAppLocks(getGlobalRefreshLockNames());
  return blockingLocks.map(lock => lock.lockName);
}
