import type { Constraint, LicenseClass, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const WORD_MONTHS: Record<string, number> = { one: 12, two: 24, three: 36, four: 48, five: 60 };

function licenseMinFrom(text: string): LicenseClass {
  if (/\bextra\b/i.test(text)) return 'EXTRA';
  if (/\bgeneral\b/i.test(text)) return 'GENERAL';
  // Novice is a legacy class; Technician is the modern equivalent floor.
  if (/\b(technician|tech|novice)\b/i.test(text)) return 'TECH';
  return 'NONE';
}

function heldMonthsFrom(text: string): number | undefined {
  const numeric = /(\d+)\s*(year|month)s?/i.exec(text);
  if (numeric) {
    const n = Number.parseInt(numeric[1], 10);
    return /year/i.test(numeric[2]) ? n * 12 : n;
  }
  const worded = /\b(one|two|three|four|five)\s+(year|month)s?/i.exec(text);
  if (worded) {
    const base = WORD_MONTHS[worded[1].toLowerCase()];
    return /year/i.test(worded[2]) ? base : base / 12;
  }
  return undefined;
}

export function extractLicense(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields['License Requirement'] ?? raw.rawFields.license;
  if (!text || text.trim() === '') return [];
  const heldMonthsMin = heldMonthsFrom(text);
  const foreignLicenseOK =
    /\b(worldwide|foreign|international|US licensure (?:is )?not required|any country)\b/i.test(text) ||
    undefined;
  return [
    makeConstraint(
      'license',
      text,
      {
        axis: 'license',
        licenseMin: licenseMinFrom(text),
        ...(heldMonthsMin !== undefined ? { heldMonthsMin } : {}),
        ...(foreignLicenseOK ? { foreignLicenseOK } : {}),
      },
      0,
    ),
  ];
}
