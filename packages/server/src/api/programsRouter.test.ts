import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { Program } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import {
  ardcGrants,
  seedFixtureCorpus,
  seedTestUser,
  starProgram,
} from '../test/fixtures/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
import { reindexBrowse } from './reindex.js';
import { createProgramsRouter, parseBrowseQuery } from './programsRouter.js';
import {
  loadActiveProfile,
  loadAllProfiles,
  loadProfile,
  PROFILE_KIND_PRIORITY,
  saveProfile,
} from './profileStore.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';

const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

/**
 * The test harness mounts Plan 1's requestId middleware and error handler around
 * the router, so every failure assertion below sees the ONE real envelope
 * `{ error: { code, message, details? }, requestId }` (RESOLUTIONS R6) rather
 * than a shape invented by the test.
 */
function buildApp(
  db: Database.Database,
  user: SessionUser = MEMBER,
  overrides: Partial<RouterDeps> = {},
) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => {
      next(user.role === 'admin' ? undefined : new AppError('forbidden', 'Admin role required.'));
    },
    currentUser: () => user,
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/programs', createProgramsRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

/**
 * A licensed undergraduate. Enough profile to get real verdicts, with GPA absent.
 *
 * `seedTestUser` first: `profiles.user_id` is `REFERENCES users(id) ON DELETE
 * CASCADE` in Plan 1's 001-init.sql and `PRAGMA foreign_keys = ON` is set on the
 * connection, so this INSERT fails without the parent row (RESOLUTIONS R19).
 */
function seedStudentProfile(db: Database.Database, patch: Record<string, unknown> = {}): void {
  seedTestUser(db, 'u-member');
  db.prepare(
    `INSERT INTO profiles (id, user_id, kind, data, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind) DO UPDATE SET data = excluded.data`,
  ).run(
    'p-1',
    'u-member',
    'student',
    JSON.stringify({
      kind: 'student',
      callsign: 'W8UM',
      licenseClass: 'GENERAL',
      licensedSince: '2023-05-01',
      state: 'MI',
      degreeLevel: 'BACH',
      institution: 'Example State University',
      accredited: true,
      partTime: false,
      citizenship: 'US_CITIZEN',
      stage: 'UNDERGRAD',
      ...patch,
    }),
    NOW,
  );
}

/**
 * An unincorporated club that is NOT ARRL-affiliated. This is the profile the
 * `arrl_membership` axis actually speaks to — see the note on the axis-breakdown
 * test below for why a student never reaches that axis.
 */
function seedClubProfile(db: Database.Database, patch: Record<string, unknown> = {}): void {
  seedTestUser(db, 'u-member');
  db.prepare(
    `INSERT INTO profiles (id, user_id, kind, data, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind) DO UPDATE SET data = excluded.data`,
  ).run(
    'p-2',
    'u-member',
    'organization',
    JSON.stringify({
      kind: 'organization',
      entity: 'club_unincorporated',
      orgName: 'Example Radio Club',
      callsign: 'W8XYZ',
      state: 'MI',
      is501c3: false,
      hasFiscalSponsor: false,
      arrlAffiliated: false,
      ...patch,
    }),
    NOW,
  );
}

/**
 * A second individual-facing program gated on license class alone. It exists so
 * the `unknownByField` ranking is measured on UNEQUAL counts: with only the five
 * fixture programs, a profile with gaps produces one `licenseClass` and one
 * `degreeLevel` and any sort order passes vacuously.
 */
function licenseGatedProgram(): Program {
  return {
    id: 'zeta-license-gated-award',
    funderId: 'arrl-foundation',
    name: 'Zeta License-Gated Award',
    klass: 'ham_scholarship',
    summary: 'A second individual award whose only hard gate is license class.',
    applicantEntities: ['individual'],
    amount: {
      instrument: 'cash_fixed',
      amountMin: 1000,
      amountMax: 1000,
      amountRaw: '$1,000',
      awardCountRaw: '1',
    },
    deadline: { kind: 'rolling', source: { kind: 'self' }, note: 'Accepted year round.' },
    applyVia: 'contact_person',
    applyContact: 'grants@example.com',
    constraints: [
      {
        id: 'zeta-license',
        hard: true,
        fallbackRank: 0,
        rawText: 'Applicants must hold a General class licence or higher.',
        spec: { axis: 'license', licenseMin: 'GENERAL' },
      },
    ],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://example.com/zeta-award',
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      verificationMethod: 'manual_curation',
      contentHash: 'f1'.repeat(32),
    },
    rawOtherText: '',
    tags: ['scholarship'],
  };
}

