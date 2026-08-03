import { hash, verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';

/** OWASP 2024 baseline for Argon2id: m = 19 MiB, t = 2, p = 1. */
export const ARGON2_OPTIONS = {
  // Algorithm.Argon2id === 2. @node-rs/argon2 declares Algorithm as an
  // ambient `const enum`, which isolatedModules (on project-wide, not ours
  // to change) forbids importing as a value (TS2748) — so it's imported as
  // a type only and the stable numeric literal is used here instead.
  algorithm: 2 as Algorithm,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export const MIN_PASSWORD_LENGTH = 12;

export class WeakPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WeakPasswordError';
  }
}

export function assertPasswordPolicy(plain: string): void {
  if (plain.trim().length < MIN_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

/** Returns false — never throws — for a malformed or empty stored hash. */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

// PLAN-LOCAL: not part of the CONTRACT or the task-14 interface list. Backs
// the constant-time-w.r.t.-account-existence login requirement: a naive
// `findByEmail` miss that short-circuits before hashing returns fast for an
// unknown email and slow (one argon2id verify) for a known one, which leaks
// account existence through response timing. Login flows (a later task) are
// expected to call verifyPasswordConstantTime instead of branching on
// whether the user was found.

let dummyHashPromise: Promise<string> | undefined;

/**
 * A precomputed argon2id hash of a fixed, non-secret placeholder password.
 * Computed once per process and memoized — the cost we're matching is the
 * argon2id verify, not the hash, so re-hashing on every call would be
 * wasted work rather than added safety.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHashPromise ??= hash(
    'grantspotter-dummy-password-used-only-for-timing-safety',
    ARGON2_OPTIONS,
  );
  return dummyHashPromise;
}

/**
 * Verifies a password the same way regardless of whether a matching user
 * was found. Pass `undefined` for `storedHash` when the lookup (e.g. by
 * email) missed — this still performs one argon2id verify, against the
 * dummy hash, and always returns false. Callers must not additionally
 * branch on "user found?" before calling this.
 */
export async function verifyPasswordConstantTime(
  storedHash: string | undefined,
  plain: string,
): Promise<boolean> {
  if (storedHash === undefined) {
    await verifyPassword(await dummyPasswordHash(), plain);
    return false;
  }
  return verifyPassword(storedHash, plain);
}
