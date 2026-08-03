import type {
  DeadlineKind,
  DeadlineSpec,
  Instrument,
  ProgramStatus,
  RawOpportunity,
} from '@grantspotter/core';
import { RECURRENCE_PREFIX } from '@grantspotter/core';
import { sourceKeyOf } from './disputed.js';
import type { NormalizeContext } from './index.js';

/**
 * sourceId -> the CANONICAL Program id whose cycle its records inherit (RESOLUTIONS R9: Plan 4's
 * id list is canonical and Plan 5's seed corpus owns identity, so these are literals, never
 * minted ids). All 111 ARRL catalog entries share ONE deadline, owned by the ARRL Foundation
 * Scholarship Program. QCWA's intake is that same ARRL portal, so QCWA's real deadline lives
 * inside the ARRL cycle too.
 *
 * This only resolves if the seeded `arrl-foundation-scholarships` record carries
 * `sourceKey: { sourceId: 'arrl-scholarship-program', externalKey: 'scholarship-program' }`,
 * which is what makes `ctx.existingIdFor` hand this crawler that id instead of minting one.
 */
export const DEADLINE_INHERITANCE: Readonly<Record<string, string>> = Object.freeze({
  'arrl-scholarship-descriptions': 'arrl-foundation-scholarships',
  qcwa: 'arrl-foundation-scholarships',
});

/**
 * sourceId -> the RECUR directive that goes in DeadlineSpec.note (CONTRACT §10.1, RESOLUTIONS
 * R12). CONTRACT §3 freezes DeadlineSpec as { kind, source, note } with nowhere to put "which
 * four dates", so Plan 1 Task 5 defines this micro-format inside `note` and `parseRecurrence`
 * reads it back. THESE ARE LOAD-BEARING: `expandCycles` projects nothing without a directive,
 * so omitting them silently empties the calendar for the three programs that matter most.
 *
 * Everything after the first ` | ` is human prose the parser ignores. The directive kind MUST
 * equal the DeadlineKind we emit, or Plan 1 ignores it by design (a copy-paste accident must
 * not be able to invent deadlines) — `noteFor` below enforces that.
 */
export const RECURRENCE_BY_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  'ardc-grants':
    'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | ' +
    'Applications arriving after Sep 1 roll to the next Feb 1 cycle. ARDC evaluates for 60–120 days.',
  'arrl-amateur-radio-grants':
    'RECUR n_fixed_windows tz=America/New_York windows=02-01..02-28,06-01..06-30,10-01..10-31 | ' +
    'Three windows a year. Generally not more than $3,000, up to $5,000 in 2026.',
  'arrl-scholarship-program':
    'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | ' +
    'Opens about Oct 30 and closes Dec 30 at 12:00 PM Eastern. Moved from Jan 31 — never ' +
    'hardcode the old date.',
});

const KIND_BY_SOURCE: Readonly<Record<string, DeadlineKind>> = Object.freeze({
  'ardc-grants': 'n_fixed_dates', // Feb 1, Apr 1, Jul 1, Sep 1
  'arrl-amateur-radio-grants': 'n_fixed_windows', // Feb 1-28, Jun 1-30, Oct 1-31
  'arrl-scholarship-program': 'annual_window', // opens ~Oct 30, closes ~Dec 30 12:00 EST
  'arrl-etp-grants': 'annual_window', // Oct 1-31
  'arrl-club-grant': 'unpublished',
  ariss: 'quarterly_rewritten',
  'yaesu-dr2x': 'ad_hoc',
  'ncdxf-grants': 'rolling',
  'ncdxf-scholarships': 'unpublished',
  sara: 'rolling',
  'austin-arc': 'annual_window',
  ylrl: 'annual_window',
  'ieee-mtts': 'annual_window',
  'ieee-student-branch-rebate': 'annual_window',
  'nasa-csli': 'unpublished',
  'ardc-award-tables': 'dormant',
});

