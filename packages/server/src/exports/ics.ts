/**
 * RFC 5545 calendar generation.
 *
 * WHY THIS FILE IS THE MOST CONSERVATIVE ONE IN THE PACKAGE. Every other export lands in a file a
 * person reads once. A calendar lands in the device someone carries and fires a reminder. If a
 * deadline moves a day LATE here, the product has told an applicant they have a day they do not
 * have, and it will keep telling them on a schedule until the subscription is removed.
 *
 * THE THREE THINGS THAT MOVE A DEADLINE, and what this file does about each:
 *
 * 1. **A stored deadline is a UTC INSTANT of a 23:59 LOCAL wall time.** `2026-11-01T03:59:00.000Z`
 *    in `America/New_York` IS the funder's 31 October. The task brief's draft rendered the UTC
 *    clock face as if it were the local one (`DTSTART;TZID=America/New_York:20261101T035900`),
 *    which is four hours and one calendar day late on every one of the 233 ARRL cycles in this
 *    corpus. This file converts the instant into the zone's real wall time and `ics.test.ts`
 *    proves the round trip for every event it writes.
 *
 * 2. **A `TZID` with no `VTIMEZONE` makes a client guess**, usually the viewer's own zone. Every
 *    `TZID` written here is backed by a shipped block; a zone with no block falls back to the
 *    exact UTC instant instead, and says so.
 *
 * 3. **A day-precision date has no time to render.** `observedCycles` stores a funder-published
 *    date as `…T23:59:59.999Z` with `timezone: 'UTC'` — documented there as a day-precision FRAME,
 *    explicitly not a claim about where the funder is. Rendered as a timed UTC event it lands on
 *    the NEXT day for anyone east of London. Those become all-day events, which show on the same
 *    calendar day everywhere, and the description says why.
 *
 * WINDOWS ARE NOT DEADLINES. A window (`opensAt` and `closesAt` on different funder-local days)
 * becomes ONE all-day event spanning open..close with an exclusive `DTEND`, which is what a
 * calendar draws as a bar. A deadline becomes a point in time. A window whose open and close land
 * on the SAME funder-local day is a deadline, not a one-day window — two IEEE programmes were
 * remodelled for exactly that reason, because a one-day window reads `closed` on 364 days a year
 * and invents an opening date the funder never printed.
 *
 * A PROJECTED DATE NEVER LOOKS PUBLISHED. Only 4 of the 243 cycles this corpus projects are dates
 * a funder actually printed; 239 are computed from a recurrence rule. Those carry the `(estimated)`
 * prefix in the `SUMMARY`, `STATUS:TENTATIVE` (the format's own word for an unconfirmed date, so a
 * client that never shows a description still renders the doubt), `X-GRANTSPOTTER-ESTIMATED:TRUE`,
 * and `rows.ts`'s own projected-deadline wording in the description. The wording is imported, not
 * restated: the spreadsheet and the calendar give the reader the same sentence.
 */
import type { Cycle, Program } from '@grantspotter/core';
import { isDoNotPublish } from '../normalize/index.js';
import { exportablePrograms } from './filter.js';
import {
  DEADLINE_BASIS_PROJECTED,
  DEADLINE_BASIS_PUBLISHED,
  funderLocalDay,
} from './rows.js';
import { hasVtimezone, VTIMEZONE_BLOCKS } from './icsTimezones.js';

const MAX_OCTETS = 75;

/** What the `SUMMARY` of a projected date begins with. Exported so tests assert one spelling. */
export const ICS_ESTIMATED_PREFIX = '(estimated) ';

/**
 * RFC 5545 §3.1: a content line is at most 75 OCTETS, and longer ones are split with CRLF followed
 * by a single space. A client that meets an unfolded 300-octet `DESCRIPTION` truncates it without
 * complaint — which is how a "verify this date" caveat disappears while the date survives.
 *
 * Folding counts octets, not characters, and iterating by code point (not by UTF-16 unit) is what
 * keeps a multi-byte character — or an astral one, which is two units — whole across the break.
 */
