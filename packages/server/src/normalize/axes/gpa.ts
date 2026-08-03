import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const NUMBER = String.raw`\d(?:\.\d+)?`;

// "3.0 GPA", "2.5 GPA on a 4.0 scale" — a number immediately before the word GPA is, in every
// real occurrence in this corpus, the actual requirement, never a "scale" qualifier (those
// always trail GPA: "on a 4.0 scale"). Checked FIRST, ahead of GPA_AFTER below, or "Minimum 2.5
// GPA on a 4.0 scale" incorrectly yields 4.0 (the scale denominator, not the floor).
const GPA_BEFORE = new RegExp(`(${NUMBER})\\s*GPA\\b`, 'i');
// "GPA of 3.5", "GPA over 3.5", "GPA requirement 3.0", "GPA must be 3.7" — the number follows
// GPA through a short run of connective words.
const GPA_AFTER = new RegExp(`\\bGPA\\b[^0-9]{0,20}(${NUMBER})`, 'i');
const GPA_OVER = new RegExp(`\\b(?:over|above|at least|minimum of)\\s+(${NUMBER})\\b`, 'i');
const CLASS_RANK = /top\s+(\d+)(?:\s*(?:to|[-–])\s*(\d+))?\s*(?:percent|%)/i;

/**
 * Splits `text` into clauses on a "." only when it is a genuine sentence end — never a decimal
 * point ("2.5", "4.0"), which this corpus embeds directly inside GPA numbers, and never an
 * abbreviation's period ("U.S." in "Applicant must be a U.S. citizen with a 3.0 GPA or higher")
 * — and on a "1)"/"2)"-style numbered-list marker (real shape: "1) High School GPA must be 3.7
 * or higher\n2) Aggregate income..."). Deliberately does NOT split on ";": this corpus routinely
 * uses a semicolon to join a number and its preference language into ONE requirement ("Minimum
 * 2.5 GPA on a 4.0 scale; preference given to need and higher GPA"), and splitting there would
 * strand the preference half from the number half, wrongly leaving the constraint hard.
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
  const LIST_MARKER = /\n(?=\d+\))/g;
  for (let m = LIST_MARKER.exec(text); m !== null; m = LIST_MARKER.exec(text)) boundaries.add(m.index);
  const cuts = [0, ...[...boundaries].sort((a, b) => a - b), text.length];
  const clauses: string[] = [];
  for (let i = 0; i < cuts.length - 1; i += 1) clauses.push(text.slice(cuts[i], cuts[i + 1]).trim());
  return clauses.filter((c) => c !== '');
}

/** The first clause matching `anchor`, so a multi-clause Other field never bleeds unrelated
 * numbers or prose from a neighbouring, differently-scoped clause into the one we extract. */
function findClause(text: string, anchor: RegExp): string | undefined {
  return splitClauses(text).find((c) => anchor.test(c));
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
 * populate `rawFields.Other` at all.
 */
function candidateTexts(raw: RawOpportunity): string[] {
  return [raw.rawFields.Other, raw.rawFields.gpa, raw.rawText].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
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

    const gpaClause = findClause(text, /\bGPA\b/i);
    if (gpaClause === undefined) continue;
    const gpa = GPA_BEFORE.exec(gpaClause) ?? GPA_AFTER.exec(gpaClause) ?? GPA_OVER.exec(gpaClause);
    if (!gpa) continue;
    return [makeConstraint('gpa', gpaClause, { axis: 'gpa', min: Number.parseFloat(gpa[1]) }, 0)];
  }
  return [];
}
