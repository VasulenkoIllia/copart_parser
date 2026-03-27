import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

type HttpMode = "direct" | "proxy" | "mixed";

interface AppEnv {
  app: {
    name: string;
    env: string;
    tz: string;
    logLevel: "debug" | "info" | "warn" | "error";
  };
  schedule: {
    ingestCron: string;
    photoRetryCron: string;
    photoSolrRetryCron: string;
    runLockTtlSec: number;
    runOnStart: boolean;
  };
  maintenance: {
    enabled: boolean;
    cron: string;
    batchSize: number;
    pruneOrphanLotImages: boolean;
    photoFetchAttemptsRetentionDays: number;
    invalidCsvRowsRetentionDays: number;
    ingestRunsRetentionDays: number;
    photoRunsRetentionDays: number;
    photoClusterRunsRetentionDays: number;
  };
  csv: {
    sourceUrl: string;
    authKey: string;
    localFile: string;
    cacheBust: boolean;
    timeoutMs: number;
    retries: number;
    retryDelayMs: number;
    streamHighWaterMark: number;
    skipLogLimit: number;
  };
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    databaseCore: string;
    databaseMedia: string;
    poolMin: number;
    poolMax: number;
    connectTimeoutMs: number;
  };
  ingest: {
    batchSize: number;
    upsertChunk: number;
    progressEveryRows: number;
    maxRows: number;
    pruneMissingLots: boolean;
    pruneMaxInvalidRows: number;
    pruneMaxInvalidPercent: number;
    executionRetries: number;
    executionRetryDelayMs: number;
    rowHashAlgo: string;
  };
  photo: {
    batchSize: number;
    fetchConcurrency: number;
    workerTotal: number;
    workerIndex: number;
    progressEveryLots: number;
    httpTimeoutMs: number;
    endpointRetries: number;
    solrFallbackEnabled: boolean;
    solrFallbackMinIntervalMs: number;
    solrFallbackRetries: number;
    imageRetries: number;
    logLotResults: boolean;
    validateByHeadFirst: boolean;
    minWidth: number;
    minHeight: number;
    minContentLength: number;
    fallbackFullMinWidth: number;
    fallbackFullMinHeight: number;
    fallbackFullMinContentLength: number;
    acceptedExtensions: string[];
    retryBaseDelayMinutes: number;
    retryMaxDelayMinutes: number;
  };
  proxy: {
    mode: HttpMode;
    listFile: string;
    list: string[];
    rotation: string;
    maxRoutesPerRequest: number;
    healthcheckUrl: string;
    autoSelectForPhoto: boolean;
    autoSelectProbeLots: number;
    failureCooldownSec: number;
    preflightEnabled: boolean;
    preflightTimeoutMs: number;
    preflightConcurrency: number;
    preflightTopN: number;
    preflightMinWorking: number;
    preflightStrict: boolean;
  };
  diagnostics: {
    httpLogSlowRequestMs: number;
    httpLogRetryAttempts: boolean;
  };
  telegram: {
    enabled: boolean;
    botToken: string;
    chatId: string;
    sendSuccessSummary: boolean;
    sendErrorAlerts: boolean;
    pollingEnabled: boolean;
    pollTimeoutSec: number;
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value;
}

function toInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid integer value for ${name}: "${raw}"`);
  }
  return parsed;
}

function toFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid float value for ${name}: "${raw}"`);
  }
  return parsed;
}

function toBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const normalized = raw.toLowerCase().trim();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value for ${name}: "${raw}"`);
}

function parseHttpMode(name: string, fallback: HttpMode): HttpMode {
  const raw = optional(name, fallback);
  if (raw === "direct" || raw === "proxy" || raw === "mixed") {
    return raw;
  }
  throw new Error(`Invalid HTTP mode for ${name}: "${raw}"`);
}

function parseList(name: string): string[] {
  const raw = optional(name, "");
  if (!raw.trim()) {
    return [];
  }
  return raw
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function parseProxyListFromFile(filePath: string): string[] {
  if (!filePath.trim()) {
    return [];
  }

  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Proxy list file not found: ${resolved}`);
  }

  const content = fs.readFileSync(resolved, "utf8");
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => Boolean(line) && !line.startsWith("#"));
}

