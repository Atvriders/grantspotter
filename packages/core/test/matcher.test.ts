import { describe, expect, it } from 'vitest';
import {
  APPLICANT_ENTITY_CONSTRAINT_SUFFIX,
  evaluateConstraint,
  matchAll,
  matchProgram,
} from '../src/matcher.js';
import type { ConstraintSpec, DegreeLevel, Stage, StudentProfile } from '../src/types.js';
import { makeConstraint, makeOrg, makeProgram, makeStudent } from './fixtures.js';

const NOW = '2027-03-01T00:00:00.000Z';

describe('matchProgram — baseline', () => {
  it('is eligible when a program has no constraints', () => {
    expect(matchProgram(makeStudent(), makeProgram(), NOW)).toEqual({ kind: 'eligible' });
  });

  it('works without an explicit clock', () => {
    expect(matchProgram(makeStudent(), makeProgram()).kind).toBe('eligible');
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
    expect(verdict.reasons[0].rawText).toContain('nominated_by_institution');
  });

  it('refuses a 501(c)(3) club for a program that only funds via a fiscal sponsor', () => {
    // ARDC requires clubs and individuals to apply through a fiscal sponsor.
    const ardc = makeProgram({
      id: 'ardc-grants',
      applicantEntities: ['club_via_fiscal_sponsor', 'university', 'school_lea'],
    });
    expect(matchProgram(makeOrg({ entity: 'club_501c3' }), ardc, NOW).kind).toBe('ineligible');
    expect(matchProgram(makeOrg({ entity: 'university' }), ardc, NOW).kind).toBe('eligible');
  });

  it('refuses an organisation for an individuals-only scholarship', () => {
    expect(matchProgram(makeOrg(), makeProgram(), NOW).kind).toBe('ineligible');
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

  it('does not let a not-evaluable hard constraint block anyone', () => {
    const program = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 3 },
          { id: 'rec', hard: true },
        ),
        makeConstraint(
          { axis: 'other', note: 'preference to a student ham from a ham family' },
          { id: 'oth', hard: true },
        ),
      ],
    });
    expect(matchProgram(makeStudent(), program, NOW)).toEqual({ kind: 'eligible' });
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

  it('does not block an org on an unresolvable county constraint', () => {
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
      kind: 'eligible',
    });
  });

  it('does not block an org on an unresolvable call_district constraint', () => {
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
    ).toEqual({ kind: 'eligible' });
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

  it('takes the funder at their word when they say "or related field"', () => {
    // The widening is the funder's own; relatedness is not ours to adjudicate,
    // and the applicant reads their verbatim wording (Constraint.rawText) anyway.
    expect(status(fos(['Electronics', 'communications', 'related fields']), 'physics')).toBe('pass');
    expect(status(fos(['engineering', 'or a related technical field']), 'industrial design')).toBe('pass');
    expect(status(fos(['engineering', 'sciences', 'similar field']), 'industrial design')).toBe('pass');
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
    expect(status(fos(['Electronics', 'communications', 'related fields']))).toBe('pass');
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

  it('MARCO admits all seven majors its "including, but not necessarily" list invites', () => {
    expect(MARCO_RAW).toContain('including, but not necessarily leading to');
    for (const fieldOfStudy of THE_SEVEN) {
      expect([fieldOfStudy, matchProgram(makeStudent({ fieldOfStudy }), marco, NOW)]).toEqual([
        fieldOfStudy,
        { kind: 'eligible' },
      ]);
    }
  });

  it('York admits all seven majors its "including but not limited to" list invites', () => {
    expect(YORK_RAW).toContain('including but not limited to');
    for (const fieldOfStudy of THE_SEVEN) {
      expect([fieldOfStudy, matchProgram(makeStudent({ fieldOfStudy }), york, NOW)]).toEqual([
        fieldOfStudy,
        { kind: 'eligible' },
      ]);
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
   * An open list makes the question unanswerable-in-a-useful-way, not unanswered: every reply
   * passes, so demanding one would show a locked door where there is none. Same treatment the
   * "or a related field" widening has always had.
   */
  it('stops asking an undeclared applicant a question that cannot change the answer', () => {
    for (const program of [marco, york]) {
      expect(matchProgram(makeStudent(), program, NOW)).toEqual({ kind: 'eligible' });
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
    for (const rawText of open) {
      expect([
        rawText,
        evaluateConstraint(
          { axis: 'field_of_study', fields: ['Engineering', 'physics'], excludedFields: [] },
          makeStudent({ fieldOfStudy: 'Music Performance' }),
          NOW,
          rawText,
        ).status,
      ]).toEqual([rawText, 'pass']);
    }
  });

  /**
   * The other half of the same judgement, and the reason this is a narrow rule rather than a
   * blanket one. Each of these is a real corpus sentence whose verdict must not move.
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
   * NON-REGRESSION: the "or a related field" widening predates this rule, reads `fields[]` rather
   * than `rawText`, and must keep working with no rawText at all — every existing three-argument
   * call to `evaluateConstraint` still means exactly what it did.
   */
  it('leaves the existing "or a related field" widening exactly as it was', () => {
    const relatedness = (fields: string[], fieldOfStudy: string, rawText?: string): string =>
      evaluateConstraint(
        { axis: 'field_of_study', fields, excludedFields: [] },
        makeStudent({ fieldOfStudy }),
        NOW,
        rawText,
      ).status;
    // No rawText argument at all — the old three-argument call.
    expect(relatedness(['Electronics', 'communications', 'related fields'], 'physics')).toBe('pass');
    expect(relatedness(['engineering', 'or a related technical field'], 'industrial design')).toBe('pass');
    expect(relatedness(['engineering', 'sciences', 'similar field'], 'industrial design')).toBe('pass');
    expect(relatedness(['Electronics', 'communications'], 'industrial design')).toBe('fail');
    // ...and with the funder's real sentence supplied, the verdicts are unchanged.
    expect(
      relatedness(
        ['Electronics', 'communications', 'related fields'],
        'physics',
        'Electronics, communications, or related fields',
      ),
    ).toBe('pass');
    expect(relatedness(['Electronics', 'communications'], 'industrial design', 'Electronics, communications')).toBe('fail');
  });

  /**
   * Kupferschmid is the third and last constraint in the committed corpus that carries an
   * open-list marker, and unlike MARCO and York its named fields already covered its own
   * audience — so this asserts the widening is real rather than incidental.
   */
  it('honours Kupferschmid\'s "including but not limited to" as well', () => {
    const status = evaluateConstraint(
      {
        axis: 'field_of_study',
        fields: [
          'Applied sciences', 'technology', 'engineering', 'mathematics', 'astronomy',
          'communications', 'computers', 'electronics', 'physics',
        ],
        excludedFields: [],
      },
      makeStudent({ fieldOfStudy: 'Music Performance' }),
      NOW,
      'Applied sciences, technology, engineering, and\nmathematics, including but not limited ' +
        'to astronomy, communications,\ncomputers, electronics, and physics.',
    ).status;
    expect(status).toBe('pass');
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

describe('matchAll', () => {
  it('keys verdicts by program id and preserves input order', () => {
    const open = makeProgram({ id: 'open' });
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
