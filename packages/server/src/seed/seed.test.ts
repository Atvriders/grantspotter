/**
 * The seed corpus, as shipped. Data-driven on purpose: every batch Tasks 12-16 add is covered by
 * this file automatically, and `loadSeedCorpus` runs the validation harness (validate.ts), so a
 * batch that ships a fact no page supports fails at import time here rather than in production.
 *
 * The harness's own rejection proofs live in `validate.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { Profile, Program } from '@grantspotter/core';
import { RECURRENCE_PREFIX, expandCycles, matchProgram } from '@grantspotter/core';
import { assertNotBlocked } from '../fetcher/blocklist.js';
import { SEED_LAST_VERIFIED, loadSeedCorpus, seedDir } from './load.js';

const corpus = loadSeedCorpus(seedDir());
const byId = new Map(corpus.programs.map((p) => [p.id, p]));

const STUDENT: Profile = {
  kind: 'student', callsign: 'W8UM', licenseClass: 'GENERAL', licensedSince: '2021-05-01',
  state: 'MI', fieldOfStudy: 'Electrical Engineering', degreeLevel: 'BACH',
  institution: 'University of Michigan', accredited: true, partTime: false, gpa: 3.4,
  citizenship: 'US_CITIZEN', birthDate: '2006-04-02', stage: 'UNDERGRAD',
  activityKinds: ['club_member', 'field_day'], financialNeed: true, gender: 'female',
};
const ORG: Profile = {
  kind: 'organization', entity: 'club_501c3', orgName: 'Example University Radio Club',
  callsign: 'W1EXA', state: 'MA', is501c3: true, hasFiscalSponsor: false,
  arrlAffiliated: true, memberCount: 24, institutionName: 'Example University',
};
const EMPTY_STUDENT: Profile = { kind: 'student' };

describe('seed corpus', () => {
  it('loads at least one funder and one program', () => {
    expect(corpus.funders.length).toBeGreaterThan(0);
    expect(corpus.programs.length).toBeGreaterThan(0);
  });

  it('has unique funder ids and unique program ids', () => {
    expect(new Set(corpus.funders.map((f) => f.id)).size).toBe(corpus.funders.length);
    expect(new Set(corpus.programs.map((p) => p.id)).size).toBe(corpus.programs.length);
  });

  it('resolves every program funderId to a real funder', () => {
    const ids = new Set(corpus.funders.map((f) => f.id));
    const orphans = corpus.programs.filter((p) => !ids.has(p.funderId)).map((p) => p.id);
    expect(orphans).toEqual([]);
  });

  it('computes a content hash for every record', () => {
    for (const program of corpus.programs) {
      expect(program.trust.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('stamps every record with the research date and seed_import provenance', () => {
    for (const program of corpus.programs) {
      expect(program.trust.lastVerifiedAt).toBe(SEED_LAST_VERIFIED);
      expect(['seed_import', 'manual_curation']).toContain(program.trust.verificationMethod);
    }
  });

  it('never contains a URL on a blocklisted host', () => {
    for (const funder of corpus.funders) assertNotBlocked(funder.homepage);
    for (const program of corpus.programs) {
      assertNotBlocked(program.trust.sourceUrl);
      if (program.applyUrl) assertNotBlocked(program.applyUrl);
      if (program.aiPolicy.url) assertNotBlocked(program.aiPolicy.url);
      for (const claim of program.trust.disputed?.claims ?? []) assertNotBlocked(claim.sourceUrl);
    }
  });

  it('never contains a private LAN address or a host filesystem path', () => {
    const json = JSON.stringify(corpus);
    expect(json).not.toMatch(/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(json).not.toMatch(/\b192\.168\.\d{1,3}\.\d{1,3}\b/);
    expect(json).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
  });

  it('keeps every summary a short excerpt, not a page dump', () => {
    for (const program of corpus.programs) {
      expect(program.summary.length).toBeGreaterThan(0);
      expect(program.summary.length).toBeLessThanOrEqual(600);
    }
  });

  it('runs every record through the matcher without throwing, for three profile shapes', () => {
    for (const profile of [STUDENT, ORG, EMPTY_STUDENT]) {
      for (const program of corpus.programs) {
        const verdict = matchProgram(profile, program);
        expect(['eligible', 'eligible_preferred', 'ineligible', 'unknown']).toContain(verdict.kind);
      }
    }
  });

  it('never returns ineligible purely because a profile field is missing', () => {
    for (const program of corpus.programs) {
      const verdict = matchProgram(EMPTY_STUDENT, program);
      if (verdict.kind === 'ineligible') {
        // An empty profile may only be excluded by a constraint that is genuinely
        // unsatisfiable for a student, never by absent data.
        expect(verdict.reasons.length).toBeGreaterThan(0);
        for (const reason of verdict.reasons) expect(reason.hard).toBe(true);
      }
    }
  });

  it('keeps soft constraints out of the exclusion path by construction', () => {
    for (const program of corpus.programs) {
      for (const constraint of program.constraints) {
        expect(typeof constraint.hard).toBe('boolean');
        expect(Number.isInteger(constraint.fallbackRank)).toBe(true);
        expect(constraint.rawText.length).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * RESOLUTIONS R12 / CONTRACT §10.1. CONTRACT §3 freezes DeadlineSpec as {kind, source, note},
 * so recurrence parameters travel inside `note` in Plan 1's RECUR micro-format. If the seed
 * omits it, expandCycles returns nothing, the calendar is silently empty for the three most
 * important programs in the corpus, and no other test notices.
 */
