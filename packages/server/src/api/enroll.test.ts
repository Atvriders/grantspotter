import { Agent as httpAgent } from 'node:http';
import type Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { createBootstrapState } from '../auth/bootstrap.js';
import { hashPassword, MIN_PASSWORD_LENGTH, verifyPassword } from '../auth/password.js';
import { createRateLimiter } from '../auth/rateLimit.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { loadConfig } from '../config.js';
import {
  createEnrollmentCodeRepo,
  hashEnrollmentCode,
  type EnrollmentCodeRepo,
} from '../db/repositories/enrollmentCodes.js';
import { createUserRepo } from '../db/repositories/users.js';
import { createTestDb, type TestDb } from '../../test/helpers/tempDb.js';

/**
 * THE PUBLIC HALF OF ENROLMENT: `POST /api/auth/enroll` and `GET /api/auth/enrollment-open`.
 *
 * `test/api.auth.test.ts` covers login, /me and logout; `api/auth.test.ts` covers the first-run
 * token. This file covers the third way an account can come into existence — the one nobody has to
 * be present for — and the properties it has to hold are not the properties of a sign-in form:
 * exactly one account per available use no matter how many people press at once, one answer for
 * every wrong code, and never an administrator.
 *
 * IT DRIVES THE WHOLE APP (`createApp`) rather than the router in isolation, because half of what
 * is being asserted is about the composition: the JSON body limit, the error envelope, the session
 * cookie, and the ordering of the middleware that produces them.
 */

const config = loadConfig({
  SESSION_SECRET: 'z'.repeat(32),
  NODE_ENV: 'test',
  CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter',
});

const GOOD_PASSWORD = 'a-long-enough-password';
const ADMIN_ID = 'admin-1';

/** One argon2id hash, reused for every seeded row: this file has ~40 hashes to spare and no more. */
let seedHash: Promise<string> | undefined;
function seededPasswordHash(): Promise<string> {
  seedHash ??= hashPassword('a-seeded-password-not-a-real-secret');
  return seedHash;
}

let harness: TestDb;
let db: Database.Database;
let codes: EnrollmentCodeRepo;

beforeEach(async () => {
  harness = createTestDb();
  db = harness.db;
  codes = createEnrollmentCodeRepo(db);
  // A real administrator row: `enrollment_codes.created_by_user_id` references it, and its presence
  // is also what makes first-run bootstrap closed, which is the state a live deployment is in.
  db.prepare(
    `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at)
     VALUES (?, 'admin@example.org', 'admin@example.org', ?, 'admin', 'ics-admin', ?)`,
  ).run(ADMIN_ID, await seededPasswordHash(), '2026-09-01T00:00:00.000Z');
}, 30_000);

afterEach(() => harness.cleanup());

function build() {
  return createApp({
    db,
    config,
    bootstrap: createBootstrapState(db, () => undefined),
    loginLimiter: createRateLimiter({ windowMs: 15 * 60 * 1000, maxFailures: 5 }),
    logger: () => undefined,
  });
}

function issue(over: Partial<Parameters<EnrollmentCodeRepo['create']>[0]> = {}) {
  return codes.create({
    label: 'W1MX autumn 2026 intake',
    maxUses: null,
    expiresAt: null,
    createdByUserId: ADMIN_ID,
    nowISO: new Date().toISOString(),
    ...over,
  });
}

function memberCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'member'").get() as { n: number }
  ).n;
}

function usesOf(id: string): number {
  return codes.findById(id)?.uses ?? -1;
}

/** Status plus the error envelope, with the per-request id removed: what a caller can tell apart. */
function refusal(res: request.Response): unknown {
  return { status: res.status, error: res.body.error };
}

describe('enrolling with a code', () => {
  it('creates a member, signs them in, and spends exactly one use', async () => {
    const { code, plaintext } = issue({ maxUses: 30 });

    const res = await request(build()).post('/api/auth/enroll').send({
      code: plaintext,
      email: 'New.Student@Example.org',
      password: GOOD_PASSWORD,
      displayName: 'New Student',
    });

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({
      id: expect.any(String),
      email: 'New.Student@Example.org',
      displayName: 'New Student',
      role: 'member',
      createdAt: expect.any(String),
    });
    // Signed in on the way out: the point of enrolling is to arrive inside the product.
    const setCookie = res.headers['set-cookie'];
    expect((Array.isArray(setCookie) ? setCookie : [setCookie]).join(';')).toContain(
      `${SESSION_COOKIE}=`,
    );

    // The password they chose is the credential that was stored.
    const stored = createUserRepo(db).findByEmail('new.student@example.org');
    expect(stored).toBeDefined();
    expect(stored?.role).toBe('member');
    await expect(verifyPassword(stored!.passwordHash, GOOD_PASSWORD)).resolves.toBe(true);

    // Exactly one use, stamped.
    expect(codes.findById(code.id)).toMatchObject({ uses: 1, lastUsedAt: expect.any(String) });

    // …and an administrator can find out where this account came from, without the code appearing.
    const audit = db
      .prepare('SELECT actor_user_id, action, entity_type, detail FROM audit_log')
      .all() as Array<Record<string, string>>;
    expect(audit).toEqual([
      {
        actor_user_id: stored!.id,
        action: 'user.enroll',
        entity_type: 'user',
        detail: JSON.stringify({ enrollmentCodeId: code.id, label: 'W1MX autumn 2026 intake' }),
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain(plaintext.replace(/-/g, ''));
  }, 30_000);

  it('accepts the code as it was written down, not as it was generated', async () => {
    const { plaintext } = issue();
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: ` ${plaintext.toLowerCase()} `, email: 'a@example.org', password: GOOD_PASSWORD });
    expect(res.status).toBe(201);
  }, 30_000);

  it('never emits a hash, a token or anything else the account is held together with', async () => {
    const { plaintext } = issue();
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: GOOD_PASSWORD });

    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/argon2|passwordHash|icsToken/i);
    expect(body).not.toContain(createUserRepo(db).findByEmail('a@example.org')!.icsToken);
    expect(body).not.toContain(hashEnrollmentCode(plaintext));
  }, 30_000);
});

