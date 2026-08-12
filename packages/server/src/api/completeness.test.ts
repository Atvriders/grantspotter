import { describe, it, expect } from 'vitest';
import { matchAll } from '@grantspotter/core';
import type {
  ApplicantEntity,
  Constraint,
  ConstraintSpec,
  OrgProfile,
  Program,
  StudentProfile,
} from '@grantspotter/core';
import { fixturePrograms } from '../test/fixtures/programs.js';
import { computeCompleteness } from './completeness.js';

const sparse: StudentProfile = { kind: 'student' };

/**
 * UNKNOWNS NO PROFILE COULD EVER RESOLVE, in the fixture corpus.
 *
 * `matchProgram` refuses to read an EMPTY constraint list as an eligibility (round eight): a record
 * that states no requirement has not said the applicant qualifies, so the verdict is `unknown` with
 * nothing to fill in — the same answer an unrecorded audience and an unmeasurable radius already
 * produce. `chicagoFmScholarship` is such a record: a discontinued programme kept as a negative
 * result, with no eligibility rules on it at all.
 *
 * The meter counts it, exactly as it already counts those other two shapes, because the score is
 * the share of the corpus that yields a real verdict and this one does not. What it must NOT do is
 * name a field for it — there is nothing the applicant could type — and that is what these tests
 * assert alongside the count, so "fully judged" keeps meaning "nothing is waiting on YOU".
 */
const UNRESOLVABLE_BY_ANY_PROFILE = 1;

const rich: StudentProfile = {
  kind: 'student',
  callsign: 'W8UM',
  licenseClass: 'GENERAL',
  licensedSince: '2023-05-01',
  state: 'MI',
  degreeLevel: 'BACH',
  institution: 'Example State University',
  accredited: true,
  partTime: false,
  citizenship: 'US_CITIZEN',
  stage: 'UNDERGRAD',
  gpa: 3.4,
};

