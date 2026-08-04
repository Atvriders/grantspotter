import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { Program } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import {
  seedFixtureCorpus,
  starProgram,
  arrlClubGrant,
  arrlScholarship,
} from '../test/fixtures/programs.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { contextForSource } from '../crawl/context.js';
import { DO_NOT_PUBLISH_TAG, normalizeRaw } from '../normalize/index.js';
import { TIER_D_RECORDS, manualTierD } from '../sources/manual-tier-d.js';
import { reindexBrowse } from './reindex.js';
import { createCalendarRouter } from './calendarRouter.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => MEMBER,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/calendar', createCalendarRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

const WINDOW = 'from=2026-08-01T00:00:00.000Z&to=2027-03-01T00:00:00.000Z';

describe('GET /api/calendar', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('returns cycle instances inside the requested window', async () => {
    const res = await request(buildApp(db)).get(`/api/calendar?${WINDOW}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const e of res.body.entries) {
      expect(e.cycle.closesAt >= '2026-08-01T00:00:00.000Z').toBe(true);
      expect(e.cycle.closesAt <= '2027-03-01T00:00:00.000Z').toBe(true);
    }
  });

  it('colours by instrument and applicant entity, so both are on every entry', async () => {
    const res = await request(buildApp(db)).get(`/api/calendar?${WINDOW}`);
    const entry = res.body.entries[0];
    expect(typeof entry.instrument).toBe('string');
    expect(Array.isArray(entry.applicantEntities)).toBe(true);
  });

  it('returns a prep start date so the calendar can show when to begin', async () => {
    const res = await request(buildApp(db)).get(`/api/calendar?${WINDOW}`);
    const arrl = res.body.entries.find(
      (e: { programId: string }) => e.programId === 'arrl-foundation-scholarship',
    );
    expect(arrl.prepLeadDays).toBe(30);
    expect(arrl.prepStartAt).toBe('2026-11-30T17:00:00.000Z');
    expect(arrl.prepNote).toContain('transcript');
  });

  it('flags estimated cycles distinctly from observed ones', async () => {
    const res = await request(buildApp(db))
      .get('/api/calendar?from=2026-08-01T00:00:00.000Z&to=2028-01-01T00:00:00.000Z');
    const kinds = new Set(res.body.entries.map((e: { isEstimated: boolean }) => e.isEstimated));
    expect(kinds.size).toBeGreaterThanOrEqual(1);
    for (const e of res.body.entries) expect(typeof e.isEstimated).toBe('boolean');
  });

  it('marks watched programs so the calendar can highlight them', async () => {
    starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
    const res = await request(buildApp(db)).get(`/api/calendar?${WINDOW}`);
    const arrl = res.body.entries.find(
      (e: { programId: string }) => e.programId === 'arrl-foundation-scholarship',
    );
    expect(arrl.watched).toBe(true);
  });

  it('omits programs with no dated cycle rather than inventing one', async () => {
    const res = await request(buildApp(db)).get(`/api/calendar?${WINDOW}`);
    const ids = res.body.entries.map((e: { programId: string }) => e.programId);
    expect(ids).not.toContain('arrl-club-grant');
    expect(ids).not.toContain('chicago-fm-club-scholarship');
  });

  it('lists the undated programs separately so they are not silently lost', async () => {
    const res = await request(buildApp(db)).get(`/api/calendar?${WINDOW}`);
    const undated = res.body.undated.map((u: { programId: string }) => u.programId);
    expect(undated).toContain('arrl-club-grant');
    expect(res.body.undated.find((u: { programId: string }) => u.programId === 'arrl-club-grant')
      .deadlineKind).toBe('unpublished');
  });

  it('defaults the window to the next twelve months', async () => {
    const res = await request(buildApp(db)).get('/api/calendar');
    expect(res.body.from).toBe(NOW);
    expect(res.body.to).toBe('2027-08-02T12:00:00.000Z');
  });

  /**
   * ADDED BY TASK 11, and the single most important assertion in this file.
   *
   * The brief builds the calendar from `expandCycles` alone. That function
   * projects a RECURRENCE and stamps every row it produces `isEstimated: true`,
   * so a calendar built from it can only ever contain projections — the window a
   * funder actually PUBLISHED arrives through core's other channel,
   * `observedCycles`, which yields exactly one row per stated window and marks
   * it `isEstimated: false`.
   *
   * Measured against the real corpus at 2026-08-02, the difference is not
   * cosmetic: over 18 months there are 243 cycles, of which 4 are funder-stated
   * (ARISS 2026-07-01..09-30, Yaesu 2026-08-31, two federal NOFOs). In
   * September 2026 specifically, the brief's calendar shows 1 entry where the
   * corpus holds 3, and the 2 it drops are precisely the 2 a funder printed.
   * Dropping exactly the authoritative rows and keeping only the projected ones
   * inverts the honesty property this table was repaired to carry, and
   * `reindexBrowse` merges both channels — so the browse row would show the
   * funder's real date while the calendar beside it showed nothing.
   *
   * The two channels stay separate calls, never merged into one `expandCycles`
   * pass: that shortcut is what would put a 2027 ARISS deadline, which ARISS has
   * never announced, on this calendar.
   */
  it('shows the window a funder published, marked as published rather than estimated', async () => {
    const published: Program = {
      ...arrlClubGrant,
      id: 'arrl-club-grant-observed',
      name: 'ARRL Club Grant Program (stated window)',
      deadline: {
        kind: 'n_fixed_windows',
        source: { kind: 'self' },
        note: 'Application window published by the funder: opens 2026-09-07, closes 2026-11-04.',
      },
    };
    createProgramRepo(db).upsert(published);

    const res = await request(buildApp(db)).get(`/api/calendar?${WINDOW}`);
    const stated = res.body.entries.filter((e: { isEstimated: boolean }) => !e.isEstimated);
    expect(stated).toHaveLength(1);
    expect(stated[0].programId).toBe('arrl-club-grant-observed');
    expect(stated[0].cycle.closesAt).toBe('2026-11-04T23:59:59.999Z');
    expect(stated[0].cycle.opensAt).toBe('2026-09-07T00:00:00.000Z');

    // ...and the projected rows are still there beside it, still flagged.
    const estimated = res.body.entries.filter((e: { isEstimated: boolean }) => e.isEstimated);
    expect(estimated.length).toBeGreaterThan(0);

    // A stated window is ONE window. Nothing invents a 2027 successor for it.
    const wide = await request(buildApp(db))
      .get('/api/calendar?from=2026-08-01T00:00:00.000Z&to=2029-01-01T00:00:00.000Z');
    const allStated = wide.body.entries.filter(
      (e: { programId: string }) => e.programId === 'arrl-club-grant-observed',
    );
    expect(allStated).toHaveLength(1);
  });

  /**
   * ADDED BY TASK 11. Two Global Constraints of this plan land on the calendar
   * and on nothing else here: "every user-facing date renders with its
   * `lastVerifiedAt` provenance, no bare dates", and "`status: 'unknown'`
   * renders as a real, labelled state". The calendar is a wall of dates; without
   * these two fields on the entry the UI cannot honour either constraint, and
   * 118 of the 150 real records carry `status: 'unknown'`.
   */
  it('carries the provenance and the status every date on this surface needs', async () => {
    const res = await request(buildApp(db)).get(`/api/calendar?${WINDOW}`);
    for (const e of res.body.entries) {
      expect(typeof e.lastVerifiedAt).toBe('string');
      expect(e.lastVerifiedAt.length).toBeGreaterThan(0);
      expect(typeof e.status).toBe('string');
    }
    const arrl = res.body.entries.find(
      (e: { programId: string }) => e.programId === 'arrl-foundation-scholarship',
    );
    expect(arrl.lastVerifiedAt).toBe(arrlScholarship.trust.lastVerifiedAt);
    expect(arrl.status).toBe('open');
  });

  /**
   * ADDED BY TASK 11. `createProgramRepo(db).list()` returns the WHOLE
   * `programs` table, suppressed records included. 545 of the 742 records the
   * corpus can produce carry `do_not_publish` — past ARDC/NSF/USAspending awards
   * and the 37 ARRL clubs already funded. `reindexBrowse` filters them and the
   * detail route 404s them; a calendar that did not filter would put a grant
   * somebody else already won on a user's "apply by" wall, which is the exact
   * harm the tag exists to prevent. The `undated` list matters more than the
   * dated one here, because a past award has no cycle and would land there.
   */
  it('never puts a do_not_publish record on the calendar, dated or undated', async () => {
    const pastAward: Program = {
      ...arrlClubGrant,
      id: 'arrl-club-grant-2024-award',
      name: 'ARRL Club Grant — 2024 award to a club that already won it',
      tags: [...arrlClubGrant.tags, DO_NOT_PUBLISH_TAG],
    };
    const datedPastAward: Program = {
      ...arrlScholarship,
      id: 'arrl-scholarship-2024-award',
      name: 'ARRL Scholarship — 2024 award',
      tags: [...arrlScholarship.tags, DO_NOT_PUBLISH_TAG],
    };
    createProgramRepo(db).upsert(pastAward);
    createProgramRepo(db).upsert(datedPastAward);

    const res = await request(buildApp(db)).get(`/api/calendar?${WINDOW}`);
    const dated = res.body.entries.map((e: { programId: string }) => e.programId);
    const undated = res.body.undated.map((u: { programId: string }) => u.programId);
    expect(dated).not.toContain('arrl-scholarship-2024-award');
    expect(undated).not.toContain('arrl-club-grant-2024-award');
    // The publishable sibling is untouched: this is suppression, not breakage.
    expect(dated).toContain('arrl-foundation-scholarship');
    expect(undated).toContain('arrl-club-grant');
  });

  /**
   * ADDED BY TASK 11, correcting the brief. The brief computes `undated` as
   * "produced no cycle inside [from, to]", which is a different claim from "this
   * funder publishes no deadline". Against the real corpus, a one-month view of
   * September 2026 would then report 147 of 150 programmes as undated — including
   * the 111 ARRL-catalog entries whose deadline is a perfectly well-known
   * December 30. Telling a user that a programme with a published December
   * deadline has no deadline is the same class of lie as publishing a date the
   * funder never announced, and this list is rendered as "no deadline published"
   * beside a calendar the user is scrolling month by month.
   *
   * `undated` is therefore computed over the whole projection horizon —
   * `HORIZON_DAYS` from `reindex.ts`, the same 550 days the browse projection
   * uses for `next_closes_at` — so the calendar's "no deadline published" list
   * and the browse row's empty next-deadline cell are the same 28 records,
   * whatever month the user happens to be looking at.
   */
  it('does not call a December deadline undated because you are looking at September', async () => {
    const res = await request(buildApp(db))
      .get('/api/calendar?from=2026-09-01T00:00:00.000Z&to=2026-09-30T23:59:59.999Z');
    expect(res.status).toBe(200);
    const undated = res.body.undated.map((u: { programId: string }) => u.programId);
    expect(undated).not.toContain('arrl-foundation-scholarship');
    expect(undated).not.toContain('qcwa-memorial-scholarship');
    // ...while the genuinely undated ones are still listed.
    expect(undated).toContain('arrl-club-grant');
    // The dated half is still window-scoped: only ARDC's Sep 1 cycle falls here.
    const dated = res.body.entries.map((e: { programId: string }) => e.programId);
    expect(dated).toEqual(['ardc-grants']);
  });

  /**
   * ADDED BY TASK 11. `parseBrowseQuery` is deliberately total — an unreadable
   * browse filter is dropped and the user sees a wider list, which is visible.
   * A calendar window is the opposite: silently substituting "the next twelve
   * months" for a month the client asked for answers a different question and
   * looks exactly like an answer. Absent means default; present-and-unreadable
   * is `validation_failed`, which Plan 1's `ERROR_STATUS` maps to 422.
   */
  it('refuses an unreadable window rather than silently answering a different one', async () => {
    for (const query of [
      'from=last-tuesday',
      'to=2027-13-45T00:00:00.000Z',
      'from=2027-03-01T00:00:00.000Z&to=2026-08-01T00:00:00.000Z',
      'from=2026-08-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z',
    ]) {
      const res = await request(buildApp(db)).get(`/api/calendar?${query}`);
      expect(res.status, query).toBe(422);
      expect(res.body.error.code, query).toBe('validation_failed');
      expect(typeof res.body.requestId).toBe('string');
    }
  });

  /**
   * ADDED BY TASK 11, built from the REAL Tier-D record. farweb.org was taken
   * over between 2025-10-17 and 2026-02-10 and now redirects to a gambling site,
   * while ARRL, QCWA and club pages still say "apply at the FAR website". The
   * record exists to intercept that instruction, so on this surface it must
   * never become a dated opportunity with a "start preparing" date attached, and
   * the response must never carry the hijacked domain.
   */
  it('never renders the farweb.org warning as an opportunity or emits the domain', async () => {
    const far = TIER_D_RECORDS.find((r) => r.externalKey === 'far-farweb-org-compromised');
    if (far === undefined) throw new Error('the FAR safety-warning record is missing from Tier D');
    const program = normalizeRaw(far, contextForSource(manualTierD, NOW));
    createFunderRepo(db).upsert({ id: program.funderId, name: 'Various funders', homepage: '' });
    createProgramRepo(db).upsert(program);

    const res = await request(buildApp(db))
      .get('/api/calendar?from=2026-08-01T00:00:00.000Z&to=2029-01-01T00:00:00.000Z');
    expect(res.status).toBe(200);
    const dated = res.body.entries.map((e: { programId: string }) => e.programId);
    expect(dated).not.toContain(program.id);
    const warned = res.body.undated.find((u: { programId: string }) => u.programId === program.id);
    expect(warned.status).toBe('discontinued');
    expect(JSON.stringify(res.body)).not.toMatch(/farweb\.org/i);
  });
});
