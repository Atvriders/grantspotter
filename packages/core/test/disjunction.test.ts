/**
 * THE FUNDER NAMED MORE THAN ONE ROUTE — `ConstraintSpec.anyOf` and `.orUnrepresented`, and the
 * open-list widening now shared by every allow-list axis.
 *
 * WHAT THIS FILE IS ABOUT. Eight hard `ineligible` verdicts were measured whose evidence — the
 * funder's own sentence, the one GrantSpotter prints under the verdict — says the applicant
 * qualifies. All eight are one shape: the funder named ALTERNATIVES AT DIFFERENT TIERS, the spec
 * had room for one, the extractor picked a winner, and the losing branch hardened into a refusal.
 *
 *   "Resident of Brevard County FL, or any FL resident"    county[Brevard] refused a Floridian
 *   "Resident of Gwinnett County GA, or the State of GA"   county[Gwinnett] refused a Georgian
 *   "…General Class … two years …, or hold a current
 *    Amateur Extra Class License"                          GENERAL+24mo refused an Extra of 6 months
 *
 * The two fields are MONOTONE IN THE SAFE DIRECTION and the first three tests below say so
 * directly, because that property is what makes an extractor bug here cost a page-read rather than
 * an award: `anyOf` can only turn a `fail` into a `pass`, `orUnrepresented` only a `fail` into an
 * `unknown`, and neither can invent a refusal.
 *
 * Kept in its own file rather than appended to `matcher.test.ts` for the reason `license.test.ts`,
 * `chrome-scope.test.ts` and `preference-scope.test.ts` exist: concurrently-running agents edit the
 * big shared suites.
 */
import { describe, expect, it } from 'vitest';
import { evaluateConstraint, matchProgram } from '../src/matcher.js';
import { constraintSchema, constraintSpecSchema } from '../src/schema.js';
import type { ConstraintSpec, ConstraintTier, Profile, StudentProfile } from '../src/types.js';
import { makeProgram, makeStudent } from './fixtures.js';

const NOW = '2026-08-02T00:00:00.000Z';

const student = (over: Partial<StudentProfile>): Profile => makeStudent(over);

const status = (spec: ConstraintSpec, profile: Profile, rawText = ''): string =>
  evaluateConstraint(spec, profile, NOW, rawText).status;

// ---------------------------------------------------------------- the property

