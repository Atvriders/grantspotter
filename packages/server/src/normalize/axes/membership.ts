import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const ARRL_MEMBER = /\bARRL\s+member(?:s|ship)?\b/i;
const AT_LEAST_YEARS = /(?:at least|for)\s+(one|two|three|\d+)\s+years?/i;
const WORD_YEARS: Record<string, number> = { one: 1, two: 2, three: 3 };

// Text describing ARRL membership as the AWARD ITSELF — "$500 and 1 year ARRL membership for
// non-member", "the award includes a one-year ARRL membership", "recipient receives a year of
// membership" — is not an eligibility requirement, it is the prize, and in the one real instance
// of this shape in this corpus (the ARRL Rocky Mountain Division Scholarship) it is explicitly
// offered TO non-members. A clause matching this must never become a hard "must be an ARRL
// member" bar: that would exclude exactly the people the award exists for, which is worse than
// missing the constraint entirely (a missing constraint merely over-shows the award; a wrong hard
// constraint hides it from its own intended recipient).
const PRIZE_POLARITY =
  /\bfor\s+non-?members?\b|\bnon-?members?\s+(?:only|welcome|eligible)\b|\b(?:award|scholarship|prize)\s+includes?\b|\bincludes?\s+(?:a\s+|an\s+|\d+[\s-]*(?:year|yr)s?\s+)*(?:of\s+)?ARRL\s+member|\brecipients?\s+receives?\b|\breceives?\s+(?:a\s+|an\s+|\d+[\s-]*(?:year|yr)s?\s+)*(?:of\s+)?ARRL\s+member/i;

/**
 * Splits `text` into clauses on a "." only when it is a genuine sentence end — never a decimal
 * point ("2.5", "4.0") — and on a "1)"/"2)"-style numbered-list marker. Mirrors gpa.ts's
 * `splitClauses` (see that file for the full reasoning behind each exception); membership shares
 * the same corpus, and an Other field that combines a GPA number with ARRL-membership language in
 * one sentence would otherwise truncate mid-number the same way gpa.ts's old naive
 * `/[^.]*ARRL\s+member[^.]*\./i` idiom did in practice: the William Bennett entry's Other field
 * ("GPA of 3.0 or better for an ongoing course of study; applicant must be an ARRL member") has a
 * decimal point in "3.0" that a plain `[^.]*` sentence regex cannot cross, silently pulling the
 * match's start point to well past where the real ARRL-membership clause begins.
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
    const isAbbreviation =
      before !== undefined &&
      /[A-Z]/.test(before) &&
      (beforeBefore === undefined || beforeBefore === '.' || /\s/.test(beforeBefore));
    if (!isDecimalPoint && !isAbbreviation) boundaries.add(m.index + 1);
  }
  const LIST_MARKER = /\n(?=\d+\))/g;
  for (let m = LIST_MARKER.exec(text); m !== null; m = LIST_MARKER.exec(text)) boundaries.add(m.index);
  const cuts = [0, ...[...boundaries].sort((a, b) => a - b), text.length];
  const clauses: string[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) clauses.push(text.slice(cuts[i], cuts[i + 1]).trim());
  return clauses.filter((c) => c !== '');
}

function findClause(text: string, anchor: RegExp): string | undefined {
  return splitClauses(text).find((c) => anchor.test(c));
}

/**
 * `Other` and `eligibility` are tried as SELF-CONTAINED candidates before `rawText`'s individual
 * lines, mirroring gpa.ts's `candidateTexts`. The old code concatenated `Other` + `eligibility` +
 * the WHOLE flattened `rawText` into one string before scanning it — and `rawText` already
 * contains `Other` again as a substring, plus every other field's content (Award Amount, License
 * Requirement, Region, ...). For the ARRL Rocky Mountain Division Scholarship, whose Other field
 * never mentions ARRL membership at all (only its Award Amount field does: "$500 and 1 year ARRL
 * membership for non-member"), and whose entire record contains not one literal sentence-ending
 * period, the old single-string scan had no boundary anywhere and the "sentence" ballooned across
 * every field in the record. Splitting `rawText` into its per-field/per-line pieces keeps each
 * field's wording isolated, so a mention buried in Award Amount is checked (and can be rejected by
 * `PRIZE_POLARITY`) on its own, never blended with an unrelated Other-field eligibility clause.
 */
function candidateTexts(raw: RawOpportunity): string[] {
  const rawTextLines = (raw.rawText ?? '').split('\n');
  return [raw.rawFields.Other, raw.rawFields.eligibility, ...rawTextLines].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
}

export function extractArrlMembership(raw: RawOpportunity): Constraint[] {
  for (const text of candidateTexts(raw)) {
    const clause = findClause(text, ARRL_MEMBER);
    if (clause === undefined) continue;
    // The award ITSELF, not a requirement — keep scanning the remaining fields/lines in case a
    // genuine requirement is stated elsewhere, but never emit a hard bar from this clause.
    if (PRIZE_POLARITY.test(clause)) continue;
    const years = AT_LEAST_YEARS.exec(clause);
    const minYears = years ? (WORD_YEARS[years[1].toLowerCase()] ?? Number.parseInt(years[1], 10)) : 0;
    return [
      makeConstraint('arrl_membership', clause, { axis: 'arrl_membership', required: true, minYears }, 0),
    ];
  }
  return [];
}