/**
 * Same shape, but the license constraint is SOFT. A soft constraint the profile
 * meets is the only way to reach `eligible_preferred`, and no fixture program
 * carries one — without this the `preferred` counter and the
 * `verdict=eligible_preferred` filter would both ship untested.
 */
function softPreferenceProgram(): Program {
  const base = licenseGatedProgram();
  return {
    ...base,
    id: 'yotta-preference-award',
    name: 'Yotta Preference Award',
    constraints: [
      {
        id: 'yotta-license-preference',
        hard: false,
        fallbackRank: 2,
        rawText: 'Preference is given to applicants holding a General class licence or higher.',
        spec: { axis: 'license', licenseMin: 'GENERAL' },
      },
    ],
    trust: { ...base.trust, contentHash: 'a2'.repeat(32) },
  };
}

/**
 * A program whose verdict depends on WHEN it is asked: the licence must have
 * been held for four years. Nothing in the fixture corpus is time-sensitive, so
 * without this the router could read the wall clock instead of `deps.now()` and
 * every test would still pass.
 */
function tenureGatedProgram(): Program {
  const base = licenseGatedProgram();
  return {
    ...base,
    id: 'tenure-gated-award',
    name: 'Tenure-Gated Award',
    constraints: [
      {
        id: 'tenure-license',
        hard: true,
        fallbackRank: 0,
        rawText: 'Applicants must have held their licence for at least four years.',
        spec: { axis: 'license', licenseMin: 'TECH', heldMonthsMin: 48 },
      },
    ],
    trust: { ...base.trust, contentHash: 'b3'.repeat(32) },
  };
}

/** A stored-but-suppressed record: evidence of a past award, never an opportunity. */
function pastAwardProgram(): Program {
  return {
    ...ardcGrants,
    id: 'ardc-past-award-2024',
    name: 'ARDC 2024 award to a university club',
    summary: 'A grant already made in 2024. Evidence of who ARDC funds, not an opening.',
    applicantEntities: ['individual'],
    trust: { ...ardcGrants.trust, status: 'closed', contentHash: '0c'.repeat(32) },
    tags: ['grant', 'ardc', 'past_award', DO_NOT_PUBLISH_TAG],
  };
}

describe('parseBrowseQuery', () => {
  it('falls back to defaults for an empty query string', () => {
    const f = parseBrowseQuery({});
    expect(f.page).toBe(1);
    expect(f.pageSize).toBe(50);
    expect(f.sort).toBe('deadline');
    expect(f.klass).toEqual([]);
    expect(f.includeRolling).toBe(true);
  });

  it('accepts repeated and comma-separated multi-values', () => {
    expect(parseBrowseQuery({ klass: 'ham_grant,ham_scholarship' }).klass)
      .toEqual(['ham_grant', 'ham_scholarship']);
    expect(parseBrowseQuery({ klass: ['ham_grant', 'ham_scholarship'] }).klass)
      .toEqual(['ham_grant', 'ham_scholarship']);
  });

  it('drops values outside the enum instead of trusting the client', () => {
    expect(parseBrowseQuery({ klass: 'ham_grant,DROP TABLE programs' }).klass)
      .toEqual(['ham_grant']);
    expect(parseBrowseQuery({ sort: 'sneaky' }).sort).toBe('deadline');
    expect(parseBrowseQuery({ verdict: 'maybe' }).verdict).toEqual([]);
    expect(parseBrowseQuery({ status: 'unknown,made_up' }).status).toEqual(['unknown']);
  });

  it('clamps pageSize to a sane ceiling', () => {
    expect(parseBrowseQuery({ pageSize: '100000' }).pageSize).toBe(200);
    expect(parseBrowseQuery({ pageSize: '0' }).pageSize).toBe(1);
    expect(parseBrowseQuery({ pageSize: 'not-a-number' }).pageSize).toBe(50);
    expect(parseBrowseQuery({ page: '-3' }).page).toBe(1);
  });

  it('keeps a non-date deadline bound out of the filters entirely', () => {
    const f = parseBrowseQuery({ deadlineFrom: 'yesterday', deadlineTo: '2026-12-01' });
    expect(f.deadlineFrom).toBeUndefined();
    expect(f.deadlineTo).toBe('2026-12-01');
  });

  /**
   * The enum whitelists are READ OFF core's zod schemas rather than restated as
   * string arrays, so a value added to `ProgramStatus` in CONTRACT §3 becomes
   * filterable in the same commit instead of being silently dropped here.
   */
  it('accepts every value the core schemas define, for every faceted filter', () => {
    expect(parseBrowseQuery({ status: 'open,closed,dormant,discontinued,contact_only,no_application,unknown' }).status)
      .toHaveLength(7);
    expect(parseBrowseQuery({ entity: 'individual,teacher,nominated_by_institution' }).entity)
      .toHaveLength(3);
    expect(parseBrowseQuery({ instrument: 'cash_range,tuition_coverage,unknown' }).instrument)
      .toHaveLength(3);
  });
});

