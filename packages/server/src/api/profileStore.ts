import type { OrgProfile, Profile, StudentProfile } from '@grantspotter/core';
import type { Db } from '../db/migrate.js';
import { createProfileRepo, type ProfileKind } from '../db/repositories/profiles.js';

/**
 * `ProfileKind` is Plan 1's, defined once in
 * packages/server/src/db/repositories/profiles.ts as `Profile['kind']`, so it
 * is derived from the CONTRACT §3 union and cannot drift when a third profile
 * variant is added. Plan 3 re-exports it for convenience; it does not restate
 * the literals.
 */
export type { ProfileKind };

/**
 * DEVIATION FROM THE TASK BRIEF (2026-08-03), and why.
 *
 * The brief writes `SELECT data FROM profiles …` + `JSON.parse` inline here.
 * Plan 1 already owns that statement — `createProfileRepo(db).get()` — and it
 * additionally runs `profileSchema.parse` on the way out, which is CONTRACT §6's
 * rule that JSON columns are validated on READ. Reading the row by hand skips
 * that validation and hands the matcher an unvalidated `as Profile` cast, so a
 * profile stored by an older schema would reach `matchProgram` as a
 * structurally-wrong object and produce verdicts nobody could explain. It is
 * also the same duplication the plan already refuses for `programs`, where
 * Plan 3 reads whole records through `createProgramRepo` rather than its own
 * SQL (RESOLUTIONS R1). So the read path delegates.
 *
 * `saveProfile` below keeps explicit SQL, for a reason the read path does not
 * have: Plan 1's `upsert` stamps `updated_at` from `new Date()`, and Plan 3's
 * global constraint is that every timestamp comes from the injected clock.
 */
export function loadProfile(db: Db, userId: string, kind: ProfileKind): Profile | null {
  return createProfileRepo(db).get(userId, kind) ?? null;
}

export function loadAllProfiles(
  db: Db,
  userId: string,
): { student: StudentProfile | null; organization: OrgProfile | null } {
  const profiles = createProfileRepo(db);
  return {
    student: (profiles.get(userId, 'student') as StudentProfile | undefined) ?? null,
    organization: (profiles.get(userId, 'organization') as OrgProfile | undefined) ?? null,
  };
}

/**
 * Preference order when a request does not name a profile. A `Record` keyed by
 * `ProfileKind` rather than a string array, so a third profile variant added to
 * CONTRACT §3 fails to compile here instead of silently never being reached.
 *
 * Student wins because the ~150-record corpus is scholarship-heavy (spec §2 —
 * 111 of the ARRL catalog entries are scholarships).
 */
export const PROFILE_KIND_PRIORITY: Record<ProfileKind, number> = {
  student: 0,
  organization: 1,
};

const DEFAULT_KIND_ORDER: ProfileKind[] = (
  Object.keys(PROFILE_KIND_PRIORITY) as ProfileKind[]
).sort((a, b) => PROFILE_KIND_PRIORITY[a] - PROFILE_KIND_PRIORITY[b]);

export function isProfileKind(value: unknown): value is ProfileKind {
  return typeof value === 'string' && Object.hasOwn(PROFILE_KIND_PRIORITY, value);
}

/**
 * The profile a request should be matched against. A user may hold both; the
 * caller may name one, otherwise the order above decides.
 *
 * A named preference is NOT a hint that falls back: `prefer: 'student'` for a
 * user who holds only an organization profile answers `null`. Quietly matching
 * a club against a scholarship the caller asked to see as a student would put a
 * verdict on screen that was computed from a profile the user did not choose.
 */
export function loadActiveProfile(
  db: Db,
  userId: string,
  prefer?: ProfileKind,
): { profile: Profile; kind: ProfileKind } | null {
  const profiles = createProfileRepo(db);
  for (const kind of prefer ? [prefer] : DEFAULT_KIND_ORDER) {
    const profile = profiles.get(userId, kind);
    if (profile !== undefined) return { profile, kind };
  }
  return null;
}

export function saveProfile(
  db: Db,
  userId: string,
  kind: ProfileKind,
  profile: Profile,
  nowISO: string,
): void {
  // `kind` and `profile.kind` are two names for one fact, and the row's `kind`
  // column is what every read filters on. If they ever disagree the profile is
  // filed where nothing will look for it, so the disagreement is refused rather
  // than resolved in favour of one of them.
  if (profile.kind !== kind) {
    throw new Error(
      `saveProfile: kind "${kind}" contradicts the profile payload's kind "${profile.kind}".`,
    );
  }
  db.prepare(
    `INSERT INTO profiles (id, user_id, kind, data, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind)
     DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(`${userId}:${kind}`, userId, kind, JSON.stringify(profile), nowISO);
}
