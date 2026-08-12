/**
 * DOES THE SPEC SAY WHAT THE SENTENCE PRINTED BESIDE IT SAYS?
 *
 * Five rounds of adversarial verification have each found defects a green suite did not, and this
 * round's class was the sharpest yet: a parsed spec that CONTRADICTS the funder sentence stored on
 * the same `Constraint`. Eight hard refusals, every one of them refuted by the very words
 * GrantSpotter displays underneath as the evidence —
 *
 *   "Resident of Brevard County FL, OR ANY FL RESIDENT"        refused a Floridian
 *   "Resident of Gwinnett County GA, OR THE STATE OF GA"       refused a Georgian
 *   "…ADDITIONAL APPLICANTS…AND OKLAHOMA RESIDENTS…"           refused an Oklahoman
 *   "Maryland, Delaware, New Jersey, New York, or NEW ENGLAND" refused six states
 *   "…General … two years …, OR HOLD A CURRENT AMATEUR EXTRA"  refused an Extra of six months
 *   "open only to graduating HIGHSCHOOL SENIORS and
 *    undergraduate students"                                   refused every graduating senior
 *   "…GOTA, Field Day, ETC."                                   refused a club member
 *   "Examples: … EMERGENCY ACTIVITIES … AND ANY SIMILAR…"      refused an ARES volunteer
 *
 * WHY THIS FILE IS NOT MORE PINNED EXPECTATIONS. Every one of those eight had a test over it, and
 * the tests passed, because they asserted the value the extractor happened to emit.
 * `chrome-scope.test.ts:156` is the proof: it read `stages: ['UNDERGRAD']` and called it one of
 * "the two clearest real ones, by name and wording" — while the wording it was quoting names the
 * high-school senior FIRST. A test that pins a parse is only as good as the parse was on the day
 * it was written, and it goes on certifying that day's answer forever.
 *
 * So these assertions never name a value. They read EVERY constraint in the real corpus, and each
 * one fails when the spec and its own `rawText` disagree in one of the directions this round found:
 *
 *   R1  a STATE the sentence names is admitted by no tier              (Brevard, Gwinnett, Oklahoma)
 *   R2  a REGION the sentence names resolves to fewer states than it has        (New England)
 *   R3  a DURATION on one branch of an alternation is applied to both            (Ware's Extra)
 *   R4  an AUDIENCE the sentence names is missing from `stages`             (Goldwater, Rodriguez)
 *   R5  a DEGREE LEVEL the sentence names is missing from `degreeLevels`
 *   R6  the funder called their own list ILLUSTRATIVE and it still refuses  (CARA, ARDC, CWops…)
 *   R7  a list entry that is an IDIOM ABOUT A CLASS OF FIELDS is the reason for a refusal
 *
 * AND EVERY RULE CARRIES ITS OWN MUTATION PROOF, in the `it` directly below it. A corpus-wide
 * "offenders is empty" assertion is worth nothing on its own — it is green against a rule that
 * matches nothing, and green is exactly the state this project keeps being lied to by. So each
 * rule is also run against the SPEC AS IT ACTUALLY WAS before this round, reconstructed here, and
 * is required to flag it. That is the difference between a check that fails when a spec is WRONG
 * and one that fails when a spec CHANGES: the rule is pinned, the parse is not.
 *
 * R7 IS NOT A HISTORICAL CASE. It found a live one, in this file's own verification pass — see its
 * block below.
 *
 * Its own file rather than an append to part1/part2/disjunction/unadjudicable, for the reason those
 * files give for existing.
 */
import type { Constraint, ConstraintSpec, GeoSpec, Program, StudentProfile } from '@grantspotter/core';
import { evaluateConstraint, statesForArrlDivision, statesForArrlSection } from '@grantspotter/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCorpus } from '../../../../../scripts/profile-corpus.js';

const NOW = '2026-08-02T00:00:00.000Z';

let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

/**
 * THE FIXTURE LOAD IS SETUP FOR THE WHOLE FILE, AND IT IS NOT PART OF ANY RULE'S TIME BUDGET.
 *
 * WHY THIS HOOK EXISTS, MEASURED. `loadCorpus` re-parses every committed fixture through the real
 * parsers and the real normalizer; MEASURED on this host on 2026-08-12 on two cores
 * (`taskset -c 0,1`), a load is 2,374 ms and the R1 sweep over all 652 constraints that follows it
 * is 1 ms. Without this hook that load was charged to whichever `it` touched the corpus first —
 * R1's, because it is the first in the file — so a rule that does one millisecond of work was
 * being run against a 5,000 ms default timeout with 2,400 ms of shared fixture I/O already spent
 * out of it. On a two-core runner with the rest of the suite competing for the same cores it went
 * over: reproduced here at 5,837 ms by pinning to two cores and putting two busy loops on them,
 * and that is exactly the failure CI reported.
 *
 * WHY IT IS NOT A LARGER `testTimeout`. The rule's own cost is 1 ms and did not change when R1
 * grew from 63 constraints to 77; the number that grew is the corpus, which every test in this
 * file shares and none of them is about. Raising the budget would hide the load in eleven W-rules
 * and seven R-rules at once and leave the next one to go red as fixtures land. Loading it in a
 * hook makes each `it` measure the rule again — the same shape as `exports/corpus.test.ts`, which
 * has done this since it was written, and as the `beforeEach` in `api/calendarRouter.test.ts`.
 *
 * THE TIMEOUT HERE IS THE HOOK'S, and it is generous on purpose: it bounds fixture I/O on the
 * slowest machine this suite runs on, not a property of the product.
 */
