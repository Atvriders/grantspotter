import { evaluateGeo } from './geo.js';
import type {
  ActivityKind,
  ApplicantEntity,
  Citizenship,
  Constraint,
  ConstraintSpec,
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

interface FieldRequirement {
  /** Alternatives that actually name a field. */
  informative: FieldPhrase[];
  /** The funder said "any"/"all"/"none", or every alternative was pure noise. */
  unrestricted: boolean;
  /** The funder said "or related field": adjacency we cannot adjudicate, so we include. */
  widened: boolean;
  excluded: FieldPhrase[];
}

function readFieldRequirement(fields: string[], excludedFields: string[]): FieldRequirement {
  const informative: FieldPhrase[] = [];
  let unrestricted = false;
  let widened = false;
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

function isStudent(profile: Profile): profile is StudentProfile {
  return profile.kind === 'student';
}

function isOrg(profile: Profile): profile is OrgProfile {
  return profile.kind === 'organization';
}

export function evaluateConstraint(
  spec: ConstraintSpec,
  profile: Profile,
  nowISO: string,
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
      const required = readFieldRequirement(spec.fields, spec.excludedFields);
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
      // The funder wrote "or a related field". They widened it themselves, and
      // relatedness is not something this matcher can adjudicate — so include,
      // and let the applicant read the funder's own wording (Constraint.rawText,
      // which Plan 3 renders) to judge the fit.
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
        else if (!stages.includes(profile.stage)) failed = true;
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
      if (wanted.length > 0) {
        if (mine === undefined) missing.push('activityKinds');
        else if (!wanted.some((k) => mine.includes(k))) failed = true;
      }
      if (spec.cwProficiencyWpmMin !== undefined) {
        if (profile.cwWpm === undefined) missing.push('cwWpm');
        else if (profile.cwWpm < spec.cwProficiencyWpmMin) failed = true;
      }
      if (failed) return FAIL;
      if (missing.length > 0) return { status: 'unknown', missing };
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

export const APPLICANT_ENTITY_CONSTRAINT_SUFFIX = ':applicant-entity';

/**
 * `evaluateGeo`'s `county` and `call_district` axes report their missing
 * field as `'county'` / `'callDistrict'` regardless of profile kind, but
 * neither name is a field on `OrgProfile` (only `StudentProfile` has them —
 * `matcher.ts`'s `geography` case even forces both to `undefined` for
 * non-student profiles). For an organisation, that `unknown` is therefore
 * permanently unresolvable: the UI could never find a matching input to
 * jump to. Known carry-forward finding from Task 8 — handled here by
 * treating those two field names as not-evaluable (silently dropped from
 * `missingProfileFields`) whenever the profile is an organisation, rather
 * than letting them surface as an actionable-looking missing field.
 */
const ORG_UNRESOLVABLE_GEO_FIELDS = new Set(['county', 'callDistrict']);

function isResolvableMissingField(profile: Profile, field: string): boolean {
  if (isOrg(profile) && ORG_UNRESOLVABLE_GEO_FIELDS.has(field)) return false;
  return true;
}

function applicantEntityConstraint(program: Program, applyingAs: ApplicantEntity): Constraint {
  const accepted =
    program.applicantEntities.length > 0
      ? program.applicantEntities.join(', ')
      : '(none recorded)';
  return {
    id: `${program.id}${APPLICANT_ENTITY_CONSTRAINT_SUFFIX}`,
    hard: true,
    fallbackRank: 0,
    rawText: `This program accepts applications from: ${accepted}.`,
    spec: {
      axis: 'other',
      note: `Your profile applies as "${applyingAs}", which this program does not accept.`,
    },
  };
}

/**
 * Verdict precedence, most decisive first — deliberate, and each rule has a
 * dedicated test in `matcher.test.ts`:
 *
 * 1. The applicant-entity gate. Wrong entity type is definite and immediate:
 *    an RCA nominee-only program can never accept a direct student
 *    application no matter what else is true, so this is checked before any
 *    per-axis constraint and short-circuits everything below.
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
  if (!program.applicantEntities.includes(applyingAs)) {
    return { kind: 'ineligible', reasons: [applicantEntityConstraint(program, applyingAs)] };
  }

  const hardFailures: Constraint[] = [];
  const missingFields = new Set<string>();
  const metPreferences: Constraint[] = [];

  for (const constraint of program.constraints) {
    // Financial need is always a weighting, never a bar (spec §4.5 rule 11),
    // so it is forced soft whatever the record says.
    const isSoft = !constraint.hard || constraint.spec.axis === 'financial_need';
    const result = evaluateConstraint(constraint.spec, profile, nowISO);

    if (isSoft) {
      if (result.status === 'pass') metPreferences.push(constraint);
      continue;
    }
    if (result.status === 'fail') {
      hardFailures.push(constraint);
    } else if (result.status === 'unknown') {
      for (const field of result.missing) {
        if (isResolvableMissingField(profile, field)) missingFields.add(field);
      }
    }
    // 'pass' and 'not_evaluable' do not block.
  }

  if (hardFailures.length > 0) return { kind: 'ineligible', reasons: hardFailures };
  if (missingFields.size > 0) {
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
