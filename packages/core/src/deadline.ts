import type { Program } from './types.js';

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

function parseMonthDay(raw: string, context: string): MonthDay {
  const m = /^(\d{2})-(\d{2})$/.exec(raw);
  if (m === null) {
    throw new RecurrenceParseError(`${context}: "${raw}" is not an MM-DD date`);
  }
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RecurrenceParseError(`${context}: "${raw}" is out of range`);
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
