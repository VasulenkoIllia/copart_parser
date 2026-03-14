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

const REQUIRED_TOTALS = parseTotals(process.env.PHOTO_TEST_CASE_TOTALS ?? "10,15");
const OLD_POOL_TARGET = toInt(process.env.PHOTO_TEST_OLD_POOL_SIZE, 100);
const SOURCE_ROW_RESERVE = toInt(process.env.PHOTO_TEST_SOURCE_ROW_RESERVE, 50);
const HTTP_MODE_FOR_PHOTO = (process.env.PHOTO_TEST_HTTP_MODE || process.env.HTTP_MODE || "direct").trim();
const DB_PREPARE_MODE = (process.env.PHOTO_TEST_DB_PREPARE ?? "drop").trim().toLowerCase();
const LOG_PREFIX = "[photo-test-suite]";

const MYSQL_HOST = process.env.MYSQL_HOST || "127.0.0.1";
const MYSQL_PORT = toInt(process.env.MYSQL_PORT, 3306);
const MYSQL_USER = process.env.MYSQL_USER || "copart";
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || "copart";
const MYSQL_CORE_DB = process.env.MYSQL_DATABASE_CORE || "copart_core";
const MYSQL_MEDIA_DB = process.env.MYSQL_DATABASE_MEDIA || "copart_media";

const BASE_ENV_OVERRIDES = {
  TELEGRAM_ENABLED: "false",
  TELEGRAM_SEND_SUCCESS_SUMMARY: "false",
  TELEGRAM_SEND_ERROR_ALERTS: "false",
  PHOTO_WORKER_TOTAL: "1",
  PHOTO_WORKER_INDEX: "0",
  PHOTO_LOG_LOT_RESULTS: "true",
  HTTP_MODE: HTTP_MODE_FOR_PHOTO,
};

function toInt(value, fallback) {
  if (!value || !String(value).trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value: ${value}`);
  }
  return parsed;
}

function parseTotals(raw) {
  const values = String(raw)
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .map(item => Number.parseInt(item, 10));

  if (values.length === 0) {
    throw new Error("PHOTO_TEST_CASE_TOTALS is empty; expected values like 10,15");
  }

  for (const value of values) {
    if (!Number.isFinite(value) || value < 1) {
      throw new Error(`Invalid PHOTO_TEST_CASE_TOTALS value: ${value}`);
    }
  }

  return Array.from(new Set(values));
}

function requiredNewRowsForTotals(totals) {
  let sum = 0;
  for (const total of totals) {
    sum += (total * (total + 1)) / 2;
  }
  return sum;
}

function formatNow() {
  return new Date().toISOString();
}

function log(message, meta = null) {
  if (meta && Object.keys(meta).length > 0) {
    process.stdout.write(`${LOG_PREFIX} ${message} ${JSON.stringify(meta)}\n`);
    return;
  }
  process.stdout.write(`${LOG_PREFIX} ${message}\n`);
}

function logSection(title) {
  process.stdout.write(`\n${LOG_PREFIX} ===== ${title} =====\n`);
}

function quoteId(identifier) {
  if (!/^[a-zA-Z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
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

function pickFirst(record, keys) {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
}

function parseLotNumber(record) {
  const lotRaw = pickFirst(record, ["Lot number", "lot_number", "lot number", "lotNumber"]);
  if (!lotRaw) {
    return null;
  }
  const parsed = Number.parseInt(lotRaw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
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

async function openSourceStream() {
  const sourceFile = (process.env.PHOTO_TEST_SOURCE_FILE || "").trim();
  if (sourceFile) {
    const resolved = path.isAbsolute(sourceFile)
      ? sourceFile
      : path.resolve(ROOT_DIR, sourceFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`PHOTO_TEST_SOURCE_FILE does not exist: ${resolved}`);
    }
    log("Using local source CSV file", { sourceFile: resolved });
    return {
      input: fs.createReadStream(resolved),
      sourceLabel: resolved,
    };
  }

  const url = buildCsvUrl();
  log("Downloading real CSV source", { url });
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
      "User-Agent": "copart-parser-photo-test-suite",
    },
  });

  if (!response.ok) {
    throw new Error(`CSV download failed with HTTP ${response.status}`);
  }

  return {
    input: createNodeStreamFromWeb(response.body),
    sourceLabel: url,
  };
}

async function collectUniqueRows(requiredRows) {
  const { input, sourceLabel } = await openSourceStream();

  const reader = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });

  let lineNumber = 0;
  let headerLine = null;
  let headers = null;

  const uniqueRows = [];
  const seenLots = new Set();

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
    if (!lotNumber || seenLots.has(lotNumber)) {
      continue;
    }

    seenLots.add(lotNumber);
    uniqueRows.push({
      lotNumber,
      rawLine: line,
      record,
    });

    if (uniqueRows.length >= requiredRows) {
      break;
    }
  }

  if (input && typeof input.destroy === "function") {
    input.destroy();
  }

  if (!headerLine || !headers) {
    throw new Error("Failed to parse CSV header from source");
  }

  return {
    sourceLabel,
    headerLine,
    headers,
    rows: uniqueRows,
  };
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

    child.once("error", error => reject(error));
    child.once("close", code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Command failed: ${command} ${args.join(" ")} (exit=${code})`));
    });
  });
}

