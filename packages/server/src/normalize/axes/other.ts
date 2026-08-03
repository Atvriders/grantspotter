import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { stableSuffix } from './preference.js';

/**
 * The catch-all. No schema captures "preference to a student ham from a ham family",
 * learning-disability documentation, or an at-risk-youth turnaround letter — verbatim Other-field
 * prose is kept, always.
 *
 * Deliberately does NOT route through makeConstraint's preference-text detection (unlike every
 * other axis in this file set). Most Other-field prose carries no preference language of its
 * own — "documentation of a diagnosed learning disability" has none — so isPreferenceText would
 * default it to hard: true. That would let a catch-all bucket of un-schematized prose silently
 * exclude an otherwise-eligible applicant, which this axis exists explicitly to avoid. It is
 * hard-coded soft, the same way financial_need is in financialNeed.ts.
 */
export function extractOther(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields.Other;
  if (!text || text.trim() === '') return [];
  const rawText = text.trim();
  return [
    {
      id: `other-0-${stableSuffix(`other|${rawText}`)}`,
      hard: false,
      fallbackRank: 0,
      rawText,
      spec: { axis: 'other', note: rawText },
    },
  ];
}
