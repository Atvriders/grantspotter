import type { Constraint, RawOpportunity } from '@grantspotter/core';

const NEED = /\bfinancial(?:ly)?\s+need\b|\bneed[- ]based\b|\bdemonstrated need\b/i;

/**
 * Financial need is ALWAYS a weighting and NEVER a bar — all four occurrences in the corpus
 * read that way, so this constraint is hard-coded soft rather than going through
 * makeConstraint's preference detection.
 */
export function extractFinancialNeed(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawText].filter(Boolean).join('\n');
  if (!NEED.test(text)) return [];
  const sentence = /[^.]*financial[^.]*\.|[^.]*need[- ]based[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  return [
    {
      id: 'financial_need-0',
      hard: false,
      fallbackRank: 0,
      rawText: sentence,
      spec: { axis: 'financial_need', weighted: true },
    },
  ];
}