describe('a disjunction can only ever widen', () => {
  /**
   * The load-bearing claim. Every axis, every profile: adding an alternative never turns a pass
   * into a refusal and never turns an unknown into one. If a future extractor writes nonsense into
   * `anyOf`, this is the bound on the damage.
   */
  it('never turns a pass or an unknown into a fail, on any axis', () => {
    const bases: ConstraintSpec[] = [
      { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 24 },
      { axis: 'geography', geo: { type: 'county', values: ['Brevard'] } },
      { axis: 'field_of_study', fields: ['electronics'], excludedFields: [] },
      { axis: 'age_stage', stages: ['HS_SENIOR'] },
      { axis: 'gpa', min: 3.5 },
      { axis: 'citizenship', allowed: ['US_CITIZEN'] },
      { axis: 'ham_activity', activityKinds: ['contesting'], proofRequired: false },
    ];
    const profiles: Profile[] = [
      student({}),
      student({ licenseClass: 'EXTRA', licensedSince: '2010-01-01T00:00:00.000Z' }),
      student({ state: 'FL', county: 'Brevard', fieldOfStudy: 'electronics', stage: 'HS_SENIOR' }),
      student({ state: 'GA', county: 'Fulton', fieldOfStudy: 'Music', stage: 'GRAD', gpa: 2.0 }),
    ];
    // A deliberately unhelpful alternative FOR EACH AXIS: it matches almost nobody, so if `anyOf`
    // could narrow, it would. One per axis rather than one list for all of them, because an
    // alternative is now the same axis as its base by construction — see the same-axis block at
    // the end of this file for why that stopped being a matter of extractor discipline.
    const useless: Record<string, ConstraintTier[]> = {
      license: [{ axis: 'license', licenseMin: 'EXTRA', heldMonthsMin: 600 }],
      geography: [{ axis: 'geography', geo: { type: 'county', values: ['Nowhere'] } }],
      field_of_study: [{ axis: 'field_of_study', fields: ['Sanskrit'], excludedFields: [] }],
      age_stage: [{ axis: 'age_stage', stages: ['HS_SENIOR'], ageMax: 3 }],
      gpa: [{ axis: 'gpa', min: 4.5 }],
      citizenship: [{ axis: 'citizenship', allowed: ['US_CITIZEN'] }],
      ham_activity: [{ axis: 'ham_activity', activityKinds: ['teaching'], cwProficiencyWpmMin: 99, proofRequired: true }],
    };
    for (const base of bases) {
      for (const profile of profiles) {
        const before = status(base, profile);
        const after = status({ ...base, anyOf: useless[base.axis] } as ConstraintSpec, profile);
        if (before !== 'fail') {
          expect(after, `${base.axis} went ${before} -> ${after}`).not.toBe('fail');
        }
      }
    }
  });

  it('a spec with no alternatives evaluates exactly as it did before', () => {
    const spec: ConstraintSpec = { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 24 };
    const extra6mo = student({ licenseClass: 'EXTRA', licensedSince: '2026-02-01T00:00:00.000Z' });
    expect(status(spec, extra6mo)).toBe('fail');
    expect(evaluateConstraint(spec, student({}), NOW)).toEqual({
      status: 'unknown',
      missing: ['licenseClass'],
    });
  });

  it('orUnrepresented converts a refusal into an unknown with NOTHING to fill in', () => {
    const spec: ConstraintSpec = {
      axis: 'age_stage',
      stages: ['HS_SENIOR'],
      orUnrepresented: 'previous awardees',
    };
    const undergrad = student({ stage: 'UNDERGRAD' });
    expect(status({ axis: 'age_stage', stages: ['HS_SENIOR'] }, undergrad)).toBe('fail');
    // Not a refusal — and not an editor field either, because no answer can settle it.
    expect(evaluateConstraint(spec, undergrad, NOW)).toEqual({ status: 'unknown', missing: [] });
    // …and it does not reach an applicant who meets the STATED route. They are eligible, not
    // uncertain: `orUnrepresented` is consulted only once every representable route has failed.
    expect(status(spec, student({ stage: 'HS_SENIOR' }))).toBe('pass');
  });

  it('surfaces as "unknown, nothing you can do" and never as ineligible in a whole verdict', () => {
    const program = makeProgram({
      applicantEntities: ['individual'],
      constraints: [
        {
          id: 'age-0',
          hard: true,
          fallbackRank: 0,
          rawText: 'The scholarship is open to graduating high school seniors, and to previous awardees.',
          spec: { axis: 'age_stage', stages: ['HS_SENIOR'], orUnrepresented: 'previous awardees' },
        },
      ],
    });
    expect(matchProgram(student({ stage: 'GRAD' }), program, NOW)).toEqual({
      kind: 'unknown',
      missingProfileFields: [],
    });
  });
});

// ---------------------------------------------------------------- per-axis composition

