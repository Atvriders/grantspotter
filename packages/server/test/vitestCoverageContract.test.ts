import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import workspace from '../../../vitest.workspace.js';

/**
 * THE TEST-FILE-THAT-NO-PROJECT-RUNS INVARIANT.
 *
 * Five separate defects in this repo have had exactly one shape: a test file exists on disk,
 * and no vitest project's `include` matches it, so `npm test` collects it, runs nothing from it,
 * and goes GREEN. Every "expect N tests passing" gate downstream then checks nothing.
 *
 *   1. `packages/server` — the config included only `test/**` while 87 tests lived in `src/**`.
 *   2. `packages/web` — the identical hole, carrying 27 test files, 20 of them `.tsx`.
 *   3. `packages/core` — a `src/*.test.ts` would never run; correct today only by accident of
 *      where its tests happen to live.
 *   4. `scripts/` — no project covered it AT ALL, so the tests for `scripts/profile-corpus.ts`
 *      had to be smuggled into `packages/core/test/matcher.test.ts`, in another package, importing
 *      `../../../scripts/profile-corpus.js`. Fixed on 2026-08-03 by `scripts/vitest.config.ts`.
 *   5. THIS FILE'S OWN BLIND SPOT, found by the Plan 2 close-out review (I4). `TEST_FILE` below
 *      enumerated `.test.ts`/`.test.tsx` only, so a `*.spec.ts`, `*.test.mts`, `*.test.js` or
 *      `*.spec.tsx` anywhere — INCLUDING inside a covered package — was neither run by vitest
 *      (no project include matches those extensions) nor flagged here (this walk never saw it).
 *      Reproduced 2026-08-03 with three probes each holding `expect(1).toBe(2)`
 *      (`docs/orphan-probe.spec.ts`, `packages/server/test/orphan-probe.test.mts`,
 *      `packages/core/src/orphan-probe.spec.tsx`): the full suite stayed at its baseline
 *      1760 passed / 9 failed and named none of them. The file had even transcribed
 *      `(?:test|spec)` into `VITEST_DEFAULT_INCLUDE` and then never enumerated a spec file.
 *      A sibling hole, same review: `exclude` defaulted to `[]` rather than to vitest's OWN
 *      default exclude, so a test file under `.cache/` or `cypress/` was counted as covered by a
 *      project that would never run it. Both are closed below.
 *
 * ALL FOUR OF THE ORIGINAL FOUR WERE FOUND BY A HUMAN READING CONFIGURATION. Not one was ever caught by a failing
 * test, and that is the entire problem: the symptom of this bug is the ABSENCE of failure. A
 * suite cannot notice tests it never collected, so the only thing that can notice is a test that
 * reads the filesystem and the configuration and compares them.
 *
 * This test does that. It enumerates every file on disk that ANY vitest configuration could
 * plausibly regard as a test — `.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`, i.e. exactly
 * vitest's own default `include` vocabulary, not the narrower set this repo happens to write
 * today — resolves the projects named by `vitest.workspace.ts` and the `include` globs in each
 * project's own `vitest.config.ts`, and fails — naming the files — when any is matched by no
 * project. Enumerating the same vocabulary vitest does is the point: a file this walk cannot see
 * is a file this invariant cannot protect, and defect 5 above lived in exactly that gap.
 *
 * It follows the invariants this repo already relies on: `sources/registry.test.ts` imports every
 * source module on disk and asserts each is registered, and `normalize/rawFieldsContract.test.ts`
 * scans for `rawFields` keys that are written and read by nothing. Both were proven by deliberate
 * breakage; so was this one — a throwaway `docs/orphan-probe.test.ts` turned it red and it named
 * the file, then the probe was deleted.
 *
 * WHY IT LIVES IN `packages/server/test/`, and not next to the workspace file it checks:
 *   - It must live where it is CERTAIN to run. An invariant about uncollected test files that is
 *     itself an uncollected test file is the joke writing itself, so it cannot live in the newest
 *     or least-established project. `packages/server` is the most redundantly covered project in
 *     the repo — its config includes BOTH `src/**` and `test/**` — so this file keeps running even
 *     if someone moves it between those trees. Core's config covers one tree only; web's runs
 *     under jsdom, which this file has no use for; `scripts/` is the project this defect just bit.
 *   - `packages/server` is already the home of this repo's other two invariants of the same
 *     "compare the code on disk against the thing that is supposed to enumerate it" family.
 *   - The vacuity guards below make the placement self-defending: if this file ever stopped seeing
 *     the filesystem or the configs, it fails instead of passing on an empty set.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not re-implement vitest's glob engine. `globToRegExp`
 * understands `**`, `*`, `?` and `{a,b}` — the whole of the syntax this repo's four configs use —
 * and THROWS on anything else rather than quietly failing to match, because a matcher that
 * silently matches nothing turns this invariant into the very bug it exists to catch.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * Directories that hold no first-party source. `node_modules` and `dist` are also in vitest's own
 * default `exclude`, so skipping them here agrees with what vitest would do; the rest are build
 * output and local scratch that is not committed.
 */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.superpowers']);