beforeAll(async () => {
  await corpus();
}, 120_000);

/** Every constraint in the publishable corpus, with the program that carries it. */
async function everyConstraint(): Promise<Array<{ program: Program; c: Constraint }>> {
  const { programs } = await corpus();
  return programs.flatMap((program) => program.constraints.map((c) => ({ program, c })));
}

/** The tier the funder named first, plus every alternative — the whole disjunction. */
function tiers(spec: ConstraintSpec): ConstraintSpec[] {
  return [spec, ...((spec.anyOf ?? []) as ConstraintSpec[])];
}

// =============================================================== R1 + R2: places

/**
 * The same table `geography.ts` resolves names with, including its one hard-won special case:
 * `\bvirginia\b` matches the word inside "West Virginia" too, so a West-Virginia-only sentence
 * would otherwise be read as naming Virginia.
 *
 * Restated here rather than imported ON PURPOSE, and this is the only restatement in the file. A
 * check that a parser did its job cannot ask the parser what the answer was: importing
 * `STATE_BY_NAME` would make R1 agree with `geography.ts` by construction, including about a state
 * `geography.ts` cannot see. It is a fixed list of fifty-one facts about the United States, not a
 * behaviour, so it cannot drift out from under this test the way an implementation can.
 */
const STATE_BY_NAME: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};
const STATE_CODES = new Set(Object.values(STATE_BY_NAME));

/**
 * How many times a sentence names one state, by full name or by two-letter code.
 *
 * `washington` carries the second special case, and it is the one this rule's first draft got
 * wrong: "Resident of Atlantic Division (…), the Roanoke Division (…) … or Washington, D.C."
 * (James Cothran, KD3NI) names the DISTRICT, not the state, and reading it as Washington state
 * reported a defect on a record whose spec is correct. A rule that cries wolf on a correct record
 * is how a real offender gets waved through.
 */
function occurrencesOfState(text: string, code: string): number {
  const name = Object.keys(STATE_BY_NAME).find((k) => STATE_BY_NAME[k] === code);
  if (name === undefined) return 0;
  const byName =
    name === 'virginia'
      ? /(?<!west )\bvirginia\b/gi
      : name === 'washington'
        ? /\bwashington\b(?!\s*,?\s*d\.?\s?c)/gi
        : new RegExp(`\\b${name}\\b`, 'gi');
  return [...text.matchAll(byName)].length + [...text.matchAll(new RegExp(`\\b${code}\\b`, 'g'))].length;
}

function statesNamedIn(text: string): string[] {
  return [...STATE_CODES].filter((code) => occurrencesOfState(text, code) > 0);
}

/** Every state a single tier lets somebody live in. A county tier admits a county, not a state. */
function statesAdmittedByTier(geo: GeoSpec): string[] {
  if (geo.type === 'state') return geo.values;
  if (geo.type === 'arrl_division') return geo.values.flatMap(statesForArrlDivision);
  if (geo.type === 'arrl_section') return geo.values.flatMap(statesForArrlSection);
  return [];
}

function geoTiers(spec: ConstraintSpec): GeoSpec[] {
  return tiers(spec).flatMap((t) => (t.axis === 'geography' ? [t.geo] : []));
}

/**
 * A rule this axis cannot answer from a state name alone: a circle, a callsign property, or "any".
 * Skipped rather than guessed at — the point of this file is that a confident wrong answer is the
 * expensive kind.
 */
function decidableFromStates(spec: ConstraintSpec): boolean {
  return !geoTiers(spec).some((g) => g.type === 'radius' || g.type === 'call_district' || g.type === 'any');
}

/**
 * THE ONE EXEMPTION, AND WHY IT IS THIS NARROW. A state name in a county list can be a LOCATOR
 * rather than an alternative — "Residence in Central IL in one of these counties: Peoria,
 * Tazewell, …" says where the counties are, and Peoria's award is genuinely not open to every
 * Illinoisan. So a state is excused when the spec's own county values carry it.
 *
 * BUT ONLY WHEN THE SENTENCE NAMES IT ONCE. "Resident of Brevard County FL, OR ANY FL RESIDENT"
 * names Florida twice — once to place the county and once as a whole-state alternative — and the
 * refusal this file exists to catch lived in the difference. Without the count, the county
 * qualifier the SAME round added (`county: ['Brevard, FL']`) would have excused the very defect it
 * sits next to, and the rule would have been born already blind. The mutation proof below runs
 * exactly that shape.
 */
function statesUnadmitted(spec: ConstraintSpec, rawText: string): string[] {
  if (!decidableFromStates(spec)) return [];
  const admitted = new Set(geoTiers(spec).flatMap(statesAdmittedByTier));
  const locators = new Set(
    geoTiers(spec)
      .filter((g) => g.type === 'county')
      .flatMap((g) => g.values.map((v) => v.split(',')[1]?.trim()))
      .filter((s): s is string => s !== undefined && s !== ''),
  );
  return statesNamedIn(rawText).filter(
    (s) => !admitted.has(s) && !(locators.has(s) && occurrencesOfState(rawText, s) === 1),
  );
}

