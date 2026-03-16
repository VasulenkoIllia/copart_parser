import mysql, { Pool } from "mysql2/promise";
import env from "../config/env";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) {
    return pool;
  }

  pool = mysql.createPool({
    host: env.mysql.host,
    port: env.mysql.port,
    user: env.mysql.user,
    password: env.mysql.password,
    database: env.mysql.databaseCore,
    waitForConnections: true,
    connectionLimit: env.mysql.poolMax,
    maxIdle: env.mysql.poolMin,
    idleTimeout: 60_000,
    queueLimit: 0,
    connectTimeout: env.mysql.connectTimeoutMs,
    multipleStatements: true,
    charset: "utf8mb4",
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) {
    return;
  }
  await pool.end();
  pool = null;
}
