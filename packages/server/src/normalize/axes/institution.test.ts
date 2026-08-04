import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { extractInstitution } from './institution.js';

const raw = (fields: Record<string, string>, rawText = ''): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: rawText || Object.values(fields).join('\n'),
});

interface InstitutionSpec {
  axis: string;
  degreeLevels: string[];
  tradeSchoolOK: boolean;
  partTimeOK: boolean;
  accreditationRequired: boolean;
}

const specs = (fields: Record<string, string>): InstitutionSpec[] =>
  extractInstitution(raw(fields)).map((c) => c.spec as unknown as InstitutionSpec);

const first = (fields: Record<string, string>): InstitutionSpec => {
  const all = specs(fields);
  expect(all.length).toBeGreaterThan(0);
  return all[0];
};

const levels = (fields: Record<string, string>): string[] => [...first(fields).degreeLevels].sort();

/**
 * The corpus profile that motivated this file: `partTimeOK` defaulted to `false` whenever the
 * funder simply never mentioned enrolment intensity, and matcher.ts reads `!partTimeOK` as a hard
 * bar. That barred a part-time adult learner from 104 of 112 individual-facing candidates,
 * including entries whose Institution text is literally "Any". Silence in a funder's text is
 * absence of a restriction, never a prohibition.
 */
describe('extractInstitution — silence is not a part-time prohibition', () => {
  it('does not bar part-time when the text says nothing about enrolment intensity', () => {
    expect(first({ Institution: 'Accredited 4-year college or university' })).toMatchObject({
      partTimeOK: true,
      accreditationRequired: true,
    });
  });

  // The single most common Institution value in the corpus (30 of 111 entries) — the funder's
  // way of saying "we do not care where you go to school". It cannot possibly ban part-timers.
  it('does not bar part-time for the literal "Any" institution text', () => {
    expect(first({ Institution: 'Any' })).toMatchObject({
      partTimeOK: true,
      accreditationRequired: false,
      degreeLevels: [],
    });
  });

  it('does not bar part-time for an unrestricted institution sentence', () => {
    expect(first({ Institution: 'Any accredited institution' }).partTimeOK).toBe(true);
  });

  // True positives must still fire — all five are verbatim corpus text.
  it.each([
    ['Full-time studies at a two-year trade school or 4-year undergraduate institution'],
    [
      'Full-time student at an accredited 4-year college or university\nMust be a citizen of the ' +
        'United States but without regard to gender, race, national origin, handicap status or any other factor.',
    ],
    [
      'Fully accredited institution or university. Applicants must be enrolled in a full time ' +
        'degree program, with a minimum of twelve (12) credit hours per semester.',
    ],
    ['Applicant must be pursuing full-time studies at an accredited undergraduate degree-granting institution'],
    ['Applicant must be pursing full-time studies at a four-year undergraduate degree-granting instituion'],
  ])('still bars part-time when the funder genuinely requires full-time enrolment: %s', (text) => {
    expect(first({ Institution: text }).partTimeOK).toBe(false);
  });

  it('lets an explicit part-time permission win over the word "full-time" in the same sentence', () => {
    // The Six Meter Club of Chicago Scholarship, verbatim.
    expect(
      first({
        Institution:
          'Part-time or full-time post-secondary student at a regionally accredited technical ' +
          'school, community college, college or university leading to an undergraduate degree',
      }).partTimeOK,
    ).toBe(true);
  });

  /**
   * The YLRL Marte Wessel K0EPE scholarship targets part-time students who are working full time.
   * Its "full-time" describes EMPLOYMENT, not enrolment, and it reaches this axis only through
   * prose — the ylrl source emits no `Institution` field at all. Both readings must come out
   * part-time-friendly: no institution constraint at all, or one that permits part-time.
   */
  it('never bars the part-time-targeted Marte Wessel K0EPE award', () => {
    const cases: Array<Record<string, string>> = [
      { summary: 'Award: $1,500. For part-time students working full-time.' },
      { Institution: 'For part-time students working full-time.' },
      { Institution: 'Open to students working full-time.' },
    ];
    for (const fields of cases) {
      for (const spec of specs(fields)) expect(spec.partTimeOK).toBe(true);
    }
  });

  it('honours an explicit part-time prohibition', () => {
    expect(first({ Institution: 'Part-time students are not eligible.' }).partTimeOK).toBe(false);
  });
});

