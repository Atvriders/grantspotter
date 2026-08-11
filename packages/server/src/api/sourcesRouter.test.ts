import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { createSourcesRouter, sourceHealth } from './sourcesRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { CrawlRunSummary, CrawlTrigger, RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };
const ADMIN: SessionUser = { id: 'u-admin', email: 'admin@example.com', role: 'admin' };

const OK_SUMMARY: CrawlRunSummary[] = [
  { sourceId: 'arrl-scholarship-descriptions', parsedCount: 111, events: 2, reviewItems: 2 },
];

function buildApp(
  db: Database.Database,
  user: SessionUser,
  crawl: CrawlTrigger = async () => OK_SUMMARY,
) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => {
      next(user.role === 'admin' ? undefined : new AppError('forbidden', 'Admin role required.'));
    },
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/sources', createSourcesRouter(deps, crawl));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

/**
 * `klass` and `enabled` are listed because Plan 1's `sources` DDL declares
 * `klass TEXT NOT NULL`; omitting it fails the insert rather than defaulting.
 */
function insertSource(
  db: Database.Database,
  patch: Partial<{
    id: string;
    label: string;
    tier: string;
    klass: string;
    funder_id: string;
    enabled: number;
    last_polled_at: string | null;
    last_success_at: string | null;
    consecutive_failures: number;
    last_record_count: number | null;
    baseline_record_count: number | null;
    expected_min_records: number;
    last_error: string | null;
  }> = {},
) {
  const row = {
    id: 'arrl-scholarship-descriptions',
    label: 'ARRL scholarship catalog',
    tier: 'C',
    klass: 'ham_scholarship',
    funder_id: 'arrl-foundation',
    enabled: 1,
    last_polled_at: '2026-08-02T03:17:00.000Z',
    last_success_at: '2026-08-02T03:17:00.000Z',
    consecutive_failures: 0,
    last_record_count: 111,
    baseline_record_count: null as number | null,
    expected_min_records: 100,
    last_error: null as string | null,
    ...patch,
  };
  db.prepare(
    `INSERT INTO sources
       (id, label, tier, klass, funder_id, enabled, last_polled_at, last_success_at,
        consecutive_failures, last_record_count, baseline_record_count, expected_min_records,
        last_error)
     VALUES (@id, @label, @tier, @klass, @funder_id, @enabled, @last_polled_at, @last_success_at,
             @consecutive_failures, @last_record_count, @baseline_record_count,
             @expected_min_records, @last_error)`,
  ).run(row);
  return row;
}

