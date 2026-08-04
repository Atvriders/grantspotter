import { Router } from 'express';
import type Database from 'better-sqlite3';
import type { Program } from '@grantspotter/core';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { hydratePrograms } from './browseQuery.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { isDoNotPublish } from '../normalize/index.js';

/**
 * The programs `userId` has starred, oldest star first.
 *
 * RESOLUTIONS R8: this and {@link watchersOfProgram} are the only two queries
 * anything asks of `watches`, so they live beside the router rather than in a
 * `db/repositories/watches.ts` that would hold nothing else. The stable
 * `created_at` order is what migration 033's `idx_watches_user_created` serves.
 */
export function watchedProgramIds(db: Database.Database, userId: string): string[] {
  const rows = db
    .prepare('SELECT program_id FROM watches WHERE user_id = ? ORDER BY created_at')
    .all(userId) as Array<{ program_id: string }>;
  return rows.map((r) => r.program_id);
}

/**
 * Every user watching `programId`. This is the direction Task 8's change-event
 * fan-out asks in, once per event, which is why Plan 1's 001-init.sql carries
 * `idx_watches_program` — the UNIQUE (user_id, program_id) constraint's index
 * has the wrong leading column for it.
 */
export function watchersOfProgram(db: Database.Database, programId: string): string[] {
  const rows = db
    .prepare('SELECT user_id FROM watches WHERE program_id = ?')
    .all(programId) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

export interface WatchRow {
  program: Program;
  funderName: string;
  nextOpensAt: string | null;
  nextClosesAt: string | null;
  nextIsEstimated: boolean;
  /**
   * IANA zone the two instants above are expressed in, or null when unknown.
   * The watchlist reads the SAME projection browse does, so it inherited the
   * same one-day-late defect and is fixed by the same column (migration 037).
   * Null is "no zone recorded", never the server's — render UTC and say so.
   */
  nextTimezone: string | null;
}

export function createWatchRouter(deps: RouterDeps): Router {
  const router = Router();

  /**
   * `hydratePrograms` reads the browse projection, and the projection is
   * deliberately narrower than `watches`: `reindexBrowse` rebuilds it wholesale
   * and drops every `do_not_publish` record on the way through. Rendering the
   * watchlist from the projection ALONE therefore makes a star disappear in two
   * situations that have nothing to do with the user — between an approval and
   * the next rebuild, and for any record the corpus has reclassified.
   *
   * A star is a subscription to change events (spec §11.2), so silently losing
   * one removes the very signal the user asked for. Everything the projection
   * cannot answer is answered from `programs` instead, and the only row that
   * does not render is a record `isDoNotPublish` suppresses corpus-wide — those
   * are never reachable through any read surface, and the `watches` row is left
   * untouched so the star returns the moment the record is publishable again.
   * A watch for a program that no longer exists at all cannot be observed here:
   * `watches.program_id` is ON DELETE CASCADE, so the row is already gone.
   */
  function loadRows(userId: string): WatchRow[] {
    const ids = watchedProgramIds(deps.db, userId);
    if (ids.length === 0) return [];

    const projected = hydratePrograms(deps.db, ids);
    const programs = createProgramRepo(deps.db);
    const funderNames = new Map(
      (
        deps.db.prepare('SELECT id, name FROM funders').all() as Array<{ id: string; name: string }>
      ).map((f) => [f.id, f.name] as const),
    );

    const rows: WatchRow[] = [];
    for (const id of ids) {
      const hit = projected.get(id);
      if (hit !== undefined) {
        if (isDoNotPublish(hit.program)) continue;
        rows.push({
          program: hit.program,
          funderName: hit.funderName,
          nextOpensAt: hit.nextOpensAt,
          nextClosesAt: hit.nextClosesAt,
          nextIsEstimated: hit.nextIsEstimated,
          nextTimezone: hit.nextTimezone,
        });
        continue;
      }
      const program = programs.get(id);
      if (program === undefined || isDoNotPublish(program)) continue;
      // The projection is the ONLY place the next-cycle scalars exist, so a row
      // it has not built yet reports no dates rather than a guessed one — and
      // no zone either, for exactly the same reason.
      rows.push({
        program,
        funderName: funderNames.get(program.funderId) ?? '',
        nextOpensAt: null,
        nextClosesAt: null,
        nextIsEstimated: false,
        nextTimezone: null,
      });
    }

    // Soonest deadline first; undated last, alphabetically among themselves, so
    // the order is total and does not depend on insertion order.
    return rows.sort((a, b) => {
      if (a.nextClosesAt === null && b.nextClosesAt === null) {
        return a.program.name.localeCompare(b.program.name);
      }
      if (a.nextClosesAt === null) return 1;
      if (b.nextClosesAt === null) return -1;
      return a.nextClosesAt.localeCompare(b.nextClosesAt);
    });
  }

  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    res.json({ rows: loadRows(user.id) });
  });

  router.post('/', deps.requireAuth, (req, res, next) => {
    const user = deps.currentUser(req);
    const programId = (req.body as { programId?: unknown } | undefined)?.programId;
    if (typeof programId !== 'string' || programId === '') {
      next(new AppError('bad_request', 'A non-empty "programId" is required.'));
      return;
    }
    /**
     * A suppressed id and an id that does not exist must be INDISTINGUISHABLE
     * here.
     *
     * Until 2026-08-04 this test was `SELECT 1 FROM programs`, so starring one
     * of the ~553 `do_not_publish` records answered `201 {watched:true}` while a
     * bogus id answered 404 — an existence oracle over exactly the set of
     * records the product refuses to show, readable by anyone with an account,
     * one request per id. The star it created was inert besides: `loadRows`
     * drops the row through the same `isDoNotPublish` below, so the watchlist
     * never rendered it and the fan-out in `notify.ts` never announced it. The
     * only thing the 201 ever conveyed was "this id is real".
     *
     * Same code, same sentence, same status as a nonexistent id, and no row is
     * written — a `watches` row would be a second, slower oracle for anyone who
     * could read their own watchlist ordering.
     *
     * An ALREADY-starred record that later becomes suppressed keeps its row:
     * that is `loadRows`' business, not this route's, and dropping it would
     * destroy a subscription the user is entitled to get back.
     */
    const program = createProgramRepo(deps.db).get(programId);
    if (program === undefined || isDoNotPublish(program)) {
      next(new AppError('not_found', `No program with id "${programId}".`));
      return;
    }
    // `notify_changes` is left to Plan 1's DEFAULT 1: starring IS subscribing
    // (spec §11.2). The ON CONFLICT target is Plan 1's UNIQUE (user_id,
    // program_id) constraint, which is why starring twice is a no-op rather
    // than a 500. The id is derived from the same pair, so a repeat star also
    // violates the primary key; SQLite resolves the named target first, and the
    // idempotency test in watchRouter.test.ts is what holds that true. This is
    // the same statement shape the `starProgram` fixture uses.
    deps.db
      .prepare(
        `INSERT INTO watches (id, user_id, program_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, program_id) DO NOTHING`,
      )
      .run(`${user.id}:${programId}`, user.id, programId, deps.now());
    res.status(201).json({ programId, watched: true });
  });

  router.delete('/:programId', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    deps.db
      .prepare('DELETE FROM watches WHERE user_id = ? AND program_id = ?')
      .run(user.id, req.params.programId);
    res.status(204).end();
  });

  return router;
}
