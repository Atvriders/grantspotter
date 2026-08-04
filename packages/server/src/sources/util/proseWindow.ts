/**
 * THE PROSE-WINDOW READER — one funder's window sentence in, month-days (and a year, only when the
 * page prints one) out.
 *
 * It has no I/O, no `SourceModule`, and no source of its own: it is a pure text helper of exactly
 * the same shape as `util/dates.ts` and `util/text.ts` beside it, so `sources/util/` is where it
 * belongs. It shipped inside `tier-c-b.ts` only because a new file under `sources/` needs an entry
 * in `registry.test.ts`'s `NOT_A_SOURCE_MODULE` allow-list — a shared invariant the task that wrote
 * it did not own. It now has one, naming this file and the reason it exports no module.
 *
 * THE FOUR PROGRAMMES IT EXISTS FOR.
 *
 * `normalize/deadline.ts` reads a funder-published window BY NAME out of `rawFields.opensAt` /
 * `closesAt` — that is the only channel a source has for saying "the funder printed these dates",
 * and it is the channel the precedence rule runs on (a date parsed off the funder's own page beats
 * every table in that file). Four programmes print an application window on their page, in prose,
 * and until this parser existed nothing turned any of them into dates:
 *
 *   arrl-etp-grants  "APPLICATIONS WILL ONLY BE ACCEPTED FOR REVIEW BETWEEN OCTOBER 1ST AND
 *                     OCTOBER 31ST of 2025."
 *   austin-arc       "Applications open May 1 and close July 31 each year."
 *   ieee-mtts        "IMPORTANT: All requests for MTT chapter funding must be received by
 *                     October 1 or the chapter may be asked to make its application in the
 *                     following year."
 *   ieee-student-…   "Student Branch Annual Plans are due 15 March."
 *
 * These are hand-written by volunteers, not to a schema, so the reader has to survive shouting
 * caps, ordinal suffixes, `and` used as a range separator, a year that arrives as "of 2025" three
 * words after the day it governs, the same-month shorthand "October 1 - 31", day-before-month
 * ("15 March"), and a month-granular range whose year sits at the far end of a filename-ish token
 * ("Jun-thru-Aug_2026"). Every one of those shapes is taken from a committed capture.
 *
 * WHAT IT REFUSES TO DO, and why that is the whole point of it.
 *
 * `yearUnstated` is a first-class result, not a failure. Three of the four sentences above name a
 * month and a day and NO YEAR anywhere on the page — Austin ARC's only four-digit number is the
 * footer's "© 2026 Austin Amateur Radio Club", IEEE's is "© Copyright 2026 IEEE", and a site
 * copyright is not a deadline. Filling that gap from the clock, or from the year the capture
 * happened to be taken in, would publish "closes 2026-10-01" over IEEE's name when IEEE has never
 * written 2026 next to that deadline. This parser therefore returns the month-day it read and says
 * the year is unstated, and its callers publish NO date rather than a plausible one.
 *
 * WHERE THE THREE YEARLESS ONES WENT, now that they have somewhere to go. A yearless annual rule
 * ("open May 1 and close July 31 each year") is a RECURRENCE, and the representation for a
 * recurrence — `RECUR annual_window window=05-01..07-31`, which carries no year by construction —
 * is `normalize/deadline.ts`'s `RECURRENCE_BY_SOURCE`, not a source's rawFields. All three now
 * have a directive there, keyed off the month-days this parser reads and asserted against them.
 * They still publish no `opensAt`/`closesAt`, and that separation is load-bearing: the rawFields
 * channel means ONE dated window, never repeated, and coercing a rule into it is what would put an
 * unannounced 2027 deadline on the calendar under a funder's name.
 *
 * `parseArissWindow` in `tier-c-b.ts` — the single-purpose window reader this generalises — stays
 * where it is: it is bound to one source's ARISS-specific sentence pattern, while everything here
 * is source-agnostic.
 */
const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

const MONTH_ALT = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
/** `1ST`, `2nd`, `3rd`, `31st` — matched case-insensitively with the rest of the pattern. */
const ORDINAL = '(?:st|nd|rd|th)';
const MAX_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function lastDayOf(month: number, year: number): number {
  return month === 2 && isLeap(year) ? 29 : MAX_DAY[month - 1];
}

/**
 * A month/day pair, in page order, WITH A DAY. A bare month name is deliberately never a token on
 * this path: "…or the chapter **may** be asked to make its application in the following year"
 * contains the month name `may`, and a scanner that accepted bare months would read IEEE MTT-S's
 * one-deadline sentence as a May-to-October window. The month-granular shape that legitimately has
 * no days is handled by `MONTH_RANGE` below, which requires two month names AND a year and so
 * cannot fire on an English sentence that happens to use "may" as a verb.
 *
 * Both orders in one alternation, scanned once left to right, so the two halves can never produce
 * overlapping tokens for the same text: groups 1-2 are `15 March`, groups 3-4 are `October 1ST`.
 */
