import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const GPA = /\bGPA\b[^0-9]{0,20}(\d(?:\.\d+)?)/i;
const GPA_OVER = /\b(?:over|above|at least|minimum of)\s+(\d\.\d+)\b/i;
const CLASS_RANK = /top\s+(\d+)(?:\s*(?:to|[-–])\s*(\d+))?\s*(?:percent|%)/i;

export function extractGpa(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawFields.gpa, raw.rawText].filter(Boolean).join('\n');
  const rank = CLASS_RANK.exec(text);
  if (rank) {
    // "top 5 to 10 percent" — take the widest bound so the matcher is inclusive, not exclusive.
    const pct = Number.parseInt(rank[2] ?? rank[1], 10);
    const sentence = /[^.]*top\s+\d+[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
    return [makeConstraint('gpa', sentence, { axis: 'gpa', classRankTopPct: pct }, 0)];
  }
  const gpa = GPA.exec(text) ?? GPA_OVER.exec(text);
  if (!gpa) return [];
  const sentence = /[^.]*GPA[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  return [makeConstraint('gpa', sentence, { axis: 'gpa', min: Number.parseFloat(gpa[1]) }, 0)];
}
