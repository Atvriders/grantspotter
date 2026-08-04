/**
 * THE ONLY INTEGRATION SEAM IN PLAN 5, tested against a REAL migrated database.
 *
 * Every other file in this plan — and every other test in it — works against the `ExportDataSource`
 * interface and a fake. That is deliberate and it is also the whole risk: a fake can be perfectly
 * satisfied by an implementation that names a column no migration ever created. So this suite runs
 * the real SQLite implementation against `openTestDb()`, which is the same migration runner
 * production boots with, and asserts the four things a fake cannot see:
 *
 *   1. the suppression gate is inside the data source as well as inside the routes;
 *   2. the token table's two access paths are the two the migration's index decision assumed;
 *   3. deleting a user REVOKES THEIR FEED, through the foreign key rather than through a route;
 *   4. cycles come from BOTH of core's channels, not just the projected one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import type { Program } from '@grantspotter/core';
import { expandCycles, observedCycles } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { seedTestUser } from '../test/fixtures/programs.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo, withContentHash } from '../db/repositories/programs.js';
import { createProfileRepo } from '../db/repositories/profiles.js';
import { createSqliteExportDataSource, type ExportDataSource } from './dataSource.js';
import { hashIcsToken, newIcsToken } from './token.js';
import { makeFunder, makeProgram, makeSuppressedProgram } from './testFixtures.js';

const FROM = '2026-08-01';
const TO = '2028-08-01';
const NOW = '2026-08-02T12:00:00.000Z';

/**
 * A programme carrying a real `RECUR` directive, which is the ONLY thing `parseRecurrence` reads.
 * `makeProgram()`'s default note is human prose ("February 1, April 1, …") and projects nothing —
 * so without this record the projected half of the two-channel assertion below would be vacuous.
 */
const PROJECTED: Program = makeProgram({
  deadline: {
    kind: 'n_fixed_dates',
    source: { kind: 'self' },
    note:
      'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | ' +
      'February 1, April 1, July 1, September 1.',
  },
});

/**
 * A programme whose note carries a window the funder actually PRINTED. `observedCycles` reads it
 * and marks the cycle `isEstimated: false`; `expandCycles` produces nothing for it. Its presence
 * is what makes the observed half of the same assertion non-vacuous.
 */
const OBSERVED: Program = makeProgram({
  id: 'ariss-proposal-window',
  name: 'ARISS Contact Proposal Window',
  deadline: {
    kind: 'annual_window',
    source: { kind: 'self' },
    note: 'published by the funder: opens 2027-02-01, closes 2027-03-31',
  },
});

let db: Database.Database;
let source: ExportDataSource;

beforeAll(() => {
  db = openTestDb();
  createFunderRepo(db).upsert(makeFunder());
  const programs = createProgramRepo(db);
  programs.upsert(withContentHash(PROJECTED));
  programs.upsert(withContentHash(OBSERVED));
  programs.upsert(withContentHash(makeSuppressedProgram()));

  seedTestUser(db, 'u-member');
  seedTestUser(db, 'u-other');
  createProfileRepo(db).upsert('u-member', {
    kind: 'student',
    callsign: 'W8UM',
    licenseClass: 'GENERAL',
  });
  db.prepare(
    `INSERT INTO watches (id, user_id, program_id, notify_changes, created_at)
     VALUES ('w-1', 'u-member', 'ardc-grants', 1, ?)`,
  ).run(NOW);

  source = createSqliteExportDataSource(db);
});

afterAll(() => {
  db.close();
});