describe('R1 — a state the funder named, that no tier of the spec admits', () => {
  /**
   * HARD CONSTRAINTS ONLY, and the scope is the doctrine rather than convenience: a soft
   * constraint cannot refuse anybody, so a state missing from one costs a rank and not an award.
   * Five soft records in this corpus do have the gap — Gulf Coast, Hodges W6YOO, Wayne Nelson,
   * Warren K6OBS and Shenandoah Valley, each of them "preference to <county>; if no qualified
   * applicant, then <the whole state>" with the second tier dropped. They are recorded here in
   * words because they are real and worth someone's time, and they are NOT asserted, because
   * pinning a defect is what the test at the top of this file was doing.
   *
   * ROUND 8 — AND THE SECOND MECHANISM THAT CANNOT REFUSE. `hard` stopped being the same question
   * as "can this constraint produce an `ineligible`" when the cascade ladder landed: a hard
   * constraint carrying `orUnrepresented` is consulted exactly when every tier has failed, and the
   * answer there is `unknown`. `ConstraintAlternatives` states it as an invariant of the schema —
   * "`orUnrepresented` can only turn a `fail` into an `unknown`. Also never a refusal." — and
   * `disjunction.test.ts` proves it over this corpus by deleting the field and checking no verdict
   * improves. So those constraints are out of scope here for the SAME reason soft ones are, and
   * for no other: a state missing from one costs a rank or an unknown, never an award.
   *
   * The Shenandoah Valley ladder is the record this exempts, and it is the shape the paragraph
   * above already names: eight counties across Virginia AND West Virginia, whose fallback rung
   * widens only to Virginia. Its county tier admits all eight counties whatever state the applicant
   * is in, and a West Virginian outside them gets `unknown` rather than a refusal — which is
   * exactly what this rule exists to guarantee, arrived at by a different route.
   */
  it('no hard geography constraint leaves out a state its own sentence names', async () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'geography' || !c.hard) continue;
      if (c.spec.orUnrepresented !== undefined) continue;
      if (!decidableFromStates(c.spec) || statesNamedIn(c.rawText).length === 0) continue;
      checked += 1;
      const missing = statesUnadmitted(c.spec, c.rawText);
      if (missing.length > 0) {
        offenders.push(`${program.name}: names ${missing.join(',')} — ${JSON.stringify(c.rawText.slice(0, 140))}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: the rule really has 40 hard constraints to be wrong about.
    expect(checked).toBe(40);
  });

  it('…and it catches all three of the specs that were published before this round', () => {
    const geo = (g: GeoSpec): ConstraintSpec => ({ axis: 'geography', geo: g });
    // Exactly what the corpus held at dc9868b, sentence and all.
    expect(
      statesUnadmitted(geo({ type: 'county', values: ['Brevard'] }), 'Resident of Brevard County FL, or any FL resident'),
    ).toEqual(['FL']);
    expect(
      statesUnadmitted(geo({ type: 'county', values: ['Gwinnett'] }), 'Resident of Gwinnett County GA, or the State of GA'),
    ).toEqual(['GA']);
    expect(
      statesUnadmitted(
        geo({ type: 'arrl_section', values: ['North Texas'] }),
        'Applicant must have graduated high school located within the North Texas Section. Additional ' +
          'applicants to be considered: and Oklahoma residents attending school in Texas or another state.',
      ),
    ).toEqual(['OK']);

    // AND THE REGRESSION THE COUNTY-QUALIFIER FIX COULD HAVE HIDDEN: today's county value, with
    // the alternative deleted. The sentence still says "or any FL resident", so it is still caught.
    expect(
      statesUnadmitted(geo({ type: 'county', values: ['Brevard, FL'] }), 'Resident of Brevard County FL, or any FL resident'),
    ).toEqual(['FL']);

    // …while a state named ONCE, to place the counties, is not a second tier and must not be read
    // as one. Peoria's award is genuinely closed to most of Illinois.
    expect(
      statesUnadmitted(
        geo({ type: 'county', values: ['Peoria, IL', 'Fulton, IL'] }),
        'Residence in Central IL in one of these counties: Peoria, Tazewell, Woodford, Knox, McLean, Fulton, Logan, Marshall or Stark',
      ),
    ).toEqual([]);
  });
});

/**
 * A REGION NAME IS A LIST OF STATES, and one the parser does not know is a silent bar. "New
 * England" is the only region this corpus states as a bare region rather than as an ARRL Division
 * or an explicit list; every other region word in it ("Midwest", "Northwest", "Southeastern") is a
 * real Division name that `arrlSections.ts` resolves, and R1 already covers those because their
 * sentences spell the states out.
 */
const NEW_ENGLAND = ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'];

describe('R2 — a region the funder named, resolved to fewer states than it has', () => {
  it('every record whose sentence says "New England" admits all six New England states', async () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'geography' || !/\bnew england\b/i.test(c.rawText)) continue;
      if (!decidableFromStates(c.spec)) continue;
      checked += 1;
      const admitted = new Set(geoTiers(c.spec).flatMap(statesAdmittedByTier));
      const missing = NEW_ENGLAND.filter((s) => !admitted.has(s));
      if (missing.length > 0) offenders.push(`${program.name}: missing ${missing.join(',')}`);
    }
    expect(offenders).toEqual([]);
    // Vacuity guard. Eight records say it; seven said it and were already right, which is what
    // made the eighth invisible.
    expect(checked).toBe(8);
  });

  it('…and it catches the Ware spec as it was published', () => {
    const ware: ConstraintSpec = { axis: 'geography', geo: { type: 'state', values: ['DE', 'MD', 'NJ', 'NY'] } };
    const admitted = new Set(geoTiers(ware).flatMap(statesAdmittedByTier));
    expect(NEW_ENGLAND.filter((s) => !admitted.has(s))).toEqual(NEW_ENGLAND);
  });
});

// =============================================================== R3: a duration on one branch

const LICENCE_CLASS_WORDS =
  /\b(amateur extra|extra class|extra|general class|general|technician class|technician|novice)\b/gi;
const HELD_DURATION =
  /\b(?:for|held|licensed)\b[^.]{0,40}?\b(?:one|two|three|four|five|six|twelve|\d+)[\s-]*(?:year|month)s?\b/gi;

/**
 * TRUE WHEN THE SENTENCE PUTS ITS DURATION AFTER THE WHOLE ALTERNATION, so the duration governs
 * every class named and one tier can hold the lot.
 *
 * This is the distinction that makes R3 a rule rather than a second parser, and getting it wrong
 * in either direction is a real cost. Two corpus sentences name two classes and a duration:
 *
 *   Tortorella  "General Class OR Extra Class active Amateur Radio License, MUST HAVE BEEN
 *                LICENSED FOR AT LEAST THREE YEARS"   — duration last: it governs both. One tier
 *                is correct, and demanding an `anyOf` here would be inventing a route that lets an
 *                Extra of one month in against the funder's plain words.
 *   Ware        "Must hold a current General Class License FOR AT LEAST TWO YEARS or more before
 *                application submission, OR HOLD A CURRENT AMATEUR EXTRA CLASS LICENSE" — a class
 *                named AFTER the duration, so the duration is not the last word and cannot govern
 *                it. One tier hard-refused an Amateur Extra of six months, which is exactly the
 *                applicant that clause was written to admit.
 *
 * Position, not vocabulary: no list of phrasings to keep in step, and it reads the funder's own
 * word order, which is where the scope of a duration actually lives.
 */
function durationGovernsEveryClass(rawText: string): boolean {
  const classes = [...rawText.matchAll(LICENCE_CLASS_WORDS)];
  const durations = [...rawText.matchAll(HELD_DURATION)];
  if (classes.length === 0 || durations.length === 0) return true;
  const lastClass = classes[classes.length - 1].index ?? 0;
  const lastDuration = durations[durations.length - 1].index ?? 0;
  return lastDuration > lastClass;
}

function distinctClassesNamed(rawText: string): string[] {
  return [
    ...new Set(
      [...rawText.matchAll(LICENCE_CLASS_WORDS)].map((m) =>
        /extra/i.test(m[1]) ? 'EXTRA' : /general/i.test(m[1]) ? 'GENERAL' : /novice/i.test(m[1]) ? 'NOVICE' : 'TECH',
      ),
    ),
  ];
}

/** The shape R3 forbids: two classes, a duration that governs only the first, and one tier. */
function durationLeaksAcrossBranches(spec: ConstraintSpec, rawText: string): boolean {
  if (spec.axis !== 'license' || spec.heldMonthsMin === undefined || spec.heldMonthsMin <= 0) return false;
  if (distinctClassesNamed(rawText).length < 2) return false;
  if (durationGovernsEveryClass(rawText)) return false;
  return (spec.anyOf ?? []).length === 0;
}

describe('R3 — a duration the sentence put on one branch, applied to both', () => {
  it('no licence constraint holds a duration the sentence does not put last', async () => {
    const offenders: string[] = [];
    let withTwoClasses = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'license') continue;
      if (distinctClassesNamed(c.rawText).length < 2) continue;
      withTwoClasses += 1;
      if (durationLeaksAcrossBranches(c.spec, c.rawText)) {
        offenders.push(`${program.name}: ${JSON.stringify(c.rawText.slice(0, 150))}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: four sentences in the corpus name two or more licence classes — NEAR-Fest
    // (three, in preference order), Tortorella, You've Got a Friend in Pennsylvania, and Ware.
    // Only Ware carries a duration the sentence does not put last, and only Ware has an `anyOf`.
    expect(withTwoClasses).toBe(4);
  });

  it('…and it catches the Ware spec as it was published, without touching Tortorella', () => {
    const wareText =
      'Must hold a current General Class License for at least two years or more before application ' +
      'submission, or hold a current Amateur Extra Class License';
    expect(durationLeaksAcrossBranches({ axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 24 }, wareText)).toBe(true);
    // Today's spec, with the alternative the funder wrote: not an offender.
    expect(
      durationLeaksAcrossBranches(
        { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 24, anyOf: [{ axis: 'license', licenseMin: 'EXTRA' }] },
        wareText,
      ),
    ).toBe(false);
    // THE OTHER DIRECTION, which is what stops this rule unrestricting the corpus. Tortorella's
    // duration is the last thing the sentence says, so it governs both classes and one tier is the
    // honest reading — an Amateur Extra of one month is correctly refused.
    expect(
      durationLeaksAcrossBranches(
        { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 36 },
        'General Class or Extra Class active Amateur Radio License, must have been licensed for at least three years',
      ),
    ).toBe(false);
  });
});

