/**
 * THE TWO CORPORA, SIDE BY SIDE — because "the corpus" has meant only one of them.
 *
 * This repository holds two populations of records and they are not the same records:
 *
 *   FIXTURE  150 publishable programmes, 652 constraints, built by running the real parsers and
 *            the real normalizer over the committed captures in `fixtures/`. This is what
 *            `scripts/profile-corpus.ts` `loadCorpus()` returns, what `npm run profile-corpus`
 *            measures, and what the e2e database is seeded from. Its constraints are the
 *            EXTRACTORS' output — `normalize/axes/` decided every `spec` in it.
 *
 *   SEED     144 publishable programmes, 696 constraints, hand-written in `data/seed/*.json` and
 *            imported by `importSeedIfEmpty` on the first boot of an empty database. THIS IS WHAT
 *            A FRESH INSTALL SERVES, and it is what runs at grant.waterburp.com. Its constraints
 *            are a CURATOR'S output: a `rawText` copied off the funder's page and a `spec` a human
 *            wrote beside it.
 *
 * `spec-vs-sentence.test.ts` and `sentence-vs-spec.test.ts` — R1–R7 and W1–W12, every rule this
 * project has for "does the spec say what the sentence beside it says?" — read `loadCorpus()` and
 * nothing else. Nine rounds of hardening, and the 696 constraints a student actually reads were
 * outside every one of them. `exports/testCorpus.ts` learned the same lesson one directory over
 * ("A claim about 'the corpus' that is only checked against the fixtures is a claim about the test
 * data"); this is that lesson applied to the eligibility rules.
 *
 * WHY A SHARED HELPER RATHER THAN A SECOND `everyConstraint` IN EACH FILE. Both files already
 * carried a private copy of the fixture load, and the seed half needs the publishable gate applied
 * exactly as the server applies it. Two copies of that would be two chances to filter differently,
 * and the difference would show up as one file finding a defect the other cannot see.
 *
 * IT IS A TEST HELPER, AND IT LIVES HERE RATHER THAN BESIDE THE TWO FILES THAT USE IT. Its first
 * home was `normalize/axes/`, which `normalize/purity.test.ts` refuses: nothing under `normalize/`
 * may import anything outside it but `@grantspotter/core`, and this reaches into `seed/` and into
 * `scripts/`. That guard is right and it caught this within the hour. `src/test/` is the tree
 * `tsconfig.build.json` already excludes from the shipped build, beside `testDb.ts`; nothing under
 * `src/` that ships imports it, and `tsc --noEmit -p tsconfig.json` still type-checks it.
 */
import type { Constraint, Program } from '@grantspotter/core';
import { loadCorpus } from '../../../../scripts/profile-corpus.js';
import { loadSeedCorpus, publishableSeedPrograms } from '../seed/load.js';

/**
 * Which population a record came from. Every count in the two guard files is reported per corpus,
 * never as a single total: a rule that stops seeing 40 fixture constraints must not be able to
 * hide inside a sum that the seed half happens to make up.
 */
export type CorpusName = 'fixture' | 'seed';

export interface CorpusConstraint {
  corpus: CorpusName;
  program: Program;
  c: Constraint;
}

/** A per-corpus counter, so a vacuity guard names which population it counted. */
export interface Tally {
  fixture: number;
  seed: number;
}

export function tally(): Tally {
  return { fixture: 0, seed: 0 };
}

export function bump(t: Tally, corpus: CorpusName, by = 1): void {
  t[corpus] += by;
}

let cachedFixture: ReturnType<typeof loadCorpus> | undefined;

/** The fixture corpus, memoised per process — the load re-parses every committed capture. */
export function fixtureCorpus(): ReturnType<typeof loadCorpus> {
  cachedFixture ??= loadCorpus();
  return cachedFixture;
}

let cachedSeed: Program[] | undefined;

/**
 * The seed corpus, through the server's own loader and the server's own suppression gate.
 *
 * `publishableSeedPrograms` is imported rather than restated for the reason `import.ts` gives: the
 * gate has leaked six times, every time from a caller that wrote its own predicate.
 */
export function seedPrograms(): Program[] {
  cachedSeed ??= publishableSeedPrograms(loadSeedCorpus().programs);
  return cachedSeed;
}

/** Every publishable programme in both corpora, labelled. */
export async function everyProgram(): Promise<Array<{ corpus: CorpusName; program: Program }>> {
  const { programs } = await fixtureCorpus();
  return [
    ...programs.map((program) => ({ corpus: 'fixture' as const, program })),
    ...seedPrograms().map((program) => ({ corpus: 'seed' as const, program })),
  ];
}

/** Every constraint on every publishable programme in both corpora, labelled. */
export async function everyConstraintInBothCorpora(): Promise<CorpusConstraint[]> {
  return (await everyProgram()).flatMap(({ corpus, program }) =>
    program.constraints.map((c) => ({ corpus, program, c })),
  );
}

/**
 * THE SEED RECORD A PLANTED-VIOLATION PROOF IS BUILT ON, found by the ids the JSON file carries.
 *
 * It THROWS when the record or the constraint is gone rather than returning `undefined`, and that
 * is the whole reason it exists: a proof that plants a violation on a record the corpus no longer
 * holds plants it on nothing, and a silently-empty mutation is a green test that proves the rule
 * can speak when it cannot. Curators rename seed ids — `data/seed/*.json` is hand-edited — so this
 * has to be the loud kind of failure.
 */
export function seedConstraint(
  all: readonly CorpusConstraint[],
  programId: string,
  constraintId: string,
): CorpusConstraint {
  const found = all.find(
    (e) => e.corpus === 'seed' && e.program.id === programId && e.c.id === constraintId,
  );
  if (found === undefined) {
    throw new Error(
      `data/seed no longer holds ${programId} / ${constraintId}, so the planted-violation proof ` +
        'built on it would mutate nothing and pass. Re-point it at the record that replaced it.',
    );
  }
  return found;
}

/**
 * The same corpus with ONE constraint replaced — the shape every planted-violation proof takes.
 *
 * The mutated corpus goes back through the WHOLE sweep, not just the rule's predicate: the same
 * axis filters, the same exemptions, the same counters. That is the difference between proving a
 * predicate can return true and proving the RULE can reach a record and say so. This project has
 * now found four guards that were structurally blind, and in every one of them the predicate was
 * fine and the sweep never handed it the record.
 */
export function plant(
  all: readonly CorpusConstraint[],
  target: CorpusConstraint,
  mutate: (c: Constraint) => Constraint,
): CorpusConstraint[] {
  let planted = 0;
  const out = all.map((e) => {
    if (e !== target) return e;
    planted += 1;
    return { ...e, c: mutate(e.c) };
  });
  if (planted !== 1) {
    throw new Error(`plant() matched ${planted} constraints; it must match exactly the one given.`);
  }
  return out;
}

/**
 * Loading both corpora is FILE I/O SHARED BY A WHOLE FILE, not any one rule's work. Call this from
 * a `beforeAll` with a generous timeout; `spec-vs-sentence.test.ts` carries the measurement and the
 * argument for why the answer is a hook rather than a larger `testTimeout`.
 */
export async function warmBothCorpora(): Promise<void> {
  await fixtureCorpus();
  seedPrograms();
}
