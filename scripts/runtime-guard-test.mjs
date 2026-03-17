#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT_DIR, ".env") });

const LOG_PREFIX = "[runtime-guard-test]";
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
      "User-Agent": "copart-parser-runtime-guard-test",
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  log("Starting");
  await npmCommand("build");
  await npmCommand("db:drop");
  await npmCommand("db:migrate");

  const source = await collectFirstRow();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "copart-runtime-guard-"));
  const csvPath = path.join(tempDir, "manual-refresh-source.csv");
  await fsp.writeFile(csvPath, `${source.headerLine}\n${source.rawLine}\n`, "utf8");

  log("Seeding core lot from local CSV", {
    csvPath,
    lotNumber: source.lotNumber,
  });
  await runCommand(process.execPath, ["dist/index.js", "ingest:csv"], {
    ...COMMAND_ENV,
    CSV_LOCAL_FILE: csvPath,
    INGEST_MAX_ROWS: "0",
  });

  process.env.CSV_LOCAL_FILE = csvPath;
  process.env.TELEGRAM_ENABLED = "false";
  process.env.TELEGRAM_SEND_SUCCESS_SUMMARY = "false";
  process.env.TELEGRAM_SEND_ERROR_ALERTS = "false";
  process.env.PHOTO_WORKER_TOTAL = "1";
  process.env.PHOTO_WORKER_INDEX = "0";

  const require = createRequire(import.meta.url);
  const { acquireAppLock, releaseAppLock } = require(path.join(ROOT_DIR, "dist/services/locks/db-lock.js"));
  const { closePool } = require(path.join(ROOT_DIR, "dist/db/mysql.js"));
  const {
    PIPELINE_REFRESH_LOCK,
    MANUAL_LOT_REFRESH_LOCK,
  } = require(path.join(ROOT_DIR, "dist/services/locks/lock-names.js"));
  const { runCsvIngest } = require(path.join(ROOT_DIR, "dist/services/ingest/csv-ingest.js"));
  const { runPhotoSync } = require(path.join(ROOT_DIR, "dist/services/photo/photo-sync.js"));
  const { runRetentionCleanup } = require(path.join(ROOT_DIR, "dist/services/maintenance/retention.js"));
  const { refreshLotFullyByNumber } = require(path.join(ROOT_DIR, "dist/services/manual/lot-refresh.js"));
  const {
    buildRefreshReply,
    normalizeCommand,
    parseLotNumberArg,
  } = require(path.join(ROOT_DIR, "dist/services/telegram/bot.js"));

  let pipelineHandle = null;
  let manualHandle = null;

  try {
    assert(normalizeCommand("/refresh_lot@TestBot") === "refresh_lot", "Group command mention was not normalized");
    assert(parseLotNumberArg(" lot #123-45 ") === 12345, "Lot number parser did not strip formatting");

    pipelineHandle = await acquireAppLock(PIPELINE_REFRESH_LOCK);
    assert(Boolean(pipelineHandle), "Failed to acquire pipeline lock for runtime guard test");

    const blockedRefresh = await refreshLotFullyByNumber(source.lotNumber);
    assert(
      blockedRefresh.status === "blocked_by_global_refresh",
      `Expected blocked_by_global_refresh, got=${blockedRefresh.status}`
    );
    assert(
      blockedRefresh.blockingLocks.includes(PIPELINE_REFRESH_LOCK),
      "Blocked refresh did not report pipeline_refresh lock"
    );

    const blockedReply = buildRefreshReply(blockedRefresh);
    assert(
      blockedReply.includes("Йде глобальне оновлення."),
      "Blocked refresh reply did not explain global refresh in progress"
    );

    const skippedIngest = await runCsvIngest({
      notifySuccess: false,
      notifyError: false,
      buildInvalidRowsReport: false,
    });
    assert(skippedIngest.executed === false, "CSV ingest should skip while pipeline lock is held");

    const skippedPhoto = await runPhotoSync({
      notifySuccess: false,
      notifyError: false,
      build404Report: false,
    });
    assert(skippedPhoto.executed === false, "Photo sync should skip while pipeline lock is held");

    const skippedRetention = await runRetentionCleanup({
      ignoreEnabledFlag: true,
    });
    assert(skippedRetention.executed === false, "Retention should skip while pipeline lock is held");

    await releaseAppLock(pipelineHandle);
    pipelineHandle = null;

    manualHandle = await acquireAppLock(MANUAL_LOT_REFRESH_LOCK);
    assert(Boolean(manualHandle), "Failed to acquire manual refresh lock");
    const manualBlockedRefresh = await refreshLotFullyByNumber(source.lotNumber);
    assert(
      manualBlockedRefresh.status === "blocked_by_manual_refresh",
      `Expected blocked_by_manual_refresh, got=${manualBlockedRefresh.status}`
    );
    assert(
      manualBlockedRefresh.blockingLocks.includes(MANUAL_LOT_REFRESH_LOCK),
      "Manual blocked refresh did not report lot_manual_refresh lock"
    );

    await releaseAppLock(manualHandle);
    manualHandle = null;

    const missingLot = await refreshLotFullyByNumber(999999999999);
    assert(missingLot.status === "lot_not_found_in_core", "Missing core lot should return lot_not_found_in_core");

    log("PASS", {
      lotNumber: source.lotNumber,
      blockedByGlobal: blockedRefresh.status,
      blockedByManual: manualBlockedRefresh.status,
      normalizedGroupCommand: normalizeCommand("/refresh_lot@TestBot"),
      tempDir,
    });
  } finally {
    if (manualHandle) {
      await releaseAppLock(manualHandle);
    }
    if (pipelineHandle) {
      await releaseAppLock(pipelineHandle);
    }
    await closePool();
  }

  process.exit(0);
}

main().catch(error => {
  process.stderr.write(`${LOG_PREFIX} FATAL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
