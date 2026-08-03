import type { Program, RawOpportunity } from '@grantspotter/core';
import { expandCycles, hashProgram, parseRecurrence } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { programIdFor } from '../sources/util/ids.js';
import { DEADLINE_INHERITANCE } from './deadline.js';
import { DISPUTED_OVERRIDES, sourceKeyOf } from './disputed.js';
import { type NormalizeContext, normalizeRaw } from './index.js';

const NOW = '2026-08-02T00:00:00.000Z';

const ctx = (over: Partial<NormalizeContext> = {}): NormalizeContext => ({
  sourceId: 'arrl-scholarship-descriptions',
  funderId: 'arrl-foundation',
  klass: 'ham_scholarship',
  tier: 'C',
  nowISO: NOW,
  verificationMethod: 'live_fetch',
  deadlineInheritsFrom: DEADLINE_INHERITANCE['arrl-scholarship-descriptions'],
  mintId: programIdFor,
  ...over,
});

const raw = (over: Partial<RawOpportunity> = {}): RawOpportunity => ({
  sourceId: 'arrl-scholarship-descriptions',
  externalKey: 'YASME Foundation Scholarship',
  name: 'YASME Foundation Scholarship',
  rawFields: {
    'Field of Study': 'Sciences or Engineering',
    'License Requirement': 'General or higher, licensed at least two years',
    Region: 'Any',
    Institution: 'Any accredited institution',
    'Award Amount': '$5,000',
    'Number of Awards': 'Three',
    Other: 'Top 5 to 10 percent of the class; year-end activity report required.',
  },
  sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
  rawText: 'YASME Foundation Scholarship body text',
  ...over,
});

describe('normalizeRaw identity and provenance', () => {
  it('builds a deterministic id from sourceId and externalKey', () => {
    const a = normalizeRaw(raw(), ctx());
    const b = normalizeRaw(raw(), ctx());
    expect(a.id).toBe(b.id);
    expect(a.id).toContain('arrl-scholarship-descriptions--');
  });

  it('reuses an already-stored id instead of minting a duplicate — RESOLUTIONS R9', () => {
    const seeded = normalizeRaw(
      raw({ sourceId: 'ardc-grants', externalKey: 'grants', name: 'ARDC Grants Program' }),
      ctx({
        sourceId: 'ardc-grants',
        funderId: 'ardc',
        klass: 'ham_grant',
        tier: 'A',
        deadlineInheritsFrom: undefined,
        existingIdFor: (sourceId, externalKey) =>
          sourceId === 'ardc-grants' && externalKey === 'grants' ? 'ardc-grants' : undefined,
      }),
    );
    expect(seeded.id).toBe('ardc-grants');
    expect(seeded.id).not.toContain('--');
  });

  it('falls back to minting when nothing is stored under that source key', () => {
    const fresh = normalizeRaw(
      raw({ sourceId: 'ardc-grants', externalKey: 'grants' }),
      ctx({
        sourceId: 'ardc-grants',
        funderId: 'ardc',
        klass: 'ham_grant',
        tier: 'A',
        deadlineInheritsFrom: undefined,
        existingIdFor: () => undefined,
      }),
    );
    expect(fresh.id).toBe(programIdFor('ardc-grants', 'grants'));
  });

  it('stamps the ingest identity into tags so approval can persist the source key', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.tags).toContain('source:arrl-scholarship-descriptions');
    expect(p.tags).toContain('key:YASME Foundation Scholarship');
  });

  it('carries funderId, klass and the source URL through', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.funderId).toBe('arrl-foundation');
    expect(p.klass).toBe('ham_scholarship');
    expect(p.trust.sourceUrl).toBe('http://www.arrl.org/scholarship-descriptions');
    expect(p.trust.lastVerifiedAt).toBe(NOW);
    expect(p.trust.verificationMethod).toBe('live_fetch');
  });

  it('sets contentHash to hashProgram of itself, computed last', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.trust.contentHash).toBe(hashProgram(p));
    expect(p.trust.contentHash).not.toBe('');
  });

  it('produces the same hash on two consecutive nights when only lastVerifiedAt moves', () => {
    const a = normalizeRaw(raw(), ctx());
    const b = normalizeRaw(raw(), ctx({ nowISO: '2026-08-03T00:00:00.000Z' }));
    expect(hashProgram(a)).toBe(hashProgram(b));
  });
});

