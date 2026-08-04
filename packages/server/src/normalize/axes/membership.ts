import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { candidateTexts as sharedCandidateTexts, findClause } from './clauses.js';
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
 * `splitClauses`/`findClause` used to be private copies here — DOT safety plus the numbered-list
 * marker, mirroring gpa.ts's original `splitClauses` (membership shares the same corpus, and an
 * Other field that combines a GPA number with ARRL-membership language in one sentence would
 * otherwise truncate mid-number the same way gpa.ts's old naive `/[^.]*ARRL\s+member[^.]*\./i`
 * idiom did in practice: the William Bennett entry's Other field ("GPA of 3.0 or better for an
 * ongoing course of study; applicant must be an ARRL member") has a decimal point in "3.0" that a
 * plain `[^.]*` sentence regex cannot cross, silently pulling the match's start point to well past
 * where the real ARRL-membership clause begins). Both now import from clauses.ts, which also adds
 * a field-label boundary this file's copy never had, plus tight-/known-abbreviation handling; none
 * of the three changes anything here in practice because candidateTexts below already splits
 * `rawText` into individual lines before either function ever sees it, so there is no embedded
 * "\nLabel:" or "St."/"Ph.D."-style abbreviation left for the added rules to act on. Verified
 * behaviour-preserving on the full 111-entry ARRL corpus before adopting it (see the consolidation
 * report).
 */

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
  const rawTextLines = raw.rawText.split('\n');
  return sharedCandidateTexts([raw.rawFields.Other, raw.rawFields.eligibility, ...rawTextLines], '');
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
