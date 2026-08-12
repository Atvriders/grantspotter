import { describe, expect, it } from 'vitest';
import {
  APPLICANT_ENTITY_CONSTRAINT_SUFFIX,
  APPLICANT_ENTITY_WORDING,
  applicantEntityListLabel,
  evaluateConstraint,
  hasFunderWording,
  isApplicantEntityConstraint,
  matchAll,
  matchProgram,
  statesARequirement,
} from '../src/matcher.js';
import type {
  ApplicantEntity,
  Constraint,
  ConstraintSpec,
  ConstraintTier,
  DegreeLevel,
  Stage,
  StudentProfile,
} from '../src/types.js';
import { makeConstraint, makeOrg, makeProgram, makeStudent } from './fixtures.js';

const NOW = '2027-03-01T00:00:00.000Z';

/** CONTRACT §3's whole `ApplicantEntity` union, so a new member cannot skip these checks. */
const ALL_APPLICANT_ENTITIES: ApplicantEntity[] = [
  'individual',
  'club_unincorporated',
  'club_501c3',
  'club_via_fiscal_sponsor',
  'school_lea',
  'university',
  'university_dept',
  'ieee_student_branch_chapter',
  'teacher',
  'nominated_by_institution',
];

/** The `note` off an `other`-axis constraint — GrantSpotter's own restatement, if it has one. */
function describeOther(constraint: Constraint): string {
  return constraint.spec.axis === 'other' ? constraint.spec.note : '';
}

describe('matchProgram — baseline', () => {
  /**
   * SILENCE IS NOT PERMISSION — and this test used to assert that it was.
   *
   * `eligible` means "you meet every requirement this record states". Over an EMPTY constraint list
   * that is vacuously true, and it reads to the person acting on it as "you may apply". Measured
   * over the 150 publishable programmes the committed fixtures produce, 28 carry no constraints at
   * all, and the nine of those with a recorded audience produced 27 `eligible` verdicts across the
   * seven shipped profiles — among them NASA's CubeSat Launch Initiative, the NTIA Public Wireless
   * Supply Chain Innovation Fund, the ARRL Club Grant Program and the Yaesu DR-2X Repeater Program.
   * All four are real money with real published rules that nobody has parsed.
   *
   * The answer is the one `matchProgram` already gives an unrecorded AUDIENCE (round five) and an
   * unmeasurable radius: unresolved, with nothing the reader could fill in. Never `ineligible` —
   * that would hide a live route to money over a gap in our own data.
   */
  it('does not turn a record that states nothing into an eligibility', () => {
    expect(makeProgram().constraints).toEqual([]);
    expect(matchProgram(makeStudent(), makeProgram(), NOW)).toEqual({
      kind: 'unknown',
      missingProfileFields: [],
    });
  });

  /**
   * AN EMPTY LIST IS NOT AN "ANY", and the distinction is the whole width of the rule above. 136
   * constraints in this corpus test nothing while quoting a funder who wrote "Any" / "None" /
   * "All" / "No geographic requirements" — that is the funder ANSWERING the question, and the
   * North Fulton Amateur Radio League Scholarship is made of exactly those. Reading a stated
   * "no restriction" as undecided would be a false exclude with a researched record behind it.
   */
  it('still says eligible when the funder answered the question with "no restriction"', () => {
    const answered = makeProgram({
      constraints: [
        makeConstraint({ axis: 'field_of_study', fields: [], excludedFields: [] }, { rawText: 'Any' }),
        makeConstraint({ axis: 'license', licenseMin: 'NONE' }, { rawText: 'None' }),
        makeConstraint({ axis: 'geography', geo: { type: 'any', values: [] } }, { rawText: 'Any' }),
      ],
    });
    expect(matchProgram(makeStudent(), answered, NOW)).toEqual({ kind: 'eligible' });
  });

  it('works without an explicit clock', () => {
    const stated = makeProgram({
      constraints: [makeConstraint({ axis: 'citizenship', allowed: ['ANY'] }, { rawText: 'Any' })],
    });
    expect(matchProgram(makeStudent(), stated).kind).toBe('eligible');
  });
});

describe('matchProgram — the applicant-entity gate', () => {
  it('refuses a student for a program only an institution can nominate', () => {
    // RCA: the university selects the recipient; the student never applies.
    const rca = makeProgram({
      id: 'rca-scholarships',
      name: 'RCA Scholarship Program',
      applicantEntities: ['nominated_by_institution'],
    });
    const verdict = matchProgram(makeStudent(), rca, NOW);
    expect(verdict.kind).toBe('ineligible');
    if (verdict.kind !== 'ineligible') throw new Error('unreachable');
    expect(verdict.reasons).toHaveLength(1);
    expect(verdict.reasons[0].id).toBe(`rca-scholarships${APPLICANT_ENTITY_CONSTRAINT_SUFFIX}`);
    expect(verdict.reasons[0].hard).toBe(true);
  });

  it('refuses a 501(c)(3) club for a program that only funds via a fiscal sponsor', () => {
    // ARDC requires clubs and individuals to apply through a fiscal sponsor.
    const ardc = makeProgram({
      id: 'ardc-grants',
      applicantEntities: ['club_via_fiscal_sponsor', 'university', 'school_lea'],
      // A stated requirement, so that the applicant this gate LETS THROUGH reaches a real
      // `eligible` rather than the "nothing was recorded" `unknown` of the baseline block above.
      constraints: [makeConstraint({ axis: 'citizenship', allowed: ['ANY'] }, { rawText: 'Any' })],
    });
    expect(matchProgram(makeOrg({ entity: 'club_501c3' }), ardc, NOW).kind).toBe('ineligible');
    expect(matchProgram(makeOrg({ entity: 'university' }), ardc, NOW).kind).toBe('eligible');
  });

  it('refuses an organisation for an individuals-only scholarship', () => {
    expect(matchProgram(makeOrg(), makeProgram(), NOW).kind).toBe('ineligible');
  });
});

/**
 * THE REASON THIS GATE GIVES IS THE ONE SENTENCE IN THIS PRODUCT NO FUNDER WROTE.
 *
 * Everything else in `Verdict.reasons` is a `Constraint` an extractor lifted off a funder's page,
 * and `IneligibilityDrawer` renders `rawText` verbatim in a monospaced quotation block on the
 * strength of that. The applicant-entity constraint is composed here, at match time, out of
 * `program.applicantEntities` — which is not a quotation either: it is GrantSpotter's research on
 * a source, assembled per source id in `normalize/index.ts`'s `ENTITIES_BY_SOURCE`.
 *
 * It used to be given a `rawText` all the same, reading `This program accepts applications from:
 * ieee_student_branch_chapter.` — a plausible funder sentence, in the funder's voice, containing a
 * machine token no human ever typed. `grep -rn` across `packages` and `e2e` found that wording in
 * `matcher.ts` and NOWHERE else: no page, no fixture, no funder. Measured over the real corpus, a
 * collegiate 501(c)(3) club's printed eligibility report carried 144 such rows, 125 of them
 * quoting an enum identifier under a column headed "in the funder's words".
 */
describe('matchProgram — the entity reason quotes nobody, and says so', () => {
  const ieee = makeProgram({
    id: 'ieee-mtts',
    applicantEntities: ['ieee_student_branch_chapter'],
  });

  it('carries an EMPTY rawText, because no funder sentence exists to quote', () => {
    const verdict = matchProgram(makeOrg({ entity: 'club_501c3' }), ieee, NOW);
    if (verdict.kind !== 'ineligible') throw new Error('unreachable');
    expect(verdict.reasons[0].rawText).toBe('');
    expect(hasFunderWording(verdict.reasons[0])).toBe(false);
    expect(isApplicantEntityConstraint(verdict.reasons[0])).toBe(true);
  });

  it('never puts an enum identifier in front of a reader', () => {
    for (const entity of ALL_APPLICANT_ENTITIES) {
      const program = makeProgram({ id: 'p', applicantEntities: [entity] });
      const verdict = matchProgram(makeOrg({ entity: 'club_via_fiscal_sponsor' }), program, NOW);
      if (verdict.kind !== 'ineligible') continue;
      const text = `${verdict.reasons[0].rawText} ${describeOther(verdict.reasons[0])}`;
      // `individual` is also an English word, so the test is about the SHAPE of an identifier:
      // nothing snake_cased may reach a reader. That is what "ieee_student_branch_chapter" was.
      expect(text, `${entity} leaked its identifier`).not.toMatch(/[a-z]+_[a-z]/);
      if (entity.includes('_')) expect(text, entity).not.toContain(entity);
    }
  });

  it('attributes its own sentence to GrantSpotter, inside the sentence', () => {
    const verdict = matchProgram(makeOrg({ entity: 'club_501c3' }), ieee, NOW);
    if (verdict.kind !== 'ineligible') throw new Error('unreachable');
    expect(describeOther(verdict.reasons[0])).toBe(
      'GrantSpotter, not the funder: this record lists who may apply as IEEE student branches ' +
        'and chapters, and your profile applies as a club that is its own 501(c)(3). That list ' +
        "is GrantSpotter's reading of the funder's page, not a sentence the funder wrote — read " +
        'the page before you rule yourself out.',
    );
  });

  it('names every entity of a multi-entity list in English', () => {
    expect(applicantEntityListLabel(['individual'])).toBe('individuals');
    expect(applicantEntityListLabel(['individual', 'teacher'])).toBe(
      'individuals or teachers applying in person',
    );
    expect(applicantEntityListLabel(['individual', 'teacher', 'school_lea'])).toBe(
      'individuals, teachers applying in person or schools and school districts',
    );
    expect(applicantEntityListLabel([])).toBe('');
  });

  it('has English for every entity CONTRACT §3 models, on both sides of the sentence', () => {
    for (const entity of ALL_APPLICANT_ENTITIES) {
      const wording = APPLICANT_ENTITY_WORDING[entity];
      expect(wording.listed, entity).not.toContain('_');
      expect(wording.applying, entity).not.toContain('_');
      expect(wording.listed.length, entity).toBeGreaterThan(entity.length / 2);
    }
    expect(Object.keys(APPLICANT_ENTITY_WORDING).sort()).toEqual([...ALL_APPLICANT_ENTITIES].sort());
  });
});

