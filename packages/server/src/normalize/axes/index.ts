import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { extractFieldOfStudy } from './fieldOfStudy.js';
import { extractGeography } from './geography.js';
import { extractGpa } from './gpa.js';
import { extractInstitution } from './institution.js';
import { extractLicense } from './license.js';

export type AxisExtractor = (raw: RawOpportunity) => Constraint[];

export { cascadeRank, isPreferenceText, makeConstraint, stableSuffix } from './preference.js';
export { extractFieldOfStudy, extractGeography, extractGpa, extractInstitution, extractLicense };
export { RADIUS_CENTERS } from './radiusCenters.js';

/** Task 18 appends the remaining eight extractors to this list. */
export const AXIS_EXTRACTORS: AxisExtractor[] = [
  extractLicense,
  extractGeography,
  extractFieldOfStudy,
  extractInstitution,
  extractGpa,
];

export function extractConstraints(raw: RawOpportunity): Constraint[] {
  const out: Constraint[] = [];
  for (const extractor of AXIS_EXTRACTORS) out.push(...extractor(raw));
  return out;
}
