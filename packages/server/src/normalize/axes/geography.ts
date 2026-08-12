import { ARRL_DIVISIONS, ARRL_SECTIONS } from '@grantspotter/core';
import type { Constraint, GeoSpec, RawOpportunity } from '@grantspotter/core';
import { isPreferenceText, makeConstraint, preferenceScope, requirementText } from './preference.js';
import { RADIUS_CENTERS } from './radiusCenters.js';

const STATE_BY_NAME: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE',
  // The corpus writes this both as "The District of Columbia" and as the bare code "DC" (see the
  // two-letter-code loop below, which now includes DC because it is a value in this map). Never
  // silently dropped again — see the "virginia" special case below for why it used to be.
  'district of columbia': 'DC',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/**
 * A REGION NAME IS A LIST OF STATES, and a name this table does not know is a silent bar.
 *
 * The Michael R. Ware, NN3I, Scholarship states its area as "Maryland, Delaware, New Jersey, New
 * York, OR NEW ENGLAND." Four of those five are keys in STATE_BY_NAME; the fifth is not, so it
 * matched nothing, the published spec was `state: [DE, MD, NJ, NY]`, and every applicant in the six
 * New England states — the funder's own last-named alternative — was hard-refused while being shown
 * the sentence that names them. That is a VOCABULARY gap, the kind a parser can close, and the
 * honest remedy is to close it rather than to decline to decide.
 *
 * DELIBERATELY ONE ENTRY. Every other multi-state region word in the corpus ("Northwest",
 * "Midwest", "Southeastern", "northeastern") appears only where the funder ALSO names the ARRL
 * Division or a radius, both of which win the cascade in `geoFrom` before the state scan runs, so
 * a table of guessed region-to-state mappings would be code nothing exercises. "New England" is
 * the one region this corpus states as a bare region, and its membership is not a judgement call.
 * Measured against every other record that mentions it — seven, all ARRL New England Division or
 * an explicit "(ME, NH, VT, CT, RI, MA)" list — this changes no other spec.
 */
const REGION_STATES: Record<string, string[]> = {
  'new england': ['CT', 'ME', 'MA', 'NH', 'RI', 'VT'],
};

/**
 * Builds the whole-word regex used to test each STATE_BY_NAME entry against the source text.
 * "virginia" is the one name that needs a special case: \bvirginia\b matches the standalone word
 * "Virginia" INSIDE "West Virginia" too (a word boundary exists on both sides of "Virginia" in
 * "West Virginia" — the space is a non-word character), so a West-Virginia-only entry used to
 * fabricate a Virginia (VA) constraint the source text never states. The negative lookbehind
 * excludes exactly that case, leaving the dedicated "west virginia" key above to own that
 * spelling; a text that separately and legitimately mentions both ("...Virginia, ... and West
 * Virginia...") still yields both VA and WV, because that standalone "Virginia" occurrence is not
 * preceded by "west ".
 */
function stateNamePattern(name: string): RegExp {
  if (name === 'virginia') return /(?<!west )\bvirginia\b/i;
  return new RegExp(`\\b${name}\\b`, 'i');
}

const RADIUS = /within\s+(\d+)\s+miles\s+of\s+([A-Z][A-Za-z. ]*(?:,\s*[A-Za-z. ]+)?)/i;
const CALL_DISTRICT = /\b(\d)(?:st|nd|rd|th)?\s+call\s+(?:district|area)\b/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- ARRL Divisions ----------

/**
 * Corpus-observed shorthand for two Divisions whose canonical name (arrlSections.ts,
 * ARRL_DIVISIONS) is longer: "Northwest"/"Southwest" are not real Division names — the ARRL
 * calls them "Northwestern" and "Southwestern" — but several live scholarship entries use the
 * short form anyway. Mapped to the canonical spelling rather than emitted verbatim, per the
 * requirement that anything this axis emits validates against the real table.
 */
