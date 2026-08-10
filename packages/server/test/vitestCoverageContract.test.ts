import { readFile, readdir } from 'node:fs/promises';
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
  [
    'e2e/writing.spec.ts',
    'Playwright, not vitest, for the same reason as e2e/api.spec.ts and e2e/flow.spec.ts: it uses ' +
      "@playwright/test's `request` and `page` fixtures against the server `playwright.config.ts`'s " +
      '`webServer` builds and boots. Its HTTP half drives the writing routers today; its browser ' +
      'half skips with a reason until the SPA fallback is mounted. `npm run test:e2e` runs it, ' +
      'never `npm test`.',
  ],
  [
    'e2e/shippedSeed.spec.ts',
    'Playwright, not vitest, for the same reason as the three above: @playwright/test fixtures ' +
      'against a real built server. It is the odd one out in one respect worth recording — it boots ' +
      'the SHIPPED seed corpus rather than the fixtures the other suites use, because the two are ' +
      'different products (143 publishable and 0 suppressed with canonical ids, against 150 and 553 ' +
      'with content-hashed ones) and the canonical ids are what make the first-run import idempotent ' +
      'instead of inserting every programme again on each boot. That property cannot be tested ' +
      'against a hash-id fixture at all. `npm run test:e2e` runs it, never `npm test`.',
  ],
  [
    'e2e/responsive.spec.ts',
    'Playwright, not vitest, and it is the one suite here that CANNOT be anything else: it measures ' +
      '`document.documentElement.scrollWidth` against the viewport, and the only environment this ' +
      'repo has that computes a layout is a real Chromium. jsdom returns zeros from every ' +
      '`getBoundingClientRect`, which is why `packages/web/src/test/responsive.test.ts` asserts the ' +
      'CAUSES in the CSS and delegates the pixels here. It boots the shipped seed corpus on its own ' +
      'port, the way e2e/shippedSeed.spec.ts does, because the defect it guards against — 112 of ' +
      '143 records scrolling sideways on an unbreakable URL — is a property of the corpus a real ' +
      'install has. `npm run test:e2e` runs it, never `npm test`.',
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

/* ------------------------------------------------------------------------------------------- *
 * DEFECT 6: THE PROJECT-THAT-NEVER-RAN. The invocation layer, which everything above is blind to.
 *
 * Everything above compares FILES ON DISK against CONFIGURATION. The Plan 3 close-out review
 * pointed out that this answers "does every test file belong to A project" and never "does every
 * project actually RUN", and then proved the gap by execution: it changed the root package.json's
 * `"test": "vitest run"` to `"vitest run --project server"` — DROPPING THE ENTIRE WEB SUITE, 653
 * tests, plus core and scripts — and this file passed 12 of 12. That is the sharpest instance of
 * the family: the guard written to stop a silently-shrinking suite did not notice the suite
 * shrinking by 653 tests, because the shrink happened one layer below anything it read.
 *
 * `npm test` is what "the suite" MEANS in this repo — it is the command the plans, the close-out
 * reviews and every "N passing" claim are measured with, and there is no CI workflow that would
 * name the projects independently. So the invariant is: the declared entry point must invoke
 * vitest over the WHOLE workspace, with nothing that narrows what is collected.
 *
 * IT IS AN ALLOW-LIST OF FLAGS, NOT A DENY-LIST OF THE NARROWING ONES — the same lesson
 * `sources/registry.test.ts` learned when a deny-list of five egress substrings was walked past
 * with `node:fs`. `--project` is only the flag somebody happened to try; `--dir`, `--root`,
 * `--shard`, `--changed`, `--related`, a bare positional path filter and `--passWithNoTests` all
 * shrink the run too, and the next one has not been invented yet. So every token in the command
 * must be recognised as SAFE by name, and anything else fails loudly rather than being tolerated.
 *
 * WHAT THIS DOES NOT PROVE, stated plainly rather than left to be discovered: it does not observe a
 * real vitest process, so it cannot prove what a developer typed at their own terminal, and it
 * cannot prove a collected test ASSERTED anything. The `.only`/`.skip` scan below closes the
 * biggest remaining slice of the second gap — a single `describe.only` silently drops every other
 * file in its project, which is this defect family reached from inside a test file instead of from
 * the config or the command line.
 * ------------------------------------------------------------------------------------------- */

/**
 * Tokens `npm test` may contain. Each is either vitest's run mode or something that changes only
 * how results are REPORTED — never which files are collected or which projects are run.
 */
const NON_NARROWING_TOKENS: ReadonlyMap<string, string> = new Map([
  ['vitest', 'the runner itself'],
  ['npx', 'the launcher'],
  ['run', 'run mode: execute once and exit, rather than watch. Collects the same set either way.'],
  ['--run', 'the flag spelling of run mode.'],
  ['--silent', 'suppresses console output from tests; collection is untouched.'],
  ['--no-color', 'reporter styling only.'],
  ['--coverage', 'adds instrumentation; it cannot remove a file from the run.'],
  ['--hideSkippedTests', 'reporter output only.'],
]);

/** Flag PREFIXES (`--reporter=json`) that are reporting-only, matched before the exact list. */
const NON_NARROWING_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['--reporter=', 'chooses how results are printed.'],
  ['--outputFile=', 'where a reporter writes; collection is untouched.'],
  ['--bail=', 'stops after N FAILURES. It can only cut a run short once something is already red.'],
];

