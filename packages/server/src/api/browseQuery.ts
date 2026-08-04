import type Database from 'better-sqlite3';
import type { Program } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import type { BrowseFilters } from './browseTypes.js';

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/** SQLite LIKE treats % and _ as wildcards; escape them with a backslash. */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const ORDER_BY: Record<BrowseFilters['sort'], string> = {
  // NULL closes_at sorts last in both directions: undated programs never lead the list.
  deadline: 'ps.next_closes_at IS NULL ASC, ps.next_closes_at ASC, ps.name ASC',
  amount_desc: 'COALESCE(ps.amount_max, ps.amount_min, -1) DESC, ps.name ASC',
  name: 'ps.name ASC',
  verified: 'ps.last_verified_at DESC, ps.name ASC',
};

/**
 * Indexed filter over the browse projection. Returns the page of ids plus the
 * unpaginated total. Matcher verdicts are NOT applied here — they are a
 * per-profile overlay applied by the router (Task 4).
 */
export function queryProgramIds(
  db: Database.Database,
  f: BrowseFilters,
): { ids: string[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (f.klass.length) {
    where.push(`ps.klass IN (${placeholders(f.klass.length)})`);
    params.push(...f.klass);
  }
  if (f.status.length) {
    where.push(`ps.status IN (${placeholders(f.status.length)})`);
    params.push(...f.status);
  }
  if (f.instrument.length) {
    where.push(`ps.instrument IN (${placeholders(f.instrument.length)})`);
    params.push(...f.instrument);
  }
  if (f.entity.length) {
    where.push(
      `EXISTS (SELECT 1 FROM program_facets pf
                WHERE pf.program_id = ps.program_id
                  AND pf.facet_kind = 'entity'
                  AND pf.facet_value IN (${placeholders(f.entity.length)}))`,
    );
    params.push(...f.entity);
  }
  if (f.amountMin !== undefined) {
    // Overlap semantics: keep a program whose ceiling reaches the user's floor.
    where.push('COALESCE(ps.amount_max, ps.amount_min, 0) >= ?');
    params.push(f.amountMin);
  }
  if (f.amountMax !== undefined) {
    where.push('COALESCE(ps.amount_min, ps.amount_max, 0) <= ?');
    params.push(f.amountMax);
  }
  if (f.deadlineFrom !== undefined || f.deadlineTo !== undefined) {
    const clauses: string[] = [];
    const dated: string[] = ['ps.next_closes_at IS NOT NULL'];
    if (f.deadlineFrom !== undefined) {
      dated.push('ps.next_closes_at >= ?');
      params.push(f.deadlineFrom);
    }
    if (f.deadlineTo !== undefined) {
      dated.push('ps.next_closes_at <= ?');
      params.push(f.deadlineTo);
    }
    clauses.push(`(${dated.join(' AND ')})`);
    // DEVIATION FROM THE TASK BRIEF, and why (2026-08-03).
    //
    // The brief matches the undated half on `deadline_kind IN (rolling, unpublished,
    // no_application_exists, dormant, ad_hoc, inherited)`, under the comment "deadline kinds
    // that have no concrete date and therefore no window to match". In THIS corpus the kind is
    // not that fact, and the proxy is wrong in BOTH directions — whether a date projects depends
    // on the deadline NOTE (core's `RECUR` micro-format, or a window the funder published), not
    // on the kind. Both were reproduced against the fixture corpus before this line was written:
    //
    //   FALSE POSITIVE. `qcwa-memorial-scholarship` is `inherited` and projects a real
    //   2026-12-30T17:00:00.000Z. Asked for programs closing in FEBRUARY 2027 it came back
    //   anyway, because `inherited` is on the list. That is not one record: domain fact 5 —
    //   111 ARRL catalog entries share one deadline via `kind: 'inherited'`, every one of them
    //   dated — so the largest cohort in the corpus would ignore the deadline filter entirely,
    //   and it would do so under `includeRolling`'s DEFAULT of true.
    //
    //   FALSE NEGATIVE, the worse one. A program whose kind is `annual_window` but whose note is
    //   human prose projects NO cycle at all (the fixture header on `arrlScholarship` documents
    //   exactly this: `parseRecurrence` returns `{kind:'none'}` without the `RECUR ` prefix), so
    //   `next_closes_at` is NULL while the kind is not on the list. A probe of that exact shape
    //   was DROPPED from a windowed search with `includeRolling: true` — the user asked to keep
    //   undated programs and the only genuinely undated program was the one that disappeared.
    //
    // So the undated half is matched on the absence of the date itself, which is what the brief's
    // own comment says it means. The two halves are then exact complements — every projected row
    // is either dated-and-in-window or undated — and it reads the `idx_ps_closes` index the dated
    // half already uses instead of an unindexed six-way string comparison.
    if (f.includeRolling) clauses.push('ps.next_closes_at IS NULL');
    where.push(`(${clauses.join(' OR ')})`);
  }
  if (f.q !== undefined && f.q.trim() !== '') {
    where.push(`ps.haystack LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(f.q.trim().toLowerCase())}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM program_search ps ${whereSql}`)
      .get(...params) as { n: number }
  ).n;

  const offset = Math.max(0, (f.page - 1) * f.pageSize);
  const rows = db
    .prepare(
      `SELECT ps.program_id AS id
         FROM program_search ps
         ${whereSql}
        ORDER BY ${ORDER_BY[f.sort]}
        LIMIT ? OFFSET ?`,
    )
    .all(...params, f.pageSize, offset) as Array<{ id: string }>;

  return { ids: rows.map((r) => r.id), total };
}

export interface HydratedProgram {
  program: Program;
  funderName: string;
  nextOpensAt: string | null;
  nextClosesAt: string | null;
  nextIsEstimated: boolean;
}

/**
 * Load full `Program` records plus their projection dates for an explicit id
 * list. The record itself comes from Plan 1's repository — `programs` is
 * normalized and has no `data` column (RESOLUTIONS R1) — while the three
 * next-cycle scalars come from the browse projection, which is the only place
 * they exist.
 */
export function hydratePrograms(
  db: Database.Database,
  ids: string[],
): Map<string, HydratedProgram> {
  const out = new Map<string, HydratedProgram>();
  if (ids.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT ps.program_id AS id,
              ps.funder_name AS funder_name,
              ps.next_opens_at AS next_opens_at,
              ps.next_closes_at AS next_closes_at,
              ps.next_is_estimated AS next_is_estimated
         FROM program_search ps
        WHERE ps.program_id IN (${placeholders(ids.length)})`,
    )
    .all(...ids) as Array<{
      id: string;
      funder_name: string;
      next_opens_at: string | null;
      next_closes_at: string | null;
      next_is_estimated: number;
    }>;

  const programs = createProgramRepo(db);
  for (const r of rows) {
    const program = programs.get(r.id);
    // A projection row whose program has been deleted is skipped rather than
    // faked; reindexBrowse() clears it on the next rebuild.
    if (program === undefined) continue;
    out.set(r.id, {
      program,
      funderName: r.funder_name,
      nextOpensAt: r.next_opens_at,
      nextClosesAt: r.next_closes_at,
      nextIsEstimated: r.next_is_estimated === 1,
    });
  }
  return out;
}
