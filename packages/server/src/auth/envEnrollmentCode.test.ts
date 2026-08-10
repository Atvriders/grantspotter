import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveEnrollmentCode } from '../config.js';
import { createEnrollmentCodeRepo } from '../db/repositories/enrollmentCodes.js';
import { openTestDb } from '../test/testDb.js';
import {
  ENV_CODE_DEFAULT_DAYS,
  ENV_CODE_DEFAULT_MAX_USES,
  ENV_CODE_LABEL,
  isEnvCodeLabel,
} from './chosenCode.js';
import { syncEnvEnrollmentCode, type EnvCodeOutcome } from './envEnrollmentCode.js';

const NOW = '2026-09-01T12:00:00.000Z';
const A_DAY_LATER = '2026-09-02T12:00:00.000Z';

/** A code that clears the twelve-character floor and is nobody's real intake. */
const CODE = 'W9XYZ-FIELDDAY-QRP-2027';
const OTHER = 'W9XYZ-HAMFEST-BOOTH-2027';

let db: Database.Database;
const logged: string[] = [];

/**
 * Raw SQL rather than `createUserRepo`, for the reason `enrollmentCodes.test.ts` gives: the only
 * thing the foreign key needs is a real `users.id`, and `users.create` costs an argon2id hash this
 * file has no use for.
 */
function insertUser(id: string, over: { role?: string; disabled?: 0 | 1; at?: string } = {}): string {
  db.prepare(
    `INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, disabled, created_at)
     VALUES (?, ?, ?, 'not-a-real-hash', ?, ?, ?, ?)`,
  ).run(
    id,
    `${id}@example.org`,
    `${id}@example.org`,
    over.role ?? 'admin',
    `ics-${id}`,
    over.disabled ?? 0,
    over.at ?? NOW,
  );
  return id;
}

function sync(code: string | undefined, nowISO = NOW, over: { maxUses?: number; days?: number } = {}): EnvCodeOutcome {
  return syncEnvEnrollmentCode({
    db,
    spec:
      code === undefined
        ? undefined
        : {
            code,
            maxUses: over.maxUses ?? ENV_CODE_DEFAULT_MAX_USES,
            days: over.days ?? ENV_CODE_DEFAULT_DAYS,
          },
    nowISO,
    log: (line) => logged.push(line),
  });
}

function envRows() {
  return createEnrollmentCodeRepo(db)
    .list()
    .filter((c) => isEnvCodeLabel(c.label));
}

function auditRows(): Array<{ action: string; actor: string | null; detail: string }> {
  return db
    .prepare('SELECT action, actor_user_id AS actor, detail FROM audit_log ORDER BY at, rowid')
    .all() as Array<{ action: string; actor: string | null; detail: string }>;
}

beforeEach(() => {
  db = openTestDb();
  logged.length = 0;
});

afterEach(() => {
  db.close();
});

/**
 * THE VALUE IS REFUSED BEFORE THE DATABASE IS EVER OPENED, and these are the refusals that stop the
 * process. Everything a pure function can decide is decided here, so that no boot which nobody
 * asked for can ever meet one of them — see `resolveEnrollmentCode` for why the line is drawn
 * exactly here and not one layer further in.
 */
