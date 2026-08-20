/**
 * Corpus profiler — "what does the matcher actually tell a real applicant?"
 *
 *   npm run profile-corpus              # all profiles, summary + per-axis
 *   npm run profile-corpus -- --detail  # ...plus every excluded program by name
 *   npm run profile-corpus -- ee-undergrad
 *
 * Why this exists: Plan 2's whole-branch review found the matcher's worst defects not by unit
 * test but by running the REAL matcher over the REAL corpus with a plausible applicant and
 * reading the output. Every round that tested only the reported case declared victory early.
 * This is that sweep, kept as a tool so the measurement can be repeated after any change to
 * matcher.ts or to any extractor in packages/server/src/normalize/axes/.
 *
 * It is a DEV TOOL, not shipped library code. It deliberately reaches into BOTH packages —
 * core for the matcher, server for source loading and normalization — which is exactly why it
 * lives at the repo root next to verify-sources.ts and capture-fixture.ts rather than inside
 * either package. spec §14 purity binds packages/core/src, which may never import node: or
 * reach into server; nothing under scripts/ is compiled into a published package surface.
 *
 * The corpus is built OFFLINE from the committed fixtures, never from the network, so the
 * numbers are reproducible and comparing two runs is meaningful. Sources whose only committed
 * fixture is a synthetic `pathological.*` file are skipped and listed, so under-coverage is
 * visible rather than silent.
 *
 * WHAT THIS MEASURES (remediation 2026-08-03). The corpus is the set of programs the product
 * would actually SHOW, not everything `normalizeRaw` can produce. Those differ: `do_not_publish`
 * records — past awards and cross-check-only rows — are stored deliberately (a funder's grant
 * history is the best evidence of who that funder funds) but are suppressed by
 * `buildReviewItems`, so no user ever sees them as opportunities. Until this fix the profiler
 * counted every produced record, and as real fixtures landed its corpus grew from 178 to 742
 * while 545 of those 742 were records the product suppresses — so every eligibility figure taken
 * with it was measured against a population that does not exist for a user, which is worse than
 * having no tool at all.
 *
 * ...AND THE SAME LESSON, LEARNED TWICE (close-out review, 2026-08-03). `buildReviewItems` applies
 * TWO suppression gates, one immediately below the other, and this file applied only the first.
 * The second is the ADJACENCY GATE: a candidate whose source scored it below
 * `ADJACENCY_THRESHOLD` never reaches the review queue either, and all 45 `nsf-funding-rss`
 * records — Gravitational Physics, Chemical Oceanography, SBIR — score 0 or 1 against a threshold
 * of 6. So the tool reported a corpus of 197 where a user can reach 152: a 23% over-report, in the
 * instrument every acceptance figure in this plan was measured with. An over-reporting measuring
 * tool is worse than none, because it manufactures confidence.
 *
 * NEITHER RULE IS REIMPLEMENTED HERE. `isDoNotPublish` (normalize/index.ts) and
 * `isBelowAdjacencyThreshold` (review/index.ts) are imported from the product — the same two
 * predicates `buildReviewItems` calls, in the same order — so the tool and the product cannot
 * drift. If a new suppressed record type is classified there, or the threshold moves, this
 * profiler follows in the same commit. That is the discipline the `isDoNotPublish` fix
 * established; missing the gate beside it is what it cost to only half-apply it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  FetchRequest,
  FetchedPayload,
  OrgProfile,
  Profile,
  Program,
  RawOpportunity,
  StudentProfile,
} from '../packages/core/src/index.js';
import { matchAll } from '../packages/core/src/matcher.js';
import { contextForSource } from '../packages/server/src/crawl/context.js';
import { isDoNotPublish, normalizeRaw } from '../packages/server/src/normalize/index.js';
import { isBelowAdjacencyThreshold } from '../packages/server/src/review/index.js';
import { SOURCES } from '../packages/server/src/sources/registry.js';
import {
  hasFollowUp,
  isSignalSource,
  resolveRequests,
} from '../packages/server/src/sources/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'fixtures');
/** Fixed so two runs of this tool differ only by the code under test. */
export const PROFILE_NOW_ISO = '2026-08-02T00:00:00.000Z';

const CONTENT_TYPE: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/rss+xml; charset=utf-8',
  '.b64': 'application/zip',
};

