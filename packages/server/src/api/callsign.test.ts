import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCallsignRouter, LOOKUP_MAX_PER_WINDOW, type CallsignCaller } from './callsign.js';
import { errorHandler, requestIdMiddleware } from './errors.js';

/**
 * THE ROUTE, WITH NO NETWORK ANYWHERE NEAR IT.
 *
 * Every test here hands the router a fake transport, which is the whole reason
 * `CallsignRouterDeps.transport` exists as a structural interface: the unit suite runs with
 * zero network access, and a route that reached callook.info to be tested would be a route
 * that cannot be tested at all.
 */

const SETUP_TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const MEMBER: CallsignCaller = { id: 'u-member', role: 'member' };

/** A VALID callook body, in the shape its API reference documents. */
const VALID_BODY = {
  status: 'VALID',
  type: 'PERSON',
  current: { callsign: 'W8UM', operClass: 'GENERAL' },
  name: 'JANE Q OPERATOR',
  address: { line1: '1301 BEAL AVE', line2: 'ANN ARBOR, MI 48109' },
  otherInfo: {
    grantDate: '04/04/2019',
    expiryDate: '04/04/2029',
    frn: '0012345678',
    ulsUrl: 'https://wireless2.fcc.gov/UlsApp/UlsSearch/license.jsp?licKey=1234',
  },
};

interface Harness {
  app: express.Express;
  transport: ReturnType<typeof vi.fn>;
}

function buildApp(
  options: {
    user?: CallsignCaller;
    setupToken?: string | null;
    respond?: () => Promise<Response>;
  } = {},
): Harness {
  const respond = options.respond ?? (() => Promise.resolve(new Response(JSON.stringify(VALID_BODY), { status: 200 })));
  const transport = vi.fn(respond);

  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use(
    '/api/callsign',
    createCallsignRouter({
      transport,
      setupToken: () => (options.setupToken === undefined ? SETUP_TOKEN : options.setupToken),
      sessionUser: () => options.user,
    }),
  );
  app.use(errorHandler({ logger: () => undefined }));
  return { app, transport };
}

