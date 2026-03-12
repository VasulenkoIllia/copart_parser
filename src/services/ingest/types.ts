export type CsvRecord = Record<string, string>;

export interface IngestCandidate {
  lotNumber: number;
  yardNumber: number | null;
  imageUrl: string | null;
  rowHash: string;
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