function npmCommand(scriptName) {
  return runCommand("npm", ["run", scriptName]);
}

async function prepareDatabase() {
  logSection("Database Prepare");
  log("Database prepare mode", { mode: DB_PREPARE_MODE });

  if (DB_PREPARE_MODE === "drop") {
    await npmCommand("db:drop");
    await npmCommand("db:migrate");
    return;
  }

  if (DB_PREPARE_MODE === "reset") {
    await npmCommand("db:reset");
    await npmCommand("db:migrate");
    return;
  }

  if (DB_PREPARE_MODE === "none") {
    await npmCommand("db:migrate");
    return;
  }

  throw new Error(`Unsupported PHOTO_TEST_DB_PREPARE mode: ${DB_PREPARE_MODE}`);
}

async function connectDb() {
  return mysql.createPool({
    host: MYSQL_HOST,
    port: MYSQL_PORT,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    waitForConnections: true,
    connectionLimit: 10,
    connectTimeout: 10000,
    multipleStatements: false,
  });
}

function placeholders(length) {
  return Array.from({ length }, () => "?").join(", ");
}

async function fetchSingleNumber(pool, sql, params = []) {
  const [rows] = await pool.query(sql, params);
  const row = rows?.[0] ?? {};
  const firstValue = Object.values(row)[0];
  return Number(firstValue || 0);
}

async function fetchLastRunId(pool, dbName, table) {
  const sql = `SELECT id FROM ${quoteId(dbName)}.${quoteId(table)} ORDER BY id DESC LIMIT 1`;
  return fetchSingleNumber(pool, sql);
}

async function fetchIngestRunById(pool, runId) {
  const [rows] = await pool.query(
    `
      SELECT
        id,
        status,
        rows_total,
        rows_valid,
        rows_invalid,
        rows_inserted,
        rows_updated,
        rows_unchanged,
        started_at,
        finished_at
      FROM ${quoteId(MYSQL_CORE_DB)}.${quoteId("ingest_runs")}
      WHERE id = ?
      LIMIT 1
    `,
    [runId]
  );
  return rows[0] ?? null;
}

async function fetchPhotoRunById(pool, runId) {
  const [rows] = await pool.query(
    `
      SELECT
        id,
        status,
        lots_scanned,
        lots_processed,
        lots_ok,
        lots_missing,
        images_upserted,
        http_404_count,
        started_at,
        finished_at,
        error_message,
        meta_json
      FROM ${quoteId(MYSQL_CORE_DB)}.${quoteId("photo_runs")}
      WHERE id = ?
      LIMIT 1
    `,
    [runId]
  );
  return rows[0] ?? null;
}

async function fetchOldLotsWithMedia(pool, lotNumbers) {
  if (lotNumbers.length === 0) {
    return [];
  }

  const [rows] = await pool.query(
    `
      SELECT DISTINCT lot_number
      FROM ${quoteId(MYSQL_MEDIA_DB)}.${quoteId("lot_images")}
      WHERE
        lot_number IN (${placeholders(lotNumbers.length)})
        AND check_status = 'ok'
        AND is_full_size = 1
        AND variant = 'hd'
      ORDER BY lot_number ASC
    `,
    lotNumbers
  );

  return rows.map(row => Number(row.lot_number));
}

async function countDueCandidatesForLots(pool, lotNumbers) {
  if (lotNumbers.length === 0) {
    return 0;
  }

  const [rows] = await pool.query(
    `
      SELECT COUNT(*) AS cnt
      FROM ${quoteId(MYSQL_CORE_DB)}.${quoteId("lots")} l
      WHERE
        l.lot_number IN (${placeholders(lotNumbers.length)})
        AND l.image_url IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM ${quoteId(MYSQL_MEDIA_DB)}.${quoteId("lot_images")} li
          WHERE li.lot_number = l.lot_number
            AND li.check_status = 'ok'
            AND li.is_full_size = 1
            AND li.variant = 'hd'
        )
        AND (
          l.photo_status = 'unknown'
          OR (
            l.photo_status = 'missing'
            AND (
              l.next_photo_retry_at IS NULL
              OR l.next_photo_retry_at <= CURRENT_TIMESTAMP(3)
            )
          )
        )
    `,
    lotNumbers
  );

  return Number(rows[0]?.cnt || 0);
}

