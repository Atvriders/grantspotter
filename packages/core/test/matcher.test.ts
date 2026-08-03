import { describe, expect, it } from 'vitest';
import {
  APPLICANT_ENTITY_CONSTRAINT_SUFFIX,
  evaluateConstraint,
  matchAll,
  matchProgram,
} from '../src/matcher.js';
import type { ConstraintSpec } from '../src/types.js';
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
