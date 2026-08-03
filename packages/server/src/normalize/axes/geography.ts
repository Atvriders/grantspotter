import { ARRL_DIVISIONS, ARRL_SECTIONS } from '@grantspotter/core';
import type { Constraint, GeoSpec, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';
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
  `((?:${NAME}\\s*(?:,\\s*|\\s+(?:or|and)\\s+))*${NAME})\\s+[Cc]ount(?:y|ies)\\b(?!\\s*:)`,
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
  if (counties.length > 0) return { type: 'county', values: counties };

  const states = new Set<string>();
  for (const [name, code] of Object.entries(STATE_BY_NAME)) {
    if (stateNamePattern(name).test(text)) states.add(code);
  }
  for (const m of text.matchAll(/\b([A-Z]{2})\b/g)) {
    if (Object.values(STATE_BY_NAME).includes(m[1])) states.add(m[1]);
  }
  if (states.size > 0) return { type: 'state', values: [...states] };

  return { type: 'any', values: [] };
}

export function extractGeography(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields.Region ?? raw.rawFields.counties ?? raw.rawFields.region;
  if (!text || text.trim() === '') return [];
  return [makeConstraint('geography', text, { axis: 'geography', geo: geoFrom(text) }, 0)];
}