describe('the SQLite export data source reads what the repositories read', () => {
  /**
   * THE FIFTH LEAK, PRE-EMPTED. `listPrograms` is the only read the ICS routes have — they do not
   * go through `applyExportFilter` the way the CSV and XLSX routes do — so a data source that
   * handed back everything would put the whole hazard on one filter in one route handler. The gate
   * is here too, and it is the SHARED `isDoNotPublish` via `exportablePrograms`, never a local copy.
   */
  it('never returns a suppressed record, though the row is really in the table', () => {
    const stored = (db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n;
    expect(stored).toBe(3);
    const ids = source.listPrograms().map((p) => p.id);
    expect(ids).toEqual(['ardc-grants', 'ariss-proposal-window']);
    expect(ids).not.toContain('ardc-2019-award-11225');
  });

  it('returns funders through the funder repository', () => {
    expect(source.listFunders().map((f) => f.id)).toEqual(['ardc']);
  });

  it('returns the first profile a user saved', () => {
    expect(source.getProfile('u-member')?.kind).toBe('student');
    expect(source.getProfile('u-other')).toBeUndefined();
  });

  it('returns the watchlist through Plan 3’s own query', () => {
    expect(source.listWatchedProgramIds('u-member')).toEqual(['ardc-grants']);
    expect(source.listWatchedProgramIds('u-other')).toEqual([]);
  });

  /**
   * BOTH CHANNELS, which is a DEVIATION FROM THE TASK BRIEF and the same one Plan 3 already made
   * and wrote down. The brief's `listCycles` is `expandCycles` alone. `expandCycles` repeats a
   * recurrence rule forwards and marks every row `isEstimated: true`; `observedCycles` records the
   * single window a funder actually PRINTED. Against the real corpus at 2026-08-02, `expandCycles`
   * alone omits all four funder-published windows (ARISS, Yaesu and two federal NOFOs) — so the
   * one calendar in this product whose entire purpose is to distinguish "the funder said so" from
   * "we projected it" would have carried only the projections. `api/calendarRouter.ts`'s `cyclesFor`
   * says so in its own header; this is the same fix in the export seam.
   */
  it('projects both of core’s cycle channels, so a funder-published window survives', () => {
    const cycles = source.listCycles(FROM, TO);
    const observed = cycles.filter((c) => !c.isEstimated);
    expect(observed.map((c) => c.programId)).toEqual(['ariss-proposal-window']);
    expect(observed[0].closesAt?.slice(0, 10)).toBe('2027-03-31');
    expect(cycles.some((c) => c.isEstimated)).toBe(true);

    const publishable = source.listPrograms();
    const expected = publishable.flatMap((p) => [
      ...expandCycles(p, publishable, FROM, TO),
      ...observedCycles(p, publishable, FROM, TO),
    ]);
    expect(cycles).toEqual(expected);
  });

  it('projects no cycle for a suppressed programme, because it never sees one', () => {
    expect(source.listCycles(FROM, TO).map((c) => c.programId)).not.toContain(
      'ardc-2019-award-11225',
    );
  });
});

describe('ics_tokens, through the seam', () => {
  it('stores only the hash, and resolves a token back to its owner', () => {
    const token = newIcsToken();
    source.upsertToken('u-member', hashIcsToken(token), NOW);

    const row = db.prepare('SELECT * FROM ics_tokens WHERE user_id = ?').get('u-member') as {
      token_hash: string;
      created_at: string;
      revoked_at: string | null;
    };
    expect(row.token_hash).toBe(hashIcsToken(token));
    expect(row.token_hash).not.toBe(token);
    expect(row.created_at).toBe(NOW);
    expect(row.revoked_at).toBeNull();

    expect(source.getUserIdForTokenHash(hashIcsToken(token))).toBe('u-member');
    expect(source.getTokenHash('u-member')).toBe(hashIcsToken(token));
  });

  it('rotates in place: one row per user, and the old hash stops resolving', () => {
    const first = newIcsToken();
    const second = newIcsToken();
    source.upsertToken('u-member', hashIcsToken(first), NOW);
    source.upsertToken('u-member', hashIcsToken(second), NOW);

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM ics_tokens WHERE user_id = ?').get('u-member') as {
        n: number;
      }).n,
    ).toBe(1);
    expect(source.getUserIdForTokenHash(hashIcsToken(first))).toBeUndefined();
    expect(source.getUserIdForTokenHash(hashIcsToken(second))).toBe('u-member');
  });

  it('revokes without deleting, and a revoked hash resolves to nobody', () => {
    const token = newIcsToken();
    source.upsertToken('u-member', hashIcsToken(token), NOW);
    source.revokeToken('u-member', '2026-08-03T00:00:00.000Z');

    expect(source.getUserIdForTokenHash(hashIcsToken(token))).toBeUndefined();
    expect(source.getTokenHash('u-member')).toBeUndefined();
    expect(
      db.prepare('SELECT revoked_at FROM ics_tokens WHERE user_id = ?').get('u-member'),
    ).toEqual({ revoked_at: '2026-08-03T00:00:00.000Z' });

    // …and creating again clears the revocation rather than leaving a dead row in the way.
    const fresh = newIcsToken();
    source.upsertToken('u-member', hashIcsToken(fresh), NOW);
    expect(source.getUserIdForTokenHash(hashIcsToken(fresh))).toBe('u-member');
  });

  /**
   * THE MUST-DO, PROVEN AT THE ROW.
   *
   * `api/adminUsersRouter.ts` deletes an account with one `DELETE FROM users` and relies on the
   * cascade; Plan 3 Task 13's report claims "the ICS token dies with the row". The brief for THIS
   * task specified `ics_tokens` with no foreign key at all, which would have made that claim false
   * and left a removed member's calendar client fetching the organisation's corpus forever.
   * `test/userCascade.test.ts` guards the schema; this guards the behaviour a user would feel.
   */
  it('lets a deleted user take their feed with them', () => {
    seedTestUser(db, 'u-doomed');
    const token = newIcsToken();
    source.upsertToken('u-doomed', hashIcsToken(token), NOW);
    expect(source.getUserIdForTokenHash(hashIcsToken(token))).toBe('u-doomed');

    db.prepare('DELETE FROM users WHERE id = ?').run('u-doomed');

    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM ics_tokens WHERE user_id = ?').get('u-doomed') as {
        n: number;
      }).n,
      'the token row outlived its user — the cascade did not fire',
    ).toBe(0);
    expect(source.getUserIdForTokenHash(hashIcsToken(token))).toBeUndefined();
  });

  it('refuses a token for a user that does not exist', () => {
    expect(() => source.upsertToken('u-ghost', hashIcsToken(newIcsToken()), NOW)).toThrow(
      /FOREIGN KEY/i,
    );
  });

  /**
   * The migration's index decision, pinned. `090-ics-tokens.sql` deliberately omits the brief's
   * `idx_ics_tokens_hash` because `UNIQUE (token_hash)` and `PRIMARY KEY (user_id)` already index
   * both reads. If a future read stops being covered by an autoindex, this fails rather than
   * quietly doing a table scan on every calendar fetch.
   */
  it('serves both of its reads from an index, with no table scan', () => {
    const plan = (sql: string): string =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(' | ');

    expect(
      plan("SELECT user_id FROM ics_tokens WHERE token_hash = 'x' AND revoked_at IS NULL"),
    ).toContain('USING INDEX sqlite_autoindex_ics_tokens_2 (token_hash=?)');
    expect(
      plan("SELECT token_hash FROM ics_tokens WHERE user_id = 'x' AND revoked_at IS NULL"),
    ).toContain('USING INDEX sqlite_autoindex_ics_tokens_1 (user_id=?)');
    expect(
      (db.prepare('PRAGMA index_list(ics_tokens)').all() as Array<{ name: string }>).map(
        (r) => r.name,
      ),
    ).not.toContain('idx_ics_tokens_hash');
  });

  it('hands the same handle back through rawDb, so the backup route reads everything', () => {
    expect(source.rawDb()).toBe(db);
    // The suppressed record `listPrograms` hides is still there for a backup to take.
    expect(
      source
        .rawDb()
        .prepare('SELECT COUNT(*) AS n FROM programs')
        .get(),
    ).toEqual({ n: 3 });
  });
});
