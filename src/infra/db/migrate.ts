import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";
import type { DbClient } from "./client.js";

export interface Migration {
  version: number;
  name: string;
  file: string;
  sql: string;
}

const FILE_RE = /^(\d+)_([a-z0-9_-]+)\.sql$/i;

/** Reads `NNN_name.sql` files in version order. */
export function listMigrations(dir: string): Migration[] {
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f));
  const migrations = files.map((file) => {
    const m = FILE_RE.exec(file);
    if (!m?.[1] || !m[2]) throw new Error(`bad migration filename: ${file}`);
    return {
      version: Number(m[1]),
      name: m[2],
      file,
      sql: readFileSync(path.join(dir, file), "utf8"),
    };
  });
  migrations.sort((a, b) => a.version - b.version);
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) throw new Error(`duplicate migration version ${m.version}`);
    seen.add(m.version);
  }
  return migrations;
}

async function ensureTable(db: DbClient): Promise<void> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version integer PRIMARY KEY,
       name text NOT NULL,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
}

export async function appliedVersions(db: DbClient): Promise<number[]> {
  await ensureTable(db);
  const res = await db.query<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  return res.rows.map((r) => Number(r.version));
}

export async function pendingMigrations(db: DbClient, dir: string): Promise<Migration[]> {
  const applied = new Set(await appliedVersions(db));
  return listMigrations(dir).filter((m) => !applied.has(m.version));
}

/** Applies every pending migration, each in its own transaction. Forward-only. */
export async function runMigrations(
  db: DbClient,
  dir: string,
  logger?: Logger,
): Promise<Migration[]> {
  const pending = await pendingMigrations(db, dir);
  for (const m of pending) {
    logger?.info({ version: m.version, name: m.name }, "applying migration");
    await db.transaction(async (tx) => {
      await tx.exec(m.sql);
      await tx.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
        m.version,
        m.name,
      ]);
    });
  }
  return pending;
}
