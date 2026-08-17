/**
 * THE FENCE ROUND THE DISPLAYED SENTENCE, AND THE MEASUREMENT THAT SAYS IT IS THE RIGHT SHAPE.
 *
 * Splitting `constraints[].rawText` out of the witnessed-only half rests on one claim: a rewrite
 * of a displayed sentence that keeps the matcher's READING of it moves no answer, for any record
 * and any applicant. That claim is not asserted here. It is measured, against the shipped corpus
 * and a profile set spanning the axes, and the same file measures that the instrument would have
 * noticed if it were false.
 *
 * The claim it replaces was "`rawText` cannot move a verdict", and that one is FALSE — see the
 * first describe block, which measures how far false it is.
 */
import { describe, expect, it } from 'vitest';
import type { Constraint, Profile, Program, Verdict } from '@grantspotter/core';
import { matchProgram } from '@grantspotter/core';
import { loadSeedCorpus, seedDir } from './load.js';
import { matcherReadingOf } from './matcherReading.js';
import { WITNESSED_ONLY_PATHS } from './shippedValues.js';

const CORPUS: Program[] = loadSeedCorpus(seedDir()).programs;
const AT = '2026-09-01T00:00:00.000Z';

/**
 * Applicants chosen to reach the two axes that consult the sentence: `field_of_study` (a major
 * outside any list a funder gives) and `ham_activity` (somebody who has answered the activity
 * question with "none", which is the state that turns an open list into `unknown`).
 */
const PROFILES: Profile[] = [
  { kind: 'student', state: 'TX', licenseClass: 'GENERAL', degreeLevel: 'BACH', fieldOfStudy: 'Electrical Engineering' },
  { kind: 'student', state: 'CA', licenseClass: 'NONE', degreeLevel: 'GRAD', fieldOfStudy: 'Basket Weaving' },
  { kind: 'student', state: 'OH', licenseClass: 'EXTRA', degreeLevel: 'BACH', fieldOfStudy: 'Music', activityKinds: [] },
  { kind: 'student', state: 'NY', licenseClass: 'TECH', degreeLevel: 'ASSOC', fieldOfStudy: 'Nursing', activityKinds: [] },
  { kind: 'organization', entity: 'club_501c3', state: 'FL' },
  { kind: 'organization', entity: 'university', state: 'NY' },
];

/**
 * The ANSWER, with the printed sentence taken out of it. An `ineligible` Verdict is
 * `{ reasons: Constraint[] }` — the constraint objects, `rawText` and all — so a deep-equal on the
 * whole verdict cannot tell "this rewrite changed who is eligible" from "this rewrite changed a
 * quotation", and that distinction is the entire subject of this file.
 */
function answerOf(verdict: Verdict): string {
  switch (verdict.kind) {
    case 'eligible':
      return 'eligible';
    case 'eligible_preferred':
      return `preferred|${String(verdict.rank)}|${[...verdict.met].sort().join(',')}`;
    case 'unknown':
      return `unknown|${[...verdict.missingProfileFields].sort().join(',')}`;
    case 'ineligible':
      return `ineligible|${verdict.reasons.map((r) => r.id).sort().join(',')}`;
  }
}

interface Sweep {
  pairs: number;
  moved: number;
  programs: Set<string>;
}

/** Mutates every constraint in the corpus and counts the answers that move. */
function sweepConstraints(mutate: (c: Constraint) => Constraint): Sweep {
  const out: Sweep = { pairs: 0, moved: 0, programs: new Set() };
  for (const program of CORPUS) {
    const after: Program = { ...program, constraints: program.constraints.map(mutate) };
    for (const profile of PROFILES) {
      out.pairs += 1;
      if (answerOf(matchProgram(profile, program, AT)) !== answerOf(matchProgram(profile, after, AT))) {
        out.moved += 1;
        out.programs.add(program.id);
      }
    }
  }
  return out;
}

/** Rewrites every sentence in the corpus and counts the answers that move. */
function sweep(rewrite: (rawText: string) => string): Sweep {
  return sweepConstraints((c) => ({ ...c, rawText: rewrite(c.rawText) }));
}

describe('the claim that a displayed sentence cannot move a verdict', () => {
  /**
   * IT IS FALSE, AND THIS IS BY HOW MUCH.
   *
   * `hasFunderWording` is not the only reader of `rawText`. `matchProgram` threads the sentence
   * into `evaluateConstraint`, which asks whether the funder called their own list illustrative;
   * `field_of_study` widens its list on the answer and `ham_activity` turns a refusal into
   * `unknown`. A reconcile that rewrote sentences on the belief that they are inert would be able
   * to change who is told they are eligible, on a live deployment, silently.
   */
  it('is false: erasing the corpus’s sentences moves answers', () => {
    const erased = sweep(() => '');
    expect(erased.moved).toBeGreaterThan(0);

    const opened = sweep((t) => `${t} Including but not limited to the above.`);
    expect(opened.moved).toBeGreaterThan(0);
  });

  it('is false in the one specific way this module fences, and no other', () => {
    // Rewriting the sentence while keeping its reading moves NOTHING...
    const preserved = sweep((t) =>
      matcherReadingOf(t).openedTheList
        ? 'A different sentence entirely, and the funder’s list is illustrative — such as these.'
        : 'A different sentence entirely.',
    );
    expect(preserved.moved).toBe(0);
    expect(preserved.pairs).toBe(CORPUS.length * PROFILES.length);

    // ...and every sweep that DOES move an answer is a sweep that moves the reading, on at least
    // one constraint of every programme whose answer moved.
    const opened = sweep((t) => `${t} Including but not limited to the above.`);
    for (const programId of opened.programs) {
      const program = CORPUS.find((p) => p.id === programId)!;
      const flipped = program.constraints.some(
        (c) =>
          matcherReadingOf(c.rawText).openedTheList !==
          matcherReadingOf(`${c.rawText} Including but not limited to the above.`).openedTheList,
      );
      expect(flipped, `${programId} moved without its reading moving`).toBe(true);
    }
  });
});

