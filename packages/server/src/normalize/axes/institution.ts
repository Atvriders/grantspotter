import type { Constraint, DegreeLevel, RawOpportunity } from '@grantspotter/core';
import { sentenceEndBoundaries } from './clauses.js';
import { makeConstraint } from './preference.js';

/**
 * The institution axis, governed throughout by this codebase's asymmetry: a false INCLUDE shows
 * an applicant an award they may not win — recoverable, they read the funder's own page — while a
 * false EXCLUDE hides it permanently and silently. So every rule below only emits a restriction
 * the funder's text actually states, and when the text is ambiguous it does not bar.
 *
 * Two spec fields here are read by matcher.ts as bars, and both used to invert silence into
 * prohibition:
 *
 *  - `partTimeOK`: matcher.ts reads `!spec.partTimeOK` as "this program requires full-time
 *    enrolment". It was computed as `/\bpart[- ]time\b/.test(text)` — i.e. TRUE only if the funder
 *    happened to use the words "part-time". A corpus profile measured the result: a part-time
 *    adult learner was barred from 104 of 112 individual-facing candidates, including entries
 *    whose Institution text is literally "Any". Now it is the other way round: part-time is
 *    permitted unless the funder states an enrolment-intensity requirement.
 *
 *  - `degreeLevels`: a NON-EMPTY list is a bar (matcher.ts fails any applicant whose level is not
 *    in it). Any token the recognizer failed to read therefore narrowed the list into an
 *    exclusion — "Any accredited 4-year college or university, graduate studies permitted" came
 *    out `["GRAD"]`, barring every undergraduate from a scholarship that names undergraduates
 *    first. See CREATING / WIDENING below.
 *
 * `accreditationRequired` and `tradeSchoolOK` default to `false` = "unstated", which is the
 * permissive direction for both (matcher.ts only bars on accreditation when the flag is true, and
 * ignores tradeSchoolOK entirely), so they are left alone.
 */

// ---------------------------------------------------------------- clause splitting

/**
 * Splits `text` into clauses on a genuine sentence end, a ";" or a newline — never on a decimal
 * point ("GPA 3.0 or higher", "a 4.0 scale") and never on an abbreviation's period ("U.S.
 * Department of Education", which is real corpus text).
 *
 * The sentence-end half of this (decimal/abbreviation safety) used to be a private copy of the
 * idiom gpa.ts introduced; it now comes from clauses.ts's `sentenceEndBoundaries`, which is the
 * one place that logic lives for all four axes that need it. This function does NOT import
 * clauses.ts's `splitClauses` wholesale, though: that function deliberately never splits on ";"
 * (several OTHER axes' free-text sentences state one requirement across a semicolon and would be
 * truncated by splitting there), while degree-level matching here wants exactly the opposite —
 * finer-grained clauses than a sentence, so "2 or 4-year college; graduate studies permitted"
 * reads as two separate degree statements rather than one blended one. So the ";"/newline split
 * stays local to this file, layered on top of the shared sentence-end boundaries.
 */
function splitClauses(text: string): string[] {
  const boundaries = sentenceEndBoundaries(text);
  for (const m of text.matchAll(/[;\n]/g)) boundaries.add(m.index + 1);
  const cuts = [0, ...[...boundaries].sort((a, b) => a - b), text.length];
  const clauses: string[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) {
    clauses.push(text.slice(cuts[i], cuts[i + 1]).replace(/^[;\s·]+|[;\s]+$/g, ''));
  }
  return clauses.filter((c) => c !== '');
}

// ---------------------------------------------------------------- degree levels

/** Low to high. Only used to expand "or higher"; nothing else depends on the ordering. */
const LEVEL_ORDER: DegreeLevel[] = ['CERT', 'ASSOC', 'BACH', 'GRAD'];

/**
 * CREATING tokens — statements about the APPLICANT'S OWN course of study. Only these may bring a
 * degree-level bar into existence.
 *
 * A number-of-years form counts as one only when it qualifies "program"/"degree" ("2 or 4-year
 * program", "Engineering or other 4-year technical degree", "intent to complete a 4-year degree").
 * When it qualifies a SCHOOL instead ("Accredited 4-year college or university", the corpus's
 * second-commonest Institution value) it describes the institution's tier, not the applicant's
 * level — a master's candidate attends a 4-year university too — so it creates nothing HERE.
 * Reading an institution tier as THE applicant's degree level would newly exclude associate and
 * graduate applicants from ~15 real entries; that is the false-exclude direction and is not
 * allowed. A tier is read once more, further down and only where the funder stated no credential
 * at all, as a FLOOR that admits its own rung and every rung above — see `statesAFourYearFloor`,
 * which is the other half of this rule and not an exception to it.
 */
