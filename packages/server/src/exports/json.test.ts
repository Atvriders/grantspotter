import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import type { Funder, Program } from '@grantspotter/core';
import { migrate } from '../db/migrate.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { isDoNotPublish } from '../normalize/index.js';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  DERIVED_TABLES,
  NEVER_BACKED_UP_TABLES,
  exportBackup,
  restoreBackup,
} from './json.js';
import { loadExportCorpus } from './testCorpus.js';

/**
 * The brief's toy schema. It exists to prove the module is SCHEMA-AGNOSTIC — it discovers tables
 * from `sqlite_master` and columns from `PRAGMA table_info`, so it neither knows nor cares what
 * shape the real database has. The round-trip suite at the bottom of this file proves the other
 * half: that against the REAL migrated schema and the REAL corpus, nothing is lost and nothing
 * changes side of the suppression boundary.
 */
function makeToyDb(): Db {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE funders (id TEXT PRIMARY KEY, name TEXT NOT NULL, homepage TEXT);
    CREATE TABLE programs (id TEXT PRIMARY KEY, funder_id TEXT NOT NULL, name TEXT, amount TEXT, blob_col BLOB);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE not_in_contract (id TEXT PRIMARY KEY);
  `);
  db.prepare('INSERT INTO funders VALUES (?,?,?)').run(
    'ardc',
    'Amateur Radio Digital Communications',
    'https://www.ardc.net/',
  );
  db.prepare('INSERT INTO programs VALUES (?,?,?,?,?)').run(
    'ardc-grants',
    'ardc',
    'ARDC Grants Program',
    '{"instrument":"cash_range"}',
    Buffer.from([1, 2, 3]),
  );
  db.prepare('INSERT INTO sessions VALUES (?,?)').run('sess-1', 'user-1');
  db.prepare('INSERT INTO not_in_contract VALUES (?)').run('x');
  return db;
}

describe('exportBackup', () => {
  let db: Db;
  beforeEach(() => {
    db = makeToyDb();
  });

  it('stamps the app name, format version and export time', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    expect(backup.app).toBe('grantspotter');
    expect(backup.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(backup.exportedAt).toBe('2026-08-02T12:00:00.000Z');
  });

  it('dumps every contract table that exists and skips ones that do not', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    expect(Object.keys(backup.tables).sort()).toEqual(['funders', 'programs']);
    expect(backup.tables.funders).toHaveLength(1);
    expect(backup.tables.funders[0]).toMatchObject({ id: 'ardc' });
  });

  it('never exports sessions, and never exports a table outside the backup list', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    expect(backup.tables.sessions).toBeUndefined();
    expect(backup.tables.not_in_contract).toBeUndefined();
  });

  it('encodes BLOB columns as base64 envelopes so JSON round-trips them', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    expect(backup.tables.programs[0].blob_col).toEqual({ $b64: 'AQID' });
  });

  it('survives a JSON round trip', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    expect(() => JSON.parse(JSON.stringify(backup))).not.toThrow();
  });
});

describe('restoreBackup', () => {
  let db: Db;
  beforeEach(() => {
    db = makeToyDb();
  });

  it('replaces existing rows and reports what it restored', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    backup.tables.funders = [
      {
        id: 'arrl-foundation',
        name: 'ARRL Foundation',
        homepage: 'https://www.arrl.org/arrl-foundation',
      },
    ];
    const result = restoreBackup(db, JSON.parse(JSON.stringify(backup)));
    expect(result.tablesRestored).toEqual(['funders', 'programs']);
    expect(result.rowsRestored).toBe(2);
    const rows = db.prepare('SELECT id FROM funders').all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['arrl-foundation']);
  });

  it('decodes base64 envelopes back into buffers', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    restoreBackup(db, JSON.parse(JSON.stringify(backup)));
    const row = db.prepare('SELECT blob_col FROM programs').get() as { blob_col: Buffer };
    expect(Buffer.from(row.blob_col).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('ignores columns in the file that no longer exist in the schema', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    backup.tables.funders[0].removed_column = 'gone';
    expect(() => restoreBackup(db, JSON.parse(JSON.stringify(backup)))).not.toThrow();
  });

  it('rejects a file with the wrong app marker or an unknown format version', () => {
    expect(() =>
      restoreBackup(db, { app: 'other', formatVersion: 1, exportedAt: '', tables: {} }),
    ).toThrow(/not a GrantSpotter backup/);
    expect(() =>
      restoreBackup(db, { app: 'grantspotter', formatVersion: 99, exportedAt: '', tables: {} }),
    ).toThrow(/format version 99/);
  });

  it('refuses a file naming a table outside the backup list', () => {
    expect(() =>
      restoreBackup(db, {
        app: 'grantspotter',
        formatVersion: 1,
        exportedAt: '',
        tables: { evil: [{ id: 'x' }] },
      }),
    ).toThrow(/unknown table "evil"/);
  });

  it('refuses a file naming a DERIVED table, which a restore must rebuild and never import', () => {
    expect(() =>
      restoreBackup(db, {
        app: 'grantspotter',
        formatVersion: 1,
        exportedAt: '',
        tables: { program_search: [{ program_id: 'x' }] },
      }),
    ).toThrow(/unknown table "program_search"/);
  });

  it('leaves the database untouched when one table fails mid-restore', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM funders').get() as { n: number };
    expect(() =>
      restoreBackup(db, {
        app: 'grantspotter',
        formatVersion: 1,
        exportedAt: '',
        tables: {
          funders: [{ id: 'ok', name: 'ok', homepage: 'x' }],
          programs: [{ id: null, funder_id: null }],
        },
      }),
    ).toThrow();
    const after = db.prepare('SELECT COUNT(*) AS n FROM funders').get() as { n: number };
    expect(after.n).toBe(before.n);
  });

  it('reports that it could NOT reindex when the browse projection is not in this schema', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    const result = restoreBackup(db, JSON.parse(JSON.stringify(backup)));
    // `null`, never `0`. "Rebuilt nothing" and "could not rebuild" are different sentences and the
    // admin console is about to print one of them.
    expect(result.programsReindexed).toBeNull();
  });

  it('restores in the canonical parent-before-child order whatever order the file names', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    const shuffled = {
      app: 'grantspotter' as const,
      formatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: backup.exportedAt,
      tables: { programs: backup.tables.programs, funders: backup.tables.funders },
    };
    const result = restoreBackup(db, JSON.parse(JSON.stringify(shuffled)));
    expect(result.tablesRestored).toEqual(['funders', 'programs']);
  });
});

/**
 * THE TABLE CENSUS.
 *
 * `BACKUP_TABLES` is a hand-written list, and a hand-written list of tables goes stale the moment
 * someone adds a migration. When it does, the failure is silent and total: the new table's rows
 * are simply absent from every backup taken from that day on, and nobody finds out until a
 * restore. So every table a freshly migrated database actually has must be classified as one of
 * three things — backed up, derived (rebuilt on restore), or deliberately never backed up — and a
 * fourth kind fails here, by name.
 */
describe('every table in a migrated database is classified', () => {
  it('names no table this module has never heard of', () => {
    const db = new Database(':memory:');
    migrate(db);
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    db.close();

    const classified = new Set<string>([
      ...BACKUP_TABLES,
      ...DERIVED_TABLES,
      ...NEVER_BACKED_UP_TABLES,
    ]);
    expect(tables.filter((t) => !classified.has(t))).toEqual([]);
  });

  it('keeps sessions out of the backup list, and the browse projection out of it too', () => {
    const backed = new Set<string>(BACKUP_TABLES);
    expect(backed.has('sessions')).toBe(false);
    expect(backed.has('schema_migrations')).toBe(false);
    for (const derived of DERIVED_TABLES) expect(backed.has(derived)).toBe(false);
  });
});

// --------------------------------------------------------------- the round trip

const NOW = '2026-08-02T12:00:00.000Z';

/**
 * A genuinely empty migrated database, foreign keys ON — the state a restore actually lands in.
 * `openDatabase` is not used because it takes a file path and turns on WAL; the pragma that
 * matters here is `foreign_keys`, and having it ON is the whole point: the brief's restore turned
 * it off inside a transaction, where SQLite silently ignores the pragma.
 */
function emptyMigratedDb(): Db {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function fundersFor(programs: Program[]): Funder[] {
  return [...new Set(programs.map((p) => p.funderId))].map((id) => ({
    id,
    name: `Funder ${id}`,
    homepage: 'https://example.com/',
  }));
}

/**
 * User rows, and the reason this fixture is written the way it is. A full backup carries `users`
 * and `profiles`, which is exactly why the route is admin-only — and this repo has already had to
 * strip 490 real e-mail addresses and phone numbers out of captured fixtures before they reached a
 * public repository. A backup fixture is the easiest possible way to put them back. Everything
 * here is `example.com` and RFC 5737; the assertion below holds the line for anyone who edits it.
 */
function seedAccounts(db: Db): void {
  const user = db.prepare(
    `INSERT INTO users (id, email, email_normalized, password_hash, role, display_name, ics_token,
                        disabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  );
  user.run('u-admin', 'admin@example.com', 'admin@example.com', 'x', 'admin', 'Admin', 'ics-1', NOW);
  user.run(
    'u-member',
    'member@example.com',
    'member@example.com',
    'x',
    'member',
    'Member',
    'ics-2',
    NOW,
  );
  db.prepare(
    'INSERT INTO profiles (id, user_id, kind, data, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    'prof-1',
    'u-member',
    'student',
    JSON.stringify({ kind: 'student', callsign: 'K5EXAMPLE', state: 'TX' }),
    NOW,
  );
  db.prepare(
    `INSERT INTO notification_channels (user_id, in_app, webhook_url, updated_at)
     VALUES (?, 1, ?, ?)`,
  ).run('u-member', 'https://192.0.2.10/hooks/grantspotter', NOW);
  // A LIVE SESSION, on purpose: the assertion is that this is the one thing a backup drops.
  db.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run('sess-hash', 'u-admin', NOW, '2026-09-02T12:00:00.000Z', NOW, 'test');
}

