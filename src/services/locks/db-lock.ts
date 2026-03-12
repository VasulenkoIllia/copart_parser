import crypto from "crypto";
import { RowDataPacket } from "mysql2";
import env from "../../config/env";
import { getPool } from "../../db/mysql";

export interface AppLockHandle {
  lockName: string;
  ownerId: string;
}

interface LockRow extends RowDataPacket {
  owner_id: string;
}

export async function acquireAppLock(lockName: string): Promise<AppLockHandle | null> {
  const pool = getPool();
  const ownerId = crypto.randomUUID();

  await pool.query(
    `
      INSERT INTO \`${env.mysql.databaseCore}\`.\`app_locks\` (lock_name, owner_id, locked_until)
      VALUES (?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL ? SECOND))
      ON DUPLICATE KEY UPDATE
        owner_id = IF(locked_until < CURRENT_TIMESTAMP(3), VALUES(owner_id), owner_id),
        locked_until = IF(
          locked_until < CURRENT_TIMESTAMP(3),
          VALUES(locked_until),
          locked_until
        )
    `,
    [lockName, ownerId, env.schedule.runLockTtlSec]
  );

  const [rows] = await pool.query<LockRow[]>(
    `
      SELECT owner_id
      FROM \`${env.mysql.databaseCore}\`.\`app_locks\`
      WHERE lock_name = ?
      LIMIT 1
    `,
    [lockName]
  );

  if (rows.length === 0 || rows[0].owner_id !== ownerId) {
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

export async function withAppLock<T>(
  lockName: string,
  callback: () => Promise<T>
): Promise<T | null> {
  const handle = await acquireAppLock(lockName);
  if (!handle) {
    return null;
  }

  try {
    return await callback();
  } finally {
    await releaseAppLock(handle);
  }
}
