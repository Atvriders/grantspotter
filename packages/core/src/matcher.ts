import { evaluateGeo } from './geo.js';
import type {
  ActivityKind,
  ApplicantEntity,
  Citizenship,
  Constraint,
  ConstraintSpec,
  ConstraintTier,
  DegreeLevel,
  LicenseClass,
  OrgProfile,
  Profile,
  Program,
  Stage,
  StudentProfile,
  Verdict,
} from './types.js';

export type AxisStatus = 'pass' | 'fail' | 'unknown' | 'not_evaluable';

export interface AxisResult {
  status: AxisStatus;
  /** Profile fields that would resolve an `unknown`. Empty otherwise. */
  missing: string[];
}

const PASS: AxisResult = { status: 'pass', missing: [] };
const FAIL: AxisResult = { status: 'fail', missing: [] };
const NOT_EVALUABLE: AxisResult = { status: 'not_evaluable', missing: [] };

function unknown(...fields: string[]): AxisResult {
  return { status: 'unknown', missing: fields };
}

const LICENSE_RANK: Record<LicenseClass, number> = { NONE: 0, TECH: 1, GENERAL: 2, EXTRA: 3 };

/** Whole calendar months from `fromISO` to `toISO`; negative if `toISO` is earlier. */
export function monthsBetween(fromISO: string, toISO: string): number {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

export function ageAt(birthISO: string, atISO: string): number {
  return Math.floor(monthsBetween(birthISO, atISO) / 12);
}

/**
 * `asOf` is either an MM-DD (resolved against the current year, e.g. YCCC's
 * "22 or younger as of June 1") or a full ISO date. Anything else falls back
 * to "now".
 */
function asOfDateISO(asOf: string | undefined, nowISO: string): string {
  if (asOf === undefined) return nowISO;
  if (/^\d{2}-\d{2}$/.test(asOf)) {
    const year = new Date(nowISO).getUTCFullYear();
    return `${year}-${asOf}T00:00:00.000Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(asOf)) return asOf;
  return nowISO;
}

function normText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ /g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// field_of_study matching
//
// The corpus does not hold tidy enum values. `Constraint.spec.fields` holds
// prose the extractor lifted verbatim off funder pages, e.g.
//   ["electronics", "communications", "related fields"]
//   ["Bachelor's degree", "higher in engineering", "sciences", "similar field"]
//   ["Electrical Engineering/Electronics"]     ["STEM (Science", "Technology", ...]
//   ["Bachelor's degree", "higher"]            ["None"]
// String equality against a student's "Electrical Engineering" matched none of
// those, so 63 of 112 candidates hard-excluded an EE undergraduate — including
// awards written specifically to fund EE students.
//
// DIRECTION OF ERROR governs every judgement call below. A false include shows
// someone an award they may not win; they open the funder's page (whose verbatim
// text this app always renders) and find out. A false exclude hides the money
// forever, silently. So: match generously, exclude strictly, and when the
// funder's own words widen the field ("or related field"), take the widening.
// ---------------------------------------------------------------------------

/**
 * Splits one recorded field value into the alternatives it actually contains.
 * The extractor already splits on `,` `/` `or` `and`, but not always (its
 * preference and list-intro branches, and every non-ARRL source, can emit a
 * whole clause), and re-splitting an already-split value is a no-op. Runs on the
 * raw string because `normText` erases the `/` and `,` separators first.
 */
function splitFieldAlternatives(value: string): string[] {
  return value
    .split(/[,;/|]|\band\/or\b|\bor\b|\band\b/gi)
    .map((part) => normText(part))
    .filter((part) => part !== '');
}

/**
 * Words that carry no field-of-study meaning: degree levels, institution types,
 * list scaffolding and the extractor's own leakage ("Bachelor's degree or higher
 * in electronics" splits into a "Bachelor's degree" alternative that names no
 * field at all). They are ignored both when deciding whether an alternative says
 * anything about a field AND when comparing two fields, so an award can never be
 * matched — or missed — on the strength of the word "degree".
 */
// NOTE for whoever extends this list: packages/core/test/purity.test.ts scans
// this file with a regex that reads `from'` + quote as an import specifier, so a
// literal 'from' entry here fails the purity suite. It is omitted deliberately.
const FIELD_NOISE_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'at', 'on', 'to', 'for', 'with', 'that', 'would', 'which',
  'toward', 'towards', 'into', 'as', 'be', 'is', 'are', 'was', 'must', 'may', 'can', 'will',
  'should', 'shall', 'not', 'no', 'none', 'nor', 'any', 'all', 'other', 'others', 'else',
  'applicant', 'applicants', 'student', 'students', 'candidate', 'candidates', 'enrolled',
  'pursuing', 'pursue', 'studying', 'seeking', 'majoring', 'leading', 'earned', 'earning',
  'degree', 'degrees', 'diploma', 'certificate', 'certification', 'certificates', 'program',
  'programs', 'programme', 'course', 'courses', 'curriculum', 'coursework', 'major', 'majors',
  'minor', 'minors', 'field', 'fields', 'study', 'studies', 'discipline', 'disciplines', 'area',
  'areas', 'subject', 'subjects', 'career', 'careers', 'concentration', 'emphasis', 'track',
  'bachelor', 'bachelors', 'baccalaureate', 'master', 'masters', 'associate', 'associates',
  'doctoral', 'doctorate', 'phd', 'bs', 'ba', 'bsc', 'ms', 'msc', 'mba', 'aa', 'as', 'aas',
  'undergraduate', 'undergrad', 'graduate', 'postgraduate', 'freshman', 'sophomore', 'junior',
  'senior', 'year', 'years', 'level', 'higher', 'above', 'beyond', 'lower', 'full', 'time',
  'accredited', 'accreditation', 'abet', 'college', 'colleges', 'university', 'universities',
  'school', 'schools', 'institution', 'institutions', 'trade', 'vocational', 'campus',
  'requirement', 'requirements', 'required', 'require', 'restriction', 'restrictions',
  'restricted', 'unrestricted', 'open', 'eligible', 'eligibility', 'qualified', 'qualifying',
  'given', 'award', 'awarded', 'scholarship', 'scholarships', 'regardless', 'declared',
  'undeclared', 'undecided', 'general', 'various', 'etc', 'gpa', 'cumulative', 'average',
  'grade', 'point', 'na', 'n', 'tbd', 'tba', 'unknown', 'unspecified', 'specified', 'this',
]);

/** "or a related field", "or similar field" — the funder's own widening. */
const RELATEDNESS_WORDS = new Set([
  'related', 'similar', 'allied', 'adjacent', 'comparable', 'equivalent', 'associated', 'akin',
  'analogous', 'relevant', 'applicable',
]);

/**
 * Abbreviations a student is likely to type, expanded into (not replaced by)
 * their long forms, so "EE" matches "Electrical Engineering" and "Electronics"
 * alike. Ambiguous ones (CE = computer OR civil engineering) expand to every
 * reading: over-including one extra award beats hiding the right one.
 */
const FIELD_ABBREVIATIONS: Record<string, string> = {
  ee: 'electrical engineering electronics',
  eee: 'electrical electronics engineering',
  ece: 'electrical computer engineering',
  eecs: 'electrical engineering computer science',
  cs: 'computer science',
  ce: 'computer engineering civil engineering',
  cpe: 'computer engineering',
  cse: 'computer science engineering',
  me: 'mechanical engineering',
  che: 'chemical engineering',
  ae: 'aerospace engineering',
  bme: 'biomedical engineering',
  it: 'information technology',
  cis: 'computer information systems',
  mis: 'management information systems',
  stem: 'science technology engineering mathematics',
  steam: 'science technology engineering arts mathematics',
  rf: 'radio frequency',
  comms: 'communications',
  tech: 'technology',
  math: 'mathematics',
  maths: 'mathematics',
  psych: 'psychology',
};

/**
 * Words that mean the same thing to a funder but share no spelling, so neither
 * the stem nor the shared-prefix rule below can pair them. Deliberately tiny:
 * "engineering" and "technology"/"technical" are used interchangeably across
 * this corpus ("Technical field of study that would support the radio art" is
 * an award for engineers), and "math"/"mathematics" is pure abbreviation.
 */
const FIELD_SYNONYM_GROUPS: string[][] = [
  ['engineering', 'engineer', 'engineered', 'technology', 'technologie', 'technical', 'tech'],
  ['math', 'mathematic'],
  // Domain-specific and deliberate: on a ham-radio funding desk, an award whose
  // stated field is "Communications" (the Goldwater scholarship) is an award for
  // radio engineers, and excluding an EE student from it is the exact failure
  // this file exists to stop. The cost is the mirror case — a mass-communications
  // student is shown an electronics award — which is the recoverable direction.
  ['communication', 'telecommunication', 'radio', 'wireless', 'electrical', 'electronic'],
];

const FIELD_SYNONYM_KEY = new Map<string, number>();
FIELD_SYNONYM_GROUPS.forEach((group, index) => {
  for (const word of group) FIELD_SYNONYM_KEY.set(word, index);
});

/** Crude, deliberate: only a trailing plural "s". Both sides get the same treatment. */
function stemWord(word: string): string {
  return word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
}

interface FieldPhrase {
  /** Normalized text with abbreviations expanded — used for containment. */
  text: string;
  /** Stemmed content words, noise removed — used for overlap. */
  words: string[];
}

function analyzeFieldPhrase(value: string): FieldPhrase {
  const expanded: string[] = [];
  for (const word of normText(value).split(' ')) {
    if (word === '') continue;
    expanded.push(word);
    const expansion = FIELD_ABBREVIATIONS[word];
    if (expansion !== undefined) expanded.push(...expansion.split(' '));
  }
  const words: string[] = [];
  for (const word of expanded) {
    if (FIELD_NOISE_WORDS.has(word) || RELATEDNESS_WORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    // A one-letter token is punctuation debris, never a field: normText turns
    // "Bachelor's degree" into "bachelor s degree", and a stray "s" counted as
    // content is what made a pure degree-level value look like a real field
    // requirement and exclude everyone.
    if (word.length < 2) continue;
    const stem = stemWord(word);
    if (!words.includes(stem)) words.push(stem);
  }
  return { text: expanded.join(' '), words };
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Two content words mean the same field if they are the same word, share a
 * synonym group, or share a 5-character prefix while both are at least 5 long —
 * which is what pairs "electrical"/"electronics" (electr-), "computer"/
 * "computing" (comput-) and "science"/"scientific" (scien-). Short words are
 * excluded from the prefix rule because "media"/"medicine" would otherwise pair.
 */
function fieldWordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const keyA = FIELD_SYNONYM_KEY.get(a);
  if (keyA !== undefined && keyA === FIELD_SYNONYM_KEY.get(b)) return true;
  if (a.length < 5 || b.length < 5) return false;
  return commonPrefixLength(a, b) >= 5;
}

/** Whole-phrase containment on word boundaries: "electrical engineering" contains "engineering". */
function phraseContains(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Generous: the applicant's field need only share one content word with the funder's. */
function fieldPhrasesOverlap(mine: FieldPhrase, theirs: FieldPhrase): boolean {
  if (mine.text === theirs.text) return true;
  if (phraseContains(mine.text, theirs.text) || phraseContains(theirs.text, mine.text)) return true;
  return mine.words.some((a) => theirs.words.some((b) => fieldWordsMatch(a, b)));
}

/**
 * Strict, and deliberately NOT the same test as inclusion: an exclusion is the
 * one direction where being wrong hides money, so it requires the applicant's
 * field to actually BE the excluded one ("liberal arts" vs "Liberal Arts",
 * "sports medicine" vs "medicine"), never a single shared word.
 */
function fieldPhraseExcluded(mine: FieldPhrase, excluded: FieldPhrase): boolean {
  if (excluded.words.length === 0 || mine.words.length === 0) return false;
  if (mine.text === excluded.text) return true;
  if (phraseContains(mine.text, excluded.text) || phraseContains(excluded.text, mine.text)) {
    return true;
  }
  return (
    mine.words.length === excluded.words.length &&
    excluded.words.every((word) => mine.words.some((theirs) => fieldWordsMatch(word, theirs)))
  );
}

/** "Any", "All", "Any field", "None" — an explicit no-restriction marker. */
function isAnyFieldMarker(value: string): boolean {
  const analyzed = analyzeFieldPhrase(value);
  return analyzed.words.length === 0 && /\b(any|all|every|none|no)\b/.test(analyzed.text);
}

/**
 * Words that describe a KIND of field rather than a field: "or a related
 * technical field" widens as completely as "or a related field" does. Kept
 * separate from the noise list because "Technical field" standing alone, with no
 * relatedness word, IS a requirement — one that an engineer meets and a music
 * major does not (Wayne Nelson, KB4UT, Memorial Scholarship).
 */
const WIDENING_DESCRIPTOR_WORDS = new Set([
  'technical', 'technological', 'professional', 'academic', 'accredited',
]);

/**
 * "or related field", "or a related technical field", "or similar field" — a
 * relatedness word in a phrase that names no field of its own. "Technology-
 * related field" and "a Health Care-related field" are NOT widenings: they still
 * name a field, and are matched normally.
 */
function isFieldWideningMarker(value: string): boolean {
  const hasRelatedness = normText(value)
    .split(' ')
    .some((word) => RELATEDNESS_WORDS.has(word));
  if (!hasRelatedness) return false;
  return analyzeFieldPhrase(value).words.every((word) => WIDENING_DESCRIPTOR_WORDS.has(word));
}

// ---------------------------------------------------------------------------
// OPEN LISTS — the funder who says their own list is not exhaustive
//
// SCOPE, and why this block sits above every axis rather than inside one.
// `spec.fields`, `spec.activityKinds` and `spec.stages` are ENUMERATED ALLOW-
// LISTS: the matcher passes an applicant who is on the list and refuses one who
// is not, so a list the funder never meant as complete is a bar the funder never
// wrote. This rule reads the qualifier the funder put ON the list, and it is now
// asked by every axis whose spec is such a list and whose corpus contains one —
// `field_of_study`, which had it, and `ham_activity`, which is where the ninth
// instance was already sitting.
//
// ONE SIGNAL, TWO ANSWERS, AND THE DIFFERENCE IS THE EVIDENCE EACH AXIS HOLDS.
// `funderOpenedTheList` answers exactly one question — "did the funder say this
// list is illustrative?" — and it is never on its own an answer about the
// APPLICANT. What each axis does with it differs, and deliberately:
//   - `field_of_study` reads it as a `pass`, because the applicant HAS named a
//     field and an opened list plus a named field is a judgement of ADJACENCY
//     ("is Physical Therapy one of the healing arts?") that the funder invited
//     and the applicant can make for themselves off the verbatim sentence.
//   - `ham_activity` reads it as `unknown`, because it does not: the seven
//     `ActivityKind` values are a checklist, an applicant on none of them has
//     said "none of these", and turning that into "yes, you qualify" asserts
//     participation nobody recorded. See the case block for the measurement.
// Both keep the withdrawal of the false excludes; neither is licence for the
// next axis to pick whichever answer is more convenient.
//
//   ARDC   "…proof of amateur radio activity… EXAMPLES: membership in a local or
//           regional club, participation in amateur radio emergency activities,
//           teaching amateur radio classes, on-the-air activities, participation
//           in college radio clubs, AND ANY SIMILAR ACTIVITIES…"
//   CARA   "Must demonstrate use of amateur radio through public service,
//           community events, ARES, RACES or SKYWARN, GOTA, Field Day, ETC."
//   CWops  "(EXAMPLES INCLUDE BUT ARE NOT LIMITED TO: ARRL Code Proficiency
//           certificate…; membership in CWops or HSC or other club…; …)"
//
// AND THE AXES DELIBERATELY LEFT OUT, each measured over the committed fixtures
// rather than guessed:
//   - `institution.degreeLevels`. SEVEN records carry a marker here and in every
//     one of them the marker is about the FIELD, not the level: the institution
//     axis reads "Bachelor's degree or higher in electronics, communications, or
//     RELATED FIELDS" for its `degreeLevels: [BACH, GRAD]`, and widening a degree
//     floor out of a sentence about subjects would be reading the wrong clause.
//   - `geography` and `age_stage`. ZERO of their rawTexts carry a marker, so
//     wiring them would be untested speculation. Their real defects were tiers
//     and an unrepresentable audience — different causes, different remedies.
//   - `ham_activity.cwProficiencyWpmMin`. A NUMBER is not a list. CWops's
//     "at 15 wpm or higher" sits inside its open list of examples and arguably
//     opens too; that is a separate judgement, unmeasured here, and the widening
//     below touches `activityKinds` only.
//
// `RELATEDNESS_WORDS` above handles exactly one idiom, "or a related field",
// and handles it by reading `spec.fields` — because that idiom survives
// extraction as a field alternative of its own ("related fields"). It is not
// the only way a funder opens a list, and the other ways leave no trace in
// `fields[]` at all: they are QUALIFIERS ON the list, not members of it.
//
//   MARCO   "Field of study must be leading to a career in the healing arts,
//            INCLUDING, BUT NOT NECESSARILY leading to Medicine, Dentistry,
//            Veterinary Medicine, Nursing, Pharmacy, EMT, or Radiology technician."
//   York    "…leading to a career in the healing arts, INCLUDING BUT NOT LIMITED
//            TO a career in Medicine, Nursing, Dentistry, Pharmacy, EMT, or Radiology"
//
// The extractor is right to lift only the eight and seven field names it can
// see; synthesising a phantom "or a related field" alternative so this file
// would notice would fabricate wording neither funder wrote, which is the same
// defect class as the 26 invented field values a sibling fix removed. So the
// signal is read where the funder actually put it: `Constraint.rawText`, the
// verbatim sentence, threaded into this axis by `matchProgram`. That keeps the
// widening attached to its own evidence, and needs no change to `ConstraintSpec`
// (CONTRACT §3 freezes it).
//
// Measured blast radius: of the 65 distinct `field_of_study` constraints the
// committed fixtures produce, exactly three carry an open-list marker — MARCO,
// York, and Kupferschmid ("Applied sciences, technology, engineering, and
// mathematics, including but not limited to astronomy, …"). All three said it
// themselves. Every other list in the corpus stays closed, and an
// engineering-only award still excludes a music major.
//
// DIRECTION OF ERROR, as everywhere in this file — but note this rule is not a
// general loosening. It fires only on the funder's own words, and it never
// touches `excludedFields`: an award that says "any field except Liberal Arts"
// still bars a liberal-arts student, whatever else its sentence says.
// ---------------------------------------------------------------------------

/**
 * Nouns a widening idiom lands on: "or a related FIELD", "and related
 * DISCIPLINES", "and any similar ACTIVITIES". Written out rather than reusing
 * `FIELD_NOISE_WORDS` because that set is about scoring a phrase, and this is
 * about recognising a shape.
 *
 * `activit(y|ies)` is the one word this list gained when the rule stopped being
 * the field axis's private property, and it is the whole of ARDC's widening:
 * "…participation in college radio clubs, AND ANY SIMILAR ACTIVITIES which
 * illustrate his/her interest and participation with the amateur radio
 * avocation." No field_of_study rawText in the corpus contains it, so field
 * behaviour is byte-for-byte unchanged by its presence.
 */
const OPEN_LIST_NOUN_PATTERN =
  'fields?|disciplines?|areas?|subjects?|majors?|minors?|studies|study|programs?|courses?|careers?' +
  '|activit(?:y|ies)';

const RELATEDNESS_PATTERN = [...RELATEDNESS_WORDS].join('|');
const WIDENING_DESCRIPTOR_PATTERN = [...WIDENING_DESCRIPTOR_WORDS].join('|');

/**
 * The phrasings volunteers actually write, run against `normText`ed rawText so
 * that punctuation cannot hide any of them: "including, but not necessarily"
 * and "including but not limited to" flatten to the same token sequence, and
 * "e.g." flattens to "e g".
 *
 * Two rules earn their narrowness:
 *
 *   - Bare "including" is NOT here. Only "including but not …" is. "Engineering
 *     degrees, including electrical and computer" reads as a list with examples
 *     of itself, not as an invitation to a music major, and treating every
 *     "including" as an opening is exactly the blanket permissiveness this axis
 *     must not become.
 *   - The relatedness pattern deliberately mirrors `isFieldWideningMarker`: the
 *     relatedness word may be followed only by a WIDENING_DESCRIPTOR word before
 *     the noun. So "or related fields" and "or a related technical field" open
 *     the list, while "or SIMILAR SCIENTIFIC field" (Chuck Bierman, K7ZJ) does
 *     not — "scientific" names a real bound, and a music major must not be
 *     admitted to an award for scientific fields.
 *
 *     THAT IS STILL RIGHT, AND IT USED TO SAY SOMETHING ELSE AS WELL: "…and the
 *     corpus record that carries that phrasing must keep behaving exactly as it
 *     does today." What it did that day was hard-REFUSE Physics, Chemistry,
 *     Biology and Astronomy (The Chick Allen, NW3Y, Scholarship — 16 of 20
 *     probed majors), with "or similar scientific field" on the screen above the
 *     word "no". Not being a widening is not the same as being a bar: the third
 *     answer is `unknown`, and round six gave the extractor a way to say it
 *     (`ConstraintSpec.orUnrepresented`, minted in `fieldOfStudy.ts` by
 *     `namesADomain`, which now reads `similar` as scaffolding and `scientific`
 *     as a domain). So this rule still refuses to turn that phrase into a pass,
 *     and the phrase no longer turns into a refusal either.
 *
 * "and other" is likewise absent, and only the plural "and/or/among others" is
 * matched, so "Engineering or other 4-year technical degree" stays a technical
 * requirement rather than becoming an open list.
 */
const OPEN_LIST_MARKERS: RegExp[] = [
  /\bnot (?:necessarily |strictly |solely |exclusively )?(?:limited|restricted|confined) to\b/,
  /\bincluding but not\b/,
  /\bnot (?:an? )?exhaustive\b/,
  /\bwithout limitation\b/,
  /\bsuch as\b/,
  /\bfor example\b/,
  /\bfor instance\b/,
  /\be g\b/,
  /\b(?:among|and|or) others\b/,
  /\betc\b/,
  /\band the like\b/,
  /\band more\b/,
  new RegExp(
    `\\b(?:or|and) (?:any |a |an |other |closely |otherwise )*(?:${RELATEDNESS_PATTERN})` +
      ` (?:(?:${WIDENING_DESCRIPTOR_PATTERN}) )*(?:${OPEN_LIST_NOUN_PATTERN})\\b`,
  ),
];

/**
 * Where the eligible list stops and the barred list starts. Anything after it
 * describes what is EXCLUDED, and examples of an exclusion ("except health
 * sciences, such as nursing") must never be read as an invitation. Exclusion is
 * the strict direction; only the text in front of this boundary can open a list.
 */
const EXCLUSION_INTRO =
  /\b(?:except|excepting|excluding|exclusive of|other than|apart |aside |besides|not eligible|ineligible|does not include|do not include|with the exception)\b/;

/**
 * True when the funder's own sentence says the list it just gave is illustrative
 * rather than complete — asked by every allow-list axis, not just fields. See
 * the SCOPE note at the head of this block for which axes ask it and which
 * deliberately do not.
 *
 * `rawText` is the sentence the funder wrote and GrantSpotter displays, threaded
 * in by `matchProgram`. Reading the widening from there rather than synthesising
 * a phantom list member keeps it attached to its own evidence.
 */
function funderOpenedTheList(rawText: string): boolean {
  const text = normText(rawText);
  if (text === '') return false;
  const boundary = EXCLUSION_INTRO.exec(text);
  const eligibleHalf = boundary === null ? text : text.slice(0, boundary.index);
  return OPEN_LIST_MARKERS.some((marker) => marker.test(eligibleHalf));
}

interface FieldRequirement {
  /** Alternatives that actually name a field. */
  informative: FieldPhrase[];
  /** The funder said "any"/"all"/"none", or every alternative was pure noise. */
  unrestricted: boolean;
  /**
   * The funder widened their own list — either with the "or related field"
   * idiom that survives into `fields[]`, or by qualifying the whole list as
   * non-exhaustive in `rawText`. Adjacency is not ours to adjudicate, so we
   * include and let the applicant read the funder's verbatim wording.
   */
  widened: boolean;
  excluded: FieldPhrase[];
}

function readFieldRequirement(
  fields: string[],
  excludedFields: string[],
  rawText: string,
): FieldRequirement {
  const informative: FieldPhrase[] = [];
  let unrestricted = false;
  let widened = funderOpenedTheList(rawText);
  for (const alternative of fields.flatMap(splitFieldAlternatives)) {
    if (isAnyFieldMarker(alternative)) {
      unrestricted = true;
      continue;
    }
    if (isFieldWideningMarker(alternative)) {
      widened = true;
      continue;
    }
    // Pure noise — "Bachelor's degree", "higher", "4-year program", "None" —
    // names no field, so it is not a field requirement and must never be allowed
    // to exclude the entire user base. (Two records in today's corpus record
    // fields:["None"]; that is an upstream extractor bug, not a real bar, and it
    // is left for the extractor to fix. This only stops it hiding every award.)
    const phrase = analyzeFieldPhrase(alternative);
    if (phrase.words.length > 0) informative.push(phrase);
  }
  const excluded = excludedFields
    .flatMap(splitFieldAlternatives)
    .map(analyzeFieldPhrase)
    .filter((phrase) => phrase.words.length > 0);
  if (informative.length === 0 && !widened) unrestricted = true;
  return { informative, unrestricted, widened, excluded };
}

// ---------------------------------------------------------------------------
// stage matching
//
// `Stage` is not a partition, and treating it as one produces false excludes.
// It mixes two kinds of fact:
//
//   LEVEL   HS_SENIOR, UNDERGRAD, GRAD — where in education the applicant is.
//   STATUS  VETERAN, RETRAINING_ADULT  — who the applicant is WHILE enrolled at
//           one of those levels. Neither says anything about the level itself:
//           a veteran may be an undergraduate or a graduate student, and a
//           returning adult is, by definition, enrolled in something.
//
// `StudentProfile` has room for exactly one `stage`, so an applicant who is
// both has to give up the level in order to state the status — and a plain
// `stages.includes(profile.stage)` then reads "RETRAINING_ADULT" as "not an
// undergraduate". Reported case: The Frankford Radio Club (FRC) Scholarship,
// whose clause hardens correctly to [HS_SENIOR, UNDERGRAD, VETERAN] straight
// from the funder's "open to graduating high school seniors, undergraduate
// students and US miltary veterans" — and which hard-excluded a 41-year-old
// studying part-time for an AAS. Eleven awards in the committed corpus excluded
// that applicant on this axis; six of them were awards for undergraduates.
//
// The fix belongs here rather than in the extractors: writing RETRAINING_ADULT
// into records alongside UNDERGRAD would put a stage in the record that the
// funder never wrote. What the funder wrote is right; the comparison was wrong.
//
// DIRECTION OF ERROR, as everywhere else in this file. A false include shows
// someone an award they may not win and they read the funder's page; a false
// exclude hides it silently and forever. Adult learners returning to school are
// a core constituency of this corpus — one award in it (Marte Wessel K0EPE)
// exists specifically for part-time students working full-time.
// ---------------------------------------------------------------------------

/**
 * Stages that describe a status rather than an academic level. These are the only
 * ones that subsume anything: they take on whatever level the applicant is
 * actually enrolled at. Adding a stage to `Stage` that names a status (a
 * "PARENT" or "CAREER_CHANGER") means adding it here too.
 */
const STATUS_STAGES: ReadonlySet<Stage> = new Set<Stage>(['VETERAN', 'RETRAINING_ADULT']);

/**
 * The academic level each `degreeLevel` puts an applicant at. `CERT` and `ASSOC`
 * are undergraduate study: the community-college certificate and the two-year
 * associate degree are exactly the routes a returning adult takes, and reading
 * them as anything else would re-create the defect for the people it hurt most.
 */
const LEVEL_STAGE_FOR_DEGREE: Record<DegreeLevel, Stage> = {
  CERT: 'UNDERGRAD',
  ASSOC: 'UNDERGRAD',
  BACH: 'UNDERGRAD',
  GRAD: 'GRAD',
};

/**
 * Every stage an applicant genuinely satisfies, given the one stage they stated
 * and the degree level they are enrolled at.
 *
 * Subsumption runs in ONE direction only. A status stage implies a level; a
 * level never implies a status, because nothing in the profile says an
 * undergraduate served in the military or is returning to school, and claiming
 * a veterans' award on their behalf is not "generous", it is wrong.
 *
 * `HS_SENIOR` is deliberately NOT promoted to `UNDERGRAD`: "undergraduate
 * students" reads as currently enrolled, a graduating senior is an incoming one,
 * and the corpus writes awards for each separately — 11 individual-facing awards
 * name HS_SENIOR alone. Nor does `GRAD` imply `UNDERGRAD`.
 *
 * When a status stage carries no `degreeLevel`, the applicant is enrolled
 * somewhere and has just not said where, so both levels are allowed rather than
 * neither. That is the recoverable direction; `HS_SENIOR` is still not among
 * them, because an adult returner is not a graduating high-school senior.
 */
export function stagesSatisfiedBy(stage: Stage, degreeLevel: DegreeLevel | undefined): Stage[] {
  if (!STATUS_STAGES.has(stage)) return [stage];
  if (degreeLevel === undefined) return [stage, 'UNDERGRAD', 'GRAD'];
  return [stage, LEVEL_STAGE_FOR_DEGREE[degreeLevel]];
}

function isStudent(profile: Profile): profile is StudentProfile {
  return profile.kind === 'student';
}

function isOrg(profile: Profile): profile is OrgProfile {
  return profile.kind === 'organization';
}

/**
 * ONE TIER, evaluated on its own. `evaluateConstraint` below composes tiers; this
 * is where an axis's actual question is asked.
 *
 * `rawText` is the funder's own sentence — `Constraint.rawText`, which CONTRACT §3
 * guarantees is ALWAYS populated — and it is read by every axis whose spec is an
 * enumerated allow-list the funder may have qualified in prose. `matchProgram`
 * always supplies it; a tier inside `anyOf` is handed the SAME sentence, because
 * both tiers came out of it and the funder's widening governs the whole of it.
 */
function evaluateTier(
  spec: ConstraintTier,
  profile: Profile,
  nowISO: string,
  rawText: string,
): AxisResult {
  switch (spec.axis) {
    case 'license': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const needed = LICENSE_RANK[spec.licenseMin];
      if (needed > 0) {
        if (profile.licenseClass === undefined) return unknown('licenseClass');
        if (LICENSE_RANK[profile.licenseClass] < needed) return FAIL;
      }
      if (spec.heldMonthsMin !== undefined && spec.heldMonthsMin > 0) {
        if (profile.licensedSince === undefined) return unknown('licensedSince');
        if (monthsBetween(profile.licensedSince, nowISO) < spec.heldMonthsMin) return FAIL;
      }
      // foreignLicenseOK is informational: CONTRACT §3 has no profile field for it.
      return PASS;
    }

    case 'geography': {
      const decision = evaluateGeo(spec.geo, {
        state: profile.state,
        county: isStudent(profile) ? profile.county : undefined,
        lat: profile.lat,
        lon: profile.lon,
        callDistrict: isStudent(profile) ? profile.callDistrict : undefined,
        callsign: profile.callsign,
      });
      return { status: decision.status, missing: decision.missing };
    }

    case 'field_of_study': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const required = readFieldRequirement(spec.fields, spec.excludedFields, rawText);
      // Nothing here can decide anything: no field list worth the name and no
      // exclusion. Answering "what do you study?" could not change the outcome,
      // so do not make the applicant answer it — a wasted `unknown` reads to the
      // user exactly like a locked door.
      const decidable = required.excluded.length > 0 || (!required.unrestricted && !required.widened);
      const mine =
        profile.fieldOfStudy === undefined ? undefined : analyzeFieldPhrase(profile.fieldOfStudy);
      // A profile field that survives normalization as nothing ("-", "undeclared")
      // is not an answer; treat it like no answer at all rather than as a field
      // that matches nothing.
      if (mine === undefined || mine.words.length === 0) {
        return decidable ? unknown('fieldOfStudy') : PASS;
      }
      if (required.excluded.some((phrase) => fieldPhraseExcluded(mine, phrase))) return FAIL;
      if (required.unrestricted) return PASS;
      if (required.informative.some((phrase) => fieldPhrasesOverlap(mine, phrase))) return PASS;
      // The funder widened the list themselves — "or a related field" among the
      // alternatives, or "including but not limited to" / "such as" qualifying
      // the whole list in their own sentence. Neither relatedness nor "what else
      // did they have in mind" is something this matcher can adjudicate, so
      // include, and let the applicant read the funder's own wording
      // (Constraint.rawText, which Plan 3 renders) to judge the fit.
      if (required.widened) return PASS;
      return FAIL;
    }

    case 'institution': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      if (spec.degreeLevels.length > 0) {
        if (profile.degreeLevel === undefined) return unknown('degreeLevel');
        const levels: DegreeLevel[] = spec.degreeLevels;
        if (!levels.includes(profile.degreeLevel)) return FAIL;
      }
      if (spec.accreditationRequired) {
        if (profile.accredited === undefined) return unknown('accredited');
        if (!profile.accredited) return FAIL;
      }
      if (!spec.partTimeOK) {
        if (profile.partTime === undefined) return unknown('partTime');
        if (profile.partTime) return FAIL;
      }
      // tradeSchoolOK is informational: CONTRACT §3 has no profile field for it.
      return PASS;
    }

    case 'gpa': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const results: AxisStatus[] = [];
      const missing: string[] = [];
      if (spec.min !== undefined) {
        if (profile.gpa === undefined) {
          results.push('unknown');
          missing.push('gpa');
        } else {
          results.push(profile.gpa >= spec.min ? 'pass' : 'fail');
        }
      }
      if (spec.classRankTopPct !== undefined) {
        if (profile.classRankTopPct === undefined) {
          results.push('unknown');
          missing.push('classRankTopPct');
        } else {
          results.push(profile.classRankTopPct <= spec.classRankTopPct ? 'pass' : 'fail');
        }
      }
      if (results.length === 0) return PASS;
      if (results.includes('pass')) return PASS; // either route satisfies the axis
      if (results.includes('unknown')) return { status: 'unknown', missing };
      return FAIL;
    }

    case 'arrl_membership': {
      if (!spec.required) return NOT_EVALUABLE;
      if (isOrg(profile)) {
        if (profile.arrlAffiliated === undefined) return unknown('arrlAffiliated');
        return profile.arrlAffiliated ? PASS : FAIL;
      }
      if (profile.arrlMemberSince === undefined) return unknown('arrlMemberSince');
      if (spec.minYears > 0 && monthsBetween(profile.arrlMemberSince, nowISO) < spec.minYears * 12) {
        return FAIL;
      }
      return PASS;
    }

    case 'recommendation':
      // No profile field can answer this. Plan 3 renders Constraint.rawText.
      return NOT_EVALUABLE;

    case 'citizenship': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const allowed: Citizenship[] = spec.allowed;
      if (allowed.includes('ANY')) return PASS;
      if (profile.citizenship === undefined) return unknown('citizenship');
      if (allowed.includes(profile.citizenship)) return PASS;
      if (profile.citizenship === 'US_CITIZEN' && allowed.includes('US_RESIDENT')) return PASS;
      // withinMonthsOfCitizenship is informational: no profile field exists.
      return FAIL;
    }

    case 'age_stage': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const missing: string[] = [];
      let failed = false;
      const stages: Stage[] = spec.stages;
      if (stages.length > 0) {
        if (profile.stage === undefined) missing.push('stage');
        else {
          // Set membership over every stage the applicant genuinely satisfies, not just the one
          // their profile had room to state. See stagesSatisfiedBy above.
          const mine = stagesSatisfiedBy(profile.stage, profile.degreeLevel);
          if (!mine.some((stage) => stages.includes(stage))) failed = true;
        }
      }
      if (spec.ageMin !== undefined || spec.ageMax !== undefined) {
        if (profile.birthDate === undefined) {
          missing.push('birthDate');
        } else {
          const age = ageAt(profile.birthDate, asOfDateISO(spec.asOf, nowISO));
          if (spec.ageMin !== undefined && age < spec.ageMin) failed = true;
          if (spec.ageMax !== undefined && age > spec.ageMax) failed = true;
        }
      }
      if (failed) return FAIL;
      if (missing.length > 0) return { status: 'unknown', missing };
      return PASS;
    }

    case 'ham_activity': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const missing: string[] = [];
      let failed = false;
      const mine = profile.activityKinds;
      const wanted: ActivityKind[] = spec.activityKinds;
      // AN OPENED LIST IS AN OPENED QUESTION, NOT A YES.
      //
      // `activityKinds` is an allow-list, so a list the funder gave as EXAMPLES
      // is a bar the funder never wrote: ARDC's "Examples: … and any similar
      // activities", CARA's "…GOTA, Field Day, etc.", CWops's "Examples include
      // but are not limited to: …". Which of the seven `ActivityKind`s counts as
      // "similar" is not something this matcher can adjudicate, and adjudicating
      // it wrongly is what refused a contester, a Field Day operator and an
      // ARES/RACES/SKYWARN volunteer from the largest programme in the corpus —
      // whose sentence names emergency activity in so many words. So an opened
      // list does not FAIL anyone.
      //
      // It does not PASS anyone either, and the round that made it do so is the
      // reason this comment is longer than the rule. Reading the widening as a
      // pass turned a hard requirement into a positive verdict for an applicant
      // who satisfies nothing on the list — including one whose `activityKinds`
      // is `[]`, i.e. who answered the question with "none". Measured over the
      // committed corpus, hard `ham_activity` facing such an applicant could not
      // refuse anybody AND asserted eligibility for everybody: CARA, ARDC and
      // CWops each moved from `ineligible` (or from a fillable `unknown`) to a
      // positive verdict. The two errors are not symmetric, but they are both
      // errors: a false exclude hides the money forever and silently, while a
      // false include spends an application on a promise the funder never made.
      // `unknown` costs the applicant neither — the door stays open and nothing
      // is claimed on their behalf — and it is what CWops's own spec already
      // said through `orUnrepresented`, quoting this very sentence, on a branch
      // `evaluateTier` used to reach `pass` before `evaluateConstraint` could
      // ever consult it. Two mechanisms, one sentence, one answer now.
      //
      // AND THE QUESTION IS STILL ASKED. An applicant who has not filled in
      // `activityKinds` gets `unknown` NAMING that field, exactly as a closed
      // list does, because their answer can still resolve this: naming a kind
      // the funder listed is a `pass` on the funder's own words. Only once they
      // have answered, and are on none of the listed kinds, does the `unknown`
      // become one with nothing to fill in — which is the honest pair of claims
      // (this could not be worked out; no input of yours would change that).
      let openedListUndecided = false;
      if (wanted.length > 0) {
        if (mine === undefined) missing.push('activityKinds');
        else if (!wanted.some((k) => mine.includes(k))) {
          if (funderOpenedTheList(rawText)) openedListUndecided = true;
          else failed = true;
        }
      }
      if (spec.cwProficiencyWpmMin !== undefined) {
        if (profile.cwWpm === undefined) missing.push('cwWpm');
        else if (profile.cwWpm < spec.cwProficiencyWpmMin) failed = true;
      }
      if (failed) return FAIL;
      if (missing.length > 0) return { status: 'unknown', missing };
      // Unresolved with nothing listable — see `unlistableUnknown` in `matchProgram`.
      if (openedListUndecided) return unknown();
      // proofRequired is informational.
      return PASS;
    }

    case 'financial_need': {
      // Spec §4.5 rule 11: always a weighting, never a bar. This axis can
      // never return `fail`, whatever `Constraint.hard` says.
      if (!isStudent(profile)) return NOT_EVALUABLE;
      return profile.financialNeed === true ? PASS : NOT_EVALUABLE;
    }

    case 'gender': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      if (spec.allowed.includes('any')) return PASS;
      if (
        profile.gender === undefined ||
        profile.gender === 'other' ||
        profile.gender === 'prefer_not_to_say'
      ) {
        // Refuse to guess. The UI shows the funder's own wording instead.
        return unknown('gender');
      }
      return spec.allowed.includes(profile.gender) ? PASS : FAIL;
    }

    case 'other':
      // Long-tail requirements no schema captures. Plan 3 renders rawText.
      return NOT_EVALUABLE;
  }
}