const DIVISION_ALIASES: Record<string, string> = {
  northwest: 'Northwestern',
  southwest: 'Southwestern',
};

const DIVISION_CANDIDATES: ReadonlyArray<{ pattern: RegExp; canonical: string }> = [
  ...ARRL_DIVISIONS.map((name) => ({
    pattern: new RegExp(`\\b${escapeRegExp(name)}\\b`, 'i'),
    canonical: name,
  })),
  ...Object.entries(DIVISION_ALIASES).map(([alias, canonical]) => ({
    pattern: new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i'),
    canonical,
  })),
];

const DIVISION_KEYWORD = /\bDivisions?\b/gi;

/**
 * Every Division name the text actually names, checked against the canonical 15-Division table
 * rather than inferred from capitalisation. A single generic "<Name> Division" regex can only
 * ever capture the one name immediately touching the keyword, so it silently collapsed both of
 * the corpus's multi-Division shapes to one entry: "the Atlantic Division (...), the Roanoke
 * Division (...), the Southeastern Division (...)" (three separate keywords, `.exec` without a
 * `g` flag only ever returning the first) and "ARRL Northwest, Pacific or Southwest Division"
 * (one keyword serving a comma/or-joined list, so only the name directly touching it matched).
 *
 * Fixed by scanning EVERY "Division"/"Divisions" occurrence and, for each one, testing the whole
 * table (plus the two known aliases above) against the text window since the previous occurrence
 * (or the start of the text) — so a name is recognised wherever it sits in the window, not only
 * immediately before the keyword. A name with no match anywhere in the table is dropped rather
 * than emitted as if it were real: the whole point of validating against arrlSections.ts.
 */
function divisionsIn(text: string): string[] {
  const found = new Set<string>();
  let windowStart = 0;
  DIVISION_KEYWORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIVISION_KEYWORD.exec(text))) {
    const window = text.slice(windowStart, m.index);
    for (const { pattern, canonical } of DIVISION_CANDIDATES) {
      if (pattern.test(window)) found.add(canonical);
    }
    windowStart = DIVISION_KEYWORD.lastIndex;
  }
  if (found.size === 0) return [];
  return ARRL_DIVISIONS.filter((name) => found.has(name));
}

// ---------- Section-named-within-its-Division phrase ----------

/**
 * "<Section Name> Section of the <Division Name> Division" — e.g. "ARRL Western Pennsylvania
 * Section of the Atlantic Division" (the real Steel City ARC Scholarship entry). This is a
 * narrower question than the general Division-before-Section priority in geoFrom below, which
 * several OTHER real entries genuinely depend on (a Section named as the first, narrowest tier of
 * a multi-tier preference cascade with a Division as a broader fallback tier, e.g. Robert A.
 * Rodriguez K5AUW: "ARRL South Texas Section (first preference); ... ARRL West Gulf Division
 * (third preference)" — see geography.test.ts and the remediation report for why that priority is
 * left alone globally). Here the funder states a Section AND names the Division it sits inside,
 * together, in one phrase: the Section is unambiguously the operative (narrower) restriction —
 * the Division mention describes the Section's context, not a second, broader eligibility area.
 * Without this, the general division scan below matches "... Division" first and returns the
 * whole (much broader) Division, silently widening a Section-only award to every Section in it
 * (for Atlantic: Delaware, Eastern Pennsylvania, Maryland-DC, Northern New York, Southern New
 * Jersey, Western New York, Western Pennsylvania — several states and DC, not just Western PA).
 *
 * Validated against the real table both ways: the captured Section name must be a real Section,
 * the captured Division name must be a real Division, AND that Section must actually belong to
 * that Division (arrlSections.ts). A phrase pairing a real Section with a Division it does NOT
 * belong to is a data problem in the source text, not something for this function to silently
 * reconcile by guessing which one the funder meant — it is left unmatched here and falls through
 * to the general division/section scan below instead.
 */
