import { describe, expect, it } from 'vitest';
import { ageAt, evaluateConstraint, monthsBetween } from '../src/matcher.js';
import type { ConstraintSpec } from '../src/types.js';
import { makeOrg, makeStudent } from './fixtures.js';

const NOW = '2027-03-01T00:00:00.000Z';

describe('date helpers', () => {
  it('counts whole elapsed months', () => {
    expect(monthsBetween('2026-01-15T00:00:00.000Z', '2027-01-14T00:00:00.000Z')).toBe(11);
    expect(monthsBetween('2026-01-15T00:00:00.000Z', '2027-01-16T00:00:00.000Z')).toBe(12);
    expect(monthsBetween('2027-05-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')).toBe(-4);
  });

  it('computes age in whole years', () => {
    expect(ageAt('2004-07-15T00:00:00.000Z', '2027-06-01T00:00:00.000Z')).toBe(22);
    expect(ageAt('2004-05-15T00:00:00.000Z', '2027-06-01T00:00:00.000Z')).toBe(23);
  });
});

describe('license axis', () => {
  it('compares licence class by rank', () => {
    const spec = { axis: 'license', licenseMin: 'GENERAL' } as const;
    expect(evaluateConstraint(spec, makeStudent({ licenseClass: 'EXTRA' }), NOW).status).toBe('pass');
    expect(evaluateConstraint(spec, makeStudent({ licenseClass: 'GENERAL' }), NOW).status).toBe('pass');
    expect(evaluateConstraint(spec, makeStudent({ licenseClass: 'TECH' }), NOW).status).toBe('fail');
  });

  it('is unknown when the licence class is missing, but passes when NONE is required', () => {
    expect(evaluateConstraint({ axis: 'license', licenseMin: 'TECH' }, makeStudent(), NOW)).toEqual({
      status: 'unknown',
      missing: ['licenseClass'],
    });
    expect(evaluateConstraint({ axis: 'license', licenseMin: 'NONE' }, makeStudent(), NOW).status).toBe(
      'pass',
    );
  });

  it('enforces a holding period', () => {
    // ARDC scholarships require the applicant to have been licensed at least a year.
    const spec = { axis: 'license', licenseMin: 'TECH', heldMonthsMin: 12 } as const;
    const short = makeStudent({ licenseClass: 'GENERAL', licensedSince: '2026-06-01T00:00:00.000Z' });
    const long = makeStudent({ licenseClass: 'GENERAL', licensedSince: '2025-06-01T00:00:00.000Z' });
    expect(evaluateConstraint(spec, short, NOW).status).toBe('fail');
    expect(evaluateConstraint(spec, long, NOW).status).toBe('pass');
    expect(
      evaluateConstraint(spec, makeStudent({ licenseClass: 'GENERAL' }), NOW),
    ).toEqual({ status: 'unknown', missing: ['licensedSince'] });
  });

  it('is not evaluable against an organisation profile', () => {
    expect(
      evaluateConstraint({ axis: 'license', licenseMin: 'EXTRA' }, makeOrg(), NOW).status,
    ).toBe('not_evaluable');
  });
});

describe('geography axis', () => {
  it('delegates to evaluateGeo for students and organisations alike', () => {
    const spec: ConstraintSpec = { axis: 'geography', geo: { type: 'state', values: ['LA'] } };
    expect(evaluateConstraint(spec, makeStudent({ state: 'LA' }), NOW).status).toBe('pass');
    expect(evaluateConstraint(spec, makeStudent({ state: 'TX' }), NOW).status).toBe('fail');
    expect(evaluateConstraint(spec, makeStudent(), NOW)).toEqual({
      status: 'unknown',
      missing: ['state'],
    });
    expect(evaluateConstraint(spec, makeOrg({ state: 'LA' }), NOW).status).toBe('pass');
  });
});

describe('field_of_study axis', () => {
  // A real catalogue entry reads "Any, except for Liberal Arts".
  it('honours exclusions even when the allow-list says Any', () => {
    const spec: ConstraintSpec = {
      axis: 'field_of_study',
      fields: ['Any'],
      excludedFields: ['Liberal Arts'],
    };
    expect(
      evaluateConstraint(spec, makeStudent({ fieldOfStudy: 'Electrical Engineering' }), NOW).status,
    ).toBe('pass');
    expect(
      evaluateConstraint(spec, makeStudent({ fieldOfStudy: 'liberal  arts' }), NOW).status,
    ).toBe('fail');
  });

  it('matches an explicit allow-list and reports a missing field', () => {
    const spec: ConstraintSpec = {
      axis: 'field_of_study',
      fields: ['Electrical Engineering', 'Computer Science'],
      excludedFields: [],
    };
    expect(
      evaluateConstraint(spec, makeStudent({ fieldOfStudy: 'Computer Science' }), NOW).status,
    ).toBe('pass');
    expect(evaluateConstraint(spec, makeStudent({ fieldOfStudy: 'Journalism' }), NOW).status).toBe(
      'fail',
    );
    expect(evaluateConstraint(spec, makeStudent(), NOW)).toEqual({
      status: 'unknown',
      missing: ['fieldOfStudy'],
    });
  });
});

