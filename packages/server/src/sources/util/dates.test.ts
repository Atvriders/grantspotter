import { describe, expect, it } from 'vitest';
import { parseDateRange, parseUsDate } from './dates.js';

describe('parseUsDate', () => {
  it('parses long and abbreviated month names', () => {
    expect(parseUsDate('December 30, 2026')).toBe('2026-12-30');
    expect(parseUsDate('Dec 30, 2026')).toBe('2026-12-30');
    expect(parseUsDate('Sept. 30, 2026')).toBe('2026-09-30');
    expect(parseUsDate('1 February 2027')).toBe('2027-02-01');
  });

  it('applies a default year when the text omits one', () => {
    expect(parseUsDate('October 31', 2026)).toBe('2026-10-31');
    expect(parseUsDate('October 31')).toBeUndefined();
  });

  it('returns undefined for text with no date', () => {
    expect(parseUsDate('rolling, no deadline')).toBeUndefined();
  });
});

describe('parseDateRange', () => {
  it('parses the Yaesu window form "June 3 - August 31, 2026"', () => {
    expect(parseDateRange('June 3 - August 31, 2026')).toEqual({
      opensAt: '2026-06-03',
      closesAt: '2026-08-31',
    });
  });

  it('parses an en dash and a same-month window', () => {
    expect(parseDateRange('February 1–28, 2027')).toEqual({
      opensAt: '2027-02-01',
      closesAt: '2027-02-28',
    });
  });

  it('parses the ARISS form "opened July 1, 2026 and closes September 30, 2026"', () => {
    expect(parseDateRange('opened July 1, 2026 and closes September 30, 2026')).toEqual({
      opensAt: '2026-07-01',
      closesAt: '2026-09-30',
    });
  });

  it('parses the Austin ARC form "May 1 through July 31"', () => {
    expect(parseDateRange('May 1 through July 31', 2026)).toEqual({
      opensAt: '2026-05-01',
      closesAt: '2026-07-31',
    });
  });

  it('returns undefined when there are not two dates', () => {
    expect(parseDateRange('applications are accepted year round')).toBeUndefined();
  });
});
