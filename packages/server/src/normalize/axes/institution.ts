import type { Constraint, DegreeLevel, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

export function extractInstitution(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields.Institution;
  if (!text || text.trim() === '') return [];
  const levels = new Set<DegreeLevel>();
  // "trade" is deliberately excluded here — it drives tradeSchoolOK below, not a CERT degree
  // level; a trade school accepted alongside two/four-year/graduate programs isn't itself a
  // certificate-level requirement.
  if (/\b(?:certificates?|certifications?|vocational)\b/i.test(text)) levels.add('CERT');
  if (/\b(?:two[- ]year|associates?|community colleges?)\b/i.test(text)) levels.add('ASSOC');
  if (/\b(?:four[- ]year|bachelors?|undergraduates?|baccalaureates?)\b/i.test(text)) levels.add('BACH');
  if (/\b(?:graduates?|masters?|doctoral|phds?|post[- ]graduates?)\b/i.test(text)) levels.add('GRAD');
  return [
    makeConstraint(
      'institution',
      text,
      {
        axis: 'institution',
        degreeLevels: [...levels],
        tradeSchoolOK: /\b(?:trade|vocational|technical schools?)\b/i.test(text),
        partTimeOK: /\bpart[- ]time\b/i.test(text),
        accreditationRequired: /\baccredit/i.test(text),
      },
      0,
    ),
  ];
}
