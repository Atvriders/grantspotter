import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const EXCEPT = /\bexcept(?:\s+for)?\b\s*(.+)$/i;

/**
 * Strips a leading "Preference [will be given/is given] [to applicants/students] [who are]
 * pursuing studies in ..." / "Preference for an ..." preamble — real corpus shapes (ARRL
 * scholarship descriptions: "Preference will be given to applicants pursuing studies in
 * Electrical Engineering, ..." and "Preference for an Engineering discipline"). Requires the
 * literal word "preference" — the ~100 plain "X, Y or Z" / "Any" entries in this corpus have no
 * such word and are returned untouched. Only fires when the preamble's connector ("pursuing ...
 * in" / "for") is actually found, so a mid-sentence, unrelated "preference" with no such
 * connector (e.g. a trailing DEGREE-LEVEL preference clause bolted onto an otherwise normal field
 * list) is left alone rather than guessed at.
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

function splitFields(text: string): string[] {
  return text
    .split(/,|\/|\bor\b|\band\b/i)
    .map((s) => s.replace(/[.;]/g, '').trim())
    .filter((s) => s !== '' && !/^any$/i.test(s));
}

export function extractFieldOfStudy(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields['Field of Study'];
  if (!text || text.trim() === '') return [];
  const except = EXCEPT.exec(text);
  const excludedFields = except ? splitFields(except[1]) : [];
  const requiredPart = except ? text.slice(0, except.index) : text;
  const cleaned = stripPreamble(requiredPart);
  const fields = /^\s*any\b/i.test(cleaned) ? [] : splitFields(cleaned);
  return [
    makeConstraint('field_of_study', text, { axis: 'field_of_study', fields, excludedFields }, 0),
  ];
}
