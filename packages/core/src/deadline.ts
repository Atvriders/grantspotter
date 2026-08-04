import type { Cycle, DeadlineKind, Program } from './types.js';

export interface MonthDay {
  month: number; // 1-12
  day: number; // 1-31
}

export interface DateWindow {
  open: MonthDay;
  close: MonthDay;
}

export interface TimeOfDay {
  hour: number;
  minute: number;
}

/**
 * PLAN-LOCAL. CONTRACT §3 freezes DeadlineSpec as { kind, source, note }, so the
 * recurrence parameters travel in `note` using the RECUR micro-format. Plans 2
 * and 5 emit that format; this type is what it parses into.
 */
export type Recurrence =
  | { kind: 'none' }
  | { kind: 'n_fixed_dates'; timezone: string; dates: MonthDay[]; closeTime: TimeOfDay }
  | {
      kind: 'n_fixed_windows';
      timezone: string;
      windows: DateWindow[];
      openTime: TimeOfDay;
      closeTime: TimeOfDay;
    }
  | {
      kind: 'annual_window';
      timezone: string;
      window: DateWindow;
      openTime: TimeOfDay;
      closeTime: TimeOfDay;
    };

export const RECURRENCE_PREFIX = 'RECUR ';
export const DEFAULT_OPEN_TIME: TimeOfDay = { hour: 0, minute: 0 };
export const DEFAULT_CLOSE_TIME: TimeOfDay = { hour: 23, minute: 59 };

export class RecurrenceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecurrenceParseError';
  }
}

// Calendar-aware max day per month, used to validate MM-DD values that carry
// no year. Feb is deliberately given 29: a bare "02-29" is a real calendar
// date in leap years, and a recurrence rule has no year to test it against.
// So parseMonthDay ACCEPTS 02-29 — rejecting the one MM-DD that is merely
// *sometimes* invalid, on the same footing as 02-30 which is *never* valid,
// would be the wrong kind of loud. The non-leap-year case is deferred to
// projection time, where expandCycles's clampDay (year-aware) already clamps
// Feb 29 down to Feb 28 for the years it doesn't exist in — the same
// mechanism that clamps "close of month" dates in general. What parseMonthDay
// must still reject outright is a day with no calendar meaning in ANY year
// for that month, e.g. 02-30, 04-31, 06-31, 09-31, 11-31.
const MONTH_MAX_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function parseMonthDay(raw: string, context: string): MonthDay {
  const m = /^(\d{2})-(\d{2})$/.exec(raw);
  if (m === null) {
    throw new RecurrenceParseError(`${context}: "${raw}" is not an MM-DD date`);
  }
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12) {
    throw new RecurrenceParseError(`${context}: "${raw}" has an invalid month ${m[1]}`);
  }
  const maxDay = MONTH_MAX_DAY[month - 1];
  if (day < 1 || day > maxDay) {
    throw new RecurrenceParseError(
      `${context}: "${raw}" — month ${m[1]} has no day ${m[2]} (that month runs 01 to ${String(maxDay).padStart(2, '0')})`,
    );
  }
  return { month, day };
}

function parseTimeOfDay(raw: string, context: string): TimeOfDay {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (m === null) {
    throw new RecurrenceParseError(`${context}: "${raw}" is not an HH:MM time`);
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) {
    throw new RecurrenceParseError(`${context}: "${raw}" is out of range`);
  }
  return { hour, minute };
}

function assertIanaZone(tz: string): string {
  try {
    // Throws RangeError for an unknown zone. Catching a typo here beats
    // silently emitting deadlines in the wrong offset.
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
  } catch {
    throw new RecurrenceParseError(`unknown IANA time zone "${tz}"`);
  }
  return tz;
}

function parseWindow(raw: string, context: string): DateWindow {
  const halves = raw.split('..');
  if (halves.length !== 2) {
    throw new RecurrenceParseError(`${context}: "${raw}" is not an MM-DD..MM-DD window`);
  }
  return {
    open: parseMonthDay(halves[0], context),
    close: parseMonthDay(halves[1], context),
  };
}