describe('enrolment never grants admin', () => {
  it('ignores a role the caller asked for, and makes a member', async () => {
    const { plaintext } = issue();
    const res = await request(build()).post('/api/auth/enroll').send({
      code: plaintext,
      email: 'aspiring@example.org',
      password: GOOD_PASSWORD,
      role: 'admin',
      isAdmin: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe('member');
    expect(createUserRepo(db).findByEmail('aspiring@example.org')?.role).toBe('member');
    // The only admin in this deployment is still the one that was seeded.
    expect(
      db.prepare("SELECT id FROM users WHERE role = 'admin'").all(),
    ).toEqual([{ id: ADMIN_ID }]);
  }, 30_000);
});

describe('a code that cannot be redeemed', () => {
  it('answers an unknown code and a wrong-but-plausible one identically', async () => {
    // A real code exists; neither of these is it. One is shaped exactly like a code from this
    // deployment's own alphabet, the other is the real code with its last character changed — the
    // guess somebody makes if they think they mistyped one character.
    const { code, plaintext } = issue();
    const app = build();

    const lastIsZero = plaintext.endsWith('0');
    const nearMiss = `${plaintext.slice(0, -1)}${lastIsZero ? '2' : '0'}`;
    expect(nearMiss).not.toBe(plaintext);

    const unknown = await request(app)
      .post('/api/auth/enroll')
      .send({ code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', email: 'a@example.org', password: GOOD_PASSWORD });
    const plausible = await request(app)
      .post('/api/auth/enroll')
      .send({ code: nearMiss, email: 'b@example.org', password: GOOD_PASSWORD });

    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('unauthorized');
    // Byte-identical, envelope and all: nothing here tells the caller that some OTHER code exists,
    // how many there are, or that they were one character away from one.
    expect(refusal(plausible)).toEqual(refusal(unknown));

    expect(memberCount()).toBe(0);
    expect(usesOf(code.id)).toBe(0);
  }, 30_000);

  it('tells the holder of a revoked code that it was withdrawn', async () => {
    const { code, plaintext } = issue();
    codes.revoke(code.id, new Date().toISOString());

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: GOOD_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/withdrawn/i);
    expect(memberCount()).toBe(0);
  }, 30_000);

  it('tells the holder of an expired code that it expired', async () => {
    const { plaintext } = issue({ expiresAt: '2020-01-01T00:00:00.000Z' });

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: GOOD_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/expired/i);
    expect(memberCount()).toBe(0);
  }, 30_000);

  /**
   * THE THIRTY-FIRST PERSON.
   *
   * A club officer issues a thirty-use code for an intake and thirty-one people turn up. The
   * thirty-first has typed everything correctly, has done nothing wrong, and is the single most
   * likely person in this whole feature to conclude that the product is broken and give up. What
   * this message has to do is tell them it is not their fault and name the one action that fixes
   * it — ask the person who gave them the code — rather than say "not valid" and let them retype
   * it eleven times.
   */
  it('tells the person who arrived after a code ran out that it is not their fault', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });
    const app = build();

    const first = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'first@example.org', password: GOOD_PASSWORD });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'second@example.org', password: GOOD_PASSWORD });

    expect(second.status).toBe(403);
    expect(second.body.error.message).toMatch(/already been used/i);
    // The two things the sentence exists to say.
    expect(second.body.error.message).toMatch(/not.*wrong|nothing is wrong/i);
    expect(second.body.error.message).toMatch(/ask the person who gave you the code/i);

    expect(memberCount()).toBe(1);
    expect(usesOf(code.id)).toBe(1);
  }, 30_000);
});

