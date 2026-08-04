import { describe, expect, it } from 'vitest';
import {
  OBSERVED_WINDOW_MARKER,
  expandCycles,
  observedCycles,
  parseObservedWindow,
} from '../src/deadline.js';
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

/* --------------------------------------- observed (funder-stated) windows -------------------- */

// REMEDIATION 2026-08-03. `expandCycles` above projects a RULE. These cover the other half: a
// window a funder STATED once, which produced no `Cycle` at all until this fix, so every programme
// whose dates were read off its funder's own page was missing from a calendar built on `cycles`.
//
// The notes below are byte-for-byte what `normalize/deadline.ts`'s `describeObservedWindow` writes
// for the real committed captures (see `review/index.test.ts` for the end-to-end pin that keeps
// that writer and this reader from drifting apart).
const ARISS_NOTE =
  'One window sentence rewritten quarterly at a stable URL. ' +
  'Application window published by the funder: opens 2026-07-01, closes 2026-09-30.';
const YAESU_NOTE =
  'Irregular windows announced by the funder with no fixed schedule. ' +
  'Application deadline published by the funder: closes 2026-08-31.';

const ariss = makeProgram({
  id: 'ariss--ariss-iss-contact-proposal--3b40cb18',
  name: 'ARISS ISS Contact Proposal',
  klass: 'ham_grant',
  deadline: { kind: 'quarterly_rewritten', source: { kind: 'self' }, note: ARISS_NOTE },
});

const yaesu = makeProgram({
  id: 'yaesu-dr2x--yaesu-dr2x-repeater-program--fe73e843',
  name: 'Yaesu DR-2X Repeater Program',
  klass: 'ham_grant',
  deadline: { kind: 'ad_hoc', source: { kind: 'self' }, note: YAESU_NOTE },
});

/** The 18-month horizon `review/index.ts` uses, from the corpus's fixed `now`. */
const FROM = '2026-08-02T00:00:00.000Z';
const TO = '2028-02-02T00:00:00.000Z';

describe('parseObservedWindow', () => {
  it('reads both halves of the sentence normalize writes', () => {
    expect(parseObservedWindow(ARISS_NOTE)).toEqual({
      opensAt: '2026-07-01',
      closesAt: '2026-09-30',
    });
    expect(parseObservedWindow(YAESU_NOTE)).toEqual({ closesAt: '2026-08-31' });
  });

  it('reads nothing from a note that carries no funder-stated window', () => {
    expect(parseObservedWindow(ardc.deadline.note)).toBeUndefined();
    expect(parseObservedWindow('Applications are accepted at any time.')).toBeUndefined();
    expect(parseObservedWindow('')).toBeUndefined();
  });

  it('never reads a date that appears BEFORE the marker — only the funder gets to state one', () => {
    // The prose before the marker is ours (a RECUR directive, or a NOTE_BY_KIND sentence). A date
    // found there would be our own table masquerading as something the funder published.
    const note = `We think it closes 2026-01-05. Application deadline ${OBSERVED_WINDOW_MARKER} closes 2026-09-30.`;
    expect(parseObservedWindow(note)).toEqual({ closesAt: '2026-09-30' });
  });

  it('rejects a window whose close precedes its open — whole, never half-kept', () => {
    const note = `Application window ${OBSERVED_WINDOW_MARKER} opens 2026-09-30, closes 2026-07-01.`;
    expect(parseObservedWindow(note)).toBeUndefined();
  });

  it('rejects a date that is not a real calendar day, and keeps one that is', () => {
    expect(
      parseObservedWindow(`x ${OBSERVED_WINDOW_MARKER} closes 2027-02-29.`),
    ).toBeUndefined();
    expect(parseObservedWindow(`x ${OBSERVED_WINDOW_MARKER} closes 2026-13-01.`)).toBeUndefined();
    expect(parseObservedWindow(`x ${OBSERVED_WINDOW_MARKER} closes 1889-06-01.`)).toBeUndefined();
    expect(parseObservedWindow(`x ${OBSERVED_WINDOW_MARKER} closes 2028-02-29.`)).toEqual({
      closesAt: '2028-02-29',
    });
  });
});