export function parseRecurrence(note: string): Recurrence {
  if (!note.startsWith(RECURRENCE_PREFIX)) return { kind: 'none' };

  const directive = note.slice(RECURRENCE_PREFIX.length).split('|')[0].trim();
  const tokens = directive.split(/\s+/).filter((t) => t.length > 0);
  const kind = tokens[0] ?? '';

  const kv = new Map<string, string>();
  for (const token of tokens.slice(1)) {
    const eq = token.indexOf('=');
    if (eq <= 0) {
      throw new RecurrenceParseError(`malformed key=value token "${token}" in RECUR directive`);
    }
    kv.set(token.slice(0, eq), token.slice(eq + 1));
  }

  const tzRaw = kv.get('tz');
  if (tzRaw === undefined) {
    throw new RecurrenceParseError(`RECUR ${kind} requires tz=<IANA zone>`);
  }
  const timezone = assertIanaZone(tzRaw);

  const openRaw = kv.get('open');
  const closeRaw = kv.get('close');
  const openTime = openRaw === undefined ? DEFAULT_OPEN_TIME : parseTimeOfDay(openRaw, 'open');
  const closeTime = closeRaw === undefined ? DEFAULT_CLOSE_TIME : parseTimeOfDay(closeRaw, 'close');

  if (kind === 'n_fixed_dates') {
    const raw = kv.get('dates');
    if (raw === undefined) {
      throw new RecurrenceParseError('RECUR n_fixed_dates requires dates=MM-DD[,MM-DD...]');
    }
    const dates = raw.split(',').map((d) => parseMonthDay(d, 'dates'));
    return { kind, timezone, dates, closeTime };
  }

  if (kind === 'n_fixed_windows') {
    const raw = kv.get('windows');
    if (raw === undefined) {
      throw new RecurrenceParseError(
        'RECUR n_fixed_windows requires windows=MM-DD..MM-DD[,MM-DD..MM-DD...]',
      );
    }
    const windows = raw.split(',').map((w) => parseWindow(w, 'windows'));
    return { kind, timezone, windows, openTime, closeTime };
  }

  if (kind === 'annual_window') {
    const raw = kv.get('window');
    if (raw === undefined) {
      throw new RecurrenceParseError('RECUR annual_window requires window=MM-DD..MM-DD');
    }
    return { kind, timezone, window: parseWindow(raw, 'window'), openTime, closeTime };
  }

  throw new RecurrenceParseError(`unknown RECUR kind "${kind}"`);
}

/**
 * Offset in minutes that `timeZone` was at the given UTC instant. Derived by
 * asking Intl what the local wall clock reads there and subtracting.
 */
function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part === undefined ? 0 : Number(part.value);
  };
  // `hour` can come back as 24 for midnight under some ICU builds.
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return (asUtc - utcMs) / 60000;
}

/**
 * Convert a wall-clock time in an IANA zone to a UTC ISO instant. Two passes:
 * the first offset estimate can be wrong within a few hours of a DST
 * transition, and re-reading the offset at the corrected instant fixes it.
 *
 * A wall time inside the fall-back window (e.g. 2026-11-01 01:30 in
 * America/New_York, which occurs twice as clocks repeat that hour) is
 * ambiguous by construction — this always resolves to the pre-fallback
 * (still-DST) occurrence, because the second pass re-reads the offset at an
 * instant that is still inside DST for times in that hour. No deadline in
 * this corpus falls at 1–2 AM, so the ambiguity is unreachable in practice;
 * documented here so nobody has to re-derive it if that ever changes.
 */
export function zonedWallTimeToUtcISO(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): string {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = naive - offsetMinutesAt(naive, timeZone) * 60000;
  ts = naive - offsetMinutesAt(ts, timeZone) * 60000;
  return new Date(ts).toISOString();
}

/**
 * Follow `deadline.source.inherited` to the programme that actually owns the
 * dates. Returns the input programme when it owns its own deadline, when the
 * owner is absent from `allPrograms` (an incomplete corpus must not fabricate
 * dates), or when the chain loops.
 */
export function resolveDeadlineOwner(program: Program, allPrograms: Program[]): Program {
  const byId = new Map(allPrograms.map((p) => [p.id, p]));
  const seen = new Set<string>([program.id]);
  let current = program;
  for (let hops = 0; hops < 8; hops += 1) {
    if (current.deadline.source.kind !== 'inherited') return current;
    const next = byId.get(current.deadline.source.fromProgramId);
    if (next === undefined) return program;
    if (seen.has(next.id)) return program;
    seen.add(next.id);
    current = next;
  }
  return program;
}

const MONTH_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Only these three kinds carry enough information to be projected forward. */
const PROJECTABLE_KINDS: ReadonlySet<DeadlineKind> = new Set<DeadlineKind>([
  'n_fixed_dates',
  'n_fixed_windows',
  'annual_window',
]);

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysInMonth(year, month));
}