/**
 * THE WHOLE CONSTRAINT: the tier the funder named first, OR any other tier they
 * named, OR — if all of those fail — an admission that they named a route this
 * schema cannot check.
 *
 * `rawText` stays optional and additive so every existing three-argument call
 * still compiles and still means what it did. `matchProgram` always supplies it.
 *
 * THE COMPOSITION, and why each line is the direction it is:
 *
 *   pass anywhere        -> `pass`. A disjunction needs one route, and the
 *                          alternatives are the funder's own words for the
 *                          others. This is the line that stops eight measured
 *                          refusals, and the only line that can.
 *   unknown anywhere     -> `unknown`, listing every field that could resolve
 *                          ANY tier. A route the applicant might be on, that a
 *                          missing field is hiding, is not a refusal — and the
 *                          fields are unioned rather than taken from the base
 *                          tier alone, or the editor would send the reader to
 *                          fill in a field that answers a question they have
 *                          already failed.
 *   all fail, but the
 *   funder named a route
 *   we cannot check      -> `unknown` with NOTHING to fill in. See
 *                          `ConstraintAlternatives.orUnrepresented`.
 *   otherwise            -> `fail`, exactly as before.
 *
 * `not_evaluable` short-circuits on the base tier: an axis that cannot be
 * evaluated for this profile kind (a `field_of_study` tier against an
 * organisation) cannot be evaluated by its siblings either, since they are the
 * same axis. Returning it unchanged keeps "there is no schema field that could
 * ever resolve this" distinct from "this applicant does not qualify", which is a
 * distinction `matchProgram` depends on.
 *
 * A spec with no alternatives evaluates to precisely `evaluateTier`, so every
 * constraint in the corpus that states one thing behaves exactly as it did.
 */
