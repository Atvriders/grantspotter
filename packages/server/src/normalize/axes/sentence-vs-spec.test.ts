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
 * Every degree level the sentence names, "or higher" included. Split out of `levelsUnnamed`
 * unchanged, for the reason `placesNamed` gives: W3 and W10 read the same sentence and must reach
 * the same reading of it, or one of them is quietly excusing what the other flags.
 */
function levelsNamed(rawText: string): string[] {
  let ceiling = -1;
  if (OR_HIGHER.test(rawText)) {
    for (let i = 0; i < LEVEL_ORDER.length; i += 1) {
      if (LEVEL_SAYS[LEVEL_ORDER[i]].test(rawText)) ceiling = Math.max(ceiling, i);
    }
  }
  return LEVEL_ORDER.filter((l) => LEVEL_SAYS[l].test(rawText) || (ceiling >= 0 && LEVEL_ORDER.indexOf(l) > ceiling));
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
    // Vacuity guard: 33 level lists publishing 83 levels — the largest hard-bar axis in the corpus.
    expect(checked).toBe(33);
    expect(admittedValues).toBe(83);
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
 * THE SAME BLINDNESS HAS A SECOND DOOR, AND 26 RECORDS ARE STANDING IN IT. A tier can admit exactly
 * the values its sentence names and still refuse nobody, because it holds NO value at all:
 *
 *   Richard W. Bendicksen N7ZL  "4-year college or university"            -> `degreeLevels: []`
 *   L. B. Cebik W4RNL           "4-year college or university"            -> `degreeLevels: []`
 *   Henry Broughton K2AE        "Accredited 4-year college or university" -> `degreeLevels: []`
 *   YASME Foundation            "Accredited four-year college or university" -> `degreeLevels: []`
 *   Tom & Judith Comstock       "…accepted at a 2 or 4-year college…"     -> `degreeLevels: []`
 *   …and 21 more, pinned in full as `KNOWN_TOOTHLESS`.
 *
 * W3 reads "4-year" as naming BACH — `LEVEL_SAYS.BACH` matches `\b(?:4|four)\s*-?\s*years?\b` —
 * and it must, or the sibling records that DO publish `['BACH']` under that wording would all be
 * reported as over-claims. And W3 skips every one of the 26, at `if (admitted.size === 0) continue`,
 * because an EMPTY list is never wider than its sentence by value-count. It is infinitely wider by
 * enforcement: a student one rung below the floor the funder wrote is told `eligible`, and every
 * one of the 26 is HARD, so that is the verdict on the screen. That is a false include, it is the
 * subject of this round, and it is what the seven previous rounds of false-exclude hunting left
 * behind — `institution.ts` says so in its own words: "WIDENING tokens … may only ADD to a list
 * that is already non-empty, never create one, so no entry ever gains a bar it did not have …
 * while 'Accredited 4-year college or university' stays unrestricted."
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
 * record without going red. The four buckets and the checked population add to all 649 constraints
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
 *   D1  W10b flags all 144, and W10a's census is byte-identical — the proof, made inside the test,
 *       that any rule reading only `spec` and `rawText` is blind here by construction.
 *   D2  211 checked, 211 flagged. No survivors.
 *   D3  BLIND ON THE OFFENDER LIST, AND IT SAYS SO. W10a exempts `orUnrepresented`, so nothing is
 *       flagged; what moves is coverage, from 203 checked to 0, with 247 constraints in a bucket
 *       that asks them nothing. Reported, not hidden.
 *   D4  flags more, and every added offender is on `field_of_study` — the one axis it reaches.
 *
 * That is the honest form of the claim, and it is bounded in a way the previous three guards were
 * not: W10 is blind exactly on the disarming mutations nobody has thought to add to the battery. It
 * does not claim the battery is complete. It claims the battery is the place to look, and that
 * adding a fifth mutation is cheap, mechanical, and does not require re-reading a thousand lines of
 * prose to know what it proved.
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
function theApplicantTheSentenceExcludes(
  spec: ConstraintSpec,
  rawText: string,
): { profile: StudentProfile; excluded: string } | undefined {
  switch (spec.axis) {
    case 'geography': {
      // A radius, a call district and a county cannot be answered by naming a state, and this file
      // exists to say that a confident wrong answer is the expensive kind.
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
        return undefined;
      }
      if (GEO_WIDENED.test(rawText)) return undefined;
      const named = placesNamed(rawText);
      if (named.size === 0) return undefined;
      const outside = Object.values(PLACE_BY_NAME).find((code) => !named.has(code));
      if (outside === undefined) return undefined;
      return { profile: { ...ENFORCEMENT_PROBE, state: outside }, excluded: `state ${outside}` };
    }
    case 'institution': {
      // DOWNWARD ONLY, and this is W5's doctrine applied to the other ladder in the schema: "the
      // sentence's LOWEST named class is the most generous reading of what the funder asked for".
      // A sentence reading "four-year college or university" plainly puts a CERTIFICATE student
      // outside the award; whether it puts a DOCTORAL student outside is genuinely arguable, since
      // a university is where graduate study happens. Probing upward would report a defect on every
      // record whose funder wrote "college" and meant the whole building, and that cry-wolf is how
      // an exemption gets bolted on. Downward is where the false include actually lives.
      const named = levelsNamed(rawText);
      if (named.length === 0) return undefined;
      const floor = Math.min(...named.map((l) => LEVEL_ORDER.indexOf(l)));
      if (floor <= 0) return undefined;
      const outside = LEVEL_ORDER[floor - 1];
      return {
        profile: { ...ENFORCEMENT_PROBE, degreeLevel: outside as DegreeLevel },
        excluded: `degreeLevel ${outside}`,
      };
    }
    case 'age_stage': {
      const named = ALL_STAGES.filter((s) => STAGE_SAYS[s].test(rawText));
      if (named.length === 0) return undefined;
      const outside = STAGE_PROBE_ORDER.find((s) => !named.includes(s));
      if (outside === undefined) return undefined;
      // `stagesSatisfiedBy` reads `degreeLevel` too, and a probe carrying BACH would satisfy an
      // UNDERGRAD tier no matter what stage it stated. The probe states its stage and nothing else.
      return {
        profile: { ...ENFORCEMENT_PROBE, stage: outside as StudentProfile['stage'], degreeLevel: undefined },
        excluded: `stage ${outside}`,
      };
    }
    case 'ham_activity': {
      const named = ALL_ACTIVITY_KINDS.filter((k) => ACTIVITY_SAYS[k].test(rawText));
      if (named.length === 0) return undefined;
      const outside = ALL_ACTIVITY_KINDS.find((k) => !named.includes(k));
      if (outside === undefined) return undefined;
      return {
        profile: { ...ENFORCEMENT_PROBE, activityKinds: [outside as ActivityKind] },
        excluded: `activityKinds [${outside}]`,
      };
    }
    case 'license': {
      if (ANY_CLASS.test(rawText)) return undefined;
      const named = classesNamed(rawText);
      if (named.length === 0) return undefined;
      const floor = Math.min(...named.map((n) => LICENSE_RANK[n]));
      const below = Object.keys(LICENSE_RANK).find((k) => LICENSE_RANK[k] === floor - 1);
      if (below === undefined) return undefined;
      return {
        profile: { ...ENFORCEMENT_PROBE, licenseClass: below as StudentProfile['licenseClass'] },
        excluded: `licenseClass ${below}`,
      };
    }
    case 'citizenship': {
      if (CITIZENSHIP_SAYS_ANY.test(rawText)) return undefined;
      if (!/\bcitizen/i.test(rawText) && !CITIZENSHIP_SAYS_RESIDENT.test(rawText)) return undefined;
      // `Citizenship` has no "neither" member; `'ANY'` on a PROFILE is the applicant who is neither
      // a citizen nor a resident, which is what `evaluateTier`'s allow-list test does with it.
      return { profile: { ...ENFORCEMENT_PROBE, citizenship: 'ANY' }, excluded: 'citizenship neither' };
    }
    case 'field_of_study': {
      // A TIER WITH NO FIELDS IS A ROUTE THAT IS NOT ABOUT THE FIELD OF STUDY, and it is the
      // funder's own. IRARC's "Undergraduate degree or electronic technician certification program"
      // mints an `anyOf` tier with `fields: []`; an award open to any undergraduate is open to a
      // poetry undergraduate, in the funder's words. W9 pins that record from the other side.
      if (tiers(spec).some((t) => t.axis === 'field_of_study' && t.fields.length === 0)) return undefined;
      // W7 proved every entry in `fields` is a quotation of the sentence, so the sentence names
      // exactly the list; a major sharing no word with any of them is outside all of it.
      const outside = PLAINLY_UNRELATED[0];
      return { profile: { ...ENFORCEMENT_PROBE, fieldOfStudy: outside }, excluded: `fieldOfStudy ${outside}` };
    }
    case 'gpa': {
      const named = gpasNamed(rawText);
      if (named.length === 0) return undefined;
      const floor = Math.min(...named);
      if (floor <= 0) return undefined;
      return {
        profile: { ...ENFORCEMENT_PROBE, gpa: Math.max(0, floor - 0.5), classRankTopPct: 100 },
        excluded: `gpa ${Math.max(0, floor - 0.5)}`,
      };
    }
    default:
      // `arrl_membership`, `recommendation`, `financial_need`, `gender` and `other` publish no
      // allow-list or floor a sentence could be read against; they are counted, never flagged.
      return undefined;
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
  opened: number;
  unrepresented: number;
  silent: number;
}

function readEnforcementWidth(all: Array<{ program: Program; c: Constraint }>): EnforcementCensus {
  const census: EnforcementCensus = { admitsEverybody: [], checked: 0, opened: 0, unrepresented: 0, silent: 0 };
  for (const { program, c } of all) {
    const probe = theApplicantTheSentenceExcludes(c.spec, c.rawText);
    if (probe === undefined) {
      census.silent += 1;
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
    const verdict = evaluateConstraint(c.spec, probe.profile, NOW, c.rawText);
    if (verdict.status !== 'fail') {
      census.admitsEverybody.push(
        `${program.name} [${c.spec.axis}] ${probe.excluded} -> ${verdict.status} — ${JSON.stringify(c.rawText.slice(0, 90))}`,
      );
    }
  }
  census.admitsEverybody.sort();
  return census;
}

/**
 * THE RECORDS WHERE A STATED REQUIREMENT ENFORCES NOTHING, pinned as a list that may only ever
 * SHRINK, exactly as `KNOWN_GEO_OVERCLAIMS` is.
 *
 * Every one is the same defect, on the same axis, through the same door: the funder wrote a degree
 * level into their own sentence and `institution.ts` published `degreeLevels: []`. The tier holds
 * no value, so it refuses nobody, so a student one rung BELOW the floor the funder wrote is told
 * `eligible`. Every one is HARD. This is a false include of exactly the kind this round is about,
 * and it is invisible to W3 — an EMPTY list is never wider than its sentence by value-count, and
 * W3 skips it at `if (admitted.size === 0) continue`.
 *
 * WHY PINNED AND NOT FIXED HERE. `institution.ts` is not this territory, and the fix is not a
 * missing constant: sibling records read the very same "4-year college or university" wording and
 * publish `['BACH']` or `['BACH','GRAD']` correctly, so which branch these fall down is a live
 * extractor question. It is reported in the round summary.
 *
 * A LIST, NOT A SKIP. It goes red in BOTH directions — red when a new record joins them, red when
 * one is fixed and its entry goes stale.
 */
const KNOWN_TOOTHLESS = [
  'The Alan G. Thorpe, K1TMW, Memorial Scholarship [institution] degreeLevel ASSOC -> pass — "Any accredited 4-year college or university"',
  'The Bill, W2ONV, and Ann Salerno Memorial Scholarship [institution] degreeLevel ASSOC -> pass — "accredited 4-year college or university"',
  'The CTRI/Chris Seeber, KA1GEU, Memorial Scholarship [institution] degreeLevel CERT -> pass — "Any accredited 2- or 4-year college or university"',
  'The Dayton Amateur Radio Association Scholarship [institution] degreeLevel ASSOC -> pass — "Accredited 4-year college or university"',
  'The Ernest L. Baulch, W2TX, and Marcia E. Baulch, WA2AKJ, Scholarship [institution] degreeLevel ASSOC -> pass — "Any 4-year college or university"',
  'The Gary Wagner, K3OMI, Scholarship [institution] degreeLevel ASSOC -> pass — "Accredited 4-year college or university in NC, VA, WV, MD or TN"',
  'The Gwinnett Amateur Radio Society Scholarship [institution] degreeLevel ASSOC -> pass — "4 year college or university"',
  'The Helen Laughlin AM Mode Memorial Scholarship [institution] degreeLevel ASSOC -> pass — "4-year college or university"',
  'The Henry Broughton, K2AE, Memorial Scholarship [institution] degreeLevel ASSOC -> pass — "Accredited 4-year college or university"',
  'The John C. York, KE5V, Scholarship [institution] degreeLevel CERT -> pass — "Any accredited 2- or 4-year college or university"',
  'The L. B. Cebik, W4RNL, and Jean Cebik, N4TZP, Scholarship [institution] degreeLevel ASSOC -> pass — "4-year college or university"',
  'The Lois Manley, K7LMZ, and Randall Pitchford, WW7ZZ, Scholarship [institution] degreeLevel CERT -> pass — "Any accredited 2- or 4-year college or university"',
  'The Medical Amateur Radio Council (MARCO) Scholarship [institution] degreeLevel CERT -> pass — "Accredited 2- or 4-year college or university."',
  'The Michael Holt, K8MJH, and Mary Holt, KC8OIP, Scholarship [institution] degreeLevel ASSOC -> pass — "Full-time student at an accredited 4-year college or university\\nMust be a citizen of the U"',
  'The Orlando HamCation Scholarship [institution] degreeLevel ASSOC -> pass — "Accredited 4-year college or university"',
  'The Peoria Area Amateur Radio Club Scholarship [institution] degreeLevel CERT -> pass — "Accredited 2 or 4-year college or university"',
  'The Pikes Peak Radio Amateur Association (PPRAA) Memorial Scholarship [institution] degreeLevel ASSOC -> pass — "Accredited 4-year college or university"',
  'The Ray, NØRP, & Katie, WØKTE, Pautz Scholarship [institution] degreeLevel ASSOC -> pass — "Accredited 4-year college or university"',
  'The Richard W. Bendicksen, N7ZL, Memorial Scholarship [institution] degreeLevel ASSOC -> pass — "4-year college or university"',
  'The Scholarship of the Morris Radio Club of New Jersey [institution] degreeLevel ASSOC -> pass — "4-year college or university"',
  'The Ted, W4VHF, and Itice, K4LVV, Goldthorpe Scholarship [institution] degreeLevel ASSOC -> pass — "4-year college or university"',
  'The Tom and Judith Comstock Scholarship [institution] degreeLevel CERT -> pass — "Applicant must be a high school senior accepted at a 2 or 4-year college or a student curr"',
  'The Wayne Nelson, KB4UT, Memorial Scholarship [institution] degreeLevel ASSOC -> pass — "Any accredited 4-year college or university"',
  'The William Bennett, W7PHO, Memorial Scholarship [institution] degreeLevel ASSOC -> pass — "4-year college or university"',
  'The William C. Winscott, N6CHA, Memorial Scholarship [institution] degreeLevel ASSOC -> pass — "Accredited 4-year college or university"',
  'The YASME Foundation Scholarship [institution] degreeLevel ASSOC -> pass — "Accredited four-year college or university"',
];

/** One pass of W10b, shared with the battery for the same reason `readEnforcementWidth` is. */
interface EnforcementReach {
  notedOnly: string[];
  checked: number;
  preferences: number;
}

function readEnforcementReach(all: Array<{ program: Program; c: Constraint }>): EnforcementReach {
  const reach: EnforcementReach = { notedOnly: [], checked: 0, preferences: 0 };
  for (const { program, c } of all) {
    const probe = theApplicantTheSentenceExcludes(c.spec, c.rawText);
    if (probe === undefined || funderDeclinedToBar(c.rawText)) continue;
    if (funderNamedARouteTheSchemaCannotCheck(c.spec)) continue;
    // W10b is asked only of a spec that CAN refuse. A spec that cannot is W10a's finding, and
    // reporting it twice would let one fix close two rules and hide whichever it did not fix.
    if (evaluateConstraint(c.spec, probe.profile, NOW, c.rawText).status !== 'fail') continue;
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
    // Vacuity guard, and these four numbers add to all 649 constraints in the corpus — every one
    // is either checked or in a named bucket, and no constraint falls out of this rule unseen.
    //
    //   checked        203  the funder named values on an axis this schema holds, and closed them.
    //                       The rule had 203 chances to be wrong and took 26.
    //   opened          36  "etc.", "such as", "or similar" — the funder declining to close a list.
    //   unrepresented   44  `orUnrepresented` — see the note on it above; this is D3 occurring
    //                       naturally, and it is the bucket to watch, because a constraint moving
    //                       INTO it stops being checked at all.
    //   silent         366  the sentence names nothing on an axis a sentence can be read against —
    //                       `recommendation`, `financial_need`, `other`, and the many records whose
    //                       rawText is "Any" or a bare place name on an axis about schooling.
    expect({
      checked: census.checked,
      opened: census.opened,
      unrepresented: census.unrepresented,
      silent: census.silent,
    }).toEqual({ checked: 203, opened: 36, unrepresented: 44, silent: 366 });
  });

  /**
   * …AND THEY ARE REAL, read end-to-end rather than off the spec. `evaluateConstraint` returning
   * `pass` is not by itself a claim about a student; `matchProgram` returning `eligible` is. This
   * case takes one of the 26, hands the whole program to the matcher, and shows the verdict a
   * community-college student is actually shown.
   *
   * WHEN THESE LINES GO RED THE DEFECT IS FIXED: delete this case and the 26 entries above.
   */
  it('…and the 26 are real: the verdict a student one rung below the floor is shown', async () => {
    const { programs } = await corpus();
    const bendicksen = programs.find((p) => p.name.includes('Bendicksen'));
    if (bendicksen === undefined) throw new Error('The Richard W. Bendicksen Scholarship is missing from the corpus');
    const inst = bendicksen.constraints.find((c) => c.spec.axis === 'institution');
    if (inst === undefined) throw new Error('Bendicksen states an institution requirement and it is missing');
    // From the sentence first: change the funder's wording and this line fails before the rest.
    expect(inst.rawText).toContain('4-year college');
    expect(inst.hard).toBe(true);
    // W3 reads that sentence as naming the bachelor and nothing lower, and it must — sibling
    // records publish `['BACH']` under the very same words.
    expect(levelsNamed(inst.rawText)).toEqual(['BACH']);
    // The tier holds no value at all, so the axis cannot refuse an associate-degree student…
    const assoc = { ...ENFORCEMENT_PROBE, degreeLevel: 'ASSOC' as const };
    expect(evaluateConstraint(inst.spec, assoc, NOW, inst.rawText).status).toBe('pass');
    // …and that is what they are told, through the whole matcher, on the funder's own program.
    const alone: Program = { ...bendicksen, constraints: [inst] };
    expect(matchProgram(assoc, alone, NOW).kind).toBe('eligible');
    // THE OTHER DIRECTION, and it is what makes this a false INCLUDE and not a parse complaint:
    // the applicant the funder did name is admitted, and must stay admitted after any fix.
    expect(matchProgram(ENFORCEMENT_PROBE, alone, NOW).kind).toBe('eligible');
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
    expect({ checked: w10b.checked, preferences: w10b.preferences }).toEqual({ checked: 144, preferences: 33 });
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
    expect(w10a.admitsEverybody).toHaveLength(26);
    expect(w10a.checked).toBe(203);
    expect(w10b.notedOnly).toHaveLength(KNOWN_NOTED_ONLY.length);
    expect(w10b.checked).toBe(144);

    // D1 — EVERY HARD CONSTRAINT BECOMES SOFT. Every requirement in the product stops barring
    // anyone: `matchProgram` demotes a soft failure to "preference not met" and returns `eligible`.
    // W1 through W8 do not move by a single assertion. W10b flags every one of the 144.
    const d1 = readEnforcementReach(mutated((c) => ({ ...c, hard: false })));
    expect(d1.notedOnly).toHaveLength(144);
    // AND THE PROOF THAT D1 IS INVISIBLE TO A VALUE-WIDTH RULE, made here rather than asserted
    // about W1-W8 from outside them. Every one of those rules reads `c.spec` and `c.rawText` and
    // nothing else; so does `readEnforcementWidth`; so its census is IDENTICAL under D1. Any rule
    // with those two inputs is blind to this mutation by construction, and that is the whole
    // reason W10b had to read a third one. (Run for real, once, by softening `everyConstraint`:
    // W1 through W9 stayed green and the only two failures in the file were W10's.)
    expect(readEnforcementWidth(mutated((c) => ({ ...c, hard: false })))).toEqual(w10a);

    // D2 — EVERY SPEC BECOMES ITS EMPTY FORM, so no tier holds a value to test against. Value-width
    // is untouched in the only sense W1-W8 can measure: an empty list admits no value they can
    // find, so they skip it at `if (admitted.size === 0) continue`. W10a checks 211 rather than
    // 203 — an emptied geography tier is `any`, which this rule reads and W1 does not — and flags
    // every single one of them.
    const d2 = readEnforcementWidth(mutated((c) => ({ ...c, spec: emptied(c.spec) })));
    expect({ flagged: d2.admitsEverybody.length, checked: d2.checked }).toEqual({ flagged: 211, checked: 211 });
    // Every constraint the rule can still see is flagged — no survivors, not "most".
    expect(d2.admitsEverybody).toHaveLength(d2.checked);

    // D3 — EVERY CONSTRAINT GAINS `orUnrepresented`, which turns every `fail` into an `unknown`
    // with nothing to fill in, while changing not one admitted value.
    //
    // AND HERE IS THE BLIND SPOT, REPORTED RATHER THAN HIDDEN. W10a exempts that field, for the
    // reason `funderNamedARouteTheSchemaCannotCheck` gives, so its offender list does NOT grow —
    // it empties. What moves instead is COVERAGE: 203 constraints checked falls to none, and 247
    // land in a bucket that asks them nothing. A rule with nothing left to say has said something.
    const d3 = readEnforcementWidth(
      mutated((c) => ({ ...c, spec: { ...c.spec, orUnrepresented: 'the funder named another route' } })),
    );
    expect(d3.checked).toBe(0);
    expect(d3.admitsEverybody).toEqual([]);
    expect(d3.unrepresented).toBe(247);

    // D4 — EVERY FIELD LIST IS WIDENED: W9's mechanism, applied corpus-wide. Narrower than D2 by
    // construction, since it reaches only the one axis that has a widening — which is the point of
    // running it separately. It is the mutation that actually shipped, in round seven.
    const d4 = readEnforcementWidth(mutated((c) => ({ ...c, spec: widenedFields(c.spec) })));
    expect(d4.admitsEverybody.length).toBeGreaterThan(w10a.admitsEverybody.length);
    expect(d4.admitsEverybody.filter((o) => o.includes('[field_of_study]'))).toHaveLength(
      d4.admitsEverybody.length - w10a.admitsEverybody.length,
    );
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