const SECTION_OF_DIVISION =
  /\b(?:ARRL\s+)?([A-Za-z][A-Za-z .'-]*?)\s+Section\s+of\s+the\s+(?:ARRL\s+)?([A-Za-z][A-Za-z .'-]*?)\s+Division\b/gi;

function sectionOfDivisionIn(text: string): string[] {
  const found = new Set<string>();
  SECTION_OF_DIVISION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_OF_DIVISION.exec(text))) {
    const sectionName = m[1].trim().toLowerCase();
    const divisionName = m[2].trim().toLowerCase();
    const section = ARRL_SECTIONS.find((s) => s.name.toLowerCase() === sectionName);
    const division = ARRL_DIVISIONS.find((d) => d.toLowerCase() === divisionName);
    if (!section || !division || section.division !== division) continue;
    found.add(section.name);
  }
  if (found.size === 0) return [];
  return ARRL_SECTIONS.map((section) => section.name).filter((name) => found.has(name));
}

// ---------- ARRL Sections ----------

const SECTION_CANDIDATES: ReadonlyArray<{ pattern: RegExp; canonical: string }> = ARRL_SECTIONS.map(
  (section) => ({
    pattern: new RegExp(`\\b${escapeRegExp(section.name)}\\b`, 'i'),
    canonical: section.name,
  }),
);

const SECTION_KEYWORD = /\bSections?\b/gi;

/**
 * Same window-scan strategy as divisionsIn, against the 71-Section table. This also fixes a
 * silent failure the old generic `[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+Section\b` regex had for
 * hyphenated section names such as "Maryland-DC" or "NYC-Long Island": the second half of those
 * names ("DC", "NYC") is all caps, which `[a-z]+` cannot match, so the old regex never matched
 * "Maryland-DC Section" at all and the text fell through to the state branch, silently losing
 * the DC half. Testing the literal canonical string against the window sidesteps that entirely.
 */
function sectionsIn(text: string): string[] {
  const found = new Set<string>();
  let windowStart = 0;
  SECTION_KEYWORD.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SECTION_KEYWORD.exec(text))) {
    const window = text.slice(windowStart, m.index);
    for (const { pattern, canonical } of SECTION_CANDIDATES) {
      if (pattern.test(window)) found.add(canonical);
    }
    windowStart = SECTION_KEYWORD.lastIndex;
  }
  if (found.size === 0) return [];
  return ARRL_SECTIONS.map((section) => section.name).filter((name) => found.has(name));
}

// ---------- Counties ----------

/**
 * Prose words that show up glued to a candidate through the necessarily loose word-chase below;
 * a "county name" containing one of these is leftover sentence structure, not a place, and is
 * dropped rather than emitted as a fabricated county. There is no canonical county table to
 * validate against (unlike Divisions/Sections), so this denylist is the county axis's equivalent
 * safety net.
 */
const COUNTY_LIST_STOPWORDS = new Set([
  'following', 'preference', 'preferences', 'preferred', 'residents', 'resident', 'residing',
  'residence', 'applicant', 'applicants', 'identified', 'qualified', 'no', 'if', 'then', 'will',
  'be', 'given', 'state', 'states', 'section', 'sectioin', 'division', 'district', 'area',
  'areas', 'region', 'regions', 'county', 'counties', 'these', 'who', 'is',
]);

function isRealCandidate(name: string): boolean {
  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => !COUNTY_LIST_STOPWORDS.has(w));
}

function splitCandidateList(segment: string): string[] {
  return segment
    .split(/,|\bor\b|\band\b/i)
    .map((s) => s.replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 1 && isRealCandidate(s));
}

