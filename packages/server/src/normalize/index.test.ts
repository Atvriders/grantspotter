import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OrgProfile, Program, ProgramStatus, RawOpportunity } from '@grantspotter/core';
import { expandCycles, hashProgram, matchProgram, obligationState, parseRecurrence } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
// The corpus profiler's own loader, imported rather than reimplemented so the corpus-wide count
// below cannot drift from `npm run profile-corpus`. scripts/ is inside the root tsconfig include
// and is a vitest project of its own, so this crosses no boundary that is not already crossed.
import { loadCorpus } from '../../../../scripts/profile-corpus.js';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
import { grantsGovFederal } from '../sources/grants-gov-federal.js';
import { TIER_D_RECORDS } from '../sources/manual-tier-d.js';
import { SOURCES } from '../sources/registry.js';
import { isSignalSource } from '../sources/types.js';
import { programIdFor } from '../sources/util/ids.js';
import { DEADLINE_INHERITANCE } from './deadline.js';
import { DISPUTED_OVERRIDES, sourceKeyOf } from './disputed.js';
import {
  DO_NOT_PUBLISH_TAG,
  ENTITIES_BY_SOURCE,
  ENTITIES_UNKNOWN_BY_SOURCE,
  PUBLISHABLE_RECORD_TYPES,
  SUPPRESSED_RECORD_TYPES,
  entitiesFromApplicantTypes,
  isDoNotPublish,
  type NormalizeContext,
  normalizeRaw,
} from './index.js';

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
  it('points at the owning SOURCE, which is stable — a literal cannot name a derived id', () => {
    // REMEDIATION (2026-08-03). This assertion used to demand the literal
    // 'arrl-foundation-scholarships' in a field consumed as a PROGRAM id, and no program has ever
    // carried that id: `programIdFor` derives every id from (sourceId, externalKey). All 112
    // inheriting records pointed at nothing. The table names the owner's SOURCE now, and the
    // program id is derived from that source's stable key at the point of use.
    expect(DEADLINE_INHERITANCE['arrl-scholarship-descriptions']).toBe('arrl-scholarship-program');
    expect(DEADLINE_INHERITANCE.qcwa).toBe('arrl-scholarship-program');
    for (const owner of Object.values(DEADLINE_INHERITANCE)) {
      expect(owner).not.toContain('--'); // a minted id would carry the `--<hash>` suffix
    }
  });

  it('makes every ARRL catalog entry inherit the one shared cycle', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.deadline.kind).toBe('inherited');
    // Derived from the owner's stable source key by the same `programIdFor` the owner's own
    // record uses — not a literal, and not the source id either.
    expect(p.deadline.source).toEqual({
      kind: 'inherited',
      fromProgramId: programIdFor('arrl-scholarship-program', 'scholarship-program'),
    });
  });

  it('makes QCWA inherit the same ARRL cycle, because its intake is ARRL’s portal', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'qcwa', externalKey: 'qcwa-memorial-scholarship' }),
      ctx({ sourceId: 'qcwa', funderId: 'qcwa', deadlineInheritsFrom: DEADLINE_INHERITANCE.qcwa }),
    );
    expect(p.deadline.kind).toBe('inherited');
    expect(p.deadline.source).toEqual({
      kind: 'inherited',
      fromProgramId: programIdFor('arrl-scholarship-program', 'scholarship-program'),
    });
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
    // `status: 'closed'` alone was never enough: nothing downstream read trust.status either
    // (matcher.ts still does not), so a past award was a fully publishable Program until the tag
    // below started being both written and enforced. See the do_not_publish describe block below.
    expect(p.tags).toContain('do_not_publish');
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
    // poll." Round 1 caught this with a name-keyed CONTACT_ONLY_RECORDS table in deadline.ts, a
    // workaround; round 2 replaced it with a real rawFields.status on the source record itself
    // (see sources/manual-tier-d.js, and the exhaustive per-record table below), which is what
    // this override reproduces here.
    const p = normalizeRaw(
      tierD({
        externalKey: 'rca-youth-activities',
        name: 'Radio Club of America Youth Activities Program',
        rawFields: { recordType: 'manual', status: 'contact_only', deadlineKind: 'rolling' },
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
    //
    // REMEDIATION (2026-08-03): this used to be asserted through `ctx()`, whose source INHERITS
    // its deadline — so it was really asserting that a record riding another programme's cycle
    // claims to be open on its own, which is the defect that badged 110 closed ARRL scholarships
    // as open. A source that owns its own deadline is what "an ordinary open record" means.
    const p = normalizeRaw(
      raw({ sourceId: 'ncdxf-grants', externalKey: 'ncdxf-grant-program' }),
      ctx({ sourceId: 'ncdxf-grants', funderId: 'ncdxf', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.trust.status).toBe('open');
  });

  it('refuses to call a record that rides another programme’s cycle open', () => {
    // The companion half of the assertion above, at the same seam: `unknown` is what normalize/
    // knows about an inheriting record, because it cannot see the owner.
    expect(normalizeRaw(raw(), ctx()).trust.status).toBe('unknown');
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
    expect(p.obligations.costShareRequired).toBeUndefined();
  });
});

describe('status fix round 2 — every one of the 16 Tier D records carries an honoured, correct status', () => {
  // RESOLUTIONS/coordinator review (round 2): round 1 fixed the two records it was told about but
  // left the same class of bug live in the other 14. sources/manual-tier-d.ts now gives every
  // record an explicit rawFields.status; this table is the single place that field's correctness
  // is asserted, keyed by externalKey rather than array position, so a record can be reordered,
  // added or removed without this test silently passing on the wrong entry.
  const EXPECTED_STATUS: Readonly<Record<string, ProgramStatus>> = Object.freeze({
    // A domain takeover that intercepts a live "apply at FAR" instruction. The FAR intake itself
    // really is gone — the one safety-warning record where 'discontinued' is correct.
    'far-farweb-org-compromised': 'discontinued',
    // Yasme is an active board; there is simply no application to submit to.
    'yasme-supporting-grants': 'no_application',
    'yasme-excellence-award': 'no_application',
    // RCA nominates through the student's institution — a path, but through a person/department.
    'rca-scholarship-program': 'contact_only',
    'rca-youth-activities': 'contact_only',
    // Guided pointers into real, active, non-aggregatable programs — not a single open cash grant.
    'nasa-space-grant-consortia': 'contact_only',
    'campus-sga-playbook': 'contact_only',
    'ncdxf-youth-grant': 'contact_only',
    // HamSCI has no club-facing application at all: contact a funded PI, not a grant desk.
    'hamsci-participation': 'no_application',
    'ieee-society-funding-pages': 'contact_only',
    // ARRL CARI runs live meetups right now; it was simply never a funding program.
    'negative-arrl-cari': 'no_application',
    // AMSAT is thriving — it is a grant RECIPIENT, not a grantmaker.
    'negative-amsat': 'no_application',
    // FlexRadio exists and sells radios; it just has no education/nonprofit tier.
    'negative-flexradio': 'no_application',
    // Icom/DXE/Kenwood give real equipment through a regional rep — a person, not a form.
    'negative-icom-dxengineering-kenwood': 'contact_only',
    // The real DARA scholarship lives inside the ARRL catalog; Hamvention itself is ongoing.
    'negative-dara-hamvention': 'no_application',
    // The one negative record that genuinely ended — hence also the stale-mirror warning.
    'negative-chicago-fm-club': 'discontinued',
  });

  const tierDCtx: NormalizeContext = ctx({
    sourceId: 'manual-tier-d',
    funderId: 'various',
    klass: 'ham_grant',
    tier: 'D',
    verificationMethod: 'manual_curation',
    deadlineInheritsFrom: undefined,
  });

  it('has exactly one expectation per TIER_D_RECORDS externalKey — no record ships unexamined', () => {
    const keys = TIER_D_RECORDS.map((r) => r.externalKey);
    expect(new Set(keys)).toEqual(new Set(Object.keys(EXPECTED_STATUS)));
    expect(keys.length).toBe(Object.keys(EXPECTED_STATUS).length);
  });

  it.each(TIER_D_RECORDS.map((r) => [r.externalKey, r] as const))(
    'computes the researched status for %s',
    (externalKey, record) => {
      const p = normalizeRaw(record, tierDCtx);
      expect(p.trust.status).toBe(EXPECTED_STATUS[externalKey]);
    },
  );

  it('reserves discontinued for the one record that actually ended', () => {
    // AMSAT, ARRL CARI, FlexRadio and DARA/Hamvention are all active organizations; labelling
    // them 'discontinued' would tell a student a live org had shut down.
    const discontinued = Object.entries(EXPECTED_STATUS)
      .filter(([, status]) => status === 'discontinued')
      .map(([key]) => key)
      .sort();
    expect(discontinued).toEqual(['far-farweb-org-compromised', 'negative-chicago-fm-club']);
  });

  it('never computes open for a Tier D record, since none of them is a live cash application', () => {
    for (const record of TIER_D_RECORDS) {
      const p = normalizeRaw(record, tierDCtx);
      expect(p.trust.status, record.externalKey).not.toBe('open');
    }
  });

  it('reads every status straight from rawFields.status — the override, not inference, is what wins', () => {
    for (const record of TIER_D_RECORDS) {
      expect(record.rawFields.status, `${record.externalKey} has no explicit status`).toBe(
        EXPECTED_STATUS[record.externalKey],
      );
    }
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
  const ardcCtx = () =>
    ctx({ sourceId: 'ardc-grants', funderId: 'ardc', klass: 'ham_grant', tier: 'A', deadlineInheritsFrom: undefined });

  /**
   * CLOSE-OUT REVIEW B3, and then its reversal — BOTH pinned against the real bytes.
   *
   * B3 removed ARDC's open-access obligation and 20% indirect cap because `indirect`, `CERN-OHL`
   * and `GPL` appeared in zero ARDC fixture bytes and every `open-source` hit across the eight
   * captured award tables was a grantee's project title. Its removal note said the enumerated
   * licence list "is not on that page either". That note is now out of date in both directions:
   * `ardc-grants.ts` requests https://www.ardc.net/apply/ and
   * .../apply/grant-application-instructions/, both came back 200, both are committed, and the
   * licence list is on the FIRST of the two.
   *
   * The `assertsFromRealArdcBytes` test below re-greps the committed fixtures on every run rather
   * than trusting this comment — which is the discipline the Yaesu "12-month on-air obligation"
   * cost us, having been repeated as established fact while appearing zero times in its capture.
   */
  it('publishes ARDC’s open-access requirement and 20% indirect cap on the record whose pages state them', () => {
    const p = normalizeRaw(raw({ sourceId: 'ardc-grants', externalKey: 'apply' }), ardcCtx());
    expect(p.obligations.licenseObligation).toMatch(
      /all technology, documentation, and other materials produced using ARDC funds must be made freely available to the public/i,
    );
    expect(p.obligations.licenseObligation).toMatch(/CERN Open Hardware License/);
    expect(p.obligations.indirectCostCapPct).toBe(20);
  });

  it('does NOT put the 2026 application terms on ARDC’s past-award year archives', () => {
    // `ardc-grants` also emits eight `past_award` children — histories of money already handed
    // out. The terms live on /apply/, which produced the `apply` record and nothing else, so the
    // entry is keyed per record. A source-level entry would backdate today's licence terms onto
    // grants awarded years ago.
    const p = normalizeRaw(raw({ sourceId: 'ardc-grants', externalKey: '2021-grants' }), ardcCtx());
    expect(p.obligations.licenseObligation).toBeUndefined();
    expect(p.obligations.indirectCostCapPct).toBeUndefined();
  });

  it('leaves ARDC’s cost share UNSTATED, because its only cost-share sentence is conditional', () => {
    // fixtures/ardc-grants/03-apply-instructions.html says "If your organization's indirect cost
    // rate is more than 20%, we ask that you cost-share any indirect amount over 20%". `true`
    // over-states that for an organisation at or under 20%; `false` contradicts the page for one
    // above it. This is precisely the case the third state exists for.
    const p = normalizeRaw(raw({ sourceId: 'ardc-grants', externalKey: 'apply' }), ardcCtx());
    expect(p.obligations.costShareRequired).toBeUndefined();
    expect('costShareRequired' in p.obligations).toBe(false);
  });

  it('finds both ARDC obligations in the committed capture, verbatim, byte for byte', async () => {
    // GREP, DON'T REMEMBER. This is the test the Yaesu sustainment obligation would have failed
    // for months: it asserts the sentence is IN THE FIXTURE, not merely in our table, so the two
    // cannot drift and a re-capture that drops the term breaks the build instead of shipping a
    // stale obligation.
    const root = path.join(fileURLToPath(new URL('../../../../fixtures/ardc-grants/', import.meta.url)));
    const applyPage = await readFile(path.join(root, '02-apply.html'), 'utf8');
    const instructions = await readFile(path.join(root, '03-apply-instructions.html'), 'utf8');
    const flat = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

    expect(flat(applyPage)).toContain(
      'all technology, documentation, and other materials produced using ARDC funds must be made freely available to the public',
    );
    expect(flat(instructions)).toContain('You may include up to 20% for indirect costs');

    // ...and the page each one is NOT on, so a future capture cannot quietly swap them.
    expect(instructions).not.toContain('freely available');
    expect(applyPage.toLowerCase()).not.toContain('indirect');

    const p = normalizeRaw(raw({ sourceId: 'ardc-grants', externalKey: 'apply' }), ardcCtx());
    expect(flat(applyPage)).toContain(
      p.obligations.licenseObligation!.split(' licenses: Software')[0].replace(/\s+/g, ' '),
    );
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

  /**
   * B3's headline. `OBLIGATIONS_BY_SOURCE['yaesu-dr2x']` hard-coded "The repeater must remain on
   * the air for 12 months." onto every Yaesu record. The 145,639-byte real capture contains
   * `twelve` 0 times, `12 month` 0 times, `on the air` 0 times and `remain` 0 times; the sentence
   * lived only in three synthetic fixtures. The obligation is now whatever the PAGE said, parsed
   * into rawFields.sustainment by the Yaesu module — and nothing at all when no page said it.
   */
  it('asserts no Yaesu sustainment obligation when the page states none', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'yaesu-dr2x' }),
      ctx({ sourceId: 'yaesu-dr2x', funderId: 'yaesu-usa', klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
    );
    expect(p.obligations.sustainmentObligation).toBeUndefined();
  });

  it('publishes the funder’s own sentence when a page does state one', () => {
    const sustainment = 'The repeater must remain on the air for twelve months.';
    const p = normalizeRaw(
      raw({ sourceId: 'yaesu-dr2x', rawFields: { sustainment } }),
      ctx({ sourceId: 'yaesu-dr2x', funderId: 'yaesu-usa', klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
    );
    expect(p.obligations.sustainmentObligation).toBe(sustainment);
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

  it('reads Grants.gov’s own costSharing flag, per record, over the table default', () => {
    // fixtures/grants-gov-federal/05-…-fetchopportunity.json carries "costSharing":true for NTIA
    // PWSCIF (opportunityId 363179) in the same synopsis object responseDate comes from. The
    // product published `costShareRequired: false` — the disqualifying direction — because the
    // string `costSharing` appeared nowhere in the codebase.
    const yes = normalizeRaw(
      raw({ sourceId: 'grants-gov-federal', rawFields: { costSharing: 'true' } }),
      ctx({ sourceId: 'grants-gov-federal', funderId: 'federal', klass: 'adjacent_stem', deadlineInheritsFrom: undefined }),
    );
    expect(yes.obligations.costShareRequired).toBe(true);

    const no = normalizeRaw(
      raw({ sourceId: 'grants-gov-federal', rawFields: { costSharing: 'false' } }),
      ctx({ sourceId: 'grants-gov-federal', funderId: 'federal', klass: 'adjacent_stem', deadlineInheritsFrom: undefined }),
    );
    expect(no.obligations.costShareRequired).toBe(false);

    // ...and the THIRD state, which is the one this whole change is about: a hit whose detail leg
    // never ran carries no costSharing key at all, and must therefore answer nothing.
    const silent = normalizeRaw(
      raw({ sourceId: 'grants-gov-federal', rawFields: {} }),
      ctx({ sourceId: 'grants-gov-federal', funderId: 'federal', klass: 'adjacent_stem', deadlineInheritsFrom: undefined }),
    );
    expect(silent.obligations.costShareRequired).toBeUndefined();
    expect('costShareRequired' in silent.obligations).toBe(false);
    expect(obligationState(silent.obligations.costShareRequired)).toBe('unstated');
  });

  it('finds NTIA’s "costSharing":true in the committed capture itself, not only in a hand-made rawField', () => {
    // The bug that started this whole change, pinned at the BYTES: fixtures/grants-gov-federal/
    // 05-…-fetchopportunity.json (opportunityId 363179, NTIA PWSCIF) says true while the product
    // published false. A re-capture that drops the flag now fails here instead of silently
    // reverting the record to "no cost share required". The end-to-end half is asserted in the
    // NTIA PWSCIF describe further down, on the record the production parser actually builds.
    const body = loadFixture('grants-gov-federal', '05-api-grants-gov-v1-api-fetchopportunity.json');
    expect(body).toMatch(/"costSharing"\s*:\s*true/);
  });

  it('carries every §4.6 obligation field a page in this corpus actually states', () => {
    // spec §4.6 models six: licenseObligation, indirectCostCapPct, costShareRequired,
    // coFunderPreference, sustainmentObligation, reportingObligation. Seed records re-enter this
    // same pipeline on "Verify now" (Plan 3 Task 10), so a field no source produces is a field
    // silently dropped — which is why this test enumerates them.
    //
    // ALL SIX are produced again as of 2026-08-03. Close-out review B3 correctly cut this list to
    // four when it found ARDC's `licenseObligation` and `indirectCostCapPct` asserted from a page
    // nothing fetched; `ardc-grants.ts` now fetches BOTH ARDC application pages (HTTP 200,
    // committed), so the two came back with their quotes and this list is six again.
    const produced = new Set<string>();
    const cases: Array<[string, Partial<NormalizeContext>, string, Record<string, string>]> = [
      ['ardc-grants', { funderId: 'ardc', klass: 'ham_grant', tier: 'A' }, 'apply', {}],
      ['arrl-amateur-radio-grants', { funderId: 'arrl-foundation', klass: 'ham_grant' }, 'amateur-radio-grants', {}],
      [
        'yaesu-dr2x',
        { funderId: 'yaesu-usa', klass: 'equipment_in_kind' },
        'dr2x-repeater',
        { sustainment: 'The repeater must remain on the air for twelve months.' },
      ],
      ['ncdxf-grants', { funderId: 'ncdxf', klass: 'ham_grant' }, 'ncdxf-dxpedition-grants', {}],
      ['manual-tier-d', { funderId: 'yasme', klass: 'ham_grant', tier: 'D', verificationMethod: 'manual_curation' }, 'yasme-supporting-grants', {}],
    ];
    for (const [sourceId, over, externalKey, rawFields] of cases) {
      const p = normalizeRaw(
        raw({ sourceId, externalKey, rawFields }),
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

  /**
   * THE HEADLINE COUNT, measured over the whole real corpus rather than argued.
   *
   * With `costShareRequired: false, coFunderPreference: false` as the opening literals of every
   * record, EVERY publishable program published "this funder does not require cost sharing" and
   * "this funder has no co-funder preference" — 150 of 150 records, 144 of which had no funder
   * statement of any kind behind either claim. This test rebuilds the same corpus the profiler
   * uses and asserts that silence now reads as silence.
   */
  it('publishes no cost-share or co-funder answer for a record whose funder gave none', async () => {
    // `loadCorpus` is the profiler's own builder — the same 150 publishable records
    // `npm run profile-corpus` reports, with `isDoNotPublish` and the adjacency gate already
    // applied. Reimplementing the fixture pairing here would let this count drift from the tool
    // every acceptance figure in this plan is measured with.
    const { programs } = await loadCorpus();
    expect(programs.length).toBeGreaterThan(100);

    const stated = (key: 'costShareRequired' | 'coFunderPreference') =>
      programs.filter((p) => p.obligations[key] !== undefined);
    const unstated = (key: 'costShareRequired' | 'coFunderPreference') =>
      programs.filter((p) => obligationState(p.obligations[key]) === 'unstated');

    // Nothing is lost: the records a funder DID answer for still answer.
    const costStated = stated('costShareRequired');
    expect(costStated.length).toBeGreaterThan(0);
    for (const p of costStated) {
      expect(typeof p.obligations.costShareRequired).toBe('boolean');
    }
    const coStated = stated('coFunderPreference');
    expect(coStated.length).toBeGreaterThan(0);

    // ...and every other record now says nothing rather than saying no.
    expect(unstated('costShareRequired').length).toBe(programs.length - costStated.length);
    expect(unstated('coFunderPreference').length).toBe(programs.length - coStated.length);
    expect(unstated('costShareRequired').length).toBeGreaterThan(100);

    // The key is ABSENT, not present-and-undefined: `{...{a: undefined}}` would create it, and it
    // would then serialise into the API response and the SQLite JSON column as an explicit null.
    for (const p of unstated('costShareRequired')) {
      expect('costShareRequired' in p.obligations).toBe(false);
      expect(JSON.stringify(p.obligations)).not.toContain('costShareRequired');
    }
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
    expect(typeof p.rawOtherText).toBe('string');
    // `obligations.costShareRequired` and `.coFunderPreference` used to be asserted `'boolean'`
    // HERE, in the completeness test — which is exactly how the defect was kept alive: a
    // completeness check cannot tell a field that is populated from a field that is invented, and
    // this one demanded the invention. They are optional now, and this record's funder said
    // nothing, so the correct output is nothing.
    expect(p.obligations.costShareRequired).toBeUndefined();
    expect(p.obligations.coFunderPreference).toBeUndefined();
  });

  it('never emits a summary that is a full text dump', () => {
    const long = 'x'.repeat(5000);
    const p = normalizeRaw(raw({ rawText: long }), ctx());
    expect(p.summary.length).toBeLessThanOrEqual(400);
  });
});

/**
 * REMEDIATION 2026-08-03 — `do_not_publish` used to be written for `crosscheck` only, and read by
 * nothing anywhere in the repo. These tests cover the WRITER half (this file); the READER half —
 * proving the tag is actually enforced, and that it stays enforced — lives in `review/index.test.ts`.
 */
describe('do_not_publish: which record types are suppressed', () => {
  const typed = (recordType: string): Program =>
    normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', rawFields: { recordType } }),
      ctx({ sourceId: 'arrl-club-grant', funderId: 'arrl-foundation', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );

  it('stamps the tag on every suppressed record type', () => {
    expect([...SUPPRESSED_RECORD_TYPES].sort()).toEqual(['crosscheck', 'past_award']);
    for (const recordType of SUPPRESSED_RECORD_TYPES) {
      const p = typed(recordType);
      expect(p.tags, `${recordType} must carry its own type tag`).toContain(recordType);
      expect(p.tags, `${recordType} must be suppressed`).toContain(DO_NOT_PUBLISH_TAG);
      expect(isDoNotPublish(p)).toBe(true);
    }
  });

  it('leaves every publishable record type publishable', () => {
    // `verified_negative` and `safety_warning` are the load-bearing cases: "we checked, this does
    // not exist" and "this funder's domain was taken over, do not apply" are answers a searcher
    // most needs to see. Suppressing them would hide the warning.
    for (const recordType of PUBLISHABLE_RECORD_TYPES) {
      const p = typed(recordType);
      expect(p.tags, `${recordType} must not be suppressed`).not.toContain(DO_NOT_PUBLISH_TAG);
      expect(isDoNotPublish(p)).toBe(false);
    }
  });

  it('leaves a record with no recordType at all publishable', () => {
    // The ONE real ARRL Club Grant Program record on the same page as the 37 past recipients.
    expect(isDoNotPublish(normalizeRaw(raw(), ctx()))).toBe(false);
  });

  it('the two classes are disjoint', () => {
    for (const t of SUPPRESSED_RECORD_TYPES) expect(PUBLISHABLE_RECORD_TYPES.has(t)).toBe(false);
  });

  /**
   * INVARIANT, in the shape of `sources/registry.test.ts` ("every module on disk must be
   * registered") and the ARRL prefix-collision table. Every `recordType` literal that any source
   * module on disk actually emits must be classified as either suppressed or publishable. A fifth
   * past-award-style source arriving with a new record type — `historical_award`, say — fails HERE,
   * at the classification, instead of silently defaulting into "publishable" and putting funded
   * history back into the review queue, which is exactly how the original defect behaved.
   */
  it('INVARIANT: every recordType any source emits is explicitly classified', async () => {
    const sourcesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../sources');
    const files = (await readdir(sourcesDir, { recursive: true, withFileTypes: true }))
      // Node 20.11.0 leaves Dirent.parentPath undefined for recursive readdir; `.path` is the
      // older alias. Same accommodation as sources/registry.test.ts.
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
      .map((e) => path.join(e.parentPath ?? e.path ?? sourcesDir, e.name));
    expect(files.length).toBeGreaterThan(10);

    const found = new Map<string, string[]>();
    for (const file of files) {
      for (const m of (await readFile(file, 'utf8')).matchAll(/recordType:\s*'([a-z_]+)'/g)) {
        found.set(m[1], [...(found.get(m[1]) ?? []), path.basename(file)]);
      }
    }

    // Guards against a silently-vacuous pass: if the scan or the regex ever stops finding
    // anything, this fails rather than reporting "all zero record types are classified".
    expect([...found.keys()].sort()).toEqual([
      'crosscheck',
      'guided_workflow',
      'manual',
      'past_award',
      'safety_warning',
      'verified_negative',
    ]);

    const unclassified = [...found.entries()]
      .filter(([t]) => !SUPPRESSED_RECORD_TYPES.has(t) && !PUBLISHABLE_RECORD_TYPES.has(t))
      .map(([t, where]) => `${t} (emitted by ${[...new Set(where)].join(', ')})`);
    expect(unclassified, 'classify this in normalize/index.ts before shipping it').toEqual([]);
  });

  it('all four past_award sources normalize to a suppressed, closed record', () => {
    // arrl-club-grant, ardc-award-tables, nsf-awards and usaspending all stamp recordType
    // past_award. Each comes through a different funder/klass/tier, so each is checked.
    const cases: Array<[string, string, Program['klass']]> = [
      ['arrl-club-grant', 'arrl-foundation', 'ham_grant'],
      ['ardc-award-tables', 'ardc', 'ham_grant'],
      ['nsf-awards', 'nsf', 'adjacent_stem'],
      ['usaspending', 'federal', 'adjacent_stem'],
    ];
    for (const [sourceId, funderId, klass] of cases) {
      const p = normalizeRaw(
        raw({ sourceId, rawFields: { recordType: 'past_award', amountRaw: '$18,000' } }),
        ctx({ sourceId, funderId, klass, deadlineInheritsFrom: undefined }),
      );
      expect(isDoNotPublish(p), `${sourceId} must be suppressed`).toBe(true);
      expect(p.trust.status, `${sourceId} must be closed`).toBe('closed');
    }
  });
});

/**
 * ROUND 4. `applyVia` and `applyUrl` are what Plan 3 renders as the apply button, so a wrong
 * channel wastes a professional's time at exactly the moment they have decided to apply.
 * NCDXF's intake was pinned to `email_pdf_packet` on the strength of the Budget Worksheet alone;
 * the live https://www.ncdxf.org/pages/grant_app.php (fetched 2026-08-03) has BOTH halves:
 *   Part 1  "You can download the Budget Worksheet Here ==>" ... "Create a new email message
 *           addressed to: dxbudget@ncdxf.org" — a spreadsheet, not a PDF, and only half the
 *           application.
 *   Part 2  <form action="ncdxf_grant.php" method="post"> ... "PLEASE FILL OUT THIS FORM
 *           COMPLETELY AND THEN CLICK THE 'SUBMIT APPLICATION' BUTTON" — an ordinary HTML form on
 *           the funder's own site.
 * `page_form` is the half an applicant can complete unaided in a browser, so that is the channel
 * the button points at; the emailed worksheet is not lost, because the parser keeps the funder's
 * own two-part sentence in `applyNote`, which normalizeRaw publishes as `applyContact`.
 */
describe('the NCDXF grant intake is a web form, not only an emailed packet', () => {
  const ncdxfCtx = {
    sourceId: 'ncdxf-grants',
    funderId: 'ncdxf',
    klass: 'ham_grant' as const,
    deadlineInheritsFrom: undefined,
  };

  it('publishes page_form, the channel an applicant can complete unaided', () => {
    const p = normalizeRaw(raw({ sourceId: 'ncdxf-grants', rawFields: {} }), ctx(ncdxfCtx));
    expect(p.applyVia).toBe('page_form');
    expect(p.applyVia).not.toBe('email_pdf_packet');
  });

  it('does not lose the emailed Budget Worksheet half of the application', () => {
    const applyNote =
      'Applications must be made by completing (1) a Budget Worksheet and (2) an Application ' +
      'Form, and submitting both to NCDXF.';
    const p = normalizeRaw(
      raw({ sourceId: 'ncdxf-grants', rawFields: { applyNote } }),
      ctx(ncdxfCtx),
    );
    expect(p.applyContact).toBe(applyNote);
  });

  it('leaves the other pinned apply channels alone', () => {
    const via = (sourceId: string) =>
      normalizeRaw(raw({ sourceId, rawFields: {} }), ctx({ sourceId, deadlineInheritsFrom: undefined }))
        .applyVia;
    expect(via('sara')).toBe('email_pdf_packet');
    expect(via('austin-arc')).toBe('self_hosted_portal');
    expect(via('ardc-grants')).toBe('external_spa_portal');
    expect(via('arrl-etp-grants')).toBe('jotform_year_keyed');
    expect(via('manual-tier-d')).toBe('contact_person');
  });
});

/**
 * CLOSE-OUT REVIEW B2 — the apply button. 116 of 152 published records carried an applyUrl their
 * own funder's page contradicts, because `applyUrl` read `formUrl ?? detailUrl ?? sourceUrl` and
 * two sources write the route under the name `applyUrl`. The value was parsed, asserted by its
 * own source test, and consumed by nothing: the write-only defect class, at the exact field a
 * professional clicks once they have decided to apply.
 */
describe('applyUrl is what the funder’s page names, not the page we scraped', () => {
  const applyUrlOf = (rawFields: Record<string, string>, sourceUrl?: string): string | undefined =>
    normalizeRaw(
      raw({ sourceId: 'qcwa', externalKey: 'qcwa-scholarship', rawFields, ...(sourceUrl ? { sourceUrl } : {}) }),
      ctx({ sourceId: 'qcwa', funderId: 'qcwa', klass: 'ham_scholarship', deadlineInheritsFrom: undefined }),
    ).applyUrl;

  it('publishes QCWA’s stated route — the ARRL Foundation page its own sentence names', () => {
    // fixtures/qcwa/…, verbatim: "Applications are available and completed online via the ARRL
    // Foundation website: https://www.arrl.org/scholarship-descriptions". tier-c-a.ts parses it
    // into rawFields.applyUrl and tier-c-a.test.ts asserts the parse; until this fix the record
    // published https://www.qcwa.org/scholarship-program.htm — the page the reader was on.
    expect(
      applyUrlOf({ applyUrl: 'https://www.arrl.org/scholarship-descriptions' }, 'https://www.qcwa.org/scholarship-program.htm'),
    ).toBe('https://www.arrl.org/scholarship-descriptions');
  });

  it('keeps formUrl and detailUrl working, and prefers the funder’s named route over both', () => {
    expect(applyUrlOf({ formUrl: 'https://form.jotform.com/1' })).toBe('https://form.jotform.com/1');
    expect(applyUrlOf({ detailUrl: 'https://example.org/detail' })).toBe('https://example.org/detail');
    expect(
      applyUrlOf({ applyUrl: 'https://funder.example/apply', formUrl: 'https://form.jotform.com/1' }),
    ).toBe('https://funder.example/apply');
  });

  it('falls back to the source URL only when no page named a route', () => {
    expect(applyUrlOf({}, 'https://www.qcwa.org/scholarship-program.htm')).toBe(
      'https://www.qcwa.org/scholarship-program.htm',
    );
  });
});

/* ============================================================================================
 * APPLICANT ENTITIES — the remediation of write-only-field defect `applicantTypes`, and of the
 * `?? []` behind it.
 *
 * `applicantEntities: ENTITIES_BY_SOURCE[ctx.sourceId] ?? []` collapsed "the funder accepts none
 * of the entities we model" and "nobody has established who may apply" into one value, and
 * `matchProgram` hard-failed on an empty list either way — its own reason string read
 * "(none recorded)". 76 of 197 candidates were unreachable by every profile in the corpus, the
 * single genuinely-open federal call among them, while Grants.gov's real eligibility list sat
 * unread in `rawFields.applicantTypes`.
 *
 * The reading was fixed on 2026-08-12: `matchProgram` answers `unknown` for an unrecorded
 * audience, so an empty list here is no longer a refusal. The tables below still bind — a source
 * that says nothing must SAY that it says nothing — because "nobody established this" is a fact
 * about our research that the corpus has to carry either way.
 * ========================================================================================== */

describe('no source may accept nobody BY ACCIDENT', () => {
  /** Every source that produces candidates. Signal-only sources emit change events, not Programs. */
  const candidateSourceIds = SOURCES.filter((s) => !isSignalSource(s)).map((s) => s.id);

  it('finds the registry it is about to check', () => {
    expect(candidateSourceIds.length).toBeGreaterThan(20);
  });

  it('classifies every candidate-producing source as either known or declared-unknown', () => {
    // THE POINT OF THIS TEST. A new source added with no entity list gets `[]`, which the matcher
    // reads as "accepts nobody" — silently, with no error and no failing test. This is what turns
    // that into a build failure: state the audience, or state that nobody has established it.
    const unclassified = candidateSourceIds
      .filter((id) => ENTITIES_BY_SOURCE[id] === undefined && ENTITIES_UNKNOWN_BY_SOURCE[id] === undefined)
      .sort();
    expect(unclassified).toEqual([]);
  });

  it('never classifies a source both ways', () => {
    const both = Object.keys(ENTITIES_BY_SOURCE).filter((id) => ENTITIES_UNKNOWN_BY_SOURCE[id] !== undefined);
    expect(both).toEqual([]);
  });

  it('keeps both tables honest: no entry for a source that does not exist', () => {
    const known = new Set(SOURCES.map((s) => s.id));
    const stale = [...Object.keys(ENTITIES_BY_SOURCE), ...Object.keys(ENTITIES_UNKNOWN_BY_SOURCE)]
      .filter((id) => !known.has(id))
      .sort();
    expect(stale).toEqual([]);
  });

  it('gives every declared-unknown a real reason, not a placeholder', () => {
    for (const [id, reason] of Object.entries(ENTITIES_UNKNOWN_BY_SOURCE)) {
      expect(reason.length, `${id} needs a reason somebody signed`).toBeGreaterThan(60);
    }
  });

  it('never lets a known list be empty — that is what the unknown table is for', () => {
    for (const [id, entities] of Object.entries(ENTITIES_BY_SOURCE)) {
      expect(entities.length, `${id} has an empty list in the KNOWN table`).toBeGreaterThan(0);
    }
  });
});

describe('entitiesFromApplicantTypes — Grants.gov’s own eligibility list', () => {
  it('is undefined when the source published no list, so the tables decide', () => {
    expect(entitiesFromApplicantTypes(undefined)).toBeUndefined();
    expect(entitiesFromApplicantTypes('   ')).toBeUndefined();
  });

  it('maps the enumerable types it can', () => {
    expect(entitiesFromApplicantTypes('Individuals')).toEqual(['individual']);
    expect(entitiesFromApplicantTypes('Public and State controlled institutions of higher education')).toEqual([
      'university',
      'university_dept',
    ]);
    expect(entitiesFromApplicantTypes('Independent school districts')).toEqual(['school_lea']);
    expect(
      entitiesFromApplicantTypes(
        'Nonprofits having a 501(c)(3) status with the IRS, other than institutions of higher education',
      ),
    ).toEqual(['club_501c3']);
    expect(
      entitiesFromApplicantTypes(
        'Nonprofits that do not have a 501(c)(3) status with the IRS, other than institutions of higher education',
      ),
    ).toEqual(['club_unincorporated']);
  });

  it('unions a multi-type list in a stable order', () => {
    const list =
      'Individuals; Private institutions of higher education; Independent school districts';
    expect(entitiesFromApplicantTypes(list)).toEqual([
      'individual',
      'school_lea',
      'university',
      'university_dept',
    ]);
    // Order comes from the canonical entity order, never from the funder's listing order, so two
    // crawls of the same record cannot produce two contentHashes.
    expect(entitiesFromApplicantTypes(list)).toEqual(
      entitiesFromApplicantTypes(
        'Independent school districts; Private institutions of higher education; Individuals',
      ),
    );
  });

  it('reads "Others (see text…)" as ORGANISATIONS, never as everyone', () => {
    // `Individuals` is itself a value in this vocabulary: a NOFO open to natural persons selects
    // it. "Others" names organisation shapes the list cannot express — confirmed by NTIA PWSCIF's
    // own applicantEligibilityDesc, "The applicant must be organized under the laws of the United
    // States or a State thereof".
    const entities = entitiesFromApplicantTypes(
      'Others (see text field entitled "Additional Information on Eligibility" for clarification)',
    );
    expect(entities).not.toContain('individual');
    expect(entities).not.toContain('teacher');
    expect(entities).toEqual(
      expect.arrayContaining(['university', 'university_dept', 'school_lea', 'club_501c3']),
    );
  });

  it('reads "Unrestricted" as everyone, individuals included — the funder said so in words', () => {
    const entities = entitiesFromApplicantTypes(
      'Unrestricted (i.e., open to any type of entity above), subject to any clarification in text field entitled "Additional Information on Eligibility"',
    );
    expect(entities).toContain('individual');
    expect(entities).toContain('university');
  });

  it('never offers nominated_by_institution, which is not an application route', () => {
    for (const list of ['Unrestricted (i.e., open to any type of entity above)', 'Others (see text)']) {
      expect(entitiesFromApplicantTypes(list)).not.toContain('nominated_by_institution');
    }
  });

  it('is empty when the funder enumerated only types this contract does not model', () => {
    // The funder's own answer, not our silence: a state-government-only call accepts nobody here.
    expect(entitiesFromApplicantTypes('State governments; Small businesses')).toEqual([]);
  });
});

describe('the one genuinely open federal call reaches an applicant (NTIA PWSCIF)', () => {
  // Driven end to end through the production parser against the committed real captures:
  // fixtures/grants-gov-federal/00..04 (search2) plus 05 (fetchOpportunity for opportunity
  // 363179). It is the only hit in 128 that clears ADJACENCY_THRESHOLD, and its detail leg lists
  // exactly one applicant type: Others (see text field entitled "Additional Information on
  // Eligibility" for clarification).
  const SEARCH_URL = 'https://api.grants.gov/v1/api/search2';
  const searchPayloads = [
    '00-api-grants-gov-v1-api-search2.json',
    '01-api-grants-gov-v1-api-search2.json',
    '02-api-grants-gov-v1-api-search2.json',
    '03-api-grants-gov-v1-api-search2.json',
    '04-api-grants-gov-v1-api-search2.json',
  ].map((file) => fixturePayload('grants-gov-federal', file, SEARCH_URL));
  const payloads = [
    ...searchPayloads,
    fixturePayload(
      'grants-gov-federal',
      '05-api-grants-gov-v1-api-fetchopportunity.json',
      'https://api.grants.gov/v1/api/fetchOpportunity',
    ),
  ];
  const raws = grantsGovFederal.parse(payloads);
  const federalCtx = ctx({
    sourceId: 'grants-gov-federal',
    funderId: 'federal',
    klass: 'adjacent_stem',
    tier: 'A',
    deadlineInheritsFrom: undefined,
  });
  const pwscif = normalizeRaw(raws[0], federalCtx);

  const org = (entity: OrgProfile['entity']): OrgProfile => ({ kind: 'organization', entity });

  it('parses exactly the one real open opportunity', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].externalKey).toBe('363179');
    expect(raws[0].rawFields.applicantTypes).toMatch(/^Others \(see text field/);
  });

  it('no longer publishes an empty applicant-entity list', () => {
    expect(pwscif.applicantEntities).not.toEqual([]);
  });

  it('reaches a university and a school applicant — the profiles this NOFO is actually for', () => {
    expect(matchProgram(org('university'), pwscif, NOW).kind).not.toBe('ineligible');
    expect(matchProgram(org('school_lea'), pwscif, NOW).kind).not.toBe('ineligible');
    expect(matchProgram(org('club_501c3'), pwscif, NOW).kind).not.toBe('ineligible');
  });

  it('publishes NTIA’s own cost-share requirement, end to end from the capture', () => {
    // `"costSharing":true` sits in the same JSON object `parseOpportunityDetail` reads
    // `responseDate` out of. The product used to publish `costShareRequired: false` here — the
    // disqualifying direction, on the single federal opportunity in the corpus a real applicant
    // can reach. This asserts the value the PRODUCTION parser produces, not a synthetic rawField.
    expect(raws[0].rawFields.costSharing).toBe('true');
    expect(pwscif.obligations.costShareRequired).toBe(true);
    expect(obligationState(pwscif.obligations.costShareRequired)).toBe('yes');
  });

  it('publishes the funder’s own window, not a table sentence', () => {
    expect(pwscif.deadline.note).toContain('2026-07-14');
    expect(pwscif.deadline.note).toContain('2026-09-09');
    expect(pwscif.deadline.kind).toBe('ad_hoc');
    expect(pwscif.trust.status).toBe('open'); // closes 2026-09-09, after NOW
  });
});

describe('NCDXF grants: a live ham grant that no profile could reach', () => {
  it('accepts the individuals and groups its own page names', () => {
    // fixtures/ncdxf-grants/00-www-ncdxf-org-pages-grant-app-html.html, the `audience` field the
    // parser already extracted: "individuals and groups who use amateur radio communications to
    // advance and promote education, science and international goodwill."
    const p = normalizeRaw(
      raw({ sourceId: 'ncdxf-grants', externalKey: 'ncdxf-grant-program', rawFields: {} }),
      ctx({ sourceId: 'ncdxf-grants', funderId: 'ncdxf', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.applicantEntities).toContain('individual');
    expect(p.applicantEntities).toContain('club_unincorporated');
    expect(p.applicantEntities).not.toEqual([]);
  });
});

describe('a per-record applicant list outranks the per-source table', () => {
  it('uses what the funder published over what we researched about the source', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ariss', rawFields: { applicantTypes: 'Individuals' } }),
      ctx({ sourceId: 'ariss', funderId: 'ariss-usa', klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
    );
    expect(p.applicantEntities).toEqual(['individual']);
  });

  it('falls back to the table when the record carries no list', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ariss', rawFields: {} }),
      ctx({ sourceId: 'ariss', funderId: 'ariss-usa', klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
    );
    expect(p.applicantEntities).toEqual(['school_lea', 'university']);
  });
});

describe('observed dates do not disturb the calendar', () => {
  /** Owner + one dependent, exactly as the corpus's 112 inheriting candidates are shaped. */
  const owner = (): Program =>
    normalizeRaw(
      raw({
        sourceId: 'arrl-scholarship-program',
        externalKey: 'scholarship-program',
        name: 'ARRL Foundation Scholarship Program',
        rawFields: { status: 'closed', window: 'The 2026 Scholarship Cycle is now closed.' },
        rawText: 'The 2026 Scholarship Cycle is now closed.',
      }),
      // REMEDIATION (2026-08-03): this fixture used to pin the owner's id by hand
      // (`existingIdFor: () => 'arrl-foundation-scholarships'`), which is precisely how the
      // dangling-reference defect stayed invisible for 37 commits — the dependent and the owner
      // agreed because the test made them agree. The owner now mints its id exactly as the crawl
      // does, and the dependent has to find it on its own.
      ctx({ sourceId: 'arrl-scholarship-program', deadlineInheritsFrom: undefined }),
    );
  const dependent = (): Program => normalizeRaw(raw(), ctx());
  const FROM = '2027-01-01T00:00:00.000Z';
  const TO = '2027-12-31T23:59:59.999Z';

  it('still projects the owner’s cycle', () => {
    const all = [owner(), dependent()];
    expect(expandCycles(all[0], all, FROM, TO).length).toBeGreaterThan(0);
  });

  it('still lets the dependent ride it, and inheriting a CLOSED cycle stays correct', () => {
    const all = [owner(), dependent()];
    expect(all[0].trust.status).toBe('closed');
    const cycles = expandCycles(all[1], all, FROM, TO);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles.every((c) => c.programId === all[1].id)).toBe(true);
  });

  it('converges identically whether the owner or the dependent is seen first', () => {
    // The order-independence property `review/index.ts`'s backfill exists to guarantee, checked
    // at the seam this change actually touches: the same corpus in either order must project the
    // same rows.
    const ownerFirst = [owner(), dependent()];
    const dependentsFirst = [dependent(), owner()];
    const project = (all: Program[], p: Program) => expandCycles(p, all, FROM, TO);
    expect(project(dependentsFirst, dependentsFirst[0])).toEqual(project(ownerFirst, ownerFirst[1]));
    expect(project(dependentsFirst, dependentsFirst[1])).toEqual(project(ownerFirst, ownerFirst[0]));
  });

  it('projects the same cycles when the owner also states an observed window', () => {
    const withObserved = normalizeRaw(
      raw({
        sourceId: 'arrl-scholarship-program',
        externalKey: 'scholarship-program',
        name: 'ARRL Foundation Scholarship Program',
        rawFields: { opensAt: '2026-10-30', closesAt: '2026-12-30' },
      }),
      // REMEDIATION (2026-08-03): this fixture used to pin the owner's id by hand
      // (`existingIdFor: () => 'arrl-foundation-scholarships'`), which is precisely how the
      // dangling-reference defect stayed invisible for 37 commits — the dependent and the owner
      // agreed because the test made them agree. The owner now mints its id exactly as the crawl
      // does, and the dependent has to find it on its own.
      ctx({ sourceId: 'arrl-scholarship-program', deadlineInheritsFrom: undefined }),
    );
    const plain = owner();
    expect(expandCycles(withObserved, [withObserved], FROM, TO)).toEqual(
      expandCycles(plain, [plain], FROM, TO),
    );
    expect(withObserved.deadline.note).toContain('2026-12-30');
  });
});