/**
 * Every filename shape vitest itself would treat as a test, which is deliberately WIDER than the
 * two extensions this repo writes today (`.test.ts`, `.test.tsx` — `.tsx` because web's hole was
 * `.tsx`). It is the same vocabulary as `VITEST_DEFAULT_INCLUDE` below, and that is the whole
 * point: this walk decides what the invariant can see, so narrowing it to current practice is how
 * defect 5 happened — a `*.spec.ts` was invisible to the walk AND matched by no project include,
 * so it ran nowhere and was reported nowhere. A file that no project runs must be flagged whether
 * or not anyone here would have written it that way.
 */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Files that look like a test to vitest but legitimately belong to another runner (a Playwright
 * `*.spec.ts`, say), keyed by repo-relative POSIX path.
 *
 * AN ENTRY IS EXPENSIVE ON PURPOSE. The guards below refuse a vacuous one: the path must exist on
 * disk, must STILL be matched by no vitest project (so an entry cannot outlive the condition it
 * excuses — the "allow-listed as a known defect while being cited as proof of health" trap this
 * repo has already sprung once), and the reason must be a real sentence. This exists so that the
 * response to a red from the check above is either to wire the file into a project or to sign a
 * statement, never to quietly re-narrow `TEST_FILE`.
 *
 * The two Playwright suites below are the first entries, added with the e2e harness on 2026-08-04.
 * This is the case the file's own comment anticipated ("a Playwright `*.spec.ts`, say"), and it is
 * signed rather than dodged: renaming them to something `TEST_FILE` does not enumerate would have
 * made them invisible to this invariant AND to vitest, which is defect 5 with extra steps.
 */
const NOT_A_VITEST_FILE: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'e2e/api.spec.ts',
    'Playwright, not vitest: `test`, `expect` and the `request` fixture come from @playwright/test, ' +
      'and the suite only means anything against the real built server that `playwright.config.ts`' +
      "'s `webServer` boots. `npm run test:e2e` runs it; vitest would fail to collect it. Adding " +
      'an `e2e` project to vitest.workspace.ts would make `npm test` try to run it and fail.',
  ],
  [
    'e2e/flow.spec.ts',
    'Playwright, not vitest, for the same reason as e2e/api.spec.ts: it drives a real Chromium ' +
      'through the built SPA against the built server, using @playwright/test\'s `page` fixture. ' +
      'It is run by `npm run test:e2e`, never by `npm test`.',
  ],
]);

/** Config file names vitest looks for in a project directory, in its own precedence order. */
const CONFIG_NAMES = ['vitest.config.ts', 'vitest.config.js', 'vite.config.ts', 'vite.config.js'];

/**
 * Vitest's built-in default `include`, used by a project whose config declares none:
 * `['**\/*.{test,spec}.?(c|m)[jt]s?(x)']`. It is transcribed as a regex rather than run through
 * `globToRegExp` because it uses extglob and character-class syntax that this file deliberately
 * refuses to guess at. Only the `.test.ts`/`.test.tsx` half can ever matter here, since those are
 * the only files enumerated, but the whole pattern is kept honest.
 */
const VITEST_DEFAULT_INCLUDE = /(?:^|\/)[^/]*\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Vitest's built-in default `exclude`, used by a project whose config declares none. It used to
 * default to `[]` here, which was a second escape hatch found by the same review: a test file
 * under `cypress/` or `.cache/` is matched by `test/**\/*.test.ts`, so it was reported as COVERED
 * while vitest's own default exclude means it never runs — the invariant's exact failure mode,
 * reached from the config side instead of the filename side.
 *
 * Only the directory patterns are transcribed. The config-file pattern in vitest's default
 * (`**\/{karma,rollup,…}.config.*`) cannot match anything `TEST_FILE` enumerates, and vitest MERGES
 * nothing: a project that declares its own `exclude` replaces this wholesale, which is what the
 * `exclude.length > 0` branch below does.
 */
