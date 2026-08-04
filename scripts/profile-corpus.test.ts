import { describe, expect, it } from 'vitest';
import { matchProgram } from '../packages/core/src/matcher.js';
import { makeStudent } from '../packages/core/test/fixtures.js';
import { isDoNotPublish, loadCorpus, PROFILE_NOW_ISO, PROFILES } from './profile-corpus.js';

/**
 * The tests for `scripts/profile-corpus.ts` — the dev tool every matcher fix in this remediation
 * has been judged with.
 *
 * WHY THEY ARE HERE NOW. They used to live in `packages/core/test/matcher.test.ts`, a different
 * package, importing `../../../scripts/profile-corpus.js`, because no vitest project covered
 * `scripts/` at all: `vitest.workspace.ts` listed only `packages/{core,server,web}`, so a test
 * file next to the tool it tests would have been collected by nobody and `npm test` would have
 * stayed green while running none of it. That hole is now closed by `scripts/vitest.config.ts`,
 * and `packages/server/test/vitestCoverageContract.test.ts` fails if it — or one like it — ever
 * reopens. The tests moved back to the code they are about.
 */

/**
 * REMEDIATION 2026-08-03 — the measuring tool measured the wrong population.
 *
 * `scripts/profile-corpus.ts` built its corpus from `normalizeRaw` and kept EVERY record,
 * including the ones the review queue suppresses — past awards and cross-check rows, which are
 * stored on purpose as evidence of who a funder funds but are never shown as opportunities. As
 * real fixtures landed its corpus grew to 742, of which 545 were suppressed records. Numbers taken
 * over a population that no user can ever see are worse than no numbers at all.
 */
describe('scripts/profile-corpus — the corpus is what the product would show', () => {
  it('excludes every do_not_publish record, and reports how many it excluded', async () => {
    const { programs, loaded, suppressed } = await loadCorpus();

    // The whole point: not one suppressed record survives into the measured corpus.
    expect(programs.filter((p) => isDoNotPublish(p))).toEqual([]);

    // Real counts, from the committed fixtures. 742 records normalize; 545 of them are
    // suppressed (544 `past_award` + the 1 `crosscheck` row), leaving 197 the product would
    // actually show. These move when fixtures land — update them, do not soften them, and
    // check WHICH source moved: `loaded` carries the split per source.
    expect(suppressed).toBe(545);
    expect(programs).toHaveLength(197);
    expect(programs.length + suppressed).toBe(742);

    // The canonical case from the do_not_publish fix: the ARRL club-grant page yields the ONE
    // real ARRL Club Grant Program plus 37 clubs that have already RECEIVED money.
    expect(loaded.find((e) => e.sourceId === 'arrl-club-grant')).toEqual({
      sourceId: 'arrl-club-grant',
      programs: 1,
      suppressed: 37,
    });
    // ...and the three sources that are ENTIRELY past awards contribute nothing to show.
    for (const sourceId of ['ardc-award-tables', 'nsf-awards', 'usaspending']) {
      const entry = loaded.find((e) => e.sourceId === sourceId);
      expect(entry?.programs, `${sourceId} publishes nothing`).toBe(0);
      expect(entry?.suppressed, `${sourceId} is all past awards`).toBeGreaterThan(0);
    }
  });
});

/**
 * REMEDIATION 2026-08-03 (follow-on) — the profiler's four canned applicants were all
 * individuals, and none was a certificate/vocational student. Two real defects hid behind that
 * blind spot: the CWops Scholarship's trade/art/professional-school disjunct (fixed in commit
 * ec64293) had no profile that could ever exercise it, and 76 of the corpus's 197 publishable
 * programs are org-facing (club/school/university) and were never matched against anything —
 * which is exactly the population the `do_not_publish` bug (37 ARRL club-grant past recipients,
 * 424 ARDC award rows, 45 USAspending and 38 NSF historical awards, all publishable) landed on.
 * `PROFILES` in scripts/profile-corpus.ts now also carries `cert-trade` (a licensed
 * certificate-program student) and two organisation profiles, `radio-club` (a club_501c3) and
 * `school-org` (a school_lea) — see that file for the full rationale.
 */