// =============================================================== R4 + R5: audiences and levels

/**
 * Sentence shape -> the value an allow-list must therefore contain. Written as rules rather than
 * as a list of program names, so a new record arriving with a new spelling is checked by the rule
 * and not by whether anybody remembered to add it. `highschool` as one word is in here because
 * that spelling is what the Goldwater defect was made of.
 */
const AUDIENCE_RULES: Array<{ says: RegExp; mustAllow: string; label: string }> = [
  { says: /\b(?:graduating\s+)?high[\s-]?school\s+seniors?\b/i, mustAllow: 'HS_SENIOR', label: 'high-school seniors' },
  { says: /\bundergraduate\s+students?\b|\bundergraduates\b/i, mustAllow: 'UNDERGRAD', label: 'undergraduate students' },
  { says: /\bgraduate\s+students?\b/i, mustAllow: 'GRAD', label: 'graduate students' },
  { says: /\b(?:military\s+)?veterans?\b/i, mustAllow: 'VETERAN', label: 'veterans' },
];

const LEVEL_RULES: Array<{ says: RegExp; mustAllow: string; label: string }> = [
  { says: /\bcertificat(?:e|ion)\b|\bvocational\b/i, mustAllow: 'CERT', label: 'a certificate programme' },
  // "2- OR 4-YEAR" is how the corpus's clearest case (CWops) actually writes it, and the elided
  // "year" after the 2 is exactly the shape a naive `\b2[\s-]?year\b` misses — which would have
  // left this rule blind to the sentence it was written for.
  { says: /\bassociate(?:'s)?\b|\b(?:2|two)[\s-]*(?:-\s*)?(?:or\s+\d[\s-]*)?years?\b|\bcommunity college\b/i, mustAllow: 'ASSOC', label: 'a two-year programme' },
  { says: /\bbachelor|\bundergraduate\b|\b4[\s-]?year\b|\bfour[\s-]?year\b/i, mustAllow: 'BACH', label: 'a four-year degree' },
  { says: /\bgraduate school\b|\bmaster(?:'s)?\b|\bdoctora|\bph\.?d\b|\bpost[\s-]?graduate\b/i, mustAllow: 'GRAD', label: 'graduate study' },
];

/**
 * The allow-list a spec publishes on one axis, across every tier — plus the marker that says the
 * funder named a route this schema cannot describe.
 *
 * `orUnrepresented` is an accepted answer here and that is deliberate. Robert A. Rodriguez K5AUW is
 * "open to graduating high school seniors, AND TO PREVIOUS AWARDEES", and "previous awardee" is not
 * a `Stage`; inventing one would put an audience in the record no funder wrote. Declining to decide
 * is the honest third answer, and it is not a refusal, so it satisfies this rule.
 */
function allowListSatisfies(spec: ConstraintSpec, key: 'stages' | 'degreeLevels', value: string): boolean {
  if (spec.orUnrepresented !== undefined) return true;
  return tiers(spec).some((t) => {
    const list = (t as unknown as Record<string, unknown>)[key];
    return Array.isArray(list) && (list as string[]).includes(value);
  });
}

/**
 * THE ONE THING A PREFERENCE MAY LEAVE OUT: THE EXCEPTION TO ITSELF.
 *
 * This rule exists because a missing stage is a SILENT BAR — `spec.stages` is an allow-list and
 * the matcher refuses whoever is not on it. That harm is real for a HARD constraint and does not
 * exist for a soft one, which can refuse nobody; there, the same list answers a different
 * question ("whom does this funder say it prefers?"), and a positive "you meet this preference",
 * with the rank that comes with it, is a claim of its own.
 *
 *   MARCO  "Preference will be given to undergraduate students and those in certificate programs,
 *           BUT graduate students MAY APPLY."
 *
 * A graduate student here is tolerated, not preferred, and publishing GRAD in that soft list told
 * every one of them the funder preferred them. So a preference may omit an audience its sentence
 * names only when the sentence names it AFTER a concessive — and the check is written here from
 * the English rather than imported from `ageStage.ts`, so a production rule that quietly widened
 * its own vocabulary would show up as an offender instead of excusing itself.
 *
 * The exemption is available to soft constraints only. A hard list that drops an audience is the
 * Goldwater defect whatever punctuation precedes it, and the case below proves the exemption
 * cannot reach it.
 */
const CONCESSIVE_EXCEPTION = /\b(?:but|however|although|though)\b/i;

function namedOnlyAsAnException(rawText: string, says: RegExp): boolean {
  const marker = CONCESSIVE_EXCEPTION.exec(rawText);
  if (marker === null) return false;
  return !says.test(rawText.slice(0, marker.index));
}

describe('R4 — an audience the funder named, missing from the stage list', () => {
  it('no stage list drops an audience its own sentence names', async () => {
    const offenders: string[] = [];
    let claims = 0;
    let exceptions = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'age_stage' || c.spec.stages.length === 0) continue;
      for (const rule of AUDIENCE_RULES) {
        if (!rule.says.test(c.rawText)) continue;
        claims += 1;
        if (allowListSatisfies(c.spec, 'stages', rule.mustAllow)) continue;
        if (!c.hard && namedOnlyAsAnException(c.rawText, rule.says)) {
          exceptions += 1;
          continue;
        }
        offenders.push(
          `${program.name}: names "${rule.label}" but publishes ${JSON.stringify(c.spec.stages)} — ` +
            JSON.stringify(c.rawText.slice(0, 140)),
        );
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: 19 audience claims across the corpus's stage constraints.
    expect(claims).toBe(19);
    // …and exactly one of them is a preference declining to claim its own exception (MARCO).
    expect(exceptions).toBe(1);
  });

  it('the exception clause is an exception, not a hole in the rule', () => {
    const graduates = AUDIENCE_RULES.find((r) => r.mustAllow === 'GRAD')?.says;
    if (graduates === undefined) throw new Error('the graduate-students rule is missing');
    // MARCO's sentence names graduate students only behind its "but", so a preference may omit them.
    expect(
      namedOnlyAsAnException(
        'Preference will be given to undergraduate students and those in certificate programs, ' +
          'but graduate students may apply.',
        graduates,
      ),
    ).toBe(true);
    // A sentence that names the audience in its own right is not excused by a later "but".
    expect(
      namedOnlyAsAnException(
        'Open to graduate students, but the award is paid to the institution.',
        graduates,
      ),
    ).toBe(false);
    // Nor is a sentence with no concessive at all.
    expect(namedOnlyAsAnException('Open to graduate students.', graduates)).toBe(false);
  });

  it('…and it catches the Goldwater spec as it was published', () => {
    const goldwater: ConstraintSpec = { axis: 'age_stage', stages: ['UNDERGRAD'] };
    const sentence =
      'Applicant must be a US citizen, open only to graduating highschool seniors and undergraduate students;';
    const rule = AUDIENCE_RULES.find((r) => r.mustAllow === 'HS_SENIOR')!;
    // The sentence names them — with the one-word spelling that caused the defect...
    expect(rule.says.test(sentence)).toBe(true);
    // ...and the published spec did not.
    expect(allowListSatisfies(goldwater, 'stages', 'HS_SENIOR')).toBe(false);
    expect(allowListSatisfies({ axis: 'age_stage', stages: ['HS_SENIOR', 'UNDERGRAD'] }, 'stages', 'HS_SENIOR')).toBe(true);
  });
});

describe('R5 — a degree level the funder named, missing from the level list', () => {
  it('no degree-level list drops a level its own sentence names', async () => {
    const offenders: string[] = [];
    let claims = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'institution' || c.spec.degreeLevels.length === 0) continue;
      for (const rule of LEVEL_RULES) {
        if (!rule.says.test(c.rawText)) continue;
        claims += 1;
        if (allowListSatisfies(c.spec, 'degreeLevels', rule.mustAllow)) continue;
        offenders.push(
          `${program.name}: names ${rule.label} but publishes ${JSON.stringify(c.spec.degreeLevels)} — ` +
            JSON.stringify(c.rawText.slice(0, 140)),
        );
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: 67 level claims, on the largest hard-bar axis in this corpus (122 hard
    // institution constraints). It was 39 until the ASSOC pattern learned to read "2- or 4-year";
    // the eight sentences that phrasing added are all satisfied, which is the answer that makes
    // widening the pattern safe to keep. It was 47 until round nine read a bare "4-year college or
    // university" as a floor at the bachelor rather than as `degreeLevels: []`: those 20 records
    // used to be skipped by the `degreeLevels.length === 0` guard one line up — an empty list
    // never drops a level because it never holds one — and each now makes exactly one BACH claim,
    // every one of them satisfied — a floor that had come in BELOW the bachelor (say `['ASSOC']`,
    // or a `['GRAD']` read off "university") would put all 20 into `offenders` above. The 13
    // sibling records reading "2- or 4-year college or university" are still skipped by that same
    // guard, which is the shape of the fix: they name a two-year route themselves, so they keep
    // an empty list and this rule has nothing to check.
    expect(claims).toBe(67);
  });

  it('…and it catches a two-year school published as a bachelor-only bar', () => {
    const sentence = 'Fully accredited educational institution of higher learning, 2- or 4-year, undergraduate, graduate or post-graduate';
    const narrowed: ConstraintSpec = {
      axis: 'institution', degreeLevels: ['BACH'], tradeSchoolOK: true, partTimeOK: true, accreditationRequired: true,
    };
    expect(LEVEL_RULES.find((r) => r.mustAllow === 'ASSOC')!.says.test(sentence)).toBe(true);
    expect(allowListSatisfies(narrowed, 'degreeLevels', 'ASSOC')).toBe(false);
  });
});

// =============================================================== R6: the funder's own "etc."

/**
 * The phrasings a funder uses to say their own list is illustrative. Deliberately the STRICT
 * subset — bare "including" is absent, for the reason `matcher.ts`'s `OPEN_LIST_MARKERS` gives:
 * "Engineering degrees, including electrical and computer" is a list with examples of itself, not
 * an invitation past it.
 */
const ILLUSTRATIVE =
  /\bnot (?:necessarily |strictly |solely |exclusively )?(?:limited|restricted|confined) to\b|\bincluding but not\b|\bsuch as\b|\bfor example\b|\bfor instance\b|\be\.?\s?g\.?\b|\b(?:among|and|or) others\b|\betc\b|\band the like\b|\bwithout limitation\b|\bnot (?:an? )?exhaustive\b|\band more\b/i;

/** Exclusion is the strict direction: examples of what is BARRED are not an invitation. */
const EXCLUSION_INTRO =
  /\b(?:except|excepting|excluding|exclusive of|other than|not eligible|ineligible|does not include|do not include|with the exception)\b/i;

/**
 * An applicant who holds every credential and does none of the enumerated things. Whatever a
 * constraint bars them on is the constraint's own enumeration — which is the thing an
 * illustrative list may not do.
 */
const OFF_LIST_APPLICANT: StudentProfile = {
  kind: 'student', callsign: 'K5EXAMPLE', licenseClass: 'EXTRA', licensedSince: '1990-01-01T00:00:00.000Z',
  state: 'TX', county: 'Travis', callDistrict: '5', lat: 30.27, lon: -97.74,
  fieldOfStudy: 'Basket Weaving', degreeLevel: 'BACH', accredited: true, partTime: false,
  gpa: 4.0, classRankTopPct: 1, arrlMemberSince: '1990-01-01T00:00:00.000Z',
  citizenship: 'US_CITIZEN', birthDate: '2004-01-01T00:00:00.000Z', stage: 'UNDERGRAD',
  activityKinds: ['public_service'], cwWpm: 60, financialNeed: true, gender: 'female',
};

/**
 * THREE WAYS TO BE OFF THE LIST, AND THE FIXTURE ABOVE IS ONLY ONE OF THEM.
 *
 * `OFF_LIST_APPLICANT` carries `activityKinds: ['public_service']` — somebody who answered the
 * question, with something. The two applicants round seven's over-claim actually reached were the
 * one whose `activityKinds` is `[]` ("none of these") and the one who was never asked, and neither
 * was in this rule's reach: R6 probed one profile, so the empty and unset cases — the ones that
 * came out `eligible` — were never run against a single corpus record.
 *
 * A rule whose fixture cannot reach the failure it exists to catch is the defect class this
 * project has now found seven times. The sweep below runs all three, so the rule has 60 chances to
 * be wrong instead of 20. The MIRROR of this claim — that none of the three may come out `pass`
 * either — is in `sentence-vs-spec.test.ts`, which is where the widening direction lives.
 */
const OFF_LIST_APPLICANTS: Array<{ label: string; profile: StudentProfile }> = [
  { label: 'stated an activity, none of them listed', profile: OFF_LIST_APPLICANT },
  { label: 'answered "none of these"', profile: { ...OFF_LIST_APPLICANT, activityKinds: [] } },
  { label: 'never asked', profile: { ...OFF_LIST_APPLICANT, activityKinds: undefined } },
];

describe('R6 — the funder called their own list illustrative, and it refused somebody anyway', () => {
  it('no constraint whose sentence opens its own list can produce a refusal', async () => {
    const offenders: string[] = [];
    let checked = 0;
    let probes = 0;
    for (const { program, c } of await everyConstraint()) {
      const eligibleHalf = c.rawText.split(EXCLUSION_INTRO)[0];
      if (!ILLUSTRATIVE.test(eligibleHalf)) continue;
      // A funder who opened their list AND wrote an exclusion still means the exclusion.
      if (c.spec.axis === 'field_of_study' && c.spec.excludedFields.length > 0) continue;
      checked += 1;
      for (const { label, profile } of OFF_LIST_APPLICANTS) {
        probes += 1;
        if (evaluateConstraint(c.spec, profile, NOW, c.rawText).status === 'fail') {
          offenders.push(`${program.name} [${c.spec.axis}] (${label}): ${JSON.stringify(c.rawText.slice(0, 140))}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: 20 constraints in the corpus carry the funder's own widening…
    expect(checked).toBe(20);
    // …and each is asked by all three off-list applicants, not just the one that has an answer.
    expect(probes).toBe(60);
  });

  it('…and it catches the two activity lists that were hardened, on the sentences they came from', () => {
    // CARA: "…GOTA, Field Day, etc." — a club member who does none of the three was refused.
    const cara: ConstraintSpec = { axis: 'ham_activity', activityKinds: ['on_air', 'field_day'], proofRequired: false };
    const caraText = 'Participation in amateur radio activities: contesting, GOTA, Field Day, etc.';
    expect(ILLUSTRATIVE.test(caraText)).toBe(true);
    // With the funder's sentence the axis stops REFUSING; strip the widening and the bar returns,
    // so the withheld refusal comes from the funder's word and not from the axis giving up.
    expect(evaluateConstraint(cara, OFF_LIST_APPLICANT, NOW, caraText).status).toBe('unknown');
    expect(evaluateConstraint(cara, OFF_LIST_APPLICANT, NOW, 'Participation in Field Day.').status).toBe('fail');
    // Not refusing is not the same as admitting. This applicant does nothing on CARA's list, so
    // the honest answer is that nobody can tell — and, since they HAVE stated their activities,
    // there is nothing left for them to fill in that would settle it.
    expect(evaluateConstraint(cara, OFF_LIST_APPLICANT, NOW, caraText).missing).toEqual([]);

    // And the same rule reading a spec that was never widened at all: the historical shape.
    const hardened: ConstraintSpec = { axis: 'ham_activity', activityKinds: ['club_member'], proofRequired: false };
    expect(evaluateConstraint(hardened, OFF_LIST_APPLICANT, NOW, 'Applicant must be a member of a radio club.').status).toBe('fail');
  });
});

// =============================================================== R7: an idiom is not a field

/**
 * A RELATEDNESS IDIOM IS NOT A MEMBER OF THE LIST IT SITS IN — and this rule is the only one in
 * this file that was RED when it was written.
 *
 * `matcher.ts` matches a field by stemmed word overlap. "or similar scientific field" therefore
 * admits only an applicant who writes "similar", "scientific" or "field" in their own major, i.e.
 * almost nobody — so an entry the funder wrote to WIDEN their list ends up narrowing it. Nineteen
 * records in this corpus carry such an entry. Eighteen were already handled, by one of the two
 * routes the product has for them:
 *
 *   "or related fields"        -> `isFieldWideningMarker` (matcher.ts): the list opens, pass.
 *   "Technology-related field" -> `namesADomain` (fieldOfStudy.ts): `orUnrepresented`, unknown.
 *
 * The nineteenth fell through both. `namesADomain` knew `related` but not its synonym `similar`,
 * and knew `science` but not its adjective `scientific`, so "similar scientific field" reduced to
 * "similar scientific", which is in no domain set. THE CHICK ALLEN, NW3Y, SCHOLARSHIP hard-refused
 * 16 of 20 probed majors — Physics, Chemistry, Biology and Astronomy among them — while displaying
 * "Electronics, Electrical Engineering, Aerospace Engineering, Computer Science OR SIMILAR
 * SCIENTIFIC FIELD" as the evidence. A physics student read "or similar scientific field" directly
 * above the word "no".
 *
 * Fixed in the same commit as this test, in `fieldOfStudy.ts`, by adding `similar` beside `related`
 * in `ENTRY_SCAFFOLDING` and `scientific` beside `science` in `UNADJUDICABLE_DOMAINS` — each one
 * the exact analogue of a word already in the same list, and each one changing exactly this one
 * entry in the whole corpus. The remedy is `orUnrepresented` and not widening: fail -> unknown,
 * never fail -> pass, so a music major is still not admitted to it.
 */
const RELATEDNESS_IDIOM = /\b(?:related|similar|comparable|allied|akin|associated|equivalent|analogous)\b/i;
const CLASS_OF_FIELDS_NOUN =
  /\b(?:fields?|disciplines?|areas?|subjects?|majors?|minors?|studies|study|programs?|courses?|careers?)\b/i;

function relatednessIdioms(spec: ConstraintSpec): string[] {
  if (spec.axis !== 'field_of_study') return [];
  return spec.fields.filter((f) => RELATEDNESS_IDIOM.test(f) && CLASS_OF_FIELDS_NOUN.test(f));
}

describe('R7 — a list entry that describes a CLASS of fields, used as a bar', () => {
  /**
   * Two probes, and both matter. The idiom must never be the reason for a refusal (it is an
   * invitation, and word overlap cannot adjudicate it) and it must never become a blanket pass
   * (a music major is not admitted to an award for scientific fields by the funder saying
   * "similar"). `unknown` is the third answer, and it is the one this product is built to give.
   */
  it('no field list refuses an applicant on the strength of a relatedness idiom', async () => {
    const refusals: string[] = [];
    const blankets: string[] = [];
    let checked = 0;
    for (const { program, c } of await everyConstraint()) {
      const idioms = relatednessIdioms(c.spec);
      if (idioms.length === 0) continue;
      if (c.spec.axis === 'field_of_study' && c.spec.excludedFields.length > 0) continue;
      checked += 1;
      const insider = evaluateConstraint(c.spec, { kind: 'student', fieldOfStudy: 'Physics' }, NOW, c.rawText).status;
      const outsider = evaluateConstraint(
        c.spec, { kind: 'student', fieldOfStudy: 'Music Performance' }, NOW, c.rawText,
      ).status;
      if (insider === 'fail') refusals.push(`${program.name}: ${JSON.stringify(idioms)} refuses Physics`);
      // A widening the FUNDER wrote may pass anybody — that is `or related fields`, and it is their
      // choice. What may not happen is an entry becoming a pass with no widening in the sentence.
      if (outsider === 'pass' && !ILLUSTRATIVE.test(c.rawText) && !/\b(?:or|and) (?:a |an |any )?(?:closely |otherwise )?(?:related|similar)\b/i.test(c.rawText)) {
        blankets.push(`${program.name}: ${JSON.stringify(idioms)} admits a music major with no widening`);
      }
    }
    expect(refusals).toEqual([]);
    expect(blankets).toEqual([]);
    // Vacuity guard: 19 records carry a relatedness idiom in their field list.
    expect(checked).toBe(19);
  });

  it('…and it catches the Chick Allen spec as it was published, four hours before this test', () => {
    const sentence =
      'Electronics, Electrical Engineering, Aerospace Engineering, Computer Science or similar scientific field';
    const asPublished: ConstraintSpec = {
      axis: 'field_of_study',
      fields: ['Electronics', 'Electrical Engineering', 'Aerospace Engineering', 'Computer Science', 'similar scientific field'],
      excludedFields: [],
    };
    expect(relatednessIdioms(asPublished)).toEqual(['similar scientific field']);
    expect(evaluateConstraint(asPublished, { kind: 'student', fieldOfStudy: 'Physics' }, NOW, sentence).status).toBe('fail');

    // What it says now, and the two halves of "honest" it has to satisfy at once.
    const fixed: ConstraintSpec = { ...asPublished, orUnrepresented: 'similar scientific field' };
    expect(evaluateConstraint(fixed, { kind: 'student', fieldOfStudy: 'Physics' }, NOW, sentence).status).toBe('unknown');
    expect(evaluateConstraint(fixed, { kind: 'student', fieldOfStudy: 'Music Performance' }, NOW, sentence).status).toBe('unknown');
    // The route the funder named first is untouched: an electronics student is plainly eligible.
    expect(evaluateConstraint(fixed, { kind: 'student', fieldOfStudy: 'Electronics' }, NOW, sentence).status).toBe('pass');
  });

  it('the record itself now says so, in the funder’s own words', async () => {
    const { programs } = await corpus();
    const chickAllen = programs.find((p) => p.name.includes('Chick Allen'));
    if (chickAllen === undefined) throw new Error('The Chick Allen, NW3Y, Scholarship is missing from the corpus');
    const field = chickAllen.constraints.find((c) => c.spec.axis === 'field_of_study');
    if (field === undefined || field.spec.axis !== 'field_of_study') {
      throw new Error('Chick Allen states a field requirement and it is missing');
    }
    // Asserted from the sentence first, then the spec — the shape chrome-scope.test.ts had to be
    // rewritten into. Change the funder's wording and the first line fails loudly; drop the
    // handling and the second does.
    expect(field.rawText).toContain('or similar scientific field');
    expect(field.spec.orUnrepresented).toBe('similar scientific field');
    // Verbatim, never a summary: the same guard unadjudicable.test.ts applies corpus-wide.
    expect(field.rawText).toContain(field.spec.orUnrepresented);
  });
});
