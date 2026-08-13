/**
 * "ARE THESE OUR WORDS?" — ASKED IN FOUR PLACES, ANSWERED FOUR DIFFERENT WAYS, WITH NO ONE HOME.
 *
 * THE ANSWER TO THE QUESTION THIS FILE WAS WRITTEN TO ASK, STATED PLAINLY AND FIRST: NO. The
 * decision has no single home, nothing in the tree points any one of the four at any other, and
 * two of them give OPPOSITE verdicts about the same field. All four have now shipped wrong at
 * least once, in three separate rounds, and each was repaired where it stood.
 *
 *   1. THE VERBATIM PANEL — `core/src/matcher.ts` `hasFunderWording`.
 *      BASIS: `constraint.rawText.trim() !== ''`. An empty `rawText` is declared to BE the honest
 *      representation of "no funder said this". Four surfaces branch on it: `Opportunity.tsx`'s
 *      `RequirementQuote`, `IneligibilityDrawer`, `ProgramTable` and `exports/eligibility.ts`,
 *      which splits `reasons` from `reasonsFromGrantSpotter` on exactly this call.
 *      WAS WRONG: it printed `This program accepts applications from:
 *      ieee_student_branch_chapter.` — a sentence GrantSpotter composed, in the funder's
 *      grammatical voice, inside the quotation block.
 *
 *   2. THE FACT CHECKLIST — `server/src/prose/facts.ts` `shippedPassages`.
 *      BASIS: a verbatim whole-line match of the applicant's draft against the lines of the
 *      templates this product ships, promoted to a PASSAGE at three lines or 200 characters.
 *      WAS WRONG: any line carrying a `{{slot}}` was dropped from the comparison entirely, so the
 *      product's own budget skeleton came back as nine assertions the applicant had to sign, seven
 *      of them second-order — verbatim shipped lines stranded by the broken run.
 *
 *   3. THE COMPOSED-REASON MARKER — `matcher.ts` `applicantEntityConstraint` /
 *      `isApplicantEntityConstraint` / `APPLICANT_ENTITY_AXIS_LABEL`.
 *      BASIS: the attribution is written INSIDE the sentence, and `rawText` is left empty, because
 *      "a CSV cell has no styling" and a marker carried by a surface's CSS does not survive being
 *      copied out of it.
 *      WAS WRONG: the axis label read `OTHER` above a sentence about who may apply, and the
 *      sentence itself printed a storage identifier as though somebody had written it.
 *
 *   4. THE SEED VOICE DETECTOR — `server/src/seed/funderVoice.test.ts`.
 *      BASIS: four families of VOICE (META, ADVICE, PIPELINE, CROSSREF) rather than vocabulary.
 *      WAS WRONG TWICE: round one policed machine tells and was answered by a rewrite that carried
 *      none; round two is the current file.
 *      AND IT IS UNREACHABLE. It is defined inside a `.test.ts` and exported nowhere, so no
 *      product code can consult it even if it wanted to. A decider that only a test can call is a
 *      decision the product does not make. That is asserted below, not asserted about.
 *
 * THE TWO THAT CONTRADICT EACH OTHER OUTRIGHT. `matcher.ts` says an empty `rawText` is the honest
 * representation of a composed constraint. `server/src/seed/validate.ts` says an empty `rawText` is
 * a `constraint-shape` VIOLATION — "a constraint without one is unreviewable" — and refuses the
 * record. Both sentences are true of their own population and neither knows the other exists;
 * what keeps them from colliding is that the populations happen to be disjoint, and NOTHING IN THE
 * TREE STATES THAT, enforces it, or would notice it ending. `the two rules that contradict each
 * other` below is the first thing in this repository that does.
 *
 * WHAT THIS FILE CAN AND CANNOT DO. It cannot unify the four; that is a change to product code in
 * three packages and it is named in the handover. What it does is make the four AGREE ABOUT THE
 * SAME STRING, in one place, so that the next round cannot repair one of them into disagreement
 * with the others and go green — which is what happened three times.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  APPLICANT_ENTITY_AXIS_LABEL,
  hasFunderWording,
  isApplicantEntityConstraint,
  matchProgram,
} from '@grantspotter/core';
import type { Constraint, Profile, Program } from '@grantspotter/core';
import { buildEligibilityReport } from '../src/exports/eligibility.js';
import { requirementsChecklistMarkdown } from '../src/exports/zip.js';
import { exportReadiness, shippedPassages } from '../src/prose/facts.js';
import { shippedTemplateText } from '../src/templates/shippedText.js';
import { validateSeedFile } from '../src/seed/validate.js';
import { loadShippedExportCorpus, SHIPPED_NOW_ISO } from '../src/exports/testCorpus.js';
import { makeFunder } from '../src/exports/testFixtures.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * THE ROLL CALL, AS DATA. Four deciders, four files, four bases. Written down so that the count is
 * an assertion rather than a claim in a comment: if a fifth appears, or one of these moves, the
 * anchor below stops being found and this table has to be updated by somebody who then has to look
 * at how long it has become.
 */
