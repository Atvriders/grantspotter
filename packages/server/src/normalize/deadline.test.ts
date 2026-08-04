import type { Program, RawOpportunity, SourceModule } from '@grantspotter/core';
import { OBSERVED_WINDOW_MARKER, expandCycles, observedCycles, parseRecurrence } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { cycleHorizonEndISO } from '../review/index.js';
import { austinArc } from '../sources/tier-c-a.js';
import { ariss, ieeeMtts, ieeeStudentBranchRebate } from '../sources/tier-c-b.js';
import { yaesuDr2x } from '../sources/yaesu-dr2x.js';
import { SOURCES } from '../sources/registry.js';
import { programIdFor } from '../sources/util/ids.js';
import { normalizeRaw } from './index.js';
import {
  DEADLINE_INHERITANCE,
  DEADLINE_OWNER_EXTERNAL_KEY,
  RECURRENCE_BY_SOURCE,
  deadlineOwnerKey,
  deadlineOwnerProgramId,
  inferDeadline,
  inferInstrument,
  inferStatus,
  observedWindow,
  parseObservedDate,
} from './deadline.js';
import type { NormalizeContext } from './index.js';

const NOW = '2026-08-02T00:00:00.000Z';

const ctx = (over: Partial<NormalizeContext> = {}): NormalizeContext => ({
  sourceId: 'arrl-scholarship-descriptions',
  funderId: 'arrl-foundation',
  klass: 'ham_scholarship',
  tier: 'C',
  nowISO: NOW,
  verificationMethod: 'live_fetch',
  // The REAL minting function, not a stub. Every inheritance assertion below resolves the owner's
  // id through this seam exactly as production does; a stub would let the tests agree with each
  // other while disagreeing with the product, which is the shape of the defect being remediated.
  mintId: programIdFor,
  ...over,
});

/**
 * The owner's SOURCE id, read out of the table rather than typed as a literal. The dangling-owner
 * defect survived 37 commits because every test of this path hand-wrote the identifier it was
 * supposed to resolve; no test in this file names one.
 */
const ARRL_OWNER = DEADLINE_INHERITANCE['arrl-scholarship-descriptions'];

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
    const status = inferStatus(winscott, ctx({ deadlineInheritsFrom: ARRL_OWNER }));
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

/* ============================================================================================
 * OBSERVED DATES — the remediation of write-only-field bug #2 (rawFieldsContract.test.ts).
 *
 * `opensAt`, `closesAt`, `openDate`, `closeDate` and `responseDate` were parsed off real funder
 * pages by three source modules and read by NOTHING: this file contained not one reference to
 * any of them, so every date the product showed came out of DEADLINE_INHERITANCE, a RECUR
 * directive or KIND_BY_SOURCE — tables we wrote — never from what the funder printed.
 * ========================================================================================== */

describe('parseObservedDate — strict, and rejects rather than coerces', () => {
  it.each([
    ['2026-09-30', '2026-09-30', 'ISO day, as ARISS / Yaesu / the daily extract emit it'],
    ['09/09/2026', '2026-09-09', 'MM/DD/YYYY, as Grants.gov search2 emits closeDate'],
    ['7/4/2026', '2026-07-04', 'single-digit MM/DD/YYYY'],
    ['Sep 09, 2026 12:00:00 AM EDT', '2026-09-09', 'the long form Grants.gov uses for responseDate'],
    ['Nov 14, 2026', '2026-11-14', 'the short long-form, with no time'],
    ['September 30, 2026', '2026-09-30', 'a spelled-out month'],
    ['2028-02-29', '2028-02-29', 'Feb 29 in a real leap year'],
  ])('reads %j as %j (%s)', (input, expected) => {
    expect(parseObservedDate(input)).toBe(expected);
  });

  it.each([
    ['', 'blank'],
    ['   ', 'whitespace'],
    ['TBD', 'prose, not a date'],
    ['2026-02-30', 'February has no 30th in any year'],
    ['2027-02-29', 'February 29 in a NON-leap year'],
    ['2026-13-01', 'month 13'],
    ['2026-00-10', 'month 0'],
    ['13/01/2026', 'a day-first date in a MM/DD/YYYY field'],
    ['1899-01-01', 'a year no funder is publishing a deadline in'],
    ['2999-01-01', 'the same, forward'],
    ['Smarch 9, 2026', 'not a month'],
    ['2026-09', 'month granularity is not day granularity'],
    ['09-09-2026', 'an unrecognised separator order'],
  ])('rejects %j (%s) rather than coercing it into a plausible deadline', (input) => {
    expect(parseObservedDate(input)).toBeUndefined();
  });

  it('rejects undefined without throwing', () => {
    expect(parseObservedDate(undefined)).toBeUndefined();
  });
});

