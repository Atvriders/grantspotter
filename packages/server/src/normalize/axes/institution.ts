import type { Constraint, DegreeLevel, RawOpportunity } from '@grantspotter/core';
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
 * Department of Education", which is real corpus text). This is the same safe splitter gpa.ts
 * introduced to replace the naive `[^.]*\.` sentence idiom; a `[^.]*\.` here would cut
 * "2 year Associate's degree" style text at the wrong places and, worse, silently truncate the
 * clause a level is read from.
 */
function splitClauses(text: string): string[] {
  const boundaries = new Set<number>();
  const DOT = /\./g;
  for (let m = DOT.exec(text); m !== null; m = DOT.exec(text)) {
    const before = text[m.index - 1];
    const beforeBefore = text[m.index - 2];
    const after = text[m.index + 1];
    const isDecimalPoint =
      before !== undefined && after !== undefined && /\d/.test(before) && /\d/.test(after);
    // A single capital letter preceded by whitespace/start-of-string or another period is an
    // initial ("U.S.", "U.S.A."), not a sentence end.
    const isAbbreviation =
      before !== undefined &&
      /[A-Z]/.test(before) &&
      (beforeBefore === undefined || beforeBefore === '.' || /\s/.test(beforeBefore));
    if (!isDecimalPoint && !isAbbreviation) boundaries.add(m.index + 1);
  }
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
 * level — a master's candidate attends a 4-year university too — so it creates nothing. Reading
 * institution tier as degree level would newly exclude associate and graduate applicants from
 * ~15 real entries; that is the false-exclude direction and is not allowed.
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
 * WIDENING tokens — institution tiers the funder enumerated. They may only ADD to a list that is
 * already non-empty, never create one, so no entry ever gains a bar it did not have: "An
 * accredited 2- or 4-year college, university or trade school. Graduate studies permitted."
 * gains ASSOC and BACH beside its GRAD instead of barring undergraduates, while "Accredited
 * 4-year college or university" stays unrestricted.
 */
const WIDENS: Array<[DegreeLevel, RegExp]> = [
  ['ASSOC', new RegExp(String.raw`\b${YEARS_2}\b|\bcommunity colleges?\b`, 'i')],
  ['BACH', new RegExp(String.raw`\b${YEARS_4}\b`, 'i')],
];

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
  if (levels.size === 0) return [];
  const text = clauses.join(' ');
  for (const [level, re] of WIDENS) if (re.test(text)) levels.add(level);
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
    // "trade" is deliberately excluded from CERT above — it drives tradeSchoolOK, not a
    // certificate-level requirement; a trade school accepted alongside two/four-year/graduate
    // programs isn't itself a certificate-level requirement.
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