/**
 * The narrowing tokens that are known TODAY, named so the failure message can say what is wrong
 * instead of only that something is. This is documentation attached to the allow-list above, NOT
 * the gate: an unrecognised token fails whether or not it appears here.
 */
const KNOWN_NARROWING: ReadonlyMap<string, string> = new Map([
  ['--project', 'runs only the named project(s) — this is the exact defeat this check exists for'],
  ['-p', 'the short spelling of --project'],
  ['--dir', 'moves the base directory the run scans'],
  ['--root', 'moves the project root'],
  ['--shard', 'runs a fraction of the files'],
  ['--changed', 'runs only files affected by the working tree'],
  ['--related', 'runs only files related to the named sources'],
  ['--include', 'replaces the configured include globs'],
  ['--exclude', 'removes files from the run'],
  ['--testNamePattern', 'runs only tests whose NAME matches'],
  ['-t', 'the short spelling of --testNamePattern'],
  [
    '--passWithNoTests',
    'makes an EMPTY run green, which is this defect family with the volume turned all the way up',
  ],
]);

/** Split a shell command into tokens, honouring quotes. Throws on shell syntax it cannot read. */
export function tokenizeCommand(command: string): string[] {
  if (/[|&;><`$()]/.test(command)) {
    throw new Error(
      `the test script uses shell syntax this check cannot read (${command}); teach it before ` +
        'trusting this invariant again — an unread chain can hide anything',
    );
  }
  const tokens: string[] = [];
  for (const m of command.trim().matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}

/** Every token in `npm test` that is not recognised as leaving the collected set alone. */
export function narrowingTokens(command: string): string[] {
  const bad: string[] = [];
  for (const token of tokenizeCommand(command)) {
    if (NON_NARROWING_TOKENS.has(token)) continue;
    if (NON_NARROWING_PREFIXES.some(([prefix]) => token.startsWith(prefix))) continue;
    const flag = token.split('=')[0] ?? token;
    const why = KNOWN_NARROWING.get(flag);
    bad.push(
      why === undefined
        ? `"${token}" is not in NON_NARROWING_TOKENS. If it cannot remove a file or a project from ` +
          'the run, add it there with a reason; if it can, it does not belong in `npm test`.'
        : `"${token}" ${why}`,
    );
  }
  return bad;
}

const rootPackageJson = JSON.parse(
  await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
) as { scripts?: Record<string, string> };

describe('vitest project coverage — `npm test` runs every project', () => {
  it('declares a test script at all', () => {
    expect(
      rootPackageJson.scripts?.test,
      'the root package.json has no `test` script, so there is no entry point for any "N tests ' +
        'passing" claim to have measured',
    ).toBeTruthy();
  });

  it('invokes vitest over the whole workspace, with nothing that narrows the run', () => {
    const command = rootPackageJson.scripts?.test ?? '';
    const tokens = tokenizeCommand(command);
    expect(tokens, `\`npm test\` (${command}) does not invoke vitest`).toContain('vitest');

    const bad = narrowingTokens(command);
    expect(
      bad,
      bad.length === 0
        ? ''
        : `\`npm test\` is "${command}", which does not run the whole workspace:\n  ${bad.join('\n  ')}\n` +
          'Every check above compares FILES against CONFIGURATION and cannot see this: a run that ' +
          'silently drops a project is green here and green in the terminal, and the tests it ' +
          'dropped are simply not mentioned. Narrowing belongs on the command line a developer ' +
          'types, never in the script every claim about this suite is measured with.',
    ).toEqual([]);
  });

  it('names every workspace project in a script that runs them all', () => {
    // The positive statement of the same rule: whatever `npm test` is, the projects it runs must be
    // the whole workspace. With no narrowing token there is nothing to subset it, so this asserts
    // the conclusion the check above earns — and fails loudly if the workspace is ever emptied.
    const running = narrowingTokens(rootPackageJson.scripts?.test ?? '').length === 0 ? [...workspace] : [];
    expect(running).toEqual([...workspace]);
    expect(running.length, 'the workspace declares no projects').toBeGreaterThan(1);
  });

  it('reads the command the way a shell would', () => {
    expect(tokenizeCommand('vitest run')).toEqual(['vitest', 'run']);
    expect(tokenizeCommand('vitest run --reporter=json')).toEqual(['vitest', 'run', '--reporter=json']);
    expect(tokenizeCommand('vitest run -t "a b"')).toEqual(['vitest', 'run', '-t', 'a b']);
    expect(() => tokenizeCommand('vitest run && echo ok')).toThrow(/shell syntax/);
  });

  /** The break that produced this section, plus the ones nobody tried, pinned as behaviour. */
  it('rejects every narrowing invocation, not only the one that was tried', () => {
    expect(narrowingTokens('vitest run')).toEqual([]);
    expect(narrowingTokens('vitest run --silent --reporter=dot')).toEqual([]);
    for (const command of [
      'vitest run --project server', // the exact Plan 3 defeat: dropped 653 web tests, stayed green
      'vitest run -p server',
      'vitest run --dir packages/server',
      'vitest run --shard=1/4',
      'vitest run --changed',
      'vitest run --related src/a.ts',
      'vitest run --exclude "packages/web/**"',
      'vitest run -t suppression',
      'vitest run --passWithNoTests',
      'vitest run packages/server', // a bare positional path filter needs no flag at all
      'vitest run --some-flag-invented-next-year=1', // the whole point of an allow-list
    ]) {
      expect(narrowingTokens(command), `${command} must be rejected`).not.toEqual([]);
    }
  });
});