/**
 * Fixtures captured before the NN- naming convention existed. Each entry names the request
 * whose URL the payload must carry (some parsers key off payload.url), by index into the
 * source's resolved request list.
 */
const LEGACY_FIXTURES: Record<string, Array<{ file: string; requestIndex: number }>> = {
  'nsf-awards': [{ file: 'awards-response.json', requestIndex: 0 }],
  usaspending: [{ file: 'spending-by-award.json', requestIndex: 0 }],
  'grants-gov-federal': [{ file: 'search2-response.json', requestIndex: 0 }],
};

/**
 * Re-exported so this tool's own test can assert against the SAME predicates the product enforces
 * rather than a copy of the rules. Importing them from anywhere else would be the drift this fix
 * exists to prevent.
 */
export { isBelowAdjacencyThreshold, isDoNotPublish };

/**
 * The relevance score a scoring source wrote for this record, as a number, or `undefined` for the
 * sources that compute none — which is every ham-specific source and means "not scored", not "zero".
 *
 * This mirrors `crawl/runner.ts`'s private `adjacencyScores`, which is the production caller that
 * hands the score to `buildReviewItems`, and it is the one line of that path that cannot be
 * imported: the runner builds a `Map` keyed by minted program id inside `runSource`. The DECISION
 * — what counts as below the threshold, and that exactly-threshold passes — is imported, not
 * restated. `profile-corpus.test.ts` pins this pair against the real corpus so the two cannot
 * separate silently.
 */
function adjacencyScoreOf(raw: RawOpportunity): number | undefined {
  const written = raw.rawFields.adjacencyScore;
  if (written === undefined) return undefined;
  const score = Number(written);
  return Number.isFinite(score) ? score : undefined;
}

export interface CorpusLoad {
  /** Publishable programs only: what the review queue would let a user see. */
  programs: Program[];
  /** Per source: publishable programs, and how many each gate took out. */
  loaded: Array<{ sourceId: string; programs: number; suppressed: number; belowAdjacency: number }>;
  skipped: Array<{ sourceId: string; why: string }>;
  /** Total records normalize produced that carry `do_not_publish` and were excluded above. */
  suppressed: number;
  /**
   * The records that count above, kept rather than only counted (added 2026-08-04 for `e2e/seed.ts`).
   *
   * They are stored evidence — past ARDC/NSF/USAspending awards, the ARRL clubs already funded —
   * and every read surface in the product refuses them by name: `reindexBrowse`, the opportunity
   * detail route, the watchlist and the calendar each call `isDoNotPublish` before showing a
   * record. That refusal is only testable end-to-end against a database that actually holds one,
   * and the detail route DID answer 200 for all of them until someone put one in front of it.
   * Carrying the array costs nothing (they were already normalized) and re-deriving it elsewhere
   * would be the second copy of the gate this file exists to prevent.
   */
  suppressedPrograms: Program[];
  /** Total records excluded by the adjacency gate — real opportunities, just not for a radio club. */
  belowAdjacency: number;
}

function payloadFor(sourceId: string, file: string, url: string): FetchedPayload {
  return {
    url,
    status: 200,
    contentType: CONTENT_TYPE[path.extname(file)] ?? 'text/plain',
    body: readFileSync(path.join(FIXTURE_ROOT, sourceId, file), 'utf8'),
    fetchedAt: PROFILE_NOW_ISO,
  };
}

/**
 * WHAT EACH SOURCE'S COMMITTED FIXTURES PARSE TO, before any normalization or suppression.
 *
 * Split out of `loadCorpus` (2026-08-14) so that `seed/constraintProvenance.test.ts` can read the
 * FUNDER'S OWN CAPTURED TEXT — `RawOpportunity.rawText`, which `normalizeRaw` consumes and does not
 * carry forward whole — through this loader rather than a second copy of it. The fixture-to-request
 * pairing here is not obvious (positional `NN-` ordering, a follow-up phase, three legacy names,
 * the signal-source skip), and a second implementation of it in a test would be a guard measuring
 * a corpus slightly different from the one the product is measured on. `loadCorpus` now calls this
 * and normalizes what it returns; nothing about its output changed.
 *
 * `hasCapture` is the one fact a provenance check cannot do without: `manual-tier-d` produces its
 * records from a hand-written array in the module, so its `rawText` is GrantSpotter's own research
 * brief, not a funder's page. Checking a quotation against it would be checking our prose against
 * our prose and calling the pass evidence. Sources with no `NN-` fixture file are therefore marked
 * here as carrying no capture, and provenance over them is UNMEASURABLE rather than satisfied.
 */