async function countLotsTouchedSince(pool, lotNumbers, startedAt) {
  if (lotNumbers.length === 0) {
    return 0;
  }

  const [rows] = await pool.query(
    `
      SELECT COUNT(*) AS cnt
      FROM ${quoteId(MYSQL_CORE_DB)}.${quoteId("lots")}
      WHERE
        lot_number IN (${placeholders(lotNumbers.length)})
        AND last_photo_check_at IS NOT NULL
        AND last_photo_check_at >= ?
    `,
    [...lotNumbers, startedAt]
  );

  return Number(rows[0]?.cnt || 0);
}

async function countGoodMediaLots(pool, lotNumbers) {
  if (lotNumbers.length === 0) {
    return 0;
  }

  const [rows] = await pool.query(
    `
      SELECT COUNT(DISTINCT lot_number) AS cnt
      FROM ${quoteId(MYSQL_MEDIA_DB)}.${quoteId("lot_images")}
      WHERE
        lot_number IN (${placeholders(lotNumbers.length)})
        AND check_status = 'ok'
        AND is_full_size = 1
        AND variant = 'hd'
    `,
    lotNumbers
  );

  return Number(rows[0]?.cnt || 0);
}

async function countAttemptsForWindow(pool, lotNumbers, startedAt, finishedAt) {
  if (lotNumbers.length === 0 || !startedAt || !finishedAt) {
    return 0;
  }

  const [rows] = await pool.query(
    `
      SELECT COUNT(*) AS cnt
      FROM ${quoteId(MYSQL_MEDIA_DB)}.${quoteId("photo_fetch_attempts")}
      WHERE
        attempted_at >= ?
        AND attempted_at <= ?
        AND lot_number IN (${placeholders(lotNumbers.length)})
    `,
    [startedAt, finishedAt, ...lotNumbers]
  );

  return Number(rows[0]?.cnt || 0);
}

function ensureDirectory(dirPath) {
  return fsp.mkdir(dirPath, { recursive: true });
}

async function writeCsv(filePath, headerLine, rows) {
  const lines = [headerLine, ...rows.map(item => item.rawLine)].join("\n");
  await fsp.writeFile(filePath, `${lines}\n`, "utf8");
}

function buildCaseMatrix(totals) {
  const cases = [];
  for (const total of totals) {
    for (let oldCount = 0; oldCount <= total; oldCount += 1) {
      const newCount = total - oldCount;
      cases.push({
        id: `${String(cases.length + 1).padStart(2, "0")}_t${total}_old${oldCount}_new${newCount}`,
        total,
        oldCount,
        newCount,
      });
    }
  }
  return cases;
}