export function foldIcsLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_OCTETS) return line;
  const out: string[] = [];
  let current = '';
  let used = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > MAX_OCTETS) {
      out.push(current);
      // Continuation lines start with one space, which counts against the same 75 octets.
      current = ` ${char}`;
      used = 1 + size;
    } else {
      current += char;
      used += size;
    }
  }
  if (current.length > 0) out.push(current);
  return out.join('\r\n');
}

/**
 * RFC 5545 §3.3.11 TEXT escaping. A lone CR is escaped too: funder text pasted from a Windows
 * document carries them, and a raw CR inside a value ends the content line early — the property
 * after it is then read as garbage and the whole event can be dropped.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/* ------------------------------------------------------------------------------ instants and days */

const WALL_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = WALL_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  const made = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  WALL_FORMATTERS.set(timeZone, made);
  return made;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYYMMDDTHHMMSS` — the wall-clock reading of an instant in a zone, as a client will see it. */
function zonedWallStamp(instantMs: number, timeZone: string): string {
  const parts = wallFormatter(timeZone).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? '0');
  // `hour12: false` yields 24 for midnight on some ICU builds; core's `offsetMinutesAt` takes the
  // same `% 24`.
  return (
    `${String(get('year')).padStart(4, '0')}${pad(get('month'))}${pad(get('day'))}` +
    `T${pad(get('hour') % 24)}${pad(get('minute'))}${pad(get('second'))}`
  );
}

/** `YYYYMMDDTHHMMSSZ` — an unambiguous UTC instant. */
function utcStamp(instantMs: number): string {
  const d = new Date(instantMs);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** `YYYYMMDD` from an ISO calendar day. */
function icsDate(dayISO: string): string {
  return dayISO.replace(/-/g, '');
}

/** Day arithmetic done in UTC on the day string, so no local zone can shift it. */
function addDays(dayISO: string, days: number): string {
  const shifted = new Date(Date.parse(`${dayISO}T00:00:00.000Z`) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------------------- what a cycle IS */

type CycleKind = 'WINDOW' | 'DEADLINE' | 'OPENING';

interface CalendarCycle {
  kind: CycleKind;
  /** The zone to render in, or `''` when the funder never stated one. */
  zone: string;
  /** True when the zone is real AND we can ship a `VTIMEZONE` for it. */
  tzid: string | undefined;
  openMs: number | undefined;
  closeMs: number | undefined;
  openDay: string;
  closeDay: string;
  /**
   * The stored value is a bare `YYYY-MM-DD`, i.e. a calendar day with no time in it at all. There
   * is then no wall time to render and nothing to convert: re-reading `2027-02-01` as the UTC
   * instant of midnight and then asking what day that is in `America/Los_Angeles` answers
   * "31 January" — a day early, invented entirely by the renderer.
   */
  dayPrecision: boolean;
  /** The instant the reminder counts back from: the close, or the open when that is all there is. */
  anchorMs: number;
}

/**
 * `timezone: 'UTC'` means NO FUNDER ZONE WAS RECORDED — see `observedCycles`, which sets it as a
 * day-precision frame. Treating it as a real zone would turn an end-of-day sentinel into a claimed
 * 23:59:59 UTC appointment.
 */
function funderZoneOf(cycle: Cycle): string {
  return cycle.timezone === '' || cycle.timezone === 'UTC' ? '' : cycle.timezone;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A day with no time is anchored at its own END in UTC, never at midnight: a reminder counted back
 * from midnight is a day early, and for a bare `YYYY-MM-DD` close the funder's meaning is "by the
 * end of that day".
 */
function anchorInstant(value: string, edge: 'open' | 'close'): number {
  if (DATE_ONLY.test(value)) {
    return Date.parse(`${value}T${edge === 'open' ? '00:00:00.000' : '23:59:59.999'}Z`);
  }
  return Date.parse(value);
}

function classify(cycle: Cycle): CalendarCycle | undefined {
  const zone = funderZoneOf(cycle);
  const usable = (value: string | undefined, edge: 'open' | 'close'): number | undefined => {
    if (value === undefined || value === '') return undefined;
    const ms = anchorInstant(value, edge);
    return Number.isNaN(ms) ? undefined : ms;
  };
  const openMs = usable(cycle.opensAt, 'open');
  const closeMs = usable(cycle.closesAt, 'close');
  const anchorMs = closeMs ?? openMs;
  if (anchorMs === undefined) return undefined;

  // `funderLocalDay` is `rows.ts`'s settled answer to "which calendar day is this, to the funder" —
  // including its rule that a bare `YYYY-MM-DD` IS a calendar day already and must not be re-zoned.
  // The calendar asks the same question the spreadsheet asks, so it asks the same function; there
  // is no second answer to drift from the first.
  const openDay = openMs === undefined ? '' : funderLocalDay(cycle.opensAt, zone);
  const closeDay = closeMs === undefined ? '' : funderLocalDay(cycle.closesAt, zone);

  let kind: CycleKind;
  if (closeMs === undefined) kind = 'OPENING';
  else if (openMs !== undefined && openDay !== '' && openDay !== closeDay) kind = 'WINDOW';
  else kind = 'DEADLINE';

  return {
    kind,
    zone,
    tzid: zone !== '' && hasVtimezone(zone) ? zone : undefined,
    openMs,
    closeMs,
    openDay,
    closeDay,
    dayPrecision:
      (cycle.opensAt !== undefined && DATE_ONLY.test(cycle.opensAt)) ||
      (cycle.closesAt !== undefined && DATE_ONLY.test(cycle.closesAt)),
    anchorMs,
  };
}

/** Whether the event is drawn as a day (or a run of days) rather than a point in time. */
function isAllDay(c: CalendarCycle): boolean {
  return c.kind !== 'DEADLINE' || c.zone === '' || c.dayPrecision;
}

/* --------------------------------------------------------------------------------- the VEVENT */

function timing(c: CalendarCycle): string[] {
  if (isAllDay(c)) {
    const start = c.kind === 'OPENING' ? c.openDay : c.kind === 'WINDOW' ? c.openDay : c.closeDay;
    const last = c.kind === 'OPENING' ? c.openDay : c.closeDay;
    // DTEND is EXCLUSIVE for VALUE=DATE. A window whose last day is the 31st ends on the 1st;
    // writing the 31st would render the window a day short, and the last day is the one that
    // matters.
    return [
      `DTSTART;VALUE=DATE:${icsDate(start)}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(last, 1))}`,
    ];
  }
  const end = c.anchorMs + 3_600_000;
  if (c.tzid === undefined) {
    // A real funder zone we cannot ship a VTIMEZONE for. The instant is exact either way; only the
    // display zone is lost, and `describe` says so.
    return [`DTSTART:${utcStamp(c.anchorMs)}`, `DTEND:${utcStamp(end)}`];
  }
  return [
    `DTSTART;TZID=${c.tzid}:${zonedWallStamp(c.anchorMs, c.tzid)}`,
    `DTEND;TZID=${c.tzid}:${zonedWallStamp(end, c.tzid)}`,
  ];
}

const KIND_WORD: Record<CycleKind, string> = {
  WINDOW: 'window',
  DEADLINE: 'deadline',
  OPENING: 'opens',
};

function summaryFor(c: CalendarCycle, cycle: Cycle, program: Program): string {
  const word = KIND_WORD[c.kind];
  // The projected labels already end in "deadline" or "window"; appending only when they do not
  // guarantees the word is present without writing "deadline — … deadline".
  const label = cycle.label.toLowerCase().includes(word) ? cycle.label : `${cycle.label} ${word}`;
  const prefix = cycle.isEstimated ? ICS_ESTIMATED_PREFIX : '';
  return `${prefix}${program.name} — ${label}`;
}

/**
 * The exact dates, in words, so nothing is lost by drawing the event as a day. An all-day event
 * shows a window as a bar — which is what a reader wants — but it cannot show that the close is at
 * 23:59 Eastern, so the description says it, with the stored instant beside it.
 */
function datingSentences(c: CalendarCycle): string[] {
  const out: string[] = [];
  const exact = (ms: number, day: string): string => {
    if (c.zone === '' || c.dayPrecision) return day;
    const wall = zonedWallStamp(ms, c.zone);
    return `${day} ${wall.slice(9, 11)}:${wall.slice(11, 13)} ${c.zone} (${new Date(ms).toISOString()})`;
  };

  if (c.kind === 'WINDOW' && c.openMs !== undefined) out.push(`Opens ${exact(c.openMs, c.openDay)}.`);
  if (c.closeMs !== undefined) out.push(`Closes ${exact(c.closeMs, c.closeDay)}.`);
  else if (c.openMs !== undefined) {
    out.push(`Opens ${exact(c.openMs, c.openDay)}. No closing date is published.`);
  }

  if (c.zone === '') {
    out.push(
      'The funder published a date with no time of day and no time zone, so this is an all-day ' +
        'event and the day is the date exactly as published, read in UTC. It is not a claim about ' +
        'the funder’s own working day.',
    );
  } else if (c.dayPrecision) {
    out.push(
      `The funder published a date with no time of day, so this is an all-day event on that date ` +
        `as published. Nothing here converts it into or out of ${c.zone}.`,
    );
  } else if (c.tzid === undefined) {
    out.push(
      `GrantSpotter ships no time-zone definition for ${c.zone}, so this event carries the exact ` +
        'UTC instant instead of a floating local time. Your calendar will show it in your own zone.',
    );
  }
  return out;
}

/**
 * One VEVENT, as unfolded lines. Returns `[]` for a cycle with no dates, and for a suppressed
 * programme: the gate is inside `buildIcsCalendar` too, but a direct caller must not be able to
 * route around it. That is the same belt-and-braces `buildExportRows` applies after
 * `selectExportPrograms` has already gated what the browse projection handed back.
 */
export function cycleToVevent(
  cycle: Cycle,
  program: Program,
  nowISO: string,
  alarmDaysBefore = 14,
): string[] {
  if (isDoNotPublish(program)) return [];
  const c = classify(cycle);
  if (c === undefined) return [];

  const stamp = utcStamp(Date.parse(nowISO));
  const lines: string[] = [
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(cycle.id)}@grantspotter`,
    `DTSTAMP:${stamp}`,
    `LAST-MODIFIED:${stamp}`,
    'SEQUENCE:0',
    ...timing(c),
    `SUMMARY:${escapeIcsText(summaryFor(c, cycle, program))}`,
  ];

  const description = [
    `Deadline basis: ${cycle.isEstimated ? DEADLINE_BASIS_PROJECTED : DEADLINE_BASIS_PUBLISHED}.`,
    cycle.isEstimated
      ? 'This date was computed by GrantSpotter from the funder’s stated recurrence rule and was ' +
        'not observed on the funder’s page. Check it on the funder’s own site before relying on it.'
      : 'This date was published by the funder.',
    ...datingSentences(c),
    program.summary,
    `Award: ${program.amount.amountRaw} (${program.amount.awardCountRaw})`,
    `Status: ${program.trust.status}`,
    program.applyUrl === undefined ? `Source: ${program.trust.sourceUrl}` : `Apply: ${program.applyUrl}`,
    `GrantSpotter: last verified ${program.trust.lastVerifiedAt} via ${program.trust.verificationMethod}.`,
    program.trust.disputed === undefined ? '' : `DISPUTED: ${program.trust.disputed.note}`,
    program.trust.staleMirrorWarning ?? '',
  ].filter((part) => part.length > 0);
  lines.push(`DESCRIPTION:${escapeIcsText(description.join('\n'))}`);

  lines.push(`URL:${program.applyUrl ?? program.trust.sourceUrl}`);
  lines.push(
    `CATEGORIES:${[program.klass, KIND_WORD[c.kind]].map(escapeIcsText).join(',')}`,
  );
  // TENTATIVE is RFC 5545's own word for a date that is not confirmed. A client that renders
  // nothing but the grid still shows the doubt.
  lines.push(`STATUS:${cycle.isEstimated ? 'TENTATIVE' : 'CONFIRMED'}`);
  lines.push('TRANSP:TRANSPARENT');
  lines.push(`X-GRANTSPOTTER-ESTIMATED:${cycle.isEstimated ? 'TRUE' : 'FALSE'}`);
  lines.push(`X-GRANTSPOTTER-CYCLE-KIND:${c.kind}`);
  lines.push(`X-GRANTSPOTTER-PROGRAM-ID:${escapeIcsText(program.id)}`);

  /*
   * AN ABSOLUTE TRIGGER, NOT `-P14D`. A relative trigger counts from DTSTART, and for the 233
   * window cycles in this corpus DTSTART is the day the window OPENS — so `-P14D` would fire up to
   * a month before the date that matters and nowhere near the close. An absolute UTC instant fires
   * exactly `alarmDaysBefore` days before the real close for every event shape, and `ics.test.ts`
   * asserts that difference rather than the spelling.
   */
  lines.push('BEGIN:VALARM');
  lines.push('ACTION:DISPLAY');
  lines.push(
    `TRIGGER;VALUE=DATE-TIME:${utcStamp(c.anchorMs - alarmDaysBefore * 86_400_000)}`,
  );
  lines.push(
    `DESCRIPTION:${escapeIcsText(
      `${alarmDaysBefore} days to the ${program.name} ${KIND_WORD[c.kind] === 'opens' ? 'opening' : KIND_WORD[c.kind]}.`,
    )}`,
  );
  lines.push('END:VALARM');

  lines.push('END:VEVENT');
  return lines;
}

