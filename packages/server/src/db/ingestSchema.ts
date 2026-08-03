import type Database from 'better-sqlite3';

/**
 * RESOLUTIONS R1/R3/R4. Plan 1 Task 12's 001-init.sql owns every CONTRACT §6 table. This module
 * creates exactly ONE table — `review_rejects`, Plan 2's only plan-local table — and otherwise
 * ASSERTS that Plan 1's shape is present.
 *
 * The previous version of this file ran `CREATE TABLE IF NOT EXISTS programs (...)` with its own
 * column list. Against a migrated database that is a silent no-op, so a divergent shape survived
 * typechecking and the first nightly crawl died on
 * `SQLITE_CONSTRAINT: NOT NULL constraint failed: programs.summary`. Never re-declare a table
 * another plan owns; assert it instead.
 */
export class MissingSchemaError extends Error {
  readonly table: string;
  readonly column?: string;
  constructor(table: string, column?: string) {
    super(
      column === undefined
        ? `Missing table "${table}". Run Plan 1's migrations (migrate(db)) before ensureIngestionSchema().`
        : `Missing column "${table}.${column}". packages/server/src/db/migrations/001-init.sql owns this shape.`,
    );
    this.name = 'MissingSchemaError';
    this.table = table;
    if (column !== undefined) this.column = column;
  }
}

/** Plan-local tables this module owns outright. CONTRACT §6 lists `review_rejects`. */
const PLAN_LOCAL_TABLES = [
  `CREATE TABLE IF NOT EXISTS review_rejects (
     reject_key  TEXT PRIMARY KEY,
     decided_by  TEXT NOT NULL,
     decided_at  TEXT NOT NULL
   )`,
];

/**
 * Plan 1 tables and the columns the ingestion path actually reads or writes. Asserted, never
 * created and never altered. `sources` carries source health (R4): there is no `source_health`.
 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  programs: [
    'id', 'funder_id', 'name', 'klass', 'summary', 'applicant_entities', 'amount', 'deadline',
    'apply_via', 'apply_url', 'apply_contact', 'funding_restrictions', 'obligations', 'ai_policy',
    'trust', 'raw_other_text', 'tags', 'source_id', 'external_key', 'content_hash', 'status',
    'last_verified_at',
  ],
  // `enabled` is in this list on purpose (RESOLUTIONS R20): `runCrawl` refuses to poll a source
  // whose row says `enabled = 0`, so if the column ever went missing the crawler would silently
  // start ignoring every admin pause. Assert it at boot instead.
  sources: [
    'id', 'funder_id', 'label', 'tier', 'klass', 'enabled', 'expected_min_records',
    'last_record_count', 'last_polled_at', 'last_success_at', 'last_error',
    'consecutive_failures',
  ],
  snapshots: ['source_id', 'url', 'status', 'content_type', 'body_sha256', 'body_bytes', 'file_path', 'fetched_at'],
  change_events: ['id', 'source_id', 'program_id', 'kind', 'field_path', 'before_json', 'after_json', 'detected_at'],
  review_items: ['id', 'change_event_id', 'candidate_json', 'decision', 'decided_by', 'decided_at', 'confidence', 'reject_key'],
  audit_log: ['at', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'detail'],
};

/**
 * Ingestion-only indexes. Plan 1 owns the rest; these are additive, IF NOT EXISTS, and — the
 * point — carry names Plan 1 does not already use.
 *
 * RESOLUTIONS R23: there is deliberately NO `idx_snapshots_source` here. Plan 1's 001-init.sql
 * already creates an index of that exact name (`ON snapshots(source_id, fetched_at)`), and SQLite
 * matches `IF NOT EXISTS` on the NAME alone — so a second declaration with a different definition
 * (`… fetched_at DESC`) is a silent no-op and the index you think you added never exists. That is
 * the same two-definitions-one-name trap as the `CREATE TABLE IF NOT EXISTS programs` defect
 * above, just with a performance rather than a correctness consequence. Plan 1 owns snapshot
 * indexing; if the crawl ever needs a descending variant, it gets a distinct name and a comment
 * saying it complements Plan 1's rather than replacing it.
 */
const INDEXES = ['CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_id)'];

/** Idempotent. Call once at boot, AFTER migrate(db). */
export function ensureIngestionSchema(db: Database.Database): void {
  for (const ddl of PLAN_LOCAL_TABLES) db.exec(ddl);

  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (info.length === 0) throw new MissingSchemaError(table);
    const existing = new Set(info.map((c) => c.name));
    for (const column of columns) {
      if (!existing.has(column)) throw new MissingSchemaError(table, column);
    }
  }

  for (const ddl of INDEXES) db.exec(ddl);
}