describe('profileStore', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedTestUser(db, 'u-member');
  });

  afterEach(() => {
    db.close();
  });

  it('returns null for a user with no profile of that kind', () => {
    expect(loadProfile(db, 'u-member', 'student')).toBeNull();
    expect(loadActiveProfile(db, 'u-member')).toBeNull();
    expect(loadAllProfiles(db, 'u-member')).toEqual({ student: null, organization: null });
  });

  it('round-trips a profile through the injected clock', () => {
    saveProfile(db, 'u-member', 'student', { kind: 'student', callsign: 'W8UM' }, NOW);
    expect(loadProfile(db, 'u-member', 'student')).toEqual({ kind: 'student', callsign: 'W8UM' });
    const row = db
      .prepare('SELECT updated_at FROM profiles WHERE user_id = ? AND kind = ?')
      .get('u-member', 'student') as { updated_at: string };
    expect(row.updated_at).toBe(NOW);
  });

  it('updates in place rather than inserting a second row for the same kind', () => {
    saveProfile(db, 'u-member', 'student', { kind: 'student', callsign: 'W8UM' }, NOW);
    saveProfile(
      db,
      'u-member',
      'student',
      { kind: 'student', callsign: 'W8UM', licenseClass: 'EXTRA' },
      '2026-08-03T00:00:00.000Z',
    );
    const rows = db
      .prepare('SELECT id FROM profiles WHERE user_id = ? AND kind = ?')
      .all('u-member', 'student');
    expect(rows).toHaveLength(1);
    expect(loadProfile(db, 'u-member', 'student')).toEqual({
      kind: 'student',
      callsign: 'W8UM',
      licenseClass: 'EXTRA',
    });
  });

  it('refuses to file a profile under a kind that contradicts its own payload', () => {
    expect(() =>
      saveProfile(
        db,
        'u-member',
        'organization',
        { kind: 'student', callsign: 'W8UM' },
        NOW,
      ),
    ).toThrow(/kind/i);
  });

  it('prefers the student profile when a user holds both', () => {
    saveProfile(db, 'u-member', 'student', { kind: 'student', callsign: 'W8UM' }, NOW);
    saveProfile(
      db,
      'u-member',
      'organization',
      { kind: 'organization', entity: 'club_unincorporated' },
      NOW,
    );
    expect(loadActiveProfile(db, 'u-member')?.kind).toBe('student');
    expect(loadActiveProfile(db, 'u-member', 'organization')?.kind).toBe('organization');
    expect(loadAllProfiles(db, 'u-member').organization?.entity).toBe('club_unincorporated');
  });

  it('falls back to the organization profile when only that one exists', () => {
    saveProfile(
      db,
      'u-member',
      'organization',
      { kind: 'organization', entity: 'club_501c3' },
      NOW,
    );
    expect(loadActiveProfile(db, 'u-member')?.kind).toBe('organization');
    // An explicit preference that is not on file is not a silent fallback: the
    // caller asked to be matched as a student and there is no student profile.
    expect(loadActiveProfile(db, 'u-member', 'student')).toBeNull();
  });

  /**
   * The kind order is a `Record<ProfileKind, number>` so that a third profile
   * variant added to CONTRACT §3 fails to compile here instead of silently
   * never being reached by the default order.
   */
  it('ranks every profile kind the contract defines', () => {
    expect(Object.keys(PROFILE_KIND_PRIORITY).sort()).toEqual(['organization', 'student']);
  });
});

