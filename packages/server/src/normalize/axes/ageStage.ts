import type { Constraint, RawOpportunity, Stage } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const RANGE = /\b(\d{2})\s*(?:to|through|[-–])\s*(\d{2})\b/;
const MAX_AGE = /\b(\d{2})\s*(?:years old )?or (?:younger|under)\b/i;
const MIN_AGE = /\bat least\s+(\d{2})\s*(?:years old)?\b/i;
const AS_OF = /\bas of\s+([A-Z][a-z]+\.?\s+\d{1,2})/;

function stagesFrom(text: string): Stage[] {
  const stages = new Set<Stage>();
  if (/\b(?:high school seniors?|graduating seniors?)\b/i.test(text)) stages.add('HS_SENIOR');
  if (/\b(?:undergraduates?|baccalaureate|four[- ]year students?)\b/i.test(text)) stages.add('UNDERGRAD');
  if (/\b(?:graduate students?|masters?|doctoral|phds?)\b/i.test(text)) stages.add('GRAD');
  if (/\bveterans?\b/i.test(text)) stages.add('VETERAN');
  if (/\bretrain|returning to school|career chang|adults? (?:re)?entering\b/i.test(text)) {
    stages.add('RETRAINING_ADULT');
  }
  return [...stages];
}

export function extractAgeStage(raw: RawOpportunity): Constraint[] {
  const ageText = raw.rawFields.Age ?? raw.rawFields.age ?? '';
  const otherText = [raw.rawFields.Other, raw.rawFields.Institution, raw.rawText].filter(Boolean).join('\n');
  const text = [ageText, otherText].filter(Boolean).join('\n');

  const range = RANGE.exec(ageText);
  const maxAge = MAX_AGE.exec(ageText);
  const minAge = MIN_AGE.exec(ageText);
  const stages = stagesFrom(otherText);

  if (!range && !maxAge && !minAge && stages.length === 0) return [];

  const asOf = AS_OF.exec(ageText)?.[1];
  const rawText = ageText.trim() !== '' ? ageText.trim() : (/[^.]*(?:senior|undergraduate|graduate student|veteran|retrain)[^.]*\./i.exec(otherText)?.[0]?.trim() ?? text);

  return [
    makeConstraint(
      'age_stage',
      rawText,
      {
        axis: 'age_stage',
        ...(range ? { ageMin: Number.parseInt(range[1], 10), ageMax: Number.parseInt(range[2], 10) } : {}),
        ...(!range && maxAge ? { ageMax: Number.parseInt(maxAge[1], 10) } : {}),
        ...(!range && minAge ? { ageMin: Number.parseInt(minAge[1], 10) } : {}),
        ...(asOf ? { asOf } : {}),
        stages,
      },
      0,
    ),
  ];
}
