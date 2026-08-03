import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { isPreferenceText, makeConstraint } from './preference.js';

const EXCEPT = /\bexcept(?:\s+for)?\b\s*(.+)$/i;
const GPA_ISH = /\bGPA\b|grade[- ]?point\s*average/i;

/**
 * A field name this extractor invents is strictly worse than one it misses. `fields[]` is a
 * disjunction the matcher evaluates: a value the funder never wrote is a filter no applicant can
 * satisfy, so the award becomes invisible to exactly the students it was endowed for (and the
 * applicant has no way to discover that). A *missing* field only widens the list — the award is
 * shown to someone who then reads the funder's own page. Every judgement below therefore breaks
 * toward dropping an uncertain fragment rather than keeping it, and toward `[]` (unconstrained)
 * rather than a list of scaffolding words.
 */

/**
 * Whole-segment "there is no field restriction" wordings. The corpus states this five different
 * ways — "Any", "All", "None", "No preference.", "No requirements." — and every one of them used
 * to become a literal `fields[]` entry that nothing could match ("All", "None", "No preference"),
 * i.e. an award endowed for every field was hidden from every applicant. All five now mean the
 * same thing they mean in English: no constraint.
 */
const UNCONSTRAINED_SEGMENT =
  /^\s*(?:any|all|none|no\s+(?:preference|requirements?|restrictions?|specific)|not\s+applicable|n\/a)\b/i;

/**
 * A cascade/fallback sentence ("If no qualified applicant, award given regardless of the field of
 * study.") describes what happens when the field list finds no taker — it never names a field.
 * Real corpus (North Fulton Amateur Radio League Scholarship) spells applicant "appilcant", so
 * this deliberately keys off "if no ..." and "regardless of ... field" and never off the
 * misspelled noun; before this, that one sentence minted two fabricated fields ("If no qualified
 * appilcant", "award given regardless of the field of study") on top of the two real ones.
 */
const FALLBACK_SENTENCE = /^\s*if\s+no\b|\bregardless\s+of\s+(?:the\s+)?field/i;

/**
 * Sponsorship/administration prose that the source packed into the same `Field of Study` value as
 * the real answer (real corpus, David Knaus Memorial Scholarship: "Bachelor's degree or a 2 year
 * Associate's degree\nThis Scholarship is sponsored by the West Allis Radio Amateur Club"). It is
 * a sentence about the club, not a field of study.
 */
const ADMIN_PROSE = /\b(?:sponsored|administered|funded|endowed|awarded|donated)\s+by\b/i;

/**
 * Strips a leading "Preference [will be given] [to] [applicants/students] [pursuing studies in /
 * of / in / for] ..." preamble — real corpus shapes: "Preference will be given to applicants
 * pursuing studies in Electrical Engineering, ..." (Robert A. Rodriguez K5AUW), "Preference for
 * an Engineering discipline" (Michael Holt), "preference to students of electronics,
 * communications, or related fields" (Charles Clarke Cordle Memorial). Requires the literal word
 * "preference" — the ~100 plain "X, Y or Z" / "Any" entries in this corpus have no such word and
 * are returned untouched. Only fires when a connector is actually found immediately after the
 * preference phrase, so a preference sentence about something *other* than fields ("Preference
 * will be given to undergraduate students and those in certificate programs" — MARCO's
 * degree-level postamble) still matches nothing here and is dropped whole by
 * `cleanedSentenceOrDrop` instead of being mined for fake fields.
 */
const PREAMBLE =
  /^.*?\bpreference\b[^a-zA-Z]*(?:(?:will\s+be|is)\s+given\s+)?(?:to\s+|for\s+)?(?:applicants?|students?|candidates?)?(?:\s+who\s+are)?\s*(?:pursuing(?:\s+studies)?(?:\s+in)?|studying(?:\s+in)?|majoring\s+in|enrolled\s+in|in\s+the\s+fields?\s+of|of|in|for)\s+(?:an?\s+)?/i;

// A trailing generic descriptor word left dangling once the preamble in front of it is gone —
// "Preference for an Engineering discipline" strips to "Engineering discipline" and this removes
// the "discipline". Applied only to a SINGLE remaining field (no list separator left): in a list,
// the same words are the tail of a real, if vague, entry the funder did write — Cordle's "...,
// communications, or related fields" must keep "related fields" rather than be shaved to
// "related".
const TRAILING_DESCRIPTOR = /\s+(?:discipline|field|major|area)s?\.?$/i;
const LIST_SEPARATOR = /,|\/|\bor\b|\band\b/i;

