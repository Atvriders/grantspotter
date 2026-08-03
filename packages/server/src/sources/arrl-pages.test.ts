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

// The committed REAL captures under fixtures/<id>/00-*.html — pages actually pulled from
// arrl.org on 2026-08-02, as opposed to the synthetic pathological.html above. Plan 2's review
// found that every existing test in this file drove only the synthetic fixture, which is how
// arrl-scholarship-program shipped a parser that returns zero records against the live page
// while staying green: "the tests measure agreement between a parser and its author, not
// between a parser and the web." Each block below exercises the real page and checks actual
// field values against the raw HTML, not just a record count.
const real = (id: string, file: string, url: string) => fixturePayload(id, file, url);

describe('arrl-amateur-radio-grants', () => {
  const raws = arrlAmateurRadioGrants.parse([
    p('arrl-amateur-radio-grants', 'https://www.arrl.org/amateur-radio-grants'),
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

describe('arrl-amateur-radio-grants (REAL fixture)', () => {
  // Raw HTML, fixtures/arrl-amateur-radio-grants/00-www-arrl-org-amateur-radio-grants.html:
  //   line 140: <li>February 1 - February 28</li>
  //   line 142: <li>October 1 - October 31</li>
  //   line 151: <li>Awarded grants generally do not exceed $3,000.*</li>
  //   line 155: <strong>*In support of ARRL's Year of the Club, award amounts may be up to
  //             $5,000 in 2026. </strong>
  // The $3,000 cap and the $5,000-in-2026 footnote are two separate sentences, three
  // paragraphs apart on the live page — this is the shape that broke the old single-field
  // `amount` pattern.
  const raws = arrlAmateurRadioGrants.parse([
    real(
      'arrl-amateur-radio-grants',
      '00-www-arrl-org-amateur-radio-grants.html',
      'https://www.arrl.org/amateur-radio-grants',
    ),
  ]);

  it('parses exactly one record from the live page', () => {
    expect(raws).toHaveLength(1);
  });

  it('captures all three windows even though the live page lists them one per line, not one sentence', () => {
    expect(raws[0].rawFields.windows).toBe(
      'February 1 - February 28 June 1 - June 30 October 1 - October 31',
    );
  });

  it('splits the $3,000 cap and the "$5,000 in 2026" footnote into amount/amountNote instead of dropping the footnote', () => {
    expect(raws[0].rawFields.amount).toBe('generally do not exceed $3,000.');
    expect(raws[0].rawFields.amountNote).toBe(
      "In support of ARRL's Year of the Club, award amounts may be up to $5,000 in 2026.",
    );
  });

  // Round 2 (whole-branch review): restrictions/applicant feed normalize/axes/* directly, so a
  // stale pattern here doesn't just leave a field blank — it lets the matcher compute a
  // confidently wrong eligibility constraint. Raw HTML, lines 145-146, 150:
  //   <li>Grant requests for emergency communications equipment, facilities, or projects will
  //       not be considered.</li>
  //   <li>Grant requests for ongoing operations or expenses will not be considered.</li>
  //   ...
  //   <li>Grants are awarded only to organizations, not individuals.</li>
  it('captures both live exclusion sentences and the organizations-only sentence verbatim', () => {
    expect(raws[0].rawFields.restrictions).toBe(
      'Grant requests for emergency communications equipment, facilities, or projects will not ' +
        'be considered. Grant requests for ongoing operations or expenses will not be considered.',
    );
    expect(raws[0].rawFields.applicant).toBe('Grants are awarded only to organizations, not individuals.');
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

describe('arrl-club-grant (REAL fixture)', () => {
  // Raw HTML, fixtures/arrl-club-grant/00-www-arrl-org-club-grant-program.html:
  //   line 161: <p><span>Kansas State University Amateur Radio Club - KS</span></p>
  //   line 180: <p><span>WB4SA, Radio Scouting - FL</span>  </p>
  // Both rows are "Name - ST" with NO dollar amount — the live 2024 recipient list format the
  // old comma-anchored RECIPIENT_LINE matched zero of. WB4SA's own name contains a comma, which
  // exercises the lazy backtracking past an embedded comma to the real name/state separator.
  const raws = arrlClubGrant.parse([
    real('arrl-club-grant', '00-www-arrl-org-club-grant-program.html', 'https://www.arrl.org/club-grant-program'),
  ]);

  it('parses the main program record plus all 37 recipients from the live 2024 list', () => {
    const awards = raws.filter((r) => r.rawFields.recordType === 'past_award');
    expect(raws).toHaveLength(38);
    expect(awards).toHaveLength(37);
  });

  it('mines "Name - ST" rows with no dollar amount, including a name containing its own comma', () => {
    const kansas = raws.find((r) => r.rawFields.recipient === 'Kansas State University Amateur Radio Club');
    expect(kansas?.rawFields.state).toBe('KS');
    expect(kansas?.rawFields.amountRaw).toBe('');
    expect(kansas?.externalKey).toBe('past-award:Kansas State University Amateur Radio Club:KS');

    const wb4sa = raws.find((r) => r.rawFields.recipient === 'WB4SA, Radio Scouting');
    expect(wb4sa?.rawFields.state).toBe('FL');
    expect(wb4sa?.rawFields.amountRaw).toBe('');
    expect(wb4sa?.externalKey).toBe('past-award:WB4SA, Radio Scouting:FL');
  });

  // Round 2 (whole-branch review, 2026-08-03): the live page's raw HTML contains no occurrence
  // of "affiliat" or "eligib" in any form (confirmed by grepping the captured fixture directly),
  // so `eligibility` is genuinely unresolvable from this capture — not a regex miss. Asserting
  // it stays undefined pins that as a deliberate, verified omission rather than a silent gap: a
  // future edit that starts matching *something* here should be forced to explain what changed.
  it('leaves eligibility undefined — the live page states no affiliation requirement anywhere', () => {
    const main = raws.find((r) => r.externalKey === 'club-grant-program');
    expect(main?.rawFields.eligibility).toBeUndefined();
  });
});

describe('parseClubGrantRecipients', () => {
  it('ignores lines that are not recipient rows', () => {
    expect(parseClubGrantRecipients('Just some prose about grants.', 'https://x.test')).toEqual([]);
  });
});

describe('arrl-etp-grants', () => {
  const raws = arrlEtpGrants.parse([p('arrl-etp-grants', 'https://www.arrl.org/etp-grants')]);

  it('captures the October window and the year-specific Jotform id', () => {
    expect(raws[0].rawFields.window).toMatch(/October 1 - 31/);
    expect(raws[0].rawFields.jotformId).toBe('243456789012345');
  });

  it('captures the teacher/K-12 applicant sentence', () => {
    expect(raws[0].rawFields.applicant).toMatch(/teachers/i);
  });
});

describe('arrl-etp-grants (REAL fixture)', () => {
  // Raw HTML, fixtures/arrl-etp-grants/00-www-arrl-org-etp-grants.html:
  //   line 145: Step 2: Complete the <a href="https://form.jotform.com/252714368960161">
  //             2025 ETP Grant Application on Jotform</a> here.
  //   (elsewhere on the page): "APPLICATIONS WILL ONLY BE ACCEPTED FOR REVIEW BETWEEN
  //   OCTOBER 1ST AND OCTOBER 31ST of 2025."
  const raws = arrlEtpGrants.parse([
    real('arrl-etp-grants', '00-www-arrl-org-etp-grants.html', 'https://www.arrl.org/etp-grants'),
  ]);

  it('parses exactly one record from the live page', () => {
    expect(raws).toHaveLength(1);
  });

  it('captures the ALL-CAPS "1ST AND ... 31ST" window and the live Jotform id', () => {
    expect(raws[0].rawFields.window).toBe('OCTOBER 1ST AND OCTOBER 31ST of 2025.');
    expect(raws[0].rawFields.jotformId).toBe('252714368960161');
  });

  // Round 2 (whole-branch review): raw HTML, line 138 (tags stripped by flattenHtml):
  //   "...a working relationship with local ham radio volunteers who will provide mentoring
  //   support for the school.<span> Grant applicants must be a <em>current ARRL member</em> to
  //   be eligible to apply.<br /></span></p>"
  // The live page never says "available to teachers" as a contiguous phrase — the old pattern
  // matched nothing here. The actual applicant-eligibility sentence is the ARRL-membership one.
  it('captures the live "must be a current ARRL member" sentence, not the synthetic wording', () => {
    expect(raws[0].rawFields.applicant).toBe(
      'Grant applicants must be a current ARRL member to be eligible to apply.',
    );
  });
});

describe('arrl-scholarship-program', () => {
  it('captures the open/close sentence and the 12:00 PM EST close time', () => {
    const raws = arrlScholarshipProgram.parse([
      p('arrl-scholarship-program', 'https://www.arrl.org/scholarship-program'),
    ]);
    expect(raws[0].rawFields.window).toMatch(/opens October 30/i);
    expect(raws[0].rawFields.closeTime).toBe('12:00 PM EST');
  });
});

describe('arrl-scholarship-program (REAL fixture — this is defect #1)', () => {
  // Raw HTML, fixtures/arrl-scholarship-program/00-www-arrl-org-scholarship-program.html:
  //   line 140: <p><strong>The 2026 Scholarship Cycle is now closed. </strong></p>
  //   line 164: The 2026 scholarship cycle is closed.
  // Neither sentence contains the word "open" anywhere, which is why the original
  // `/(opens?[^.]*?clos[^.]*\.)/i` pattern matched nothing on this page and the source — the
  // one that owns the deadline 112 of 181 candidates inherit — silently produced zero records.
  const raws = arrlScholarshipProgram.parse([
    real('arrl-scholarship-program', '00-www-arrl-org-scholarship-program.html', 'https://www.arrl.org/scholarship-program'),
  ]);

  it('still parses exactly one record from a closed-cycle page, instead of zero', () => {
    expect(raws).toHaveLength(1);
  });

  it('represents the closed cycle as rawFields.status, without fabricating open/close dates', () => {
    expect(raws[0].rawFields.status).toBe('closed');
    expect(raws[0].rawFields.window).toMatch(/scholarship cycle is now closed/i);
    // No close time is published anywhere on a closed-cycle page — must stay unset, not guessed.
    expect(raws[0].rawFields.closeTime).toBeUndefined();
  });
});

describe('arrl-foundation-special-funds', () => {
  it('parses a single prose record', () => {
    const raws = arrlFoundationSpecialFunds.parse([
      p('arrl-foundation-special-funds', 'https://www.arrl.org/arrl-foundation-special-funds'),
    ]);
    expect(raws).toHaveLength(1);
    expect(raws[0].rawFields.summary).toMatch(/special funds/i);
  });
});

describe('arrl-foundation-special-funds (REAL fixture)', () => {
  // Raw HTML, fixtures/arrl-foundation-special-funds/00-www-arrl-org-arrl-foundation-special-funds.html
  // line 143: The ARRL Foundation manages special funds that provide awards to celebrate
  //           individual accomplishments and grant for youth-oriented Amateur Radio activities.
  // The page's own <h1> is "ARRL Foundation Special Funds" with no trailing period, sitting
  // above ~500 characters of nav-menu chrome before this sentence — the old bare
  // `special funds?[^.]*\.` pattern matched the heading first and ran through all of it,
  // yielding a 612-character "summary" that was entirely navigation links.
  const raws = arrlFoundationSpecialFunds.parse([
    real(
      'arrl-foundation-special-funds',
      '00-www-arrl-org-arrl-foundation-special-funds.html',
      'https://www.arrl.org/arrl-foundation-special-funds',
    ),
  ]);

  it('parses exactly one record from the live page', () => {
    expect(raws).toHaveLength(1);
  });

  it('captures the actual summary sentence, not the nav chrome above it', () => {
    expect(raws[0].rawFields.summary).toBe(
      'The ARRL Foundation manages special funds that provide awards to celebrate individual ' +
        'accomplishments and grant for youth-oriented Amateur Radio activities.',
    );
    // The regression this guards against produced 612 characters of navigation links.
    expect(raws[0].rawFields.summary.length).toBeLessThan(200);
  });
});

describe('arrl-summary-of-scholarship-requirements', () => {
  it('is a cross-check source: expectedMinRecords 0 and it never publishes', () => {
    expect(arrlSummaryOfScholarshipRequirements.expectedMinRecords).toBe(0);
    expect(arrlSummaryOfScholarshipRequirements.notes).toMatch(/stale/i);
    const raws = arrlSummaryOfScholarshipRequirements.parse([
      p(
        'arrl-summary-of-scholarship-requirements',
        'https://www.arrl.org/summary-of-scholarship-requirements',
      ),
    ]);
    for (const raw of raws) expect(raw.rawFields.recordType).toBe('crosscheck');
  });
});

describe('arrl-summary-of-scholarship-requirements (REAL fixture)', () => {
  // Raw HTML, fixtures/arrl-summary-of-scholarship-requirements/00-...html: the table's first
  // data row reads "Androscroggin | ME or ARRL New England Division". This source is documented
  // as STALE and crosscheck-only (see the config notes), so this test does not chase parser
  // quality here — it only pins the one behavior that matters for a source normalize/ refuses
  // to publish: it still runs against the real page, still tags crosscheck, and still yields
  // exactly the single record `expectedMinRecords: 0` promises callers should not rely on.
  const raws = arrlSummaryOfScholarshipRequirements.parse([
    real(
      'arrl-summary-of-scholarship-requirements',
      '00-www-arrl-org-summary-of-scholarship-requirements.html',
      'https://www.arrl.org/summary-of-scholarship-requirements',
    ),
  ]);

  it('parses one crosscheck-tagged record containing real table rows', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].rawFields.recordType).toBe('crosscheck');
    expect(raws[0].rawFields.table).toContain('Androscroggin');
  });
});
