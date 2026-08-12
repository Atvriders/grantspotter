/**
 * DOES THE SENTENCE NAME EVERY VALUE THE SPEC ADMITS?
 *
 * `spec-vs-sentence.test.ts` reads in one direction only. All seven of its rules detect a spec
 * NARROWER than the sentence printed beside it — a state the funder named and no tier admits, a
 * region resolved to too few states, an audience missing from an allow-list. Not one of them
 * detects a spec WIDER. The proof is cheap and was run: plant an extra state in the New England
 * expansion the funder never wrote, and R1 through R7 all stay green. The only thing that stops it
 * is a `toHaveLength(10)` value pin on that one record — which protects one record, by pinning a
 * parse, which is the thing that file's own header says a test must not do.
 *
 * That blindness is not academic. It is the exact shape round seven shipped: an opened list read
 * as a `pass`, so CARA, ARDC and CWops each asserted eligibility for an applicant on none of the
 * kinds they name. The narrowing guard was live and green throughout, because a false include is
 * invisible to a rule that only looks for false excludes.
 *
 * ============================= WHY BOTH DIRECTIONS ARE ERRORS =============================
 * `matcher.ts` is right that they are not symmetric — "a false exclude hides the money forever,
 * silently", and a student wrongly told no never applies and never learns. That is why this
 * product prefers `unknown` to a confident wrong `ineligible`.
 *
 * But `unknown` is the preferred answer, not `pass`. A student wrongly told YES spends an
 * application, a transcript fee, three recommendation letters and a month of waiting on money the
 * funder was never going to give them, and finds out by silence. `unknown` costs them neither: the
 * door stays open and nothing is claimed on their behalf.
 *
 * So this file asks the mirror question, on every axis that publishes an ALLOW-LIST or a FLOOR —
 * the two shapes a spec can be too wide in:
 *
 *   W1  a STATE a geography tier admits that the sentence never names
 *   W2  a STAGE the audience list admits that the sentence never names
 *   W3  a DEGREE LEVEL the level list admits that the sentence never names
 *   W4  an ACTIVITY KIND the activity list admits that the sentence never names
 *   W5  a LICENCE FLOOR below the lowest class the sentence names
 *   W6  a CITIZENSHIP the allow-list admits that the sentence never names
 *   W7  a FIELD in the list that appears nowhere in the sentence
 *   W8  a GPA FLOOR below the number the sentence names
 *
 * ================================ HOW EACH RULE IS BUILT =================================
 * Same three obligations as the narrowing file, because they are what made it worth having:
 *
 *   1. NEVER NAME A VALUE. The corpus rule reads every constraint and compares the spec to its own
 *      `rawText`. It fails when the two disagree, not when either changes.
 *   2. A VACUITY GUARD. "Offenders is empty" is green against a rule that matches nothing, so each
 *      rule also pins how many constraints and how many VALUES it had the chance to be wrong
 *      about. A rule whose fixture cannot reach the failure it exists to catch is the defect class
 *      this project has now found seven times — see the R6 note at the foot of this file.
 *   3. A MUTATION PROOF, and the OPPOSITE one beside it. Each rule is run against a planted
 *      over-claim and must flag it; and against the widest reading the sentence genuinely
 *      supports, where it must stay silent. The second half is not decoration. A rule that cries
 *      wolf gets an exemption bolted on, and the exemption is where the real offender walks
 *      through — `statesUnadmitted`'s county qualifier in the other file is that exact story.
 *
 * WHAT "THE SENTENCE NAMES IT" MEANS, and why the vocabularies below are written out here rather
 * than imported from the extractors: importing would make each rule agree with the parser by
 * construction, including about a value the parser cannot see. These are lists of facts about
 * English and about the United States, not behaviours, so they cannot drift out from under the
 * test the way an implementation can. Every one of them is deliberately GENEROUS — it credits the
 * sentence with every reading a funder could have meant, so that anything it still flags is a
 * value no reading supports.
 */
import type {
  ActivityKind,
  Constraint,
  ConstraintSpec,
  DegreeLevel,
  GeoSpec,
  Program,
  StudentProfile,
} from '@grantspotter/core';
import {
  ARRL_DIVISIONS,
  evaluateConstraint,
  matchProgram,
  statesForArrlDivision,
  statesForArrlSection,
} from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../../../../../scripts/profile-corpus.js';

const NOW = '2026-08-02T00:00:00.000Z';

let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

async function everyConstraint(): Promise<Array<{ program: Program; c: Constraint }>> {
  const { programs } = await corpus();
  return programs.flatMap((program) => program.constraints.map((c) => ({ program, c })));
}

/** The base tier plus every alternative: the whole disjunction, which is what an applicant faces. */
function tiers(spec: ConstraintSpec): ConstraintSpec[] {
  return [spec, ...((spec.anyOf ?? []) as ConstraintSpec[])];
}

// ============================================================ W1: places

/**
 * The fifty states, DC and the five inhabited territories, because `statesForArrlDivision` emits
 * PR and VI and a rule that cannot spell them reports a defect on a record whose spec is right.
 * Restated rather than imported, for the reason the header gives.
 */
const PLACE_BY_NAME: Record<string, string> = {
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
  'puerto rico': 'PR', 'virgin islands': 'VI', guam: 'GU', 'american samoa': 'AS',
  'northern mariana islands': 'MP',
};

/**
 * ONE TYPO IS STILL A NAMING. The Indianapolis Amateur Radio Association writes its own division
 * out as "(Illinois, Indiana and Wisconsion)", and a rule that reads that as "Wisconsin is not
 * named" reports an over-claim on a record whose spec says exactly what the funder meant. So a
 * word within one edit of a state name counts as that state.
 *
 * Bounded at length >= 6 and single-word names only, because that is where it is safe: no two such
 * US place names are within one edit of each other, so this can never credit a sentence with a
 * state it does not mean. It cries wolf in neither direction, which is the whole requirement.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Does the sentence name this place, by full name, by code, or by a one-letter misspelling?
 *
 * Two special cases, both of them the difference between a rule and a false alarm:
 *   `virginia`   the word sits inside "West Virginia", so a WV-only sentence would read as VA.
 *   `washington` "or Washington, D.C." names the DISTRICT, not the state — the case that made
 *                R1's first draft report a defect on the James Cothran record, whose spec is
 *                correct about it.
 */
function sentenceNamesPlace(text: string, code: string): boolean {
  if (code === 'DC') {
    return /\bdistrict of columbia\b|\bwashington,?\s*d\.?\s?c\b|\bd\.\s?c\.?\b|\bDC\b/i.test(text);
  }
  const name = Object.keys(PLACE_BY_NAME).find((k) => PLACE_BY_NAME[k] === code);
  if (name === undefined) return false;
  const byName =
    name === 'virginia'
      ? /(?<!west )\bvirginia\b/i
      : name === 'washington'
        ? /\bwashington\b(?!\s*,?\s*d\.?\s?c)/i
        : new RegExp(`\\b${name.replace(/ /g, '\\s+')}\\b`, 'i');
  if (byName.test(text)) return true;
  if (new RegExp(`\\b${code}\\b`).test(text)) return true;
  if (name.length >= 6 && !name.includes(' ')) {
    return (text.toLowerCase().match(/[a-z]+/g) ?? []).some((w) => w.length >= 6 && withinOneEdit(w, name));
  }
  return false;
}

/** Every place a single tier lets somebody live in. A county tier admits a county, not a state. */
function placesAdmittedByTier(geo: GeoSpec): string[] {
  if (geo.type === 'state') return geo.values;
  if (geo.type === 'arrl_division') return geo.values.flatMap(statesForArrlDivision);
  if (geo.type === 'arrl_section') return geo.values.flatMap(statesForArrlSection);
  return [];
}

function geoTiers(spec: ConstraintSpec): GeoSpec[] {
  return tiers(spec).flatMap((t) => (t.axis === 'geography' ? [t.geo] : []));
}

const NEW_ENGLAND = ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'];

/**
 * A REGION NAME IS A NAMING OF EVERY STATE IN IT — but only when the funder left the region as a
 * name. This is the hinge of W1 and it is the mirror image of R2.
 *
 * "Residence in ARRL Rocky Mountain Division" names the division and nothing else, so ARRL's
 * published definition IS what the funder said, and all four states are named. But
 * "ARRL Southwestern Division (AZ, Los Angeles, Orange, San Diego, Santa Barbara)" is a funder who
 * wrote their own gloss, and the gloss is then the most specific thing they said about scope.
 * Crediting them with ARRL's wider definition would be putting a claim in the record they did not
 * make — which is the whole subject of this file.
 *
 * "Enumerated" is decided by POSITION, not by a list of phrasings: a place named within 140
 * characters after the region word is the funder glossing it. Same discipline as R3's duration
 * test — read the funder's word order, keep no vocabulary in step.
 */
const REGIONS: Array<{ words: RegExp; states: readonly string[]; label: string }> = [
  ...ARRL_DIVISIONS.map((d) => ({
    words: new RegExp(`\\b${d.replace(/ /g, '[\\s-]')}\\b`, 'i'),
    states: statesForArrlDivision(d),
    label: d,
  })),
  { words: /\bnew england\b/i, states: NEW_ENGLAND, label: 'New England' },
  // The two divisions this corpus abbreviates. "ARRL Northwest Division" is the Northwestern.
  { words: /\bnorthwest\b/i, states: statesForArrlDivision('Northwestern'), label: 'Northwest' },
  { words: /\bsouthwest\b/i, states: statesForArrlDivision('Southwestern'), label: 'Southwest' },
];

/**
 * The funder widening their own geography, which is theirs to do and is not an over-claim. CTRI's
 * "if no suitable applicant identified, APPLICANTS FROM ALL REGIONS WILL BE CONSIDERED" is a
 * sentence that names every state there is.
 */
const GEO_WIDENED =
  /\ball regions\b|\bany (?:state|region)\b|\bnationwide\b|\banywhere\b|\bany applicant\b|\ball (?:states|applicants)\b|\bany (?:U\.?S\.?|United States)\b/i;

/**
 * Every place the sentence names, outright or through a region it left as a name. Split out of
 * `placesUnnamed` unchanged so W10 can read the SAME reading of the same sentence: the two rules
 * are mirror halves of one question and must not be allowed to disagree about what was named.
 */
function placesNamed(rawText: string): Set<string> {
  const supported = new Set<string>();
  for (const code of Object.values(PLACE_BY_NAME)) {
    if (sentenceNamesPlace(rawText, code)) supported.add(code);
  }
  for (const region of REGIONS) {
    const at = region.words.exec(rawText);
    if (at === null) continue;
    const gloss = rawText.slice(at.index, at.index + 140);
    const glossed = Object.values(PLACE_BY_NAME).some((code) => sentenceNamesPlace(gloss, code));
    if (!glossed) for (const s of region.states) supported.add(s);
  }
  return supported;
}

function placesUnnamed(spec: ConstraintSpec, rawText: string): string[] {
  const geos = geoTiers(spec);
  // A circle or a callsign property cannot be answered from a place name; the point of this file
  // is that a confident wrong answer is the expensive kind.
  if (geos.some((g) => g.type === 'radius' || g.type === 'call_district' || g.type === 'any')) return [];
  if (GEO_WIDENED.test(rawText)) return [];
  const admitted = new Set(geos.flatMap(placesAdmittedByTier));
  if (admitted.size === 0) return [];
  const supported = placesNamed(rawText);
  return [...admitted].filter((s) => !supported.has(s)).sort();
}

/**
 * THE TWO RECORDS WHERE THE CORPUS ADMITS SOMEBODY ITS OWN SENTENCE DOES NOT NAME, and they are
 * pinned as a list that may only ever SHRINK. Both are hard constraints, so both are a live
 * `eligible` shown to a student the funder's own words exclude.
 *
 *   Charles N. Fisher   "ARRL Southwestern Division (AZ, LOS ANGELES, ORANGE, SAN DIEGO, SANTA
 *                        BARBARA)" — four ARRL SECTIONS, all of them in southern California. The
 *                        spec is `arrl_division: ['Southwestern']`, and `statesForArrlDivision`
 *                        flattens that to `['AZ','CA']`, so every Californian passes. Northern
 *                        California is the PACIFIC division; a Berkeley student is told they
 *                        qualify for an award whose own sentence lists four southern sections.
 *                        This is not an extractor bug. It is `statesForArrlDivision` being lossy
 *                        for the four states ARRL splits between divisions, and no value of
 *                        `GeoSpec` as it stands can say "southern California".
 *
 *   James Cothran KD3NI  "...the Southeastern Division (AL, FL, GA)". ARRL's Southeastern Division
 *                        also contains Puerto Rico and the US Virgin Islands, and the spec admits
 *                        both. The funder glossed all three of their divisions carefully — their
 *                        Atlantic gloss matches ARRL's sections exactly, and they add "or
 *                        Washington, D.C." by hand — so the omission is theirs and it is meant.
 *
 * WHY THEY ARE PINNED AND NOT FIXED HERE. The honest verdict for both is `unknown`: the funder's
 * words do not admit these applicants and do not refuse them either, and narrowing the spec to the
 * gloss would be the other error — CTRI's gloss of New England omits Massachusetts, which ARRL's
 * definition plainly contains, and intersecting there would refuse a real Massachusetts applicant
 * and take R2 red with it. There is no mechanism for "this tier is wider than the sentence, answer
 * `unknown`": `orUnrepresented` turns `fail` into `unknown` and cannot touch a `pass`. That is a
 * schema gap, it is reported in the round summary, and it is not something a test file may invent.
 *
 * A LIST, NOT A SKIP. Naming them costs the rule nothing — it still reads all 63 constraints and
 * all 246 admitted places — and it goes red in BOTH directions: red when a new record over-claims,
 * red when one of these two is fixed and the entry goes stale. That is the opposite of an
 * exemption, which is silent forever.
 */
const KNOWN_GEO_OVERCLAIMS = [
  'The Charles N. Fisher Memorial Scholarship: admits CA',
  'The James Cothran, KD3NI, Scholarship: admits PR,VI',
];

describe('W1 — a place the spec admits, that the funder never named', () => {
  it('no geography tier admits a state its own sentence does not name', async () => {
    const offenders: string[] = [];
    let checked = 0;
    let admittedValues = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'geography') continue;
      const admitted = new Set(geoTiers(c.spec).flatMap(placesAdmittedByTier));
      if (admitted.size === 0) continue;
      if (geoTiers(c.spec).some((g) => g.type === 'radius' || g.type === 'call_district' || g.type === 'any')) {
        continue;
      }
      if (GEO_WIDENED.test(c.rawText)) continue;
      checked += 1;
      admittedValues += admitted.size;
      const unnamed = placesUnnamed(c.spec, c.rawText);
      if (unnamed.length > 0) offenders.push(`${program.name}: admits ${unnamed.join(',')}`);
    }
    expect(offenders.sort()).toEqual(KNOWN_GEO_OVERCLAIMS);
    // Vacuity guard: 77 constraints, 287 admitted places. The rule had 287 chances to be wrong.
    //
    // 63 AND 246 UNTIL ROUND 8, when 14 cascade ladders were published beside the preferences they
    // came from. Those are the constraints most able to over-claim — each is a disjunction built
    // out of two or three rungs of one sentence — and the offender list did not grow by a single
    // entry, which is the claim worth having: every place a ladder admits is a place its own
    // funder named.
    expect(checked).toBe(77);
    expect(admittedValues).toBe(287);
  });

  it('…and it catches an extra state planted in the New England expansion', () => {
    const ware = 'Maryland, Delaware, New Jersey, New York, or New England';
    const honest: ConstraintSpec = {
      axis: 'geography',
      geo: { type: 'state', values: ['DE', 'MD', 'NJ', 'NY', ...NEW_ENGLAND] },
    };
    // The spec the funder's sentence supports, exactly: silent.
    expect(placesUnnamed(honest, ware)).toEqual([]);
    // One state more than the funder wrote — the mutation that walked past all seven rules of
    // spec-vs-sentence.test.ts and was stopped only by a length pin on this one record.
    const planted: ConstraintSpec = {
      axis: 'geography',
      geo: { type: 'state', values: ['DE', 'MD', 'NJ', 'NY', 'PA', ...NEW_ENGLAND] },
    };
    expect(placesUnnamed(planted, ware)).toEqual(['PA']);
  });

  it('…and a bare region name is a naming of every state in it', () => {
    // The funder said "Rocky Mountain Division" and left ARRL to define it. All four are named.
    const rocky: ConstraintSpec = { axis: 'geography', geo: { type: 'arrl_division', values: ['Rocky Mountain'] } };
    expect(placesUnnamed(rocky, 'Residence in ARRL Rocky Mountain Division (CO, NM, UT or WY)')).toEqual([]);
    expect(placesUnnamed(rocky, 'Residence in the ARRL Rocky Mountain Division')).toEqual([]);
    // A funder's own misspelling of their own division is still a naming.
    const central: ConstraintSpec = { axis: 'geography', geo: { type: 'arrl_division', values: ['Central'] } };
    expect(
      placesUnnamed(central, 'preference given to applicants from the ARRL Central Division (Illinois, Indiana and Wisconsion)'),
    ).toEqual([]);
    // And a funder who opens their geography has named everywhere.
    expect(
      placesUnnamed(
        { axis: 'geography', geo: { type: 'arrl_division', values: ['New England'] } },
        'ARRL New England Division (Connecticut, Rhode Island, Vermont, Maine, New Hampshire); if no ' +
          'suitable applicant identified, applicants from all regions will be considered',
      ),
    ).toEqual([]);
  });

  it('…and the two known over-claims are real: each passes an applicant its sentence excludes', async () => {
    const { programs } = await corpus();
    const fisher = programs.find((p) => p.name.includes('Charles N. Fisher'));
    if (fisher === undefined) throw new Error('The Charles N. Fisher Memorial Scholarship is missing from the corpus');
    const geo = fisher.constraints.find((c) => c.spec.axis === 'geography');
    if (geo === undefined) throw new Error('Fisher states a geography requirement and it is missing');
    // Asserted from the sentence first: change the funder's wording and this line fails loudly.
    expect(geo.rawText).toContain('Southwestern Division');
    expect(geo.rawText).toContain('San Diego');
    // A student in northern California — the PACIFIC division — is told this is open to them.
    // WHEN THIS LINE GOES RED THE DEFECT IS FIXED: delete this case and the entry above.
    expect(evaluateConstraint(geo.spec, { kind: 'student', state: 'CA' }, NOW, geo.rawText).status).toBe('pass');
    // The route the funder named first is untouched and must stay so.
    expect(evaluateConstraint(geo.spec, { kind: 'student', state: 'AZ' }, NOW, geo.rawText).status).toBe('pass');
    expect(evaluateConstraint(geo.spec, { kind: 'student', state: 'OH' }, NOW, geo.rawText).status).toBe('fail');
  });
});

