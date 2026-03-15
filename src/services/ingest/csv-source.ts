import fs from "fs";
import readline from "readline";
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

export interface ParsedCsvRow {
  record: CsvRecord;
  raw: string | null;
  line: number | null;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotedField = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === "\"") {
      if (inQuotedField) {
        const next = index + 1 < line.length ? line[index + 1] : null;
        if (next === "\"") {
          current += "\"";
          index += 1;
          continue;
        }

        if (next === "," || next === null) {
          inQuotedField = false;
          continue;
        }

        // Copart source sometimes sends raw quotes inside quoted text (`125" SLEEPER CAB`).
        current += "\"";
        continue;
      }

      if (current.trim() === "") {
        inQuotedField = true;
        continue;
      }

      current += "\"";
      continue;
    }

    if (char === "," && !inQuotedField) {
      fields.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields;
}

function tryRepairMalformedLine(line: string, expectedColumns: number): string | null {
  // Copart occasionally sends an extra quote right before delimiter:
  // ...,"SUMMIT 850 X 165"","","BLUE",...
  // We can safely collapse this pattern only when it is not an empty field.
  const repaired = line.replace(/(?<=[^,])""(?=,")/g, "\"");
  if (repaired === line) {
    return null;
  }

  const repairedValues = parseCsvLine(repaired);
  if (repairedValues.length !== expectedColumns) {
    return null;
  }

  return repaired;
}

function buildRecord(headers: string[], values: string[]): CsvRecord {
  const normalized: CsvRecord = {};
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    normalized[header] = values[index] ?? "";
  }
  return normalized;
}

export async function* iterateCsvRows(
  stream: Readable,
  onSkipRecord?: (meta: SkipRecordMeta) => void
): AsyncGenerator<ParsedCsvRow> {
  let skipped = 0;
  let lineNumber = 0;
  let headers: string[] | null = null;
  const reader = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });

  for await (const rawLine of reader) {
    lineNumber += 1;
    const line = lineNumber === 1 ? stripBom(rawLine) : rawLine;
    if (!line.trim()) {
      continue;
    }

    let values = parseCsvLine(line);
    if (!headers) {
      headers = values.map(value => value.trim());
      continue;
    }

    if (values.length !== headers.length) {
      const actualBeforeRepair = values.length;
      const repairedLine = tryRepairMalformedLine(line, headers.length);
      if (repairedLine) {
        values = parseCsvLine(repairedLine);
        logger.warn("CSV row repaired after parse mismatch", {
          line: lineNumber,
          expected: headers.length,
          actualBeforeRepair,
          actualAfterRepair: values.length,
        });
        yield {
          record: buildRecord(headers, values),
          raw: repairedLine,
          line: lineNumber,
        };
        continue;
      }

      skipped += 1;
      const message = `csv_column_count_mismatch expected=${headers.length} actual=${values.length}`;
      onSkipRecord?.({ message, line: lineNumber, raw: line });

      if (skipped <= env.csv.skipLogLimit) {
        logger.warn("CSV row skipped due to parse error", {
          skipped,
          line: lineNumber,
          message,
        });
      } else if (skipped === env.csv.skipLogLimit + 1) {
        logger.warn("CSV skip log limit reached", {
          skipped,
          skipLogLimit: env.csv.skipLogLimit,
        });
      }
      continue;
    }

    yield {
      record: buildRecord(headers, values),
      raw: line,
      line: lineNumber,
    };
  }
}
