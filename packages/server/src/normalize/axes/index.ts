import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { extractAgeStage } from './ageStage.js';
import { extractCitizenship } from './citizenship.js';
import { extractFieldOfStudy } from './fieldOfStudy.js';
import { extractFinancialNeed } from './financialNeed.js';
import { extractGender } from './gender.js';
import { extractGeography } from './geography.js';
import { extractGpa } from './gpa.js';
import { extractHamActivity } from './hamActivity.js';
import { extractInstitution } from './institution.js';
import { extractLicense } from './license.js';
import { extractArrlMembership } from './membership.js';
import { extractOther } from './other.js';
import { extractRecommendation } from './recommendation.js';

export type AxisExtractor = (raw: RawOpportunity) => Constraint[];

export { cascadeRank, isPreferenceText, makeConstraint, stableSuffix } from './preference.js';
export { extractFieldOfStudy, extractGeography, extractGpa, extractInstitution, extractLicense };
export {
  extractAgeStage,
  extractArrlMembership,
  extractCitizenship,
  extractFinancialNeed,
  extractGender,
  extractHamActivity,
  extractOther,
  extractRecommendation,
};
export { RADIUS_CENTERS } from './radiusCenters.js';

export const AXIS_EXTRACTORS: AxisExtractor[] = [
  extractLicense,
  extractGeography,
  extractFieldOfStudy,
  extractInstitution,
  extractGpa,
  extractArrlMembership,
  extractRecommendation,
  extractCitizenship,
  extractAgeStage,
  extractHamActivity,
  extractFinancialNeed,
  extractGender,
  extractOther,
];

export function extractConstraints(raw: RawOpportunity): Constraint[] {
  const out: Constraint[] = [];
  for (const extractor of AXIS_EXTRACTORS) out.push(...extractor(raw));
  return out;
}
