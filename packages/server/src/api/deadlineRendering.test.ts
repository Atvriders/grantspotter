import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { Program } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { ardcGrants, seedFixtureCorpus, seedTestUser } from '../test/fixtures/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { RECURRENCE_BY_SOURCE } from '../normalize/deadline.js';
import { reindexBrowse } from './reindex.js';
import { hydratePrograms } from './browseQuery.js';
import { createProgramsRouter } from './programsRouter.js';
import { createWatchRouter } from './watchRouter.js';
import { createCalendarRouter } from './calendarRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';
// THE ONE CROSS-PACKAGE IMPORT IN THE SERVER SUITE, AND THE REASON FOR IT.
//
// This file exists to assert the RENDERED CALENDAR DAY, not the stored instant. Those are two
// different claims, and the whole defect lived in the gap between them: the projection held a
// perfectly correct `2027-03-01T04:59:00.000Z` and the screen printed the wrong day, because the
// frame that instant is expressed in never reached the renderer. A server-side test that stopped
// at the instant would have passed happily for the entire life of the bug — every existing
// assertion on `next_closes_at` did.
//
// So the real renderer is imported rather than reimplemented. `formatDate` is the single helper
// every deadline in this product is formatted through (`packages/web/src/lib/trust.ts`, no
// dependencies but `Intl`), and a private copy of it here would be a second definition of the
// answer — free to agree with this test while disagreeing with the screen, which is exactly the
// class of drift this repo keeps closing. There is precedent for reaching across a package to
// test the thing that actually runs: `scripts/profile-corpus.test.ts` imports from both
// `packages/core` and `packages/server` for the same reason.
import { formatDate } from '../../../web/src/lib/trust.js';

/**
 * DEADLINE RENDERING, END TO END: `cycles` -> reindex -> `program_search` -> browse query ->
 * `BrowseRow` -> `GET /api/programs` -> the funder's own calendar day.
 *
 * THE DEFECT. A deadline is stored as the UTC instant of a LOCAL wall time. Core's
 * `zonedWallTimeToUtcISO` with `DEFAULT_CLOSE_TIME` 23:59 turns the ARRL Amateur Radio Grants
 * "Feb 1-28, 2027 window" (`tz=America/New_York`) into `2027-03-01T04:59:00.000Z`. That instant
 * IS the 28th of February to the funder who published it. Rendered without the zone it prints
 * **2027-03-01**.
 *
 * One day LATE is the dangerous direction. It does not merely misinform — it tells an applicant
 * they have a day they do not have, which is the single failure this product exists to prevent.
 *
 * Task 16 fixed `formatDate` and proved it renders the funder's day WHEN GIVEN THE ZONE, then
 * reported that browse and the watchlist could not be fixed at the component level, because
 * `program_search.next_closes_at` and `BrowseRow` carried no zone to give it. Migration 037 adds
 * `program_search.next_timezone` and every hop between now carries it. These tests are the join:
 * each one asserts the exact string a user reads, and pins the wrong day beside the right one so
 * a regression cannot be mistaken for a formatting preference.
 */

