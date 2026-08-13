import type { Database } from 'better-sqlite3';
import type { Cycle, Funder, Profile, Program } from '@grantspotter/core';
import { expandCycles, observedCycles } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import { loadActiveProfile } from '../api/profileStore.js';
import { watchedProgramIds } from '../api/watchRouter.js';
import { exportablePrograms } from './filter.js';

/**
 * PLAN-LOCAL PORT. Everything else in Plan 5 depends on this interface, never on the database.
 * That is what lets every route test run against a fake — and it is also why the one file that
 * implements it, below, is worth its own suite against a really migrated schema.
 */
export interface ExportDataSource {
  /**
   * The programmes a reader may be shown. NOT every row in `programs`: see the gate in
   * `createSqliteExportDataSource` below.
   */
  listPrograms(): Program[];
  listFunders(): Funder[];
  listCycles(fromISO: string, toISO: string): Cycle[];
  getProfile(userId: string): Profile | undefined;
  listWatchedProgramIds(userId: string): string[];
  getUserIdForTokenHash(hash: string): string | undefined;
  upsertToken(userId: string, hash: string, nowISO: string): void;
  revokeToken(userId: string, nowISO: string): void;
  getTokenHash(userId: string): string | undefined;
  /**
   * The raw handle, for the two callers that legitimately need one: `assertExportReady` /
   * `getApplication` (Plan 4 takes a `Db`, not a port), and the admin backup, which must read
   * EVERY row including the ~553 suppressed ones — a backup that silently dropped three quarters
   * of the corpus would be data loss on the next restore.
   */
  rawDb(): Database;
}

/**
 * THE ONLY INTEGRATION SEAM IN PLAN 5.
 *
 * Repositories are factories (RESOLUTIONS R8): `createProgramRepo(db)` exposes `.list(filter?)` /
 * `.get(id)` / `.upsert(program)`, `createFunderRepo(db)` exposes `.list()` / `.upsert(funder)`,
 * and `createProfileRepo(db)` exposes `.get(userId, kind)` / `.listForUser(userId)` — though the
 * profile is read through `api/profileStore.ts`'s `loadActiveProfile` rather than off the repo, so
 * that the export and the browse screen cannot pick different profiles for one user (see
 * `getProfile` below). There are no free `listPrograms` / `listFunders` / `getProfileForUser`
 * functions, and there is no
 * `db/repositories/watches.ts` — watch queries live in Plan 3's `api/watchRouter.ts` as
 * `watchedProgramIds(db, userId)`. Everything else in Plan 5, and every test in it, sees only
 * `ExportDataSource`.
 *
 * TWO DELIBERATE DEVIATIONS FROM THE TASK BRIEF, both of which the product has already paid for
 * once elsewhere:
 *
 * 1. **`listPrograms` applies the suppression gate.** The brief returns `programs.list()` raw. The
 *    export routes reach the gate anyway — `selectExportPrograms` runs `exportablePrograms` on
 *    what the browse projection hands back, and `buildExportRows` gates again — but this read is
 *    also what `readDraft` resolves a programme id against, and a calendar SUBSCRIPTION re-fetches
 *    on a schedule into a device the user carries, which is the least recoverable place one of the
 *    ~553 suppressed records could surface. This boundary has leaked four times in this repository and every time the
 *    leaking read path had rolled its own filter, so this one calls the shared
 *    `exportablePrograms` (which calls the shared `isDoNotPublish`) and the routes gate again on
 *    top. The belt is free: the gate is idempotent.
 *
 * 2. **`listCycles` projects BOTH of core's channels.** The brief uses `expandCycles` alone.
 *    `expandCycles` repeats a stated recurrence rule forwards and marks every row
 *    `isEstimated: true`; `observedCycles` records the single window a funder actually printed and
 *    marks it `isEstimated: false`, inventing no successor. Against the real corpus at 2026-08-02
 *    the projected channel alone omits ALL FOUR funder-published windows, so the calendar whose
 *    whole purpose is to distinguish "the funder said so" from "GrantSpotter guessed" would have
 *    contained only guesses. Plan 3's `api/calendarRouter.ts` hit the identical defect in its own
 *    brief and records the identical fix in its `cyclesFor` header; the export seam matches it,
 *    including passing the publishable set as `allPrograms` so deadline inheritance resolves
 *    against exactly the corpus the reader can see.
 */
export function createSqliteExportDataSource(db: Database): ExportDataSource {
  const programs = createProgramRepo(db);
  const funders = createFunderRepo(db);

  const publishable = (): Program[] => exportablePrograms(programs.list());

  return {
    listPrograms: publishable,
    listFunders: () => funders.list(),
    listCycles(fromISO: string, toISO: string): Cycle[] {
      const all = publishable();
      return all.flatMap((p) => [
        ...expandCycles(p, all, fromISO, toISO),
        ...observedCycles(p, all, fromISO, toISO),
      ]);
    },
    /**
     * The profile the BROWSE SCREEN would match this user against, through the browse screen's own
     * loader.
     *
     * This was `profiles.listForUser(userId)[0]`, under the comment "the first one they saved,
     * which is what Plan 3's browse does too". Both halves were false. `listForUser` is
     * `ORDER BY kind`, so `[0]` is whichever kind sorts first alphabetically — `organization` —
     * regardless of when either was saved; and browse resolves the same question through
     * `loadActiveProfile`, whose documented order is `PROFILE_KIND_PRIORITY`, which puts `student`
     * FIRST because the corpus is scholarship-heavy. For a user holding both profiles — the exact
     * case the sentence was written about — the eligibility export was computed against their club
     * while the verdicts on screen were computed against them, and nothing on either surface said
     * so.
     *
     * That divergence stopped being merely wrong and became load-bearing when the export began
     * honouring the screen's verdict filter (`exports/selection.ts`): "Ineligible" would have
     * selected rows by one profile's verdicts and reported them under the other's.
     */
    getProfile: (userId: string) => loadActiveProfile(db, userId)?.profile,
    listWatchedProgramIds: (userId: string) => watchedProgramIds(db, userId),
    getUserIdForTokenHash(hash: string): string | undefined {
      const row = db
        .prepare('SELECT user_id FROM ics_tokens WHERE token_hash = ? AND revoked_at IS NULL')
        .get(hash) as { user_id: string } | undefined;
      return row?.user_id;
    },
    upsertToken(userId: string, hash: string, nowISO: string): void {
      // ON CONFLICT(user_id), not a DELETE + INSERT: rotation replaces the hash in place and
      // clears any previous revocation, so a user who revoked and then subscribed again is not
      // blocked by their own dead row. One row per user, always.
      db.prepare(
        `INSERT INTO ics_tokens (user_id, token_hash, created_at, revoked_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash,
                                            created_at = excluded.created_at,
                                            revoked_at = NULL`,
      ).run(userId, hash, nowISO);
    },
    revokeToken(userId: string, nowISO: string): void {
      // Stamped, not deleted: `revoked_at` is the record that this account once had a feed and
      // when it was turned off, which is what an administrator investigating a leaked URL needs.
      // Every read filters on `revoked_at IS NULL`, so the row grants nothing.
      db.prepare('UPDATE ics_tokens SET revoked_at = ? WHERE user_id = ?').run(nowISO, userId);
    },
    getTokenHash(userId: string): string | undefined {
      const row = db
        .prepare('SELECT token_hash FROM ics_tokens WHERE user_id = ? AND revoked_at IS NULL')
        .get(userId) as { token_hash: string } | undefined;
      return row?.token_hash;
    },
    rawDb: () => db,
  };
}
