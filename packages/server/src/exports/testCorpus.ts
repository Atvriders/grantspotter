/**
 * THE REAL CORPUS, PROJECTED, FOR THE EXPORT SUITES.
 *
 * `csv.test.ts` proves shape against hand-built records; `corpus.test.ts` proves the CSV's *bytes*
 * against the 703 records the committed fixtures actually produce. Tasks 2 and 3 need the second
 * kind of proof too — a suppression gate that holds for `makeSuppressedProgram()` and leaks for the
 * 553 real ones has proved nothing — and both need the same three lines of setup that
 * `corpus.test.ts` writes privately.
 *
 * So the setup lives here once, memoised, rather than being retyped per format. It is a TEST
 * HELPER (the sibling of `testFixtures.ts`) and nothing in the shipped server imports it: the
 * loader it calls lives under `scripts/`, which is a dev tree.
 *
 * The projection deliberately mirrors `review/index.ts`'s `writeCyclesFor` — `expandCycles` for
 * the recurrence rules plus `observedCycles` for the windows a funder actually printed — because a
 * calendar assertion is only worth making against the cycles the product would really store.
 */
import type { Cycle, Funder, Program } from '@grantspotter/core';
import { expandCycles, observedCycles } from '@grantspotter/core';
import { cycleHorizonEndISO } from '../review/index.js';
import { loadCorpus, PROFILE_NOW_ISO } from '../../../../scripts/profile-corpus.js';

export interface ExportCorpus {
  /** The 150 records a user may see. */
  programs: Program[];
  /** The 553 records the product stores and must never publish. */
  suppressedPrograms: Program[];
  /**
   * One `Funder` per funder id a record names. `loadCorpus` carries no funder rows, and the
   * export's funder lookup must not be the thing under test.
   */
  funders: Funder[];
  cyclesByProgramId: Map<string, Cycle[]>;
  /** The profiler's fixed clock. Every count in the export suites is taken at this instant. */
  now: string;
}

function projectCycles(programs: Program[], nowISO: string): Map<string, Cycle[]> {
  const horizon = cycleHorizonEndISO(nowISO);
  const map = new Map<string, Cycle[]>();
  for (const program of programs) {
    const cycles = [
      ...expandCycles(program, programs, nowISO, horizon),
      ...observedCycles(program, programs, nowISO, horizon),
    ];
    if (cycles.length > 0) map.set(program.id, cycles);
  }
  return map;
}

let cached: Promise<ExportCorpus> | undefined;

export function loadExportCorpus(): Promise<ExportCorpus> {
  cached ??= loadCorpus().then((corpus) => ({
    programs: corpus.programs,
    suppressedPrograms: corpus.suppressedPrograms,
    funders: [...new Set(corpus.programs.map((p) => p.funderId))].map((id) => ({
      id,
      name: `Funder ${id}`,
      homepage: 'https://example.com/',
    })),
    cyclesByProgramId: projectCycles(corpus.programs, PROFILE_NOW_ISO),
    now: PROFILE_NOW_ISO,
  }));
  return cached;
}
