/**
 * The browse query, held in the URL and nowhere else.
 *
 * The URL is the single source of truth for what the user is looking at: it is shareable, it
 * survives a reload, and it is what `GET /api/programs` is asked for. There is no second copy in
 * component state to drift out of step with it.
 *
 * THE FACET LISTS ARE TYPED AGAINST CONTRACT §3'S UNIONS. Each label map is a
 * `Record<Union, string>`, so a value added to `OpportunityClass`, `ApplicantEntity`, `Instrument`
 * or `ProgramStatus` fails to compile here rather than becoming a facet that exists in the corpus,
 * is offered by no checkbox, and — because the server drops unknown values — answers "no results"
 * forever. `packages/server/src/api/programsRouter.ts` records the same reasoning for its side of
 * the wire; this is the browser half of it. The options offered are derived from the label maps,
 * never restated beside them.
 */
import type {
  ApplicantEntity,
  Instrument,
  OpportunityClass,
  ProgramStatus,
} from '@grantspotter/core';

/** Plan-3-local, mirroring `packages/server/src/api/browseTypes.ts`. Web never imports server. */
export type VerdictKind = 'eligible' | 'eligible_preferred' | 'ineligible' | 'unknown';
export type BrowseSort = 'deadline' | 'amount_desc' | 'name' | 'verified';

export const KLASS_LABELS: Record<OpportunityClass, string> = {
  ham_grant: 'Ham grant',
  ham_scholarship: 'Ham scholarship',
  adjacent_stem: 'Adjacent STEM / RF',
  equipment_in_kind: 'Equipment & in-kind',
};

export const ENTITY_LABELS: Record<ApplicantEntity, string> = {
  individual: 'Individual',
  club_unincorporated: 'Club (unincorporated)',
  club_501c3: 'Club (501(c)(3))',
  club_via_fiscal_sponsor: 'Club via fiscal sponsor',
  school_lea: 'School / district',
  university: 'University',
  university_dept: 'University department',
  ieee_student_branch_chapter: 'IEEE student branch chapter',
  teacher: 'Teacher',
  nominated_by_institution: 'Nominated by institution',
};

export const INSTRUMENT_LABELS: Record<Instrument, string> = {
  cash_range: 'Cash range',
  cash_fixed: 'Cash, fixed',
  cash_tiered_blocks: 'Cash, tiered blocks',
  in_kind_equipment: 'Equipment',
  in_kind_service: 'Service',
  discounted_purchase: 'Discounted purchase',
  per_member_rebate: 'Per-member rebate',
  tuition_coverage: 'Tuition coverage',
  unknown: 'Unknown',
};

export const STATUS_LABELS: Record<ProgramStatus, string> = {
  open: 'Open',
  closed: 'Closed',
  dormant: 'Dormant',
  discontinued: 'Discontinued',
  contact_only: 'Contact only',
  no_application: 'No application exists',
  unknown: 'Unknown',
};

export const VERDICT_LABELS: Record<VerdictKind, string> = {
  eligible: 'Eligible',
  eligible_preferred: 'Preferred',
  ineligible: 'Ineligible',
  unknown: 'Unknown',
};

export const SORT_LABELS: Record<BrowseSort, string> = {
  deadline: 'Next deadline',
  amount_desc: 'Largest award',
  name: 'Name',
  verified: 'Most recently verified',
};

export interface UiFilters {
  klass: OpportunityClass[];
  entity: ApplicantEntity[];
  instrument: Instrument[];
  status: ProgramStatus[];
  verdict: VerdictKind[];
  deadlineFrom?: string;
  deadlineTo?: string;
  /** When a deadline window is set, rolling and undated programs drop out unless this is true. */
  includeRolling: boolean;
  amountMin?: number;
  amountMax?: number;
  q?: string;
  sort: BrowseSort;
  page: number;
}

export const EMPTY_FILTERS: UiFilters = {
  klass: [],
  entity: [],
  instrument: [],
  status: [],
  verdict: [],
  includeRolling: true,
  sort: 'deadline',
  page: 1,
};