describe('what ENROLLMENT_CODE has to be before the server will start', () => {
  it('is absent by default, and an empty value is the same as no value', () => {
    expect(resolveEnrollmentCode({})).toBeUndefined();
    expect(resolveEnrollmentCode({ ENROLLMENT_CODE: '' })).toBeUndefined();
    expect(resolveEnrollmentCode({ ENROLLMENT_CODE: '   ' })).toBeUndefined();
  });

  it('carries the operator string unchanged, with both bounds filled in', () => {
    expect(resolveEnrollmentCode({ ENROLLMENT_CODE: CODE })).toEqual({
      code: CODE,
      maxUses: ENV_CODE_DEFAULT_MAX_USES,
      days: ENV_CODE_DEFAULT_DAYS,
    });
  });

  it('never leaves a compose-set code unbounded, whatever the operator omits', () => {
    // The whole of the "must not quietly become the one chosen code with no bound" requirement,
    // asserted against the two fields rather than against the defaults' values.
    for (const env of [
      { ENROLLMENT_CODE: CODE },
      { ENROLLMENT_CODE: CODE, ENROLLMENT_CODE_MAX_USES: '5' },
      { ENROLLMENT_CODE: CODE, ENROLLMENT_CODE_DAYS: '7' },
    ]) {
      const spec = resolveEnrollmentCode(env);
      expect(spec?.maxUses, JSON.stringify(env)).toBeGreaterThan(0);
      expect(spec?.days, JSON.stringify(env)).toBeGreaterThan(0);
    }
  });

  it('refuses a code under the floor with the same sentence the admin console gives', () => {
    expect(() => resolveEnrollmentCode({ ENROLLMENT_CODE: 'W9XYZ-2027' })).toThrow(ConfigError);
    expect(() => resolveEnrollmentCode({ ENROLLMENT_CODE: 'W9XYZ-2027' })).toThrow(
      /has to be at least 12/,
    );
    // And it says the way out, which is the half that makes refusing to start proportionate for an
    // optional value: the escape hatch is cheaper than the fix.
    expect(() => resolveEnrollmentCode({ ENROLLMENT_CODE: 'W9XYZ-2027' })).toThrow(
      /delete the ENROLLMENT_CODE line/,
    );
  });

  it('holds the two companions to the ceilings a chosen code has, not to a bigger one', () => {
    expect(() =>
      resolveEnrollmentCode({ ENROLLMENT_CODE: CODE, ENROLLMENT_CODE_MAX_USES: '201' }),
    ).toThrow(/at most 200 accounts/);
    expect(() =>
      resolveEnrollmentCode({ ENROLLMENT_CODE: CODE, ENROLLMENT_CODE_DAYS: '366' }),
    ).toThrow(/at most 365 days/);
  });

  it('refuses a companion that is not a whole number rather than reading half of it', () => {
    // `Number()` and not `parseInt`: "30 accounts" must not silently become thirty.
    expect(() =>
      resolveEnrollmentCode({ ENROLLMENT_CODE: CODE, ENROLLMENT_CODE_MAX_USES: '30 accounts' }),
    ).toThrow(/ENROLLMENT_CODE_MAX_USES must be a whole number/);
    expect(() =>
      resolveEnrollmentCode({ ENROLLMENT_CODE: CODE, ENROLLMENT_CODE_DAYS: '0' }),
    ).toThrow(/ENROLLMENT_CODE_DAYS must be a whole number/);
  });

  it('ignores the companions entirely when no code is set', () => {
    // A bound with nothing to bind is not worth a refusal to start.
    expect(
      resolveEnrollmentCode({ ENROLLMENT_CODE_MAX_USES: 'nonsense', ENROLLMENT_CODE_DAYS: '-4' }),
    ).toBeUndefined();
  });

  it('answers a pasted key as a paste rather than as a code that is the wrong length', () => {
    expect(() => resolveEnrollmentCode({ ENROLLMENT_CODE: 'A'.repeat(200) })).toThrow(
      /at most 96/,
    );
  });

  it('rides on loadConfig, so a bad value stops the process the two other values stop it', () => {
    const base = { SESSION_SECRET: 'f'.repeat(64), CONTACT_URL: 'https://w9xyz.org/about' };
    expect(loadConfig(base).enrollmentCode).toBeUndefined();
    expect(loadConfig({ ...base, ENROLLMENT_CODE: CODE }).enrollmentCode?.code).toBe(CODE);
    expect(() => loadConfig({ ...base, ENROLLMENT_CODE: 'short' })).toThrow(ConfigError);
  });
});

/**
 * THE INVARIANT EVERY BRANCH SERVES: at most one code from the file is live, and it is the one the
 * file names right now. Each test below is that sentence against a state the table can be in.
 */