describe('the tiers a funder actually writes', () => {
  it('geography: a county bar with a state alternative admits the whole state', () => {
    // "Resident of Brevard County FL, or any FL resident"
    const spec: ConstraintSpec = {
      axis: 'geography',
      geo: { type: 'county', values: ['Brevard'] },
      anyOf: [{ axis: 'geography', geo: { type: 'state', values: ['FL'] } }],
    };
    expect(status(spec, student({ state: 'FL', county: 'Orange' }))).toBe('pass');
    expect(status(spec, student({ state: 'FL', county: 'Brevard' }))).toBe('pass');
    expect(status(spec, student({ state: 'GA', county: 'Fulton' }))).toBe('fail');
    // A profile that never said which county it is in no longer has to: the state settles it.
    expect(status(spec, student({ state: 'FL' }))).toBe('pass');
  });

  it('license: "General held two years, OR Extra" stops being an AND', () => {
    const spec: ConstraintSpec = {
      axis: 'license',
      licenseMin: 'GENERAL',
      heldMonthsMin: 24,
      anyOf: [{ axis: 'license', licenseMin: 'EXTRA' }],
    };
    // The person the second half of the sentence exists for.
    expect(status(spec, student({ licenseClass: 'EXTRA', licensedSince: '2026-02-01T00:00:00.000Z' }))).toBe('pass');
    // The first half still holds, both ways round.
    expect(status(spec, student({ licenseClass: 'GENERAL', licensedSince: '2020-01-01T00:00:00.000Z' }))).toBe('pass');
    expect(status(spec, student({ licenseClass: 'GENERAL', licensedSince: '2026-02-01T00:00:00.000Z' }))).toBe('fail');
    expect(status(spec, student({ licenseClass: 'TECH', licensedSince: '2010-01-01T00:00:00.000Z' }))).toBe('fail');
    // An Extra whose start date is unknown passes on the tier that does not need it — the union of
    // missing fields is what stops the base tier's `unknown` masking a route that already passed.
    expect(status(spec, student({ licenseClass: 'EXTRA' }))).toBe('pass');
  });

  it('field_of_study: an "any field at this level" tier unrestricts, but never past an exclusion', () => {
    // "Undergraduate degree or electronic technician certification program"
    const spec: ConstraintSpec = {
      axis: 'field_of_study',
      fields: ['electronic technician certification program'],
      excludedFields: [],
      anyOf: [{ axis: 'field_of_study', fields: [], excludedFields: [] }],
    };
    expect(status(spec, student({ fieldOfStudy: 'Biology' }))).toBe('pass');
    expect(status(spec, student({ fieldOfStudy: 'Electronics Technology' }))).toBe('pass');
    // An exclusion is a requirement, not a tier. It rides on both.
    const barred: ConstraintSpec = {
      axis: 'field_of_study',
      fields: ['engineering'],
      excludedFields: ['Liberal Arts'],
      anyOf: [{ axis: 'field_of_study', fields: [], excludedFields: ['Liberal Arts'] }],
    };
    expect(status(barred, student({ fieldOfStudy: 'Biology' }))).toBe('pass');
    expect(status(barred, student({ fieldOfStudy: 'Liberal Arts' }))).toBe('fail');
  });

  it('unknown wins over fail across tiers, and lists every field that could settle any of them', () => {
    const spec: ConstraintSpec = {
      axis: 'geography',
      geo: { type: 'county', values: ['Brevard'] },
      anyOf: [{ axis: 'geography', geo: { type: 'state', values: ['FL'] } }],
    };
    expect(evaluateConstraint(spec, student({}), NOW)).toEqual({
      status: 'unknown',
      missing: ['county', 'state'],
    });
  });

  it('an axis that cannot be evaluated at all stays not_evaluable, alternatives or not', () => {
    const org: Profile = { kind: 'organization', entity: 'club_501c3', state: 'FL' };
    const spec: ConstraintSpec = {
      axis: 'field_of_study',
      fields: ['electronics'],
      excludedFields: [],
      anyOf: [{ axis: 'field_of_study', fields: [], excludedFields: [] }],
    };
    expect(status(spec, org)).toBe('not_evaluable');
  });
});

// ---------------------------------------------------------------- the shared widening