/**
 * The connectors a county list may be joined by, as a single alternation used by
 * COUNTY_LIST_BEFORE's backward chase: a bare comma ("Travis, Bastrop"), a bare and/or ("Hays and
 * Williamson"), or — the form the real Austin ARC page uses and the one that used to break the
 * whole list — an Oxford comma, i.e. a comma AND a connective word (", and Williamson").
 *
 * ROUND 3 ROOT CAUSE. This alternation used to be `(?:,\s*|\s+(?:or|and)\s+)`: comma, or
 * and/or-with-spaces, never the two together. On "Travis, Bastrop, Blanco, Burnet, Caldwell,
 * Hays, and Williamson counties." the comma branch consumes ", " and then demands a Title-Case
 * name where the lowercase "and" sits, while the and/or branch demands whitespace where the comma
 * sits. Both fail at that one connector, which fails the entire backward chase from "Travis", and
 * the global scan then restarts and matches the shortest thing that does work — "Williamson
 * counties" — so an award open to seven Central Texas counties published exactly one of them and
 * was hidden from applicants in the other six.
 *
 * Note this was never a `splitCandidateList` problem (that function has always split on `,`, `or`
 * AND `and`, and drops the empty segment an Oxford comma produces): the list never reached it,
 * because the pattern that finds the list never matched.
 */
const LIST_CONNECTOR = String.raw`(?:,\s*(?:(?:or|and)\s+)?|\s+(?:or|and)\s+)`;

// A run of one or two Title-Case words: "Peoria", "San Diego". Deliberately does NOT allow an
// "of" infix ("Gwinnett" only, never "Resident of Gwinnett") — that infix is common enough in
// ordinary prose that allowing it reopens the whole-preceding-sentence bug this rewrite exists to
// fix. "City of Winchester" (a real corpus county-list item) still comes through correctly
// because splitCandidateList sees it as one already comma-delimited item, never through this
// word-by-word chase.
const NAME = String.raw`[A-Z][A-Za-z.]*(?:\s+[A-Z][A-Za-z.]*)?`;

/**
 * "Travis, Williamson or Hays county" / "Orange, Seminole, ... and Polk Counties" — a comma/or/
 * and-joined list of names immediately BEFORE the county/counties keyword. Anchored so the list
 * can only extend backward through valid connectors (comma, "or", "and"), never through ordinary
 * prose: "preference will be given to residents of Pasco County" yields only "Pasco", not the
 * whole sentence fragment the old code produced by taking everything before the match.
 * The trailing `(?!\s*:)` excludes the "counties:" shape entirely, so it is only ever handled
 * once, by COUNTY_LIST_AFTER below.
 */
// Deliberately NOT case-insensitive: NAME's `[A-Z]` must mean a real capital, not "any letter",
// or it stops meaning "a proper noun" at all. An earlier draft of this pattern used the 'i' flag
// (to let "county"/"Counties" match either way) and, as a side effect, made `[A-Z]` in NAME match
// lowercase letters too — so ordinary connective words directly before a real county name
// ("residents of Pasco County", "followed by Orange and Los Angeles Counties") were captured as
// part of the county name ("of Pasco", "by Orange"), the same class of prefix-contamination bug
// this rewrite exists to fix. `[Cc]ount` below covers the keyword's real case variation instead.
const COUNTY_LIST_BEFORE = new RegExp(
  `((?:${NAME}\\s*${LIST_CONNECTOR})*${NAME})\\s+[Cc]ount(?:y|ies)\\b(?!\\s*:)`,
  'g',
);

/**
 * "these counties: Peoria, Tazewell, Woodford, Knox, McLean, Fulton, Logan, Marshall or Stark" —
 * a list AFTER a colon that immediately follows the keyword. This is the exact shape defect #2
 * was filed against: the old code sliced everything BEFORE the match (`text.slice(0, index)`)
 * instead of reading the list that actually follows the colon, so nine named counties collapsed
 * into the single literal value "Residence in Central IL in one of these".
 *
 * The lazy capture stops at a sentence terminator, the next county/counties keyword, or the end
 * of the string — so two colon-lists in one sentence ("...Virginia counties: A, B, or the
 * following West Virginia counties: C, D...") are read as two separate lists rather than merging
 * into one, with the connective prose between them dropped by the stopword filter in
 * splitCandidateList (it contains "following").
 */
