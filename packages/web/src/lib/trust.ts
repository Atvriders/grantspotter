/**
 * Spec §8 — "how stale is this?", answered the same way everywhere.
 *
 * Every user-facing date in this product renders with its provenance, and no bare date is ever
 * shown. These four functions are the whole vocabulary; `TrustBadge` renders it, and Tasks 17-25
 * format dates through `formatDate` rather than each inventing a format.
 */

export const UNVERIFIED_AFTER_DAYS = 90;

/** What a missing or unreadable date renders as. Never an empty cell. */
export const NO_DATE = '—';

/**
 * Whole days between two instants. An unparseable input is INFINITELY old rather than zero days
 * old: zero would read as "checked just now", which is the one thing a broken date must not say.
 */
export function daysSince(iso: string, nowISO: string): number {
  const then = Date.parse(iso);
  const now = Date.parse(nowISO);
  if (Number.isNaN(then) || Number.isNaN(now)) return Number.POSITIVE_INFINITY;
  return Math.floor((now - then) / 86_400_000);
}

/**
 * Spec §8: "Older than 90 days renders amber 'unverified'." Exactly 90 is still
 * verified; 91 is not. An unparseable date is treated as unverified - the whole
 * point of this badge is that silence never reads as confidence.
 */
export function isUnverified(lastVerifiedAt: string, nowISO: string): boolean {
  return daysSince(lastVerifiedAt, nowISO) > UNVERIFIED_AFTER_DAYS;
}

const DAY_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dayFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = DAY_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  // `en-CA` is the locale whose numeric date IS `YYYY-MM-DD`, so the output stays the ISO form
  // the design system uses without hand-assembling parts.
  let made: Intl.DateTimeFormat;
  try {
    made = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    // An unknown IANA zone throws. A crashed table is worse than a UTC day, and the fallback is
    // the same day the no-timezone call would have produced, so nothing silently changes meaning.
    made = dayFormatter('UTC');
  }
  DAY_FORMATTERS.set(timeZone, made);
  return made;
}

/**
 * ISO date, no locale ambiguity. An em dash, never an empty cell.
 *
 * `timeZone` is the CYCLE'S timezone, and passing it is not optional wherever a deadline is
 * rendered. Deadlines are stored as UTC instants of a LOCAL wall time — `zonedWallTimeToUtcISO`
 * with `DEFAULT_CLOSE_TIME` 23:59 turns the ARRL's "closes 28 February 2027" (America/New_York)
 * into `2027-03-01T04:59:00.000Z`. Formatted in UTC that prints **2027-03-01**, telling an
 * applicant they have one more day than they do. Formatted in `America/New_York` it prints the
 * day the funder published.
 *
 * The default is UTC because it is deterministic and because the browse projection
 * (`program_search.next_closes_at`) carries no timezone column to pass. That is a known gap,
 * recorded for the reviewer — it is not a licence to omit the argument where a `Cycle` is in hand.
 */
export function formatDate(
  iso: string | null | undefined,
  timeZone: string = 'UTC',
): string {
  if (iso === null || iso === undefined || iso === '') return NO_DATE;
  // A date-only string is ALREADY a calendar day — it has no instant to re-zone. Sending it
  // through a zoned formatter would move `2026-12-30` to the 29th in any western timezone, which
  // is the same one-day-late defect in the opposite direction.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return NO_DATE;
  return dayFormatter(timeZone).format(new Date(parsed));
}
