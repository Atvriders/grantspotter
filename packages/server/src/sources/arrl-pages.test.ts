import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import {
  arrlAmateurRadioGrants,
  arrlClubGrant,
  arrlEtpGrants,
  arrlFoundationSpecialFunds,
  arrlScholarshipProgram,
  arrlSummaryOfScholarshipRequirements,
  parseClubGrantRecipients,
} from './arrl-pages.js';

const p = (id: string, url: string) => fixturePayload(id, 'pathological.html', url);

describe('arrl-amateur-radio-grants', () => {
  const raws = arrlAmateurRadioGrants.parse([
    p('arrl-amateur-radio-grants', 'http://www.arrl.org/amateur-radio-grants'),
  ]);

  it('captures all three application windows in one field', () => {
    expect(raws).toHaveLength(1);
    const windows = raws[0].rawFields.windows;
    expect(windows).toMatch(/February\s*1/);
    expect(windows).toMatch(/June\s*1/);
    expect(windows).toMatch(/October\s*1\s*-\s*31/);
  });

  it('captures the $3,000 / $5,000 amount sentence verbatim', () => {
    expect(raws[0].rawFields.amount).toContain('$3,000');
    expect(raws[0].rawFields.amount).toContain('$5,000');
  });

  it('captures the funding restrictions and the organizations-only rule', () => {
    expect(raws[0].rawFields.restrictions).toMatch(/emergency communications/i);
    expect(raws[0].rawFields.restrictions).toMatch(/operating expenses/i);
    expect(raws[0].rawFields.applicant).toMatch(/not to individuals/i);
  });
});

describe('arrl-club-grant', () => {
  const raws = arrlClubGrant.parse([p('arrl-club-grant', 'https://www.arrl.org/club-grant-program')]);

  it('captures the $1,000-$25,000 range and the affiliation requirement', () => {
    expect(raws[0].rawFields.amount).toContain('$25,000');
    expect(raws[0].rawFields.eligibility).toMatch(/ARRL-affiliated/i);
  });

  it('has NO deadline field, because the page has never published one', () => {
    expect(raws[0].rawFields.window).toBeUndefined();
    expect(raws[0].rawFields.deadline).toBeUndefined();
  });

  it('mines the recipient list as past-award records', () => {
    const awards = raws.filter((r) => r.rawFields.recordType === 'past_award');
    expect(awards).toHaveLength(5);
    expect(awards[0].rawFields.recipient).toBe('Kansas State University Amateur Radio Club');
    expect(awards[0].rawFields.state).toBe('KS');
    expect(awards[0].rawFields.amountRaw).toBe('$18,000');
    expect(awards[0].externalKey).toContain('Kansas State');
  });
});

describe('parseClubGrantRecipients', () => {
  it('ignores lines that are not recipient rows', () => {
    expect(parseClubGrantRecipients('Just some prose about grants.', 'https://x.test')).toEqual([]);
  });
});

describe('arrl-etp-grants', () => {
  const raws = arrlEtpGrants.parse([p('arrl-etp-grants', 'http://www.arrl.org/etp-grants')]);

  it('captures the October window and the year-specific Jotform id', () => {
    expect(raws[0].rawFields.window).toMatch(/October 1 - 31/);
    expect(raws[0].rawFields.jotformId).toBe('243456789012345');
  });

  it('captures the teacher/K-12 applicant sentence', () => {
    expect(raws[0].rawFields.applicant).toMatch(/teachers/i);
  });
});

describe('arrl-scholarship-program', () => {
  it('captures the open/close sentence and the 12:00 PM EST close time', () => {
    const raws = arrlScholarshipProgram.parse([
      p('arrl-scholarship-program', 'http://www.arrl.org/scholarship-program'),
    ]);
    expect(raws[0].rawFields.window).toMatch(/opens October 30/i);
    expect(raws[0].rawFields.closeTime).toBe('12:00 PM EST');
  });
});

describe('arrl-foundation-special-funds', () => {
  it('parses a single prose record', () => {
    const raws = arrlFoundationSpecialFunds.parse([
      p('arrl-foundation-special-funds', 'http://www.arrl.org/arrl-foundation-special-funds'),
    ]);
    expect(raws).toHaveLength(1);
    expect(raws[0].rawFields.summary).toMatch(/special funds/i);
  });
});

describe('arrl-summary-of-scholarship-requirements', () => {
  it('is a cross-check source: expectedMinRecords 0 and it never publishes', () => {
    expect(arrlSummaryOfScholarshipRequirements.expectedMinRecords).toBe(0);
    expect(arrlSummaryOfScholarshipRequirements.notes).toMatch(/stale/i);
    const raws = arrlSummaryOfScholarshipRequirements.parse([
      p(
        'arrl-summary-of-scholarship-requirements',
        'http://www.arrl.org/summary-of-scholarship-requirements',
      ),
    ]);
    for (const raw of raws) expect(raw.rawFields.recordType).toBe('crosscheck');
  });
});
