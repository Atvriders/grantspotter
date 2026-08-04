import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import {
  seedFixtureCorpus,
  seedTestUser,
  funders,
  ardcGrants,
} from '../test/fixtures/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
import { reindexBrowse } from './reindex.js';
import { createWatchRouter, watchedProgramIds, watchersOfProgram } from './watchRouter.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database, user: SessionUser = MEMBER) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/watches', createWatchRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

describe('watchlist API', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    // `watches.user_id` is REFERENCES users(id) ON DELETE CASCADE (Plan 1
    // 001-init.sql) and foreign keys are ON, so the two session users these
    // tests impersonate need real rows (RESOLUTIONS R19).
    seedTestUser(db, 'u-member');
    seedTestUser(db, 'u-other');
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('starts empty', async () => {
    const res = await request(buildApp(db)).get('/api/watches');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
  });

  it('stars a program and returns it hydrated with its next deadline', async () => {
    const app = buildApp(db);
    const post = await request(app)
      .post('/api/watches')
      .send({ programId: 'arrl-foundation-scholarship' });
    expect(post.status).toBe(201);
    const get = await request(app).get('/api/watches');
    expect(get.body.rows).toHaveLength(1);
    expect(get.body.rows[0].program.id).toBe('arrl-foundation-scholarship');
    expect(get.body.rows[0].nextClosesAt).toBe('2026-12-30T17:00:00.000Z');
    // The watchlist reads the SAME projection browse does, so it inherited the same
    // no-timezone defect and is fixed by the same column (migration 037).
    expect(get.body.rows[0].nextTimezone).toBe('America/New_York');
  });

  it('is idempotent — starring twice leaves one row', async () => {
    const app = buildApp(db);
    await request(app).post('/api/watches').send({ programId: 'ardc-grants' });
    const second = await request(app).post('/api/watches').send({ programId: 'ardc-grants' });
    expect(second.status).toBe(201);
    expect(watchedProgramIds(db, 'u-member')).toEqual(['ardc-grants']);
  });

  it('rejects starring a program that does not exist', async () => {
    const res = await request(buildApp(db)).post('/api/watches').send({ programId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('rejects a POST with no programId as bad_request, not validation_failed', async () => {
    const res = await request(buildApp(db)).post('/api/watches').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('unstars', async () => {
    const app = buildApp(db);
    await request(app).post('/api/watches').send({ programId: 'ardc-grants' });
    const del = await request(app).delete('/api/watches/ardc-grants');
    expect(del.status).toBe(204);
    expect(watchedProgramIds(db, 'u-member')).toEqual([]);
  });

  it('unstarring something not starred is not an error', async () => {
    const res = await request(buildApp(db)).delete('/api/watches/ardc-grants');
    expect(res.status).toBe(204);
  });

  it('keeps one user’s watchlist out of another’s', async () => {
    const other: SessionUser = { id: 'u-other', email: 'other@example.com', role: 'member' };
    await request(buildApp(db)).post('/api/watches').send({ programId: 'ardc-grants' });
    const res = await request(buildApp(db, other)).get('/api/watches');
    expect(res.body.rows).toEqual([]);
  });

  it('lists every watcher of a program, which is what the fan-out needs', async () => {
    const other: SessionUser = { id: 'u-other', email: 'other@example.com', role: 'member' };
    await request(buildApp(db)).post('/api/watches').send({ programId: 'ardc-grants' });
    await request(buildApp(db, other)).post('/api/watches').send({ programId: 'ardc-grants' });
    expect(watchersOfProgram(db, 'ardc-grants').sort()).toEqual(['u-member', 'u-other']);
  });

  it('sorts the watchlist by next deadline, undated last', async () => {
    const app = buildApp(db);
    await request(app).post('/api/watches').send({ programId: 'arrl-club-grant' });
    await request(app).post('/api/watches').send({ programId: 'arrl-foundation-scholarship' });
    const res = await request(app).get('/api/watches');
    expect(res.body.rows.map((r: { program: { id: string } }) => r.program.id))
      .toEqual(['arrl-foundation-scholarship', 'arrl-club-grant']);
  });

  /**
   * ADDED BEYOND THE BRIEF (2026-08-03). Spec §11.2: a star is a subscription to
   * CHANGE EVENTS, so the one thing the watchlist must never do is delete or hide
   * a watch because the programme stopped being interesting. Every one of the
   * seven `trust.status` values in the corpus is reachable by a watched record —
   * `open` 10, `unknown` 118, `contact_only` 7, `no_application` 7, `closed` 5,
   * `discontinued` 2, `dormant` 1 — and a status change is precisely the event
   * the user starred the programme to hear about.
   */
  describe('a watch survives its programme changing state', () => {
    it('keeps the watch, and reports the new status, when a programme closes', async () => {
      const app = buildApp(db);
      await request(app).post('/api/watches').send({ programId: 'ardc-grants' });

      createProgramRepo(db).upsert({
        ...ardcGrants,
        trust: { ...ardcGrants.trust, status: 'closed' },
      });
      reindexBrowse(db, NOW);

      const res = await request(app).get('/api/watches');
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].program.id).toBe('ardc-grants');
      expect(res.body.rows[0].program.trust.status).toBe('closed');
      expect(watchedProgramIds(db, 'u-member')).toEqual(['ardc-grants']);
    });

    it('lists a programme whose status was never `open` in the first place', async () => {
      const app = buildApp(db);
      // `chicago-fm-club-scholarship` is `discontinued`; `arrl-club-grant` is
      // `unknown`. Both are watchable and both must render.
      await request(app).post('/api/watches').send({ programId: 'chicago-fm-club-scholarship' });
      const res = await request(app).get('/api/watches');
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].program.trust.status).toBe('discontinued');
    });

    it('keeps a watch whose programme the browse projection has not caught up with', async () => {
      // The projection is rebuilt wholesale by `reindexBrowse`; between an
      // approval and the next rebuild a watched programme has no `program_search`
      // row at all. Reading the watchlist straight off the projection would make
      // the star disappear for that window.
      const app = buildApp(db);
      await request(app).post('/api/watches').send({ programId: 'ardc-grants' });
      db.exec('DELETE FROM program_search');

      const res = await request(app).get('/api/watches');
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].program.id).toBe('ardc-grants');
      expect(res.body.rows[0].funderName).toBe('Amateur Radio Digital Communications');
      expect(res.body.rows[0].nextClosesAt).toBeNull();
      // No projection row means no date AND no zone. The fallback path must not
      // supply a frame for a deadline it does not have.
      expect(res.body.rows[0].nextTimezone).toBeNull();
    });

    it('hides — but never deletes — a watch on a record that becomes do_not_publish', async () => {
      // The one status-like transition that DOES remove a row from the rendered
      // list, because `isDoNotPublish` is the corpus-wide suppression predicate
      // (~553 stored-but-unpublishable records) and Task 3 pinned zero of them
      // reachable through any read surface. The `watches` row itself is left
      // alone, so Task 8 can still fan a change event out to its watchers and the
      // star reappears the moment the record is publishable again.
      const app = buildApp(db);
      await request(app).post('/api/watches').send({ programId: 'ardc-grants' });

      createProgramRepo(db).upsert({
        ...ardcGrants,
        tags: [...ardcGrants.tags, DO_NOT_PUBLISH_TAG],
      });
      reindexBrowse(db, NOW);

      const res = await request(app).get('/api/watches');
      expect(res.body.rows).toEqual([]);
      expect(watchedProgramIds(db, 'u-member')).toEqual(['ardc-grants']);
      expect(watchersOfProgram(db, 'ardc-grants')).toEqual(['u-member']);
    });

    it('drops the watch only when the programme itself is deleted, via Plan 1’s cascade', async () => {
      const app = buildApp(db);
      await request(app).post('/api/watches').send({ programId: 'ardc-grants' });
      db.prepare('DELETE FROM programs WHERE id = ?').run('ardc-grants');
      expect(watchedProgramIds(db, 'u-member')).toEqual([]);
    });
  });

  it('starring subscribes to changes — notify_changes lands on Plan 1’s DEFAULT 1', async () => {
    await request(buildApp(db)).post('/api/watches').send({ programId: 'ardc-grants' });
    const row = db
      .prepare('SELECT notify_changes, created_at FROM watches WHERE user_id = ? AND program_id = ?')
      .get('u-member', 'ardc-grants') as { notify_changes: number; created_at: string };
    expect(row.notify_changes).toBe(1);
    expect(row.created_at).toBe(NOW);
  });

  it('rejects a blank or non-string programId', async () => {
    const app = buildApp(db);
    for (const body of [{ programId: '' }, { programId: 42 }, { programId: null }]) {
      const res = await request(app).post('/api/watches').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
    }
  });

  /**
   * ADDED 2026-08-04, not in the brief. THE EXISTENCE ORACLE.
   *
   * `POST /api/watches` tested existence with `SELECT 1 FROM programs`, so a
   * suppressed id answered `201 {watched:true}` while a bogus id answered 404.
   * Two requests and a status code therefore enumerated all ~553 records the
   * product refuses to show — the same set the detail route, browse, the
   * calendar and the watchlist all go to some trouble to hide — and the star it
   * minted was inert: `loadRows` drops it through `isDoNotPublish`, so nothing
   * ever rendered it and no change event was ever announced for it. The 201 said
   * nothing except "this id is real", which is the one fact being withheld.
   *
   * The distinguishing signal is the whole defect, so the assertion is that the
   * two answers are the SAME, not merely that one of them is a 404.
   */
  describe('the suppression boundary on POST', () => {
    const SUPPRESSED_ID = 'ardc-grants--past-award-2019-already-paid';

    beforeEach(() => {
      createProgramRepo(db).upsert({
        ...ardcGrants,
        id: SUPPRESSED_ID,
        name: 'ARDC — 2019 grant, already awarded and paid',
        tags: [...ardcGrants.tags, 'past_award', DO_NOT_PUBLISH_TAG],
      });
      reindexBrowse(db, NOW);
    });

    it('answers a suppressed id exactly as a nonexistent one, and stars neither', async () => {
      const app = buildApp(db);
      const suppressed = await request(app).post('/api/watches').send({ programId: SUPPRESSED_ID });
      const absent = await request(app).post('/api/watches').send({ programId: 'no-such-program' });

      expect(suppressed.status).toBe(404);
      expect(suppressed.status).toBe(absent.status);
      expect(suppressed.body.error.code).toBe(absent.body.error.code);
      // Same sentence too, once the id inside it is normalised away.
      expect(suppressed.body.error.message.replace(SUPPRESSED_ID, 'X'))
        .toBe(absent.body.error.message.replace('no-such-program', 'X'));

      // No row was written for EITHER. A `watches` row would be a second, slower
      // oracle for anyone who can read back their own watchlist.
      expect(watchedProgramIds(db, 'u-member')).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM watches').get()).toEqual({ n: 0 });
    });

    it('still stars the publishable sibling — this is suppression, not breakage', async () => {
      const res = await request(buildApp(db)).post('/api/watches').send({ programId: 'ardc-grants' });
      expect(res.status).toBe(201);
      expect(watchedProgramIds(db, 'u-member')).toEqual(['ardc-grants']);
    });
  });

  it('leaves the funder of a watched programme intact for display', async () => {
    // `funderName` comes from the projection when it is fresh and from `funders`
    // when it is not; both paths must name the same funder.
    const app = buildApp(db);
    await request(app).post('/api/watches').send({ programId: 'arrl-foundation-scholarship' });
    const fresh = await request(app).get('/api/watches');
    db.exec('DELETE FROM program_search');
    const stale = await request(app).get('/api/watches');
    const expected = funders.find((f) => f.id === 'arrl-foundation')?.name;
    expect(fresh.body.rows[0].funderName).toBe(expected);
    expect(stale.body.rows[0].funderName).toBe(expected);
  });

  it('is one query helper per direction, and both agree', async () => {
    const other: SessionUser = { id: 'u-other', email: 'other@example.com', role: 'member' };
    await request(buildApp(db)).post('/api/watches').send({ programId: 'ardc-grants' });
    await request(buildApp(db)).post('/api/watches').send({ programId: 'arrl-club-grant' });
    await request(buildApp(db, other)).post('/api/watches').send({ programId: 'ardc-grants' });

    expect(watchedProgramIds(db, 'u-member').sort()).toEqual(['ardc-grants', 'arrl-club-grant']);
    expect(watchedProgramIds(db, 'u-other')).toEqual(['ardc-grants']);
    expect(watchersOfProgram(db, 'ardc-grants').sort()).toEqual(['u-member', 'u-other']);
    expect(watchersOfProgram(db, 'arrl-club-grant')).toEqual(['u-member']);
    expect(watchersOfProgram(db, 'chicago-fm-club-scholarship')).toEqual([]);
  });
});