const VITEST_DEFAULT_EXCLUDE = [
  '**/node_modules/**',
  '**/dist/**',
  '**/cypress/**',
  '**/.{idea,git,cache,output,temp}/**',
] as const;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...(await walk(path.join(dir, entry.name))));
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out.sort();
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A glob is turned into an anchored RegExp over a POSIX path relative to the project root.
 *
 * Supported, because that is what this repo's configs contain: `**` as a whole path segment,
 * `*` and `?` within a segment, and `{a,b}` alternation over literals. Everything else — character
 * classes, negation, extglob — throws by name. Under-matching is the failure mode that hides
 * orphaned test files, so an unrecognised glob has to be loud.
 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        if (!atSegmentStart) throw new Error(`unsupported glob (\`**\` mid-segment): ${glob}`);
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*'; // zero or more directories
          i += 2;
        } else if (i + 2 === glob.length) {
          out += '.*';
          i += 1;
        } else {
          throw new Error(`unsupported glob (\`**\` not a whole segment): ${glob}`);
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) throw new Error(`unsupported glob (unclosed \`{\`): ${glob}`);
      const body = glob.slice(i + 1, end);
      if (/[{*?/[\]()!+@]/.test(body)) {
        throw new Error(`unsupported glob (only literal alternatives inside \`{}\`): ${glob}`);
      }
      out += `(?:${body.split(',').map(escapeRegExp).join('|')})`;
      i = end;
    } else if ('[]()!+@|'.includes(c)) {
      throw new Error(`unsupported glob (character classes/extglob/negation): ${glob}`);
    } else {
      out += escapeRegExp(c);
    }
  }
  return new RegExp(`^${out}$`);
}

interface ResolvedProject {
  /** How the project is named in failure output: its workspace entry. */
  readonly label: string;
  /** Absolute directory the project's globs are relative to. */
  readonly root: string;
  readonly include: readonly RegExp[];
  readonly exclude: readonly RegExp[];
}

/**
 * Resolve the workspace into projects with real, matchable include globs.
 *
 * This reads the SAME files vitest reads — `vitest.workspace.ts` and each project's own
 * `vitest.config.ts` — rather than restating their contents here, because a hard-coded copy of the
 * configuration would go stale in exactly the situation this invariant exists to catch.
 */
async function resolveProjects(): Promise<ResolvedProject[]> {
  const projects: ResolvedProject[] = [];
  for (const entry of workspace) {
    if (typeof entry !== 'string') {
      throw new Error(
        'vitest.workspace.ts now holds an inline project config; teach resolveProjects() to read it ' +
          'before trusting this invariant again.',
      );
    }
    if (/[*?{[]/.test(entry)) {
      throw new Error(
        `vitest.workspace.ts entry "${entry}" is a glob; teach resolveProjects() to expand it ` +
          'before trusting this invariant again.',
      );
    }

    const target = path.resolve(REPO_ROOT, entry);
    const isConfigFile = /\.[cm]?[jt]s$/.test(entry);
    const root = isConfigFile ? path.dirname(target) : target;

    let config: Record<string, unknown> = {};
    let configPath: string | undefined;
    if (isConfigFile) {
      configPath = target;
    } else {
      const names = await readdir(root);
      configPath = CONFIG_NAMES.map((n) => (names.includes(n) ? path.join(root, n) : undefined)).find(
        (p) => p !== undefined,
      );
    }
    if (configPath !== undefined) {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(configPath).href)) as {
        default: unknown;
      };
      if (typeof mod.default === 'function') {
        throw new Error(
          `${configPath} exports a config FUNCTION; teach resolveProjects() to call it before ` +
            'trusting this invariant again.',
        );
      }
      config = (mod.default ?? {}) as Record<string, unknown>;
    }

    const test = (config.test ?? {}) as Record<string, unknown>;
    // `root`/`dir` would move the base every glob is resolved against, and silently invalidate the
    // matching below. Nothing in this repo sets either; if something starts to, this must learn how.
    for (const key of ['root', 'dir'] as const) {
      if (config[key] !== undefined || test[key] !== undefined) {
        throw new Error(
          `${configPath ?? entry} sets \`${key}\`, which relocates the project root; teach ` +
            'resolveProjects() to honour it before trusting this invariant again.',
        );
      }
    }

    const include = Array.isArray(test.include) ? (test.include as string[]) : undefined;
    // A declared `exclude` REPLACES vitest's default rather than adding to it, so the two cases
    // are kept apart deliberately. Defaulting to `[]` was the second hole (see the note on
    // VITEST_DEFAULT_EXCLUDE): it credited a project with running files vitest itself skips.
    const exclude = Array.isArray(test.exclude)
      ? (test.exclude as string[])
      : [...VITEST_DEFAULT_EXCLUDE];
    projects.push({
      label: entry,
      root,
      include: include === undefined ? [VITEST_DEFAULT_INCLUDE] : include.map(globToRegExp),
      exclude: exclude.map(globToRegExp),
    });
  }
  return projects;
}

