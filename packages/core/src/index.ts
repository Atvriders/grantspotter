export const CORE_VERSION = '0.1.0';

export * from './types.js';
export * from './schema.js';
export { hashProgram } from './hash.js';
export { AWARD_ANCHOR, AWARD_ANCHOR_AFTER, NON_AWARD_CONTEXT_TERMS, parseAmount } from './amount.js';
export {
  DEFAULT_CLOSE_TIME,
  DEFAULT_OPEN_TIME,
  parseRecurrence,
  RECURRENCE_PREFIX,
  RecurrenceParseError,
  resolveDeadlineOwner,
  zonedWallTimeToUtcISO,
} from './deadline.js';
export type { DateWindow, MonthDay, Recurrence, TimeOfDay } from './deadline.js';
export { ARRL_DIVISIONS, ARRL_SECTIONS } from './arrlSections.js';
export type { ArrlSection } from './arrlSections.js';
export {
  callDistrictFromCallsign,
  evaluateGeo,
  haversineMiles,
  statesForArrlDivision,
  statesForArrlSection,
  withinRadius,
} from './geo.js';
export type { GeoDecision, GeoLocation } from './geo.js';
export { expandCycles } from './deadline.js';
export { ageAt, evaluateConstraint, monthsBetween } from './matcher.js';
export type { AxisResult, AxisStatus } from './matcher.js';
export { APPLICANT_ENTITY_CONSTRAINT_SUFFIX, matchAll, matchProgram } from './matcher.js';
