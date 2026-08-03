import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Resolved from import.meta.url so it works from src (vitest, tsx) and from
 * dist (production), where scripts/copy-sql.mjs has placed the .sql files.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

export function openDatabase(filePath: string): Db {
  const db = new Database(filePath);
  // WAL is CONTRACT §6. foreign_keys must be set here: SQLite ignores the
  // pragma inside the transaction that wraps each migration.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export function migrate(db: Db, dir: string = MIGRATIONS_DIR): MigrationResult {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );

  const done = new Set(
    db
      .prepare('SELECT name FROM schema_migrations')
      .all()
      .map((row) => (row as { name: string }).name),
  );
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    if (done.has(file)) {
      alreadyApplied.push(file);
      continue;
    }
    const sql = readFileSync(join(dir, file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
    applied.push(file);
  }

  return { applied, alreadyApplied };
}
