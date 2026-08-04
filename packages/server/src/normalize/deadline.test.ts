import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { inferDeadline, inferInstrument, inferStatus } from './deadline.js';
import type { NormalizeContext } from './index.js';

const NOW = '2026-08-02T00:00:00.000Z';

const ctx = (over: Partial<NormalizeContext> = {}): NormalizeContext => ({
  sourceId: 'arrl-scholarship-descriptions',
  funderId: 'arrl-foundation',
  klass: 'ham_scholarship',
  tier: 'C',
  nowISO: NOW,
  verificationMethod: 'live_fetch',
  mintId: () => 'test-id',
  ...over,
});

const raw = (over: Partial<RawOpportunity> = {}): RawOpportunity => ({
  sourceId: 'arrl-scholarship-descriptions',
  externalKey: 'Some Scholarship',
  name: 'Some Scholarship',
  rawFields: {},
  sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
  rawText: 'Some Scholarship body text',
  ...over,
});

/**
 * Remediation of the bug tracked at
 * .superpowers/sdd/2026-08-02-grantspotter-plan-2-ingestion/remediation-status-report.md:
 * `inferStatus` had no case for `manual`/`guided_workflow` recordTypes (same latent shape as the
 * already-fixed `safety_warning` bug) and no defense at all against a scraped record whose own
 * text says it is not currently active — the William C. Winscott Memorial Scholarship computed
 * `open` despite its "Other:" field reading "This scholarship is not currently active."
 */
describe('inferStatus — manual and guided_workflow recordTypes never default to open', () => {
  it('computes unknown for a manual record with no researched rawFields.status override', () => {
    // Every real manual-tier-d.ts record of this kind currently carries an explicit override
    // (FIX ROUND 2) — this exercises the defensive fallback for when one is absent, which used
    // to fall through every branch to 'open'.
    const status = inferStatus(
      raw({
        sourceId: 'manual-tier-d',
        externalKey: 'a-manual-record-with-no-status-yet',
        rawFields: { recordType: 'manual', deadlineKind: 'unpublished' },
        rawText: 'A hand-tracked programme with no published cycle.',
      }),
      ctx({ sourceId: 'manual-tier-d', funderId: 'various', tier: 'D', verificationMethod: 'manual_curation' }),
    );
    expect(status).toBe('unknown');
    expect(status).not.toBe('open');
  });

  it('computes unknown for a guided_workflow record with no researched rawFields.status override', () => {
    // NASA Space Grant (52 consortia) and campus SGA (~4,000 campuses) are structurally
    // non-aggregatable — there is no single deadline to derive a status from.
    const status = inferStatus(
      raw({
        sourceId: 'manual-tier-d',
        externalKey: 'a-guided-workflow-with-no-status-yet',
        rawFields: { recordType: 'guided_workflow', deadlineKind: 'unpublished' },
        rawText: 'A non-aggregatable guided workflow with no single national deadline.',
      }),
      ctx({ sourceId: 'manual-tier-d', funderId: 'various', tier: 'D', verificationMethod: 'manual_curation' }),
    );
    expect(status).toBe('unknown');
    expect(status).not.toBe('open');
  });

  it('still lets an explicit rawFields.status override win for both kinds', () => {
    // Reproduces the real shipped manual-tier-d.ts shape: the override, not the recordType
    // fallback, is what actually governs these records today.
    const manual = inferStatus(
      raw({ rawFields: { recordType: 'manual', status: 'no_application', deadlineKind: 'no_application_exists' } }),
      ctx({ sourceId: 'manual-tier-d' }),
    );
    const guided = inferStatus(
      raw({ rawFields: { recordType: 'guided_workflow', status: 'contact_only', deadlineKind: 'unpublished' } }),
      ctx({ sourceId: 'manual-tier-d' }),
    );
    expect(manual).toBe('no_application');
    expect(guided).toBe('contact_only');
  });
});

