import { describe, expect, it } from 'vitest';
// The dev tool this remediation's numbers come from. See the describe block at the foot of this
// file for why its test lives here rather than beside it.
import { isDoNotPublish, loadCorpus } from '../../../scripts/profile-corpus.js';
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
 * REMEDIATION 2026-08-03 — the measuring tool measured the wrong population.
 *
 * `scripts/profile-corpus.ts` is the tool every matcher fix in this remediation has been judged
 * with. It built its corpus from `normalizeRaw` and kept EVERY record, including the ones the
 * review queue suppresses — past awards and cross-check rows, which are stored on purpose as
 * evidence of who a funder funds but are never shown as opportunities. As real fixtures landed
 * its corpus grew to 742, of which 545 were suppressed records. Numbers taken over a population
 * that no user can ever see are worse than no numbers at all.
 *
 * WHY THIS TEST IS IN A CORE TEST FILE. The profiler lives at the repo root because it reaches
 * into both packages, and no vitest project covers `scripts/` (the workspace is `packages/*`), so
 * a test file next to it would never run. `packages/server/src/crawl/verifySources.test.ts`
 * already reaches out to `scripts/` for the same reason. Core's purity rule binds
 * `packages/core/src`, not its tests (see purity.test.ts's own note).
 */
describe('scripts/profile-corpus — the corpus is what the product would show', () => {
  it('excludes every do_not_publish record, and reports how many it excluded', async () => {
    const { programs, loaded, suppressed } = await loadCorpus();

    // The whole point: not one suppressed record survives into the measured corpus.
    expect(programs.filter((p) => isDoNotPublish(p))).toEqual([]);

    // Real counts, from the committed fixtures. 742 records normalize; 545 of them are
    // suppressed (544 `past_award` + the 1 `crosscheck` row), leaving 197 the product would
    // actually show. These move when fixtures land — update them, do not soften them, and
    // check WHICH source moved: `loaded` carries the split per source.
    expect(suppressed).toBe(545);
    expect(programs).toHaveLength(197);
    expect(programs.length + suppressed).toBe(742);

    // The canonical case from the do_not_publish fix: the ARRL club-grant page yields the ONE
    // real ARRL Club Grant Program plus 37 clubs that have already RECEIVED money.
    expect(loaded.find((e) => e.sourceId === 'arrl-club-grant')).toEqual({
      sourceId: 'arrl-club-grant',
      programs: 1,
      suppressed: 37,
    });
    // ...and the three sources that are ENTIRELY past awards contribute nothing to show.
    for (const sourceId of ['ardc-award-tables', 'nsf-awards', 'usaspending']) {
      const entry = loaded.find((e) => e.sourceId === sourceId);
      expect(entry?.programs, `${sourceId} publishes nothing`).toBe(0);
      expect(entry?.suppressed, `${sourceId} is all past awards`).toBeGreaterThan(0);
    }
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