/**
 * SILENCE IS NOT A PROHIBITION.
 *
 * `[].includes(anything)` is `false`, so a record that stated NOTHING about who may apply was a
 * hard `ineligible` for every possible user, decided before any other axis ran. Measured over the
 * 150 publishable programs the committed fixtures produce: 19 of them carried
 * `applicantEntities: []`, every one of the ten `ApplicantEntity` values was refused by all 19,
 * and a collegiate 501(c)(3) club was refused 144 of 150 with all 144 on this gate. Eleven of the
 * 19 are live routes to money — campus student-government funding and the NASA Space Grant
 * consortia among them, the two the corpus itself annotates as the primary audience's real
 * funding.
 *
 * The rule being applied is `geo.ts`'s, stated for the unmeasurable radius and equally true here:
 * a gap in the data cannot come out as a judgement about a person.
 */
describe('matchProgram — an audience nobody recorded is not a refusal', () => {
  const silent = makeProgram({ id: 'campus-sga', applicantEntities: [], constraints: [] });

  it('is unknown, not ineligible, for every entity the contract models', () => {
    for (const entity of ALL_APPLICANT_ENTITIES) {
      const profile = makeOrg({ entity });
      expect(matchProgram(profile, silent, NOW), entity).toEqual({
        kind: 'unknown',
        missingProfileFields: [],
      });
    }
    expect(matchProgram(makeStudent(), silent, NOW)).toEqual({
      kind: 'unknown',
      missingProfileFields: [],
    });
  });

  it('is unknown and not ELIGIBLE either — nobody said the applicant may apply', () => {
    // The other direction of the same error. `eligible` is the claim an applicant acts on, and
    // an unrecorded audience is not evidence for it.
    expect(matchProgram(makeStudent(), silent, NOW).kind).not.toBe('eligible');
    expect(matchProgram(makeStudent(), silent, NOW).kind).not.toBe('eligible_preferred');
  });

  it('asks for no profile field, because the gap is in the record and not in the reader', () => {
    const verdict = matchProgram(makeStudent({ gpa: 3.9 }), silent, NOW);
    if (verdict.kind !== 'unknown') throw new Error('unreachable');
    expect(verdict.missingProfileFields).toEqual([]);
  });

  it('does not short-circuit: a provable hard failure still outranks it, with its own quote', () => {
    const program = makeProgram({
      applicantEntities: [],
      constraints: [
        makeConstraint({ axis: 'gpa', min: 3.5 }, { id: 'gpa', hard: true, rawText: 'Minimum 3.5 GPA.' }),
      ],
    });
    const verdict = matchProgram(makeStudent({ gpa: 2.0 }), program, NOW);
    expect(verdict.kind).toBe('ineligible');
    if (verdict.kind !== 'ineligible') throw new Error('unreachable');
    expect(verdict.reasons.map((c) => c.id)).toEqual(['gpa']);
    // ...and that one IS a quotation, so the drawer may show it as one.
    expect(hasFunderWording(verdict.reasons[0])).toBe(true);
  });

  it('still runs the other axes, so an unanswered one is named', () => {
    const program = makeProgram({
      applicantEntities: [],
      constraints: [makeConstraint({ axis: 'gpa', min: 3.5 }, { id: 'gpa', hard: true })],
    });
    expect(matchProgram(makeStudent({ gpa: undefined }), program, NOW)).toEqual({
      kind: 'unknown',
      missingProfileFields: ['gpa'],
    });
  });

  it('never lets a met preference promote it to eligible_preferred', () => {
    const program = makeProgram({
      applicantEntities: [],
      constraints: [
        makeConstraint({ axis: 'gpa', min: 3.0 }, { id: 'pref', hard: false, fallbackRank: 1 }),
      ],
    });
    expect(matchProgram(makeStudent({ gpa: 3.9 }), program, NOW).kind).toBe('unknown');
  });
});

describe('matchProgram — hard constraints', () => {
  it('reports every failing hard constraint', () => {
    const program = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'state', values: ['TX'] } },
          { id: 'geo', hard: true },
        ),
        makeConstraint({ axis: 'gpa', min: 3.5 }, { id: 'gpa', hard: true }),
        makeConstraint({ axis: 'license', licenseMin: 'TECH' }, { id: 'lic', hard: true }),
      ],
    });
    const student = makeStudent({ state: 'OH', gpa: 2.0, licenseClass: 'EXTRA' });
    const verdict = matchProgram(student, program, NOW);
    expect(verdict.kind).toBe('ineligible');
    if (verdict.kind !== 'ineligible') throw new Error('unreachable');
    expect(verdict.reasons.map((c) => c.id).sort()).toEqual(['geo', 'gpa']);
  });

  it('prefers a definite failure over an unknown', () => {
    const program = makeProgram({
      constraints: [
        makeConstraint({ axis: 'gpa', min: 3.5 }, { id: 'gpa', hard: true }),
        makeConstraint({ axis: 'citizenship', allowed: ['US_CITIZEN'] }, { id: 'cit', hard: true }),
      ],
    });
    const verdict = matchProgram(makeStudent({ gpa: 2.0 }), program, NOW);
    expect(verdict.kind).toBe('ineligible');
    if (verdict.kind !== 'ineligible') throw new Error('unreachable');
    expect(verdict.reasons.map((c) => c.id)).toEqual(['gpa']);
  });

  it('returns unknown with the sorted, de-duplicated fields that would resolve it', () => {
    const program = makeProgram({
      constraints: [
        makeConstraint({ axis: 'gpa', min: 3 }, { id: 'gpa', hard: true }),
        makeConstraint({ axis: 'license', licenseMin: 'GENERAL' }, { id: 'lic', hard: true }),
        makeConstraint({ axis: 'license', licenseMin: 'EXTRA' }, { id: 'lic2', hard: true }),
      ],
    });
    expect(matchProgram(makeStudent(), program, NOW)).toEqual({
      kind: 'unknown',
      missingProfileFields: ['gpa', 'licenseClass'],
    });
  });

  /**
   * A HARD AXIS NOBODY CAN ANSWER STILL BLOCKS NOBODY — and no longer ADMITS everybody either.
   *
   * `recommendation` and `other` have no profile field in CONTRACT §3, for any applicant, ever.
   * Refusing on one would refuse the whole user base forever, so `not_evaluable` does not block,
   * and that half is unchanged and asserted first below. What changed is the other half: when
   * these are the ONLY requirements a record states, "does not block" was the entire verdict, and
   * `eligible` — "you meet every requirement this record states" — was published without one
   * requirement having been looked at. The ARRL Foundation Scholarship Program is that record in
   * the real corpus, and it said `eligible` to a profile that has answered nothing at all.
   */
  const unanswerableOnly = makeProgram({
    constraints: [
      makeConstraint(
        { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 3 },
        { id: 'rec', hard: true, rawText: 'Three letters of recommendation are required.' },
      ),
      makeConstraint(
        { axis: 'other', note: 'preference to a student ham from a ham family' },
        { id: 'oth', hard: true, rawText: 'Preference to a student ham from a ham family.' },
      ),
    ],
  });

  it('does not let a not-evaluable hard constraint block anyone', () => {
    // The direction that hides money: never `ineligible`, and never a demand for a profile field
    // that does not exist.
    const verdict = matchProgram(makeStudent(), unanswerableOnly, NOW);
    expect(verdict.kind).not.toBe('ineligible');
    if (verdict.kind === 'unknown') expect(verdict.missingProfileFields).toEqual([]);
  });

  it('does not say yes out of nothing when every stated requirement is unanswerable', () => {
    expect(matchProgram(makeStudent(), unanswerableOnly, NOW)).toEqual({
      kind: 'unknown',
      missingProfileFields: [],
    });
    // …and it is not about how full the profile is. A profile that answered NOTHING gets the same
    // reading, because the gap is in what the record can be checked against, not in the reader.
    expect(matchProgram({ kind: 'student' }, unanswerableOnly, NOW)).toEqual({
      kind: 'unknown',
      missingProfileFields: [],
    });
  });

  it('still says eligible when one hard axis really was decided', () => {
    const withOneCheckableAxis = makeProgram({
      constraints: [
        ...unanswerableOnly.constraints,
        makeConstraint({ axis: 'gpa', min: 2.0 }, { id: 'gpa', hard: true }),
      ],
    });
    // The GPA clears 2.0, so a requirement really was checked and met — which is exactly what
    // `eligible` claims, and the recommendation line beside it does not withdraw it.
    expect(matchProgram(makeStudent({ gpa: 3.1 }), withOneCheckableAxis, NOW)).toEqual({
      kind: 'eligible',
    });
  });

  it('leaves a funder who ANSWERED the question eligible, on both unanswerable axes', () => {
    // "No letters of recommendation are required" / an `other` tier holding nothing: the same
    // reading a citizenship list of "Any" gets. `statesARequirement` is what separates the two,
    // and a funder saying "none needed" has not left anything unchecked.
    const answered = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'recommendation', recommenderType: 'none', count: 0 },
          { id: 'rec', hard: true, rawText: 'No letters of recommendation are required.' },
        ),
        makeConstraint({ axis: 'other', note: '' }, { id: 'oth', hard: true }),
      ],
    });
    expect(matchProgram(makeStudent(), answered, NOW)).toEqual({ kind: 'eligible' });
  });

  it('never fires on a SOFT unanswerable axis — a preference is not a requirement', () => {
    const softOnly = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 3 },
          { id: 'rec', hard: false },
        ),
        makeConstraint({ axis: 'gpa', min: 2.0 }, { id: 'gpa', hard: true }),
      ],
    });
    expect(matchProgram(makeStudent({ gpa: 3.1 }), softOnly, NOW)).toEqual({ kind: 'eligible' });
  });

  /**
   * AND IT IS NOT A NEW SILENCE FOR ORGANISATIONS. Most `not_evaluable`s in `evaluateConstraint`
   * come from `if (!isStudent(profile))` — "this axis is about schooling and you are a club" —
   * which is a requirement that does not bear on this applicant, not a requirement nobody could
   * check. Reading those the same way would put every organisation on every student-worded record
   * into `unknown`, over records where the funder answered plainly.
   */
  it('does not turn a student-only axis into unknown for an organisation', () => {
    const studentWorded = makeProgram({
      applicantEntities: ['club_501c3'],
      constraints: [
        makeConstraint({ axis: 'citizenship', allowed: ['ANY'] }, { id: 'cit', hard: true, rawText: 'Any' }),
      ],
    });
    expect(matchProgram(makeOrg({ entity: 'club_501c3' }), studentWorded, NOW).kind).toBe('eligible');
  });
});