describe('the funder who says their own list is illustrative', () => {
  const kinds: ConstraintSpec = {
    axis: 'ham_activity',
    activityKinds: ['club_member', 'ares_races_skywarn', 'teaching', 'on_air'],
    proofRequired: false,
  };
  const contester = student({ activityKinds: ['contesting', 'field_day'] });

  it('ham_activity: a closed list still bars, so the rule is not a blanket loosening', () => {
    expect(status(kinds, contester, 'Applicant must be an active member of a local radio club.')).toBe('fail');
  });

  /**
   * AN OPENED LIST STOPS THE LIST GATING. IT DOES NOT ANSWER FOR THE APPLICANT.
   *
   * The round that introduced this widening read it as `pass`, which turned a hard requirement
   * into a positive verdict for someone on none of the funder's examples — including someone
   * whose `activityKinds` is `[]`, i.e. who answered "none of these". `unknown` is what keeps
   * both halves: no refusal the sentence does not support, and no claim the funder never made.
   */
  it('ham_activity: "and any similar activities" stops the list REFUSING — ARDC, verbatim', () => {
    const ardc =
      'Examples: membership in a local or regional club, participation in amateur radio emergency ' +
      'activities, teaching amateur radio classes, on-the-air activities, participation in college ' +
      'radio clubs, and any similar activities which illustrate his/her interest and participation ' +
      'with the amateur radio avocation.';
    // Was `fail` before the widening, and is not a refusal any more.
    expect(status(kinds, contester, ardc)).toBe('unknown');
    // …but neither is it a yes: nothing here says a contester's activity is one of the examples.
    expect(evaluateConstraint(kinds, contester, NOW, ardc).missing).toEqual([]);
    // Answering "none of these" is an answer, and it is not a qualification either.
    expect(status(kinds, student({ activityKinds: [] }), ardc)).toBe('unknown');
    // THE QUESTION IS STILL ASKED. An applicant who has said nothing gets the fillable prompt,
    // because naming a kind the funder listed is still a pass on the funder's own words.
    expect(status(kinds, student({}), ardc)).toBe('unknown');
    expect(evaluateConstraint(kinds, student({}), NOW, ardc).missing).toEqual(['activityKinds']);
    // And someone who IS on the list passes on it, opened or not.
    expect(status(kinds, student({ activityKinds: ['teaching'] }), ardc)).toBe('pass');
  });

  /**
   * The CARA Merit Scholarship's real sentence ends "…GOTA, Field Day, etc." and is pinned against
   * the committed capture in `normalize/axes/disjunction.test.ts`, which reads it out of the corpus
   * record rather than retyping it. It is deliberately NOT reproduced here: `userFacingCopyContract`
   * treats any 16-character run shared with a product string as a test naming that string, and
   * CARA's list happens to contain the Profile page's "ARES, RACES or SKYWARN" option label word
   * for word — so quoting it in a matcher unit test would silently mark a dropdown nobody has
   * asserted as covered. This case pins the MARKER; the corpus test pins the funder.
   */
  it('ham_activity: a trailing "etc." is the funder opening the list too', () => {
    const clubOnly = student({ activityKinds: ['club_member'] });
    const closed: ConstraintSpec = {
      axis: 'ham_activity',
      activityKinds: ['ares_races_skywarn', 'field_day', 'public_service'],
      proofRequired: false,
    };
    expect(status(closed, clubOnly, 'Applicant must be active in ARES.')).toBe('fail');
    expect(
      status(closed, clubOnly, 'Must demonstrate use of amateur radio through community events, Field Day, etc.'),
    ).toBe('unknown');
  });

  /**
   * A HARD FAIL STILL OUTRANKS THE OPENED LIST. The widening is about the LIST, and the numeric
   * floor beside it is a fact about the applicant that the funder's "not limited to" does not
   * touch — so a 5 wpm operator is still refused, and the opened list cannot upgrade that refusal
   * into an `unknown` any more than it may upgrade it into a pass.
   */
  it('ham_activity: an open list opens the LIST, never a numeric floor', () => {
    const cwops: ConstraintSpec = {
      axis: 'ham_activity',
      activityKinds: ['club_member', 'on_air', 'contesting'],
      cwProficiencyWpmMin: 15,
      proofRequired: true,
    };
    const open = 'Examples include but are not limited to: ARRL Code Proficiency certificate at 15 wpm or higher';
    expect(status(cwops, student({ activityKinds: ['teaching'], cwWpm: 20 }), open)).toBe('unknown');
    expect(status(cwops, student({ activityKinds: ['on_air'], cwWpm: 5 }), open)).toBe('fail');
    // The list is only ever consulted for the applicant it can answer for: on it, the wpm floor
    // is the whole question.
    expect(status(cwops, student({ activityKinds: ['on_air'], cwWpm: 20 }), open)).toBe('pass');
  });

  /**
   * ONE SIGNAL, ONE ANSWER — the two axes that read `funderOpenedTheList` now agree, and this is
   * the case where they used to differ.
   *
   * `field_of_study` read an opened list as a PASS for one round, on the argument that the
   * applicant HAS named a field, so the funder had invited a judgement of adjacency the applicant
   * could make off the verbatim sentence. Measured over the corpus, what that produced was
   * `eligible` on eight non-empty lists for majors the sentences do not point at — a Music
   * Performance graduate student admitted to a healing-arts award. Naming a field is what makes
   * the question ASKABLE; it is not evidence of adjacency to a list the field shares no word with.
   */
  it('field_of_study reads an opened list exactly as ham_activity does', () => {
    const marco: ConstraintSpec = {
      axis: 'field_of_study',
      fields: ['healing arts', 'Medicine', 'Nursing'],
      excludedFields: [],
    };
    const raw =
      'Field of study must be leading to a career in the healing arts, including, but not ' +
      'necessarily leading to Medicine, Dentistry, Veterinary Medicine, Nursing, Pharmacy, EMT, ' +
      'or Radiology technician.';
    // Was `fail` before the widening existed, and is not a refusal any more.
    expect(status(marco, student({ fieldOfStudy: 'Physical Therapy' }), raw)).toBe('unknown');
    // …but neither is it a yes, and the applicant nothing in the sentence points at gets the same
    // answer rather than an eligibility.
    expect(status(marco, student({ fieldOfStudy: 'Music Performance' }), raw)).toBe('unknown');
    expect(evaluateConstraint(marco, student({ fieldOfStudy: 'Music Performance' }), NOW, raw).missing).toEqual([]);
    // THE QUESTION IS STILL ASKED, because a field the funder listed is still a pass.
    expect(evaluateConstraint(marco, student({}), NOW, raw)).toEqual({
      status: 'unknown',
      missing: ['fieldOfStudy'],
    });
    expect(status(marco, student({ fieldOfStudy: 'Nursing' }), raw)).toBe('pass');
    // Close the list and the same applicant is refused: the marker is doing the work.
    expect(status(marco, student({ fieldOfStudy: 'Physical Therapy' }), 'Medicine or Nursing.')).toBe('fail');
  });
});