export function evaluateConstraint(
  spec: ConstraintSpec,
  profile: Profile,
  nowISO: string,
  rawText = '',
): AxisResult {
  const base = evaluateTier(spec, profile, nowISO, rawText);
  if (base.status === 'pass' || base.status === 'not_evaluable') return base;
  const alternatives = spec.anyOf ?? [];
  if (alternatives.length === 0 && spec.orUnrepresented === undefined) return base;

  const results: AxisResult[] = [base];
  for (const tier of alternatives) results.push(evaluateTier(tier, profile, nowISO, rawText));

  if (results.some((r) => r.status === 'pass')) return PASS;
  const missing = [...new Set(results.flatMap((r) => (r.status === 'unknown' ? r.missing : [])))];
  if (results.some((r) => r.status === 'unknown')) return { status: 'unknown', missing };
  // Every route this schema can describe is closed. If the funder named one it
  // cannot, the honest answer is that we do not know — never `ineligible`.
  if (spec.orUnrepresented !== undefined) return unknown();
  return FAIL;
}

export const APPLICANT_ENTITY_CONSTRAINT_SUFFIX = ':applicant-entity';

/**
 * `evaluateGeo`'s `county` and `call_district` axes report their missing
 * field as `'county'` / `'callDistrict'` regardless of profile kind, but
 * neither name is a field on `OrgProfile` (only `StudentProfile` has them —
 * `matcher.ts`'s `geography` case even forces both to `undefined` for
 * non-student profiles). For an organisation, that `unknown` is therefore
 * permanently unresolvable: the UI could never find a matching input to
 * jump to. Known carry-forward finding from Task 8 — handled here by
 * treating those two field names as UNLISTABLE (dropped from
 * `missingProfileFields`) whenever the profile is an organisation, rather
 * than letting them surface as an actionable-looking missing field.
 *
 * UNLISTABLE IS NOT ANSWERED — close-out review I6. Dropping the field used
 * to drop the whole `unknown` with it: `missingFields` stayed empty and
 * `matchProgram` fell through to `eligible`, so an organisation was told it
 * satisfies a geography constraint that was never evaluated. The verdict now
 * stays `unknown` with an EMPTY `missingProfileFields`, which is the honest
 * pair of claims: something could not be worked out, and there is no input
 * you could fill in to change that. `VerdictBadge` already renders exactly
 * that case ("Not an answer yet. Something this program asks for could not be
 * evaluated from your profile. It is not a 'no'.").
 *
 * The direction matters and is preserved: `unknown` still never becomes
 * `ineligible`, so an unset field can never hide an award. But `unknown` is a
 * real state in this product, and letting it become a verdict is the same
 * over-assertion as a phantom obligation, merely pointed at the optimistic
 * side.
 */
