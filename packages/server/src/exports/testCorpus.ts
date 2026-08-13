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
import { loadSeedCorpus, publishableSeedPrograms } from '../seed/load.js';
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

/**
 * THE OTHER CORPUS — the one a real deployment actually serves.
 *
 * `loadExportCorpus` above is the FIXTURE corpus: 703 records normalized out of `fixtures/`, which
 * is what every byte-proof in this directory is measured against and what the e2e database is
 * seeded from. It is not what a student sees. A container booted on an empty DATA_DIR runs
 * `importSeedIfEmpty` over `data/seed/` and reports "Imported 143 programs (143 publishable, 0
 * suppressed) from 26 funders" — a different population, drawn from different files, with a
 * different set of records carrying a `RECUR` directive in their deadline note (7, against the
 * fixtures' 6).
 *
 * A claim about "the corpus" that is only checked against the fixtures is a claim about the test
 * data. `deadlineNoteCorpus.test.ts` is the first assertion in this directory to read the shipped
 * records, and it exists because the defect it pins was found in the shipped file, not the fixture
 * one.
 *
 * `loadSeedCorpus` is the loader the SERVER boots through, and `publishableSeedPrograms` is its own
 * suppression gate — neither is re-implemented here. The clock is fixed for the same reason
 * `PROFILE_NOW_ISO` is: a projected cycle count that moves with the wall clock makes a test that
 * fails on a Tuesday.
 */
export const SHIPPED_NOW_ISO = '2026-08-04T00:00:00.000Z';

export interface ShippedExportCorpus {
  /** The 143 records a fresh install publishes. */
  programs: Program[];
  /** The seed's own funder rows — real names, because the file a user opens carries them. */
  funders: Funder[];
  cyclesByProgramId: Map<string, Cycle[]>;
  now: string;
}

let cachedShipped: ShippedExportCorpus | undefined;

export function loadShippedExportCorpus(): ShippedExportCorpus {
  if (cachedShipped === undefined) {
    const seed = loadSeedCorpus();
    const programs = publishableSeedPrograms(seed.programs);
    cachedShipped = {
      programs,
      funders: seed.funders,
      cyclesByProgramId: projectCycles(programs, SHIPPED_NOW_ISO),
      now: SHIPPED_NOW_ISO,
    };
  }
  return cachedShipped;
}