const COUNTY_LIST_AFTER = /\bcount(?:y|ies)\s*:\s*([\s\S]*?)(?=[.;]|\bcount(?:y|ies)\b|$)/gi;

function extractCountyNames(text: string): string[] {
  const names = new Set<string>();

  COUNTY_LIST_AFTER.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COUNTY_LIST_AFTER.exec(text))) {
    for (const n of splitCandidateList(m[1])) names.add(n);
  }

  COUNTY_LIST_BEFORE.lastIndex = 0;
  while ((m = COUNTY_LIST_BEFORE.exec(text))) {
    for (const n of splitCandidateList(m[1])) names.add(n);
  }

  return [...names];
}

/**
 * A COUNTY NAME WITHOUT ITS STATE IS A DIFFERENT COUNTY IN THIRTY OTHER STATES.
 *
 * `parseCountyValue` (core/geo.ts) reads a value with no comma as state-agnostic and PASSES on a
 * bare name match, so the Peoria Area Amateur Radio Club Scholarship — "Residence in Central IL in
 * one of these counties: Peoria, Tazewell, Woodford, Knox, MCLEAN, FULTON, LOGAN, MARSHALL or
 * Stark" — admitted a resident of Fulton County GEORGIA and Knox County TENNESSEE to an
 * Illinois-only award. That is a false INCLUDE, the opposite polarity to most of this round: it
 * costs an applicant an afternoon on a form rather than the award, which is why it is fixed and
 * why the fix is written to be incapable of the other kind of error.
 *
 * THE STATE COMES FROM THE FUNDER'S OWN SENTENCE OR IT DOES NOT COME AT ALL. The qualifier is
 * attached only when the very text the county list was read from names EXACTLY ONE state — "Central
 * IL", "Pasco County, Florida", "San Diego or Imperial Counties, CA". Two states named (Shenandoah
 * Valley's "the following Virginia counties: … or the following West Virginia counties: …") is
 * ambiguous per county and is left alone; none named (Austin ARC's `counties` field is the bare
 * list "Travis, Bastrop, …, and Williamson counties.") would mean inventing a value, which this
 * axis's county reader refuses to do everywhere else and refuses here.
 *
 * IT CANNOT MANUFACTURE A REFUSAL FOR SOMEONE IN THE RIGHT COUNTY. `evaluateGeo`'s county branch
 * answers `unknown` with `missing: ['state']` — a field the editor can offer — when the applicant
 * named a matching county but no state, rather than failing them. So the worst this does to a real
 * Peoria-county applicant who left `state` empty is ask them for it.
 */
function qualifyCountiesWithState(counties: string[], text: string): string[] {
  const states = statesIn(text);
  if (states.length !== 1) return counties;
  return counties.map((county) => `${county}, ${states[0]}`);
}

/**
 * THE FUNDER GLOSSED THE CALL DISTRICT WITH THE STATES IN IT, AND THE SENTENCE IS ABOUT RESIDENCE.
 *
 *   Fred R. McDaniel Memorial  "RESIDENT OF FCC 5th call district (TX, OK, AR, LA, MS, NM)"
 *
 * `call_district` is a property of a CALLSIGN — `evaluateGeo` falls back to
 * `callDistrictFromCallsign` — and the sentence states a rule about where the applicant LIVES,
 * with the six states spelled out in the funder's own parenthesis. A Texas resident holding a
 * callsign issued in another district (a ham who moved, or holds a vanity call — both legal, both
 * common, and neither is a change of address) was hard-refused by a rule they satisfy.
 *
 * The remedy is the second tier rather than a replacement: the district reading is the funder's
 * first-named one and still admits everyone it admitted, and `anyOf` can only turn a refusal into
 * a pass. Emitted only when the text names states BESIDE the district — the funder's own gloss,
 * never a guess. One record in the corpus qualifies; the Clive Frazier K9FWF preference ("the 9th
 * call area or attending a Big Ten school") names no state and is untouched.
 */