/** Every project whose include globs match `absFile`, relative to that project's own root. */
function projectsMatching(projects: readonly ResolvedProject[], absFile: string): string[] {
  const matched: string[] = [];
  for (const project of projects) {
    const rel = path.relative(project.root, absFile).split(path.sep).join('/');
    if (rel.startsWith('../') || path.isAbsolute(rel)) continue;
    if (!project.include.some((re) => re.test(rel))) continue;
    if (project.exclude.some((re) => re.test(rel))) continue;
    matched.push(project.label);
  }
  return matched;
}

const testFiles = await walk(REPO_ROOT);
const projects = await resolveProjects();
const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

/** Every enumerated test file that no project would run, allow-list not yet applied. */
const uncovered = testFiles.filter((file) => projectsMatching(projects, file).length === 0).map(rel);

describe('vitest project coverage', () => {
  it('collects every test file on disk under at least one project', () => {
    const orphaned = uncovered.filter((file) => !NOT_A_VITEST_FILE.has(file));

    expect(
      orphaned,
      orphaned.length === 0
        ? ''
        : `${orphaned.length} test file(s) exist on disk but are matched by NO vitest project, so ` +
          `\`npm test\` runs none of them and stays green:\n  ${orphaned.join('\n  ')}\n` +
          'Add a project to vitest.workspace.ts, or widen the include globs of the project that ' +
          'should own them. Narrowing TEST_FILE is not a fix — it is defect 5 again.',
    ).toEqual([]);
  });

  it('collects no test file under two projects, which would double-count it', () => {
    const doubled = testFiles
      .map((file) => ({ file: rel(file), by: projectsMatching(projects, file) }))
      .filter((m) => m.by.length > 1)
      .map((m) => `${m.file} ← ${m.by.join(', ')}`);
    expect(doubled).toEqual([]);
  });
});

/**
 * The vacuity guards. The failure mode of a filesystem-scanning invariant is that it stops seeing
 * anything and passes on an empty set — which is indistinguishable from success, and is the same
 * class of silence this whole file exists to break.
 */