describe('matchProgram — the preference cascade', () => {
  // "Preference will be given to applicants residing in Louisiana. If no
  // qualified applicant is identified, ..." — a soft constraint, not a filter.
  const louisiana = makeProgram({
    constraints: [
      makeConstraint(
        { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
        {
          id: 'pref-la',
          hard: false,
          fallbackRank: 0,
          rawText:
            'Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, the award may be made to an applicant from any state.',
        },
      ),
    ],
  });

  it('ranks a Louisiana applicant as preferred', () => {
    expect(matchProgram(makeStudent({ state: 'LA' }), louisiana, NOW)).toEqual({
      kind: 'eligible_preferred',
      rank: 0,
      met: ['pref-la'],
    });
  });

  it('does NOT exclude an applicant from another state', () => {
    expect(matchProgram(makeStudent({ state: 'TX' }), louisiana, NOW)).toEqual({
      kind: 'eligible',
    });
  });

  it('does NOT turn an unanswerable preference into unknown', () => {
    expect(matchProgram(makeStudent(), louisiana, NOW)).toEqual({ kind: 'eligible' });
  });

  it('takes the lowest fallbackRank among the met preferences', () => {
    const program = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
          { id: 'p0', hard: false, fallbackRank: 0 },
        ),
        makeConstraint(
          { axis: 'arrl_membership', required: true, minYears: 0 },
          { id: 'p2', hard: false, fallbackRank: 2 },
        ),
        makeConstraint({ axis: 'gpa', min: 3.5 }, { id: 'p5', hard: false, fallbackRank: 5 }),
      ],
    });
    const student = makeStudent({
      state: 'LA',
      arrlMemberSince: '2020-01-01T00:00:00.000Z',
      gpa: 2.1,
    });
    expect(matchProgram(student, program, NOW)).toEqual({
      kind: 'eligible_preferred',
      rank: 0,
      met: ['p0', 'p2'],
    });
  });

  it('falls back to the later preference when the primary is not met', () => {
    const program = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
          { id: 'p0', hard: false, fallbackRank: 0 },
        ),
        makeConstraint({ axis: 'gpa', min: 3 }, { id: 'p3', hard: false, fallbackRank: 3 }),
      ],
    });
    expect(matchProgram(makeStudent({ state: 'TX', gpa: 3.4 }), program, NOW)).toEqual({
      kind: 'eligible_preferred',
      rank: 3,
      met: ['p3'],
    });
  });

  /**
   * A PREFERENCE MET BY NOBODY DOING ANYTHING.
   *
   * `eligible_preferred` is the top of the ranking this product sorts by, and `rank` is the number
   * a student uses to decide what to spend an application fee and a transcript on. Both records
   * below are verbatim from the committed corpus, and in both the promotion came out of a spec with
   * no content in it at all.
   */
  it('does not award a preference for a spec that tests nothing', () => {
    // 10-10 International: `fields: []`, and the funder's sentence is the words "No preference."
    // (The extractor files it soft because the word "preference" is in it — which would not matter
    // at all if a vacuous pass were not being counted as an achievement.)
    const tenTen = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'field_of_study', fields: [], excludedFields: [] },
          { id: 'no-preference', hard: false, fallbackRank: 0, rawText: 'No preference.' },
        ),
      ],
    });
    expect(matchProgram(makeStudent({ fieldOfStudy: 'Electrical Engineering' }), tenTen, NOW)).toEqual({
      kind: 'eligible',
    });
    // The Free Family: three institution fields, none of them set, under a sentence naming two
    // universities by name — which `ConstraintTier.institution` has nowhere to put. The applicant
    // was promoted for attending neither.
    const freeFamily = makeProgram({
      constraints: [
        makeConstraint(
          {
            axis: 'institution',
            degreeLevels: [],
            tradeSchoolOK: false,
            partTimeOK: true,
            accreditationRequired: false,
          },
          {
            id: 'rice-and-vt',
            hard: false,
            fallbackRank: 0,
            rawText:
              'Preference will be given to qualified applicants, regardless of residency, ' +
              'attending Rice University in Houston, TX and Virginia Tech in Blacksburg, VA',
          },
        ),
      ],
    });
    expect(matchProgram(makeStudent({ degreeLevel: 'BACH', partTime: false }), freeFamily, NOW)).toEqual({
      kind: 'eligible',
    });
  });

  /**
   * ...AND THE SAME EMPTY FIELDS STILL PASS AS A HARD CONSTRAINT. The rule is about crediting an
   * applicant with an achievement, not about what an empty tier means: 136 constraints in this
   * corpus test nothing while quoting a funder who wrote "Any" or "None", and reading those as
   * anything but a pass would refuse people the funder has just admitted.
   */
  it('leaves a hard tier that tests nothing passing, as the funder\'s "Any" says', () => {
    const anyField = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'field_of_study', fields: [], excludedFields: [] },
          { id: 'any-field', hard: true, rawText: 'Any' },
        ),
      ],
    });
    expect(matchProgram(makeStudent({ fieldOfStudy: 'Music Performance' }), anyField, NOW)).toEqual({
      kind: 'eligible',
    });
  });

  /**
   * The true negative for the rule above: a preference that really does test something still
   * promotes, and still carries its rank. This is what stops "does not award a preference for an
   * empty spec" quietly becoming "does not award preferences".
   */
  it('still promotes on a preference with content in it', () => {
    const attendingHere = makeProgram({
      constraints: [
        makeConstraint(
          {
            axis: 'institution',
            degreeLevels: ['BACH'],
            tradeSchoolOK: false,
            partTimeOK: true,
            accreditationRequired: false,
          },
          { id: 'bachelors-preferred', hard: false, fallbackRank: 2 },
        ),
      ],
    });
    expect(matchProgram(makeStudent({ degreeLevel: 'BACH' }), attendingHere, NOW)).toEqual({
      kind: 'eligible_preferred',
      rank: 2,
      met: ['bachelors-preferred'],
    });
  });

  it('never excludes on financial need even when the constraint is marked hard', () => {
    const program = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'financial_need', weighted: true },
          { id: 'need', hard: true, fallbackRank: 1 },
        ),
      ],
    });
    expect(matchProgram(makeStudent({ financialNeed: false }), program, NOW)).toEqual({
      kind: 'eligible',
    });
    expect(matchProgram(makeStudent({ financialNeed: true }), program, NOW)).toEqual({
      kind: 'eligible_preferred',
      rank: 1,
      met: ['need'],
    });
  });
});

