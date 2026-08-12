/**
 * Regressions for the last systematic defect in the eligibility extractors: six axes carved their
 * "sentence" out of a record with `/[^.]*KEYWORD[^.]*\./i` — "everything up to the next period" —
 * which splits mid-decimal ("3.0"), mid-abbreviation ("U.S.", "Ph.D."), and, when a record has no
 * sentence-ending period at all, balloons across every field of the flattened record.
 *
 * Every assertion here checks the EXACT extracted value (rawText and hard/soft), not merely that
 * a constraint was produced: each of these cases produced a constraint before the fix too — just
 * the wrong one. Each axis also keeps a true-positive case so the fix cannot degenerate into
 * "never constrain anything".
 */
import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { extractAgeStage } from './ageStage.js';
import { extractCitizenship } from './citizenship.js';
import { splitClauses } from './clauses.js';
import { extractFinancialNeed } from './financialNeed.js';
import { extractGender } from './gender.js';
import { extractHamActivity } from './hamActivity.js';
import { extractRecommendation } from './recommendation.js';

const raw = (fields: Record<string, string>, rawText?: string): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText:
    rawText ??
    Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
});

const stagesOf = (spec: unknown): string[] => [...(spec as { stages: string[] }).stages].sort();
const kindsOf = (spec: unknown): string[] => [...(spec as { activityKinds: string[] }).activityKinds].sort();

describe('splitClauses (shared)', () => {
  it('does not split inside a decimal', () => {
    expect(splitClauses('Applicant must have a 3.0 GPA or higher')).toEqual([
      'Applicant must have a 3.0 GPA or higher',
    ]);
  });

  it('does not split inside "U.S." or "Ph.D."', () => {
    expect(splitClauses('Open to U.S. citizens holding a Ph.D. from a US school')).toEqual([
      'Open to U.S. citizens holding a Ph.D. from a US school',
    ]);
  });

  it('does not split inside "St. Louis"', () => {
    expect(splitClauses('Residence in the St. Louis metropolitan area')).toEqual([
      'Residence in the St. Louis metropolitan area',
    ]);
  });

  it('still splits on genuine sentence ends and on numbered-list markers', () => {
    expect(splitClauses('Must be a U.S. citizen. Must hold a 3.0 GPA.')).toEqual([
      'Must be a U.S. citizen.',
      'Must hold a 3.0 GPA.',
    ]);
    expect(splitClauses('Other:\n1) U.S. citizen\n2) Financial need')).toEqual([
      'Other:',
      '1) U.S. citizen',
      '2) Financial need',
    ]);
  });
});