function suppressionCensus(db: Db): { publishable: number; suppressed: number } {
  const all = createProgramRepo(db).list();
  return {
    publishable: all.filter((p) => !isDoNotPublish(p)).length,
    suppressed: all.filter((p) => isDoNotPublish(p)).length,
  };
}

describe('a full backup round trip through an empty migrated database, on the real corpus', () => {
  let source: Db;
  let target: Db;
  let backup: ReturnType<typeof exportBackup>;
  let before: { publishable: number; suppressed: number };
  let restored: ReturnType<typeof restoreBackup>;

  beforeEach(async () => {
    const corpus = await loadExportCorpus();
    const all = [...corpus.programs, ...corpus.suppressedPrograms];

    source = emptyMigratedDb();
    const funders = createFunderRepo(source);
    for (const f of fundersFor(all)) funders.upsert(f);
    const programs = createProgramRepo(source);
    for (const p of all) programs.upsert(p);
    seedAccounts(source);
    before = suppressionCensus(source);

    backup = exportBackup(source, NOW);
    target = emptyMigratedDb();
    restored = restoreBackup(target, JSON.parse(JSON.stringify(backup)), NOW);
  });

  it('starts from the corpus this project actually has: 150 publishable, 553 suppressed', () => {
    expect(before).toEqual({ publishable: 150, suppressed: 553 });
  });

  it('BACKS UP THE SUPPRESSED RECORDS — the one place isDoNotPublish must not filter', () => {
    // 553 past ARDC/NSF/USAspending awards and 37 already-funded ARRL clubs. They are real data an
    // admin is entitled to, and losing them on restore is data loss. Every other export gates them
    // out through `exportablePrograms`; this file is the documented exception.
    expect(backup.tables.programs).toHaveLength(703);
  });

  it('lands all 703 in an empty database, with suppression preserved exactly', () => {
    const after = suppressionCensus(target);
    expect(after).toEqual({ publishable: 150, suppressed: 553 });
    expect(after).toEqual(before);
  });

  it('never lets a suppressed record cross the boundary and come back publishable', () => {
    const suppressedBefore = new Set(
      createProgramRepo(source)
        .list()
        .filter((p) => isDoNotPublish(p))
        .map((p) => p.id),
    );
    const suppressedAfter = new Set(
      createProgramRepo(target)
        .list()
        .filter((p) => isDoNotPublish(p))
        .map((p) => p.id),
    );
    expect([...suppressedAfter].sort()).toEqual([...suppressedBefore].sort());
  });

  it('carries the constraints with the programs, so a restored record still matches', () => {
    const countIn = (db: Db): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM constraints').get() as { n: number }).n;
    expect(countIn(target)).toBe(countIn(source));
    expect(countIn(target)).toBeGreaterThan(0);
  });

  it('REBUILDS THE BROWSE INDEX, so the restore does not leave stale filters behind', () => {
    expect(restored.programsReindexed).toBe(150);
    const projected = (
      target.prepare('SELECT COUNT(*) AS n FROM program_search').get() as { n: number }
    ).n;
    // 150, not 703: the projection is a browse surface and honours suppression, exactly as it
    // does after a nightly crawl.
    expect(projected).toBe(150);
  });

  it('carries user rows, profiles and channel config, and drops live sessions', () => {
    expect(backup.tables.users).toHaveLength(2);
    expect(backup.tables.profiles).toHaveLength(1);
    expect(backup.tables.notification_channels).toHaveLength(1);
    expect(backup.tables.sessions).toBeUndefined();
    const sessions = (
      target.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }
    ).n;
    expect(sessions).toBe(0);
    const users = (target.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
    expect(users).toBe(2);
  });

  it('holds the redaction line: every address in the backup fixture is example.com', () => {
    const emails = (backup.tables.users as Array<{ email: string }>).map((u) => u.email);
    expect(emails.every((e) => e.endsWith('@example.com'))).toBe(true);
    const hooks = (
      backup.tables.notification_channels as Array<{ webhook_url: string | null }>
    ).map((c) => c.webhook_url ?? '');
    // RFC 5737 documentation range, never a real LAN address.
    expect(hooks.every((h) => h === '' || /^https:\/\/(192\.0\.2|198\.51\.100|203\.0\.113)\./.test(h))).toBe(
      true,
    );
  });

  it('reports what it wrote', () => {
    expect(restored.rowsRestored).toBe(
      Object.values(backup.tables).reduce((n, rows) => n + rows.length, 0),
    );
    expect(restored.rowsSkipped).toBe(0);
    expect(restored.tablesRestored).toContain('programs');
    expect(restored.tablesRestored).toContain('users');
    expect(restored.tablesSkipped).toEqual([]);
  });

  it('produces a referentially sound database — foreign keys were never actually disabled', () => {
    const violations = target.pragma('foreign_key_check') as unknown[];
    expect(violations).toEqual([]);
  });
});

