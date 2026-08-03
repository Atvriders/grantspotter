const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MONTH_ALT = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
// The day run is followed by a negative lookahead so a 4-digit year immediately after a
// month name (no comma) is never mistaken for a 2-digit day plus a leftover 2-digit remainder,
// e.g. "February 2027" must not read as day=20, dangling "27".
const MONTH_DAY = new RegExp(
  `\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?!\\d)(?:\\s*,)?(?:\\s*(\\d{4}))?`,
  'gi',
);
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})[a-z]*\\.?(?:\\s*,)?\\s*(\\d{4})?`, 'i');

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "December 30, 2026" | "Dec 30, 2026" | "Sept. 30, 2026" | "1 February 2027" -> ISO date. */
export function parseUsDate(input: string, defaultYear?: number): string | undefined {
  MONTH_DAY.lastIndex = 0;
  const md = MONTH_DAY.exec(input);
  if (md) {
    const year = md[3] ? Number.parseInt(md[3], 10) : defaultYear;
    if (year === undefined) return undefined;
    return iso(year, MONTHS[md[1].toLowerCase().slice(0, 3)], Number.parseInt(md[2], 10));
  }
  const dm = DAY_MONTH.exec(input);
  if (dm) {
    const year = dm[3] ? Number.parseInt(dm[3], 10) : defaultYear;
    if (year === undefined) return undefined;
    return iso(year, MONTHS[dm[2].toLowerCase().slice(0, 3)], Number.parseInt(dm[1], 10));
  }
  return undefined;
}

/**
 * Two dates in one sentence: "June 3 - August 31, 2026", "February 1-28, 2027",
 * "opened July 1, 2026 and closes September 30, 2026", "May 1 through July 31".
 * A trailing year applies to both ends when the first end omits it.
 */
export function parseDateRange(
  input: string,
  defaultYear?: number,
): { opensAt?: string; closesAt?: string } | undefined {
  const found: Array<{ month: number; day: number; year?: number }> = [];
  MONTH_DAY.lastIndex = 0;
  for (let m = MONTH_DAY.exec(input); m !== null; m = MONTH_DAY.exec(input)) {
    found.push({
      month: MONTHS[m[1].toLowerCase().slice(0, 3)],
      day: Number.parseInt(m[2], 10),
      year: m[3] ? Number.parseInt(m[3], 10) : undefined,
    });
  }

  // Same-month shorthand: "February 1-28, 2027" yields one month-day plus a bare day. The
  // month alternation must be grouped with (?:...) — without it, `|` splits the whole pattern
  // into unrelated alternatives instead of alternating only the month names. A trailing
  // ", 2027" is captured here too, since the en dash form otherwise strands the year outside
  // any MONTH_DAY match ("February 1–28, 2027" never lets "2027" attach to a month).
  if (found.length === 1) {
    const bare = new RegExp(
      `\\b(?:${MONTH_ALT})[a-z]*\\.?\\s+\\d{1,2}\\s*[\\-\\u2013\\u2014]\\s*(\\d{1,2})(?:\\s*,\\s*(\\d{4}))?\\b`,
      'i',
    ).exec(input);
    if (bare) {
      found.push({
        month: found[0].month,
        day: Number.parseInt(bare[1], 10),
        year: bare[2] ? Number.parseInt(bare[2], 10) : undefined,
      });
    }
  }

  if (found.length < 2) return undefined;
  const trailingYear = found[found.length - 1].year ?? defaultYear;
  const open = found[0];
  const close = found[found.length - 1];
  const openYear = open.year ?? trailingYear;
  const closeYear = close.year ?? trailingYear;
  if (openYear === undefined || closeYear === undefined) return undefined;
  return {
    opensAt: iso(openYear, open.month, open.day),
    closesAt: iso(closeYear, close.month, close.day),
  };
}
