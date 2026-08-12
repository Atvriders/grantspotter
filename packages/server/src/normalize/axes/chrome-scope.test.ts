// `recommendation.ts` and `ageStage.ts` — the two axes that still read constraints off SITE
// CHROME after `hamActivity.ts` was guarded against it.
//
// THE DEFECT THIS FILE PINS. `candidateTexts` falls back to `raw.rawText`, which for a source that
// files no `Other` / `eligibility` / `sponsor` field is the WHOLE FLATTENED PAGE — masthead,
// navigation column, mega-footer and all. `withoutSiteChrome` (see hamActivity.ts for its
// derivation) drops a run of link labels before any axis reads the page. It was applied to one
// axis; five constraints on two others were still being minted from menus:
//
//   ARRL Amateur Radio Grants   recommendation, off the ARRL Foundation's own side rail.
//   ARRL Club Grant Program     recommendation, off the identical side rail next door.
//   YLRL Scholarships           recommendation, because "Sponsor" is a MENU ITEM on ylrl.net.
//   IEEE Student Branch Rebate  recommendation AND age_stage — the latter a hard
//                               `stages: ["GRAD"]` bar read off ieee.org's chrome, which on an
//                               allow-list axis excluded every undergraduate, high-school and
//                               returning-adult applicant from a student-branch rebate.
//
// A recommendation constraint changes no matcher verdict, so four of the five hid nothing — they
// PUBLISHED a fabricated obligation and quoted a navigation menu back to the applicant as the
// funder's own words. The fifth, the `age_stage` bar, hid the programme outright. Both are the
// same defect: "if the eligibility text does not state a requirement, absent is the honest output".
//
// Kept in its own file rather than appended to part1.test.ts / part2.test.ts, which
// concurrently-running agents edit for other axes — the same reason license.test.ts,
// hamActivity.test.ts, clause-split.test.ts and preference-scope.test.ts exist.
import type { Program, RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
// The offline corpus loader: every committed REAL capture, parsed by its own source module and
// normalized exactly as the crawler does, minus the records the review queue suppresses.
import { loadCorpus } from '../../../../../scripts/profile-corpus.js';
import { extractAgeStage } from './ageStage.js';
import { withoutSiteChrome } from './hamActivity.js';
import { extractRecommendation } from './recommendation.js';

let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

function keyOf(program: Program): string {
  const tag = (prefix: string): string =>
    program.tags.find((t) => t.startsWith(prefix))?.slice(prefix.length) ?? '?';
  return `${tag('source:')}::${tag('key:')}`;
}

const raw = (fields: Record<string, string>, rawText?: string): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: rawText ?? Object.values(fields).join('\n'),
});

function specsOn(program: Program, axis: string): unknown[] {
  return program.constraints.filter((c) => c.spec.axis === axis).map((c) => c.spec);
}

// ---------------------------------------------------------------- the real captures

