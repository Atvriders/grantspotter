import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/migrate.js';
import { createTestDb, type TestDb } from './helpers/tempDb.js';

const EXPECTED_TABLES = [
  'applications',
  'audit_log',
  'change_events',
  'constraints',
  'cycles',
  'funders',
  'profiles',
  'programs',
  'review_items',
  'sessions',
  'snapshots',
  'sources',
  'template_instances',
  'users',
  'watches',
];

let harness: TestDb | undefined;
afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

function tableNames(db: TestDb['db']): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
    )
    .all()
    .map((row) => (row as { name: string }).name);
}

describe('migrate', () => {
  it('creates all fifteen CONTRACT §6 tables', () => {
    harness = createTestDb();
    // Containment, not equality: CONTRACT §6 also blesses `review_rejects`
    // (Plan 2) and `ics_tokens` (Plan 5, migration 090-ics-tokens.sql), and
    // migrate() applies every .sql in the directory. Asserting equality here
    // would turn Plan 5's migration into a Plan 1 test failure.
    expect(EXPECTED_TABLES).toHaveLength(15);
    const present = tableNames(harness.db);
    expect(EXPECTED_TABLES.filter((t) => !present.includes(t))).toEqual([]);
  });

  it('records what it applied and is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grantspotter-mig-'));
    try {
      const db = openDatabase(join(dir, 'db.sqlite'));
      const first = migrate(db);
      expect(first.applied).toContain('001-init.sql');
      expect(first.alreadyApplied).toEqual([]);

      const second = migrate(db);
      expect(second.applied).toEqual([]);
      expect(second.alreadyApplied).toEqual(first.applied);

      const rows = db.prepare('SELECT name FROM schema_migrations').all();
      expect(rows).toHaveLength(first.applied.length);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens the database in WAL mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'grantspotter-wal-'));
    try {
      const db = openDatabase(join(dir, 'db.sqlite'));
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enforces foreign keys on the connection, including cascade delete', () => {
    harness = createTestDb();
    const { db } = harness;
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    expect(() =>
      db
        .prepare('INSERT INTO cycles (id, program_id, timezone, label, is_estimated) VALUES (?,?,?,?,0)')
        .run('c1', 'no-such-program', 'America/New_York', 'orphan'),
    ).toThrow(/FOREIGN KEY constraint failed/);

    db.prepare(
      'INSERT INTO funders (id, name, homepage, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('f1', 'ARRL Foundation', 'https://www.arrl.org/arrl-foundation', 'now', 'now');
    db.prepare(
      `INSERT INTO programs (id, funder_id, name, klass, summary, applicant_entities, amount,
        deadline, apply_via, funding_restrictions, obligations, ai_policy, trust, raw_other_text,
        tags, content_hash, status, last_verified_at, created_at, updated_at)
       VALUES ('p1','f1','X','ham_grant','s','[]','{}','{}','page_form','[]','{}','{}','{}','','[]','h','open','now','now','now')`,
    ).run();
    db.prepare(
      'INSERT INTO constraints (id, program_id, ordinal, hard, fallback_rank, raw_text, axis, spec) VALUES (?,?,0,1,0,?,?,?)',
    ).run('k1', 'p1', 'raw', 'license', '{}');

    db.prepare('DELETE FROM programs WHERE id = ?').run('p1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM constraints').get()).toEqual({ n: 0 });
  });

  it('enforces the role CHECK and the uniqueness rules the API depends on', () => {
    harness = createTestDb();
    const { db } = harness;
    const insertUser = db.prepare(
      'INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at) VALUES (?,?,?,?,?,?,?)',
    );
    insertUser.run('u1', 'A@Example.org', 'a@example.org', 'hash', 'admin', 'tok1', 'now');

    expect(() =>
      insertUser.run('u2', 'a@example.org', 'a@example.org', 'hash', 'member', 'tok2', 'now'),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insertUser.run('u3', 'c@example.org', 'c@example.org', 'hash', 'wizard', 'tok3', 'now'),
    ).toThrow(/CHECK constraint failed/);

    const insertProfile = db.prepare(
      'INSERT INTO profiles (id, user_id, kind, data, updated_at) VALUES (?,?,?,?,?)',
    );
    insertProfile.run('pr1', 'u1', 'student', '{"kind":"student"}', 'now');
    expect(() => insertProfile.run('pr2', 'u1', 'student', '{"kind":"student"}', 'now')).toThrow(
      /UNIQUE constraint failed/,
    );
    // one student profile AND one org profile per user is allowed
    expect(() =>
      insertProfile.run('pr3', 'u1', 'organization', '{"kind":"organization"}', 'now'),
    ).not.toThrow();
  });

  // RESOLUTIONS R1/R2/R3. These three shapes are consumed verbatim by Plans 2
  // and 3; the statements below are the exact ones those plans run, so a
  // silent rename here fails this test instead of the first nightly crawl.
  it('accepts the ingest statements Plans 2 and 3 actually run', () => {
    harness = createTestDb();
    const { db } = harness;

    db.prepare(
      'INSERT INTO funders (id, name, homepage, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('ardc', 'ARDC', 'https://www.ardc.net/', 'now', 'now');
    db.prepare(
      'INSERT INTO sources (id, label, tier, klass) VALUES (?,?,?,?)',
    ).run('ardc-grants', 'ARDC grants page', 'B', 'ham_grant');

    // R3: no id, no body_path, body_bytes and a nullable file_path.
    const insertSnapshot = db.prepare(
      `INSERT INTO snapshots (source_id, url, status, content_type, body_sha256, body_bytes, file_path, fetched_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    );
    const info = insertSnapshot.run(
      'ardc-grants',
      'https://www.ardc.net/apply/',
      200,
      'text/html',
      'a'.repeat(64),
      4096,
      null,
      '2026-08-02T00:00:00.000Z',
    );
    expect(typeof info.lastInsertRowid).toBe('number');

    // R1: the ingest-identity columns and their partial unique index.
    const insertProgram = db.prepare(
      `INSERT INTO programs (id, funder_id, name, klass, summary, applicant_entities, amount,
         deadline, apply_via, funding_restrictions, obligations, ai_policy, trust, raw_other_text,
         tags, source_id, external_key, content_hash, status, last_verified_at, created_at, updated_at)
       VALUES (?,'ardc','X','ham_grant','s','[]','{}','{}','page_form','[]','{}','{}','{}','','[]',?,?,'h','open','now','now','now')`,
    );
    insertProgram.run('ardc-grants', 'ardc-grants', 'grants');
    expect(() => insertProgram.run('dupe', 'ardc-grants', 'grants')).toThrow(
      /UNIQUE constraint failed/,
    );
    // A different externalKey under the same source is fine...
    expect(() => insertProgram.run('other', 'ardc-grants', 'award-tables')).not.toThrow();
    // ...and the index is partial, so hand-curated rows with no source do not
    // collide with each other on (NULL, NULL).
    expect(() => insertProgram.run('manual-a', null, null)).not.toThrow();
    expect(() => insertProgram.run('manual-b', null, null)).not.toThrow();

    expect(
      db
        .prepare('SELECT id FROM programs WHERE source_id = ? AND external_key = ?')
        .get('ardc-grants', 'grants'),
    ).toEqual({ id: 'ardc-grants' });

    // R2: candidate_json, and created_at is defaulted rather than supplied.
    db.prepare(
      'INSERT INTO change_events (id, source_id, kind, detected_at) VALUES (?,?,?,?)',
    ).run('ce1', 'ardc-grants', 'deadline_changed', '2026-08-02T00:00:00.000Z');
    expect(() =>
      db
        .prepare(
          'INSERT INTO review_items (id, change_event_id, candidate_json, confidence, reject_key) VALUES (?,?,?,?,?)',
        )
        .run('ri1', 'ce1', '{"id":"ardc-grants"}', 0.8, 'ardc-grants|deadline'),
    ).not.toThrow();
    expect(
      db.prepare('SELECT candidate_json, created_at, decision FROM review_items WHERE id = ?').get('ri1'),
    ).toEqual({ candidate_json: '{"id":"ardc-grants"}', created_at: '', decision: 'pending' });
  });

  // RESOLUTIONS R24. Plan 4 ships no migration for these tables; it asserts
  // this shape with assertApplicationSchema(db) in
  // db/repositories/applications.ts, so this is the one place the two shapes
  // are actually created and therefore proven. The INSERTs below
  // are Plan 4's own statements — createApplication() in
  // db/repositories/applications.ts and Plan 4's template_instances insert —
  // column for column.
  it('stores application drafts and template instances in Plan 4 columns', () => {
    harness = createTestDb();
    const { db } = harness;

    db.prepare(
      'INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run('u1', 'a@example.org', 'a@example.org', 'hash', 'member', 'tok1', 'now');
    db.prepare(
      'INSERT INTO funders (id, name, homepage, created_at, updated_at) VALUES (?,?,?,?,?)',
    ).run('ardc', 'ARDC', 'https://www.ardc.net/', 'now', 'now');
    db.prepare(
      `INSERT INTO programs (id, funder_id, name, klass, summary, applicant_entities, amount,
         deadline, apply_via, funding_restrictions, obligations, ai_policy, trust, raw_other_text,
         tags, content_hash, status, last_verified_at, created_at, updated_at)
       VALUES ('ardc-grants','ardc','ARDC Grants Program','ham_grant','s','[]','{}','{}',
         'external_spa_portal','[]','{}','{}','{}','','[]','h','open','now','now','now')`,
    ).run();

    db.prepare(
      `INSERT INTO applications (id, user_id, program_id, title, body_markdown, answers_json,
         fact_confirmations_json, include_disclosure, facts_confirmed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', '{}', '{}', 1, NULL, ?, ?)`,
    ).run('app-1', 'u1', 'ardc-grants', 'ARDC station rebuild', 'now', 'now');
    db.prepare(
      `INSERT INTO template_instances (id, application_id, template_id, position,
         filled_markdown, unresolved_slots_json, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('ti-1', 'app-1', 'need-statement', 0, '# Need statement', '["budget_total"]', 'now');

    expect(
      db
        .prepare(
          `SELECT program_id, body_markdown, answers_json, fact_confirmations_json,
             include_disclosure, facts_confirmed_at FROM applications WHERE id = ?`,
        )
        .get('app-1'),
    ).toEqual({
      program_id: 'ardc-grants',
      body_markdown: '',
      answers_json: '{}',
      fact_confirmations_json: '{}',
      include_disclosure: 1,
      facts_confirmed_at: null,
    });
    expect(
      db
        .prepare(
          'SELECT position, filled_markdown, unresolved_slots_json FROM template_instances WHERE id = ?',
        )
        .get('ti-1'),
    ).toEqual({
      position: 0,
      filled_markdown: '# Need statement',
      unresolved_slots_json: '["budget_total"]',
    });

    // program_id is nullable: a draft exists before a programme is chosen,
    // and the defaults cover every column Plan 4 omits on that path.
    db.prepare(
      `INSERT INTO applications (id, user_id, program_id, title, created_at, updated_at)
       VALUES ('app-2','u1',NULL,'Untitled draft','now','now')`,
    ).run();
    expect(
      db.prepare('SELECT answers_json, include_disclosure FROM applications WHERE id = ?').get('app-2'),
    ).toEqual({ answers_json: '{}', include_disclosure: 1 });

    // Approving a `vanished` review item deletes the programme (R26). The
    // draft survives with a null programme rather than blocking the delete.
    db.prepare('DELETE FROM programs WHERE id = ?').run('ardc-grants');
    expect(db.prepare('SELECT program_id FROM applications WHERE id = ?').get('app-1')).toEqual({
      program_id: null,
    });

    // Deleting the owner takes the drafts and their template instances too.
    db.prepare('DELETE FROM users WHERE id = ?').run('u1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM template_instances').get()).toEqual({ n: 0 });
  });
});
