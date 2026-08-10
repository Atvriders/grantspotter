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
  APPLICANT_ENTITY_CONSTRAINT_SUFFIX,
  evaluateConstraint,
  matchAll,
  matchProgram,
  monthsBetween,
} from './matcher.js';
export type { AxisResult, AxisStatus } from './matcher.js';

// CONTRACT §4 — content hashing. sha256.ts stays internal on purpose.
export { hashProgram } from './hash.js';

// Enrolment codes: the normalisation and the policy on a code an administrator TYPES. Shared
// because the admin console has to show what a chosen code will be stored as before it is saved,
// and `web -> server` is not a direction this repository allows. The generator and the digest are
// not here — they need node:crypto and stay in `server/db/repositories/enrollmentCodes.ts`.
export {
  CHOSEN_CODE_MAX_DAYS,
  CHOSEN_CODE_MAX_INPUT,
  CHOSEN_CODE_MIN_LENGTH,
  describeEnrollmentCodeFold,
  ENROLLMENT_CODE_ALPHABET,
  ENROLLMENT_CODE_FOLD,
  exhaustionChance,
  groupThousands,
  labelRepeatsChosenCode,
  MEASURED_GUESSES_PER_SECOND,
  normalizeEnrollmentCode,
} from './enrollmentCode.js';