/**
 * THE SAME QUESTION, ASKED OF EVERYTHING ELSE STILL LUMPED INTO THE WITNESSED-ONLY HALF.
 *
 * One over-broad path was found by a student reading a screen. This is the sweep for the others,
 * kept as a test so the answer is a measurement somebody can re-run rather than a claim in a
 * commit message. It deliberately asserts what each field DOES, not what this round decided about
 * it, so it stays true whichever way a later round goes.
 */
describe('the rest of the witnessed-only half', () => {
  it('measures which parts of a constraint can move an answer, and which cannot', () => {
    const flipHard = sweepConstraints((c) => ({ ...c, hard: !c.hard }));
    const renumber = sweepConstraints((c) => ({ ...c, fallbackRank: c.fallbackRank + 7 }));
    // `hard` and `fallbackRank` ARE verdict-bearing. They stay witnessed-only, and this is why.
    expect(flipHard.moved).toBeGreaterThan(0);
    expect(renumber.moved).toBeGreaterThan(0);

    // `spec.note` — the prose on the `other` axis — is NOT. The `other` axis is `NOT_EVALUABLE`,
    // and the one predicate that reads the note (`statesARequirement`) only asks whether it is
    // blank, so neither rewriting it nor emptying it moves an answer anywhere in the corpus.
    const noted = CORPUS.flatMap((p) => p.constraints).filter(
      (c) => 'note' in c.spec && typeof (c.spec as { note?: unknown }).note === 'string',
    );
    expect(noted.length).toBeGreaterThan(0);
    const rewritten = sweepConstraints((c) =>
      'note' in c.spec ? { ...c, spec: { ...c.spec, note: 'Rewritten.' } } : c,
    );
    const emptied = sweepConstraints((c) => ('note' in c.spec ? { ...c, spec: { ...c.spec, note: '' } } : c));
    expect(rewritten.moved).toBe(0);
    expect(emptied.moved).toBe(0);

    // IT IS LEFT IN THE WITNESSED-ONLY HALF ANYWAY, and the reason is worth writing down. It is
    // display-only TODAY, over THIS corpus; it is not display-only by construction the way an
    // unread field would be, because `statesARequirement` reads it and a note is part of `spec`,
    // the type CONTRACT §3 freezes as the matcher's input. Splitting prose out of `spec` is a
    // contract-level decision, and nothing needs correcting there. What it costs meanwhile is a
    // report, not a refusal: a record whose note the corpus reworded is announced as an
    // eligibility-rules difference, and a real one does that today (`ardc-grants`). No correction
    // to any displayed sentence is blocked by it — the sentence paths are independent.
    expect(WITNESSED_ONLY_PATHS).toEqual(['constraints.rules']);
  });
});

describe('the reading itself', () => {
  it('recognises the idioms matcher.ts documents, and refuses the ones it excludes', () => {
    const open = [
      'Engineering, including but not limited to electrical.',
      'Engineering, such as electrical.',
      'Engineering or a related field.',
      'Engineering or a related technical field.',
      // Deliberately NOT the corpus's own wording of this idiom. `userFacingCopyContract` counts a
      // sentence as covered when a test quotes sixteen consecutive characters of it, so a probe
      // table that borrowed a real screen's phrasing would mark that screen's copy asserted by
      // this file — which looks at no screen at all.
      'Contesting, DXing, county hunting, satellite operating, etc.',
      'Applied sciences, e.g. astronomy.',
      'Medicine, Dentistry, Nursing, and any similar activities.',
      'Engineering, without limitation.',
    ];
    const closed = [
      '',
      'Electrical Engineering.',
      'Engineering degrees, including electrical and computer.',
      'Engineering, or similar scientific field.',
      'Engineering or other 4-year technical degree.',
      'Must hold a Technician class licence or higher.',
    ];
    for (const text of open) {
      expect(matcherReadingOf(text).openedTheList, JSON.stringify(text)).toBe(true);
    }
    for (const text of closed) {
      expect(matcherReadingOf(text).openedTheList, JSON.stringify(text)).toBe(false);
    }
  });

  /**
   * The exclusion boundary, which is the one place a marker must NOT open a list: examples of what
   * is BARRED are not an invitation. If the probe lost this, it would be reading the wrong half of
   * the sentence and every corpus figure above would be measuring the wrong thing.
   */
  it('reads only the half of the sentence in front of an exclusion', () => {
    expect(matcherReadingOf('Any field except health sciences, such as nursing.').openedTheList).toBe(false);
    expect(matcherReadingOf('Engineering, such as electrical, except aerospace.').openedTheList).toBe(true);
  });

  it('is not stuck: it answers both ways over the shipped corpus', () => {
    const readings = CORPUS.flatMap((p) => p.constraints.map((c) => matcherReadingOf(c.rawText)));
    expect(readings.filter((r) => r.openedTheList).length).toBeGreaterThan(0);
    expect(readings.filter((r) => !r.openedTheList).length).toBeGreaterThan(0);
  });

  it('depends on the sentence and on nothing else — not the clock, not a profile', () => {
    const text = 'Engineering, such as electrical.';
    for (let i = 0; i < 3; i += 1) expect(matcherReadingOf(text)).toEqual({ openedTheList: true });
  });
});