describe('inferStatus — the Winscott scholarship: text stating inactivity must never yield open', () => {
  // Verbatim RawOpportunity as produced by arrlScholarshipDescriptions.parse() against the real,
  // committed fixture (fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html)
  // — confirmed by running the actual parser. No recordType, no rawFields.status: an ordinary
  // scraped catalog entry, which is exactly why it fell through to 'open' before this fix.
  const winscott = raw({
    externalKey: 'The William C. Winscott, N6CHA, Memorial Scholarship',
    name: 'The William C. Winscott, N6CHA, Memorial Scholarship',
    rawFields: {
      'Field of Study': 'Any',
      'License Requirement': 'Any active Amateur Radio license class',
      Region: 'Any',
      Institution: 'Accredited 4-year college or university',
      'Award Amount': '$2,500',
      'Number of Awards': '1 per year',
      Other:
        "This scholarship is not currently active. First award will be made the year following " +
        "Mr. Winscott's passing and receipt of the William C. Winscott Trust",
    },
    rawText:
      'Award Amount: $2,500\n' +
      'Number of awards: 1 per year\n' +
      'License Requirement: Any active Amateur Radio license class\n' +
      'Region: Any\n' +
      'Field of Study: Any\n' +
      'Institution: Accredited 4-year college or university\n' +
      "Other: This scholarship is not currently active. First award will be made the year " +
      "following Mr. Winscott's passing and receipt of the William C. Winscott Trust",
  });

  it('computes dormant, never open, for the literal "not currently active" text', () => {
    const status = inferStatus(winscott, ctx({ deadlineInheritsFrom: 'arrl-foundation-scholarships' }));
    expect(status).toBe('dormant');
    expect(status).not.toBe('open');
  });

  it.each([
    'This program is no longer offered.',
    'This program is no longer active.',
    'This program is no longer available.',
    'The scholarship is discontinued.',
    'Applications are suspended until further notice.',
    'The program is on hiatus.',
  ])('also catches %j', (sentence) => {
    const status = inferStatus(raw({ rawText: sentence, rawFields: { Other: sentence } }), ctx());
    expect(status).toBe('dormant');
    expect(status).not.toBe('open');
  });
});

describe('inferStatus — the blocklist-warning record (far-farweb-org-compromised)', () => {
  // Reproduces the real manual-tier-d.ts record verbatim (recordType 'safety_warning' plus its
  // researched 'discontinued' override): a compromised-domain warning whose entire purpose is to
  // stop an applicant from visiting farweb.org. Publishing it as 'open' inverts its purpose.
  it('computes discontinued via its real rawFields.status override, never open', () => {
    const status = inferStatus(
      raw({
        sourceId: 'manual-tier-d',
        externalKey: 'far-farweb-org-compromised',
        name: 'Foundation for Amateur Radio (FAR) — domain compromised, do not apply',
        rawFields: { recordType: 'safety_warning', status: 'discontinued' },
        sourceUrl: 'https://www.arrl.org/scholarship-program',
        rawText:
          'SAFETY WARNING. The Foundation for Amateur Radio’s domain no longer belongs to FAR: ' +
          'it now redirects to an Indonesian online-gambling site. Do not visit the domain.',
      }),
      ctx({ sourceId: 'manual-tier-d', funderId: 'various', tier: 'D', verificationMethod: 'manual_curation' }),
    );
    expect(status).toBe('discontinued');
    expect(status).not.toBe('open');
  });

  it('still computes discontinued via the safety_warning fallback with no override present', () => {
    const status = inferStatus(
      raw({
        sourceId: 'manual-tier-d',
        externalKey: 'far-farweb-org-compromised',
        rawFields: { recordType: 'safety_warning' },
      }),
      ctx({ sourceId: 'manual-tier-d' }),
    );
    expect(status).toBe('discontinued');
    expect(status).not.toBe('open');
  });
});

describe('inferStatus — the true positive must still fire', () => {
  it('computes open for a genuinely open programme with a future close date', () => {
    const status = inferStatus(
      raw({
        externalKey: 'A Genuinely Open Scholarship',
        name: 'A Genuinely Open Scholarship',
        rawFields: {
          'Field of Study': 'Any',
          'Award Amount': '$5,000',
          Other: 'Applications open January 1, 2027 and close March 31, 2027.',
        },
        rawText:
          'Award Amount: $5,000\nOther: Applications open January 1, 2027 and close March 31, 2027.',
      }),
      ctx(),
    );
    expect(status).toBe('open');
  });

  it('computes closed for a past-award record whose close date has passed', () => {
    const status = inferStatus(
      raw({
        sourceId: 'arrl-club-grant',
        externalKey: 'past-award:Example Amateur Radio Club:TX',
        name: 'Example Amateur Radio Club (ARRL Club Grant recipient)',
        rawFields: { recordType: 'past_award', recipient: 'Example Amateur Radio Club', state: 'TX', amountRaw: '$5,000' },
        rawText: 'Example Amateur Radio Club, TX — $5,000',
      }),
      ctx({ sourceId: 'arrl-club-grant' }),
    );
    expect(status).toBe('closed');
  });
});

