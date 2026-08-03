import { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createTestDb, type TestDb } from './helpers/tempDb.js';

const config = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  CONTACT_URL: 'https://example.org/grantspotter',
  NODE_ENV: 'test',
});

let harness: TestDb;
beforeEach(() => {
  harness = createTestDb();
});
afterEach(() => harness.cleanup());

describe('GET /api/health', () => {
  it('reports readiness without requiring a session', async () => {
    const app = createApp({ db: harness.db, config });
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.name).toBe('grantspotter');
    expect(res.body.version).toBe('0.1.0');
    // >= 1 rather than exactly 1: Plan 5 adds 090-ics-tokens.sql later.
    expect(res.body.migrations).toBeGreaterThanOrEqual(1);
    expect(res.body.programs).toBe(0);
    expect(typeof res.body.now).toBe('string');
  });

  it('returns the error envelope for an unknown API route', async () => {
    const app = createApp({ db: harness.db, config });
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(typeof res.body.requestId).toBe('string');
  });
});

// RESOLUTIONS R5. createApp seals the app with notFoundHandler, so Plans 3-5
// can only reach the router table through this hook. These two assertions are
// what stop ~20 routers being silently unreachable.
describe('AppDeps.mountRoutes', () => {
  function laterPlanRouter() {
    const router = Router();
    router.get('/mounted', (_req, res) => {
      res.json({ mounted: true });
    });
    return router;
  }

  it('reaches a router mounted through the hook', async () => {
    const app = createApp({
      db: harness.db,
      config,
      mountRoutes: (a) => {
        a.use('/api', laterPlanRouter());
      },
    });
    const res = await request(app).get('/api/mounted');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mounted: true });
  });

  // RESOLUTIONS R16 + R25: this must stay an /api path. Once Plan 5 Task 17
  // installs createSpaMiddleware as the last statement of Plan 3 Task 14's
  // callback, an unknown non-/api GET is answered with index.html, but
  // /api/* still falls to this envelope.
  it('still answers an unknown /api path with the 404 envelope', async () => {
    const app = createApp({
      db: harness.db,
      config,
      mountRoutes: (a) => {
        a.use('/api', laterPlanRouter());
      },
    });
    const res = await request(app).get('/api/still-unknown');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(typeof res.body.requestId).toBe('string');
  });

  it('proves why mounting after createApp returns does not work', async () => {
    // This is the anti-pattern the hook exists to prevent. It is asserted
    // rather than merely described so nobody re-discovers it in Plan 4.
    const app = createApp({ db: harness.db, config });
    app.use('/api', laterPlanRouter());
    const res = await request(app).get('/api/mounted');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