describe('sourceHealth', () => {
  it('is healthy when the yield meets the baseline and nothing failed', () => {
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-08-02T03:17:00.000Z',
        consecutiveFailures: 0,
        lastRecordCount: 111,
        baselineRecordCount: 111,
        lastError: null,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('healthy');
  });

  it('alarms when a source that normally yields records yields none', () => {
    // DEVIATION FROM THE BRIEF (2026-08-04). The brief satisfied this
    // assertion by hardcoding the string "(baseline 111 for the ARRL catalog)"
    // into the generic yield_dropped message, so NCDXF's alarm would have
    // claimed a baseline of 111 records it has never had. The number the
    // operator needs is THIS source's own last good count, so it is an input.
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-08-02T03:17:00.000Z',
        consecutiveFailures: 0,
        lastRecordCount: 0,
        baselineRecordCount: 111,
        lastError: null,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('yield_dropped');
    expect(health.detail).toContain('111');
  });

  it('names no baseline it does not have', () => {
    // The alarm still fires without a recorded baseline; it just does not
    // invent one. `sources.baseline_record_count` is nullable and no writer
    // fills it today, so this is the common case in production.
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-08-02T03:17:00.000Z',
        consecutiveFailures: 0,
        lastRecordCount: 0,
        baselineRecordCount: null,
        lastError: null,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('yield_dropped');
    expect(health.detail).toContain('100');
    expect(health.detail).not.toContain('111');
  });

  it('treats an empty scrape as idle when the source expects zero', () => {
    // grants.austinhams.org shows "No opportunities available" Aug 1 - Apr 30.
    // That is the site working correctly, not the parser breaking.
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-08-02T03:17:00.000Z',
        consecutiveFailures: 0,
        lastRecordCount: 0,
        baselineRecordCount: null,
        lastError: null,
        expectedMinRecords: 0,
      },
      NOW,
    );
    expect(health.state).toBe('idle');
  });

  it('distinguishes idle from never_polled — absence of activity is not a broken pipeline', () => {
    const idle = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-08-02T03:17:00.000Z',
        consecutiveFailures: 0,
        lastRecordCount: 0,
        baselineRecordCount: null,
        lastError: null,
        expectedMinRecords: 0,
      },
      NOW,
    );
    const never = sourceHealth(
      {
        lastPolledAt: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        lastRecordCount: null,
        baselineRecordCount: null,
        lastError: null,
        expectedMinRecords: 0,
      },
      NOW,
    );
    expect(idle.state).not.toBe(never.state);
    expect(idle.detail).not.toBe(never.detail);
  });

  it('is failing after consecutive failures', () => {
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-07-20T03:17:00.000Z',
        consecutiveFailures: 3,
        lastRecordCount: 111,
        baselineRecordCount: 111,
        lastError: null,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('failing');
    expect(health.detail).toContain('3');
  });

  it('says WHY it is failing, not only how often — the operator acts on the reason', () => {
    // `sources.last_error` after `crawl/runner.ts` recorded a refusal. Without this, the page
    // showed a count of failures and nothing else, which is the one fact the Failures column
    // already carries and none of the fact somebody opened this page for.
    const refused =
      'HTTP 403 for https://students.ieee.org/topics/submit-your-student-branch-annual-plan/ ' +
      '— the site refused us, so no page was read. This is a refusal, not an empty page.';
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-07-20T03:17:00.000Z',
        consecutiveFailures: 1,
        lastRecordCount: 1,
        baselineRecordCount: 1,
        lastError: refused,
        expectedMinRecords: 1,
      },
      NOW,
    );
    expect(health.state).toBe('failing');
    expect(health.detail).toContain('HTTP 403');
    expect(health.detail).toContain('students.ieee.org');
    expect(health.detail).toContain('refusal, not an empty page');
    // Singular, because this is the first night. "1 consecutive failures" is the kind of sentence
    // that tells a reader nobody looked at this screen.
    expect(health.detail).toContain('1 consecutive failure since');
  });

  it('is stale when nothing has succeeded in more than seven days', () => {
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-07-01T03:17:00.000Z',
        consecutiveFailures: 0,
        lastRecordCount: 111,
        baselineRecordCount: 111,
        lastError: null,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('stale');
  });

  it('is never_polled before the first crawl', () => {
    const health = sourceHealth(
      {
        lastPolledAt: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        lastRecordCount: null,
        baselineRecordCount: null,
        lastError: null,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('never_polled');
  });

  it('is stale, not healthy, when a source has been polled but has never succeeded', () => {
    // consecutiveFailures can be reset to 0 by a writer while last_success_at
    // stays null. Falling through to the yield check would then read a NULL
    // record count as 0 and call the source healthy or idle.
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: null,
        consecutiveFailures: 0,
        lastRecordCount: null,
        baselineRecordCount: null,
        lastError: null,
        expectedMinRecords: 0,
      },
      NOW,
    );
    expect(health.state).toBe('stale');
  });
});

