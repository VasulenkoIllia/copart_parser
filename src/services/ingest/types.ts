import { GeneratedReportFile } from "../reports/types";

export type CsvRecord = Record<string, string>;

export interface CsvFieldUpdateStat {
  field: string;
  lotsUpdated: number;
}

export interface IngestCandidate {
  lotNumber: number;
  yardNumber: number | null;
  imageUrl: string | null;
  rowHash: string;
  csvPayload: CsvRecord;
}

export interface IngestCounters {
  rowsTotal: number;
  rowsValid: number;
  rowsInvalid: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsUpdatedImageUrlChanged: number;
  rowsUpdatedOtherFields: number;
  rowsUnchanged: number;
}

export interface CsvIngestRunSummary {
  runId: number;
  sourceUrl: string;
  rowsTotal: number;
  rowsValid: number;
  rowsInvalid: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsUpdatedImageUrlChanged: number;
  rowsUpdatedOtherFields: number;
  rowsUnchanged: number;
  hydratedLotsFromMedia: number;
  prunedLots: number;
  durationMs: number;
  maxRows: number | null;
  maxRowsReached: boolean;
  updatedFields: CsvFieldUpdateStat[];
  invalidRowsReport: GeneratedReportFile | null;
  invalidRowsDebugReport: GeneratedReportFile | null;
}

export interface CsvIngestExecutionResult {
  executed: boolean;
  summary?: CsvIngestRunSummary;
}

export interface UpsertBatchResult {
  inserted: number;
  updated: number;
  updatedImageUrlChanged: number;
  updatedOtherFields: number;
  unchanged: number;
  updatedFields: CsvFieldUpdateStat[];
}