/** The five faceted keys, paired with the label map that defines their legal values. */
export const FACETS = [
  { key: 'klass', legend: 'Opportunity class', labels: KLASS_LABELS },
  { key: 'entity', legend: 'Applicant entity', labels: ENTITY_LABELS },
  { key: 'instrument', legend: 'Instrument', labels: INSTRUMENT_LABELS },
  { key: 'status', legend: 'Status', labels: STATUS_LABELS },
  { key: 'verdict', legend: 'Matcher verdict', labels: VERDICT_LABELS },
] as const;

export type FacetKey = (typeof FACETS)[number]['key'];

export function filtersToSearchParams(f: UiFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const facet of FACETS) {
    const values: readonly string[] = f[facet.key];
    if (values.length > 0) params.set(facet.key, values.join(','));
  }
  if (f.deadlineFrom !== undefined && f.deadlineFrom !== '') {
    params.set('deadlineFrom', f.deadlineFrom);
  }
  if (f.deadlineTo !== undefined && f.deadlineTo !== '') params.set('deadlineTo', f.deadlineTo);
  if (!f.includeRolling) params.set('includeRolling', 'false');
  if (f.amountMin !== undefined) params.set('amountMin', String(f.amountMin));
  if (f.amountMax !== undefined) params.set('amountMax', String(f.amountMax));
  if (f.q !== undefined && f.q !== '') params.set('q', f.q);
  if (f.sort !== EMPTY_FILTERS.sort) params.set('sort', f.sort);
  if (f.page !== 1) params.set('page', String(f.page));
  return params;
}

/**
 * A comma-separated facet, filtered to the values this build actually offers.
 *
 * The server drops anything it does not recognise, so a URL carrying a stale or hand-typed value
 * would otherwise produce a result set that silently disagrees with the checkboxes on screen.
 * `Object.hasOwn` rather than `in`, so `?klass=constructor` is not a legal facet value.
 */
function list<T extends string>(
  params: URLSearchParams,
  key: string,
  labels: Record<T, string>,
): T[] {
  const raw = params.get(key);
  if (raw === null || raw === '') return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is T => Object.hasOwn(labels, value));
}

/**
 * A whole number, or undefined.
 *
 * `Number('')` is **0**, not NaN, so a bare `Number.isFinite` guard reads `?page=` as page zero
 * (an empty result for a URL that asked for nothing) and `?amountMin=` as a real $0 floor nobody
 * typed. An empty string means "absent", which is what the caller has to see.
 */
function int(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function isSort(value: string | null): value is BrowseSort {
  return value !== null && Object.hasOwn(SORT_LABELS, value);
}

export function searchParamsToFilters(params: URLSearchParams): UiFilters {
  const sort = params.get('sort');
  const filters: UiFilters = {
    klass: list(params, 'klass', KLASS_LABELS),
    entity: list(params, 'entity', ENTITY_LABELS),
    instrument: list(params, 'instrument', INSTRUMENT_LABELS),
    status: list(params, 'status', STATUS_LABELS),
    verdict: list(params, 'verdict', VERDICT_LABELS),
    includeRolling: params.get('includeRolling') !== 'false',
    sort: isSort(sort) ? sort : EMPTY_FILTERS.sort,
    // Page 0 would slice the wrong end of the result set on the server; a negative page is the
    // same mistake with a sign on it.
    page: Math.max(1, int(params, 'page') ?? 1),
  };
  const deadlineFrom = params.get('deadlineFrom');
  const deadlineTo = params.get('deadlineTo');
  const amountMin = int(params, 'amountMin');
  const amountMax = int(params, 'amountMax');
  const q = params.get('q');
  if (deadlineFrom !== null && deadlineFrom !== '') filters.deadlineFrom = deadlineFrom;
  if (deadlineTo !== null && deadlineTo !== '') filters.deadlineTo = deadlineTo;
  if (amountMin !== undefined) filters.amountMin = amountMin;
  if (amountMax !== undefined) filters.amountMax = amountMax;
  if (q !== null && q !== '') filters.q = q;
  return filters;
}

/** True when the deadline window is excluding rolling and undated programs. */
export function hidesRollingPrograms(f: UiFilters): boolean {
  return !f.includeRolling && (f.deadlineFrom !== undefined || f.deadlineTo !== undefined);
}
