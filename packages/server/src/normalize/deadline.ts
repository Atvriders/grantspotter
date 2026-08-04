import type {
  DeadlineKind,
  DeadlineSpec,
  Instrument,
  ProgramStatus,
  RawOpportunity,
} from '@grantspotter/core';
import { RECURRENCE_PREFIX } from '@grantspotter/core';
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
  // ROUND 4. Was 'annual_window' — a shape nobody has stated. The captured page
  // (fixtures/ylrl/) publishes no month, no day and no window anywhere: it describes the
  // scholarships and points at ylrl.net/apply/, which is why the parser refuses to write a
  // `window` field for it at all (sources/tier-c-a.test.ts asserts that against the real page).
  // 'unpublished' is the one honest value for a deadline nobody has stated: it is also the only
  // one that keeps `expandCycles` from being handed a projectable kind with no dates to project,
  // and `inferStatus` below refuses to call an explicitly-unpublished programme 'open'.
  ylrl: 'unpublished',
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
 * FIX ROUND 1 (Task 15 review, Critical). Before this fix, `far-farweb-org-compromised` — a
 * SAFETY WARNING that a compromised domain (farweb.org, now an Indonesian gambling site) is
 * still linked from live QCWA/ARRL/club pages — computed `status: 'open'`, because
 * `recordType: 'safety_warning'` fell through every branch below to the final `return 'open'`.
 * Plan 3 renders status badges and filters directly on `trust.status`, so that bug would have
 * tagged a domain-takeover warning as an open opportunity.
 *
 * FIX ROUND 2 (Task 15/16 review). Round 1 fixed the two records it was told about
 * (`far-farweb-org-compromised`, `rca-youth-activities`) but left the same class of bug live in
 * the other 14 Tier D records: every `verified_negative` record computed a blanket
 * `'discontinued'` regardless of whether the underlying organization was actually defunct (AMSAT,
 * ARRL CARI, FlexRadio and DARA/Hamvention are all ACTIVE — they are simply not grantmakers, or
 * their real program lives elsewhere), and four contact-only/pointer records with no cash terms
 * computed the generic `'open'` default. Round 1's own `CONTACT_ONLY_RECORDS` table was flagged in
 * that round's report as a workaround, not the real fix.
 *
 * The real fix, done this round: `sources/manual-tier-d.ts` now gives EVERY one of its 16 records
 * an explicit `rawFields.status`, researched per record (see that file's per-record comments for
 * the reasoning — e.g. `'contact_only'` for the Icom/DXE relationship-giving record because a real
 * path exists through a person, `'no_application'` for AMSAT/CARI/FlexRadio/DARA because the org is
 * real but there is nothing to apply to, `'discontinued'` reserved for Chicago FM Club, the one
 * record that genuinely ended). `CONTACT_ONLY_RECORDS` is deleted: it existed only to reconstruct
 * `rca-youth-activities`' status by (sourceId, externalKey) lookup, and a record carrying its own
 * status makes that reconstruction unnecessary.
 *
 * The override mechanism below — `rawFields.status` wins, inference runs only when it is absent —
 * was already correct as of round 1. `rawFields.status` being WRITTEN and never READ is exactly
 * how the FAR bug hid in the first place; the remaining generic recordType/deadlineKind inference
 * below is now a fallback for records that genuinely have no researched status (a live-crawled
 * source usually doesn't), not a substitute for one.
 *
 * FIX ROUND 3 (this task — remediation of the false 'open' the round 1/2 fix left in place).
 * Two distinct holes, both proven by real, committed corpus data rather than a synthetic example:
 *
 * 1. `'manual'` and `'guided_workflow'` were added to `KNOWN_RECORD_TYPES` (so the "fail loud as
 *    unknown" net at the bottom does not catch them — they are, correctly, KNOWN) but the switch
 *    below never grew a case for either, so a record of either kind with no `rawFields.status`
 *    override fell through every branch to the final `return 'open'`. Every current
 *    `manual-tier-d.ts` record of these two kinds happens to carry an explicit override (see the
 *    FIX ROUND 2 doc above), so this was latent, not currently firing on the shipped corpus — but
 *    "happens not to fire today" is exactly the shape of the original FAR bug, and a manually-
 *    tracked programme's status is never derivable from a date, and a guided workflow (52 NASA
 *    Space Grant consortia, ~4,000 campus SGAs) has no single deadline by construction — that is
 *    the entire reason it ships as a workflow instead of a feed. `'unknown'` is the honest
 *    fallback for both; `'open'` asserts a live cycle nothing here can support.
 *
 * 2. The William C. Winscott, N6CHA, Memorial Scholarship — a real entry in the live,
 *    111-record ARRL scholarship-descriptions catalog, with no `recordType` at all (it is an
 *    ordinary scraped catalog entry, not a Tier D hand-curated record) — computed `'open'`. Its
 *    own `Other:` field reads "This scholarship is not currently active. First award will be made
 *    the year following Mr. Winscott's passing and receipt of the William C. Winscott Trust."
 *    Nothing above catches this: no recordType, no deadlineKind override, no applicantEntity,
 *    and `ctx.sourceId` is the ordinary catalog source, not one of the two hardcoded exceptions.
 *    `statesInactivity` below closes this for good by reading the funder's own words instead of
 *    relying on some future field ever being added for it — the fastest-growing category of bug
 *    in this file has been "a record with no structured signal at all defaults to open".
 */
const INACTIVITY_PATTERN =
  /\bnot currently\s+active\b|\bno longer (?:offered|active|available)\b|\bdiscontinued\b|\bsuspended\b|\bon hiatus\b/i;

/**
 * FIX ROUND 4 (scope, not strength). A segment that says a programme ended, about a DIFFERENT,
 * superseded programme the page also mentions — a retrospective qualifier ("previous", "prior",
 * "past", "predecessor", "earlier") applied to a named programme, in the same segment as the
 * inactivity wording.
 *
 * The case that proved it: the live NCDXF scholarships page
 * (fixtures/ncdxf-scholarships/00-www-ncdxf-org-pages-scholarships-html.html) describes a LIVE
 * award — full tuition at DX University and Contest University for hams 25 and under — and then
 * prints a recipients table under the heading "Previous ARRL Foundation Scholarship Program (No
 * Longer Active)". Reading that heading as the extracted programme's own status marked a live
 * scholarship 'dormant': a false exclude, the direction that hides an award permanently with no
 * signal to anyone. (The tier C-B parser labels that very span `rawFields.retiredPredecessor`
 * for the same reason; this check is deliberately not coupled to that field name, so it also
 * holds for any other page that prints a superseded programme's obituary next to a live one.)
 *
 * Note what this does NOT match: "Formerly the Smith Award, this scholarship is no longer
 * offered" (`\bformer\b` does not match "formerly", and the qualifier must attach to a named
 * programme), so a funder's own farewell to the programme being extracted still counts.
 */
const RETIRED_PREDECESSOR =
  /\b(?:previous|prior|past|predecessor|earlier|former)\b[^.\n]{0,80}?\b(?:program|programme|scholarship|fund|award|grant)s?\b/i;

/**
 * True when the funder's own text says THIS programme is not accepting applications right now.
 *
 * Checked against `rawText` — the full flattened body every source's `rawFields` is itself split
 * from (see `sources/util/text.ts`'s `splitByLabels`) — so this fires regardless of which label,
 * if any, the sentence happens to land under on a given source's page. That breadth is the whole
 * point (the Winscott scholarship states its inactivity under `Other:`), but until round 4 it was
 * unbounded: the check read the ENTIRE flattened page as if every word of it described the record
 * being extracted.
 *
 * Bounded, not weakened: the body is split into segments (lines, and sentences within a line) and
 * each segment is judged on its own. A segment whose inactivity wording belongs to a retired
 * predecessor programme is skipped; any other segment stating inactivity still yields 'dormant'
 * exactly as before.
 */
function statesInactivity(raw: RawOpportunity): boolean {
  const segments = raw.rawText.split(/\n|(?<=[.;!?])\s+/);
  return segments.some(
    (segment) => INACTIVITY_PATTERN.test(segment) && !RETIRED_PREDECESSOR.test(segment),
  );
}

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

  // FIX ROUND 3. The funder's own words say this programme is not currently active (e.g. the
  // Winscott scholarship) — never let that compute 'open', regardless of recordType. 'dormant'
  // is the honest read: the programme exists and is not permanently ended (Winscott names a
  // specific future trigger), it simply has no live cycle right now. Round 4 bounded WHICH words
  // count (see statesInactivity): a superseded programme's obituary printed on the same page is
  // not this programme's status.
  if (statesInactivity(raw)) return 'dormant';

  // FIX ROUND 4. A source whose KIND_BY_SOURCE entry is an EXPLICIT 'unpublished' has been
  // researched and found to publish no dates at all (ylrl, ncdxf-scholarships, arrl-club-grant,
  // nasa-csli — the last two used to be named here one by one, which is the same table read a
  // second time by hand). Nothing about such a record can support asserting a live cycle, so
  // 'open' is a claim this file cannot back; 'unknown' is what we actually know. This reads the
  // TABLE, deliberately not the resolved kind: `KIND_BY_SOURCE[...] ?? 'unpublished'` is also the
  // fallback for every source nobody has modelled a deadline for yet (nsf-funding-rss's 45 live
  // NSF solicitations among them), and "we have not modelled it" is not the same finding as "the
  // funder does not publish one". A per-record `rawFields.deadlineKind` overrides the table
  // entirely, so it must not be second-guessed here either.
  if (KIND_BY_SOURCE[ctx.sourceId] === 'unpublished' && raw.rawFields.deadlineKind === undefined) {
    return 'unknown';
  }

  // FIX ROUND 3. 'manual'/'guided_workflow' reach here only when none of the more specific
  // signals above resolved them (no deadlineKind of no_application_exists, no
  // nominated_by_institution applicant, no inactivity text) — i.e. exactly the case where a
  // record of one of these kinds carries no researched rawFields.status at all (every real
  // manual-tier-d.ts record of these kinds currently does — see the doc comment above; this is
  // the defensive fallback for when one is absent). Neither kind's status is derivable from a
  // date or a generic bucket, so 'unknown' is the honest answer; 'open' asserts a live cycle
  // nothing here can support.
  if (recordType === 'manual' || recordType === 'guided_workflow') return 'unknown';

  // A recordType WAS set, but nothing above resolved it — fail loud as 'unknown', never silently
  // 'open'.
  if (recordType !== undefined && !KNOWN_RECORD_TYPES.has(recordType)) return 'unknown';

  return 'open';
}

