import { describe, expect, it } from 'vitest';
import type { Cycle } from '@grantspotter/core';
// THE ONE CROSS-PACKAGE IMPORT IN THIS FILE, AND THE REASON FOR IT.
//
// `funderLocalDay` renders the calendar day a deadline instant belongs to. `formatDate`
// (packages/web/src/lib/trust.ts) is the single helper every deadline ON SCREEN is formatted
// through. If the two disagree, a user reads one day in the browser and mails a colleague a
// spreadsheet saying another — which is the one-day-late defect this repo has already paid for
// once. Pinning them against each other is the only way to keep the export and the screen in
// step, and `api/deadlineRendering.test.ts` sets the precedent for reaching across the package
// boundary in a TEST rather than reimplementing the answer.
import { formatDate } from '../../../web/src/lib/trust.js';
import { buildExportRows, EXPORT_FIELDS, funderLocalDay } from './rows.js';
import { makeCycle, makeFunder, makeProgram, makeSuppressedProgram } from './testFixtures.js';

const funders = [makeFunder()];

function rowFor(program = makeProgram(), cycles: Cycle[] = []) {
  const map = new Map([[program.id, cycles]]);
  const [row] = buildExportRows([program], funders, map);
  return row;
}

describe('funderLocalDay', () => {
  /**
   * A deadline is stored as the UTC instant of a 23:59 LOCAL wall time. The ARRL's "closes 28
   * February 2027" in America/New_York is `2027-03-01T04:59:00.000Z`. Rendered without the zone it
   * prints 2027-03-01 and tells an applicant they have a day they do not have.
   */
  it('renders the funder’s own calendar day, not the UTC day', () => {
    expect(funderLocalDay('2027-03-01T04:59:00.000Z', 'America/New_York')).toBe('2027-02-28');
    expect(funderLocalDay('2026-11-01T03:59:00.000Z', 'America/New_York')).toBe('2026-10-31');
    expect(funderLocalDay('2027-02-02T07:59:00.000Z', 'America/Los_Angeles')).toBe('2027-02-01');
  });

  it('renders UTC when no zone was recorded, and never guesses the server’s zone', () => {
    expect(funderLocalDay('2027-03-01T04:59:00.000Z', undefined)).toBe('2027-03-01');
    expect(funderLocalDay('2027-03-01T04:59:00.000Z', '')).toBe('2027-03-01');
  });

  it('leaves a date-only value alone — it is already a calendar day with no instant to re-zone', () => {
    expect(funderLocalDay('2026-12-30', 'America/Los_Angeles')).toBe('2026-12-30');
  });

  it('renders an absent or unparseable value as an empty cell, never as a wrong date', () => {
    expect(funderLocalDay(undefined, 'UTC')).toBe('');
    expect(funderLocalDay('', 'UTC')).toBe('');
    expect(funderLocalDay('not a date', 'UTC')).toBe('');
  });

  it('agrees with the renderer the browser uses for every instant it is given', () => {
    const cases: Array<[string, string]> = [
      ['2027-03-01T04:59:00.000Z', 'America/New_York'],
      ['2026-09-02T06:59:00.000Z', 'America/Los_Angeles'],
      ['2026-09-30T23:59:59.999Z', 'UTC'],
      ['2026-12-30', 'America/New_York'],
    ];
    for (const [iso, tz] of cases) {
      expect(funderLocalDay(iso, tz), `${iso} @ ${tz}`).toBe(formatDate(iso, tz));
    }
  });
});

describe('buildExportRows', () => {
  it('resolves the funder name and carries the programme through', () => {
    const row = rowFor();
    expect(row.funderName).toBe('Amateur Radio Digital Communications');
    expect(row.cells.id).toBe('ardc-grants');
    expect(row.cells.funder).toBe('Amateur Radio Digital Communications');
  });

  it('renders an unknown funder id as an empty name instead of throwing', () => {
    const map = new Map<string, Cycle[]>();
    const [row] = buildExportRows([makeProgram({ funderId: 'nope' })], [], map);
    expect(row.cells.funder).toBe('');
    expect(row.cells.id).toBe('ardc-grants');
  });

  it('refuses every do_not_publish record, so no format can render one', () => {
    const rows = buildExportRows([makeProgram(), makeSuppressedProgram()], funders, new Map());
    expect(rows.map((r) => r.cells.id)).toEqual(['ardc-grants']);
  });

  it('fills every declared field on every row, so no format sees an undefined cell', () => {
    const row = rowFor(makeProgram(), [makeCycle()]);
    for (const field of EXPORT_FIELDS) {
      expect(typeof row.cells[field], `${field} must be a string`).toBe('string');
    }
    expect(Object.keys(row.cells).sort()).toEqual([...EXPORT_FIELDS].sort());
  });

  it('flattens list fields with a semicolon so the cell stays one field', () => {
    expect(rowFor().cells.applicantEntities).toBe(
      'club_via_fiscal_sponsor; school_lea; university',
    );
  });
});