describe('POST /api/callsign/lookup — who may call it', () => {
  it('answers a signed-in member for their own profile', async () => {
    const { app, transport } = buildApp({ user: MEMBER });
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'w8um' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('found');
    expect(res.body.record.callsign).toBe('W8UM');
    expect(res.body.record.state).toBe('MI');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('answers the first-run screen, which has no session and holds the setup token', async () => {
    const { app, transport } = buildApp({});
    const res = await request(app)
      .post('/api/callsign/lookup')
      .send({ callsign: 'W8UM', setupToken: SETUP_TOKEN });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('found');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refuses an anonymous caller with no token, and asks nobody anything', async () => {
    const { app, transport } = buildApp({});
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses an anonymous caller whose token is wrong', async () => {
    const { app, transport } = buildApp({});
    const res = await request(app)
      .post('/api/callsign/lookup')
      .send({ callsign: 'W8UM', setupToken: 'not-the-token' });

    expect(res.status).toBe(401);
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * The door closes on its own. `BootstrapState.token()` answers `null` once an account exists,
   * so the anonymous path needs no separate switch to turn off — and must not survive one.
   */
  it('refuses the token path once an administrator account exists', async () => {
    const { app, transport } = buildApp({ setupToken: null });
    const res = await request(app)
      .post('/api/callsign/lookup')
      .send({ callsign: 'W8UM', setupToken: SETUP_TOKEN });

    expect(res.status).toBe(401);
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * The token is READ, never spent. Spending it here would leave an operator who looked their
   * own callsign up unable to create the administrator account the same token is for.
   */
  it('does not consume the setup token', async () => {
    const { app } = buildApp({});
    const first = await request(app)
      .post('/api/callsign/lookup')
      .send({ callsign: 'W8UM', setupToken: SETUP_TOKEN });
    const second = await request(app)
      .post('/api/callsign/lookup')
      .send({ callsign: 'W1AW', setupToken: SETUP_TOKEN });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  /**
   * THE RULE THIS ENDPOINT EXISTS TO KEEP. An administrator may not look a third party's
   * callsign up: the answer is somebody's name and home address, and filling it into an
   * account that person did not fill in themselves makes GrantSpotter state facts on their
   * behalf. There is no user parameter, and a body that carries one is REFUSED rather than
   * quietly answered for the caller instead.
   */
  it('refuses a request that names another user instead of answering it for the caller', async () => {
    const { app, transport } = buildApp({ user: { id: 'u-admin', role: 'admin' } });
    const res = await request(app)
      .post('/api/callsign/lookup')
      .send({ callsign: 'W8UM', userId: 'u-someone-else' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses a body with no callsign at all', async () => {
    const { app, transport } = buildApp({ user: MEMBER });
    const res = await request(app).post('/api/callsign/lookup').send({});

    expect(res.status).toBe(422);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('POST /api/callsign/lookup — rate limit', () => {
  it('allows a person filling in a form and refuses a batch', async () => {
    const { app, transport } = buildApp({ user: MEMBER });

    for (let i = 0; i < LOOKUP_MAX_PER_WINDOW; i += 1) {
      const ok = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });
      expect(ok.status).toBe(200);
    }

    const refused = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.body.error.details.retryAfterSec).toBeGreaterThan(0);

    // The refused attempt never became a request to callook.info — which is the point of it.
    expect(transport).toHaveBeenCalledTimes(LOOKUP_MAX_PER_WINDOW);
  });

  it('counts per caller, so one user cannot spend another user’s allowance', async () => {
    let caller: CallsignCaller = MEMBER;
    const transport = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(VALID_BODY), { status: 200 })),
    );
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware());
    app.use(
      '/api/callsign',
      createCallsignRouter({
        transport,
        setupToken: () => SETUP_TOKEN,
        sessionUser: () => caller,
      }),
    );
    app.use(errorHandler({ logger: () => undefined }));

    for (let i = 0; i < LOOKUP_MAX_PER_WINDOW; i += 1) {
      await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });
    }
    expect(
      (await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' })).status,
    ).toBe(429);

    caller = { id: 'u-other', role: 'member' };
    expect(
      (await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' })).status,
    ).toBe(200);
  });
});

describe('POST /api/callsign/lookup — failing soft', () => {
  /**
   * A source that cannot be reached is not an HTTP error here. The request succeeded; it is
   * callook.info that had nothing to say, and a 5xx would tell a licensed operator that
   * something is wrong with their licence.
   */
  it('answers 200 with `unavailable` when the source cannot be reached', async () => {
    const { app, transport } = buildApp({
      user: MEMBER,
      respond: () => Promise.reject(new TypeError('fetch failed')),
    });
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('unavailable');
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(0);
    expect(res.body.record).toBeUndefined();
    // The client's one retry, which is its business — asserted only so a change to it is a
    // change somebody makes on purpose.
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('answers 200 with `updating` while the source re-imports the FCC database', async () => {
    const { app } = buildApp({
      user: MEMBER,
      respond: () =>
        Promise.resolve(new Response(JSON.stringify({ status: 'UPDATING' }), { status: 200 })),
    });
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('updating');
  });

  it('answers 200 with `not_found` for a callsign the source has no record of', async () => {
    const { app } = buildApp({
      user: MEMBER,
      respond: () =>
        Promise.resolve(new Response(JSON.stringify({ status: 'INVALID' }), { status: 200 })),
    });
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8ZZZ' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('not_found');
  });

  /**
   * A non-US callsign is decided BEFORE the request, so an international operator's own
   * callsign is never sent anywhere and never comes back as "not found".
   */
  it('answers `not_us` without contacting anybody', async () => {
    const { app, transport } = buildApp({ user: MEMBER });
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'DL1ABC' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('not_us');
    expect(transport).not.toHaveBeenCalled();
  });
});