describe('observedWindow — which rawFields it reads, and when it refuses', () => {
  const withFields = (rawFields: Record<string, string>): RawOpportunity => raw({ rawFields });

  it('reads the tier-c-b / yaesu pair', () => {
    expect(observedWindow(withFields({ opensAt: '2026-07-01', closesAt: '2026-09-30' }))).toEqual({
      opensAt: '2026-07-01',
      closesAt: '2026-09-30',
    });
  });

  it('reads the federal pair', () => {
    expect(observedWindow(withFields({ openDate: '07/14/2026', closeDate: '09/09/2026' }))).toEqual({
      opensAt: '2026-07-14',
      closesAt: '2026-09-09',
    });
  });

  it('falls back to responseDate only when there is no closeDate', () => {
    expect(
      observedWindow(withFields({ responseDate: 'Sep 09, 2026 12:00:00 AM EDT' })),
    ).toEqual({ closesAt: '2026-09-09' });
    // closeDate wins when both are present: it is the machine field on BOTH federal legs.
    expect(
      observedWindow(
        withFields({ closeDate: '09/09/2026', responseDate: 'Dec 31, 2026 12:00:00 AM EST' }),
      ),
    ).toEqual({ closesAt: '2026-09-09' });
  });

  it('keeps a close-only window (Yaesu publishes no opening date at all)', () => {
    expect(observedWindow(withFields({ closesAt: '2026-08-31' }))).toEqual({ closesAt: '2026-08-31' });
  });

  it('never reads postDate as an opening date', () => {
    // Grants.gov's postDate is when the ROW was posted, not when the funder opens its window.
    expect(observedWindow(withFields({ postDate: '2026-02-01', closeDate: '05/01/2026' }))).toEqual({
      closesAt: '2026-05-01',
    });
  });

  it('rejects the whole window when the close precedes the open', () => {
    // Both halves come out of one parsed sentence; if they contradict each other, neither is
    // trustworthy, and keeping the close alone would let a mis-parse decide open vs closed.
    expect(observedWindow(withFields({ opensAt: '2026-09-30', closesAt: '2026-07-01' }))).toBeUndefined();
  });

  it('is undefined when the source published no date at all', () => {
    expect(observedWindow(withFields({ 'Award Amount': '$5,000' }))).toBeUndefined();
  });
});

describe('inferDeadline — ARISS: the dates come from the REAL captured page, not from a table', () => {
  // The whole point of this remediation, driven end to end: parse the committed capture with the
  // production parser, then normalize it, and read the dates back out of the DeadlineSpec.
  // fixtures/ariss/00-ariss-usa-org-proposal-overview.html line 243:
  //   "Proposal window opened July 1 and closes on September 30 for contacts to be held from
  //    January to June 2027."  — no year on either end; the capture year supplies it.
  const arissRaw = ariss.parse([
    fixturePayload('ariss', '00-ariss-usa-org-proposal-overview.html', 'https://ariss-usa.org/proposal-overview/'),
  ])[0];
  const arissCtx = ctx({ sourceId: 'ariss', funderId: 'ariss-usa', klass: 'equipment_in_kind' });

  it('parsed the real window off the page in the first place', () => {
    expect(arissRaw.rawFields.opensAt).toBe('2026-07-01');
    expect(arissRaw.rawFields.closesAt).toBe('2026-09-30');
  });

  it('publishes both of the funder’s own dates in the DeadlineSpec', () => {
    const spec = inferDeadline(arissRaw, arissCtx);
    expect(spec.note).toContain('2026-07-01');
    expect(spec.note).toContain('2026-09-30');
  });

  it('is not merely the per-source table sentence any more', () => {
    // The regression: before this fix the note was exactly this and nothing else, for every
    // ARISS record, forever — which also meant `diffPrograms` could never see the window move.
    expect(inferDeadline(arissRaw, arissCtx).note).not.toBe(
      'One window sentence rewritten quarterly at a stable URL.',
    );
  });

  it('keeps the funder-stated SHAPE: four windows a year, rewritten quarterly', () => {
    // A concrete observed window does not turn ARISS into an annual programme. Nothing here may
    // become projectable, or `expandCycles` would publish a 2027 ARISS deadline ARISS has never
    // announced.
    const spec = inferDeadline(arissRaw, arissCtx);
    expect(spec.kind).toBe('quarterly_rewritten');
    expect(parseRecurrence(spec.note).kind).toBe('none');
  });

  it('the window is still open on the capture date, so the status stays open', () => {
    expect(inferStatus(arissRaw, arissCtx)).toBe('open');
  });
});

describe('inferDeadline — Yaesu publishes only a close date, and only that is published', () => {
  const yaesuRaw = yaesuDr2x.parse([
    fixturePayload('yaesu-dr2x', '00-systemfusion-yaesu-com.html', 'https://systemfusion.yaesu.com/dr-2x-repeater-program/'),
  ])[0];
  const yaesuCtx = ctx({ sourceId: 'yaesu-dr2x', funderId: 'yaesu-usa', klass: 'equipment_in_kind' });

  it('states the real close date from the page prose ("…once again through August 31st, 2026")', () => {
    expect(yaesuRaw.rawFields.closesAt).toBe('2026-08-31');
    expect(inferDeadline(yaesuRaw, yaesuCtx).note).toContain('2026-08-31');
  });

  it('invents no opening date to go with it', () => {
    expect(yaesuRaw.rawFields.opensAt).toBeUndefined();
    expect(inferDeadline(yaesuRaw, yaesuCtx).note).not.toMatch(/opens \d{4}-/);
  });
});

