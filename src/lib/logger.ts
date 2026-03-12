import env from "../config/env";

type LogLevel = "debug" | "info" | "warn" | "error";

const levelWeight: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function canLog(target: LogLevel): boolean {
  const configured = env.app.logLevel;
  return levelWeight[target] >= levelWeight[configured];
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }
  return ` ${JSON.stringify(meta)}`;
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (!canLog(level)) {
    return;
  }

  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${formatMeta(meta)}`;

  if (level === "error") {
    process.stderr.write(`${line}\n`);
    return;
  }

  process.stdout.write(`${line}\n`);
}

export const logger = {
  debug(message: string, meta?: Record<string, unknown>): void {
    log("debug", message, meta);
  },
  info(message: string, meta?: Record<string, unknown>): void {
    log("info", message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    log("warn", message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    log("error", message, meta);
  },
};