const DECIDERS: ReadonlyArray<{ what: string; file: string; anchor: string }> = [
  {
    what: 'the verbatim panel — is this constraint the funder’s sentence?',
    file: 'packages/core/src/matcher.ts',
    anchor: 'export function hasFunderWording',
  },
  {
    what: 'the fact checklist — is this line of the draft ours?',
    file: 'packages/server/src/prose/facts.ts',
    anchor: 'export function shippedPassages',
  },
  {
    what: 'the composed-reason marker — attribution inside the sentence, not in the styling',
    file: 'packages/core/src/matcher.ts',
    anchor: 'export function isApplicantEntityConstraint',
  },
  {
    what: 'the seed voice detector — is a field attributed to the funder really GrantSpotter?',
    file: 'packages/server/src/seed/funderVoice.test.ts',
    anchor: 'const TELLS',
  },
];

/** The composed constraint, obtained the way the product obtains it: by running the matcher. */
function composedConstraint(programs: readonly Program[]): Constraint {
  // A profile whose entity is not one this programme records, which is what makes the matcher
  // compose the reason rather than read one.
  const profile: Profile = {
    kind: 'organization',
    entity: 'club_unincorporated',
    fieldSources: {},
  } as unknown as Profile;
  for (const program of programs) {
    if (program.applicantEntities.includes('club_unincorporated')) continue;
    const verdict = matchProgram(profile, program, SHIPPED_NOW_ISO);
    // Only an `ineligible` verdict carries reasons; the composed constraint is a refusal.
    if (verdict.kind !== 'ineligible') continue;
    const found = verdict.reasons.find(isApplicantEntityConstraint);
    if (found !== undefined) return found;
  }
  throw new Error('no programme in the shipped corpus composes an applicant-entity reason');
}

let corpus: ReturnType<typeof loadShippedExportCorpus>;
let composed: Constraint;

beforeAll(() => {
  corpus = loadShippedExportCorpus();
  composed = composedConstraint(corpus.programs);
});

describe('the four deciders', () => {
  it('are still where this file says they are, and there are still four of them', () => {
    for (const decider of DECIDERS) {
      const source = readFileSync(join(REPO_ROOT, decider.file), 'utf8');
      expect(source.includes(decider.anchor), `${decider.file} no longer defines ${decider.anchor}`).toBe(
        true,
      );
    }
    expect(
      DECIDERS.length,
      'A decider was added or removed. Before updating this number: the point of the list is ' +
        'that it should be getting SHORTER. Four separate answers to "are these our words" is ' +
        'the condition that let the same defect be repaired three times without being fixed.',
    ).toBe(4);
  });

  /**
   * THE FOURTH ONE CANNOT BE CALLED. Its families and its cross-reference check are the only
   * mechanism in this repository that can tell a funder's register from GrantSpotter's, and they
   * live inside a `.test.ts`, exported nowhere. The seed is therefore policed at build time and
   * every OTHER authored string in the product — a `spec.note`, a composed reason, a template
   * overlay — is not policed at all, because nothing can reach the detector that would do it.
   */
  it('include one that no product code can consult, because it lives in a test file', () => {
    const detector = 'packages/server/src/seed/funderVoice.test.ts';
    expect(readFileSync(join(REPO_ROOT, detector), 'utf8')).toContain('const TELLS');

    // Nothing imports it, and it exports nothing to import.
    const source = readFileSync(join(REPO_ROOT, detector), 'utf8');
    expect(
      source.split('\n').filter((l) => /^export /.test(l)),
      `${detector} now exports something. If the voice detector has become reachable, move it ` +
        'out of the test file and give the other three deciders a way to call it — that is the ' +
        'consolidation this whole file is arguing for.',
    ).toEqual([]);
  });
});

