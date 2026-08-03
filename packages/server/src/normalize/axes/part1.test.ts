import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import {
  cascadeRank,
  extractConstraints,
  extractFieldOfStudy,
  extractGpa,
  extractInstitution,
  extractLicense,
  isPreferenceText,
} from './index.js';
import { extractGeography } from './geography.js';

const raw = (fields: Record<string, string>, rawText = ''): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: rawText || Object.values(fields).join('\n'),
});

describe('isPreferenceText and cascadeRank', () => {
  it('detects preference language in all its observed forms', () => {
    expect(isPreferenceText('Preference will be given to applicants residing in Louisiana.')).toBe(true);
    expect(isPreferenceText('Preferred: General class or higher.')).toBe(true);
    expect(isPreferenceText('Applicants who prefer CW are encouraged to apply.')).toBe(true);
    expect(isPreferenceText('ARDC gives preference to a GPA over 3.5.')).toBe(true);
  });

  it('does not treat a plain requirement as a preference', () => {
    expect(isPreferenceText('Applicant must hold a General class license.')).toBe(false);
    expect(isPreferenceText('Any accredited institution.')).toBe(false);
  });

  it('ranks an explicit cascade after the primary preference', () => {
    expect(cascadeRank('Preference will be given to applicants residing in Louisiana.')).toBe(0);
    expect(
      cascadeRank(
        'Preference to Louisiana. If no qualified applicant is identified, the award is open to any eligible applicant.',
      ),
    ).toBe(1);
  });
});

describe('extractLicense', () => {
  it('reads the four license classes', () => {
    expect(extractLicense(raw({ 'License Requirement': 'Any' }))[0].spec).toMatchObject({
      axis: 'license',
      licenseMin: 'NONE',
    });
    expect(extractLicense(raw({ 'License Requirement': 'Technician or higher' }))[0].spec).toMatchObject({
      licenseMin: 'TECH',
    });
    expect(extractLicense(raw({ 'License Requirement': 'General or higher' }))[0].spec).toMatchObject({
      licenseMin: 'GENERAL',
    });
    expect(extractLicense(raw({ 'License Requirement': 'Amateur Extra' }))[0].spec).toMatchObject({
      licenseMin: 'EXTRA',
    });
  });

  it('treats Novice as Technician, the modern equivalent floor', () => {
    expect(extractLicense(raw({ 'License Requirement': 'Novice or higher' }))[0].spec).toMatchObject({
      licenseMin: 'TECH',
    });
  });

  it('reads a held-duration requirement in years and months', () => {
    expect(extractLicense(raw({ 'License Requirement': 'licensed at least one year' }))[0].spec).toMatchObject({
      heldMonthsMin: 12,
    });
    expect(extractLicense(raw({ 'License Requirement': 'licensed at least two years' }))[0].spec).toMatchObject({
      heldMonthsMin: 24,
    });
    expect(extractLicense(raw({ 'License Requirement': 'licensed for 18 months' }))[0].spec).toMatchObject({
      heldMonthsMin: 18,
    });
  });

  it('flags a foreign licence as acceptable when the text says so', () => {
    const c = extractLicense(raw({ 'License Requirement': 'Any class; US licensure not required, worldwide' }));
    expect(c[0].spec).toMatchObject({ foreignLicenseOK: true });
  });

  it('marks a preference-form licence soft, never a bar', () => {
    const c = extractLicense(raw({ 'License Requirement': 'Preference given to General class or higher.' }));
    expect(c[0].hard).toBe(false);
    expect(c[0].spec).toMatchObject({ licenseMin: 'GENERAL' });
  });

  it('always preserves the source text verbatim on the constraint', () => {
    const text = 'General or higher, licensed at least two years';
    expect(extractLicense(raw({ 'License Requirement': text }))[0].rawText).toBe(text);
  });

  it('returns [] when the source publishes no licence field', () => {
    expect(extractLicense(raw({}))).toEqual([]);
  });
});