describe('rawOtherText is always populated', () => {
  it('carries the Other field verbatim, newlines and all', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.rawOtherText).toContain('Top 5 to 10 percent');
    expect(p.rawOtherText).toContain('year-end activity report');
  });

  it('falls back to the whole rawText rather than losing unmodelled requirements', () => {
    const p = normalizeRaw(
      raw({ rawFields: { 'Award Amount': '$1,000' }, rawText: 'A long-tail requirement sentence.' }),
      ctx(),
    );
    expect(p.rawOtherText).toContain('A long-tail requirement sentence.');
  });

  it('is an empty string, never undefined, when there is genuinely nothing', () => {
    const p = normalizeRaw(raw({ rawFields: {}, rawText: '' }), ctx());
    expect(p.rawOtherText).toBe('');
  });
});

describe('amounts', () => {
  it('keeps amountRaw and awardCountRaw verbatim', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.amount.amountRaw).toBe('$5,000');
    expect(p.amount.awardCountRaw).toBe('Three');
  });

  it('keeps a non-numeric award count verbatim', () => {
    const p = normalizeRaw(raw({ rawFields: { ...raw().rawFields, 'Number of Awards': 'Multiple per year' } }), ctx());
    expect(p.amount.awardCountRaw).toBe('Multiple per year');
  });

  it('keeps the literal string TBD verbatim and leaves min/max undefined', () => {
    const p = normalizeRaw(raw({ rawFields: { amountRaw: 'TBD' } }), ctx());
    expect(p.amount.amountRaw).toBe('TBD');
    expect(p.amount.amountMin).toBeUndefined();
    expect(p.amount.amountMax).toBeUndefined();
  });

  it('uses empty strings, not undefined, when a source publishes no amount at all', () => {
    const p = normalizeRaw(raw({ rawFields: {} }), ctx());
    expect(p.amount.amountRaw).toBe('');
    expect(p.amount.awardCountRaw).toBe('');
  });
});

describe('deadline inheritance', () => {
  it('points at the canonical program ids, not minted ones — RESOLUTIONS R9', () => {
    expect(DEADLINE_INHERITANCE['arrl-scholarship-descriptions']).toBe(
      'arrl-foundation-scholarships',
    );
    expect(DEADLINE_INHERITANCE.qcwa).toBe('arrl-foundation-scholarships');
    for (const id of Object.values(DEADLINE_INHERITANCE)) {
      expect(id).not.toContain('--'); // a minted id would carry the `--<hash>` suffix
    }
  });

  it('makes every ARRL catalog entry inherit the one shared cycle', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.deadline.kind).toBe('inherited');
    expect(p.deadline.source).toEqual({
      kind: 'inherited',
      fromProgramId: DEADLINE_INHERITANCE['arrl-scholarship-descriptions'],
    });
  });

  it('makes QCWA inherit the same ARRL cycle, because its intake is ARRL’s portal', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'qcwa', externalKey: 'qcwa-memorial-scholarship' }),
      ctx({ sourceId: 'qcwa', funderId: 'qcwa', deadlineInheritsFrom: DEADLINE_INHERITANCE.qcwa }),
    );
    expect(p.deadline.kind).toBe('inherited');
    expect(p.deadline.source).toEqual({ kind: 'inherited', fromProgramId: DEADLINE_INHERITANCE.qcwa });
  });

  it('gives a self-owned source kind self', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ardc-grants' }),
      ctx({ sourceId: 'ardc-grants', funderId: 'ardc', klass: 'ham_grant', tier: 'A', deadlineInheritsFrom: undefined }),
    );
    expect(p.deadline.source).toEqual({ kind: 'self' });
  });

  it('marks a source with no published deadline as unpublished, never as a guessed date', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', externalKey: 'club-grant-program', rawFields: { amount: '$1,000 to $25,000' } }),
      ctx({ sourceId: 'arrl-club-grant', funderId: 'arrl-foundation', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.deadline.kind).toBe('unpublished');
    expect(p.deadline.note).toMatch(/never published/i);
  });

  it('marks rolling sources rolling', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'sara', externalKey: 'sara-student-teacher-grants' }),
      ctx({ sourceId: 'sara', funderId: 'sara', klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
    );
    expect(p.deadline.kind).toBe('rolling');
  });
});