describe('GET /api/programs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('returns every program with a null verdict when no profile exists', async () => {
    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.profileApplied).toBeNull();
    expect(res.body.rows[0].verdict).toBeNull();
    expect(res.body.summary.eligible).toBe(0);
  });

  /**
   * ...and the whole census reads zero, not "you are eligible for none of these".
   * `profileApplied: null` is the discriminator the UI must branch on; the four
   * counters are only meaningful once a profile has been applied. Pinned here
   * because a census that silently reported 0 eligible against a total of 5
   * would be a false exclude with no signal, which is the one failure mode this
   * endpoint may never have.
   */
  it('reports an empty census, not a negative one, when no profile is applied', async () => {
    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.body.summary).toEqual({
      total: 5,
      eligible: 0,
      preferred: 0,
      ineligible: 0,
      unknown: 0,
      ineligibleByAxis: [],
      unknownByField: [],
    });
  });

  it('applies the student profile and returns a verdict for every row', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.body.profileApplied).toBe('student');
    expect(res.body.rows).toHaveLength(5);
    for (const row of res.body.rows) {
      expect(row.verdict).not.toBeNull();
      expect(['eligible', 'eligible_preferred', 'ineligible', 'unknown'])
        .toContain(row.verdict.kind);
    }
  });

  it('reports a verdict census that sums to the filtered total', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs');
    const s = res.body.summary;
    expect(s.eligible + s.preferred + s.ineligible + s.unknown).toBe(s.total);
    expect(s.total).toBe(5);
    expect(s.eligible).toBe(3);
    expect(s.ineligible).toBe(2);
  });

  /**
   * DEVIATION FROM THE TASK BRIEF (2026-08-03), reproduced before it was written.
   *
   * The brief asserts `arrl_membership` here, with the comment "a student is not
   * an ARRL-affiliated club, so the Club Grant excludes on the arrl_membership
   * axis". A student never reaches that axis. `matchProgram` checks the
   * APPLICANT-ENTITY gate first and short-circuits: `arrl-club-grant` accepts
   * `club_501c3` and `club_unincorporated`, a student applies as `individual`,
   * so the verdict is a single synthesized reason whose `spec.axis` is `other`
   * and whose rawText names the entities the program does accept. Run against
   * the real matcher, the brief's assertion reads
   * `["other"] toContain "arrl_membership"` and fails.
   *
   * Both halves of the intent are therefore asserted, in the profile each one
   * actually belongs to: the entity gate here, and `arrl_membership` in the
   * organization block below — which is the case the brief's own comment
   * describes.
   */
  it('breaks the ineligible count down by constraint axis', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.body.summary.ineligibleByAxis).toEqual([{ axis: 'other', count: 2 }]);
  });

  it('filters by verdict kind after the indexed query', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs?verdict=ineligible');
    expect(res.body.rows.length).toBeGreaterThan(0);
    for (const row of res.body.rows) expect(row.verdict.kind).toBe('ineligible');
    expect(res.body.total).toBe(2);
    // The census still describes the whole filtered corpus, not just this slice.
    expect(res.body.summary.total).toBe(5);
    expect(res.body.summary.eligible).toBe(3);
  });

  it('accepts more than one verdict kind at once', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs?verdict=eligible,unknown');
    expect(res.body.total).toBe(3);
    for (const row of res.body.rows) expect(row.verdict.kind).toBe('eligible');
  });

  /**
   * A verdict filter with no profile behind it must not silently answer "all of
   * them". There is no verdict to match, so the honest answer is an empty page
   * with the census still describing the corpus.
   */
  it('returns nothing for a verdict filter when no profile is applied', async () => {
    const res = await request(buildApp(db)).get('/api/programs?verdict=eligible');
    expect(res.body.rows).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.summary.total).toBe(5);
  });

  it('surfaces the raw constraint text for every ineligibility reason', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs?verdict=ineligible');
    let reasons = 0;
    for (const row of res.body.rows) {
      for (const reason of row.verdict.reasons) {
        reasons += 1;
        expect(typeof reason.rawText).toBe('string');
        expect(reason.rawText.length).toBeGreaterThan(0);
        expect(typeof reason.spec.axis).toBe('string');
      }
    }
    // Vacuity guard: a loop over zero rows would pass every assertion above.
    expect(reasons).toBe(2);
  });

  it('passes filters through to the indexed query', async () => {
    const res = await request(buildApp(db)).get('/api/programs?klass=ham_grant&sort=name');
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r: { program: { id: string } }) => r.program.id))
      .toEqual(['ardc-grants', 'arrl-club-grant']);
  });

  it('paginates the filtered corpus while the census keeps describing all of it', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs?sort=name&pageSize=2&page=2');
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(2);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.total).toBe(5);
    expect(res.body.summary.total).toBe(5);
  });

  it('carries lastVerifiedAt and status onto every row so the badges can render', async () => {
    const res = await request(buildApp(db)).get('/api/programs?q=chicago');
    const row = res.body.rows[0];
    expect(row.program.trust.lastVerifiedAt).toBe('2026-01-05T00:00:00.000Z');
    expect(row.program.trust.status).toBe('discontinued');
    expect(row.program.trust.staleMirrorWarning).toContain('7 or more third-party aggregators');
  });

  it('reports the next cycle and the funder name the row header needs', async () => {
    const res = await request(buildApp(db)).get('/api/programs?q=ardc');
    const row = res.body.rows[0];
    expect(row.funderName).toBe('Amateur Radio Digital Communications');
    // ARDC's next fixed date after NOW, closing 23:59 PDT — the same value
    // `reindex.test.ts` pins on the projection row this is read from.
    expect(row.nextClosesAt).toBe('2026-09-02T06:59:00.000Z');
    expect(row.nextIsEstimated).toBe(true);
  });

  it('marks the rows this user has starred', async () => {
    starProgram(db, 'u-member', 'ardc-grants', NOW);
    starProgram(db, 'u-other', 'arrl-club-grant', NOW);
    const res = await request(buildApp(db)).get('/api/programs');
    const watched = res.body.rows
      .filter((r: { watched: boolean }) => r.watched)
      .map((r: { program: { id: string } }) => r.program.id);
    expect(watched).toEqual(['ardc-grants']);
  });

  /**
   * ~553 records in the real corpus are stored evidence, not opportunities. The
   * rule is not reimplemented anywhere in this router — `reindexBrowse` applies
   * the single shared `isDoNotPublish` predicate — but the endpoint is where a
   * user would see the leak, so the endpoint is where it is asserted. Note the
   * suppressed record is deliberately `applicantEntities: ['individual']` here:
   * it would be ELIGIBLE for this student, so if it ever surfaced it would
   * surface at the top of the list.
   */
  it('never lists or counts a do_not_publish record', async () => {
    createProgramRepo(db).upsert(pastAwardProgram());
    reindexBrowse(db, NOW);
    seedStudentProfile(db);

    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.body.rows.map((r: { program: { id: string } }) => r.program.id))
      .not.toContain('ardc-past-award-2024');
    expect(res.body.total).toBe(5);
    expect(res.body.summary.total).toBe(5);
    expect(res.body.summary.eligible).toBe(3);
    // …and it is still stored. Suppression hides it; it does not destroy evidence.
    expect(createProgramRepo(db).get('ardc-past-award-2024')).toBeDefined();
  });

  it('raises the one error envelope when the route rejects the caller', async () => {
    const app = buildApp(db, MEMBER, {
      requireAuth: (_req, _res, next) => {
        next(new AppError('unauthorized', 'Sign in to continue.'));
      },
    });
    const res = await request(app).get('/api/programs');
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'unauthorized', message: 'Sign in to continue.' });
    expect(typeof res.body.requestId).toBe('string');
  });

  /**
   * A stored profile that no longer parses is a server-side fault, not a bad
   * request. Left to the default handler a `ZodError` becomes `validation_failed`
   * / 422 with the message "The request body is invalid.", which is a lie about
   * a request that was perfectly valid — so it is caught and restated.
   */
  it('answers the real envelope when a stored profile no longer parses', async () => {
    seedTestUser(db, 'u-member');
    db.prepare(
      `INSERT INTO profiles (id, user_id, kind, data, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('p-bad', 'u-member', 'student', '{"kind":"student","licenseClass":"WIZARD"}', NOW);

    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('internal');
    expect(res.body.error.message).toMatch(/profile/i);
  });
});

describe('GET /api/programs — an organization profile', () => {
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
   * The case the brief's own comment describes: a club that is not
   * ARRL-affiliated IS accepted as an applicant entity by the Club Grant, so the
   * entity gate lets it through and the `arrl_membership` constraint is what
   * excludes it. This is the axis breakdown doing the job spec §5 asks of it —
   * "here is the specific constraint for each".
   */
  it('breaks the ineligible count down by a real constraint axis', async () => {
    seedClubProfile(db);
    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.body.profileApplied).toBe('organization');
    expect(res.body.summary.ineligibleByAxis).toEqual([
      { axis: 'other', count: 4 },
      { axis: 'arrl_membership', count: 1 },
    ]);
    const clubGrant = res.body.rows.find(
      (r: { program: { id: string } }) => r.program.id === 'arrl-club-grant',
    );
    expect(clubGrant.verdict.reasons[0].rawText).toBe('Club must be ARRL-affiliated.');
  });

  it('honours an explicit profile preference when the user holds both', async () => {
    seedStudentProfile(db);
    seedClubProfile(db);
    const asStudent = await request(buildApp(db)).get('/api/programs');
    expect(asStudent.body.profileApplied).toBe('student');
    expect(asStudent.body.summary.eligible).toBe(3);

    const asClub = await request(buildApp(db)).get('/api/programs?profile=organization');
    expect(asClub.body.profileApplied).toBe('organization');
    expect(asClub.body.summary.ineligible).toBe(5);
  });

  it('ignores a profile preference the query string invented', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs?profile=wizard');
    expect(res.body.profileApplied).toBe('student');
  });
});

describe('GET /api/programs — verdicts a fuller profile would resolve', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    createProgramRepo(db).upsert(licenseGatedProgram());
    reindexBrowse(db, NOW);
    seedTestUser(db, 'u-member');
    db.prepare(
      `INSERT INTO profiles (id, user_id, kind, data, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('p-1', 'u-member', 'student', JSON.stringify({
      kind: 'student', callsign: 'W8UM', state: 'MI', accredited: true, partTime: false,
    }), NOW);
  });

  afterEach(() => {
    db.close();
  });

  /**
   * The ranking is the actionable half of the census: "fill in this one field
   * and 2 more verdicts resolve". Measured on unequal counts on purpose — a
   * corpus where every field appears once would pass any sort order.
   */
  it('ranks the profile fields that would resolve the most unknown verdicts', async () => {
    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.body.summary.unknown).toBe(3);
    expect(res.body.summary.unknownByField).toEqual([
      { field: 'licenseClass', count: 2 },
      { field: 'degreeLevel', count: 1 },
    ]);
    const fields = res.body.summary.unknownByField;
    for (let i = 1; i < fields.length; i += 1) {
      expect(fields[i - 1].count).toBeGreaterThanOrEqual(fields[i].count);
    }
  });

  it('names the missing fields on the row itself, not only in the census', async () => {
    const res = await request(buildApp(db)).get('/api/programs?verdict=unknown');
    expect(res.body.total).toBe(3);
    const row = res.body.rows.find(
      (r: { program: { id: string } }) => r.program.id === 'zeta-license-gated-award',
    );
    expect(row.verdict.missingProfileFields).toEqual(['licenseClass']);
  });

  /**
   * The governing asymmetry, made executable. A false include costs the
   * applicant one page-load of the funder's site; a false exclude hides an award
   * with no signal at all. Nothing here may answer `ineligible` merely because a
   * profile field is blank.
   */
  it('answers unknown, never ineligible, for a field the profile has simply not filled in', async () => {
    const res = await request(buildApp(db)).get('/api/programs');
    const byId = new Map(
      res.body.rows.map((r: { program: { id: string }; verdict: { kind: string } }) => [
        r.program.id,
        r.verdict.kind,
      ]),
    );
    expect(byId.get('arrl-foundation-scholarship')).toBe('unknown');
    expect(byId.get('zeta-license-gated-award')).toBe('unknown');
    expect(byId.get('qcwa-memorial-scholarship')).toBe('unknown');
    expect(res.body.summary.ineligible).toBe(2); // both are entity-gate exclusions
  });
});

