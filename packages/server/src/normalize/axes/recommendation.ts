import type { Constraint, RawOpportunity, RecommenderType } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const WORD_COUNT: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const COUNT = /\b(one|two|three|four|five|\d+)\s+(?:letters? of )?(?:references?|recommendations?)/i;
const SIGNAL = /\b(references?|recommendations?|sponsor(?:ed|ship)?|letter from)\b/i;

function recommenderTypeFrom(text: string): RecommenderType {
  if (/\bofficer of an ARRL[- ]affiliated club|ARRL[- ]affiliated club officer|sitting officer\b/i.test(text)) {
    return 'arrl_affiliated_club_officer';
  }
  if (/\bactive\s+\w+\s+member\b|\bsponsored by an active\b/i.test(text)) return 'sponsor_org_member';
  if (/\bteacher|instructor|faculty|professor\b/i.test(text)) return 'teacher';
  return 'any';
}

export function extractRecommendation(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawFields.sponsor, raw.rawText].filter(Boolean).join('\n');
  if (!SIGNAL.test(text)) return [];
  const sentence =
    /[^.]*(?:reference|recommendation|sponsor|letter from)[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  const countMatch = COUNT.exec(sentence);
  const count = countMatch
    ? (WORD_COUNT[countMatch[1].toLowerCase()] ?? Number.parseInt(countMatch[1], 10))
    : 1;
  return [
    makeConstraint(
      'recommendation',
      sentence,
      { axis: 'recommendation', recommenderType: recommenderTypeFrom(sentence), count },
      0,
    ),
  ];
}
