import { beforeAll, describe, expect, it } from 'vitest';
import type { Cycle } from '@grantspotter/core';
import { zonedWallTimeToUtcISO } from '@grantspotter/core';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
import {
  buildIcsCalendar,
  cycleToVevent,
  escapeIcsText,
  foldIcsLine,
  ICS_ESTIMATED_PREFIX,
} from './ics.js';
import { VTIMEZONE_BLOCKS } from './icsTimezones.js';
import { DEADLINE_BASIS_PROJECTED, DEADLINE_BASIS_PUBLISHED, funderLocalDay } from './rows.js';
import { makeCycle, makeProgram, makeSuppressedProgram } from './testFixtures.js';
import { loadExportCorpus, type ExportCorpus } from './testCorpus.js';

const NOW = '2026-08-02T12:00:00.000Z';

/* ------------------------------------------------------------------ an ICS reader, not a matcher */

/**
 * A calendar file is only correct if a CLIENT reading it back arrives at the right instant, so
 * everything below parses the output rather than grepping it. Unfolding first, because a property
 * that has been folded is not findable by `includes` — which is exactly why unfolded output
 * truncates silently in real clients.
 */
function unfold(ics: string): string[] {
  const out: string[] = [];
  for (const line of ics.split('\r\n')) {
    if (line.startsWith(' ') && out.length > 0) out[out.length - 1] += line.slice(1);
    else if (line.length > 0) out.push(line);
  }
  return out;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseProp(line: string): Prop {
  const colon = line.indexOf(':');
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    params[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return { name, params, value };
}

function components(lines: string[], name: string): Prop[][] {
  const out: Prop[][] = [];
  let current: Prop[] | undefined;
  let depth = 0;
  for (const line of lines) {
    if (line === `BEGIN:${name}`) {
      current = [];
      depth = 0;
      continue;
    }
    if (current === undefined) continue;
    if (line === `END:${name}` && depth === 0) {
      out.push(current);
      current = undefined;
      continue;
    }
    if (line.startsWith('BEGIN:')) depth += 1;
    if (line.startsWith('END:')) depth -= 1;
    current.push(parseProp(line));
  }
  return out;
}

function prop(props: Prop[], name: string): Prop | undefined {
  return props.find((p) => p.name === name);
}

/* -------------------------------------------- a VTIMEZONE evaluator, so the blocks prove themselves */

function offsetToMinutes(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1;
  return sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(3, 5)));
}

/** Day of month of the `n`th Sunday of a month (1-based month, UTC arithmetic). */
function nthSunday(year: number, month: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + (n - 1) * 7;
}

/**
 * The offset a CLIENT would apply, derived from the shipped `VTIMEZONE` block's own `RRULE`s and
 * `TZOFFSETTO`s — not from ICU. That is the whole point: this recomputes what the file says, so
 * comparing it against ICU compares OUR data with the real IANA rules.
 */
function offsetFromBlock(block: string, wallMs: number): number {
  const lines = block.split('\n');
  const sub = (name: string): string[] => {
    const start = lines.indexOf(`BEGIN:${name}`);
    if (start < 0) return [];
    return lines.slice(start + 1, lines.indexOf(`END:${name}`, start));
  };
  const to = (body: string[]): number =>
    offsetToMinutes(body.find((l) => l.startsWith('TZOFFSETTO:'))!.slice('TZOFFSETTO:'.length));
  const daylight = sub('DAYLIGHT');
  const standard = sub('STANDARD');
  if (daylight.length === 0) return to(standard);

  const rule = (body: string[]): { month: number; nth: number } => {
    const rrule = body.find((l) => l.startsWith('RRULE:'))!;
    const month = Number(/BYMONTH=(\d+)/.exec(rrule)![1]);
    const nth = Number(/BYDAY=(\d)SU/.exec(rrule)![1]);
    return { month, nth };
  };
  const hourOf = (body: string[]): number =>
    Number(body.find((l) => l.startsWith('DTSTART:'))!.slice('DTSTART:'.length + 9, 'DTSTART:'.length + 11));

  const year = new Date(wallMs).getUTCFullYear();
  const dstRule = rule(daylight);
  const stdRule = rule(standard);
  const dstStart = Date.UTC(year, dstRule.month - 1, nthSunday(year, dstRule.month, dstRule.nth), hourOf(daylight));
  const dstEnd = Date.UTC(year, stdRule.month - 1, nthSunday(year, stdRule.month, stdRule.nth), hourOf(standard));
  return wallMs >= dstStart && wallMs < dstEnd ? to(daylight) : to(standard);
}