function parseProxyList(mode: HttpMode, listEnvName: string, fileEnvName: string): string[] {
  const inline = parseList(listEnvName);
  const filePath = optional(fileEnvName, "");
  const fromFile = mode === "direct" ? [] : parseProxyListFromFile(filePath);

  if (inline.length === 0) {
    return fromFile;
  }
  if (fromFile.length === 0) {
    return inline;
  }

  const deduped = new Set<string>();
  const merged = [...fromFile, ...inline];
  for (const item of merged) {
    deduped.add(item);
  }
  return Array.from(deduped);
}

function parseLogLevel(name: string, fallback: LogLevel): LogLevel {
  const raw = optional(name, fallback);
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  throw new Error(`Invalid log level for ${name}: "${raw}"`);
}

type LogLevel = "debug" | "info" | "warn" | "error";

function isSafeMysqlIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(value);
}

const env: AppEnv = {
  app: {
    name: optional("APP_NAME", "copart-parser"),
    env: optional("APP_ENV", "development"),
    tz: optional("TZ", "Europe/Kyiv"),
    logLevel: parseLogLevel("LOG_LEVEL", "info"),
  },
  schedule: {
    ingestCron: optional("INGEST_CRON", "0 0,5,10,15,20 * * *"),
    photoRetryCron: optional("PHOTO_RETRY_CRON", ""),
    photoSolrRetryCron: optional("PHOTO_SOLR_RETRY_CRON", ""),
    runLockTtlSec: toInt("RUN_LOCK_TTL_SEC", 16200),
    runOnStart: toBoolean("SCHEDULER_RUN_ON_START", false),
  },
  maintenance: {
    enabled: toBoolean("RETENTION_ENABLED", true),
    cron: optional("RETENTION_CRON", "30 3 * * *"),
    batchSize: toInt("RETENTION_BATCH_SIZE", 5000),
    pruneOrphanLotImages: toBoolean("RETENTION_PRUNE_ORPHAN_LOT_IMAGES", true),
    photoFetchAttemptsRetentionDays: toInt("RETENTION_PHOTO_FETCH_ATTEMPTS_DAYS", 30),
    invalidCsvRowsRetentionDays: toInt("RETENTION_INVALID_CSV_ROWS_DAYS", 30),
    ingestRunsRetentionDays: toInt("RETENTION_INGEST_RUNS_DAYS", 45),
    photoRunsRetentionDays: toInt("RETENTION_PHOTO_RUNS_DAYS", 45),
    photoClusterRunsRetentionDays: toInt("RETENTION_PHOTO_CLUSTER_RUNS_DAYS", 45),
  },
  csv: {
    sourceUrl: optional("CSV_SOURCE_URL", "https://allzap.site/copart/salesdata.csv"),
    authKey: optional("CSV_AUTH_KEY", "change_me"),
    localFile: optional("CSV_LOCAL_FILE", ""),
    cacheBust: toBoolean("CSV_CACHE_BUST", true),
    timeoutMs: toInt("CSV_HTTP_TIMEOUT_MS", 60000),
    retries: toInt("CSV_DOWNLOAD_RETRIES", 5),
    retryDelayMs: toInt("CSV_DOWNLOAD_RETRY_DELAY_MS", 5000),
    streamHighWaterMark: toInt("CSV_STREAM_HIGH_WATER_MARK", 1_048_576),
    skipLogLimit: toInt("CSV_PARSE_SKIP_LOG_LIMIT", 20),
  },
  mysql: {
    host: optional("MYSQL_HOST", "127.0.0.1"),
    port: toInt("MYSQL_PORT", 3306),
    user: optional("MYSQL_USER", "copart"),
    password: optional("MYSQL_PASSWORD", "copart"),
    databaseCore: optional("MYSQL_DATABASE_CORE", "copart_core"),
    databaseMedia: optional("MYSQL_DATABASE_MEDIA", "copart_media"),
    poolMin: toInt("MYSQL_POOL_MIN", 5),
    poolMax: toInt("MYSQL_POOL_MAX", 50),
    connectTimeoutMs: toInt("MYSQL_CONNECT_TIMEOUT_MS", 10_000),
  },
  ingest: {
    batchSize: toInt("INGEST_BATCH_SIZE", 1000),
    upsertChunk: toInt("INGEST_UPSERT_CHUNK", 500),
    progressEveryRows: toInt("INGEST_PROGRESS_EVERY_ROWS", 5_000),
    maxRows: toInt("INGEST_MAX_ROWS", 0),
    pruneMissingLots: toBoolean("INGEST_PRUNE_MISSING_LOTS", true),
    pruneMaxInvalidRows: toInt("INGEST_PRUNE_MAX_INVALID_ROWS", 250),
    pruneMaxInvalidPercent: toFloat("INGEST_PRUNE_MAX_INVALID_PERCENT", 2),
    executionRetries: toInt("INGEST_EXECUTION_RETRIES", 2),
    executionRetryDelayMs: toInt("INGEST_EXECUTION_RETRY_DELAY_MS", 5_000),
    rowHashAlgo: optional("INGEST_ROW_HASH_ALGO", "sha256"),
  },
  photo: {
    batchSize: toInt("PHOTO_BATCH_SIZE", 500),
    fetchConcurrency: toInt("PHOTO_FETCH_CONCURRENCY", 25),
    workerTotal: toInt("PHOTO_WORKER_TOTAL", 1),
    workerIndex: toInt("PHOTO_WORKER_INDEX", 0),
    progressEveryLots: toInt("PHOTO_PROGRESS_EVERY_LOTS", 100),
    httpTimeoutMs: toInt("PHOTO_HTTP_TIMEOUT_MS", 20_000),
    endpointRetries: toInt("PHOTO_ENDPOINT_RETRIES", 3),
    solrFallbackEnabled: toBoolean("PHOTO_SOLR_FALLBACK_ENABLED", false),
    solrFallbackMinIntervalMs: toInt("PHOTO_SOLR_FALLBACK_MIN_INTERVAL_MS", 1000),
    solrFallbackRetries: toInt("PHOTO_SOLR_FALLBACK_RETRIES", 1),
    imageRetries: toInt("PHOTO_IMAGE_RETRIES", 3),
    logLotResults: toBoolean("PHOTO_LOG_LOT_RESULTS", false),
    validateByHeadFirst: toBoolean("PHOTO_VALIDATE_BY_HEAD_FIRST", true),
    minWidth: toInt("PHOTO_MIN_WIDTH", 599),
    minHeight: toInt("PHOTO_MIN_HEIGHT", 900),
    minContentLength: toInt("PHOTO_MIN_CONTENT_LENGTH", 120_000),
    fallbackFullMinWidth: toInt("PHOTO_FALLBACK_FULL_MIN_WIDTH", 900),
    fallbackFullMinHeight: toInt("PHOTO_FALLBACK_FULL_MIN_HEIGHT", 675),
    fallbackFullMinContentLength: toInt("PHOTO_FALLBACK_FULL_MIN_CONTENT_LENGTH", 80_000),
    acceptedExtensions: parseList("PHOTO_ACCEPTED_EXTENSIONS"),
    retryBaseDelayMinutes: toInt("PHOTO_RETRY_BASE_DELAY_MINUTES", 30),
    retryMaxDelayMinutes: toInt("PHOTO_RETRY_MAX_DELAY_MINUTES", 120),
  },
  proxy: {
    mode: parseHttpMode("HTTP_MODE", "direct"),
    listFile: optional("PROXY_LIST_FILE", ""),
    list: [],
    rotation: optional("PROXY_ROTATION", "strict"),
    maxRoutesPerRequest: toInt("PROXY_MAX_ROUTES_PER_REQUEST", 5),
    healthcheckUrl: optional("PROXY_HEALTHCHECK_URL", "https://www.copart.com/"),
    autoSelectForPhoto: toBoolean("PROXY_AUTO_SELECT_FOR_PHOTO", false),
    autoSelectProbeLots: toInt("PROXY_AUTO_SELECT_PROBE_LOTS", 20),
    failureCooldownSec: toInt("PROXY_FAILURE_COOLDOWN_SEC", 300),
    preflightEnabled: toBoolean("PROXY_PREFLIGHT_ENABLED", true),
    preflightTimeoutMs: toInt("PROXY_PREFLIGHT_TIMEOUT_MS", 7_000),
    preflightConcurrency: toInt("PROXY_PREFLIGHT_CONCURRENCY", 100),
    preflightTopN: toInt("PROXY_PREFLIGHT_TOP_N", 20),
    preflightMinWorking: toInt("PROXY_PREFLIGHT_MIN_WORKING", 5),
    preflightStrict: toBoolean("PROXY_PREFLIGHT_STRICT", false),
  },
  diagnostics: {
    httpLogSlowRequestMs: toInt("HTTP_LOG_SLOW_REQUEST_MS", 3_000),
    httpLogRetryAttempts: toBoolean("HTTP_LOG_RETRY_ATTEMPTS", true),
  },
  telegram: {
    enabled: toBoolean("TELEGRAM_ENABLED", false),
    botToken: optional("TELEGRAM_BOT_TOKEN", ""),
    chatId: optional("TELEGRAM_CHAT_ID", ""),
    sendSuccessSummary: toBoolean("TELEGRAM_SEND_SUCCESS_SUMMARY", true),
    sendErrorAlerts: toBoolean("TELEGRAM_SEND_ERROR_ALERTS", true),
    pollingEnabled: toBoolean("TELEGRAM_BOT_POLLING_ENABLED", true),
    pollTimeoutSec: toInt("TELEGRAM_BOT_POLL_TIMEOUT_SEC", 20),
  },
};