/**
 * WHAT A BACKUP CARRIES FROM A FEATURE THAT NO LONGER EXISTS, AND WHY THIS BLOCK IS NOW ABOUT
 * COMPATIBILITY RATHER THAN ABOUT SECRECY.
 *
 * WHAT WAS HERE. Four tests about `enrollment_codes` in a backup file: that a reader without
 * `SESSION_SECRET` could not get a code back out of its digest, that a restore returned a club
 * mid-intake to a working code, that restoring onto a host with a different secret brought the
 * records back and not the codes, and that a pre-093 file's unkeyed digest still redeemed. Each was
 * true and each was worth holding: the digest had once been an unsalted SHA-256, and
 * `W1MX-AUTUMN-2026` came back out of one on this host in 32.4 s and 11,334,277 dictionary
 * candidates.
 *
 * ALL FOUR ARE ABOUT REDEEMING A CODE, AND NOTHING REDEEMS A CODE. Enrolment is retired (migration
 * 095). A digest in a backup is now a MAC of a string that opens nothing, whether the reader holds
 * the key or not, so the question those tests answered has stopped being a question.
 *
 * WHAT REPLACED THEM IS THE HALF THAT STILL BINDS, AND IT IS THE REASON THE TABLE WAS NOT DROPPED.
 * `restoreBackup` REFUSES outright any file naming a table that is not in `BACKUP_TABLES`, so
 * dropping `enrollment_codes` would have made every backup any shipped build has written
 * unrestorable — an operator's disaster-recovery file turned into a hard error by an upgrade that
 * removed a feature they were not using. Keeping the table keeps the list true and keeps those
 * files working, and these two tests are what say so out loud.
 */
