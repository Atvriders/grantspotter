/**
 * THE FUNDER NAMED SOMETHING THIS SCHEMA CANNOT DECIDE, AND THE EXTRACTOR CALLED IT A NO.
 *
 * The companion to disjunction.test.ts. That file covers the shape where the funder named a second
 * tier the parser CAN say (`anyOf`); this one covers the shape where they named a route it cannot
 * — a DOMAIN of study whose membership is not word overlap, an EXAMPLE list one of whose items is
 * a number, a rule about GROUPS, and a sentence about a SCHOOL read as a fact about a student.
 * Every case below was a hard `ineligible` measured over the real corpus.
 *
 *   Rev. Paul E. Bittner, WØAIH   "Science, Technology, Engineering or Mathematics" refused a
 *                                 PHYSICS undergraduate. Thirty records carry a bare domain.
 *   The CWops Scholarship         "Examples include but are not limited to: ARRL Code Proficiency
 *                                 certificate AT 15 WPM or higher; successful completion of CWA
 *                                 Basic Level…" refused a 10 wpm CWA graduate, and its INSTITUTION
 *                                 line ("…2- or 4-year, undergraduate, graduate or post-graduate")
 *                                 refused a graduating high school senior.
 *   ARRL Foundation Special Funds "GROUPS THAT QUALIFY for mini-grants will include… CLUB
 *                                 ACTIVITIES" refused an ARES volunteer — an individual, who is
 *                                 the one party that sentence is not about.
 *   Fred R. McDaniel Memorial     "RESIDENT of FCC 5th call district (TX, OK, AR, LA, MS, NM)"
 *                                 refused a Texan whose callsign was issued elsewhere.
 *   Peoria Area ARC               the opposite polarity, fixed in the same pass: nine bare county
 *                                 names admitted Fulton County GEORGIA to an Illinois-only award.
 *
 * WHAT `unknown` IS DOING HERE, since most of these assertions expect one. It is not a softer no.
 * `orUnrepresented` can only turn a `fail` into an `unknown` with NOTHING to fill in — the state
 * `VerdictBadge` renders as "this could not be worked out", beside the funder's own sentence. The
 * negative assertions in each block are what keep it from becoming a blanket: an award that names
 * an actual field still refuses a music major, and a speed floor the funder stated on its own
 * still refuses a slower operator.
 *
 * Its own file rather than an append to part1/part2/word-sense, which concurrently-running agents
 * edit — the same reason disjunction.test.ts and chrome-scope.test.ts exist.
 */
import type { Program, RawOpportunity, StudentProfile } from '@grantspotter/core';
import { matchProgram } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../../../../scripts/profile-corpus.js';
import { extractFieldOfStudy } from './fieldOfStudy.js';
import { extractHamActivity } from './hamActivity.js';

const NOW = '2026-08-02T00:00:00.000Z';

let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

const raw = (fields: Record<string, string>): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n'),
});

async function find(name: string): Promise<Program> {
  const { programs } = await corpus();
  const p = programs.find((program) => program.name.includes(name));
  if (p === undefined) throw new Error(`${name} is missing from the corpus`);
  return p;
}

/**
 * A licensed undergraduate who clears every other axis these records carry, so the verdict below
 * is decided by the one axis under test and nothing else.
 */
const student = (over: Partial<StudentProfile>): StudentProfile => ({
  kind: 'student',
  callsign: 'K5EXAMPLE',
  licenseClass: 'EXTRA',
  licensedSince: '2018-06-01T00:00:00.000Z',
  state: 'TX',
  callDistrict: '5',
  fieldOfStudy: 'Electrical Engineering',
  degreeLevel: 'BACH',
  accredited: true,
  partTime: false,
  gpa: 3.6,
  arrlMemberSince: '2018-06-01T00:00:00.000Z',
  citizenship: 'US_CITIZEN',
  birthDate: '2006-03-01T00:00:00.000Z',
  stage: 'UNDERGRAD',
  activityKinds: ['club_member', 'on_air'],
  financialNeed: true,
  gender: 'female',
  ...over,
});