env.proxy.list = parseProxyList(env.proxy.mode, "PROXY_LIST", "PROXY_LIST_FILE");

if (env.maintenance.batchSize < 1) {
  throw new Error("RETENTION_BATCH_SIZE must be >= 1");
}

if (env.maintenance.photoFetchAttemptsRetentionDays < 0) {
  throw new Error("RETENTION_PHOTO_FETCH_ATTEMPTS_DAYS must be >= 0");
}

if (env.maintenance.invalidCsvRowsRetentionDays < 0) {
  throw new Error("RETENTION_INVALID_CSV_ROWS_DAYS must be >= 0");
}

if (env.maintenance.ingestRunsRetentionDays < 0) {
  throw new Error("RETENTION_INGEST_RUNS_DAYS must be >= 0");
}

if (env.maintenance.photoRunsRetentionDays < 0) {
  throw new Error("RETENTION_PHOTO_RUNS_DAYS must be >= 0");
}

if (env.maintenance.photoClusterRunsRetentionDays < 0) {
  throw new Error("RETENTION_PHOTO_CLUSTER_RUNS_DAYS must be >= 0");
}

if (env.ingest.upsertChunk > env.ingest.batchSize) {
  throw new Error("INGEST_UPSERT_CHUNK must be <= INGEST_BATCH_SIZE");
}

