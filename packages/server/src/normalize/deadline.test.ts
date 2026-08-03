import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { inferStatus } from './deadline.js';
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
