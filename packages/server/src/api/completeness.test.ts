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

  it('reports zero remaining unknowns for a profile the corpus can fully judge', () => {
    const report = computeCompleteness(rich, fixturePrograms);
    expect(report.unknownCount).toBe(0);
    expect(report.fields).toEqual([]);
    expect(report.score).toBe(100);
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
    expect(computeCompleteness(undergrad, fixturePrograms, NOW).unknownCount).toBe(0);
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
    expect(computeCompleteness(senior, fixturePrograms, NOW).unknownCount).toBe(0);
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
    expect(computeCompleteness(grad, fixturePrograms, NOW).unknownCount).toBe(0);
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

  it('meters a radio club against the org-facing half of the corpus', () => {
    const club: OrgProfile = { kind: 'organization', entity: 'club_501c3' };
    const report = computeCompleteness(club, fixturePrograms, NOW);
    expect(report.total).toBe(5);
    // Only the ARRL Club Grant is undecidable, and only because nobody has said
    // whether the club is ARRL-affiliated.
    expect(report.unknownCount).toBe(1);
    expect(report.fields).toEqual([{ field: 'arrlAffiliated', resolves: 1 }]);
    expect(report.score).toBe(80);
  });

  it('fully judges a school applying for a contact programme', () => {
    const school: OrgProfile = {
      kind: 'organization',
      entity: 'school_lea',
      orgName: 'Example Unified School District',
    };
    const report = computeCompleteness(school, fixturePrograms, NOW);
    expect(report.unknownCount).toBe(0);
    expect(report.fields).toEqual([]);
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
    expect(report.unknownCount).toBe(2);
    expect(report.total).toBe(5);
    expect(report.score).toBe(60);
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
