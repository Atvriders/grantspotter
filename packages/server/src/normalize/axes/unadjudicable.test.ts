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
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCorpus } from '../../../../../scripts/profile-corpus.js';
import {
  bump,
  everyConstraintInBothCorpora,
  plant,
  seedConstraint,
  tally,
  warmBothCorpora,
  type CorpusConstraint,
  type Tally,
} from '../../test/axesCorpora.js';
import { extractFieldOfStudy } from './fieldOfStudy.js';
import { extractHamActivity } from './hamActivity.js';

const NOW = '2026-08-02T00:00:00.000Z';

let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

/**
 * THE FIXTURE LOAD IS SETUP FOR THE WHOLE FILE, NOT PART OF ANY TEST'S TIME BUDGET. `loadCorpus`
 * re-parses every committed fixture — MEASURED at 2,374 ms on two cores on 2026-08-12 — and
 * without this hook that cost was charged to whichever `it` reached the corpus first, inside its
 * 5,000 ms default. `axes/spec-vs-sentence.test.ts` carries the measurement and the argument for
 * why the answer is a hook rather than a larger `testTimeout`; it is the file that went red first,
 * and every file in this list was sitting at about half the budget behind it.
 */
beforeAll(async () => {
  await corpus();
  // The seed half of the corpus-wide guard at the foot of this file. Same reason, same hook.
  await warmBothCorpora();
}, 120_000);

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
  /**
   * THE SWEEP, LIFTED OUT OF ITS `it` SO THE PLANTED-VIOLATION PROOF RUNS THE SAME ONE.
   *
   * The shape `spec-vs-sentence.test.ts` and `sentence-vs-spec.test.ts` adopted in the round
   * before this: a proof that re-implements the predicate proves the predicate can return true,
   * not that the RULE can reach a record and say so. Four guards in this repository have been
   * found structurally blind with a perfectly good predicate inside them.
   */
  function readRoutes(all: readonly CorpusConstraint[]): { offenders: string[]; checked: Tally } {
    const offenders: string[] = [];
    const checked = tally();
    for (const { corpus: which, program, c } of all) {
      const stated = c.spec.orUnrepresented;
      if (stated === undefined) continue;
      bump(checked, which);
      for (const route of stated.split(', ')) {
        if (!c.rawText.toLowerCase().includes(route.toLowerCase())) {
          offenders.push(`[${which}] ${program.name}: "${route}" is not in its own rawText`);
        }
      }
    }
    return { offenders, checked };
  }

  /**
   * AND IT NOW READS THE CORPUS A STUDENT IS ACTUALLY SERVED.
   *
   * Until 2026-08-16 this rule read `loadCorpus()` and nothing else — the 150 FIXTURE records
   * built by re-running the extractors over `fixtures/`. A fresh install serves `data/seed`, and
   * the 91 hand-written `orUnrepresented` routes in it had never been past this rule in their
   * lives. They pass; that is the answer, and it was not knowable before the sweep was pointed at
   * them. The distinction that matters is in `docs/how-this-catalogue-can-be-wrong.md`: this is a
   * claim about DATA, not about code, so it is true only of the population it was run over, and
   * running it on the fixtures said nothing whatever about the seed.
   */
  it('every orUnrepresented route appears verbatim in its own constraint’s rawText', async () => {
    const { offenders, checked } = readRoutes(await everyConstraintInBothCorpora());
    expect(offenders).toEqual([]);
    // Per corpus, never summed: a rule that stops seeing the fixture half must not be able to hide
    // inside a total the seed half makes up. Seed measured at 91 on 2026-08-16.
    //
    // 95 SINCE `87c656c`, WHICH IS THIS RULE DOING ITS JOB IN THE GROWING DIRECTION. Four routes
    // were added to `data/seed` by the round that closed eight register entries against the
    // funders' own captures, and all four are a phrase the record's own `rawText` already carried,
    // lifted OUT of `fields` — where word overlap was matching it to majors it does not name — and
    // into the field that publishes it as an unadjudicable route. All four constraints are SOFT,
    // so the movement here is `pass` -> `unknown`, not `fail` -> `unknown`: nobody was being
    // refused, people were being told they met a preference the sentence does not give them.
    // (Re-measured through `evaluateConstraint` on 2026-08-20, on the shipped `ylrl-k4lmb-study`:
    // `Culinary Arts` pass -> unknown, `Electrical Engineering` and `Communications` pass -> pass.)
    //
    //   · `ylrl-k4lmb-study`, `ylrl-nm7n-study`, `ylrl-k0epe-study` — three YLRL scholarships whose
    //     shared sentence is "Preference will be given to students studying communications, radio,
    //     electronics, or Amateur Radio related arts and sciences." The fourth disjunct names a
    //     CLASS of fields rather than a field, and it was sitting in `fields` as a list member.
    //     `matcher.ts` matches a field by stemmed word overlap, so a phrase the funder wrote to
    //     WIDEN their list matched every major carrying the word "arts": measured on the shipped
    //     record, `Culinary Arts` read `pass` and now reads `unknown`, while `Electrical
    //     Engineering` and `Communications` still `pass`. The defect was an over-claim on a soft
    //     preference — a culinary-arts student told they met YLRL's study preference — not a
    //     refusal; these three constraints are soft and refuse nobody either way.
    //   · `rca-track` — "Undergraduate and graduate students on a wireless career track", where
    //     "wireless career track" is a career direction and not a field of study either. The
    //     alternative of `fields: []` was tried and is worse: an empty list is `unrestricted`, so
    //     every applicant would `pass` and a culinary-arts major would be told they meet RCA's
    //     wireless-career-track preference. Quoted here, every probed major reads `unknown`.
    //
    // Each is a substring of its own constraint's `rawText`, which is what the sweep above proves;
    // the pin is here so a FIFTH route cannot arrive unannounced, and so a route that is silently
    // deleted takes this test red rather than passing on a smaller corpus.
    //
    // AND ONE HONEST LIMIT ON WHAT `rca-track` INHERITS FROM THAT PROOF. This rule checks a route
    // against its own `rawText`, not against a funder capture. On a record that HAS a capture that
    // is a chain — `constraintProvenance.test.ts` holds `rawText` itself verbatim to the page — so
    // the route inherits the page's authority. `rca-scholarship-program` is `manual-tier-d` and
    // ships no capture at all, so its `rawText` is GrantSpotter's own research brief and what this
    // sweep proves there is internal consistency, not provenance. That is not a reason to skip it;
    // it is a reason not to read a green tick on it as more than it says.
    expect(checked.seed).toBe(95);
    // Vacuity guard. 49 field_of_study constraints carry a bare domain, the CWops proof list, and
    // Robert A. Rodriguez K5AUW's "previous awardees" — the audience with no profile field that
    // this field was introduced for.
    //
    // 50 UNTIL THE VERIFICATION PASS OF THE SAME ROUND, when the 49th field_of_study record
    // arrived: The Chick Allen, NW3Y, Scholarship's "or similar scientific field". It had fallen
    // through BOTH nets — `namesADomain` knew `related` but not its synonym `similar`, and knew
    // `science` but not its adjective `scientific` — so the phrase survived into `fields` as a
    // list member that word overlap admits almost nobody to, and the record hard-refused 16 of 20
    // probed majors, Physics, Chemistry, Biology and Astronomy among them. See
    // `spec-vs-sentence.test.ts`, the corpus-wide rule that found it.
    //
    // 66 SINCE ROUND 8, when the geography cascade ladder landed: 15 bounded cascades — "Residence
    // in WI. If none identified, residence in the ARRL Central Division" and its fourteen siblings
    // — each publish the funder's own condition here ("If none identified", "if no suitable
    // applicant found", "If there is no applicant from the preferred areas"), which is what stops
    // an out-of-ladder applicant being refused by the rung the funder DID name. Fifteen more
    // strings for the rule above to catch, and it is the only thing standing between that field
    // and a paraphrase.
    //
    // 86 SINCE THE LAST ROUND, when the institution axis stopped writing a school TIER into the
    // applicant's CREDENTIAL field alone: the 20 records whose only degree statement is "4-year
    // college or university" keep the floor and now publish the funder's own tier phrase here, so
    // an associate- or certificate-seeking student AT a four-year university reads `unknown` and
    // the funder's sentence rather than a refusal that sentence does not state. Every one of the
    // 20 is caught by the rule above — the phrase is a substring of the funder's own wording, and
    // `institution.test.ts` asserts that record by record as well.
    //
    // AND 90 SINCE THE ROUND AFTER IT, which found four more records still in the state that fix
    // was written to end. Atlanta Radio Club, Buckner WØVZK, Daze N5DD and Ware NN3I all write a
    // bare four-year tier and then name a SECOND SCHOOL — "or graduate program", "graduate studies
    // permitted", "or graduate school thereof". `CREATES` read "graduate" as the applicant's own
    // credential, so the record was held to have stated one, kept a hard `["BACH","GRAD"]`, and
    // refused every associate and certificate applicant. 928 (profile, state, programme) pairs,
    // every one of them `ineligible -> unknown` and none in the other direction.
    expect(checked.fixture).toBe(90);
  });

  /**
   * THE PROOF THAT THE SWEEP CAN REACH A SEED RECORD AND SAY SO.
   *
   * Built on a real record found by its committed ids — `seedConstraint` throws rather than
   * returning `undefined`, because a violation planted on a record the corpus no longer holds is
   * planted on nothing and passes green. The mutation is the exact defect this rule exists for and
   * the one round five removed from `rawText`: GrantSpotter's own summary, filed in the field
   * documented as the funder's own words.
   */
  it('…and the same sweep goes red on a real seed record whose route nobody wrote', async () => {
    const all = await everyConstraintInBothCorpora();
    const target = seedConstraint(
      all,
      'arrl-cat-the-chick-allen-nw3y-scholarship',
      'field_of_study-0-d1cca5db',
    );
    const planted = plant(all, target, (c) => ({
      ...c,
      spec: { ...c.spec, orUnrepresented: 'any field broadly related to the sciences' },
    }));

    const { offenders, checked } = readRoutes(planted);
    expect(offenders).toEqual([
      '[seed] The Chick Allen, NW3Y, Scholarship: "any field broadly related to the sciences" is ' +
        'not in its own rawText',
    ]);
    // The mutation replaced a route, it did not add one: the census must not move, or the sweep is
    // reaching a different set of records under the mutation than it does under the real corpus.
    expect(checked).toEqual({ fixture: 90, seed: 95 });
  });
});