describe('a body that costs the holder nothing', () => {
  it('refuses a password below the floor without spending the code', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: 'short' });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    // The number is in the sentence: "the request body is invalid" makes them guess.
    expect(res.body.error.message).toContain(String(MIN_PASSWORD_LENGTH));

    // Their one place is still theirs.
    expect(usesOf(code.id)).toBe(0);
    expect(memberCount()).toBe(0);
    const retry = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: GOOD_PASSWORD });
    expect(retry.status).toBe(201);
  }, 30_000);

  it('refuses an address that already has an account without spending the code', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });
    createUserRepo(db).create({
      email: 'taken@example.org',
      passwordHash: await seededPasswordHash(),
      role: 'member',
    });

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'Taken@Example.org', password: GOOD_PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
    // The one action that gets this person into the product. Being told only "that did not work"
    // sends somebody who enrolled last term to their club officer instead of to the sign-in screen,
    // which is why this answer stays specific even though it is also an account-existence answer —
    // see `ENROLLMENT_CONFLICT_MAX` in api/auth.ts for what bounds the question instead.
    expect(res.body.error.message).toMatch(/sign in/i);
    expect(usesOf(code.id)).toBe(0);
    expect(memberCount()).toBe(1);
  }, 30_000);

  it('refuses something that could never be an email address', async () => {
    const { code, plaintext } = issue();
    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'not-an-address', password: GOOD_PASSWORD });

    expect(res.status).toBe(422);
    expect(usesOf(code.id)).toBe(0);
  }, 30_000);
});

/**
 * THE HEART OF THIS FEATURE, AND THE DEFECT IT IS SHAPED AGAINST.
 *
 * This project shipped a check-then-act with an `await` between the check and the write once
 * already, in the callsign lookup: eight concurrent presses all read the same empty ledger, all
 * passed a limit meant to allow one, and all sent a request. Nothing about that was visible to a
 * test that made the presses one after another.
 *
 * So the first test below is a CONTROL rather than a test of the product: it drives the naive shape
 * — read the row, await an argon2id hash, write `uses + 1` computed in JavaScript — through the
 * same `Promise.all` harness, and proves the harness genuinely overlaps by watching that shape
 * fail. Without it, the second test passing would be evidence of nothing: a harness that serialised
 * its requests would pass it just as happily against a broken implementation.
 */