/** The UTC instant a client would compute for a DTSTART/DTEND, using only what the file carries. */
function instantOf(p: Prop, ics: string): number {
  if (p.params.VALUE === 'DATE') {
    const [y, m, d] = [p.value.slice(0, 4), p.value.slice(4, 6), p.value.slice(6, 8)].map(Number);
    return Date.UTC(y, m - 1, d);
  }
  const [y, mo, d, h, mi, s] = [
    p.value.slice(0, 4),
    p.value.slice(4, 6),
    p.value.slice(6, 8),
    p.value.slice(9, 11),
    p.value.slice(11, 13),
    p.value.slice(13, 15),
  ].map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  if (p.value.endsWith('Z')) return wall;
  const tzid = p.params.TZID;
  expect(tzid, 'a floating time with no TZID and no Z is unanchored').toBeTruthy();
  const blocks = components(unfold(ics), 'VTIMEZONE');
  const block = blocks.find((b) => prop(b, 'TZID')?.value === tzid);
  expect(block, `the file must carry a VTIMEZONE for ${tzid}`).toBeTruthy();
  return wall - offsetFromBlock(VTIMEZONE_BLOCKS[tzid], wall) * 60_000;
}

const PROGRAM = makeProgram();
const PROGRAMS = new Map([[PROGRAM.id, PROGRAM]]);

function calendar(cycles: Cycle[], extra: Partial<Parameters<typeof buildIcsCalendar>[0]> = {}): string {
  return buildIcsCalendar({
    calendarName: 'GrantSpotter deadlines',
    cycles,
    programsById: PROGRAMS,
    nowISO: NOW,
    ...extra,
  });
}

/* ----------------------------------------------------------------------------------- line folding */

describe('foldIcsLine', () => {
  it('leaves a short line alone', () => {
    expect(foldIcsLine('SUMMARY:hi')).toBe('SUMMARY:hi');
  });

  it('folds a long line at 75 octets with a leading space on continuations', () => {
    const folded = foldIcsLine(`DESCRIPTION:${'a'.repeat(200)}`);
    const lines = folded.split('\r\n');
    expect(lines[0].length).toBe(75);
    expect(lines.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    expect(lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(
      `DESCRIPTION:${'a'.repeat(200)}`,
    );
  });

  it('never splits a multi-byte character across a fold', () => {
    const folded = foldIcsLine(`SUMMARY:${'€'.repeat(60)}`);
    for (const line of folded.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
      expect(line).not.toContain('�');
    }
    const lines = folded.split('\r\n');
    expect(lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(`SUMMARY:${'€'.repeat(60)}`);
  });

  it('keeps an astral character whole', () => {
    const folded = foldIcsLine(`SUMMARY:${'x'.repeat(70)}${'\u{1F4E1}'.repeat(4)}`);
    const lines = folded.split('\r\n');
    expect(lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('')).toBe(
      `SUMMARY:${'x'.repeat(70)}${'\u{1F4E1}'.repeat(4)}`,
    );
    expect(folded).not.toContain('�');
  });
});

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon, comma and newline', () => {
    expect(escapeIcsText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });

  it('escapes a lone CR as well, which a funder’s pasted text can carry', () => {
    expect(escapeIcsText('a\rb\r\nc')).toBe('a\\nb\\nc');
  });
});

/* ---------------------------------------------------------------- windows versus single deadlines */

