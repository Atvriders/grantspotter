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

/* ------------------------------------------------------------------ observed dates ---------- */

/**
 * OBSERVED DATES — the dates the funder itself published, which until this fix reached nothing.
 *
 * `rawFieldsContract.test.ts` (the written-but-never-read invariant) caught this as bug #2 of its
 * class: `opensAt`, `closesAt`, `openDate`, `closeDate` and `responseDate` were parsed off real
 * pages by `sources/tier-c-b.ts` (ARISS), `sources/yaesu-dr2x.ts` and `federal/grantsGov.ts`, and
 * this file contained not one reference to any of them. Every date the product showed came from
 * `DEADLINE_INHERITANCE`, a `RECUR:` directive or `KIND_BY_SOURCE` — tables written by us — never
 * from what the funder actually stated. ARISS's own page says the proposal window opened July 1
 * and closes September 30; the shipped record said "One window sentence rewritten quarterly at a
 * stable URL." and nothing else.
 *
 * THE PRECEDENCE RULE, stated once here because everything below implements it:
 *
 *   A date the source genuinely parsed from the funder's own page is the most authoritative
 *   deadline information available, and it beats every table in this file. Inheritance and the
 *   `RECUR:` / `KIND_BY_SOURCE` tables are the fallbacks for records that publish no date of
 *   their own.
 *
 * Two things that rule deliberately does NOT do:
 *
 *   - It never DELETES a `RECUR` directive. `expandCycles` projects the calendar out of that
 *     directive, and 112 of 181 real candidates ride the `arrl-scholarship-program` cycle through
 *     it. `parseRecurrence` reads only as far as the first ` | `, so an observed window is
 *     APPENDED to the human half of the note and the projection is bit-for-bit unaffected.
 *   - It never projects an observed window forward. A window a funder stated once ("opens
 *     2026-07-01, closes 2026-09-30") is one dated window, not a yearly rule; feeding it to
 *     `expandCycles` as `annual_window window=07-01..09-30` would publish a 2027 ARISS deadline
 *     ARISS has never announced. `Cycle.isEstimated: false` is where an OBSERVED cycle belongs
 *     (see `db/repositories/cycles.ts`, which says nothing writes those yet) and that seam is in
 *     `core`/`review`, not here.
 */

const MAX_DAY_BY_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_PREFIXES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** `YYYY-MM-DD` (ARISS, Yaesu, the daily extract). */
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** `MM/DD/YYYY` (Grants.gov search2 `openDate` / `closeDate`). */
const US_SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
/** `Sep 09, 2026 12:00:00 AM EDT` and `Nov 14, 2026` (Grants.gov `responseDate`). */
const LONG_FORM = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?:\D|$)/;