export interface SourceRaws {
  sourceId: string;
  /** True when the source's records come from committed captures of the funder's own pages. */
  hasCapture: boolean;
  raws: RawOpportunity[];
}

export interface RawLoad {
  bySource: SourceRaws[];
  skipped: Array<{ sourceId: string; why: string }>;
}

async function buildRawOpportunities(): Promise<RawLoad> {
  const bySource: SourceRaws[] = [];
  const skipped: RawLoad['skipped'] = [];

  for (const source of SOURCES) {
    const dir = path.join(FIXTURE_ROOT, source.id);
    const captured = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /^\d\d-/.test(f))
          .sort()
      : [];
    let requests: FetchRequest[] = [];
    try {
      requests = await resolveRequests(source);
    } catch (err) {
      skipped.push({ sourceId: source.id, why: `requests() threw: ${String(err)}` });
      continue;
    }

    const payloads: FetchedPayload[] = [];
    if (captured.length > 0) {
      const firstPhase = captured.slice(0, requests.length);
      firstPhase.forEach((file, i) => {
        payloads.push(payloadFor(source.id, file, requests[i]?.url ?? `file:///${file}`));
      });
      const rest = captured.slice(firstPhase.length);
      if (rest.length > 0 && hasFollowUp(source)) {
        const followUps = source.followUp(payloads);
        rest.forEach((file, i) => {
          payloads.push(payloadFor(source.id, file, followUps[i]?.url ?? `file:///${file}`));
        });
      }
    } else {
      for (const legacy of LEGACY_FIXTURES[source.id] ?? []) {
        const url = requests[legacy.requestIndex]?.url ?? `file:///${legacy.file}`;
        payloads.push(payloadFor(source.id, legacy.file, url));
      }
    }

    if (payloads.length === 0 && requests.length > 0) {
      skipped.push({ sourceId: source.id, why: `${requests.length} live request(s), no real fixture` });
      continue;
    }
    if (isSignalSource(source)) {
      skipped.push({ sourceId: source.id, why: 'signal-only source: produces change events, not candidates' });
      continue;
    }

    let raws;
    try {
      raws = source.parse(payloads);
    } catch (err) {
      skipped.push({ sourceId: source.id, why: `parse threw: ${String(err)}` });
      continue;
    }
    bySource.push({ sourceId: source.id, hasCapture: payloads.length > 0, raws });
  }

  return { bySource, skipped };
}

/**
 * Every candidate Program the committed fixtures can produce, normalized exactly as the crawler
 * does, MINUS the records the review queue suppresses — BOTH gates, in the product's own order
 * (see the file header). Both excluded counts are carried out rather than silently dropped, so the
 * tool reports what it left out instead of quietly shrinking or, as it did until this fix, quietly
 * inflating.
 */
async function buildCorpus(): Promise<CorpusLoad> {
  const programs: Program[] = [];
  const suppressedPrograms: Program[] = [];
  const loaded: CorpusLoad['loaded'] = [];
  let suppressed = 0;
  let belowAdjacency = 0;

  const { bySource, skipped } = await loadRawOpportunities();
  for (const { sourceId, raws } of bySource) {
    const source = SOURCES.find((s) => s.id === sourceId);
    if (source === undefined) continue;
    const ctx = contextForSource(source, PROFILE_NOW_ISO);
    const produced = raws.map((raw) => normalizeRaw(raw, ctx));
    // The two suppressions the product applies, applied here with the product's own predicates,
    // in `buildReviewItems`'s own order. A past award or a cross-check row is stored evidence,
    // never an opportunity; a sub-threshold federal record is a real opportunity that is not one
    // for a radio club. Measuring eligibility over records no user can ever be shown makes every
    // figure below a fiction — in the first case by 545 records, in the second by 45.
    const publishable: Program[] = [];
    let suppressedHere = 0;
    let gatedHere = 0;
    produced.forEach((program, i) => {
      if (isDoNotPublish(program)) {
        suppressedHere += 1;
        suppressedPrograms.push(program);
        return;
      }
      const raw = raws[i];
      if (raw !== undefined && isBelowAdjacencyThreshold(adjacencyScoreOf(raw))) {
        gatedHere += 1;
        return;
      }
      publishable.push(program);
    });
    programs.push(...publishable);
    suppressed += suppressedHere;
    belowAdjacency += gatedHere;
    loaded.push({
      sourceId: source.id,
      programs: publishable.length,
      suppressed: suppressedHere,
      belowAdjacency: gatedHere,
    });
  }

  return { programs, suppressedPrograms, loaded, skipped, suppressed, belowAdjacency };
}