describe('what a boot does about the code in the compose file', () => {
  it('does nothing, and says nothing, on the deployments that set nothing', () => {
    insertUser('admin-1');
    expect(sync(undefined)).toEqual({ kind: 'off' });
    expect(logged).toEqual([]);
    expect(envRows()).toEqual([]);
    expect(auditRows()).toEqual([]);
  });

  it('creates a real row an administrator can see, revoke and count', () => {
    insertUser('admin-1');
    const outcome = sync(CODE);
    expect(outcome.kind).toBe('created');

    const [row] = envRows();
    expect(row?.label).toBe(ENV_CODE_LABEL);
    // A code somebody typed IS a chosen code, whichever door it came through, and the admin table
    // has to say so — this one can be thought of, unlike twenty random characters.
    expect(row?.chosen).toBe(true);
    expect(row?.maxUses).toBe(ENV_CODE_DEFAULT_MAX_USES);
    expect(row?.uses).toBe(0);
    expect(row?.createdByUserId).toBe('admin-1');
    expect(row?.expiresAt).toBe(
      new Date(Date.parse(NOW) + ENV_CODE_DEFAULT_DAYS * 86_400_000).toISOString(),
    );
  });

  it('writes the code and its digest nowhere a person can read them', () => {
    insertUser('admin-1');
    sync(CODE);
    const everything = `${logged.join('\n')}\n${JSON.stringify(auditRows())}\n${JSON.stringify(envRows())}`;
    // The whole point of the table storing a keyed digest survives the new door only if the new
    // door does not print the thing the digest exists to hide.
    expect(everything).not.toContain(CODE);
    expect(everything).not.toContain('W9XYZFIE1DDAYQRP2027');
    expect(everything.toLowerCase()).not.toContain(CODE.toLowerCase());
  });

  it('leaves the row completely alone on a second boot with the same value', () => {
    insertUser('admin-1');
    sync(CODE);
    const before = envRows()[0];

    // A day later, and with the operator having since edited the bounds. Neither may move the row:
    // a restart that recomputed the expiry would make a weekly-restarted container immortal.
    const outcome = sync(CODE, A_DAY_LATER, { maxUses: 200, days: 365 });
    expect(outcome.kind).toBe('unchanged');
    expect(envRows()).toEqual([before]);
    expect(auditRows()).toHaveLength(1);
  });

  it('keeps the uses a second boot inherits, rather than resetting the count', () => {
    insertUser('admin-1');
    sync(CODE);
    const repo = createEnrollmentCodeRepo(db);
    expect(repo.redeem({ plaintext: CODE, nowISO: NOW }, () => 'an account').ok).toBe(true);

    sync(CODE, A_DAY_LATER);
    expect(envRows()[0]?.uses).toBe(1);
  });

  it('withdraws the old code and issues the new one when the value changes', () => {
    insertUser('admin-1');
    sync(CODE);
    const outcome = sync(OTHER, A_DAY_LATER);
    expect(outcome.kind).toBe('created');

    const rows = envRows();
    expect(rows).toHaveLength(2);
    // The old row is REVOKED and not deleted: its label, its use count and its history are the
    // evidence an operator wants on the day they ask what that code did.
    const repo = createEnrollmentCodeRepo(db);
    expect(repo.findByCode(CODE)?.revokedAt).toBe(A_DAY_LATER);
    expect(repo.findByCode(OTHER)?.revokedAt).toBeNull();
    expect(repo.inspect(CODE, A_DAY_LATER)).toEqual({ ok: false, refusal: 'revoked' });
    expect(repo.inspect(OTHER, A_DAY_LATER)).toMatchObject({ ok: true });
  });

  it('withdraws the code when the line is removed, and says the row stays', () => {
    insertUser('admin-1');
    sync(CODE);
    const outcome = sync(undefined, A_DAY_LATER);
    expect(outcome).toEqual({ kind: 'withdrawn', withdrew: 1 });
    expect(createEnrollmentCodeRepo(db).findByCode(CODE)?.revokedAt).toBe(A_DAY_LATER);
    expect(logged.at(-1)).toMatch(/no longer set/);
    expect(logged.at(-1)).toMatch(/row stays/);
  });

  it('does not bring back a code an administrator revoked, however many times it restarts', () => {
    insertUser('admin-1');
    sync(CODE);
    const repo = createEnrollmentCodeRepo(db);
    repo.revoke(envRows()[0]!.id, A_DAY_LATER);

    for (const at of [A_DAY_LATER, '2026-09-03T12:00:00.000Z']) {
      const outcome = sync(CODE, at);
      expect(outcome.kind).toBe('closed');
    }
    expect(repo.inspect(CODE, A_DAY_LATER)).toEqual({ ok: false, refusal: 'revoked' });
    expect(envRows()).toHaveLength(1);
    expect(logged.at(-1)).toMatch(/does not bring one back/);
  });

  it('does not bring back a code the operator retired by editing, and says why', () => {
    insertUser('admin-1');
    sync(CODE);
    sync(OTHER, A_DAY_LATER);
    // Reverting the file. Everyone who was read the old code at a meeting still has it.
    const outcome = sync(CODE, '2026-09-03T12:00:00.000Z');
    expect(outcome.kind).toBe('closed');
    expect(createEnrollmentCodeRepo(db).inspect(CODE, '2026-09-03T12:00:00.000Z')).toEqual({
      ok: false,
      refusal: 'revoked',
    });
    // And the invariant still holds: reverting closed the door the file no longer names.
    expect(createEnrollmentCodeRepo(db).anyOpen('2026-09-03T12:00:00.000Z')).toBe(false);
  });

  it('never leaves two file-set codes live at once', () => {
    insertUser('admin-1');
    sync(CODE);
    sync(OTHER, A_DAY_LATER);
    const live = envRows().filter((c) => c.revokedAt === null);
    expect(live).toHaveLength(1);
  });

  it('leaves a code an administrator issued alone, and does not take it over', () => {
    const admin = insertUser('admin-1');
    const repo = createEnrollmentCodeRepo(db);
    const issued = repo.create({
      label: 'W9XYZ spring 2027 intake',
      chosen: CODE,
      maxUses: 5,
      expiresAt: '2026-10-01T00:00:00.000Z',
      createdByUserId: admin,
      nowISO: NOW,
    });
    expect(issued.ok).toBe(true);

    const outcome = sync(CODE, A_DAY_LATER, { maxUses: 200, days: 365 });
    expect(outcome.kind).toBe('app-owned');

    // Untouched: same label, same bounds, same issuer. A line in a file may not seize a credential
    // somebody else created, nor silently re-bound it.
    const after = repo.findByCode(CODE);
    expect(after?.label).toBe('W9XYZ spring 2027 intake');
    expect(after?.maxUses).toBe(5);
    expect(after?.expiresAt).toBe('2026-10-01T00:00:00.000Z');
    expect(envRows()).toEqual([]);
    // And the log says every way in which the file does not govern it, because the operator's
    // reasonable assumption is that it does.
    expect(logged.at(-1)).toMatch(/has NOT taken it over/);
    expect(logged.at(-1)).toMatch(/will not withdraw it/);
  });

  it('still closes the file\'s own old code when the new value belongs to the app', () => {
    const admin = insertUser('admin-1');
    sync(CODE);
    const repo = createEnrollmentCodeRepo(db);
    repo.create({
      label: 'W9XYZ spring 2027 intake',
      chosen: OTHER,
      maxUses: 5,
      expiresAt: null,
      createdByUserId: admin,
      nowISO: NOW,
    });
    sync(OTHER, A_DAY_LATER);
    expect(repo.findByCode(CODE)?.revokedAt).toBe(A_DAY_LATER);
  });
});

