import { describe, it, expect } from 'vitest';
import { ardcGrants, arrlScholarship, qcwaScholarship } from '../test/fixtures/programs.js';
import { prepLeadFor, prepStartFor } from './prepLead.js';

describe('prepLeadFor', () => {
  it('gives ARDC its published 60-120 day evaluation lag', () => {
    const lead = prepLeadFor(ardcGrants);
    expect(lead.decisionLagMinDays).toBe(60);
    expect(lead.decisionLagMaxDays).toBe(120);
    expect(lead.note).toContain('60');
  });

  it('gives ARDC a prep lead long enough to gather three references', () => {
    expect(prepLeadFor(ardcGrants).prepLeadDays).toBe(45);
  });

  it('gives an ARRL scholarship a transcript-and-reference lead', () => {
    const lead = prepLeadFor(arrlScholarship);
    expect(lead.prepLeadDays).toBe(30);
    expect(lead.note).toContain('transcript');
  });

  it('inherits the lead of the program a deadline was inherited from', () => {
    // QCWA rides the ARRL cycle, so it inherits the ARRL lead rather than the
    // generic default.
    expect(prepLeadFor(qcwaScholarship).prepLeadDays).toBe(30);
  });

  it('falls back to a documented default for a funder with no published lead', () => {
    const lead = prepLeadFor({ ...ardcGrants, funderId: 'unknown-funder', tags: [] });
    expect(lead.prepLeadDays).toBe(30);
    expect(lead.note).toContain('no published lead time');
  });

  /**
   * ADDED BY TASK 11, not in the brief. NCDXF's two-months-of-lead is one of the
   * two numbers the brief's own rationale names ("ARDC evaluates for 60-120 days
   * ... NCDXF asks for roughly two months' lead"), and it is the entry that
   * proves the table is not one number wearing six hats: 60 is not 45 and is not
   * the 30-day default.
   */
  it('gives NCDXF the two months of lead it asks for', () => {
    const lead = prepLeadFor({ ...ardcGrants, funderId: 'ncdxf' });
    expect(lead.prepLeadDays).toBe(60);
    expect(lead.note).toContain('two months');
  });

  /**
   * FIXED (2026-08-04). This note used to state "carries a 12-month on-air obligation the club
   * must agree to first" — a claim that appears zero times, case-insensitively, in the 145,639-
   * byte Yaesu capture (`fixtures/yaesu-dr2x/00-systemfusion-yaesu-com.html`; see Task 9's audit
   * and `content/templates/funders/funder-yaesu-dr2x.md`, which established the honest phrasing:
   * the application is a fillable PDF this crawler never downloads, so any obligation it carries
   * is unknown, not published). This is a calendar-tooltip string rendered straight to an
   * applicant via `calendarRouter.ts`'s `prepNote`, so the fix belongs in the string itself, not
   * only in a comment beside it.
   */
  it('never asserts a Yaesu on-air obligation the funder never published', () => {
    const lead = prepLeadFor({ ...ardcGrants, funderId: 'yaesu' });
    expect(lead.note).not.toMatch(/12 months|12-month|twelve months|on the air|on-air|remain/i);
    expect(lead.note).toMatch(/unknown, not published/);
  });

  /**
   * ADDED BY TASK 11. `prepLeadFor` answers out of a module-level table, and the
   * calendar route calls it once per program and hands the result to a response
   * body. Returning the table row itself would let one mutated response rewrite
   * every later answer for the life of the process.
   */
  it('answers with a copy, so a caller cannot rewrite the table for everyone', () => {
    const first = prepLeadFor(ardcGrants);
    first.prepLeadDays = 9999;
    expect(prepLeadFor(ardcGrants).prepLeadDays).toBe(45);
  });
});

describe('prepStartFor', () => {
  it('subtracts the lead from the close date', () => {
    expect(prepStartFor('2026-12-30T17:00:00.000Z', 30)).toBe('2026-11-30T17:00:00.000Z');
  });

  it('returns null when there is no close date', () => {
    expect(prepStartFor(null, 30)).toBeNull();
  });

  /**
   * ADDED BY TASK 11. An unparseable close date must not become an
   * `Invalid Date` that `toISOString()` throws on, and must not become a silent
   * "start today" either — a date we could not read is not a date we may
   * publish a start time from.
   */
  it('returns null rather than inventing a start from an unreadable close date', () => {
    expect(prepStartFor('not-a-date', 30)).toBeNull();
  });
});