describe('inferDeadline — a kind that ASSERTS no date cannot survive the funder publishing one', () => {
  const federalCtx = ctx({ sourceId: 'grants-gov-federal', funderId: 'federal', klass: 'adjacent_stem', tier: 'A' });
  const pwscif = raw({
    sourceId: 'grants-gov-federal',
    externalKey: '363179',
    name: 'Public Wireless Supply Chain Innovation Fund Grant Program – Solutions for AI-Native RAN',
    rawFields: { openDate: '07/14/2026', closeDate: '09/09/2026', oppStatus: 'posted' },
  });

  it('promotes unpublished to ad_hoc — a federal NOFO with a window is not "no deadline exists"', () => {
    const spec = inferDeadline(pwscif, federalCtx);
    expect(spec.kind).toBe('ad_hoc');
    expect(spec.note).not.toMatch(/never published a deadline/i);
    expect(spec.note).toContain('2026-07-14');
    expect(spec.note).toContain('2026-09-09');
  });

  it('promotes rolling the same way, and only when a date really was published', () => {
    const rollingCtx = ctx({ sourceId: 'sara', funderId: 'sara', klass: 'equipment_in_kind' });
    expect(inferDeadline(raw({ rawFields: {} }), rollingCtx).kind).toBe('rolling');
    expect(inferDeadline(raw({ rawFields: { closesAt: '2027-03-01' } }), rollingCtx).kind).toBe('ad_hoc');
  });

  it('leaves ad_hoc alone: nothing is promoted twice', () => {
    expect(
      inferDeadline(raw({ rawFields: { closesAt: '2026-08-31' } }), ctx({ sourceId: 'yaesu-dr2x' })).kind,
    ).toBe('ad_hoc');
  });

  it('never touches no_application_exists — there is no application to have a deadline', () => {
    // YASME and HamSCI select recipients themselves. A stray date field on such a record is not
    // an application deadline and must not be published as one.
    const spec = inferDeadline(
      raw({
        sourceId: 'manual-tier-d',
        rawFields: { deadlineKind: 'no_application_exists', closesAt: '2026-01-01' },
      }),
      ctx({ sourceId: 'manual-tier-d', tier: 'D' }),
    );
    expect(spec.kind).toBe('no_application_exists');
    expect(spec.note).not.toContain('2026-01-01');
  });
});

describe('inferDeadline — the RECUR calendar survives an observed window untouched', () => {
  // 112 of 181 candidates ride the arrl-scholarship-program cycle, which `expandCycles` projects
  // out of the RECUR directive in `note`. `parseRecurrence` reads only as far as the first ` | `,
  // so appending observed dates to the prose half must leave the projection bit-for-bit identical.
  const scholarshipCtx = ctx({ sourceId: 'arrl-scholarship-program', deadlineInheritsFrom: undefined });

  it('still emits a directive that parses to the same annual window', () => {
    const withDates = inferDeadline(
      raw({ rawFields: { opensAt: '2026-10-30', closesAt: '2026-12-30' } }),
      scholarshipCtx,
    );
    expect(withDates.note.startsWith('RECUR ')).toBe(true);
    expect(parseRecurrence(withDates.note)).toMatchObject({
      kind: 'annual_window',
      timezone: 'America/New_York',
      window: { open: { month: 10, day: 30 }, close: { month: 12, day: 30 } },
      closeTime: { hour: 12, minute: 0 },
    });
  });

  it('parses identically with and without the appended observed window', () => {
    const bare = inferDeadline(raw({ rawFields: {} }), scholarshipCtx);
    const withDates = inferDeadline(
      raw({ rawFields: { opensAt: '2026-10-30', closesAt: '2026-12-30' } }),
      scholarshipCtx,
    );
    expect(parseRecurrence(withDates.note)).toEqual(parseRecurrence(bare.note));
    expect(withDates.kind).toBe(bare.kind);
    expect(withDates.note).toContain('2026-12-30');
  });
});

describe('inferDeadline — precedence between an observed date and inheritance', () => {
  it('keeps all 112 ARRL-catalog entries inheriting: none of them parses a date of its own', () => {
    const c = ctx({ deadlineInheritsFrom: ARRL_OWNER });
    const spec = inferDeadline(raw(), c);
    expect(spec.kind).toBe('inherited');
    // The owner id is DERIVED from the owner's stable source key, never written down here.
    expect(spec.source).toEqual({
      kind: 'inherited',
      fromProgramId: deadlineOwnerProgramId(ARRL_OWNER, c),
    });
  });

  it('lets a record that DID parse its own window own its deadline instead of riding another’s', () => {
    // The stated precedence rule: a date on the funder's own page outranks another programme's
    // projected cycle. Unreachable on today's corpus (no inheriting source parses dates), which
    // is exactly why it is pinned here rather than left true by accident.
    const spec = inferDeadline(
      raw({ rawFields: { opensAt: '2027-01-05', closesAt: '2027-02-05' } }),
      ctx({ deadlineInheritsFrom: ARRL_OWNER }),
    );
    expect(spec.source).toEqual({ kind: 'self' });
    expect(spec.note).toContain('2027-01-05');
    expect(spec.note).toContain('2027-02-05');
  });

  it('a window rejected as nonsensical falls straight back to inheritance', () => {
    const spec = inferDeadline(
      raw({ rawFields: { opensAt: '2027-02-05', closesAt: '2027-01-05' } }),
      ctx({ deadlineInheritsFrom: ARRL_OWNER }),
    );
    expect(spec.kind).toBe('inherited');
  });
});

