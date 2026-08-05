import { describe, expect, it } from 'vitest';
import { humanRetryAfter, retryAfterSecOf } from './retryAfter.js';

/**
 * A screen may repeat the server's number or say nothing about time. It may not make one up, and it
 * may not round one down — both `Login.tsx` and `Enroll.tsx` did the first of those until
 * 2026-08-05, printing "wait a minute" for a pause the server had already called nine hundred
 * seconds.
 */
describe('reading retryAfterSec off an error body', () => {
  it('takes a positive number and rounds it up to a whole second', () => {
    expect(retryAfterSecOf({ retryAfterSec: 900 })).toBe(900);
    expect(retryAfterSecOf({ retryAfterSec: 0.2 })).toBe(1);
  });

  it('refuses anything it could not say out loud', () => {
    for (const details of [
      undefined,
      null,
      'nine hundred',
      {},
      { retryAfterSec: '900' },
      { retryAfterSec: 0 },
      { retryAfterSec: -5 },
      { retryAfterSec: Number.NaN },
      { retryAfterSec: Number.POSITIVE_INFINITY },
    ]) {
      expect(retryAfterSecOf(details)).toBeNull();
    }
  });
});

describe('saying a wait out loud', () => {
  it('keeps short waits in seconds, because those are waits people sit through', () => {
    expect(humanRetryAfter(1)).toBe('1 second');
    expect(humanRetryAfter(45)).toBe('45 seconds');
    expect(humanRetryAfter(60)).toBe('60 seconds');
  });

  it('rounds minutes UP, so the advice is never early', () => {
    // 61 s is 1.02 minutes: "1 minute" would send somebody back to a second refusal.
    expect(humanRetryAfter(61)).toBe('2 minutes');
    expect(humanRetryAfter(842)).toBe('15 minutes');
    expect(humanRetryAfter(900)).toBe('15 minutes');
  });

  it('falls back to hours rather than printing a three-digit minute count', () => {
    expect(humanRetryAfter(3600)).toBe('1 hour');
    expect(humanRetryAfter(7300)).toBe('3 hours');
  });
});
