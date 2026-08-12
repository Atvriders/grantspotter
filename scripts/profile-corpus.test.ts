import { beforeAll, describe, expect, it } from 'vitest';
import { matchProgram } from '../packages/core/src/matcher.js';
import { makeStudent } from '../packages/core/test/fixtures.js';
import { ADJACENCY_THRESHOLD } from '../packages/server/src/federal/adjacency.js';
import {
  isBelowAdjacencyThreshold,
  isDoNotPublish,
  loadCorpus,
  PROFILE_NOW_ISO,
  PROFILES,
} from './profile-corpus.js';

/**
 * ONE LOAD FOR THE FILE, AND IT IS SETUP RATHER THAN PART OF ANY TEST'S BUDGET.
 *
 * `loadCorpus` re-parses every committed fixture on every call and memoizes nothing: MEASURED on
 * this host on 2026-08-12 on two cores, 2,351 ms for the first test in this file and about 1,650 ms
 * for EACH of the five after it, because each one called it again. Six loads of the same immutable
 * fixtures, every one of them inside a 5,000 ms default test timeout that the assertions around it
 * need almost none of. `axes/spec-vs-sentence.test.ts` carries the measurement and the argument;
 * it is the file where this went over the line on a two-core runner.
 *
 * SHARED BECAUSE THE CORPUS IS BUILT FROM COMMITTED FILES AND NOTHING HERE WRITES TO IT — every
 * test below reads counts and filters lists. The eleven axis test files have shared one load per
 * file since they were written.
 */
let cached: ReturnType<typeof loadCorpus> | undefined;
function corpus(): ReturnType<typeof loadCorpus> {
  cached ??= loadCorpus();
  return cached;
}