describe('inferStatus — only the CLOSED direction is asserted from an observed window', () => {
  const federalCtx = ctx({ sourceId: 'grants-gov-extract', funderId: 'federal', klass: 'adjacent_stem', tier: 'A' });

  it('computes closed when the funder’s own close date has passed', () => {
    // The real regression this fixes: grants-gov-extract row 354777, the NTIA PWSCIF entry in the
    // committed daily extract, carries closeDate 2026-05-01 and oppStatus "posted", and published
    // as `open` three months after it shut.
    const status = inferStatus(
      raw({ sourceId: 'grants-gov-extract', externalKey: '354777', rawFields: { closeDate: '2026-05-01', oppStatus: 'posted' } }),
      federalCtx,
    );
    expect(status).toBe('closed');
    expect(status).not.toBe('open');
  });

  it('leaves a still-open window open', () => {
    expect(
      inferStatus(raw({ rawFields: { closeDate: '2026-11-14' } }), federalCtx),
    ).toBe('open');
  });

  it('treats the close DAY as open all day, in the most permissive zone', () => {
    // A day-precision deadline must not expire early anywhere on earth.
    expect(inferStatus(raw({ rawFields: { closesAt: '2026-08-02' } }), federalCtx)).toBe('open');
    expect(inferStatus(raw({ rawFields: { closesAt: '2026-08-01' } }), federalCtx)).toBe('closed');
  });

  it('does not downgrade a programme whose window has not opened yet', () => {
    // A future opening is still a live opportunity to prepare for; there is no honest
    // ProgramStatus for "forecast", and 'unknown' would hide a real call.
    expect(
      inferStatus(raw({ rawFields: { openDate: '01/05/2027', closeDate: '03/05/2027' } }), federalCtx),
    ).toBe('open');
  });

  it('never asserts closed off an unreadable date', () => {
    expect(inferStatus(raw({ rawFields: { closeDate: 'TBD' } }), federalCtx)).toBe('open');
    expect(inferStatus(raw({ rawFields: { closeDate: '2026-02-30' } }), federalCtx)).toBe('open');
  });

  it('cannot displace any verdict the rules above it already reached', () => {
    const past = { closesAt: '2020-01-01' };
    // A researched override still wins.
    expect(inferStatus(raw({ rawFields: { ...past, status: 'contact_only' } }), federalCtx)).toBe('contact_only');
    // So does the funder's own inactivity wording...
    expect(
      inferStatus(raw({ rawFields: past, rawText: 'This scholarship is not currently active.' }), ctx()),
    ).toBe('dormant');
    // ...and an explicitly-unpublished source stays unknown rather than becoming closed.
    expect(
      inferStatus(raw({ sourceId: 'ylrl', rawFields: past }), ctx({ sourceId: 'ylrl' })),
    ).toBe('unknown');
  });
});

describe('the behaviours this change had to leave alone', () => {
  it('the ARRL scholarship cycle stays CLOSED — its page says the 2026 cycle is closed', () => {
    // arrl-pages.ts represents the closed cycle as rawFields.status and deliberately fabricates
    // no dates for it. Inheriting a closed cycle is correct; nothing here may turn it open.
    const arrlCtx = ctx({ sourceId: 'arrl-scholarship-program', deadlineInheritsFrom: undefined });
    const closedCycle = raw({
      sourceId: 'arrl-scholarship-program',
      externalKey: 'scholarship-program',
      rawFields: { status: 'closed', window: 'The 2026 Scholarship Cycle is now closed.' },
      rawText: 'The 2026 Scholarship Cycle is now closed.',
    });
    expect(inferStatus(closedCycle, arrlCtx)).toBe('closed');
    // ...and an entry inheriting from it is still inherited, not re-dated.
    expect(inferDeadline(raw(), ctx({ deadlineInheritsFrom: ARRL_OWNER })).kind).toBe(
      'inherited',
    );
  });

  it('Winscott stays dormant, YLRL stays unknown, NCDXF W6EEN stays unknown', () => {
    expect(
      inferStatus(
        raw({ rawFields: { Other: 'This scholarship is not currently active.' }, rawText: 'Other: This scholarship is not currently active.' }),
        ctx({ deadlineInheritsFrom: ARRL_OWNER }),
      ),
    ).toBe('dormant');
    expect(inferStatus(raw({ sourceId: 'ylrl', rawFields: {} }), ctx({ sourceId: 'ylrl' }))).toBe('unknown');
    const w6een = inferStatus(
      raw({
        sourceId: 'ncdxf-scholarships',
        rawFields: { retiredPredecessor: 'Previous ARRL Foundation Scholarship Program (No Longer Active)' },
        rawText:
          'NCDXF will provide full tuition scholarships for hams 25 years of age and younger.\n' +
          'Previous ARRL Foundation Scholarship Program (No Longer Active)',
      }),
      ctx({ sourceId: 'ncdxf-scholarships' }),
    );
    expect(w6een).toBe('unknown');
    expect(w6een).not.toBe('dormant');
  });
});

/* ============================================================================================
 * REMEDIATION (2026-08-03) — the dangling deadline owner, and the status that never rode with it.
 *
 * Two defects, one root cause: a record inheriting one property from an owner while silently
 * defaulting another. `DEADLINE_INHERITANCE` named a program id no program has ever carried, so
 * 112 records pointed at nothing; and nothing carried the owner's STATE across the same hop, so
 * 110 ARRL scholarships badged `open` while the portal they ride says the 2026 cycle is closed.
 *
 * Both hid behind tests that hand-wrote the very identifier the product was supposed to resolve.
 * Nothing below writes one down.
 * ============================================================================================ */