const ORG_UNRESOLVABLE_GEO_FIELDS = new Set(['county', 'callDistrict']);

function isResolvableMissingField(profile: Profile, field: string): boolean {
  if (isOrg(profile) && ORG_UNRESOLVABLE_GEO_FIELDS.has(field)) return false;
  return true;
}

/**
 * True when this constraint carries a sentence the FUNDER wrote.
 *
 * `Constraint.rawText` is the whole basis of the product's trust claim: `IneligibilityDrawer`
 * shows it verbatim in a monospaced quote block, and the printed eligibility report heads a column
 * with the funder's words. Both of those promises are only keepable for constraints that came out
 * of a funder's page. A constraint GrantSpotter composed at match time has no such sentence, and
 * the honest representation of "no funder said this" is an EMPTY `rawText` — not a plausible
 * sentence written in the funder's voice.
 *
 * Every surface that renders a reason must branch on this. Rendering an empty string inside a
 * quotation block is the same lie as filling it in.
 */
export function hasFunderWording(constraint: Constraint): boolean {
  return constraint.rawText.trim() !== '';
}

/** True for the one constraint in this file that GrantSpotter composes rather than reads. */
export function isApplicantEntityConstraint(constraint: Constraint): boolean {
  return constraint.id.endsWith(APPLICANT_ENTITY_CONSTRAINT_SUFFIX);
}

