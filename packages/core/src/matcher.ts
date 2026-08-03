import { evaluateGeo } from './geo.js';
import type {
  ActivityKind,
  ApplicantEntity,
  Citizenship,
  Constraint,
  ConstraintSpec,
  DegreeLevel,
  LicenseClass,
  OrgProfile,
  Profile,
  Program,
  Stage,
  StudentProfile,
  Verdict,
} from './types.js';

export type AxisStatus = 'pass' | 'fail' | 'unknown' | 'not_evaluable';

export interface AxisResult {
  status: AxisStatus;
  /** Profile fields that would resolve an `unknown`. Empty otherwise. */
  missing: string[];
}

const PASS: AxisResult = { status: 'pass', missing: [] };
const FAIL: AxisResult = { status: 'fail', missing: [] };
const NOT_EVALUABLE: AxisResult = { status: 'not_evaluable', missing: [] };

function unknown(...fields: string[]): AxisResult {
  return { status: 'unknown', missing: fields };
}

const LICENSE_RANK: Record<LicenseClass, number> = { NONE: 0, TECH: 1, GENERAL: 2, EXTRA: 3 };

/** Whole calendar months from `fromISO` to `toISO`; negative if `toISO` is earlier. */
export function monthsBetween(fromISO: string, toISO: string): number {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
  let months =
    (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

export function ageAt(birthISO: string, atISO: string): number {
  return Math.floor(monthsBetween(birthISO, atISO) / 12);
}

/**
 * `asOf` is either an MM-DD (resolved against the current year, e.g. YCCC's
 * "22 or younger as of June 1") or a full ISO date. Anything else falls back
 * to "now".
 */
function asOfDateISO(asOf: string | undefined, nowISO: string): string {
  if (asOf === undefined) return nowISO;
  if (/^\d{2}-\d{2}$/.test(asOf)) {
    const year = new Date(nowISO).getUTCFullYear();
    return `${year}-${asOf}T00:00:00.000Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(asOf)) return asOf;
  return nowISO;
}

function normText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ /g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isStudent(profile: Profile): profile is StudentProfile {
  return profile.kind === 'student';
}

function isOrg(profile: Profile): profile is OrgProfile {
  return profile.kind === 'organization';
}

export function evaluateConstraint(
  spec: ConstraintSpec,
  profile: Profile,
  nowISO: string,
): AxisResult {
  switch (spec.axis) {
    case 'license': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const needed = LICENSE_RANK[spec.licenseMin];
      if (needed > 0) {
        if (profile.licenseClass === undefined) return unknown('licenseClass');
        if (LICENSE_RANK[profile.licenseClass] < needed) return FAIL;
      }
      if (spec.heldMonthsMin !== undefined && spec.heldMonthsMin > 0) {
        if (profile.licensedSince === undefined) return unknown('licensedSince');
        if (monthsBetween(profile.licensedSince, nowISO) < spec.heldMonthsMin) return FAIL;
      }
      // foreignLicenseOK is informational: CONTRACT §3 has no profile field for it.
      return PASS;
    }

    case 'geography': {
      const decision = evaluateGeo(spec.geo, {
        state: profile.state,
        county: isStudent(profile) ? profile.county : undefined,
        lat: profile.lat,
        lon: profile.lon,
        callDistrict: isStudent(profile) ? profile.callDistrict : undefined,
        callsign: profile.callsign,
      });
      return { status: decision.status, missing: decision.missing };
    }

    case 'field_of_study': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      if (profile.fieldOfStudy === undefined) {
        if (spec.fields.length === 0 && spec.excludedFields.length === 0) return PASS;
        return unknown('fieldOfStudy');
      }
      const mine = normText(profile.fieldOfStudy);
      if (spec.excludedFields.some((f) => normText(f) === mine)) return FAIL;
      if (spec.fields.length === 0) return PASS;
      if (spec.fields.some((f) => normText(f) === 'any')) return PASS;
      return spec.fields.some((f) => normText(f) === mine) ? PASS : FAIL;
    }

    case 'institution': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      if (spec.degreeLevels.length > 0) {
        if (profile.degreeLevel === undefined) return unknown('degreeLevel');
        const levels: DegreeLevel[] = spec.degreeLevels;
        if (!levels.includes(profile.degreeLevel)) return FAIL;
      }
      if (spec.accreditationRequired) {
        if (profile.accredited === undefined) return unknown('accredited');
        if (!profile.accredited) return FAIL;
      }
      if (!spec.partTimeOK) {
        if (profile.partTime === undefined) return unknown('partTime');
        if (profile.partTime) return FAIL;
      }
      // tradeSchoolOK is informational: CONTRACT §3 has no profile field for it.
      return PASS;
    }

    case 'gpa': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const results: AxisStatus[] = [];
      const missing: string[] = [];
      if (spec.min !== undefined) {
        if (profile.gpa === undefined) {
          results.push('unknown');
          missing.push('gpa');
        } else {
          results.push(profile.gpa >= spec.min ? 'pass' : 'fail');
        }
      }
      if (spec.classRankTopPct !== undefined) {
        if (profile.classRankTopPct === undefined) {
          results.push('unknown');
          missing.push('classRankTopPct');
        } else {
          results.push(profile.classRankTopPct <= spec.classRankTopPct ? 'pass' : 'fail');
        }
      }
      if (results.length === 0) return PASS;
      if (results.includes('pass')) return PASS; // either route satisfies the axis
      if (results.includes('unknown')) return { status: 'unknown', missing };
      return FAIL;
    }

    case 'arrl_membership': {
      if (!spec.required) return NOT_EVALUABLE;
      if (isOrg(profile)) {
        if (profile.arrlAffiliated === undefined) return unknown('arrlAffiliated');
        return profile.arrlAffiliated ? PASS : FAIL;
      }
      if (profile.arrlMemberSince === undefined) return unknown('arrlMemberSince');
      if (spec.minYears > 0 && monthsBetween(profile.arrlMemberSince, nowISO) < spec.minYears * 12) {
        return FAIL;
      }
      return PASS;
    }

    case 'recommendation':
      // No profile field can answer this. Plan 3 renders Constraint.rawText.
      return NOT_EVALUABLE;

    case 'citizenship': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const allowed: Citizenship[] = spec.allowed;
      if (allowed.includes('ANY')) return PASS;
      if (profile.citizenship === undefined) return unknown('citizenship');
      if (allowed.includes(profile.citizenship)) return PASS;
      if (profile.citizenship === 'US_CITIZEN' && allowed.includes('US_RESIDENT')) return PASS;
      // withinMonthsOfCitizenship is informational: no profile field exists.
      return FAIL;
    }

    case 'age_stage': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const missing: string[] = [];
      let failed = false;
      const stages: Stage[] = spec.stages;
      if (stages.length > 0) {
        if (profile.stage === undefined) missing.push('stage');
        else if (!stages.includes(profile.stage)) failed = true;
      }
      if (spec.ageMin !== undefined || spec.ageMax !== undefined) {
        if (profile.birthDate === undefined) {
          missing.push('birthDate');
        } else {
          const age = ageAt(profile.birthDate, asOfDateISO(spec.asOf, nowISO));
          if (spec.ageMin !== undefined && age < spec.ageMin) failed = true;
          if (spec.ageMax !== undefined && age > spec.ageMax) failed = true;
        }
      }
      if (failed) return FAIL;
      if (missing.length > 0) return { status: 'unknown', missing };
      return PASS;
    }

    case 'ham_activity': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      const missing: string[] = [];
      let failed = false;
      const mine = profile.activityKinds;
      const wanted: ActivityKind[] = spec.activityKinds;
      if (wanted.length > 0) {
        if (mine === undefined) missing.push('activityKinds');
        else if (!wanted.some((k) => mine.includes(k))) failed = true;
      }
      if (spec.cwProficiencyWpmMin !== undefined) {
        if (profile.cwWpm === undefined) missing.push('cwWpm');
        else if (profile.cwWpm < spec.cwProficiencyWpmMin) failed = true;
      }
      if (failed) return FAIL;
      if (missing.length > 0) return { status: 'unknown', missing };
      // proofRequired is informational.
      return PASS;
    }

    case 'financial_need': {
      // Spec §4.5 rule 11: always a weighting, never a bar. This axis can
      // never return `fail`, whatever `Constraint.hard` says.
      if (!isStudent(profile)) return NOT_EVALUABLE;
      return profile.financialNeed === true ? PASS : NOT_EVALUABLE;
    }

    case 'gender': {
      if (!isStudent(profile)) return NOT_EVALUABLE;
      if (spec.allowed.includes('any')) return PASS;
      if (
        profile.gender === undefined ||
        profile.gender === 'other' ||
        profile.gender === 'prefer_not_to_say'
      ) {
        // Refuse to guess. The UI shows the funder's own wording instead.
        return unknown('gender');
      }
      return spec.allowed.includes(profile.gender) ? PASS : FAIL;
    }

    case 'other':
      // Long-tail requirements no schema captures. Plan 3 renders rawText.
      return NOT_EVALUABLE;
  }
}

export const APPLICANT_ENTITY_CONSTRAINT_SUFFIX = ':applicant-entity';

/**
 * `evaluateGeo`'s `county` and `call_district` axes report their missing
 * field as `'county'` / `'callDistrict'` regardless of profile kind, but
 * neither name is a field on `OrgProfile` (only `StudentProfile` has them —
 * `matcher.ts`'s `geography` case even forces both to `undefined` for
 * non-student profiles). For an organisation, that `unknown` is therefore
 * permanently unresolvable: the UI could never find a matching input to
 * jump to. Known carry-forward finding from Task 8 — handled here by
 * treating those two field names as not-evaluable (silently dropped from
 * `missingProfileFields`) whenever the profile is an organisation, rather
 * than letting them surface as an actionable-looking missing field.
 */
const ORG_UNRESOLVABLE_GEO_FIELDS = new Set(['county', 'callDistrict']);

function isResolvableMissingField(profile: Profile, field: string): boolean {
  if (isOrg(profile) && ORG_UNRESOLVABLE_GEO_FIELDS.has(field)) return false;
  return true;
}

function applicantEntityConstraint(program: Program, applyingAs: ApplicantEntity): Constraint {
  const accepted =
    program.applicantEntities.length > 0
      ? program.applicantEntities.join(', ')
      : '(none recorded)';
  return {
    id: `${program.id}${APPLICANT_ENTITY_CONSTRAINT_SUFFIX}`,
    hard: true,
    fallbackRank: 0,
    rawText: `This program accepts applications from: ${accepted}.`,
    spec: {
      axis: 'other',
      note: `Your profile applies as "${applyingAs}", which this program does not accept.`,
    },
  };
}

/**
 * Verdict precedence, most decisive first — deliberate, and each rule has a
 * dedicated test in `matcher.test.ts`:
 *
 * 1. The applicant-entity gate. Wrong entity type is definite and immediate:
 *    an RCA nominee-only program can never accept a direct student
 *    application no matter what else is true, so this is checked before any
 *    per-axis constraint and short-circuits everything below.
 * 2. Any hard `fail` -> `ineligible`. A hard fail is a definite, provable
 *    exclusion (e.g. GPA below the floor) and outranks mere uncertainty:
 *    filling in a missing field can never undo a fact already known to be
 *    false, so `ineligible` beats `unknown` when both are present.
 * 3. Any hard `unknown` -> `unknown`. Nothing is definitely wrong, but the
 *    axis can't be decided without more profile data.
 * 4. Any soft `pass` -> `eligible_preferred`. Soft constraints never
 *    exclude (rule stated in the brief and enforced below); they only
 *    promote a candidate that is otherwise fully eligible.
 * 5. Otherwise -> `eligible`.
 *
 * Hard `not_evaluable` is treated as a pass (it cannot block — there is no
 * schema field to ever resolve it, e.g. `recommendation`/`other`). Soft
 * `fail`, `unknown` and `not_evaluable` are all simply "not met": a soft
 * `unknown` must NOT escalate the verdict to `unknown`, or every program
 * with an unanswered preference axis would demand a profile field before
 * showing any result at all — defeating the point of preferences being
 * optional upside, not gates.
 */
export function matchProgram(
  profile: Profile,
  program: Program,
  nowISO: string = new Date().toISOString(),
): Verdict {
  const applyingAs: ApplicantEntity = isStudent(profile) ? 'individual' : profile.entity;
  if (!program.applicantEntities.includes(applyingAs)) {
    return { kind: 'ineligible', reasons: [applicantEntityConstraint(program, applyingAs)] };
  }

  const hardFailures: Constraint[] = [];
  const missingFields = new Set<string>();
  const metPreferences: Constraint[] = [];

  for (const constraint of program.constraints) {
    // Financial need is always a weighting, never a bar (spec §4.5 rule 11),
    // so it is forced soft whatever the record says.
    const isSoft = !constraint.hard || constraint.spec.axis === 'financial_need';
    const result = evaluateConstraint(constraint.spec, profile, nowISO);

    if (isSoft) {
      if (result.status === 'pass') metPreferences.push(constraint);
      continue;
    }
    if (result.status === 'fail') {
      hardFailures.push(constraint);
    } else if (result.status === 'unknown') {
      for (const field of result.missing) {
        if (isResolvableMissingField(profile, field)) missingFields.add(field);
      }
    }
    // 'pass' and 'not_evaluable' do not block.
  }

  if (hardFailures.length > 0) return { kind: 'ineligible', reasons: hardFailures };
  if (missingFields.size > 0) {
    return { kind: 'unknown', missingProfileFields: [...missingFields].sort() };
  }
  if (metPreferences.length > 0) {
    return {
      kind: 'eligible_preferred',
      rank: Math.min(...metPreferences.map((c) => c.fallbackRank)),
      met: metPreferences.map((c) => c.id).sort(),
    };
  }
  return { kind: 'eligible' };
}

export function matchAll(
  profile: Profile,
  programs: Program[],
  nowISO: string = new Date().toISOString(),
): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();
  for (const program of programs) verdicts.set(program.id, matchProgram(profile, program, nowISO));
  return verdicts;
}
