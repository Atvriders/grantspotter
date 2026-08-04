import type { Constraint, LicenseClass, RawOpportunity } from '@grantspotter/core';
import { makeConstraint, requirementText } from './preference.js';

const WORD_MONTHS: Record<string, number> = { one: 12, two: 24, three: 36, four: 48, five: 60 };

// Genuinely NO amateur licence is required at all — e.g. this corpus's one real
// "License Requirement: None" entry (The North Fulton Amateur Radio League Scholarship, whose
// ARRL catalog value is the bare word "None"). Checked before the generic "mentions a licence but
// names no class" fallback below, or the one real unlicensed-OK award in this corpus would
// wrongly gain a TECH floor it doesn't have.
const NO_LICENSE = /\bnone\b|\bnot\s+required\b|\bno\s+licen[sc]e\s+(?:is\s+)?required\b|\bn\/a\b/i;

/**
 * "ANY CLASS QUALIFIES" — which is NOT "no licence needed". These phrases PRESUPPOSE a licence
 * and disclaim only a floor ABOVE the entry level, so the correct answer is the entry-level
 * floor, TECH, and never NONE.
 *
 * Checked BEFORE NO_LICENSE, and deliberately so. The two families are one word apart in
 * English and share their most distinctive tokens: qcwa.org's live page says "There are no
 * restrictions regarding class of amateur license, race, sex, residence, or field of study" one
 * sentence after saying the award is for "licensed radio amateurs", and that sentence contains
 * "no", "license", and a negation, exactly like "no license required". Any future widening of
 * NO_LICENSE toward the shapes it still misses ("no ham ticket needed", "licence not necessary")
 * walks straight into it. Reading a class disclaimer as a licence disclaimer publishes a
 * licensed-operators-only award as eligible to someone with no amateur licence — the one
 * direction a funding desk whose entire subject is amateur radio must not fail in.
 *
 * Narrow on purpose: it matches only text that disclaims a restriction on the CLASS, never the
 * much larger "any class" family ("Any active Amateur Radio License Class", "FCC issued amateur
 * radio license, any class" — 40+ entries). Those already resolve to TECH through the fallback
 * below, and short-circuiting them here would flatten the one entry that reads "Any active
 * Amateur Radio License Class for two years, preference for General Class" from a General-class
 * PREFERENCE to a bare TECH, discarding the funder's stated preference.
 */
const CLASS_AGNOSTIC =
  /\bno\s+restrictions?\s+(?:regarding|on|as\s+to|upon)\s+(?:the\s+)?(?:(?:amateur\s+)?licen[sc]e\s+)?class\b|\bclass\s+(?:of\s+(?:amateur\s+)?licen[sc]e\s+)?is\s+not\s+restricted\b/i;

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
 *
 * CLASS_AGNOSTIC outranks NO_LICENSE for the reason given at its definition: "no restrictions
 * regarding CLASS of amateur license" is a statement about which licence qualifies, not about
 * whether one is needed, and TECH is the floor it describes.
 */
function licenseMinFrom(text: string): LicenseClass {
  if (CLASS_AGNOSTIC.test(text)) return 'TECH';
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
  // THE FLOOR IS WHAT THE FUNDER REQUIRES, NOT WHAT IT PREFERS. Three catalog entries state both
  // in one field, and reading the class off the whole field publishes the preferred class as the
  // bar: Holt's "Any active Amateur Radio License Class for two years, preference for General
  // Class" yielded licenseMin GENERAL, excluding the Technician-of-two-years the funder plainly
  // accepts. `requirementText` returns the field minus its preference clauses ("Any active
  // Amateur Radio License Class for two years"), which names no class and so falls through to
  // TECH — the entry-level floor, which is the answer — while `heldMonthsMin` still reads the two
  // years from the same half. It is empty only when the field is nothing but preference prose,
  // where the whole field is the best evidence there is.
  const stated = requirementText(text) || text;
  const heldMonthsMin = heldMonthsFrom(stated);
  const foreignLicenseOK =
    /\b(worldwide|foreign|international|US licensure (?:is )?not required|any country)\b/i.test(text) ||
    undefined;
  return [
    makeConstraint(
      'license',
      text,
      {
        axis: 'license',
        licenseMin: licenseMinFrom(stated),
        ...(heldMonthsMin !== undefined ? { heldMonthsMin } : {}),
        ...(foreignLicenseOK ? { foreignLicenseOK } : {}),
      },
      0,
    ),
  ];
}