if (env.ingest.progressEveryRows < 1) {
  throw new Error("INGEST_PROGRESS_EVERY_ROWS must be >= 1");
}

if (env.ingest.maxRows < 0) {
  throw new Error("INGEST_MAX_ROWS must be >= 0");
}

if (env.ingest.pruneMaxInvalidRows < 0) {
  throw new Error("INGEST_PRUNE_MAX_INVALID_ROWS must be >= 0");
}

if (env.ingest.pruneMaxInvalidPercent < 0 || env.ingest.pruneMaxInvalidPercent > 100) {
  throw new Error("INGEST_PRUNE_MAX_INVALID_PERCENT must be in range [0, 100]");
}

if (env.ingest.executionRetries < 1) {
  throw new Error("INGEST_EXECUTION_RETRIES must be >= 1");
}

if (env.ingest.executionRetryDelayMs < 0) {
  throw new Error("INGEST_EXECUTION_RETRY_DELAY_MS must be >= 0");
}

if (!isSafeMysqlIdentifier(env.mysql.databaseCore)) {
  throw new Error("MYSQL_DATABASE_CORE contains unsupported characters");
}

if (!isSafeMysqlIdentifier(env.mysql.databaseMedia)) {
  throw new Error("MYSQL_DATABASE_MEDIA contains unsupported characters");
}