describe('GET /api/programs — a preference the applicant meets', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    createProgramRepo(db).upsert(softPreferenceProgram());
    reindexBrowse(db, NOW);
    seedStudentProfile(db);
  });

  afterEach(() => {
    db.close();
  });

  it('counts a met soft constraint as preferred rather than merely eligible', async () => {
    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.body.summary.total).toBe(6);
    expect(res.body.summary.preferred).toBe(1);
    expect(res.body.summary.eligible).toBe(3);
    expect(res.body.summary.ineligible).toBe(2);
    expect(
      res.body.summary.eligible +
        res.body.summary.preferred +
        res.body.summary.ineligible +
        res.body.summary.unknown,
    ).toBe(6);
  });

  it('filters on the preferred kind and reports which constraints were met', async () => {
    const res = await request(buildApp(db)).get('/api/programs?verdict=eligible_preferred');
    expect(res.body.total).toBe(1);
    expect(res.body.rows[0].program.id).toBe('yotta-preference-award');
    expect(res.body.rows[0].verdict.met).toEqual(['yotta-license-preference']);
    expect(res.body.rows[0].verdict.rank).toBe(2);
  });
});

describe('GET /api/programs — the clock the verdicts are computed against', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    createProgramRepo(db).upsert(tenureGatedProgram());
    reindexBrowse(db, NOW);
    seedStudentProfile(db); // licensedSince 2023-05-01
  });

  afterEach(() => {
    db.close();
  });

  /**
   * `matchAll`'s third argument defaults to `new Date().toISOString()`. Left to
   * default, a licence-tenure verdict would be computed from the wall clock —
   * un-reproducible between two identical requests and untestable in principle.
   * Plan 3's rule is that every timestamp comes from `deps.now()`, and the only
   * way to assert a clock is used is to move it.
   */
  it('answers from the injected clock, not the wall clock', async () => {
    const verdictAt = async (now: string): Promise<string> => {
      const res = await request(buildApp(db, MEMBER, { now: () => now })).get('/api/programs');
      const row = res.body.rows.find(
        (r: { program: { id: string } }) => r.program.id === 'tenure-gated-award',
      );
      return row.verdict.kind;
    };

    // 2026-08-02: the licence is ~39 months old, short of the four-year floor.
    expect(await verdictAt(NOW)).toBe('ineligible');
    // 2027-06-01: 49 months. The same profile, the same corpus, a later clock.
    expect(await verdictAt('2027-06-01T00:00:00.000Z')).toBe('eligible');
  });
});

describe('GET /api/programs on a database that has only ever been migrated', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  /**
   * No fixture corpus, no reindex, no user row. Two of this repo's worst bugs
   * hid behind tests that hand-wrote the row the product failed to create, so
   * the empty case is asserted from a database that has only ever been migrated.
   */
  it('answers an empty page and an empty census instead of failing', async () => {
    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.profileApplied).toBeNull();
    expect(res.body.summary.total).toBe(0);
  });

  /**
   * A projection row whose program has been deleted must not become a 500 and
   * must not be counted. `hydratePrograms` already skips it; the census, the
   * total and the page are all derived from what actually hydrated so that the
   * three cannot disagree.
   */
  it('drops a stale projection row rather than throwing on the hydration miss', async () => {
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
    seedStudentProfile(db);
    db.prepare('DELETE FROM programs WHERE id = ?').run('arrl-foundation-scholarship');

    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.summary.total).toBe(4);
    expect(res.body.summary.eligible).toBe(2);
    expect(res.body.rows.map((r: { program: { id: string } }) => r.program.id))
      .not.toContain('arrl-foundation-scholarship');
  });
});