describe('matchProgram — the org/county/call_district carry-forward finding', () => {
  // OrgProfile has no `county` field and no `callDistrict` field (only
  // `callsign`), so a hard geography constraint on either axis can never be
  // resolved for an organisation applicant. Rather than surface `'county'`
  // or `'callDistrict'` as a missingProfileField the org-side UI could never
  // collect, matchProgram treats them as not-evaluable for org profiles.

  /**
   * CLOSE-OUT REVIEW I6 — AN UNRESOLVABLE AXIS STAYS UNKNOWN. IT DOES NOT BECOME A VERDICT.
   *
   * Dropping the field from `missingProfileFields` is right: the org editor has no county input,
   * so linking the reader to one would be a promise the product cannot keep. Dropping the field
   * and then letting `matchProgram` fall through to `eligible` is NOT right — it tells an
   * organisation it satisfies a geography constraint that was never evaluated, and nothing
   * downstream records that an axis went unanswered.
   *
   * The direction is the recoverable one (an applicant who is wrongly included reads the funder's
   * own page; one who is wrongly excluded never sees the award), and it stays that way: `unknown`
   * still is not `ineligible`. But `unknown` is a real, honest state in this product, and turning
   * it into a verdict is the same over-assertion as a phantom 12-month obligation or 148 invented
   * "no cost share required" claims, merely pointed at the optimistic side.
   *
   * Latent in today's corpus, and measured: 5 of the 150 publishable records carry a hard
   * county/call_district geography constraint, and all 5 accept `individual` only — so the
   * applicant-entity gate returns `ineligible` for every organisation before geography is reached.
   * Zero records change verdict. Like the `javascript:` href, it is worth closing while it costs
   * nothing.
   */
  it('leaves an org unknown — not eligible — on an unresolvable county constraint', () => {
    const program = makeProgram({
      applicantEntities: ['club_501c3'],
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'county', values: ['Calcasieu, LA'] } },
          { id: 'county', hard: true },
        ),
      ],
    });
    expect(matchProgram(makeOrg({ entity: 'club_501c3' }), program, NOW)).toEqual({
      kind: 'unknown',
      // Empty on purpose: there is no org input that would answer it, so naming one would send
      // the reader to an editor where nothing they type can change this verdict.
      missingProfileFields: [],
    });
  });

  it('leaves an org unknown — not eligible — on an unresolvable call_district constraint', () => {
    const program = makeProgram({
      applicantEntities: ['club_501c3'],
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'call_district', values: ['5'] } },
          { id: 'district', hard: true },
        ),
      ],
    });
    expect(
      matchProgram(makeOrg({ entity: 'club_501c3', callsign: undefined }), program, NOW),
    ).toEqual({ kind: 'unknown', missingProfileFields: [] });
  });

  it('never turns an unresolvable axis into `ineligible` — the unrecoverable direction', () => {
    const program = makeProgram({
      applicantEntities: ['club_501c3'],
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'county', values: ['Calcasieu, LA'] } },
          { id: 'county', hard: true },
        ),
      ],
    });
    expect(matchProgram(makeOrg({ entity: 'club_501c3' }), program, NOW).kind).not.toBe(
      'ineligible',
    );
  });

  /**
   * A soft constraint never gates, so an unresolvable SOFT geography axis must not manufacture an
   * `unknown` either — that would demand an answer for a preference, which is the defect the
   * "soft unknown does not escalate" rule already forbids.
   */
  it('does not escalate a SOFT unresolvable geography axis to unknown', () => {
    const program = makeProgram({
      applicantEntities: ['club_501c3'],
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'county', values: ['Calcasieu, LA'] } },
          { id: 'county', hard: false },
        ),
      ],
    });
    expect(matchProgram(makeOrg({ entity: 'club_501c3' }), program, NOW)).toEqual({
      kind: 'eligible',
    });
  });

  it('still surfaces a genuinely resolvable missing field for an org alongside the unresolvable one', () => {
    const program = makeProgram({
      applicantEntities: ['club_501c3'],
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'county', values: ['Calcasieu, LA'] } },
          { id: 'county', hard: true },
        ),
        makeConstraint(
          { axis: 'arrl_membership', required: true, minYears: 0 },
          { id: 'arrl', hard: true },
        ),
      ],
    });
    expect(matchProgram(makeOrg({ entity: 'club_501c3' }), program, NOW)).toEqual({
      kind: 'unknown',
      missingProfileFields: ['arrlAffiliated'],
    });
  });

  it('still resolves county normally for a student, whose profile does have the field', () => {
    const program = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'county', values: ['Calcasieu, LA'] } },
          { id: 'county', hard: true },
        ),
      ],
    });
    expect(matchProgram(makeStudent(), program, NOW)).toEqual({
      kind: 'unknown',
      missingProfileFields: ['county'],
    });
  });
});

/**
 * Every `fields` array below is REAL: it is what `extractFieldOfStudy` produces
 * today from the committed ARRL scholarship-descriptions fixture, with the
 * funder's own sentence quoted next to it. Before this axis learned to read
 * prose, string equality made 63 of the 112 individual-facing candidates
 * hard-exclude an electrical-engineering undergraduate.
 */
describe('field_of_study — free-text corpus values', () => {
  const fos = (fields: string[], excludedFields: string[] = []): ConstraintSpec => ({
    axis: 'field_of_study',
    fields,
    excludedFields,
  });
  const status = (spec: ConstraintSpec, fieldOfStudy?: string): string =>
    evaluateConstraint(spec, makeStudent({ fieldOfStudy }), NOW).status;

  it('matches an EE undergraduate against the three shapes the corpus actually holds', () => {
    // "Electronics, communications, or a related technical field" — unsplit prose.
    expect(status(fos(['electronics, communications, or a related technical field']), 'electrical engineering')).toBe('pass');
    // ...and the same sentence after the extractor split it (Charles N. Fisher, Grauer, Lawson).
    expect(status(fos(['Electronics', 'communications', 'related fields']), 'electrical engineering')).toBe('pass');
    // "engineering or science" — one alternative is a strict superset of the applicant's field.
    expect(status(fos(['engineering or science']), 'electrical engineering')).toBe('pass');
    expect(status(fos(['Sciences', 'Engineering']), 'electrical engineering')).toBe('pass');
    // "Electrical Engineering/Electronics" — slash-separated, never split by the extractor.
    expect(status(fos(['Electrical Engineering/Electronics']), 'electrical engineering')).toBe('pass');
    // The STEM list (Bittner, Steel City, Ware, and 15 more) and the degree-level
    // leakage the extractor mints from "Bachelor's degree or higher in electrical
    // engineering" (Metzger).
    expect(status(fos(['Science', 'Technology', 'Engineering', 'Mathematics']), 'electrical engineering')).toBe('pass');
    expect(status(fos(["Bachelor's degree", 'higher in electrical engineering']), 'electrical engineering')).toBe('pass');
  });

  /**
   * "OR RELATED FIELD" WITHDRAWS THE REFUSAL. IT DOES NOT ISSUE AN ADMISSION.
   *
   * This test asserted `pass` for a round, on the reasoning that relatedness is not ours to
   * adjudicate and the applicant reads the verbatim wording anyway. The first half is right and is
   * why none of these is a `fail`. The second half was doing the adjudicating it disclaimed: a
   * `pass` IS an answer, printed as "you are eligible", and nothing in "electronics,
   * communications, or related fields" says industrial design is one of them.
   *
   * `unknown` is the honest third answer, and it costs the applicant nothing — the door stays open,
   * the funder's sentence is on the screen, and no application fee is spent on a claim the funder
   * never made. Same rule, same reasoning, as the `ham_activity` opened list.
   */
  it('reads "or related field" as the funder declining to close their list', () => {
    expect(status(fos(['Electronics', 'communications', 'related fields']), 'physics')).toBe('unknown');
    expect(status(fos(['engineering', 'or a related technical field']), 'industrial design')).toBe('unknown');
    expect(status(fos(['engineering', 'sciences', 'similar field']), 'industrial design')).toBe('unknown');
    // ...and it is an `unknown` with NOTHING to fill in: the applicant has already answered the
    // only question this axis asks.
    expect(
      evaluateConstraint(
        fos(['Electronics', 'communications', 'related fields']),
        makeStudent({ fieldOfStudy: 'physics' }),
        NOW,
      ),
    ).toEqual({ status: 'unknown', missing: [] });
    // The route the funder named FIRST is untouched — an applicant on the list is eligible, not
    // uncertain, and that is what stops this being a blanket softening of the axis.
    expect(status(fos(['Electronics', 'communications', 'related fields']), 'communications')).toBe('pass');
    expect(status(fos(['engineering', 'sciences', 'similar field']), 'chemical engineering')).toBe('pass');
    // Without the widening, the same list is a real bar.
    expect(status(fos(['Electronics', 'communications']), 'industrial design')).toBe('fail');
    // "Technology-related field" / "a Health Care-related field" still NAME a
    // field: they are matched, not treated as a blanket widening.
    expect(status(fos(['Technology-related field']), 'music performance')).toBe('fail');
    expect(status(fos(['Technology-related field']), 'electrical engineering')).toBe('pass');
  });

  it('understands the abbreviations a student actually types', () => {
    expect(status(fos(['Electrical Engineering', 'Computer Science']), 'EE')).toBe('pass');
    expect(status(fos(['Electrical Engineering', 'Computer Science']), 'CS')).toBe('pass');
    expect(status(fos(['Computer Engineering']), 'CE')).toBe('pass');
    expect(status(fos(['Science', 'Technology', 'Engineering', 'Mathematics']), 'STEM')).toBe('pass');
    expect(status(fos(['Music Performance']), 'EE')).toBe('fail');
  });

  it('still excludes a genuine non-match, and says so as a hard verdict', () => {
    expect(status(fos(['Engineering']), 'Music Performance')).toBe('fail');
    expect(status(fos(['Electrical Engineering', 'Computer Science']), 'Music Performance')).toBe('fail');
    expect(status(fos(['Horticulture', 'environmental sciences']), 'electrical engineering')).toBe('fail');
    const engineeringOnly = makeProgram({
      constraints: [makeConstraint(fos(['Engineering']), { id: 'field', hard: true })],
    });
    const verdict = matchProgram(makeStudent({ fieldOfStudy: 'Music Performance' }), engineeringOnly, NOW);
    expect(verdict.kind).toBe('ineligible');
    if (verdict.kind !== 'ineligible') throw new Error('unreachable');
    expect(verdict.reasons.map((r) => r.id)).toEqual(['field']);
  });

  it('never lets a value that names no field exclude the entire user base', () => {
    // Two live records read fields:["None"] — an extractor defect, owned upstream.
    // Whatever it means, it cannot mean "nobody may apply".
    for (const applicant of ['electrical engineering', 'music performance', 'nursing']) {
      expect(status(fos(['None']), applicant)).toBe('pass');
      expect(status(fos(['No requirements']), applicant)).toBe('pass');
      expect(status(fos(['All']), applicant)).toBe('pass');
      // Degree-level and institution prose that leaked into `fields` (Mary Lou
      // Brown, CARA Merit, Yankee Clipper) says nothing about a field either.
      expect(status(fos(["Bachelor's degree", 'higher']), applicant)).toBe('pass');
      expect(status(fos(['An accredited 2-', '4-year college', 'university', 'trade school']), applicant)).toBe('pass');
      expect(status(fos(['2', '4-year program']), applicant)).toBe('pass');
    }
  });

  it('only asks for the applicant field when the answer could change the outcome', () => {
    expect(evaluateConstraint(fos(['Engineering']), makeStudent(), NOW)).toEqual({
      status: 'unknown',
      missing: ['fieldOfStudy'],
    });
    // Nothing to decide: do not make an undeclared high-school senior answer.
    expect(status(fos(['None']))).toBe('pass');
    expect(status(fos(["Bachelor's degree", 'higher']))).toBe('pass');
    // A WIDENED LIST IS STILL A LIST, so the question is worth asking: naming one of the fields
    // the funder actually wrote is a pass on the funder's own words. This used to be a `pass` for
    // an applicant who had said nothing at all — an eligibility asserted over two blanks.
    expect(
      evaluateConstraint(fos(['Electronics', 'communications', 'related fields']), makeStudent(), NOW),
    ).toEqual({ status: 'unknown', missing: ['fieldOfStudy'] });
    // An answer that normalizes to nothing is no answer, not a field that matches nothing.
    expect(status(fos(['Engineering']), '—')).toBe('unknown');
  });

  it('excludes strictly, where inclusion is generous', () => {
    // Real catalogue entry: "Any, except for Liberal Arts".
    expect(status(fos(['Any'], ['Liberal Arts']), 'liberal  arts')).toBe('fail');
    expect(status(fos(['Any'], ['Liberal Arts']), 'Electrical Engineering')).toBe('pass');
    expect(status(fos(['Any'], ['Medicine']), 'Sports Medicine')).toBe('fail');
    // A single shared word includes, but must never exclude: "medical physics"
    // is not "medicine", and an arts student is not a liberal-arts student here.
    expect(status(fos(['Any'], ['Medicine']), 'Medical Physics')).toBe('pass');
    expect(status(fos(['Any'], ['Liberal Arts']), 'Studio Arts')).toBe('pass');
  });
});