describe('observedCycles — the window a funder stated, recorded once and never projected', () => {
  it("records ARISS's real captured window as ONE isEstimated:false cycle", () => {
    const cycles = observedCycles(ariss, [ariss], FROM, TO);
    expect(cycles).toEqual([
      {
        id: 'ariss--ariss-iss-contact-proposal--3b40cb18:observed:2026-09-30T23:59:59.999Z',
        programId: 'ariss--ariss-iss-contact-proposal--3b40cb18',
        opensAt: '2026-07-01T00:00:00.000Z',
        closesAt: '2026-09-30T23:59:59.999Z',
        timezone: 'UTC',
        label: 'Jul 1 – Sep 30, 2026 window',
        isEstimated: false,
      },
    ]);
  });

  it('invents NO successor, over a horizon long enough to hold four more of them', () => {
    // The whole reason this is not a RECUR directive: one dated window is not a yearly rule, and
    // `RECUR annual_window window=07-01..09-30` would publish a 2027 ARISS deadline ARISS has
    // never announced. Four years of horizon, still exactly one row, and no later year anywhere
    // in it.
    const cycles = observedCycles(ariss, [ariss], '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].closesAt).toBe('2026-09-30T23:59:59.999Z');
    for (const year of ['2027', '2028', '2029', '2030']) {
      expect(JSON.stringify(cycles)).not.toContain(year);
    }
  });

  it('records a close date with no open date as a single dated deadline', () => {
    const cycles = observedCycles(yaesu, [yaesu], FROM, TO);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].opensAt).toBeUndefined();
    expect(cycles[0].closesAt).toBe('2026-08-31T23:59:59.999Z');
    expect(cycles[0].label).toBe('Aug 31, 2026 deadline');
    expect(cycles[0].isEstimated).toBe(false);
  });

  it('writes nothing for an open date with no close date', () => {
    // `listClosingBetween` selects on closes_at, so such a row could never appear on the calendar
    // it was written for. A write-only row is the defect class this codebase keeps closing.
    const openOnly = makeProgram({
      id: 'open-only',
      deadline: {
        kind: 'ad_hoc',
        source: { kind: 'self' },
        note: `Application window ${OBSERVED_WINDOW_MARKER} opens 2026-09-01; no close date is stated.`,
      },
    });
    expect(parseObservedWindow(openOnly.deadline.note)).toEqual({ opensAt: '2026-09-01' });
    expect(observedCycles(openOnly, [openOnly], FROM, TO)).toEqual([]);
  });

  it('writes nothing for a programme whose note states no window at all', () => {
    expect(observedCycles(ardc, [ardc], FROM, TO)).toEqual([]);
    expect(observedCycles(arrlScholarships, [arrlScholarships], FROM, TO)).toEqual([]);
  });

  it('drops a stated window whose close falls outside the horizon, either side', () => {
    // The real NTIA PWSCIF row (grants-gov-extract 354777) states a close of 2026-05-01, three
    // months before `now`: already shut, already `status: 'closed'`, and not a calendar entry.
    const past = makeProgram({
      id: 'past',
      deadline: {
        kind: 'ad_hoc',
        source: { kind: 'self' },
        note: `Application deadline ${OBSERVED_WINDOW_MARKER} closes 2026-05-01.`,
      },
    });
    expect(observedCycles(past, [past], FROM, TO)).toEqual([]);

    const beyond = makeProgram({
      id: 'beyond',
      deadline: {
        kind: 'ad_hoc',
        source: { kind: 'self' },
        note: `Application deadline ${OBSERVED_WINDOW_MARKER} closes 2029-05-01.`,
      },
    });
    expect(observedCycles(beyond, [beyond], FROM, TO)).toEqual([]);
  });

  it('writes nothing for a kind that asserts there is no application cycle', () => {
    for (const kind of ['no_application_exists', 'dormant'] as const) {
      const p = makeProgram({
        id: `no-cycle-${kind}`,
        deadline: {
          kind,
          source: { kind: 'self' },
          note: `The funder selects recipients. Application deadline ${OBSERVED_WINDOW_MARKER} closes 2026-09-30.`,
        },
      });
      expect(observedCycles(p, [p], FROM, TO), kind).toEqual([]);
    }
  });

  it('gives an inheriting programme its owner’s stated window under its own id', () => {
    const dependent = makeProgram({
      id: 'dependent',
      name: 'Dependent Scholarship',
      deadline: {
        kind: 'inherited',
        source: { kind: 'inherited', fromProgramId: ariss.id },
        note: 'This record has no deadline of its own; it rides another program’s cycle.',
      },
    });
    const cycles = observedCycles(dependent, [ariss, dependent], FROM, TO);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].programId).toBe('dependent');
    expect(cycles[0].id).toBe('dependent:observed:2026-09-30T23:59:59.999Z');
    expect(cycles[0].label).toBe('Jul 1 – Sep 30, 2026 window (via ARISS ISS Contact Proposal)');
    expect(cycles[0].isEstimated).toBe(false);
  });

  it('fabricates nothing for an inheriting programme whose owner is absent from the corpus', () => {
    // resolveDeadlineOwner hands back the input programme, whose kind is still `inherited` — and
    // an inherited record must not acquire a deadline from its own prose.
    const orphan = makeProgram({
      id: 'orphan',
      deadline: {
        kind: 'inherited',
        source: { kind: 'inherited', fromProgramId: 'not-published-yet' },
        note: `It rides another cycle. Application deadline ${OBSERVED_WINDOW_MARKER} closes 2026-09-30.`,
      },
    });
    expect(observedCycles(orphan, [orphan], FROM, TO)).toEqual([]);
  });

  it('returns nothing for an inverted or unparsable range', () => {
    expect(observedCycles(ariss, [ariss], TO, FROM)).toEqual([]);
    expect(observedCycles(ariss, [ariss], 'not-a-date', TO)).toEqual([]);
  });

  it('produces a stable id so a re-approval upserts instead of duplicating', () => {
    const a = observedCycles(ariss, [ariss], FROM, TO);
    const b = observedCycles(ariss, [ariss], FROM, TO);
    expect(a).toEqual(b);
  });
});