/**
 * `.only` and `.skip`: the same silent shrink, reached from inside a test file.
 *
 * A single `describe.only` drops every other FILE in its project — vitest honours `only` across the
 * whole run — and reports the survivors as passing. `.skip` and `.todo` drop one block and report
 * it as skipped, which no "N passing" claim ever subtracts. Neither is visible to any check above,
 * and both produce exactly the symptom this file exists to break: a green run over less than
 * everyone thinks.
 */
const SKIPPED_BY_DESIGN: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'packages/server/src/normalize/rawFieldsContract.test.ts',
    'One `it.todo` per entry in WRITE_ONLY_KNOWN_DEFECTS — 18 rawFields keys a live source writes ' +
      'and nothing consumes. They are `todo` ON PURPOSE and that is the whole point: `todo` is the ' +
      'one result vitest never counts as passing, so `npm test` reports "N passed | 18 todo" and a ' +
      'tracked defect can never be read as a satisfied invariant. This is the deliberate opposite ' +
      'of the case this guard exists for — a block quietly removed from the run — so it is signed ' +
      'rather than silenced, and the count shrinks as the defects are fixed.',
  ],
]);

/**
 * MATCHED AT STATEMENT POSITION — start of line, after indentation — never anywhere in the text.
 *
 * A file that scans for `.skip` has to quote `.skip` to test its own scanner, and this one does, a
 * few tests below. The first draft stripped string literals instead and reported ITSELF as using
 * `.only`: a backtick nested inside a quoted fixture desynchronised the stripper, which is a hand
 * -rolled JS lexer's ordinary failure and exactly the kind of silent mis-scan the rest of this file
 * exists to prevent. A real `describe.only(` is a STATEMENT; a quoted one never is. Anchoring is
 * both simpler and harder to get wrong than lexing, so it is what this uses.
 */
const ONLY_MARKER = /^[ \t]*(?:describe|it|test|suite)\s*\.\s*only\b/gm;