const YEARS_2 = String.raw`(?:two|2)\s*-?\s*(?:or\s+(?:four|4)\s*-?\s*)?years?`;
const YEARS_4 = String.raw`(?:four|4)\s*-?\s*years?`;
const OWN_COURSE = String.raw`(?:\w+[\s,-]+)?(?:program|degree)`;
const CREATES: Array<[DegreeLevel, RegExp]> = [
  [
    'CERT',
    /\b(?:certificates?|certifications?|vocational|diplomas?)\b/i,
  ],
  [
    'ASSOC',
    new RegExp(String.raw`\bassociates?\b|\b${YEARS_2}\s+${OWN_COURSE}\b`, 'i'),
  ],
  [
    'BACH',
    new RegExp(String.raw`\b(?:bachelors?|baccalaureates?|undergraduates?)\b|\b${YEARS_4}\s+${OWN_COURSE}\b`, 'i'),
  ],
  // `\bgraduates?\b` cannot match inside "undergraduate" (no word boundary), but does match the
  // "graduate" of "post-graduate" — which is the intended reading anyway.
  [
    'GRAD',
    /\b(?:graduates?|masters?|doctoral|phds?)\b/i,
  ],
];

/** "Undergraduate" is US usage for associate AND bachelor programmes; excluding associate students
 * from "Any undergraduate degree" is a false exclude. */
const UNDERGRAD_INCLUDES_ASSOC = /\bundergraduates?\b/i;

/**
 * A trade / vocational / technical / art / professional school NAMED by the funder as somewhere
 * the applicant may study.
 *
 * A certificate or diploma is the ordinary credential such a school awards. So when a funder
 * names one and the record still carries a degree-level bar that omits `CERT`, that bar excludes
 * exactly the students the funder's own sentence admits — the false-exclude direction this file's
 * header forbids. And the bar in these records is never a statement about certificates: it is
 * assembled from a NEIGHBOURING sentence ("Graduate studies permitted.") or from the OTHER branch
 * of a disjunction ("…or 4-year undergraduate institution"), and then applied to the school branch
 * by nothing more than list membership.
 *
 * This used to require the "or A … school" article shape, written to the one sentence that was
 * reported (CWops). That shape is one way English opens a fresh branch, not the only one, and it
 * left eight records whose funders name a trade school and whose `degreeLevels` still barred
 * certificate students — verbatim, and every one of them widened by this rule:
 *
 *   10-10 International / Hy and Mimi Ginsberg / K3IVO Freestate / Steve Marks W5CIA / QCWA
 *     "An accredited 2- or 4-year college, university, or trade school. Graduate studies
 *      permitted." — the bar was ASSOC+BACH+GRAD, and every one of those levels comes from a
 *      sentence about GRADUATE study plus the school's own 2-/4-year tier. Nothing here says a
 *      trade-school certificate does not count.
 *   ECARS  "Full-time studies at a two-year trade school or 4-year undergraduate institution" —
 *      two branches; "undergraduate" qualifies the second one only.
 *   NEAR-Fest  "Any undergraduate degree or a two-year technical school in radio communications" —
 *      same two-branch shape, and the CWops article to boot; only the word "technical" kept it out.
 *   CWops  "Fully accredited educational institution of higher learning, 2- or 4-year,
 *      undergraduate, graduate or post-graduate, or a fully accredited trade, art or professional
 *      school." — the original ruling, unchanged by this widening.
 *
 * The year figure in "2- or 4-year college, university, or trade school" is the SCHOOL'S tier, not
 * the applicant's credential (see CREATES above, which already refuses to read it as a level): a
 * two-year school awards certificates, diplomas and associate degrees alike.
 */
const TRADE_SCHOOL_NAMED =
  /\b(?:trade|vocational|technical|art|professional)\b[^;.\n]{0,25}?\bschools?\b/i;