describe('an appended observed window leaves the RECUR projection untouched', () => {
  // `normalize/deadline.ts` appends the funder's stated dates AFTER the ` | ` a RECUR directive
  // terminates at, precisely so that the 112 candidates riding `arrl-scholarship-program` project
  // exactly as before. This asserts the real projected dates, not merely a matching count.
  const withStated = makeProgram({
    deadline: {
      ...arrlScholarships.deadline,
      note: `${arrlScholarships.deadline.note} Application window ${OBSERVED_WINDOW_MARKER} opens 2026-11-01, closes 2026-11-30.`,
    },
  });

  it('projects the identical rows with and without the appended sentence', () => {
    const without = expandCycles(arrlScholarships, [arrlScholarships], FROM, TO);
    const withIt = expandCycles(withStated, [withStated], FROM, TO);
    expect(withIt).toEqual(without);
    expect(without.map((c) => c.closesAt)).toEqual([
      '2026-12-30T17:00:00.000Z', // Dec 30, 2026 12:00 EST
      '2027-12-30T17:00:00.000Z', // Dec 30, 2027 12:00 EST
    ]);
    expect(without.map((c) => c.opensAt)).toEqual([
      '2026-10-30T04:00:00.000Z',
      '2027-10-30T04:00:00.000Z',
    ]);
    expect(without.every((c) => c.isEstimated)).toBe(true);
  });

  it('still lets an inheriting programme ride that projection bit-for-bit', () => {
    const before = expandCycles(qcwa, [arrlScholarships, qcwa], FROM, TO);
    const after = expandCycles(qcwa, [withStated, qcwa], FROM, TO);
    expect(after).toEqual(before);
    expect(before.map((c) => c.closesAt)).toEqual([
      '2026-12-30T17:00:00.000Z',
      '2027-12-30T17:00:00.000Z',
    ]);
    expect(before[0].label).toBe(
      'Oct 30 – Dec 30, 2026 window (via ARRL Foundation Scholarship Program)',
    );
  });

  it('a programme carrying BOTH yields both, told apart by isEstimated and by nothing else', () => {
    // No programme in the corpus carries both today (no source with a RECUR directive parses
    // dates). Pinned so that if one ever does, the projection of the RULE and the record of the
    // STATED window are two separate claims and neither silently swallows the other.
    const projected = expandCycles(withStated, [withStated], FROM, TO);
    const stated = observedCycles(withStated, [withStated], FROM, TO);
    expect(projected.every((c) => c.isEstimated)).toBe(true);
    expect(stated).toHaveLength(1);
    expect(stated[0].isEstimated).toBe(false);
    expect(stated[0].closesAt).toBe('2026-11-30T23:59:59.999Z');
    expect(projected.map((c) => c.id)).not.toContain(stated[0].id);
  });
});