describe('extractCitizenship — clause boundaries', () => {
  it('keeps "U.S. citizen" whole (regression: split at the abbreviation)', () => {
    const cs = extractCitizenship(raw({ Other: 'Applicant must be a U.S. citizen.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].rawText).toBe('Applicant must be a U.S. citizen.');
    expect(cs[0].hard).toBe(true);
    expect(cs[0].spec).toMatchObject({ axis: 'citizenship', allowed: ['US_CITIZEN'] });
  });

  it('keeps "U.S. citizens" plural whole and still reads the plural "permanent residents"', () => {
    const cs = extractCitizenship(raw({ Other: 'Open to U.S. citizens and permanent residents.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].rawText).toBe('Open to U.S. citizens and permanent residents.');
    expect(cs[0].spec).toMatchObject({
      axis: 'citizenship',
      allowed: expect.arrayContaining(['US_CITIZEN', 'US_RESIDENT']),
    });
  });

  // The reported shape: the residency word sits BEFORE the abbreviation, so the old idiom's match
  // started after "U.S." and dropped US_RESIDENT entirely — a permanent resident was told they
  // were ineligible for an award explicitly open to them.
  it('reads US_RESIDENT when "permanent residents" precedes a "U.S." abbreviation', () => {
    const cs = extractCitizenship(
      raw({ Other: 'Open to permanent residents of the U.S. and to U.S. citizens.' }),
    );
    expect(cs[0].rawText).toBe('Open to permanent residents of the U.S. and to U.S. citizens.');
    expect(cs[0].spec).toMatchObject({
      axis: 'citizenship',
      allowed: expect.arrayContaining(['US_CITIZEN', 'US_RESIDENT']),
    });
  });

  // Rev. Paul E. Bittner, WØAIH, Memorial Scholarship — real Other field. Old rawText: "citizen
  // with a 3.".
  it('does not split a sentence at a decimal GPA (Bittner regression)', () => {
    const cs = extractCitizenship(raw({ Other: 'Applicant must be a U.S. citizen with a 3.0 GPA or higher' }));
    expect(cs[0].rawText).toBe('Applicant must be a U.S. citizen with a 3.0 GPA or higher');
    expect(cs[0].hard).toBe(true);
  });

  // The Carole J. Streeter, KB9JBR, Scholarship — Other is the two words "U.S. citizenship" and
  // the record has no sentence-ending period, so the old match ran across every field and picked
  // up "License Requirement: ... with preference for basic Morse code capability", flipping a
  // stated citizenship requirement into a mere preference.
  it('does not let another field\'s "preference" wording soften a citizenship requirement (Streeter regression)', () => {
    const cs = extractCitizenship(
      raw({
        'License Requirement': 'Any class of active Amateur Radio license with preference for basic Morse code capability',
        Region: 'none',
        Other: 'U.S. citizenship',
      }),
    );
    expect(cs).toHaveLength(1);
    expect(cs[0].rawText).toBe('U.S. citizenship');
    expect(cs[0].hard).toBe(true);
  });

  // The Gary Wagner, K3OMI, Scholarship — real Other field, a numbered list.
  it('reads a numbered-list "1) U.S. citizen" without swallowing item 2 (Gary Wagner regression)', () => {
    const cs = extractCitizenship(raw({ Other: '1) U.S. citizen\n2) Financial need' }));
    expect(cs[0].rawText).toBe('1) U.S. citizen');
    expect(cs[0].hard).toBe(true);
  });

  // The 10-10 International Scholarships and the ARDC Scholarships, verbatim. Silence read as
  // prohibition, in its purest form: the funder says citizenship is NOT a requirement and the
  // extractor emitted a hard US-citizens-only bar, hiding a worldwide award from every
  // non-US applicant.
  it('reads "US citizenship ... are not requirements" as ANY (10-10 / ARDC regression)', () => {
    const cs = extractCitizenship(
      raw(
        { Region: 'Any' },
        'The 10-10 Scholarships are open to all radio amateurs. US licensure, US residence and US citizenship are not requirements.\nRegion: Any',
      ),
    );
    expect(cs).toHaveLength(1);
    expect(cs[0].spec).toMatchObject({ axis: 'citizenship', allowed: ['ANY'] });
    expect(cs[0].rawText).toBe(
      'US licensure, US residence and US citizenship are not requirements.',
    );
  });

  it('still bars on a genuine citizens-only restriction (true positive)', () => {
    const cs = extractCitizenship(raw({ Other: 'This scholarship is open only to United States citizens.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].spec).toMatchObject({ axis: 'citizenship', allowed: ['US_CITIZEN'] });
  });
});

describe('extractAgeStage — clause boundaries', () => {
  // The Chick Allen, NW3Y, Scholarship — real Other field. Old rawText: "citizen; open to
  // graduation high school seniors, undergraduate students and U." (military veterans dropped).
  it('keeps "U.S. military veterans" in the clause (Chick Allen regression)', () => {
    const other =
      'Applicant must be a U.S. citizen; open to graduation high school seniors, undergraduate students and U.S. military veterans.';
    const cs = extractAgeStage(raw({ Other: other }));
    expect(cs).toHaveLength(1);
    expect(cs[0].rawText).toBe(other);
    expect(stagesOf(cs[0].spec)).toEqual(['HS_SENIOR', 'UNDERGRAD', 'VETERAN']);
  });

  it('does not split a sentence at a decimal GPA', () => {
    const other = 'Open to undergraduate students with a 3.0 GPA or higher.';
    const cs = extractAgeStage(raw({ Other: other }));
    expect(cs[0].rawText).toBe(other);
    expect(stagesOf(cs[0].spec)).toEqual(['UNDERGRAD']);
  });

  // The Wayne Nelson, KB4UT, Memorial Scholarship — real Other field. The word "undergraduate"
  // appears only inside "in high school or in the previous undergraduate year", which names where
  // the GPA came from; this entry restricts standing not at all, so the honest answer is no
  // age_stage constraint rather than a hard undergraduates-only bar.
  it('does not read "the previous undergraduate year" as a stage restriction (Wayne Nelson regression)', () => {
    expect(
      extractAgeStage(
        raw({
          Other:
            'Applicant must be a US citizen; applicant must have a demonstrated previous grade point average of 3.0 on a 4.0 scale in high school or in the previous undergraduate year',
        }),
      ),
    ).toEqual([]);
  });

  // The `post-graduate` spelling this axis added for CWops still reads — from a clause that says
  // something about the APPLICANT. Both halves of that sentence matter and they are asserted
  // separately below: the spelling here, the surface it may be read from next.
  it('reads "undergraduate, graduate or post-graduate" as both stages when the clause is about the applicant', () => {
    const cs = extractAgeStage(
      raw({ Other: 'Open to undergraduate, graduate or post-graduate students' }),
    );
    expect(stagesOf(cs[0].spec)).toEqual(['GRAD', 'UNDERGRAD']);
  });

  // The CWops Scholarship — real Institution field, and the SAME three words. Here they list the
  // levels a qualifying SCHOOL teaches at (institution.ts reads them as degreeLevels
  // ["CERT","ASSOC","BACH","GRAD"]); read as the applicant's own standing they became an ALLOW-list
  // that told an Extra-class graduating high school senior with 25 wpm they were ineligible, sole
  // reason age_stage, for an award whose preamble is "open to any qualified applicant". A sentence
  // about buildings may not decide who the applicant is.
  it('reads no stage out of an Institution sentence that describes the school (CWops regression)', () => {
    expect(
      extractAgeStage(
        raw({
          Institution:
            'Fully accredited educational institution of higher learning, 2- or 4-year, undergraduate, graduate or post-graduate, or a fully accredited trade, art or professional school',
        }),
      ),
    ).toEqual([]);
  });

  // The Tom and Judith Comstock Scholarship — real Institution field, and the reason the gate is
  // "does this clause assert something of the applicant?" rather than "ignore Institution". This
  // record states its whole audience there and nowhere else, so both stages must survive.
  it('still reads both stages from an Institution clause that states an obligation on the applicant (Comstock)', () => {
    const cs = extractAgeStage(
      raw({
        Institution:
          'Applicant must be a high school senior accepted at a 2 or 4-year college or a student currently enrolled at a 2 or 4-year college',
      }),
    );
    expect(stagesOf(cs[0].spec)).toEqual(['HS_SENIOR', 'UNDERGRAD']);
  });

  // The Ozaukee Radio Club, W9CQO, Scholarship — real Age field. No pattern here parses "under 26
  // years of age" into ageMax, but the funder's own age wording is still what the applicant needs
  // to read, so it must stay the constraint's rawText.
  //
  // The second field is the Comstock Institution line rather than ECARS's "Full-time studies at a
  // 4-year undergraduate institution": that one describes the SCHOOL and no longer produces a
  // stage at all (see the CWops regression above), so it can no longer stand in for "the clause
  // that produced the stages". The assertion — which of two texts becomes the rawText — is the
  // same one it always was.
  it('keeps an unparsed Age field as the rawText, but not the placeholder "Any"', () => {
    const institution =
      'Applicant must be a high school senior accepted at a 2 or 4-year college or a student currently enrolled at a 2 or 4-year college';
    expect(
      extractAgeStage(raw({ Age: 'Applicant must be under 26 years of age.', Institution: institution }))[0]
        .rawText,
    ).toBe('Applicant must be under 26 years of age.');
    expect(extractAgeStage(raw({ Age: 'Any', Institution: institution }))[0].rawText).toBe(institution);
  });

  // The Six Meter Club of Chicago Scholarship — real Institution field. "undergraduate degree" is
  // a degree LEVEL, already read by institution.ts as degreeLevels ["ASSOC","BACH"]; duplicating
  // it here as a hard stages:["UNDERGRAD"] bar excluded a part-time adult in an associate
  // programme from an award whose very first words are "Part-time or full-time".
  it('does not read "undergraduate degree" as a stage — that is institution.ts\'s degreeLevels (Six Meter regression)', () => {
    expect(
      extractAgeStage(
        raw({
          Institution:
            'Part-time or full-time post-secondary student at a regionally accredited technical school, community college, college or university leading to an undergraduate degree',
        }),
      ),
    ).toEqual([]);
  });

  // The Tom and Judith Comstock Scholarship — real Institution field. The second half explicitly
  // admits students already enrolled in college, but only HS_SENIOR was read, so every
  // currently-enrolled undergraduate was told they were ineligible.
  it('reads a currently-enrolled college student as UNDERGRAD (Comstock regression)', () => {
    const cs = extractAgeStage(
      raw({
        Institution:
          'Applicant must be a high school senior accepted at a 2 or 4-year college or a student currently enrolled at a 2 or 4-year college',
      }),
    );
    expect(stagesOf(cs[0].spec)).toEqual(['HS_SENIOR', 'UNDERGRAD']);
  });

  it('still bars on a genuine high-school-senior-only restriction (true positive)', () => {
    const cs = extractAgeStage(raw({ Other: 'Applicant must be a high school senior at time of application.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(true);
    expect(stagesOf(cs[0].spec)).toEqual(['HS_SENIOR']);
  });
});

describe('extractGender — clause boundaries', () => {
  it('does not split at a decimal or an abbreviation', () => {
    const other = 'Preference is given to women who hold a U.S. amateur licence and a 3.5 GPA.';
    const cs = extractGender(raw({ Other: other }));
    expect(cs[0].rawText).toBe(other);
    expect(cs[0].hard).toBe(false);
  });

  it('still bars on YLRL’s genuine female-only scope (true positive)', () => {
    const cs = extractGender(raw({ eligibility: 'Open to licensed women amateur radio operators worldwide.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].spec).toMatchObject({ axis: 'gender', allowed: ['female'] });
  });
});

describe('extractRecommendation — clause boundaries', () => {
  // The ARDC Scholarships — real Other field. The old anchor regex had no word boundary, so
  // "Preference" matched the "reference" alternative and the extracted clause was the GPA
  // sentence (truncated at "3."), not the recommendation sentence: wrong rawText, wrong count,
  // and a stated requirement reported as a preference.
  it('anchors on the recommendation sentence, not on "Preference" (ARDC regression)', () => {
    const cs = extractRecommendation(
      raw({
        Other:
          'Preference will be given to applicants demonstrating a GPA of over 3.5 on a 4.0 scale. Three letters of recommendation must be provided from teachers, local radio club officers and/or others.',
      }),
    );
    expect(cs).toHaveLength(1);
    expect(cs[0].rawText).toBe(
      'Three letters of recommendation must be provided from teachers, local radio club officers and/or others.',
    );
    expect(cs[0].hard).toBe(true);
    expect(cs[0].spec).toMatchObject({ axis: 'recommendation', recommenderType: 'teacher', count: 3 });
  });

  // The David Knaus Memorial Scholarship — real Field of Study field. Who FUNDS the award is not
  // a requirement on the applicant; emitting one fabricates an obligation the funder never stated.
  it('does not fabricate a recommendation from "This Scholarship is sponsored by ..." (Knaus regression)', () => {
    expect(
      extractRecommendation(
        raw({
          'Field of Study':
            "Bachelor's degree or a 2 year Associate's degree\nThis Scholarship is sponsored by the West Allis Radio Amateur Club",
        }),
      ),
    ).toEqual([]);
  });

  it('does not split a reference requirement at a decimal GPA', () => {
    const other = 'Two letters of reference are required from applicants with a 3.5 GPA.';
    const cs = extractRecommendation(raw({ Other: other }));
    expect(cs[0].rawText).toBe(other);
    expect(cs[0].spec).toMatchObject({ count: 2 });
  });

  it('still reads a genuine sponsor requirement (true positive)', () => {
    const cs = extractRecommendation(raw({ Other: 'Applicant must be sponsored by an active QCWA member.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(true);
    expect(cs[0].spec).toMatchObject({ recommenderType: 'sponsor_org_member', count: 1 });
  });
});

describe('extractHamActivity — clause boundaries', () => {
  // The ARDC Scholarships — real Other field, an explicitly permissive list of EXAMPLES of
  // acceptable proof. Club membership and on-the-air operating are both named, but neither
  // pattern matched the funder's spelling, so an applicant who is a club member AND operates on
  // the air was excluded from the largest award programme in the corpus.
  it('reads club membership and on-the-air activity from ARDC’s examples list', () => {
    const cs = extractHamActivity(
      raw({
        Other:
          'Applicant must show proof of amateur radio activity during the previous year. Examples: membership in a local or regional club, participation in amateur radio emergency activities, teaching amateur radio classes, on-the-air activities, participation in college radio clubs, and any similar activities.',
      }),
    );
    expect(cs).toHaveLength(1);
    expect(kindsOf(cs[0].spec)).toEqual(expect.arrayContaining(['club_member', 'on_air', 'teaching']));
  });

  // The Harry A. Hodges / K6GO Gayle Olson / Richard Warren K6OBS scholarships all carry this
  // sentence. "teacher" is who writes the letter, not an amateur-radio activity the applicant
  // performs; reading it as one fabricated a ham-activity bar on three awards at once.
  it('does not read "teacher recommendations" as a teaching activity (Hodges/K6GO/Warren regression)', () => {
    expect(
      extractHamActivity(
        raw({
          Other:
            'Applicant must be performing at a high academic level or an at-risk youth with at least two counselor or teacher recommendations as to how and why they have turned their lives around.',
        }),
      ),
    ).toEqual([]);
  });

  it('does not split an activity clause at a decimal GPA', () => {
    const other = 'Applicant must have a 3.0 GPA and documented participation in ARES.';
    const cs = extractHamActivity(raw({ Other: other }));
    expect(cs[0].rawText).toBe(other);
    expect(kindsOf(cs[0].spec)).toEqual(['ares_races_skywarn']);
    expect(cs[0].spec).toMatchObject({ proofRequired: true });
  });

  it('still bars on a genuine documented-activity requirement (true positive)', () => {
    const cs = extractHamActivity(
      raw({ Other: 'Documented participation in ARES, SKYWARN, Field Day and club teaching is required.' }),
    );
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(true);
    expect(kindsOf(cs[0].spec)).toEqual(
      expect.arrayContaining(['ares_races_skywarn', 'club_member', 'field_day', 'teaching']),
    );
  });
});

describe('extractFinancialNeed — clause boundaries', () => {
  it('does not split at a decimal or an abbreviation', () => {
    const other = 'Applicant must be a U.S. citizen with financial need and a 3.0 GPA.';
    const cs = extractFinancialNeed(raw({ Other: other }));
    expect(cs).toHaveLength(1);
    expect(cs[0].rawText).toBe(other);
    expect(cs[0].hard).toBe(false);
  });

  it('still records a genuine need-based weighting (true positive)', () => {
    const cs = extractFinancialNeed(raw({ Other: 'This is a need-based award.' }));
    expect(cs).toHaveLength(1);
    expect(cs[0].rawText).toBe('This is a need-based award.');
    expect(cs[0].spec).toMatchObject({ axis: 'financial_need', weighted: true });
  });
});