// ------------------------------------------------- the memo, and why it is safe

/**
 * BOTH LOADERS ABOVE ARE BUILT ONCE PER PROCESS. This is the fix for a whole class of CI timeout,
 * not for the one test that happened to fail.
 *
 * MEASURED, on this repo, pinned to two cores with busy loops competing for them (the only way the
 * failure reproduces — both versions pass in isolation, which is what made it look flaky rather
 * than structural):
 *
 *     loadRawOpportunities   cold 1508 ms   warm  980 ms      <- re-read and re-parsed every capture
 *     loadCorpus             cold 1879 ms   warm 1807 ms      <- and re-normalized every record
 *
 * Nothing was cached, so "warm" cost what "cold" cost. Twenty-five test files call one or both of
 * these, several of them more than once, and vitest's default per-test budget is 5,000 ms. CI run
 * 32411910577 went red on `seed/constraintProvenance.test.ts`, whose first fixture rule pays for
 * BOTH loaders inside its own budget: 5,707 ms measured here under contention, against 5,000. It
 * was the second failure of this exact shape — `spec-vs-sentence.test.ts`'s R1 was the first, and
 * was fixed by hoisting `loadCorpus` into that one file's `beforeAll`. Hoisting per file treats a
 * symptom per file. The loaders being uncached is the cause, so the memo lives here.
 *
 * WHY A MEMO IS SOUND HERE, AND WHERE IT WOULD NOT BE. Both loaders are pure functions of files
 * that are COMMITTED — `fixtures/**` and the source registry — read through `readFileSync` at call
 * time. Nothing in the suite rewrites either during a run: the two tests that build fixture trees
 * (`scripts/generate-arrl-seed.test.ts`) and seed directories (`seed/import.test.ts`) both write
 * into `mkdtempSync` roots under the OS temp dir and point the code under test at those, never at
 * `REPO_ROOT`. Verified by grep over every `writeFileSync`/`mkdirSync`/`rmSync` in the tree. If a
 * test ever does need to edit `fixtures/` and re-load, this memo becomes wrong and that test needs
 * an explicit invalidation hook — it does not get to rely on the loader having been slow.
 *
 * The memo is PER PROCESS, and vitest isolates each test file in its own module registry, so it is
 * in practice per test file: no state crosses a file boundary that did not cross one before.
 */
let rawLoadMemo: Promise<RawLoad> | undefined;
let corpusMemo: Promise<CorpusLoad> | undefined;

/**
 * AND THE SHARED RESULT CANNOT BE MUTATED, which is the half of a memo that turns a slow suite
 * into a lying one.
 *
 * Before the memo, most callers got a private copy; now every caller in a file shares one object
 * graph. A single `programs.sort()` or `program.constraints.push(...)` anywhere would leak between
 * tests and the suite would go green on state the previous test left behind. So the answer is not
 * "the consumers were read and none of them mutate" — that is a claim with a shelf life of one
 * commit. `Object.freeze`, applied to everything reachable, makes the mutation impossible: these
 * modules are ESM and therefore strict, so a write to a frozen object THROWS at the offending line
 * rather than being silently dropped.
 *
 * Reading the consumers came first and agreed: all twenty-five build their own arrays and push into
 * those, `plant()` in `src/test/axesCorpora.ts` spreads rather than assigns, and every `.sort()` in
 * them is on the result of a `.map()`/`.filter()`. The freeze is what keeps that true.
 *
 * `Program` and `RawOpportunity` are plain JSON-shaped records — no `Map`, `Set` or `Date` on
 * either — so walking `Object.values` reaches everything, and `seen` keeps the walk finite where
 * `normalizeRaw` hands several records the SAME module-level constant (`RESTRICTIONS_BY_SOURCE`,
 * `AI_POLICY_BY_FUNDER`). Those constants are frozen too, which is correct and slightly wider than
 * this file: they are shared by every record already, so anything that mutated one was corrupting
 * its siblings before this change and only now says so.
 */
function deepFreeze<T>(value: T, seen: Set<unknown>): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner, seen);
  return Object.freeze(value);
}