/* ------------------------------------------------------------------------------- the VCALENDAR */

/** PLAN-LOCAL TYPE. The CONTRACT does not define a calendar input shape. */
export interface IcsCalendarInput {
  calendarName: string;
  cycles: readonly Cycle[];
  programsById: ReadonlyMap<string, Program>;
  nowISO: string;
  alarmDaysBefore?: number;
}

const CALDESC =
  'Most dates in this calendar are estimated by GrantSpotter from a funder’s stated recurrence ' +
  'rule, not published by the funder. Events whose title begins “(estimated)” are projections: ' +
  'confirm them on the funder’s own page before relying on them.';

/**
 * The calendar. THE SUPPRESSION GATE RUNS HERE AND IS NOT OPTIONAL.
 *
 * This is not defensive decoration. `/exports/deadlines.ics` and `/calendar/:token.ics` used to
 * build `programsById` from `deps.data.listPrograms()` with NO filter at all — which was both a
 * gate this had to catch for and, measured on the live site, a calendar that ignored the user's
 * filters outright. Both now select through `selectExportPrograms` like every other format, and
 * the gate stays here regardless: a calendar subscription re-fetches on a schedule into a device
 * the user carries, so it is the least recoverable place one of the 553 suppressed records could
 * surface. The gate belongs where it cannot be forgotten.
 */