function callDistrictStateTier(text: string, base: GeoSpec): GeoSpec | undefined {
  if (base.type !== 'call_district') return undefined;
  const states = statesIn(text);
  return states.length > 0 ? { type: 'state', values: states } : undefined;
}

function geoFrom(text: string): GeoSpec {
  const radius = RADIUS.exec(text);
  if (radius) {
    const centerLabel = radius[2].replace(/\s+/g, ' ').trim().replace(/[.,]$/, '');
    const center = RADIUS_CENTERS[centerLabel.toLowerCase()];
    return {
      type: 'radius',
      values: [centerLabel],
      radiusMiles: Number.parseInt(radius[1], 10),
      centerLabel,
      ...(center ? { centerLat: center.lat, centerLon: center.lon } : {}),
    };
  }

  const callDistrict = CALL_DISTRICT.exec(text);
  if (callDistrict) return { type: 'call_district', values: [callDistrict[1]] };

  // Checked before the general division scan, but ONLY fires for the specific "<Section> Section
  // of the <Division> Division" phrase — every other Section/Division text still goes through the
  // ordinary division-before-section priority below, unchanged.
  const pairedSections = sectionOfDivisionIn(text);
  if (pairedSections.length > 0) return { type: 'arrl_section', values: pairedSections };

  const divisions = divisionsIn(text);
  if (divisions.length > 0) return { type: 'arrl_division', values: divisions };

  const sections = sectionsIn(text);
  if (sections.length > 0) return { type: 'arrl_section', values: sections };

  const counties = extractCountyNames(text);
  if (counties.length > 0) {
    return { type: 'county', values: qualifyCountiesWithState(counties, text) };
  }

  const states = statesIn(text);
  if (states.length > 0) return { type: 'state', values: states };

  return { type: 'any', values: [] };
}

/** Every state the text names — by name, by two-letter code, or by a region name. */
function statesIn(text: string): string[] {
  const states = new Set<string>();
  for (const [name, code] of Object.entries(STATE_BY_NAME)) {
    if (stateNamePattern(name).test(text)) states.add(code);
  }
  for (const m of text.matchAll(/\b([A-Z]{2})\b/g)) {
    if (Object.values(STATE_BY_NAME).includes(m[1])) states.add(m[1]);
  }
  for (const [region, codes] of Object.entries(REGION_STATES)) {
    if (new RegExp(`\\b${region}\\b`, 'i').test(text)) for (const code of codes) states.add(code);
  }
  return [...states];
}

// ---------- the funder's other tier ----------

