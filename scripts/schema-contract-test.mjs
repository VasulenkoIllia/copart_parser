#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT_DIR, ".env") });

const LOG_PREFIX = "[schema-contract-test]";
const MYSQL_HOST = process.env.MYSQL_HOST || "127.0.0.1";
const MYSQL_PORT = Number.parseInt(process.env.MYSQL_PORT || "3306", 10);
const MYSQL_USER = process.env.MYSQL_USER || "copart";
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || "copart";
const MYSQL_CORE_DB = process.env.MYSQL_DATABASE_CORE || "copart_core";
const UNKNOWN_HEADER = "Future Surprise Header";
const UNKNOWN_VALUE = "SURPRISE_VALUE";

const COMMAND_ENV = {
  TELEGRAM_ENABLED: "false",
  TELEGRAM_SEND_SUCCESS_SUMMARY: "false",
  TELEGRAM_SEND_ERROR_ALERTS: "false",
  PHOTO_WORKER_TOTAL: "1",
  PHOTO_WORKER_INDEX: "0",
};

function log(message, meta = null) {
  if (meta && Object.keys(meta).length > 0) {
    process.stdout.write(`${LOG_PREFIX} ${message} ${JSON.stringify(meta)}\n`);
    return;
  }
  process.stdout.write(`${LOG_PREFIX} ${message}\n`);
}

function buildCsvUrl() {
  const sourceUrl = (process.env.CSV_SOURCE_URL || "https://allzap.site/copart/salesdata.csv").trim();
  const authKey = (process.env.CSV_AUTH_KEY || "").trim();
  const cacheBust = (process.env.CSV_CACHE_BUST || "true").trim().toLowerCase() !== "false";

  const url = new URL(sourceUrl);
  if (authKey) {
    url.searchParams.set("authKey", authKey);
  }
  if (cacheBust) {
    url.searchParams.set("_ts", String(Date.now()));
  }
  return url.toString();
}

function stripBom(value) {
  if (!value) {
    return value;
  }
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotedField = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotedField) {
        const next = index + 1 < line.length ? line[index + 1] : null;
        if (next === '"') {
          current += '"';
          index += 1;
          continue;
        }

        if (next === "," || next === null) {
          inQuotedField = false;
          continue;
        }

        current += '"';
        continue;
      }

      if (current.trim() === "") {
        inQuotedField = true;
        continue;
      }

      current += '"';
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

function buildRecord(headers, values) {
  const result = {};
  for (let i = 0; i < headers.length; i += 1) {
    result[headers[i]] = values[i] ?? "";
  }
  return result;
}

function parseLotNumber(record) {
  const candidates = ["Lot number", "lot_number", "lot number", "lotNumber"];
  for (const key of candidates) {
    const raw = record[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      continue;
    }
    const parsed = Number.parseInt(String(raw).trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function createNodeStreamFromWeb(body) {
  if (!body) {
    throw new Error("CSV response body is empty");
  }
  if (typeof Readable.fromWeb === "function") {
    return Readable.fromWeb(body);
  }
  throw new Error("Readable.fromWeb is not available in current Node.js runtime");
}

async function collectFirstRow() {
  const url = buildCsvUrl();
  log("Downloading real CSV source", { url });

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "User-Agent": "copart-parser-schema-contract-test",
    },
  });

  if (!response.ok) {
    throw new Error(`CSV download failed with HTTP ${response.status}`);
  }

  const input = createNodeStreamFromWeb(response.body);
  const reader = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  let headerLine = null;
  let headers = null;

  for await (const rawLine of reader) {
    lineNumber += 1;
    const line = lineNumber === 1 ? stripBom(rawLine) : rawLine;
    if (!line.trim()) {
      continue;
    }

    const values = parseCsvLine(line);
    if (!headers) {
      headers = values.map(item => String(item).trim());
      headerLine = line;
      continue;
    }

    if (values.length !== headers.length) {
      continue;
    }

    const record = buildRecord(headers, values);
    const lotNumber = parseLotNumber(record);
    if (!lotNumber) {
      continue;
    }

    input.destroy();
    return {
      sourceUrl: url,
      headerLine,
      headers,
      rawLine: line,
      lotNumber,
    };
  }

  input.destroy();
  throw new Error("Failed to collect a valid CSV row");
}