/** {@link buildRawOpportunities}, once per process, frozen. See the note above. */
export function loadRawOpportunities(): Promise<RawLoad> {
  rawLoadMemo ??= buildRawOpportunities().then((load) => deepFreeze(load, new Set()));
  return rawLoadMemo;
}

/** {@link buildCorpus}, once per process, frozen. See the note above. */
export function loadCorpus(): Promise<CorpusLoad> {
  corpusMemo ??= buildCorpus().then((load) => deepFreeze(load, new Set()));
  return corpusMemo;
}

// ---------------------------------------------------------------- profiles

export interface NamedProfile {
  key: string;
  label: string;
  profile: Profile;
}

const student = (over: Partial<StudentProfile>): StudentProfile => ({ kind: 'student', ...over });
const org = (over: Partial<OrgProfile>): OrgProfile => ({
  kind: 'organization',
  entity: 'club_501c3',
  ...over,
});

export const PROFILES: NamedProfile[] = [
  {
    key: 'ee-undergrad',
    label:
      'licensed EE undergraduate — General class since 2022, BSEE at an accredited 4-year in TX, ' +
      'full-time, 3.6 GPA, US citizen, ARRL member since 2022, age 20, female, financial need',
    profile: student({
      callsign: 'K5EXAMPLE',
      licenseClass: 'GENERAL',
      licensedSince: '2022-06-01T00:00:00.000Z',
      state: 'TX',
      callDistrict: '5',
      fieldOfStudy: 'Electrical Engineering',
      degreeLevel: 'BACH',
      institution: 'A State University',
      accredited: true,
      partTime: false,
      gpa: 3.6,
      arrlMemberSince: '2022-06-01T00:00:00.000Z',
      citizenship: 'US_CITIZEN',
      birthDate: '2006-03-01T00:00:00.000Z',
      stage: 'UNDERGRAD',
      activityKinds: ['club_member', 'on_air'],
      financialNeed: true,
      gender: 'female',
    }),
  },
  {
    key: 'hs-unlicensed',
    label:
      'unlicensed high-school senior — no callsign, undeclared major, accredited HS in OH, age 17, ' +
      'male, financial need',
    profile: student({
      licenseClass: 'NONE',
      state: 'OH',
      degreeLevel: 'BACH',
      accredited: true,
      partTime: false,
      gpa: 3.2,
      citizenship: 'US_CITIZEN',
      birthDate: '2009-01-15T00:00:00.000Z',
      stage: 'HS_SENIOR',
      financialNeed: true,
      gender: 'male',
    }),
  },
  {
    key: 'grad-nontechnical',
    label:
      'licensed graduate student, non-technical major — Extra class since 2015, MA in Music ' +
      'Performance at an accredited university in NY, full-time, 3.8 GPA, age 25, male',
    profile: student({
      callsign: 'W2EXAMPLE',
      licenseClass: 'EXTRA',
      licensedSince: '2015-05-01T00:00:00.000Z',
      state: 'NY',
      callDistrict: '2',
      fieldOfStudy: 'Music Performance',
      degreeLevel: 'GRAD',
      accredited: true,
      partTime: false,
      gpa: 3.8,
      arrlMemberSince: '2016-01-01T00:00:00.000Z',
      citizenship: 'US_CITIZEN',
      birthDate: '2001-02-01T00:00:00.000Z',
      stage: 'GRAD',
      activityKinds: ['contesting', 'on_air'],
      gender: 'male',
    }),
  },
  {
    key: 'adult-parttime',
    label:
      'licensed adult returning to school part-time — Tech class since 2024, part-time AAS in ' +
      'Electronics Technology at an accredited community college in FL, age 41, financial need',
    profile: student({
      callsign: 'W4EXAMPLE',
      licenseClass: 'TECH',
      licensedSince: '2024-02-01T00:00:00.000Z',
      state: 'FL',
      callDistrict: '4',
      fieldOfStudy: 'Electronics Technology',
      degreeLevel: 'ASSOC',
      accredited: true,
      partTime: true,
      gpa: 3.4,
      citizenship: 'US_CITIZEN',
      birthDate: '1985-07-09T00:00:00.000Z',
      stage: 'RETRAINING_ADULT',
      activityKinds: ['club_member'],
      financialNeed: true,
      gender: 'male',
    }),
  },
  {
    key: 'cert-trade',
    label:
      'licensed certificate/vocational student — Technician class since 2023, Avionics & ' +
      'Communications certificate at an accredited trade school in AZ, full-time, 3.5 GPA, US ' +
      'citizen, age 20, financial need — exercises the CWops trade/art/professional-school fix',
    profile: student({
      callsign: 'K7EXAMPLE',
      licenseClass: 'TECH',
      licensedSince: '2023-09-01T00:00:00.000Z',
      state: 'AZ',
      callDistrict: '7',
      fieldOfStudy: 'Avionics and Communications Technology',
      degreeLevel: 'CERT',
      institution: 'A Technical Institute',
      accredited: true,
      partTime: false,
      gpa: 3.5,
      citizenship: 'US_CITIZEN',
      birthDate: '2006-01-10T00:00:00.000Z',
      stage: 'UNDERGRAD',
      activityKinds: ['on_air', 'club_member'],
      cwWpm: 20,
      financialNeed: true,
      gender: 'female',
    }),
  },
  {
    key: 'radio-club',
    label:
      'ARRL-affiliated 501(c)(3) radio club — 45 members, repeater/EmComm-focused, in WA, applying ' +
      'for the ARRL Club Grant Program, ARRL Amateur Radio Grants, and the Yaesu DR-2X discount — ' +
      'the org-facing population the individual profiles above can never see',
    profile: org({
      entity: 'club_501c3',
      orgName: 'A Community Amateur Radio Club',
      callsign: 'W7EXAMPLE',
      state: 'WA',
      is501c3: true,
      hasFiscalSponsor: false,
      arrlAffiliated: true,
      memberCount: 45,
    }),
  },
  {
    key: 'school-org',
    label:
      'public middle school (LEA) with an amateur radio club, in MN, applying as an institution — ' +
      'never as an individual — for programs like ARISS, the ARRL ETP, and ARDC/NASA CSLI grants',
    profile: org({
      entity: 'school_lea',
      orgName: 'A Public Middle School',
      state: 'MN',
      is501c3: false,
      arrlAffiliated: false,
      memberCount: 20,
      institutionName: 'A Public School District',
    }),
  },
];

