import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { extractConstraints } from './index.js';
import { extractAgeStage } from './ageStage.js';
import { extractCitizenship } from './citizenship.js';
import { extractFinancialNeed } from './financialNeed.js';
import { extractGender } from './gender.js';
import { extractHamActivity } from './hamActivity.js';
import { extractArrlMembership } from './membership.js';
import { extractOther } from './other.js';
import { extractRecommendation } from './recommendation.js';

const raw = (fields: Record<string, string>, rawText = ''): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: rawText || Object.values(fields).join('\n'),
});

describe('extractArrlMembership', () => {
  it('reads plain membership', () => {
    expect(extractArrlMembership(raw({ Other: 'Applicant must be an ARRL member.' }))[0].spec).toMatchObject({
      axis: 'arrl_membership',
      required: true,
      minYears: 0,
    });
  });

  it('reads the second intensity: member for at least one year', () => {
    expect(
      extractArrlMembership(raw({ Other: 'Applicant must be an ARRL member for at least one year.' }))[0].spec,
    ).toMatchObject({ required: true, minYears: 1 });
  });

  it('returns [] when ARRL membership is not mentioned', () => {
    expect(extractArrlMembership(raw({ Other: 'Any licensed amateur.' }))).toEqual([]);
  });

  it('reads the plural requirement form: "open to ARRL members" (regression: word-boundary plural gap)', () => {
    const cs = extractArrlMembership(raw({ Other: 'This scholarship is open to ARRL members.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].spec).toMatchObject({ axis: 'arrl_membership', required: true, minYears: 0 });
  });

  it('reads a preference-form plural: "preference is given to ARRL members" and keeps it soft', () => {
    const cs = extractArrlMembership(raw({ Other: 'Preference is given to ARRL members.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(false);
    expect(cs[0].spec).toMatchObject({ axis: 'arrl_membership', required: true, minYears: 0 });
  });
});

describe('extractRecommendation', () => {
  it('reads ARDC’s three references', () => {
    expect(extractRecommendation(raw({ Other: 'Three references are required.' }))[0].spec).toMatchObject({
      axis: 'recommendation',
      count: 3,
    });
  });

  it('reads QCWA’s active-member sponsor', () => {
    expect(
      extractRecommendation(raw({ Other: 'Applicant must be sponsored by an active QCWA member.' }))[0].spec,
    ).toMatchObject({ recommenderType: 'sponsor_org_member', count: 1 });
  });

  it('reads Goldwater’s sitting club officer', () => {
    expect(
      extractRecommendation(
        raw({ Other: 'A letter from a sitting officer of an ARRL-affiliated club is required.' }),
      )[0].spec,
    ).toMatchObject({ recommenderType: 'arrl_affiliated_club_officer' });
  });

  it('reads a teacher recommendation', () => {
    expect(
      extractRecommendation(raw({ Other: 'A letter of recommendation from a teacher is required.' }))[0].spec,
    ).toMatchObject({ recommenderType: 'teacher' });
  });
});

describe('extractCitizenship', () => {
  it('reads US citizen', () => {
    expect(extractCitizenship(raw({ Other: 'Applicant must be a US citizen.' }))[0].spec).toMatchObject({
      axis: 'citizenship',
      allowed: ['US_CITIZEN'],
    });
  });

  it('reads permanent resident as US_RESIDENT', () => {
    expect(
      extractCitizenship(raw({ Other: 'Applicant must be a US citizen or permanent resident.' }))[0].spec,
    ).toMatchObject({ allowed: expect.arrayContaining(['US_CITIZEN', 'US_RESIDENT']) });
  });

  it('reads the "within three months of citizenship" variant', () => {
    expect(
      extractCitizenship(
        raw({ Other: 'Applicant must be a US citizen, or within three months of citizenship.' }),
      )[0].spec,
    ).toMatchObject({ withinMonthsOfCitizenship: 3 });
  });

  it('reads worldwide eligibility as ANY', () => {
    expect(
      extractCitizenship(raw({ Region: 'Any', Other: 'Open worldwide; US residence is not required.' }))[0].spec,
    ).toMatchObject({ allowed: ['ANY'] });
  });

  it('reads the plural requirement form: "open to US citizens" (regression: word-boundary plural gap)', () => {
    const cs = extractCitizenship(raw({ Other: 'This scholarship is open to US citizens.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].spec).toMatchObject({ axis: 'citizenship', allowed: ['US_CITIZEN'] });
  });

  it('reads a preference-form plural: "preference is given to US citizens" and keeps it soft', () => {
    const cs = extractCitizenship(raw({ Other: 'Preference is given to US citizens.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(false);
    expect(cs[0].spec).toMatchObject({ axis: 'citizenship', allowed: ['US_CITIZEN'] });
  });
});

describe('extractAgeStage', () => {
  it('reads an explicit age range', () => {
    expect(extractAgeStage(raw({ Age: '17 to 25' }))[0].spec).toMatchObject({
      axis: 'age_stage',
      ageMin: 17,
      ageMax: 25,
    });
  });

  it('reads YCCC’s "22 or younger as of June 1" including the asOf date', () => {
    const spec = extractAgeStage(raw({ Age: '22 or younger as of June 1' }))[0].spec as {
      ageMax?: number;
      asOf?: string;
    };
    expect(spec.ageMax).toBe(22);
    expect(spec.asOf).toBe('June 1');
  });

  it('reads stages when there is no explicit age', () => {
    const spec = extractAgeStage(
      raw({ Other: 'Open to high school seniors, undergraduates and graduate students.' }),
    )[0].spec as { stages: string[] };
    expect(spec.stages.sort()).toEqual(['GRAD', 'HS_SENIOR', 'UNDERGRAD']);
  });

  it('reads veterans, explicitly included by Chick Allen and Frankford RC', () => {
    const spec = extractAgeStage(raw({ Other: 'Veterans are explicitly encouraged to apply.' }))[0].spec as {
      stages: string[];
    };
    expect(spec.stages).toContain('VETERAN');
  });

  it('reads retraining adults', () => {
    const spec = extractAgeStage(
      raw({ Other: 'Open to adults retraining for a new career.' }),
    )[0].spec as { stages: string[] };
    expect(spec.stages).toContain('RETRAINING_ADULT');
  });
});

describe('extractHamActivity', () => {
  it('reads CWops’ 15 wpm within 24 months — the only CW requirement in the corpus', () => {
    const spec = extractHamActivity(
      raw({ Other: 'Applicant must hold an ARRL Code Proficiency certificate at 15 wpm earned within 24 months.' }),
    )[0].spec as { cwProficiencyWpmMin?: number; proofRequired: boolean };
    expect(spec.cwProficiencyWpmMin).toBe(15);
    expect(spec.proofRequired).toBe(true);
  });

  it('reads the activity kinds', () => {
    const spec = extractHamActivity(
      raw({ Other: 'Documented participation in ARES, SKYWARN, Field Day and club teaching is required.' }),
    )[0].spec as { activityKinds: string[] };
    expect(spec.activityKinds).toEqual(
      expect.arrayContaining(['ares_races_skywarn', 'field_day', 'teaching', 'club_member']),
    );
  });

  it('reads contesting and public service', () => {
    const spec = extractHamActivity(
      raw({ Other: 'Preference to applicants active in contesting and public service events.' }),
    )[0].spec as { activityKinds: string[] };
    expect(spec.activityKinds).toEqual(expect.arrayContaining(['contesting', 'public_service']));
  });

  it('returns [] when no activity is mentioned', () => {
    expect(extractHamActivity(raw({ Other: 'Any accredited institution.' }))).toEqual([]);
  });
});

describe('extractFinancialNeed', () => {
  it('is ALWAYS soft — financial need is a weighting, never a bar', () => {
    const c = extractFinancialNeed(raw({ Other: 'Demonstrated financial need is considered.' }));
    expect(c[0].hard).toBe(false);
    expect(c[0].spec).toMatchObject({ axis: 'financial_need', weighted: true });
  });

  it('stays soft even when the source words it as a requirement', () => {
    const c = extractFinancialNeed(raw({ Other: 'Applicants must demonstrate financial need.' }));
    expect(c[0].hard).toBe(false);
  });
});

describe('extractGender', () => {
  it('reads YLRL’s female-only scope — the only gender constraint in the corpus', () => {
    expect(
      extractGender(raw({ eligibility: 'Open to licensed women amateur radio operators worldwide.' }))[0].spec,
    ).toMatchObject({ axis: 'gender', allowed: ['female'] });
  });

  it('returns [] for everything else, because no ARRL entry has a gender constraint', () => {
    expect(extractGender(raw({ Other: 'Open to all licensed amateurs.' }))).toEqual([]);
  });
});

describe('extractOther', () => {
  it('keeps a long-tail requirement no schema captures', () => {
    const c = extractOther(
      raw({ Other: 'Preference to a student ham from a ham family.' }),
    );
    expect(c[0].spec).toMatchObject({ axis: 'other' });
    expect(c[0].rawText).toBe('Preference to a student ham from a ham family.');
    expect(c[0].hard).toBe(false);
  });

  it('keeps learning-disability documentation verbatim', () => {
    const c = extractOther(
      raw({ Other: 'Applicant must provide documentation of a diagnosed learning disability.' }),
    );
    expect((c[0].spec as { note: string }).note).toMatch(/learning disability/i);
  });

  it('returns [] when there is no Other field', () => {
    expect(extractOther(raw({ Region: 'Any' }))).toEqual([]);
  });
});

describe('extractConstraints with all thirteen axes wired', () => {
  it('produces a constraint for every axis present in a rich entry', () => {
    const cs = extractConstraints(
      raw({
        'License Requirement': 'General or higher, licensed at least two years',
        Region: 'Any',
        'Field of Study': 'Sciences or Engineering',
        Institution: 'Any accredited institution',
        Age: '17 to 25',
        Other:
          'US citizen. ARRL member for at least one year. Three references required. Demonstrated ' +
          'financial need is considered. Applicant must rank in the top 10 percent of the class. ' +
          'Documented Field Day participation. Preference to a student ham from a ham family.',
      }),
    );
    const axes = new Set(cs.map((c) => (c.spec as { axis: string }).axis));
    for (const axis of [
      'license',
      'geography',
      'field_of_study',
      'institution',
      'gpa',
      'arrl_membership',
      'recommendation',
      'citizenship',
      'age_stage',
      'ham_activity',
      'financial_need',
      'other',
    ]) {
      expect(axes, `missing axis ${axis}`).toContain(axis);
    }
  });

  it('gives every constraint a unique id and a verbatim rawText', () => {
    const cs = extractConstraints(
      raw({ 'License Requirement': 'Any', Region: 'Any', Other: 'US citizen. Financial need considered.' }),
    );
    expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length);
    for (const c of cs) expect(c.rawText.trim()).not.toBe('');
  });

  it('never marks a preference-form constraint hard', () => {
    const cs = extractConstraints(
      raw({
        Region:
          'Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, the award is open to any eligible applicant.',
        Other: 'Financial need is considered.',
      }),
    );
    for (const c of cs) expect(c.hard).toBe(false);
  });
});