describe('the RECUR micro-format is actually emitted — RESOLUTIONS R12', () => {
  /** The three recurring programs, normalized exactly as the crawler produces them. */
  const recurring = (): Record<'ardc' | 'grants' | 'scholarships', Program> => ({
    ardc: normalizeRaw(
      raw({ sourceId: 'ardc-grants', externalKey: 'grants', name: 'ARDC Grants Program' }),
      ctx({
        sourceId: 'ardc-grants',
        funderId: 'ardc',
        klass: 'ham_grant',
        tier: 'A',
        deadlineInheritsFrom: undefined,
        existingIdFor: () => 'ardc-grants',
      }),
    ),
    grants: normalizeRaw(
      raw({
        sourceId: 'arrl-amateur-radio-grants',
        externalKey: 'amateur-radio-grants',
        name: 'ARRL Amateur Radio Grants',
      }),
      ctx({
        sourceId: 'arrl-amateur-radio-grants',
        funderId: 'arrl-foundation',
        klass: 'ham_grant',
        deadlineInheritsFrom: undefined,
        existingIdFor: () => 'arrl-amateur-radio-grants',
      }),
    ),
    scholarships: normalizeRaw(
      raw({
        sourceId: 'arrl-scholarship-program',
        externalKey: 'scholarship-program',
        name: 'ARRL Foundation Scholarship Program',
      }),
      ctx({
        sourceId: 'arrl-scholarship-program',
        funderId: 'arrl-foundation',
        deadlineInheritsFrom: undefined,
        existingIdFor: () => 'arrl-foundation-scholarships',
      }),
    ),
  });

  it('emits a parseable directive whose kind matches DeadlineSpec.kind', () => {
    for (const p of Object.values(recurring())) {
      expect(p.deadline.note.startsWith('RECUR ')).toBe(true);
      const parsed = parseRecurrence(p.deadline.note);
      expect(parsed.kind).toBe(p.deadline.kind);
    }
  });

  it('emits ARDC Feb 1 / Apr 1 / Jul 1 / Sep 1 in Pacific time', () => {
    const parsed = parseRecurrence(recurring().ardc.deadline.note);
    expect(parsed).toMatchObject({
      kind: 'n_fixed_dates',
      timezone: 'America/Los_Angeles',
      dates: [
        { month: 2, day: 1 },
        { month: 4, day: 1 },
        { month: 7, day: 1 },
        { month: 9, day: 1 },
      ],
    });
  });

  it('emits the three ARRL grant windows in Eastern time', () => {
    const parsed = parseRecurrence(recurring().grants.deadline.note);
    expect(parsed).toMatchObject({
      kind: 'n_fixed_windows',
      timezone: 'America/New_York',
      windows: [
        { open: { month: 2, day: 1 }, close: { month: 2, day: 28 } },
        { open: { month: 6, day: 1 }, close: { month: 6, day: 30 } },
        { open: { month: 10, day: 1 }, close: { month: 10, day: 31 } },
      ],
    });
  });

  it('emits the scholarship annual window closing Dec 30 at 12:00 Eastern', () => {
    const parsed = parseRecurrence(recurring().scholarships.deadline.note);
    expect(parsed).toMatchObject({
      kind: 'annual_window',
      timezone: 'America/New_York',
      window: { open: { month: 10, day: 30 }, close: { month: 12, day: 30 } },
      closeTime: { hour: 12, minute: 0 },
    });
  });

  it('expandCycles returns a NON-EMPTY result for all three — the whole point of R12', () => {
    const all = Object.values(recurring());
    for (const p of all) {
      const cycles = expandCycles(p, all, '2027-01-01T00:00:00.000Z', '2027-12-31T23:59:59.999Z');
      expect(cycles.length, `${p.id} projected no cycles`).toBeGreaterThan(0);
      expect(cycles.every((c) => c.programId === p.id)).toBe(true);
    }
  });

  it('lets the 111 inheriting catalog entries ride the scholarship cycle', () => {
    const all = Object.values(recurring());
    const catalogEntry = normalizeRaw(raw(), ctx());
    const cycles = expandCycles(
      catalogEntry,
      [...all, catalogEntry],
      '2027-01-01T00:00:00.000Z',
      '2027-12-31T23:59:59.999Z',
    );
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles.every((c) => c.programId === catalogEntry.id)).toBe(true);
  });

  it('never attaches a directive to a non-projectable kind', () => {
    const clubGrant = normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', externalKey: 'club-grant-program' }),
      ctx({ sourceId: 'arrl-club-grant', funderId: 'arrl-foundation', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(clubGrant.deadline.kind).toBe('unpublished');
    expect(clubGrant.deadline.note.startsWith('RECUR ')).toBe(false);
  });
});

describe('status and instrument', () => {
  it('marks a past-award record closed so it never renders as a live deadline', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ardc-award-tables', rawFields: { recordType: 'past_award', amountRaw: '$77,000' } }),
      ctx({ sourceId: 'ardc-award-tables', funderId: 'ardc', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.trust.status).toBe('closed');
    expect(p.tags).toContain('past_award');
  });

  it('marks a verified-negative record discontinued', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'manual-tier-d', rawFields: { recordType: 'verified_negative', reason: 'no programme exists' } }),
      ctx({ sourceId: 'manual-tier-d', funderId: 'various', tier: 'D', verificationMethod: 'manual_curation', deadlineInheritsFrom: undefined }),
    );
    expect(p.trust.status).toBe('discontinued');
  });

  it('marks a no-application record no_application', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'manual-tier-d', rawFields: { recordType: 'manual', deadlineKind: 'no_application_exists' } }),
      ctx({ sourceId: 'manual-tier-d', funderId: 'yasme', tier: 'D', verificationMethod: 'manual_curation', deadlineInheritsFrom: undefined }),
    );
    expect(p.trust.status).toBe('no_application');
    expect(p.deadline.kind).toBe('no_application_exists');
  });

  it('marks the Yaesu record a discounted purchase, not a cash grant', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'yaesu-dr2x', rawFields: { pricing: '$1,450 or $1,860.' } }),
      ctx({ sourceId: 'yaesu-dr2x', funderId: 'yaesu-usa', klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
    );
    expect(p.amount.instrument).toBe('discounted_purchase');
  });

  it('marks ARISS and NASA CSLI in-kind service', () => {
    for (const sourceId of ['ariss', 'nasa-csli']) {
      const p = normalizeRaw(
        raw({ sourceId }),
        ctx({ sourceId, funderId: sourceId, klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
      );
      expect(p.amount.instrument).toBe('in_kind_service');
    }
  });

  it('refuses to publish a crosscheck record', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'arrl-summary-of-scholarship-requirements', rawFields: { recordType: 'crosscheck' } }),
      ctx({ sourceId: 'arrl-summary-of-scholarship-requirements', deadlineInheritsFrom: undefined }),
    );
    expect(p.tags).toContain('crosscheck');
    expect(p.tags).toContain('do_not_publish');
  });
});