describe('institution axis', () => {
  it('checks degree level, accreditation and part-time status', () => {
    const spec: ConstraintSpec = {
      axis: 'institution',
      degreeLevels: ['BACH', 'GRAD'],
      tradeSchoolOK: false,
      partTimeOK: false,
      accreditationRequired: true,
    };
    expect(
      evaluateConstraint(
        spec,
        makeStudent({ degreeLevel: 'BACH', accredited: true, partTime: false }),
        NOW,
      ).status,
    ).toBe('pass');
    expect(
      evaluateConstraint(
        spec,
        makeStudent({ degreeLevel: 'ASSOC', accredited: true, partTime: false }),
        NOW,
      ).status,
    ).toBe('fail');
    expect(
      evaluateConstraint(
        spec,
        makeStudent({ degreeLevel: 'BACH', accredited: true, partTime: true }),
        NOW,
      ).status,
    ).toBe('fail');
    expect(evaluateConstraint(spec, makeStudent({ degreeLevel: 'BACH' }), NOW)).toEqual({
      status: 'unknown',
      missing: ['accredited'],
    });
  });
});

describe('gpa axis', () => {
  it('enforces a hard floor', () => {
    const spec = { axis: 'gpa', min: 3 } as const;
    expect(evaluateConstraint(spec, makeStudent({ gpa: 3.2 }), NOW).status).toBe('pass');
    expect(evaluateConstraint(spec, makeStudent({ gpa: 2.9 }), NOW).status).toBe('fail');
    expect(evaluateConstraint(spec, makeStudent(), NOW)).toEqual({
      status: 'unknown',
      missing: ['gpa'],
    });
  });

  // YASME asks for the top 5-10% of the class instead of a GPA number.
  it('accepts a class-rank route as an alternative to GPA', () => {
    const spec = { axis: 'gpa', min: 3.5, classRankTopPct: 10 } as const;
    expect(
      evaluateConstraint(spec, makeStudent({ gpa: 3.1, classRankTopPct: 5 }), NOW).status,
    ).toBe('pass');
    expect(
      evaluateConstraint(spec, makeStudent({ gpa: 3.1, classRankTopPct: 40 }), NOW).status,
    ).toBe('fail');
    expect(evaluateConstraint(spec, makeStudent({ gpa: 3.1 }), NOW)).toEqual({
      status: 'unknown',
      missing: ['classRankTopPct'],
    });
  });
});

describe('arrl_membership axis', () => {
  it('enforces the two intensities for a student', () => {
    const member = { axis: 'arrl_membership', required: true, minYears: 0 } as const;
    const veteran = { axis: 'arrl_membership', required: true, minYears: 1 } as const;
    const recent = makeStudent({ arrlMemberSince: '2026-06-01T00:00:00.000Z' });
    const older = makeStudent({ arrlMemberSince: '2025-06-01T00:00:00.000Z' });
    expect(evaluateConstraint(member, recent, NOW).status).toBe('pass');
    expect(evaluateConstraint(veteran, recent, NOW).status).toBe('fail');
    expect(evaluateConstraint(veteran, older, NOW).status).toBe('pass');
    expect(evaluateConstraint(veteran, makeStudent(), NOW)).toEqual({
      status: 'unknown',
      missing: ['arrlMemberSince'],
    });
  });

  it('uses arrlAffiliated for organisations and is not evaluable when not required', () => {
    const spec = { axis: 'arrl_membership', required: true, minYears: 1 } as const;
    expect(evaluateConstraint(spec, makeOrg({ arrlAffiliated: true }), NOW).status).toBe('pass');
    expect(evaluateConstraint(spec, makeOrg({ arrlAffiliated: false }), NOW).status).toBe('fail');
    expect(evaluateConstraint(spec, makeOrg(), NOW)).toEqual({
      status: 'unknown',
      missing: ['arrlAffiliated'],
    });
    expect(
      evaluateConstraint(
        { axis: 'arrl_membership', required: false, minYears: 0 },
        makeStudent(),
        NOW,
      ).status,
    ).toBe('not_evaluable');
  });
});

describe('citizenship axis', () => {
  it('treats a US citizen as satisfying a US-resident requirement', () => {
    const residents: ConstraintSpec = { axis: 'citizenship', allowed: ['US_RESIDENT'] };
    expect(evaluateConstraint(residents, makeStudent({ citizenship: 'US_CITIZEN' }), NOW).status).toBe(
      'pass',
    );
    const citizens: ConstraintSpec = { axis: 'citizenship', allowed: ['US_CITIZEN'] };
    expect(evaluateConstraint(citizens, makeStudent({ citizenship: 'US_RESIDENT' }), NOW).status).toBe(
      'fail',
    );
    expect(
      evaluateConstraint({ axis: 'citizenship', allowed: ['ANY'] }, makeStudent(), NOW).status,
    ).toBe('pass');
    expect(evaluateConstraint(citizens, makeStudent(), NOW)).toEqual({
      status: 'unknown',
      missing: ['citizenship'],
    });
  });
});