describe('computeCompleteness', () => {
  it('counts how many programs each missing field would resolve', () => {
    const report = computeCompleteness(sparse, fixturePrograms);
    expect(report.unknownCount).toBeGreaterThan(0);
    expect(report.fields.length).toBeGreaterThan(0);
    expect(report.fields[0]!.resolves).toBeGreaterThanOrEqual(
      report.fields.at(-1)!.resolves,
    );
  });

  it('sorts fields by the number of unknown verdicts they would resolve', () => {
    const report = computeCompleteness(sparse, fixturePrograms);
    for (let i = 1; i < report.fields.length; i += 1) {
      expect(report.fields[i - 1]!.resolves).toBeGreaterThanOrEqual(report.fields[i]!.resolves);
    }
  });

  it('reports nothing left for the applicant to fill in, for a profile the corpus can fully judge', () => {
    const report = computeCompleteness(rich, fixturePrograms);
    // The claim this test exists to make: no verdict is waiting on this applicant.
    expect(report.fields).toEqual([]);
    // What is left is the record that states nothing, which no answer can settle.
    expect(report.unknownCount).toBe(UNRESOLVABLE_BY_ANY_PROFILE);
    expect(fixturePrograms.filter((p) => p.constraints.length === 0)).toHaveLength(
      UNRESOLVABLE_BY_ANY_PROFILE,
    );
    expect(report.score).toBe(
      Math.round(((report.total - UNRESOLVABLE_BY_ANY_PROFILE) / report.total) * 100),
    );
  });

  it('expresses the score as the share of the corpus that yields a real verdict', () => {
    const report = computeCompleteness(sparse, fixturePrograms);
    expect(report.score).toBe(
      Math.round(((report.total - report.unknownCount) / report.total) * 100),
    );
  });

  it('handles an empty corpus without dividing by zero', () => {
    const report = computeCompleteness(sparse, []);
    expect(report.total).toBe(0);
    expect(report.score).toBe(100);
    expect(report.fields).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The rest of this file is beyond the task brief. It exists because the meter's
// whole premise is one invariant — silence is `unknown`, never `ineligible` —
// and because the applicant shapes below are the ones the corpus profiler found
// this product has to serve. Neither was covered by the five tests above.
// ---------------------------------------------------------------------------

const NOW = '2026-08-02T12:00:00.000Z';

function hard(id: string, spec: ConstraintSpec, rawText = `Constraint ${id}.`): Constraint {
  return { id, hard: true, fallbackRank: 0, rawText, spec };
}

function program(
  id: string,
  constraints: Constraint[],
  applicantEntities: ApplicantEntity[] = ['individual'],
): Program {
  return {
    id,
    funderId: 'example-funder',
    name: id,
    klass: 'ham_scholarship',
    summary: '',
    applicantEntities,
    amount: { instrument: 'unknown', amountRaw: 'Not published', awardCountRaw: 'Not published' },
    deadline: { kind: 'unpublished', source: { kind: 'self' }, note: '' },
    applyVia: 'none',
    constraints,
    fundingRestrictions: [],
    obligations: {},
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://example.com/programs/' + id,
      lastVerifiedAt: NOW,
      verificationMethod: 'manual_curation',
      contentHash: '0'.repeat(64),
    },
    rawOtherText: '',
    tags: [],
  };
}

/**
 * One program per axis that has a profile field behind it, each one a hard bar.
 * A profile that states nothing must come back `unknown` on every one of them.
 */
const SILENCE_CORPUS: Program[] = [
  program('bar-license', [hard('c-license', { axis: 'license', licenseMin: 'GENERAL' })]),
  program('bar-gpa', [hard('c-gpa', { axis: 'gpa', min: 3.0 })]),
  program('bar-age', [hard('c-age', { axis: 'age_stage', ageMax: 25, stages: [] })]),
  program('bar-citizenship', [
    hard('c-citizenship', { axis: 'citizenship', allowed: ['US_CITIZEN'] }),
  ]),
  program('bar-part-time', [
    hard('c-part-time', {
      axis: 'institution',
      degreeLevels: [],
      tradeSchoolOK: true,
      partTimeOK: false,
      accreditationRequired: false,
    }),
  ]),
  program('bar-activity', [
    hard('c-activity', {
      axis: 'ham_activity',
      activityKinds: ['contesting'],
      proofRequired: false,
    }),
  ]),
];

describe('the premise: an unset profile field is unknown, never ineligible', () => {
  it('returns unknown on every axis a silent profile cannot answer', () => {
    const verdicts = matchAll(sparse, SILENCE_CORPUS, NOW);
    expect([...verdicts.values()].map((v) => v.kind)).toEqual(SILENCE_CORPUS.map(() => 'unknown'));
  });

  it('names every one of those fields in the meter, so the user can go fix them', () => {
    const report = computeCompleteness(sparse, SILENCE_CORPUS, NOW);
    expect(report.unknownCount).toBe(SILENCE_CORPUS.length);
    expect(report.score).toBe(0);
    expect(report.fields.map((f) => f.field).sort()).toEqual([
      'activityKinds',
      'birthDate',
      'citizenship',
      'gpa',
      'licenseClass',
      'partTime',
    ]);
  });

  it('turns ineligible only once the applicant states the disqualifying fact', () => {
    const stated: StudentProfile = {
      kind: 'student',
      licenseClass: 'TECH',
      gpa: 2.0,
      birthDate: '1980-01-01',
      citizenship: 'US_RESIDENT',
      partTime: true,
      activityKinds: ['on_air'],
    };
    const verdicts = matchAll(stated, SILENCE_CORPUS, NOW);
    expect([...verdicts.values()].map((v) => v.kind)).toEqual(
      SILENCE_CORPUS.map(() => 'ineligible'),
    );

    const report = computeCompleteness(stated, SILENCE_CORPUS, NOW);
    expect(report.unknownCount).toBe(0);
    expect(report.fields).toEqual([]);
    // Every verdict is real, so the corpus is fully judged even though the
    // applicant is eligible for none of it. The meter measures answers, not luck.
    expect(report.score).toBe(100);
  });
});

describe('the applicant shapes the corpus has to serve', () => {
  it('fully judges a licensed EE undergraduate', () => {
    const undergrad: StudentProfile = {
      kind: 'student',
      callsign: 'K5UTD',
      licenseClass: 'EXTRA',
      fieldOfStudy: 'Electrical Engineering',
      degreeLevel: 'BACH',
      accredited: true,
      partTime: false,
      stage: 'UNDERGRAD',
      gpa: 3.8,
    };
    const report = computeCompleteness(undergrad, fixturePrograms, NOW);
    expect(report.fields).toEqual([]);
    expect(report.unknownCount).toBe(UNRESOLVABLE_BY_ANY_PROFILE);
  });

  it('reads an unlicensed high-school senior as ineligible, not as an unanswered question', () => {
    const senior: StudentProfile = {
      kind: 'student',
      licenseClass: 'NONE',
      stage: 'HS_SENIOR',
      degreeLevel: 'BACH',
      accredited: true,
      partTime: false,
    };
    const verdicts = matchAll(senior, fixturePrograms, NOW);
    // The ARRL catalog needs any class of licence; this applicant has stated they
    // hold none. That is a fact, so it is a bar, and nothing is left unanswered.
    expect(verdicts.get('arrl-foundation-scholarship')?.kind).toBe('ineligible');
    const report = computeCompleteness(senior, fixturePrograms, NOW);
    expect(report.fields).toEqual([]);
    expect(report.unknownCount).toBe(UNRESOLVABLE_BY_ANY_PROFILE);
  });

  it('fully judges a licensed graduate student in a non-technical major', () => {
    const grad: StudentProfile = {
      kind: 'student',
      licenseClass: 'GENERAL',
      fieldOfStudy: 'Comparative Literature',
      degreeLevel: 'GRAD',
      accredited: true,
      partTime: false,
      stage: 'GRAD',
    };
    const report = computeCompleteness(grad, fixturePrograms, NOW);
    expect(report.fields).toEqual([]);
    expect(report.unknownCount).toBe(UNRESOLVABLE_BY_ANY_PROFILE);
  });

  it('admits a licensed adult returning part-time where the funder says part-time is fine', () => {
    // The Marte Wessel K0EPE shape: part-time study while working full-time.
    const returning: StudentProfile = {
      kind: 'student',
      licenseClass: 'GENERAL',
      degreeLevel: 'BACH',
      accredited: true,
      partTime: true,
      stage: 'RETRAINING_ADULT',
    };
    const partTimeWelcome = program('part-time-welcome', [
      hard('c-institution', {
        axis: 'institution',
        degreeLevels: ['BACH'],
        tradeSchoolOK: false,
        partTimeOK: true,
        accreditationRequired: true,
      }),
    ]);
    expect(matchAll(returning, [partTimeWelcome], NOW).get('part-time-welcome')?.kind).toBe(
      'eligible',
    );
  });

  it('does not bar a part-time applicant who has not said whether they are part-time', () => {
    const undeclared: StudentProfile = {
      kind: 'student',
      licenseClass: 'GENERAL',
      degreeLevel: 'BACH',
      accredited: true,
    };
    const verdict = matchAll(undeclared, fixturePrograms, NOW).get('qcwa-memorial-scholarship');
    expect(verdict?.kind).toBe('unknown');
    expect(computeCompleteness(undeclared, fixturePrograms, NOW).fields).toEqual([
      { field: 'partTime', resolves: 1 },
    ]);
  });

  it('admits a certificate/trade-school student where the funder admits one', () => {
    const trade: StudentProfile = {
      kind: 'student',
      licenseClass: 'TECH',
      degreeLevel: 'CERT',
      accredited: true,
      partTime: false,
    };
    const tradeWelcome = program('trade-welcome', [
      hard('c-institution', {
        axis: 'institution',
        degreeLevels: ['CERT', 'ASSOC', 'BACH'],
        tradeSchoolOK: true,
        partTimeOK: true,
        accreditationRequired: true,
      }),
    ]);
    const degreeOnly = program('degree-only', [
      hard('c-institution', {
        axis: 'institution',
        degreeLevels: ['BACH', 'GRAD'],
        tradeSchoolOK: false,
        partTimeOK: true,
        accreditationRequired: true,
      }),
    ]);
    const verdicts = matchAll(trade, [tradeWelcome, degreeOnly], NOW);
    expect(verdicts.get('trade-welcome')?.kind).toBe('eligible');
    expect(verdicts.get('degree-only')?.kind).toBe('ineligible');
    expect(computeCompleteness(trade, [tradeWelcome, degreeOnly], NOW).unknownCount).toBe(0);
  });

  /**
   * ONE UNDECIDABLE RECORD FOR AN ORGANISATION, AND IT IS THE ONE THE READER CAN DO SOMETHING
   * ABOUT.
   *
   *   ARRL Club Grant  waiting on `arrlAffiliated` — a question for the reader, named below.
   *
   * ARDC Grants IS NO LONGER THE SECOND, and the reason is the whole of this round's matcher
   * change. Its only hard constraint is an `other` tier quoting "Clubs and individuals need a
   * fiscal sponsor. For-profits ineligible." — a real requirement in the funder's own words that
   * no field in CONTRACT §3 can answer. Round nine made a record whose only hard requirement is
   * unanswerable come back `unknown`; that rule was cleared by whatever ELSE a record happened to
   * hold, so the identical sentence meant two different things in two records, and it was cleared
   * from EVALUATION results, so it meant two different things for a student and for a club. It is
   * gone — `matcher.ts` carries the account — and an axis nobody can answer decides nothing in
   * either direction again.
   *
   * The meter counts what is left, because the score is the share of the corpus that yields a real
   * verdict. What it must not do is name a field for a record the reader cannot resolve, and that
   * is still asserted here.
   */
  it('meters a radio club against the org-facing half of the corpus', () => {
    const club: OrgProfile = { kind: 'organization', entity: 'club_501c3' };
    const report = computeCompleteness(club, fixturePrograms, NOW);
    expect(report.total).toBe(5);
    expect(report.unknownCount).toBe(1);
    expect(report.fields).toEqual([{ field: 'arrlAffiliated', resolves: 1 }]);
    expect(report.score).toBe(80);
  });

  it('asks a school for nothing, and names no field it could not use', () => {
    const school: OrgProfile = {
      kind: 'organization',
      entity: 'school_lea',
      orgName: 'Example Unified School District',
    };
    const report = computeCompleteness(school, fixturePrograms, NOW);
    // Nothing is waiting on THIS READER — which is what the meter promises…
    expect(report.fields).toEqual([]);
    // …and nothing is waiting on anything else either. See the block above.
    expect(report.unknownCount).toBe(0);
  });

  it('never asks an organisation for a field only a student profile has', () => {
    const countyGated = program(
      'county-gated',
      [
        hard('c-geo', {
          axis: 'geography',
          geo: { type: 'county', values: ['Washtenaw'] },
        }),
      ],
      ['club_501c3'],
    );
    const club: OrgProfile = { kind: 'organization', entity: 'club_501c3' };
    const report = computeCompleteness(club, [countyGated], NOW);
    expect(report.fields.map((f) => f.field)).not.toContain('county');
    expect(report.fields.map((f) => f.field)).not.toContain('callDistrict');
  });
});

describe('what the meter actually promises', () => {
  it('breaks ties between equally blocking fields by name, so the list is stable', () => {
    const report = computeCompleteness(sparse, fixturePrograms, NOW);
    expect(report.fields).toEqual([
      { field: 'degreeLevel', resolves: 1 },
      { field: 'licenseClass', resolves: 1 },
    ]);
    // Two verdicts waiting on a field, plus the one record that states no requirement at all and
    // that no answer could settle.
    expect(report.unknownCount).toBe(2 + UNRESOLVABLE_BY_ANY_PROFILE);
    expect(report.total).toBe(5);
    expect(report.score).toBe(40);
  });

  it('counts a program once per field even when several constraints ask for the same one', () => {
    const twice = program('gpa-twice', [
      hard('c-gpa-a', { axis: 'gpa', min: 3.0 }),
      hard('c-gpa-b', { axis: 'gpa', min: 3.5 }),
    ]);
    const also = program('gpa-also', [hard('c-gpa-c', { axis: 'gpa', min: 2.5 })]);
    expect(computeCompleteness(sparse, [twice, also], NOW).fields).toEqual([
      { field: 'gpa', resolves: 2 },
    ]);
  });

  it('reports the fields blocking a verdict NOW, which is not a promise that the verdict lands', () => {
    // The institution axis stops at the first thing it cannot answer, so filling
    // `degreeLevel` moves QCWA's unknown along to `accredited` instead of
    // resolving it. `resolves` is therefore "verdicts blocked on this field
    // today", an upper bound on what one answer buys — the UI must not promise
    // more than that.
    const before = computeCompleteness(sparse, fixturePrograms, NOW);
    expect(before.fields).toContainEqual({ field: 'degreeLevel', resolves: 1 });

    const after = computeCompleteness(
      { kind: 'student', degreeLevel: 'BACH' },
      fixturePrograms,
      NOW,
    );
    expect(after.unknownCount).toBe(before.unknownCount);
    expect(after.fields).toEqual([
      { field: 'accredited', resolves: 1 },
      { field: 'licenseClass', resolves: 1 },
    ]);
  });

  it('takes its clock from the caller rather than from the wall', () => {
    const clockSensitive = program('clock-sensitive', [
      hard('c-age', { axis: 'age_stage', ageMax: 25, stages: [] }),
      hard('c-gpa', { axis: 'gpa', min: 3.0 }),
    ]);
    const applicant: StudentProfile = { kind: 'student', birthDate: '2000-06-01' };

    // Aged out: a hard fail is decisive, so nothing is left unknown.
    expect(computeCompleteness(applicant, [clockSensitive], NOW).unknownCount).toBe(0);
    // A year earlier the same applicant is inside the cap, and the GPA nobody
    // has stated becomes the open question.
    expect(
      computeCompleteness(applicant, [clockSensitive], '2025-08-02T12:00:00.000Z'),
    ).toMatchObject({ unknownCount: 1, fields: [{ field: 'gpa', resolves: 1 }] });
  });
});