// ---------------------------------------------------------------- the same-axis rule

/**
 * `anyOf` IS THE ONE MECHANISM HERE THAT CAN TURN A REFUSAL INTO AN ADMISSION, and until this
 * round its entire safety argument rested on a rule nothing checked.
 *
 * The rule is that alternatives are TIERS OF THE SAME AXIS — a disjunction is only "the funder's
 * other route" while both routes answer the same question. It was written down three times (in
 * `ConstraintAlternatives`, in `schema.ts`, in `evaluateConstraint`) as a request to extractors,
 * and the file it protects said out loud that nothing enforced it. Measured against the real
 * `evaluateConstraint` on the day it was found:
 *
 *   {axis:'field_of_study', fields:['Engineering']} + anyOf:[{axis:'geography', geo:{type:'any'}}]
 *     -> PASS for a Basket Weaving major.
 *
 * All six `anyOf` constraints in the committed corpus are same-axis and every route in them is
 * named in the funder's own sentence, so nothing shipped wrong. "No extractor has done it yet" is
 * not a property.
 */
describe('an alternative can only ever be another tier of the same question', () => {
  const basketWeaver = student({ fieldOfStudy: 'Basket Weaving', state: 'TX' });
  const engineeringOnly: ConstraintSpec = {
    axis: 'field_of_study',
    fields: ['Engineering'],
    excludedFields: [],
  };

  it('is a compile error at the extractor', () => {
    // @ts-expect-error a geography tier is not an alternative to a field-of-study tier
    const crossAxis: ConstraintSpec = { ...engineeringOnly, anyOf: [{ axis: 'geography', geo: { type: 'any', values: [] } }] };
    // The same literal, written the way a well-formed record does, compiles.
    const sameAxis: ConstraintSpec = {
      ...engineeringOnly,
      anyOf: [{ axis: 'field_of_study', fields: ['Basket Weaving'], excludedFields: [] }],
    };
    expect(status(sameAxis, basketWeaver)).toBe('pass');
    expect(crossAxis.axis).toBe('field_of_study');
  });

  it('is refused by the schema, so the JSON column cannot smuggle one past the type', () => {
    // `constraints.spec` is TEXT-containing-JSON and `listForProgram` re-parses every stored row.
    // A cross-axis alternative arriving from there has never been near a type checker.
    expect(() =>
      constraintSpecSchema.parse({
        axis: 'field_of_study',
        fields: ['Engineering'],
        excludedFields: [],
        anyOf: [{ axis: 'geography', geo: { type: 'any', values: [] } }],
      }),
    ).toThrow();
    // ...and the same shape with the right axis still round-trips.
    expect(
      constraintSpecSchema.parse({
        axis: 'field_of_study',
        fields: ['Engineering'],
        excludedFields: [],
        anyOf: [{ axis: 'field_of_study', fields: [], excludedFields: [] }],
      }),
    ).toMatchObject({ anyOf: [{ axis: 'field_of_study' }] });
  });

  it('is ignored by the matcher, so a corrupt row cannot invent an admission either', () => {
    // The exact spec from the finding, forced past both guards the way a bad migration would.
    const crossAxis = {
      ...engineeringOnly,
      anyOf: [{ axis: 'geography', geo: { type: 'any', values: [] } }],
    } as unknown as ConstraintSpec;
    expect(status(crossAxis, basketWeaver)).toBe('fail');
    // Dropped, not read as a refusal: the base tier's own answer is what stands, so corrupt data
    // can never hide money either.
    expect(status(crossAxis, student({ fieldOfStudy: 'Engineering' }))).toBe('pass');
    expect(evaluateConstraint(crossAxis, student({}), NOW)).toEqual({
      status: 'unknown',
      missing: ['fieldOfStudy'],
    });
  });
});

