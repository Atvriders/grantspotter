import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, MIGRATIONS_DIR, openDatabase } from '../src/db/migrate.js';
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
    const stored = db
      .prepare('SELECT candidate_json, created_at, decision FROM review_items WHERE id = ?')
      .get('ri1') as { candidate_json: string; created_at: string; decision: string };
    expect(stored.candidate_json).toBe('{"id":"ardc-grants"}');
    expect(stored.decision).toBe('pending');
    // created_at is defaulted, not supplied — and the default must be a real,
    // sortable timestamp, not '', or ORDER BY created_at degenerates into a
    // tie across the whole table (see the dedicated test below).
    expect(stored.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  // The Inbox's core loop is `ORDER BY created_at` over review_items. Before
  // this fix the column defaulted to '' — a non-empty, sortable ISO timestamp
  // for an omitted column, and correct ordering across sequential inserts, is
  // exactly what that loop depends on.
  it('defaults review_items.created_at to a sortable non-empty ISO timestamp', () => {
    harness = createTestDb();
    const { db } = harness;

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
      'INSERT INTO change_events (id, source_id, kind, detected_at) VALUES (?,?,?,?)',
    ).run('ce1', 'src', 'deadline_changed', '2026-08-02T00:00:00.000Z');

    const insertReviewItem = db.prepare(
      'INSERT INTO review_items (id, change_event_id, candidate_json) VALUES (?,?,?)',
    );
    insertReviewItem.run('ri-first', 'ce1', '{}');
    insertReviewItem.run('ri-second', 'ce1', '{}');

    const rows = db
      .prepare('SELECT id, created_at FROM review_items ORDER BY created_at')
      .all() as { id: string; created_at: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.created_at).not.toBe('');
      expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    // Sequential inserts sort in insertion order rather than tying on ''.
    expect(rows.map((r) => r.id)).toEqual(['ri-first', 'ri-second']);
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

/**
 * THE ONLY DATABASE MIGRATION 094 ACTUALLY CHANGES ANYTHING ON: one that already has codes in it.
 *
 * A fresh install runs 091, 092, 093 and 094 back to back against an empty table, so the rebuild
 * copies nothing and the re-attribution matches nothing. Every claim 094 makes — that the digests
 * travel, that the uses and the expiry survive, that the compose file's rows stop naming a person
 * while an administrator's rows go on naming theirs — is a claim about an UPGRADE, and this is the
 * only place it can be tested. It is built by migrating with 094 held back, writing the rows an
 * older build would have written, and then letting it run.
 */
describe('094, on a database that already has enrollment codes', () => {
  const AT = '2026-08-01T00:00:00.000Z';
  const ENV_LABEL = 'Set in docker-compose.yml (ENROLLMENT_CODE)';
  const FAR = '2099-01-01T00:00:00.000Z';

  /** Every migration except the one under test, so `migrate()` can be asked to apply it alone. */
  function dirWithout(exclude: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'grantspotter-pre094-'));
    for (const file of readdirSync(MIGRATIONS_DIR)) {
      if (file === exclude) continue;
      copyFileSync(join(MIGRATIONS_DIR, file), join(dir, file));
    }
    return dir;
  }

  it('re-attributes the file’s code to nobody and leaves everything else exactly as it was', () => {
    const migrations = dirWithout('094-enrollment-codes-outlive-their-issuer.sql');
    // A raw database rather than `createTestDb`, which migrates all the way to HEAD in its
    // constructor and would leave nothing for 094 to do.
    const home = mkdtempSync(join(tmpdir(), 'grantspotter-mig094-'));
    const db = openDatabase(join(home, 'db.sqlite'));
    try {
      // A database at 093: the table still has the cascade, so the code from the file has to name
      // somebody, and the founding administrator is who it named.
      expect(migrate(db, migrations).applied).toContain('093-peppered-enrollment-code-digests.sql');
      expect(
        (db.pragma('foreign_key_list(enrollment_codes)') as Array<{ table: string }>).map(
          (fk) => fk.table,
        ),
      ).toEqual(['users']);

      db.prepare(
        `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
         VALUES (?, ?, ?, 'x', 'admin', ?, ?)`,
      ).run('u-founder', 'f@example.test', 'f@example.test', 'ics-f', AT);
      db.prepare(
        `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
         VALUES (?, ?, ?, 'x', 'admin', ?, ?)`,
      ).run('u-officer', 'o@example.test', 'o@example.test', 'ics-o', AT);
      for (const [id, label, issuer] of [
        ['c-env', ENV_LABEL, 'u-founder'],
        // Same label, differently cased and padded — `isEnvCodeLabel` folds it and so must the
        // migration, or a row the boot treats as the file's would keep naming a person.
        ['c-env-folded', `  ${ENV_LABEL.toUpperCase()} `, 'u-founder'],
        ['c-app', 'W1MX autumn 2026 intake', 'u-officer'],
      ] as const) {
        db.prepare(
          `INSERT INTO enrollment_codes
             (id, code_hash, hash_scheme, label, chosen, max_uses, uses, expires_at, revoked_at,
              created_at, created_by_user_id, last_used_at)
           VALUES (?, ?, 'hmac-sha256', ?, 1, 30, 29, ?, NULL, ?, ?, ?)`,
        ).run(id, `digest-of-${id}`, label, FAR, AT, issuer, AT);
      }

      const applied = migrate(db).applied;
      expect(applied).toEqual(['094-enrollment-codes-outlive-their-issuer.sql']);

      const rows = db
        .prepare(
          `SELECT id, code_hash, hash_scheme, uses, max_uses, expires_at, revoked_at, chosen,
                  created_by_user_id AS issuer
             FROM enrollment_codes ORDER BY id`,
        )
        .all() as Array<Record<string, unknown>>;
      // Nothing was lost in the rebuild — not a row, not a digest, not a use, not an expiry.
      expect(rows).toEqual([
        { id: 'c-app', code_hash: 'digest-of-c-app', hash_scheme: 'hmac-sha256', uses: 29,
          max_uses: 30, expires_at: FAR, revoked_at: null, chosen: 1, issuer: 'u-officer' },
        { id: 'c-env', code_hash: 'digest-of-c-env', hash_scheme: 'hmac-sha256', uses: 29,
          max_uses: 30, expires_at: FAR, revoked_at: null, chosen: 1, issuer: null },
        { id: 'c-env-folded', code_hash: 'digest-of-c-env-folded', hash_scheme: 'hmac-sha256',
          uses: 29, max_uses: 30, expires_at: FAR, revoked_at: null, chosen: 1, issuer: null },
      ]);

      // The key is gone and the column takes NULL, which is what the two nulls above depend on.
      expect(db.pragma('foreign_key_list(enrollment_codes)')).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      // Deleting the founding administrator is now a no-op for the file's rows — it used to delete
      // them, whereupon the next boot reissued that code with a fresh expiry and its uses at zero —
      // and withdraws the officer's, without touching the intake record it carries.
      db.prepare('DELETE FROM users WHERE id = ?').run('u-founder');
      db.prepare('DELETE FROM users WHERE id = ?').run('u-officer');
      expect(
        db.prepare('SELECT id, uses, revoked_at FROM enrollment_codes ORDER BY id').all(),
      ).toEqual([
        { id: 'c-app', uses: 29, revoked_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/) },
        { id: 'c-env', uses: 29, revoked_at: null },
        { id: 'c-env-folded', uses: 29, revoked_at: null },
      ]);
    } finally {
      db.close();
      rmSync(migrations, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