const NOTE_BY_KIND: Readonly<Record<DeadlineKind, string>> = Object.freeze({
  n_fixed_dates: 'Fixed application dates published by the funder.',
  n_fixed_windows: 'Fixed application windows published by the funder.',
  annual_window: 'A single annual window with an open date and a close date.',
  rolling: 'Applications are accepted at any time; the funder publishes no deadline.',
  quarterly_rewritten: 'One window sentence rewritten quarterly at a stable URL.',
  ad_hoc: 'Irregular windows announced by the funder with no fixed schedule.',
  inherited: 'This record has no deadline of its own; it rides another program’s cycle.',
  unpublished:
    'The funder has never published a deadline for this program. Deliberately left unresolved ' +
    'rather than guessed.',
  no_application_exists: 'There is no application and no deadline; the funder selects recipients.',
  dormant: 'Historical record; no live cycle.',
});

/**
 * The RECUR directive when this source has one AND it describes the kind we are about to emit;
 * the plain human note otherwise. The kind check is what stops a directive from leaking onto a
 * record whose kind was overridden by `rawFields.deadlineKind`.
 */
function noteFor(sourceId: string, kind: DeadlineKind): string {
  const directive = RECURRENCE_BY_SOURCE[sourceId];
  if (directive !== undefined && directive.startsWith(`${RECURRENCE_PREFIX}${kind} `)) {
    return directive;
  }
  return NOTE_BY_KIND[kind] ?? '';
}

export function inferDeadline(raw: RawOpportunity, ctx: NormalizeContext): DeadlineSpec {
  const declared = raw.rawFields.deadlineKind as DeadlineKind | undefined;
  if (declared) {
    return { kind: declared, source: { kind: 'self' }, note: noteFor(ctx.sourceId, declared) };
  }
  if (ctx.deadlineInheritsFrom) {
    return {
      kind: 'inherited',
      source: { kind: 'inherited', fromProgramId: ctx.deadlineInheritsFrom },
      note: NOTE_BY_KIND.inherited,
    };
  }
  const kind = KIND_BY_SOURCE[ctx.sourceId] ?? 'unpublished';
  return { kind, source: { kind: 'self' }, note: noteFor(ctx.sourceId, kind) };
}

/**
 * recordType values this function actually knows how to resolve. Anything else that shows up in
 * `rawFields.recordType` is, by definition, a value nobody taught this function about yet — see
 * the FIX ROUND 1 note on `inferStatus` below for why that must fail loud as 'unknown' rather
 * than silently fall through to 'open'.
 */
const KNOWN_RECORD_TYPES: ReadonlySet<string> = new Set([
  'past_award',
  'verified_negative',
  'crosscheck',
  'safety_warning',
  'manual',
  'guided_workflow',
]);

const KNOWN_PROGRAM_STATUSES: ReadonlySet<string> = new Set([
  'open',
  'closed',
  'dormant',
  'discontinued',
  'contact_only',
  'no_application',
  'unknown',
]);

/**
 * (sourceId, externalKey) pairs whose own prose says "contact-only" / "do not poll" but carry no
 * structured field the recordType/deadlineKind checks below can key on. rca-youth-activities'
 * rawText reads "Permanent contact-only entry; do not poll."
 *
 * FIX ROUND 1: a prior version of this function compared `ctx.sourceId` against the STRING
 * 'rca-scholarship-program' to catch that sibling record — which can never match, because
 * manual-tier-d.ts's SOURCE_ID is the constant 'manual-tier-d', and 'rca-scholarship-program' is
 * only that record's externalKey. That record actually resolves via the applicantEntity check
 * below (its rawFields.applicantEntity is 'nominated_by_institution'); this table exists for the
 * one Tier D record applicantEntity does not cover.
 */
const CONTACT_ONLY_RECORDS: ReadonlySet<string> = new Set([
  sourceKeyOf('manual-tier-d', 'rca-youth-activities'),
]);

