import type { Profile } from '@grantspotter/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertPasswordPolicy,
  dummyPasswordHash,
  hashPassword,
  verifyPassword,
  verifyPasswordConstantTime,
  WeakPasswordError,
} from '../src/auth/password.js';
import { createProfileRepo } from '../src/db/repositories/profiles.js';
import { createSessionRepo } from '../src/db/repositories/sessions.js';
import { createUserRepo, normalizeEmail, toPublicUser } from '../src/db/repositories/users.js';
import { createTestDb, type TestDb } from './helpers/tempDb.js';

let harness: TestDb;
beforeEach(() => {
  harness = createTestDb();
});
afterEach(() => harness.cleanup());

describe('password hashing', () => {
  it('produces an argon2id hash that verifies', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stapl')).toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
  });

  it('returns false rather than throwing on a malformed stored hash', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
    expect(await verifyPassword('', 'anything')).toBe(false);
  });

  it('rejects passwords below the minimum length', () => {
    expect(() => assertPasswordPolicy('short')).toThrow(WeakPasswordError);
    expect(() => assertPasswordPolicy('           ')).toThrow(WeakPasswordError);
    expect(() => assertPasswordPolicy('a-long-enough-password')).not.toThrow();
  });

  it('produces a reusable dummy hash that is itself a valid argon2id hash', async () => {
    const dummy = await dummyPasswordHash();
    expect(dummy.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    // Calling it again must not mint a fresh (differently salted) hash — the
    // whole point is to precompute the work once and reuse the result so the
    // per-request cost for an unknown email matches the cost for a known one.
    expect(await dummyPasswordHash()).toBe(dummy);
  });

  it('runs a real argon2 verify against the dummy hash for an unknown user, and always returns false', async () => {
    expect(await verifyPasswordConstantTime(undefined, 'whatever the visitor typed')).toBe(false);
  });

  it('still verifies correctly for a known user via the constant-time path', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPasswordConstantTime(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPasswordConstantTime(hash, 'wrong password entirely')).toBe(false);
  });

  it('spends comparable time on an unknown user as on a known one (same argon2id work both paths)', async () => {
    const hash = await hashPassword('correct horse battery staple');

    const time = async (fn: () => Promise<unknown>): Promise<number> => {
      const start = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - start) / 1_000_000;
    };

    // Warm up (dummy hash memoization, JIT) before measuring either path.
    await verifyPasswordConstantTime(hash, 'correct horse battery staple');
    await verifyPasswordConstantTime(undefined, 'correct horse battery staple');

    const knownSamples = await Promise.all(
      Array.from({ length: 5 }, () => time(() => verifyPasswordConstantTime(hash, 'nope'))),
    );
    const unknownSamples = await Promise.all(
      Array.from({ length: 5 }, () => time(() => verifyPasswordConstantTime(undefined, 'nope'))),
    );
    const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const knownMs = median(knownSamples);
    const unknownMs = median(unknownSamples);

    // Both paths run exactly one argon2id verify, so they should be within
    // the same order of magnitude. This is a smoke test against gross
    // shortcuts (e.g. an early return that skips hashing for unknown users),
    // not a precise timing-attack guarantee — CI hosts are noisy.
    expect(unknownMs).toBeGreaterThan(knownMs * 0.2);
    expect(unknownMs).toBeLessThan(knownMs * 5);
  });
});