describe('status fix round 1 — a safety warning must never compute open', () => {
  const tierD = (over: Partial<RawOpportunity> = {}): RawOpportunity =>
    raw({
      sourceId: 'manual-tier-d',
      externalKey: 'placeholder',
      name: 'placeholder',
      rawFields: {},
      sourceUrl: 'https://www.arrl.org/scholarship-program',
      rawText: 'placeholder body text',
      ...over,
    });

  const tierDCtx = (over: Partial<NormalizeContext> = {}): NormalizeContext =>
    ctx({
      sourceId: 'manual-tier-d',
      funderId: 'various',
      klass: 'ham_grant',
      tier: 'D',
      verificationMethod: 'manual_curation',
      deadlineInheritsFrom: undefined,
      ...over,
    });

  it('marks the FAR domain-takeover safety warning discontinued, never open', () => {
    // Reproduces the actual manual-tier-d.ts record verbatim: recordType 'safety_warning' plus
    // an explicit rawFields.status override. Before the fix this fell through every branch of
    // inferStatus to 'open' — a domain-takeover warning rendered as a live opportunity.
    const p = normalizeRaw(
      tierD({
        externalKey: 'far-farweb-org-compromised',
        name: 'Foundation for Amateur Radio (FAR) — domain compromised, do not apply',
        rawFields: { recordType: 'safety_warning', status: 'discontinued' },
      }),
      tierDCtx(),
    );
    expect(p.trust.status).toBe('discontinued');
    expect(p.trust.status).not.toBe('open');
  });

  it('falls back to discontinued for a safety_warning record even with no explicit override', () => {
    const p = normalizeRaw(
      tierD({ externalKey: 'some-future-safety-warning', rawFields: { recordType: 'safety_warning' } }),
      tierDCtx(),
    );
    expect(p.trust.status).toBe('discontinued');
  });

  it('marks the RCA Youth Activities permanent contact-only entry contact_only, never open', () => {
    // manual-tier-d.ts's own rawText for this record reads "Permanent contact-only entry; do not
    // poll." — nothing in recordType/deadlineKind alone said so, which is why it silently
    // computed open before this fix.
    const p = normalizeRaw(
      tierD({
        externalKey: 'rca-youth-activities',
        name: 'Radio Club of America Youth Activities Program',
        rawFields: { recordType: 'manual', deadlineKind: 'rolling' },
      }),
      tierDCtx(),
    );
    expect(p.trust.status).toBe('contact_only');
    expect(p.trust.status).not.toBe('open');
  });

  it('does not let an unrecognised recordType default to open', () => {
    const p = normalizeRaw(
      tierD({ externalKey: 'a-record-type-nobody-taught-this-function-about', rawFields: { recordType: 'brand_new_kind_2027' } }),
      tierDCtx(),
    );
    expect(p.trust.status).toBe('unknown');
    expect(p.trust.status).not.toBe('open');
  });

  it('still defaults to open when no recordType is published at all', () => {
    // The common case for a normal live-crawled record: no recordType field whatsoever. Must
    // stay open, or every ordinary open opportunity in the corpus regresses to unknown.
    const p = normalizeRaw(raw(), ctx());
    expect(p.trust.status).toBe('open');
  });

  it('lets an explicit rawFields.status override win even over a distinct recordType-derived status', () => {
    // Without the override this record's recordType/deadlineKind would resolve to
    // 'no_application' (see the existing no-application test above) — proving the override wins
    // over a DIFFERENT branch's inference, not just coincidentally agreeing with it.
    const p = normalizeRaw(
      tierD({
        externalKey: 'override-wins-over-no-application',
        rawFields: { recordType: 'manual', deadlineKind: 'no_application_exists', status: 'closed' },
      }),
      tierDCtx(),
    );
    expect(p.trust.status).toBe('closed');
  });

  it('does not attach a cost-share obligation to the Tier D NCDXF Youth Grant record', () => {
    // Regression guard for the OBLIGATIONS_BY_RECORD drift found alongside the status bug: a
    // dead entry keyed sourceKeyOf('manual-tier-d', 'ncdxf-dxpedition-grants') never matched any
    // real record (that externalKey only exists under the separate 'ncdxf-grants' source) and has
    // been removed rather than repointed, since the real Tier D record — ncdxf-youth-grant —
    // "publishes no terms" and carries no known obligation.
    const p = normalizeRaw(
      tierD({ externalKey: 'ncdxf-youth-grant', name: 'NCDXF Youth Grant', rawFields: { recordType: 'manual', deadlineKind: 'unpublished' } }),
      tierDCtx({ funderId: 'ncdxf' }),
    );
    expect(p.obligations.costShareRequired).toBe(false);
  });
});