/**
 * FIX ROUND 1 (Task 15 review, Critical). Before this fix, `far-farweb-org-compromised` — a
 * SAFETY WARNING that a compromised domain (farweb.org, now an Indonesian gambling site) is
 * still linked from live QCWA/ARRL/club pages — computed `status: 'open'`, because
 * `recordType: 'safety_warning'` fell through every branch below to the final `return 'open'`.
 * Plan 3 renders status badges and filters directly on `trust.status`, so that bug would have
 * tagged a domain-takeover warning as an open opportunity.
 *
 * Two changes close this:
 *   1. `rawFields.status` is now read as an explicit per-record override and wins over every
 *      inference below. far-farweb-org-compromised carries `status: 'discontinued'` for exactly
 *      this reason — that field existed since Task 15 shipped but was never read anywhere.
 *   2. The fallthrough at the bottom no longer defaults an UNRECOGNISED recordType to 'open'. A
 *      recordType this function has never heard of now resolves to 'unknown' — the same honest,
 *      already-rendered status this product uses everywhere else for "we don't know" — instead of
 *      the single most misleading label available. Only the genuine default path (no recordType
 *      set at all, the common case for a live-crawled record) still reaches plain 'open'.
 */
export function inferStatus(raw: RawOpportunity, ctx: NormalizeContext): ProgramStatus {
  const override = raw.rawFields.status;
  if (override !== undefined && KNOWN_PROGRAM_STATUSES.has(override)) {
    return override as ProgramStatus;
  }

  const recordType = raw.rawFields.recordType;
  switch (recordType) {
    case 'past_award':
      return 'closed';
    case 'verified_negative':
      return 'discontinued';
    case 'crosscheck':
      return 'unknown';
    case 'safety_warning':
      // Reached only when no rawFields.status override is present above.
      return 'discontinued';
    default:
      break;
  }

  if (raw.rawFields.deadlineKind === 'no_application_exists') return 'no_application';
  if (raw.rawFields.applicantEntity === 'nominated_by_institution') return 'contact_only';
  if (CONTACT_ONLY_RECORDS.has(sourceKeyOf(ctx.sourceId, raw.externalKey))) return 'contact_only';
  if (ctx.sourceId === 'nasa-csli' || ctx.sourceId === 'arrl-club-grant') return 'unknown';

  // A recordType WAS set, but nothing above resolved it — fail loud as 'unknown', never silently
  // 'open'.
  if (recordType !== undefined && !KNOWN_RECORD_TYPES.has(recordType)) return 'unknown';

  return 'open';
}

const INSTRUMENT_BY_SOURCE: Readonly<Record<string, Instrument>> = Object.freeze({
  'yaesu-dr2x': 'discounted_purchase',
  ariss: 'in_kind_service',
  'nasa-csli': 'in_kind_service',
  sara: 'in_kind_equipment',
  'arrl-etp-grants': 'in_kind_equipment',
  'ieee-student-branch-rebate': 'per_member_rebate',
  'ncdxf-scholarships': 'tuition_coverage',
});

export function inferInstrument(raw: RawOpportunity, ctx: NormalizeContext): Instrument {
  const bySource = INSTRUMENT_BY_SOURCE[ctx.sourceId];
  if (bySource) return bySource;
  const amountRaw = raw.rawFields['Award Amount'] ?? raw.rawFields.amountRaw ?? raw.rawFields.amount ?? '';
  if (amountRaw === '' || /^TBD$/i.test(amountRaw.trim())) return 'unknown';
  // 20 x $25,000, 4 x $15,000 ... — ARDC's tiered block is the only one in the corpus.
  if (/\$[\d,]+\s*,\s*\$[\d,]+\s*,\s*\$[\d,]+/.test(amountRaw)) return 'cash_tiered_blocks';
  if (/\bto\b|[-–]/.test(amountRaw) && (amountRaw.match(/\$/g) ?? []).length >= 2) return 'cash_range';
  if (amountRaw.includes('$')) return 'cash_fixed';
  return 'unknown';
}
