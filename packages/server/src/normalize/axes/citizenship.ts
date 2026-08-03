import type { Citizenship, Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const WORD_MONTHS: Record<string, number> = { one: 1, two: 2, three: 3, six: 6, twelve: 12 };
const WITHIN = /within\s+(one|two|three|six|twelve|\d+)\s+months?\s+of\s+citizenship/i;
const WORLDWIDE = /\b(worldwide|any country|US (?:residence|licensure|citizenship) (?:is )?not required|international applicants)\b/i;

export function extractCitizenship(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawFields.Region, raw.rawFields.eligibility, raw.rawText]
    .filter(Boolean)
    .join('\n');
  const hasCitizen = /\bcitizen(?:ship)?\b/i.test(text);
  const worldwide = WORLDWIDE.test(text);
  if (!hasCitizen && !worldwide) return [];

  if (worldwide && !/must be a US citizen/i.test(text)) {
    const sentence = /[^.]*(?:worldwide|not required|any country)[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
    return [makeConstraint('citizenship', sentence, { axis: 'citizenship', allowed: ['ANY'] }, 0)];
  }

  const sentence = /[^.]*citizen[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  const allowed: Citizenship[] = ['US_CITIZEN'];
  if (/\b(permanent resident|lawful resident|US resident)\b/i.test(sentence)) allowed.push('US_RESIDENT');
  const within = WITHIN.exec(sentence);
  const withinMonthsOfCitizenship = within
    ? (WORD_MONTHS[within[1].toLowerCase()] ?? Number.parseInt(within[1], 10))
    : undefined;
  return [
    makeConstraint(
      'citizenship',
      sentence,
      {
        axis: 'citizenship',
        allowed,
        ...(withinMonthsOfCitizenship !== undefined ? { withinMonthsOfCitizenship } : {}),
      },
      0,
    ),
  ];
}
