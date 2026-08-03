import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../../src/db/migrate.js';
import { migrate, openDatabase } from '../../src/db/migrate.js';

export interface TestDb {
  db: Db;
  dir: string;
  cleanup(): void;
}

/** A migrated SQLite database in a throwaway temp directory. */
export function createTestDb(): TestDb {
  const dir = mkdtempSync(join(tmpdir(), 'grantspotter-test-'));
  const db = openDatabase(join(dir, 'grantspotter.sqlite'));
  migrate(db);
  return {
    db,
    dir,
    cleanup(): void {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