/**
 * Almost every exported deadline is computed from a recurrence rule rather than published by its
 * funder. A projected date exported without that distinction becomes an authoritative-looking
 * deadline in someone's spreadsheet.
 *
 * The two corpora, because "the committed corpus" used to stand here and meant whichever one the
 * reader assumed: the FIXTURE corpus projects 243 cycles of which 4 are funder-published at
 * `profile-corpus.ts`'s fixed 2026-08-02 clock (asserted in `corpus.test.ts`), while `data/seed/`,
 * which is what a fresh install serves, holds 3 records declaring a funder-published window — 2 of
 * which still resolve to a future cycle today and none of which do from 2027.
 */
describe('buildExportRows — projected dates are labelled as projected', () => {
  it('labels a funder-published cycle as published', () => {
    const row = rowFor(makeProgram(), [makeCycle({ isEstimated: false })]);
    expect(row.cells.deadlineBasis).toBe('funder-published');
  });

  it('labels a computed cycle as projected, in words a spreadsheet reader cannot mistake', () => {
    const row = rowFor(makeProgram(), [makeCycle({ isEstimated: true })]);
    expect(row.cells.deadlineBasis).toBe('projected (estimated by GrantSpotter, not the funder)');
  });

  it('leaves the basis empty when there is no cycle at all', () => {
    const row = rowFor(makeProgram(), []);
    expect(row.cells.deadlineBasis).toBe('');
    expect(row.cells.nextCloses).toBe('');
  });

  it('picks the earliest closing cycle as the next one', () => {
    const row = rowFor(makeProgram(), [
      makeCycle({ id: 'c2', closesAt: '2027-07-02T06:59:00.000Z', isEstimated: true }),
      makeCycle({ id: 'c1', closesAt: '2027-02-02T07:59:00.000Z', isEstimated: true }),
    ]);
    expect(row.cells.nextClosesUtc).toBe('2027-02-02T07:59:00.000Z');
    expect(row.cells.nextCloses).toBe('2027-02-01');
    expect(row.cells.timezone).toBe('America/Los_Angeles');
  });
});

/**
 * `costShareRequired` and `coFunderPreference` are tri-state. Absent means NO PAGE ADDRESSED IT,
 * which is a different instruction to an applicant than "the funder has told us this is not
 * required". Across the 150 publishable programmes it is unstated on 148, true on 2 and false on
 * ZERO — so a renderer that collapses absent into "no" would publish a claim no funder has made,
 * 148 times, in a file the user then mails to somebody.
 */
describe('buildExportRows — obligations stay three-state', () => {
  it('renders an unstated obligation as unstated, never as "not required"', () => {
    const row = rowFor(makeProgram({ obligations: {} }));
    expect(row.cells.costShareRequired).toBe('unstated');
    expect(row.cells.coFunderPreference).toBe('unstated');
    expect(row.cells.costShareRequired).not.toContain('not required');
  });

  it('renders a stated no as "not required" — the funder actually said so', () => {
    const row = rowFor(makeProgram({ obligations: { costShareRequired: false } }));
    expect(row.cells.costShareRequired).toBe('not required');
  });

  it('renders a stated yes as required', () => {
    const row = rowFor(makeProgram({ obligations: { costShareRequired: true } }));
    expect(row.cells.costShareRequired).toBe('required');
  });

  it('renders coFunderPreference in its own vocabulary rather than borrowing cost share’s', () => {
    expect(rowFor(makeProgram({ obligations: { coFunderPreference: true } })).cells.coFunderPreference).toBe(
      'preferred',
    );
    expect(
      rowFor(makeProgram({ obligations: { coFunderPreference: false } })).cells.coFunderPreference,
    ).toBe('not preferred');
  });
});
