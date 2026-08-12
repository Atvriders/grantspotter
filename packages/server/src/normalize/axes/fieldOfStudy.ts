import type { Constraint, ConstraintSpecFor, RawOpportunity } from '@grantspotter/core';
import { sentenceEndBoundaries } from './clauses.js';
import {
  isPreferenceText,
  makeConstraint,
  preferenceScope,
  requirementText,
} from './preference.js';

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
 * everything before them: they introduce a field list from scratch, and what stands in front of
 * them is generic filler ("Field of study must be", "Applicant must be", "Studies toward"). Takes
 * everything after the LAST such match, so a repeated/nested one resolves to just the final list.
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
 *
 * The tail — an optional "(leading to) (a) career in/as" — belongs to the WIDENER, not to a new
 * list. Both healing-arts entries end their widener with exactly that phrase ("...but not
 * necessarily leading to Medicine", "...but not limited to a career in Medicine"), which is why
 * it is consumed here rather than left for LIST_INTRO_REPLACE to find. See `stripListIntro`.
 */
const LIST_INTRO_MERGE =
  /,?\s*\b(?:including|such\s+as)\b,?\s*(?:but\s+not\s+(?:limited\s+to|necessarily\s+(?:limited\s+to)?)?\s*(?:leading\s+to)?)?\s*(?:(?:leading\s+to\s+)?(?:an?\s+)?careers?\s+(?:in|as)\s+)?/gi;

/**
 * MERGE RUNS FIRST, AND THAT ORDER IS THE WHOLE POINT.
 *
 * "including, but not necessarily leading to" and "including but not limited to a career in" both
 * END in a phrase LIST_INTRO_REPLACE recognises as a list intro. Running REPLACE first therefore
 * made the WIDENER the last intro in the string, and cutting to it deleted the very field the
 * widener was widening:
 *
 *   MARCO   "Field of study must be leading to a career in THE HEALING ARTS, including, but not
 *            necessarily leading to Medicine, Dentistry, Veterinary Medicine, Nursing, Pharmacy,
 *            EMT, or Radiology technician."
 *   York    "…pursuing a field of study leading to a career in THE HEALING ARTS, including but not
 *            limited to a career in Medicine, Nursing, Dentistry, Pharmacy, EMT, or Radiology"
 *
 * Both came out as a closed list of the examples with the governing field — the healing arts, the
 * one field both awards are actually endowed for, and the category one ARRL entry exists
 * specifically to bring into amateur radio — deleted. A comment here used to assert that no real
 * field name is lost this way and cite these two records as the evidence; it was false for both.
 *
 * Neutralising the widener before looking for an intro fixes it: MARCO and York keep "healing
 * arts" at the head of their lists, and Kupferschmid's "Applied sciences, technology, engineering,
 * and mathematics, including but not limited to astronomy, …" is unaffected because its widener
 * has no intro phrase in it and REPLACE finds nothing to cut in either order.
 *
 * What IS still dropped in front of the last intro is only ever filler — "Field of study must be",
 * "Applicant must be", "Studies toward a Bachelor of Science degree" — because `splitFields` and
 * `isNonFieldFragment` would discard those words anyway. That is the honest form of the claim the
 * old comment overstated.
 */
function stripListIntro(text: string): string {
  const merged = text.replace(LIST_INTRO_MERGE, ', ');
  let last: RegExpExecArray | null = null;
  LIST_INTRO_REPLACE.lastIndex = 0;
  for (let m = LIST_INTRO_REPLACE.exec(merged); m !== null; m = LIST_INTRO_REPLACE.exec(merged)) {
    last = m;
  }
  return last === null ? merged : merged.slice(last.index + last[0].length);
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
 *
 * The decimal/abbreviation safety used to be a private copy of the idiom gpa.ts introduced; it
 * now comes from clauses.ts's `sentenceEndBoundaries`, the one shared place that logic lives.
 * Deliberately still not the shared `splitClauses` itself — this function only ever wants
 * sentence-level (".") boundaries, never clauses.ts's numbered-list/bullet/field-label rules
 * (this axis reads a single already-isolated `Field of Study` value, not a flattened multi-field
 * record, so none of those apply here), and the separate `splitClauses` below it in this same
 * file already owns ";" splitting for a reason specific to field lists (see its own comment).
 */
function splitSentences(text: string): string[] {
  const boundaries = [...sentenceEndBoundaries(text)].sort((a, b) => a - b);
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

/**
 * Every field name stated in `part`.
 *
 * `safetyNet` decides what happens when every sentence was dropped. For a WHOLE captured value
 * that would mean the extractor understood none of it, and falling back to the untouched text is
 * the conservative answer (the per-fragment filters in `splitFields` still apply, so it can
 * restore text but never scaffolding). For a scoped HALF of a value it is the opposite: the half
 * was isolated precisely because something else in the sentence governs it, and "every sentence
 * dropped" is the correct answer rather than a failure to parse. MARCO's preference half —
 * "Preference will be given to undergraduate students and those in certificate programs, but
 * graduate students may apply." — is a degree-level statement naming no field at all, and with
 * the safety net on it mines three fabricated fields out of its own commas.
 */
function fieldsIn(part: string, safetyNet: boolean): string[] {
  const kept = splitSentences(part)
    .flatMap(splitClauses)
    .map(cleanedSentenceOrDrop)
    .filter((s): s is string => s !== undefined);
  const segments = kept.length > 0 ? kept : safetyNet ? [part] : [];
  return segments.flatMap((s) => (UNCONSTRAINED_SEGMENT.test(s) ? [] : splitFields(s)));
}

/**
 * Words that name an ACADEMIC ROUTE — a degree level or a kind of programme — as opposed to the
 * grade-and-comparative scaffolding that also ends up in `NON_FIELD_WORDS`. Drawn from that set,
 * deliberately narrower than it, and the difference is what makes `unrestrictedAlternative` below
 * a rule rather than a licence to unrestrict everything.
 */
const DEGREE_ROUTE_WORDS = new Set([
  'degree', 'degrees', 'diploma', 'diplomas', 'undergraduate', 'undergrad', 'graduate',
  'associate', 'associates', 'bachelor', 'bachelors', 'master', 'masters', 'doctoral',
  'doctorate', 'phd', 'program', 'programs', 'course', 'courses', 'coursework', 'school',
  'schools', 'college', 'colleges', 'university', 'universities', 'apprenticeship',
]);

/**
 * DROPPING AN ALTERNATIVE FROM A DISJUNCTION REMOVES A ROUTE TO THE MONEY.
 *
 * IRARC Memorial (Rubino) states its field requirement as "UNDERGRADUATE DEGREE or electronic
 * technician certification program". Two routes. The first names an academic route and NO subject,
 * so `isNonFieldFragment` discards it — correctly, as a field NAME — and the surviving list is the
 * single value "electronic technician certification program", published as a hard bar. A Biology
 * undergraduate in Brevard County was refused an award whose own sentence's first words admit her.
 *
 * A fragment that names a route and no subject is not noise when it stands as an ALTERNATIVE: it
 * is the funder saying "…or just be an undergraduate", which places no restriction on the subject
 * at all. So it is emitted as a tier of its own — `fields: []`, which the matcher already reads as
 * unrestricted — instead of being dropped. The funder's named programme stays in the base tier, so
 * the record still says what they wrote.
 *
 * WHY IT IS NOT "ANY DROPPED FRAGMENT". The Donald E. Daze, N5DD, Scholarship's value is
 * "Engineering, GPA requirement 3.0 or higher": splitting it leaves a bare "higher", which is also
 * discarded and is NOT an alternative — it is the tail of a GPA phrase whose head another axis
 * owns. Treating it as one would unrestrict an engineering-only award out of a comparative
 * adjective. The route words above are what separate them, and they are the reason this asks for a
 * degree/programme noun rather than for "the fragment was dropped".
 *
 * The other nine records whose raw text splits this way never reach here at all: "Bachelor's degree
 * or higher in electronics, communications, or related fields" is consumed by `DEGREE_INTRO`
 * before any split, exactly as intended, so their degree prefix is never an alternative in the
 * first place. Measured over the committed fixtures, one record gains this tier: IRARC.
 */
function unrestrictedAlternative(part: string, fields: string[]): boolean {
  if (fields.length === 0) return false;
  return splitSentences(part)
    .flatMap(splitClauses)
    .map(cleanedSentenceOrDrop)
    .filter((s): s is string => s !== undefined)
    .some((segment) =>
      normalizeParens(segment)
        .split(/\bor\b/i)
        .some((fragment) => {
          const words = fragment.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1);
          if (words.length === 0) return false;
          if (!words.every((w) => NON_FIELD_WORDS.has(w))) return false;
          return words.some((w) => DEGREE_ROUTE_WORDS.has(w));
        }),
    );
}

/**
 * A DOMAIN IS NOT A LIST OF MAJORS — the largest false-exclude in the corpus, by a wide margin.
 *
 * "Science, Technology, Engineering or Mathematics" (Rev. Paul E. Bittner, WØAIH, Memorial) is
 * parsed faithfully: `fields: ['Science','Technology','Engineering','Mathematics']` is exactly
 * what the page says. The refusal happens downstream. `matcher.ts` matches a field by STEMMED WORD
 * OVERLAP between the applicant's phrase and the funder's — it has no taxonomy, and cannot have
 * one — so an umbrella noun only admits an applicant who happens to reuse the noun. Measured with
 * the real `evaluateConstraint` against that exact spec and rawText:
 *
 *   "Science, Technology, Engineering or Mathematics"  refused Physics, Chemistry, Biology,
 *                                                      Astronomy, Geology, Statistics,
 *                                                      Cybersecurity, Mechatronics, Nursing
 *   "Sciences or Engineering"        (YASME)           refused the same nine
 *   "Medical"       (Carole J. Streeter, KB9JBR)       refused all nineteen probes, Nursing and
 *                                                      Radiography included — nothing passes it
 *   "…or a Health Care-related field" (Richard Warren) refused Nursing
 *   "Technical field"  (Wayne Nelson, KB4UT)           refused Computer Science, Welding Technology
 *   "Communications"   (Goldwater, verified on the
 *                       ARRL page)                     refused Journalism, Broadcasting
 *
 * A physics undergraduate reads "Science" on the screen directly above the word "no". That is the
 * doctrine's exact failure mode — the evidence GrantSpotter displays refutes the verdict it prints
 * — and it is why holding everything else identical and changing only the word in the "what do you
 * study?" box took a student from 55 refusals of 150 to 77.
 *
 * WHAT THE HONEST ANSWER IS, and why it is not a wider list. There is no widening marker in these
 * sentences: "Science, Technology, Engineering or Mathematics" is a genuinely CLOSED list — of
 * umbrellas — so `funderOpenedTheList` does not apply and must not be made to. Nor may this
 * extractor invent the members ("Science" → Physics, Chemistry, Biology, …): the list would be
 * arbitrary, never exhaustive, and every subject it forgot would still be refused, which is the
 * same defect with a longer tail. What is TRUE is narrower and exactly representable: the funder
 * named a route — "study a subject that falls within this domain" — and THIS SCHEMA CANNOT CHECK
 * IT, because deciding whether Radiography is inside "Medical" is not word overlap. So the spec
 * says so, in the funder's own words, and `ConstraintAlternatives.orUnrepresented` turns what was
 * a refusal into `unknown` with nothing to fill in. Never a `pass` — a music major is not admitted
 * to a STEM award by this — and never a refusal.
 *
 * WHICH ENTRIES, and why the test is this strict. A BARE domain noun is the whole defect: an
 * applicant who studies an instance of it shares no word with it. A domain noun with a MODIFIER is
 * a field in its own right and matches the way lexical matching is meant to — "Computer Science",
 * "Communications Engineering", "Applied Sciences", "Physical Science", "Science Education",
 * "electrical engineering", "ABET accredited Engineering" are all left exactly as they are, and
 * every one of them still refuses a music major. So an entry qualifies only when, after its
 * scaffolding words are removed, NOTHING IS LEFT BUT THE DOMAIN TERM ITSELF. Nine records carry a
 * modified domain and no bare one; none of them changes.
 *
 * EVERY WORD IN THIS SET WAS MEASURED, not assumed: each one is here because a subject that is
 * uncontroversially INSIDE it is refused by a real constraint in the corpus (the table above).
 * That is the bar for adding a tenth: name the domain, name the corpus record, and name the major
 * it refuses. "Education" and "Agriculture" are deliberately absent — both appear only in lists
 * that already carry a bare domain, so nothing in this corpus turns on them and no refusal was
 * measured to justify them.
 */
const UNADJUDICABLE_DOMAINS = new Set([
  // `scientific` sits beside `science`/`sciences` for exactly the reason `technical` already sits
  // beside `technology`/`technologies`: it is the same domain in its adjectival form, and the set
  // is about the DOMAIN a word names, not the part of speech it names it with. Added round six
  // under this block's own bar — name the domain, the record, and the major it refuses: the domain
  // is `scientific`, the record is The Chick Allen, NW3Y, Scholarship ("Electronics, Electrical
  // Engineering, Aerospace Engineering, Computer Science OR SIMILAR SCIENTIFIC FIELD"), and the
  // majors are Physics, Chemistry, Biology and Astronomy — every one of them a hard `ineligible`
  // measured with the real matcher, under a sentence that invites them in so many words.
  'science', 'sciences', 'scientific', 'stem',
  'technology', 'technologies', 'technical',
  'engineering',
  'mathematics', 'math', 'maths',
  'medical', 'medicine',
  'health care', 'healthcare',
  'business',
  'communications', 'communication',
]);

/**
 * Scaffolding around a field name, removed before the domain test and ONLY for that test — the
 * spec keeps the funder's entry verbatim. "Mathematics fields" (Lois Manley), "Technology-related
 * field" (Homer V. Thompson, Walter Gallinghouse), "a Health Care-related field" (Richard Warren)
 * and "similar scientific field" (Chick Allen) are the corpus's four shapes, and all four name the
 * domain and nothing else.
 *
 * `similar` JOINED `related` IN ROUND SIX, and the fourth shape is why. The relatedness word may
 * come FIRST — "or SIMILAR SCIENTIFIC field", not "Technology-RELATED field" — and with only
 * `related` here that entry's core came out as "similar scientific", which is in no domain set, so
 * the phrase fell through this net as well as through `matcher.ts`'s `isFieldWideningMarker` (where
 * it is deliberately not a widening, because "scientific" names a real bound). It therefore
 * survived into `fields` as a LIST MEMBER THAT MATCHES ALMOST NOBODY: word overlap admits only an
 * applicant who writes "similar", "scientific" or "field" in their own major. Measured before this
 * change, Chick Allen hard-refused 16 of 20 probed majors, Physics, Chemistry, Biology and
 * Astronomy among them, while displaying "or similar scientific field" as the evidence.
 *
 * `similar` is a relatedness word exactly as `related` is — `matcher.ts`'s `RELATEDNESS_WORDS`
 * has carried both since long before this — so this is one list catching up with the other, not a
 * new judgement. The remedy is `orUnrepresented` (fail -> unknown) and NOT widening (fail -> pass):
 * whether Physics is a field similar to Aerospace Engineering is not something this matcher can
 * decide, and a music major must still not be admitted to it.
 */
const ENTRY_SCAFFOLDING = new Set([
  'field', 'fields', 'discipline', 'disciplines', 'area', 'areas', 'major', 'majors',
  'subject', 'subjects', 'study', 'studies', 'related', 'similar', 'of', 'in', 'a', 'an', 'the',
  'or',
]);

/**
 * A trailing purpose clause says what the study must ACHIEVE, not which subject it names, so it is
 * cut before the domain test. One record needs it, and it is the clearest evidence that lexical
 * matching cannot adjudicate a domain: the Orlando HamCation Scholarship's "Technical field of
 * study that would support the radio art" admits Electrical Engineering and refuses COMPUTER
 * SCIENCE — an arbitrary split produced by which words happen to appear in the phrase, on a
 * requirement that is plainly satisfied by both.
 */
const PURPOSE_CLAUSE = /\b(?:that|which|leading to|to support|supporting)\b.*$/i;

function namesADomain(entry: string): boolean {
  const core = entry
    .replace(PURPOSE_CLAUSE, '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w !== '' && !ENTRY_SCAFFOLDING.has(w))
    .join(' ');
  return UNADJUDICABLE_DOMAINS.has(core);
}

/**
 * The funder's own words for the routes this schema cannot check — the bare domains in their list,
 * in the order they wrote them.
 *
 * NOT WHEN THE RECORD CARRIES AN EXCLUSION. `orUnrepresented` is consulted whenever the tier
 * fails, and an exclusion failing is the one refusal that must stand: "any field except Liberal
 * Arts" bars a liberal-arts student whatever else the sentence says, and softening that to
 * `unknown` would be a route around a bar the funder wrote in so many words. Same rule, and the
 * same reason, as the `anyOf` alternative below carrying `excludedFields` rather than dropping it.
 */
function unadjudicableDomains(fields: string[], excludedFields: string[]): string | undefined {
  if (excludedFields.length > 0) return undefined;
  const domains = fields.filter(namesADomain);
  return domains.length > 0 ? domains.join(', ') : undefined;
}

function fieldSpec(fields: string[], excludedFields: string[]): ConstraintSpecFor<'field_of_study'> {
  const orUnrepresented = unadjudicableDomains(fields, excludedFields);
  return {
    axis: 'field_of_study',
    fields,
    excludedFields,
    ...(orUnrepresented !== undefined ? { orUnrepresented } : {}),
  };
}

/**
 * ONE FIELD, TWO STATEMENTS — and here the required half is not a field of study at all.
 *
 * Charles Clarke Cordle's whole `Field of Study` value is
 *
 *   "GPA of 2.5 or higher; | preference to students of electronics, communications, or related fields"
 *
 * The half the funder REQUIRES is a GPA floor. It is MISFILED rather than mis-scoped: a GPA floor
 * is `gpa.ts`'s business, and that axis already publishes `min: 2.5` for this entry, reading the
 * same words through its `rawText` fallback (this corpus files requirements under `Field of Study`
 * often enough that `institution.ts` reads 19 of the 111 entries' degree rules out of it too).
 * So this axis DECLINES that half: it names no field, and the two ways of "using" it anyway are
 * both worse than nothing — minting a `fields[]` entry out of GPA wording is a filter no applicant
 * can satisfy (the fabrication defect this file exists to prevent), and synthesising a GPA
 * constraint from the field axis would make two extractors own one requirement, which is how they
 * drift apart.
 *
 * What is left is the preference, and it is emitted as its own soft constraint carrying the
 * funder's own wording, rather than as a whole-value constraint that `makeConstraint`'s
 * preference-derived-spec guard has to hold down. Where BOTH halves name fields, both constraints
 * are emitted: required hard, preferred soft.
 *
 * Returns `undefined` — "nothing to scope, use the whole value as before" — for everything else:
 * an explicit cascade or a whole-value preference (`isPreferenceText`, e.g. Holt's "Preference for
 * an Engineering discipline", which has no requirement half to scope to), a value with no
 * preference at all, and a preference half that names no field (MARCO). An exclusion is a
 * REQUIREMENT and must never ride on the soft constraint, so a value that carries one but states
 * no required field is left whole too.
 */
function scopedConstraints(requiredPart: string, excludedFields: string[]): Constraint[] | undefined {
  if (isPreferenceText(requiredPart)) return undefined;
  const required = requirementText(requiredPart);
  const preferred = preferenceScope(requiredPart).governed.join(' ').trim();
  if (required === '' || preferred === '') return undefined;

  const preferredFields = fieldsIn(preferred, false);
  if (preferredFields.length === 0) return undefined;
  const requiredFields = fieldsIn(required, false);
  if (requiredFields.length === 0) {
    if (excludedFields.length > 0) return undefined;
    return [makeConstraint('field_of_study', preferred, fieldSpec(preferredFields, []), 0)];
  }
  return [
    makeConstraint('field_of_study', required, fieldSpec(requiredFields, excludedFields), 0),
    makeConstraint('field_of_study', preferred, fieldSpec(preferredFields, []), 1),
  ];
}

export function extractFieldOfStudy(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields['Field of Study'];
  if (!text || text.trim() === '') return [];
  const except = EXCEPT.exec(text);
  const excludedFields = except ? splitFields(except[1]) : [];
  const requiredPart = except ? text.slice(0, except.index) : text;

  const scoped = scopedConstraints(requiredPart, excludedFields);
  if (scoped !== undefined) return scoped;

  const fields = fieldsIn(requiredPart, true);
  // The alternative carries the SAME `excludedFields`. An exclusion is a requirement, never a
  // tier: "any field except Liberal Arts, or an undergraduate degree" still bars a liberal-arts
  // student, and an alternative that forgot the exclusion would be a route around it.
  const alternatives = unrestrictedAlternative(requiredPart, fields)
    ? [{ axis: 'field_of_study' as const, fields: [], excludedFields }]
    : [];
  return [
    makeConstraint(
      'field_of_study',
      text,
      {
        ...fieldSpec(fields, excludedFields),
        ...(alternatives.length > 0 ? { anyOf: alternatives } : {}),
      },
      0,
    ),
  ];
}