/**
 * A ROUTE THE FUNDER CLOSED BY NAME IS NOT A ROUTE A DISJUNCTION MAY REOPEN.
 *
 * `excludedFields` is the corpus's only such route — "Any, except for Liberal Arts" (The Rick
 * Hughes, K4BYT, Memorial Scholarship) — and it is a REQUIREMENT riding on every tier, never a
 * tier of its own. Both extractors knew that and both said so in prose: `fieldOfStudy.ts` copies
 * the exclusion onto the alternative it mints, and declines to mint `orUnrepresented` at all when
 * a record carries one. That made a funder's own bar depend on two extractors remembering, in two
 * places, forever — and a sibling that forgot turned the refusal into a `pass`.
 */
describe('an exclusion is a requirement, not a tier', () => {
  const liberalArts = student({ fieldOfStudy: 'Liberal Arts' });

  it('survives a sibling tier that forgot it', () => {
    const forgetful: ConstraintSpec = {
      axis: 'field_of_study',
      fields: ['engineering'],
      excludedFields: ['Liberal Arts'],
      anyOf: [{ axis: 'field_of_study', fields: [], excludedFields: [] }],
    };
    expect(status(forgetful, liberalArts)).toBe('fail');
    // ...while the alternative still does its own job for everybody the funder did not bar.
    expect(status(forgetful, student({ fieldOfStudy: 'Biology' }))).toBe('pass');
  });

  it('survives an orUnrepresented beside it', () => {
    const softened: ConstraintSpec = {
      axis: 'field_of_study',
      fields: ['engineering'],
      excludedFields: ['Liberal Arts'],
      orUnrepresented: 'or a related field',
    };
    expect(status(softened, liberalArts)).toBe('fail');
    // The route the funder named for everyone else is still softened, exactly as before.
    expect(status(softened, student({ fieldOfStudy: 'Biology' }))).toBe('unknown');
  });
});

// ---------------------------------------------------------------- the contract

describe('the representation survives the round trip the product actually makes', () => {
  /**
   * `constraints.spec` is a JSON column and every stored constraint is re-parsed through
   * `constraintSchema` on the way out. A zod object strips what it does not know, so without the
   * schema half of this change every disjunction would work in the extractor, work in this suite,
   * and be silently deleted between SQLite and the browser.
   */
  it('zod keeps anyOf and orUnrepresented through a parse', () => {
    const stored = {
      id: 'geography-0-deadbeef',
      hard: true,
      fallbackRank: 0,
      rawText: 'Resident of Brevard County FL, or any FL resident',
      spec: {
        axis: 'geography',
        geo: { type: 'county', values: ['Brevard'] },
        anyOf: [{ axis: 'geography', geo: { type: 'state', values: ['FL'] } }],
      },
    };
    expect(constraintSchema.parse(structuredClone(stored))).toEqual(stored);
    expect(
      constraintSpecSchema.parse({
        axis: 'age_stage',
        stages: ['HS_SENIOR'],
        orUnrepresented: 'previous awardees',
      }),
    ).toEqual({ axis: 'age_stage', stages: ['HS_SENIOR'], orUnrepresented: 'previous awardees' });
  });

  it('still refuses an axis outside the union, and still enumerates all 13 for the drawer', () => {
    expect(() => constraintSpecSchema.parse({ axis: 'vibes', note: 'nope' })).toThrow();
    // `web/src/components/IneligibilityDrawer.test.tsx` reads `.options` to prove no axis can
    // arrive unlabelled. Wrapping the union in an intersection would have removed it silently.
    expect(constraintSpecSchema.options).toHaveLength(13);
    expect(() =>
      constraintSpecSchema.parse({
        axis: 'geography',
        geo: { type: 'county', values: ['Brevard'] },
        anyOf: [{ axis: 'geography', geo: { type: 'nowhere', values: [] } }],
      }),
    ).toThrow();
  });
});
