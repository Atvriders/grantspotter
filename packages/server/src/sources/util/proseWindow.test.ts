import { describe, expect, it } from 'vitest';
import { parseProseWindow } from './proseWindow.js';

/**
 * MOVED WITH THE PARSER, unchanged. Every shape below is lifted from a committed capture or one of
 * its siblings — none is invented to flatter the parser. The four sentences the reader exists for
 * are also asserted against their own real fixtures, next to the sources that read them
 * (`tier-c-a.test.ts` for austin-arc, `tier-c-b.test.ts` for arrl-etp-grants and the two IEEE
 * pages); this file is the grammar underneath them, plus the decoys that share those pages.
 */
describe('parseProseWindow', () => {
  it('reads shouting caps, ordinal suffixes, "AND" as a separator, and a year that arrives as "of 2025"', () => {
    // fixtures/arrl-etp-grants/00-www-arrl-org-etp-grants.html, flattened lines 35 and 46.
    expect(
      parseProseWindow(
        'APPLICATIONS WILL ONLY BE ACCEPTED FOR REVIEW BETWEEN OCTOBER 1ST AND OCTOBER 31ST of 2025.',
      ),
    ).toEqual({
      opensOn: '10-01',
      closesOn: '10-31',
      opensAt: '2025-10-01',
      closesAt: '2025-10-31',
      yearUnstated: false,
    });
  });

  it('reads the same-month shorthand "October 1 - 31 of 2025", where the month is named once', () => {
    // fixtures/arrl-etp-grants/pathological.html — the shape an older ETP capture used.
    expect(parseProseWindow('October 1 - 31 of 2025.')).toEqual({
      opensOn: '10-01',
      closesOn: '10-31',
      opensAt: '2025-10-01',
      closesAt: '2025-10-31',
      yearUnstated: false,
    });
  });

  it('lets a year on the LAST date govern the first, which is where funders put it', () => {
    expect(parseProseWindow('Applications are accepted between May 1 and July 31, 2026.')).toEqual({
      opensOn: '05-01',
      closesOn: '07-31',
      opensAt: '2026-05-01',
      closesAt: '2026-07-31',
      yearUnstated: false,
    });
  });

  it('reads a month-granular range whose year sits at the far end of the token', () => {
    // Yaesu's PDF title, "…Jun-thru-Aug_2026.pdf": months only, and the year glued on with an
    // underscore. First of the opening month to the last of the closing month.
    expect(parseProseWindow('Yaesu DR-2X Repeater Grant Jun-thru-Aug_2026.pdf')).toEqual({
      opensOn: '06-01',
      closesOn: '08-31',
      opensAt: '2026-06-01',
      closesAt: '2026-08-31',
      yearUnstated: false,
    });
  });

  it('treats a lone date as a DEADLINE, including "must be received by" rather than "due"', () => {
    expect(parseProseWindow('All requests must be received by October 1, 2026.')).toEqual({
      closesOn: '10-01',
      closesAt: '2026-10-01',
      yearUnstated: false,
    });
    expect(parseProseWindow('Applications open May 1, 2026.')).toEqual({
      opensOn: '05-01',
      opensAt: '2026-05-01',
      yearUnstated: false,
    });
  });

  /* ------------------------------------------------------------------ the refusals ------------ */

  it('reports the month-days and NO dates when the sentence states no year', () => {
    expect(parseProseWindow('Applications open May 1 and close July 31 each year.')).toEqual({
      opensOn: '05-01',
      closesOn: '07-31',
      yearUnstated: true,
    });
    expect(parseProseWindow('Chapter funding requests are due October 1 each year.')).toEqual({
      closesOn: '10-01',
      yearUnstated: true,
    });
  });

  it('never treats a bare month name as a date, so a sentence using "may" as a verb is not a window', () => {
    // The exact clause that follows IEEE MTT-S's one deadline. A scanner that accepted bare months
    // would read this as a May-to-October window.
    expect(
      parseProseWindow('the chapter may be asked to make its application in the following year'),
    ).toBeUndefined();
  });

  it('never reads a date out of spelled-out or parenthesised numbers, or a bare day count', () => {
    expect(
      parseProseWindow('Minimum of ten (10) members; five (5) members for Student Branch Chapters'),
    ).toBeUndefined();
    // The "30" here is a duration, and the only real date in the sentence is October 31st.
    expect(
      parseProseWindow(
        'Recipients will be contacted within 30 days after the October 31st grant deadline.',
      ),
    ).toEqual({ closesOn: '10-31', yearUnstated: true });
  });

  it('rejects a day its month cannot have rather than clamping it to one that exists', () => {
    expect(parseProseWindow('Proposals close February 30, 2026.')).toBeUndefined();
    expect(parseProseWindow('Proposals close February 29, 2027.')).toBeUndefined();
    expect(parseProseWindow('Proposals close February 29, 2028.')).toEqual({
      closesOn: '02-29',
      closesAt: '2028-02-29',
      yearUnstated: false,
    });
  });

  it('does not mistake a schedule clause for an application window', () => {
    // The tail of ARISS's own window sentence. "to" is ordinary English, not range notation, and a
    // month range built out of it would put the ISS crew's contact schedule on the deadline
    // calendar as a six-month application period.
    expect(parseProseWindow('contacts to be held from January to June 2027')).toBeUndefined();
  });

  it('refuses a whole window whose close precedes its open, rather than keeping the close', () => {
    const window = parseProseWindow('Open November 1 and close March 31, 2026.');
    expect(window?.opensAt).toBeUndefined();
    expect(window?.closesAt).toBeUndefined();
    expect(window?.opensOn).toBe('11-01');
    expect(window?.closesOn).toBe('03-31');
  });

  it('returns undefined for a sentence with no date in it at all', () => {
    expect(parseProseWindow('Applications are accepted at any time.')).toBeUndefined();
  });
});