/**
 * …unless the funder attached a DEGREE OUTCOME to the enumeration itself.
 *
 * Six Meter Club of Chicago, verbatim: "Part-time or full-time post-secondary student at a
 * regionally accredited technical school, community college, college or university LEADING TO AN
 * UNDERGRADUATE DEGREE." The technical school is named, but the funder has said in its own words
 * what the course of study must end in, and it says so about the whole list rather than about one
 * branch of it. A certificate is not a degree, so that record keeps its ASSOC+BACH bar: this is
 * silence being honoured where there is silence, and a stated restriction being honoured where
 * there is a statement. It is the only one of the nine trade-school records carrying a
 * degree-level bar that is NOT widened.
 */
const DEGREE_OUTCOME_STATED =
  /\b(?:leading\s+to|toward|towards|culminating\s+in|resulting\s+in)\s+(?:an?\s+)?(?:[\w-]+\s+){0,2}?\b(?:degrees?|baccalaureates?)\b/i;

/**
 * WIDENING tokens — institution tiers the funder enumerated. They may only ADD to a list that is
 * already non-empty, never NARROW one: "An accredited 2- or 4-year college, university or trade
 * school. Graduate studies permitted." gains ASSOC and BACH beside its GRAD instead of barring
 * undergraduates. A tier can still bring a bar into existence, but only through the one door
 * below it — `statesAFourYearFloor`, which reads a tier as a floor exactly when the funder stated
 * no credential of their own and named no tier below the four-year one.
 */
const WIDENS: Array<[DegreeLevel, RegExp]> = [
  ['ASSOC', new RegExp(String.raw`\b${YEARS_2}\b|\bcommunity colleges?\b`, 'i')],
  ['BACH', new RegExp(String.raw`\b${YEARS_4}\b`, 'i')],
];

/**
 * ...AND THE HOLE THE WIDENING-ONLY RULE LEFT: A FLOOR THAT REFUSES NOBODY.
 *
 * WIDENS may only add to a list that already exists. So a record whose ONLY degree statement is
 * the school's tier came out `degreeLevels: []` — and an empty list is not "no bar at that level",
 * it is NO BAR AT ALL. 20 records in this corpus are that exact shape, every one of them HARD:
 *
 *   "4-year college or university"            (Bendicksen N7ZL, Cebik W4RNL, Bennett W7PHO, …)
 *   "Accredited 4-year college or university" (Broughton K2AE, Dayton ARA, Orlando HamCation, …)
 *   "Accredited four-year college or university"                              (YASME Foundation)
 *   "Full-time student at an accredited 4-year college or university"      (Holt K8MJH/KC8OIP)
 *
 * MEASURED, with `scripts/profile-corpus.ts`'s own loader over the 150 publishable programmes.
 * The part-time community-college ASSOC student (`adult-parttime`) was told `eligible` or
 * `eligible_preferred` by 11 of these 20; the trade-school CERT student (`cert-trade`) by 10.
 * Swept across all 51 states, an accredited community-college associate student went 2,447
 * positives -> 1,864 and a trade-school certificate student 2,282 -> 1,699. A funder who wrote
 * "4-year college or university" has said in their own words where the applicant must be
 * studying, and a student one rung below that floor was reading `eligible` on that same sentence.
 *
 * AND IT REFUSED NOBODY THE SENTENCE ADMITS. The same sweep for a bachelor's student and for a
 * graduate student — 51 states x 150 programmes each — moved ZERO pairs, in either direction.
 *
 * THIS IS NOT A REVERSAL OF THE WIDENING-ONLY RULE, AND MUST NOT BECOME ONE. That rule cures a
 * NARROWING: a tier token may never remove a level the funder actually named, which is what turned
 * "Any accredited 4-year college or university, graduate studies permitted" into `["GRAD"]` and
 * barred every undergraduate from a scholarship that names undergraduates first. Both directions
 * of that cure are kept here, by two conditions that are the whole rule:
 *
 *   1. IT ONLY FIRES ON SILENCE. If any clause CREATED a level — i.e. the funder said anything at
 *      all about the applicant's own credential — the tier stays a widener and nothing below
 *      changes. Not one record that publishes a level today has that level taken away.
 *   2. IT IS A FLOOR, NOT A LEVEL. "4-year college or university" admits BACH *and every rung
 *      above it*, because a master's candidate attends a 4-year university too — reading the tier
 *      as the single level BACH is precisely the false exclude the header forbids, and would
 *      newly refuse a graduate applicant from 11 of these 20 records.
 *
 * AND IT REFUSES TO GUESS DOWNWARD. The floor is only read off a sentence that names the 4-year
 * tier AND NO TIER AT OR BELOW IT. "Any accredited 2- or 4-year college or university", "An
 * accredited 2- or 4-year college, university, or trade school" and "Accredited 4-year college or
 * university, junior college or trade technicial school in the U.S." (all verbatim) name a
 * two-year or vocational route themselves, so they keep `[]` and go on refusing nobody — which is
 * what those sentences say. A certificate student at an accredited community college is inside
 * "2- or 4-year college", and barring them on a guess is the direction that hides money forever.
 */
