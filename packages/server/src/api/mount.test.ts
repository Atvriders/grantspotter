import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openTestDb } from '../test/testDb.js';
import { hashPassword } from '../auth/password.js';
import { requireAdmin, requireAuth } from '../auth/middleware.js';
import { createUserRepo } from '../db/repositories/users.js';
import { currentSessionUser, mountProductApi } from './mount.js';
import { webDistRoot } from './webDist.js';
import type { CrawlRunSummary, RouterDeps } from './deps.js';
import type { AuthedUser } from './types.js';
import type { VerifyRunner } from './verify.js';

const NOW = '2026-08-02T12:00:00.000Z';

const config = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  NODE_ENV: 'test',
  // Required with no default: `loadConfig` refuses to build a config without a contact
  // URL, so every harness that wants one has to name an address a real deployment could
  // hold. Nothing here reaches the network; this value only has to survive the loader.
  CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter',
});

/**
 * Plan 1's `notFoundHandler()` answers with exactly this message. A router that
 * was registered after it — the RESOLUTIONS R5 bug — 404s with this body and
 * nothing else in the plan would notice, so "reachable" means "the response did
 * not come from the 404 handler", which is stricter than `status !== 404`: a
 * route that legitimately 404s an unknown id still proves it ran, because it
 * says which id it could not find.
 */
const NOT_MOUNTED = 'Not found.';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

interface Probe {
  method: Method;
  path: string;
  body?: Record<string, unknown>;
}

/** Every route Plan 3 registers, one probe each. */
const PLAN_3_ROUTES: Probe[] = [
  { method: 'get', path: '/api/programs' },
  { method: 'get', path: '/api/programs/no-such-program' },
  { method: 'post', path: '/api/programs/no-such-program/verify' },
  { method: 'get', path: '/api/profiles' },
  { method: 'put', path: '/api/profiles/student', body: {} },
  { method: 'get', path: '/api/me' },
  { method: 'get', path: '/api/watches' },
  { method: 'post', path: '/api/watches', body: {} },
  { method: 'delete', path: '/api/watches/no-such-program' },
  { method: 'get', path: '/api/notifications' },
  { method: 'get', path: '/api/notifications/health' },
  { method: 'post', path: '/api/notifications/read-all', body: {} },
  { method: 'post', path: '/api/notifications/no-such-notification/read', body: {} },
  { method: 'get', path: '/api/channels' },
  { method: 'put', path: '/api/channels', body: {} },
  { method: 'post', path: '/api/channels/test', body: {} },
  { method: 'get', path: '/api/calendar' },
  { method: 'get', path: '/api/inbox' },
  { method: 'post', path: '/api/inbox/no-such-item/decision', body: { decision: 'approved' } },
  { method: 'get', path: '/api/admin/users' },
  { method: 'post', path: '/api/admin/users', body: {} },
  { method: 'patch', path: '/api/admin/users/no-such-user/role', body: { role: 'member' } },
  { method: 'patch', path: '/api/admin/users/no-such-user/disabled', body: { disabled: true } },
  { method: 'post', path: '/api/admin/users/no-such-user/reset-password', body: {} },
  { method: 'delete', path: '/api/admin/users/no-such-user' },
  { method: 'get', path: '/api/sources/health' },
  { method: 'patch', path: '/api/sources/no-such-source', body: { enabled: false } },
  { method: 'post', path: '/api/sources/crawl', body: { sourceIds: [] } },
];