// ============================================================ W2 + W3: audiences and levels

/**
 * Every word a funder could use to name each audience — read GENEROUSLY, so that a stage this rule
 * still flags is one no reading of the sentence supports. `college` and `university` count for
 * UNDERGRAD because "a student at an accredited university" plainly names undergraduates.
 *
 * A bare "students" is deliberately NOT here. It would make UNDERGRAD unfalsifiable — nearly every
 * sentence on this axis contains it — and a rule that cannot fail is the thing this file exists to
 * replace.
 */
const STAGE_SAYS: Record<string, RegExp> = {
  HS_SENIOR: /\bhigh[\s-]?school\b|\bhighschool\b|\bsecondary school\b|\bK-?12\b|\bpre[\s-]?college\b|\b12th grade\b/i,
  UNDERGRAD:
    /\bundergraduate\b|\bundergrad\b|\bbachelor|\bbaccalaureate\b|\bfreshman\b|\bsophomore\b|\bcollege\b|\buniversity\b|\b(?:4|four)\s*-?\s*years?\b|\bassociate\b|\b(?:2|two)\s*-?\s*years?\b/i,
  GRAD: /\bgraduate\b|\bmaster|\bdoctora|\bph\.?d\b|\bpost[\s-]?graduate\b/i,
  VETERAN: /\bveterans?\b|\bmilitary\b|\barmed forces\b|\bservice ?members?\b/i,
  RETRAINING_ADULT:
    /\bretrain|\bcareer[\s-]?chang|\badult learner|\bre-?entry\b|\breturning\b|\bnon[\s-]?traditional\b|\bsecond career\b/i,
};

function stagesUnnamed(spec: ConstraintSpec, rawText: string): string[] {
  const admitted = [...new Set(tiers(spec).flatMap((t) => (t.axis === 'age_stage' ? t.stages : [])))];
  return admitted.filter((s) => !(STAGE_SAYS[s] ?? /$^/).test(rawText)).sort();
}

describe('W2 — an audience the stage list admits, that the funder never named', () => {
  it('no stage list admits an audience its own sentence does not name', async () => {
    const offenders: string[] = [];
    let checked = 0;
    let admittedValues = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'age_stage') continue;
      const admitted = new Set(tiers(c.spec).flatMap((t) => (t.axis === 'age_stage' ? t.stages : [])));
      if (admitted.size === 0) continue;
      checked += 1;
      admittedValues += admitted.size;
      const unnamed = stagesUnnamed(c.spec, c.rawText);
      if (unnamed.length > 0) {
        offenders.push(
          `${program.name}: admits ${unnamed.join(',')} — ${JSON.stringify(c.rawText.slice(0, 140))}`,
        );
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: 14 stage lists publishing 22 audiences between them.
    expect(checked).toBe(14);
    expect(admittedValues).toBe(22);
  });

  it('…and it catches an audience added to the Goldwater list that its sentence never names', () => {
    const sentence =
      'Applicant must be a US citizen, open only to graduating highschool seniors and undergraduate students;';
    // What the record says now: both audiences are in the sentence.
    expect(stagesUnnamed({ axis: 'age_stage', stages: ['HS_SENIOR', 'UNDERGRAD'] }, sentence)).toEqual([]);
    // A graduate student added to a sentence that says "OPEN ONLY TO" two other audiences. R4
    // cannot see this — a longer allow-list is never narrower than its sentence.
    expect(
      stagesUnnamed({ axis: 'age_stage', stages: ['HS_SENIOR', 'UNDERGRAD', 'GRAD'] }, sentence),
    ).toEqual(['GRAD']);
    // And an over-claim hidden in an `anyOf` sibling is reached too, because that is the tier an
    // applicant is actually evaluated against.
    expect(
      stagesUnnamed(
        { axis: 'age_stage', stages: ['HS_SENIOR'], anyOf: [{ axis: 'age_stage', stages: ['VETERAN'] }] },
        sentence,
      ),
    ).toEqual(['VETERAN']);
  });
});

const LEVEL_ORDER = ['CERT', 'ASSOC', 'BACH', 'GRAD'];

/** The rest of an `institution` tier held constant, so each case below varies only the levels. */
function institutionAdmitting(degreeLevels: DegreeLevel[]): ConstraintSpec {
  return { axis: 'institution', degreeLevels, tradeSchoolOK: true, partTimeOK: true, accreditationRequired: false };
}

/**
 * Read generously again, and note that "undergraduate" names BOTH of the undergraduate levels: an
 * associate degree is an undergraduate degree, so "an accredited undergraduate degree-granting
 * institution" cannot be an over-claim about ASSOC.
 */