function labelDate(year: number, month: number, day: number): string {
  return `${MONTH_SHORT[month - 1]} ${day}, ${year}`;
}

function labelWindow(
  openYear: number,
  openMonth: number,
  openDay: number,
  closeYear: number,
  closeMonth: number,
  closeDay: number,
): string {
  if (openYear === closeYear && openMonth === closeMonth) {
    return `${MONTH_SHORT[openMonth - 1]} ${openDay}–${closeDay}, ${openYear} window`;
  }
  if (openYear === closeYear) {
    return `${MONTH_SHORT[openMonth - 1]} ${openDay} – ${MONTH_SHORT[closeMonth - 1]} ${closeDay}, ${openYear} window`;
  }
  return `${MONTH_SHORT[openMonth - 1]} ${openDay}, ${openYear} – ${MONTH_SHORT[closeMonth - 1]} ${closeDay}, ${closeYear} window`;
}

interface CycleDraft {
  opensAt?: string;
  closesAt: string;
  label: string;
}

function projectWindow(
  window: DateWindow,
  openYear: number,
  openTime: TimeOfDay,
  closeTime: TimeOfDay,
  timezone: string,
): CycleDraft {
  const crossesYearEnd =
    window.close.month < window.open.month ||
    (window.close.month === window.open.month && window.close.day < window.open.day);
  const closeYear = crossesYearEnd ? openYear + 1 : openYear;
  const openDay = clampDay(openYear, window.open.month, window.open.day);
  const closeDay = clampDay(closeYear, window.close.month, window.close.day);
  return {
    opensAt: zonedWallTimeToUtcISO(
      openYear,
      window.open.month,
      openDay,
      openTime.hour,
      openTime.minute,
      0,
      timezone,
    ),
    closesAt: zonedWallTimeToUtcISO(
      closeYear,
      window.close.month,
      closeDay,
      closeTime.hour,
      closeTime.minute,
      0,
      timezone,
    ),
    label: labelWindow(
      openYear,
      window.open.month,
      openDay,
      closeYear,
      window.close.month,
      closeDay,
    ),
  };
}

/**
 * Project concrete dated Cycle instances into [fromISO, toISO].
 *
 * Every projected cycle carries isEstimated: true — it comes from a recurrence
 * rule, not from an observed page. A window the funder actually stated becomes
 * an isEstimated: false cycle through `observedCycles` below; the two are
 * separate functions because they are separate claims, and a caller that wants
 * both asks for both (`review/index.ts` does).
 *
 * Cycle ids are `${programId}:${closesAt}` so a nightly re-projection upserts
 * over the previous run rather than duplicating rows.
 */
