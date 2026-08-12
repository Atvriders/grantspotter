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
  orUnrepresented?: string;
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
    // These two carry CERT because the funder names a trade school and says nothing about
    // certificates — see the trade-school describe block below. 10-10 International / K3IVO
    // Freestate / Steve Marks W5CIA use the first wording; Hy and Mimi Ginsberg / QCWA the second.
    [
      'An accredited 2-or 4- year college, university, or trade school. Graduate studies accepted.',
      ['ASSOC', 'BACH', 'CERT', 'GRAD'],
    ],
    [
      'An accredited 2- or 4-year college, university or trade school. Graduate studies permitted.',
      ['ASSOC', 'BACH', 'CERT', 'GRAD'],
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

  /**
   * An institution TIER ("4-year college") describes the school, not the applicant's credential,
   * so it may never NARROW a list the funder wrote — a graduate student attends a 4-year
   * university too, and reading the tier as the single level BACH is what barred them.
   *
   * That rule is unchanged and asserted in the two cases below, which pair a tier with a
   * credential the funder DID name. What changed is the case where the tier is the only degree
   * statement in the sentence: see the "floor" block that follows.
   */
  it.each([
    ['Accredited 4-year college or university, or graduate program.', ['BACH', 'GRAD']],
    ['Full-time studies at a two-year trade school or 4-year undergraduate institution', ['CERT', 'ASSOC', 'BACH']],
  ])('never narrows a stated level list to the school tier: %s', (text, expected) => {
    expect(levels({ Institution: text })).toEqual([...expected].sort());
  });

  /**
   * ...AND A TIER THAT IS THE ONLY DEGREE STATEMENT IN THE SENTENCE IS A FLOOR, NOT A SILENCE.
   *
   * `degreeLevels: []` is not "no bar at that level", it is NO BAR AT ALL. 20 hard records in the
   * corpus read "4-year college or university" and published exactly that, so a community-college
   * associate student and a trade-school certificate student — the two populations this product is
   * named for — were shown `eligible` on a sentence that places them outside it. Measured over
   * 3,900 (profile, program) pairs, that was 22 of 811 positive verdicts.
   *
   * The floor is INCLUSIVE UPWARDS for the same reason the narrowing rule exists: a master's
   * candidate attends a 4-year university, and 11 of these 20 records are positive for the corpus
   * graduate profile today. `['BACH']` alone would refuse every one of them.
   */
  it.each([
    ['4-year college or university'],
    ['4 year college or university'],
    ['Accredited 4-year college or university'],
    ['Any accredited 4-year college or university'],
    ['Accredited four-year college or university'],
    ['Accredited 4-year college or university in NC, VA, WV, MD or TN'],
    [
      'Full-time student at an accredited 4-year college or university\nMust be a citizen of the ' +
        'United States but without regard to gender, race, national origin, handicap status or any other factor.',
    ],
  ])('reads a bare four-year tier as a floor at the bachelor and above: %s', (text) => {
    expect(levels({ Institution: text })).toEqual(['BACH', 'GRAD']);
  });

  /**
   * ...AND ONLY WHERE THE FUNDER NAMED NOTHING BELOW IT. All six are verbatim corpus text, and
   * each names a two-year or vocational route in its own words — a certificate student at an
   * accredited community college is inside "2- or 4-year college", and barring them on a guess is
   * the direction that hides money for good. "Any accredited 2- or 4-year college or university"
   * is a different sentence from "4-year college or university" and does not become it here.
   */
  it.each([
    ['Any accredited 2- or 4-year college or university'],
    ['Accredited 2 or 4-year college, technical school, or university'],
    ['An accredited 2- or 4-year college, university, or trade school within the United States'],
    ['Accredited 4-year college or university, junior college or trade technicial school in the U.S.'],
    ['Any accredited 2- or 4-year university, college or technical school'],
    [
      'Applicant must be a high school senior accepted at a 2 or 4-year college or a student ' +
        'currently enrolled at a 2 or 4-year college',
    ],
  ])('reads no floor from a sentence that names a lower tier itself: %s', (text) => {
    expect(levels({ Institution: text })).toEqual([]);
  });

  it('reads no floor from a sentence with no tier in it at all', () => {
    for (const text of [
      'Any',
      'Any accredited institution',
      'Any accredited college or university',
      'Fully accredited institution or university.',
    ]) {
      expect(levels({ Institution: text })).toEqual([]);
    }
  });

  /**
   * ...AND THE FLOOR SAYS, IN THE FUNDER'S OWN WORDS, WHAT IT CANNOT CHECK.
   *
   * A SCHOOL TIER IS NOT A CREDENTIAL. `degreeLevel` is what the applicant is studying FOR
   * ("Associate degree", "Certificate, trade or professional school"); `institution` is free text
   * no axis reads. So an associate- or certificate-seeking student AT a four-year university
   * satisfies "4-year college or university" verbatim, and a floor written into the credential
   * field alone made them `ineligible` — 1,456 (profile, state, programme) pairs, measured over
   * all 51 states, none of them stated by any sentence on any funder's page.
   *
   * `ConstraintAlternatives.orUnrepresented` is the field for exactly this and it can only turn a
   * `fail` into an `unknown`, never a refusal. The floor stays — a bachelor's or graduate
   * applicant plainly satisfies the tier and goes on reading `eligible`, which is the half the
   * floor got right — and the applicant whose credential does not settle the sentence is asked to
   * read it rather than told no.
   */
  it.each([
    ['4-year college or university', '4-year college or university'],
    ['4 year college or university', '4 year college or university'],
    ['Accredited 4-year college or university', '4-year college or university'],
    ['Accredited four-year college or university', 'four-year college or university'],
    [
      'Full-time student at an accredited 4-year college or university\nMust be a citizen of the ' +
        'United States but without regard to gender, race, national origin, handicap status or any other factor.',
      '4-year college or university',
    ],
  ])('records the tier it read the floor off, verbatim: %s', (text, route) => {
    const spec = first({ Institution: text });
    expect(spec.degreeLevels).toEqual(['BACH', 'GRAD']);
    expect(spec.orUnrepresented).toBe(route);
    // Verbatim means verbatim: the route is the funder's own substring, never a paraphrase.
    expect(text).toContain(route);
  });

  it('records no such route where the FUNDER stated the credential themselves', () => {
    // "Bachelor's degree or higher" is a statement about the applicant's own course of study, and
    // this schema holds the field that answers it. Nothing is unrepresented, so nothing is claimed
    // to be — a softening minted here would let a certificate student past a floor the funder wrote.
    for (const text of [
      "Bachelor's degree or higher in electronics, communications, or related fields",
      'Applicant must be enrolled in a certificate program at a 4-year college or university',
      'A 4-year college or university leading to an undergraduate degree',
    ]) {
      expect(first({ Institution: text }).orUnrepresented).toBeUndefined();
    }
    // ...and neither does a sentence that never produced a floor at all.
    expect(first({ Institution: 'Any accredited 2- or 4-year college or university' }).orUnrepresented).toBeUndefined();
  });

  /**
   * …AND "OR GRADUATE PROGRAM" IS A SECOND SCHOOL, NOT THE APPLICANT'S CREDENTIAL. THIS CASE IS
   * THE INVERSION OF TWO LINES THAT STOOD IN THE CASE ABOVE, AND THEY WERE WRONG.
   *
   * The rule they encoded was `levels.size === 0` — record the tier only when the sentence created
   * no level at all. `CREATES` reads "graduate program", "graduate studies" and "graduate school"
   * and creates GRAD, so these sentences were held to have stated a credential, kept a hard
   * `["BACH","GRAD"]` (WIDENS pulls the floor to BACH off the tier token anyway), and refused every
   * associate- and certificate-seeking applicant. FOUR REAL RECORDS were still in that state after
   * the round that was meant to end it: Atlanta Radio Club and Buckner WØVZK ("Accredited 4-year
   * college or university, or graduate program."), Daze N5DD, and Ware NN3I ("…4-year US college or
   * university or graduate school thereof").
   *
   * None of those sentences says the applicant must already hold a bachelor's. Each names a
   * BUILDING and then another BUILDING, and an associate student at the first one satisfies it
   * verbatim — the same defect, in the same words, as the 1,456 the tier rule was written for.
   *
   * MEASURED, BOTH DIRECTIONS, over 306,300 (profile, state, programme) pairs — 7 corpus profiles
   * x 4 credential rungs x full/part-time x 51 states x 150 publishable programmes:
   *
   *   pairs moving INTO `ineligible`      0
   *   pairs moving OUT of `ineligible`  928   every one to `unknown`; none to a positive
   *   pairs moving INTO a positive        0
   *   pairs moving OUT of a positive      0
   *
   * All 928 are CERT and ASSOC applicants on those four records. A bachelor's and a graduate
   * applicant move zero pairs, full- and part-time, in all 51 states.
   */
  it('records the route where the funder named a second SCHOOL rather than a credential', () => {
    for (const text of [
      'Accredited 4-year college or university, or graduate program.',
      'Any accredited 4-year college or university, graduate studies permitted',
      'Any fully accredited 4-year US college or university or graduate school thereof',
    ]) {
      const spec = first({ Institution: text });
      // The floor the funder plainly wrote is unchanged — this is not a return to `[]`, which told
      // a certificate student at a trade school `eligible`.
      expect(spec.degreeLevels).toEqual(['BACH', 'GRAD']);
      // …and the tier phrase is recorded beside it, verbatim, so the two rungs it does not settle
      // read `unknown` instead of `ineligible`.
      expect(spec.orUnrepresented).toBeDefined();
      expect(text).toContain(spec.orUnrepresented);
    }
  });

  /**
   * THE WORDINGS THE CRAWL WILL BRING, AND NOT ONE OF THEM IS A PLACE OF STUDY.
   *
   * None of these is in the corpus today; every one is ordinary funder English, and every one
   * minted `['BACH','GRAD']` — a hard refusal of every associate and certificate applicant — off a
   * sentence about how long the money lasts, about secondary school, about where the money may be
   * spent, or off a vocational route the tier vocabulary did not happen to spell.
   */
  it.each([
    // A DURATION, not a tier. English puts the adjectival form in the singular ("4-year college")
    // and a length of time in the plural ("four years"), which is the whole difference.
    ['The award is renewable for up to four years at any college or university.'],
    ['Must have completed four years of high school.'],
    // A PERMISSION about the money, beside a sentence admitting every institution there is.
    ['Open to students at any accredited institution; award may be used at a 4-year college or university.'],
    // A VOCATIONAL ROUTE the funder named. `LOWER_TIER_NAMED` was a fixed vocabulary of school
    // NOUNS and omitted "technical institute" — the exact phrase this product's own `cert-trade`
    // corpus profile uses for where that student studies.
    ['4-year university or a technical institute'],
    ['Accredited 4-year college or university, or an approved career academy'],
  ])('mints no floor and no route from: %s', (text) => {
    const spec = first({ Institution: text });
    expect(spec.degreeLevels).toEqual([]);
    expect(spec.orUnrepresented).toBeUndefined();
  });

  it('still reads a floor where the award clause sits BESIDE a real one', () => {
    // The award-clause guard is asked of the clause the tier is in, never of the whole field, so a
    // record that states a floor and then says something about the money keeps its floor.
    const spec = first({
      Institution: 'Applicant must attend an accredited 4-year college. The award may be used for tuition or fees.',
    });
    expect(spec.degreeLevels).toEqual(['BACH', 'GRAD']);
    expect(spec.orUnrepresented).toBe('4-year college');
  });

  /**
   * RULING (2026-08-03): the CWops Scholarship's Institution field, verbatim, is
   *
   *   "Fully accredited educational institution of higher learning, 2- or 4-year, undergraduate,
   *   graduate or post-graduate, or a fully accredited trade, art or professional school"
   *
   * A prior round read this as a single enumeration and produced ["ASSOC", "BACH", "GRAD"],
   * excluding certificate/vocational applicants. That is wrong: "or a fully accredited trade,
   * art or professional school" is a DISJUNCT, not a continuation of the degree-level list — the
   * "2- or 4-year, undergraduate, graduate or post-graduate" enumeration modifies "institution of
   * higher learning" only. The trade/art/professional branch names a school type with no
   * degree-level restriction of its own, and a certificate is the ordinary credential such a
   * school awards, so excluding certificate students contradicts what the funder plainly wrote.
   * This is now a regression test for the corrected reading, asserting the full spec (not just
   * degreeLevels) so the trade/accreditation/part-time fields stay pinned too.
   */
  it('reads the CWops Scholarship: the trade/art/professional-school branch admits certificate study', () => {
    expect(
      first({
        Institution:
          'Fully accredited educational institution of higher learning, 2- or 4-year, undergraduate, ' +
          'graduate or post-graduate, or a fully accredited trade, art or professional school',
      }),
    ).toMatchObject({
      degreeLevels: ['CERT', 'ASSOC', 'BACH', 'GRAD'],
      tradeSchoolOK: true,
      partTimeOK: true,
      accreditationRequired: true,
    });
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
 * NAMING A TRADE SCHOOL AND OMITTING `CERT`.
 *
 * The CWops ruling above was right and too narrow. It keyed on one sentence's grammar — "or A …
 * school", indefinite article required — and left eight ARRL records whose funders name a trade,
 * technical or professional school and whose `degreeLevels` still barred certificate students.
 * matcher.ts:511-514 reads a non-empty `degreeLevels` as a bar, so those eight hid themselves from
 * exactly the applicants their own sentence names, and did so silently.
 *
 * Every text below is verbatim from the committed capture, and each was read against its own
 * record before being widened. What they share is not a grammatical shape but a fact about where
 * the bar came from: in all seven widened records the levels are assembled from a NEIGHBOURING
 * sentence ("Graduate studies permitted.") or from the OTHER branch of a disjunction ("…or 4-year
 * undergraduate institution"), and then applied to the school branch by list membership alone. The
 * funder never wrote anything about certificates, and silence is not a prohibition.
 *
 * ONE OF THE EIGHT IS NOT WIDENED — Six Meter Club of Chicago, below — because there the funder
 * did write something about the credential.
 */
describe('extractInstitution — a named trade school admits the credential it awards', () => {
  it.each([
    // 10-10 International / K3IVO Freestate ARC / Steve Marks W5CIA Legacy — same sentence, three
    // funders. The GRAD comes from the second sentence; the years describe the school's tier.
    [
      '10-10 International',
      'An accredited 2-or 4- year college, university, or trade school. Graduate studies accepted.',
      ['ASSOC', 'BACH', 'CERT', 'GRAD'],
    ],
    // Hy and Mimi Ginsberg / QCWA — the same sentence with "permitted" for "accepted".
    [
      'Hy and Mimi Ginsberg / QCWA',
      'An accredited 2- or 4-year college, university or trade school. Graduate studies permitted.',
      ['ASSOC', 'BACH', 'CERT', 'GRAD'],
    ],
    /**
     * ECARS. A PRIOR ROUND ASSERTED THE OPPOSITE and this test deliberately overturns it.
     *
     * That round read "two-year" as attaching to the applicant's credential, making the trade
     * branch "ASSOCIATE-equivalent". It does not: "two-year" qualifies the SCHOOL, and this file's
     * own CREATES rules already refuse to read an institution tier as a degree level (a master's
     * candidate attends a 4-year university too). A two-year trade school awards certificates,
     * diplomas and associate degrees alike. Measured on the real record, neither ASSOC nor BACH
     * comes from the trade branch at all — both come from "4-year UNDERGRADUATE institution", the
     * other side of the "or". So the bar excluding certificate students was built entirely out of
     * a branch the certificate student was never applying under.
     */
    [
      'ECARS',
      'Full-time studies at a two-year trade school or 4-year undergraduate institution',
      ['ASSOC', 'BACH', 'CERT'],
    ],
    // NEAR-Fest, from its Field of Study value. The CWops article shape is right there ("or a
    // two-year technical school"); only the word "technical" — absent from the old pattern's
    // trade/vocational/art/professional alternation — kept it barred.
    [
      'NEAR-Fest',
      'Any undergraduate degree or a two-year technical school in radio communications',
      ['ASSOC', 'BACH', 'CERT'],
    ],
    // `levels()` sorts, so every expectation in this file is alphabetical, not LEVEL_ORDER.
  ])('widens to CERT: %s', (_name, text, expected) => {
    expect(levels({ Institution: text })).toEqual(expected);
  });

  /**
   * THE TRUE NEGATIVE, and the line the rule is drawn on. Six Meter Club of Chicago, verbatim:
   *
   *   "Part-time or full-time post-secondary student at a regionally accredited technical school,
   *    community college, college or university leading to an undergraduate degree"
   *
   * A technical school is named here too, but the funder has attached a DEGREE OUTCOME to the
   * whole enumeration — the course of study must lead to an undergraduate degree, whichever of
   * those institutions it is taken at. A certificate is not a degree. That is a restriction the
   * funder stated, not silence this extractor is filling in, so it stands: this is the one of the
   * eight reported records that keeps its bar.
   */
  it('does NOT widen when the funder states a degree outcome for the whole list (Six Meter Club)', () => {
    expect(
      levels({
        Institution:
          'Part-time or full-time post-secondary student at a regionally accredited technical ' +
          'school, community college, college or university leading to an undergraduate degree',
      }),
    ).toEqual(['ASSOC', 'BACH']);
  });

  /**
   * The other guard, and the reason this can only ever be a widening: naming a trade school must
   * never CREATE a bar. All four are verbatim corpus text whose records carry no degree-level
   * statement at all, and all four must stay completely unrestricted — a record that today shows
   * an award to every applicant must not start asking about degree level because the word "trade"
   * appears in it.
   */
  it.each([
    ['Accredited 2 or 4-year college, technical school, or university'],
    ['Any accredited college, university or trade school'],
    ['Accredited college, university, junior college or trade school'],
    ['An accredited 2- or 4-year college, university, or trade school within the United States'],
  ])('never creates a degree-level bar out of a trade school alone: %s', (text) => {
    expect(levels({ Institution: text })).toEqual([]);
  });

  it('leaves the CWops ruling exactly as it was', () => {
    expect(
      levels({
        Institution:
          'Fully accredited educational institution of higher learning, 2- or 4-year, undergraduate, ' +
          'graduate or post-graduate, or a fully accredited trade, art or professional school',
      }),
    ).toEqual(['ASSOC', 'BACH', 'CERT', 'GRAD']);
  });

  /**
   * And a record with a real degree-level bar and NO school of any kind named must be untouched —
   * the widening has to be reachable only through the funder's own words. Mary Lou Brown's
   * bachelor-or-higher floor still excludes certificate study.
   */
  it('still excludes certificate study where no trade school is named at all', () => {
    expect(levels({ Institution: "Bachelor's degree or higher" })).toEqual(['BACH', 'GRAD']);
    expect(levels({ Institution: 'Accredited 4-year college or university, or graduate program.' })).toEqual([
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