export function buildIcsCalendar(input: IcsCalendarInput): string {
  const { calendarName, cycles, programsById, nowISO, alarmDaysBefore = 14 } = input;

  const publishable = new Map(
    exportablePrograms([...programsById.values()]).map((p) => [p.id, p]),
  );

  // A stable order, so two runs over the same data — in whatever order a query returned them —
  // produce the same file, and a subscription does not re-download an identical calendar.
  const ordered = [...cycles].sort((a, b) => {
    const key = (c: Cycle): string => c.closesAt ?? c.opensAt ?? '';
    const byDate = key(a).localeCompare(key(b));
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
  });

  const events: string[] = [];
  const zones = new Set<string>();
  for (const cycle of ordered) {
    const program = publishable.get(cycle.programId);
    if (program === undefined) continue;
    const vevent = cycleToVevent(cycle, program, nowISO, alarmDaysBefore);
    if (vevent.length === 0) continue;
    for (const line of vevent) {
      const match = /^DT(?:START|END);TZID=([^:;]+):/.exec(line);
      if (match !== null) zones.add(match[1]);
    }
    events.push(...vevent);
  }

  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GrantSpotter//GrantSpotter//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    `X-WR-CALDESC:${escapeIcsText(CALDESC)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];

  const tzBlocks: string[] = [];
  for (const zone of [...zones].sort()) {
    const block = VTIMEZONE_BLOCKS[zone];
    /* c8 ignore next */
    if (block !== undefined) tzBlocks.push(...block.split('\n'));
  }

  return [...head, ...tzBlocks, ...events, 'END:VCALENDAR'].map(foldIcsLine).join('\r\n') + '\r\n';
}