/**
 * A STATIC skip — one that names a block and removes it unconditionally — as opposed to a runtime
 * one. The first argument must be a quoted name (`describe.skip('…')`) or the marker must be
 * chained (`describe.skip.each([…])`). That deliberately does NOT match
 * `test.skip(!condition, reason)`, Playwright's imperative form used in `e2e/flow.spec.ts:56`, nor
 * `it.skipIf(!hasFixture(id))(…)`, used twice in `sources/arrl-scholarship-descriptions.test.ts`:
 * both decide at runtime and neither removes a file from the run. That leaves a residual hole this
 * file cannot close — `it.skipIf(!hasFixture(...))` reports SKIPPED, not failed, when the fixture
 * is deleted — which is the Plan 3 review's finding against the ARRL invariant and belongs to that
 * test, not this one.
 */
const STATIC_SKIP = /^[ \t]*(?:describe|it|test|suite)\s*\.\s*(skip|todo|fails)\s*(?:\.\s*each\s*\(|\(\s*['"`])/gm;

const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function onlyMarkersIn(src: string): string[] {
  return [...withoutComments(src).matchAll(ONLY_MARKER)].map(() => 'only');
}

function skipMarkersIn(src: string): string[] {
  return [...withoutComments(src).matchAll(STATIC_SKIP)].map((m) => m[1] ?? '');
}

describe('vitest project coverage — no test file quietly removes itself from the run', () => {
  it('contains no `.only`, which silently drops every other file in its project', async () => {
    const offenders: string[] = [];
    for (const file of testFiles) {
      if (onlyMarkersIn(await readFile(file, 'utf8')).length > 0) {
        offenders.push(`${rel(file)} uses .only — every other file in its project is skipped`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('signs every statically-skipped block, so a skip is a decision and not a leftover', async () => {
    const skipped: string[] = [];
    for (const file of testFiles) {
      const markers = skipMarkersIn(await readFile(file, 'utf8'));
      if (markers.length > 0 && !SKIPPED_BY_DESIGN.has(rel(file))) {
        skipped.push(`${rel(file)} uses .${[...new Set(markers)].join('/.')} unsigned`);
      }
    }
    expect(
      skipped,
      'a statically skipped block runs nowhere and is subtracted from no count. Delete it, make it ' +
        'conditional (.skipIf), or sign it in SKIPPED_BY_DESIGN with a reason.',
    ).toEqual([]);
  });

  it('keeps SKIPPED_BY_DESIGN honest: every entry still exists and is still skipped', async () => {
    for (const [file, reason] of SKIPPED_BY_DESIGN) {
      expect(reason.trim().length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(20);
      const src = await readFile(path.join(REPO_ROOT, file), 'utf8').catch(() => undefined);
      expect(src, `${file} is signed as skipped but no longer exists`).toBeDefined();
      if (src === undefined) continue;
      expect(
        skipMarkersIn(src),
        `${file} no longer skips anything — delete its SKIPPED_BY_DESIGN entry`,
      ).not.toEqual([]);
    }
  });

  it('tells a static skip apart from a conditional one', () => {
    expect(skipMarkersIn('describe.skip("x", () => {})')).toEqual(['skip']);
    expect(skipMarkersIn('  it.skip(`x`, () => {})')).toEqual(['skip']);
    expect(onlyMarkersIn('it.only("x", () => {})')).toEqual(['only']);
    expect(skipMarkersIn('test.todo("x")')).toEqual(['todo']);
    expect(skipMarkersIn('describe.skip.each([1])("x", () => {})')).toEqual(['skip']);
    // Legitimate and in use in this repo — a runtime condition, not a block removing itself.
    expect(skipMarkersIn("it.skipIf(!hasFixture(id))('x', () => {})")).toEqual([]);
    expect(skipMarkersIn("describe.skipIf(cond)('x', () => {})")).toEqual([]);
    expect(skipMarkersIn('describe.each(THEMES)("x", () => {})')).toEqual([]);
    expect(skipMarkersIn('  test.skip(!isHtml(body), SPA_PENDING);')).toEqual([]); // e2e/flow.spec.ts:56
    // ...and prose about skipping — or a quoted fixture, which is why matching is line-anchored —
    // is not skipping.
    expect(skipMarkersIn('// describe.skip("x", () => {})')).toEqual([]);
    expect(skipMarkersIn('expect(scan(`describe.skip("x")`)).toEqual([]);')).toEqual([]);
    expect(onlyMarkersIn('expect(scan("it.only(")).toEqual([]);')).toEqual([]);
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