/**
 * THE FOREIGN KEY FORCED THE RIGHT ANSWER, and this block is what stops a later change from
 * relaxing it back out again.
 */
describe('a code from a file cannot exist before an administrator does', () => {
  it('defers on an empty database rather than inventing an issuer', () => {
    expect(sync(CODE)).toEqual({ kind: 'deferred', withdrew: 0 });
    expect(envRows()).toEqual([]);
    expect(createEnrollmentCodeRepo(db).anyOpen(NOW)).toBe(false);
    expect(logged.at(-1)).toMatch(/no administrator account exists yet/);
    expect(logged.at(-1)).toMatch(/no restart needed/);
  });

  it('creates no users of its own', () => {
    sync(CODE);
    expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0);
  });

  it('does not settle for a member when the deployment has one', () => {
    insertUser('member-1', { role: 'member' });
    expect(sync(CODE).kind).toBe('deferred');
  });

  it('creates it against the founding administrator once one exists', () => {
    expect(sync(CODE).kind).toBe('deferred');
    insertUser('admin-1');
    expect(sync(CODE, A_DAY_LATER).kind).toBe('created');
    expect(envRows()[0]?.createdByUserId).toBe('admin-1');
  });

  it('attributes it to the oldest enabled administrator', () => {
    insertUser('admin-disabled', { disabled: 1, at: '2026-08-01T00:00:00.000Z' });
    insertUser('admin-oldest', { at: '2026-08-02T00:00:00.000Z' });
    insertUser('admin-newest', { at: '2026-08-03T00:00:00.000Z' });
    sync(CODE);
    expect(envRows()[0]?.createdByUserId).toBe('admin-oldest');
  });
});

describe('the trail a code from a file leaves', () => {
  it('records the creation with no signed-in actor, because nobody was', () => {
    insertUser('admin-1');
    sync(CODE);
    const [row] = auditRows();
    expect(row?.action).toBe('enrollment_code.create');
    // Naming the administrator whose id is in `created_by_user_id` would put a colleague's name
    // against an act they did not perform.
    expect(row?.actor).toBeNull();
    const detail = JSON.parse(row?.detail ?? '{}') as Record<string, unknown>;
    expect(detail).toMatchObject({ label: ENV_CODE_LABEL, chosen: true, via: 'ENROLLMENT_CODE' });
  });

  it('records a withdrawal as a withdrawal, marked as the file rather than a button', () => {
    insertUser('admin-1');
    sync(CODE);
    sync(undefined, A_DAY_LATER);
    const revoke = auditRows().find((r) => r.action === 'enrollment_code.revoke');
    expect(revoke).toBeDefined();
    expect(revoke?.actor).toBeNull();
    expect(JSON.parse(revoke?.detail ?? '{}')).toMatchObject({ via: 'ENROLLMENT_CODE' });
  });

  it('adds nothing to the trail on a boot that changed nothing', () => {
    insertUser('admin-1');
    sync(CODE);
    const before = auditRows().length;
    sync(CODE, A_DAY_LATER);
    sync(CODE, '2026-09-03T12:00:00.000Z');
    // An audit log that grows a row every restart is an audit log people stop reading.
    expect(auditRows()).toHaveLength(before);
  });
});