const kindOf = (p: Program, profile: StudentProfile): string =>
  matchProgram(profile, p, NOW).kind;

/**
 * The axes a program refuses this profile on, or `[]` for any other verdict. Asserted instead of
 * the bare verdict wherever the record ALSO carries a place bar this one profile cannot satisfy —
 * many of these awards are Division- or state-restricted, and those refusals are correct and must
 * stay. What is under test is that the axis named below has stopped being one of the reasons.
 */
const refusals = (p: Program, profile: StudentProfile): string[] => {
  const verdict = matchProgram(profile, p, NOW);
  return verdict.kind === 'ineligible' ? verdict.reasons.map((r) => r.spec.axis) : [];
};

// ---------------------------------------------------------------- A1: domains

describe('field_of_study: a domain is not a list of majors', () => {
  it('Bittner — the physics undergraduate the STEM award refused is no longer refused on that axis', async () => {
    // (Bittner is also Wisconsin-only, which is a real bar this Texan profile keeps and should.)
    const bittner = await find('Rev. Paul E. Bittner');
    expect(refusals(bittner, student({ fieldOfStudy: 'Physics' }))).not.toContain('field_of_study');
    expect(refusals(bittner, student({ fieldOfStudy: 'Physics' }))).toEqual(['geography']);
  });

  it('Dannals — and where no other axis bars them, the verdict is an unknown with nothing to fill in', async () => {
    // "Science, technology, engineering, or mathematics", open to any region. The physics
    // undergraduate used to be a flat `ineligible` on this record with the word "Science" on the
    // screen above it.
    const dannals = await find('Harry J. Dannals');
    const verdict = matchProgram(student({ fieldOfStudy: 'Physics' }), dannals, NOW);
    expect(verdict.kind).toBe('unknown');
    // Nothing the applicant could type resolves it — the question is whether Physics is inside
    // "Science", and no profile field answers that. An empty list is how the badge says so.
    if (verdict.kind !== 'unknown') throw new Error('unreachable');
    expect(verdict.missingProfileFields).toEqual([]);
    // …and the applicant the lexical match always admitted is still plainly eligible.
    expect(kindOf(dannals, student({ fieldOfStudy: 'Electrical Engineering' }))).toBe('eligible');
  });

  it('the domains are recorded verbatim, from the funder’s own list', async () => {
    const bittner = await find('Rev. Paul E. Bittner');
    const spec = bittner.constraints.find((c) => c.spec.axis === 'field_of_study')?.spec;
    expect(spec).toMatchObject({
      fields: ['Science', 'Technology', 'Engineering', 'Mathematics'],
      orUnrepresented: 'Science, Technology, Engineering, Mathematics',
    });
  });

  it.each([
    ['Statistics', 'Michael Tortorella'], // "Mathematics or data science"
    ['Cybersecurity', 'Steel City ARC'], // "Science, Technology, Engineering or Math"
    ['Nursing', 'Richard Warren K6OBS'], // "…or a Health Care-related field"
    ['Radiography', 'Carole J. Streeter'], // "Medical"
    ['Accounting', 'Wilse Morgan'], // "Engineering, Medicine, Science or Business"
    ['Journalism', 'Goldwater'], // "Communications", verified against the ARRL page
    ['Computer Science', 'Wayne Nelson'], // "Technical field"
    ['Computer Science', 'Orlando HamCation'], // "Technical field of study that would support…"
  ])('%s is no longer refused on field_of_study by %s', async (fieldOfStudy, programName) => {
    const program = await find(programName);
    expect(refusals(program, student({ fieldOfStudy }))).not.toContain('field_of_study');
  });

  /**
   * THE OTHER DIRECTION, and the reason the test is "is the entry NOTHING BUT a domain?" rather
   * than "does it contain a domain word?". A funder who names an actual subject still refuses the
   * applicant who does not study it — otherwise this rule would quietly unrestrict the corpus.
   */
  it.each([
    ['Physics', 'Louisiana Memorial'], // "International studies"
    ['Physics', 'Robert D., W8ST'], // "Horticulture and/or environmental sciences"
    ['Music Performance', 'Edmond A. Metzger'], // "…in electrical engineering"
    ['Music Performance', 'Betty Weatherford'], // "Electrical or Communications Engineering"
  ])('%s is still refused by %s, which named a field rather than a domain', async (
    fieldOfStudy,
    programName,
  ) => {
    const program = await find(programName);
    expect(refusals(program, student({ fieldOfStudy }))).toContain('field_of_study');
  });

  it('a modified domain is a field: "Computer Science" and "Applied Sciences" gain nothing', () => {
    for (const value of ['Computer Science', 'Applied Sciences', 'Science Education', 'Physical Science']) {
      expect(extractFieldOfStudy(raw({ 'Field of Study': value }))[0].spec).not.toHaveProperty(
        'orUnrepresented',
      );
    }
  });

  it('an exclusion is never softened — the one route that must still be able to refuse', () => {
    // Rick Hughes, K4BYT, verbatim, with a domain added: `orUnrepresented` is consulted on ANY
    // failure of the tier, including the exclusion's, so a record carrying one may not have it.
    const cs = extractFieldOfStudy(raw({ 'Field of Study': 'Science, except for Liberal Arts' }));
    expect(cs[0].spec).not.toHaveProperty('orUnrepresented');
  });
});

