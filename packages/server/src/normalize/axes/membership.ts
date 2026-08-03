import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const ARRL_MEMBER = /\bARRL\s+member(?:s|ship)?\b/i;
const AT_LEAST_YEARS = /(?:at least|for)\s+(one|two|three|\d+)\s+years?/i;
const WORD_YEARS: Record<string, number> = { one: 1, two: 2, three: 3 };

export function extractArrlMembership(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawFields.eligibility, raw.rawText].filter(Boolean).join('\n');
  if (!ARRL_MEMBER.test(text)) return [];
  const sentence = /[^.]*ARRL\s+member[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  const years = AT_LEAST_YEARS.exec(sentence);
  const minYears = years ? (WORD_YEARS[years[1].toLowerCase()] ?? Number.parseInt(years[1], 10)) : 0;
  return [
    makeConstraint('arrl_membership', sentence, { axis: 'arrl_membership', required: true, minYears }, 0),
  ];
}
