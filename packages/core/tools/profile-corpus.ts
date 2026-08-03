/**
 * Corpus profiler — "what does the matcher actually tell a real applicant?"
 *
 *   npx tsx packages/core/tools/profile-corpus.ts            # all profiles, summary + per-axis
 *   npx tsx packages/core/tools/profile-corpus.ts --detail   # ...plus every excluded program by name
 *   npx tsx packages/core/tools/profile-corpus.ts ee-undergrad
 *
 * Why this exists: Plan 2's whole-branch review found the matcher's worst defects not by unit
 * test but by running the REAL matcher over the REAL corpus with a plausible applicant and
 * reading the output. Every round that tested only the reported case declared victory early.
 * This is that sweep, kept as a tool so the measurement can be repeated after any change to
 * matcher.ts or to any extractor in packages/server/src/normalize/axes/.
 *
 * It is a DEV TOOL, not shipped library code. It deliberately reaches into packages/server
 * (source loading, normalization) which packages/core/src may never do — spec §14 purity applies
 * to packages/core/src only, and tsconfig.build.json only compiles src/**, so nothing here can
 * leak into the published @grantspotter/core surface. Its natural long-term home is the
 * repo-root scripts/ directory next to verify-sources.ts and capture-fixture.ts; it lives here
 * only because packages/core was the territory of the task that wrote it.
 *
 * The corpus is built OFFLINE from the committed fixtures, never from the network, so the
 * numbers are reproducible and comparing two runs is meaningful. Sources whose only committed
 * fixture is a synthetic `pathological.*` file are skipped and listed, so under-coverage is
 * visible rather than silent.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchRequest, FetchedPayload, Profile, Program, StudentProfile } from '../src/index.js';
import { matchAll } from '../src/matcher.js';
import { contextForSource } from '../../server/src/crawl/context.js';
import { normalizeRaw } from '../../server/src/normalize/index.js';
import { SOURCES } from '../../server/src/sources/registry.js';
import { hasFollowUp, isSignalSource, resolveRequests } from '../../server/src/sources/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
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

export interface CorpusLoad {
  programs: Program[];
  loaded: Array<{ sourceId: string; programs: number }>;
  skipped: Array<{ sourceId: string; why: string }>;
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

/** Every candidate Program the committed fixtures can produce, normalized exactly as the crawler does. */
export async function loadCorpus(): Promise<CorpusLoad> {
  const programs: Program[] = [];
  const loaded: CorpusLoad['loaded'] = [];
  const skipped: CorpusLoad['skipped'] = [];

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
    const ctx = contextForSource(source, PROFILE_NOW_ISO);
    const produced = raws.map((raw) => normalizeRaw(raw, ctx));
    programs.push(...produced);
    loaded.push({ sourceId: source.id, programs: produced.length });
  }

  return { programs, loaded, skipped };
}

// ---------------------------------------------------------------- profiles

export interface NamedProfile {
  key: string;
  label: string;
  profile: Profile;
}

const student = (over: Partial<StudentProfile>): StudentProfile => ({ kind: 'student', ...over });

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

  const { programs, loaded, skipped } = await loadCorpus();
  console.log('=== GrantSpotter corpus profile ===');
  console.log(`now: ${PROFILE_NOW_ISO}   corpus: ${programs.length} program(s) from committed fixtures`);
  for (const entry of loaded) console.log(`  loaded  ${entry.sourceId.padEnd(38)} ${entry.programs}`);
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