/**
 * REMEDIATION 2026-08-03 — a funder who says their list is not exhaustive is taken at their word.
 *
 * `RELATEDNESS_WORDS` widens a field list for exactly one idiom, "or a related field", and only
 * because that idiom survives extraction as a member of `fields[]`. A funder who instead
 * QUALIFIES the whole list — "including but not limited to", "such as" — leaves nothing in
 * `fields[]` to notice, because the qualifier is not a field. The extractor was right not to
 * synthesise one (that is the fabricated-field defect a sibling fix removed 26 instances of), so
 * the signal is read where the funder actually wrote it: `Constraint.rawText`, threaded into the
 * axis by `matchProgram`. No `ConstraintSpec` change, and therefore no CONTRACT §3 amendment.
 *
 * The reported case, from the close-out review: MARCO and John C. York both list healing-arts
 * professions and both mark the list open, and both hard-excluded seven majors their own sentence
 * invites. ARRL's text for MARCO asks applicants to "show a desire to encourage others in the
 * healing arts to become licensed hams" — the award exists to bring exactly these students into
 * amateur radio, and the product was telling them the door was shut.
 *
 * The constraints below are VERBATIM: `extractFieldOfStudy` produces them, ids and all, from the
 * committed `fixtures/arrl-scholarship-descriptions` payload.
 */