async function runCommand(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed: ${command} ${args.join(" ")} (exit=${code})`));
    });
  });
}

async function npmCommand(scriptName) {
  await runCommand("npm", ["run", scriptName]);
}

async function connectDb() {
  return mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    waitForConnections: true,
    connectionLimit: 4,
    connectTimeout: 10_000,
  });
}

async function fetchColumns(pool) {
  const [rows] = await pool.query(
    `
      SELECT COLUMN_NAME AS column_name
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = 'lots'
      ORDER BY COLUMN_NAME ASC
    `,
    [MYSQL_CORE_DB]
  );

  return rows.map(row => String(row.column_name));
}

async function fetchLotCsvPayload(pool, lotNumber) {
  const [rows] = await pool.query(
    `
      SELECT csv_payload
      FROM \`${MYSQL_CORE_DB}\`.\`lots\`
      WHERE lot_number = ?
      LIMIT 1
    `,
    [lotNumber]
  );

  const payload = rows[0]?.csv_payload;
  if (!payload) {
    throw new Error(`Lot ${lotNumber} not found after ingest`);
  }

  return typeof payload === "string" ? JSON.parse(payload) : payload;
}

async function main() {
  log("Starting");
  await npmCommand("build");
  await npmCommand("db:drop");
  await npmCommand("db:migrate");

  const source = await collectFirstRow();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "copart-schema-contract-"));
  const knownCsvPath = path.join(tempDir, "known.csv");
  const unknownCsvPath = path.join(tempDir, "unknown.csv");

  await fsp.writeFile(knownCsvPath, `${source.headerLine}\n${source.rawLine}\n`, "utf8");
  await fsp.writeFile(
    unknownCsvPath,
    `${source.headerLine},"${UNKNOWN_HEADER}"\n${source.rawLine},"${UNKNOWN_VALUE}"\n`,
    "utf8"
  );

  log("Running ingest with known headers", {
    knownCsvPath,
    lotNumber: source.lotNumber,
  });
  await runCommand(process.execPath, ["dist/index.js", "ingest:csv"], {
    ...COMMAND_ENV,
    CSV_LOCAL_FILE: knownCsvPath,
    INGEST_MAX_ROWS: "0",
  });

  log("Running ingest with unknown header", {
    unknownCsvPath,
    unknownHeader: UNKNOWN_HEADER,
  });
  await runCommand(process.execPath, ["dist/index.js", "ingest:csv"], {
    ...COMMAND_ENV,
    CSV_LOCAL_FILE: unknownCsvPath,
    INGEST_MAX_ROWS: "0",
  });

  const pool = await connectDb();
  try {
    const columns = await fetchColumns(pool);
    if (!columns.includes("make") || !columns.includes("imageurl") || !columns.includes("sale_date")) {
      throw new Error("Expected materialized lot columns are missing after fresh migrations");
    }

    if (columns.includes("csv_future_surprise_header") || columns.includes("future_surprise_header")) {
      throw new Error("Unknown CSV header was incorrectly materialized into lots schema");
    }

    const payload = await fetchLotCsvPayload(pool, source.lotNumber);
    if (payload[UNKNOWN_HEADER] !== UNKNOWN_VALUE) {
      throw new Error(
        `Unknown header was not preserved in csv_payload. expected=${UNKNOWN_VALUE}, actual=${String(payload[UNKNOWN_HEADER])}`
      );
    }

    log("PASS", {
      lotNumber: source.lotNumber,
      materializedColumnsChecked: ["make", "imageurl", "sale_date"],
      unknownHeader: UNKNOWN_HEADER,
      unknownValue: payload[UNKNOWN_HEADER],
      tempDir,
    });
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`${LOG_PREFIX} FATAL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
