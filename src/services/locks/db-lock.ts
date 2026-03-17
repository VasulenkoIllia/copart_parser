import crypto from "crypto";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";
import { logger } from "../../lib/logger";

export interface AppLockHandle {
  lockName: string;
  ownerId: string;
}

interface ActiveAppLockRow extends RowDataPacket {
  lock_name: string;
  owner_id: string;
  locked_until: Date | string;
}

export interface ActiveAppLock {
  lockName: string;
  ownerId: string;
  lockedUntil: Date;
}

function normalizeLockNames(lockNames: string[]): string[] {
  return Array.from(
    new Set(
      lockNames
        .map(lockName => lockName.trim())
        .filter(Boolean)
    )
  );
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

export async function fetchActiveAppLocks(lockNames: string[]): Promise<ActiveAppLock[]> {
  const normalizedLockNames = normalizeLockNames(lockNames);
  if (normalizedLockNames.length === 0) {
    return [];
  }

  const placeholders = normalizedLockNames.map(() => "?").join(", ");
  const pool = getPool();
  const [rows] = await pool.query<ActiveAppLockRow[]>(
    `
      SELECT lock_name, owner_id, locked_until
      FROM \`${env.mysql.databaseCore}\`.\`app_locks\`
      WHERE lock_name IN (${placeholders})
        AND locked_until >= CURRENT_TIMESTAMP(3)
      ORDER BY lock_name ASC
    `,
    normalizedLockNames
  );

  return rows.map(row => ({
    lockName: String(row.lock_name),
    ownerId: String(row.owner_id),
    lockedUntil:
      row.locked_until instanceof Date ? row.locked_until : new Date(String(row.locked_until)),
  }));
}

async function releaseAppLocks(handles: AppLockHandle[]): Promise<void> {
  for (const handle of [...handles].reverse()) {
    await releaseAppLock(handle);
  }
}

export async function withAppLocks<T>(
  lockNames: string[],
  callback: () => Promise<T>
): Promise<T | null> {
  const normalizedLockNames = normalizeLockNames(lockNames);
  if (normalizedLockNames.length === 0) {
    return callback();
  }

  const handles: AppLockHandle[] = [];
  for (const lockName of normalizedLockNames) {
    const handle = await acquireAppLock(lockName);
    if (!handle) {
      await releaseAppLocks(handles);
      return null;
    }
    handles.push(handle);
  }

  const renewEveryMs = Math.max(1_000, Math.floor((env.schedule.runLockTtlSec * 1_000) / 3));
  let renewInFlight = false;
  let lockLostError: Error | null = null;
  const timer = setInterval(() => {
    if (renewInFlight) {
      return;
    }

    renewInFlight = true;
    void Promise.all(handles.map(handle => renewAppLock(handle)))
      .catch(error => {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        lockLostError = lockLostError ?? normalizedError;
        logger.error("App lock renewal failed", {
          lockNames: handles.map(handle => handle.lockName),
          ownerIds: handles.map(handle => handle.ownerId),
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
    await releaseAppLocks(handles);
  }
}

export async function withAppLock<T>(
  lockName: string,
  callback: () => Promise<T>
): Promise<T | null> {
  return withAppLocks([lockName], callback);
}