/**
 * sourceId -> the instrument the FUNDER'S OWN PAGE describes, for the sources whose award is not
 * derivable from an amount string. Getting one wrong is not cosmetic: this codebase separates
 * `discounted_purchase` and the in-kind values from cash precisely so a club does not budget
 * around money that does not exist — or, in SARA's case below, wait for hardware that is never
 * coming while the actual cheque goes unclaimed.
 */
const INSTRUMENT_BY_SOURCE: Readonly<Record<string, Instrument>> = Object.freeze({
  'yaesu-dr2x': 'discounted_purchase',
  ariss: 'in_kind_service',
  'nasa-csli': 'in_kind_service',
  // ROUND 4. Was 'in_kind_equipment', pinned on earlier research into radio-astronomy kits
  // (Radio JOVE, SuperSID). The captured page (fixtures/sara/) says otherwise, and the page
  // governs: "The Society of Amateur Radio Astronomers provides funds in support of student
  // projects. The funds will be divided up into several small grants of no more than $200 each
  // or more, with the approval of the grant committee, to ensure that the money reaches the
  // largest number of students." Radio JOVE / SuperSID / INSPIRE appear there only as example
  // projects an applicant might BUILD with the money, never as what SARA hands over.
  // cash_range, not cash_fixed: the page states a ceiling with explicit committee discretion
  // above it ("no more than $200 each OR MORE, with the approval of the grant committee"), so
  // the per-grant amount varies and a flat figure would be an award the funder never promised.
  sara: 'cash_range',
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