describe('cycleToVevent — a window is not a deadline', () => {
  it('renders a timed deadline in the funder’s own zone, and it round-trips to the stored instant', () => {
    // The corpus shape: a UTC INSTANT of a 23:59 local wall time. Rendering the UTC clock face as
    // if it were local would put this event on 2 September — a day the applicant does not have.
    const cycle = makeCycle({ closesAt: '2026-09-02T06:59:00.000Z', timezone: 'America/Los_Angeles' });
    const ics = calendar([cycle]);
    const event = components(unfold(ics), 'VEVENT')[0];
    const start = prop(event, 'DTSTART')!;
    expect(start.params.TZID).toBe('America/Los_Angeles');
    expect(start.value).toBe('20260901T235900');
    expect(instantOf(start, ics)).toBe(Date.parse(cycle.closesAt!));
    expect(instantOf(prop(event, 'DTEND')!, ics) - instantOf(start, ics)).toBe(3_600_000);
    expect(prop(event, 'X-GRANTSPOTTER-CYCLE-KIND')!.value).toBe('DEADLINE');
  });

  it('renders a window as ONE all-day event spanning the funder’s open..close days, DTEND exclusive', () => {
    // ARRL: opens 2026-10-01 00:00 EDT, closes 2026-10-31 23:59 EDT.
    const cycle = makeCycle({
      id: 'arrl-arg-2026-10',
      opensAt: '2026-10-01T04:00:00.000Z',
      closesAt: '2026-11-01T03:59:00.000Z',
      timezone: 'America/New_York',
      label: 'Oct 1–31, 2026 window',
    });
    const ics = calendar([cycle]);
    const event = components(unfold(ics), 'VEVENT')[0];
    expect(prop(event, 'DTSTART')!.value).toBe('20261001');
    expect(prop(event, 'DTSTART')!.params.VALUE).toBe('DATE');
    // The window's last day is the 31st, so the EXCLUSIVE end is the 1st of November. A DTEND of
    // 20261031 would render the window a day short — and the last day is the one that matters.
    expect(prop(event, 'DTEND')!.value).toBe('20261101');
    expect(prop(event, 'X-GRANTSPOTTER-CYCLE-KIND')!.value).toBe('WINDOW');
    expect(prop(event, 'SUMMARY')!.value).toContain('window');
    // The exact close instant is not lost just because the event is all-day.
    expect(prop(event, 'DESCRIPTION')!.value).toContain('2026-10-31 23:59 America/New_York');
    expect(prop(event, 'DESCRIPTION')!.value).toContain('2026-11-01T03:59:00.000Z');
  });

  it('treats a one-day "window" as a deadline, which is what two IEEE programmes were remodelled to', () => {
    // A one-day window reads `closed` on 364 days a year and invents an opening date the funder
    // never printed. Opens and closes on the same funder-local day IS a deadline.
    const cycle = makeCycle({
      opensAt: '2026-09-02T00:00:00.000Z',
      closesAt: '2026-09-02T06:59:00.000Z',
      timezone: 'America/Los_Angeles',
      label: 'Sep 1, 2026',
    });
    const event = components(unfold(calendar([cycle])), 'VEVENT')[0];
    expect(prop(event, 'X-GRANTSPOTTER-CYCLE-KIND')!.value).toBe('DEADLINE');
    expect(prop(event, 'SUMMARY')!.value).toContain('deadline');
    expect(prop(event, 'SUMMARY')!.value).not.toContain('window');
  });

  it('renders a cycle with NO funder zone as an all-day event and says so, rather than inventing a time', () => {
    // `observedCycles` stores a funder-published DATE as `…T23:59:59.999Z` with `timezone: 'UTC'`,
    // documented there as a day-precision FRAME and explicitly not a claim about where the funder
    // is. Rendered as a timed UTC event it would land on the NEXT day for anyone east of London.
    const cycle = makeCycle({
      id: 'yaesu:observed:2026-08-31T23:59:59.999Z',
      closesAt: '2026-08-31T23:59:59.999Z',
      timezone: 'UTC',
      isEstimated: false,
      label: 'Aug 31, 2026 deadline',
    });
    const ics = calendar([cycle]);
    const event = components(unfold(ics), 'VEVENT')[0];
    expect(prop(event, 'DTSTART')!.params.VALUE).toBe('DATE');
    expect(prop(event, 'DTSTART')!.value).toBe('20260831');
    expect(prop(event, 'DTEND')!.value).toBe('20260901');
    expect(prop(event, 'DESCRIPTION')!.value).toContain('no time zone');
    expect(prop(event, 'DESCRIPTION')!.value).toContain('UTC');
    expect(ics).not.toContain('BEGIN:VTIMEZONE');
  });

  it('never re-zones a bare YYYY-MM-DD, which would move it a day', () => {
    // A date-only close is a calendar DAY, not an instant. Reading `2027-02-01` as UTC midnight and
    // then asking what day that is in America/Los_Angeles answers "31 January" — a day early, and
    // invented entirely by the renderer. `funderLocalDay` has the same rule for the same reason.
    const cycle = makeCycle({ closesAt: '2027-02-01', timezone: 'America/Los_Angeles' });
    const ics = calendar([cycle]);
    const event = components(unfold(ics), 'VEVENT')[0];
    expect(prop(event, 'DTSTART')!.params.VALUE).toBe('DATE');
    expect(prop(event, 'DTSTART')!.value).toBe('20270201');
    expect(prop(event, 'DTEND')!.value).toBe('20270202');
    expect(prop(event, 'DTSTART')!.value).not.toBe('20270131');
    expect(prop(event, 'DESCRIPTION')!.value).toContain('no time of day');
    expect(ics).not.toContain('BEGIN:VTIMEZONE');
    // The reminder counts back from the END of that day, not from its midnight — otherwise it
    // fires a day early. (ICS has no sub-second precision, so the stored .999 truncates.)
    const alarm = components(unfold(ics), 'VALARM')[0];
    expect(new Date(instantOf(prop(alarm, 'TRIGGER')!, '')).toISOString()).toBe(
      '2027-01-18T23:59:59.000Z',
    );
  });

  it('falls back to an exact UTC instant when a zone has no VTIMEZONE to ship', () => {
    // A bare TZID with no definition makes a client GUESS, usually the viewer's own zone. Writing
    // the instant is uglier and exact.
    const cycle = makeCycle({ closesAt: '2026-09-02T06:59:00.000Z', timezone: 'Europe/London' });
    const ics = calendar([cycle]);
    const event = components(unfold(ics), 'VEVENT')[0];
    expect(prop(event, 'DTSTART')!.params.TZID).toBeUndefined();
    expect(prop(event, 'DTSTART')!.value).toBe('20260902T065900Z');
    expect(instantOf(prop(event, 'DTSTART')!, ics)).toBe(Date.parse(cycle.closesAt!));
    expect(prop(event, 'DESCRIPTION')!.value).toContain('Europe/London');
    expect(ics).not.toContain('BEGIN:VTIMEZONE');
  });

  it('renders an opening-only cycle as an opening, never as a deadline', () => {
    const cycle: Cycle = {
      id: 'opens-only',
      programId: PROGRAM.id,
      opensAt: '2026-10-01T04:00:00.000Z',
      timezone: 'America/New_York',
      label: 'Applications open',
      isEstimated: true,
    };
    const event = components(unfold(calendar([cycle])), 'VEVENT')[0];
    expect(prop(event, 'X-GRANTSPOTTER-CYCLE-KIND')!.value).toBe('OPENING');
    expect(prop(event, 'DTSTART')!.value).toBe('20261001');
    expect(prop(event, 'SUMMARY')!.value).toContain('opens');
  });

  it('emits nothing for a cycle with neither an open nor a close', () => {
    const cycle: Cycle = {
      id: 'empty',
      programId: PROGRAM.id,
      timezone: 'America/New_York',
      label: 'Nothing',
      isEstimated: true,
    };
    expect(cycleToVevent(cycle, PROGRAM, NOW)).toEqual([]);
    expect(calendar([cycle])).not.toContain('BEGIN:VEVENT');
  });
});