describe('extractGeography — five incompatible shapes', () => {
  it('reads "Any" as type any', () => {
    expect(extractGeography(raw({ Region: 'Any' }))[0].spec).toMatchObject({
      axis: 'geography',
      geo: { type: 'any' },
    });
  });

  it('reads a state list', () => {
    const spec = extractGeography(raw({ Region: 'Illinois, Indiana and Wisconsin' }))[0].spec;
    expect(spec).toMatchObject({ geo: { type: 'state' } });
    expect((spec as { geo: { values: string[] } }).geo.values.sort()).toEqual(['IL', 'IN', 'WI']);
  });

  it('reads an ARRL Division', () => {
    expect(extractGeography(raw({ Region: 'ARRL Central Division (IL, IN, WI)' }))[0].spec).toMatchObject({
      geo: { type: 'arrl_division', values: ['Central'] },
    });
  });

  it('reads an ARRL Section', () => {
    expect(extractGeography(raw({ Region: 'Northern Florida Section' }))[0].spec).toMatchObject({
      geo: { type: 'arrl_section', values: ['Northern Florida'] },
    });
  });

  it('reads a county list', () => {
    const spec = extractGeography(
      raw({ Region: 'Travis, Williamson or Hays county, Texas' }),
    )[0].spec as { geo: { type: string; values: string[] } };
    expect(spec.geo.type).toBe('county');
    expect(spec.geo.values.length).toBeGreaterThanOrEqual(3);
  });

  it('reads a call district', () => {
    expect(extractGeography(raw({ Region: 'Applicants in the 5th call district' }))[0].spec).toMatchObject({
      geo: { type: 'call_district', values: ['5'] },
    });
  });

  it('reads all three real radius forms and fills coordinates from the gazetteer', () => {
    const cases: Array<[string, number, string]> = [
      ['Residing within 250 miles of Seaford, Delaware', 250, 'Seaford, Delaware'],
      ['Within 70 miles of Schenectady, NY', 70, 'Schenectady, NY'],
      ['within 175 miles of Erving, MA', 175, 'Erving, MA'],
    ];
    for (const [text, miles, label] of cases) {
      const spec = extractGeography(raw({ Region: text }))[0].spec as {
        geo: { type: string; radiusMiles?: number; centerLabel?: string; centerLat?: number };
      };
      expect(spec.geo.type).toBe('radius');
      expect(spec.geo.radiusMiles).toBe(miles);
      expect(spec.geo.centerLabel).toBe(label);
      expect(typeof spec.geo.centerLat).toBe('number');
    }
  });

  it('leaves coordinates undefined for an unknown centre rather than inventing them', () => {
    const spec = extractGeography(raw({ Region: 'within 30 miles of Nowhereville, ZZ' }))[0].spec as {
      geo: { centerLat?: number; centerLon?: number; centerLabel?: string };
    };
    expect(spec.geo.centerLat).toBeUndefined();
    expect(spec.geo.centerLon).toBeUndefined();
    expect(spec.geo.centerLabel).toBe('Nowhereville, ZZ');
  });

  it('marks the Louisiana cascade soft with fallbackRank 1 on the fallback clause', () => {
    const cs = extractGeography(
      raw({
        Region:
          'Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, the award is open to any eligible applicant.',
      }),
    );
    expect(cs[0].hard).toBe(false);
    expect(cs[0].fallbackRank).toBe(1);
  });
});

