import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { candidateTexts as sharedCandidateTexts, findClause } from './clauses.js';
import { makeConstraint } from './preference.js';

const NUMBER = String.raw`\d(?:\.\d+)?`;
// "GPA" and "grade point average" (also "grade-point average") are both real spellings in this
// corpus (Wayne Nelson, SEMARC) — checked exhaustively against every other candidate spelling
// (G.P.A., cumulative average, class average): none of those occur.
const GPA_WORD = String.raw`(?:GPA|grade[- ]?point average)`;
const GPA_WORD_RE = new RegExp(`\\b${GPA_WORD}\\b`, 'i');
const CASCADE_ISH = /\bif no (?:other )?qualified applicant/i;

// "3.0 GPA", "2.5 GPA on a 4.0 scale" — a number immediately before the word GPA is, in every
// real occurrence in this corpus, the actual requirement, never a "scale" qualifier (those
// always trail GPA: "on a 4.0 scale"). Checked FIRST, ahead of GPA_AFTER below, or "Minimum 2.5
// GPA on a 4.0 scale" incorrectly yields 4.0 (the scale denominator, not the floor).
const GPA_BEFORE = new RegExp(`(${NUMBER})\\s*${GPA_WORD}\\b`, 'i');
// "GPA of 3.5", "GPA over 3.5", "GPA requirement 3.0", "grade point average of 3.0" — the number
// follows the GPA word through a short run of connective words.
const GPA_AFTER = new RegExp(`\\b${GPA_WORD}\\b[^0-9]{0,24}(${NUMBER})`, 'i');
const GPA_OVER = new RegExp(`\\b(?:over|above|at least|minimum of)\\s+(${NUMBER})\\b`, 'i');
const CLASS_RANK = /top\s+(\d+)(?:\s*(?:to|[-–])\s*(\d+))?\s*(?:percent|%)/i;

/**
 * `splitClauses`/`findClause` used to be private copies here, DOT-safety, numbered-list marker,
 * field-label boundary and all — this file introduced that idiom and every other axis re-derived
 * it. It now lives in clauses.ts (see that file's header), which also carries two refinements
 * this file never had (tight-abbreviation and known-abbreviation handling) and a slightly looser
 * field-label rule (continuation words don't need to be capitalized — real labels here mix case,
 * e.g. "Award amount:"). Verified behaviour-preserving for this file specifically on the full
 * 111-entry ARRL corpus before adopting it (see the consolidation report) — the field-label
 * boundary is still what keeps the `rawText` fallback candidate (see candidateTexts below) from
 * swallowing the entire flattened record when neither `Other` nor `gpa` is populated (real case:
 * Charles Clarke Cordle has no `Other` field at all — its GPA text is filed under `Field of
 * Study`). Deliberately does NOT split on ";" — see narrowAcrossSemicolons below, which handles
 * the semicolon case with more precision than a blanket split or a blanket non-split can.
 */

/**
 * Within a clause, a ";" is ambiguous: it sometimes joins a number to preference language about
 * THAT SAME number ("Minimum 2.5 GPA on a 4.0 scale; preference given to need and higher GPA" —
 * the second half says "GPA" again, so it must survive for `hard` to come out false), and it
 * sometimes joins a number to a preference about something else entirely ("GPA of 2.5 or higher;
 * preference to students of electronics, communications, or related fields" — Charles Clarke
 * Cordle — the second half is a FIELD OF STUDY preference and must NOT survive, or the GPA floor
 * wrongly comes out soft). Splits on ";", keeps the part that actually yields a GPA number, and
 * only pulls an adjacent part back in if IT ALSO mentions GPA (or is an explicit fallback
 * cascade) — otherwise the neighbour is dropped.
 */
function narrowAcrossSemicolons(clause: string): string {
  if (!clause.includes(';')) return clause;
  const parts = clause.split(';').map((p) => p.trim());
  const coreIndex = parts.findIndex((p) => GPA_BEFORE.test(p) || GPA_AFTER.test(p));
  if (coreIndex === -1) return clause;
  const continues = (p: string): boolean => GPA_WORD_RE.test(p) || CASCADE_ISH.test(p);
  const keep = [coreIndex];
  if (coreIndex > 0 && continues(parts[coreIndex - 1])) keep.unshift(coreIndex - 1);
  if (coreIndex < parts.length - 1 && continues(parts[coreIndex + 1])) keep.push(coreIndex + 1);
  return keep.map((i) => parts[i]).join('; ');
}

/**
 * `Other` (or `gpa`) is tried as a SELF-CONTAINED candidate before `rawText`, rather than
 * concatenated with it. `rawText` is the whole flattened record — every other field's content
 * too — and `Other` is always a substring of it; for the (real, common) case where the `Other`
 * value has no true sentence terminator at all ("Minimum 2.5 GPA on a 4.0 scale; preference
 * given to need and higher GPA" has none), concatenating them leaves no boundary anywhere and
 * the extracted clause balloons to include Award Amount/License Requirement/etc. noise. Trying
 * `Other` alone first keeps the constraint's rawText to just the GPA requirement whenever a
 * structured `Other` field exists; `rawText` remains the fallback for sources that never
 * populate `rawFields.Other` at all (real case: Charles Clarke Cordle has no `Other` field —
 * its GPA text is filed under `Field of Study` — and is only reachable through this fallback,
 * now bounded by the `\nLabel:` boundary in the shared splitClauses).
 */
function candidateTexts(raw: RawOpportunity): string[] {
  return sharedCandidateTexts([raw.rawFields.Other, raw.rawFields.gpa], raw.rawText);
}

export function extractGpa(raw: RawOpportunity): Constraint[] {
  for (const text of candidateTexts(raw)) {
    const rankClause = findClause(text, CLASS_RANK);
    if (rankClause !== undefined) {
      const rank = CLASS_RANK.exec(rankClause);
      if (rank) {
        // "top 5 to 10 percent" — take the widest bound so the matcher is inclusive, not exclusive.
        const pct = Number.parseInt(rank[2] ?? rank[1], 10);
        return [makeConstraint('gpa', rankClause, { axis: 'gpa', classRankTopPct: pct }, 0)];
      }
    }

    const gpaClause = findClause(text, GPA_WORD_RE);
    if (gpaClause === undefined) continue;
    const narrowed = narrowAcrossSemicolons(gpaClause);
    const gpa = GPA_BEFORE.exec(narrowed) ?? GPA_AFTER.exec(narrowed) ?? GPA_OVER.exec(narrowed);
    if (!gpa) continue;
    return [makeConstraint('gpa', narrowed, { axis: 'gpa', min: Number.parseFloat(gpa[1]) }, 0)];
  }
  return [];
}