describe('two people redeeming the last use at the same instant', () => {
  const RACERS = 6;

  it('CONTROL: the naive read-await-write shape hands out six accounts from a one-use code', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });
    const codeHash = hashEnrollmentCode(plaintext);
    const users = createUserRepo(db);

    // Deliberately NOT `repo.redeem`. This is what the route would look like if the check and the
    // write were separated by the password hash, which is the only await on the real path.
    async function naiveRedeem(email: string): Promise<boolean> {
      const row = db
        .prepare('SELECT id, uses, max_uses FROM enrollment_codes WHERE code_hash = ?')
        .get(codeHash) as { id: string; uses: number; max_uses: number | null };
      if (row.max_uses !== null && row.uses >= row.max_uses) return false;

      const passwordHash = await hashPassword(GOOD_PASSWORD);

      db.prepare('UPDATE enrollment_codes SET uses = ? WHERE id = ?').run(row.uses + 1, row.id);
      users.create({ email, passwordHash, role: 'member' });
      return true;
    }

    const results = await Promise.all(
      Array.from({ length: RACERS }, (_unused, i) => naiveRedeem(`racer-${String(i)}@example.org`)),
    );

    // Every one of them believed it had the last use. This is the bug, reproduced on purpose.
    expect(results.filter(Boolean)).toHaveLength(RACERS);
    expect(memberCount()).toBe(RACERS);

    // AND THE LEDGER DOES NOT EVEN RECORD IT. Measured, not predicted: this assertion was written
    // as `toBe(RACERS)` and came back 1. All six racers read `uses = 0` and all six wrote
    // `uses = 0 + 1`, so five of the writes are lost and the table ends up saying that a one-use
    // code was used once — while six accounts exist. An officer auditing this afterwards would see
    // nothing wrong at all, which is the part that makes this class of defect survive: it is silent
    // in exactly the record you would go and check. `uses = uses + 1` in the WHERE-guarded UPDATE
    // is what makes the count arithmetic rather than a guess.
    expect(usesOf(code.id)).toBe(1);
  }, 30_000);

  it('produces exactly one account, and exactly one use, from a one-use code', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });
    const app = build();

    const responses = await Promise.all(
      Array.from({ length: RACERS }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({
            code: plaintext,
            email: `racer-${String(i)}@example.org`,
            password: GOOD_PASSWORD,
          }),
      ),
    );

    const created = responses.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(memberCount()).toBe(1);
    expect(usesOf(code.id)).toBe(1);

    // The five who lost are told the truthful thing — the code ran out — and not "invalid".
    const losers = responses.filter((r) => r.status !== 201);
    expect(losers).toHaveLength(RACERS - 1);
    for (const loser of losers) {
      expect(loser.status).toBe(403);
      expect(loser.body.error.message).toMatch(/already been used/i);
    }
    // Exactly one account exists, and it belongs to whichever racer won.
    const emails = (db.prepare("SELECT email FROM users WHERE role = 'member'").all() as Array<{
      email: string;
    }>).map((r) => r.email);
    expect(emails).toHaveLength(1);
    expect(emails[0]).toMatch(/^racer-\d@example\.org$/);
    expect(created[0].body.user.email).toBe(emails[0]);
  }, 30_000);

  it('hands out no more than the limit when many race for a few places', async () => {
    const { code, plaintext } = issue({ maxUses: 2 });
    const app = build();

    const responses = await Promise.all(
      Array.from({ length: RACERS }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({
            code: plaintext,
            email: `crowd-${String(i)}@example.org`,
            password: GOOD_PASSWORD,
          }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
    expect(memberCount()).toBe(2);
    expect(usesOf(code.id)).toBe(2);
  }, 30_000);
});

/**
 * ONE VALID CODE USED AS A MEMBERSHIP DIRECTORY.
 *
 * The 409 above is genuinely useful to the person it is written for, and it is also an answer to
 * the question "does this address have an account here?" — which anybody holding one code could
 * ask about any address, as often as they liked. MEASURED, 2026-08-05: 200 probes with one
 * `maxUses: null` code, all 200 answered, nothing charged and nothing written down. A club
 * officer's code, shared with thirty people, was a membership oracle for the whole deployment.
 *
 * The counting is asserted in `api/authCost.test.ts`, which drives 200 of them. What is asserted
 * here is the product's side of the trade: the answer stays useful for the people who need it, the
 * SPECIFIC form of it is bounded per CODE, one code's budget is not another's — and running a
 * budget out does not stop anybody enrolling.
 *
 * TWO ASSERTIONS IN THIS BLOCK WERE CHANGED ON 2026-08-05, NOT WEAKENED. They read
 * `expect(refused.status).toBe(429)` and pinned the behaviour that the sixth caller to a probed
 * code — including a brand-new person with a fresh address — was refused for fifteen minutes. That
 * was the mechanism by which one honest returning student, pressing submit five times with the
 * right password, closed her club's intake for the other thirty (measured, 2026-08-05), and by
 * which a stranger holding the club's own code could keep it closed for 20 requests an hour. The
 * property those assertions were reaching for — that a caller past the budget cannot tell a member
 * from a stranger by the words they get back — is asserted below and asserted harder, because it
 * now also has to hold for the COST. What is gone is the refusal, and it was the defect.
 */
describe('what one code can be used to find out about other people', () => {
  const CONFLICT_MAX = 5;

  async function seedMember(email: string): Promise<void> {
    createUserRepo(db).create({
      email,
      passwordHash: await seededPasswordHash(),
      role: 'member',
    });
  }

  it('answers five people plainly, then stops naming anybody, and never stops enrolling', async () => {
    const { code, plaintext } = issue();
    const app = build();
    for (let i = 0; i < CONFLICT_MAX + 1; i += 1) await seedMember(`member-${String(i)}@x.org`);

    async function ask(i: number) {
      return request(app)
        .post('/api/auth/enroll')
        .send({ code: plaintext, email: `member-${String(i)}@x.org`, password: GOOD_PASSWORD });
    }

    for (let i = 0; i < CONFLICT_MAX; i += 1) {
      const answered = await ask(i);
      expect(answered.status).toBe(409);
      expect(answered.body.error.message).toMatch(/sign in/i);
      // The specific answer, which is the one worth rationing: it names the address, which is what
      // turns "that did not work" into "go to the sign-in screen".
      expect(answered.body.error.message).toContain(`member-${String(i)}@x.org`);
    }

    // The sixth is still answered, still told where to go, and told nothing about anybody.
    const vague = await ask(CONFLICT_MAX);
    expect(vague.status).toBe(409);
    expect(vague.body.error.message).toMatch(/sign in/i);
    expect(vague.body.error.message).not.toContain(`member-${String(CONFLICT_MAX)}@x.org`);
    expect(vague.body.error.code).toBe('conflict');

    // AND THE CODE IS STILL A CODE. This is what the old `toBe(429)` denied: the person after the
    // probing is a stranger with a fresh address and a real code, and nothing anybody did to that
    // budget is any of her business.
    const newcomer = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'brand-new@x.org', password: GOOD_PASSWORD });
    expect(newcomer.status).toBe(201);
    expect(usesOf(code.id)).toBe(1);
    expect(memberCount()).toBe(CONFLICT_MAX + 2);

    // Said as its own assertion because it is the property, not a side effect of the two above:
    // running this budget out refuses nobody.
    for (const res of [vague, newcomer]) expect(res.status).not.toBe(429);
  }, 60_000);

  it('bounds the specific answer per code, so one probed code does not blunt another club’s', async () => {
    const probed = issue({ label: 'probed' });
    const other = issue({ label: 'another club' });
    const app = build();
    for (let i = 0; i < CONFLICT_MAX; i += 1) await seedMember(`member-${String(i)}@x.org`);

    for (let i = 0; i < CONFLICT_MAX; i += 1) {
      expect(
        (
          await request(app).post('/api/auth/enroll').send({
            code: probed.plaintext,
            email: `member-${String(i)}@x.org`,
            password: GOOD_PASSWORD,
          })
        ).status,
      ).toBe(409);
    }
    // Spent: this code's answers are now the vague one, and still 409, and still not a refusal.
    const blunted = await request(app)
      .post('/api/auth/enroll')
      .send({ code: probed.plaintext, email: 'member-0@x.org', password: GOOD_PASSWORD });
    expect(blunted.status).toBe(409);
    expect(blunted.body.error.message).not.toContain('member-0@x.org');

    // The other club's code has its own budget and its own intake, and neither has moved.
    const theirs = await request(app)
      .post('/api/auth/enroll')
      .send({ code: other.plaintext, email: 'member-0@x.org', password: GOOD_PASSWORD });
    expect(theirs.status).toBe(409);
    expect(theirs.body.error.message).toContain('member-0@x.org');
    const newPerson = await request(app)
      .post('/api/auth/enroll')
      .send({ code: other.plaintext, email: 'brand-new@x.org', password: GOOD_PASSWORD });
    expect(newPerson.status).toBe(201);
    expect(usesOf(other.code.id)).toBe(1);
    // …and the probed code has still spent nothing, because a conflict rolls its transaction back.
    expect(usesOf(probed.code.id)).toBe(0);

    // The probed code still enrols the person it was issued for.
    const student = await request(app)
      .post('/api/auth/enroll')
      .send({ code: probed.plaintext, email: 'late-student@x.org', password: GOOD_PASSWORD });
    expect(student.status).toBe(201);
    expect(usesOf(probed.code.id)).toBe(1);
  }, 60_000);

  it('writes each answered question against the code, and never the address it was asked about', async () => {
    const { code, plaintext } = issue();
    await seedMember('quiet-member@x.org');

    const res = await request(build())
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'quiet-member@x.org', password: GOOD_PASSWORD });
    expect(res.status).toBe(409);

    const trail = db
      .prepare('SELECT actor_user_id, action, entity_type, entity_id, detail FROM audit_log')
      .all() as Array<Record<string, string | null>>;
    expect(trail).toEqual([
      {
        // Nobody signed in did this: the actor is an anonymous caller holding a code. Naming the
        // code's issuer here would be a false statement in the one record kept to be believed.
        actor_user_id: null,
        action: 'enrollment_code.conflict',
        entity_type: 'enrollment_code',
        entity_id: code.id,
        detail: JSON.stringify({ label: 'W1MX autumn 2026 intake' }),
      },
    ]);
    // An administrator learns WHICH CREDENTIAL is being used this way, which is what they can act
    // on. A trail of the addresses would be the very list this limit exists to stop somebody
    // building — and it would be readable by more people than the one who asked.
    expect(JSON.stringify(trail)).not.toContain('quiet-member@x.org');
  }, 30_000);

  /**
   * THE ROW AN ADMINISTRATOR ACTS ON, written by the answer that spends the budget and by no other.
   *
   * Five specific answers is where this code stops naming people, and an operator who is going to
   * revoke a credential needs to be told that it happened. The sixth, seventh and hundredth probe
   * write nothing: an audit trail a caller can fill at will is one that hides everything else in
   * it, which is the reason the row is bound to the transition and not to the condition.
   */
  it('records the moment a code stops naming people, once, against the code', async () => {
    const { code, plaintext } = issue();
    const app = build();
    for (let i = 0; i < CONFLICT_MAX + 3; i += 1) await seedMember(`m${String(i)}@x.org`);

    for (let i = 0; i < CONFLICT_MAX + 3; i += 1) {
      await request(app)
        .post('/api/auth/enroll')
        .send({ code: plaintext, email: `m${String(i)}@x.org`, password: GOOD_PASSWORD });
    }

    const paused = db
      .prepare(
        "SELECT actor_user_id, entity_id, detail FROM audit_log WHERE action = 'enrollment_code.conflict_paused'",
      )
      .all() as Array<Record<string, string | null>>;
    expect(paused).toEqual([
      {
        actor_user_id: null,
        entity_id: code.id,
        detail: JSON.stringify({
          label: 'W1MX autumn 2026 intake',
          answers: CONFLICT_MAX,
          windowSec: 900,
        }),
      },
    ]);
    // Five specific answers plus this one, and not one row for the three probes after it.
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'enrollment_code.conflict'")
          .get() as { n: number }
      ).n,
    ).toBe(CONFLICT_MAX);
    expect(JSON.stringify(paused)).not.toContain('@x.org');
  }, 60_000);
});