const FOUR_YEAR_TIER = new RegExp(
  String.raw`\b${YEARS_4}\s+(?:[\w.'-]+[\s,]+){0,3}?(?:colleges?|universit(?:y|ies)|institutions?|schools?)\b`,
  'i',
);
/** Any tier at or below the four-year one, named anywhere in the same text. See above. */
const LOWER_TIER_NAMED = new RegExp(
  String.raw`\b${YEARS_2}\b|\b(?:community|junior)\s+colleges?\b|\bpost[-\s]?secondary\b` +
    String.raw`|${TRADE_SCHOOL_NAMED.source}`,
  'i',
);
function statesAFourYearFloor(text: string): boolean {
  return FOUR_YEAR_TIER.test(text) && !LOWER_TIER_NAMED.test(text);
}

/** See TRADE_SCHOOL_NAMED / DEGREE_OUTCOME_STATED. Widens to CERT, never creates a bar. */
function admitsCertificate(text: string): boolean {
  return TRADE_SCHOOL_NAMED.test(text) && !DEGREE_OUTCOME_STATED.test(text);
}

/**
 * "or higher" opens every level above the one named — but only when it is attached to a degree
 * word. "GPA 3.0 or higher" and "institution of higher learning" are not degree statements, and
 * the 20-character leash keeps them out ("...graduate school thereof, and have a GPA of 3.0 or
 * higher" is one clause in the real corpus).
 */
const OR_HIGHER =
  /\b(?:degrees?|programs?|certificates?|bachelors?|associates?|baccalaureates?|undergraduates?|masters?)\b[^;.]{0,20}?\bor\s+higher\b/i;

function degreeLevels(clauses: string[]): DegreeLevel[] {
  const levels = new Set<DegreeLevel>();
  for (const clause of clauses) {
    const created = new Set<DegreeLevel>();
    for (const [level, re] of CREATES) if (re.test(clause)) created.add(level);
    if (UNDERGRAD_INCLUDES_ASSOC.test(clause)) created.add('ASSOC');
    if (created.size > 0 && OR_HIGHER.test(clause)) {
      const highest = Math.max(...[...created].map((l) => LEVEL_ORDER.indexOf(l)));
      for (const level of LEVEL_ORDER.slice(highest + 1)) created.add(level);
    }
    for (const level of created) levels.add(level);
  }
  const text = clauses.join(' ');
  if (levels.size === 0) {
    // The funder stated no credential of their own. A tier sentence is then the only degree
    // statement there is, and it is a floor — see statesAFourYearFloor. Silence stays silence
    // for every other wording.
    if (!statesAFourYearFloor(text)) return [];
    for (const level of LEVEL_ORDER.slice(LEVEL_ORDER.indexOf('BACH'))) levels.add(level);
  }
  for (const [level, re] of WIDENS) if (re.test(text)) levels.add(level);
  if (admitsCertificate(text)) levels.add('CERT');
  return LEVEL_ORDER.filter((l) => levels.has(l));
}

// ---------------------------------------------------------------- enrolment intensity

/**
 * A full-time REQUIREMENT: "full-time" immediately qualifying enrolment ("full-time studies",
 * "Full-time student at...", "enrolled in a full time degree program"). Deliberately forward-only.
 * The YLRL Marte Wessel K0EPE award — the one award in the corpus aimed squarely at part-time
 * students — reads "For part-time students working full-time", where "full-time" qualifies
 * EMPLOYMENT and is followed by nothing at all; a looser or backward-looking match would bar the
 * very applicants it exists for.
 */
const FULL_TIME_REQUIRED =
  /\bfull[-\s]?time\b[\s,]*(?:[\w-]+[\s,]+){0,2}?(?:stud(?:y|ies|ents?)|enroll?(?:ed|ment|ing)|attendance|course\s+load|credit\s+hours?|degrees?|programs?|basis|status|schedule|matriculat\w*)\b/i;
