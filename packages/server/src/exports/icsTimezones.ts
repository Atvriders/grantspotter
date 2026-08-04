/**
 * Static `VTIMEZONE` blocks for the IANA zones a GrantSpotter calendar can carry.
 *
 * WHY THIS FILE EXISTS AT ALL. RFC 5545 requires a `VTIMEZONE` component in the calendar for every
 * `TZID` a `DTSTART` names. A client that meets a `TZID` it has no definition for does not fail —
 * it GUESSES, usually by falling back to the viewer's own zone, and the deadline silently moves.
 * A deadline that moves later is the dangerous direction: it tells an applicant they have a day
 * they do not have.
 *
 * WHY THE RULES ARE HARD-CODED RATHER THAN READ FROM THE PLATFORM. Node's ICU knows the zones but
 * exposes no way to enumerate their transition rules, so a `VTIMEZONE` has to be written by hand
 * whatever the source. Hand-written data about time is exactly the kind that rots quietly, so
 * `ics.test.ts` does not trust these blocks: it evaluates each one's own `RRULE`s and offsets to
 * compute the UTC instant a *client* would derive, and compares it against the instant
 * `Intl.DateTimeFormat` (i.e. ICU's real IANA data) gives, across every zone here and both sides
 * of every DST transition. If a US rule ever changes, that test goes red before a user's calendar
 * does.
 *
 * THE RULE ITSELF. US DST has been stable since the Energy Policy Act of 2005 took effect in 2007:
 * DST starts the SECOND Sunday in March at 02:00 local standard time, and ends the FIRST Sunday in
 * November at 02:00 local daylight time. Arizona (`America/Phoenix`) and Hawaii
 * (`Pacific/Honolulu`) do not observe it and are written as fixed-offset zones.
 *
 * `DTSTART` inside a `VTIMEZONE` subcomponent is a LOCAL time expressed in that subcomponent's
 * `TZOFFSETFROM` — which is why the DAYLIGHT block starts at 02:00 standard and the STANDARD block
 * at 02:00 daylight. Both anchor dates are the real first occurrence under the current rule:
 * 2007-03-11 was the second Sunday of March 2007 and 2007-11-04 the first Sunday of November 2007.
 *
 * Lines are `\n`-joined here; `buildIcsCalendar` folds and re-joins the whole document with CRLF,
 * so there is exactly one place in this package that knows about line endings.
 */

function usZone(
  tzid: string,
  stdOffset: string,
  dstOffset: string,
  stdName: string,
  dstName: string,
): string {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:DAYLIGHT',
    `TZOFFSETFROM:${stdOffset}`,
    `TZOFFSETTO:${dstOffset}`,
    `TZNAME:${dstName}`,
    'DTSTART:20070311T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    `TZOFFSETFROM:${dstOffset}`,
    `TZOFFSETTO:${stdOffset}`,
    `TZNAME:${stdName}`,
    'DTSTART:20071104T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ].join('\n');
}

function fixedZone(tzid: string, offset: string, name: string): string {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:STANDARD',
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    `TZNAME:${name}`,
    'DTSTART:19700101T000000',
    'END:STANDARD',
    'END:VTIMEZONE',
  ].join('\n');
}

/**
 * The seven US zones. There is deliberately NO `UTC` entry: a cycle with no funder time zone
 * recorded carries `timezone: 'UTC'` as a day-precision FRAME, not as a claim about where the
 * funder is (see `observedCycles` in `packages/core/src/deadline.ts`), and `ics.ts` renders those
 * as all-day events, which need no `TZID` and therefore no `VTIMEZONE`. Shipping a UTC block would
 * be shipping a definition nothing can emit.
 *
 * A zone that is NOT in this map never gets a bare `TZID` pointing at nothing: `ics.ts` falls back
 * to writing the UTC instant, which is exact, and says so in the event description.
 */
export const VTIMEZONE_BLOCKS: Readonly<Record<string, string>> = Object.freeze({
  'America/New_York': usZone('America/New_York', '-0500', '-0400', 'EST', 'EDT'),
  'America/Chicago': usZone('America/Chicago', '-0600', '-0500', 'CST', 'CDT'),
  'America/Denver': usZone('America/Denver', '-0700', '-0600', 'MST', 'MDT'),
  'America/Los_Angeles': usZone('America/Los_Angeles', '-0800', '-0700', 'PST', 'PDT'),
  'America/Anchorage': usZone('America/Anchorage', '-0900', '-0800', 'AKST', 'AKDT'),
  'America/Phoenix': fixedZone('America/Phoenix', '-0700', 'MST'),
  'Pacific/Honolulu': fixedZone('Pacific/Honolulu', '-1000', 'HST'),
});

/** Whether a `TZID` can be shipped with a definition a client can actually resolve. */
export function hasVtimezone(tzid: string): boolean {
  return Object.prototype.hasOwnProperty.call(VTIMEZONE_BLOCKS, tzid);
}