/**
 * THE MEASUREMENTS THAT REFUTED THE FIRST VERSION OF THIS FEATURE, TURNED INTO ASSERTIONS.
 *
 * Every `it` in this block corresponds to something an adversarial reader demonstrated on
 * 2026-08-05 against the previous commit, with the number they measured in the comment. None of
 * these were visible to the suite as it stood, because every one of them is about what a limit does
 * to somebody who is NOT attacking, and the suite only ever asserted what it does to somebody who
 * is.
 */
describe('what a limit must never do to the people it is not aimed at', () => {
  async function seedMember(email: string): Promise<void> {
    createUserRepo(db).create({ email, passwordHash: await seededPasswordHash(), role: 'member' });
  }

  /**
   * MEASURED before the fix: five presses, and a DIFFERENT student was answered 429 with
   * retryAfterSec 900. No attacker, no wrong code, no wrong password — a returning student who had
   * forgotten she already had an account, pressing the button.
   */
  it('lets one returning student press submit six times without closing her club’s intake', async () => {
    const { plaintext } = issue({ maxUses: 30 });
    const app = build();
    await seedMember('returning.student@example.org');

    for (let press = 1; press <= 6; press += 1) {
      const res = await request(app).post('/api/auth/enroll').send({
        code: plaintext,
        email: 'returning.student@example.org',
        password: GOOD_PASSWORD,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/sign in/i);
    }

    const classmate = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'student-01@example.org', password: GOOD_PASSWORD });
    expect(classmate.status).toBe(201);
    expect(memberCount()).toBe(2);
  }, 60_000);

  /**
   * MEASURED before the fix: 12 wrong codes from an address with no code at all, and the honest
   * student holding a real one was answered 429 with retryAfterSec 900. 48 requests held every club
   * on the deployment closed for an hour.
   *
   * The guess budget still closes — the eleventh wrong code from this connection is refused, which
   * `closes the door after ten wrong codes` pins — but a caller holding a code this deployment
   * issued never reads that counter, so nothing a guesser does can reach them.
   */
  it('does not let a stranger’s wrong codes close enrolment for somebody with a real one', async () => {
    const { plaintext } = issue({ maxUses: 30 });
    const app = build();

    for (let i = 0; i < 12; i += 1) {
      await request(app)
        .post('/api/auth/enroll')
        .send({
          code: `ZZZZZ-ZZZZZ-ZZZZZ-ZZZ${String(i).padStart(2, '0')}`,
          email: `junk-${String(i)}@example.net`,
          password: GOOD_PASSWORD,
        });
    }

    const student = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'legit@example.org', password: GOOD_PASSWORD });
    expect(student.status).toBe(201);
    expect(memberCount()).toBe(1);
  }, 60_000);

  /**
   * The guess budget is per caller as well, so even two people who are BOTH getting it wrong do not
   * spend each other's patience. Two real sockets with different source addresses: 127.0.0.0/8 is
   * all local on Linux, and with no `X-Forwarded-For` in play express reports the peer, so this is a
   * genuinely different client rather than a header saying so.
   */
  it('spends one connection’s guesses without spending another’s', async () => {
    issue();
    const app = build();
    const noisy = new httpAgent({ localAddress: '127.0.0.2' });

    for (let i = 0; i < 12; i += 1) {
      await request(app)
        .post('/api/auth/enroll')
        .agent(noisy)
        .send({
          code: `ZZZZZ-ZZZZZ-ZZZZZ-ZZZ${String(i).padStart(2, '0')}`,
          email: `junk-${String(i)}@example.net`,
          password: GOOD_PASSWORD,
        });
    }
    const noisyAgain = await request(app)
      .post('/api/auth/enroll')
      .agent(noisy)
      .send({ code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZ99', email: 'j@example.net', password: GOOD_PASSWORD });
    expect(noisyAgain.status).toBe(429);

    // Somebody else, mistyping their own code for the first time, is answered about the code.
    const elsewhere = await request(app)
      .post('/api/auth/enroll')
      .send({ code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZ98', email: 'other@example.org', password: GOOD_PASSWORD });
    expect(elsewhere.status).toBe(401);
  }, 60_000);

  /**
   * MEASURED before the fix: `audit_log` was EMPTY after ten wrong codes had closed enrolment for
   * the whole deployment. The operator saw a page refusing everybody and had nothing to read.
   */
  it('writes one row when a connection is cut off, with no address and no code in it', async () => {
    issue();
    const app = build();

    for (let i = 0; i < 14; i += 1) {
      await request(app)
        .post('/api/auth/enroll')
        .send({
          code: `ZZZZZ-ZZZZZ-ZZZZZ-ZZZ${String(i).padStart(2, '0')}`,
          email: `junk-${String(i)}@example.net`,
          password: GOOD_PASSWORD,
        });
    }

    const rows = db
      .prepare(
        "SELECT actor_user_id, entity_type, entity_id, detail FROM audit_log WHERE action = 'enrollment.code_guessing'",
      )
      .all() as Array<Record<string, string | null>>;
    // ONE row, not fourteen: written by the guess that closed the budget, not by every refusal
    // after it.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_user_id: null, entity_type: 'enrollment' });
    // Where from, coarsely, so the operator can recognise their own NAT or block a building —
    // never the host, and never a code or an address, neither of which this caller even had.
    expect(rows[0].entity_id).toMatch(/\/(24|48)$/);
    expect(JSON.stringify(rows)).not.toContain('example.net');
    expect(JSON.stringify(rows)).not.toContain('ZZZZZ');
  }, 60_000);

  /**
   * MEASURED before the fix: 30 valid students pressing submit together produced 10 accounts and 20
   * answers of "Too many enrollment attempts. Try again later." The budget meant to bound argon2id
   * was being charged for the successes as well as the guesses.
   */
  it('gives thirty students with a valid code thirty accounts, all at once', async () => {
    const { code, plaintext } = issue({ maxUses: 30 });
    const app = build();

    const responses = await Promise.all(
      Array.from({ length: 30 }, (_unused, i) =>
        request(app)
          .post('/api/auth/enroll')
          .send({
            code: plaintext,
            email: `student-${String(i)}@example.org`,
            password: GOOD_PASSWORD,
          }),
      ),
    );

    expect(responses.filter((r) => r.status === 201)).toHaveLength(30);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(0);
    expect(memberCount()).toBe(30);
    expect(usesOf(code.id)).toBe(30);
  }, 120_000);

  /**
   * THE ORACLE THAT THE PREVIOUS FIX OPENED, closed by ordering.
   *
   * MEASURED before the fix: one valid code and a ONE-CHARACTER password answered 409 naming the
   * address for a member and 422 "Password must be at least 12 characters." for anybody else. The
   * 422 was unmetered, unlogged and free — 2,000 addresses classified in 2,983 ms.
   *
   * The floor is checked first, so this body cannot separate anybody from anybody. It is not
   * reachable from the product at all: `routes/Enroll.tsx` checks the same floor before it POSTs.
   */
  it('answers a too-short password identically for a member and a stranger', async () => {
    const { code, plaintext } = issue();
    const app = build();
    await seedMember('officer@example.org');

    const member = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'officer@example.org', password: 'x' });
    const stranger = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'nobody@example.org', password: 'x' });

    expect(member.status).toBe(422);
    // Byte-identical, envelope and all.
    expect(refusal(member)).toEqual(refusal(stranger));
    expect(usesOf(code.id)).toBe(0);
    expect(memberCount()).toBe(1);
  }, 30_000);

  /**
   * WHAT STILL BOUNDS THE ORACLE, now that a probe past the disclosure budget is answered rather
   * than refused: the code's own `maxUses`.
   *
   * Classifying an address that is NOT a member costs a place, because the answer IS the account.
   * A thirty-use code therefore buys about thirty of those and then answers 403 to everybody,
   * including the caller doing the asking — and it does so from `inspect`, before the address is
   * ever looked up, so an exhausted code cannot be used to ask about anybody at all. An officer who
   * issues `maxUses: null` has issued something else, which is why that is an explicit decision.
   */
  it('stops answering about anybody once the code it was asked with has run out', async () => {
    const { plaintext } = issue({ maxUses: 2 });
    const app = build();
    await seedMember('officer@example.org');

    for (let i = 0; i < 2; i += 1) {
      expect(
        (
          await request(app)
            .post('/api/auth/enroll')
            .send({ code: plaintext, email: `probe-${String(i)}@x.org`, password: GOOD_PASSWORD })
        ).status,
      ).toBe(201);
    }

    // The code is spent. Now the two questions that used to be tellable apart:
    const aboutMember = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'officer@example.org', password: GOOD_PASSWORD });
    const aboutStranger = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'nobody@x.org', password: GOOD_PASSWORD });

    expect(aboutMember.status).toBe(403);
    expect(refusal(aboutMember)).toEqual(refusal(aboutStranger));
    expect(memberCount()).toBe(3);
  }, 60_000);

  /**
   * The same body against a code that is NOT valid: the password floor answers first there too, so
   * a short password cannot be used to sort real codes from wrong ones either.
   */
  it('answers a too-short password identically for a real code and a wrong one', async () => {
    const { plaintext } = issue();
    const app = build();

    const real = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: 'x' });
    const wrong = await request(app)
      .post('/api/auth/enroll')
      .send({ code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZ2', email: 'a@example.org', password: 'x' });

    expect(real.status).toBe(422);
    expect(refusal(real)).toEqual(refusal(wrong));
  }, 30_000);
});

