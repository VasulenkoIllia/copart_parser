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
