import { closePool } from "./db/mysql";
import { runMigrations } from "./db/migrate";
import { logger } from "./lib/logger";
import { runCsvIngest } from "./services/ingest/csv-ingest";
import { runPhotoSync } from "./services/photo/photo-sync";
import { runPhotoCluster } from "./services/photo/photo-cluster";
import { startScheduler } from "./services/scheduler/scheduler";
import { runFullPipelineOnce } from "./services/pipeline/run-once";
import { runProxyCheck } from "./services/proxy/proxy-check";
import { runRetentionCleanup } from "./services/maintenance/retention";

async function run(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(
      [
        "Usage:",
        "  node dist/index.js db:migrate",
        "  node dist/index.js ingest:csv",
        "  node dist/index.js photo:sync",
        "  node dist/index.js photo:cluster",
        "  node dist/index.js proxy:check",
        "  node dist/index.js pipeline:run-once",
        "  node dist/index.js retention:cleanup",
        "  node dist/index.js scheduler:start",
        "",
      ].join("\n")
    );
    return;
  }

  switch (command) {
    case "db:migrate":
      await runMigrations();
      return;
    case "ingest:csv":
      await runCsvIngest();
      return;
    case "photo:sync":
      await runPhotoSync();
      return;
    case "photo:cluster":
      await runPhotoCluster();
      return;
    case "proxy:check":
      await runProxyCheck();
      return;
    case "pipeline:run-once":
      await runFullPipelineOnce();
      return;
    case "retention:cleanup":
      await runRetentionCleanup({ ignoreEnabledFlag: true });
      return;
    case "scheduler:start":
      await startScheduler();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

run()
  .catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    logger.error("Fatal command error", {
      message,
      stack,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
