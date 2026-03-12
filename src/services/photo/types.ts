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
  lotsOk: number;
  lotsMissing: number;
  imagesUpserted: number;
  imagesFullSize: number;
  imagesBadQuality: number;
  http404Count: number;
}

export interface PhotoClusterRunWorkerRow {
  photoRunId: number;
  workerIndex: number;
  workerTotal: number;
  status: "running" | "success" | "failed";
  lotsScanned: number;
  lotsProcessed: number;
  lotsOk: number;
  lotsMissing: number;
  imagesUpserted: number;
  imagesFullSize: number;
  imagesBadQuality: number;
  http404Count: number;
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
  totalLotsOk: number;
  totalLotsMissing: number;
  totalImagesUpserted: number;
  totalImagesFullSize: number;
  totalImagesBadQuality: number;
  totalHttp404Count: number;
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
