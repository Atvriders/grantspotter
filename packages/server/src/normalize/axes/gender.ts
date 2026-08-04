import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { candidateTexts, firstClause } from './clauses.js';
import { makeConstraint } from './preference.js';

const FEMALE = /\b(women|woman|females?|YL|young lad(?:y|ies))\b/i;

/** YLRL only. There is no gender constraint anywhere in the ARRL catalog. */
export function extractGender(raw: RawOpportunity): Constraint[] {
  const candidates = candidateTexts([raw.rawFields.eligibility, raw.rawFields.Other], raw.rawText);
  // Anchored on the same pattern as the gate, so the extracted clause is always the one that
  // actually states the gender scope. The old sentence regex spelled a SHORTER list than the gate
  // ("women|woman|female|YL" — no "females", no "young ladies"), so a record gated in on one of
  // the missing spellings fell through to the whole flattened record as its rawText. Gender is
  // the one axis here whose hard/soft reading can bar an applicant on something they cannot
  // change, so the rawText that decides it must be the funder's own sentence, nothing else.
  const clause = firstClause(candidates, FEMALE);
  if (clause === undefined) return [];
  return [makeConstraint('gender', clause, { axis: 'gender', allowed: ['female'] }, 0)];
}
