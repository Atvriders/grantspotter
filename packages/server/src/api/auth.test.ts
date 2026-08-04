import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createBootstrapState } from '../auth/bootstrap.js';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../auth/password.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { loadConfig } from '../config.js';
import { createUserRepo } from '../db/repositories/users.js';
import { createTestDb, type TestDb } from '../../test/helpers/tempDb.js';

/**
 * The FIRST-RUN half of the auth router.
 *
 * `test/api.auth.test.ts` covers login, /me, logout and the rate limiter. This file
 * covers only what a self-hoster meets on their very first boot — the one-time token
 * and the password floor — because both defects it pins were invisible to a suite that
 * only ever sent a well-formed bootstrap.
 */

const config = loadConfig({
  SESSION_SECRET: 'z'.repeat(32),
  CONTACT_URL: 'http://127.0.0.1:3030/grantspotter',
  NODE_ENV: 'test',
});

const GOOD_PASSWORD = 'a-long-enough-password';

let harness: TestDb;
beforeEach(() => {
  harness = createTestDb();
});
afterEach(() => harness.cleanup());

function build() {
  const bootstrap = createBootstrapState(harness.db, () => undefined);
  const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxFailures: 5 });
  const app = createApp({
    db: harness.db,
    config,
    bootstrap,
    loginLimiter,
    logger: () => undefined,
  });
  return { app, bootstrap };
}

describe('the first-run password floor', () => {
  it('states the requirement plainly rather than answering with a generic validation message', async () => {
    const { app, bootstrap } = build();
    const res = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token: bootstrap.token(), email: 'admin@example.org', password: 'short' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    // An operator who is told "the request body is invalid" has to guess which
    // field and which rule. The number is in the sentence on purpose.
    expect(res.body.error.message).toContain(String(MIN_PASSWORD_LENGTH));
    expect(res.body.error.message).toMatch(/password/i);
  });

  /**
   * THE DEFECT THIS FILE EXISTS FOR.
   *
   * `consume()` used to run BEFORE the password was checked, and `consume()` sets the
   * one-time token to null on a match. So an operator who typed a short password at the
   * first-run screen got a 422 telling them to pick a longer one — and by then the token
   * they had just copied out of `docker logs` was spent. Every subsequent attempt, with a
   * perfectly good password and the correct token, answered 401 "That bootstrap token is
   * not valid." `required()` still reported true, so the screen kept inviting them to try.
   * The only way out was restarting the container to mint a new token.
   *
   * A validation failure must cost the operator nothing. The token is spent only by an
   * attempt that would otherwise have created the account.
   */
  it('does not spend the one-time token on an attempt that failed the floor', async () => {
    const { app, bootstrap } = build();
    const token = bootstrap.token();

    const weak = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token, email: 'admin@example.org', password: 'short' });
    expect(weak.status).toBe(422);

    // Same token, second try, this time long enough.
    const retry = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token, email: 'admin@example.org', password: GOOD_PASSWORD });
    expect(retry.status).toBe(201);
    expect(retry.body.user.role).toBe('admin');
  });

  it('still spends the token once an account is actually created', async () => {
    const { app, bootstrap } = build();
    const token = bootstrap.token();

    expect(
      (
        await request(app)
          .post('/api/auth/bootstrap')
          .send({ token, email: 'admin@example.org', password: GOOD_PASSWORD })
      ).status,
    ).toBe(201);

    const second = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token, email: 'usurper@example.org', password: GOOD_PASSWORD });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
  });

  /**
   * The asymmetry is deliberate, and this is the test that keeps someone from
   * "tidying" it away.
   *
   * The floor belongs at the point that SETS a credential, never at the point that
   * CHECKS one. A minimum length on the sign-in body would (a) lock out whoever already
   * holds a short password — here, an account seeded straight into the table by a
   * migration, a restore, or an older release — and (b) tell an unauthenticated attacker
   * the policy for free, since a password below the floor would answer 422 where one
   * above it answers 401.
   */
  it('accepts a pre-existing short password at sign-in while refusing to create one', async () => {
    const { app, bootstrap } = build();

    // CREATE refuses the one-character password. Done first, while the instance is
    // still un-bootstrapped, so the 422 is the floor talking and not the "an account
    // already exists" 409 that would otherwise answer first.
    const created = await request(app)
      .post('/api/auth/bootstrap')
      .send({ token: bootstrap.token(), email: 'new@example.org', password: 'x' });
    expect(created.status).toBe(422);

    // The same one-character password, already in the table — how a restore, a
    // migration from an older release, or an operator's own SQL leaves it.
    createUserRepo(harness.db).create({
      email: 'legacy@example.org',
      passwordHash: await hashPassword('x'),
      role: 'admin',
    });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'legacy@example.org', password: 'x' });
    expect(login.status).toBe(200);
    expect(login.body.user.email).toBe('legacy@example.org');

    // And a below-floor password that is simply WRONG must be an ordinary 401,
    // byte-identical to any other wrong password. A 422 here would hand an
    // unauthenticated attacker the policy.
    const wrongShort = await request(app)
      .post('/api/auth/login')
      .send({ email: 'legacy@example.org', password: 'y' });
    expect(wrongShort.status).toBe(401);
    expect(wrongShort.body.error.message).toBe('Incorrect email or password.');
  });
});