describe('mountRoutes composition', () => {
  let db: Database.Database;
  let adminApp: ReturnType<typeof createApp>;
  let memberApp: ReturnType<typeof createApp>;
  let anonApp: ReturnType<typeof createApp>;
  let admin: AuthedUser;
  let member: AuthedUser;
  const crawled: Array<string[] | undefined> = [];

  /**
   * The REAL guards from Plan 1's auth module, in front of a shim that stands
   * in for a signed session cookie. `attachUser` is what normally populates
   * `req.auth`; supplying it here exercises `requireAuth()` and `requireAdmin()`
   * themselves rather than a passthrough fake, so the role matrix asserted below
   * is the one production runs.
   */
  function appFor(user: AuthedUser | null): ReturnType<typeof createApp> {
    const asUser =
      (inner: ReturnType<typeof requireAuth>): RouterDeps['requireAuth'] =>
      (req, res, next) => {
        if (user !== null) req.auth = user;
        inner(req, res, next);
      };

    const deps: RouterDeps = {
      db,
      now: () => NOW,
      requireAuth: asUser(requireAuth()),
      requireAdmin: asUser(requireAdmin()),
      currentUser: currentSessionUser,
    };

    // Never called with a real target: this suite asserts registration and the
    // role matrix, not verification or crawl behaviour.
    const runner: VerifyRunner = {
      verify: async (programId) => ({
        programId,
        attemptedAt: NOW,
        ok: true,
        changed: false,
        diffs: [],
        lastVerifiedAt: NOW,
        changeEventIds: [],
      }),
    };
    const crawl = async (sourceIds?: string[]): Promise<CrawlRunSummary[]> => {
      crawled.push(sourceIds);
      return [];
    };

    return createApp({
      db,
      config,
      logger: () => undefined,
      // Exactly the shape of Plan 3's hook body: product routers, and nothing
      // after them. Plans 4 and 5 append below this line in their own tasks;
      // Plan 5 Task 17's SPA middleware is always last (RESOLUTIONS R25).
      mountRoutes: (a) => {
        mountProductApi(a, deps, runner, crawl);
      },
    });
  }

  beforeAll(async () => {
    db = openTestDb();
    const users = createUserRepo(db);
    const createdAdmin = users.create({
      email: 'admin@example.com',
      passwordHash: await hashPassword('an-admin-password-not-a-real-secret'),
      role: 'admin',
      displayName: 'The Admin',
    });
    const createdMember = users.create({
      email: 'member@example.com',
      passwordHash: await hashPassword('a-member-password-not-a-real-secret'),
      role: 'member',
      displayName: 'The Member',
    });
    admin = {
      id: createdAdmin.id,
      email: createdAdmin.email,
      displayName: createdAdmin.displayName,
      role: 'admin',
    };
    member = {
      id: createdMember.id,
      email: createdMember.email,
      displayName: createdMember.displayName,
      role: 'member',
    };

    adminApp = appFor(admin);
    memberApp = appFor(member);
    anonApp = appFor(null);
  });

  afterAll(() => {
    db.close();
  });

  it('makes every Plan 3 route reachable through the real createApp', async () => {
    // If mountProductApi ran after Plan 1's notFoundHandler — the R5 bug — each
    // of these would come back as the 404 handler's own envelope and no other
    // test in this plan would notice.
    for (const probe of PLAN_3_ROUTES) {
      const res = await request(adminApp)[probe.method](probe.path).send(probe.body ?? {});
      // 204 No Content carries no content-type by definition, and it is not a
      // shape notFoundHandler can produce, so it is proof of reachability on
      // its own (`DELETE /api/watches/:programId`, `POST .../read`).
      if (res.status !== 204) {
        expect(res.headers['content-type'], `${probe.method} ${probe.path}`).toMatch(
          /application\/json/,
        );
      }
      expect(
        res.status === 404 && res.body?.error?.message === NOT_MOUNTED,
        `${probe.method} ${probe.path} is not mounted`,
      ).toBe(false);
      expect(res.status, `${probe.method} ${probe.path} crashed`).toBeLessThan(500);
    }
  });

  it('covers all 28 registered routes, so this list cannot silently shrink', () => {
    expect(PLAN_3_ROUTES).toHaveLength(28);
  });

  it('serves the read surfaces a signed-in member is entitled to', async () => {
    for (const path of [
      '/api/programs',
      '/api/profiles',
      '/api/me',
      '/api/watches',
      '/api/notifications',
      '/api/channels',
      '/api/calendar',
      '/api/inbox',
      '/api/sources/health',
    ]) {
      const res = await request(memberApp).get(path);
      expect(res.status, `${path} for a member`).toBe(200);
    }
  });

  it('keeps a member read-only on the Inbox — the API decides, not the UI', async () => {
    const read = await request(memberApp).get('/api/inbox');
    expect(read.status).toBe(200);

    const decide = await request(memberApp)
      .post('/api/inbox/no-such-item/decision')
      .send({ decision: 'approved' });
    expect(decide.status).toBe(403);
    expect(decide.body.error.code).toBe('forbidden');
  });

  it('keeps a member read-only on sources, and off the crawl trigger entirely', async () => {
    const read = await request(memberApp).get('/api/sources/health');
    expect(read.status).toBe(200);
    expect(read.body.canConfigure).toBe(false);

    const before = crawled.length;
    const configure = await request(memberApp)
      .patch('/api/sources/no-such-source')
      .send({ enabled: false });
    expect(configure.status).toBe(403);

    const trigger = await request(memberApp).post('/api/sources/crawl').send({});
    expect(trigger.status).toBe(403);
    expect(crawled.length, 'a member reached the crawler').toBe(before);
  });

  it('refuses a member every admin-only route', async () => {
    const adminOnly: Probe[] = [
      { method: 'get', path: '/api/notifications/health' },
      { method: 'get', path: '/api/admin/users' },
      { method: 'post', path: '/api/admin/users', body: {} },
      { method: 'patch', path: '/api/admin/users/no-such-user/role', body: { role: 'member' } },
      { method: 'patch', path: '/api/admin/users/no-such-user/disabled', body: { disabled: true } },
      { method: 'post', path: '/api/admin/users/no-such-user/reset-password', body: {} },
      { method: 'delete', path: '/api/admin/users/no-such-user' },
      // Enrollment codes. These matter twice over: they are admin-only, and until this list named
      // them the ROUTER WAS NOT MOUNTED AT ALL and nothing noticed. 122 tests passed against a
      // feature no deployed instance could reach, because every other test file mounts its own
      // express app — so a member probe returning 404-because-absent is indistinguishable from
      // 403-because-refused unless something asserts the composed app. That is this file's whole
      // job, and it only does it for routes somebody remembered to add here.
      { method: 'get', path: '/api/admin/enrollment-codes' },
      { method: 'post', path: '/api/admin/enrollment-codes', body: { label: 'probe' } },
      { method: 'post', path: '/api/admin/enrollment-codes/no-such-code/revoke', body: {} },
      { method: 'patch', path: '/api/sources/no-such-source', body: { enabled: false } },
      { method: 'post', path: '/api/sources/crawl', body: {} },
      { method: 'post', path: '/api/inbox/no-such-item/decision', body: { decision: 'approved' } },
    ];
    for (const probe of adminOnly) {
      const res = await request(memberApp)[probe.method](probe.path).send(probe.body ?? {});
      expect(res.status, `${probe.method} ${probe.path} for a member`).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
  });

  it('refuses an anonymous request every Plan 3 route with 401, not 404', async () => {
    for (const probe of PLAN_3_ROUTES) {
      const res = await request(anonApp)[probe.method](probe.path).send(probe.body ?? {});
      expect(res.status, `${probe.method} ${probe.path} anonymously`).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    }
  });

  it('leaves Plan 1’s JSON 404 envelope governing an unknown API path', async () => {
    const res = await request(adminApp).get('/api/unknown');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.message).toBe(NOT_MOUNTED);
    expect(typeof res.body.requestId).toBe('string');
  });

  it('does not serve the SPA — that is Plan 5 Task 17, and it is mounted last', async () => {
    // The positive case (`GET /` is HTML) lives in Plan 5's spa.test.ts. Here
    // the point is that Plan 3 does NOT claim `/`: if this ever returns HTML,
    // someone has moved the SPA mount into Plan 3's hook body and Plan 5 will
    // then mount a second one (RESOLUTIONS R25/R27).
    const res = await request(adminApp).get('/');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('not_found');
  });

  it('resolves the real dist directory the same way from src and from dist', () => {
    // '../../../web/dist' relative to packages/server/{src,dist}/api is the same
    // path either way, which is why one expression serves tsx, vitest and the
    // image. RESOLUTIONS R27: Plan 5's spa.ts imports THIS function; if it ever
    // grows a second copy, the SPA 404s in production and only there.
    expect(webDistRoot().endsWith(join('packages', 'web', 'dist'))).toBe(true);
  });
});

describe('currentSessionUser', () => {
  it('refuses to invent a user when the request carries none', () => {
    // requireAuth() guarantees req.auth, so reaching here means a route was
    // registered without it. Throwing beats returning an anonymous id that a
    // watchlist or an application would then be scoped to.
    expect(() => currentSessionUser({} as never)).toThrow(/Sign in/);
  });

  it('narrows the authenticated user to the fields a Plan 3 router may see', () => {
    const user = currentSessionUser({
      auth: { id: 'u-1', email: 'a@example.com', displayName: 'A', role: 'admin' },
    } as never);
    expect(user).toEqual({ id: 'u-1', email: 'a@example.com', role: 'admin' });
  });
});