describe('disputed claims ship populated', () => {
  it('attaches all three ARRL Club Grant readings instead of picking one', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', externalKey: 'club-grant-program', name: 'ARRL Club Grant Program', rawFields: { amount: '$1,000 to $25,000' } }),
      ctx({ sourceId: 'arrl-club-grant', funderId: 'arrl-foundation', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.trust.disputed).toBeDefined();
    expect(p.trust.disputed?.claims).toHaveLength(3);
    for (const claim of p.trust.disputed?.claims ?? []) {
      expect(claim.claim.length).toBeGreaterThan(20);
      expect(() => new URL(claim.sourceUrl)).not.toThrow();
    }
  });

  it('keys the override on the source key, so it survives id reconciliation', () => {
    // RESOLUTIONS R9 means the same record can carry a minted id on a fresh database and the
    // seeded id `arrl-club-grant` once Plan 5's corpus is imported. Keying on (sourceId,
    // externalKey) is the only key that is the same in both worlds.
    expect(Object.keys(DISPUTED_OVERRIDES)).toContain(
      sourceKeyOf('arrl-club-grant', 'club-grant-program'),
    );
    const minted = normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', externalKey: 'club-grant-program' }),
      ctx({ sourceId: 'arrl-club-grant', deadlineInheritsFrom: undefined }),
    );
    const seeded = normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', externalKey: 'club-grant-program' }),
      ctx({
        sourceId: 'arrl-club-grant',
        deadlineInheritsFrom: undefined,
        existingIdFor: () => 'arrl-club-grant',
      }),
    );
    expect(minted.id).not.toBe(seeded.id);
    expect(minted.trust.disputed?.claims).toHaveLength(3);
    expect(seeded.trust.disputed?.claims).toHaveLength(3);
  });
});