/**
 * The heading a reason is filed under. `spec.axis` is `'other'` for the applicant-entity
 * constraint — which rendered as the word "OTHER" above a sentence about who may apply — so the
 * one constraint this file invents names itself instead of borrowing the long-tail bucket.
 */
export const APPLICANT_ENTITY_AXIS_LABEL = 'Who may apply';

/**
 * English for an `ApplicantEntity`. The enum identifiers are machine tokens, and until this fix
 * they were printed straight into a reason presented as a funder's own sentence — 125 rows of a
 * collegiate club's eligibility report read "This program accepts applications from:
 * ieee_student_branch_chapter." as though somebody had written it. A machine token shown as
 * English somebody wrote is a fabrication of the same family as an invented quotation.
 *
 * Two forms because the sentence needs both sides: what the record lists, and what the reader is.
 * `Record<ApplicantEntity, ...>` makes it total — a new entity in CONTRACT §3 fails the typecheck
 * here rather than leaking its identifier to a reader.
 */
export const APPLICANT_ENTITY_WORDING: Record<
  ApplicantEntity,
  { readonly listed: string; readonly applying: string }
> = {
  individual: { listed: 'individuals', applying: 'an individual' },
  club_unincorporated: { listed: 'unincorporated clubs', applying: 'an unincorporated club' },
  club_501c3: {
    listed: 'clubs that are their own 501(c)(3)',
    applying: 'a club that is its own 501(c)(3)',
  },
  club_via_fiscal_sponsor: {
    listed: 'clubs applying through a fiscal sponsor',
    applying: 'a club applying through a fiscal sponsor',
  },
  school_lea: { listed: 'schools and school districts', applying: 'a school or school district' },
  university: { listed: 'universities and colleges', applying: 'a university or college' },
  university_dept: { listed: 'university departments', applying: 'a university department' },
  ieee_student_branch_chapter: {
    listed: 'IEEE student branches and chapters',
    applying: 'an IEEE student branch or chapter',
  },
  teacher: { listed: 'teachers applying in person', applying: 'a teacher applying in person' },
  nominated_by_institution: {
    listed: 'candidates their institution nominates',
    applying: 'a candidate nominated by their institution',
  },
};