describe('extractFieldOfStudy', () => {
  it('reads a plain field list', () => {
    expect(extractFieldOfStudy(raw({ 'Field of Study': 'Electrical Engineering' }))[0].spec).toMatchObject({
      axis: 'field_of_study',
      fields: ['Electrical Engineering'],
      excludedFields: [],
    });
  });

  it('reads "Any" as an empty required list, which means unconstrained', () => {
    expect(extractFieldOfStudy(raw({ 'Field of Study': 'Any' }))[0].spec).toMatchObject({
      fields: [],
      excludedFields: [],
    });
  });

  it('reads the one real exclusion: "Any, except for Liberal Arts"', () => {
    expect(
      extractFieldOfStudy(raw({ 'Field of Study': 'Any, except for Liberal Arts' }))[0].spec,
    ).toMatchObject({ fields: [], excludedFields: ['Liberal Arts'] });
  });

  it('splits a multi-field list on commas, slashes and "or"', () => {
    const spec = extractFieldOfStudy(
      raw({ 'Field of Study': 'Sciences, Engineering or Computer Science' }),
    )[0].spec as { fields: string[] };
    expect(spec.fields).toEqual(['Sciences', 'Engineering', 'Computer Science']);
  });
});

describe('extractInstitution', () => {
  it('reads degree levels, trade school, part-time and accreditation', () => {
    const spec = extractInstitution(
      raw({ Institution: 'Accredited two-year, four-year or graduate program; trade schools accepted; part-time OK' }),
    )[0].spec as {
      degreeLevels: string[];
      tradeSchoolOK: boolean;
      partTimeOK: boolean;
      accreditationRequired: boolean;
    };
    expect(spec.degreeLevels.sort()).toEqual(['ASSOC', 'BACH', 'GRAD']);
    expect(spec.tradeSchoolOK).toBe(true);
    expect(spec.partTimeOK).toBe(true);
    expect(spec.accreditationRequired).toBe(true);
  });

  it('defaults part-time to false and accreditation to false when unstated', () => {
    const spec = extractInstitution(raw({ Institution: 'Any institution' }))[0].spec as {
      partTimeOK: boolean;
      accreditationRequired: boolean;
    };
    expect(spec.partTimeOK).toBe(false);
    expect(spec.accreditationRequired).toBe(false);
  });
});

describe('extractGpa', () => {
  it('reads a hard GPA floor', () => {
    const c = extractGpa(raw({ Other: 'A minimum GPA of 3.0 is required.' }));
    expect(c[0].hard).toBe(true);
    expect(c[0].spec).toMatchObject({ axis: 'gpa', min: 3 });
  });

  it('reads ARDC’s soft "preference over 3.5" as a preference, not a bar', () => {
    const c = extractGpa(raw({ Other: 'Preference is given to applicants with a GPA over 3.5.' }));
    expect(c[0].hard).toBe(false);
    expect(c[0].spec).toMatchObject({ min: 3.5 });
  });

  it('reads YASME’s class-rank proxy instead of a GPA', () => {
    const c = extractGpa(raw({ Other: 'Applicant must rank in the top 5 to 10 percent of the class.' }));
    expect(c[0].spec).toMatchObject({ axis: 'gpa', classRankTopPct: 10 });
  });

  it('returns [] when there is no GPA language at all', () => {
    expect(extractGpa(raw({ Other: 'Applicant must own a soldering iron.' }))).toEqual([]);
  });
});

describe('extractConstraints', () => {
  it('runs every part-1 extractor and gives each constraint a unique id', () => {
    const cs = extractConstraints(
      raw({
        'License Requirement': 'General or higher',
        Region: 'Any',
        'Field of Study': 'Engineering',
        Institution: 'Accredited four-year',
        Other: 'Minimum GPA of 2.5.',
      }),
    );
    const axes = cs.map((c) => (c.spec as { axis: string }).axis);
    expect(axes).toEqual(
      expect.arrayContaining(['license', 'geography', 'field_of_study', 'institution', 'gpa']),
    );
    expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length);
  });

  it('gives every constraint a non-empty verbatim rawText', () => {
    for (const c of extractConstraints(raw({ Region: 'Any', 'License Requirement': 'Any' }))) {
      expect(c.rawText.length).toBeGreaterThan(0);
    }
  });
});