/**
 * The same defect shape on the degree-level field: a statement the recognizer fails to read
 * produces a NARROWER level list than the funder wrote, and a short list is a hard bar. "Any
 * accredited 4-year college or university, graduate studies permitted" yielded ["GRAD"], barring
 * every undergraduate from a scholarship that names undergraduates first.
 */
describe('extractInstitution — an enumeration is never inverted into an exclusion', () => {
  it.each([
    ['Accredited 4-year college or university, or graduate program.', ['BACH', 'GRAD']],
    ['Any accredited 4-year college or university, graduate studies permitted', ['BACH', 'GRAD']],
    ['An accredited 2-or 4- year college, university, or trade school. Graduate studies accepted.', ['ASSOC', 'BACH', 'GRAD']],
    ['An accredited 2- or 4-year college, university or trade school. Graduate studies permitted.', ['ASSOC', 'BACH', 'GRAD']],
    [
      'Fully accredited educational institution of higher learning, 2- or 4-year, undergraduate, ' +
        'graduate or post-graduate, or a fully accredited trade, art or professional school',
      ['ASSOC', 'BACH', 'GRAD'],
    ],
    [
      'Any fully accredited 4-year US college or university or graduate school thereof, and have a ' +
        'GPA of 3.0 or higher out of a 4.0 scale',
      ['BACH', 'GRAD'],
    ],
  ])('credits every level the text names: %s', (text, expected) => {
    expect(levels({ Institution: text })).toEqual(expected);
  });

  // "Any community college, college, university or trade school accredited by ..." is maximally
  // permissive; reading "community college" as an ASSOC-only requirement barred every bachelor's
  // and graduate applicant from it.
  it('does not turn a bare institution-type list into a degree-level bar', () => {
    expect(
      levels({
        Institution:
          'Any community college, college, university or trade school accredited by an accrediting ' +
          'body recognized by the U.S. Department of Education',
      }),
    ).toEqual([]);
  });

  // An institution TIER ("4-year college") describes the school, not the applicant's degree; a
  // graduate student attends a 4-year university too. Only a statement about the applicant's own
  // programme may create a level bar.
  it.each([
    ['Accredited 4-year college or university'],
    ['Accredited four-year college or university'],
    ['Any accredited 2- or 4-year college or university'],
    ['An accredited 2- or 4-year college, university, or trade school within the United States'],
  ])('does not read an institution tier as a degree-level bar: %s', (text) => {
    expect(levels({ Institution: text })).toEqual([]);
  });

  it('reads "N-year degree/program" — a statement about the applicant\'s own course — as a level', () => {
    expect(levels({ Institution: 'Engineering or other 4-year technical degree' })).toEqual(['BACH']);
    expect(levels({ Institution: '2 or 4-year program' })).toEqual(['ASSOC', 'BACH']);
  });

  it('treats "undergraduate" as covering associate as well as bachelor programmes', () => {
    expect(levels({ Institution: 'Accredited undergraduate degree-granting institution' })).toEqual([
      'ASSOC',
      'BACH',
    ]);
  });

  it('reads "or higher" as opening the levels above the one named', () => {
    expect(levels({ Institution: "Bachelor's degree or higher" })).toEqual(['BACH', 'GRAD']);
    expect(levels({ Institution: "Associate's or higher degree" })).toEqual(['ASSOC', 'BACH', 'GRAD']);
  });

  it('does not let a GPA "or higher" leak into the degree levels', () => {
    expect(levels({ 'Field of Study': "Bachelor's degree or higher; GPA 3.0 or higher" })).toEqual([
      'BACH',
      'GRAD',
    ]);
  });
});

/**
 * Degree-level requirements in this corpus routinely sit in the `Field of Study` field rather
 * than `Institution` — 19 of 111 entries. Those requirements were previously (wrongly) enforced
 * by the field-of-study axis; after that axis stopped fabricating degree values out of them they
 * were enforced by nobody. This axis reads them, as a SECOND constraint carrying its own verbatim
 * rawText, so nothing is attributed to wording the funder did not use.
 */