const DATE_TOKEN = new RegExp(
  `(?:\\b(\\d{1,2})${ORDINAL}?\\s+(?:of\\s+)?(${MONTH_ALT})[a-z]*\\.?)` +
    `|(?:\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?!\\d)${ORDINAL}?)`,
  'gi',
);

/**
 * A year that belongs to the date token immediately before it — ANCHORED at the token's end, so
 * only text glued to the date can supply it.
 *
 * That anchoring is the guard against the footer. "Applications open May 1 and close July 31 each
 * year." sits on a page whose only four-digit number is a copyright, and an unanchored "find a year
 * somewhere nearby" search is precisely how a copyright becomes a deadline. Accepts ", 2025",
 * " of 2025", " in 2025", "_2026" and a bare " 2025", plus a leading ordinal for the "31ST of 2025"
 * shape where the token stopped before the suffix.
 */
const TRAILING_YEAR = new RegExp(`^${ORDINAL}?\\s*,?[\\s_]*(?:of\\s+|in\\s+)?((?:19|20)\\d{2})\\b`, 'i');

/**
 * The same-month shorthand: "October 1 - 31 of 2025" states two days and names the month once, so
 * `DATE_TOKEN` sees only one date. Consulted only when exactly one token was found, and it must
 * re-find the same month, so it can never invent a second window out of an unrelated number.
 */
const SAME_MONTH_RANGE = new RegExp(
  `\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})${ORDINAL}?\\s*[-\\u2013\\u2014]\\s*(\\d{1,2})${ORDINAL}?`,
  'i',
);

/**
 * A month-granular range with its year at the end: Yaesu's "Jun-thru-Aug_2026". Consulted only when
 * no day-bearing token was found at all.
 *
 * THREE things are required together, and each one keeps this off ordinary English. The year, so a
 * month-only range that could never resolve does not pretend to. A DASH or `thru`/`through` as the
 * separator — never a bare "to" or "and" — because a hyphenated or `thru` range is compact range
 * NOTATION, while "to" is how a sentence talks: ARISS's window sentence ends "…for contacts to be
 * held from January to June 2027", which is when a contact happens and not when anyone may apply,
 * and reading it as a window would put a six-month application period on the calendar out of a
 * clause about the ISS crew schedule. And two month names, so the lone "may" that is really a verb
 * cannot start one.
 */
const MONTH_RANGE = new RegExp(
  `\\b(${MONTH_ALT})[a-z]*\\.?` +
    `(?:[\\s_]*[-\\u2013\\u2014][\\s_]*|[\\s_\\-\\u2013\\u2014]*(?:thru|through)[\\s_\\-\\u2013\\u2014]*)` +
    `(${MONTH_ALT})[a-z]*\\.?[\\s_,\\-]*(?:of\\s+|in\\s+)?((?:19|20)\\d{2})\\b`,
  'i',
);

/**
 * Which end of a window a LONE date is. A sentence with two dates states both ends; a sentence with
 * one states a deadline far more often than an opening ("must be received by October 1", "due 15
 * March"), so `closesOn` is the default and only an opening verb with no closing verb anywhere
 * moves it. Getting this backwards is not symmetric: an open date alone leaves `inferStatus`'s
 * inference untouched, while a close date alone can turn a live programme `closed`.
 */
const OPEN_VERB = /\b(?:open|opens|opened|opening|begins?|beginning|starts?|starting)\b/i;
const CLOSE_VERB =
  /\b(?:close[sd]?|closing|due|deadlines?|received by|no later than|ends?|ending|submitted by)\b/i;

/** A funder's stated window, as far as the sentence itself supports. */
export interface ProseWindow {
  /** `MM-DD`, always present when a date was read at all. */
  opensOn?: string;
  closesOn?: string;
  /** `YYYY-MM-DD` — present ONLY when the sentence states the year itself. */
  opensAt?: string;
  closesAt?: string;
  /** True when month and day were read but no year is stated. The dates stay unpublished. */
  yearUnstated: boolean;
}

interface DateToken {
  month: number;
  day: number;
  year?: number;
}

function tokenYear(sentence: string, endIndex: number): number | undefined {
  const m = TRAILING_YEAR.exec(sentence.slice(endIndex));
  if (!m) return undefined;
  const year = Number.parseInt(m[1], 10);
  return year >= 1990 && year <= 2100 ? year : undefined;
}

function validToken(month: number, day: number, year?: number): DateToken | undefined {
  if (month < 1 || month > 12) return undefined;
  if (day < 1 || day > lastDayOf(month, year ?? 2001)) return undefined;
  const token: DateToken = { month, day };
  if (year !== undefined) token.year = year;
  return token;
}