const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database, nowISO: string) {
  const deps: RouterDeps = {
    db,
    now: () => nowISO,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(new AppError('forbidden', 'Admin role required.')),
    currentUser: () => MEMBER,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/programs', createProgramsRouter(deps));
  app.use('/api/watchlist', createWatchRouter(deps));
  app.use('/api/calendar', createCalendarRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

/**
 * The ARRL Amateur Radio Grants programme, carrying THE PRODUCTION RECURRENCE DIRECTIVE.
 *
 * `RECURRENCE_BY_SOURCE` is imported from `normalize/deadline.ts`, not transcribed. It is the
 * table the real crawl writes into `deadline.note` for this source, so the windows under test
 * are the windows the corpus actually holds; a copied string here could keep passing after the
 * real directive changed underneath it.
 */
function arrlGrants(): Program {
  return {
    ...ardcGrants,
    id: 'arrl-amateur-radio-grants',
    name: 'ARRL Amateur Radio Grants',
    deadline: {
      kind: 'n_fixed_windows',
      source: { kind: 'self' },
      note: RECURRENCE_BY_SOURCE['arrl-amateur-radio-grants'] ?? '',
    },
  };
}

describe('the ARRL February window renders as the 28th, not the 1st of March', () => {
  // After the October 2026 window has closed, so the February 2027 window is the NEXT cycle and
  // therefore the one the browse projection carries.
  const NOW = '2026-11-02T12:00:00.000Z';
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    seedTestUser(db, MEMBER.id);
    createProgramRepo(db).upsert(arrlGrants());
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('projects the instant AND the zone it is a wall time in', () => {
    const row = db
      .prepare('SELECT next_closes_at, next_timezone FROM program_search WHERE program_id = ?')
      .get('arrl-amateur-radio-grants') as {
        next_closes_at: string | null;
        next_timezone: string | null;
      };
    // The exact instant named in the defect report, produced by the real directive.
    expect(row.next_closes_at).toBe('2027-03-01T04:59:00.000Z');
    expect(row.next_timezone).toBe('America/New_York');
  });

  it('renders the funder’s calendar day — and would print the day after without the zone', () => {
    const hit = hydratePrograms(db, ['arrl-amateur-radio-grants']).get('arrl-amateur-radio-grants');
    expect(hit).toBeDefined();

    // THE ASSERTION THIS WHOLE TASK IS FOR.
    expect(formatDate(hit?.nextClosesAt, hit?.nextTimezone)).toBe('2027-02-28');

    // ...and the exact string a user was shown before it, pinned so the regression is legible.
    // This is not a preference about formatting: 2027-03-01 is a day the ARRL does not accept.
    expect(formatDate(hit?.nextClosesAt)).toBe('2027-03-01');
  });

  it('carries the zone all the way out of GET /api/programs', async () => {
    const res = await request(buildApp(db, NOW)).get('/api/programs?q=amateur%20radio%20grants');
    const row = res.body.rows.find(
      (r: { program: { id: string } }) => r.program.id === 'arrl-amateur-radio-grants',
    );
    expect(row).toBeDefined();
    expect(row.nextClosesAt).toBe('2027-03-01T04:59:00.000Z');
    expect(row.nextTimezone).toBe('America/New_York');
    // The web layer holds nothing but this response, so the day it can render is asserted from
    // the response alone — no test-only knowledge in between.
    expect(formatDate(row.nextClosesAt, row.nextTimezone)).toBe('2027-02-28');
  });

  /**
   * THE CALENDAR NEVER HAD THIS GAP, and this test is what makes that a fact rather than a
   * reading.
   *
   * `calendarRouter` returns the whole `Cycle` on every entry — `{ id, programId, opensAt,
   * closesAt, timezone, label, isEstimated }` — because it projects cycles directly instead of
   * reading the browse projection, and `Cycle.timezone` has been a required field since Plan 1.
   * So the zone was already on the wire there; it was the flattening into three scalars in
   * `program_search` that dropped it, which is exactly why browse and the watchlist were the two
   * broken surfaces and the calendar was not.
   *
   * It is pinned anyway. "This surface happens to be correct" is one refactor away from being
   * false, and the whole class of defect here is a hop that quietly stops carrying a field.
   */
  it('was already correct on the calendar, which carries the whole Cycle', async () => {
    const res = await request(buildApp(db, NOW)).get(
      '/api/calendar?from=2027-02-01T00:00:00.000Z&to=2027-03-31T00:00:00.000Z',
    );
    const entry = res.body.entries.find(
      (e: { programId: string }) => e.programId === 'arrl-amateur-radio-grants',
    );
    expect(entry).toBeDefined();
    expect(entry.cycle.closesAt).toBe('2027-03-01T04:59:00.000Z');
    expect(entry.cycle.timezone).toBe('America/New_York');
    expect(formatDate(entry.cycle.closesAt, entry.cycle.timezone)).toBe('2027-02-28');
    // The label core writes states the same day in prose, so the two agree on the wire.
    expect(entry.cycle.label).toContain('Feb 1–28, 2027');
  });

  it('carries the zone onto the watchlist, which reads the same projection', async () => {
    await request(buildApp(db, NOW))
      .post('/api/watchlist')
      .send({ programId: 'arrl-amateur-radio-grants' });

    const res = await request(buildApp(db, NOW)).get('/api/watchlist');
    const row = res.body.rows.find(
      (r: { program: { id: string } }) => r.program.id === 'arrl-amateur-radio-grants',
    );
    expect(row).toBeDefined();
    expect(row.nextTimezone).toBe('America/New_York');
    expect(formatDate(row.nextClosesAt, row.nextTimezone)).toBe('2027-02-28');
  });
});

describe('every zone shape the real corpus produces renders its own day', () => {
  const NOW = '2026-08-02T12:00:00.000Z';
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * ARDC is in California and its directive is `tz=America/Los_Angeles`, so its 23:59 close on
   * 1 September is `2026-09-02T06:59:00.000Z` — a UTC instant whose UTC DAY is already the wrong
   * one. This is one of the five programmes in the real corpus whose rendered day moves.
   */
  it('renders a Pacific deadline on the Pacific day', () => {
    const hit = hydratePrograms(db, ['ardc-grants']).get('ardc-grants');
    expect(hit?.nextClosesAt).toBe('2026-09-02T06:59:00.000Z');
    expect(hit?.nextTimezone).toBe('America/Los_Angeles');
    expect(formatDate(hit?.nextClosesAt, hit?.nextTimezone)).toBe('2026-09-01');
    expect(formatDate(hit?.nextClosesAt)).toBe('2026-09-02'); // the day it used to show
  });

  /**
   * THE CASE THAT MAKES THE BUG LOOK SMALLER THAN IT IS, and the reason the zone is carried even
   * when it changes nothing.
   *
   * The ARRL Foundation scholarship closes at NOON Eastern (`close=12:00`), not 23:59, so its
   * instant is `2026-12-30T17:00:00.000Z` and the UTC day already equals the Eastern day. 113 of
   * the 122 dated programmes in the corpus are this one deadline, inherited through the 111-entry
   * catalogue — which is precisely why only 5 of 150 rendered days actually move today.
   *
   * That is a fact about this corpus at this moment, not a property of the data model. The same
   * programme would move the instant the ARRL published a midnight close, and the ARRL Amateur
   * Radio Grants windows above already do. So the zone is carried unconditionally: dropping it
   * "because it makes no difference" would be true of these rows and false of the product.
   */
  it('carries the zone for a noon-Eastern deadline whose day does not move', () => {
    const hit = hydratePrograms(db, ['arrl-foundation-scholarship']).get(
      'arrl-foundation-scholarship',
    );
    expect(hit?.nextClosesAt).toBe('2026-12-30T17:00:00.000Z');
    expect(hit?.nextTimezone).toBe('America/New_York');
    expect(formatDate(hit?.nextClosesAt, hit?.nextTimezone)).toBe('2026-12-30');
    expect(formatDate(hit?.nextClosesAt)).toBe('2026-12-30');
  });

  /** An inherited deadline carries the OWNER's zone; 111 catalogue entries depend on this. */
  it('carries the zone through deadline inheritance', () => {
    const hit = hydratePrograms(db, ['qcwa-memorial-scholarship']).get('qcwa-memorial-scholarship');
    expect(hit?.nextClosesAt).toBe('2026-12-30T17:00:00.000Z');
    expect(hit?.nextTimezone).toBe('America/New_York');
  });

  /**
   * A window the FUNDER published carries `timezone: 'UTC'` — core's documented day-precision
   * frame for dates that were printed with no time and no zone, taken as the very end of the
   * stated day so a programme cannot be closed early anywhere on earth. It is a real frame, not
   * a missing one, and rendering it in UTC gives back exactly the day the funder printed.
   */
  it('renders a funder-published window as the day the funder printed', () => {
    createProgramRepo(db).upsert({
      ...ardcGrants,
      id: 'stated-window',
      name: 'Programme with a window the funder published',
      deadline: {
        kind: 'n_fixed_windows',
        source: { kind: 'self' },
        note: 'Application window published by the funder: opens 2026-09-07, closes 2026-11-04.',
      },
    });
    reindexBrowse(db, NOW);

    const hit = hydratePrograms(db, ['stated-window']).get('stated-window');
    expect(hit?.nextIsEstimated).toBe(false);
    expect(hit?.nextClosesAt).toBe('2026-11-04T23:59:59.999Z');
    expect(hit?.nextTimezone).toBe('UTC');
    expect(formatDate(hit?.nextClosesAt, hit?.nextTimezone)).toBe('2026-11-04');
  });
});

/**
 * WHAT HAPPENS WHEN NO ZONE WAS RECORDED — the half of this change that is about honesty rather
 * than correctness.
 *
 * A null `next_timezone` is not hypothetical. Migration 037 adds the column to EXISTING databases
 * with `ALTER TABLE`, so every row already in `program_search` reads null from the moment it runs
 * until the next `reindexBrowse` — a real server, serving real rows, holding a real instant and no
 * frame for it.
 *
 * The rule for that state is the rule this codebase applies everywhere else: report what is known
 * and do not manufacture what is not. UTC is deterministic, is what the reader can label, and is
 * the same day the no-argument call has always produced. Substituting the SERVER's zone would
 * invent a calendar day out of the accident of where the process happens to run — an asserted
 * value where an observed one is missing, which is the defect class this corpus has spent an
 * enormous amount of effort removing.
 */
describe('a projection row with no zone reports none, and never guesses one', () => {
  const NOW = '2026-08-02T12:00:00.000Z';
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('hydrates a pre-037 row as null rather than as the server’s zone', () => {
    // Exactly the state migration 037 leaves an existing database in: the instant survived the
    // ALTER TABLE, the frame did not.
    db.prepare('UPDATE program_search SET next_timezone = NULL WHERE program_id = ?').run(
      'ardc-grants',
    );

    const hit = hydratePrograms(db, ['ardc-grants']).get('ardc-grants');
    expect(hit?.nextClosesAt).toBe('2026-09-02T06:59:00.000Z');
    expect(hit?.nextTimezone).toBeNull();

    // Rendered in UTC, which the reader can label. It is NOT silently the funder's day, and the
    // test says so out loud: this row is honestly unknown, not quietly correct.
    expect(formatDate(hit?.nextClosesAt, hit?.nextTimezone)).toBe('2026-09-02');
    expect(formatDate(hit?.nextClosesAt, hit?.nextTimezone)).toBe(
      formatDate(hit?.nextClosesAt),
    );
  });

  it('normalizes an empty-string zone to null instead of letting "" reach a formatter', () => {
    db.prepare(`UPDATE program_search SET next_timezone = '' WHERE program_id = ?`).run(
      'ardc-grants',
    );
    expect(hydratePrograms(db, ['ardc-grants']).get('ardc-grants')?.nextTimezone).toBeNull();
  });

  it('reports no zone for a programme with no next cycle, beside its null date', () => {
    // Chicago FM is discontinued and projects nothing; the zone must be absent for the same
    // reason the date is, rather than defaulted to something that implies a deadline exists.
    const hit = hydratePrograms(db, ['chicago-fm-club-scholarship']).get(
      'chicago-fm-club-scholarship',
    );
    expect(hit?.nextClosesAt).toBeNull();
    expect(hit?.nextTimezone).toBeNull();
    expect(formatDate(hit?.nextClosesAt, hit?.nextTimezone)).toBe('—');
  });

  it('serves null over the API rather than omitting the field', async () => {
    db.prepare('UPDATE program_search SET next_timezone = NULL WHERE program_id = ?').run(
      'ardc-grants',
    );
    seedTestUser(db, MEMBER.id);
    const res = await request(buildApp(db, NOW)).get('/api/programs?q=ardc');
    const row = res.body.rows[0];
    expect(row.program.id).toBe('ardc-grants');
    // Present-and-null is a statement ("no zone recorded"); an absent key is indistinguishable
    // from a client that forgot to read it.
    expect(Object.hasOwn(row, 'nextTimezone')).toBe(true);
    expect(row.nextTimezone).toBeNull();
  });
});
