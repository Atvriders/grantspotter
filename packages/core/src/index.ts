export const CORE_VERSION = '0.1.0';

// Domain types (CONTRACT §3) and their zod mirrors.
export * from './types.js';
export * from './schema.js';

// Reference data.
export { ARRL_DIVISIONS, ARRL_SECTIONS } from './arrlSections.js';
export type { ArrlSection } from './arrlSections.js';

// CONTRACT §4 — amounts.
export { AWARD_ANCHOR, NON_AWARD_CONTEXT_TERMS, parseAmount } from './amount.js';

// CONTRACT §4 — deadlines, plus the RECUR notation Plans 2 and 5 emit.
export {
  DEFAULT_CLOSE_TIME,
  DEFAULT_OPEN_TIME,
  expandCycles,
  observedCycles,
  OBSERVED_WINDOW_MARKER,
  parseObservedWindow,
  parseRecurrence,
  RECURRENCE_PREFIX,
  RecurrenceParseError,
  resolveDeadlineOwner,
  zonedWallTimeToUtcISO,
} from './deadline.js';
export type { DateWindow, MonthDay, ObservedWindow, Recurrence, TimeOfDay } from './deadline.js';

// CONTRACT §4 — geography.
export {
  callDistrictFromCallsign,
  evaluateGeo,
  haversineMiles,
  statesForArrlDivision,
  statesForArrlSection,
  withinRadius,
} from './geo.js';
export type { GeoDecision, GeoLocation } from './geo.js';

// CONTRACT §4 — matcher.
export {
  ageAt,
  APPLICANT_ENTITY_AXIS_LABEL,
  APPLICANT_ENTITY_CONSTRAINT_SUFFIX,
  APPLICANT_ENTITY_WORDING,
  applicantEntityListLabel,
  evaluateConstraint,
  hasFunderWording,
  isApplicantEntityConstraint,
  matchAll,
  matchProgram,
  monthsBetween,
} from './matcher.js';
export type { AxisResult, AxisStatus } from './matcher.js';

// CONTRACT §4 — content hashing. sha256.ts stays internal on purpose.
export { hashProgram } from './hash.js';

// Maidenhead locators. Deliberately NOT folded into the geography block above: `geo.ts` answers
// "does this location satisfy this rule", while a locator is a BOX and the three questions asked
// of it (centre, bounds, contains) have to stay distinguishable at the call site.
// `checkCoordinateAgainstLocator` is the one that earns its keep — callook states a coordinate
// AND a grid square, and a coordinate outside its own square means the record disagrees with
// itself.
export {
  boxContainsCoordinate,
  boxRepresentativePoint,
  canonicalMaidenhead,
  checkCoordinateAgainstLocator,
  coordinateToLocator,
  MAIDENHEAD_PRECISIONS,
  MAIDENHEAD_SPAN_DEG,
  maidenheadBox,
  maidenheadRepresentativePoint,
  parseMaidenhead,
  wrapLongitudeDeg,
} from './maidenhead.js';
export type {
  CoordinateRejection,
  LocatorAgreement,
  MaidenheadBox,
  MaidenheadParse,
  MaidenheadPrecision,
  MaidenheadRejection,
  MaidenheadRepresentativePoint,
} from './maidenhead.js';