describe('field_of_study — funders who say their list is not exhaustive', () => {
  // "…including, but not necessarily leading to Medicine, Dentistry, …"
  const MARCO_RAW =
    'Field of study must be leading to a career in the healing arts, including, but not ' +
    'necessarily leading to Medicine, Dentistry, Veterinary Medicine, Nursing, Pharmacy, EMT, ' +
    'or Radiology technician. Preference will be given to undergraduate students and those in ' +
    'certificate programs, but graduate students may apply.';
  // "…including but not limited to a career in Medicine, Nursing, …"
  const YORK_RAW =
    'Applicant must be pursuing a field of study leading to a career in the healing arts, ' +
    'including but not limited to a career in Medicine, Nursing, Dentistry, Pharmacy, EMT, or ' +
    'Radiology';

  const marco = makeProgram({
    id: 'arrl-marco',
    name: 'The Medical Amateur Radio Council (MARCO) Scholarship',
    constraints: [
      {
        id: 'field_of_study-0-f5b447bf',
        hard: true,
        fallbackRank: 0,
        rawText: MARCO_RAW,
        spec: {
          axis: 'field_of_study',
          fields: [
            'healing arts',
            'Medicine',
            'Dentistry',
            'Veterinary Medicine',
            'Nursing',
            'Pharmacy',
            'EMT',
            'Radiology technician',
          ],
          excludedFields: [],
        },
      },
    ],
  });

  const york = makeProgram({
    id: 'arrl-john-c-york',
    name: 'The John C. York, KE5V, Scholarship',
    constraints: [
      {
        id: 'field_of_study-0-6208f483',
        hard: true,
        fallbackRank: 0,
        rawText: YORK_RAW,
        spec: {
          axis: 'field_of_study',
          fields: [
            'healing arts',
            'Medicine',
            'Nursing',
            'Dentistry',
            'Pharmacy',
            'EMT',
            'Radiology',
          ],
          excludedFields: [],
        },
      },
    ],
  });

  /**
   * The seven the close-out review named. Every one of them is a healing-arts major, none of them
   * is on either funder's list, and all seven computed `ineligible` for both awards before this
   * rule existed.
   */
  const THE_SEVEN = [
    'Biomedical Engineering',
    'Physical Therapy',
    'Public Health',
    'Respiratory Therapy',
    'Physician Assistant Studies',
    'Occupational Therapy',
    'Biology (pre-med)',
  ];

  /**
   * WHAT AN OPENED LIST BUYS THE SEVEN, AND WHAT IT DOES NOT.
   *
   * All seven were a hard `ineligible` before the widening existed, under a sentence that invites
   * them in so many words. That is over and stays over — none of them is refused here.
   *
   * For one round they were `eligible` instead, and this test asserted it. That was the widening
   * answering the applicant's question for them: `matcher.ts` matches by stemmed word overlap and
   * has no taxonomy, so it did not decide that Respiratory Therapy is one of the healing arts — it
   * decided nothing and printed a yes. The proof is the pair of assertions below: the SAME rule
   * that made Respiratory Therapy `eligible` made a Music Performance graduate student `eligible`
   * for a healing-arts award, and eight records in the corpus did it (MARCO, York, Kupferschmid,
   * Magnolia, Lawson, Indianapolis, McDaniel, FRC).
   *
   * `unknown` is what both of them get now, and it is not a fudge: the record itself says so.
   * `fieldOfStudy.ts` mints `orUnrepresented` for MARCO's own list, which is the schema's way of
   * saying "the funder named a route this cannot check". The applicant reads the funder's sentence
   * — which every read surface renders verbatim — and decides for themselves.
   */
  it('MARCO stops refusing the seven, and stops admitting them on our say-so', () => {
    expect(MARCO_RAW).toContain('including, but not necessarily leading to');
    for (const fieldOfStudy of THE_SEVEN) {
      expect([fieldOfStudy, matchProgram(makeStudent({ fieldOfStudy }), marco, NOW)]).toEqual([
        fieldOfStudy,
        { kind: 'unknown', missingProfileFields: [] },
      ]);
    }
  });

  it('York does the same, with the other phrasing of the same qualifier', () => {
    expect(YORK_RAW).toContain('including but not limited to');
    for (const fieldOfStudy of THE_SEVEN) {
      expect([fieldOfStudy, matchProgram(makeStudent({ fieldOfStudy }), york, NOW)]).toEqual([
        fieldOfStudy,
        { kind: 'unknown', missingProfileFields: [] },
      ]);
    }
  });

  /**
   * THE MEASURED COST OF THE ROUND THAT READ THE WIDENING AS A PASS. A healing-arts award, an
   * opened list, and two applicants with nothing to do with healing arts — both `eligible` until
   * this rule changed, one of them the profile the corpus profiler ships as `grad-nontechnical`.
   */
  it('and never admits the applicant nothing in the sentence points at', () => {
    for (const program of [marco, york]) {
      for (const fieldOfStudy of ['Music Performance', 'Basket Weaving', 'Electrical Engineering']) {
        expect([program.id, fieldOfStudy, matchProgram(makeStudent({ fieldOfStudy }), program, NOW)]).toEqual([
          program.id,
          fieldOfStudy,
          { kind: 'unknown', missingProfileFields: [] },
        ]);
      }
    }
  });

  it('still admits the fields both funders actually named, and the governing one', () => {
    for (const program of [marco, york]) {
      for (const fieldOfStudy of ['Healing Arts', 'Nursing', 'Pharmacy', 'EMT']) {
        expect(matchProgram(makeStudent({ fieldOfStudy }), program, NOW)).toEqual({
          kind: 'eligible',
        });
      }
    }
  });

  /**
   * AND THE QUESTION IS STILL ASKED — the sentence `ham_activity` already carried, now true of
   * both axes that read an opened list.
   *
   * While the widening was a `pass`, no reply could change anything, so this asserted that the
   * undeclared applicant was not asked. Now naming one of the fields the funder DID write is a
   * pass on the funder's own words, so the answer is worth having, and the prompt is the honest
   * fillable one rather than an eligibility asserted over a blank.
   */
  it('asks the undeclared applicant, because a listed field is still a pass', () => {
    for (const program of [marco, york]) {
      expect(matchProgram(makeStudent(), program, NOW)).toEqual({
        kind: 'unknown',
        missingProfileFields: ['fieldOfStudy'],
      });
    }
  });

  /**
   * THE TRUE NEGATIVE. This rule fires on the funder's own words and on nothing else. A closed
   * list stays closed, whatever else its sentence says — otherwise the fix is not "honour the
   * open list", it is "delete the field axis".
   */
  it('leaves a genuinely closed list closed', () => {
    // Wayne Nelson, KB4UT — real corpus value, no qualifier anywhere in it.
    const engineeringOnly = makeProgram({
      id: 'engineering-only',
      constraints: [
        makeConstraint(
          { axis: 'field_of_study', fields: ['Engineering'], excludedFields: [] },
          { id: 'closed-field', rawText: 'Engineering' },
        ),
      ],
    });
    const verdict = matchProgram(
      makeStudent({ fieldOfStudy: 'Music Performance' }),
      engineeringOnly,
      NOW,
    );
    expect(verdict).toEqual({ kind: 'ineligible', reasons: [expect.objectContaining({ id: 'closed-field' })] });

    // ...and the same, for every closed real-corpus sentence that a music major fails.
    const closed: Array<[string[], string]> = [
      [['Science', 'technology', 'engineering', 'mathematics'], 'Science, technology, engineering, or mathematics'],
      [['Electrical', 'Communications Engineering'], 'Electrical or Communications Engineering'],
      [['Horticulture', 'environmental sciences'], 'Horticulture and/or environmental sciences'],
      [['Engineering', 'Medicine', 'Science', 'Business'], 'Engineering, Medicine, Science or Business'],
      [['Mathematics', 'data science'], 'Mathematics or data science'],
      [['International studies'], 'International studies'],
    ];
    for (const [fields, rawText] of closed) {
      expect([
        rawText,
        evaluateConstraint(
          { axis: 'field_of_study', fields, excludedFields: [] },
          makeStudent({ fieldOfStudy: 'Music Performance' }),
          NOW,
          rawText,
        ).status,
      ]).toEqual([rawText, 'fail']);
    }
  });

  /**
   * Volunteers do not write to a schema. A sibling axis had to read "25 years of age and/or
   * younger" and "five (5) members"; this one has to read every ordinary way of saying "these are
   * examples". Punctuation cannot hide any of them — the text is normalized before matching, so
   * "including, but not necessarily" and "e.g." flatten to the same tokens as their tidy forms.
   */
  it('reads the phrasings volunteers actually write', () => {
    const open = [
      'Engineering fields, including but not limited to electronics and physics',
      'Engineering fields, including, but not necessarily limited to, electronics',
      'Engineering fields including without limitation electronics',
      'Fields such as engineering, physics and computer science',
      'Any technical field, for example engineering or physics',
      'Technical fields, e.g. engineering, physics',
      'Engineering, physics, and related fields',
      'Engineering, physics or a related technical field',
      'Engineering and physics, among others',
      'Engineering, physics, etc.',
      'This list of eligible majors is not exhaustive: engineering, physics',
    ];
    const spec: ConstraintSpec = { axis: 'field_of_study', fields: ['Engineering', 'physics'], excludedFields: [] };
    const against = (fieldOfStudy: string, rawText: string): string =>
      evaluateConstraint(spec, makeStudent({ fieldOfStudy }), NOW, rawText).status;
    for (const rawText of open) {
      // Each marker is recognised: the closed list would REFUSE a music major, and none of these
      // does. (Was `pass` for one round — see the MARCO/York block above for why it is not.)
      expect([rawText, against('Music Performance', rawText)]).toEqual([rawText, 'unknown']);
      // ...and recognising the marker never costs the applicant the funder DID name.
      expect([rawText, against('physics', rawText)]).toEqual([rawText, 'pass']);
    }
    // The control: the same list, the same applicant, no marker in the sentence.
    expect(against('Music Performance', 'Engineering and physics')).toBe('fail');
  });

  /**
   * The other half of the same judgement, and the reason this is a narrow rule rather than a
   * blanket one. Each of these is a real corpus sentence whose verdict must not move.
   *
   * READ WHAT THIS ASSERTS AND WHAT IT DOES NOT — the distinction cost an award. Every tuple here
   * is a BARE TIER, with no `orUnrepresented`, and the claim is about `matcher.ts`'s widening rule
   * alone: these sentences do not open their lists, so a music major does not walk into them. That
   * is still exactly right.
   *
   * It is NOT a claim that the corpus record refuses anybody, and until round six's verification
   * pass the first tuple was silently doing duty as one. The Chick Allen record really did publish
   * this bare tier, and it hard-refused Physics, Chemistry, Biology and Astronomy under a sentence
   * reading "or similar scientific field". Not being a widening and being a bar are different
   * things, and the third answer — `unknown` — is the one the record now gives (see the block below
   * this `it`, and `server/src/normalize/axes/spec-vs-sentence.test.ts` R7).
   */
  it('does not mistake a bounded qualifier for an open list', () => {
    const stillClosed: Array<[string[], string]> = [
      // Chuck Bierman, K7ZJ — "similar SCIENTIFIC field" names a bound; only a bare relatedness
      // word ("or a related field", "or a related technical field") is a blanket widening.
      [
        ['Electronics', 'Electrical Engineering', 'Aerospace Engineering', 'Computer Science', 'similar scientific field'],
        'Electronics, Electrical Engineering, Aerospace Engineering, Computer Science or similar scientific field',
      ],
      // NEAR-Fest — "or OTHER 4-year technical degree" is still a technical requirement. Only the
      // plural "and/or/among others" opens a list.
      [
        ['Engineering', 'other 4-year technical degree'],
        'Engineering or other 4-year technical degree',
      ],
      // Bare "including" introduces examples OF the list, not an invitation past it.
      [['Engineering'], 'Engineering degrees, including electrical and computer'],
      // "Technology-related field" / "a Health Care-related field" NAME a field (see the
      // free-text corpus block above); the rawText rule must not undo that.
      [
        ['Business', 'Science', 'Math', 'Engineering', 'Technology-related field'],
        'Business, Science, Math, Engineering or Technology-related field.',
      ],
    ];
    for (const [fields, rawText] of stillClosed) {
      expect([
        rawText,
        evaluateConstraint(
          { axis: 'field_of_study', fields, excludedFields: [] },
          makeStudent({ fieldOfStudy: 'Music Performance' }),
          NOW,
          rawText,
        ).status,
      ]).toEqual([rawText, 'fail']);
    }
  });

  /**
   * AND THE THIRD ANSWER, WHICH IS WHAT THE CORPUS ACTUALLY PUBLISHES FOR THE FIRST OF THOSE FOUR.
   *
   * "or similar scientific field" is not a widening — the assertion above is unchanged and must
   * stay — but it is also not something word overlap can adjudicate: an applicant is admitted by it
   * only if they write "similar", "scientific" or "field" in their own major. `fieldOfStudy.ts`
   * therefore mints `orUnrepresented` for it, and `evaluateConstraint`'s contract is that the field
   * can only ever turn a `fail` into an `unknown`. Both directions are asserted here, because a
   * remedy that fixed the physics student by admitting the music student would be the same defect
   * pointed the other way.
   */
  it('answers a bound it cannot adjudicate with unknown — never a pass, never a refusal', () => {
    const rawText =
      'Electronics, Electrical Engineering, Aerospace Engineering, Computer Science or similar scientific field';
    const spec: ConstraintSpec = {
      axis: 'field_of_study',
      fields: ['Electronics', 'Electrical Engineering', 'Aerospace Engineering', 'Computer Science', 'similar scientific field'],
      excludedFields: [],
      orUnrepresented: 'similar scientific field',
    };
    const statusFor = (fieldOfStudy: string): string =>
      evaluateConstraint(spec, makeStudent({ fieldOfStudy }), NOW, rawText).status;
    // The applicant the funder's sentence invites, and the bare tier refused.
    expect(statusFor('Physics')).toBe('unknown');
    expect(statusFor('Astronomy')).toBe('unknown');
    // The applicant the funder's sentence does not invite is STILL not admitted...
    expect(statusFor('Music Performance')).toBe('unknown');
    // ...and nothing about the route the funder named first has moved.
    expect(statusFor('Electronics')).toBe('pass');
    expect(statusFor('Computer Science')).toBe('pass');
    // `unknown` with nothing to fill in: there is no answer the reader could type that decides
    // whether Physics is a field similar to Aerospace Engineering.
    expect(evaluateConstraint(spec, makeStudent({ fieldOfStudy: 'Physics' }), NOW, rawText)).toEqual({
      status: 'unknown',
      missing: [],
    });
  });

  /**
   * An open list is an invitation, never an override. Exclusion is the strict direction of this
   * axis, and examples of what is BARRED are not examples of what is eligible.
   */
  it('never lets an open list defeat the funder\'s own exclusion', () => {
    const status = (fieldOfStudy: string, rawText: string): string =>
      evaluateConstraint(
        { axis: 'field_of_study', fields: ['Any'], excludedFields: ['Liberal Arts'] },
        makeStudent({ fieldOfStudy }),
        NOW,
        rawText,
      ).status;
    // Real corpus value (Six Meter Club of Chicago): "Any, except for Liberal Arts".
    expect(status('liberal  arts', 'Any, except for Liberal Arts')).toBe('fail');
    // ...and the marker sitting inside the exclusion half describes the BAR, not the invitation.
    expect(status('liberal  arts', 'Any field, except for Liberal Arts such as history or music')).toBe('fail');
    expect(status('Electrical Engineering', 'Any field, except for Liberal Arts such as history or music')).toBe('pass');
  });

  /**
   * NON-REGRESSION: the "or a related field" widening reads `fields[]` rather than `rawText`, and
   * must keep working with no rawText at all — every existing three-argument call to
   * `evaluateConstraint` still means exactly what it did, INCLUDING the two ways it can mean
   * something. The two idioms — a widening member of `fields[]`, and a qualifier in the funder's
   * sentence — reach the same answer, which is the point of reading both.
   */
  it('reaches the same answer whichever way the funder opened the list', () => {
    const relatedness = (fields: string[], fieldOfStudy: string, rawText?: string): string =>
      evaluateConstraint(
        { axis: 'field_of_study', fields, excludedFields: [] },
        makeStudent({ fieldOfStudy }),
        NOW,
        rawText,
      ).status;
    // No rawText argument at all — the old three-argument call.
    expect(relatedness(['Electronics', 'communications', 'related fields'], 'physics')).toBe('unknown');
    expect(relatedness(['engineering', 'or a related technical field'], 'industrial design')).toBe('unknown');
    expect(relatedness(['engineering', 'sciences', 'similar field'], 'industrial design')).toBe('unknown');
    expect(relatedness(['Electronics', 'communications'], 'industrial design')).toBe('fail');
    // ...and with the funder's real sentence supplied, the verdicts are unchanged.
    expect(
      relatedness(
        ['Electronics', 'communications', 'related fields'],
        'physics',
        'Electronics, communications, or related fields',
      ),
    ).toBe('unknown');
    expect(relatedness(['Electronics', 'communications'], 'industrial design', 'Electronics, communications')).toBe('fail');
    // Both idioms still leave the funder's own list intact.
    expect(relatedness(['Electronics', 'communications', 'related fields'], 'electronics')).toBe('pass');
  });

  /**
   * Kupferschmid is the third and last constraint in the committed corpus that carries an
   * open-list marker, and unlike MARCO and York its named fields already covered its own
   * audience — so this asserts the widening is real rather than incidental.
   */
  it('honours Kupferschmid\'s "including but not limited to" as well', () => {
    const spec: ConstraintSpec = {
      axis: 'field_of_study',
      fields: [
        'Applied sciences', 'technology', 'engineering', 'mathematics', 'astronomy',
        'communications', 'computers', 'electronics', 'physics',
      ],
      excludedFields: [],
    };
    const raw =
      'Applied sciences, technology, engineering, and\nmathematics, including but not limited ' +
      'to astronomy, communications,\ncomputers, electronics, and physics.';
    const against = (fieldOfStudy: string): string =>
      evaluateConstraint(spec, makeStudent({ fieldOfStudy }), NOW, raw).status;
    // The marker is read: this nine-item list, closed, would refuse a music major outright.
    expect(evaluateConstraint(spec, makeStudent({ fieldOfStudy: 'Music Performance' }), NOW, '').status).toBe('fail');
    expect(against('Music Performance')).toBe('unknown');
    // ...and the nine fields the funder wrote are still nine passes, not nine questions.
    expect(against('Astronomy')).toBe('pass');
    expect(against('Electronics')).toBe('pass');
  });
});