/* ------------------------------------------------------- a projected date must never look published */

describe('cycleToVevent — a projected date says it is projected', () => {
  it('marks an estimated cycle in the summary, the status and an X- property, and explains it', () => {
    const event = components(unfold(calendar([makeCycle({ isEstimated: true })])), 'VEVENT')[0];
    expect(prop(event, 'SUMMARY')!.value.startsWith(ICS_ESTIMATED_PREFIX)).toBe(true);
    expect(ICS_ESTIMATED_PREFIX).toBe('(estimated) ');
    // TENTATIVE is the format's OWN word for "this date is not confirmed", so a client that never
    // shows a description still renders the doubt.
    expect(prop(event, 'STATUS')!.value).toBe('TENTATIVE');
    expect(prop(event, 'X-GRANTSPOTTER-ESTIMATED')!.value).toBe('TRUE');
    const description = prop(event, 'DESCRIPTION')!.value;
    expect(description).toContain(escapeIcsText(DEADLINE_BASIS_PROJECTED));
    expect(description).toContain('not observed on the funder');
  });

  it('marks a funder-published cycle as confirmed and does not hedge it', () => {
    const event = components(unfold(calendar([makeCycle({ isEstimated: false })])), 'VEVENT')[0];
    expect(prop(event, 'SUMMARY')!.value.startsWith(ICS_ESTIMATED_PREFIX)).toBe(false);
    expect(prop(event, 'STATUS')!.value).toBe('CONFIRMED');
    expect(prop(event, 'X-GRANTSPOTTER-ESTIMATED')!.value).toBe('FALSE');
    expect(prop(event, 'DESCRIPTION')!.value).toContain(escapeIcsText(DEADLINE_BASIS_PUBLISHED));
  });

  it('uses a stable UID from the cycle id and a DTSTAMP from nowISO', () => {
    const event = components(unfold(calendar([makeCycle()])), 'VEVENT')[0];
    expect(prop(event, 'UID')!.value).toBe('ardc-grants-2027-02@grantspotter');
    expect(prop(event, 'DTSTAMP')!.value).toBe('20260802T120000Z');
  });

  it('carries the award, the status, the apply URL and the verification provenance', () => {
    const description = prop(
      components(unfold(calendar([makeCycle()])), 'VEVENT')[0],
      'DESCRIPTION',
    )!.value;
    expect(description).toContain('$1\\,285-$258\\,000');
    expect(description).toContain('https://www.ardc.net/apply/');
    expect(description).toContain('last verified 2026-08-02');
    expect(description).toContain('seed_import');
  });
});

