import type { Profile, Program } from '@grantspotter/core';
import { matchAll } from '@grantspotter/core';

/** PLAN-LOCAL to Plan 3. */
export interface CompletenessField {
  field: string;
  /**
   * How many `unknown` verdicts are blocked on this one field RIGHT NOW.
   *
   * It is an upper bound on what filling the field buys, not a promise. Two
   * reasons, both real and both covered by `completeness.test.ts`:
   *   - a single verdict can name several fields at once (`age_stage` reports
   *     `stage` and `birthDate` together), and answering one of them still
   *     leaves the verdict unknown;
   *   - some axes stop at the first thing they cannot answer, so the next
   *     missing field only appears once the current one is filled — filling
   *     `degreeLevel` moves QCWA's unknown along to `accredited`.
   * The UI may say "1 verdict is waiting on your GPA". It may not say "fill in
   * your GPA and 1 verdict becomes an answer".
   */
  resolves: number;
}

/** PLAN-LOCAL to Plan 3. */
export interface CompletenessReport {
  total: number;
  unknownCount: number;
  /** Share of the corpus that already yields a real verdict, 0-100. */
  score: number;
  fields: CompletenessField[];
}

/**
 * Completeness is defined against the matcher, not against the shape of the
 * form: a field only counts if some program's verdict actually depends on it.
 *
 * That definition rests on one invariant the matcher owns and this module
 * assumes — an unset profile field yields `unknown`, never `ineligible`. A
 * missing answer is a question, and a question is what this report enumerates.
 * If silence ever became a bar, this report would be counting bars and telling
 * the user they could argue their way out of them.
 *
 * `nowISO` is injected because two of the thirteen axes (`age_stage`,
 * `arrl_membership`) are clock-dependent, and a report that silently read the
 * wall clock would be untestable and would drift from the verdicts the browse
 * page computed a moment earlier with the request's own clock.
 */
export function computeCompleteness(
  profile: Profile,
  programs: Program[],
  nowISO: string = new Date().toISOString(),
): CompletenessReport {
  const total = programs.length;
  if (total === 0) {
    // Nothing to judge, so nothing is unanswered. Reporting 0 here would tell a
    // user with a perfectly good profile that they have work to do.
    return { total: 0, unknownCount: 0, score: 100, fields: [] };
  }

  const verdicts = matchAll(profile, programs, nowISO);
  const counts = new Map<string, number>();
  let unknownCount = 0;

  for (const verdict of verdicts.values()) {
    if (verdict.kind !== 'unknown') continue;
    unknownCount += 1;
    for (const field of new Set(verdict.missingProfileFields)) {
      counts.set(field, (counts.get(field) ?? 0) + 1);
    }
  }

  const fields = [...counts.entries()]
    .map(([field, resolves]) => ({ field, resolves }))
    .sort((a, b) => b.resolves - a.resolves || a.field.localeCompare(b.field));

  return {
    total,
    unknownCount,
    score: Math.round(((total - unknownCount) / total) * 100),
    fields,
  };
}

/**
 * The report for a user who has no profile at all. Every program is unanswered
 * because there is nobody to answer for, and no field is named because the
 * honest next step is "create a profile", not "fill in your GPA".
 *
 * The empty corpus is spelled out rather than falling out of the arithmetic:
 * `computeCompleteness` scores an empty corpus 100, and the two must agree or
 * the meter jumps from 0 to 100 the moment a signed-out user signs in.
 */
export function emptyCompleteness(total: number): CompletenessReport {
  return { total, unknownCount: total, score: total === 0 ? 100 : 0, fields: [] };
}