describe('the inheritance reference resolves through something STABLE', () => {
  it('names an owning SOURCE, never a program id — a literal cannot name a derived id', () => {
    const registered = new Set(SOURCES.map((m) => m.id));
    for (const [dependent, owner] of Object.entries(DEADLINE_INHERITANCE)) {
      expect(registered.has(dependent), `${dependent} is not a registered source`).toBe(true);
      expect(registered.has(owner), `${owner} is not a registered source`).toBe(true);
      // Every program id carries the `--<slug>--<hash>` shape `programIdFor` mints. A value here
      // that looked like one would be the original defect walking back in.
      expect(owner).not.toContain('--');
    }
  });

  it('describes which record of the owning source owns the cycle — the two tables cannot desync', () => {
    for (const owner of Object.values(DEADLINE_INHERITANCE)) {
      const key = deadlineOwnerKey(owner);
      expect(key, `no DEADLINE_OWNER_EXTERNAL_KEY entry for "${owner}"`).toBeDefined();
      expect(key?.sourceId).toBe(owner);
      expect(DEADLINE_OWNER_EXTERNAL_KEY[owner]).toBe(key?.externalKey);
    }
  });

  it('derives the owner id the same way the OWNER derives its own — that is the whole fix', () => {
    // normalize/index.ts computes a record's own id as
    //   ctx.existingIdFor?.(sourceId, externalKey) ?? ctx.mintId(sourceId, externalKey)
    // and this must be the identical computation over the identical key, or the two sides name
    // two different programs and the reference dangles exactly as it used to.
    const key = deadlineOwnerKey(ARRL_OWNER);
    expect(key).toBeDefined();
    expect(deadlineOwnerProgramId(ARRL_OWNER, ctx())).toBe(
      programIdFor(key!.sourceId, key!.externalKey),
    );
  });

  it('prefers the id the owner was actually STORED under, when the corpus already holds it', () => {
    // A seeded corpus can hold the owner under an id minted before its source key existed.
    // `existingIdFor` is the reconciliation seam, and inheritance must follow it rather than
    // insisting on the id it would have minted.
    const stored = 'some-previously-seeded-owner-id';
    const c = ctx({
      deadlineInheritsFrom: ARRL_OWNER,
      existingIdFor: (sourceId, externalKey) =>
        sourceId === ARRL_OWNER && externalKey === DEADLINE_OWNER_EXTERNAL_KEY[ARRL_OWNER]
          ? stored
          : undefined,
    });
    expect(inferDeadline(raw(), c).source).toEqual({ kind: 'inherited', fromProgramId: stored });
  });

  it('emits no inheritance at all for an owner nobody has described, rather than a dangling id', () => {
    const spec = inferDeadline(raw(), ctx({ deadlineInheritsFrom: 'a-source-with-no-owner-record' }));
    expect(spec.source).toEqual({ kind: 'self' });
    expect(spec.kind).not.toBe('inherited');
  });
});

describe('inferStatus — a record that rides another cycle never claims to be open', () => {
  it('computes unknown, not open, for an ordinary inheriting catalog entry', () => {
    // THE DEFECT: 110 of 111 ARRL scholarships reached `open` through the terminal default while
    // the portal page they ride says the 2026 cycle is closed. normalize/ cannot see the owner
    // (spec §14), so `unknown` is what this file actually knows; crawl/runner.ts resolves it to
    // the owner's real status. `open` was a claim nothing here could support.
    const status = inferStatus(raw(), ctx({ deadlineInheritsFrom: ARRL_OWNER }));
    expect(status).toBe('unknown');
    expect(status).not.toBe('open');
  });

  it('still lets a record with no owner default to open — ordinary opportunities do not regress', () => {
    expect(inferStatus(raw({ sourceId: 'ncdxf-grants' }), ctx({ sourceId: 'ncdxf-grants' }))).toBe('open');
  });

  it('lets the record’s OWN evidence outrank its owner: Winscott stays dormant', () => {
    expect(
      inferStatus(
        raw({ rawText: 'Other: This scholarship is not currently active.' }),
        ctx({ deadlineInheritsFrom: ARRL_OWNER }),
      ),
    ).toBe('dormant');
  });
});

