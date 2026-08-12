import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createCallsignRouter,
  LOOKUP_MAX_PER_WINDOW,
  LOOKUP_WINDOW_MS,
  type CallsignCaller,
} from './callsign.js';
import { createRateLimiter, type RateLimiter } from '../auth/rateLimit.js';
import { createHostCooldown, type HostCooldown } from '../callsign/cooldown.js';
import { errorHandler, requestIdMiddleware } from './errors.js';

/**
 * THE ROUTE, WITH NO NETWORK ANYWHERE NEAR IT.
 *
 * Every test here hands the router a fake transport, which is the whole reason
 * `CallsignRouterDeps.transport` exists as a structural interface: the unit suite runs with
 * zero network access, and a route that reached callook.info to be tested would be a route
 * that cannot be tested at all.
 */

/*
 * `SETUP_TOKEN` WAS DECLARED HERE AND IS GONE, with the six assertions that used it. The route
 * accepted the one-time first-run token from an unauthenticated caller so that the setup screen's
 * callsign panel could work before any account existed; `routes/FirstRun.tsx` deleted that panel on
 * 2026-08-11 and this round deleted the privilege behind it. What each retired test asserted, and
 * why deleting rather than rewriting it is the honest move, is written at the point it was removed.
 */
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
    respond?: () => Promise<Response>;
    cooldown?: HostCooldown;
  } = {},
): Harness {
  // Each app gets its own cooldown ledger by construction (`createCallsignRouter` builds one per
  // router), so a 429 in one test cannot silence the lookup in the next.
  const respond = options.respond ?? (() => Promise.resolve(new Response(JSON.stringify(VALID_BODY), { status: 200 })));
  const transport = vi.fn(respond);

  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use(
    '/api/callsign',
    createCallsignRouter({
      transport,
      sessionUser: () => options.user,
      ...(options.cooldown === undefined ? {} : { cooldown: options.cooldown }),
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

  /*
   * FOUR TESTS ABOUT THE SETUP TOKEN WERE HERE AND ARE DELETED RATHER THAN RELAXED, because what
   * they asserted is no longer a property this route has:
   *
   *   - `answers the first-run screen, which has no session and holds the setup token` asserted
   *     that an unauthenticated caller presenting the token got a 200 and a record. That is the
   *     privilege itself. The screen it existed for was deleted on 2026-08-11 with the callsign
   *     field, so the assertion describes a caller that cannot exist and a behaviour that must not.
   *   - `refuses an anonymous caller whose token is wrong` and `refuses the token path once an
   *     administrator account exists` were the two edges of that branch. With no branch there are
   *     no edges; both collapse into the one assertion below, which is that an anonymous caller is
   *     refused, full stop, whatever they send.
   *   - `does not consume the setup token` asserted that a lookup left the token spendable for the
   *     bootstrap it belongs to. This route never sees the token now, so it cannot spend it — the
   *     property is held by construction rather than by a test, and `the composition root` block at
   *     the bottom of this file asserts the construction.
   *
   * Rewriting any of them to expect a 401 instead of a 200 would have kept a test named after a
   * caller that no longer exists, which is the failure mode this codebase keeps finding.
   */
  it('refuses an anonymous caller, and asks nobody anything', async () => {
    const { app, transport } = buildApp({});
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * THE REFUSAL SAYS ONE THING NOW, AND THE THING IT USED TO SAY WAS AN INVITATION.
   *
   * It read "Sign in to look a callsign up. During first-run setup, send the one-time setup token
   * printed in the server log with the request." Two separate wrongs by 2026-08-11: there is no
   * setup-token path to send anything to, and the token is not printed in the log any more —
   * `bootstrap.ts` writes it to `first-run-token.txt` because a secret in `docker logs` stays in
   * `docker logs`. A 401 that tells an anonymous caller how to get a token is the last place that
   * sentence should have survived.
   */
  it('does not offer the anonymous caller a second credential to try', async () => {
    const { app } = buildApp({});
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });

    expect(res.body.error.message).toBe('Sign in to look a callsign up.');
    expect(res.body.error.message).not.toMatch(/token|log/i);
  });

  /**
   * THE RETIRED CREDENTIAL, PRESENTED ANYWAY, IS AN UNKNOWN KEY AND NOT A LOGIN.
   *
   * `setupToken` is no longer declared in the body schema, so `.strict()` treats it exactly as it
   * treats `userId`: a request that names something this endpoint does not do is refused (422)
   * rather than stripped and answered. That is the right answer for the only client that could
   * still send one — it is holding a credential this route no longer honours, and being told so
   * beats being answered as though it had worked. Asserted from BOTH sides, because the interesting
   * half is the anonymous one: presenting the token is not a way in.
   */
  it('refuses a body carrying the retired setupToken key, signed in or not', async () => {
    for (const user of [undefined, MEMBER]) {
      const { app, transport } = buildApp(user === undefined ? {} : { user });
      const res = await request(app)
        .post('/api/callsign/lookup')
        .send({ callsign: 'W8UM', setupToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' });

      expect(res.status, user === undefined ? 'anonymous' : 'signed in').toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
      expect(transport).not.toHaveBeenCalled();
    }
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

  /**
   * WHAT IS RATIONED IS THE REQUEST, AND A `not_us` PRESS MAKES NONE.
   *
   * Measured before the fix, on this exact shape: nine `DL1ABC` presses from one member answered
   * 200 eight times and then 429, with the transport called ZERO times throughout — and the next
   * press, with a real US callsign, was refused for 600 seconds. The people who only ever see the
   * `not_us` path are international operators, and that message exists to tell them their licence
   * is fine and to carry on. Charging them for hearing it, and then locking the form, says the
   * opposite. `wouldReachTheSource` is now asked first, and it is the same predicate the client
   * uses for its own short-circuit, so what is counted and what is spent cannot disagree.
   */
  it('spends no ration on a callsign that can never become a request', async () => {
    const { app, transport } = buildApp({ user: MEMBER });

    // Twice the whole allowance, all of them refused before any socket could exist.
    for (let i = 0; i < LOOKUP_MAX_PER_WINDOW * 2; i += 1) {
      const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'DL1ABC' });
      expect(res.status, `press ${String(i + 1)}`).toBe(200);
      expect(res.body.status).toBe('not_us');
    }
    expect(transport).not.toHaveBeenCalled();

    // …and the allowance is still whole, which is the half that actually hurt somebody.
    const real = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });
    expect(real.status).toBe(200);
    expect(real.body.status).toBe('found');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  /**
   * The carve-out above is exactly as wide as its reason and no wider. A caller who has genuinely
   * spent the allowance on real lookups is still refused, and is refused on the FIRST real press
   * after it — a `not_us` press in between neither restores the ration nor extends it.
   */
  it('still refuses a real lookup from a caller who has spent the allowance', async () => {
    const { app, transport } = buildApp({ user: MEMBER });

    for (let i = 0; i < LOOKUP_MAX_PER_WINDOW; i += 1) {
      expect((await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' })).status).toBe(200);
    }
    // A press that costs callook nothing is answered even now.
    const foreign = await request(app).post('/api/callsign/lookup').send({ callsign: 'DL1ABC' });
    expect(foreign.status).toBe(200);
    expect(foreign.body.status).toBe('not_us');

    const refused = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });
    expect(refused.status).toBe(429);
    expect(transport).toHaveBeenCalledTimes(LOOKUP_MAX_PER_WINDOW);
  });

  /**
   * Authorisation is decided BEFORE the ration, and the `not_us` carve-out does not move it: an
   * anonymous caller is refused whatever they type. Otherwise the cheapest way to find out whether
   * this endpoint exists, and to burn CPU on it, would be to send it rubbish.
   */
  it('refuses an anonymous caller even when the press would cost the source nothing', async () => {
    const { app, transport } = buildApp({});
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'DL1ABC' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * THE THIRD WAY A PRESS COSTS THE SOURCE NOTHING, ADDED WITH THE COOLDOWN.
   *
   * Measured before it existed: eight presses against a stand-in answering `429 Retry-After: 120`
   * to everything produced EIGHT requests in 69 ms, gaps of 21, 9, 7, 8, 8, 8, 8 ms — the whole
   * allowance spent, at the one host in this product that publishes `Disallow: /`, seven of them
   * after it had said in writing not to.
   *
   * Both halves are asserted here because they are one decision. The requests collapse to one; and
   * the presses that made none are not charged, so the member comes out of the hold with the
   * allowance they went in with. Charging for them would repeat the `not_us` mistake next door with
   * the source, rather than the callsign, as the reason nothing could be asked.
   */
  it('stops asking a source that asked to wait, and does not charge the person for the wait', async () => {
    const { app, transport } = buildApp({
      user: MEMBER,
      respond: () =>
        Promise.resolve(new Response('slow down', { status: 429, headers: { 'retry-after': '120' } })),
    });

    for (let i = 0; i < LOOKUP_MAX_PER_WINDOW * 2; i += 1) {
      const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });
      expect(res.status, `press ${String(i + 1)}`).toBe(200);
      expect(res.body.status).toBe('unavailable');
      expect(res.body.message).toMatch(/asked GrantSpotter to wait/);
      expect(res.body.message).toContain('about 2 minutes');
    }

    // Sixteen presses, one request. It was one request per press.
    expect(transport).toHaveBeenCalledTimes(1);
  });

  /**
   * PRESSES THAT OVERLAP, WHICH IS WHAT SEVERAL PEOPLE ARE.
   *
   * The test above presses sixteen times in sequence, so every press after the first reads a hold
   * the previous answer has already written. Fire them together and none of them can: measured
   * 2026-08-04 through this router, eight simultaneous presses at a stand-in answering
   * `429 Retry-After: 120` produced EIGHT requests, with the cooldown present and every one of its
   * own tests green. The per-session ration bounds one member at eight; it does not bound two
   * members at all, and the hold — the only mechanism here that is about the HOST — could not see a
   * request that had not answered yet.
   *
   * The transport is deliberately slow so the presses genuinely overlap rather than happening to
   * queue. A machine slow enough to space these 200 ms apart fails this test loudly, which is the
   * right direction: the number it would print is the number of requests a stranger's server got.
   */
  it('sends ONE request for eight presses that overlap, from one member', async () => {
    const { app, transport } = buildApp({
      user: MEMBER,
      respond: () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(JSON.stringify(VALID_BODY), { status: 200 })),
            200,
          );
        }),
    });

    const answers = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' }),
      ),
    );

    expect(transport).toHaveBeenCalledTimes(1);
    // Nobody is told the source failed them: seven get GrantSpotter's own sentence, one gets the
    // record. Every one of them is answered — a refusal here is not an HTTP error either.
    for (const answer of answers) expect(answer.status).toBe(200);
    expect(answers.filter((a) => a.body.status === 'found')).toHaveLength(1);
    const refused = answers.filter((a) => a.body.status === 'unavailable');
    expect(refused).toHaveLength(7);
    for (const answer of refused) {
      expect(answer.body.message).toMatch(/already waiting on an answer from callook\.info/);
    }
  });

  /**
   * THE CASE THE RATION CANNOT REACH AT ALL. Eight members pressing at once have eight untouched
   * allowances between them, so the only thing that can bound them is a rule about the host — and
   * until 2026-08-04 the only such rule could not see a request that had not answered yet.
   *
   * The second half matters as much as the first: losing a race must not cost the loser a press.
   * Seven members are refused here, and each of them still has their whole allowance afterwards.
   */
  it('sends ONE request for eight presses from eight different members, and charges only the one that asked', async () => {
    let seat = 0;
    // The real limiter, watched. Counting `recordFailure` is how "the press that lost the race was
    // not charged" is asserted precisely rather than inferred from an allowance that eight
    // different members have eight separate copies of.
    const inner = createRateLimiter({ windowMs: LOOKUP_WINDOW_MS, maxFailures: LOOKUP_MAX_PER_WINDOW });
    const charged: string[] = [];
    const limiter: RateLimiter = {
      check: (key, nowMs) => inner.check(key, nowMs),
      // Delegated and never used: this route counts every press that reaches the source, before the
      // request, so it has nothing whose outcome it must wait for. `begin` exists for the two auth
      // routes, which do, and `count` for the enrolment route's audit row (auth/rateLimit.ts).
      begin: (key, nowMs) => inner.begin(key, nowMs),
      count: (key, nowMs) => inner.count(key, nowMs),
      recordFailure: (key, nowMs) => {
        charged.push(key);
        inner.recordFailure(key, nowMs);
      },
      reset: (key) => {
        inner.reset(key);
      },
    };
    const transport = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () => resolve(new Response(JSON.stringify(VALID_BODY), { status: 200 })),
            200,
          );
        }),
    );
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware());
    app.use(
      '/api/callsign',
      createCallsignRouter({
        transport,
        limiter,
        // A different signed-in member per request, which is what the rate limiter counts by.
        sessionUser: () => {
          seat += 1;
          return { id: `u-member-${String(seat)}`, role: 'member' };
        },
      }),
    );
    app.use(errorHandler({ logger: () => undefined }));

    const answers = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' }),
      ),
    );

    expect(transport).toHaveBeenCalledTimes(1);
    for (const answer of answers) expect(answer.status).toBe(200);
    expect(answers.filter((a) => a.body.status === 'unavailable')).toHaveLength(7);
    // One request was made, and exactly one person paid for it. Charging the other seven would be
    // the `not_us` mistake in a third costume: a press that cost callook.info nothing.
    expect(charged).toHaveLength(1);
  });

  /**
   * The carve-out is exactly as wide as its reason. Fifteen free presses during a hold buy nothing
   * once the hold lifts: the allowance resumes from the ONE request that was actually made, and the
   * refusal lands where it always did.
   *
   * The ledger is injected so the wait can be ended without waiting two real minutes. It is the
   * only place a clock is faked here — the requests, the limiter and the route are all real.
   */
  it('resumes the allowance from what was actually spent once the wait lifts', async () => {
    let heldMs = 0;
    // The real ledger, with ONLY the wait faked. `isAsking`/`beginAsking` are the host's one-request
    // lane and are left exactly as they ship: a stub of those would be this test quietly answering
    // the question the next test asks. What is replaced here is the clock, and nothing else.
    const cooldown: HostCooldown = {
      ...createHostCooldown(),
      remainingMs: () => heldMs,
      hold: (_key, ms) => {
        heldMs = ms;
      },
    };
    let answer = (): Response =>
      new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
    const { app, transport } = buildApp({
      user: MEMBER,
      cooldown,
      respond: () => Promise.resolve(answer()),
    });

    for (let i = 0; i < LOOKUP_MAX_PER_WINDOW * 2; i += 1) {
      await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });
    }
    expect(transport).toHaveBeenCalledTimes(1);

    heldMs = 0; // the wait callook.info named has run out
    answer = () => new Response(JSON.stringify(VALID_BODY), { status: 200 });

    // One request was made and one was charged, so seven of the eight remain.
    for (let i = 0; i < LOOKUP_MAX_PER_WINDOW - 1; i += 1) {
      const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });
      expect(res.status, `press ${String(i + 1)} after the wait`).toBe(200);
      expect(res.body.status).toBe('found');
    }
    const refused = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });
    expect(refused.status).toBe(429);
    expect(refused.body.error.code).toBe('rate_limited');
    expect(transport).toHaveBeenCalledTimes(LOOKUP_MAX_PER_WINDOW);
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
    /*
     * WAS `toHaveBeenCalledTimes(2)`, with the comment "the client's one retry, which is its
     * business — asserted only so a change to it is a change somebody makes on purpose". This is
     * that change, made on purpose: the client no longer retries. The rate-limit comment at the
     * top of `callsign.ts` says one press of this button is one request to somebody else's
     * server, the README defends contacting a `Disallow: /` host on precisely that basis, and a
     * dropped connection was quietly making it two — with a second fresh timeout budget, measured
     * at 1808 ms against a 1000 ms limit. The number here is the number a site owner can count in
     * their own log, so it is the one the sentence has to match. See the note beside the two
     * assertions in `callsign/callook.test.ts` that changed with it.
     */
    expect(transport).toHaveBeenCalledTimes(1);
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

  /**
   * WHAT THE LIVE DEPLOYMENT ANSWERED ON 2026-08-09, AND WHY IT WAS THE WRONG ANSWER.
   *
   * `POST /api/callsign/lookup` with `N0CALLXX` returned `status: "not_us"` and "GrantSpotter can
   * only look up United States callsigns automatically… your licence is no less valid for being
   * issued somewhere this lookup cannot reach". `N0` is a US prefix. The string is a typo — six
   * suffix letters where the format allows four — and the person who made it was told their
   * American callsign was foreign. The route did not decide that; it repeated an `undefined` that
   * meant two things at once, which is why the fix is in `callsign/shape.ts` and this test is here
   * to hold the answer the route actually gives.
   */
  it('answers a mistyped US callsign `malformed`, not `not_us`, and asks nobody', async () => {
    const { app, transport } = buildApp({ user: MEMBER });
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'N0CALLXX' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('malformed');
    expect(res.body.message).toMatch(/check what you typed/i);
    expect(res.body.message).not.toMatch(/United States/);
    expect(transport).not.toHaveBeenCalled();
  });

  /**
   * The carve-out that already exists for a press that cannot become a request has to cover this
   * one too, and for a sharper reason than the foreign case: the person here has made a TYPO, and a
   * typo is the thing somebody corrects several times in a row. Charging for it would ration the
   * form against exactly the user who most needs another go at it.
   */
  it('spends no ration on presses that are not callsigns', async () => {
    const { app, transport } = buildApp({ user: MEMBER });

    for (let i = 0; i < LOOKUP_MAX_PER_WINDOW * 2; i += 1) {
      const res = await request(app).post('/api/callsign/lookup').send({ callsign: 'N0CALLXX' });
      expect(res.status, `press ${String(i + 1)}`).toBe(200);
      expect(res.body.status).toBe('malformed');
    }
    expect(transport).not.toHaveBeenCalled();

    // The allowance is whole: the press that follows the typos is a real lookup and is answered.
    const real = await request(app).post('/api/callsign/lookup').send({ callsign: 'W8UM' });
    expect(real.status).toBe(200);
    expect(real.body.status).toBe('found');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  /**
   * The shapes, at the route rather than at the classifier, because this is the layer a person
   * actually reaches. `''` is refused by the body schema before any of this — `callsign` is
   * `min(1)` — so the empty case arrives as whitespace, which is what an accidental space bar in
   * the field leaves behind.
   */
  it.each([
    ['too long', 'N0CALLXX'],
    ['too short', 'W1'],
    ['no digit', 'KANSAS'],
    ['two digits', 'W5X5'],
    ['punctuation', '???'],
    ['nothing but a space', ' '],
    ['an operating suffix', 'W1AW/4'],
  ])('answers `malformed` for %s (%s) without naming a country', async (_what, callsign) => {
    const { app, transport } = buildApp({ user: MEMBER });
    const res = await request(app).post('/api/callsign/lookup').send({ callsign });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('malformed');
    expect(res.body.message).not.toMatch(/United States|not a US/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it('refuses an empty callsign at the schema, before any of that', async () => {
    const { app, transport } = buildApp({ user: MEMBER });
    const res = await request(app).post('/api/callsign/lookup').send({ callsign: '' });

    expect(res.status).toBe(422);
    expect(transport).not.toHaveBeenCalled();
  });
});

/**
 * THE ROUTER EXISTED FOR A DAY AND NOTHING MOUNTED IT.
 *
 * Every test above passed against a router assembled inside this file, and the feature was
 * nevertheless entirely dead: `createCallsignRouter` had no caller, so `POST /api/callsign/lookup`
 * answered 404 in production while this suite was green. A unit test that builds its own app can
 * never see that, and it is the exact failure this project keeps finding — a green test pointing at
 * something that is not wired to anything.
 *
 * So this block reads the composition root as TEXT. `index.ts` calls `main()` at import time and
 * cannot be imported by a test; reading it is the only way to assert anything about it, and it is
 * enough to hold the three facts that would silently kill the feature again:
 *
 *   1. it is mounted at all;
 *   2. it is mounted BEFORE the SPA fallback — Express matches in registration order and
 *      `createSpaMiddleware` serves index.html for anything the routers above it did not claim,
 *      so a router registered after it is unreachable;
 *   3. it is handed NO first-run token.
 *
 * Fact 3 read the other way round until 2026-08-11 — "the router and `createApp` share ONE
 * BootstrapState, because two would mean two different random setup tokens, and the first-run
 * screen would hold one the lookup route never heard of". That was a correct guard on a wiring that
 * has been removed, so it is inverted rather than deleted: the same line of `index.ts` is still
 * worth watching, and what is now worth watching for is the argument coming BACK. A dead privilege
 * is easiest to restore by someone reading an old test that says it should be there.
 *
 * Comments are stripped first, for the reason `index.ts` states in its own header: a comment that
 * quotes a mount call is indistinguishable from a mount call to a scanner.
 */
describe('the composition root actually mounts this router', () => {
  const source = readFileSync(
    resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'index.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

  it('imports and mounts it on /api/callsign', () => {
    expect(source).toMatch(/import \{ createCallsignRouter \} from '\.\/api\/callsign\.js';/);
    expect(source).toMatch(/'\/api\/callsign',\s*\n?\s*createCallsignRouter\(/);
  });

  it('mounts it above the SPA fallback, which must stay last', () => {
    const mount = source.indexOf('createCallsignRouter(');
    const spa = source.indexOf('createSpaMiddleware(');
    expect(mount, 'createCallsignRouter is not mounted').toBeGreaterThan(-1);
    expect(spa, 'createSpaMiddleware is not mounted').toBeGreaterThan(-1);
    expect(mount, 'a router after the SPA fallback is unreachable').toBeLessThan(spa);
  });

  /**
   * THE ROUTE GETS THE TRANSPORT AND NOTHING ELSE, WHICH IS THE WHOLE OF THE FIX.
   *
   * `setupToken: () => bootstrap.token()` was the second argument, and it was the only reason an
   * unauthenticated request could reach callook.info at all. Asserted against the mount call rather
   * than against the file, so that a `bootstrap.token()` read somewhere else in the composition
   * root — there are legitimate ones — does not make this fail for the wrong reason.
   */
  it('hands it no first-run token, so there is nothing to authenticate anonymously with', () => {
    const mount = /createCallsignRouter\(\{[\s\S]*?\}\)/.exec(source)?.[0];
    expect(mount, 'the mount call is no longer in a shape this test can read').toBeTruthy();
    expect(mount).toContain('transport: callsignTransport');
    expect(mount, 'the retired setup-token privilege is wired up again').not.toMatch(/setupToken/);
    expect(mount).not.toMatch(/bootstrap/);
  });

  /**
   * The BootstrapState is still built once and still passed to `createApp` — that is the auth
   * routes' business and not this router's any more, but it is cheap to keep watching the one
   * thing that would be catastrophic here: this feature spending a token it must never touch.
   */
  it('never spends the one-time token from anywhere in the composition root', () => {
    expect(source).toMatch(/const bootstrap = createBootstrapState\(db\)/);
    expect(source).toMatch(/createApp\(\{\s*\n?\s*db,\s*\n?\s*config,\s*\n?\s*bootstrap,/);
    expect(source).not.toMatch(/bootstrap\.consume\(/);
  });

  it('lets the operator switch the whole feature off', () => {
    expect(source).toMatch(/if \(config\.callsignLookupEnabled\)/);
  });
});
