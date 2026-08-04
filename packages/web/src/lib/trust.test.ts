import { describe, it, expect } from 'vitest';
import { daysSince, isUnverified, formatDate, UNVERIFIED_AFTER_DAYS } from './trust.js';

const NOW = '2026-08-02T12:00:00.000Z';

describe('daysSince', () => {
  it('counts whole days', () => {
    expect(daysSince('2026-08-01T12:00:00.000Z', NOW)).toBe(1);
    expect(daysSince('2026-05-04T12:00:00.000Z', NOW)).toBe(90);
  });

  it('reports an unparseable date as infinitely old, never as zero days', () => {
    // Zero would read as "checked just now", which is the one thing a broken date must not say.
    expect(daysSince('not a date', NOW)).toBe(Number.POSITIVE_INFINITY);
    expect(daysSince(NOW, 'not a date')).toBe(Number.POSITIVE_INFINITY);
  });

  it('goes negative for a date in the future rather than clamping silently', () => {
    expect(daysSince('2026-08-03T12:00:00.000Z', NOW)).toBe(-1);
  });
});

describe('isUnverified', () => {
  it('is false at exactly 90 days', () => {
    // Spec §8 says "older than 90 days", so 90 itself is still verified.
    expect(UNVERIFIED_AFTER_DAYS).toBe(90);
    expect(isUnverified('2026-05-04T12:00:00.000Z', NOW)).toBe(false);
  });

  it('is true at 91 days', () => {
    expect(isUnverified('2026-05-03T12:00:00.000Z', NOW)).toBe(true);
  });

  it('is true for the Chicago FM record, verified in January', () => {
    expect(isUnverified('2026-01-05T00:00:00.000Z', NOW)).toBe(true);
  });

  it('treats an unparseable date as unverified rather than silently fresh', () => {
    expect(isUnverified('not a date', NOW)).toBe(true);
  });
});

describe('formatDate', () => {
  it('renders an ISO date in an unambiguous, non-US-centric form', () => {
    expect(formatDate('2026-12-30T17:00:00.000Z')).toBe('2026-12-30');
  });

  it('renders an em dash for a missing date rather than an empty cell', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
  });

  it('renders an em dash for an unparseable date rather than "Invalid Date"', () => {
    expect(formatDate('not a date')).toBe('—');
  });

  it('renders a date-only string as itself, in any timezone', () => {
    // `birthDate`, `licensedSince` and the raw fields on a review candidate are calendar days
    // with no instant behind them. Re-zoning one would move it to the 29th out west.
    expect(formatDate('2026-12-30')).toBe('2026-12-30');
    expect(formatDate('2026-12-30', 'America/Los_Angeles')).toBe('2026-12-30');
  });

  /**
   * THE ONE-DAY-LATE DEFECT. Deadlines are stored as UTC instants of a LOCAL wall time:
   * `zonedWallTimeToUtcISO` + `DEFAULT_CLOSE_TIME` (23:59) turn "closes 28 February 2027" in
   * America/New_York into `2027-03-01T04:59:00.000Z` — the exact string
   * `packages/server/src/crawl/runner.test.ts:827` asserts, with that comment. Slicing the UTC
   * instant would print 2027-03-01 and tell an applicant they have one more day than they do.
   * Every caller that has the cycle's `timezone` in scope must pass it.
   */
  it('renders the funder\'s own calendar day when the cycle timezone is supplied', () => {
    expect(formatDate('2027-03-01T04:59:00.000Z', 'America/New_York')).toBe('2027-02-28');
    expect(formatDate('2027-02-02T07:59:00.000Z', 'America/Los_Angeles')).toBe('2027-02-01');
  });

  it('defaults to UTC, which is one day LATE for a US 23:59 deadline — pass the timezone', () => {
    // Pinned deliberately: this is the documented hazard, not an accident. A caller with no
    // timezone in scope (the browse projection carries none) gets the UTC day.
    expect(formatDate('2027-03-01T04:59:00.000Z')).toBe('2027-03-01');
  });

  it('is unaffected by the host timezone, so a test host cannot flip the day', () => {
    // The suite runs on a host set to America/Chicago. A `toLocaleDateString()` implementation
    // would pass here by luck and print a different day in CI.
    expect(formatDate('2026-01-01T02:00:00.000Z')).toBe('2026-01-01');
  });

  it('falls back to the UTC day rather than throwing on an unknown timezone', () => {
    expect(formatDate('2027-03-01T04:59:00.000Z', 'Not/AZone')).toBe('2027-03-01');
  });

  it('renders a funder-published UTC window on its own day in either mode', () => {
    // ARISS closes 2026-09-30T23:59:59.999Z — one of the four `isEstimated: false` cycles.
    expect(formatDate('2026-09-30T23:59:59.999Z')).toBe('2026-09-30');
    expect(formatDate('2026-09-30T23:59:59.999Z', 'America/New_York')).toBe('2026-09-30');
  });
});