// ---------------------------------------------------------------- reporting

interface ProfileReport {
  eligible: number;
  eligiblePreferred: number;
  unknown: number;
  ineligible: number;
  /** Names of everything the applicant may apply for — the list this product exists to produce. */
  eligibleNames: string[];
  byAxis: Map<string, Array<{ program: string; detail: string }>>;
  byMissingField: Map<string, number>;
}

function axisOf(reasonId: string, axis: string): string {
  return reasonId.endsWith(':applicant-entity') ? 'applicant_entity' : axis;
}

function describeSpec(spec: { axis: string } & Record<string, unknown>): string {
  switch (spec.axis) {
    case 'field_of_study':
      return `fields=${JSON.stringify(spec.fields)} excluded=${JSON.stringify(spec.excludedFields)}`;
    case 'geography':
      return `geo=${JSON.stringify(spec.geo)}`;
    case 'license':
      return `licenseMin=${String(spec.licenseMin)} heldMonthsMin=${String(spec.heldMonthsMin ?? 0)}`;
    case 'institution':
      return `degreeLevels=${JSON.stringify(spec.degreeLevels)} partTimeOK=${String(spec.partTimeOK)} accreditationRequired=${String(spec.accreditationRequired)}`;
    case 'gpa':
      return `min=${String(spec.min)} classRankTopPct=${String(spec.classRankTopPct)}`;
    case 'citizenship':
      return `allowed=${JSON.stringify(spec.allowed)}`;
    case 'age_stage':
      return `ageMin=${String(spec.ageMin)} ageMax=${String(spec.ageMax)} stages=${JSON.stringify(spec.stages)}`;
    default:
      return JSON.stringify(spec);
  }
}

