import { GeneratedReportFile } from "../reports/types";

export type LotPhotoStatus = "unknown" | "ok" | "missing";

export interface PhotoLotCandidate {
  lotNumber: number;
  yardNumber: number | null;
  imageUrl: string;
  photoStatus: LotPhotoStatus;
  photo404Count: number;
}

export type ImageVariant = "thumb" | "full" | "hd" | "video" | "unknown";

export interface ParsedLotImageLink {
  lotNumber: number;
  sequence: number;
  variant: ImageVariant;
  url: string;
}

export type ImageCheckStatus = "pending" | "ok" | "not_found" | "bad_quality" | "error";

export interface CheckedLotImage extends ParsedLotImageLink {
  httpStatus: number | null;
  contentType: string | null;
  contentLength: number | null;
  width: number | null;
  height: number | null;
  isFullSize: boolean;
  checkStatus: ImageCheckStatus;
  lastCheckedAt: Date | null;
}

export interface PhotoRunCounters {
  lotsScanned: number;
  lotsProcessed: number;
  photoLinksProcessed: number;
  lotsOk: number;
  lotsMissing: number;
  imagesUpserted: number;
  imagesInserted: number;
  imagesUpdated: number;
  imagesFullSize: number;
  imagesStoredHd: number;
  imagesStoredFull: number;
  imagesBadQuality: number;
  http404Count: number;
  endpoint404Lots: number;
  mmemberFallbackAttempted: number;
  mmemberFallbackOk: number;
}

export interface PhotoSyncRunSummary {
  runId: number;
  mode: "sync";
  workerTotal: number;
  workerIndex: number;
  lotsScanned: number;
  lotsProcessed: number;
  photoLinksProcessed: number;
  lotsOk: number;
  lotsMissing: number;
  imagesUpserted: number;
  imagesInserted: number;
  imagesUpdated: number;
  imagesFullSize: number;
  imagesStoredHd: number;
  imagesStoredFull: number;
  imagesBadQuality: number;
  http404Count: number;
  endpoint404Lots: number;
  mmemberFallbackAttempted: number;
  mmemberFallbackOk: number;
  durationMs: number;
  http404Report: GeneratedReportFile | null;
}

export interface PhotoSyncExecutionResult {
  executed: boolean;
  summary?: PhotoSyncRunSummary;
}

export interface PhotoClusterRunWorkerRow {
  photoRunId: number;
  workerIndex: number;
  workerTotal: number;
  status: "running" | "success" | "failed";
  lotsScanned: number;
  lotsProcessed: number;
  photoLinksProcessed: number;
  lotsOk: number;
  lotsMissing: number;
  imagesUpserted: number;
  imagesInserted: number;
  imagesUpdated: number;
  imagesFullSize: number;
  imagesStoredHd: number;
  imagesStoredFull: number;
  imagesBadQuality: number;
  http404Count: number;
  endpoint404Lots: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage: string | null;
}

export interface PhotoClusterRunSummary {
  workersFinished: number;
  workersSucceeded: number;
  workersFailed: number;
  totalLotsScanned: number;
  totalLotsProcessed: number;
  totalPhotoLinksProcessed: number;
  totalLotsOk: number;
  totalLotsMissing: number;
  totalImagesUpserted: number;
  totalImagesInserted: number;
  totalImagesUpdated: number;
  totalImagesFullSize: number;
  totalImagesStoredHd: number;
  totalImagesStoredFull: number;
  totalImagesBadQuality: number;
  totalHttp404Count: number;
  totalEndpoint404Lots: number;
  totalMmemberFallbackAttempted: number;
  totalMmemberFallbackOk: number;
}

export interface PhotoClusterRunResult extends PhotoClusterRunSummary {
  clusterRunId: number;
  mode: "cluster";
  workerTotal: number;
  durationMs: number;
  http404Report: GeneratedReportFile | null;
}

export interface LotImagesEndpointPayload {
  imgCount?: number;
  lotImages?: Array<{
    sequence?: number;
    link?: Array<{
      url?: string;
      isThumbNail?: boolean;
      isHdImage?: boolean;
      isEngineSound?: boolean;
    }>;
  }>;
}
