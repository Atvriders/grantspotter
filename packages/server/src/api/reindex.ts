import type Database from 'better-sqlite3';
import type { Cycle, Program } from '@grantspotter/core';
import { expandCycles, observedCycles } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import { isDoNotPublish } from '../normalize/index.js';

/**
 * ~18 months: long enough to catch next year's annual window.
 *
 * Exported for the opportunity detail route (Task 5), which projects the same
 * cycles for one program that this file projects for all of them. Two copies of
 * the number would let the detail page and the browse row beside it disagree
 * about whether a program has a next deadline at all.
 */
export const HORIZON_DAYS = 550;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * Whole records come from Plan 1's repository (RESOLUTIONS R1 — there is no
 * `programs.data` column); only the funder display name is read in SQL, and it
 * is read once into a map rather than joined per row.
 *
 * `do_not_publish` records are dropped here and nowhere else in this file. 545
 * of the 742 records the corpus can produce carry that tag — past ARDC / NSF /
 * USAspending awards, and the 37 ARRL clubs that have already been funded. They
 * are stored on purpose (a funder's grant history is the best evidence of who
 * that funder funds) and `programs` is where they live, but a browse row IS the
 * claim "you could apply for this", so listing history there would be the exact
 * harm this pipeline exists to prevent. The rule is not reimplemented:
 * `isDoNotPublish` is the single shared predicate that `buildReviewItems`, the
 * approve path and the corpus profiler all call, so if a new suppressed record
 * type is classified in `normalize/index.ts` the browse surface starts excluding
 * it in the same commit.
 */
function loadCorpus(db: Database.Database): Array<{ program: Program; funderName: string }> {
  const funderNames = new Map(
    (db.prepare('SELECT id, name FROM funders').all() as Array<{ id: string; name: string }>)
      .map((f) => [f.id, f.name] as const),
  );
  return createProgramRepo(db)
    .list()
    .filter((program) => !isDoNotPublish(program))
    .map((program) => ({ program, funderName: funderNames.get(program.funderId) ?? '' }));
}

/**
 * The soonest cycle that has not closed yet, across BOTH channels core exposes.
 *
 * `expandCycles` repeats a `RECUR` rule forwards and marks every row
 * `isEstimated: true`; `observedCycles` records the one window a funder actually
 * published and marks it `isEstimated: false`. They are separate functions
 * because they are separate claims (merging them would put a 2027 deadline on
 * the calendar for a funder who announced only 2026), and a caller that wants
 * both asks for both — `review/index.ts`'s `writeCyclesFor` does exactly this
 * when it fills the `cycles` table, so the browse projection agrees with the
 * calendar rather than showing a different date from it.
 *
 * On a tie, the funder's own stated window wins: "the date the funder published"
 * outranks "a date we projected from a rule" whenever both name the same day.
 */
function nextCycle(cycles: Cycle[], nowISO: string): Cycle | null {
  const future = cycles
    .filter((c) => c.closesAt !== undefined && c.closesAt >= nowISO)
    .sort((a, b) => {
      const byClose = (a.closesAt ?? '').localeCompare(b.closesAt ?? '');
      if (byClose !== 0) return byClose;
      return Number(a.isEstimated) - Number(b.isEstimated);
    });
  return future[0] ?? null;
}

/**
 * Rebuild the browse projection from `programs`. Wholesale, inside one
 * transaction, so a partial rebuild can never be observed by a reader.
 * Returns the number of programs projected.
 */
export function reindexBrowse(db: Database.Database, nowISO: string): number {
  const corpus = loadCorpus(db);
  const allPrograms = corpus.map((c) => c.program);
  const to = addDays(nowISO, HORIZON_DAYS);

  const clearSearch = db.prepare('DELETE FROM program_search');
  const clearFacets = db.prepare('DELETE FROM program_facets');
  const insertSearch = db.prepare(
    `INSERT INTO program_search
       (program_id, funder_id, funder_name, name, klass, status, instrument,
        amount_min, amount_max, deadline_kind, next_opens_at, next_closes_at,
        next_is_estimated, next_timezone, last_verified_at, haystack)
     VALUES (@program_id, @funder_id, @funder_name, @name, @klass, @status, @instrument,
             @amount_min, @amount_max, @deadline_kind, @next_opens_at, @next_closes_at,
             @next_is_estimated, @next_timezone, @last_verified_at, @haystack)`,
  );
  const insertFacet = db.prepare(
    'INSERT OR IGNORE INTO program_facets (program_id, facet_kind, facet_value) VALUES (?, ?, ?)',
  );

  const run = db.transaction(() => {
    clearSearch.run();
    clearFacets.run();
    for (const { program, funderName } of corpus) {
      const cycles = [
        ...expandCycles(program, allPrograms, nowISO, to),
        ...observedCycles(program, allPrograms, nowISO, to),
      ];
      const next = nextCycle(cycles, nowISO);
      insertSearch.run({
        program_id: program.id,
        funder_id: program.funderId,
        funder_name: funderName,
        name: program.name,
        klass: program.klass,
        status: program.trust.status,
        instrument: program.amount.instrument,
        amount_min: program.amount.amountMin ?? null,
        amount_max: program.amount.amountMax ?? null,
        deadline_kind: program.deadline.kind,
        next_opens_at: next?.opensAt ?? null,
        next_closes_at: next?.closesAt ?? null,
        next_is_estimated: next?.isEstimated ? 1 : 0,
        // The frame the two instants above are expressed in (migration 037).
        //
        // `next_closes_at` is the UTC instant of a LOCAL wall time, so without
        // this column it cannot be rendered as a calendar day: the ARRL's
        // "Feb 1-28, 2027 window" is stored `2027-03-01T04:59:00.000Z` and
        // prints 2027-03-01 in UTC — one day LATE, which tells an applicant
        // they have a day they do not have.
        //
        // `Cycle.timezone` is a required field and both producers always set
        // it (`expandCycles` from the RECUR rule's validated `tz=`,
        // `observedCycles` to 'UTC' — its documented day-precision frame, not a
        // claim about where the funder is), so the empty-string branch is not a
        // live path today. It is written as NULL rather than defaulted because
        // the alternative to "not known" must never be a zone nobody observed:
        // an absent frame is rendered in UTC and labelled by the reader.
        next_timezone: next?.timezone !== undefined && next.timezone !== '' ? next.timezone : null,
        last_verified_at: program.trust.lastVerifiedAt,
        haystack: [
          program.name, funderName, program.summary,
          program.tags.join(' '), program.amount.amountRaw, program.rawOtherText,
        ].join(' · ').toLowerCase(),
      });
      for (const e of program.applicantEntities) insertFacet.run(program.id, 'entity', e);
      for (const t of program.tags) insertFacet.run(program.id, 'tag', t);
    }
  });

  run();
  return corpus.length;
}
