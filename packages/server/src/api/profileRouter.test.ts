import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { arrlScholarship, seedFixtureCorpus, seedTestUser } from '../test/fixtures/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
import { reindexBrowse } from './reindex.js';
import { createProfileRouter, createMeRouter } from './profileRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
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
  app.use('/api/profiles', createProfileRouter(deps));
  app.use('/api/me', createMeRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

describe('profiles API', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    // The `users` row IS required (RESOLUTIONS R19): neither router reads it —
    // the session user arrives through deps.currentUser — but `profiles.user_id`
    // is REFERENCES users(id) ON DELETE CASCADE in Plan 1's 001-init.sql and
    // foreign keys are ON, so PUT /api/profiles/student fails without it.
    // seedTestUser fills Plan 1's NOT NULL / UNIQUE columns (email_normalized,
    // password_hash, ics_token) for a pinned id.
    seedTestUser(db, 'u-member');
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('returns both profile slots as null before anything is saved', async () => {
    const res = await request(buildApp(db)).get('/api/profiles');
    expect(res.status).toBe(200);
    expect(res.body.student).toBeNull();
    expect(res.body.organization).toBeNull();
  });

  it('saves a student profile and reads it back', async () => {
    const app = buildApp(db);
    const put = await request(app)
      .put('/api/profiles/student')
      .send({ kind: 'student', callsign: 'K5UTD', licenseClass: 'EXTRA', state: 'TX' });
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/profiles');
    expect(get.body.student.callsign).toBe('K5UTD');
  });

  it('lets one user hold both a student and an organization profile', async () => {
    const app = buildApp(db);
    await request(app).put('/api/profiles/student').send({ kind: 'student', callsign: 'K5UTD' });
    await request(app)
      .put('/api/profiles/organization')
      .send({ kind: 'organization', entity: 'club_501c3', orgName: 'Example University ARC' });
    const get = await request(app).get('/api/profiles');
    expect(get.body.student.callsign).toBe('K5UTD');
    expect(get.body.organization.orgName).toBe('Example University ARC');
  });

  it('rejects a body whose kind does not match the route, with 422 not 400', async () => {
    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .send({ kind: 'organization', entity: 'club_501c3' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toMatch(/kind/i);
  });

  it('rejects an unknown profile kind in the path', async () => {
    const res = await request(buildApp(db)).put('/api/profiles/robot').send({ kind: 'student' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('rejects a profile that fails the core zod schema, and returns the issues as details', async () => {
    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .send({ kind: 'student', licenseClass: 'SUPER_EXTRA' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('returns the completeness report alongside the saved profile', async () => {
    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .send({ kind: 'student', callsign: 'K5UTD' });
    expect(res.body.completeness.total).toBe(5);
    expect(typeof res.body.completeness.score).toBe('number');
  });

  /**
   * Found by Task 26's end-to-end seed, which is the first thing in this repo to put the corpus's
   * 553 suppressed records in front of the API at the same time as its 150 publishable ones. The
   * meter then read `58 of 703` and a completeness of 92%, where the same profile against the
   * records a user can actually reach is `58 of 150` and 61%. A stored-evidence record is a past
   * award with no constraints, so it matches trivially and can only ever inflate the score.
   */
  it('measures completeness against the publishable corpus, not the records the product hides', async () => {
    createProgramRepo(db).upsert({
      ...arrlScholarship,
      id: 'arrl-foundation-2019-award',
      name: 'ARRL Foundation — 2019 award (stored evidence, not an opportunity)',
      tags: [...arrlScholarship.tags, DO_NOT_PUBLISH_TAG],
    });

    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .send({ kind: 'student', callsign: 'K5UTD' });
    expect(res.body.completeness.total).toBe(5);

    const me = await request(buildApp(db)).get('/api/me');
    expect(me.body.completeness.total).toBe(5);
    const listed = await request(buildApp(db)).get('/api/profiles');
    expect(listed.body.completeness.total).toBe(5);
  });
});

describe('GET /api/me', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
    // DEVIATION FROM THE TASK BRIEF (2026-08-03). The brief's comment here read:
    // "No `users` row is inserted: Plan 1's `users` table has NOT NULL
    // `email_normalized`, `password_hash` and `ics_token`, and neither router
    // under test reads it — the session user arrives through deps.currentUser."
    //
    // Both halves are true and the conclusion is still wrong. The second test in
    // this block PUTs a profile, and `profiles.user_id` is
    // `REFERENCES users(id) ON DELETE CASCADE` with `PRAGMA foreign_keys = ON`,
    // so the INSERT dies inside the route and the request comes back 500:
    //   FOREIGN KEY constraint failed
    //   [profiles API > reflects a saved profile] expected false to be true
    // Reproduced by running the brief verbatim; see task-6-report.md. What the
    // routers read is not what the schema requires, which is the whole reason
    // RESOLUTIONS R19 exists.
    seedTestUser(db, 'u-member');
  });

  afterEach(() => {
    db.close();
  });

  it('returns the session user, role, and which profiles exist', async () => {
    const res = await request(buildApp(db)).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: 'u-member',
      email: 'member@example.com',
      role: 'member',
    });
    expect(res.body.hasStudentProfile).toBe(false);
    expect(res.body.hasOrgProfile).toBe(false);
  });

  it('reflects a saved profile', async () => {
    const app = buildApp(db);
    await request(app).put('/api/profiles/student').send({ kind: 'student', callsign: 'K5UTD' });
    const res = await request(app).get('/api/me');
    expect(res.body.hasStudentProfile).toBe(true);
    expect(res.body.completeness.total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Beyond the brief. The brief's nine assertions never open the database after a
// write, never exercise the auth seam, and never put an applicant through the
// API who is not a full-time degree student.
// ---------------------------------------------------------------------------

describe('profiles API, beyond the brief', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    seedTestUser(db, 'u-member');
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  function storedRows(): Array<{ kind: string; data: string; updated_at: string }> {
    return db
      .prepare('SELECT kind, data, updated_at FROM profiles WHERE user_id = ? ORDER BY kind')
      .all('u-member') as Array<{ kind: string; data: string; updated_at: string }>;
  }

  it('stamps the row with the injected clock, never with the wall clock', async () => {
    await request(buildApp(db)).put('/api/profiles/student').send({ kind: 'student' });
    expect(storedRows()).toEqual([
      { kind: 'student', data: '{"kind":"student"}', updated_at: NOW },
    ]);
  });

  it('updates the one row in place instead of accumulating a history', async () => {
    const app = buildApp(db);
    await request(app).put('/api/profiles/student').send({ kind: 'student', callsign: 'K5UTD' });
    await request(app).put('/api/profiles/student').send({ kind: 'student', callsign: 'W8UM' });
    const rows = storedRows();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.data).callsign).toBe('W8UM');
  });

  it('stores only fields CONTRACT §3 defines, dropping anything else the client sent', async () => {
    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .send({ kind: 'student', callsign: 'K5UTD', isAdmin: true, notes: 'x'.repeat(100) });
    expect(res.status).toBe(200);
    expect(res.body.profile).toEqual({ kind: 'student', callsign: 'K5UTD' });
    expect(storedRows()[0]!.data).toBe('{"kind":"student","callsign":"K5UTD"}');
  });

  it('raises unauthorized through the shared envelope when requireAuth refuses', async () => {
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware());
    app.use(
      '/api/profiles',
      createProfileRouter({
        db,
        now: () => NOW,
        requireAuth: (_req, _res, next) => next(new AppError('unauthorized', 'Sign in first.')),
        requireAdmin: (_req, _res, next) => next(),
        currentUser: () => MEMBER,
      }),
    );
    app.use(errorHandler({ logger: () => undefined }));

    const res = await request(app).get('/api/profiles');
    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({ code: 'unauthorized', message: 'Sign in first.' });
    expect(typeof res.body.requestId).toBe('string');
    expect(storedRows()).toEqual([]);
  });

  it('rejects a body that is not an object at all, with 422 rather than a crash', async () => {
    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .set('content-type', 'application/json')
      .send('[]');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toMatch(/does not match the route kind/i);
  });

  it('leaves a body that is not JSON at all to Plan 1s parser, still in the envelope', async () => {
    // express.json() is strict by default: a bare scalar never reaches the
    // handler, and errors.ts already maps its parse failure to `bad_request`.
    // Pinned so a later reader does not "fix" this route into a second, private
    // opinion about malformed JSON.
    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .set('content-type', 'application/json')
      .send('"student"');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(typeof res.body.requestId).toBe('string');
  });

  it('reports the empty corpus-wide meter before any profile exists', async () => {
    const res = await request(buildApp(db)).get('/api/profiles');
    expect(res.body.completeness).toEqual({
      total: 5,
      unknownCount: 5,
      score: 0,
      fields: [],
    });
  });

  it('answers a sparse student with questions, not with bars', async () => {
    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .send({ kind: 'student', callsign: 'K5UTD' });
    expect(res.body.completeness).toEqual({
      total: 5,
      unknownCount: 2,
      score: 60,
      fields: [
        { field: 'degreeLevel', resolves: 1 },
        { field: 'licenseClass', resolves: 1 },
      ],
    });
  });

  it('round-trips a licensed adult returning to school part-time', async () => {
    const app = buildApp(db);
    const put = await request(app).put('/api/profiles/student').send({
      kind: 'student',
      callsign: 'K0EPE',
      licenseClass: 'GENERAL',
      degreeLevel: 'BACH',
      accredited: true,
      partTime: true,
      stage: 'RETRAINING_ADULT',
    });
    expect(put.status).toBe(200);
    expect(put.body.profile.partTime).toBe(true);
    // Stated part-time study is a fact, so the corpus can judge every record.
    expect(put.body.completeness.unknownCount).toBe(0);
    const get = await request(app).get('/api/profiles');
    expect(get.body.student.stage).toBe('RETRAINING_ADULT');
  });

  it('round-trips a certificate/trade-school student', async () => {
    const res = await request(buildApp(db)).put('/api/profiles/student').send({
      kind: 'student',
      licenseClass: 'TECH',
      degreeLevel: 'CERT',
      accredited: true,
      partTime: false,
      fieldOfStudy: 'Electronics Technology',
    });
    expect(res.status).toBe(200);
    expect(res.body.profile.degreeLevel).toBe('CERT');
  });

  it('round-trips a school applying as an organisation', async () => {
    const app = buildApp(db);
    const put = await request(app).put('/api/profiles/organization').send({
      kind: 'organization',
      entity: 'school_lea',
      orgName: 'Example Unified School District',
      state: 'MI',
    });
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/profiles');
    expect(get.body.organization.entity).toBe('school_lea');
    expect(get.body.student).toBeNull();
  });

  it('meters an organisation-only user against the org-facing corpus', async () => {
    const app = buildApp(db);
    await request(app)
      .put('/api/profiles/organization')
      .send({ kind: 'organization', entity: 'club_501c3', orgName: 'Example University ARC' });

    const profiles = await request(app).get('/api/profiles');
    expect(profiles.body.completeness).toEqual({
      total: 5,
      unknownCount: 1,
      score: 80,
      fields: [{ field: 'arrlAffiliated', resolves: 1 }],
    });

    const me = await request(app).get('/api/me');
    expect(me.body.hasStudentProfile).toBe(false);
    expect(me.body.hasOrgProfile).toBe(true);
    expect(me.body.completeness.score).toBe(80);
  });

  it('prefers the student profile for the meter when a user holds both', async () => {
    const app = buildApp(db);
    await request(app)
      .put('/api/profiles/organization')
      .send({ kind: 'organization', entity: 'club_501c3' });
    await request(app).put('/api/profiles/student').send({ kind: 'student' });

    const me = await request(app).get('/api/me');
    expect(me.body.hasStudentProfile).toBe(true);
    expect(me.body.hasOrgProfile).toBe(true);
    expect(me.body.completeness.score).toBe(60);
  });

  /**
   * One report, up to two profiles. Until `completenessFor` existed the
   * response could not say which profile the 60 belonged to, so the only way
   * for a client to label the meter was to rebuild `PROFILE_KIND_PRIORITY` in
   * the browser — a second definition of the preference order, and the reason
   * `loadActiveProfile` is re-read above rather than picked out of `profiles`.
   */
  describe('completenessFor names the profile the meter speaks for', () => {
    it('is null when the user holds no profile at all', async () => {
      const app = buildApp(db);
      expect((await request(app).get('/api/me')).body.completenessFor).toBeNull();
      expect((await request(app).get('/api/profiles')).body.completenessFor).toBeNull();
    });

    it('names the only profile a single-profile user holds', async () => {
      const app = buildApp(db);
      await request(app)
        .put('/api/profiles/organization')
        .send({ kind: 'organization', entity: 'club_501c3' });

      expect((await request(app).get('/api/me')).body.completenessFor).toBe('organization');
      expect((await request(app).get('/api/profiles')).body.completenessFor).toBe('organization');
    });

    it('names student, and only student, when the user holds both', async () => {
      const app = buildApp(db);
      await request(app)
        .put('/api/profiles/organization')
        .send({ kind: 'organization', entity: 'club_501c3' });
      await request(app).put('/api/profiles/student').send({ kind: 'student' });

      const me = await request(app).get('/api/me');
      expect(me.body.completenessFor).toBe('student');
      // The organisation profile exists and was NOT evaluated. Both facts are
      // in the response, so a client can say so instead of implying the score
      // covers it.
      expect(me.body.hasOrgProfile).toBe(true);
    });

    it('names the profile just saved on a PUT, not the one the default order would pick', async () => {
      const app = buildApp(db);
      await request(app).put('/api/profiles/student').send({ kind: 'student' });
      const put = await request(app)
        .put('/api/profiles/organization')
        .send({ kind: 'organization', entity: 'club_501c3' });

      expect(put.body.completenessFor).toBe('organization');
      // …while the unscoped meter still speaks for the student profile.
      expect((await request(app).get('/api/me')).body.completenessFor).toBe('student');
    });
  });

  /**
   * Until now, a user holding both profiles could only ever see the priority
   * (student) meter from GET /api/profiles — the PUT reply was the only
   * response that ever named the other one, so an org-only interest could
   * only be measured by saving it. `?profile=` is spelled to match the query
   * param `GET /api/programs` already reads (`req.query.profile`, gated by
   * `isProfileKind`) — one spelling for "which profile did you mean", not two.
   */
  describe('GET /api/profiles accepts ?profile= to see the non-priority meter', () => {
    async function seedBoth(app: import('express').Express): Promise<void> {
      await request(app)
        .put('/api/profiles/organization')
        .send({ kind: 'organization', entity: 'club_501c3', orgName: 'Example University ARC' });
      await request(app).put('/api/profiles/student').send({ kind: 'student', callsign: 'K5UTD' });
    }

    it('reports the priority profile by default, and the other one when asked, for a dual-profile user', async () => {
      const app = buildApp(db);
      await seedBoth(app);

      const byDefault = await request(app).get('/api/profiles');
      expect(byDefault.status).toBe(200);
      expect(byDefault.body.completenessFor).toBe('student');
      expect(byDefault.body.completeness.score).toBe(60);
      // Held, but not the one the meter speaks for — a client can say so.
      expect(byDefault.body.organization).not.toBeNull();

      const preferred = await request(app).get('/api/profiles?profile=organization');
      expect(preferred.status).toBe(200);
      expect(preferred.body.completenessFor).toBe('organization');
      expect(preferred.body.completeness.score).toBe(80);
      // Still held, still returned, just not what this report was measured against.
      expect(preferred.body.student).not.toBeNull();
    });

    it('does not fabricate a profile the user does not hold', async () => {
      const app = buildApp(db);
      await request(app).put('/api/profiles/student').send({ kind: 'student', callsign: 'K5UTD' });

      const res = await request(app).get('/api/profiles?profile=organization');
      expect(res.status).toBe(200);
      expect(res.body.completenessFor).toBeNull();
      expect(res.body.organization).toBeNull();
      expect(res.body.completeness).toEqual({
        total: 5,
        unknownCount: 5,
        score: 0,
        fields: [],
      });
    });

    it('rejects an unknown profile kind in the query as validation_failed / 422, not a silent fallback', async () => {
      const res = await request(buildApp(db)).get('/api/profiles?profile=robot');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
      expect(typeof res.body.requestId).toBe('string');
    });

    it('leaves the no-preference response exactly as before', async () => {
      const app = buildApp(db);
      await seedBoth(app);
      const res = await request(app).get('/api/profiles');
      expect(res.body.completenessFor).toBe('student');
      expect(res.body.completeness.score).toBe(60);
      expect(res.body.student).not.toBeNull();
      expect(res.body.organization).not.toBeNull();
    });
  });
});
