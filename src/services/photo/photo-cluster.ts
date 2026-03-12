import { spawn } from "child_process";
import env from "../../config/env";
import { logger } from "../../lib/logger";

interface WorkerRunResult {
  workerIndex: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

function runWorker(workerIndex: number, workerTotal: number): Promise<WorkerRunResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [process.argv[1], "photo:sync"], {
      env: {
        ...process.env,
        PHOTO_WORKER_TOTAL: String(workerTotal),
        PHOTO_WORKER_INDEX: String(workerIndex),
      },
      stdio: "inherit",
    });

    child.once("error", error => {
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      resolve({
        workerIndex,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

export async function runPhotoCluster(): Promise<void> {
  const workerTotal = env.photo.workerTotal;
  if (workerTotal < 1) {
    throw new Error("PHOTO_WORKER_TOTAL must be >= 1 for photo:cluster");
  }

  logger.info("Photo cluster started", {
    workerTotal,
    fetchConcurrencyPerWorker: env.photo.fetchConcurrency,
    batchSizePerWorker: env.photo.batchSize,
    sharding: "MOD(CRC32(CAST(lot_number AS CHAR)), workerTotal) = workerIndex",
  });

  const startedAt = Date.now();
  const workerPromises: Promise<WorkerRunResult>[] = [];
  for (let workerIndex = 0; workerIndex < workerTotal; workerIndex += 1) {
    workerPromises.push(runWorker(workerIndex, workerTotal));
  }

  const results = await Promise.all(workerPromises);
  const failed = results.filter(result => result.exitCode !== 0);

  logger.info("Photo cluster finished", {
    workerTotal,
    durationMs: Date.now() - startedAt,
    workerResults: results.map(result => ({
      workerIndex: result.workerIndex,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
    })),
  });

  if (failed.length > 0) {
    throw new Error(
      `photo:cluster failed: ${failed.length}/${workerTotal} workers exited with non-zero code`
    );
  }
}
