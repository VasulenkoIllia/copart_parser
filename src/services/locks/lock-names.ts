export const CSV_INGEST_LOCK = "csv_ingest";
export const PIPELINE_REFRESH_LOCK = "pipeline_refresh";
export const RETENTION_CLEANUP_LOCK = "retention_cleanup";
export const LOTS_MEDIA_GATE_LOCK = "lots_media_gate";
export const MANUAL_LOT_REFRESH_LOCK = "lot_manual_refresh";

export function getPhotoSyncLockName(workerTotal: number, workerIndex: number): string {
  return workerTotal > 1 ? `photo_sync_worker_${workerIndex}` : "photo_sync";
}

export function getPhotoSyncLockNames(workerTotal: number): string[] {
  if (workerTotal > 1) {
    return Array.from({ length: workerTotal }, (_, index) => `photo_sync_worker_${index}`);
  }

  return ["photo_sync"];
}