function isRealDate(year: number, month: number, day: number): boolean {
  // A year outside this band is a mis-parse, not a deadline: the corpus's oldest live page was
  // last edited in 2013 and no funder publishes a window a lifetime out.
  if (year < 1990 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const maxDay = month === 2 && leap ? 29 : MAX_DAY_BY_MONTH[month - 1];
  return day >= 1 && day <= maxDay;
}

function isoOf(year: number, month: number, day: number): string | undefined {
  if (!isRealDate(year, month, day)) return undefined;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * One funder-published date, in any of the three shapes the sources emit, normalized to
 * `YYYY-MM-DD`. Anything else — a blank, a half-parsed fragment, `2026-02-30`, `13/01/2026`, a
 * year in the 1800s — returns `undefined`. REJECTED, NEVER COERCED: a malformed date coerced into
 * a plausible one is a wrong deadline published with full confidence, which is the single worst
 * thing this product can do.
 */
export function parseObservedDate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (text === '') return undefined;

  const iso = ISO_DAY.exec(text);
  if (iso) return isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const slash = US_SLASH.exec(text);
  if (slash) return isoOf(Number(slash[3]), Number(slash[1]), Number(slash[2]));

  const long = LONG_FORM.exec(text);
  if (long) {
    const month = MONTH_PREFIXES.indexOf(long[1].toLowerCase().slice(0, 3)) + 1;
    if (month === 0) return undefined;
    return isoOf(Number(long[3]), month, Number(long[2]));
  }
  return undefined;
}

/** A window the funder published, as ISO days. Either half may be absent; both may not. */
export interface ObservedWindow {
  opensAt?: string;
  closesAt?: string;
}

/**
 * The window this record's own source parsed off the funder's page, or `undefined` when the
 * source published none.
 *
 * EVERY KEY IS READ BY NAME, never through a computed subscript over a table of key names, and
 * that is deliberate: `rawFieldsContract.test.ts` — the invariant that caught this whole defect —
 * cannot see a key read through a variable, and its own doc says a reader added that way "would
 * make this test fail with a false positive". A fix for the written-but-never-read defect class
 * must be visible to the thing that detects the class. `grep rawFields.closesAt` finds this.
 *
 * Precedence within each half is the `??` chain below. `closeDate` before `responseDate`: both
 * are Grants.gov's and they agree on every record in the committed captures (NTIA PWSCIF,
 * `closeDate: "09/09/2026"` and `responseDate: "Sep 09, 2026 12:00:00 AM EDT"`), but `closeDate`
 * rides BOTH federal legs — search2 and the daily XML extract — while `responseDate` exists only
 * on the hydrated detail, so prefer the field that is always present and always day-precise.
 *
 * `postDate` / `postingDate` are deliberately NOT read. They are when Grants.gov posted the ROW,
 * not when the funder opens its window (`rawFieldsContract.test.ts` says the same in
 * `WRITE_ONLY_BY_DESIGN`), and reading one as an open date would manufacture a window nobody
 * published.
 *
 * A window whose close precedes its open is rejected whole rather than half-kept: the two halves
 * came out of one sentence, so if they contradict each other neither is trustworthy, and keeping
 * the close date alone would let a mis-parse decide whether the programme reads as closed.
 */
export function observedWindow(raw: RawOpportunity): ObservedWindow | undefined {
  const opensAt =
    parseObservedDate(raw.rawFields.opensAt) ?? parseObservedDate(raw.rawFields.openDate);
  const closesAt =
    parseObservedDate(raw.rawFields.closesAt) ??
    parseObservedDate(raw.rawFields.closeDate) ??
    parseObservedDate(raw.rawFields.responseDate);
  if (opensAt === undefined && closesAt === undefined) return undefined;
  // Canonical ISO days compare correctly as strings.
  if (opensAt !== undefined && closesAt !== undefined && closesAt < opensAt) return undefined;
  const window: ObservedWindow = {};
  if (opensAt !== undefined) window.opensAt = opensAt;
  if (closesAt !== undefined) window.closesAt = closesAt;
  return window;
}

function describeObservedWindow(window: ObservedWindow): string {
  if (window.opensAt !== undefined && window.closesAt !== undefined) {
    return `Application window published by the funder: opens ${window.opensAt}, closes ${window.closesAt}.`;
  }
  if (window.closesAt !== undefined) {
    return `Application deadline published by the funder: closes ${window.closesAt}.`;
  }
  return `Application window published by the funder: opens ${window.opensAt}; no close date is stated.`;
}

/**
 * The two kinds that are an explicit ASSERTION THAT NO DATE EXISTS — "the funder has never
 * published a deadline for this program" and "applications are accepted at any time; the funder
 * publishes no deadline". Holding either alongside a date the funder did publish would ship a
 * record that contradicts itself, so an observed window promotes them to `ad_hoc`, "irregular
 * windows announced by the funder with no fixed schedule", which is precisely what a one-off
 * federal NOFO with an open and a close date is. `ad_hoc` is not in `expandCycles`'s
 * PROJECTABLE_KINDS, so the promotion cannot make anything project.
 */
const KINDS_ASSERTING_NO_DATE: ReadonlySet<DeadlineKind> = new Set<DeadlineKind>([
  'unpublished',
  'rolling',
]);

/**
 * Resolve the kind and note together, because an observed window can change both.
 *
 * `no_application_exists` is the one kind an observed date may not touch: it is a researched
 * statement that there is nothing to apply to and the funder picks recipients itself (YASME, the
 * HamSCI participation record), so a stray date field on such a record is not an application
 * deadline and must not be published as one.
 */
function resolveKindAndNote(
  sourceId: string,
  kind: DeadlineKind,
  observed: ObservedWindow | undefined,
): { kind: DeadlineKind; note: string } {
  if (observed === undefined || kind === 'no_application_exists') {
    return { kind, note: noteFor(sourceId, kind) };
  }
  const effective = KINDS_ASSERTING_NO_DATE.has(kind) ? 'ad_hoc' : kind;
  // Appended AFTER the table note on purpose: when that note is a RECUR directive, everything
  // past the first ` | ` is prose `parseRecurrence` ignores, so the calendar projection survives
  // untouched while the record still states the dates the funder actually printed.
  return { kind: effective, note: `${noteFor(sourceId, effective)} ${describeObservedWindow(observed)}` };
}

export function inferDeadline(raw: RawOpportunity, ctx: NormalizeContext): DeadlineSpec {
  const observed = observedWindow(raw);
  const declared = raw.rawFields.deadlineKind as DeadlineKind | undefined;
  if (declared) {
    const resolved = resolveKindAndNote(ctx.sourceId, declared, observed);
    return { kind: resolved.kind, source: { kind: 'self' }, note: resolved.note };
  }
  // Inheritance is for a record with no date of its own. A record that parsed a real window off
  // its own funder's page has one, and its own dates outrank another programme's cycle. No source
  // that inherits parses dates today (`arrl-scholarship-descriptions` and `qcwa` write neither
  // half), so all 112 inheriting candidates take this branch exactly as before — the guard is
  // what makes the precedence rule true rather than merely true-by-accident.
  if (ctx.deadlineInheritsFrom && observed === undefined) {
    return {
      kind: 'inherited',
      source: { kind: 'inherited', fromProgramId: ctx.deadlineInheritsFrom },
      note: NOTE_BY_KIND.inherited,
    };
  }
  const resolved = resolveKindAndNote(ctx.sourceId, KIND_BY_SOURCE[ctx.sourceId] ?? 'unpublished', observed);
  return { kind: resolved.kind, source: { kind: 'self' }, note: resolved.note };
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

  // THE SECOND READER OF THE OBSERVED WINDOW (the first is `inferDeadline`). Placed last, where
  // it can only ever turn a would-be 'open' into 'closed' and can displace no verdict any rule
  // above reached — which is what keeps ylrl/ncdxf-scholarships/nasa-csli on 'unknown', the
  // Winscott scholarship on 'dormant', and every researched `rawFields.status` (including
  // arrl-scholarship-program's real 'closed' 2026 cycle) exactly where it was.
  //
  // ONLY THE CLOSED DIRECTION IS ASSERTED. Telling someone a closed call is open costs them the
  // work of a whole application; a window that has not OPENED yet is still a live opportunity
  // they should be preparing for, so a future open date leaves the inference below alone rather
  // than downgrading a real programme to 'unknown'. The corpus proves the closed direction
  // matters: `grants-gov-extract`'s NTIA PWSCIF row (opportunity 354777) carries the funder's own
  // `closeDate` of 2026-05-01 and `oppStatus: "posted"`, and published as 'open' until this fix.
  const observed = observedWindow(raw);
  if (observed?.closesAt !== undefined && hasClosed(observed.closesAt, ctx.nowISO)) return 'closed';

  return 'open';
}

/**
 * True when the funder's own close DAY is wholly in the past.
 *
 * End of day, not start, and in UTC: these dates are day-precision with no zone attached, so
 * treating the deadline as expiring at 23:59:59.999Z is the reading that never closes a programme
 * early anywhere on earth. An unparseable clock or date yields `false` — never claim a programme
 * closed on the strength of a value we could not read.
 */
function hasClosed(closesAt: string, nowISO: string): boolean {
  const now = Date.parse(nowISO);
  const endOfCloseDay = Date.parse(`${closesAt}T23:59:59.999Z`);
  if (Number.isNaN(now) || Number.isNaN(endOfCloseDay)) return false;
  return endOfCloseDay < now;
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