describe('the rate limiter is what makes the entropy mean something', () => {
  /**
   * The shipped numbers, not injected ones: ten wrong codes in fifteen minutes, PER CONNECTION.
   * There is no seam to inject a smaller limiter through `createApp` — `AppDeps` does not carry one
   * — and testing the real configuration is worth more than testing a fake anyway, because the
   * number that matters operationally is the one that ships. Every request below comes down one
   * loopback connection, which is why ten is still ten here; the test above named
   * "spends one connection's guesses without spending another's" is the other half.
   */
  it('closes the door after ten wrong codes and says how long for', async () => {
    issue();
    const app = build();

    async function guess(n: number) {
      return request(app)
        .post('/api/auth/enroll')
        .send({
          code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZ2',
          email: `guess-${String(n)}@example.org`,
          password: GOOD_PASSWORD,
        });
    }

    for (let i = 0; i < 10; i += 1) {
      expect((await guess(i)).status).toBe(401);
    }

    const blocked = await guess(10);
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    expect(blocked.body.error.details.retryAfterSec).toBeGreaterThan(0);
    expect(memberCount()).toBe(0);
  }, 60_000);

  it('does not charge the holder of a real code that has run out', async () => {
    const { plaintext } = issue({ maxUses: 1 });
    const app = build();
    expect(
      (
        await request(app)
          .post('/api/auth/enroll')
          .send({ code: plaintext, email: 'first@example.org', password: GOOD_PASSWORD })
      ).status,
    ).toBe(201);

    // Eleven attempts with a REAL code that has run out — one more than the failure budget. Their
    // holder is not guessing, so none of them is charged and the eleventh is still answered with
    // the truth rather than with a lockout.
    for (let i = 0; i < 11; i += 1) {
      const res = await request(app)
        .post('/api/auth/enroll')
        .send({ code: plaintext, email: `late-${String(i)}@example.org`, password: GOOD_PASSWORD });
      expect(res.status).toBe(403);
    }
  }, 60_000);

  /**
   * WHAT THIS TEST USED TO SAY, AND WHY IT NO LONGER SAYS IT.
   *
   * It was called "forgets the failures as soon as somebody enrolls successfully", and it asserted
   * the `reset()` the handler used to run on a successful redemption. That reset was a hole in the
   * ceiling this whole describe block is about: a holder of a multi-use code could alternate nine
   * wrong codes with one real redemption and start again. MEASURED, 2026-08-05, five rounds of that
   * loop: 45 wrong-code guesses answered inside one fifteen-minute window, against a budget of ten.
   *
   * The old assertions are not weakened here — the last one (`after.status === 401`) still holds
   * and is still asserted below, because the tenth guess IS answered; it was simply never evidence
   * of the property its title claimed, since ten guesses fit in the budget whether or not the
   * success cleared it. What follows adds the eleventh, which is the request that tells the two
   * behaviours apart.
   *
   * The intake itself still carries on: a success is never charged, and neither is a real code that
   * has expired or run out (the two tests above). What no longer happens is a success paying off
   * somebody else's guesses.
   */
  it('counts the wrong codes through a success rather than forgetting them', async () => {
    const { plaintext } = issue({ maxUses: 5 });
    const app = build();

    async function guess(who: string) {
      return request(app)
        .post('/api/auth/enroll')
        .send({
          code: 'ZZZZZ-ZZZZZ-ZZZZZ-ZZZZ2',
          email: `${who}@example.org`,
          password: GOOD_PASSWORD,
        });
    }

    for (let i = 0; i < 9; i += 1) {
      expect((await guess(`guess-${String(i)}`)).status).toBe(401);
    }

    // Nine wrong codes have not closed the door on the person who has a real one.
    const good = await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'real@example.org', password: GOOD_PASSWORD });
    expect(good.status).toBe(201);

    // The tenth guess is the last one the budget allows…
    expect((await guess('another')).status).toBe(401);
    // …and the eleventh is refused, because the success in the middle bought nobody a fresh nine.
    const blocked = await guess('eleventh');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');
  }, 60_000);
});

describe('whether the sign-in screen should offer to enrol at all', () => {
  it('is false on a deployment that has never issued a code', async () => {
    const res = await request(build()).get('/api/auth/enrollment-open');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ open: false });
  });

  it('is true while one code could be redeemed, and false once none can', async () => {
    const { code, plaintext } = issue({ maxUses: 1 });
    const app = build();
    expect((await request(app).get('/api/auth/enrollment-open')).body).toEqual({ open: true });

    await request(app)
      .post('/api/auth/enroll')
      .send({ code: plaintext, email: 'a@example.org', password: GOOD_PASSWORD });

    expect(usesOf(code.id)).toBe(1);
    expect((await request(app).get('/api/auth/enrollment-open')).body).toEqual({ open: false });
  }, 30_000);

  it('answers one boolean and nothing else — no label, no count, no id', async () => {
    issue({ label: 'W1MX autumn 2026 intake', maxUses: 30 });
    const res = await request(build()).get('/api/auth/enrollment-open');
    expect(Object.keys(res.body)).toEqual(['open']);
    expect(JSON.stringify(res.body)).not.toMatch(/W1MX|30|intake/);
  });
});