describe('GET /api/sources/health', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('lets a member read source health', async () => {
    insertSource(db);
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.status).toBe(200);
    expect(res.body.rows[0].label).toBe('ARRL scholarship catalog');
    expect(res.body.rows[0].health.state).toBe('healthy');
    expect(res.body.canConfigure).toBe(false);
  });

  it('tells an admin it may configure sources', async () => {
    insertSource(db);
    const res = await request(buildApp(db, ADMIN)).get('/api/sources/health');
    expect(res.body.canConfigure).toBe(true);
  });

  it('sorts unhealthy sources to the top', async () => {
    insertSource(db);
    insertSource(db, {
      id: 'ncdxf-grants',
      label: 'NCDXF grant page',
      funder_id: 'ncdxf',
      consecutive_failures: 4,
      last_record_count: 0,
      expected_min_records: 1,
    });
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.body.rows[0].id).toBe('ncdxf-grants');
  });

  it('summarises the fleet so the nav badge can show one number', async () => {
    insertSource(db);
    insertSource(db, {
      id: 'ncdxf-grants',
      label: 'NCDXF grant page',
      funder_id: 'ncdxf',
      consecutive_failures: 4,
      last_record_count: 0,
      expected_min_records: 1,
    });
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.body.summary).toEqual({ total: 2, healthy: 1, unhealthy: 1 });
  });

  it('returns an empty list rather than erroring before the first crawl', async () => {
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.body.rows).toEqual([]);
    expect(res.body.summary.total).toBe(0);
  });

  it('reports the enabled flag so the page can grey out a paused source', async () => {
    insertSource(db);
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.body.rows[0].enabled).toBe(true);
  });

  it('reports the yield alarm for the source 112 of 150 programmes inherit from', async () => {
    // Six parsers once returned zero records from their own live pages while
    // every unit test stayed green. This row is the alarm that would have said so.
    insertSource(db, { last_record_count: 0, baseline_record_count: 111 });
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.body.rows[0].health.state).toBe('yield_dropped');
    expect(res.body.rows[0].health.detail).toContain('111');
    expect(res.body.summary).toEqual({ total: 1, healthy: 0, unhealthy: 1 });
  });

  it('reads sources.last_error out of the database, so a refused source says it was refused', async () => {
    // The row `crawl/runner.ts` writes when a site refuses the page. The column was not in
    // SELECT_COLUMNS at all until 2026-08-11, so this sentence existed in the database and could
    // not reach the screen — and the screen said "4 consecutive failures" instead.
    insertSource(db, {
      id: 'ieee-student-branch-rebate',
      label: 'IEEE Student Branch Rebate',
      funder_id: 'ieee',
      last_success_at: null,
      consecutive_failures: 4,
      last_record_count: null,
      expected_min_records: 1,
      last_error:
        'HTTP 403 for https://students.ieee.org/topics/submit-your-student-branch-annual-plan/ ' +
        '— the site refused us, so no page was read. This is a refusal, not an empty page.',
    });
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    const row = res.body.rows.find((r: { id: string }) => r.id === 'ieee-student-branch-rebate');
    expect(row.health.state).toBe('failing');
    expect(row.health.detail).toContain('HTTP 403');
    expect(row.health.detail).toContain('students.ieee.org');
    // The count is still there — the reason is added to it, never in place of it.
    expect(row.health.detail).toContain('4 consecutive failures');
  });
});