describe('they agree about the same string', () => {
  /**
   * THE CONSTRAINT GRANTSPOTTER COMPOSES, put to every decider that can see it. Round one shipped
   * because two of them disagreed about this exact object: the sentence existed, so the quotation
   * block rendered it, while the thing that composed it knew perfectly well no funder had.
   */
  it('call the composed applicant-entity reason GrantSpotter’s, on every surface at once', () => {
    // 1. the verbatim panel's gate
    expect(hasFunderWording(composed)).toBe(false);
    expect(composed.rawText).toBe('');

    // 3. the composed-reason marker: named as itself, attribution inside the sentence
    expect(isApplicantEntityConstraint(composed)).toBe(true);
    expect(composed.spec.axis).toBe('other');
    const note = composed.spec.axis === 'other' ? composed.spec.note : '';
    expect(note).not.toBe('');
    expect(
      note,
      'the attribution has to be in the words, because a CSV cell has no styling',
    ).toContain('GrantSpotter');
    // And no storage identifier inside it — the other half of what round one printed here.
    expect(note).not.toMatch(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/);

    // The spreadsheet, which is where a marker made of styling would have been lost.
    const profile: Profile = {
      kind: 'organization',
      entity: 'club_unincorporated',
      fieldSources: {},
    } as unknown as Profile;
    const report = buildEligibilityReport(
      profile,
      corpus.programs,
      corpus.funders,
      corpus.cyclesByProgramId,
      SHIPPED_NOW_ISO,
    );
    const rows = report.rows.filter((r) => r.reasonsFromGrantSpotter !== '');
    expect(rows.length, 'no row carries a GrantSpotter-attributed reason to check').toBeGreaterThan(0);
    for (const row of rows) {
      // Whatever GrantSpotter said is in ITS column, and never in the funder's.
      expect(row.reasons).not.toContain(row.reasonsFromGrantSpotter);
    }
  });

  /**
   * The mirror case. A constraint a funder really wrote must be called the funder's by the same
   * three, or the panel that exists to show the funder's own sentence shows nothing.
   */
  it('call a real funder constraint the funder’s, on every surface at once', () => {
    const real = corpus.programs
      .flatMap((p) => p.constraints)
      .find((c) => c.hard && c.rawText.trim() !== '');
    expect(real, 'the shipped corpus holds no funder-written hard constraint').toBeDefined();
    if (real === undefined) return;

    expect(hasFunderWording(real)).toBe(true);
    expect(isApplicantEntityConstraint(real)).toBe(false);

    // And it reaches the packet checklist as the funder's own line.
    const owner = corpus.programs.find((p) => p.constraints.includes(real));
    expect(owner).toBeDefined();
    const checklist = requirementsChecklistMarkdown(
      owner as Program,
      makeFunder({ id: (owner as Program).funderId }),
    );
    expect(checklist).toContain(real.rawText);
  });

  /**
   * The axis label, which is the composed reason's heading. `spec.axis` is `'other'` for it, and
   * `'other'` rendered as the word "OTHER" above a sentence about who may apply — the long-tail
   * bucket borrowed as a title. The one constraint this product invents names itself.
   */
  it('file the composed reason under a heading that is a heading, not a bucket', () => {
    expect(APPLICANT_ENTITY_AXIS_LABEL).toBe('Who may apply');
    expect(APPLICANT_ENTITY_AXIS_LABEL.toLowerCase()).not.toBe('other');
  });

  /**
   * DECIDER 2, ON THE SAME AXIS. A line this product ships is not an assertion the applicant made,
   * so it must not be on the checklist demanding their confirmation; a line the applicant wrote
   * must be. Both directions, because round two's defect was one direction only.
   */
  it('leave GrantSpotter’s own shipped lines off the applicant’s checklist, and keep the applicant’s on', () => {
    const shipped = shippedTemplateText();
    expect(shipped.length, 'no shipped templates loaded, so this proves nothing').toBeGreaterThan(0);

    // A real run of this product's own words, taken from a template it ships rather than invented.
    const source = shipped.find((t) => t.lines.filter((l) => l.trim() !== '').length >= 6);
    expect(source, 'no shipped template is long enough to form a passage').toBeDefined();
    if (source === undefined) return;
    const ourLines = source.lines.filter((l) => l.trim() !== '').slice(0, 6);

    const applicantSentence =
      'Our club logged 4,182 contacts from the campus station during the 2025 field season.';
    const draft = [...ourLines, '', applicantSentence].join('\n');

    const passages = shippedPassages(draft, shipped);
    expect(
      passages.length,
      'the product did not recognise six of its own consecutive shipped lines as its own',
    ).toBeGreaterThan(0);

    const { items, shippedFacts } = exportReadiness(draft, {}, [], shipped);
    // The count the panel prints — dropped in silence is the other half of the defect.
    expect(shippedFacts, 'nothing was recognised as the product’s own').toBeGreaterThan(0);
    // The applicant's number is theirs to confirm.
    expect(
      items.some((i) => i.text.includes('4,182')),
      'the applicant’s own figure was dropped from the checklist',
    ).toBe(true);
    // Nothing on the list may come out of the passage the product wrote.
    for (const item of items) {
      for (const line of ourLines) {
        expect(
          line.includes(item.text),
          `the checklist asks the applicant to confirm GrantSpotter's own shipped line: ${line}`,
        ).toBe(false);
      }
    }
  });
});

