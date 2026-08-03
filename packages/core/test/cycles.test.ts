import { describe, expect, it } from 'vitest';
import { expandCycles } from '../src/deadline.js';
import { makeProgram } from './fixtures.js';

const ardc = makeProgram({
  id: 'ardc-grants',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  deadline: {
    kind: 'n_fixed_dates',
    source: { kind: 'self' },
    note: 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | Applications arriving after Sep 1 roll to the next Feb 1 cycle.',
  },
});

const arrlGrants = makeProgram({
  id: 'arrl-amateur-radio-grants',
  name: 'ARRL Amateur Radio Grants',
  klass: 'ham_grant',
  deadline: {
    kind: 'n_fixed_windows',
    source: { kind: 'self' },
    note: 'RECUR n_fixed_windows tz=America/New_York windows=02-01..02-28,06-01..06-30,10-01..10-31 | Three windows a year.',
  },
});

// makeProgram's default is already the ARRL scholarship annual window.
const arrlScholarships = makeProgram();

const qcwa = makeProgram({
  id: 'qcwa-memorial-scholarship',
  name: 'QCWA Memorial Scholarship Fund',
  deadline: {
    kind: 'inherited',
    source: { kind: 'inherited', fromProgramId: 'arrl-foundation-scholarships' },
    note: 'Requests accepted from Oct 31; the application must reach the ARRL Foundation before the first week of January.',
  },
});

describe('expandCycles — projectable kinds', () => {
  it("projects ARDC's four fixed dates for one calendar year", () => {
    const cycles = expandCycles(ardc, [ardc], '2027-01-01T00:00:00.000Z', '2027-12-31T23:59:59.999Z');
    expect(cycles.map((c) => c.closesAt)).toEqual([
      '2027-02-02T07:59:00.000Z',
      '2027-04-02T06:59:00.000Z',
      '2027-07-02T06:59:00.000Z',
      '2027-09-02T06:59:00.000Z',
    ]);
    expect(cycles.map((c) => c.label)).toEqual([
      'Feb 1, 2027 deadline',
      'Apr 1, 2027 deadline',
      'Jul 1, 2027 deadline',
      'Sep 1, 2027 deadline',
    ]);
    expect(cycles.every((c) => c.opensAt === undefined)).toBe(true);
    expect(cycles.every((c) => c.isEstimated)).toBe(true);
    expect(cycles.every((c) => c.programId === 'ardc-grants')).toBe(true);
    expect(cycles.every((c) => c.timezone === 'America/Los_Angeles')).toBe(true);
  });

  it('projects across a multi-year range in ascending order', () => {
    const cycles = expandCycles(ardc, [ardc], '2027-01-01T00:00:00.000Z', '2028-12-31T23:59:59.999Z');
    expect(cycles).toHaveLength(8);
    expect(cycles[7].closesAt).toBe('2028-09-02T06:59:00.000Z');
    const closes = cycles.map((c) => Date.parse(c.closesAt as string));
    expect([...closes].sort((a, b) => a - b)).toEqual(closes);
  });

  it("projects ARRL's three windows with both ends of each window", () => {
    const cycles = expandCycles(
      arrlGrants,
      [arrlGrants],
      '2027-01-01T00:00:00.000Z',
      '2027-12-31T23:59:59.999Z',
    );
    expect(cycles.map((c) => [c.opensAt, c.closesAt])).toEqual([
      ['2027-02-01T05:00:00.000Z', '2027-03-01T04:59:00.000Z'],
      ['2027-06-01T04:00:00.000Z', '2027-07-01T03:59:00.000Z'],
      ['2027-10-01T04:00:00.000Z', '2027-11-01T03:59:00.000Z'],
    ]);
    expect(cycles[0].label).toBe('Feb 1–28, 2027 window');
    expect(cycles[2].label).toBe('Oct 1–31, 2027 window');
  });

  it('projects the ARRL scholarship annual window with its 12:00 Eastern close', () => {
    const cycles = expandCycles(
      arrlScholarships,
      [arrlScholarships],
      '2026-01-01T00:00:00.000Z',
      '2026-12-31T23:59:59.999Z',
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0].opensAt).toBe('2026-10-30T04:00:00.000Z');
    expect(cycles[0].closesAt).toBe('2026-12-30T17:00:00.000Z');
    expect(cycles[0].label).toBe('Oct 30 – Dec 30, 2026 window');
  });

  it('carries a window that crosses the year boundary into the following year', () => {
    const crossing = makeProgram({
      id: 'crossing',
      deadline: {
        kind: 'annual_window',
        source: { kind: 'self' },
        note: 'RECUR annual_window tz=America/New_York window=11-01..02-15 | Opens in November, closes in February.',
      },
    });
    const cycles = expandCycles(
      crossing,
      [crossing],
      '2027-01-01T00:00:00.000Z',
      '2027-06-30T00:00:00.000Z',
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0].opensAt).toBe('2026-11-01T04:00:00.000Z');
    expect(cycles[0].closesAt).toBe('2027-02-16T04:59:00.000Z');
    expect(cycles[0].label).toBe('Nov 1, 2026 – Feb 15, 2027 window');
  });

  it('clamps Feb 29 to Feb 28 in non-leap years', () => {
    const leapy = makeProgram({
      id: 'leapy',
      deadline: {
        kind: 'n_fixed_dates',
        source: { kind: 'self' },
        note: 'RECUR n_fixed_dates tz=America/New_York dates=02-29',
      },
    });
    const nonLeap = expandCycles(leapy, [leapy], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z');
    expect(nonLeap[0].closesAt).toBe('2027-03-01T04:59:00.000Z');
    expect(nonLeap[0].label).toBe('Feb 28, 2027 deadline');

    const leap = expandCycles(leapy, [leapy], '2028-01-01T00:00:00.000Z', '2028-12-31T00:00:00.000Z');
    expect(leap[0].closesAt).toBe('2028-03-01T04:59:00.000Z');
    expect(leap[0].label).toBe('Feb 29, 2028 deadline');
  });

  it('gives an inheriting programme its owner’s dates under its own id', () => {
    const cycles = expandCycles(
      qcwa,
      [arrlScholarships, qcwa],
      '2026-01-01T00:00:00.000Z',
      '2026-12-31T23:59:59.999Z',
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0].programId).toBe('qcwa-memorial-scholarship');
    expect(cycles[0].closesAt).toBe('2026-12-30T17:00:00.000Z');
    expect(cycles[0].label).toBe(
      'Oct 30 – Dec 30, 2026 window (via ARRL Foundation Scholarship Program)',
    );
    expect(cycles[0].id).toBe('qcwa-memorial-scholarship:2026-12-30T17:00:00.000Z');
  });

  it('produces stable ids so repeated crawls upsert instead of duplicating', () => {
    const a = expandCycles(ardc, [ardc], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z');
    const b = expandCycles(ardc, [ardc], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z');
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
    expect(a[0].id).toBe('ardc-grants:2027-02-02T07:59:00.000Z');
  });
});