describe('PATCH /api/sources/:id — configuration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    insertSource(db);
  });

  afterEach(() => {
    db.close();
  });

  it('refuses a member with 403 and changes nothing', async () => {
    const res = await request(buildApp(db, MEMBER))
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ expectedMinRecords: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    const row = db
      .prepare('SELECT expected_min_records FROM sources WHERE id = ?')
      .get('arrl-scholarship-descriptions') as { expected_min_records: number };
    expect(row.expected_min_records).toBe(100);
  });

  it('lets an admin raise the parse-yield baseline', async () => {
    const res = await request(buildApp(db, ADMIN))
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ expectedMinRecords: 105 });
    expect(res.status).toBe(200);
    expect(res.body.source.expectedMinRecords).toBe(105);
    expect(res.body.source.health.state).toBe('healthy'); // 111 still clears 105
  });

  it('lets an admin pause a source without deleting it', async () => {
    const res = await request(buildApp(db, ADMIN))
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.source.enabled).toBe(false);
  });

  it('records who changed a source, so a paused source has an author', async () => {
    await request(buildApp(db, ADMIN))
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ enabled: false });
    const row = db
      .prepare(
        `SELECT actor_user_id, action, entity_type, entity_id, detail
           FROM audit_log WHERE entity_id = ?`,
      )
      .get('arrl-scholarship-descriptions') as Record<string, string>;
    expect(row.actor_user_id).toBe('u-admin');
    expect(row.action).toBe('source.configure');
    expect(row.entity_type).toBe('source');
    expect(JSON.parse(row.detail)).toEqual({ enabled: false });
  });

  it('rejects a negative baseline and a non-boolean enabled with 422', async () => {
    const app = buildApp(db, ADMIN);
    const negative = await request(app)
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ expectedMinRecords: -1 });
    expect(negative.status).toBe(422);
    expect(negative.body.error.code).toBe('validation_failed');

    const notBool = await request(app)
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ enabled: 'yes' });
    expect(notBool.status).toBe(422);
  });

  it('rejects a patch with no recognised field, rather than reporting a silent success', async () => {
    const res = await request(buildApp(db, ADMIN))
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ tier: 'A' });
    expect(res.status).toBe(422);
  });

  it('offers no escape hatch from the fetcher blocklist', async () => {
    // farweb.org is a hijacked ham-radio funding domain that now 301s to a
    // gambling site. The blocklist that stops it is enforced in the fetcher and
    // is deliberately non-configurable: source configuration must never grow a
    // field that turns it off, points a source at a new URL, or allowlists a host.
    const app = buildApp(db, ADMIN);
    for (const body of [
      { url: 'https://farweb.org/scholarships' },
      { allowBlocked: true },
      { blocklist: [] },
      { blocklistOverride: ['farweb.org'] },
      { host: 'farweb.org' },
      { enabled: true, url: 'https://farweb.org/' },
    ]) {
      const res = await request(app)
        .patch('/api/sources/arrl-scholarship-descriptions')
        .send(body);
      // `{ enabled: true, url: ... }` is the dangerous shape: a router that
      // applied the fields it recognised and ignored the rest would 200 here
      // and read as if the URL had been accepted.
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
    }
  });

  it('404s an unknown source', async () => {
    const res = await request(buildApp(db, ADMIN))
      .patch('/api/sources/nope')
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('POST /api/sources/crawl — manual trigger', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    insertSource(db);
  });

  afterEach(() => {
    db.close();
  });

  it('refuses a member with 403 and never calls the crawler', async () => {
    const crawl = vi.fn<CrawlTrigger>(async () => OK_SUMMARY);
    const res = await request(buildApp(db, MEMBER, crawl)).post('/api/sources/crawl').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    expect(crawl).not.toHaveBeenCalled();
  });

  it('runs every source when no ids are given and returns the summary', async () => {
    const crawl = vi.fn<CrawlTrigger>(async () => OK_SUMMARY);
    const res = await request(buildApp(db, ADMIN, crawl)).post('/api/sources/crawl').send({});
    expect(res.status).toBe(200);
    expect(crawl).toHaveBeenCalledWith(undefined);
    expect(res.body.results).toEqual(OK_SUMMARY);
    expect(res.body.startedAt).toBe(NOW);
  });

  it('passes an explicit id list straight through', async () => {
    const crawl = vi.fn<CrawlTrigger>(async () => OK_SUMMARY);
    await request(buildApp(db, ADMIN, crawl))
      .post('/api/sources/crawl')
      .send({ sourceIds: ['arrl-scholarship-descriptions'] });
    expect(crawl).toHaveBeenCalledWith(['arrl-scholarship-descriptions']);
  });

  it('visits a repeated id once — a press must not multiply the load on one nonprofit', async () => {
    const crawl = vi.fn<CrawlTrigger>(async () => OK_SUMMARY);
    await request(buildApp(db, ADMIN, crawl))
      .post('/api/sources/crawl')
      .send({
        sourceIds: [
          'arrl-scholarship-descriptions',
          'arrl-scholarship-descriptions',
          'ncdxf-grants',
        ],
      });
    expect(crawl).toHaveBeenCalledWith(['arrl-scholarship-descriptions', 'ncdxf-grants']);
  });

  it('rejects a sourceIds that is not an array of strings with 422', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/sources/crawl')
      .send({ sourceIds: 'arrl-scholarship-descriptions' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('rejects an empty-string id rather than asking the crawler what it means', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/sources/crawl')
      .send({ sourceIds: [''] });
    expect(res.status).toBe(422);
  });

  it('records the trigger so a night of traffic has a named author', async () => {
    await request(buildApp(db, ADMIN))
      .post('/api/sources/crawl')
      .send({ sourceIds: ['arrl-scholarship-descriptions'] });
    const row = db
      .prepare('SELECT actor_user_id, action, entity_type, detail FROM audit_log')
      .get() as Record<string, string>;
    expect(row.actor_user_id).toBe('u-admin');
    expect(row.action).toBe('source.crawl');
    expect(JSON.parse(row.detail)).toEqual({ sourceIds: ['arrl-scholarship-descriptions'] });
  });

  it('409s a second crawl while the first is still running, and does not start it', async () => {
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // DEVIATION FROM THE BRIEF (2026-08-04). The brief kicked the first request
    // off with `const first = request(app).post(...).send({})` and then waited
    // one setImmediate. A supertest Test dispatches nothing until `.then()` or
    // `.end()` is called, so the first request had not started, the second one
    // took the lock, blocked on the gate nothing would ever release, and the
    // test timed out at 5s. It is also one tick against several rounds of real
    // socket I/O, which would have been flaky even if the request had started.
    // Waiting on the crawler actually being entered is deterministic.
    const inCrawl = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const crawl = vi.fn<CrawlTrigger>(async () => {
      entered();
      await gate;
      return OK_SUMMARY;
    });
    const app = buildApp(db, ADMIN, crawl);

    const first = request(app)
      .post('/api/sources/crawl')
      .send({})
      .then((res) => res);
    // The first request is genuinely inside the (still pending) crawl.
    await inCrawl;

    const second = await request(app).post('/api/sources/crawl').send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
    expect(crawl).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it('releases the single-flight lock after a crawl throws, so the next one can run', async () => {
    const crawl = vi
      .fn<CrawlTrigger>()
      .mockRejectedValueOnce(new Error('arrl.org timed out'))
      .mockResolvedValueOnce(OK_SUMMARY);
    const app = buildApp(db, ADMIN, crawl);

    const failed = await request(app).post('/api/sources/crawl').send({});
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('internal');

    const retried = await request(app).post('/api/sources/crawl').send({});
    expect(retried.status).toBe(200);
    expect(crawl).toHaveBeenCalledTimes(2);
  });

  it('releases the single-flight lock when the crawler throws synchronously', async () => {
    // A trigger that throws before returning a promise never sets the lock in
    // the brief's shape; assert the lock is genuinely free afterwards rather
    // than accidentally-never-taken.
    const crawl = vi
      .fn<CrawlTrigger>()
      .mockImplementationOnce(() => {
        throw new Error('registry has no such source');
      })
      .mockResolvedValueOnce(OK_SUMMARY);
    const app = buildApp(db, ADMIN, crawl);

    const failed = await request(app).post('/api/sources/crawl').send({});
    expect(failed.status).toBe(500);

    const retried = await request(app).post('/api/sources/crawl').send({});
    expect(retried.status).toBe(200);
  });
});
