import { parse } from "csv-parse";
import fs from "fs";
import { Readable } from "stream";
import env from "../../config/env";
import { httpRequest } from "../../lib/http-client";
import { logger } from "../../lib/logger";
import { CsvRecord } from "./types";

export function buildCsvUrl(): string {
  const url = new URL(env.csv.sourceUrl);
  url.searchParams.set("authKey", env.csv.authKey);
  return url.toString();
}

function buildCsvRequestUrl(): string {
  const url = new URL(buildCsvUrl());
  if (env.csv.cacheBust) {
    url.searchParams.set("_ts", String(Date.now()));
  }
  return url.toString();
}

export async function downloadCsvStream(): Promise<Readable> {
  if (env.csv.localFile) {
    logger.info("Using local CSV file source", { localFile: env.csv.localFile });
    return fs.createReadStream(env.csv.localFile, {
      highWaterMark: env.csv.streamHighWaterMark,
    });
  }

  const sourceUrl = buildCsvRequestUrl();
  const response = await httpRequest<Readable>(
    {
      method: "GET",
      url: sourceUrl,
      responseType: "stream",
      timeout: env.csv.timeoutMs,
      maxRedirects: 5,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
        "Cache-Control": "no-cache, no-store, max-age=0",
        Pragma: "no-cache",
        Expires: "0",
      },
    },
    {
      retries: env.csv.retries,
      retryDelayMs: env.csv.retryDelayMs,
    }
  );

  if (response.status < 200 || response.status >= 300 || !response.data) {
    throw new Error(`CSV download failed with HTTP ${response.status}`);
  }

  logger.info("CSV download response", {
    cacheBust: env.csv.cacheBust,
    cacheControl: response.headers["cache-control"] ?? null,
    cfCacheStatus: response.headers["cf-cache-status"] ?? null,
    contentLength: response.headers["content-length"] ?? null,
    etag: response.headers.etag ?? null,
    lastModified: response.headers["last-modified"] ?? null,
    status: response.status,
  });

  return response.data;
}

interface SkipRecordMeta {
  message: string;
  line: number | null;
  raw: string | null;
}

interface ParsedCsvRowEnvelope {
  record?: Record<string, unknown>;
  raw?: string;
  info?: {
    lines?: number;
  };
}

export interface ParsedCsvRow {
  record: CsvRecord;
  raw: string | null;
  line: number | null;
}

function extractErrorLine(err: unknown): number | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const candidate = (err as { lines?: unknown }).lines;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

export async function* iterateCsvRows(
  stream: Readable,
  onSkipRecord?: (meta: SkipRecordMeta) => void
): AsyncGenerator<ParsedCsvRow> {
  let skipped = 0;
  const parser = parse({
    columns: true,
    bom: true,
    raw: true,
    info: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: env.csv.relaxQuotes,
    skip_records_with_error: env.csv.skipRecordsWithError,
    trim: true,
    on_skip: (err, raw) => {
      skipped += 1;
      const line = extractErrorLine(err);
      const message = err?.message ?? "unknown_csv_parse_error";
      onSkipRecord?.({ message, line, raw: raw ?? null });

      if (skipped <= env.csv.skipLogLimit) {
        logger.warn("CSV row skipped due to parse error", {
          skipped,
          line,
          message,
        });
      } else if (skipped === env.csv.skipLogLimit + 1) {
        logger.warn("CSV skip log limit reached", {
          skipped,
          skipLogLimit: env.csv.skipLogLimit,
        });
      }
    },
  });

  stream.pipe(parser);

  for await (const row of parser) {
    if (!row || typeof row !== "object") {
      continue;
    }

    const envelope = row as ParsedCsvRowEnvelope;
    const sourceRecord =
      envelope.record && typeof envelope.record === "object" ? envelope.record : (row as Record<string, unknown>);
    const normalized: CsvRecord = {};
    for (const [key, value] of Object.entries(sourceRecord)) {
      normalized[String(key)] = value === null || value === undefined ? "" : String(value);
    }

    yield {
      record: normalized,
      raw: typeof envelope.raw === "string" ? envelope.raw : null,
      line:
        envelope.info && typeof envelope.info.lines === "number" && Number.isFinite(envelope.info.lines)
          ? envelope.info.lines
          : null,
    };
  }
}