// ------------------------------------------------- B2: a number inside an example list

describe('ham_activity: 15 wpm was one clause of one of six alternatives', () => {
  it('CWops — a 10 wpm applicant who may hold any of the other five proofs is not refused', async () => {
    const cwops = await find('CWops');
    expect(kindOf(cwops, student({ cwWpm: 10 }))).toBe('unknown');
    // The route the funder named first still passes, and the unanswered question still asks.
    expect(kindOf(cwops, student({ cwWpm: 20 }))).toBe('eligible');
    const unanswered = matchProgram(student({}), cwops, NOW);
    expect(unanswered.kind === 'unknown' && unanswered.missingProfileFields).toEqual(['cwWpm']);
  });

  it('the alternatives are the funder’s own words, not a summary of them', async () => {
    const cwops = await find('CWops');
    const spec = cwops.constraints.find((c) => c.spec.axis === 'ham_activity')?.spec;
    expect(spec?.orUnrepresented).toContain('successful completion of CWA Basic Level or higher');
    expect(spec).toMatchObject({ cwProficiencyWpmMin: 15 });
  });

  it('a speed the funder stated on its own is still a floor', () => {
    // No "examples", no "such as", no "not limited to" — one route, and the funder means it.
    const cs = extractHamActivity(
      raw({ Other: 'Applicant must be able to copy CW at 10 wpm and hold a current licence.' }),
    );
    expect(cs[0].spec).not.toHaveProperty('orUnrepresented');
    expect(cs[0].spec).toMatchObject({ cwProficiencyWpmMin: 10 });
  });
});

// ------------------------------------------------- B1: a rule about groups

describe('ham_activity: a rule about groups can only ever bite the individual it is not about', () => {
  it('ARRL Foundation Special Funds — the ARES volunteer it refused is no longer refused', async () => {
    const funds = await find('ARRL Foundation Special Funds');
    expect(
      kindOf(funds, student({ activityKinds: ['ares_races_skywarn', 'field_day'] })),
    ).not.toBe('ineligible');
    expect(funds.constraints.filter((c) => c.spec.axis === 'ham_activity')).toEqual([]);
  });

  it('the same words in a sentence about the APPLICANT still state a requirement', () => {
    // The rule keys on the grammatical subject, not on the word "club" — which appears in real
    // individual requirements throughout this corpus.
    const cs = extractHamActivity(
      raw({ Other: 'Applicants must be involved in club activities at their local radio club.' }),
    );
    expect(cs[0].spec).toMatchObject({ activityKinds: ['club_member'] });
  });
});