describe('the five constraints that came off a navigation menu', () => {
  const gone = async (key: string, axis: string): Promise<unknown[]> => {
    const { programs } = await corpus();
    const p = programs.find((program) => keyOf(program) === key);
    if (p === undefined) throw new Error(`${key} is missing from the corpus`);
    return specsOn(p, axis);
  };

  it('ARRL Amateur Radio Grants asks for no recommendation — that was a side rail', async () => {
    // "Back to Top · Having Trouble? · Get Involved >> The ARRL Foundation >> Amateur Radio Grants
    //  · Articles of Incorporation/ByLaws · ARRL Foundation Board of Directors and Officers · …"
    expect(await gone('arrl-amateur-radio-grants::amateur-radio-grants', 'recommendation')).toEqual([]);
  });

  it('ARRL Club Grant Program asks for no recommendation — the same side rail next door', async () => {
    expect(await gone('arrl-club-grant::club-grant-program', 'recommendation')).toEqual([]);
  });

  it('YLRL Scholarships asks for no recommendation — "Sponsor" is a menu item', async () => {
    // "Skip to content · Contact · Why Join · Resources · Links · … · Membership · Why Join ·
    //  Join/Renew Application · Sponsor · Adoptee Application · …" — ylrl.net's own menu, on the
    //  same page whose menu already produced a `contesting` bar that hid three women-only ham
    //  scholarships from licensed women.
    expect(await gone('ylrl::ylrl-scholarships', 'recommendation')).toEqual([]);
  });

  it('IEEE Student Branch Rebate asks for no recommendation and bars no stage', async () => {
    // "Submit Your Student Branch Annual Plan - IEEE Students · Renew Membership · Join IEEE
    //  Today! · Skip to content · IEEE.org · IEEE Xplore Digital Library · …" — the masthead and
    //  mega-footer. `stages: ["GRAD"]` off that run excluded every non-graduate applicant.
    expect(await gone('ieee-student-branch-rebate::ieee-student-branch-rebate', 'recommendation')).toEqual([]);
    expect(await gone('ieee-student-branch-rebate::ieee-student-branch-rebate', 'age_stage')).toEqual([]);
  });

  it('IEEE MTT-S asks for no recommendation — re-anchoring it only moved the fabrication', async () => {
    // SUPERSEDED, one round later. This case was first fixed by RE-ANCHORING: the evidence shown
    // to the applicant moved off "com · Books · Digital Products · Conferences · Conference
    // Calendar · …" and onto the sentence the funder actually wrote, and the constraint was kept —
    //
    //     "A sponsorship request usually requires a detailed description and mandatory post-event
    //      reporting."
    //
    // Reading that as a recommendation requirement is a WORD-SENSE defect that better provenance
    // cannot see: the applicant here is the party REQUESTING sponsorship — that is the award
    // itself — not somebody being vouched for. The sentence does state real obligations (a
    // description, post-event reporting); neither is a letter about anybody, and this is the wrong
    // axis to publish them on. See `recommendation.ts`'s NOT_A_LETTER_SENSE.
    //
    // Kept as a test rather than deleted, because "the rawText is now the funder's own prose" is
    // exactly the check that would have declared this fixed while the fabrication stood.
    expect(await gone('ieee-mtts::ieee-mtts-chapter-support', 'recommendation')).toEqual([]);
  });
});