if (env.photo.workerTotal < 1) {
  throw new Error("PHOTO_WORKER_TOTAL must be >= 1");
}

if (env.telegram.pollTimeoutSec < 1 || env.telegram.pollTimeoutSec > 50) {
  throw new Error("TELEGRAM_BOT_POLL_TIMEOUT_SEC must be in range [1, 50]");
}

if (env.photo.workerIndex < 0 || env.photo.workerIndex >= env.photo.workerTotal) {
  throw new Error("PHOTO_WORKER_INDEX must be in range [0, PHOTO_WORKER_TOTAL - 1]");
}

if (env.photo.progressEveryLots < 1) {
  throw new Error("PHOTO_PROGRESS_EVERY_LOTS must be >= 1");
}

if (env.photo.minWidth < 1 || env.photo.minHeight < 1 || env.photo.minContentLength < 0) {
  throw new Error("PHOTO_MIN_WIDTH/PHOTO_MIN_HEIGHT must be >= 1 and PHOTO_MIN_CONTENT_LENGTH must be >= 0");
}

if (env.photo.solrFallbackMinIntervalMs < 0) {
  throw new Error("PHOTO_SOLR_FALLBACK_MIN_INTERVAL_MS must be >= 0");
}

if (env.photo.solrFallbackRetries < 1) {
  throw new Error("PHOTO_SOLR_FALLBACK_RETRIES must be >= 1");
}

if (
  env.photo.fallbackFullMinWidth < 1 ||
  env.photo.fallbackFullMinHeight < 1 ||
  env.photo.fallbackFullMinContentLength < 0
) {
  throw new Error(
    "PHOTO_FALLBACK_FULL_MIN_WIDTH/PHOTO_FALLBACK_FULL_MIN_HEIGHT must be >= 1 and PHOTO_FALLBACK_FULL_MIN_CONTENT_LENGTH must be >= 0"
  );
}

if (env.proxy.preflightTimeoutMs < 1000) {
  throw new Error("PROXY_PREFLIGHT_TIMEOUT_MS must be >= 1000");
}

if (env.proxy.maxRoutesPerRequest < 1) {
  throw new Error("PROXY_MAX_ROUTES_PER_REQUEST must be >= 1");
}

if (env.proxy.preflightConcurrency < 1) {
  throw new Error("PROXY_PREFLIGHT_CONCURRENCY must be >= 1");
}

if (env.proxy.preflightTopN < 1) {
  throw new Error("PROXY_PREFLIGHT_TOP_N must be >= 1");
}

if (env.proxy.autoSelectProbeLots < 1) {
  throw new Error("PROXY_AUTO_SELECT_PROBE_LOTS must be >= 1");
}

if (env.proxy.preflightMinWorking < 1) {
  throw new Error("PROXY_PREFLIGHT_MIN_WORKING must be >= 1");
}

if (env.diagnostics.httpLogSlowRequestMs < 1) {
  throw new Error("HTTP_LOG_SLOW_REQUEST_MS must be >= 1");
}

export default env;