const LEVEL_SAYS: Record<string, RegExp> = {
  CERT: /\bcertificat(?:e|ion)\b|\bvocational\b|\btrade\b|\btechnician\b|\btechnical school\b|\bprofessional school\b|\bdiploma\b|\blicensure\b/i,
  ASSOC:
    /\bassociate(?:'s)?\b|\b(?:2|two)\s*-?\s*(?:or\s+\d\s*-?\s*)?years?\b|\bcommunity college\b|\bjunior college\b|\bundergraduate\b|\bundergrad\b/i,
  BACH: /\bbachelor|\bbaccalaureate\b|\b(?:4|four)\s*-?\s*years?\b|\bundergraduate\b|\bundergrad\b/i,
  GRAD: /\bgraduate\b|\bmaster(?:'s)?\b|\bdoctora|\bph\.?d\b|\bpost[\s-]?graduate\b/i,
};

/**
 * "OR HIGHER" IS A NAMING OF EVERY RUNG ABOVE. Eleven records in this corpus say "Bachelor's
 * degree or higher", and reading that as naming only BACH would report a defect on every one of
 * them. It licenses the levels ABOVE the highest the sentence names outright, and nothing below —
 * so it can never excuse a certificate programme admitted by a sentence about doctorates.
 */
const OR_HIGHER = /\bor (?:higher|above|beyond|greater)\b|\band (?:higher|above)\b/i;

/**
 * A SCHOOL TIER IS NOT A CREDENTIAL, AND READING IT AS ONE IS WHAT MADE W3 AND W10 BOTH WRONG ABOUT
 * THE SAME TWENTY-SIX RECORDS.
 *
 * `LEVEL_SAYS` above reads bare year-phrases: "4-year" names BACH, "2-year" names ASSOC. That is
 * right about a CREDENTIAL — "a four-year degree" is a bachelor's — and wrong about a BUILDING. When
 * the year-phrase qualifies a school noun the funder has named a PLACE, and a place awards a BAND of
 * credentials, not one rung:
 *
 *   "4-year college or university"   awards BACH *and* GRAD. A master's candidate attends a
 *                                    four-year university; nobody earns a certificate there.
 *   "2-year / community / junior
 *    college"                        awards CERT *and* ASSOC. A certificate student at a community
 *                                    college is a student at a community college.
 *   "trade / vocational / technical
 *    school"                         awards CERT — already read by `LEVEL_SAYS.CERT`.
 *
 * Both halves of that fact were load-bearing and both were missing, in opposite directions:
 *
 *   UPWARD, W3 flagged 20 records as over-claims for admitting GRAD under "4-year college or
 *   university" — every record the round-nine floor fix had just corrected. They are not over-claims.
 *   The funder named the building a graduate student studies in.
 *
 *   DOWNWARD, W10 accused 6 records of enforcing nothing because they did not refuse a CERTIFICATE
 *   student under "Any accredited 2- or 4-year college or university". That accusation was false:
 *   the union of the two tiers is the whole ladder, so there is no rung the sentence puts outside,
 *   and `degreeLevels: []` is the honest record of a funder who barred nobody by credential. Six
 *   entries of `KNOWN_TOOTHLESS` were a rule crying wolf, pinned as a product defect.
 *
 * This is a fact about American higher education, restated here rather than imported, for the reason
 * the header gives — `institution.ts` reaches the same reading through `statesAFourYearFloor`, and
 * the two must be able to disagree or neither is evidence about the other.
 */
const SCHOOL_NOUN = String.raw`(?:colleges?|universit(?:y|ies)|institutions?|schools?)`;
const FOUR_YEAR_SCHOOL = new RegExp(
  String.raw`\b(?:4|four)\s*-?\s*years?\s+(?:[\w.'-]+[\s,]+){0,3}?${SCHOOL_NOUN}\b`,
  'i',
);
const TWO_YEAR_SCHOOL = new RegExp(
  String.raw`\b(?:2|two)\s*-?\s*(?:or\s+(?:4|four)\s*-?\s*)?years?\s+(?:[\w.'-]+[\s,]+){0,3}?${SCHOOL_NOUN}\b` +
    String.raw`|\b(?:community|junior)\s+colleges?\b`,
  'i',
);
/** The band of credentials each named school tier awards. See the note above. */
const TIER_AWARDS: Array<[RegExp, readonly string[]]> = [
  [FOUR_YEAR_SCHOOL, ['BACH', 'GRAD']],
  [TWO_YEAR_SCHOOL, ['CERT', 'ASSOC']],
];

/**
 * Every degree level the sentence names — outright, through "or higher", or through the band of
 * credentials a school tier it names awards. Split out of `levelsUnnamed`, for the reason
 * `placesNamed` gives: W3 and W10 read the same sentence and must reach the same reading of it, or
 * one of them is quietly excusing what the other flags.
 */
function levelsNamed(rawText: string): string[] {
  const named = new Set<string>(LEVEL_ORDER.filter((l) => LEVEL_SAYS[l].test(rawText)));
  for (const [tier, awards] of TIER_AWARDS) {
    if (tier.test(rawText)) for (const level of awards) named.add(level);
  }
  if (OR_HIGHER.test(rawText)) {
    const ceiling = Math.max(-1, ...[...named].map((l) => LEVEL_ORDER.indexOf(l)));
    if (ceiling >= 0) for (const level of LEVEL_ORDER.slice(ceiling + 1)) named.add(level);
  }
  return LEVEL_ORDER.filter((l) => named.has(l));
}

function levelsUnnamed(spec: ConstraintSpec, rawText: string): string[] {
  const admitted = [...new Set(tiers(spec).flatMap((t) => (t.axis === 'institution' ? t.degreeLevels : [])))];
  const named = new Set(levelsNamed(rawText));
  return admitted.filter((l) => !named.has(l)).sort();
}

describe('W3 — a degree level the level list admits, that the funder never named', () => {
  it('no degree-level list admits a level its own sentence does not name', async () => {
    const offenders: string[] = [];
    let checked = 0;
    let admittedValues = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'institution') continue;
      const admitted = new Set(tiers(c.spec).flatMap((t) => (t.axis === 'institution' ? t.degreeLevels : [])));
      if (admitted.size === 0) continue;
      checked += 1;
      admittedValues += admitted.size;
      const unnamed = levelsUnnamed(c.spec, c.rawText);
      if (unnamed.length > 0) {
        offenders.push(`${program.name}: admits ${unnamed.join(',')} — ${JSON.stringify(c.rawText.slice(0, 140))}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: 53 level lists publishing 123 levels — the largest hard-bar axis in the corpus.
    //
    // 33 AND 83 UNTIL ROUND 9. The 20 records that read "4-year college or university" published
    // `degreeLevels: []` and were SKIPPED here, at `if (admitted.size === 0) continue` — the exact
    // blindness W10 was written to cover. Now that each publishes a floor, this rule sees them for
    // the first time, and it is the harder audience: every one of them is a spec admitting GRAD
    // under a sentence that never says "graduate". It reports none, because a four-year university
    // is where graduate study happens — see the school-tier note above.
    expect(checked).toBe(53);
    expect(admittedValues).toBe(123);
  });

  it('…and it catches a graduate route added to a sentence that stops at the bachelor', () => {
    const capped = "Bachelor's degree in electrical engineering";
    expect(levelsUnnamed(institutionAdmitting(['BACH']), capped)).toEqual([]);
    expect(levelsUnnamed(institutionAdmitting(['BACH', 'GRAD']), capped)).toEqual(['GRAD']);
    // …while the records that DO say "or higher" have named it, and must not be flagged.
    expect(levelsUnnamed(institutionAdmitting(['BACH', 'GRAD']), "Bachelor's degree or higher")).toEqual([]);
    // "or higher" reaches up and never down: a certificate is still not named by it.
    expect(levelsUnnamed(institutionAdmitting(['CERT', 'BACH', 'GRAD']), "Bachelor's degree or higher")).toEqual(['CERT']);
    // An associate degree IS an undergraduate degree, so this one is not an over-claim.
    expect(
      levelsUnnamed(institutionAdmitting(['ASSOC', 'BACH']), 'Accredited undergraduate degree-granting institution'),
    ).toEqual([]);
  });

  /**
   * …AND A SCHOOL TIER NAMES THE BAND IT AWARDS, which is the reading the 20 records the round-nine
   * floor fix corrected turn on. Asserted here as a rule about the sentence, not about those
   * records, so it goes red if the reading is ever quietly narrowed back.
   */
  it('…and a named school tier names every credential that school awards, and no other', () => {
    const fourYear = 'Accredited 4-year college or university';
    // The building a graduate student studies in. GRAD is named; the funder wrote the place.
    expect(levelsNamed(fourYear)).toEqual(['BACH', 'GRAD']);
    expect(levelsUnnamed(institutionAdmitting(['BACH', 'GRAD']), fourYear)).toEqual([]);
    // …and it reaches no lower. A certificate is not awarded by a four-year university, so a spec
    // admitting one under this sentence is still the over-claim W3 exists to find.
    expect(levelsUnnamed(institutionAdmitting(['CERT', 'BACH', 'GRAD']), fourYear)).toEqual(['CERT']);
    // The two-year tier awards downward, not upward: certificates and associate degrees.
    expect(levelsNamed('Accredited 2-year college')).toEqual(['CERT', 'ASSOC']);
    expect(levelsUnnamed(institutionAdmitting(['ASSOC', 'BACH']), 'Accredited 2-year college')).toEqual(['BACH']);
    expect(levelsNamed('a community college')).toEqual(['CERT', 'ASSOC']);
    // Both tiers named is the whole ladder, and that is why those six records bar nobody by
    // credential — see the `KNOWN_TOOTHLESS` note.
    expect(levelsNamed('Any accredited 2- or 4-year college or university')).toEqual(LEVEL_ORDER);
    // A BARE year-phrase is a credential, not a building, and keeps `LEVEL_SAYS`'s narrow reading:
    // "a four-year degree" is a bachelor's and says nothing about a master's.
    expect(levelsNamed("a four-year degree in engineering")).toEqual(['BACH']);
  });
});

// ============================================================ W4: what the applicant does

/**
 * The seven `ActivityKind`s and the words a funder uses for each. This axis is where round seven's
 * over-claim lived, so the rule that reads it is the one to keep honest.
 */
const ACTIVITY_SAYS: Record<string, RegExp> = {
  club_member: /\bclubs?\b|\bsociet(?:y|ies)\b|\bmember(?:ship)?\b|\bchapters?\b|\borganizations?\b|\bassociations?\b/i,
  ares_races_skywarn:
    /\bares\b|\braces\b|\bskywarn\b|\bemergenc|\bdisaster\b|\bpublic safety\b|\bcommunications? support\b|\bstorm\b|\bmars\b/i,
  teaching:
    /\bteach|\binstruct|\bmentor|\belmer|\btrain(?:ing|er|s|ed)?\b|\beducat|\bclasses\b|\bvolunteer examiner\b|\blicensing sessions?\b/i,
  on_air: /\bon[\s-](?:the[\s-])?air\b|\boperat|\bqso\b|\bdx\b|\brag[\s-]?chew|\bnets?\b|\bhf\b|\bactivat|\bcontact(?:s|ing)?\b/i,
  field_day: /\bfield day\b|\bgota\b/i,
  contesting: /\bcontest|\bcompetiti|\bsweepstakes\b|\bdx[\s-]?peditio/i,
  public_service: /\bpublic service\b|\bcommunity service\b|\bvolunteer|\bservice\b|\bparades?\b|\bmarathons?\b|\bpublic events?\b/i,
};

function activitiesUnnamed(spec: ConstraintSpec, rawText: string): string[] {
  const admitted = [...new Set(tiers(spec).flatMap((t) => (t.axis === 'ham_activity' ? t.activityKinds : [])))];
  return admitted.filter((k) => !(ACTIVITY_SAYS[k] ?? /$^/).test(rawText)).sort();
}

describe('W4 — an activity the kind list admits, that the funder never named', () => {
  it('no activity list admits a kind its own sentence does not name', async () => {
    const offenders: string[] = [];
    let checked = 0;
    let admittedValues = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'ham_activity') continue;
      const admitted = new Set(tiers(c.spec).flatMap((t) => (t.axis === 'ham_activity' ? t.activityKinds : [])));
      if (admitted.size === 0) continue;
      checked += 1;
      admittedValues += admitted.size;
      const unnamed = activitiesUnnamed(c.spec, c.rawText);
      if (unnamed.length > 0) {
        offenders.push(`${program.name}: admits ${unnamed.join(',')} — ${JSON.stringify(c.rawText.slice(0, 140))}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: 11 activity lists publishing 18 kinds.
    expect(checked).toBe(11);
    expect(admittedValues).toBe(18);
  });

  it('…and it catches a kind added to CARA’s list that CARA never mentions', () => {
    // CARA's sentence VERBATIM, and its three published kinds are each named in it — "public
    // service", "ARES, RACES or SKYWARN", "Field Day".
    const cara =
      'Must demonstrate use of amateur radio through public service, community events, ARES, RACES ' +
      'or SKYWARN, GOTA, Field Day, etc.';
    const kinds = (activityKinds: ActivityKind[]): ConstraintSpec => ({
      axis: 'ham_activity', activityKinds, proofRequired: false,
    });
    expect(activitiesUnnamed(kinds(['ares_races_skywarn', 'field_day', 'public_service']), cara)).toEqual([]);
    // Teaching is on no reading of that sentence. R6 cannot see this: it asks only whether an
    // opened list produced a FAIL, and a longer list produces fewer of those, never more — so the
    // funder's own "etc." would have covered the addition up.
    expect(
      activitiesUnnamed(kinds(['ares_races_skywarn', 'field_day', 'public_service', 'teaching']), cara),
    ).toEqual(['teaching']);
    // And ARDC's "on-the-air activities" really does name `on_air`, so the rule stays silent there.
    expect(
      activitiesUnnamed(
        kinds(['club_member', 'ares_races_skywarn', 'teaching', 'on_air']),
        'Examples: membership in a local or regional club, participation in amateur radio emergency ' +
          'activities, teaching amateur radio classes, on-the-air activities, participation in college ' +
          'radio clubs, and any similar activities.',
      ),
    ).toEqual([]);
  });
});

// ============================================================ W5 + W8: floors

const LICENSE_RANK: Record<string, number> = { NONE: 0, TECH: 1, GENERAL: 2, EXTRA: 3 };

/**
 * A funder who says "ANY active Amateur Radio License Class" has named the whole ladder, and the
 * class they mention next is a preference, not a floor. Michael Holt K8MJH is exactly that
 * sentence — "Any active Amateur Radio License Class for two years, preference for General Class"
 * — and a rule without this clause reports an over-claim on a spec that is right.
 */
const ANY_CLASS =
  /\bany (?:active |valid |current |class of |amateur )*(?:amateur radio )?(?:licen[cs]e|class)\b|\bany class\b|\ball classes\b|\bregardless of (?:licen[cs]e|class)\b/i;

function classesNamed(rawText: string): string[] {
  const named: string[] = [];
  if (/\b(?:amateur )?extra\b/i.test(rawText)) named.push('EXTRA');
  if (/\bgeneral\b/i.test(rawText)) named.push('GENERAL');
  // A novice licence is below Technician on the ladder this schema publishes, so both map to the
  // lowest real class rather than inventing a rung.
  if (/\btechnician\b|\btech class\b|\bnovice\b/i.test(rawText)) named.push('TECH');
  return named;
}

function licenseFloorBelowSentence(spec: ConstraintSpec, rawText: string): boolean {
  if (ANY_CLASS.test(rawText)) return false;
  const named = classesNamed(rawText);
  if (named.length === 0) return false;
  const floors = tiers(spec).flatMap((t) => (t.axis === 'license' ? [LICENSE_RANK[t.licenseMin]] : []));
  if (floors.length === 0) return false;
  // The whole disjunction is an OR, so the widest route is the one an applicant faces — and the
  // sentence's LOWEST named class is the most generous reading of what the funder asked for.
  return Math.min(...floors) < Math.min(...named.map((n) => LICENSE_RANK[n]));
}

describe('W5 — a licence floor below the lowest class the funder named', () => {
  it('no licence constraint admits a class its own sentence does not name', async () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'license') continue;
      if (ANY_CLASS.test(c.rawText) || classesNamed(c.rawText).length === 0) continue;
      checked += 1;
      if (licenseFloorBelowSentence(c.spec, c.rawText)) {
        offenders.push(`${program.name}: ${JSON.stringify(c.rawText.slice(0, 140))}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: 39 licence sentences name a class outright.
    expect(checked).toBe(39);
  });

  it('…and it catches a floor dropped below the class the sentence asks for', () => {
    const ware =
      'Must hold a current General Class License for at least two years or more before application ' +
      'submission, or hold a current Amateur Extra Class License';
    // Today's spec: General is the lowest class the sentence names and the lowest route offered.
    expect(
      licenseFloorBelowSentence(
        { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 24, anyOf: [{ axis: 'license', licenseMin: 'EXTRA' }] },
        ware,
      ),
    ).toBe(false);
    // A Technician floor on a sentence that says General or Extra. R3 cannot see it: R3 asks
    // whether a DURATION leaked across branches, and a lower floor leaks nothing.
    expect(licenseFloorBelowSentence({ axis: 'license', licenseMin: 'TECH', heldMonthsMin: 24 }, ware)).toBe(true);
    // …and an over-claim reached only through the alternative is still reached.
    expect(
      licenseFloorBelowSentence(
        { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 24, anyOf: [{ axis: 'license', licenseMin: 'TECH' }] },
        ware,
      ),
    ).toBe(true);
    // THE OTHER DIRECTION. "Any active licence class, preference for General" really does admit a
    // Technician, and a rule that flagged it would push the corpus toward refusing them.
    expect(
      licenseFloorBelowSentence(
        { axis: 'license', licenseMin: 'TECH', heldMonthsMin: 24 },
        'Any active Amateur Radio License Class for two years, preference for General Class',
      ),
    ).toBe(false);
  });
});

/** Any grade-point number the sentence states, on the four-point scale this schema records. */
function gpasNamed(rawText: string): number[] {
  return [...rawText.matchAll(/\b([0-4]\.\d{1,2})\b/g)].map((m) => Number(m[1]));
}

function gpaFloorBelowSentence(spec: ConstraintSpec, rawText: string): boolean {
  const named = gpasNamed(rawText);
  if (named.length === 0) return false;
  const mins = tiers(spec).flatMap((t) => (t.axis === 'gpa' && t.min !== undefined ? [t.min] : []));
  if (mins.length === 0) return false;
  return Math.min(...mins) < Math.min(...named);
}

describe('W8 — a grade floor below the number the funder named', () => {
  it('no gpa constraint admits a grade its own sentence does not', async () => {
    const offenders: string[] = [];
    let checked = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'gpa') continue;
      if (gpasNamed(c.rawText).length === 0) continue;
      if (tiers(c.spec).every((t) => t.axis !== 'gpa' || t.min === undefined)) continue;
      checked += 1;
      if (gpaFloorBelowSentence(c.spec, c.rawText)) {
        offenders.push(`${program.name}: ${JSON.stringify(c.rawText.slice(0, 140))}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: 17 records state a grade-point number AND publish a floor.
    expect(checked).toBe(17);
  });

  it('…and it catches a floor set below the number the sentence states', () => {
    const sentence = 'Minimum 3.0 grade point average required';
    expect(gpaFloorBelowSentence({ axis: 'gpa', min: 3.0 }, sentence)).toBe(false);
    expect(gpaFloorBelowSentence({ axis: 'gpa', min: 3.5 }, sentence)).toBe(false); // narrower: R-file territory
    expect(gpaFloorBelowSentence({ axis: 'gpa', min: 2.5 }, sentence)).toBe(true);
  });
});

// ============================================================ W6: who may be

/**
 * The whitespace classes in the two-word alternatives are not decoration. `userFacingCopyContract`
 * measures its debt by looking for a user-facing sentence's text ANYWHERE in the test corpus, and
 * a literal `any citizenship` written here would have been counted as this file asserting the
 * "Any citizenship" option on the profile form — which it does not, and which would have handed
 * `Profile.tsx` a budget of slack for the next real unasserted sentence to land in for free.
 * A rule about over-claiming had better not over-claim.
 */
const CITIZENSHIP_SAYS_ANY =
  /\bnot (?:a )?requirement|\bnot required\b|\bany\s+citizenship\b|\binternational\b|\bworld[\s-]?wide\b|\bno\s+citizenship\b|\bregardless of (?:citizenship|nationality|location)|\bany countr|\bnationality\b/i;
const CITIZENSHIP_SAYS_RESIDENT =
  /\bresiden(?:t|ce|cy)\b|\bpermanent resident\b|\bgreen card\b|\bdomicil|\blawfully admitted\b/i;

function citizenshipsUnnamed(spec: ConstraintSpec, rawText: string): string[] {
  const admitted = new Set(tiers(spec).flatMap((t) => (t.axis === 'citizenship' ? t.allowed : [])));
  const unnamed: string[] = [];
  // 'ANY' is the widest value this axis has: it admits every applicant on Earth, so a sentence
  // that does not say so is the strongest possible case of a spec claiming more than its evidence.
  if (admitted.has('ANY') && !CITIZENSHIP_SAYS_ANY.test(rawText)) unnamed.push('ANY');
  if (admitted.has('US_RESIDENT') && !CITIZENSHIP_SAYS_RESIDENT.test(rawText) && !CITIZENSHIP_SAYS_ANY.test(rawText)) {
    unnamed.push('US_RESIDENT');
  }
  return unnamed.sort();
}

describe('W6 — a citizenship the allow-list admits, that the funder never named', () => {
  it('no citizenship list admits a status its own sentence does not name', async () => {
    const offenders: string[] = [];
    let checked = 0;
    let admittedValues = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'citizenship') continue;
      const admitted = new Set(tiers(c.spec).flatMap((t) => (t.axis === 'citizenship' ? t.allowed : [])));
      if (admitted.size === 0) continue;
      checked += 1;
      admittedValues += admitted.size;
      const unnamed = citizenshipsUnnamed(c.spec, c.rawText);
      if (unnamed.length > 0) {
        offenders.push(`${program.name}: admits ${unnamed.join(',')} — ${JSON.stringify(c.rawText.slice(0, 140))}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: 27 citizenship constraints, 27 published statuses.
    expect(checked).toBe(27);
    expect(admittedValues).toBe(27);
  });

  it('…and it catches "anybody" published under a sentence that says US citizen', () => {
    const citizen = 'Must be a citizen of the United States';
    expect(citizenshipsUnnamed({ axis: 'citizenship', allowed: ['US_CITIZEN'] }, citizen)).toEqual([]);
    // The widest value in the schema, on a sentence that names the narrowest.
    expect(citizenshipsUnnamed({ axis: 'citizenship', allowed: ['ANY'] }, citizen)).toEqual(['ANY']);
    expect(citizenshipsUnnamed({ axis: 'citizenship', allowed: ['US_CITIZEN', 'US_RESIDENT'] }, citizen)).toEqual([
      'US_RESIDENT',
    ]);
    // THE OTHER DIRECTION: the two records that really are open to the world said so.
    expect(
      citizenshipsUnnamed(
        { axis: 'citizenship', allowed: ['ANY'] },
        'US licensure, US residence and US citizenship are not requirements.',
      ),
    ).toEqual([]);
    expect(
      citizenshipsUnnamed(
        { axis: 'citizenship', allowed: ['ANY'] },
        'The CWops Scholarship is open to any qualified applicant regardless of location or nationality.',
      ),
    ).toEqual([]);
  });
});

// ============================================================ W7: fields nobody wrote

/**
 * A FIELD LIST IS A QUOTATION, and this is the cheapest rule in the file to state: every entry in
 * `fields` and `excludedFields` must appear in the sentence the funder wrote. `unadjudicable.test`
 * already applies this to `orUnrepresented`; nothing applied it to the list itself, and an
 * invented entry is a major admitted to an award that never named it.
 *
 * Compared on letters and digits only, so punctuation and case cannot make a real quotation look
 * invented.
 */
function normalizeForQuotation(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function fieldsNotInSentence(spec: ConstraintSpec, rawText: string): string[] {
  const entries = tiers(spec).flatMap((t) => (t.axis === 'field_of_study' ? [...t.fields, ...t.excludedFields] : []));
  const haystack = normalizeForQuotation(rawText);
  return entries.filter((f) => {
    const needle = normalizeForQuotation(f);
    return needle !== '' && !haystack.includes(needle);
  });
}

describe('W7 — a field in the list that appears nowhere in the funder’s sentence', () => {
  it('every field list is a quotation of its own sentence', async () => {
    const offenders: string[] = [];
    let checked = 0;
    let entries = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'field_of_study') continue;
      const all = tiers(c.spec).flatMap((t) => (t.axis === 'field_of_study' ? [...t.fields, ...t.excludedFields] : []));
      if (all.length === 0) continue;
      checked += 1;
      entries += all.length;
      const invented = fieldsNotInSentence(c.spec, c.rawText);
      if (invented.length > 0) {
        offenders.push(`${program.name}: ${JSON.stringify(invented)} — ${JSON.stringify(c.rawText.slice(0, 140))}`);
      }
    }
    expect(offenders).toEqual([]);
    // Vacuity guard: 61 field lists holding 210 entries between them, every one of them checked.
    expect(checked).toBe(61);
    expect(entries).toBe(210);
  });

  it('…and it catches a field nobody wrote', () => {
    const sentence =
      'Electronics, Electrical Engineering, Aerospace Engineering, Computer Science or similar scientific field';
    const quoted = ['Electronics', 'Electrical Engineering', 'Aerospace Engineering', 'Computer Science', 'similar scientific field'];
    const listing = (fields: string[]): ConstraintSpec => ({ axis: 'field_of_study', fields, excludedFields: [] });
    expect(fieldsNotInSentence(listing(quoted), sentence)).toEqual([]);
    expect(fieldsNotInSentence(listing([...quoted, 'Underwater Basket Weaving']), sentence)).toEqual([
      'Underwater Basket Weaving',
    ]);
    // Punctuation and case are not inventions.
    expect(fieldsNotInSentence(listing(['electrical-engineering']), sentence)).toEqual([]);
    // An invented EXCLUSION is the same defect read the other way: it refuses a major the funder
    // never barred, so this rule covers both lists.
    expect(
      fieldsNotInSentence({ axis: 'field_of_study', fields: quoted, excludedFields: ['Theology'] }, sentence),
    ).toEqual(['Theology']);
  });
});

// ============================================================ W9: the widest over-claim there is

/**
 * "OR RELATED FIELDS" IS NOT "ANY FIELD", AND TODAY IT IS READ AS ONE.
 *
 * `matcher.ts`'s `field_of_study` arm ends `if (required.widened) return PASS;`. `widened` is set
 * by an entry like "related fields" or by the funder's own "including but not limited to" in
 * `rawText`, and the consequence is unconditional: once a funder has widened their list, EVERY
 * major passes it. Measured over the shipped corpus, 18 field-of-study constraints — 17 of them
 * HARD — return `pass` for a Basket Weaving, Medieval Poetry, Culinary Arts, Hospitality
 * Management or Music Performance major alike. Two of the seventeen are medical scholarships:
 *
 *   MARCO       "Field of study must be leading to a career in the HEALING ARTS, including, but
 *                not necessarily leading to Medicine, Dentistry, Veterinary Medicine, Nursing,
 *                Pharmacy, EMT, or Radiology technician."
 *   John C.York "…pursuing a field of study leading to a career in the HEALING ARTS, including but
 *                not limited to a career in Medicine, Nursing, Dentistry, Pharmacy, EMT, or
 *                Radiology"
 *
 * A poetry major reads "you qualify" under a sentence about the healing arts. That is the exact
 * shape round seven fixed on `ham_activity` — an opened list read as a yes — and it is a great
 * deal bigger here: three records there, eighteen here. The round's first fixer found it, declined
 * it deliberately, and wrote down why: the matcher cannot tell Physical Therapy (correctly `pass`,
 * and pinned as such in `packages/core/test/disjunction.test.ts`) from Basket Weaving, because
 * both are decided by stemmed word overlap against "healing arts".
 *
 * THE DOCTRINE ALREADY ANSWERS IT: `unknown` is the third answer, and it is what an opened list
 * gets on every other axis. `unknown` costs Physical Therapy nothing — the door stays open and the
 * funder's verbatim sentence is on the screen for them to judge — while `pass` spends a Basket
 * Weaving major's application on a promise nobody made. But that is a change to `matcher.ts`, not
 * to a test file, and it moves published verdict counts across the suite; it is named here so the
 * next matcher change starts from a measurement instead of rediscovering it an eighth time.
 *
 * ============================== AND THAT IS WHAT ROUND EIGHT DID ==============================
 *
 * `matcher.ts`'s `field_of_study` arm now ends `if (required.widened) return unknown();`, so the
 * eighteen records below produce exactly what the paragraph above says they should. THE LIST IS
 * KEPT, and the assertion inverted: these are the records whose widened list used to admit
 * everybody, they are named so the fix has a census rather than an anecdote, and every one of them
 * must now answer an unrelated major with `unknown` — never `pass`, and never a refusal either.
 *
 * IT MAY STILL ONLY EVER SHRINK, in the same direction and for the same reason. A record that
 * starts blanket-PASSING again is a new over-claim; a record that starts REFUSING one of these
 * majors on a sentence the funder opened is the false exclude seven rounds drained. Both are
 * failures of this block, and both are equalities with a diff rather than a silent pass.
 */
const BLANKET_PASS_ON_A_WIDENED_FIELD_LIST = {
  hard: [
    'IRARC Memorial, Joseph P. Rubino, WA4MMD, Scholarship',
    'The Charles N. Fisher Memorial Scholarship',
    'The Dr. James L. Lawson Memorial Scholarship',
    'The Francis Walton Memorial Scholarship',
    'The Frankford Radio Club (FRC) Scholarship',
    'The Fred R. McDaniel Memorial Scholarship',
    'The Henry Broughton, K2AE, Memorial Scholarship',
    'The Indianapolis Amateur Radio Association Scholarshp Fund',
    'The Irving W. Cook, WAØCGS, Scholarship',
    'The John C. York, KE5V, Scholarship',
    'The L. Phil and Alice J. Wicker Scholarship',
    'The Magnolia DX Association Scholarship',
    'The Mark Kupferschmid, AC9PR, Scholarship',
    'The Medical Amateur Radio Council (MARCO) Scholarship',
    'The Mississippi Scholarship',
    'The Paul and Helen L. Grauer Scholarship',
    'The Ray, NØRP, & Katie, WØKTE, Pautz Scholarship',
  ],
  soft: ['The Charles Clarke Cordle Memorial Scholarship'],
};

/** Five majors no reading of any of those sentences reaches. */
const PLAINLY_UNRELATED = ['Basket Weaving', 'Medieval Poetry', 'Culinary Arts', 'Hospitality Management', 'Music Performance'];

/** The relatedness idiom, as `matcher.ts` spells it — used only to build the CLOSED control. */
const RELATEDNESS_ENTRY =
  /\b(?:related|similar|allied|adjacent|comparable|equivalent|associated|akin|analogous|relevant|applicable)\b/i;

describe('W9 — a widened field list that used to admit every major there is', () => {
  /**
   * THE ASSERTION THE PARAGRAPH ABOVE ASKED FOR, and it is a stronger one than the name-list it
   * replaces: not "these eighteen stopped", but "NO pass anywhere in this corpus rests on the
   * widening". Each (constraint, major) pair that comes out `pass` is re-evaluated against the
   * same constraint with the funder's widening taken away — the relatedness entries out of
   * `fields`, the qualifier out of `rawText` — and a pass that survives that is a pass the funder's
   * own list already gave. A pass that does not is the over-claim, and there are none.
   */
  it('no pass anywhere in the corpus rests on the funder having widened their list', async () => {
    const restsOnTheWidening: string[] = [];
    let checked = 0;
    let probed = 0;
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'field_of_study' || c.spec.fields.length === 0) continue;
      checked += 1;
      const closed: ConstraintSpec = {
        ...c.spec,
        fields: c.spec.fields.filter((f) => !RELATEDNESS_ENTRY.test(f)),
      };
      for (const fieldOfStudy of PLAINLY_UNRELATED) {
        probed += 1;
        const asWritten = evaluateConstraint(c.spec, { kind: 'student', fieldOfStudy }, NOW, c.rawText).status;
        if (asWritten !== 'pass') continue;
        const withoutTheWidening = evaluateConstraint(closed, { kind: 'student', fieldOfStudy }, NOW, '').status;
        if (withoutTheWidening !== 'pass') restsOnTheWidening.push(`${program.name} — ${fieldOfStudy}`);
      }
    }
    expect(restsOnTheWidening).toEqual([]);
    // Vacuity guard: 60 field lists with at least one entry, five majors each. Before the fix this
    // same probe returned 90 pairs across the eighteen records listed above.
    expect(checked).toBe(60);
    expect(probed).toBe(300);
  });

  /**
   * ...AND THE FALSE EXCLUDES STAY WITHDRAWN. The other half of the same judgement, and the half a
   * fix in this direction can quietly undo: an opened list must still not REFUSE the applicant its
   * funder invited. Every record on the census above answers "Medieval Poetry" — a major with no
   * word in common with any of their sentences — with something that is not a 'no'.
   */
  it('and none of the eighteen went back to refusing anybody', async () => {
    const census = new Set([
      ...BLANKET_PASS_ON_A_WIDENED_FIELD_LIST.hard,
      ...BLANKET_PASS_ON_A_WIDENED_FIELD_LIST.soft,
    ]);
    const answers = new Map<string, string>();
    for (const { program, c } of await everyConstraint()) {
      if (c.spec.axis !== 'field_of_study' || !census.has(program.name)) continue;
      answers.set(
        program.name,
        evaluateConstraint(c.spec, { kind: 'student', fieldOfStudy: 'Medieval Poetry' }, NOW, c.rawText).status,
      );
    }
    expect([...answers.keys()].sort()).toEqual([...census].sort());
    // Exactly one still admits a poetry major, and it is not a widening that does it: IRARC's
    // funder named a SECOND ROUTE — "Undergraduate degree or electronic technician certification
    // program" — which `fieldOfStudy.ts` mints as an `anyOf` tier with `fields: []`. An award open
    // to any undergraduate is open to a poetry undergraduate, in the funder's own words.
    const admitted = [...answers].filter(([, status]) => status === 'pass').map(([name]) => name);
    expect(admitted).toEqual(['IRARC Memorial, Joseph P. Rubino, WA4MMD, Scholarship']);
    // Every other one declines to decide. None refuses.
    expect([...answers.values()].filter((s) => s === 'unknown')).toHaveLength(census.size - 1);
    expect([...answers.values()]).not.toContain('fail');
  });

  it('…so a medical scholarship no longer tells a poetry major they qualify', async () => {
    const { programs } = await corpus();
    const marco = programs.find((p) => p.name.includes('MARCO'));
    if (marco === undefined) throw new Error('The MARCO Scholarship is missing from the corpus');
    const field = marco.constraints.find((c) => c.spec.axis === 'field_of_study');
    if (field === undefined) throw new Error('MARCO states a field requirement and it is missing');
    const spec = field.spec;
    if (spec.axis !== 'field_of_study') throw new Error('unreachable');
    // From the sentence first: change the funder's wording and this line fails before the rest.
    expect(field.rawText).toContain('healing arts');
    expect(field.hard).toBe(true);
    const answer = (fieldOfStudy: string, rawText = field.rawText) =>
      evaluateConstraint(field.spec, { kind: 'student', fieldOfStudy }, NOW, rawText);
    // Not a yes...
    expect(answer('Medieval Poetry').status).toBe('unknown');
    // ...and not a no either: the funder's own "including but not necessarily" is why, and it is
    // the same answer this record's `orUnrepresented` already gave for its bare domains.
    expect(answer('Medieval Poetry').missing).toEqual([]);
    expect(spec.orUnrepresented).toBeDefined();
    // The route the funder named first is not in question and survives the fix.
    expect(answer('Nursing').status).toBe('pass');
    // Close the sentence and the same applicant is refused, so the widening is what is doing the
    // work here rather than the axis giving up.
    expect(answer('Medieval Poetry', 'Medicine or Nursing.').status).toBe('unknown');
    expect(
      evaluateConstraint(
        { axis: 'field_of_study', fields: spec.fields, excludedFields: [] },
        { kind: 'student', fieldOfStudy: 'Medieval Poetry' },
        NOW,
        'Medicine or Nursing.',
      ).status,
    ).toBe('fail');
  });
});

// ============================================================ W10: does it bar ANYBODY at all?

/**
 * EVERY RULE ABOVE MEASURES VALUE-WIDTH. NOT ONE OF THEM MEASURES ENFORCEMENT-WIDTH.
 *
 * W1 through W8 ask "which values does this tier admit, and did the funder name them?" That
 * question is asked of the SPEC and answered by the SPEC. It never asks the other question a
 * verdict actually turns on: does this constraint refuse anybody, ever?
 *
 * THE PROOF, AND IT IS NOT AN ARGUMENT — IT IS A MEASUREMENT. Flip every hard constraint in the
 * corpus to soft. Every requirement in the product stops barring anyone: `matchProgram` demotes a
 * soft failure to "preference not met" and the verdict comes out `eligible`. Run this file. RUN FOR
 * REAL, by softening `everyConstraint` and running the file: W1 THROUGH W9 ALL STAYED GREEN, and
 * the only two failures in the file were W10's. Before this block, `grep -n '\.hard\b'` over this
 * file returned three hits, all of them inside W9's census bucketing, none of them a rule.
 *
 * THE SAME BLINDNESS HAD A SECOND DOOR, AND 26 RECORDS WERE STANDING IN IT — 20 OF THEM REALLY.
 * A tier can admit exactly the values its sentence names and still refuse nobody, because it holds
 * NO value at all:
 *
 *   Richard W. Bendicksen N7ZL  "4-year college or university"            -> `degreeLevels: []`
 *   L. B. Cebik W4RNL           "4-year college or university"            -> `degreeLevels: []`
 *   Henry Broughton K2AE        "Accredited 4-year college or university" -> `degreeLevels: []`
 *   YASME Foundation            "Accredited four-year college or university" -> `degreeLevels: []`
 *   …and 16 more.
 *
 * W3 skipped every one of them, at `if (admitted.size === 0) continue`, because an EMPTY list is
 * never wider than its sentence by value-count. It is infinitely wider by enforcement: a student one
 * rung below the floor the funder wrote was told `eligible`, and every one was HARD, so that was the
 * verdict on the screen. That is a false include, it was the subject of round nine, and it is what
 * seven previous rounds of false-exclude hunting left behind — `institution.ts` said so in its own
 * words: "WIDENING tokens … may only ADD to a list that is already non-empty, never create one, so
 * no entry ever gains a bar it did not have … while 'Accredited 4-year college or university' stays
 * unrestricted."
 *
 * ALL 26 ARE CLOSED AND `KNOWN_TOOTHLESS` IS EMPTY. 20 by a product fix — a bare four-year school
 * tier now states a FLOOR — and 6 by fixing this file, which was reading a BUILDING as a CREDENTIAL
 * and accusing "Any accredited 2- or 4-year college or university" of failing to refuse a
 * certificate student it plainly admits. The full account is on `KNOWN_TOOTHLESS` itself. The
 * paragraphs above are kept in the past tense rather than deleted, because the shape of the hole is
 * the reason this rule exists and a rule whose reason has been deleted is the next one to be
 * simplified away.
 *
 * ================================ WHAT THIS RULE ASKS INSTEAD =============================
 * The mirror of W1-W8, one turn further round. Where they ask "every value the spec ADMITS — did
 * the funder name it?", W10 asks "the funder named a bounded set — does the spec REFUSE anything
 * outside it?" Both halves come off the same record, and the second half is built out of the FIRST
 * one's vocabulary: `placesNamed`, `levelsNamed`, `STAGE_SAYS`, `ACTIVITY_SAYS`, `classesNamed`,
 * `gpasNamed` are the same functions W1-W8 use to decide what a sentence names. If W10 and W3
 * disagreed about whether "4-year" names BACH, one of them would be quietly excusing what the other
 * flags; sharing the reading makes that impossible.
 *
 * NO FIXTURE, SO NO FIXTURE THAT CANNOT FAIL. This is the third obligation in the header, and it is
 * met structurally here rather than by inspection. The probe applicant is not written down: it is
 * DERIVED, per record, from the funder's own sentence — an applicant on none of the values that
 * sentence names, built by taking the axis's vocabulary and removing everything the funder wrote.
 * The applicant this project has now three times failed to reach IS the applicant, by construction.
 * The R6 defect below is unreachable here, because there is nothing to reach past.
 *
 * ==================================== THE TWO OBLIGATIONS =================================
 *   W10a  THE SPEC MUST BE ABLE TO REFUSE THEM. Asked of hard and soft alike — deliberately.
 *         `matcher.ts`'s own `statesARequirement` was written this round because a PREFERENCE that
 *         cannot fail is a preference nobody earned, so exempting soft constraints here would
 *         re-open the door that fix just closed.
 *   W10b  AND THE REFUSAL MUST REACH THE VERDICT: the constraint must be `hard`. This is the half
 *         the disarm mutation moves, and the only rule in this file that reads `c.hard`.
 *
 * ================================== WHEN THE ANSWER IS "NO" ===============================
 * Three ways a funder can name values and still bar nobody, and all three are the funder's doing
 * rather than the record's:
 *   OPENED    "or similar scientific field", "including but not limited to", "etc." — W9's whole
 *             subject. The funder declined to close the list, so `unknown` is the answer and
 *             refusing nobody is correct.
 *   WIDENED   "Any", "All", "no geographic requirements", "not requirements" — the funder ANSWERING
 *             the question with "there is no restriction". Reading that as anything but a pass
 *             would refuse people the funder just admitted.
 *   PREFERRED "preference will be given to…", "if no qualified applicant is identified…" — the
 *             funder ranking applicants rather than barring them. This one exempts W10b ONLY: a
 *             preference must still be able to fail, or nobody ever earns it.
 *   UNCHECKABLE `orUnrepresented` — the funder named a route this schema cannot hold. The fourth
 *             way, added after measuring, and it has its own note below because it is also D3.
 *
 * Each is a census with a pinned count, not a silent skip, for the reason `KNOWN_GEO_OVERCLAIMS`
 * gives: an exemption is where the real offender walks through, and a counted one cannot grow by a
 * record without going red. The four buckets and the checked population add to all 652 constraints
 * in the corpus, which is the assertion that stops a record leaving the rule unseen.
 *
 * ======================= AND HOW WOULD YOU KNOW *THIS* GUARD IS BLIND? ====================
 * Three rounds, three guards, each blind exactly where it counted: a copy census that dropped every
 * interpolated sentence, an R6 fixture whose applicant could not reach the failure it existed to
 * catch, and W1-W8 surviving the entire product being disarmed. The common shape is not
 * carelessness. In all three the guard was measuring something REAL and adjacent to the thing that
 * mattered, and the gap was invisible from inside the guard, because everything the guard could see
 * was fine.
 *
 * So the answer cannot be "read it again harder". It has to be a procedure that does not depend on
 * having thought of the failure. The one used here: DISARM THE PRODUCT AND SEE WHETHER THE RULE
 * NOTICES. `THE DISARM BATTERY` below is that procedure written as a test. Each mutation removes
 * one whole mechanism by which this product refuses anybody:
 *
 *   D1  every hard constraint -> soft            (the refusal never reaches the verdict)
 *   D2  every spec -> its empty/vacuous form     (the tier holds no value to test)
 *   D3  every constraint -> `orUnrepresented`    (every `fail` softened to `unknown`)
 *   D4  every field list -> widened              (W9's mechanism, applied corpus-wide)
 *
 * A rule notices a disarm in one of two ways, and the battery accepts both: it FLAGS MORE, or its
 * COVERAGE COLLAPSES — a rule left with nothing it can check has said something too. A mutation
 * that moves neither number is a mutation this rule is blind on, and the battery names it. What was
 * measured:
 *
 *   D1  W10b flags all 204, and W10a's census is byte-identical — the proof, made inside the test,
 *       that any rule reading only `spec` and `rawText` is blind here by construction. W11's
 *       coverage collapses to 0, because a soft constraint is W10b's finding by name.
 *   D2  246 constraints checked, 268 probes built, 268 flagged. No survivors. W11 flags too.
 *   D3  BLIND ON THE OFFENDER LIST, AND IT SAYS SO. W10a exempts `orUnrepresented`, so nothing is
 *       flagged; what moves is coverage, from 238 checked to 0, with 282 constraints in a bucket
 *       that asks them nothing. Reported, not hidden. W11 is blind to D3 with NOTHING moving at
 *       all, which is worse and is asserted rather than argued — see the battery's W11 case.
 *   D4  flags more, and every added offender is on `field_of_study` — the one axis it reaches.
 *
 * That is the honest form of the claim, and it is bounded in a way the previous three guards were
 * not: W10 is blind exactly on the disarming mutations nobody has thought to add to the battery. It
 * does not claim the battery is complete. It claims the battery is the place to look, and that
 * adding a fifth mutation is cheap, mechanical, and does not require re-reading a thousand lines of
 * prose to know what it proved.
 *
 * AND ROUND NINE RAN IT AGAINST A NEW RULE, which is the return on writing it as a procedure: W11
 * was answerable by running the battery it inherited, and the two mutations that can reach a verdict
 * both move it. The one that cannot is asserted to be a hole in the battery's coverage of W11
 * rather than a property of W11.
 *
 * WHAT THE BATTERY DOES *NOT* COVER, stated so the next round starts from it rather than
 * rediscovering it: every mutation above widens the product. None of them narrows it, so the
 * battery is silent about false EXCLUDES — the direction seven rounds drained and the direction
 * `spec-vs-sentence.test.ts` owns. A D5 that hardens every soft constraint, or empties every
 * `anyOf`, would measure that half, and it belongs to that file rather than this one.
 */

/**
 * The applicant every derived probe starts from: fully specified, and maximally qualified on every
 * axis. Nothing here is a value the corpus contains — each field is the most generous answer the
 * schema can hold — so a `fail` against a probe built from this can only come from the one field
 * the sentence excluded. A missing field would come out `unknown` and quietly excuse the record.
 */
const ENFORCEMENT_PROBE: StudentProfile = {
  kind: 'student', callsign: 'K5EXAMPLE', licenseClass: 'EXTRA', licensedSince: '1980-01-01T00:00:00.000Z',
  state: 'CT', county: 'Hartford', callDistrict: '1', lat: 41.76, lon: -72.68,
  fieldOfStudy: 'Electrical Engineering', degreeLevel: 'BACH', institution: 'A University',
  accredited: true, partTime: false, gpa: 4.0, classRankTopPct: 1,
  arrlMemberSince: '1980-01-01T00:00:00.000Z', citizenship: 'US_CITIZEN',
  birthDate: '2004-01-01T00:00:00.000Z', stage: 'UNDERGRAD',
  activityKinds: ['club_member', 'ares_races_skywarn', 'teaching', 'on_air', 'field_day', 'contesting', 'public_service'],
  cwWpm: 60, financialNeed: true, gender: 'female',
};

/**
 * THE FUNDER DECLINING TO CLOSE THEIR OWN LIST. Kept separate from the WIDENED vocabularies, which
 * are the funder answering "no restriction": an opened list still names things, it just does not
 * promise those are all of them. Written from the idioms these pages actually use, and every one of
 * them is a phrase whose whole job in English is to say "and others like these".
 */
const OPENED_LIST =
  /\betc\.?(?:\s|$|,)|\bincluding,?\s+but\s+not\b|\bsuch as\b|\bexamples?\b|\bfor example\b|\bsome form of\b|\bor\s+(?:similar|related|allied|comparable|equivalent|other)\b|\band any similar\b|\bamong others\b|\bnot exhaustive\b|\bnot limited to\b/i;

/** The funder ranking applicants rather than barring them. W10b's only exemption. */
const PREFERRED =
  /\bpreferences?\b|\bpreferred\b|\bpreferential/i;
const CASCADE_CONDITION = /\bif no(?:ne)?\b|\bif there is no\b|\bif not\b|\bfirst consideration\b|\bpriority\b/i;

const ALL_STAGES = ['HS_SENIOR', 'UNDERGRAD', 'GRAD', 'VETERAN', 'RETRAINING_ADULT'];
/** Status stages last: `stagesSatisfiedBy` promotes them to a level stage, so they make a muddier
 *  probe than a plain level stage does. Preferring the level stages keeps the probe decisive. */
const STAGE_PROBE_ORDER = ['HS_SENIOR', 'GRAD', 'UNDERGRAD', 'VETERAN', 'RETRAINING_ADULT'];
const ALL_ACTIVITY_KINDS = Object.keys(ACTIVITY_SAYS);

/**
 * THE APPLICANT THE FUNDER'S OWN SENTENCE PUTS OUTSIDE THE AWARD, or `undefined` when this sentence
 * asks nothing on this axis that the schema could hold — which is not a defect and is counted
 * rather than flagged.
 *
 * Each arm reads the sentence with W1-W8's own vocabulary, takes the axis's full value set, removes
 * everything the sentence named, and returns an applicant standing on what is left. When the
 * sentence names EVERY value the axis has, there is no such applicant and the answer is `undefined`
 * — the funder named the whole world, which is their right and is not an over-claim.
 */
interface Probe {
  /** The applicant the sentence puts outside the award. */
  profile: StudentProfile;
  /**
   * THE SAME APPLICANT, STANDING ON A VALUE THE SENTENCE DOES NAME, and it is the half that makes a
   * probe evidence instead of an anecdote. A `fail` proves nothing on its own: the profile could
   * have been refused for a reason that has nothing to do with the field under test, and a rule
   * built on that reads green while measuring the wrong thing. That is the R6 defect exactly — a
   * fixture that could not reach the failure it existed to catch — and the control is how this file
   * stops asserting it away. W11 counts every record whose control is not admitted as UNREACHABLE
   * rather than passing it, so coverage is a measured number and never an assumption.
   */
  control: StudentProfile;
  excluded: string;
}

/**
 * THE ACCREDITATION AND ENROLMENT BARS, which the level ladder is not the only way to state.
 * `institution` is the one axis in this schema holding THREE enforceable fields, and until round
 * nine this rule read one of them. Five of the six records it was accusing of enforcing nothing —
 * CTRI, John C. York, Lois Manley, MARCO, Peoria — publish `accreditationRequired: true` under
 * their own "Any ACCREDITED 2- or 4-year college or university", so they refuse an applicant at an
 * unaccredited school and always did. The rule simply never asked.
 *
 * `tradeSchoolOK` is deliberately not probed: `matcher.ts` says in its own words that it is
 * informational because CONTRACT §3 has no profile field for it, so no applicant can be built who
 * answers it. That is a schema gap and it is counted below rather than flagged — see `typeOnly`.
 */
const ACCREDITATION_REQUIRED = /\baccredit(?:ed|ation)\b/i;
/**
 * "Full-time" QUALIFYING ENROLMENT, forward-only and on a short leash, AND ONLY WHERE THE FUNDER
 * NEVER SAYS "PART-TIME". Both halves were measured, and each one caught a real record:
 *
 *   forward-only  the YLRL Marte Wessel K0EPE award reads "For part-time students working
 *                 full-time", where "full-time" qualifies EMPLOYMENT and is followed by nothing.
 *   never says
 *   "part-time"   the Six Meter Club of Chicago reads "PART-TIME OR FULL-TIME post-secondary
 *                 student at a regionally accredited technical school". The first draft of this
 *                 probe flagged it — the funder inviting part-time students in their opening two
 *                 words, read as a funder barring them. That is the cry-wolf this file's header
 *                 says is where an exemption gets bolted on, and it was caught by running the rule
 *                 rather than by reading it.
 *
 * A funder who wrote the words "part-time" at all has not put a part-time student outside their
 * award on any reading this test may make.
 */
const FULL_TIME_REQUIRED =
  /\bfull[\s-]?time\b[\s,]+(?:[\w.'-]+[\s,]+){0,2}?(?:students?|enrol|stud(?:y|ies|ent)|attendance|basis|status|programs?|courses?)/i;
const PART_TIME_MENTIONED = /\bpart[\s-]?time\b/i;

/**
 * EVERY LADDER, READ OFF THE SENTENCE ALONE AND NOT OFF THE AXIS IT WAS FILED UNDER.
 *
 * These nine functions take `rawText` and nothing else. That is the whole point, and it is the
 * repair of the blind spot round nine was set to close: W10's institution arm read `levelsNamed`
 * only for constraints whose OWN `spec.axis` was `institution`, so a funder who wrote a degree floor
 * into a `geography`, `age_stage`, `field_of_study` or `other` sentence was invisible to it. The
 * previous verifier swept the corpus by hand and found the five non-pinned hits all dissolved on
 * reading — which made the pin complete BY HAND CHECK, not by any rule. W11 below reads all nine
 * against every sentence in the corpus, whatever axis carried it.
 *
 * Each returns the applicant that ladder puts outside, and the CONTROL that proves the probe could
 * have been admitted. `undefined` means the sentence says nothing this ladder can read, which is not
 * a defect and is counted rather than flagged.
 */
const LOCATION_ONLY_STATE = { lat: undefined, lon: undefined, county: undefined, callDistrict: undefined };

function placeExcluded(rawText: string): Probe | undefined {
  if (GEO_WIDENED.test(rawText)) return undefined;
  const named = placesNamed(rawText);
  if (named.size === 0) return undefined;
  const outside = Object.values(PLACE_BY_NAME).find((code) => !named.has(code));
  if (outside === undefined) return undefined;
  // A radius, a county and a call district cannot be answered by naming a state, so the probe
  // STATES no answer to them: cleared, they come back `unknown`, which is never an `eligible` and
  // so can never make this rule flag a record it cannot read. A confident wrong answer is the
  // expensive kind, and that applies to the rule as much as to the product.
  return {
    profile: { ...ENFORCEMENT_PROBE, ...LOCATION_ONLY_STATE, state: outside },
    control: { ...ENFORCEMENT_PROBE, ...LOCATION_ONLY_STATE, state: [...named].sort()[0] },
    excluded: `state ${outside}`,
  };
}

function levelExcluded(rawText: string): Probe | undefined {
  // DOWNWARD ONLY, and this is W5's doctrine applied to the other ladder in the schema: "the
  // sentence's LOWEST named class is the most generous reading of what the funder asked for".
  // Upward is not probed at all, and the school-tier note on `levelsNamed` is why the question no
  // longer even arises: a funder who wrote "4-year college or university" named the building a
  // graduate student studies in, so GRAD is NAMED rather than arguably-excluded. Reading it the
  // other way would report a defect on every record whose funder wrote "college" and meant the
  // whole building, and that cry-wolf is how an exemption gets bolted on — measured, at a 36% rate,
  // in the ceiling case below.
  //
  // Downward is where the false include lives — and only when the sentence leaves a rung below.
  // "Any accredited 2- or 4-year college or university" names both tiers, whose bands cover the
  // whole ladder, so there is no such rung and this arm correctly builds no probe from it.
  const named = levelsNamed(rawText);
  if (named.length === 0) return undefined;
  const floor = Math.min(...named.map((l) => LEVEL_ORDER.indexOf(l)));
  if (floor <= 0) return undefined;
  const outside = LEVEL_ORDER[floor - 1];
  return {
    profile: { ...ENFORCEMENT_PROBE, degreeLevel: outside as DegreeLevel },
    control: { ...ENFORCEMENT_PROBE, degreeLevel: LEVEL_ORDER[floor] as DegreeLevel },
    excluded: `degreeLevel ${outside}`,
  };
}

function accreditationExcluded(rawText: string): Probe | undefined {
  if (!ACCREDITATION_REQUIRED.test(rawText)) return undefined;
  return {
    profile: { ...ENFORCEMENT_PROBE, accredited: false },
    control: ENFORCEMENT_PROBE,
    excluded: 'accredited false',
  };
}

function fullTimeExcluded(rawText: string): Probe | undefined {
  if (!FULL_TIME_REQUIRED.test(rawText) || PART_TIME_MENTIONED.test(rawText)) return undefined;
  return {
    profile: { ...ENFORCEMENT_PROBE, partTime: true },
    control: ENFORCEMENT_PROBE,
    excluded: 'partTime true',
  };
}

function stageExcluded(rawText: string): Probe | undefined {
  const named = ALL_STAGES.filter((s) => STAGE_SAYS[s].test(rawText));
  if (named.length === 0) return undefined;
  const outside = STAGE_PROBE_ORDER.find((s) => !named.includes(s));
  if (outside === undefined) return undefined;
  // `stagesSatisfiedBy` reads `degreeLevel` too, and a probe carrying BACH would satisfy an
  // UNDERGRAD tier no matter what stage it stated. The probe states its stage and nothing else.
  return {
    profile: { ...ENFORCEMENT_PROBE, stage: outside as StudentProfile['stage'], degreeLevel: undefined },
    control: { ...ENFORCEMENT_PROBE, stage: named[0] as StudentProfile['stage'], degreeLevel: undefined },
    excluded: `stage ${outside}`,
  };
}

function activityExcluded(rawText: string): Probe | undefined {
  const named = ALL_ACTIVITY_KINDS.filter((k) => ACTIVITY_SAYS[k].test(rawText));
  if (named.length === 0) return undefined;
  const outside = ALL_ACTIVITY_KINDS.find((k) => !named.includes(k));
  if (outside === undefined) return undefined;
  return {
    profile: { ...ENFORCEMENT_PROBE, activityKinds: [outside as ActivityKind] },
    control: { ...ENFORCEMENT_PROBE, activityKinds: named as ActivityKind[] },
    excluded: `activityKinds [${outside}]`,
  };
}

function licenseExcluded(rawText: string): Probe | undefined {
  if (ANY_CLASS.test(rawText)) return undefined;
  const named = classesNamed(rawText);
  if (named.length === 0) return undefined;
  const floor = Math.min(...named.map((n) => LICENSE_RANK[n]));
  const below = Object.keys(LICENSE_RANK).find((k) => LICENSE_RANK[k] === floor - 1);
  if (below === undefined) return undefined;
  return {
    profile: { ...ENFORCEMENT_PROBE, licenseClass: below as StudentProfile['licenseClass'] },
    control: ENFORCEMENT_PROBE,
    excluded: `licenseClass ${below}`,
  };
}

function citizenshipExcluded(rawText: string): Probe | undefined {
  if (CITIZENSHIP_SAYS_ANY.test(rawText)) return undefined;
  if (!/\bcitizen/i.test(rawText) && !CITIZENSHIP_SAYS_RESIDENT.test(rawText)) return undefined;
  // `Citizenship` has no "neither" member; `'ANY'` on a PROFILE is the applicant who is neither
  // a citizen nor a resident, which is what `evaluateTier`'s allow-list test does with it.
  return {
    profile: { ...ENFORCEMENT_PROBE, citizenship: 'ANY' },
    control: ENFORCEMENT_PROBE,
    excluded: 'citizenship neither',
  };
}

function gpaExcluded(rawText: string): Probe | undefined {
  const named = gpasNamed(rawText);
  if (named.length === 0) return undefined;
  const floor = Math.min(...named);
  if (floor <= 0) return undefined;
  return {
    profile: { ...ENFORCEMENT_PROBE, gpa: Math.max(0, floor - 0.5), classRankTopPct: 100 },
    control: { ...ENFORCEMENT_PROBE, gpa: floor, classRankTopPct: 1 },
    excluded: `gpa ${Math.max(0, floor - 0.5)}`,
  };
}

/**
 * ALL NINE LADDERS, each named with the axis that OWNS it — the axis whose own constraint W10 holds
 * responsible for it. A rule reading these cross-axis skips the owner, so W10 and W11 can never
 * report one record twice and a fix cannot close one rule by hiding in the other.
 *
 * THIS FULL SET IS NOT WHAT W11 READS. It is the naive rule, kept because the measurement against it
 * is the evidence for reading one ladder instead of nine — see `CREDENTIAL_NAMED` and the
 * all-nine-ladders case below. `CROSS_AXIS_LADDERS` is the set that ships.
 */
const SENTENCE_LADDERS: Array<{ owner: ConstraintSpec['axis']; read: (rawText: string) => Probe | undefined }> = [
  { owner: 'geography', read: placeExcluded },
  { owner: 'institution', read: levelExcluded },
  { owner: 'institution', read: accreditationExcluded },
  { owner: 'institution', read: fullTimeExcluded },
  { owner: 'age_stage', read: stageExcluded },
  { owner: 'ham_activity', read: activityExcluded },
  { owner: 'license', read: licenseExcluded },
  { owner: 'citizenship', read: citizenshipExcluded },
  { owner: 'gpa', read: gpaExcluded },
];

/**
 * W10's reading: the ladders belonging to THIS constraint's own axis, plus the two spec-dependent
 * guards that cannot be decided from a sentence. W10 asks whether one constraint's own spec
 * enforces its own sentence, so it is right for it to stay keyed on the axis; W11 asks whether the
 * PROGRAM enforces the sentence, and reads all nine.
 */
function theApplicantsTheSentenceExcludes(spec: ConstraintSpec, rawText: string): Probe[] {
  switch (spec.axis) {
    case 'geography':
      // A radius, a call district and a county tier publishes no state to compare against.
      //
      // `any` IS answerable, and W1 skipping it is the difference between the two questions. W1
      // asks which values a tier admits, and `any` publishes none to check. W10 asks whether the
      // tier refuses anybody, and `any` is the single widest answer to that on this axis: a tier
      // that admits everywhere, under a sentence that named two states, is the whole subject of
      // this rule. Skipping it would make D2 unable to reach the geography axis at all.
      if (
        geoTiers(spec).some(
          (g) => g.type !== 'state' && g.type !== 'arrl_division' && g.type !== 'arrl_section' && g.type !== 'any',
        )
      ) {
        return [];
      }
      return [placeExcluded(rawText)].filter((p): p is Probe => p !== undefined);
    case 'institution':
      return [levelExcluded(rawText), accreditationExcluded(rawText), fullTimeExcluded(rawText)].filter(
        (p): p is Probe => p !== undefined,
      );
    case 'age_stage':
      return [stageExcluded(rawText)].filter((p): p is Probe => p !== undefined);
    case 'ham_activity':
      return [activityExcluded(rawText)].filter((p): p is Probe => p !== undefined);
    case 'license':
      return [licenseExcluded(rawText)].filter((p): p is Probe => p !== undefined);
    case 'citizenship':
      return [citizenshipExcluded(rawText)].filter((p): p is Probe => p !== undefined);
    case 'gpa':
      return [gpaExcluded(rawText)].filter((p): p is Probe => p !== undefined);
    case 'field_of_study': {
      // A TIER WITH NO FIELDS IS A ROUTE THAT IS NOT ABOUT THE FIELD OF STUDY, and it is the
      // funder's own. IRARC's "Undergraduate degree or electronic technician certification program"
      // mints an `anyOf` tier with `fields: []`; an award open to any undergraduate is open to a
      // poetry undergraduate, in the funder's words. W9 pins that record from the other side.
      if (tiers(spec).some((t) => t.axis === 'field_of_study' && t.fields.length === 0)) return [];
      // W7 proved every entry in `fields` is a quotation of the sentence, so the sentence names
      // exactly the list; a major sharing no word with any of them is outside all of it.
      const outside = PLAINLY_UNRELATED[0];
      return [
        {
          profile: { ...ENFORCEMENT_PROBE, fieldOfStudy: outside },
          control: ENFORCEMENT_PROBE,
          excluded: `fieldOfStudy ${outside}`,
        },
      ];
    }
    default:
      // `arrl_membership`, `recommendation`, `financial_need`, `gender` and `other` publish no
      // allow-list or floor a sentence could be read against; they are counted, never flagged.
      return [];
  }
}

/** Is this sentence one the funder opened or answered outright? Then it bars nobody, correctly. */
function funderDeclinedToBar(rawText: string): boolean {
  return (
    OPENED_LIST.test(rawText) ||
    GEO_WIDENED.test(rawText) ||
    ANY_CLASS.test(rawText) ||
    CITIZENSHIP_SAYS_ANY.test(rawText)
  );
}

/**
 * THE FOURTH WAY, AND IT IS THE ONE WORTH READING TWICE. `orUnrepresented` turns every `fail` on a
 * constraint into an `unknown` with nothing to fill in. It is deliberate and it is defended:
 * `unadjudicable.test.ts` exists because thirty records carry a BARE DOMAIN — "Science, Technology,
 * Engineering or Mathematics" — whose membership is not word overlap, and reading one as a closed
 * list refused a PHYSICS undergraduate. The honest answer there is that the schema cannot decide,
 * and that is what the field says.
 *
 * So a constraint carrying it refuses nobody BY DESIGN, and W10 must not call that an over-claim —
 * doing so would push the corpus straight back toward the false excludes seven rounds drained.
 *
 * IT IS ALSO EXACTLY D3. The same field, set on a constraint that did not need it, disarms that
 * constraint completely while changing not one admitted value. Every value-width rule in this file
 * is blind to it, and so, by this exemption, is W10a's offender list. What is NOT blind is W10a's
 * COVERAGE: a corpus where every constraint carries the field is a corpus W10a can check nothing
 * in, and `checked` falls to zero. The battery asserts that, and it is the honest form of the
 * claim — a rule reports a disarm either by flagging more or by having nothing left to say.
 */
function funderNamedARouteTheSchemaCannotCheck(spec: ConstraintSpec): boolean {
  return tiers(spec).some((t) => t.orUnrepresented !== undefined) || spec.orUnrepresented !== undefined;
}

/** One pass of W10a over a corpus, so the rule and the battery below cannot drift apart. */
interface EnforcementCensus {
  admitsEverybody: string[];
  checked: number;
  probes: number;
  opened: number;
  unrepresented: number;
  typeOnly: number;
  silent: number;
}

/**
 * THE SENTENCE NAMES A SCHOOL TIER AND THIS RULE STILL BUILDS NO PROBE FROM IT. Two records, and
 * they are here for two different reasons, both named so that a third of either kind is a question
 * asked again rather than a silent arrival:
 *
 *   Tom and Judith Comstock   "Applicant must be a high school senior accepted at a 2 or 4-year
 *                             college or a student currently enrolled at a 2 or 4-year college."
 *                             Both tiers named, so their bands cover the whole credential ladder and
 *                             no rung is outside; no accreditation bar, no enrolment intensity. What
 *                             the sentence DOES exclude is a student whose school is neither — a
 *                             trade school, an unaccredited academy — and `matcher.ts` says in its
 *                             own words that it cannot ask: "tradeSchoolOK is informational:
 *                             CONTRACT §3 has no profile field for it." A SCHEMA gap, not a record
 *                             defect, counted rather than flagged for exactly the reason
 *                             `orUnrepresented` is: flagging it would demand a refusal the product
 *                             has no question with which to justify itself.
 *
 *   NEAR-Fest Memorial        "Any undergraduate degree or a two-year technical school in radio
 *                             communications." The lowest rung named is the lowest rung there is, so
 *                             nothing is below it. What this sentence bounds is a CEILING — it
 *                             stops short of GRAD — and W10's institution arm is downward-only by
 *                             doctrine. Its spec publishes `['CERT','ASSOC','BACH']` and does refuse
 *                             a graduate student, so nothing is wrong here; it is simply a bar this
 *                             rule declines to measure. Why it declines is measured, not assumed —
 *                             see the note on the ceiling below.
 */
function boundsTheSchoolTypeOnly(spec: ConstraintSpec, rawText: string): boolean {
  return (
    spec.axis === 'institution' &&
    theApplicantsTheSentenceExcludes(spec, rawText).length === 0 &&
    TIER_AWARDS.some(([tier]) => tier.test(rawText))
  );
}

function readEnforcementWidth(all: Array<{ program: Program; c: Constraint }>): EnforcementCensus {
  const census: EnforcementCensus = {
    admitsEverybody: [], checked: 0, probes: 0, opened: 0, unrepresented: 0, typeOnly: 0, silent: 0,
  };
  for (const { program, c } of all) {
    const probes = theApplicantsTheSentenceExcludes(c.spec, c.rawText);
    if (probes.length === 0) {
      if (boundsTheSchoolTypeOnly(c.spec, c.rawText)) census.typeOnly += 1;
      else census.silent += 1;
      continue;
    }
    if (funderDeclinedToBar(c.rawText)) {
      census.opened += 1;
      continue;
    }
    if (funderNamedARouteTheSchemaCannotCheck(c.spec)) {
      census.unrepresented += 1;
      continue;
    }
    census.checked += 1;
    // EVERY applicant the sentence excludes, not the first one. A constraint that refuses the
    // unaccredited student and admits the certificate student has enforced half of its sentence,
    // and a rule that stopped at the first probe would call that clean.
    for (const probe of probes) {
      census.probes += 1;
      const verdict = evaluateConstraint(c.spec, probe.profile, NOW, c.rawText);
      if (verdict.status !== 'fail') {
        census.admitsEverybody.push(
          `${program.name} [${c.spec.axis}] ${probe.excluded} -> ${verdict.status} — ${JSON.stringify(c.rawText.slice(0, 90))}`,
        );
      }
    }
  }
  census.admitsEverybody.sort();
  return census;
}

/**
 * THE RECORDS WHERE A STATED REQUIREMENT ENFORCES NOTHING. THERE ARE NONE, AND THE LIST IS EMPTY.
 *
 * IT HELD 26 AT THE START OF ROUND NINE, all one defect on one axis: the funder wrote a degree level
 * into their own sentence and `institution.ts` published `degreeLevels: []`, so a student one rung
 * BELOW the floor the funder wrote was told `eligible` by a HARD constraint. The previous gate agent
 * pinned them rather than fixing them and wrote "WHY PINNED AND NOT FIXED HERE… It is reported in the
 * round summary." That comment is deleted with the list, because AN ALLOWLIST THAT OUTLIVES ITS
 * DEFECT IS HOW A FIXED BUG COMES BACK: every remaining entry is a hole the rule has been instructed
 * not to see, and after one round nobody re-reads which.
 *
 * THE 26 CLOSED IN TWO DIFFERENT WAYS, and it matters which, because only one of them is a fix:
 *
 *   20 WERE A REAL DEFECT AND THE PRODUCT FIXED IT. `institution.ts` gained `statesAFourYearFloor`:
 *      a bare four-year school tier, on a sentence where no clause created a level and no lower tier
 *      is named, now publishes `['BACH','GRAD']` instead of `[]`. Measured end-to-end below, on the
 *      Bendicksen record, through `matchProgram`: an associate-degree student who read `eligible`
 *      now reads `ineligible`, and the bachelor's and graduate applicants the funder DID name are
 *      untouched.
 *
 *    6 WERE THIS RULE CRYING WOLF, and no product change was needed or made. All six read "…2- or
 *      4-year college or university", and W10 accused them of admitting a CERTIFICATE student the
 *      sentence excluded. The sentence does not exclude them: a certificate student at an accredited
 *      two-year college is a student at a two-year college, and the union of the two named tiers is
 *      the entire credential ladder. The bug was in `levelsNamed`, which read a BUILDING as a
 *      CREDENTIAL — see the school-tier note above, which fixes both directions of it at once.
 *      Five of the six were never toothless in the first place: they publish
 *      `accreditationRequired: true` and refuse an applicant at an unaccredited school, which this
 *      rule could not see because it probed one of the institution axis's three enforceable fields.
 *      It now probes all three it can build an applicant for.
 *
 * SO THE PIN IS RETIRED AND THE COVERAGE IS LARGER, which is the only combination worth having:
 * 203 constraints checked -> 238, over 271 probes rather than 203, and W3's own population went
 * 33 -> 53 as the 20 stopped being skipped for holding nothing.
 *
 * IT MAY ONLY EVER GROW BACK THROUGH A RED TEST. An empty equality is the strongest form this
 * assertion has: any record that starts admitting the applicant its own sentence excludes fails
 * here with its own name in the diff, and there is no longer any list to quietly add it to.
 */
const KNOWN_TOOTHLESS: string[] = [];

/** One pass of W10b, shared with the battery for the same reason `readEnforcementWidth` is. */
interface EnforcementReach {
  notedOnly: string[];
  checked: number;
  preferences: number;
}

function readEnforcementReach(all: Array<{ program: Program; c: Constraint }>): EnforcementReach {
  const reach: EnforcementReach = { notedOnly: [], checked: 0, preferences: 0 };
  for (const { program, c } of all) {
    const probes = theApplicantsTheSentenceExcludes(c.spec, c.rawText);
    if (probes.length === 0 || funderDeclinedToBar(c.rawText)) continue;
    if (funderNamedARouteTheSchemaCannotCheck(c.spec)) continue;
    // W10b is asked only of a spec that CAN refuse. A spec that cannot is W10a's finding, and
    // reporting it twice would let one fix close two rules and hide whichever it did not fix.
    if (!probes.some((probe) => evaluateConstraint(c.spec, probe.profile, NOW, c.rawText).status === 'fail')) continue;
    if (PREFERRED.test(c.rawText) || CASCADE_CONDITION.test(c.rawText)) {
      reach.preferences += 1;
      continue;
    }
    reach.checked += 1;
    if (!c.hard) {
      reach.notedOnly.push(`${program.name} [${c.spec.axis}] — ${JSON.stringify(c.rawText.slice(0, 90))}`);
    }
  }
  reach.notedOnly.sort();
  return reach;
}

/**
 * TWO SENTENCES WHERE A REFUSAL IS AVAILABLE AND NOT ENFORCED, and both are `preference.ts` doing
 * exactly what it was built to do. MARCO and John C. York both write "Applicants SHOULD describe
 * how they have engaged in volunteer and/or public service activities" — RFC 2119's SHOULD, which
 * `preference.ts` reads as a recommendation and softens, and the block comment in that file records
 * that before it did, both awards were a hard `ineligible` on `ham_activity` for every licensed
 * individual in the corpus.
 *
 * So the sentence states a requirement in the grammatical sense while the funder's own modal says
 * it is a recommendation, and soft is right. They are named rather than pattern-exempted, because
 * a THIRD record arriving here is a question worth being asked again — a bare "should" softening a
 * requirement is the recoverable direction, but it is not free.
 */
const KNOWN_NOTED_ONLY = [
  'The John C. York, KE5V, Scholarship [ham_activity] — "Applicants should describe how they have engaged iin volunteer and/or public service activ"',
  'The Medical Amateur Radio Council (MARCO) Scholarship [ham_activity] — "1) Applicants should be able to describe how they have engaged in volunteer and/or public "',
];

describe('W10 — a sentence that states a requirement, over a constraint that bars nobody', () => {
  it('every closed sentence produces a spec that can refuse the applicant it excludes', async () => {
    const census = readEnforcementWidth(await everyConstraint());
    expect(census.admitsEverybody).toEqual(KNOWN_TOOTHLESS);
    // Vacuity guard, and these six numbers add to all 652 constraints in the corpus — every one is
    // either checked or in a named bucket, and no constraint falls out of this rule unseen.
    //
    //   checked        238  the funder named values on an axis this schema holds, and closed them.
    //                       203 UNTIL ROUND NINE. It rose because the institution arm now builds an
    //                       applicant from all three enforceable fields of that axis rather than
    //                       one: 35 constraints state an accreditation or a full-time bar without
    //                       stating a degree floor, and every one of them was `silent` before.
    //   probes         260  applicants built, which is the number of chances the rule had to be
    //                       wrong. It took none.
    //   opened          36  "etc.", "such as", "or similar" — the funder declining to close a list.
    //   unrepresented   44  `orUnrepresented` — see the note on it above; this is D3 occurring
    //                       naturally, and it is the bucket to watch, because a constraint moving
    //                       INTO it stops being checked at all.
    //   typeOnly         2  the sentence bounds the school and this rule builds no applicant from
    //                       it — Comstock and NEAR-Fest, both named above, for two reasons.
    //   silent         332  the sentence names nothing on an axis a sentence can be read against —
    //                       `recommendation`, `financial_need`, `other`, and the many records whose
    //                       rawText is "Any" or a bare place name on an axis about schooling.
    //                       329 UNTIL `membership.ts` LEARNED THE SECOND WORD ORDER. "Must be a
    //                       member of ARRL" (North Fulton), the same sentence in You've Got a
    //                       Friend in Pennsylvania, and Hesselbrock's "must have been a member of
    //                       the ARRL for a minimum of one year" now produce an `arrl_membership`
    //                       constraint each instead of surviving only as the soft `other` catch-all.
    //                       They land here because `theApplicantsTheSentenceExcludes` builds no
    //                       applicant on that axis — the same bucket the four membership sentences
    //                       this corpus already parsed have always been in.
    expect({
      checked: census.checked,
      probes: census.probes,
      opened: census.opened,
      unrepresented: census.unrepresented,
      typeOnly: census.typeOnly,
      silent: census.silent,
    }).toEqual({ checked: 238, probes: 260, opened: 36, unrepresented: 44, typeOnly: 2, silent: 332 });
    expect(
      census.checked + census.opened + census.unrepresented + census.typeOnly + census.silent,
    ).toBe((await everyConstraint()).length);
  });

  /**
   * …AND THE 20 THAT WERE REAL ARE FIXED, read end-to-end rather than off the spec.
   * `evaluateConstraint` returning `pass` is not by itself a claim about a student; `matchProgram`
   * returning `eligible` is. This case takes the record the pin named first, hands the whole program
   * to the matcher, and shows the verdict a community-college student is now actually shown.
   *
   * IT IS THE SAME CASE, INVERTED RATHER THAN DELETED. The previous gate agent's instruction was
   * "WHEN THESE LINES GO RED THE DEFECT IS FIXED: delete this case and the 26 entries above."
   * Deleting it would leave nothing standing between this corpus and the defect coming back, and a
   * fix with no test is a fix until the next extractor change. Every line below is the line that was
   * there, with the expectation moved to what the funder's sentence says.
   */
  it('…and the false include is closed: the verdict a student one rung below the floor is shown', async () => {
    const { programs } = await corpus();
    const bendicksen = programs.find((p) => p.name.includes('Bendicksen'));
    if (bendicksen === undefined) throw new Error('The Richard W. Bendicksen Scholarship is missing from the corpus');
    const inst = bendicksen.constraints.find((c) => c.spec.axis === 'institution');
    if (inst === undefined) throw new Error('Bendicksen states an institution requirement and it is missing');
    // From the sentence first: change the funder's wording and this line fails before the rest.
    expect(inst.rawText).toContain('4-year college');
    expect(inst.hard).toBe(true);
    // The four-year tier names the band that school awards, and nothing below it.
    expect(levelsNamed(inst.rawText)).toEqual(['BACH', 'GRAD']);
    // The axis now refuses an associate-degree student…
    const assoc = { ...ENFORCEMENT_PROBE, degreeLevel: 'ASSOC' as const };
    expect(evaluateConstraint(inst.spec, assoc, NOW, inst.rawText).status).toBe('fail');
    // …and that refusal reaches the verdict, through the whole matcher, on the funder's own program.
    const alone: Program = { ...bendicksen, constraints: [inst] };
    expect(matchProgram(assoc, alone, NOW).kind).toBe('ineligible');
    // A CERTIFICATE student is one further down and must be refused too — the rung this rule probes.
    expect(matchProgram({ ...ENFORCEMENT_PROBE, degreeLevel: 'CERT' }, alone, NOW).kind).toBe('ineligible');
    // THE OTHER DIRECTION, and it is the half a fix in this direction can quietly undo: both
    // applicants the funder DID name are admitted, and the graduate student is the one an over-tight
    // reading ("4-year" names BACH alone) would have newly refused. Zero false excludes was the
    // measured state at the start of this round and it is not this round's to spend.
    expect(matchProgram(ENFORCEMENT_PROBE, alone, NOW).kind).toBe('eligible');
    expect(matchProgram({ ...ENFORCEMENT_PROBE, degreeLevel: 'GRAD' }, alone, NOW).kind).toBe('eligible');
  });

  /**
   * THE CEILING IS NOT PROBED, AND THAT IS A MEASUREMENT RATHER THAN A PREFERENCE.
   *
   * W10's institution arm is downward-only. Once `levelsNamed` stopped reading a four-year school as
   * the single rung BACH, the obvious next question was whether the doctrine still held — a funder
   * who names "any undergraduate degree" has put a doctoral candidate outside just as plainly as a
   * funder who names "4-year college" has put a certificate student outside.
   *
   * SO IT WAS RUN. Across the corpus, 14 institution sentences name a band with a rung above it, and
   * probing one rung above the highest named flags 5. Every one of the 5 is this rule crying wolf,
   * and all 5 are one shape — a funder who wrote a bare school noun with no tier on it:
   *
   *   Frankford Radio Club   "Any accredited college, university or trade school"          -> ASSOC
   *   Harry A. Hodges W6YOO  "Any accredited college, university, junior college or trade
   *                           technical school in the United States"                       -> BACH
   *   Magnolia DX            "…an accredited college, university, or technical school"     -> ASSOC
   *   Palomar ARC            "Accredited college, university, junior college or trade school" -> BACH
   *   Ronald Hesselbrock     "Any community college, college, university or trade school…"  -> BACH
   *
   * "Any accredited college or university" names no year tier, so the vocabulary reads only the
   * "trade school" in it and computes a ceiling at CERT — and then reports an over-claim because an
   * ASSOC student is admitted. That is absurd on its face, and a rule shipped in that state gets an
   * exemption bolted on, which the header says is where the real offender walks through.
   *
   * A 36% cry-wolf rate is the finding. It is recorded rather than acted on, and this case pins the
   * shape so the next round starts from the measurement instead of re-running it.
   */
  it('…and the ceiling stays unprobed, because a bare "college" names no tier at all', () => {
    // The five above, in one sentence: nothing but "trade school" is a level word here.
    expect(levelsNamed('Any accredited college, university or trade school')).toEqual(['CERT']);
    // …so a ceiling read off that sentence would sit at CERT and call an associate student excluded,
    // which the funder's own "any accredited college" plainly admits. No such applicant is built.
    // The accreditation bar the funder DID write is, and it is the only one on this sentence.
    expect(theApplicantsTheSentenceExcludes(
      institutionAdmitting(['CERT', 'ASSOC', 'BACH', 'GRAD']),
      'Any accredited college, university or trade school',
    ).map((p) => p.excluded)).toEqual(['accredited false']);
    // A sentence that DOES name a tier is read, and downward only.
    const probes = theApplicantsTheSentenceExcludes(
      institutionAdmitting(['BACH', 'GRAD']),
      'Accredited 4-year college or university',
    );
    expect(probes.map((p) => p.excluded)).toEqual(['degreeLevel ASSOC', 'accredited false']);
  });

  /**
   * W10b — AND THE REFUSAL HAS TO REACH THE VERDICT. A spec that can fail, hanging off a SOFT
   * constraint, bars nobody: `matchProgram` reads a soft failure as a preference not met and
   * returns `eligible`. This is the only rule in this file that reads `c.hard`, and it is the half
   * that D1 moves.
   */
  it('a closed requirement that is not a preference is enforced, not merely noted', async () => {
    const w10b = readEnforcementReach(await everyConstraint());
    expect(w10b.notedOnly).toEqual(KNOWN_NOTED_ONLY);
    // Vacuity guard: requirements stated flatly, over specs that really can refuse the applicant
    // the sentence excludes, where the only remaining question is whether the refusal is enforced.
    // The `preferences` bucket is the funder RANKING rather than barring — "preference will be
    // given to…", "if no qualified applicant is identified…" — where soft is the right answer and
    // `matchProgram` ordering them is what the funder asked for.
    //
    // 144 AND 33 UNTIL ROUND NINE. Both rose for the same two reasons W10a's `checked` did: the 20
    // records that now publish a floor can refuse somebody for the first time, and the accreditation
    // probe reaches constraints whose sentence states no degree floor at all. Every one of the 60
    // new arrivals is a hard constraint; the list of requirements stated and not enforced did not
    // grow by one.
    expect({ checked: w10b.checked, preferences: w10b.preferences }).toEqual({ checked: 204, preferences: 34 });
  });

  /**
   * THE DISARM BATTERY — the procedure the header describes, run as a test.
   *
   * Each mutation removes one whole mechanism by which this product refuses anybody, and W10 must
   * notice every one. A mutation W10 survives is a mutation W10 is blind on, and the assertion
   * names which. Run the same four against W1-W8 and all four come back green, which is the
   * measurement this block exists to record.
   */
  it('goes red when the product is disarmed, by each of the four ways it can be disarmed', async () => {
    const all = await everyConstraint();
    const mutated = (mutate: (c: Constraint) => Constraint) =>
      all.map(({ program, c }) => ({ program, c: mutate(c) }));

    // THE CONTROL. The corpus as it stands, read by the same two functions the rules above call —
    // so a disarm cannot be reported green here by a battery that drifted from the rule.
    const w10a = readEnforcementWidth(all);
    const w10b = readEnforcementReach(all);
    expect(w10a.admitsEverybody).toHaveLength(0);
    expect(w10a.checked).toBe(238);
    expect(w10b.notedOnly).toHaveLength(KNOWN_NOTED_ONLY.length);
    expect(w10b.checked).toBe(204);

    // D1 — EVERY HARD CONSTRAINT BECOMES SOFT. Every requirement in the product stops barring
    // anyone: `matchProgram` demotes a soft failure to "preference not met" and returns `eligible`.
    // W1 through W8 do not move by a single assertion. W10b flags every one of the 204.
    const d1 = readEnforcementReach(mutated((c) => ({ ...c, hard: false })));
    expect(d1.notedOnly).toHaveLength(204);
    // AND THE PROOF THAT D1 IS INVISIBLE TO A VALUE-WIDTH RULE, made here rather than asserted
    // about W1-W8 from outside them. Every one of those rules reads `c.spec` and `c.rawText` and
    // nothing else; so does `readEnforcementWidth`; so its census is IDENTICAL under D1. Any rule
    // with those two inputs is blind to this mutation by construction, and that is the whole
    // reason W10b had to read a third one. (Run for real, once, by softening `everyConstraint`:
    // W1 through W9 stayed green and the only two failures in the file were W10's.)
    expect(readEnforcementWidth(mutated((c) => ({ ...c, hard: false })))).toEqual(w10a);

    // D2 — EVERY SPEC BECOMES ITS EMPTY FORM, so no tier holds a value to test against. Value-width
    // is untouched in the only sense W1-W8 can measure: an empty list admits no value they can
    // find, so they skip it at `if (admitted.size === 0) continue`. W10a checks 246 rather than
    // 238 — an emptied geography tier is `any`, which this rule reads and W1 does not — and flags
    // every single applicant it can build.
    const d2 = readEnforcementWidth(mutated((c) => ({ ...c, spec: emptied(c.spec) })));
    expect({ flagged: d2.admitsEverybody.length, checked: d2.checked }).toEqual({ flagged: 268, checked: 246 });
    // Every PROBE the rule can still build is flagged — no survivors, not "most". `emptied` clears
    // `accreditationRequired` and opens `partTimeOK`, so the two institution bars added this round
    // are disarmed by D2 as well and this line is what proves it: 268 probes, 268 flags.
    expect(d2.admitsEverybody).toHaveLength(d2.probes);

    // D3 — EVERY CONSTRAINT GAINS `orUnrepresented`, which turns every `fail` into an `unknown`
    // with nothing to fill in, while changing not one admitted value.
    //
    // AND HERE IS THE BLIND SPOT, REPORTED RATHER THAN HIDDEN. W10a exempts that field, for the
    // reason `funderNamedARouteTheSchemaCannotCheck` gives, so its offender list does NOT grow —
    // it empties. What moves instead is COVERAGE: 238 constraints checked falls to none, and 282
    // land in a bucket that asks them nothing. A rule with nothing left to say has said something.
    const d3 = readEnforcementWidth(
      mutated((c) => ({ ...c, spec: { ...c.spec, orUnrepresented: 'the funder named another route' } })),
    );
    expect(d3.checked).toBe(0);
    expect(d3.admitsEverybody).toEqual([]);
    expect(d3.unrepresented).toBe(282);

    // D4 — EVERY FIELD LIST IS WIDENED: W9's mechanism, applied corpus-wide. Narrower than D2 by
    // construction, since it reaches only the one axis that has a widening — which is the point of
    // running it separately. It is the mutation that actually shipped, in round seven.
    const d4 = readEnforcementWidth(mutated((c) => ({ ...c, spec: widenedFields(c.spec) })));
    expect(d4.admitsEverybody.length).toBeGreaterThan(w10a.admitsEverybody.length);
    expect(d4.admitsEverybody.filter((o) => o.includes('[field_of_study]'))).toHaveLength(
      d4.admitsEverybody.length - w10a.admitsEverybody.length,
    );
  });

  /**
   * AND THE BATTERY IS RUN AGAINST W11 TOO, which is the whole reason it was written as a procedure
   * rather than as an argument: a new guard should be answerable by running the existing battery,
   * not by re-reading a thousand lines of prose to decide whether to believe it.
   *
   * W11 reads a VERDICT rather than a spec, so it is D1 and D2 that reach it — D1 because a soft
   * constraint's refusal never reaches `matchProgram`'s verdict, D2 because an emptied spec has
   * nothing to refuse with. Both must move it, and both are asserted below. A third mutation is
   * asserted NOT to move it, and that is the honest half: D3 sets `orUnrepresented`, which turns a
   * `fail` into an `unknown`, and `unknown` is not an `eligible` — W11 is deliberately blind to it,
   * for the reason the doctrine gives, and blind is what it is asserted to be rather than assumed.
   */
  it('and W11 goes red under the same battery, on the two mutations that can reach a verdict', async () => {
    const { programs } = await corpus();
    const mutatedPrograms = (mutate: (c: Constraint) => Constraint): Program[] =>
      programs.map((p) => ({ ...p, constraints: p.constraints.map(mutate) }));

    // THE CONTROL: the corpus as it stands, read by the same function the rule above calls.
    expect(readCrossAxisReach(programs).enforcedNowhere).toEqual([]);

    // D1 — every hard constraint becomes soft, so no refusal reaches a verdict. W11 must notice.
    // Its own `noted` bucket hands soft constraints to W10b, so what moves here is COVERAGE: every
    // one of the seven it was checking lands in a bucket that asks it nothing. A rule with nothing
    // left to say has said something — the same shape D3 takes for W10a.
    const d1 = readCrossAxisReach(mutatedPrograms((c) => ({ ...c, hard: false })));
    expect(d1.checked).toBe(0);
    expect(d1.noted).toBe(7);

    // D2 — every spec becomes its empty form, so the sentences are untouched and nothing enforces
    // them. This is the mutation that produces the exact shape 20 records were in this round, and
    // W11 flags every record it can still reach.
    const d2 = readCrossAxisReach(mutatedPrograms((c) => ({ ...c, spec: emptied(c.spec) })));
    expect(d2.enforcedNowhere.length).toBeGreaterThan(0);
    expect(d2.enforcedNowhere).toHaveLength(d2.checked);

    // D3 — and here is where it is blind, asserted rather than argued. `orUnrepresented` softens
    // every `fail` to an `unknown`, and W11 counts `unknown` as the programme declining to admit
    // the applicant, which is the doctrine and is not negotiable. So the offender list does not
    // grow. What moves is nothing at all: unlike W10a, W11 has no bucket that catches this, and
    // that is a real hole in the battery's coverage of this rule rather than a property of it.
    const d3 = readCrossAxisReach(
      mutatedPrograms((c) => ({ ...c, spec: { ...c.spec, orUnrepresented: 'the funder named another route' } })),
    );
    expect(d3.enforcedNowhere).toEqual([]);
  });
});

/** Each axis's spec stripped to the form that tests nothing — D2's mutation. */
function emptied(spec: ConstraintSpec): ConstraintSpec {
  switch (spec.axis) {
    case 'geography':
      return { ...spec, geo: { type: 'any', values: [] }, anyOf: undefined };
    case 'institution':
      return { ...spec, degreeLevels: [], accreditationRequired: false, partTimeOK: true, anyOf: undefined };
    case 'age_stage':
      return { ...spec, stages: [], ageMin: undefined, ageMax: undefined, anyOf: undefined };
    case 'ham_activity':
      return { ...spec, activityKinds: [], cwProficiencyWpmMin: undefined, proofRequired: false, anyOf: undefined };
    case 'license':
      return { ...spec, licenseMin: 'NONE', heldMonthsMin: undefined, anyOf: undefined };
    case 'citizenship':
      return { ...spec, allowed: ['ANY'], anyOf: undefined };
    case 'field_of_study':
      return { ...spec, fields: [], excludedFields: [], anyOf: undefined };
    case 'gpa':
      return { ...spec, min: undefined, classRankTopPct: undefined, anyOf: undefined };
    default:
      return spec;
  }
}

/** A field list opened by the funder — D4's mutation, and the shape `matcher.ts` reads as widened. */
function widenedFields(spec: ConstraintSpec): ConstraintSpec {
  if (spec.axis !== 'field_of_study' || spec.fields.length === 0) return spec;
  return { ...spec, fields: [...spec.fields, 'or related fields'] };
}

// ================================= W11: the axis the sentence was NOT filed under

/**
 * A FUNDER WRITES ONE SENTENCE. THIS PRODUCT FILES IT UNDER AN AXIS. W10 THEN CHECKS IT AGAINST THE
 * AXIS IT WAS FILED UNDER, AND NOTHING ELSE.
 *
 * That is the blind spot, stated plainly. `theApplicantsTheSentenceExcludes` switches on
 * `spec.axis`, so "Bachelor's degree or higher in electronics, communications, or related fields" —
 * recorded as `field_of_study`, because the fields are what that clause was split for — is never
 * read for the degree floor sitting in its first three words. Nine records in this corpus write a
 * credential into a `field_of_study` sentence; more write one into `geography` ("Residence or
 * student of 4-year university or college in Oklahoma"), into `gpa` ("Any fully accredited 4-year US
 * college or university or graduate school thereof, and have a GPA of 3.0"), into `age_stage`, into
 * `citizenship`. W10 sees none of them.
 *
 * The previous verifier swept those by hand, found all five non-pinned hits dissolved on reading,
 * and said so honestly: THE PIN LIST WAS COMPLETE BY HAND CHECK, NOT BY ANY RULE. A hand check does
 * not survive the next record. This is the rule.
 *
 * ============================== WHAT IT ASKS, AND WHY AT THE PROGRAM ==========================
 * W10 asks whether ONE CONSTRAINT's spec enforces its own sentence. That is the right question for
 * the axis a sentence was filed under, and the wrong one for every other axis: nobody should demand
 * that a `field_of_study` spec hold a degree floor. The obligation belongs where the reader meets
 * it — the VERDICT. So W11 asks:
 *
 *   the funder's sentence puts this applicant outside the award. Does `matchProgram`, given the
 *   whole programme, decline to tell them `eligible`?
 *
 * `unknown` counts as declining. It is the answer this product prefers over a confident wrong one,
 * it costs the applicant nothing, and demanding a refusal instead would push the corpus back toward
 * the false excludes seven rounds drained. Only `eligible` and `eligible_preferred` are flagged,
 * because only those two spend somebody's application fee.
 *
 * ==================== AND HOW WOULD YOU KNOW *THIS* GUARD IS BLIND? ==========================
 * This is the fourth guard in four rounds to be asked, and the question deserves better than the
 * assurance the previous three gave. The three failures — a copy census that dropped every
 * interpolated sentence, an R6 fixture whose applicant could not reach the failure it existed to
 * catch, W1-W8 surviving the entire product being disarmed — share ONE shape, and it is not
 * carelessness: THE GUARD'S PROBE COULD NOT REACH THE THING THE GUARD WAS ABOUT, and from inside the
 * guard everything looked fine, because everything it could see WAS fine.
 *
 * So the answer here is not prose. It is two mechanisms, and both are numbers that go red:
 *
 *   1. THE CONTROL, PER PROBE. Every flagged applicant has a twin standing one rung higher — on a
 *      value the funder's own sentence NAMES — and W11 refuses to count a record at all unless that
 *      twin is told `eligible`. A programme whose Texas-only geography refuses this Connecticut
 *      probe for reasons having nothing to do with degrees is `unreachable`, not `checked`, and the
 *      two counts are pinned separately. The R6 defect cannot hide here: "the probe could not reach
 *      the failure" is not a silent pass, it is a number, and it is asserted to be smaller than the
 *      number of records the rule really did read.
 *
 *   2. THE DISARM BATTERY, EXTENDED. D1 and D2 already exist; W11 is asserted to go red under both,
 *      in the battery below, alongside W10. A rule that survives the product being disarmed is
 *      measuring something other than what it claims.
 *
 * AND HERE IS WHAT IT IS STILL BLIND TO, stated because a bounded claim is the only honest kind:
 *
 *   - `field_of_study` IS NOT ONE OF THE NINE LADDERS. Deciding that a major is outside a funder's
 *     list needs the list, which is a spec, not a sentence; W9 owns that question and owns it with a
 *     stronger instrument (it removes the widening and re-runs). Adding a tenth ladder here would
 *     re-decide it worse.
 *   - IT READS ONE SENTENCE AT A TIME. A floor assembled across two sentences of one programme —
 *     neither stating it alone — is invisible, and no measurement in this round says how common that
 *     is, because nothing looked.
 *   - IT IS A CENSUS OF THIS CORPUS. 150 programmes' worth of English. A wording no funder here uses
 *     is a wording none of the nine vocabularies has been tried against.
 */
/**
 * AND HERE IS WHY W11 READS ONE LADDER AND NOT NINE. THIS IS A MEASUREMENT, NOT A PREFERENCE.
 *
 * The obvious W11 reads every sentence against all nine ladders. It was built that way, run over the
 * corpus, and it flagged 81 records — 28 of them before the probe's home state was derived per
 * programme, and 81 once it was, which is itself worth noticing: making a rule REACH more made a
 * bad rule wrong more often. Every shape was read. NOT ONE IS A DEFECT. They are one mistake, made
 * nine ways, and it is worth stating exactly because it is not obvious from inside the rule:
 *
 *   THE VOCABULARIES OF W1-W8 ARE GENEROUS BY DESIGN, AND GENEROSITY DOES NOT SURVIVE INVERSION.
 *   Every list in this file "credits the sentence with every reading a funder could have meant", so
 *   that anything still flagged is a value NO reading supports. In the crediting direction that is
 *   safe: over-crediting produces FEWER accusations. W11 inverts them — "the funder excluded
 *   everything they did not name" — and there over-crediting MANUFACTURES exclusions, because a word
 *   that lands in a sentence about something else now stands for a bar the funder never wrote:
 *
 *     "a sitting officer of an ARRL-affiliated CLUB"     -> `club_member` is named, so every other
 *      (Goldwater, a RECOMMENDATION sentence)               activity is excluded. It is where the
 *                                                           letter comes from, not what the
 *                                                           applicant does.
 *     "RESIDENCE in ARRL New England Division"           -> `CITIZENSHIP_SAYS_RESIDENT` matches
 *      (Byron Blanchard, a GEOGRAPHY sentence)              "residence", so a non-citizen is
 *                                                           excluded. It is a state, not a status.
 *     "the GENERAL coverage areas of ECARS"              -> `classesNamed` matches "general", so a
 *      (ECARS, a GEOGRAPHY sentence)                        Technician is excluded by a sentence
 *                                                           about radio coverage.
 *     "an accredited 2- or 4-year COLLEGE, university"   -> `STAGE_SAYS.UNDERGRAD` matches
 *      (CARA, an INSTITUTION sentence)                      "college", so a high-school senior is
 *                                                           excluded — from an award for students
 *                                                           entering college.
 *     "Recipient's COLLEGE of choice."                   -> the same, on four words.
 *      (Richard G. Kirkpatrick)
 *
 * A rule shipping in that state gets an exemption bolted on within a round, and this file's own
 * header says the exemption is where the real offender walks through. So W11 reads the ladder whose
 * vocabulary survives inversion, and the test below pins the finding rather than deleting it.
 *
 * WHAT SURVIVES INVERSION IS A WORD THAT CANNOT MEAN ANYTHING ELSE. "Bachelor's", "associate's",
 * "master's", "certificate", and an N-year school tier are credential nouns: a sentence containing
 * one is making a statement about the applicant's course of study whatever axis recorded it. A bare
 * "college", "undergraduate" or "graduate" is not anchored — `LEVEL_SAYS` reads "undergraduate" as
 * naming ASSOC, deliberately and correctly for W3, and inverting that would put a certificate
 * student outside every sentence containing the word. So the cross-axis level ladder fires only on
 * an anchor, and the anchor is checked before the reading, never after.
 */
const CREDENTIAL_NAMED =
  /\b(?:bachelors?|baccalaureates?|associates?|masters?|doctoral|doctorates?|ph\.?d|certificates?|diplomas?)\b/i;

function levelExcludedCrossAxis(rawText: string): Probe | undefined {
  if (!CREDENTIAL_NAMED.test(rawText) && !FOUR_YEAR_SCHOOL.test(rawText) && !TWO_YEAR_SCHOOL.test(rawText)) {
    return undefined;
  }
  return levelExcluded(rawText);
}

/** The ladders W11 reads against a sentence filed under some other axis. See the note above. */
const CROSS_AXIS_LADDERS: Array<{ owner: ConstraintSpec['axis']; read: (rawText: string) => Probe | undefined }> = [
  { owner: 'institution', read: levelExcludedCrossAxis },
];

interface CrossAxisCensus {
  enforcedNowhere: string[];
  checked: number;
  unreachable: number;
  ranked: number;
  opened: number;
  noted: number;
  silent: number;
}

const ADMITTED = ['eligible', 'eligible_preferred'];
/** Every place a probe can be from, so the control's home is searched for rather than assumed. */
const HOMES = Object.values(PLACE_BY_NAME);

function readCrossAxisReach(
  programs: Program[],
  ladders = CROSS_AXIS_LADDERS,
): CrossAxisCensus {
  const census: CrossAxisCensus = {
    enforcedNowhere: [], checked: 0, unreachable: 0, ranked: 0, opened: 0, noted: 0, silent: 0,
  };
  for (const program of programs) {
    for (const c of program.constraints) {
      for (const { owner, read } of ladders) {
        // The axis a sentence was filed under is W10's to check. W11 is the rest of the sentence.
        if (owner === c.spec.axis) continue;
        const probe = read(c.rawText);
        if (probe === undefined) {
          census.silent += 1;
          continue;
        }
        if (funderDeclinedToBar(c.rawText)) {
          census.opened += 1;
          continue;
        }
        if (PREFERRED.test(c.rawText) || CASCADE_CONDITION.test(c.rawText)) {
          census.ranked += 1;
          continue;
        }
        // A soft constraint that cannot bar anybody is W10b's finding, by name, and reporting it
        // again here would let one fix close two rules and hide whichever it did not fix.
        if (!c.hard) {
          census.noted += 1;
          continue;
        }
        // WHERE THE CONTROL HAS TO LIVE, DERIVED FROM THE PROGRAMME RATHER THAN WRITTEN DOWN. The
        // probe is a Connecticut resident, and most of these awards are not open to one; with the
        // state fixed, this rule read 2 records and could not have failed on the other 19. That is
        // the R6 defect precisely, and it was caught here by the `checked > unreachable` assertion
        // rather than by anybody re-reading the rule. So the state is searched for: whichever place
        // lets the funder's own named credential be told `eligible` is the place the probe stands
        // in, and both twins stand in the same one.
        const home = HOMES.find((state) =>
          ADMITTED.includes(matchProgram({ ...probe.control, state }, program, NOW).kind),
        );
        if (home === undefined) {
          census.unreachable += 1;
          continue;
        }
        census.checked += 1;
        const verdict = matchProgram({ ...probe.profile, state: home }, program, NOW).kind;
        if (ADMITTED.includes(verdict)) {
          census.enforcedNowhere.push(
            `${program.name} [${c.spec.axis} sentence, ${owner} ladder] ${probe.excluded} -> ${verdict} — ` +
              `${JSON.stringify(c.rawText.slice(0, 90))}`,
          );
        }
      }
    }
  }
  census.enforcedNowhere.sort();
  return census;
}


describe('W11 — a bar the funder wrote into a sentence filed under another axis', () => {
  it('a requirement stated anywhere in a programme is enforced by that programme', async () => {
    const { programs } = await corpus();
    const census = readCrossAxisReach(programs);
    // NO RECORD IN THIS CORPUS STATES A CREDENTIAL FLOOR ON ONE AXIS AND ENFORCES IT ON NONE. The
    // list is empty, and it is an equality with a diff rather than a silent pass: a record arriving
    // in this state fails here with its own name and the funder's own sentence beside it.
    expect(census.enforcedNowhere).toEqual([]);
    // Vacuity guard. 21 anchored cross-axis readings in the corpus, in four buckets:
    //
    //   checked        7  a hard sentence, closed, whose control the programme really does admit.
    //                     All seven are the same shape and it is the shape the round was set to
    //                     find: "Bachelor's degree or higher…" filed under `field_of_study`, and
    //                     "…4-year college or university" filed under `citizenship` and `gpa`.
    //                     Every one is refused by its own programme.
    //   unreachable    0  and this number is the one to watch, not the offender list. See below.
    //   ranked         7  "preference to baccalaureate or higher degree candidates" — the funder
    //                     ranking rather than barring, exempt exactly as it is in W10b.
    //   opened         7  "…or related fields", "including but not limited to" — a funder who
    //                     declined to close the sentence the floor was written into.
    //   noted          0  soft constraints, which are W10b's finding by name.
    expect({
      checked: census.checked,
      unreachable: census.unreachable,
      ranked: census.ranked,
      opened: census.opened,
      noted: census.noted,
    }).toEqual({ checked: 7, unreachable: 0, ranked: 7, opened: 7, noted: 0 });
    // THE ANTI-R6 ASSERTION, and it is the one this block exists to be able to make. A rule whose
    // probes could not reach a yes is a rule that cannot fail, and it reports green forever. So the
    // number of records the rule really read is pinned against the number it could not.
    expect(census.checked).toBeGreaterThan(census.unreachable);
  });

  it('…and it catches a degree floor that only a non-institution sentence states', async () => {
    const { programs } = await corpus();
    const metzger = programs.find((p) => p.name.includes('Metzger'));
    if (metzger === undefined) throw new Error('The Edmond A. Metzger Scholarship is missing from the corpus');
    // The sentence, and the axis it is filed under: a degree floor inside a FIELD OF STUDY clause.
    const field = metzger.constraints.find(
      (c) => c.spec.axis === 'field_of_study' && /bachelor/i.test(c.rawText),
    );
    if (field === undefined) throw new Error('Metzger states its bachelor floor on the field_of_study axis');
    expect(levelExcluded(field.rawText)?.excluded).toBe('degreeLevel ASSOC');
    // W10 cannot see it, and this is the blindness stated as an assertion rather than as prose:
    // asked of the constraint that carries the sentence, the level ladder is not among the probes.
    expect(theApplicantsTheSentenceExcludes(field.spec, field.rawText).map((p) => p.excluded)).not.toContain(
      'degreeLevel ASSOC',
    );
    // W11 does see it, and the programme refuses the applicant. The control is admitted first, so
    // the refusal is the floor doing the work and not the probe being unable to qualify at all —
    // Metzger is an ARRL Central Division award and a Connecticut probe would have been refused on
    // its geography, proving nothing. The home is derived, exactly as the rule derives it.
    const probe = levelExcludedCrossAxis(field.rawText);
    if (probe === undefined) throw new Error('unreachable');
    const home = HOMES.find((state) =>
      ADMITTED.includes(matchProgram({ ...probe.control, state }, metzger, NOW).kind),
    );
    expect(home).toBe('IL');
    expect(matchProgram({ ...probe.control, state: home }, metzger, NOW).kind).toBe('eligible');
    expect(matchProgram({ ...probe.profile, state: home }, metzger, NOW).kind).toBe('ineligible');
  });

  /**
   * THE 28, PINNED AS A MEASUREMENT RATHER THAN LEFT AS A CLAIM IN A COMMENT.
   *
   * The note on `CREDENTIAL_NAMED` says the nine-ladder version of this rule flags 81 records and
   * that all of them are cry-wolf. A sentence saying so decays; this asserts it. If somebody widens
   * the cross-axis ladders, or loosens a vocabulary, this number moves and the diff names the
   * records. It is 83 today, and the two that arrived are the fix in this round proving itself:
   * `membership.ts` now reads "Must be a member of ARRL" (North Fulton) and "must have been a
   * member of the ARRL for a minimum of one year" (Hesselbrock) as the `arrl_membership` sentences
   * they are, so they join the three IDENTICAL sentences — Metzger's and Pautz's "Must be an ARRL
   * Member", Bennett's "applicant must be an ARRL member" — that were already in this bucket for
   * exactly the same reason and are exactly as false.
   *
   * The second assertion is the load-bearing one: NOT ONE of them is reached by an anchored
   * reading. Every one comes from a ladder inverted outside its own axis — which is why exactly one
   * ladder is read cross-axis, and why "read the sentence with every vocabulary" is not the
   * generalisation it looks like.
   */
  it('…and reading all nine ladders cross-axis flags 83 records, every one of them a false alarm', async () => {
    const { programs } = await corpus();
    const naive = readCrossAxisReach(programs, SENTENCE_LADDERS);
    expect(naive.enforcedNowhere).toHaveLength(83);
    // THE PARTITION, WHICH IS THE CLAIM AND IS STRONGER THAN THE COUNT. Nobody adjudicated 83
    // records one at a time; they were read as six shapes, and the shape is what makes each one a
    // false alarm. Pinning the shapes means a genuinely new kind of hit cannot arrive disguised as
    // one of these — it lands in a bucket whose count is asserted and the diff names it.
    //
    //   29  a GEOGRAPHY sentence read as a citizenship bar. "RESIDENCE in ARRL New England
    //       Division" matches `CITIZENSHIP_SAYS_RESIDENT`. A state is not an immigration status.
    //   22  a recommendation / membership / licence / field sentence read as an activity bar.
    //       "a sitting officer of an ARRL-affiliated CLUB" names `club_member`, so every other
    //       activity is "excluded" — by the sentence describing where a LETTER comes from. 20 until
    //       North Fulton's and Hesselbrock's membership sentences started being parsed on their own
    //       axis; "member of ARRL" names `club_member` to this ladder for the same wrong reason
    //       "an ARRL member" already did in the three records beside them.
    //   18  an INSTITUTION sentence read as an audience bar. `STAGE_SAYS.UNDERGRAD` matches
    //       "college", so "Recipient's college of choice." puts a high-school senior outside an
    //       award for students entering college.
    //    7  an unanchored institution reading: "graduating high school seniors and UNDERGRADUATE
    //       students" -> `LEVEL_SAYS.ASSOC` matches "undergraduate", so a certificate student is
    //       "excluded". This is the shape the anchor exists to refuse, and the assertion below is
    //       that not one of the seven survives it.
    //    6  an INSTITUTION sentence read as a geography bar, and it is the subtlest of the six:
    //       "Accredited 4-year college or university in NC, VA, WV, MD or TN" names where the
    //       SCHOOL is, and `state` on a profile is where the APPLICANT lives. A Georgian at a
    //       Virginia college satisfies that sentence; the schema has no field for the other one.
    //    1  a GEOGRAPHY sentence read as a licence bar: ECARS's "the GENERAL coverage areas of
    //       ECARS" matches `classesNamed`, so a Technician is refused by a sentence about radio
    //       propagation.
    const shape = (o: string) => (/\[[a-z_]+ sentence, ([a-z_]+) ladder\]/.exec(o) ?? [])[1];
    const byShape: Record<string, number> = {};
    for (const o of naive.enforcedNowhere) byShape[shape(o)] = (byShape[shape(o)] ?? 0) + 1;
    expect(byShape).toEqual({
      citizenship: 29, ham_activity: 22, age_stage: 18, institution: 7, geography: 6, license: 1,
    });
    // The anchored rule shares this whole population and flags none of it.
    expect(readCrossAxisReach(programs).enforcedNowhere).toEqual([]);
    // …and the load-bearing half, asserted by running the SAME ladder with and without its anchor
    // rather than by re-reading the offender strings: the anchor is the whole difference, and it
    // removes all seven without removing a single record the anchored rule would have checked.
    const unanchored = readCrossAxisReach(programs, [{ owner: 'institution', read: levelExcluded }]);
    expect(unanchored.enforcedNowhere).toHaveLength(7);
    expect(readCrossAxisReach(programs).enforcedNowhere).toHaveLength(0);
    expect(readCrossAxisReach(programs).checked).toBe(7);
  });

  /**
   * THE MUTATION PROOF, and the OPPOSITE one beside it — the third obligation in this file's header,
   * which every other rule here meets and which a program-level rule has to meet differently. There
   * is no spec to plant a value in: W11 reads a VERDICT. So the mutation is planted in the programme.
   */
  it('…and it flags a programme whose sentence states a floor no constraint enforces', async () => {
    const { programs } = await corpus();
    const metzger = programs.find((p) => p.name.includes('Metzger'));
    if (metzger === undefined) throw new Error('The Edmond A. Metzger Scholarship is missing from the corpus');
    // THE PLANT: the funder's sentences are left exactly as they are, and every constraint that
    // could enforce the floor is emptied — the shape 20 records were in at the start of this round.
    const disarmed: Program = {
      ...metzger,
      constraints: metzger.constraints.map((c) => ({ ...c, spec: emptied(c.spec) })),
    };
    const flagged = readCrossAxisReach([disarmed]);
    expect(flagged.enforcedNowhere.some((o) => o.includes('degreeLevel ASSOC'))).toBe(true);
    // AND THE OPPOSITE: the record as the funder wrote it is silent, so the rule is not simply
    // flagging everything it is handed.
    expect(readCrossAxisReach([metzger]).enforcedNowhere).toEqual([]);
  });
});

// ============================================================ the fixture that could not fail

/**
 * R6 IN `spec-vs-sentence.test.ts` COULD NOT REACH ITS OWN FAILURE, and the three cases below are
 * the ones its fixture ruled out.
 *
 * R6 asserts that a funder who opened their own list may not produce a `fail`, and probes it with
 * `OFF_LIST_APPLICANT`, whose `activityKinds` is `['public_service']`. That applicant HAS answered
 * the question, and answered it with something. The two applicants round seven's over-claim
 * actually reached — the one whose `activityKinds` is `[]` ("none of these") and the one who has
 * never been asked — were outside the fixture entirely, and both of them came out `eligible`.
 *
 * A rule whose fixture cannot reach the failure it exists to catch is the defect class this
 * project has now found seven times. These three probe the whole shape of the answer, not half of
 * it: not a refusal (R6's claim), not an eligibility (this file's claim), and the right one of the
 * two `unknown`s — the fillable prompt while an answer could still settle it, and the empty one
 * once it cannot.
 */
const OPENED_LIST_APPLICANT: StudentProfile = {
  kind: 'student', callsign: 'K5EXAMPLE', licenseClass: 'EXTRA', licensedSince: '1990-01-01T00:00:00.000Z',
  state: 'TX', county: 'Travis', callDistrict: '5', lat: 30.27, lon: -97.74,
  fieldOfStudy: 'Basket Weaving', degreeLevel: 'BACH', accredited: true, partTime: false,
  gpa: 4.0, classRankTopPct: 1, arrlMemberSince: '1990-01-01T00:00:00.000Z',
  citizenship: 'US_CITIZEN', birthDate: '2004-01-01T00:00:00.000Z', stage: 'UNDERGRAD',
  activityKinds: ['public_service'], cwWpm: 60, financialNeed: true, gender: 'female',
};

describe('the two applicants R6’s fixture could not reach', () => {
  // R6's OWN spec and sentence, character for character, so that what changes between the two
  // files is the applicant and nothing else. That is the whole point: the rule was fine, the
  // fixture could not reach the case.
  const cara: ConstraintSpec = { axis: 'ham_activity', activityKinds: ['on_air', 'field_day'], proofRequired: false };
  const caraText = 'Participation in amateur radio activities: contesting, GOTA, Field Day, etc.';

  it('an applicant who answered "none of these" is neither refused nor admitted', () => {
    const none = { ...OPENED_LIST_APPLICANT, activityKinds: [] };
    const verdict = evaluateConstraint(cara, none, NOW, caraText);
    // R6's claim: the funder opened the list, so it may not refuse.
    expect(verdict.status).not.toBe('fail');
    // This file's claim: nobody said an applicant on none of the listed kinds qualifies.
    expect(verdict.status).not.toBe('pass');
    expect(verdict.status).toBe('unknown');
    // They have answered, so there is nothing left for them to fill in that would settle it.
    expect(verdict.missing).toEqual([]);
  });

  it('an applicant who has never been asked is neither refused nor admitted, and is still asked', () => {
    const unasked = { ...OPENED_LIST_APPLICANT, activityKinds: undefined };
    const verdict = evaluateConstraint(cara, unasked, NOW, caraText);
    expect(verdict.status).not.toBe('fail');
    expect(verdict.status).not.toBe('pass');
    expect(verdict.status).toBe('unknown');
    // …and unlike the applicant above, their own answer could still settle this, so it is asked.
    expect(verdict.missing).toEqual(['activityKinds']);
  });

  it('and the closed-list control still refuses both, so the opened list is doing the work', () => {
    const closedText = 'Participation in Field Day.';
    expect(evaluateConstraint(cara, { ...OPENED_LIST_APPLICANT, activityKinds: [] }, NOW, closedText).status).toBe('fail');
    // An unanswered question is asked, not refused, whether the list is open or closed.
    expect(evaluateConstraint(cara, { ...OPENED_LIST_APPLICANT, activityKinds: undefined }, NOW, closedText).missing).toEqual([
      'activityKinds',
    ]);
    // And someone on the list passes it either way.
    expect(evaluateConstraint(cara, { ...OPENED_LIST_APPLICANT, activityKinds: ['field_day'] }, NOW, closedText).status).toBe(
      'pass',
    );
  });
});
