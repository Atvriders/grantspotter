import type Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { createTestDb } from '../../test/helpers/tempDb.js';
import { ensureIngestionSchema } from '../db/ingestSchema.js';

/**
 * Plan 1's migrated temp-file database, plus Plan 2's idempotent ingestion
 * schema pass, exposed as a bare handle whose close() also removes the temp
 * directory. It is an adapter over createTestDb() and nothing else: there is
 * no second migration runner in this repository.
 *
 * RESOLUTIONS, type finding #15. A second harness that re-applied migrations by
 * hand would skip Plan 1's `schema_migrations` bookkeeping and Plan 2's
 * `ensureIngestionSchema` assertions, and would then disagree with production
 * about what the schema is — which is exactly the disagreement
 * `db/schemaConformance.test.ts` exists to make impossible.
 */
export function openTestDb(): Database.Database {
  const harness = createTestDb();
  ensureIngestionSchema(harness.db);

  const db = harness.db;
  const closeOnly = db.close.bind(db);
  db.close = (): Database.Database => {
    const result = closeOnly();
    rmSync(harness.dir, { recursive: true, force: true });
    return result;
  };
  return db;
}