/**
 * THE CASCADE IN `geoFrom` HAS EXACTLY ONE WINNER, AND FUNDERS NAME TWO PLACES.
 *
 *   IRARC Memorial (Rubino)  "Resident of Brevard County FL, OR ANY FL RESIDENT"
 *   Gwinnett ARS             "Resident of Gwinnett County GA, OR THE STATE OF GA"
 *   North Texas (Nelson)     "…graduated high school located within the North Texas Section…
 *                             ADDITIONAL APPLICANTS TO BE CONSIDERED: … applicants of other Texas
 *                             sections attending school in our state or out AND OKLAHOMA RESIDENTS
 *                             attending school in Texas or another state."
 *
 * `county` is checked before `state` and returns immediately, so the state branch never ran and
 * `arrl_section` swallowed North Texas the same way. Each award published its NARROWEST tier as a
 * hard bar and refused precisely the applicants its second clause invites: a Floridian outside
 * Brevard, a Georgian outside Gwinnett, an Oklahoman.
 *
 * Widening the cascade to "emit every tier the text names" was the obvious fix and is wrong: on
 * "Residence in Central IL in one of these counties: Peoria, Tazewell, …" the state scan finds IL,
 * and the award would silently open to all of Illinois. The state name there is not a second tier;
 * it is part of saying WHERE the counties are. So the extra tiers are read only from a span the
 * FUNDER marked as an alternative — the same discipline `matcher.ts` uses for open field lists,
 * where the widening is taken from the funder's own words and nowhere else.
 *
 * TWO MARKER FAMILIES, because they carry different amounts of authority.
 *
 *   `, or` — a hand-off. English's ordinary disjunction, and the span after it is read with the
 *   SAME cascade a whole Region field gets, so the reading is as conservative as the base. An
 *   alternative is emitted only when that reading lands on a DIFFERENT tier: on the other five
 *   corpus records carrying ", or" the span resolves to the same tier as the base and to values
 *   the base already lists (K3IVO "…Pennsylvania, or West Virginia", Shenandoah's second county
 *   list, Lippert, PVRC), so nothing is emitted and nothing changes. A list joined without the
 *   comma ("Logan, Marshall or Stark") is not matched at all.
 *
 *   "Additional applicants to be considered:" / "will also consider" — the funder saying OUT LOUD
 *   that a broader pool qualifies. Here the span is also read at the STATE tier directly, because
 *   the cascade's own narrowness is the trap: North Texas's widening span says "applicants of
 *   other Texas SECTIONS", the section scan finds "North Texas" in it and hands back the very tier
 *   that was already refusing people. Reading the states it names — Texas and Oklahoma — is what
 *   the sentence actually says. One record in the corpus carries this marker, and it is that one.
 *
 * SAFE BY CONSTRUCTION: `anyOf` is a disjunction, so anything emitted here can only turn a refusal
 * into a pass. A wrong entry costs an applicant a page-read; a missing one costs them the award.
 */
const HANDOFF_MARKER = /,\s*or\s+/gi;
const EXPLICIT_WIDENING_MARKER =
  /\badditional\s+applicants?\b[^:.]{0,80}:\s*|\b(?:will|may)\s+also\s+consider\b\s*/gi;

function sameGeo(a: GeoSpec, b: GeoSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function alternativeGeos(text: string, base: GeoSpec): GeoSpec[] {
  const found: GeoSpec[] = [];
  const add = (geo: GeoSpec): void => {
    if (geo.type === 'any' || geo.type === base.type) return;
    if (found.some((g) => sameGeo(g, geo))) return;
    found.push(geo);
  };

  // The funder's own gloss of a call district — see `callDistrictStateTier`. Added first so it
  // reads as the district's own second tier rather than as one of the marker-found spans below.
  const districtStates = callDistrictStateTier(text, base);
  if (districtStates !== undefined) add(districtStates);

  for (const marker of [HANDOFF_MARKER, EXPLICIT_WIDENING_MARKER]) {
    marker.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = marker.exec(text))) {
      const span = text.slice(m.index + m[0].length);
      if (span.trim() === '') continue;
      add(geoFrom(span));
      if (marker === EXPLICIT_WIDENING_MARKER) {
        const states = statesIn(span);
        if (states.length > 0) add({ type: 'state', values: states });
      }
    }
  }
  return found;
}

// ---------- requirement vs preference ----------

/**
 * The funder's own words for what it PREFERS: the spans a preference marker governs, per
 * `preferenceScope`. The mirror image of `requirementText`, which returns everything else.
 *
 * A two-line local rather than an export from preference.ts because that module is shared by
 * every axis and this is the only pair of axes that needs it; `preferenceScope` is the exported
 * primitive, and both halves are read from the same call so they can never disagree about where
 * the boundary is.
 */
function preferenceTextOf(text: string): string {
  return preferenceScope(text).governed.join(' ').trim();
}