export function expandCycles(
  program: Program,
  allPrograms: Program[],
  fromISO: string,
  toISO: string,
): Cycle[] {
  const owner = resolveDeadlineOwner(program, allPrograms);
  if (!PROJECTABLE_KINDS.has(owner.deadline.kind)) return [];

  const recurrence = parseRecurrence(owner.deadline.note);
  if (recurrence.kind === 'none') return [];

  const fromMs = Date.parse(fromISO);
  const toMs = Date.parse(toISO);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) return [];

  const inherited = owner.id !== program.id;
  const firstYear = new Date(fromMs).getUTCFullYear() - 1;
  const lastYear = new Date(toMs).getUTCFullYear() + 1;

  const drafts: CycleDraft[] = [];
  for (let year = firstYear; year <= lastYear; year += 1) {
    if (recurrence.kind === 'n_fixed_dates') {
      for (const date of recurrence.dates) {
        const day = clampDay(year, date.month, date.day);
        drafts.push({
          closesAt: zonedWallTimeToUtcISO(
            year,
            date.month,
            day,
            recurrence.closeTime.hour,
            recurrence.closeTime.minute,
            0,
            recurrence.timezone,
          ),
          label: `${labelDate(year, date.month, day)} deadline`,
        });
      }
    } else if (recurrence.kind === 'n_fixed_windows') {
      for (const window of recurrence.windows) {
        drafts.push(
          projectWindow(window, year, recurrence.openTime, recurrence.closeTime, recurrence.timezone),
        );
      }
    } else {
      drafts.push(
        projectWindow(
          recurrence.window,
          year,
          recurrence.openTime,
          recurrence.closeTime,
          recurrence.timezone,
        ),
      );
    }
  }

  const cycles: Cycle[] = [];
  for (const draft of drafts) {
    const closesMs = Date.parse(draft.closesAt);
    if (closesMs < fromMs || closesMs > toMs) continue;
    const cycle: Cycle = {
      id: `${program.id}:${draft.closesAt}`,
      programId: program.id,
      closesAt: draft.closesAt,
      timezone: recurrence.timezone,
      label: inherited ? `${draft.label} (via ${owner.name})` : draft.label,
      isEstimated: true,
    };
    if (draft.opensAt !== undefined) cycle.opensAt = draft.opensAt;
    cycles.push(cycle);
  }

  return cycles.sort((a, b) => {
    const delta = Date.parse(a.closesAt as string) - Date.parse(b.closesAt as string);
    if (delta !== 0) return delta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/* ------------------------------------------- observed (funder-stated) windows ---------------- */

/**
 * REMEDIATION (2026-08-03) — the calendar entry for a window a funder actually stated.
 *
 * `expandCycles` above is the whole calendar, and it projects a RECURRENCE: a rule with no year in
 * it, repeated forwards. That is the right and only channel for ARDC's four dates and the ARRL
 * windows, and it is the wrong channel for ARISS, which states ONE dated window ("opens
 * 2026-07-01, closes 2026-09-30"). `normalize/deadline.ts` refused to feed that window through
 * `RECUR annual_window window=07-01..09-30` precisely because doing so would publish a 2027 ARISS
 * deadline ARISS has never announced, and that refusal was correct. The cost of the refusal was
 * that the six programmes whose dates were just corrected from their funders' own pages produced
 * NO `Cycle` row at all, so a calendar built from `cycles` showed only recurring and inherited
 * deadlines while silently omitting every deadline a funder had actually published — which reads
 * as complete and is not.
 *
 * This is the other half. It records the window that EXISTS, and invents no successor: one stated
 * window yields exactly one `Cycle`, marked `isEstimated: false`, and nothing is repeated into any
 * later year. Nothing here consults `PROJECTABLE_KINDS`, and nothing here can add a second row.
 *
 * WHY THE NOTE IS THE CHANNEL. CONTRACT §3 freezes `DeadlineSpec` as `{ kind, source, note }` —
 * there is no field for a date — which is the same reason the `RECUR` micro-format lives in `note`.
 * `normalize/deadline.ts`'s `describeObservedWindow` writes the sentence below and this parses it
 * back; the two are pinned together end-to-end by a test in `review/index.test.ts` that runs the
 * real ARISS capture through the real parse → normalize → approve path, so the writer cannot drift
 * away from this reader without a red run.
 */
export const OBSERVED_WINDOW_MARKER = 'published by the funder:';

/** A window the funder itself stated, as ISO days. Mirrors normalize/deadline.ts's writer-side type. */
export interface ObservedWindow {
  opensAt?: string;
  closesAt?: string;
}

const OBSERVED_OPENS = /\bopens\s+(\d{4})-(\d{2})-(\d{2})\b/;
const OBSERVED_CLOSES = /\bcloses\s+(\d{4})-(\d{2})-(\d{2})\b/;

/**
 * A `YYYY-MM-DD` that is a real calendar day, or `undefined`. Year-aware, so 2027-02-29 is
 * rejected while 2028-02-29 is kept — unlike `parseMonthDay` above, which has no year to test
 * against and defers Feb 29 to projection time. REJECTED, NEVER CLAMPED: a recurrence rule with no
 * year has to be clamped to be usable at all, but a date a funder printed either parses as what it
 * says or is not trustworthy enough to put on a calendar.
 */
function realIsoDay(match: RegExpExecArray | null): string | undefined {
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1990 || year > 2100) return undefined;
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * The window a funder stated, read back out of `DeadlineSpec.note`, or `undefined` when the note
 * carries none.
 *
 * Only text AFTER `OBSERVED_WINDOW_MARKER` is read. Everything before it is our own prose or a
 * `RECUR` directive, and reading a date out of either would let a table we wrote masquerade as
 * something the funder said.
 *
 * A window whose close precedes its open is rejected WHOLE, not half-kept — the same rule
 * `normalize/deadline.ts` applies on the way in, for the same reason: both halves came out of one
 * sentence, so if they contradict each other neither is trustworthy.
 */
export function parseObservedWindow(note: string): ObservedWindow | undefined {
  const at = note.indexOf(OBSERVED_WINDOW_MARKER);
  if (at < 0) return undefined;
  const stated = note.slice(at + OBSERVED_WINDOW_MARKER.length);

  const opensAt = realIsoDay(OBSERVED_OPENS.exec(stated));
  const closesAt = realIsoDay(OBSERVED_CLOSES.exec(stated));
  if (opensAt === undefined && closesAt === undefined) return undefined;
  // Canonical ISO days compare correctly as strings.
  if (opensAt !== undefined && closesAt !== undefined && closesAt < opensAt) return undefined;

  const window: ObservedWindow = {};
  if (opensAt !== undefined) window.opensAt = opensAt;
  if (closesAt !== undefined) window.closesAt = closesAt;
  return window;
}

/**
 * Kinds that are an explicit statement that there is no application cycle to put on a calendar.
 *
 * `no_application_exists` is a researched finding that the funder selects recipients itself, and
 * `dormant` is a historical record with no live cycle; a date appearing anywhere in the prose of
 * either is not an application deadline. `inherited` is here for a different reason: a programme
 * still carrying that kind after `resolveDeadlineOwner` is one whose owner is NOT published, which
 * that function documents as "an incomplete corpus must not fabricate dates" — so it must not
 * acquire a deadline from its own note either.
 */
const KINDS_WITH_NO_CYCLE: ReadonlySet<DeadlineKind> = new Set<DeadlineKind>([
  'no_application_exists',
  'dormant',
  'inherited',
]);

/**
 * The single `Cycle` for a window the funder stated, if there is one, inside [fromISO, toISO].
 *
 * Returns at most ONE cycle, always. That is the entire point: an observed window is one dated
 * window, not a yearly rule, so there is no successor to generate and no year loop to run.
 *
 * DAY PRECISION, UTC FRAME. The dates a funder prints carry no time and no zone. The close is
 * therefore taken as the very end of the stated day in UTC — the reading that cannot close a
 * programme early anywhere on earth, and byte-for-byte the same instant `normalize/deadline.ts`'s
 * `hasClosed` uses to decide `ProgramStatus`, so the calendar and the status badge can never
 * disagree about whether a window is over. `timezone: 'UTC'` is that frame, not a claim about
 * where the funder is.
 *
 * A window with an open date but NO close date yields nothing. `cycles.closes_at` is what
 * `listClosingBetween` selects on, so such a row could never appear on the calendar it was written
 * for — a write-only row is the defect class this codebase keeps having to close, not a feature.
 * The open date is still published, as prose, on the record itself.
 *
 * Inheritance is followed exactly as `expandCycles` follows it, so a dependent riding an owner
 * that states a one-off window gets that window under its own id with the same `(via <owner>)`
 * label. No source that inherits parses dates today, so this is symmetry, not a live path.
 */
export function observedCycles(
  program: Program,
  allPrograms: Program[],
  fromISO: string,
  toISO: string,
): Cycle[] {
  const owner = resolveDeadlineOwner(program, allPrograms);
  if (KINDS_WITH_NO_CYCLE.has(owner.deadline.kind)) return [];

  const window = parseObservedWindow(owner.deadline.note);
  if (window?.closesAt === undefined) return [];

  const fromMs = Date.parse(fromISO);
  const toMs = Date.parse(toISO);
  if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) return [];

  const closesAt = `${window.closesAt}T23:59:59.999Z`;
  const closesMs = Date.parse(closesAt);
  if (closesMs < fromMs || closesMs > toMs) return [];

  const [closeYear, closeMonth, closeDay] = window.closesAt.split('-').map(Number);
  let label = `${labelDate(closeYear, closeMonth, closeDay)} deadline`;
  if (window.opensAt !== undefined) {
    const [openYear, openMonth, openDay] = window.opensAt.split('-').map(Number);
    label = labelWindow(openYear, openMonth, openDay, closeYear, closeMonth, closeDay);
  }
  if (owner.id !== program.id) label = `${label} (via ${owner.name})`;

  const cycle: Cycle = {
    // The `observed:` infix keeps this id disjoint from `expandCycles`'s `${id}:${closesAt}` even
    // if a projection ever lands on the same instant, and makes the row self-describing in the
    // table.
    id: `${program.id}:observed:${closesAt}`,
    programId: program.id,
    closesAt,
    timezone: 'UTC',
    label,
    isEstimated: false,
  };
  if (window.opensAt !== undefined) cycle.opensAt = `${window.opensAt}T00:00:00.000Z`;
  return [cycle];
}
