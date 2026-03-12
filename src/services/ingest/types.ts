export type CsvRecord = Record<string, string>;

export interface IngestCandidate {
  lotNumber: number;
  yardNumber: number | null;
  imageUrl: string | null;
  sourceLastUpdatedAt: Date | null;
  sourceCreatedAt: Date | null;
  rowHash: string;
  rawPayload: CsvRecord;
}

export interface IngestCounters {
  rowsTotal: number;
  rowsValid: number;
  rowsInvalid: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsUnchanged: number;
}

export interface UpsertBatchResult {
  inserted: number;
  updated: number;
  unchanged: number;
}
