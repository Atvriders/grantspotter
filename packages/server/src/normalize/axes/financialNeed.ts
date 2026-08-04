import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { candidateTexts, firstClause } from './clauses.js';

const NEED = /\bfinancial(?:ly)?\s+needs?\b|\bneed[- ]based\b|\bdemonstrated needs?\b/i;

/**
 * Financial need is ALWAYS a weighting and NEVER a bar — all four occurrences in the corpus
 * read that way, so this constraint is hard-coded soft rather than going through
 * makeConstraint's preference detection. The clause therefore only ever decides what the UI
 * SHOWS the applicant, never whether they are excluded; it still has to be the funder's actual
 * sentence, which the old `/[^.]*financial[^.]*\./` idiom could not guarantee — it spelled only
 * two of NEED's three alternatives ("demonstrated need" had none of its own) and split at the
 * first period, decimal or abbreviation it met.
 */
export function extractFinancialNeed(raw: RawOpportunity): Constraint[] {
  const candidates = candidateTexts([raw.rawFields.Other], raw.rawText);
  const clause = firstClause(candidates, NEED);
  if (clause === undefined) return [];
  return [
    {
      id: 'financial_need-0',
      hard: false,
      fallbackRank: 0,
      rawText: clause,
      spec: { axis: 'financial_need', weighted: true },
    },
  ];
}