/**
 * ROUND 4 — three source-metadata constants contradicted by the pages themselves, all three found
 * only once real captured fixtures replaced self-authored synthetic ones.
 */

describe('inferInstrument — SARA hands out cash, not kit', () => {
  // fixtures/sara/00-www-radio-astronomy-org-grants.html, the whole programme in one paragraph:
  //   "The Society of Amateur Radio Astronomers provides funds in support of student projects.
  //    The funds will be divided up into several small grants of no more than $200 each or more,
  //    with the approval of the grant committee, to ensure that the money reaches the largest
  //    number of students."
  // Radio JOVE / SuperSID / INSPIRE appear on the page only as example projects an applicant
  // might build with the money — never as the thing SARA hands over. `in_kind_equipment` came
  // from earlier research into those kits and was never true of this page: it tells a club or a
  // teacher to plan around hardware arriving instead of a cheque.
  const saraRaw = raw({
    sourceId: 'sara',
    externalKey: 'sara-student-teacher-grants',
    name: 'SARA Student and Teacher Project Grants',
    rawFields: {
      amount:
        'no more than $200 each or more, with the approval of the grant committee, to ensure ' +
        'that the money reaches the largest number of students.',
      applyNote: 'grants at radio-astronomy.org',
    },
    sourceUrl: 'https://www.radio-astronomy.org/grants',
    rawText: 'The Society of Amateur Radio Astronomers provides funds in support of student projects.',
  });

  it('is a cash instrument', () => {
    const instrument = inferInstrument(saraRaw, ctx({ sourceId: 'sara', funderId: 'sara', tier: 'C' }));
    expect(instrument).toBe('cash_range');
    expect(instrument).not.toBe('in_kind_equipment');
  });

  it('the page states a ceiling with committee discretion above it, so not a flat cash_fixed', () => {
    // "no more than $200 each OR MORE, with the approval of the grant committee" — the amount
    // varies per grant; cash_fixed would publish one flat award the funder never promised.
    const instrument = inferInstrument(saraRaw, ctx({ sourceId: 'sara' }));
    expect(instrument).not.toBe('cash_fixed');
  });

  it('leaves the other pinned instruments alone', () => {
    expect(inferInstrument(raw({ rawFields: {} }), ctx({ sourceId: 'yaesu-dr2x' }))).toBe(
      'discounted_purchase',
    );
    expect(inferInstrument(raw({ rawFields: {} }), ctx({ sourceId: 'arrl-etp-grants' }))).toBe(
      'in_kind_equipment',
    );
    expect(inferInstrument(raw({ rawFields: {} }), ctx({ sourceId: 'ncdxf-scholarships' }))).toBe(
      'tuition_coverage',
    );
    expect(inferInstrument(raw({ rawFields: {} }), ctx({ sourceId: 'ariss' }))).toBe(
      'in_kind_service',
    );
  });
});

describe('inferDeadline — YLRL publishes no dates at all', () => {
  // fixtures/ylrl/00-ylrl-net-scholarships.html contains no month, no day and no window: the
  // page says what the scholarships are and points at ylrl.net/apply/, nothing more (asserted
  // against the captured page in sources/tier-c-a.test.ts). `annual_window` asserted a shape
  // nobody has stated, and `expandCycles` would have had a kind with no directive to project.
  const ylrlRaw = raw({
    sourceId: 'ylrl',
    externalKey: 'ylrl-ethel-smith-k4lmb',
    name: 'Ethel Smith K4LMB Memorial Scholarship',
    rawFields: { amount: '$1,000' },
    sourceUrl: 'https://ylrl.net/scholarships/',
    rawText: 'The Ethel Smith K4LMB Memorial Scholarship is awarded to a licensed YL.',
  });
  const ylrlCtx = ctx({ sourceId: 'ylrl', funderId: 'ylrl', tier: 'C' });

  it('emits unpublished rather than an invented annual window', () => {
    const spec = inferDeadline(ylrlRaw, ylrlCtx);
    expect(spec.kind).toBe('unpublished');
    expect(spec.kind).not.toBe('annual_window');
  });

  it('says so in the note instead of describing a window', () => {
    expect(inferDeadline(ylrlRaw, ylrlCtx).note).toMatch(/never published a deadline/i);
    expect(inferDeadline(ylrlRaw, ylrlCtx).note).not.toMatch(/RECUR/);
  });

  it('never computes open for it: no dates means no assertable live cycle', () => {
    const status = inferStatus(ylrlRaw, ylrlCtx);
    expect(status).toBe('unknown');
    expect(status).not.toBe('open');
  });
});