/* -------------------------------------------------------------------------------- the alarm is real */

describe('the reminder fires before the close, not before whatever DTSTART happens to be', () => {
  it('fires 14 days before the CLOSE instant of a deadline', () => {
    const cycle = makeCycle({ closesAt: '2026-09-02T06:59:00.000Z', timezone: 'America/Los_Angeles' });
    const alarm = components(unfold(calendar([cycle])), 'VALARM')[0];
    const trigger = prop(alarm, 'TRIGGER')!;
    expect(trigger.params.VALUE).toBe('DATE-TIME');
    expect(Date.parse(cycle.closesAt!) - instantOf(trigger, '')).toBe(14 * 86_400_000);
  });

  it('fires 14 days before the CLOSE of a WINDOW, not 14 days before it opens', () => {
    // A relative `TRIGGER:-P14D` on a window fires 14 days before the window OPENS — for the 233
    // window cycles in this corpus that is a month early, and it is not the date that matters.
    const cycle = makeCycle({
      opensAt: '2026-10-01T04:00:00.000Z',
      closesAt: '2026-11-01T03:59:00.000Z',
      timezone: 'America/New_York',
    });
    const alarm = components(unfold(calendar([cycle])), 'VALARM')[0];
    expect(Date.parse(cycle.closesAt!) - instantOf(prop(alarm, 'TRIGGER')!, '')).toBe(14 * 86_400_000);
  });

  it('honours an override', () => {
    const cycle = makeCycle({ closesAt: '2026-09-02T06:59:00.000Z' });
    const alarm = components(unfold(calendar([cycle], { alarmDaysBefore: 60 })), 'VALARM')[0];
    expect(Date.parse(cycle.closesAt!) - instantOf(prop(alarm, 'TRIGGER')!, '')).toBe(60 * 86_400_000);
  });
});

/* -------------------------------------------------------------------------------- the VCALENDAR */

describe('buildIcsCalendar', () => {
  it('wraps events in a VCALENDAR with PRODID, VERSION, a refresh interval and the estimated caveat', () => {
    const ics = calendar([makeCycle()]);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    const lines = unfold(ics);
    expect(lines).toContain('VERSION:2.0');
    expect(lines).toContain('PRODID:-//GrantSpotter//GrantSpotter//EN');
    expect(lines).toContain('X-WR-CALNAME:GrantSpotter deadlines');
    expect(lines).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT12H');
    expect(lines.some((l) => l.startsWith('X-WR-CALDESC:') && l.includes('estimated'))).toBe(true);
    // A claim about the calendar's display zone that no event needs, and that changes how some
    // clients place all-day events. Nothing here floats, so nothing here needs it.
    expect(ics).not.toContain('X-WR-TIMEZONE');
  });

  it('emits a VTIMEZONE only for zones a timed event actually uses', () => {
    const ics = calendar([
      makeCycle({ closesAt: '2026-12-30T17:00:00.000Z', timezone: 'America/New_York' }),
    ]);
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(unfold(ics)).toContain('TZID:America/New_York');
    expect(ics).not.toContain('America/Chicago');
  });

  it('ships a VTIMEZONE for every TZID it writes', () => {
    const ics = calendar([
      makeCycle({ id: 'a', closesAt: '2026-12-30T17:00:00.000Z', timezone: 'America/New_York' }),
      makeCycle({ id: 'b', closesAt: '2026-12-30T18:00:00.000Z', timezone: 'America/Chicago' }),
      makeCycle({ id: 'c', closesAt: '2026-12-31T07:59:00.000Z', timezone: 'America/Los_Angeles' }),
    ]);
    const lines = unfold(ics);
    const declared = new Set(
      components(lines, 'VTIMEZONE').map((b) => prop(b, 'TZID')!.value),
    );
    const used = new Set(
      lines
        .map(parseProp)
        .filter((p) => p.name === 'DTSTART' || p.name === 'DTEND')
        .map((p) => p.params.TZID)
        .filter((t): t is string => t !== undefined),
    );
    expect([...used].sort()).toEqual(['America/Chicago', 'America/Los_Angeles', 'America/New_York']);
    for (const tzid of used) expect(declared.has(tzid), tzid).toBe(true);
  });

  it('emits no VTIMEZONE when every event is all-day', () => {
    expect(calendar([makeCycle()])).not.toContain('BEGIN:VTIMEZONE');
  });

  it('skips cycles whose program is missing rather than throwing', () => {
    expect(calendar([makeCycle({ programId: 'ghost' })])).not.toContain('BEGIN:VEVENT');
  });

  it('uses CRLF everywhere, as RFC 5545 requires', () => {
    const ics = calendar([makeCycle()]);
    expect(ics.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
  });

  it('folds every line to 75 octets, so no client truncates a description', () => {
    const ics = calendar([
      makeCycle({
        closesAt: '2026-12-30T17:00:00.000Z',
        timezone: 'America/New_York',
        label: 'a very long label '.repeat(12),
      }),
    ]);
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8'), line.slice(0, 40)).toBeLessThanOrEqual(75);
    }
  });

  it('orders events by the date they concern, so two runs of the same data agree', () => {
    const a = makeCycle({ id: 'z', closesAt: '2027-05-01T06:59:00.000Z' });
    const b = makeCycle({ id: 'a', closesAt: '2026-09-02T06:59:00.000Z' });
    expect(calendar([a, b])).toBe(calendar([b, a]));
    const uids = components(unfold(calendar([a, b])), 'VEVENT').map((e) => prop(e, 'UID')!.value);
    expect(uids).toEqual(['a@grantspotter', 'z@grantspotter']);
  });
});