const PART_TIME_MENTIONED = /\bpart[-\s]?time\b/i;
/** An explicit prohibition is not silence, so it is honoured — but nothing weaker is. */
const PART_TIME_BARRED = new RegExp(
  String.raw`\b(?:no|not|non-?)\s+part[-\s]?time\b` +
    String.raw`|\bpart[-\s]?time\b[^;.]{0,40}?\b(?:not eligible|ineligible|excluded|do(?:es)? not qualify|will not be considered)\b`,
  'i',
);

/**
 * Absence of evidence is absence of a restriction. A funder who never mentions enrolment
 * intensity has not banned part-time students, and a funder who explicitly welcomes them ("Part-
 * time or full-time post-secondary student at...") has said so outright — that wins over the word
 * "full-time" elsewhere in the same sentence.
 */
function partTimePermitted(text: string): boolean {
  if (PART_TIME_BARRED.test(text)) return false;
  if (PART_TIME_MENTIONED.test(text)) return true;
  return !FULL_TIME_REQUIRED.test(text);
}

// ---------------------------------------------------------------- candidate texts

/**
 * A clause states something about the institution or the applicant's degree level. Requires a
 * concrete NOUN, never the bare word "accredited": "ABET accredited Engineering" (The Vernon
 * "Bill" Lippert scholarship's Field of Study, verbatim) is PROGRAMME accreditation and has
 * nothing to say about the institution accreditation matcher.ts asks the applicant about.
 */
const INSTITUTION_STATEMENT = new RegExp(
  String.raw`\b(?:certificates?|certifications?|diplomas?|associates?|bachelors?|baccalaureates?` +
    String.raw`|masters?|doctoral|phds?|undergraduates?|graduates?|colleges?|universit(?:y|ies)` +
    String.raw`|trade\s+schools?|technical\s+schools?|vocational|post[-\s]?secondary` +
    String.raw`|institutions?\s+of\s+higher)\b` +
    String.raw`|\b(?:${YEARS_2}|${YEARS_4})\s+${OWN_COURSE}\b`,
  'i',
);

function spec(text: string): Extract<Constraint['spec'], { axis: 'institution' }> {
  return {
    axis: 'institution',
    degreeLevels: degreeLevels(splitClauses(text)),
    // "trade" is deliberately excluded from CREATES above — it drives tradeSchoolOK, not a
    // certificate-level requirement, so naming a trade school can never CREATE a degree-level bar
    // on a record that had none. Where a bar already exists from other wording, a named trade
    // school WIDENS it to include CERT — see TRADE_SCHOOL_NAMED / admitsCertificate above.
    tradeSchoolOK: /\b(?:trade|vocational|technical schools?)\b/i.test(text),
    partTimeOK: partTimePermitted(text),
    accreditationRequired: /\baccredit/i.test(text),
  };
}

export function extractInstitution(raw: RawOpportunity): Constraint[] {
  const out: Constraint[] = [];

  // The labelled field, verbatim — unchanged, and still the primary constraint's rawText.
  const primary = raw.rawFields.Institution;
  if (primary !== undefined && primary.trim() !== '') {
    out.push(makeConstraint('institution', primary, spec(primary), 0));
  }

  /**
   * This corpus routinely files the degree-level (and sometimes the whole institution)
   * requirement under `Field of Study` instead: 19 of 111 ARRL entries, including four with no
   * `Institution` field at all (CARA, Knaus, Wicker). Those requirements were previously enforced
   * — wrongly — by the field-of-study axis, which fabricated "Bachelor's degree" and "or higher"
   * into its `fields[]`; once that stopped, real funder-stated requirements were evaluated by
   * nobody. They are read here instead, narrowed to the clauses that genuinely make an
   * institution/degree statement and emitted as their OWN constraint so the rawText shown to an
   * applicant is the funder's wording for that requirement and nothing else. Nothing broader is
   * read: `Other` and `rawText` were swept too and carry no institution statement this misses,
   * while reading them would invent institution constraints out of unrelated prose — the exact
   * fabrication just removed from the field axis.
   */
  const field = raw.rawFields['Field of Study'];
  if (field !== undefined && field.trim() !== '') {
    const stated = splitClauses(field).filter((c) => INSTITUTION_STATEMENT.test(c));
    if (stated.length > 0) {
      const text = stated.join(' ');
      out.push(makeConstraint('institution', text, spec(text), out.length));
    }
  }

  return out;
}