beforeAll(async () => {
  await corpus();
}, 120_000);

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
    const { programs, loaded, suppressed, belowAdjacency } = await corpus();

    // The whole point: not one suppressed record survives into the measured corpus.
    expect(programs.filter((p) => isDoNotPublish(p))).toEqual([]);

    // Real counts, from the committed fixtures. 748 records normalize; 553 are suppressed as
    // past awards / cross-check rows and 45 more fall under the adjacency gate, leaving 150 the
    // product would actually show. These move when fixtures land — update them, do not soften
    // them, and check WHICH source moved: `loaded` carries the split per source.
    //
    // 149 -> 150 on 2026-08-03: `ardc-grants` gained the apply leg (fixtures/ardc-grants/
    // 02-apply.html + 03-apply-instructions.html, captured live at HTTP 200). ARDC's eight year
    // archives stay suppressed — `suppressed` is unchanged at 553 — and the one record added is
    // the application itself, which is the only thing this funder has ever had to offer and which
    // no source fetched until then.
    expect(suppressed).toBe(553);
    expect(belowAdjacency).toBe(45);
    expect(programs).toHaveLength(150);
    expect(programs.length + suppressed + belowAdjacency).toBe(748);
    expect(loaded.find((e) => e.sourceId === 'ardc-grants')).toEqual({
      sourceId: 'ardc-grants',
      programs: 1,
      suppressed: 8,
      belowAdjacency: 0,
    });

    // The canonical case from the do_not_publish fix: the ARRL club-grant page yields the ONE
    // real ARRL Club Grant Program plus 37 clubs that have already RECEIVED money.
    expect(loaded.find((e) => e.sourceId === 'arrl-club-grant')).toEqual({
      sourceId: 'arrl-club-grant',
      programs: 1,
      suppressed: 37,
      belowAdjacency: 0,
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
 * REMEDIATION 2026-08-03 (close-out review) — the SECOND gate, and the 23% over-report.
 *
 * `buildReviewItems` suppresses twice: `isDoNotPublish`, and immediately below it the adjacency
 * gate. `loadCorpus` applied the first and not the second, so it reported a corpus of 197 where a
 * user could reach 152 — in the tool every acceptance figure in this plan was measured with, whose
 * own header promises its corpus is "the set of programs the product would actually SHOW". The
 * profile numerators did not move (all 45 gated records carry empty `applicantEntities`, so no
 * profile could ever see them); every denominator did, and every rate quoted against the corpus
 * was inflated by 23%.
 *
 * These tests pin the gate as SHARED rather than copied. `isBelowAdjacencyThreshold` is the
 * product's own function, re-exported by the tool; if `review/index.ts` changes the rule — or the
 * off-by-one at exactly-threshold — the tool changes with it, and if somebody re-expresses the
 * comparison locally instead, the boundary cases below are what fails.
 */
describe('scripts/profile-corpus — the adjacency gate is the product’s, not a copy of it', () => {
  it('excludes every nsf-funding-rss record, because none of them is adjacent', async () => {
    const { programs, loaded } = await corpus();
    // A real capture of the three NSF funding feeds: 45 items, best score 1 against a threshold
    // of 6 (Gravitational Physics, Chemical Oceanography, SBIR). Real open solicitations — just
    // not for a radio club, which is why the gate and not `do_not_publish` is what removes them.
    expect(loaded.find((e) => e.sourceId === 'nsf-funding-rss')).toEqual({
      sourceId: 'nsf-funding-rss',
      programs: 0,
      suppressed: 0,
      belowAdjacency: 45,
    });
    expect(programs.filter((p) => p.tags.includes('source:nsf-funding-rss'))).toEqual([]);
  });

  it('keeps the record that scores EXACTLY the threshold — the gate’s only true positive', async () => {
    const { programs } = await corpus();
    // NTIA's Public Wireless Supply Chain Innovation Fund scores exactly ADJACENCY_THRESHOLD, so
    // an off-by-one in a re-expressed gate would empty the federal sweep of the one open federal
    // call in the whole corpus and nothing else would look different.
    expect(programs.map((p) => p.name)).toContain(
      'Public Wireless Supply Chain Innovation Fund Grant Program – Solutions for AI-Native RAN',
    );
  });

  it('applies the product’s predicate at the boundary, including “not scored” ≠ “zero”', () => {
    expect(isBelowAdjacencyThreshold(ADJACENCY_THRESHOLD)).toBe(false);
    expect(isBelowAdjacencyThreshold(ADJACENCY_THRESHOLD - 1)).toBe(true);
    expect(isBelowAdjacencyThreshold(0)).toBe(true);
    // Every ham-specific source computes no score at all; an absent score is not a low one, and
    // reading it as 0 would delete all but the federal corner of this corpus.
    expect(isBelowAdjacencyThreshold(undefined)).toBe(false);
  });
});

/**
 * REMEDIATION 2026-08-03 (follow-on) — the profiler's four canned applicants were all
 * individuals, and none was a certificate/vocational student. Two real defects hid behind that
 * blind spot: the CWops Scholarship's trade/art/professional-school disjunct (fixed in commit
 * ec64293) had no profile that could ever exercise it, and a quarter of the publishable
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
    const { programs } = await corpus();
    const cwops = programs.find((p) => p.name === 'The CWops Scholarship');
    if (cwops === undefined) throw new Error('The CWops Scholarship is missing from the corpus');
    expect(matchProgram(certTrade, cwops, PROFILE_NOW_ISO)).toEqual({ kind: 'eligible' });
  });

  it('radio-club (club_501c3) opens exactly the club-facing subset, never the individual-facing programs', async () => {
    const club = findProfile('radio-club').profile;
    expect(club).toMatchObject({ kind: 'organization', entity: 'club_501c3' });

    const { programs } = await corpus();
    const open = programs.filter((p) => p.applicantEntities.includes('club_501c3'));
    expect(open.map((p) => p.name).sort()).toEqual([
      'ARRL Amateur Radio Grants',
      'ARRL Club Grant Program',
      // ARDC's own <h1>, on https://www.ardc.net/apply/ — the application page the pipeline did
      // not fetch until 2026-08-03, which is why the largest funder in this corpus was reachable
      // by nobody while its eight year-archives were (correctly) suppressed.
      'Apply for a Grant',
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
    //
    // STRENGTHENED 2026-08-12, because the assertion was weaker than the sentence above it. It
    // read `.not.toBe('ineligible')`, which `unknown` satisfies — so the paragraph claimed
    // ELIGIBLE and the check permitted "we could not tell". That is the exact shape a verdict
    // change slips through: the entity-gate fix the same day moved 19 records from `ineligible`
    // to `unknown` across this corpus, and a `not.toBe('ineligible')` over a set that happened to
    // include one of them would have gone on passing while the claim it guards became false.
    // Measured: all six are `eligible`, so the assertion can say what the comment says.
    //
    // MOVED AGAIN 2026-08-12, and the paragraph above is why it had to. "None of these records
    // carries either constraint" was true and understated: none of them carries ANY constraint,
    // and `eligible` was therefore being read out of an empty list — the record stating no
    // requirement, and the product answering "you meet them all". Round eight made that the same
    // `unknown` an unrecorded AUDIENCE already produced: unresolved, with nothing the reader could
    // fill in, and never a refusal. The gate — which is what this test is about — is unmoved, and
    // the assertion stays an exact equality rather than the `not.toBe('ineligible')` it was
    // strengthened away from, so a future change still cannot slip past it.
    for (const program of open) {
      const verdict = matchProgram(club, program, PROFILE_NOW_ISO);
      expect(verdict.kind, program.name).not.toBe('ineligible');
      expect(verdict, program.name).toEqual(
        program.constraints.length === 0
          ? { kind: 'unknown', missingProfileFields: [] }
          : { kind: 'eligible' },
      );
    }
    // ...and the reason is the record, not the club: all six state nothing at all.
    expect(open.filter((p) => p.constraints.length > 0)).toEqual([]);
  });

  it('school-org (school_lea) can see ARISS, which never accepts an individual applicant', async () => {
    const { programs } = await corpus();
    const ariss = programs.find((p) => p.name === 'ARISS-USA ISS Contact Proposal');
    if (ariss === undefined) throw new Error('ARISS-USA ISS Contact Proposal is missing from the corpus');
    expect(ariss.applicantEntities).toEqual(['school_lea', 'university']);

    // The exact blind spot this profile closes: no individual profile, however constructed,
    // could ever pass the applicant-entity gate on this program.
    const refused = matchProgram(makeStudent(), ariss, PROFILE_NOW_ISO);
    expect(refused.kind).toBe('ineligible');
    // ...and that refusal is a real one, from a list somebody researched — not the empty list that
    // used to refuse everybody. `ariss.applicantEntities` above is what makes it real; this is
    // the verdict side of the same fact.
    if (refused.kind !== 'ineligible') throw new Error('unreachable');
    expect(refused.reasons.map((c) => c.spec.axis)).toEqual(['other']);

    const school = findProfile('school-org').profile;
    expect(school).toMatchObject({ kind: 'organization', entity: 'school_lea' });
    // Same strengthening as above: `not.toBe('ineligible')` also admits `unknown`, and the point
    // of this test is that the school CAN see it — so the exact verdict is asserted, and the
    // exact verdict is now the "nothing was recorded" `unknown`. ARISS publishes real eligibility
    // rules and this record holds none of them; the school is not refused, and is not told it
    // qualifies either.
    expect(ariss.constraints).toEqual([]);
    expect(matchProgram(school, ariss, PROFILE_NOW_ISO)).toEqual({
      kind: 'unknown',
      missingProfileFields: [],
    });
  });
});