describe('inferStatus — inactivity wording about a RETIRED PREDECESSOR is not about this program', () => {
  // Verbatim RawOpportunity as produced by the tier C-B parser against the real captured page
  // fixtures/ncdxf-scholarships/00-www-ncdxf-org-pages-scholarships-html.html. The live W6EEN
  // scholarship (full tuition at DX University / Contest University for hams 25 and under) is
  // described in the body; the ONLY inactivity wording anywhere on the page is the heading of a
  // recipients table for a DIFFERENT, superseded programme. Reading it as this programme's own
  // status marked a live scholarship dormant — a false exclude, the direction that hides an award
  // permanently with no signal to anyone.
  const ncdxf = raw({
    sourceId: 'ncdxf-scholarships',
    externalKey: 'ncdxf-w6een-scholarship',
    name: 'NCDXF W6EEN Memorial Scholarship',
    rawFields: {
      summary:
        'NCDXF will provide full tuition scholarships for hams 25 years of age and younger at ' +
        'all DX University and Contest University sessions held in North America for the next year.',
      retiredPredecessor: 'Previous ARRL Foundation Scholarship Program (No Longer Active)',
    },
    sourceUrl: 'https://www.ncdxf.org/pages/scholarships.html',
    rawText:
      'W6EEN Memorial NCDXF Scholarship Fund\n' +
      'Beginning April 22, 2013, NCDXF has decided to use these funds in a new way. Starting ' +
      'April 22, 2013, NCDXF will provide full tuition scholarships for hams 25 years of age and ' +
      'younger at all DX University and Contest University sessions held in North America for ' +
      'the next year. There is no restriction as to class of license.\n' +
      'If you are a licensed amateur radio operator 25 years of age or younger, you can apply ' +
      'for a free tuition scholarship by contacting the appropriate University directly:\n' +
      'Previous ARRL Foundation Scholarship Program (No Longer Active)\n' +
      'Year\nRecipient\n2012\nAlexander Scullin, KI6LXD\n1998\nElizabeth Pelczar, KA1SLD',
  });

  it('does not mark the live scholarship dormant off the predecessor table heading', () => {
    const status = inferStatus(ncdxf, ctx({ sourceId: 'ncdxf-scholarships', funderId: 'ncdxf', tier: 'C' }));
    expect(status).not.toBe('dormant');
  });

  it('computes unknown, because NCDXF publishes no dates for it either', () => {
    expect(inferStatus(ncdxf, ctx({ sourceId: 'ncdxf-scholarships' }))).toBe('unknown');
  });

  it('the Winscott case still computes dormant — the check is scoped, not weakened', () => {
    // Same fix, opposite direction: this sentence IS about the programme being extracted.
    const status = inferStatus(
      raw({
        rawFields: { Other: 'This scholarship is not currently active.' },
        rawText: 'Other: This scholarship is not currently active.',
      }),
      ctx(),
    );
    expect(status).toBe('dormant');
  });

  it.each([
    ['Previous ARRL Foundation Scholarship Program (No Longer Active)', 'a predecessor heading'],
    ['Our previous scholarship program is no longer offered.', 'a predecessor sentence'],
    ['Past grant program (discontinued)', 'a past grant table heading'],
  ])('ignores %j (%s)', (line) => {
    const status = inferStatus(
      raw({ rawText: `This award is open to licensed amateurs.\n${line}\nApply at example.test.` }),
      ctx(),
    );
    expect(status).not.toBe('dormant');
  });

  it.each([
    'This scholarship is not currently active.',
    'This program is no longer offered.',
    'The scholarship is discontinued.',
  ])('still fires on %j when the sentence is about this programme', (sentence) => {
    expect(inferStatus(raw({ rawText: sentence }), ctx())).toBe('dormant');
  });
});