describe('a backup written before enrolment was retired still restores', () => {
  const CHOSEN = 'W1MX-AUTUMN-2026';

  /** A row of the shape the retired feature left behind, written with SQL because there is no
   * repository any more — which is the state an upgrading operator's database is in. */
  function seedRetiredCode(db: Db): void {
    db.prepare(
      `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
       VALUES ('u-admin', 'admin@example.com', 'admin@example.com', 'x', 'admin', 'ics-1', ?)`,
    ).run(NOW);
    db.prepare(
      `INSERT INTO enrollment_codes
         (id, code_hash, label, max_uses, uses, expires_at, revoked_at, created_at,
          created_by_user_id, last_used_at, chosen, hash_scheme)
       VALUES ('c-intake', 'a-keyed-digest-stands-in-here', 'W1MX autumn 2026 intake', 30, 7,
               '2027-08-02T12:00:00.000Z', NULL, ?, 'u-admin', ?, 1, 'hmac-sha256')`,
    ).run(NOW, NOW);
  }

  it('round-trips every column of the closed record, rather than refusing the file', () => {
    const source = emptyMigratedDb();
    seedRetiredCode(source);
    const file = JSON.parse(JSON.stringify(exportBackup(source, NOW))) as unknown;
    source.close();

    const target = emptyMigratedDb();
    // The assertion that carries the whole decision: this must not throw. `restoreBackup` answers
    // `Backup names unknown table "enrollment_codes"; refusing to restore` for a table it does not
    // know, and that is what dropping the table would have done to this file.
    const result = restoreBackup(target, file, NOW);
    expect(result.tablesRestored).toContain('enrollment_codes');
    expect(result.tablesSkipped).toEqual([]);

    // Everything an officer would ask about a past intake, back as it was.
    expect(
      target
        .prepare(
          `SELECT label, uses, max_uses, expires_at, revoked_at, created_by_user_id, chosen
             FROM enrollment_codes WHERE id = 'c-intake'`,
        )
        .get(),
    ).toEqual({
      label: 'W1MX autumn 2026 intake',
      uses: 7,
      max_uses: 30,
      expires_at: '2027-08-02T12:00:00.000Z',
      revoked_at: null,
      created_by_user_id: 'u-admin',
      chosen: 1,
    });
    target.close();
  });

  /**
   * THE ONE SECRECY CLAIM THAT OUTLIVES THE FEATURE. Nothing can redeem a code, so the digest opens
   * nothing — but a backup must still never contain a string that LOOKS like a live credential,
   * because the person who finds the file cannot tell that the feature is gone and will treat what
   * they find as one. `code_hash` was never the plaintext and must not become it.
   */
  it('still carries no plaintext code, in any spelling of one', () => {
    const source = emptyMigratedDb();
    seedRetiredCode(source);
    const file = JSON.stringify(exportBackup(source, NOW));
    source.close();
    expect(file).not.toContain(CHOSEN);
    expect(file).not.toContain('W1MXATMN2026');
  });
});
