import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';

/**
 * Plan 3's declared read-contract with Plans 1 and 2. If this test fails, a
 * column was renamed upstream; reconcile the name before touching anything else.
 */
const REQUIRED: Record<string, string[]> = {
  funders: ['id', 'name'],
  // Plan 1's normalized shape (RESOLUTIONS R1). There is no `data` column.
  // `source_id` / `external_key` are the crawler-reconciliation pair from R9.
  programs: [
    'id', 'funder_id', 'name', 'klass', 'summary', 'applicant_entities',
    'amount', 'deadline', 'apply_via', 'apply_url', 'apply_contact',
    'funding_restrictions', 'obligations', 'ai_policy', 'trust',
    'raw_other_text', 'tags', 'content_hash', 'status', 'last_verified_at',
    'source_id', 'external_key',
  ],
  cycles: ['id', 'program_id', 'opens_at', 'closes_at', 'timezone', 'label', 'is_estimated'],
  users: ['id', 'email', 'role'],
  // `enabled` is read by the sources router and by the admin pause toggle
  // (Tasks 14 and 24), and gates Plan 2's runCrawl (RESOLUTIONS R20).
  sources: [
    'id', 'label', 'tier', 'funder_id', 'enabled', 'last_polled_at', 'last_success_at',
    'consecutive_failures', 'last_record_count', 'expected_min_records',
  ],
  snapshots: ['id', 'source_id', 'url', 'fetched_at', 'status'],
  change_events: [
    'id', 'source_id', 'program_id', 'kind', 'before_json', 'after_json',
    'detected_at', 'field_path',
  ],
  review_items: [
    'id', 'change_event_id', 'candidate_json', 'decision', 'decided_by',
    'decided_at', 'confidence', 'reject_key',
  ],
  // RESOLUTIONS R26: the Inbox decision route delegates to Plan 2's review
  // pipeline, which writes reject memory and the provenance trail. Plan 3 reads
  // both back in `inboxRouter.test.ts`, so both are part of its read-contract.
  // `review_rejects` is Plan 2's plan-local table (CONTRACT §6); `audit_log` is
  // Plan 1's, and its columns are `at` / `actor_user_id`, not `created_at` /
  // `user_id` — a rename upstream would make provenance silently unreadable.
  review_rejects: ['reject_key', 'decided_by', 'decided_at'],
  audit_log: ['at', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'detail'],
  // DEVIATION FROM THE TASK BRIEF, resolved towards the plan (2026-08-03).
  // The brief's REQUIRED map omits `profiles` and `watches`, but both are rows
  // in the plan's own read-contract table AND the plan says in prose that "the
  // conformance test asserts the columns (including `watches.notify_changes`)"
  // — the sentence that justifies Plan 3 shipping NO migration for either
  // table (RESOLUTIONS R19). Asserting them is the whole reason Plan 3 is
  // allowed not to create them, so the omission is a gap in the brief, not a
  // narrowing of the contract. Both shapes below are Plan 1's 001-init.sql.
  profiles: ['id', 'user_id', 'kind', 'data', 'updated_at'],
  watches: ['id', 'user_id', 'program_id', 'notify_changes', 'created_at'],
  program_search: [
    'program_id', 'funder_id', 'funder_name', 'name', 'klass', 'status',
    'instrument', 'amount_min', 'amount_max', 'deadline_kind',
    'next_opens_at', 'next_closes_at', 'next_is_estimated',
    'last_verified_at', 'haystack',
  ],
  program_facets: ['program_id', 'facet_kind', 'facet_value'],
};

describe('schema conformance (Plan 3 read-contract)', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = openTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it.each(Object.entries(REQUIRED))('table %s has every column Plan 3 reads', (table, columns) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    expect(rows.length, `table "${table}" does not exist`).toBeGreaterThan(0);
    const present = new Set(rows.map((r) => r.name));
    const missing = columns.filter((c) => !present.has(c));
    expect(missing, `${table} is missing columns`).toEqual([]);
  });

  // RESOLUTIONS R1, made executable: if a `data` column ever reappears on
  // `programs`, someone has re-introduced the document shape Plan 1's
  // normalized DDL replaced, and half of Plan 3 would silently read stale JSON.
  it('programs has no `data` column — records are read through createProgramRepo', () => {
    const rows = db.prepare('PRAGMA table_info(programs)').all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).not.toContain('data');
  });

  /**
   * The two-definitions-one-name trap, made executable (it has now recurred
   * three times in this repo: `CREATE TABLE IF NOT EXISTS programs` in Plan 2's
   * ingestion schema, `idx_snapshots_source` beside it, and the R24 note on
   * `applications`). SQLite matches `IF NOT EXISTS` on the NAME alone, so a
   * second declaration of an existing name is a silent no-op and the shape you
   * think you added never exists. Scanning the migration text on disk is the
   * only way to see it, because the database cannot tell you about a statement
   * that did nothing.
   */
  it('declares every table and index name exactly once across all migrations', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { MIGRATIONS_DIR } = await import('./migrate.js');

    const declared = new Map<string, string[]>();
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
        .replace(/--[^\n]*/g, '')
        .toLowerCase();
      for (const m of sql.matchAll(
        /create\s+(?:unique\s+)?(table|index)\s+(?:if\s+not\s+exists\s+)?([a-z0-9_]+)/g,
      )) {
        const key = `${m[1]} ${m[2]}`;
        declared.set(key, [...(declared.get(key) ?? []), file]);
      }
    }

    const duplicated = [...declared.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([key, files]) => `${key} declared in ${files.join(', ')}`);
    expect(
      duplicated,
      'SQLite matches IF NOT EXISTS on the name, so the second declaration never runs',
    ).toEqual([]);

    // Vacuity guard: a regex that stopped matching would pass the check above
    // on an empty set, which is the same silence the check exists to break.
    expect(declared.has('table programs')).toBe(true);
    expect(declared.has('table program_search')).toBe(true);
    expect(declared.has('index idx_pf_lookup')).toBe(true);
  });
});