describe('expandCycles — the seven non-projectable kinds', () => {
  const kinds = [
    'rolling',
    'quarterly_rewritten',
    'ad_hoc',
    'unpublished',
    'no_application_exists',
    'dormant',
  ] as const;

  it('returns no cycles for any kind that cannot be projected', () => {
    for (const kind of kinds) {
      const p = makeProgram({
        id: `p-${kind}`,
        deadline: { kind, source: { kind: 'self' }, note: 'No published deadline.' },
      });
      expect(
        expandCycles(p, [p], '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'),
        kind,
      ).toEqual([]);
    }
    expect(kinds).toHaveLength(6);
  });

  it('ignores a RECUR directive attached to a non-projectable kind', () => {
    const bogus = makeProgram({
      id: 'bogus',
      deadline: {
        kind: 'rolling',
        source: { kind: 'self' },
        note: 'RECUR n_fixed_dates tz=America/New_York dates=02-01 | pasted here by accident',
      },
    });
    expect(expandCycles(bogus, [bogus], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z')).toEqual(
      [],
    );
  });

  it('returns nothing for a projectable kind whose note carries no directive', () => {
    const blank = makeProgram({
      id: 'blank',
      deadline: { kind: 'annual_window', source: { kind: 'self' }, note: 'Annual, date TBC by the curator.' },
    });
    expect(expandCycles(blank, [blank], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z')).toEqual(
      [],
    );
  });

  it('returns nothing for an inverted or unparsable range', () => {
    expect(expandCycles(ardc, [ardc], '2028-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')).toEqual(
      [],
    );
    expect(expandCycles(ardc, [ardc], 'not-a-date', '2027-01-01T00:00:00.000Z')).toEqual([]);
  });
});
