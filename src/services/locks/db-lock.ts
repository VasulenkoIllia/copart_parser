import crypto from "crypto";
import { ResultSetHeader } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";
import { logger } from "../../lib/logger";

export interface AppLockHandle {
  lockName: string;
  ownerId: string;
}

export async function acquireAppLock(lockName: string): Promise<AppLockHandle | null> {
  const pool = getPool();
  const ownerId = crypto.randomUUID();

  const [insertResult] = await pool.query<ResultSetHeader>(
    `
      INSERT IGNORE INTO \`${env.mysql.databaseCore}\`.\`app_locks\` (lock_name, owner_id, locked_until)
      VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND))
    `,
    [lockName, ownerId, env.schedule.runLockTtlSec]
  );

  if (insertResult.affectedRows === 1) {
    return { lockName, ownerId };
  }

  const [updateResult] = await pool.query<ResultSetHeader>(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`app_locks\`
      SET
        owner_id = ?,
        locked_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND)
      WHERE
        lock_name = ?
        AND locked_until < CURRENT_TIMESTAMP(3)
    `,
    [ownerId, env.schedule.runLockTtlSec, lockName]
  );

  if (updateResult.affectedRows !== 1) {
    return null;
  }

  return { lockName, ownerId };
}

export async function releaseAppLock(handle: AppLockHandle): Promise<void> {
  const pool = getPool();
  await pool.query(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`app_locks\`
      SET locked_until = CURRENT_TIMESTAMP(3)
      WHERE lock_name = ? AND owner_id = ?
    `,
    [handle.lockName, handle.ownerId]
  );
}

export async function renewAppLock(handle: AppLockHandle): Promise<void> {
  const pool = getPool();
  const [result] = await pool.query<ResultSetHeader>(
    `
      UPDATE \`${env.mysql.databaseCore}\`.\`app_locks\`
      SET locked_until = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND)
      WHERE lock_name = ? AND owner_id = ?
    `,
    [env.schedule.runLockTtlSec, handle.lockName, handle.ownerId]
  );

  if (result.affectedRows !== 1) {
    throw new Error(
      `App lock lost: lock_name=${handle.lockName}, owner_id=${handle.ownerId}`
    );
  }
}

export async function withAppLock<T>(
  lockName: string,
  callback: () => Promise<T>
): Promise<T | null> {
  const handle = await acquireAppLock(lockName);
  if (!handle) {
    return null;
  }

  const renewEveryMs = Math.max(1_000, Math.floor((env.schedule.runLockTtlSec * 1_000) / 3));
  let renewInFlight = false;
  let lockLostError: Error | null = null;
  const timer = setInterval(() => {
    if (renewInFlight) {
      return;
    }

    renewInFlight = true;
    void renewAppLock(handle)
      .catch(error => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        lockLostError = lockLostError ?? normalizedError;
        logger.error("App lock renewal failed", {
          lockName: handle.lockName,
          ownerId: handle.ownerId,
          message: normalizedError.message,
        });
      })
      .finally(() => {
        renewInFlight = false;
      });
  }, renewEveryMs);

  timer.unref?.();

  try {
    const result = await callback();
    if (lockLostError) {
      throw lockLostError;
    }
    return result;
  } finally {
    clearInterval(timer);
    await releaseAppLock(handle);
  }
}
