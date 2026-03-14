import fs from "fs/promises";
import path from "path";
import { ResultSetHeader, RowDataPacket } from "mysql2";
import env from "../config/env";
import { getPool } from "./mysql";
import { logger } from "../lib/logger";

interface MigrationRow extends RowDataPacket {
  file_name: string;
}

const MIGRATIONS_DIR = path.resolve(process.cwd(), "sql", "migrations");

function renderMigrationSql(sql: string): string {
  const rendered = sql
    .split("{{CORE_DB}}")
    .join(env.mysql.databaseCore)
    .split("{{MEDIA_DB}}")
    .join(env.mysql.databaseMedia);

  const unresolvedPlaceholders = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolvedPlaceholders && unresolvedPlaceholders.length > 0) {
    throw new Error(
      `Migration contains unresolved placeholders: ${Array.from(new Set(unresolvedPlaceholders)).join(", ")}`
    );
  }

  return rendered;
}

export async function runMigrations(): Promise<void> {
  const pool = getPool();

  await pool.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.mysql.databaseCore}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await pool.query(
    `CREATE DATABASE IF NOT EXISTS \`${env.mysql.databaseMedia}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS \`${env.mysql.databaseCore}\`.\`schema_migrations\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`file_name\` VARCHAR(255) NOT NULL,
      \`applied_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uq_file_name\` (\`file_name\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const entries = await fs.readdir(MIGRATIONS_DIR, { withFileTypes: true });
  const files = entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".sql"))
    .map(entry => entry.name)
    .sort();

  if (files.length === 0) {
    logger.warn("No SQL migrations found", { migrationsDir: MIGRATIONS_DIR });
    return;
  }

  const [rows] = await pool.query<MigrationRow[]>(
    `SELECT file_name FROM \`${env.mysql.databaseCore}\`.\`schema_migrations\``
  );
  const applied = new Set(rows.map(row => row.file_name));

  for (const file of files) {
    if (applied.has(file)) {
      logger.info("Migration already applied", { file });
      continue;
    }

    const fullPath = path.join(MIGRATIONS_DIR, file);
    const rawSql = await fs.readFile(fullPath, "utf8");
    const sql = renderMigrationSql(rawSql);

    logger.info("Applying migration", { file });

    const connection = await pool.getConnection();
    try {
      await connection.query(sql);
      await connection.query<ResultSetHeader>(
        `INSERT INTO \`${env.mysql.databaseCore}\`.\`schema_migrations\` (file_name) VALUES (?)`,
        [file]
      );
    } catch (error) {
      throw error;
    } finally {
      connection.release();
    }
  }

  logger.info("Migrations complete", { total: files.length });
}