describe('inferStatus — a window kind must earn "open" against the stated schedule', () => {
  it('computes closed when today falls outside every window the funder stated', () => {
    // arrl-amateur-radio-grants states Feb 1-28, Jun 1-30 and Oct 1-31. NOW is August 2: the June
    // window shut five weeks ago and October has not opened. It published as `open`.
    const status = inferStatus(
      raw({ sourceId: 'arrl-amateur-radio-grants', rawFields: {} }),
      ctx({ sourceId: 'arrl-amateur-radio-grants' }),
    );
    expect(status).toBe('closed');
    expect(status).not.toBe('open');
  });

  it('computes open inside a stated window', () => {
    const inside = ctx({ sourceId: 'arrl-amateur-radio-grants', nowISO: '2026-06-15T12:00:00.000Z' });
    expect(inferStatus(raw({ sourceId: 'arrl-amateur-radio-grants', rawFields: {} }), inside)).toBe('open');
  });

  it('computes unknown when the kind promises a window and nobody ever stated one', () => {
    // GATE 2, and what is left in it. This used to name four sources; three of them now state
    // their annual rule in RECURRENCE_BY_SOURCE and are resolved by GATE 3 in the test below.
    // `arrl-etp-grants` is the one that stays here, and deliberately so: its page prints a DATED
    // window ("OCTOBER 1ST AND OCTOBER 31ST of 2025"), so it resolves through the OBSERVED
    // channel on a real record and gets no RECUR directive at all. Strip that observed window —
    // which `rawFields: {}` does — and there is genuinely no schedule left to ask. `unknown` is
    // honest; `open` was a guess, and NO DATE IS INVENTED to fill the gap.
    const status = inferStatus(
      raw({ sourceId: 'arrl-etp-grants', rawFields: {} }),
      ctx({ sourceId: 'arrl-etp-grants' }),
    );
    expect(status).toBe('unknown');
    expect(status).not.toBe('open');
  });

  /**
   * THE THREE YEARLESS RULES, resolved by their RECUR directive and by nothing else — and the two
   * SHAPES those rules come in, which is the whole finding of this round.
   *
   * Each of these three pages states a rule in prose and prints no year anywhere on itself, so
   * `sources/util/proseWindow.ts` reads the month-days and refuses to date them, and the record
   * publishes no `opensAt`/`closesAt` at all — `rawFields: {}` here is the true shape of these
   * records, not a convenience. What resolves them is the year-free directive, which is exactly
   * the case a recurrence exists for.
   *
   * The verdicts differ because the PAGES differ, and that is the point:
   *
   *   - Austin ARC prints both ends — "Applications open May 1 and close July 31 each year" — so
   *     it is a genuine `annual_window`, and `closed` on 2026-08-02 is a plain fact: the window
   *     shut on July 31, three days before this corpus was captured.
   *   - Neither IEEE page prints an opening at all. "must be received by October 1" and "due 15
   *     March" are DEADLINES, and both pages say a late request rolls into the following year —
   *     ARDC's claim exactly. As one-day `annual_window`s they read `closed` on 364 days of the
   *     year, a false exclude of a live programme; as `n_fixed_dates` they read `open`, which is
   *     what a funder who takes requests continuously and cuts off on a date actually offers.
   */
  it('resolves the three yearless rules from their RECUR directive alone', () => {
    const statusOf = (sourceId: string): string =>
      inferStatus(raw({ sourceId, rawFields: {} }), ctx({ sourceId }));

    // A stated window, and today is outside it.
    expect(statusOf('austin-arc')).toBe('closed');
    expect(statusOf('austin-arc')).not.toBe('unknown');

    // A stated deadline, which excludes nobody today.
    for (const sourceId of ['ieee-mtts', 'ieee-student-branch-rebate']) {
      expect(statusOf(sourceId), sourceId).toBe('open');
      expect(statusOf(sourceId), sourceId).not.toBe('unknown');
      expect(statusOf(sourceId), sourceId).not.toBe('closed');
    }
  });

  /**
   * ...AND THE DIRECTIVES ARE READ AGAINST THE PAGES, not trusted because they are written down.
   *
   * `RECURRENCE_BY_SOURCE` is a table WE wrote, and `expandCycles` projects a calendar out of it
   * under the funder's name, so the month-days in it have to be the month-days the funder's own
   * sentence states. `sources/util/proseWindow.ts` is what reads those sentences off the real
   * captures (asserted there and in each source's `(REAL fixture)` block); this pins the table to
   * the same values, so a typo in either one turns red instead of shipping a deadline nobody
   * published.
   *
   * THE KIND IS PINNED TOO, and separately from the month-days. `n_fixed_dates` versus
   * `annual_window` is the difference between "cuts off on this date" and "you may not apply
   * outside this interval" — a claim about how the funder operates, which only its page can
   * settle. A directive silently changing shape is how the one-day-window false exclude got in.
   */
  it('pins each directive to the month-days AND the shape its funder actually prints', () => {
    const md = (d: { month: number; day: number }): string =>
      `${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;

    // BOTH ENDS STATED -> a window. "Applications open May 1 and close July 31 each year."
    const austin = parseRecurrence(RECURRENCE_BY_SOURCE['austin-arc']);
    if (austin.kind !== 'annual_window') throw new Error('austin-arc is not an annual_window');
    expect(`${md(austin.window.open)}..${md(austin.window.close)}`).toBe('05-01..07-31');

    // ONE DATE, NO OPENING STATED -> a deadline. Asserted as `dates`, so an opening date cannot be
    // reintroduced without this line turning red.
    const datesOf = (sourceId: string): string[] => {
      const parsed = parseRecurrence(RECURRENCE_BY_SOURCE[sourceId]);
      if (parsed.kind !== 'n_fixed_dates') throw new Error(`${sourceId} is not n_fixed_dates`);
      return parsed.dates.map(md);
    };
    // "All requests for MTT chapter funding must be received by October 1 or the chapter may be
    //  asked to make its application in the following year."
    expect(datesOf('ieee-mtts')).toEqual(['10-01']);
    // "Student Branch Annual Plans are due 15 March."
    expect(datesOf('ieee-student-branch-rebate')).toEqual(['03-15']);

    // And no directive smuggles a year in: the whole reason a rule lives here is that it carries
    // none. `arrl-etp-grants` — whose window IS dated — must have no entry at all.
    for (const directive of Object.values(RECURRENCE_BY_SOURCE)) {
      expect(directive.split('|')[0]).not.toMatch(/\b(?:19|20)\d{2}\b/);
    }
    expect(RECURRENCE_BY_SOURCE['arrl-etp-grants']).toBeUndefined();
  });

  /**
   * FIXED (2026-08-04). The human prose half of this directive (after the first ` | `, which
   * `parseRecurrence` never reads) used to state "at 12:00 PM Eastern" and "Moved from Jan 31" —
   * neither is confirmed by any captured ARRL page (`12:00`, `noon`, `eastern` as a timezone, and
   * `january 31`/`jan 31` all appear zero times across `fixtures/arrl-scholarship-program/`,
   * `fixtures/arrl-scholarship-descriptions/` and `fixtures/arrl-summary-of-scholarship-
   * requirements/`). This string reaches `Opportunity.tsx`'s `deadline.note` dd directly, so it
   * is asserted here rather than left to a comment. The `RECUR` directive itself is untouched —
   * `close=12:00` still drives calendar projection, pinned by the test above.
   */
  it('states no ARRL scholarship close time or "moved from" claim the captures do not carry', () => {
    const prose = RECURRENCE_BY_SOURCE['arrl-scholarship-program'].split('|')[1];
    expect(prose).not.toMatch(/12:00|\bnoon\b|eastern|\bEST\b/i);
    expect(prose).not.toMatch(/january 31|jan 31|moved from/i);
    expect(prose).toMatch(/Oct 30/);
    expect(prose).toMatch(/Dec 30/);
  });

  it('leaves ARDC alone: fixed DATES are not windows, and it takes proposals all year', () => {
    // n_fixed_dates means "graded on these days", not "closed between them". Reading its four
    // dates as windows would close a genuinely open programme for 361 days of the year.
    expect(inferStatus(raw({ sourceId: 'ardc-grants', rawFields: {} }), ctx({ sourceId: 'ardc-grants' }))).toBe('open');
  });

  it('lets a date the FUNDER stated outrank the table, in the open direction too', () => {
    // The precedence rule this codebase already established for deadlines, extended to status:
    // a window a funder printed on its own page beats any per-source table of ours.
    const stated = raw({
      sourceId: 'arrl-amateur-radio-grants',
      rawFields: { closesAt: '2026-09-09' }, // after NOW, and outside every table window
    });
    expect(inferStatus(stated, ctx({ sourceId: 'arrl-amateur-radio-grants' }))).toBe('open');
  });

  it('and in the closed direction, which is the direction that costs an applicant real work', () => {
    const past = raw({ sourceId: 'arrl-amateur-radio-grants', rawFields: { closesAt: '2026-06-30' } });
    expect(inferStatus(past, ctx({ sourceId: 'arrl-amateur-radio-grants' }))).toBe('closed');
  });
});

/**
 * THE THREE YEARLESS RULES, END TO END FROM THEIR REAL CAPTURES — page bytes in, calendar rows out.
 *
 * Everything above tests `inferStatus` against a hand-built `RawOpportunity`. This runs the actual
 * committed HTML through the actual source module, through `normalizeRaw`, and into the two
 * functions `review/index.ts`'s `writeCyclesFor` and `api/reindex.ts` both call — so what is
 * asserted here is what the product would put on a user's calendar, not what a fixture agrees to.
 *
 * The horizon is `cycleHorizonEndISO(NOW)`, the product's own, for the same reason.
 *
 * THE CLOSE INSTANTS ARE THE SAME UNDER EITHER SHAPE, which is the measurement that settled the
 * IEEE ruling: `n_fixed_dates dates=10-01` and `annual_window window=10-01..10-01` both close at
 * 2026-10-02T03:59Z, so nothing was traded away for the honest badge. What differs is the
 * `opensAt` a deadline must not claim, and the label a user reads — asserted below, both.
 */
describe('the three yearless rules, from their real captures to their calendar rows', () => {
  const horizon = cycleHorizonEndISO(NOW);

  const programFor = (
    module: SourceModule,
    fixture: string,
    url: string,
    sourceId: string,
    funderId: string,
  ): Program => {
    const raws = module.parse([fixturePayload(sourceId, fixture, url)]);
    expect(raws, `${sourceId} parsed no record from its real capture`).toHaveLength(1);
    return normalizeRaw(raws[0], ctx({ sourceId, funderId, klass: 'ham_grant' }));
  };

  const CASES = [
    {
      sourceId: 'austin-arc',
      // "Applications open May 1 and close July 31 each year."
      sentence: /Applications open May 1 and close July 31 each year\./,
      program: (): Program =>
        programFor(
          austinArc,
          '00-austinhams-org-scholarships.html',
          'https://austinhams.org/scholarships/',
          'austin-arc',
          'austin-arc',
        ),
      // NOW is 2026-08-02: the 2026 window shut on July 31, and 2028's close falls past the
      // 550-day horizon. One projected cycle, 2027's.
      closes: ['2027-08-01T04:59:00.000Z'],
      // A window states both ends, so the calendar row carries an open instant and reads as a
      // window. It is the club's own sentence, so this claims nothing the club did not print.
      opens: ['2027-05-01T05:00:00.000Z'],
      labels: ['May 1 – Jul 31, 2027 window'],
      kind: 'annual_window',
      // Today is 2026-08-02, three days after the stated close. A plain fact, not an artefact.
      status: 'closed',
    },
    {
      sourceId: 'ieee-mtts',
      // "…must be received by October 1 or the chapter may be asked to make its application in
      //  the following year."
      sentence: /must be received by October 1 or the chapter may be asked/,
      program: (): Program =>
        programFor(
          ieeeMtts,
          '00-mtt-org-chapter-support.html',
          'https://mtt.org/chapter-support/',
          'ieee-mtts',
          'ieee-mtts',
        ),
      closes: ['2026-10-02T03:59:00.000Z', '2027-10-02T03:59:00.000Z'],
      // NO OPEN INSTANT, on either row. mtt.org states when a request must be RECEIVED BY and
      // never states when the intake begins, so there is no open date to publish — and a one-day
      // window's invented `2026-10-01T04:00:00.000Z` was exactly the fabrication being undone.
      opens: [undefined, undefined],
      labels: ['Oct 1, 2026 deadline', 'Oct 1, 2027 deadline'],
      kind: 'n_fixed_dates',
      // A chapter can prepare and submit its request today; October 1 is when that stops. `closed`
      // here would exclude a live opportunity for 364 days a year.
      status: 'open',
    },
    {
      sourceId: 'ieee-student-branch-rebate',
      // "Student Branch Annual Plans are due 15 March."
      sentence: /Student Branch Annual Plans are due 15 March\./,
      program: (): Program =>
        programFor(
          ieeeStudentBranchRebate,
          '00-students-ieee-org-topics-submit-your-student-branch-annual-plan.html',
          'https://students.ieee.org/topics/submit-your-student-branch-annual-plan/',
          'ieee-student-branch-rebate',
          'ieee',
        ),
      // 2026's 15 March is behind NOW; 2028's falls past the horizon.
      closes: ['2027-03-16T03:59:00.000Z'],
      opens: [undefined],
      labels: ['Mar 15, 2027 deadline'],
      kind: 'n_fixed_dates',
      status: 'open',
    },
  ];

  for (const c of CASES) {
    describe(c.sourceId, () => {
      const program = c.program();

      it('states the annual rule in its own words, with no year next to it', () => {
        const raws = [program.rawOtherText, program.summary, program.deadline.note].join(' ');
        expect(raws.length).toBeGreaterThan(0);
        expect(c.sentence.test(program.deadline.note)).toBe(true);
        // The directive half — everything before the first ` | ` — carries no year, by design.
        expect(program.deadline.note.split('|')[0]).not.toMatch(/\b(?:19|20)\d{2}\b/);
      });

      /**
       * THE VERDICT IS THE FUNDER'S, NOT THE TABLE'S. Austin ARC printed a close date that has
       * passed, so `closed`. IEEE printed a cutoff and no opening, so `open` — the shape the page
       * supports, and the one that does not exclude a chapter that could apply today.
       */
      it(`resolves ${String(c.status)} against the 2026-08-02 corpus clock`, () => {
        expect(program.trust.status).toBe(c.status);
        expect(program.trust.status).not.toBe('unknown');
        expect(program.deadline.kind).toBe(c.kind);
      });

      it('projects exactly the estimated cycles its rule supports inside the horizon', () => {
        const projected = expandCycles(program, [program], NOW, horizon);
        expect(projected.map((x) => x.closesAt)).toEqual(c.closes);
        expect(projected.every((x) => x.isEstimated)).toBe(true);
      });

      /**
       * AND THE ROW SAYS WHAT THE PAGE SAYS. A window row carries an open instant and reads
       * "… window"; a deadline row carries none and reads "… deadline". This is the user-visible
       * half of the ruling — a one-day window rendered as "Oct 1–1, 2026 window", which is both an
       * invented opening and an unreadable label.
       */
      it('labels the row as the shape the funder stated, and invents no opening', () => {
        const projected = expandCycles(program, [program], NOW, horizon);
        expect(projected.map((x) => x.label)).toEqual(c.labels);
        expect(projected.map((x) => x.opensAt)).toEqual(c.opens);
      });

      /**
       * AND NOT ONE OBSERVED ROW. `observedCycles` is the `isEstimated: false` channel, and it
       * reads a window a funder DATED. These three pages date nothing, so the record carries no
       * `published by the funder:` marker and this channel is correctly empty — which is what
       * keeps a rule from being mistaken for a window somebody actually announced.
       */
      it('contributes nothing to the observed channel, because it published no dated window', () => {
        expect(observedCycles(program, [program], NOW, horizon)).toEqual([]);
        expect(program.deadline.note).not.toContain(OBSERVED_WINDOW_MARKER);
      });
    });
  }
});

/**
 * THE OBSERVED WINDOWS ARE STILL OBSERVED, and still have no successors.
 *
 * The risk in routing three yearless rules into `RECURRENCE_BY_SOURCE` is doing the same to a
 * window a funder stated ONCE — which would publish, say, a 2027 ARISS deadline ARISS has never
 * announced. This is the guard: the two ham-side records that DO carry a funder-dated window each
 * yield exactly one `isEstimated: false` row and zero projected ones, from their real captures,
 * with an 18-month horizon that would comfortably contain a successor if anything generated one.
 */
describe('a window a funder stated once is still never projected forward', () => {
  const horizon = cycleHorizonEndISO(NOW);

  const CASES = [
    {
      label: 'ariss',
      program: (): Program => {
        const raws = ariss.parse([
          fixturePayload('ariss', '00-ariss-usa-org-proposal-overview.html', 'https://ariss-usa.org/proposal-overview/'),
        ]);
        return normalizeRaw(raws[0], ctx({ sourceId: 'ariss', funderId: 'ariss-usa', klass: 'equipment_in_kind' }));
      },
      closesAt: '2026-09-30T23:59:59.999Z',
    },
    {
      label: 'yaesu-dr2x',
      program: (): Program => {
        const raws = yaesuDr2x.parse([
          fixturePayload('yaesu-dr2x', '00-systemfusion-yaesu-com.html', 'https://systemfusion.yaesu.com/dr-2x-repeater-program/'),
        ]);
        return normalizeRaw(raws[0], ctx({ sourceId: 'yaesu-dr2x', funderId: 'yaesu', klass: 'equipment_in_kind' }));
      },
      closesAt: '2026-08-31T23:59:59.999Z',
    },
  ];

  for (const c of CASES) {
    it(`${c.label} yields exactly one observed cycle and no projected successor`, () => {
      const program = c.program();
      const observed = observedCycles(program, [program], NOW, horizon);
      expect(observed).toHaveLength(1);
      expect(observed[0].closesAt).toBe(c.closesAt);
      expect(observed[0].isEstimated).toBe(false);
      // The successor that must not exist. A `RECUR` directive for either of these would put one
      // here, one year on, under the funder's name.
      expect(expandCycles(program, [program], NOW, horizon)).toEqual([]);
    });
  }
});
