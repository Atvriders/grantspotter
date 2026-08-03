import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { isPreferenceText, makeConstraint } from './preference.js';

const EXCEPT = /\bexcept(?:\s+for)?\b\s*(.+)$/i;
const GPA_ISH = /\bGPA\b|grade[- ]?point\s*average/i;

/**
 * Strips a leading "Preference [will be given/is given] [to applicants/students] [who are]
 * pursuing studies in ..." / "Preference for an ..." preamble — real corpus shapes (ARRL
 * scholarship descriptions: "Preference will be given to applicants pursuing studies in
 * Electrical Engineering, ..." and "Preference for an Engineering discipline"). Requires the
 * literal word "preference" — the ~100 plain "X, Y or Z" / "Any" entries in this corpus have no
 * such word and are returned untouched. Only fires when the preamble's connector ("pursuing ...
 * in" / "for") is actually found, so a mid-sentence, unrelated "preference" with no such
 * connector is left alone rather than guessed at.
 */
const PREAMBLE =
  /^.*?\bpreference\b[^a-zA-Z]*(?:(?:will\s+be|is)\s+given(?:\s+to)?\s+)?(?:applicants?|students?)?(?:\s+who\s+are)?\s*(?:pursuing(?:\s+studies)?(?:\s+in)?|studying(?:\s+in)?|majoring\s+in|for)\s+(?:an?\s+)?/i;

// A trailing generic descriptor word left dangling once the preamble in front of it is gone —
// "Preference for an Engineering discipline" strips to "Engineering discipline" and this removes
// the "discipline". Scoped to the preamble branch only (see stripPreamble): it never runs on the
// ~100 non-preference entries in this corpus.
const TRAILING_DESCRIPTOR = /\s+(?:discipline|field|major|area)s?\.?$/i;

function stripPreamble(text: string): string {
  const m = PREAMBLE.exec(text);
  if (!m) return text;
  return text.slice(m[0].length).replace(TRAILING_DESCRIPTOR, '');
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

function splitFields(text: string): string[] {
  return text
    .split(/,|\/|\bor\b|\band\b/i)
    // A GPA/grade-point-average fragment is never a field name (real corpus: GPA text
    // routinely leaks into `Field of Study` — Cordle, Daze, Central Arizona DX, Mary Lou Brown —
    // and splitting it on its internal comma/"or" would otherwise mint fake fields like "GPA 30"
    // or "higher GPA 3").
    .filter((s) => !GPA_ISH.test(s))
    .map((s) => s.replace(/[.;]/g, '').trim())
    .filter((s) => s !== '' && !/^any$/i.test(s));
}

/**
 * A sentence that is ENTIRELY preference prose about something other than field names (real
 * case: "Preference will be given to undergraduate students and those in certificate programs,
 * but graduate students may apply." — a degree-level preference, not a field list) is dropped
 * outright rather than run through splitFields, which would otherwise turn each of its commas
 * into a fake field. Detected as: contains preference language, AND stripPreamble found no
 * "pursuing/studying/majoring/for" list connector to strip — i.e. there is no reason to believe
 * a field list is hiding inside it. A sentence with no preference language at all is always kept
 * (it is ordinary field-listing prose, however it may still need stripListIntro below).
 */
function cleanedSentenceOrDrop(sentence: string): string | undefined {
  const afterPreamble = stripPreamble(sentence);
  if (afterPreamble === sentence && isPreferenceText(sentence)) return undefined;
  return stripListIntro(afterPreamble);
}

export function extractFieldOfStudy(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields['Field of Study'];
  if (!text || text.trim() === '') return [];
  const except = EXCEPT.exec(text);
  const excludedFields = except ? splitFields(except[1]) : [];
  const requiredPart = except ? text.slice(0, except.index) : text;

  const kept = splitSentences(requiredPart)
    .map(cleanedSentenceOrDrop)
    .filter((s): s is string => s !== undefined);
  // Safety net: if every sentence looked like pure preference prose (should not happen on real
  // data — "Any" and plain lists never trigger isPreferenceText), fall back to the untouched
  // required part rather than silently emptying the field list.
  const segments = kept.length > 0 ? kept : [requiredPart];

  const fields = segments.flatMap((s) => (/^\s*any\b/i.test(s) ? [] : splitFields(s)));
  return [
    makeConstraint('field_of_study', text, { axis: 'field_of_study', fields, excludedFields }, 0),
  ];
}