function stripPreamble(text: string): string {
  const m = PREAMBLE.exec(text);
  if (!m) return text;
  const rest = text.slice(m[0].length);
  return LIST_SEPARATOR.test(rest) ? rest : rest.replace(TRAILING_DESCRIPTOR, '');
}

/**
 * "<some degree> degree/program in <list>" — the most common single shape in this corpus (8+
 * entries: "Bachelor's degree or higher in electronics, communications, or related fields" —
 * Irving W. Cook, Paul and Helen L. Grauer, Dr. James L. Lawson, Fred R. McDaniel, Mississippi,
 * L. Phil and Alice J. Wicker, Edmond A. Metzger, Henry Broughton; plus "Associate's or higher
 * degree in the fields of Science, ..." — Joel R. Miller STEM, and "Studies toward a Bachelor of
 * Science degree in any field of engineering" — Gary Wagner). The part before "in" states a
 * DEGREE LEVEL, which is the institution axis's job, not this one; splitting it as if it were
 * field text produced a fabricated "Bachelor's degree" entry plus a mangled "higher in
 * electronics" for the first real field. Bounded to the text before the first comma/semicolon so
 * it can never reach across into an actual list.
 */
const DEGREE_INTRO =
  /^[^,;]*?\b(?:degree|diploma|program)s?\b[^,;]*?\bin\s+(?:the\s+fields?\s+of\s+|any\s+fields?\s+of\s+)?/i;