/**
 * REMEDIATION 2026-08-03 — the stage taxonomy is not a partition.
 *
 * `Stage` mixes two different kinds of fact. `HS_SENIOR`/`UNDERGRAD`/`GRAD` name an academic
 * LEVEL and are broadly exclusive; `VETERAN` and `RETRAINING_ADULT` name a STATUS a person
 * carries WHILE enrolled at one of those levels. A profile has room for exactly one `stage`, so
 * an applicant who is both — the 41-year-old on the GI Bill, the parent back at community
 * college — has to give up the level to state the status, and a set-membership test then reads
 * that as "not an undergraduate".
 *
 * Reported case: The Frankford Radio Club (FRC) Scholarship, whose clause hardens correctly to
 * [HS_SENIOR, UNDERGRAD, VETERAN] from the funder's own "open to graduating high school seniors,
 * undergraduate students and US miltary veterans". A returning adult studying part-time for an
 * AAS — who IS an undergraduate — was hard-excluded from an undergraduate award. Eleven awards in
 * the committed corpus excluded the `adult-parttime` profile on this axis.
 *
 * The fix is subsumption, not a special case: a status stage also satisfies whatever LEVEL the
 * applicant's `degreeLevel` states. It deliberately does not run the other way — an undergraduate
 * is not thereby a veteran — and deliberately does not promote `HS_SENIOR` to `UNDERGRAD`.
 */
