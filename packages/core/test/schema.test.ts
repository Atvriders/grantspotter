import { describe, expect, it } from 'vitest';
import {
  constraintSpecSchema,
  profileSchema,
  programSchema,
} from '../src/schema.js';
import { makeConstraint, makeOrg, makeProgram, makeStudent } from './fixtures.js';

describe('zod mirrors of CONTRACT §3', () => {
  it('accepts a fully populated Program', () => {
    const program = makeProgram();
    const parsed = programSchema.parse(program);
    expect(parsed.id).toBe(program.id);
    expect(parsed.constraints).toHaveLength(program.constraints.length);
  });

  it('round-trips a Program through JSON without loss', () => {
    const program = makeProgram();
    const reparsed = programSchema.parse(JSON.parse(JSON.stringify(program)));
    expect(reparsed).toEqual(program);
  });

  it('rejects a Program with an unknown opportunity class', () => {
    const bad = { ...makeProgram(), klass: 'ham_lottery' };
    expect(() => programSchema.parse(bad)).toThrow();
  });

  it('rejects a Constraint whose spec axis is not in the union', () => {
    expect(() => constraintSpecSchema.parse({ axis: 'vibes', note: 'nope' })).toThrow();
  });

  it('accepts every one of the 13 constraint axes', () => {
    const specs = [
      { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 12, foreignLicenseOK: false },
      { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
      { axis: 'field_of_study', fields: ['Any'], excludedFields: ['Liberal Arts'] },
      {
        axis: 'institution',
        degreeLevels: ['BACH', 'GRAD'],
        tradeSchoolOK: false,
        partTimeOK: true,
        accreditationRequired: true,
      },
      { axis: 'gpa', min: 3, classRankTopPct: 10 },
      { axis: 'arrl_membership', required: true, minYears: 1 },
      { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 3 },
      { axis: 'citizenship', allowed: ['US_CITIZEN'], withinMonthsOfCitizenship: 3 },
      { axis: 'age_stage', ageMin: 17, ageMax: 25, asOf: '06-01', stages: ['UNDERGRAD'] },
      {
        axis: 'ham_activity',
        activityKinds: ['club_member', 'field_day'],
        cwProficiencyWpmMin: 15,
        proofRequired: true,
      },
      { axis: 'financial_need', weighted: true },
      { axis: 'gender', allowed: ['female'] },
      { axis: 'other', note: 'preference to a student ham from a ham family' },
    ];
    for (const spec of specs) {
      expect(() => constraintSpecSchema.parse(spec)).not.toThrow();
    }
    expect(specs).toHaveLength(13);
  });

  it('accepts both profile shapes', () => {
    expect(profileSchema.parse(makeStudent()).kind).toBe('student');
    expect(profileSchema.parse(makeOrg()).kind).toBe('organization');
  });

  it('builds constraints with rawText always populated', () => {
    const c = makeConstraint({ axis: 'gpa', min: 2.5 }, { hard: false, fallbackRank: 1 });
    expect(c.rawText.length).toBeGreaterThan(0);
    expect(c.hard).toBe(false);
    expect(c.fallbackRank).toBe(1);
  });
});