/* ------------------------------------------------------- the VTIMEZONE blocks, checked against ICU */

describe('the shipped VTIMEZONE blocks agree with the real IANA rules', () => {
  const WALL_TIMES: Array<[number, number, number, number]> = [];
  for (const year of [2026, 2027, 2028]) {
    for (const month of [1, 2, 3, 4, 6, 7, 9, 10, 11, 12]) {
      for (const day of [1, 8, 14, 15, 22, 28]) {
        WALL_TIMES.push([year, month, day, 23]);
        WALL_TIMES.push([year, month, day, 12]);
      }
    }
  }

  for (const tzid of Object.keys(VTIMEZONE_BLOCKS)) {
    it(`${tzid} resolves every wall time to the same instant ICU does`, () => {
      for (const [y, m, d, h] of WALL_TIMES) {
        const wall = Date.UTC(y, m - 1, d, h, 59, 0);
        const fromBlock = wall - offsetFromBlock(VTIMEZONE_BLOCKS[tzid], wall) * 60_000;
        const fromIcu = Date.parse(zonedWallTimeToUtcISO(y, m, d, h, 59, 0, tzid));
        expect(new Date(fromBlock).toISOString(), `${tzid} ${y}-${m}-${d} ${h}:59`).toBe(
          new Date(fromIcu).toISOString(),
        );
      }
    });
  }

  it('places the transitions on the exact days ICU does, both sides', () => {
    // 2027: DST starts Sunday 14 March, ends Sunday 7 November.
    const ny = VTIMEZONE_BLOCKS['America/New_York'];
    expect(offsetFromBlock(ny, Date.UTC(2027, 2, 14, 1))).toBe(-300); // 01:00, still EST
    expect(offsetFromBlock(ny, Date.UTC(2027, 2, 14, 3))).toBe(-240); // 03:00, now EDT
    expect(offsetFromBlock(ny, Date.UTC(2027, 10, 7, 1))).toBe(-240); // 01:00, still EDT
    expect(offsetFromBlock(ny, Date.UTC(2027, 10, 7, 3))).toBe(-300); // 03:00, now EST
  });

  it('does not pretend Arizona or Hawaii observe DST', () => {
    for (const tzid of ['America/Phoenix', 'Pacific/Honolulu']) {
      expect(VTIMEZONE_BLOCKS[tzid]).not.toContain('DAYLIGHT');
      expect(offsetFromBlock(VTIMEZONE_BLOCKS[tzid], Date.UTC(2027, 6, 1, 12))).toBe(
        offsetFromBlock(VTIMEZONE_BLOCKS[tzid], Date.UTC(2027, 0, 1, 12)),
      );
    }
  });
});

/* ------------------------------------------------------------------------ the suppression boundary */