describe('user repository', () => {
  it('normalises email for lookup while preserving what the user typed', () => {
    expect(normalizeEmail('  Student@Example.ORG ')).toBe('student@example.org');

    const repo = createUserRepo(harness.db);
    const created = repo.create({
      email: '  Student@Example.ORG ',
      passwordHash: 'hash',
      role: 'member',
      displayName: 'Student',
    });
    expect(created.email).toBe('Student@Example.ORG');
    expect(created.emailNormalized).toBe('student@example.org');
    expect(repo.findByEmail('STUDENT@example.org')?.id).toBe(created.id);
    expect(repo.findById(created.id)?.role).toBe('member');
    expect(repo.count()).toBe(1);
  });

  it('rejects a duplicate email', () => {
    const repo = createUserRepo(harness.db);
    repo.create({ email: 'a@example.org', passwordHash: 'h', role: 'admin' });
    expect(() =>
      repo.create({ email: 'A@Example.org', passwordHash: 'h', role: 'member' }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('issues a unique ICS token per user and can look one up', () => {
    const repo = createUserRepo(harness.db);
    const a = repo.create({ email: 'a@example.org', passwordHash: 'h', role: 'admin' });
    const b = repo.create({ email: 'b@example.org', passwordHash: 'h', role: 'member' });
    expect(a.icsToken).not.toBe(b.icsToken);
    expect(a.icsToken.length).toBeGreaterThanOrEqual(24);
    expect(repo.findByIcsToken(b.icsToken)?.id).toBe(b.id);
    expect(repo.findByIcsToken('nope')).toBeUndefined();
  });

  it('never leaks the password hash or the ICS token to the API layer', () => {
    const repo = createUserRepo(harness.db);
    const user = repo.create({ email: 'a@example.org', passwordHash: 'secret', role: 'admin' });
    const publicUser = toPublicUser(user);
    expect(Object.keys(publicUser).sort()).toEqual([
      'createdAt',
      'displayName',
      'email',
      'id',
      'role',
    ]);
    expect(JSON.stringify(publicUser)).not.toContain('secret');
  });

  it('records logins and updates role and disabled state', () => {
    const repo = createUserRepo(harness.db);
    const user = repo.create({ email: 'a@example.org', passwordHash: 'h', role: 'member' });
    expect(user.lastLoginAt).toBeUndefined();

    repo.recordLogin(user.id, '2027-03-01T10:00:00.000Z');
    expect(repo.findById(user.id)?.lastLoginAt).toBe('2027-03-01T10:00:00.000Z');

    repo.setRole(user.id, 'admin');
    expect(repo.findById(user.id)?.role).toBe('admin');

    repo.setDisabled(user.id, true);
    expect(repo.findById(user.id)?.disabled).toBe(true);
    expect(repo.list()).toHaveLength(1);
  });
});

describe('session repository', () => {
  it('creates, finds, touches, removes and expires sessions', () => {
    const users = createUserRepo(harness.db);
    const sessions = createSessionRepo(harness.db);
    const user = users.create({ email: 'a@example.org', passwordHash: 'h', role: 'admin' });

    sessions.create({
      id: 'hash-a',
      userId: user.id,
      expiresAt: '2027-04-01T00:00:00.000Z',
      userAgent: 'vitest',
      nowISO: '2027-03-01T00:00:00.000Z',
    });
    const found = sessions.find('hash-a');
    expect(found?.userId).toBe(user.id);
    expect(found?.userAgent).toBe('vitest');
    expect(found?.lastSeenAt).toBe('2027-03-01T00:00:00.000Z');

    sessions.touch('hash-a', '2027-03-02T00:00:00.000Z');
    expect(sessions.find('hash-a')?.lastSeenAt).toBe('2027-03-02T00:00:00.000Z');

    sessions.create({
      id: 'hash-old',
      userId: user.id,
      expiresAt: '2027-01-01T00:00:00.000Z',
      nowISO: '2026-12-01T00:00:00.000Z',
    });
    expect(sessions.removeExpired('2027-03-05T00:00:00.000Z')).toBe(1);
    expect(sessions.find('hash-old')).toBeUndefined();
    expect(sessions.find('hash-a')).toBeDefined();

    sessions.remove('hash-a');
    expect(sessions.count()).toBe(0);
  });

  it('deletes a user’s sessions when the user is deleted', () => {
    const users = createUserRepo(harness.db);
    const sessions = createSessionRepo(harness.db);
    const user = users.create({ email: 'a@example.org', passwordHash: 'h', role: 'admin' });
    sessions.create({ id: 's1', userId: user.id, expiresAt: '2027-04-01T00:00:00.000Z' });
    harness.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    expect(sessions.count()).toBe(0);
  });
});

describe('profile repository', () => {
  it('stores one student and one organisation profile per user', () => {
    const users = createUserRepo(harness.db);
    const profiles = createProfileRepo(harness.db);
    const user = users.create({ email: 'a@example.org', passwordHash: 'h', role: 'member' });

    const student: Profile = {
      kind: 'student',
      callsign: 'W8UM',
      licenseClass: 'GENERAL',
      state: 'MI',
      degreeLevel: 'BACH',
      gpa: 3.4,
    };
    const org: Profile = {
      kind: 'organization',
      entity: 'club_501c3',
      orgName: 'Example Collegiate Radio Club',
      state: 'MI',
      arrlAffiliated: true,
      memberCount: 42,
    };

    profiles.upsert(user.id, student);
    profiles.upsert(user.id, org);
    expect(profiles.get(user.id, 'student')).toEqual(student);
    expect(profiles.get(user.id, 'organization')).toEqual(org);
    expect(profiles.listForUser(user.id).map((p) => p.kind).sort()).toEqual([
      'organization',
      'student',
    ]);

    profiles.upsert(user.id, { ...student, gpa: 3.9 });
    expect(profiles.get(user.id, 'student')?.kind).toBe('student');
    expect(profiles.listForUser(user.id)).toHaveLength(2);

    profiles.remove(user.id, 'organization');
    expect(profiles.get(user.id, 'organization')).toBeUndefined();
  });

  it('refuses to return a profile whose stored JSON no longer validates', () => {
    const users = createUserRepo(harness.db);
    const profiles = createProfileRepo(harness.db);
    const user = users.create({ email: 'a@example.org', passwordHash: 'h', role: 'member' });
    profiles.upsert(user.id, { kind: 'student', state: 'MI' });
    harness.db
      .prepare('UPDATE profiles SET data = ? WHERE user_id = ? AND kind = ?')
      .run('{"kind":"student","licenseClass":"SUPER"}', user.id, 'student');
    expect(() => profiles.get(user.id, 'student')).toThrow();
  });
});