/** "individuals", "individuals or teachers", "individuals, teachers or universities". */
export function applicantEntityListLabel(entities: readonly ApplicantEntity[]): string {
  const parts = entities.map((e) => APPLICANT_ENTITY_WORDING[e].listed);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/**
 * The reason a recorded audience excludes this applicant.
 *
 * `rawText` IS EMPTY AND THAT IS THE FIX. It used to read
 * `This program accepts applications from: ieee_student_branch_chapter.` — a sentence GrantSpotter
 * composed, in the funder's grammatical voice, rendered inside the quotation block whose entire
 * premise is that the reader is looking at what the funder published. `grep` across the repo found
 * that wording in this file and nowhere else: no funder, no page, no fixture ever said it. An
 * applicant-entity list is not a quotation in the first place — it is GrantSpotter's reading of a
 * funder's page, assembled per source in `ENTITIES_BY_SOURCE` — so the reason says so in
 * GrantSpotter's own voice, and the attribution is inside the sentence rather than left to each
 * surface's styling, because a CSV cell has no styling.
 */
function applicantEntityConstraint(program: Program, applyingAs: ApplicantEntity): Constraint {
  return {
    id: `${program.id}${APPLICANT_ENTITY_CONSTRAINT_SUFFIX}`,
    hard: true,
    fallbackRank: 0,
    rawText: '',
    spec: {
      axis: 'other',
      note:
        `GrantSpotter, not the funder: this record lists who may apply as ` +
        `${applicantEntityListLabel(program.applicantEntities)}, and your profile applies as ` +
        `${APPLICANT_ENTITY_WORDING[applyingAs].applying}. That list is GrantSpotter's reading of ` +
        `the funder's page, not a sentence the funder wrote — read the page before you rule ` +
        `yourself out.`,
    },
  };
}

/**
 * Verdict precedence, most decisive first — deliberate, and each rule has a
 * dedicated test in `matcher.test.ts`:
 *
 * 1. The applicant-entity gate, BUT ONLY WHEN AN AUDIENCE WAS RECORDED. A wrong
 *    entity type against a list somebody researched is definite and immediate:
 *    an RCA nominee-only program can never accept a direct student
 *    application no matter what else is true, so this is checked before any
 *    per-axis constraint and short-circuits everything below. An EMPTY list is
 *    not that finding and never was — see `applicantEntitiesUnrecorded` below.
 * 2. Any hard `fail` -> `ineligible`. A hard fail is a definite, provable
 *    exclusion (e.g. GPA below the floor) and outranks mere uncertainty:
 *    filling in a missing field can never undo a fact already known to be
 *    false, so `ineligible` beats `unknown` when both are present.
 * 3. Any hard `unknown` -> `unknown`. Nothing is definitely wrong, but the
 *    axis can't be decided without more profile data.
 * 4. Any soft `pass` -> `eligible_preferred`. Soft constraints never
 *    exclude (rule stated in the brief and enforced below); they only
 *    promote a candidate that is otherwise fully eligible.
 * 5. Otherwise -> `eligible`.
 *
 * Hard `not_evaluable` is treated as a pass (it cannot block — there is no
 * schema field to ever resolve it, e.g. `recommendation`/`other`). Soft
 * `fail`, `unknown` and `not_evaluable` are all simply "not met": a soft
 * `unknown` must NOT escalate the verdict to `unknown`, or every program
 * with an unanswered preference axis would demand a profile field before
 * showing any result at all — defeating the point of preferences being
 * optional upside, not gates.
 */
export function matchProgram(
  profile: Profile,
  program: Program,
  nowISO: string = new Date().toISOString(),
): Verdict {
  const applyingAs: ApplicantEntity = isStudent(profile) ? 'individual' : profile.entity;

  /**
   * SILENCE IS NOT A PROHIBITION — the rule `geo.ts`'s `radiusIsMeasurable` states as "a gap in
   * the data cannot come out as a judgement about a person", applied to the gate that runs first
   * and decides everything after it.
   *
   * `[].includes(anything)` is `false`, so until this fix a record that said NOTHING about who
   * may apply was a hard `ineligible` for every possible user, before any other axis ran, and it
   * said so by quoting a sentence GrantSpotter had written reading "(none recorded)". Measured
   * over the 150 publishable programs the committed fixtures produce
   * (`scripts/profile-corpus.ts` `loadCorpus`): 19 of them — 12.7% — carry
   * `applicantEntities: []`, all 19 refused every one of the ten `ApplicantEntity` values, and a
   * collegiate 501(c)(3) club was refused 144 of 150 with all 144 on this gate. Eleven of the 19
   * are live routes to money, including the two the corpus itself annotates as the primary
   * audience's real funding: "Campus student government / student activity fee funding" and
   * "NASA National Space Grant — 52 state consortia".
   *
   * `normalize/index.ts`'s `ENTITIES_UNKNOWN_BY_SOURCE` already diagnosed this in its own words —
   * "the same silence-as-prohibition shape as `licenseMin` defaulting to 'NONE'" — and fixed the
   * PROVENANCE of the silence (an empty list is now a statement somebody signed) while leaving
   * the reading of it here unchanged. This is the other half.
   *
   * WHAT AN UNRECORDED AUDIENCE PRODUCES, and why it is not any of the other three verdicts:
   *   - not `ineligible`: nobody said the applicant may not apply.
   *   - not `eligible`: nobody said they may, either. That claim is the one an applicant acts on,
   *     and `ENTITIES_UNKNOWN_BY_SOURCE` measured what blanket permissiveness costs here.
   *   - not an `unknown` naming a profile field: the gap is in the RECORD, not the profile, so
   *     sending the reader to an editor would be asking them to fix a hole in our data by typing
   *     something about themselves.
   * So it is the `unknown` this file already has for exactly this shape: unresolved, with an
   * EMPTY `missingProfileFields` — "something could not be worked out, and there is no input you
   * could fill in to change that". Same state an unmeasurable radius produces, same
   * `unlistableUnknown` flag, and `VerdictBadge` already renders the copy for it.
   *
   * IT DOES NOT SHORT-CIRCUIT. The remaining constraints still run, so a hard `fail` that IS
   * provable still outranks it (rule 2) and still gets to quote the funder's real sentence: a GPA
   * floor the applicant is under is a refusal the funder wrote, whoever may apply.
   */
  const applicantEntitiesUnrecorded = program.applicantEntities.length === 0;
  if (!applicantEntitiesUnrecorded && !program.applicantEntities.includes(applyingAs)) {
    return { kind: 'ineligible', reasons: [applicantEntityConstraint(program, applyingAs)] };
  }

  const hardFailures: Constraint[] = [];
  const missingFields = new Set<string>();
  const metPreferences: Constraint[] = [];
  /**
   * Something unresolved that named nothing this profile could ever fill in: a hard axis that
   * came back `unknown` with no listable field, or — seeded here — an audience nobody recorded.
   * Tracked separately from `missingFields` because the two answer different questions — "is
   * anything unresolved?" and "what could the reader do about it?" — and collapsing them into one
   * set is what let an unanswerable axis read as `eligible`.
   */
  let unlistableUnknown = applicantEntitiesUnrecorded;

  for (const constraint of program.constraints) {
    // Financial need is always a weighting, never a bar (spec §4.5 rule 11),
    // so it is forced soft whatever the record says.
    const isSoft = !constraint.hard || constraint.spec.axis === 'financial_need';
    const result = evaluateConstraint(constraint.spec, profile, nowISO, constraint.rawText);

    if (isSoft) {
      if (result.status === 'pass') metPreferences.push(constraint);
      continue;
    }
    if (result.status === 'fail') {
      hardFailures.push(constraint);
    } else if (result.status === 'unknown') {
      let listedOne = false;
      for (const field of result.missing) {
        if (isResolvableMissingField(profile, field)) {
          missingFields.add(field);
          listedOne = true;
        }
      }
      // The axis is unresolved either way. If nothing about it could be put in front of the
      // reader, say so with an empty list rather than dropping the unknown entirely.
      if (!listedOne) unlistableUnknown = true;
    }
    // 'pass' and 'not_evaluable' do not block.
  }

  if (hardFailures.length > 0) return { kind: 'ineligible', reasons: hardFailures };
  if (missingFields.size > 0 || unlistableUnknown) {
    return { kind: 'unknown', missingProfileFields: [...missingFields].sort() };
  }
  if (metPreferences.length > 0) {
    return {
      kind: 'eligible_preferred',
      rank: Math.min(...metPreferences.map((c) => c.fallbackRank)),
      met: metPreferences.map((c) => c.id).sort(),
    };
  }
  return { kind: 'eligible' };
}

export function matchAll(
  profile: Profile,
  programs: Program[],
  nowISO: string = new Date().toISOString(),
): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();
  for (const program of programs) verdicts.set(program.id, matchProgram(profile, program, nowISO));
  return verdicts;
}