function compactDurationMs(startedAt) {
  const diff = Date.now() - startedAt;
  const sec = Math.max(0, Math.round(diff / 1000));
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${min}m ${rem}s`;
}

async function main() {
  logSection("Config");
  log("Suite started", {
    at: formatNow(),
    totals: REQUIRED_TOTALS,
    oldPoolTarget: OLD_POOL_TARGET,
    dbPrepare: DB_PREPARE_MODE,
    httpMode: HTTP_MODE_FOR_PHOTO,
    mysqlHost: MYSQL_HOST,
    mysqlPort: MYSQL_PORT,
    mysqlCoreDb: MYSQL_CORE_DB,
    mysqlMediaDb: MYSQL_MEDIA_DB,
  });

  logSection("Build");
  await npmCommand("build");

  await prepareDatabase();

  const matrix = buildCaseMatrix(REQUIRED_TOTALS);
  const requiredNewRows = requiredNewRowsForTotals(REQUIRED_TOTALS);
  const requiredRows = OLD_POOL_TARGET + requiredNewRows + SOURCE_ROW_RESERVE;

  logSection("Source CSV");
  const source = await collectUniqueRows(requiredRows);
  if (source.rows.length < OLD_POOL_TARGET + requiredNewRows) {
    throw new Error(
      `Not enough unique rows in source CSV. got=${source.rows.length}, need=${OLD_POOL_TARGET + requiredNewRows}`
    );
  }

  log("Collected unique rows", {
    source: source.sourceLabel,
    collected: source.rows.length,
    required: OLD_POOL_TARGET + requiredNewRows,
  });

  const seedOldRows = source.rows.slice(0, OLD_POOL_TARGET);
  const newPoolRows = source.rows.slice(OLD_POOL_TARGET, OLD_POOL_TARGET + requiredNewRows);

  const suiteDir = path.join(
    os.tmpdir(),
    "copart-parser",
    "photo-update-suite",
    formatNow().replace(/[:.]/g, "-")
  );
  const casesDir = path.join(suiteDir, "cases");
  await ensureDirectory(casesDir);

  const seedCsvPath = path.join(suiteDir, "seed_old_100.csv");
  await writeCsv(seedCsvPath, source.headerLine, seedOldRows);

  logSection("Seed Run");
  log("Seed CSV prepared", { seedCsvPath, lots: seedOldRows.length });

  const pool = await connectDb();

  try {
    const lastIngestBeforeSeed = await fetchLastRunId(pool, MYSQL_CORE_DB, "ingest_runs");
    const lastPhotoBeforeSeed = await fetchLastRunId(pool, MYSQL_CORE_DB, "photo_runs");

    await runCommand(process.execPath, ["dist/index.js", "ingest:csv"], {
      ...BASE_ENV_OVERRIDES,
      CSV_LOCAL_FILE: seedCsvPath,
      INGEST_MAX_ROWS: "0",
    });

    const seedIngestRunId = await fetchLastRunId(pool, MYSQL_CORE_DB, "ingest_runs");
    if (seedIngestRunId <= lastIngestBeforeSeed) {
      throw new Error("Seed ingest did not create a new ingest_run record");
    }

    await runCommand(process.execPath, ["dist/index.js", "photo:sync"], {
      ...BASE_ENV_OVERRIDES,
      PHOTO_BATCH_SIZE: String(OLD_POOL_TARGET),
      PHOTO_PROGRESS_EVERY_LOTS: "10",
    });

    const seedPhotoRunId = await fetchLastRunId(pool, MYSQL_CORE_DB, "photo_runs");
    if (seedPhotoRunId <= lastPhotoBeforeSeed) {
      throw new Error("Seed photo:sync did not create a new photo_run record");
    }

    const seedLotNumbers = seedOldRows.map(row => row.lotNumber);
    const oldLotsWithMedia = await fetchOldLotsWithMedia(pool, seedLotNumbers);
    const oldLotSet = new Set(oldLotsWithMedia);
    const oldRowsWithMedia = seedOldRows.filter(row => oldLotSet.has(row.lotNumber));

    log("Seed result", {
      seedIngestRunId,
      seedPhotoRunId,
      oldLotsTotal: seedLotNumbers.length,
      oldLotsWithMedia: oldRowsWithMedia.length,
    });

    const maxOldRequired = Math.max(...matrix.map(item => item.oldCount));
    if (oldRowsWithMedia.length < maxOldRequired) {
      throw new Error(
        `Not enough old lots with photo to run matrix. required_old=${maxOldRequired}, available_old_with_media=${oldRowsWithMedia.length}`
      );
    }

    logSection("Case Generation");
    log("Generating case CSV files", {
      matrixCases: matrix.length,
      requiredNewRows,
      caseTotals: REQUIRED_TOTALS,
    });

    let newCursor = 0;
    const runnableCases = [];

    for (const item of matrix) {
      const oldRows = oldRowsWithMedia.slice(0, item.oldCount);
      const newRows = newPoolRows.slice(newCursor, newCursor + item.newCount);
      if (newRows.length !== item.newCount) {
        throw new Error(
          `Not enough new rows for case ${item.id}. need=${item.newCount}, have=${newRows.length}`
        );
      }
      newCursor += item.newCount;

      const rows = [...oldRows, ...newRows];
      const csvPath = path.join(casesDir, `${item.id}.csv`);
      await writeCsv(csvPath, source.headerLine, rows);

      runnableCases.push({
        ...item,
        csvPath,
        oldLotNumbers: oldRows.map(row => row.lotNumber),
        newLotNumbers: newRows.map(row => row.lotNumber),
      });

      log("Case CSV created", {
        caseId: item.id,
        total: rows.length,
        old: item.oldCount,
        new: item.newCount,
        csvPath,
      });
    }

    logSection("Run Matrix");
    const suiteStartedAt = Date.now();
    let passed = 0;
    let failed = 0;

    for (const testCase of runnableCases) {
      const caseStartedAt = Date.now();
      log(`Case ${testCase.id} started`, {
        old: testCase.oldCount,
        new: testCase.newCount,
        csvPath: testCase.csvPath,
      });

      const ingestBefore = await fetchLastRunId(pool, MYSQL_CORE_DB, "ingest_runs");
      const photoBefore = await fetchLastRunId(pool, MYSQL_CORE_DB, "photo_runs");

      await runCommand(process.execPath, ["dist/index.js", "ingest:csv"], {
        ...BASE_ENV_OVERRIDES,
        CSV_LOCAL_FILE: testCase.csvPath,
        INGEST_MAX_ROWS: "0",
      });

      const ingestAfter = await fetchLastRunId(pool, MYSQL_CORE_DB, "ingest_runs");
      if (ingestAfter <= ingestBefore) {
        throw new Error(`Case ${testCase.id}: ingest run was not created`);
      }

      const ingestRun = await fetchIngestRunById(pool, ingestAfter);
      const oldDueBefore = await countDueCandidatesForLots(pool, testCase.oldLotNumbers);
      const newDueBefore = await countDueCandidatesForLots(pool, testCase.newLotNumbers);
      const oldMediaBefore = await countGoodMediaLots(pool, testCase.oldLotNumbers);
      const newMediaBefore = await countGoodMediaLots(pool, testCase.newLotNumbers);

      const photoStartedAt = new Date();

      await runCommand(process.execPath, ["dist/index.js", "photo:sync"], {
        ...BASE_ENV_OVERRIDES,
        PHOTO_BATCH_SIZE: String(Math.max(testCase.total, 50)),
        PHOTO_PROGRESS_EVERY_LOTS: "10",
      });

      const photoAfter = await fetchLastRunId(pool, MYSQL_CORE_DB, "photo_runs");
      if (photoAfter <= photoBefore) {
        throw new Error(`Case ${testCase.id}: photo run was not created`);
      }

      const photoRun = await fetchPhotoRunById(pool, photoAfter);
      const oldTouched = await countLotsTouchedSince(pool, testCase.oldLotNumbers, photoStartedAt);
      const newTouched = await countLotsTouchedSince(pool, testCase.newLotNumbers, photoStartedAt);
      const oldMediaAfter = await countGoodMediaLots(pool, testCase.oldLotNumbers);
      const newMediaAfter = await countGoodMediaLots(pool, testCase.newLotNumbers);
      const oldAttempts = await countAttemptsForWindow(
        pool,
        testCase.oldLotNumbers,
        photoRun?.started_at ?? null,
        photoRun?.finished_at ?? null
      );
      const newAttempts = await countAttemptsForWindow(
        pool,
        testCase.newLotNumbers,
        photoRun?.started_at ?? null,
        photoRun?.finished_at ?? null
      );

      const oldSkipCheck = oldDueBefore === 0 && oldTouched === 0;
      const newExpectedToProcess = newDueBefore > 0;
      const newObservedProcessing =
        newTouched > 0 || newAttempts > 0 || newMediaAfter > newMediaBefore || Number(photoRun?.lots_processed || 0) > 0;

      const casePassed = oldSkipCheck && (!newExpectedToProcess || newObservedProcessing);
      if (casePassed) {
        passed += 1;
      } else {
        failed += 1;
      }

      log(`Case ${testCase.id} finished`, {
        status: casePassed ? "PASS" : "FAIL",
        duration: compactDurationMs(caseStartedAt),
        ingest: {
          runId: ingestAfter,
          inserted: Number(ingestRun?.rows_inserted || 0),
          updated: Number(ingestRun?.rows_updated || 0),
          unchanged: Number(ingestRun?.rows_unchanged || 0),
          invalid: Number(ingestRun?.rows_invalid || 0),
        },
        photo: {
          runId: photoAfter,
          lotsScanned: Number(photoRun?.lots_scanned || 0),
          lotsProcessed: Number(photoRun?.lots_processed || 0),
          lotsOk: Number(photoRun?.lots_ok || 0),
          lotsMissing: Number(photoRun?.lots_missing || 0),
          imagesUpserted: Number(photoRun?.images_upserted || 0),
          http404: Number(photoRun?.http_404_count || 0),
        },
        checks: {
          oldDueBefore,
          oldTouched,
          oldAttempts,
          oldMediaBefore,
          oldMediaAfter,
          oldSkipCheck,
          newDueBefore,
          newTouched,
          newAttempts,
          newMediaBefore,
          newMediaAfter,
          newExpectedToProcess,
          newObservedProcessing,
        },
      });
    }

    logSection("Suite Summary");
    log("All cases completed", {
      totalCases: runnableCases.length,
      passed,
      failed,
      duration: compactDurationMs(suiteStartedAt),
      artifactsDir: suiteDir,
    });

    if (failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`${LOG_PREFIX} FATAL ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