function stripDegreeIntro(text: string): string {
  const m = DEGREE_INTRO.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/**
 * "leading to (a career in/as/to)", "career in/as", "pursuing/studying/majoring (in)" REPLACE
 * everything before them: in every real occurrence they introduce a field list from scratch,
 * with only generic filler prose ahead of them and no real field names lost by discarding it
 * (real corpus: "Field of study must be leading to a career in the healing arts, including, but
 * not necessarily leading to Medicine, ..." — MARCO Scholarship; "...pursuing a field of study
 * leading to a career in the healing arts, including but not limited to a career in Medicine,
 * ..." — John C. York Scholarship). Takes everything after the LAST such match, so a
 * repeated/nested one resolves to just the final list.
 */
const LIST_INTRO_REPLACE =
  /\b(?:leading\s+to(?:\s+a\s+career\s+(?:in|as|to))?|career\s+(?:in|as)|pursuing(?:\s+studies)?(?:\s+in)?|studying(?:\s+in)?|majoring\s+in)\s+/gi;

/**
 * "including (but not limited/necessarily to)", "such as" ADD more items to a list that already
 * started — they must NOT discard what precedes them, unlike LIST_INTRO_REPLACE above. Real
 * corpus shape (Mark Kupferschmid, AC9PR Scholarship): "Applied sciences, technology,
 * engineering, and mathematics, including but not limited to astronomy, communications,
 * computers, electronics, and physics." — both halves are real fields; treating "including but
 * not limited to" the same as LIST_INTRO_REPLACE would wrongly discard the first four. Stripped
 * down to a bare separator instead.
 */
const LIST_INTRO_MERGE =
  /,?\s*\b(?:including|such\s+as)\b,?\s*(?:but\s+not\s+(?:limited\s+to|necessarily\s+(?:limited\s+to)?)?\s*(?:leading\s+to)?)?\s*/gi;

function stripListIntro(text: string): string {
  let cut = text;
  let last: RegExpExecArray | null = null;
  for (let m = LIST_INTRO_REPLACE.exec(cut); m !== null; m = LIST_INTRO_REPLACE.exec(cut)) last = m;
  if (last) cut = cut.slice(last.index + last[0].length);
  return cut.replace(LIST_INTRO_MERGE, ', ');
}

/**
 * Splits on a "." only when it is a genuine sentence end — never a decimal point ("3.0", "3.2"),
 * which this corpus embeds directly in GPA numbers that leak into `Field of Study` (real corpus:
 * "Bachelor's degree or higher; GPA 3.0 or higher" — Mary Lou Brown Scholarship — must not
 * fragment into "GPA 3" / "0 or higher"), and never an abbreviation's period ("U.S."). Real
 * corpus shape (MARCO Scholarship) also packs a field-list sentence and an unrelated
 * DEGREE-LEVEL preference sentence into one `Field of Study` value, joined by a genuine period:
 * "... or Radiology technician. Preference will be given to undergraduate students and those in
 * certificate programs, but graduate students may apply." Without sentence-level separation,
 * splitFields ran on the whole value and every comma in BOTH sentences became a fake field.
 */
function splitSentences(text: string): string[] {
  const boundaries: number[] = [];
  const DOT = /\./g;
  for (let m = DOT.exec(text); m !== null; m = DOT.exec(text)) {
    const before = text[m.index - 1];
    const beforeBefore = text[m.index - 2];
    const after = text[m.index + 1];
    const isDecimalPoint =
      before !== undefined && after !== undefined && /\d/.test(before) && /\d/.test(after);
    const isAbbreviation =
      before !== undefined &&
      /[A-Z]/.test(before) &&
      (beforeBefore === undefined || beforeBefore === '.' || /\s/.test(beforeBefore));
    if (!isDecimalPoint && !isAbbreviation) boundaries.push(m.index + 1);
  }
  const cuts = [0, ...boundaries, text.length];
  const sentences: string[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) sentences.push(text.slice(cuts[i], cuts[i + 1]).trim());
  return sentences.filter((s) => s !== '');
}

/**
 * A ";" in this corpus's `Field of Study` values separates two independent statements about two
 * different axes, never two items of one list — both real occurrences are a non-field statement
 * beside a field statement: "GPA of 2.5 or higher; preference to students of electronics, ..."
 * (Cordle) and "Bachelor's degree or higher; GPA 3.0 or higher" (Mary Lou Brown). Splitting here
 * is what lets the GPA half be discarded whole (number, connector words and all) instead of
 * leaving its "or higher" tail behind to be split off as a field named "higher".
 */
function splitClauses(sentence: string): string[] {
  return sentence
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * A parenthesis is a separator, not part of a name: "STEM (science, technical, engineering,
 * manufacturing)" (ECARS) split into a field literally named "STEM (science" and another named
 * "manufacturing)". Same shape in Clive Frazier ("STEM (Science, Technology, Engineering or
 * Mathematics)") and SEMARC ("... or mathematics (STEM)"). Both the acronym and its expansion are
 * real, so the parens become separators and every part survives on its own.
 */
function normalizeParens(text: string): string {
  return text.replace(/[()]/g, ', ');
}

/**
 * Vocabulary that describes the *shape* of an award (degree level, institution type, GPA floor,
 * list scaffolding) rather than a subject anyone studies. A split fragment made of nothing but
 * these words is scaffolding that leaked out of an adjacent clause, and as a `fields[]` entry it
 * is unmatchable by construction: "Bachelor's degree", "higher", "trade school", "4-year
 * program", "An accredited 2-", "None", "All", "No preference". One substantive word anywhere in
 * the fragment is enough to keep it — "other 4-year technical degree" (Fritz Nitsch) keeps
 * "technical", "electronic technician certification program" (IRARC) keeps "electronic
 * technician", "International studies" keeps "international" — so this can only ever delete a
 * fragment that names no subject at all.
 */
const NON_FIELD_WORDS = new Set([
  // list scaffolding / articles / connectives
  'an', 'the', 'any', 'all', 'no', 'none', 'not', 'or', 'and', 'of', 'in', 'to', 'for', 'with',
  'must', 'be', 'is', 'are', 'at', 'from', 'this', 'that', 'other',
  // degree level (the institution axis's territory)
  'degree', 'degrees', 'diploma', 'diplomas', 'undergraduate', 'undergrad', 'graduate',
  'associate', 'associates', 'bachelor', 'bachelors', 'master', 'masters', 'doctoral',
  'doctorate', 'phd', 'program', 'programs', 'course', 'courses', 'coursework', 'study', 'studies',
  // institution type (the institution axis's territory)
  'school', 'schools', 'college', 'colleges', 'university', 'universities', 'institution',
  'institutions', 'trade', 'vocational', 'accredited', 'accreditation', 'campus',
  // enrolment shape
  'year', 'years', 'semester', 'semesters', 'term', 'full', 'part', 'time', 'student', 'students',
  'applicant', 'applicants', 'enrolled', 'attending',
  // GPA / threshold language (the gpa axis's territory)
  'gpa', 'grade', 'grades', 'point', 'average', 'cumulative', 'minimum', 'min', 'maximum', 'max',
  'higher', 'high', 'lower', 'low', 'better', 'above', 'below', 'over', 'under', 'greater',
  'least', 'good', 'standing',
  // requirement/preference language
  'preference', 'preferences', 'preferred', 'requirement', 'requirements', 'required', 'require',
  'scholarship', 'scholarships', 'award', 'awards', 'given', 'applicable',
]);

/**
 * True when every word in the fragment is scaffolding (see NON_FIELD_WORDS) — or when there is no
 * word at all, e.g. the "2" that "2 or 4-year program" (Yankee Clipper Contest Club) splits off.
 * Single letters are ignored so a possessive ("Bachelor's" → bachelor + s) is judged on its real
 * word.
 */
function isNonFieldFragment(item: string): boolean {
  const words = item
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 1);
  if (words.length === 0) return true;
  return words.every((w) => NON_FIELD_WORDS.has(w));
}

function splitFields(text: string): string[] {
  return (
    normalizeParens(text)
      .split(/,|\/|\bor\b|\band\b/i)
      // A GPA/grade-point-average fragment is never a field name (real corpus: GPA text
      // routinely leaks into `Field of Study` — Cordle, Daze, Central Arizona DX, Mary Lou Brown —
      // and splitting it on its internal comma/"or" would otherwise mint fake fields like "GPA 30"
      // or "higher GPA 3").
      .filter((s) => !GPA_ISH.test(s))
      .filter((s) => !ADMIN_PROSE.test(s))
      .map((s) => s.replace(/[.;]/g, '').replace(/\s+/g, ' ').trim())
      // A leading article is never part of the field's name ("a Health Care-related field" —
      // Richard Warren K6OBS) and only makes an exact-match harder.
      .map((s) => s.replace(/^(?:an?|the)\s+/i, '').trim())
      .filter((s) => s !== '' && !/^any$/i.test(s))
      .filter((s) => !isNonFieldFragment(s))
  );
}

/**
 * A sentence that is ENTIRELY preference prose about something other than field names (real
 * case: "Preference will be given to undergraduate students and those in certificate programs,
 * but graduate students may apply." — a degree-level preference, not a field list) is dropped
 * outright rather than run through splitFields, which would otherwise turn each of its commas
 * into a fake field. Detected as: contains preference language, AND stripPreamble found no
 * "pursuing/studying/majoring/of/in/for" list connector to strip — i.e. there is no reason to
 * believe a field list is hiding inside it. A cascade/fallback sentence is dropped for the same
 * reason: it says what happens when the list is empty, it never adds to the list. A sentence with
 * no preference or fallback language at all is always kept (it is ordinary field-listing prose,
 * however it may still need the degree-intro and list-intro strippers below).
 */
function cleanedSentenceOrDrop(sentence: string): string | undefined {
  // Tested on the RAW clause, before any stripper runs: "Any undergraduate degree or a two-year
  // technical school in radio communications" (New England Amateur Radio Festival) is
  // unconstrained — the funder accepts any undergraduate degree — but the degree-intro stripper
  // would otherwise hand a bare "radio communications" to the field splitter and turn an open
  // award into a two-word filter. Caught by re-sweeping the corpus, not by any reported entry.
  if (UNCONSTRAINED_SEGMENT.test(sentence)) return undefined;
  if (FALLBACK_SENTENCE.test(sentence)) return undefined;
  const afterPreamble = stripPreamble(sentence);
  if (afterPreamble === sentence && isPreferenceText(sentence)) return undefined;
  return stripListIntro(stripDegreeIntro(afterPreamble));
}

export function extractFieldOfStudy(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields['Field of Study'];
  if (!text || text.trim() === '') return [];
  const except = EXCEPT.exec(text);
  const excludedFields = except ? splitFields(except[1]) : [];
  const requiredPart = except ? text.slice(0, except.index) : text;

  const kept = splitSentences(requiredPart)
    .flatMap(splitClauses)
    .map(cleanedSentenceOrDrop)
    .filter((s): s is string => s !== undefined);
  // Safety net: if every sentence looked like pure preference prose (should not happen on real
  // data — "Any" and plain lists never trigger isPreferenceText), fall back to the untouched
  // required part rather than silently emptying the field list. The per-fragment filters in
  // splitFields still apply to it, so this can restore text but never scaffolding.
  const segments = kept.length > 0 ? kept : [requiredPart];

  const fields = segments.flatMap((s) => (UNCONSTRAINED_SEGMENT.test(s) ? [] : splitFields(s)));
  return [
    makeConstraint('field_of_study', text, { axis: 'field_of_study', fields, excludedFields }, 0),
  ];
}