describe('the two rules that contradict each other', () => {
  /**
   * BOTH RULES, RUN, IN ONE TEST — because separately each reads as obviously right.
   *
   * `matcher.ts`: an empty `rawText` IS the honest representation of "no funder said this".
   * `validate.ts`: an empty `rawText` IS a `constraint-shape` violation, and the record is refused.
   *
   * There is no third rule that reconciles them and no comment in either file that mentions the
   * other. A curator who wanted to record, in the seed, exactly the thing `matcher.ts` composes at
   * match time could not: the validator would refuse the file for doing the honest thing.
   */
  it('give opposite verdicts on an empty rawText, and nothing in the tree reconciles them', () => {
    expect(hasFunderWording({ ...composed, rawText: '' })).toBe(false);

    const rules = validateSeedFile('probe.json', {
      programs: [
        {
          ...corpus.programs[0],
          constraints: [
            { id: 'probe-c1', hard: true, fallbackRank: 0, rawText: '', spec: { axis: 'other', note: 'x' } },
          ],
        },
      ],
    }).violations.map((v) => v.rule);

    expect(
      rules,
      'validate.ts no longer refuses an empty rawText. If that is deliberate, the contradiction ' +
        'this test documents has been resolved — say which rule won, in both files.',
    ).toContain('constraint-shape');

    // Neither file knows the other exists.
    const matcher = readFileSync(join(REPO_ROOT, 'packages/core/src/matcher.ts'), 'utf8');
    const validate = readFileSync(join(REPO_ROOT, 'packages/server/src/seed/validate.ts'), 'utf8');
    expect(matcher).not.toContain('validate.ts');
    expect(validate).not.toContain('hasFunderWording');
  });

  /**
   * WHY IT HAS NOT BLOWN UP YET, ASSERTED RATHER THAN ASSUMED — and this is the assertion that
   * matters, because it is the one that will go red first.
   *
   * The two rules never meet because their populations are disjoint: every constraint in the
   * shipped seed was read off a funder's page and carries the funder's sentence, and the one
   * constraint GrantSpotter composes is minted by `matchProgram` at request time and is never
   * saved into a seed file. The day a composed constraint is persisted — or a seed constraint is
   * allowed through with no wording — one of the two rules is wrong, and this is what says so.
   */
  it('are kept apart only by a disjointness nothing else in the tree states', () => {
    const seedConstraints = corpus.programs.flatMap((p) => p.constraints);
    expect(seedConstraints.length, 'the shipped corpus holds no constraints').toBeGreaterThan(50);

    const empty = seedConstraints.filter((c) => !hasFunderWording(c));
    expect(
      empty.map((c) => c.id),
      'A stored constraint carries no funder wording. `validate.ts` calls that unreviewable and ' +
        '`matcher.ts` calls it honest — they cannot both be right about the same row, and until ' +
        'now nothing had to choose.',
    ).toEqual([]);

    const composedInSeed = seedConstraints.filter(isApplicantEntityConstraint);
    expect(
      composedInSeed.map((c) => c.id),
      'A constraint GrantSpotter composes has been persisted into the corpus. It has an empty ' +
        'rawText by design, so the seed validator refuses whichever seed file now holds it.',
    ).toEqual([]);
  });
});