describe('obligations and restrictions', () => {
  it('applies ARDC’s open-source obligation and 20% indirect cap', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ardc-grants' }),
      ctx({ sourceId: 'ardc-grants', funderId: 'ardc', klass: 'ham_grant', tier: 'A', deadlineInheritsFrom: undefined }),
    );
    expect(p.obligations.licenseObligation).toMatch(/open-source/i);
    expect(p.obligations.indirectCostCapPct).toBe(20);
  });

  it('applies ARRL’s exclusions and co-funder preference', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'arrl-amateur-radio-grants', externalKey: 'amateur-radio-grants' }),
      ctx({ sourceId: 'arrl-amateur-radio-grants', funderId: 'arrl-foundation', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.fundingRestrictions.join(' ')).toMatch(/emergency communications/i);
    expect(p.fundingRestrictions.join(' ')).toMatch(/operating expenses/i);
    expect(p.obligations.coFunderPreference).toBe(true);
  });

  it('applies Yaesu’s 12-month on-air sustainment obligation', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'yaesu-dr2x' }),
      ctx({ sourceId: 'yaesu-dr2x', funderId: 'yaesu-usa', klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
    );
    expect(p.obligations.sustainmentObligation).toMatch(/12 months|twelve months/i);
  });

  it('applies YASME’s year-end reporting obligation from the Tier D record', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'manual-tier-d', externalKey: 'yasme-supporting-grants', name: 'YASME Foundation Supporting Grants' }),
      ctx({
        sourceId: 'manual-tier-d',
        funderId: 'yasme',
        klass: 'ham_grant',
        tier: 'D',
        verificationMethod: 'manual_curation',
        deadlineInheritsFrom: undefined,
      }),
    );
    expect(p.obligations.reportingObligation).toMatch(/year-end activity report/i);
  });

  it('applies NCDXF’s cost-share requirement', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ncdxf-grants', externalKey: 'ncdxf-dxpedition-grants', name: 'NCDXF DXpedition Grants' }),
      ctx({ sourceId: 'ncdxf-grants', funderId: 'ncdxf', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.obligations.costShareRequired).toBe(true);
  });

  it('carries every §4.6 obligation field — all six are reachable through normalizeRaw', () => {
    // spec §4.6: licenseObligation, indirectCostCapPct, costShareRequired, coFunderPreference,
    // sustainmentObligation, reportingObligation. Seed records re-enter this same pipeline on
    // "Verify now" (Plan 3 Task 10), so a field no source produces is a field silently dropped.
    const produced = new Set<string>();
    const cases: Array<[string, Partial<NormalizeContext>, string]> = [
      ['ardc-grants', { funderId: 'ardc', klass: 'ham_grant', tier: 'A' }, 'grants'],
      ['arrl-amateur-radio-grants', { funderId: 'arrl-foundation', klass: 'ham_grant' }, 'amateur-radio-grants'],
      ['yaesu-dr2x', { funderId: 'yaesu-usa', klass: 'equipment_in_kind' }, 'dr2x-repeater'],
      ['ncdxf-grants', { funderId: 'ncdxf', klass: 'ham_grant' }, 'ncdxf-dxpedition-grants'],
      ['manual-tier-d', { funderId: 'yasme', klass: 'ham_grant', tier: 'D', verificationMethod: 'manual_curation' }, 'yasme-supporting-grants'],
    ];
    for (const [sourceId, over, externalKey] of cases) {
      const p = normalizeRaw(
        raw({ sourceId, externalKey }),
        ctx({ sourceId, deadlineInheritsFrom: undefined, ...over }),
      );
      for (const [field, value] of Object.entries(p.obligations)) {
        if (value !== undefined && value !== false) produced.add(field);
      }
    }
    expect([...produced].sort()).toEqual([
      'coFunderPreference',
      'costShareRequired',
      'indirectCostCapPct',
      'licenseObligation',
      'reportingObligation',
      'sustainmentObligation',
    ]);
  });
});