describe('extractInstitution — degree-level statements filed under "Field of Study"', () => {
  it('reads The Mary Lou Brown Scholarship’s bachelor-or-higher requirement', () => {
    const all = specs({
      Institution: 'Any',
      'Field of Study': "Bachelor's degree or higher; GPA 3.0 or higher",
    });
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ degreeLevels: [], partTimeOK: true, accreditationRequired: false });
    expect([...all[1].degreeLevels].sort()).toEqual(['BACH', 'GRAD']);
    const secondary = extractInstitution(
      raw({ Institution: 'Any', 'Field of Study': "Bachelor's degree or higher; GPA 3.0 or higher" }),
    )[1];
    expect(secondary.rawText).toBe("Bachelor's degree or higher");
    expect(secondary.hard).toBe(true);
  });

  it('reads The CARA Merit Scholarship, whose only institution text is under Field of Study', () => {
    const all = specs({
      'Field of Study': 'An accredited 2- or 4-year college, university or trade school',
    });
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      degreeLevels: [],
      tradeSchoolOK: true,
      partTimeOK: true,
      accreditationRequired: true,
    });
  });

  it('reads The David Knaus Memorial Scholarship without dragging in its sponsor sentence', () => {
    const cs = extractInstitution(
      raw({
        'Field of Study':
          "Bachelor's degree or a 2 year Associate's degree\nThis Scholarship is sponsored by the West Allis Radio Amateur Club",
      }),
    );
    expect(cs).toHaveLength(1);
    expect([...(cs[0].spec as unknown as InstitutionSpec).degreeLevels].sort()).toEqual(['ASSOC', 'BACH']);
    expect(cs[0].rawText).toBe("Bachelor's degree or a 2 year Associate's degree");
  });

  it('reads The Yankee Clipper Contest Club Youth Scholarship’s "2 or 4-year program"', () => {
    const all = specs({
      Institution: 'Accredited college or university',
      'Field of Study': '2 or 4-year program',
    });
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ degreeLevels: [], accreditationRequired: true, partTimeOK: true });
    expect([...all[1].degreeLevels].sort()).toEqual(['ASSOC', 'BACH']);
  });

  // A field-of-study value that is only about the field of study must produce no institution
  // constraint at all — inventing one is exactly the fabrication that was just removed from the
  // field axis.
  it.each([
    ['Sciences or Engineering'],
    ['Preference for an Engineering discipline'],
    ['Electronics, communications, or related fields'],
    // "ABET accredited Engineering" is PROGRAMME accreditation, not the institution accreditation
    // the matcher asks the applicant about (The Vernon "Bill" Lippert scholarship, verbatim).
    [
      'Applied Sciences, Natural Sciences, Mathematics,\nStatistics, and Actuarial Science or ABET accredited Engineering.',
    ],
  ])('emits no institution constraint from field-only text: %s', (text) => {
    expect(extractInstitution(raw({ 'Field of Study': text }))).toEqual([]);
  });

  it('keeps a preference-worded degree statement soft', () => {
    const cs = extractInstitution(
      raw({
        'Field of Study':
          'Field of study must be leading to a career in the healing arts, including, but not ' +
          'necessarily leading to Medicine, Dentistry, Veterinary Medicine, Nursing, Pharmacy, EMT, ' +
          'or Radiology technician. Preference will be given to undergraduate students and those in ' +
          'certificate programs, but graduate students may apply.',
      }),
    );
    expect(cs).toHaveLength(1);
    expect(cs[0].hard).toBe(false);
    expect(cs[0].rawText).toBe(
      'Preference will be given to undergraduate students and those in certificate programs, but ' +
        'graduate students may apply.',
    );
  });

  it('gives the two constraints distinct ids', () => {
    const cs = extractInstitution(
      raw({ Institution: 'Any', 'Field of Study': "Bachelor's degree or higher" }),
    );
    expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length);
  });
});

describe('extractInstitution — unchanged behaviour', () => {
  it('emits nothing when neither field carries institution text', () => {
    expect(extractInstitution(raw({ Region: 'Any' }))).toEqual([]);
    expect(extractInstitution(raw({ Institution: '   ' }))).toEqual([]);
  });

  it('still reads trade schools and accreditation', () => {
    expect(
      first({
        Institution:
          'Accredited two-year, four-year or graduate program; trade schools accepted; part-time OK',
      }),
    ).toMatchObject({ tradeSchoolOK: true, partTimeOK: true, accreditationRequired: true });
  });

  it('still reads the un-apostrophized plurals', () => {
    expect(levels({ Institution: 'Bachelors degree required.' })).toEqual(['BACH']);
    expect(levels({ Institution: 'Certificates programs accepted.' })).toEqual(['CERT']);
  });

  it('keeps the Institution field verbatim as the primary constraint rawText', () => {
    const text = 'Accredited 4-year college or university, or graduate program.';
    expect(extractInstitution(raw({ Institution: text }))[0].rawText).toBe(text);
  });
});
