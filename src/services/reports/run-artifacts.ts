import { logger } from "../../lib/logger";
import {
  fetchPhoto404AttemptsForClusterRun,
  fetchPhoto404AttemptsForRun,
} from "../photo/photo-repository";
import { writeCsvReport } from "./csv-report";
import { GeneratedReportFile } from "./types";

export interface InvalidCsvRowReportEntry {
  source: string;
  line: number | null;
  reason: string;
  raw: string;
  recordJson: string;
}

export async function createInvalidRowsReport(
  entries: InvalidCsvRowReportEntry[]
): Promise<GeneratedReportFile | null> {
  return writeCsvReport({
    prefix: "copart_invalid_rows",
    headers: ["source", "line", "reason", "raw", "record_json"],
    rows: entries.map(entry => ({
      source: entry.source,
      line: entry.line ?? "",
      reason: entry.reason,
      raw: entry.raw,
      record_json: entry.recordJson,
    })),
  });
}

export async function createPhoto404ReportForRun(
  runId: number
): Promise<GeneratedReportFile | null> {
  const attempts = await fetchPhoto404AttemptsForRun(runId);
  return writeCsvReport({
    prefix: `copart_http_404_run_${runId}`,
    headers: [
      "attempted_at",
      "lot_number",
      "attempt_type",
      "http_status",
      "url",
      "error_code",
      "error_message",
    ],
    rows: attempts.map(attempt => ({
      attempted_at: attempt.attemptedAt,
      lot_number: attempt.lotNumber,
      attempt_type: attempt.attemptType,
      http_status: attempt.httpStatus ?? "",
      url: attempt.url ?? "",
      error_code: attempt.errorCode ?? "",
      error_message: attempt.errorMessage ?? "",
    })),
  });
}

export async function createPhoto404ReportForClusterRun(
  clusterRunId: number
): Promise<GeneratedReportFile | null> {
  const attempts = await fetchPhoto404AttemptsForClusterRun(clusterRunId);
  return writeCsvReport({
    prefix: `copart_http_404_cluster_${clusterRunId}`,
    headers: [
      "attempted_at",
      "lot_number",
      "attempt_type",
      "http_status",
      "url",
      "error_code",
      "error_message",
    ],
    rows: attempts.map(attempt => ({
      attempted_at: attempt.attemptedAt,
      lot_number: attempt.lotNumber,
      attempt_type: attempt.attemptType,
      http_status: attempt.httpStatus ?? "",
      url: attempt.url ?? "",
      error_code: attempt.errorCode ?? "",
      error_message: attempt.errorMessage ?? "",
    })),
  });
}

export async function tryCreateInvalidRowsReport(
  entries: InvalidCsvRowReportEntry[]
): Promise<GeneratedReportFile | null> {
  try {
    return await createInvalidRowsReport(entries);
  } catch (error) {
    logger.warn("Failed to create invalid rows CSV report", {
      message: error instanceof Error ? error.message : String(error),
      rowCount: entries.length,
    });
    return null;
  }
}

export async function tryCreatePhoto404ReportForRun(
  runId: number
): Promise<GeneratedReportFile | null> {
  try {
    return await createPhoto404ReportForRun(runId);
  } catch (error) {
    logger.warn("Failed to create HTTP 404 CSV report for photo run", {
      message: error instanceof Error ? error.message : String(error),
      runId,
    });
    return null;
  }
}

export async function tryCreatePhoto404ReportForClusterRun(
  clusterRunId: number
): Promise<GeneratedReportFile | null> {
  try {
    return await createPhoto404ReportForClusterRun(clusterRunId);
  } catch (error) {
    logger.warn("Failed to create HTTP 404 CSV report for photo cluster run", {
      message: error instanceof Error ? error.message : String(error),
      clusterRunId,
    });
    return null;
  }
}
