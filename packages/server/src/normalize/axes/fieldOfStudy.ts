import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const EXCEPT = /\bexcept(?:\s+for)?\b\s*(.+)$/i;

function splitFields(text: string): string[] {
  return text
    .split(/,|\/|\bor\b|\band\b/i)
    .map((s) => s.replace(/[.;]/g, '').trim())
    .filter((s) => s !== '' && !/^any$/i.test(s));
}

export function extractFieldOfStudy(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields['Field of Study'];
  if (!text || text.trim() === '') return [];
  const except = EXCEPT.exec(text);
  const excludedFields = except ? splitFields(except[1]) : [];
  const requiredPart = except ? text.slice(0, except.index) : text;
  const fields = /^\s*any\b/i.test(requiredPart) ? [] : splitFields(requiredPart);
  return [
    makeConstraint('field_of_study', text, { axis: 'field_of_study', fields, excludedFields }, 0),
  ];
}
