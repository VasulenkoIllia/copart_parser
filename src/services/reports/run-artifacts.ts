import { logger } from "../../lib/logger";
import {
  fetchLotsWithoutAnyPhotos,
  fetchPhotoEndpointIssuesForClusterRun,
  fetchPhotoEndpointIssuesForRun,
  fetchPhoto404AttemptsForClusterRun,
  fetchPhoto404AttemptsForRun,
  PhotoEndpointIssueReportRow,
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

export interface AggregatedInvalidCsvRowReportEntry {
  source: string;
  line: number | null;
  reason: string;
  occurrences: number;
  sampleRaw: string;
  sampleRecordJson: string;
}

function truncatePreview(value: string, limit: number): string {
  const normalized = value.replace(/\r?\n/g, "\\n").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function pickMoreInformativePreview(current: string, candidate: string): string {
  if (!candidate.trim()) {
    return current;
  }
  if (!current.trim()) {
    return candidate;
  }
  return candidate.length > current.length ? candidate : current;
}

export function aggregateInvalidRows(
  entries: InvalidCsvRowReportEntry[]
): AggregatedInvalidCsvRowReportEntry[] {
  const aggregated = new Map<string, AggregatedInvalidCsvRowReportEntry>();

  for (const entry of entries) {
    const key = `${entry.source}|${entry.line ?? ""}|${entry.reason}`;
    const existing = aggregated.get(key);
    if (!existing) {
      aggregated.set(key, {
        source: entry.source,
        line: entry.line,
        reason: entry.reason,
        occurrences: 1,
        sampleRaw: entry.raw,
        sampleRecordJson: entry.recordJson,
      });
      continue;
    }

    existing.occurrences += 1;
    existing.sampleRaw = pickMoreInformativePreview(existing.sampleRaw, entry.raw);
    existing.sampleRecordJson = pickMoreInformativePreview(existing.sampleRecordJson, entry.recordJson);
  }

  return Array.from(aggregated.values()).sort((left, right) => {
    if (right.occurrences !== left.occurrences) {
      return right.occurrences - left.occurrences;
    }
    if ((left.line ?? 0) !== (right.line ?? 0)) {
      return (left.line ?? 0) - (right.line ?? 0);
    }
    return left.reason.localeCompare(right.reason);
  });
}

export async function createInvalidRowsReport(
  entries: InvalidCsvRowReportEntry[]
): Promise<GeneratedReportFile | null> {
  const aggregatedEntries = aggregateInvalidRows(entries);
  return writeCsvReport({
    prefix: "copart_invalid_rows",
    headers: ["source", "line", "reason", "occurrences", "sample_raw", "sample_record_json"],
    rows: aggregatedEntries.map(entry => ({
      source: entry.source,
      line: entry.line ?? "",
      reason: entry.reason,
      occurrences: entry.occurrences,
      sample_raw: truncatePreview(entry.sampleRaw, 800),
      sample_record_json: truncatePreview(entry.sampleRecordJson, 800),
    })),
  });
}

export async function createInvalidRowsDebugReport(
  entries: InvalidCsvRowReportEntry[]
): Promise<GeneratedReportFile | null> {
  const aggregatedEntries = aggregateInvalidRows(entries);
  return writeCsvReport({
    prefix: "copart_invalid_rows_debug",
    headers: ["source", "line", "reason", "occurrences", "full_raw", "full_record_json"],
    rows: aggregatedEntries.map(entry => ({
      source: entry.source,
      line: entry.line ?? "",
      reason: entry.reason,
      occurrences: entry.occurrences,
      full_raw: entry.sampleRaw,
      full_record_json: entry.sampleRecordJson,
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

function classifyEndpointIssue(attempt: PhotoEndpointIssueReportRow): string {
  if (attempt.httpStatus === 429) {
    return "rate_limited";
  }
  if (attempt.httpStatus === 403) {
    return "forbidden";
  }
  if (attempt.httpStatus === 404) {
    return "not_found";
  }
  if (attempt.errorCode || attempt.errorMessage) {
    return "request_error";
  }
  if (attempt.httpStatus === null) {
    return "no_http_status";
  }
  if (attempt.httpStatus >= 500) {
    return "server_error";
  }
  if (attempt.httpStatus >= 400) {
    return "client_error";
  }
  return "non_2xx";
}

export async function createPhotoEndpointIssuesReport(
  attempts: PhotoEndpointIssueReportRow[],
  prefix: string
): Promise<GeneratedReportFile | null> {
  return writeCsvReport({
    prefix,
    headers: [
      "attempted_at",
      "lot_number",
      "endpoint_source",
      "issue_category",
      "http_status",
      "url",
      "error_code",
      "error_message",
    ],
    rows: attempts.map(attempt => ({
      attempted_at: attempt.attemptedAt,
      lot_number: attempt.lotNumber,
      endpoint_source: attempt.endpointSource,
      issue_category: classifyEndpointIssue(attempt),
      http_status: attempt.httpStatus ?? "",
      url: attempt.url ?? "",
      error_code: attempt.errorCode ?? "",
      error_message: attempt.errorMessage ?? "",
    })),
  });
}

export async function createPhotoEndpointIssuesReportForRun(
  runId: number
): Promise<GeneratedReportFile | null> {
  const attempts = await fetchPhotoEndpointIssuesForRun(runId);
  return createPhotoEndpointIssuesReport(attempts, `copart_endpoint_issues_run_${runId}`);
}

export async function createPhotoEndpointIssuesReportForClusterRun(
  clusterRunId: number
): Promise<GeneratedReportFile | null> {
  const attempts = await fetchPhotoEndpointIssuesForClusterRun(clusterRunId);
  return createPhotoEndpointIssuesReport(attempts, `copart_endpoint_issues_cluster_${clusterRunId}`);
}

export async function createLotsWithoutAnyPhotosReport(): Promise<GeneratedReportFile | null> {
  const lots = await fetchLotsWithoutAnyPhotos();
  return writeCsvReport({
    prefix: "copart_lots_without_any_photos",
    headers: ["lot_number", "image_url"],
    rows: lots.map(lot => ({
      lot_number: lot.lotNumber,
      image_url: lot.imageUrl,
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

export async function tryCreateInvalidRowsDebugReport(
  entries: InvalidCsvRowReportEntry[]
): Promise<GeneratedReportFile | null> {
  try {
    return await createInvalidRowsDebugReport(entries);
  } catch (error) {
    logger.warn("Failed to create invalid rows debug CSV report", {
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

export async function tryCreatePhotoEndpointIssuesReport(
  attempts: PhotoEndpointIssueReportRow[],
  prefix: string
): Promise<GeneratedReportFile | null> {
  try {
    return await createPhotoEndpointIssuesReport(attempts, prefix);
  } catch (error) {
    logger.warn("Failed to create endpoint issues CSV report", {
      message: error instanceof Error ? error.message : String(error),
      rowCount: attempts.length,
      prefix,
    });
    return null;
  }
}

export async function tryCreatePhotoEndpointIssuesReportForRun(
  runId: number
): Promise<GeneratedReportFile | null> {
  try {
    return await createPhotoEndpointIssuesReportForRun(runId);
  } catch (error) {
    logger.warn("Failed to create endpoint issues CSV report for photo run", {
      message: error instanceof Error ? error.message : String(error),
      runId,
    });
    return null;
  }
}

export async function tryCreatePhotoEndpointIssuesReportForClusterRun(
  clusterRunId: number
): Promise<GeneratedReportFile | null> {
  try {
    return await createPhotoEndpointIssuesReportForClusterRun(clusterRunId);
  } catch (error) {
    logger.warn("Failed to create endpoint issues CSV report for photo cluster run", {
      message: error instanceof Error ? error.message : String(error),
      clusterRunId,
    });
    return null;
  }
}

export async function tryCreateLotsWithoutAnyPhotosReport(): Promise<GeneratedReportFile | null> {
  try {
    return await createLotsWithoutAnyPhotosReport();
  } catch (error) {
    logger.warn("Failed to create lots-without-any-photos CSV report", {
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
