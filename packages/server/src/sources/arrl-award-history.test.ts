// `arrl-pages.ts`'s `withoutAwardHistory` — the source-level half of the fabrication sweep.
//
// THE DEFECT THIS FILE PINS. arrl.org/arrl-foundation-special-funds publishes the Bill Orr W6SAI
// Technical Writing Award's roll of past winners in the middle of its prose: a bare "Winners:"
// label and 23 lines of "YYYY Name, CALL, for \"Title\"". `makeSinglePageSource` files the whole
// flattened page as `rawText` and this source labels only a `summary`, so that block reached every
// eligibility axis. It carries no sentence terminator for 23 lines, so `splitClauses` cannot break
// it, and its quoted article titles contain colons while its contributors' initials contain
// periods, so `withoutSiteChrome` cannot see it as a run of link labels either — a previous round
// tightened `isChromeLine` to try, MEASURED that it removed neither constraint, and reverted.
//
// The separator is provenance, not wording: a roll of past recipients records who has already won,
// not who may apply. `parseClubGrantRecipients` in the same file already makes exactly that
// judgement for the Club Grant page's recipient list.
//
// What it removed: `citizenship` HARD `{allowed: ["ANY"]}`, minted because the citizenship axis's
// `OPEN_WORLDWIDE` found "Worldwide" inside the 2024 winner's QST byline, "Worldwide Fun with 100 W
// and a Dipole". The ARRL Foundation says nothing about nationality on that page.
import { describe, expect, it } from 'vitest';
import { withoutAwardHistory } from './arrl-pages.js';

// Verbatim from the committed capture (fixtures/arrl-foundation-special-funds), trimmed in the
// middle. The colon inside "Lightning: Understand It…" and the period in "Lynden L." are the two
// characters that defeated every text-shape rule tried before this one.
const REAL_PAGE = [
  'Award: The award will be an engraved plaque to be presented at an ARRL convention if possible.',
  'Winners:',
  '2002 Ian Poole, G3YWX, for "Understanding Solar Indices"',
  '2008 Larry Scheff, W4QEJ, for "Lightning: Understand It or Suffer the Consequences"',
  '2023 Lynden L. "Lindy" Williams, K6EB, for "Microphones and Ham Radio"',
  '2024 Carl Luetzelschwab, K9LA, for "Worldwide Fun with 100 W and a Dipole"',
  'Victor C. Clark Youth Incentive Fund',
  'Groups that qualify for mini-grants will include, but not be limited to, high school radio clubs.',
].join('\n');

describe('an award-history roll is not eligibility text', () => {
  it('drops the label line and every year-led entry under it', () => {
    expect(withoutAwardHistory(REAL_PAGE)).toBe(
      [
        'Award: The award will be an engraved plaque to be presented at an ARRL convention if possible.',
        'Victor C. Clark Youth Incentive Fund',
        'Groups that qualify for mini-grants will include, but not be limited to, high school radio clubs.',
      ].join('\n'),
    );
  });

  it('takes the whole word "Worldwide" with it — the one that fabricated a citizenship scope', () => {
    expect(withoutAwardHistory(REAL_PAGE)).not.toMatch(/worldwide/i);
  });

  it('keeps the prose either side, including the label-shaped line above the roll', () => {
    const kept = withoutAwardHistory(REAL_PAGE);
    expect(kept).toContain('Award: The award will be an engraved plaque');
    expect(kept).toContain('Groups that qualify for mini-grants');
  });

  it('leaves a page with no roll byte-identical — the other five ARRL configs', () => {
    const prose = [
      'ARRL Club Grant Program',
      'Grants range from as small as $1,000 to as large as the maximum $25,000.',
      'Kansas State University Amateur Radio Club - KS',
      'Nixa Amateur Radio Club, Inc. - MO',
      'Winners:',
      'Kansas State University Amateur Radio Club - KS',
    ].join('\n');
    // "Winners:" with no run of YEAR-led lines beneath it is just a label — the RUN is what makes
    // it a roll, exactly as `withoutSiteChrome`'s CHROME_RUN_MIN is what makes a menu a menu.
    expect(withoutAwardHistory(prose)).toBe(prose);
  });

  it('will not eat ordinary prose that happens to open with a year', () => {
    const prose = [
      'Winners:',
      '2026 applications open on October 1.',
      'The award is announced each January.',
    ].join('\n');
    expect(withoutAwardHistory(prose)).toBe(prose);
  });

  it('recognises the other spellings of the same block', () => {
    for (const label of ['Recipients:', 'Past Winners:', 'AWARDEES:']) {
      const roll = [label, '2001 A', '2002 B', '2003 C', '2004 D', 'Eligibility follows.'].join('\n');
      expect(withoutAwardHistory(roll)).toBe('Eligibility follows.');
    }
  });
});