describe('AI policy ships populated', () => {
  it('quotes ARDC’s permission-plus-diagnosis stance with its URL', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ardc-grants' }),
      ctx({ sourceId: 'ardc-grants', funderId: 'ardc', klass: 'ham_grant', tier: 'A', deadlineInheritsFrom: undefined }),
    );
    expect(p.aiPolicy.stance).toBe('permitted');
    expect(p.aiPolicy.quote).toMatch(/extremely long and hard to understand/i);
    expect(p.aiPolicy.url).toContain('ardc.net');
  });

  it('records the ARRL Foundation stance as unaddressed rather than inventing one', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.aiPolicy.stance).toBe('unaddressed');
  });

  it('records NSF’s encouraged-disclosure stance', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'nsf-funding-rss' }),
      ctx({ sourceId: 'nsf-funding-rss', funderId: 'nsf', klass: 'adjacent_stem', tier: 'B', deadlineInheritsFrom: undefined }),
    );
    expect(p.aiPolicy.stance).toBe('permitted_with_disclosure');
    expect(p.aiPolicy.url).toContain('nsf.gov');
  });
});

describe('the resulting Program is complete', () => {
  it('populates every non-optional field of the contract shape', () => {
    const p: Program = normalizeRaw(raw(), ctx());
    expect(typeof p.summary).toBe('string');
    expect(Array.isArray(p.applicantEntities)).toBe(true);
    expect(Array.isArray(p.constraints)).toBe(true);
    expect(Array.isArray(p.fundingRestrictions)).toBe(true);
    expect(Array.isArray(p.tags)).toBe(true);
    expect(typeof p.obligations.costShareRequired).toBe('boolean');
    expect(typeof p.obligations.coFunderPreference).toBe('boolean');
    expect(typeof p.rawOtherText).toBe('string');
  });

  it('never emits a summary that is a full text dump', () => {
    const long = 'x'.repeat(5000);
    const p = normalizeRaw(raw({ rawText: long }), ctx());
    expect(p.summary.length).toBeLessThanOrEqual(400);
  });
});