describe('the RECUR micro-format is actually emitted', () => {
  const FROM = '2026-08-02T00:00:00.000Z';
  const TO = '2028-08-02T00:00:00.000Z';
  const PROJECTABLE = ['ardc-grants', 'arrl-amateur-radio-grants', 'arrl-foundation-scholarships'];

  it('carries a RECUR directive on all three projectable anchors', () => {
    for (const id of PROJECTABLE) {
      const program = byId.get(id);
      expect(program, `missing seed record ${id}`).toBeDefined();
      expect(program!.deadline.note.startsWith(RECURRENCE_PREFIX), id).toBe(true);
    }
  });

  it('expands each of them into at least one cycle', () => {
    for (const id of PROJECTABLE) {
      const cycles = expandCycles(byId.get(id)!, corpus.programs, FROM, TO);
      expect(cycles.length, `${id} produced no cycles`).toBeGreaterThan(0);
      for (const cycle of cycles) expect(cycle.isEstimated).toBe(true);
    }
  });

  it('gives ARDC its four fixed dates a year and ARRL Amateur Radio Grants its three windows', () => {
    // Plan 1 labels a projected fixed date "Feb 1, 2027 deadline" and stores closesAt as the
    // UTC instant of local end-of-day, so the label is what to assert on, not the ISO string.
    const ardc = expandCycles(
      byId.get('ardc-grants')!, corpus.programs,
      '2027-01-01T00:00:00.000Z', '2027-12-31T23:59:59.999Z',
    );
    expect(ardc.map((c) => c.label)).toEqual([
      'Feb 1, 2027 deadline',
      'Apr 1, 2027 deadline',
      'Jul 1, 2027 deadline',
      'Sep 1, 2027 deadline',
    ]);
    // THE TIMEZONE CLAIM, spelled out on real data: a deadline is 23:59 LOCAL, and the stored
    // instant is that wall time in the funder's own zone. ARDC is America/Los_Angeles, so its
    // February 1 closes at 2027-02-02T07:59Z — a UTC instant on the SECOND of February.
    expect(ardc[0].timezone).toBe('America/Los_Angeles');
    expect(ardc[0].closesAt).toBe('2027-02-02T07:59:00.000Z');

    const arg = expandCycles(
      byId.get('arrl-amateur-radio-grants')!, corpus.programs,
      '2027-01-01T00:00:00.000Z', '2027-12-31T23:59:59.999Z',
    );
    expect(arg).toHaveLength(3);
    expect(arg.every((c) => c.opensAt !== undefined && c.closesAt !== undefined)).toBe(true);
  });

  /**
   * Task 15 generates 111 catalog entries whose `deadline.source` is
   * `{ kind: 'inherited', fromProgramId: 'arrl-foundation-scholarships' }`. Until that batch
   * lands the corpus holds none, and an assertion over an empty list is the "green suite that
   * checks nothing" defect this repo has closed five times. So the MECHANISM is proven here
   * against a dependant built in this test — which is what makes it a real assertion today —
   * and every inherited record actually present is checked alongside it.
   */
  it('lets an inherited catalog entry resolve its cycle through the seeded owner', () => {
    const owner = byId.get('arrl-foundation-scholarships');
    expect(owner, 'the catalog parent must exist for 111 entries to inherit from it').toBeDefined();
    const dependant: Program = {
      ...owner!,
      id: 'probe-inherited-entry',
      deadline: {
        kind: 'inherited',
        source: { kind: 'inherited', fromProgramId: 'arrl-foundation-scholarships' },
        note: 'Rides the ARRL Foundation Scholarship Program cycle.',
      },
    };
    const viaOwner = expandCycles(dependant, [...corpus.programs, dependant], FROM, TO);
    expect(viaOwner.length).toBeGreaterThan(0);
    expect(viaOwner[0].programId).toBe('probe-inherited-entry');
    expect(viaOwner[0].label).toContain('via ARRL Foundation Scholarship Program');

    for (const program of corpus.programs.filter((p) => p.deadline.source.kind === 'inherited')) {
      expect(expandCycles(program, corpus.programs, FROM, TO).length, program.id).toBeGreaterThan(0);
    }
  });
});