describe('scripts/profile-corpus — the certificate and organisation profiles close the gap', () => {
  const findProfile = (key: string) => {
    const found = PROFILES.find((p) => p.key === key);
    if (found === undefined) throw new Error(`no profile named "${key}" in PROFILES`);
    return found;
  };

  it('carries exactly the four original profiles plus the three new ones', () => {
    expect(PROFILES.map((p) => p.key)).toEqual([
      'ee-undergrad',
      'hs-unlicensed',
      'grad-nontechnical',
      'adult-parttime',
      'cert-trade',
      'radio-club',
      'school-org',
    ]);
  });

  it('cert-trade is a certificate-level student, eligible for the CWops Scholarship end to end', async () => {
    const certTrade = findProfile('cert-trade').profile;
    expect(certTrade.kind).toBe('student');
    if (certTrade.kind !== 'student') throw new Error('unreachable');
    expect(certTrade.degreeLevel).toBe('CERT');

    // Not a synthetic program: the REAL CWops record from the committed fixture, so this proves
    // the institution-axis fix (TRADE_SCHOOL_DISJUNCT in institution.ts) actually reaches a
    // certificate applicant, not just that the fix's own unit test is satisfied.
    const { programs } = await loadCorpus();
    const cwops = programs.find((p) => p.name === 'The CWops Scholarship');
    if (cwops === undefined) throw new Error('The CWops Scholarship is missing from the corpus');
    expect(matchProgram(certTrade, cwops, PROFILE_NOW_ISO)).toEqual({ kind: 'eligible' });
  });

  it('radio-club (club_501c3) opens exactly the club-facing subset, never the 121 individual-facing programs', async () => {
    const club = findProfile('radio-club').profile;
    expect(club).toMatchObject({ kind: 'organization', entity: 'club_501c3' });

    const { programs } = await loadCorpus();
    const open = programs.filter((p) => p.applicantEntities.includes('club_501c3'));
    expect(open.map((p) => p.name).sort()).toEqual([
      '2025 Grants',
      '2026 Grants',
      'ARRL Amateur Radio Grants',
      'ARRL Club Grant Program',
      'HamSCI Personal Space Weather Station Expansion',
      // Both added by the applicant-entity remediation in normalize/index.ts, and both were
      // reachable by NOBODY before it. NCDXF's grant guidelines name their own audience —
      // "individuals and groups who use amateur radio communications…" — and had no
      // ENTITIES_BY_SOURCE entry at all; the NTIA call carries Grants.gov's real applicantTypes
      // ("Others (see text…)"), which maps to the organisation entities and never to an
      // individual. A club is exactly who both are for.
      'NCDXF Grant Program',
      'Public Wireless Supply Chain Innovation Fund Grant Program – Solutions for AI-Native RAN',
      'Yaesu System Fusion DR-2X Repeater Program',
    ]);

    // Every one of them accepts this club outright: matches.ts only ever evaluates `geography`
    // and `arrl_membership` for an organisation (every other axis is NOT_EVALUABLE for a
    // non-student profile), and none of these records carries either constraint in the
    // committed fixtures — so a correctly-typed, US-based, ARRL-affiliated club is eligible for
    // all of them. That is a real, code-verified reading of matchProgram, not an assumption.
    for (const program of open) {
      expect(matchProgram(club, program, PROFILE_NOW_ISO).kind).not.toBe('ineligible');
    }
  });

  it('school-org (school_lea) can see ARISS, which never accepts an individual applicant', async () => {
    const { programs } = await loadCorpus();
    const ariss = programs.find((p) => p.name === 'ARISS-USA ISS Contact Proposal');
    if (ariss === undefined) throw new Error('ARISS-USA ISS Contact Proposal is missing from the corpus');
    expect(ariss.applicantEntities).toEqual(['school_lea', 'university']);

    // The exact blind spot this profile closes: no individual profile, however constructed,
    // could ever pass the applicant-entity gate on this program.
    expect(matchProgram(makeStudent(), ariss, PROFILE_NOW_ISO).kind).toBe('ineligible');

    const school = findProfile('school-org').profile;
    expect(school).toMatchObject({ kind: 'organization', entity: 'school_lea' });
    expect(matchProgram(school, ariss, PROFILE_NOW_ISO).kind).not.toBe('ineligible');
  });
});
