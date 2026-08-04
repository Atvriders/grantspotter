// PLAN-LOCAL to Plan 3. Not part of CONTRACT §3.
import type {
  ApplicantEntity, Cycle, Funder, Instrument, OpportunityClass,
  Program, ProgramStatus, Verdict,
} from '@grantspotter/core';

export type VerdictKind = 'eligible' | 'eligible_preferred' | 'ineligible' | 'unknown';

export type BrowseSort = 'deadline' | 'amount_desc' | 'name' | 'verified';

export interface BrowseFilters {
  klass: OpportunityClass[];
  entity: ApplicantEntity[];
  instrument: Instrument[];
  status: ProgramStatus[];
  verdict: VerdictKind[];
  deadlineFrom?: string;
  deadlineTo?: string;
  /** When a deadline window is set, rolling/undated programs drop out unless this is true. */
  includeRolling: boolean;
  amountMin?: number;
  amountMax?: number;
  q?: string;
  sort: BrowseSort;
  page: number;
  pageSize: number;
}

export const DEFAULT_FILTERS: BrowseFilters = {
  klass: [], entity: [], instrument: [], status: [], verdict: [],
  includeRolling: true, sort: 'deadline', page: 1, pageSize: 50,
};

export interface BrowseRow {
  program: Program;
  funderName: string;
  verdict: Verdict | null;
  nextOpensAt: string | null;
  nextClosesAt: string | null;
  nextIsEstimated: boolean;
  /**
   * IANA zone `nextOpensAt` / `nextClosesAt` are expressed in, or null when no
   * zone was recorded. Pass it to `formatDate` — it is what makes the browse row
   * render the funder's own calendar day.
   *
   * A deadline is the UTC instant of a LOCAL wall time: the ARRL's
   * "Feb 1-28, 2027 window" is `2027-03-01T04:59:00.000Z`, which prints
   * 2027-03-01 in UTC and 2027-02-28 in America/New_York. The UTC reading is
   * one day LATE, and late is the dangerous direction — it tells an applicant
   * they have a day they do not have. Until migration 037 this row carried no
   * zone at all, which is why the fix could not be made at the component level.
   *
   * Null means the zone is unknown, never "use the server's". Render such an
   * instant in UTC and label it; do not infer one.
   */
  nextTimezone: string | null;
  watched: boolean;
}

export interface BrowseSummary {
  total: number;
  eligible: number;
  preferred: number;
  ineligible: number;
  unknown: number;
  /** Constraint axes ranked by how many programs they exclude the user from. */
  ineligibleByAxis: Array<{ axis: string; count: number }>;
  /** Profile fields ranked by how many `unknown` verdicts filling them would resolve. */
  unknownByField: Array<{ field: string; count: number }>;
}

export interface BrowseResponse {
  rows: BrowseRow[];
  summary: BrowseSummary;
  page: number;
  pageSize: number;
  total: number;
  profileApplied: 'student' | 'organization' | null;
}

export interface FieldProvenance {
  fieldPath: string;
  sourceId: string;
  snapshotId: string | null;
  rawLabel: string;
  rawValue: string;
  fetchedAt: string;
  /**
   * The page this value was read off, or null when the row cannot be traced to
   * one. Added by Task 5: `sourceId` names the source MODULE and `snapshotId`
   * is nullable (Task 10's verify path always passes null), so without this
   * field the provenance panel can show a value and its label but no address a
   * professional could open to check it — which is the whole point of spec §8.
   * Null is rendered as "not traceable", never as an authoritative value.
   */
  sourceUrl: string | null;
}

export interface OpportunityDetail {
  program: Program;
  funder: Funder;
  cycles: Cycle[];
  provenance: FieldProvenance[];
  verdict: Verdict | null;
  watched: boolean;
  /** Non-null when this program inherits its deadline from another program. */
  deadlineOwner: { programId: string; programName: string } | null;
}