describe('crawler identity (sourceKey)', () => {
  /**
   * Two records will legitimately have no sourceKey once Tasks 12 and 13 land: the `austin-arc`
   * module emits one page-level record while the seed splits Austin ARC into Copeland and
   * Greenwood, and the `ieee-mtts` module emits only its chapter-support record while the seed
   * also carries the MTT-S student awards. Duplicating a pair would violate Plan 1's partial
   * unique index on (source_id, external_key); inventing one no parser emits would fail to
   * reconcile while looking correct. Task 16 asserts the exact pair; this asserts that nothing
   * ELSE ever joins them.
   */
  const DOCUMENTED_EXCEPTIONS = ['austin-arc-greenwood', 'ieee-mtt-s-student-awards'];

  it('gives a sourceKey to every record except the two documented exceptions', () => {
    const missing = corpus.programs
      .filter((p) => !corpus.sourceKeys.has(p.id))
      .map((p) => p.id)
      .sort();
    expect(missing.filter((id) => !DOCUMENTED_EXCEPTIONS.includes(id))).toEqual([]);
  });

  it('never lets two records claim the same crawler identity', () => {
    const composites = [...corpus.sourceKeys.values()].map((k) => `${k.sourceId}|${k.externalKey}`);
    expect(new Set(composites).size).toBe(composites.length);
  });

  it('names only source ids Plan 2 actually registers', () => {
    const known = new Set([
      'ardc-grants', 'arrl-amateur-radio-grants', 'arrl-club-grant', 'arrl-etp-grants',
      'arrl-foundation-special-funds',
      'arrl-scholarship-program', 'arrl-scholarship-descriptions', 'qcwa', 'ylrl', 'austin-arc',
      'sara', 'ncdxf-grants', 'ncdxf-scholarships', 'ariss', 'ieee-mtts',
      'ieee-student-branch-rebate', 'nasa-csli', 'yaesu-dr2x', 'manual-tier-d',
    ]);
    for (const [programId, key] of corpus.sourceKeys) {
      expect(known.has(key.sourceId), `${programId} names unknown source ${key.sourceId}`).toBe(true);
    }
  });
});
