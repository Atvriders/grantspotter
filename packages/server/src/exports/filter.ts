import type {
  ApplicantEntity,
  Cycle,
  Instrument,
  OpportunityClass,
  Program,
  ProgramStatus,
} from '@grantspotter/core';
// THE SHARED PREDICATE, NEVER A LOCAL COPY. `isDoNotPublish` is the only reader of
// `DO_NOT_PUBLISH_TAG`, so `grep isDoNotPublish` enumerates every place suppression is honoured.
// The four times this boundary leaked in this repo, the leaking read path had written its own.
import { isDoNotPublish } from '../normalize/index.js';

/**
 * PLAN-LOCAL TYPE. The CONTRACT does not define an export filter shape.
 * Plan 3 owns the browse-UI filter; this one is deliberately separate.
 */
export interface ExportFilter {
  q?: string;
  klass?: OpportunityClass[];
  status?: ProgramStatus[];
  applicantEntities?: ApplicantEntity[];
  instrument?: Instrument[];
  tags?: string[];
  closesAfter?: string; // ISO date, inclusive
  closesBefore?: string; // ISO date, inclusive
}

const KLASSES: OpportunityClass[] = [
  'ham_grant',
  'ham_scholarship',
  'adjacent_stem',
  'equipment_in_kind',
];
const STATUSES: ProgramStatus[] = [
  'open',
  'closed',
  'dormant',
  'discontinued',
  'contact_only',
  'no_application',
  'unknown',
];
const ENTITIES: ApplicantEntity[] = [
  'individual',
  'club_unincorporated',
  'club_501c3',
  'club_via_fiscal_sponsor',
  'school_lea',
  'university',
  'university_dept',
  'ieee_student_branch_chapter',
  'teacher',
  'nominated_by_institution',
];
const INSTRUMENTS: Instrument[] = [
  'cash_range',
  'cash_fixed',
  'cash_tiered_blocks',
  'in_kind_equipment',
  'in_kind_service',
  'discounted_purchase',
  'per_member_rebate',
  'tuition_coverage',
  'unknown',
];

function values(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter((s) => s.length > 0);
  if (typeof raw === 'string')
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  return [];
}

function enumValues<T extends string>(raw: unknown, allowed: T[]): T[] | undefined {
  const picked = values(raw).filter((v): v is T => (allowed as string[]).includes(v));
  return picked.length > 0 ? picked : undefined;
}

export function parseExportFilter(query: Record<string, unknown>): ExportFilter {
  const filter: ExportFilter = {};
  if (typeof query.q === 'string' && query.q.trim().length > 0) filter.q = query.q.trim();
  const klass = enumValues(query.klass, KLASSES);
  if (klass) filter.klass = klass;
  const status = enumValues(query.status, STATUSES);
  if (status) filter.status = status;
  const entities = enumValues(query.applicantEntities, ENTITIES);
  if (entities) filter.applicantEntities = entities;
  const instrument = enumValues(query.instrument, INSTRUMENTS);
  if (instrument) filter.instrument = instrument;
  const tags = values(query.tags);
  if (tags.length > 0) filter.tags = tags;
  if (typeof query.closesAfter === 'string' && query.closesAfter.length > 0)
    filter.closesAfter = query.closesAfter;
  if (typeof query.closesBefore === 'string' && query.closesBefore.length > 0)
    filter.closesBefore = query.closesBefore;
  return filter;
}

/**
 * THE GATE. Not a filter option — there is no argument that turns it off.
 *
 * ~553 of the 703 records this product stores are EVIDENCE, not opportunities: past ARDC, NSF and
 * USAspending awards, the 37 ARRL clubs already funded, the cross-check rows from a stale summary
 * page. They are kept on purpose (a funder's grant history is the best evidence of who that funder
 * funds) and shown to nobody. 150 are publishable.
 *
 * That boundary has leaked FOUR times here, and every time the leaking read path had written its
 * own filter instead of calling `isDoNotPublish`: the detail route answered 200 for all of them,
 * the corpus profiler measured 742 instead of 197, the completeness meter scored 58 of 703 instead
 * of 58 of 150, and the verify route both leaked content and triggered live refetches.
 *
 * AN EXPORT IS A READ PATH, AND IT IS THE ONE THAT LEAVES THE BUILDING. A CSV mailed to a
 * colleague or opened in a spreadsheet is the least recoverable place a suppressed record could
 * appear. So every export path in this package runs through here — `applyExportFilter` calls it
 * before any user-supplied predicate, and `buildExportRows` calls it again, which is free because
 * it is idempotent and means a format that skips the filter still cannot render one.
 */
export function exportablePrograms(programs: readonly Program[]): Program[] {
  return programs.filter((p) => !isDoNotPublish(p));
}

function matchesText(program: Program, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    program.name.toLowerCase().includes(needle) ||
    program.summary.toLowerCase().includes(needle) ||
    program.id.toLowerCase().includes(needle) ||
    program.tags.some((t) => t.toLowerCase().includes(needle))
  );
}

function inWindow(cycles: Cycle[] | undefined, after?: string, before?: string): boolean {
  if (!after && !before) return true;
  if (!cycles || cycles.length === 0) return false;
  return cycles.some((c) => {
    const date = c.closesAt ?? c.opensAt;
    if (!date) return false;
    const day = date.slice(0, 10);
    if (after && day < after) return false;
    if (before && day > before) return false;
    return true;
  });
}

/**
 * The user's filter, applied to what the user is allowed to export. The gate runs FIRST and
 * unconditionally, so no combination of query parameters — including asking for the suppression
 * tag by name — can surface a hidden record.
 */
export function applyExportFilter(
  programs: readonly Program[],
  filter: ExportFilter,
  cyclesByProgramId: ReadonlyMap<string, Cycle[]>,
): Program[] {
  return exportablePrograms(programs).filter((p) => {
    if (filter.q && !matchesText(p, filter.q)) return false;
    if (filter.klass && !filter.klass.includes(p.klass)) return false;
    if (filter.status && !filter.status.includes(p.trust.status)) return false;
    if (
      filter.applicantEntities &&
      !p.applicantEntities.some((e) => filter.applicantEntities!.includes(e))
    )
      return false;
    if (filter.instrument && !filter.instrument.includes(p.amount.instrument)) return false;
    if (filter.tags && !p.tags.some((t) => filter.tags!.includes(t))) return false;
    if (!inWindow(cyclesByProgramId.get(p.id), filter.closesAfter, filter.closesBefore))
      return false;
    return true;
  });
}