describe('vitest project coverage — the invariant can still see', () => {
  it('finds real test files, including this one', () => {
    expect(testFiles.length).toBeGreaterThan(50);
    expect(testFiles).toContain(path.resolve(import.meta.dirname, 'vitestCoverageContract.test.ts'));
  });

  it('resolves every workspace entry to a project with at least one include glob', () => {
    expect(projects.map((p) => p.label)).toEqual([...workspace]);
    for (const project of projects) {
      expect(project.include.length, `${project.label} declares no include`).toBeGreaterThan(0);
    }
  });

  it('leaves no project matching nothing — the same defect seen from the config side', () => {
    const empty = projects
      .filter((p) => !testFiles.some((f) => projectsMatching([p], f).length > 0))
      .map((p) => p.label);
    expect(empty).toEqual([]);
  });

  it('matches globs precisely, and never by matching everything', () => {
    const src = globToRegExp('src/**/*.test.{ts,tsx}');
    expect(src.test('src/a.test.ts')).toBe(true);
    expect(src.test('src/deep/nested/a.test.tsx')).toBe(true);
    expect(src.test('test/a.test.ts')).toBe(false); // the wrong tree — defects 1 and 2
    expect(src.test('src/a.ts')).toBe(false);
    expect(src.test('src/a.test.js')).toBe(false);

    const onlyTestTree = globToRegExp('test/**/*.test.ts');
    expect(onlyTestTree.test('test/a.test.ts')).toBe(true);
    expect(onlyTestTree.test('test/deep/a.test.ts')).toBe(true);
    expect(onlyTestTree.test('src/a.test.ts')).toBe(false);
    expect(onlyTestTree.test('test/a.test.tsx')).toBe(false); // the extension half of defect 2

    const anywhere = globToRegExp('**/*.test.{ts,tsx}');
    expect(anywhere.test('a.test.ts')).toBe(true);
    expect(anywhere.test('sub/a.test.tsx')).toBe(true);
    expect(anywhere.test('a.ts')).toBe(false);

    expect(globToRegExp('a?.test.ts').test('ab.test.ts')).toBe(true);
    expect(globToRegExp('a?.test.ts').test('abc.test.ts')).toBe(false);
  });

  it('refuses glob syntax it does not understand instead of matching nothing', () => {
    expect(() => globToRegExp('src/[abc].test.ts')).toThrow(/unsupported glob/);
    expect(() => globToRegExp('!(src)/a.test.ts')).toThrow(/unsupported glob/);
    expect(() => globToRegExp('src/**.test.ts')).toThrow(/unsupported glob/);
    expect(() => globToRegExp('src/a**/b.test.ts')).toThrow(/unsupported glob/);
    expect(() => globToRegExp('src/{a,*}/b.test.ts')).toThrow(/unsupported glob/);
    expect(() => globToRegExp('src/{a,b/c.test.ts')).toThrow(/unsupported glob/);
  });

  it('applies vitest\'s own default include when a project declares none', () => {
    expect(VITEST_DEFAULT_INCLUDE.test('src/a.test.ts')).toBe(true);
    expect(VITEST_DEFAULT_INCLUDE.test('a.spec.tsx')).toBe(true);
    expect(VITEST_DEFAULT_INCLUDE.test('src/a.ts')).toBe(false);
  });

  /**
   * Defect 5, pinned as a property of the walk rather than as a memory. Every one of these is a
   * filename vitest's own default include would run and none of this repo's four project includes
   * matches, so each MUST reach the orphan check above; before 2026-08-03 the walk discarded them
   * and they reached nothing.
   */
  it('enumerates every filename shape vitest itself would call a test', () => {
    for (const name of [
      'a.test.ts',
      'a.test.tsx',
      'a.spec.ts',
      'a.spec.tsx',
      'a.test.mts',
      'a.test.cts',
      'a.test.js',
      'a.test.mjs',
      'a.test.cjs',
      'a.test.jsx',
      'a.spec.js',
    ]) {
      expect(TEST_FILE.test(name), `${name} must be enumerated`).toBe(true);
      expect(VITEST_DEFAULT_INCLUDE.test(name), `${name} is a test to vitest`).toBe(true);
    }
    for (const name of ['a.ts', 'atest.ts', 'test.ts', 'a.tests.ts', 'a.test.json']) {
      expect(TEST_FILE.test(name), `${name} is not a test file`).toBe(false);
    }
  });

  it('honours vitest\'s default exclude, so an unrunnable path is not counted as covered', () => {
    const cache = globToRegExp(VITEST_DEFAULT_EXCLUDE[3]);
    expect(cache.test('test/.cache/a.test.ts')).toBe(true);
    expect(cache.test('.git/a.test.ts')).toBe(true);
    expect(cache.test('test/a.test.ts')).toBe(false);
    expect(globToRegExp(VITEST_DEFAULT_EXCLUDE[2]).test('packages/web/cypress/a.test.ts')).toBe(true);
    // Every project in this repo declares no `exclude`, so every one must carry the default.
    for (const project of projects) {
      expect(project.exclude.length, `${project.label} lost its exclude`).toBeGreaterThan(0);
    }
  });
});

/**
 * The allow-list guards. An exemption has to name a real, still-uncovered file and say why, or it
 * is indistinguishable from having widened the ignore list to silence a red.
 */
describe('vitest project coverage — no exemption may be vacuous', () => {
  it('names only files that exist and are still matched by no project', () => {
    const wrong = [...NOT_A_VITEST_FILE.keys()].filter((file) => !uncovered.includes(file));
    expect(
      wrong,
      'listed in NOT_A_VITEST_FILE but either gone from disk or now covered by a project — ' +
        'delete the entry; a stale exemption hides the next real orphan',
    ).toEqual([]);
  });

  it('gives every exemption a written reason', () => {
    for (const [file, reason] of NOT_A_VITEST_FILE) {
      expect(reason.trim().length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(
        20,
      );
    }
  });
});