/**
 * A calendar SUBSCRIPTION is the worst place a suppressed record could surface: it re-fetches
 * forever, on a schedule, into a device the user carries. Task 9's route builds `programsById`
 * from `listPrograms()` with no filter at all, so the gate has to live in here — and it does,
 * twice: `buildIcsCalendar` gates the programme map, and `cycleToVevent` refuses a suppressed
 * programme even when it is called directly.
 */
describe('no suppressed record can reach a calendar', () => {
  it('refuses a suppressed programme handed straight to cycleToVevent', () => {
    const suppressed = makeSuppressedProgram();
    expect(cycleToVevent(makeCycle({ programId: suppressed.id }), suppressed, NOW)).toEqual([]);
  });

  it('is byte-identical when suppressed programmes and their cycles are appended', () => {
    const suppressed = makeSuppressedProgram();
    const clean = calendar([makeCycle()]);
    const mixed = buildIcsCalendar({
      calendarName: 'GrantSpotter deadlines',
      cycles: [makeCycle(), makeCycle({ id: 'x', programId: suppressed.id })],
      programsById: new Map([...PROGRAMS, [suppressed.id, suppressed]]),
      nowISO: NOW,
    });
    expect(mixed).toBe(clean);
    expect(mixed).not.toContain(suppressed.id);
    expect(mixed).not.toContain(DO_NOT_PUBLISH_TAG);
  });
});

/* --------------------------------------------------------------------------------- the real corpus */