describe('age_stage — stages that overlap in reality', () => {
  const stages = (values: Stage[]): ConstraintSpec => ({ axis: 'age_stage', stages: values });
  const status = (spec: ConstraintSpec, profile: Partial<StudentProfile>): string =>
    evaluateConstraint(spec, makeStudent(profile), NOW).status;
  const enrolled = (stage: Stage, degreeLevel?: DegreeLevel): Partial<StudentProfile> => ({
    stage,
    degreeLevel,
  });

  // Verbatim from the committed ARRL scholarship-descriptions fixture, funder's own typo included.
  const frankford = makeProgram({
    id: 'frankford-rc',
    name: 'The Frankford Radio Club (FRC) Scholarship',
    constraints: [
      makeConstraint(stages(['HS_SENIOR', 'UNDERGRAD', 'VETERAN']), {
        id: 'stage',
        hard: true,
        rawText:
          'The scholarship is open to graduating high school seniors, undergraduate students and US miltary veterans',
      }),
    ],
  });

  it('matches a 41-year-old part-time AAS student against the Frankford RC award', () => {
    // The `adult-parttime` profile from scripts/profile-corpus.ts, exactly.
    const adultLearner = makeStudent({
      stage: 'RETRAINING_ADULT',
      degreeLevel: 'ASSOC',
      partTime: true,
      birthDate: '1985-07-09T00:00:00.000Z',
      fieldOfStudy: 'Electronics Technology',
    });
    expect(matchProgram(adultLearner, frankford, NOW)).toEqual({ kind: 'eligible' });
  });

  it('still excludes a high-school senior from a graduate-only award', () => {
    const gradOnly = makeProgram({
      id: 'grad-only',
      constraints: [makeConstraint(stages(['GRAD']), { id: 'stage', hard: true })],
    });
    const hsSenior = makeStudent({
      stage: 'HS_SENIOR',
      degreeLevel: 'BACH',
      birthDate: '2009-01-15T00:00:00.000Z',
    });
    const verdict = matchProgram(hsSenior, gradOnly, NOW);
    expect(verdict.kind).toBe('ineligible');
    if (verdict.kind !== 'ineligible') throw new Error('unreachable');
    expect(verdict.reasons.map((r) => r.id)).toEqual(['stage']);
  });

  it('reads a status stage at the level the applicant says they are enrolled at', () => {
    // A returning adult in an associate or bachelor's program IS an undergraduate...
    expect(status(stages(['UNDERGRAD']), enrolled('RETRAINING_ADULT', 'ASSOC'))).toBe('pass');
    expect(status(stages(['UNDERGRAD']), enrolled('RETRAINING_ADULT', 'BACH'))).toBe('pass');
    expect(status(stages(['UNDERGRAD']), enrolled('RETRAINING_ADULT', 'CERT'))).toBe('pass');
    // ...and one in a master's is a graduate student, and not an undergraduate.
    expect(status(stages(['GRAD']), enrolled('RETRAINING_ADULT', 'GRAD'))).toBe('pass');
    expect(status(stages(['UNDERGRAD']), enrolled('RETRAINING_ADULT', 'GRAD'))).toBe('fail');
    // A veteran is the same shape of fact: a status carried while enrolled somewhere.
    expect(status(stages(['UNDERGRAD']), enrolled('VETERAN', 'BACH'))).toBe('pass');
    expect(status(stages(['GRAD']), enrolled('VETERAN', 'GRAD'))).toBe('pass');
    expect(status(stages(['UNDERGRAD']), enrolled('VETERAN', 'GRAD'))).toBe('fail');
    // The status itself still matches the award written for it.
    expect(status(stages(['VETERAN']), enrolled('VETERAN', 'GRAD'))).toBe('pass');
    expect(status(stages(['RETRAINING_ADULT']), enrolled('RETRAINING_ADULT', 'GRAD'))).toBe('pass');
  });

  it('includes a status stage at either level when the applicant has not said which', () => {
    // No degreeLevel to refine with. They are enrolled SOMEWHERE, and hiding the award is the
    // unrecoverable error, so both levels are allowed; the funder's own wording is rendered.
    expect(status(stages(['UNDERGRAD']), enrolled('RETRAINING_ADULT'))).toBe('pass');
    expect(status(stages(['GRAD']), enrolled('RETRAINING_ADULT'))).toBe('pass');
    expect(status(stages(['UNDERGRAD']), enrolled('VETERAN'))).toBe('pass');
    expect(status(stages(['GRAD']), enrolled('VETERAN'))).toBe('pass');
    // But an adult returner is still not a graduating high-school senior.
    expect(status(stages(['HS_SENIOR']), enrolled('RETRAINING_ADULT'))).toBe('fail');
    expect(status(stages(['HS_SENIOR']), enrolled('RETRAINING_ADULT', 'ASSOC'))).toBe('fail');
    expect(status(stages(['HS_SENIOR']), enrolled('VETERAN', 'BACH'))).toBe('fail');
  });

  it('does not run subsumption backwards: a level never implies a status', () => {
    // Nothing in the profile says this undergraduate served, or is returning to school. An award
    // written FOR veterans is not one we may claim on their behalf.
    expect(status(stages(['VETERAN']), enrolled('UNDERGRAD', 'BACH'))).toBe('fail');
    expect(status(stages(['RETRAINING_ADULT']), enrolled('UNDERGRAD', 'BACH'))).toBe('fail');
    expect(status(stages(['VETERAN']), enrolled('GRAD', 'GRAD'))).toBe('fail');
    expect(status(stages(['RETRAINING_ADULT']), enrolled('HS_SENIOR'))).toBe('fail');
  });

  it('does not promote a high-school senior to undergraduate, or a grad to undergrad', () => {
    // Deliberate non-subsumption. "Undergraduate students" reads as currently enrolled, and a
    // graduating senior is an incoming one; the corpus has awards for each written separately
    // (11 individual-facing awards name HS_SENIOR alone). This is also the `hs-unlicensed`
    // regression canary in scripts/profile-corpus.ts: it must not gain awards from this change.
    expect(status(stages(['UNDERGRAD']), enrolled('HS_SENIOR', 'BACH'))).toBe('fail');
    expect(status(stages(['GRAD']), enrolled('HS_SENIOR', 'BACH'))).toBe('fail');
    expect(status(stages(['UNDERGRAD']), enrolled('GRAD', 'GRAD'))).toBe('fail');
    expect(status(stages(['HS_SENIOR']), enrolled('UNDERGRAD', 'BACH'))).toBe('fail');
  });

  it('leaves the age half of the axis alone', () => {
    const youngOnly: ConstraintSpec = {
      axis: 'age_stage',
      stages: ['UNDERGRAD'],
      ageMax: 25,
    };
    // The stage now passes by subsumption, but 41 is still over the funder's ceiling.
    expect(
      status(youngOnly, {
        stage: 'RETRAINING_ADULT',
        degreeLevel: 'ASSOC',
        birthDate: '1985-07-09T00:00:00.000Z',
      }),
    ).toBe('fail');
    expect(
      status(youngOnly, {
        stage: 'RETRAINING_ADULT',
        degreeLevel: 'ASSOC',
        birthDate: '2006-03-01T00:00:00.000Z',
      }),
    ).toBe('pass');
  });

  it('still asks for the stage when the profile has none', () => {
    expect(evaluateConstraint(stages(['UNDERGRAD']), makeStudent(), NOW)).toEqual({
      status: 'unknown',
      missing: ['stage'],
    });
  });
});

/**
 * THE PREDICATE ITSELF, AXIS BY AXIS — pinned exhaustively, because it decides whether an applicant
 * is credited with meeting a preference, and a thirteenth axis added to CONTRACT §3 without a
 * ruling here would silently pick one.
 *
 * Each pair is the SAME axis twice: the shape an extractor writes when the funder stated nothing
 * (which `evaluateTier` passes vacuously), and the shape it writes when the funder stated the
 * smallest real requirement on that axis.
 */
describe('statesARequirement — what counts as the funder having asked for something', () => {
  const empty: ConstraintTier[] = [
    { axis: 'license', licenseMin: 'NONE' },
    { axis: 'geography', geo: { type: 'any', values: [] } },
    { axis: 'field_of_study', fields: [], excludedFields: [] },
    { axis: 'institution', degreeLevels: [], tradeSchoolOK: false, partTimeOK: true, accreditationRequired: false },
    { axis: 'gpa' },
    { axis: 'arrl_membership', required: false, minYears: 0 },
    { axis: 'recommendation', recommenderType: 'none', count: 0 },
    { axis: 'citizenship', allowed: ['ANY'] },
    { axis: 'age_stage', stages: [] },
    { axis: 'ham_activity', activityKinds: [], proofRequired: false },
    { axis: 'gender', allowed: ['any'] },
    { axis: 'other', note: '   ' },
  ];
  const stated: ConstraintTier[] = [
    { axis: 'license', licenseMin: 'TECH' },
    { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
    { axis: 'field_of_study', fields: [], excludedFields: ['Liberal Arts'] },
    { axis: 'institution', degreeLevels: [], tradeSchoolOK: false, partTimeOK: false, accreditationRequired: false },
    { axis: 'gpa', classRankTopPct: 10 },
    { axis: 'arrl_membership', required: true, minYears: 0 },
    { axis: 'recommendation', recommenderType: 'teacher', count: 0 },
    { axis: 'citizenship', allowed: ['US_CITIZEN'] },
    { axis: 'age_stage', ageMax: 25, stages: [] },
    { axis: 'ham_activity', activityKinds: [], proofRequired: true },
    { axis: 'gender', allowed: ['female'] },
    { axis: 'other', note: 'Student must be full time' },
    // Weighted need is a preference somebody really meets: `evaluateTier` passes only an applicant
    // who stated they have it, so it belongs on this side and has no vacuous shape.
    { axis: 'financial_need', weighted: true },
  ];

  it('says no to every axis a funder left blank', () => {
    for (const spec of empty) expect([spec.axis, statesARequirement(spec)]).toEqual([spec.axis, false]);
  });

  it('says yes to the smallest real requirement on every axis', () => {
    for (const spec of stated) expect([spec.axis, statesARequirement(spec)]).toEqual([spec.axis, true]);
  });

  it('covers all thirteen axes, so a fourteenth cannot arrive unclassified', () => {
    const covered = new Set([...empty, ...stated].map((s) => s.axis));
    expect([...covered].sort()).toEqual([
      'age_stage', 'arrl_membership', 'citizenship', 'field_of_study', 'financial_need', 'gender',
      'gpa', 'ham_activity', 'institution', 'license', 'other', 'recommendation',
    ].concat('geography').sort());
    expect(covered.size).toBe(13);
  });
});

describe('matchAll', () => {
  it('keys verdicts by program id and preserves input order', () => {
    const open = makeProgram({
      id: 'open',
      // The funder ANSWERED "anywhere" — an empty constraint list would be the record saying
      // nothing, which is an `unknown` (see the baseline block).
      constraints: [
        makeConstraint({ axis: 'geography', geo: { type: 'any', values: [] } }, { id: 'any', rawText: 'Any' }),
      ],
    });
    const texanOnly = makeProgram({
      id: 'texan',
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'state', values: ['TX'] } },
          { id: 'tx', hard: true },
        ),
      ],
    });
    const results = matchAll(makeStudent({ state: 'OH' }), [open, texanOnly], NOW);
    expect([...results.keys()]).toEqual(['open', 'texan']);
    expect(results.get('open')).toEqual({ kind: 'eligible' });
    expect(results.get('texan')?.kind).toBe('ineligible');
  });
});
