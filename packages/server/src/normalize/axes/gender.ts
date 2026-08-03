import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const FEMALE = /\b(women|woman|female|YL|young lad(?:y|ies))\b/i;

/** YLRL only. There is no gender constraint anywhere in the ARRL catalog. */
export function extractGender(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.eligibility, raw.rawFields.Other, raw.rawText].filter(Boolean).join('\n');
  if (!FEMALE.test(text)) return [];
  const sentence = /[^.]*(?:women|woman|female|YL)[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  return [makeConstraint('gender', sentence, { axis: 'gender', allowed: ['female'] }, 0)];
}