describe('the real corpus, as a calendar', () => {
  let corpus: ExportCorpus;
  let allCycles: Cycle[];
  let ics: string;
  let events: Prop[][];

  beforeAll(async () => {
    corpus = await loadExportCorpus();
    allCycles = [...corpus.cyclesByProgramId.values()].flat();
    ics = buildIcsCalendar({
      calendarName: 'GrantSpotter deadlines',
      cycles: allCycles,
      programsById: new Map(corpus.programs.map((p) => [p.id, p])),
      nowISO: corpus.now,
    });
    events = components(unfold(ics), 'VEVENT');
  }, 120_000);

  it('writes one event per projected cycle — 243 at the profiler’s clock', () => {
    expect(allCycles).toHaveLength(243);
    expect(events).toHaveLength(243);
    expect(new Set(events.map((e) => prop(e, 'UID')!.value)).size).toBe(243);
  });

  it('marks 239 of them estimated and exactly 4 as the funder’s own', () => {
    const estimated = events.filter((e) => prop(e, 'X-GRANTSPOTTER-ESTIMATED')!.value === 'TRUE');
    expect(estimated).toHaveLength(239);
    expect(allCycles.filter((c) => !c.isEstimated)).toHaveLength(4);
    expect(estimated.every((e) => prop(e, 'SUMMARY')!.value.startsWith(ICS_ESTIMATED_PREFIX))).toBe(true);
    expect(estimated.every((e) => prop(e, 'STATUS')!.value === 'TENTATIVE')).toBe(true);
    const confirmed = events.filter((e) => prop(e, 'X-GRANTSPOTTER-ESTIMATED')!.value === 'FALSE');
    expect(confirmed).toHaveLength(4);
    expect(confirmed.every((e) => prop(e, 'STATUS')!.value === 'CONFIRMED')).toBe(true);
  });

  it('splits into windows and deadlines the way the corpus is actually shaped', () => {
    const kinds = events.reduce<Record<string, number>>((acc, e) => {
      const kind = prop(e, 'X-GRANTSPOTTER-CYCLE-KIND')!.value;
      acc[kind] = (acc[kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(kinds).toEqual({ WINDOW: 233, DEADLINE: 10 });
  });

  it('lands EVERY timed event on the exact instant the cycle stores', () => {
    const byUid = new Map(allCycles.map((c) => [`${c.id}@grantspotter`, c]));
    let checked = 0;
    for (const event of events) {
      const start = prop(event, 'DTSTART')!;
      if (start.params.VALUE === 'DATE') continue;
      const cycle = byUid.get(prop(event, 'UID')!.value)!;
      expect(instantOf(start, ics), cycle.id).toBe(Date.parse(cycle.closesAt!));
      checked += 1;
    }
    // 10 deadlines, of which 2 are the funder-published day-precision ones that carry no zone and
    // therefore render all-day. 8 are timed.
    expect(checked).toBe(8);
  });

  it('lands EVERY all-day event on the funder’s own calendar day, with an exclusive end', () => {
    const byUid = new Map(allCycles.map((c) => [`${c.id}@grantspotter`, c]));
    const day = (v: string): string => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    const nextDay = (v: string): string =>
      new Date(Date.parse(`${day(v)}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
    let checked = 0;
    for (const event of events) {
      const start = prop(event, 'DTSTART')!;
      if (start.params.VALUE !== 'DATE') continue;
      const cycle = byUid.get(prop(event, 'UID')!.value)!;
      const zone = cycle.timezone === 'UTC' ? '' : cycle.timezone;
      // `funderLocalDay` is `rows.ts`'s answer to "which day is this instant, to the funder".
      // The calendar asks the same function the spreadsheet asks; there is no second answer.
      expect(day(start.value), cycle.id).toBe(funderLocalDay(cycle.opensAt ?? cycle.closesAt, zone));
      expect(nextDay(prop(event, 'DTEND')!.value), cycle.id).not.toBe(
        funderLocalDay(cycle.closesAt, zone),
      );
      expect(day(prop(event, 'DTEND')!.value), cycle.id).toBe(
        new Date(Date.parse(`${funderLocalDay(cycle.closesAt, zone)}T00:00:00.000Z`) + 86_400_000)
          .toISOString()
          .slice(0, 10),
      );
      checked += 1;
    }
    // 233 windows plus the 2 zone-less funder-published deadlines.
    expect(checked).toBe(235);
  });

  it('puts the ARRL grant window on the funder’s 31 October, never the UTC 1 November', () => {
    const event = events.find((e) =>
      prop(e, 'X-GRANTSPOTTER-PROGRAM-ID')!.value.startsWith('arrl-amateur-radio-grants--'),
    )!;
    expect(prop(event, 'DTSTART')!.value).toBe('20261001');
    expect(prop(event, 'DTEND')!.value).toBe('20261101'); // exclusive: the last day is the 31st
    expect(prop(event, 'DESCRIPTION')!.value).toContain('2026-10-31 23:59 America/New_York');
  });

  it('ships a VTIMEZONE for every TZID in the file, and no zone it does not use', () => {
    const lines = unfold(ics);
    const declared = components(lines, 'VTIMEZONE').map((b) => prop(b, 'TZID')!.value).sort();
    const used = [
      ...new Set(
        lines
          .map(parseProp)
          .filter((p) => p.name === 'DTSTART' || p.name === 'DTEND')
          .map((p) => p.params.TZID)
          .filter((t): t is string => t !== undefined),
      ),
    ].sort();
    expect(declared).toEqual(used);
    // The corpus's cycles carry four zones — New_York (233), Los_Angeles (5), Chicago (1) and the
    // day-precision UTC frame (4) — but only the TIMED ones need a TZID, and every Chicago cycle
    // is a window. So two blocks ship, and the file carries no definition it does not use.
    expect(used).toEqual(['America/Los_Angeles', 'America/New_York']);
  });

  it('folds every line in a 243-event file to 75 octets', () => {
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8'), line.slice(0, 40)).toBeLessThanOrEqual(75);
    }
  });

  it('is byte-identical with all 553 suppressed records and cycles pointing at them', () => {
    // The suppressed corpus projects NO cycles of its own today, because cycles are only written
    // when a record publishes — so appending it alone would prove nothing. These cycles are
    // therefore synthesised to model the real hazard: a record reclassified `do_not_publish` after
    // its cycles were already in the table, which is precisely the state Task 9's unfiltered
    // `listPrograms()` would hand to this function.
    expect(corpus.suppressedPrograms).toHaveLength(553);
    const planted = corpus.suppressedPrograms.map((p, i) => ({
      ...allCycles[i % allCycles.length],
      id: `${p.id}:planted`,
      programId: p.id,
    }));
    expect(planted).toHaveLength(553);
    const mixed = buildIcsCalendar({
      calendarName: 'GrantSpotter deadlines',
      cycles: [...allCycles, ...planted],
      programsById: new Map([...corpus.programs, ...corpus.suppressedPrograms].map((p) => [p.id, p])),
      nowISO: corpus.now,
    });
    expect(mixed.length).toBe(ics.length);
    expect(mixed).toBe(ics);
  }, 120_000);

  it('writes no suppressed id, name or tag into the bytes', () => {
    const publishable = new Set(corpus.programs.map((p) => p.name));
    expect(corpus.suppressedPrograms.filter((p) => ics.includes(p.id)).map((p) => p.id)).toEqual([]);
    expect(
      corpus.suppressedPrograms
        .filter((p) => !publishable.has(p.name))
        .filter((p) => ics.includes(p.name))
        .map((p) => p.name),
    ).toEqual([]);
    expect(ics).not.toContain(DO_NOT_PUBLISH_TAG);
    expect(ics).not.toMatch(/farweb\.org/i);
  });
});