function monthDay(token: DateToken): string {
  return `${String(token.month).padStart(2, '0')}-${String(token.day).padStart(2, '0')}`;
}

function isoDay(token: DateToken, year: number): string | undefined {
  if (token.day > lastDayOf(token.month, year)) return undefined;
  return `${String(year).padStart(4, '0')}-${monthDay(token)}`;
}

function scanTokens(sentence: string): DateToken[] {
  const found: DateToken[] = [];
  DATE_TOKEN.lastIndex = 0;
  for (let m = DATE_TOKEN.exec(sentence); m !== null; m = DATE_TOKEN.exec(sentence)) {
    const dayFirst = m[1] !== undefined;
    const monthWord = (dayFirst ? m[2] : m[3]).toLowerCase().slice(0, 3);
    const day = Number.parseInt(dayFirst ? m[1] : m[4], 10);
    const token = validToken(MONTHS[monthWord], day, tokenYear(sentence, m.index + m[0].length));
    if (token) found.push(token);
  }

  if (found.length === 1) {
    const bare = SAME_MONTH_RANGE.exec(sentence);
    if (bare) {
      const month = MONTHS[bare[1].toLowerCase().slice(0, 3)];
      const second = validToken(
        month,
        Number.parseInt(bare[3], 10),
        tokenYear(sentence, bare.index + bare[0].length),
      );
      // Only when it really is the token we already have, extended by a second day.
      if (second && month === found[0].month && Number.parseInt(bare[2], 10) === found[0].day) {
        found.push(second);
      }
    }
  }
  return found;
}

function monthGranularWindow(sentence: string): ProseWindow | undefined {
  const m = MONTH_RANGE.exec(sentence);
  if (!m) return undefined;
  const openMonth = MONTHS[m[1].toLowerCase().slice(0, 3)];
  const closeMonth = MONTHS[m[2].toLowerCase().slice(0, 3)];
  const year = Number.parseInt(m[3], 10);
  if (year < 1990 || year > 2100) return undefined;
  const open: DateToken = { month: openMonth, day: 1 };
  const close: DateToken = { month: closeMonth, day: lastDayOf(closeMonth, year) };
  return {
    opensOn: monthDay(open),
    closesOn: monthDay(close),
    opensAt: isoDay(open, year),
    closesAt: isoDay(close, year),
    yearUnstated: false,
  };
}

/**
 * The window one sentence states, or `undefined` when it states no date at all.
 *
 * `yearUnstated: true` means "the funder named these month-days and no year": `opensOn`/`closesOn`
 * are filled and `opensAt`/`closesAt` are NOT, and the caller publishes nothing. A window whose
 * close precedes its open within one year is rejected WHOLE rather than half-kept, on the same
 * reasoning `normalize/deadline.ts` gives: both halves came out of one sentence, so if they
 * contradict each other neither is trustworthy, and keeping the close alone would let a mis-parse
 * decide whether a programme reads as closed.
 */
export function parseProseWindow(sentence: string): ProseWindow | undefined {
  const tokens = scanTokens(sentence);
  if (tokens.length === 0) return monthGranularWindow(sentence);

  const open = tokens.length >= 2 ? tokens[0] : undefined;
  const close = tokens.length >= 2 ? tokens[tokens.length - 1] : undefined;
  const lone = tokens.length === 1 ? tokens[0] : undefined;
  const loneIsOpen = lone !== undefined && OPEN_VERB.test(sentence) && !CLOSE_VERB.test(sentence);

  const opensToken = open ?? (loneIsOpen ? lone : undefined);
  const closesToken = close ?? (loneIsOpen ? undefined : lone);

  // A year stated on EITHER end governs both, last-stated first — "May 1 and July 31, 2027" puts
  // the year only on the close, and "October 1ST … 31ST of 2025" only on the last token too.
  const statedYear = closesToken?.year ?? opensToken?.year;
  const window: ProseWindow = { yearUnstated: statedYear === undefined };
  if (opensToken) window.opensOn = monthDay(opensToken);
  if (closesToken) window.closesOn = monthDay(closesToken);
  if (statedYear === undefined) return window;

  const opensAt = opensToken ? isoDay(opensToken, opensToken.year ?? statedYear) : undefined;
  const closesAt = closesToken ? isoDay(closesToken, closesToken.year ?? statedYear) : undefined;
  if (opensAt !== undefined && closesAt !== undefined && closesAt < opensAt) {
    return { ...window, yearUnstated: false };
  }
  if (opensAt !== undefined) window.opensAt = opensAt;
  if (closesAt !== undefined) window.closesAt = closesAt;
  return window;
}