describe('no recommendation or stage constraint in this corpus is read off site chrome', () => {
  /**
   * The corpus-wide form of the same claim, and the one that fails if either axis stops filtering:
   * a published constraint's own quoted evidence may not CONTAIN a navigation run. This mirrors
   * the identical assertion hamActivity.test.ts makes for its axis.
   */
  it('every published recommendation / age_stage rawText survives withoutSiteChrome unchanged', async () => {
    const { programs } = await corpus();
    const offenders: string[] = [];
    for (const program of programs) {
      for (const c of program.constraints) {
        if (c.spec.axis !== 'recommendation' && c.spec.axis !== 'age_stage') continue;
        if (withoutSiteChrome(c.rawText) !== c.rawText) {
          offenders.push(
            `${keyOf(program)} (${program.name}) ${c.spec.axis}: ${JSON.stringify(c.rawText.slice(0, 120))}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * Vacuity guard. The assertion above passes trivially over an empty set, and both axes really do
   * have real constraints to protect — the ARRL catalogue states stages on dozens of awards and
   * recommendation requirements on several. If the filter ever over-reaches and starts eating
   * funder text, these collapse.
   */
  it('still finds the real recommendation and stage requirements it must not eat', async () => {
    const { programs } = await corpus();
    expect(programs.filter((p) => specsOn(p, 'recommendation').length > 0).length).toBeGreaterThanOrEqual(10);
    // Exact rather than a floor, which is what a guard against a filter that "starts eating funder
    // text" actually wants: a floor cannot tell a record lost to over-reach from a record that was
    // never there. 14, one fewer than when this was written, and the missing one is ECARS —
    // withdrawn deliberately and asserted by name in `modal-verbs.test.ts` ("the funder widens its
    // own band, and the widening is not the preference"), where the reason lives.
    expect(programs.filter((p) => specsOn(p, 'age_stage').length > 0).length).toBe(14);
    // …and the two clearest real ones, by name and wording.
    const goldwater = programs.find(
      (p) => keyOf(p) === 'arrl-scholarship-descriptions::The ARRL Scholarship to Honor Barry Goldwater',
    );
    if (goldwater === undefined) throw new Error('the Goldwater scholarship is missing from the corpus');
    expect(specsOn(goldwater, 'recommendation')).toEqual([
      { axis: 'recommendation', recommenderType: 'arrl_affiliated_club_officer', count: 1 },
    ]);
    expect(specsOn(goldwater, 'age_stage')).toEqual([
      { axis: 'age_stage', stages: ['HS_SENIOR', 'UNDERGRAD'] },
    ]);
    const ardc = programs.find(
      (p) =>
        keyOf(p) ===
        'arrl-scholarship-descriptions::The Amateur Radio Digital Communications (ARDC) Scholarships',
    );
    if (ardc === undefined) throw new Error('the ARDC scholarships are missing from the corpus');
    expect(specsOn(ardc, 'recommendation')).toEqual([
      { axis: 'recommendation', recommenderType: 'teacher', count: 3 },
    ]);
  });

  /**
   * THE ASSERTION ABOVE USED TO CERTIFY A FALSEHOOD, AND PASSING IS WHY NOBODY LOOKED.
   *
   * It read `stages: ['UNDERGRAD']`, introduced as one of "the two clearest real ones, by name and
   * wording" — and the wording it was quoting is
   *
   *     "Applicant must be a US citizen, open only to graduating HIGHSCHOOL SENIORS and
   *      undergraduate students; …"
   *
   * The funder names TWO audiences and the high-school senior is the FIRST. `stages` is an
   * allow-list, so publishing one of the two hard-refused every graduating senior from a $5,000
   * award written to include them, quoting them that sentence as the reason. The cause was a
   * spelling: `\bhigh school seniors?\b` cannot see "highschool", which is how this funder, this
   * capture and the committed seed record all write it.
   *
   * Updating the expected value alone would leave exactly the same test: one that passes for
   * whatever the extractor happens to emit. So the claim is now made the other way round — the
   * funder's SENTENCE is asserted first, then every audience it names is required to be in the
   * spec. Drop `HS_SENIOR` again and this fails; change the spelling in the fixture and the
   * sentence assertion fails loudly instead of the stage list silently narrowing.
   */
  it('publishes BOTH audiences the Goldwater sentence names, the high-school senior first', async () => {
    const { programs } = await corpus();
    const goldwater = programs.find(
      (p) => keyOf(p) === 'arrl-scholarship-descriptions::The ARRL Scholarship to Honor Barry Goldwater',
    );
    if (goldwater === undefined) throw new Error('the Goldwater scholarship is missing from the corpus');
    const stage = goldwater.constraints.find((c) => c.spec.axis === 'age_stage');
    if (stage === undefined || stage.spec.axis !== 'age_stage') {
      throw new Error('Goldwater states an age_stage requirement and it is missing');
    }

    // What the funder wrote, verbatim, including the one-word spelling that caused the defect.
    expect(stage.rawText).toContain('open only to graduating highschool seniors');
    expect(stage.rawText).toContain('and undergraduate students');
    // …therefore both audiences are eligible, and the one named first is not the one dropped.
    expect(stage.spec.stages).toContain('HS_SENIOR');
    expect(stage.spec.stages).toContain('UNDERGRAD');
    expect(stage.spec.stages[0]).toBe('HS_SENIOR');
    // A hard bar, so this is the difference between an award and a refusal, not a label.
    expect(stage.hard).toBe(true);
  });

  /**
   * The same claim over the whole corpus, which is what stops the ninth instance: no published
   * stage list may leave out an audience its own quoted sentence names in so many words. Written
   * as a pair of sentence-shape -> required-stage rules rather than as a list of program names,
   * so a new record arriving with a new spelling is checked by the rule and not by whether anyone
   * remembered to add it.
   *
   * HARD CONSTRAINTS, WHICH IS THIS FILE'S WHOLE SUBJECT. A stage matched off a menu run is a
   * defect here because `spec.stages` is an allow-list the matcher REFUSES on — the IEEE Student
   * Branch Rebate barring every undergraduate on the strength of a footer link. A soft stage list
   * refuses nobody; it answers the different question of whom the funder says it prefers, where an
   * omitted audience is a claim withheld rather than a bar invented, and where the funder's own
   * "…, BUT graduate students may apply" is a reason to withhold it. That case is owned, with its
   * one licensed exemption and a vacuity count, by R4 in `spec-vs-sentence.test.ts`; duplicating
   * the exemption here would mean two copies of it to keep honest.
   */
  it('no HARD stage list drops an audience its own sentence names', async () => {
    const { programs } = await corpus();
    const RULES: Array<{ says: RegExp; mustAllow: string; label: string }> = [
      { says: /\bgraduating\s+high[\s-]?school\s+seniors?\b/i, mustAllow: 'HS_SENIOR', label: 'graduating high-school seniors' },
      { says: /\bundergraduate\s+students?\b/i, mustAllow: 'UNDERGRAD', label: 'undergraduate students' },
      { says: /\bgraduate\s+students?\b/i, mustAllow: 'GRAD', label: 'graduate students' },
    ];
    const offenders: string[] = [];
    let checked = 0;
    for (const program of programs) {
      for (const c of program.constraints) {
        if (c.spec.axis !== 'age_stage' || !c.hard || c.spec.stages.length === 0) continue;
        for (const rule of RULES) {
          if (!rule.says.test(c.rawText)) continue;
          checked += 1;
          if (c.spec.stages.includes(rule.mustAllow as never)) continue;
          offenders.push(
            `${program.name}: names "${rule.label}" but publishes stages ` +
              `${JSON.stringify(c.spec.stages)} — ${JSON.stringify(c.rawText.slice(0, 120))}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard, exact: nine hard stage lists in the corpus have an audience claim checked
    // against them. Exact rather than a floor so that a rule going blind — the way the old
    // `\b2[\s-]?year\b` spelling went blind to "2- or 4-year" — is a failure and not a silence.
    expect(checked).toBe(9);
  });
});

// ---------------------------------------------------------------- the mechanism

describe('a menu run is dropped before either axis reads the page', () => {
  it('recommendation: a page whose menu says "Sponsor" states no recommendation requirement', () => {
    // Verbatim from fixtures/ylrl/ — the run that produced the real constraint.
    const page = [
      'Scholarships - Young Ladies Radio League',
      'Skip to content',
      'Contact',
      'Why Join',
      'Resources',
      'Links',
      'Young Ladies Radio League',
      'Membership',
      'Join/Renew Application',
      'Sponsor',
      'Adoptee Application',
      'Districts',
      '• Applicant must be female.',
      '• Applicant must have an Amateur Radio License.',
    ].join('\n');
    expect(extractRecommendation(raw({}, page))).toEqual([]);
    // …and the guard is not a blanket "ignore rawText": a real requirement in the same position
    // still produces its constraint, with the funder's own wording as the evidence.
    const withRequirement = `${page}\n• Applicant must submit two letters of recommendation.`;
    const cs = extractRecommendation(raw({}, withRequirement));
    expect(cs).toHaveLength(1);
    expect(cs[0].spec).toEqual({ axis: 'recommendation', recommenderType: 'any', count: 2 });
    expect(cs[0].rawText).toBe('• Applicant must submit two letters of recommendation.');
  });

  it('age_stage: a menu naming a degree level is not a stage bar', () => {
    // Verbatim shape from fixtures/ieee-student-branch-rebate/. `stages` is an ALLOW-list, so the
    // single word "Graduate" in a footer excluded everyone who is not a graduate student.
    const page = [
      'Submit Your Student Branch Annual Plan - IEEE Students',
      'Renew Membership',
      'Join IEEE Today!',
      'Skip to content',
      // "IEEE.org" is deliberately not in this run: it carries a ".", so `isChromeLine` reads it
      // as a sentence and it survives. That is the documented, accepted imprecision of the run
      // rule — a menu item that looks like prose is kept, because keeping too much is the
      // recoverable direction and the run either side of it is still removed.
      'IEEE Xplore Digital Library',
      'Student Branches',
      'Graduate Students',
      'Young Professionals',
      'Membership Benefits',
    ].join('\n');
    expect(extractAgeStage(raw({}, page))).toEqual([]);
    // A real stage sentence on the same page still lands, and it is what gets quoted.
    const cs = extractAgeStage(raw({}, `${page}\nThe rebate is open to graduate students only.`));
    expect(cs).toHaveLength(1);
    expect(cs[0].spec).toEqual({ axis: 'age_stage', stages: ['GRAD'] });
    expect(cs[0].rawText).toBe('The rebate is open to graduate students only.');
  });

  it('needs a RUN, so the ARRL catalogue’s own short answers are never dropped', () => {
    // The flattened record both axes read for 111 of the corpus's 149 programs. Every line is
    // labelled and none stands four deep, so nothing here is chrome — a rule without the run
    // requirement would eat the funder's own answers on the largest source in the corpus.
    const record = [
      'Award Amount: $2,000',
      'License Requirement: None',
      'Institution: Any',
      'Other: Applicant must be a high school senior and submit two letters of recommendation',
    ].join('\n');
    expect(withoutSiteChrome(record)).toBe(record);
    const reco = extractRecommendation(raw({}, record));
    expect(reco).toHaveLength(1);
    expect(reco[0].spec).toEqual({ axis: 'recommendation', recommenderType: 'any', count: 2 });
    const stage = extractAgeStage(raw({}, record));
    expect(stage).toHaveLength(1);
    expect(stage[0].spec).toEqual({ axis: 'age_stage', stages: ['HS_SENIOR'] });
  });
});
