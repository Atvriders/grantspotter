import type { Constraint, LicenseClass, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const WORD_MONTHS: Record<string, number> = { one: 12, two: 24, three: 36, four: 48, five: 60 };

// Genuinely NO amateur licence is required at all — e.g. this corpus's one real
// "License Requirement: None" entry. Checked FIRST: it must win over the generic "mentions a
// licence but names no class" fallback below, or the one real unlicensed-OK award in this corpus
// would wrongly gain a TECH floor it doesn't have.
const NO_LICENSE = /\bnone\b|\bnot\s+required\b|\bno\s+licen[sc]e\s+(?:is\s+)?required\b|\bn\/a\b/i;

const CLASS_RANK: Record<'TECH' | 'GENERAL' | 'EXTRA', number> = { TECH: 1, GENERAL: 2, EXTRA: 3 };

/**
 * Picks the LOWEST class named anywhere in the text — the floor that actually gates
 * eligibility — never the first one a left-to-right check happens to hit. "General or Extra" and
 * "First preference Extra Class, Second preference General Class, Third preference Technician
 * Class" both name every class that qualifies; the applicant only needs to clear the lowest one
 * named. (Checking `extra` first and returning immediately, as this function used to, made
 * "General or Extra" wrongly resolve to EXTRA — the *maximum* named, not the floor — excluding
 * every General holder from an award they qualified for.)
 *
 * Falls through to TECH — the modern entry-level licence, and the correct floor for "any class
 * is fine" — for text that plainly requires *a* licence but names no specific class ("Any active
 * Amateur Radio license", "Applicant must be a licensed radio amateur."). 68 of this corpus's 111
 * License Requirement values are exactly this shape; falling through to NONE (no licence needed
 * at all, as this function used to do) showed ham-radio-only awards as eligible to applicants
 * with no amateur licence — the worst possible direction for this product to fail in.
 */
function licenseMinFrom(text: string): LicenseClass {
  if (NO_LICENSE.test(text)) return 'NONE';
  const named: Array<'TECH' | 'GENERAL' | 'EXTRA'> = [];
  if (/\bextra\b/i.test(text)) named.push('EXTRA');
  if (/\bgeneral\b/i.test(text)) named.push('GENERAL');
  // Novice is a legacy class; Technician is the modern equivalent floor.
  if (/\b(technician|tech|novice)\b/i.test(text)) named.push('TECH');
  if (named.length > 0) {
    return named.reduce((min, c) => (CLASS_RANK[c] < CLASS_RANK[min] ? c : min));
  }
  return 'TECH';
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