function profileCorpus(profile: Profile, programs: Program[]): ProfileReport {
  const report: ProfileReport = {
    eligible: 0,
    eligiblePreferred: 0,
    unknown: 0,
    ineligible: 0,
    eligibleNames: [],
    byAxis: new Map(),
    byMissingField: new Map(),
  };
  const byId = new Map(programs.map((p) => [p.id, p]));

  for (const [id, verdict] of matchAll(profile, programs, PROFILE_NOW_ISO)) {
    const name = byId.get(id)?.name ?? id;
    if (verdict.kind === 'eligible' || verdict.kind === 'eligible_preferred') {
      report.eligibleNames.push(name);
    }
    if (verdict.kind === 'eligible') report.eligible += 1;
    else if (verdict.kind === 'eligible_preferred') report.eligiblePreferred += 1;
    else if (verdict.kind === 'unknown') {
      report.unknown += 1;
      for (const field of verdict.missingProfileFields) {
        report.byMissingField.set(field, (report.byMissingField.get(field) ?? 0) + 1);
      }
    } else {
      report.ineligible += 1;
      for (const reason of verdict.reasons) {
        const axis = axisOf(reason.id, reason.spec.axis);
        const bucket = report.byAxis.get(axis) ?? [];
        bucket.push({
          program: name,
          detail: `${describeSpec(reason.spec as never)}  raw=${JSON.stringify(reason.rawText.slice(0, 140))}`,
        });
        report.byAxis.set(axis, bucket);
      }
    }
  }
  return report;
}

function printReport(named: NamedProfile, report: ProfileReport, detail: boolean): void {
  const total = report.eligible + report.eligiblePreferred + report.unknown + report.ineligible;
  console.log(`\n--- ${named.key} ---`);
  console.log(`    ${named.label}`);
  console.log(
    `    ELIGIBLE ${report.eligible + report.eligiblePreferred} (${report.eligible} plain + ${report.eligiblePreferred} preferred)` +
      `   INELIGIBLE ${report.ineligible}   UNKNOWN ${report.unknown}   of ${total} candidate(s)`,
  );

  const axes = [...report.byAxis.entries()].sort((a, b) => b[1].length - a[1].length);
  if (axes.length > 0) {
    console.log('    exclusions by axis (one program can be excluded on several axes):');
    for (const [axis, hits] of axes) console.log(`      ${axis.padEnd(18)} ${hits.length}`);
  }
  const missing = [...report.byMissingField.entries()].sort((a, b) => b[1] - a[1]);
  if (missing.length > 0) {
    console.log('    unknown, by missing profile field:');
    for (const [field, n] of missing) console.log(`      ${field.padEnd(18)} ${n}`);
  }
  if (!detail) return;
  console.log(`\n    == eligible (${report.eligibleNames.length}) ==`);
  for (const name of report.eligibleNames) console.log(`      ${name}`);
  for (const [axis, hits] of axes) {
    console.log(`\n    == ${axis} (${hits.length}) ==`);
    for (const hit of hits) console.log(`      ${hit.program}\n        ${hit.detail}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const detail = args.includes('--detail');
  const wanted = args.filter((a) => !a.startsWith('--'));

  const { programs, loaded, skipped, suppressed, belowAdjacency } = await loadCorpus();
  console.log('=== GrantSpotter corpus profile ===');
  console.log(
    `now: ${PROFILE_NOW_ISO}   corpus: ${programs.length} publishable program(s) from committed fixtures ` +
      `(${suppressed} do_not_publish + ${belowAdjacency} below the adjacency threshold excluded, ` +
      `${programs.length + suppressed + belowAdjacency} normalized in total)`,
  );
  for (const entry of loaded) {
    const notes = [
      entry.suppressed > 0 ? `+${entry.suppressed} suppressed` : '',
      entry.belowAdjacency > 0 ? `+${entry.belowAdjacency} below adjacency threshold` : '',
    ].filter((n) => n !== '');
    const note = notes.length > 0 ? `   (${notes.join(', ')}, not shown to users)` : '';
    console.log(`  loaded  ${entry.sourceId.padEnd(38)} ${entry.programs}${note}`);
  }
  for (const entry of skipped) console.log(`  skipped ${entry.sourceId.padEnd(38)} ${entry.why}`);

  const selected = wanted.length > 0 ? PROFILES.filter((p) => wanted.includes(p.key)) : PROFILES;
  if (selected.length === 0) {
    console.error(`no such profile. known: ${PROFILES.map((p) => p.key).join(', ')}`);
    process.exitCode = 2;
    return;
  }
  for (const named of selected) {
    const open = programs.filter((p) =>
      p.applicantEntities.includes(named.profile.kind === 'student' ? 'individual' : named.profile.entity),
    );
    console.log(`\n(${open.length} of ${programs.length} candidates accept this applicant entity)`);
    printReport(named, profileCorpus(named.profile, open), detail);
  }
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('profile-corpus.ts')) {
  await main();
}
