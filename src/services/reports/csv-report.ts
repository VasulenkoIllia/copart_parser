import fs from "fs/promises";
import os from "os";
import path from "path";
import { GeneratedReportFile } from "./types";

interface WriteCsvReportOptions {
  prefix: string;
  headers: string[];
  rows: Array<Record<string, unknown>>;
}

function formatTimestamp(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hour = String(value.getHours()).padStart(2, "0");
  const minute = String(value.getMinutes()).padStart(2, "0");
  const second = String(value.getSeconds()).padStart(2, "0");
  const millisecond = String(value.getMilliseconds()).padStart(3, "0");
  return `${year}${month}${day}_${hour}${minute}${second}_${millisecond}`;
}

function escapeCsvCell(value: unknown): string {
  const normalized =
    value === null || value === undefined
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : String(value);

  if (
    normalized.includes(",") ||
    normalized.includes("\"") ||
    normalized.includes("\n") ||
    normalized.includes("\r")
  ) {
    return `"${normalized.replace(/"/g, "\"\"")}"`;
  }

  return normalized;
}

export async function writeCsvReport(
  options: WriteCsvReportOptions
): Promise<GeneratedReportFile | null> {
  if (options.rows.length === 0) {
    return null;
  }

  const reportsDir = path.join(os.tmpdir(), "copart-parser", "reports");
  await fs.mkdir(reportsDir, { recursive: true });

  const filename = `${options.prefix}_${formatTimestamp(new Date())}.csv`;
  const filePath = path.join(reportsDir, filename);
  const lines = [
    options.headers.map(header => escapeCsvCell(header)).join(","),
    ...options.rows.map(row =>
      options.headers.map(header => escapeCsvCell(row[header])).join(",")
    ),
  ];

  await fs.writeFile(filePath, `\uFEFF${lines.join("\n")}\n`, "utf8");

  return {
    path: filePath,
    filename,
    rowCount: options.rows.length,
  };
}

export async function cleanupReportFiles(
  files: Array<GeneratedReportFile | null | undefined>
): Promise<void> {
  const uniquePaths = new Set(
    files
      .map(file => file?.path)
      .filter((filePath): filePath is string => Boolean(filePath))
  );

  for (const filePath of uniquePaths) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "ENOENT") {
        throw error;
      }
    }
  }
}