describe('age_stage axis', () => {
  // YCCC: "22 or younger as of June 1".
  it('measures age at the constraint’s asOf date', () => {
    const spec: ConstraintSpec = { axis: 'age_stage', ageMax: 22, asOf: '06-01', stages: [] };
    expect(evaluateConstraint(spec, makeStudent({ birthDate: '2004-07-15' }), NOW).status).toBe('pass');
    expect(evaluateConstraint(spec, makeStudent({ birthDate: '2004-05-15' }), NOW).status).toBe('fail');
  });

  it('checks stage membership and reports both missing fields', () => {
    const spec: ConstraintSpec = {
      axis: 'age_stage',
      ageMin: 17,
      ageMax: 25,
      stages: ['UNDERGRAD', 'HS_SENIOR'],
    };
    expect(
      evaluateConstraint(spec, makeStudent({ stage: 'UNDERGRAD', birthDate: '2006-01-01' }), NOW)
        .status,
    ).toBe('pass');
    expect(
      evaluateConstraint(spec, makeStudent({ stage: 'GRAD', birthDate: '2006-01-01' }), NOW).status,
    ).toBe('fail');
    expect(evaluateConstraint(spec, makeStudent(), NOW)).toEqual({
      status: 'unknown',
      missing: ['stage', 'birthDate'],
    });
  });
});

describe('ham_activity axis', () => {
  it('needs at least one matching activity kind', () => {
    const spec: ConstraintSpec = {
      axis: 'ham_activity',
      activityKinds: ['ares_races_skywarn', 'field_day'],
      proofRequired: true,
    };
    expect(
      evaluateConstraint(spec, makeStudent({ activityKinds: ['field_day', 'on_air'] }), NOW).status,
    ).toBe('pass');
    expect(evaluateConstraint(spec, makeStudent({ activityKinds: ['teaching'] }), NOW).status).toBe(
      'fail',
    );
    expect(evaluateConstraint(spec, makeStudent(), NOW)).toEqual({
      status: 'unknown',
      missing: ['activityKinds'],
    });
  });

  // CWops requires an ARRL Code Proficiency certificate of at least 15 wpm.
  it('enforces a CW speed floor', () => {
    const spec: ConstraintSpec = {
      axis: 'ham_activity',
      activityKinds: [],
      cwProficiencyWpmMin: 15,
      proofRequired: true,
    };
    expect(evaluateConstraint(spec, makeStudent({ cwWpm: 20 }), NOW).status).toBe('pass');
    expect(evaluateConstraint(spec, makeStudent({ cwWpm: 10 }), NOW).status).toBe('fail');
  });
});

describe('financial_need, gender, recommendation and other axes', () => {
  // Spec §4.5 rule 11: financial need is always a weighting, never a bar.
  it('never fails on financial need', () => {
    const spec = { axis: 'financial_need', weighted: true } as const;
    expect(evaluateConstraint(spec, makeStudent({ financialNeed: true }), NOW).status).toBe('pass');
    expect(evaluateConstraint(spec, makeStudent({ financialNeed: false }), NOW).status).toBe(
      'not_evaluable',
    );
    expect(evaluateConstraint(spec, makeStudent(), NOW).status).toBe('not_evaluable');
  });

  // YLRL is the only gendered programme in the corpus.
  it('resolves gender, and refuses to guess for "other" or "prefer not to say"', () => {
    const spec: ConstraintSpec = { axis: 'gender', allowed: ['female'] };
    expect(evaluateConstraint(spec, makeStudent({ gender: 'female' }), NOW).status).toBe('pass');
    expect(evaluateConstraint(spec, makeStudent({ gender: 'male' }), NOW).status).toBe('fail');
    expect(evaluateConstraint(spec, makeStudent({ gender: 'other' }), NOW)).toEqual({
      status: 'unknown',
      missing: ['gender'],
    });
    expect(evaluateConstraint(spec, makeStudent({ gender: 'prefer_not_to_say' }), NOW)).toEqual({
      status: 'unknown',
      missing: ['gender'],
    });
    expect(
      evaluateConstraint({ axis: 'gender', allowed: ['any'] }, makeStudent(), NOW).status,
    ).toBe('pass');
  });

  it('never scores recommendation or other', () => {
    expect(
      evaluateConstraint(
        { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 3 },
        makeStudent(),
        NOW,
      ).status,
    ).toBe('not_evaluable');
    expect(
      evaluateConstraint(
        { axis: 'other', note: 'preference to a student ham from a ham family' },
        makeStudent(),
        NOW,
      ).status,
    ).toBe('not_evaluable');
  });
});