// ------------------------------------------------- B3: a sentence about the school

describe('age_stage: the CWops institution line describes the school, not the applicant', () => {
  it('the graduating high-school senior it refused is now eligible', async () => {
    const cwops = await find('CWops');
    expect(kindOf(cwops, student({ stage: 'HS_SENIOR', cwWpm: 25 }))).toBe('eligible');
    expect(cwops.constraints.filter((c) => c.spec.axis === 'age_stage')).toEqual([]);
    // institution.ts still holds the same three words, where they belong.
    expect(cwops.constraints.find((c) => c.spec.axis === 'institution')?.spec).toMatchObject({
      degreeLevels: ['CERT', 'ASSOC', 'BACH', 'GRAD'],
      tradeSchoolOK: true,
    });
  });
});

// ------------------------------------------------- C2/C3: places

describe('geography: a residence rule stored as a callsign, and a county with no state', () => {
  it('McDaniel — a Texan holding a callsign issued in another district is not refused', async () => {
    const mcdaniel = await find('Fred R. McDaniel');
    const moved = student({ state: 'TX', callDistrict: '4', callsign: 'W4EXAMPLE' });
    expect(kindOf(mcdaniel, moved)).not.toBe('ineligible');
    // The funder's first-named tier still admits everyone it admitted: a 5-district callsign.
    expect(kindOf(mcdaniel, student({ state: 'OH', callDistrict: '5' }))).not.toBe('ineligible');
  });

  it('Peoria — Fulton County GEORGIA no longer qualifies for an Illinois-only award', async () => {
    const peoria = await find('Peoria Area');
    expect(kindOf(peoria, student({ state: 'GA', county: 'Fulton' }))).toBe('ineligible');
    expect(kindOf(peoria, student({ state: 'IL', county: 'Fulton' }))).not.toBe('ineligible');
    // A county with no state is a question, never a refusal.
    const noState = matchProgram(
      student({ state: undefined, county: 'Fulton' }),
      peoria,
      NOW,
    );
    expect(noState.kind).toBe('unknown');
    if (noState.kind !== 'unknown') throw new Error('unreachable');
    expect(noState.missingProfileFields).toContain('state');
  });
});

// ------------------------------------------------- the corpus-wide guard

describe('nothing recorded as the funder’s words may be words the funder did not write', () => {
  /**
   * `orUnrepresented` is documented as "the funder's own words for a route this schema cannot
   * describe", and nothing but this test enforces it. A summary written by GrantSpotter and filed
   * in that field would be the defect round five removed from `rawText` — this software speaking
   * in a funder's voice — reintroduced one field over.
   *
   * Comma-separated because the field_of_study extractor lists the domains from one sentence and
   * the funder's own connector between them may be "or" ("Science, Technology, Engineering OR
   * Mathematics"). Each named route must appear verbatim; only the join is ours.
   */
  it('every orUnrepresented route appears verbatim in its own constraint’s rawText', async () => {
    const { programs } = await corpus();
    const offenders: string[] = [];
    let checked = 0;
    for (const program of programs) {
      for (const c of program.constraints) {
        const stated = c.spec.orUnrepresented;
        if (stated === undefined) continue;
        checked += 1;
        for (const route of stated.split(', ')) {
          if (!c.rawText.toLowerCase().includes(route.toLowerCase())) {
            offenders.push(`${program.name}: "${route}" is not in its own rawText`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard. 48 field_of_study constraints carry a bare domain, the CWops proof list, and
    // Robert A. Rodriguez K5AUW's "previous awardees" — the audience with no profile field that
    // this field was introduced for.
    expect(checked).toBe(50);
  });
});
