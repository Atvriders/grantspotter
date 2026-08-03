import { describe, expect, it } from 'vitest';
import {
  parseRecurrence,
  RecurrenceParseError,
  resolveDeadlineOwner,
  zonedWallTimeToUtcISO,
} from '../src/deadline.js';
import { makeProgram } from './fixtures.js';

describe('zonedWallTimeToUtcISO', () => {
  it('resolves an ARDC February deadline in Pacific-authored Eastern terms', () => {
    expect(zonedWallTimeToUtcISO(2027, 2, 1, 23, 59, 0, 'America/New_York')).toBe(
      '2027-02-02T04:59:00.000Z',
    );
  });

  it('applies daylight time where it applies', () => {
    expect(zonedWallTimeToUtcISO(2027, 7, 1, 23, 59, 0, 'America/Los_Angeles')).toBe(
      '2027-07-02T06:59:00.000Z',
    );
  });

  it('resolves the ARRL scholarship close of Dec 30 at 12:00 Eastern', () => {
    expect(zonedWallTimeToUtcISO(2026, 12, 30, 12, 0, 0, 'America/New_York')).toBe(
      '2026-12-30T17:00:00.000Z',
    );
  });

  it('does not blow up on a wall time that does not exist (spring forward)', () => {
    expect(zonedWallTimeToUtcISO(2027, 3, 14, 2, 30, 0, 'America/New_York')).toBe(
      '2027-03-14T06:30:00.000Z',
    );
  });
});

describe('parseRecurrence', () => {
  it('returns none for prose that carries no directive', () => {
    expect(parseRecurrence('Rolling; allow about two months of lead time.')).toEqual({
      kind: 'none',
    });
    expect(parseRecurrence('')).toEqual({ kind: 'none' });
  });

  it('parses the ARDC four-dates directive', () => {
    const r = parseRecurrence(
      'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | Applications arriving after Sep 1 roll to the next Feb 1 cycle.',
    );
    expect(r).toEqual({
      kind: 'n_fixed_dates',
      timezone: 'America/Los_Angeles',
      dates: [
        { month: 2, day: 1 },
        { month: 4, day: 1 },
        { month: 7, day: 1 },
        { month: 9, day: 1 },
      ],
      closeTime: { hour: 23, minute: 59 },
    });
  });

  it('parses the ARRL three-windows directive', () => {
    const r = parseRecurrence(
      'RECUR n_fixed_windows tz=America/New_York windows=02-01..02-28,06-01..06-30,10-01..10-31 | Three windows a year.',
    );
    expect(r).toEqual({
      kind: 'n_fixed_windows',
      timezone: 'America/New_York',
      windows: [
        { open: { month: 2, day: 1 }, close: { month: 2, day: 28 } },
        { open: { month: 6, day: 1 }, close: { month: 6, day: 30 } },
        { open: { month: 10, day: 1 }, close: { month: 10, day: 31 } },
      ],
      openTime: { hour: 0, minute: 0 },
      closeTime: { hour: 23, minute: 59 },
    });
  });

  it('parses the ARRL scholarship annual window with an explicit close time', () => {
    const r = parseRecurrence(
      'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | Moved from Jan 31.',
    );
    expect(r).toEqual({
      kind: 'annual_window',
      timezone: 'America/New_York',
      window: { open: { month: 10, day: 30 }, close: { month: 12, day: 30 } },
      openTime: { hour: 0, minute: 0 },
      closeTime: { hour: 12, minute: 0 },
    });
  });

  it('throws loudly rather than silently returning nothing', () => {
    expect(() => parseRecurrence('RECUR n_fixed_dates dates=02-01')).toThrow(RecurrenceParseError);
    expect(() => parseRecurrence('RECUR annual_window tz=America/New_York')).toThrow(
      RecurrenceParseError,
    );
    expect(() => parseRecurrence('RECUR fortnightly tz=America/New_York')).toThrow(
      RecurrenceParseError,
    );
    expect(() =>
      parseRecurrence('RECUR n_fixed_dates tz=Mars/Olympus_Mons dates=02-01'),
    ).toThrow(RecurrenceParseError);
    expect(() =>
      parseRecurrence('RECUR n_fixed_dates tz=America/New_York dates=13-45'),
    ).toThrow(RecurrenceParseError);
  });
});

describe('resolveDeadlineOwner', () => {
  const arrl = makeProgram({ id: 'arrl-foundation-scholarships' });

  // QCWA's scholarship is administered through ARRL's application, so its
  // real deadline lives inside ARRL's cycle. All 111 ARRL catalogue entries
  // share one deadline too — this is why inheritance exists at all.
  const qcwa = makeProgram({
    id: 'qcwa-memorial-scholarship',
    name: 'QCWA Memorial Scholarship Fund',
    deadline: {
      kind: 'inherited',
      source: { kind: 'inherited', fromProgramId: 'arrl-foundation-scholarships' },
      note: 'Requests accepted from Oct 31; the completed application must reach the ARRL Foundation before the first week of January.',
    },
  });

  it('returns the programme itself when it owns its own deadline', () => {
    expect(resolveDeadlineOwner(arrl, [arrl, qcwa]).id).toBe('arrl-foundation-scholarships');
  });

  it('follows a single inheritance hop', () => {
    expect(resolveDeadlineOwner(qcwa, [arrl, qcwa]).id).toBe('arrl-foundation-scholarships');
  });

  it('follows a chain of hops', () => {
    const middle = makeProgram({
      id: 'middle',
      deadline: {
        kind: 'inherited',
        source: { kind: 'inherited', fromProgramId: 'arrl-foundation-scholarships' },
        note: '',
      },
    });
    const leaf = makeProgram({
      id: 'leaf',
      deadline: {
        kind: 'inherited',
        source: { kind: 'inherited', fromProgramId: 'middle' },
        note: '',
      },
    });
    expect(resolveDeadlineOwner(leaf, [arrl, middle, leaf]).id).toBe(
      'arrl-foundation-scholarships',
    );
  });

  it('falls back to the programme itself when the owner is missing from the corpus', () => {
    expect(resolveDeadlineOwner(qcwa, [qcwa]).id).toBe('qcwa-memorial-scholarship');
  });

  it('breaks an inheritance cycle instead of looping forever', () => {
    const a = makeProgram({
      id: 'a',
      deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'b' }, note: '' },
    });
    const b = makeProgram({
      id: 'b',
      deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'a' }, note: '' },
    });
    expect(resolveDeadlineOwner(a, [a, b]).id).toBe('a');
  });
});