function geoConstraint(text: string, geo: GeoSpec, index: number): Constraint {
  const alternatives = alternativeGeos(text, geo);
  return makeConstraint(
    'geography',
    text,
    {
      axis: 'geography',
      geo,
      ...(alternatives.length > 0
        ? { anyOf: alternatives.map((alt) => ({ axis: 'geography' as const, geo: alt })) }
        : {}),
    },
    index,
  );
}

/**
 * ONE FIELD, TWO STATEMENTS — the requirement hard, the preference soft, each read from the
 * clause that states it.
 *
 * `preference.ts` fixed half of this defect class: a preference clause no longer softens the
 * requirement clause beside it. The other half lived here. This axis read its SPEC off the whole
 * captured field, and when the preference names the NARROWER area, the preference's area is what
 * the spec described:
 *
 *   Orlando HamCation  "Resident of Florida, | with preference given to residents of Central
 *                       Florida (Orange, Seminole, Osceola, Lake, Volusia, Brevard and Polk
 *                       Counties)"                          -> geo county[Orange, Seminole, …]
 *   K6GO               "Preference is given to residents of San Diego County …, followed by
 *                       Orange and Los Angeles Counties …. ‖ Award must go to a California
 *                       student."                           -> geo county[San Diego, Orange, …]
 *
 * `makeConstraint`'s `specStatedOnlyAsPreference` guard holds a spec like that SOFT, and rightly:
 * hardening seven preferred counties would bar every other Floridian from an award the funder
 * states they may have. But soft means nobody enforces the requirement either, so an applicant in
 * any state at all was shown a Florida-only award. Both errors at once, from one fused constraint.
 *
 * So each half is extracted from its own clause and emitted as its own constraint, with that
 * clause as its `rawText` — which is also what an applicant is shown, per the same reasoning
 * `institution.ts` gives for its `Field of Study`-derived constraint. Their hard/soft status then
 * follows from each constraint's own text: "Resident of Florida" carries no preference language
 * and is hard; "preference given to residents of Central Florida (…)" is preference prose start to
 * finish and is soft. The guard is no longer what is holding either of them.
 *
 * NEVER SPLIT AN EXPLICIT CASCADE. `isPreferenceText` is true for "State of Indiana; if no
 * qualified applicant is identified, preference given to applicants from the ARRL Central
 * Division" because the funder has said in its own words that the Indiana criterion excludes
 * nobody. Reading "State of Indiana" as a requirement and hardening it would bar the Illinois
 * applicant that sentence explicitly invites — the over-hardening direction, arrived at from the
 * opposite side. Those entries keep exactly the single soft `fallbackRank: 1` constraint they had.
 *
 * Returns `undefined` — meaning "nothing to scope, use the whole field as before" — unless the
 * field really does state two DIFFERENT areas, one required and one preferred. A preference that
 * names no area of its own (or names the same one) changes no verdict and is not worth a second
 * constraint, so those values stay byte-for-byte what they were.
 */
function scopedConstraints(text: string): Constraint[] | undefined {
  if (isPreferenceText(text)) return undefined;
  const required = requirementText(text);
  const preferred = preferenceTextOf(text);
  if (required === '' || preferred === '') return undefined;

  const requiredGeo = geoFrom(required);
  const preferredGeo = geoFrom(preferred);
  if (requiredGeo.type === 'any' || preferredGeo.type === 'any') return undefined;
  if (JSON.stringify(requiredGeo) === JSON.stringify(preferredGeo)) return undefined;

  return [geoConstraint(required, requiredGeo, 0), geoConstraint(preferred, preferredGeo, 1)];
}

export function extractGeography(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields.Region ?? raw.rawFields.counties ?? raw.rawFields.region;
  if (!text || text.trim() === '') return [];
  return scopedConstraints(text) ?? [geoConstraint(text, geoFrom(text), 0)];
}
