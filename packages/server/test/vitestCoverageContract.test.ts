import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import workspace from '../../../vitest.workspace.js';

/**
 * THE TEST-FILE-THAT-NO-PROJECT-RUNS INVARIANT.
 *
 * Four separate defects in this repo have had exactly one shape: a `*.test.ts` exists on disk,
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
 *
 * ALL FOUR WERE FOUND BY A HUMAN READING CONFIGURATION. Not one was ever caught by a failing
 * test, and that is the entire problem: the symptom of this bug is the ABSENCE of failure. A
 * suite cannot notice tests it never collected, so the only thing that can notice is a test that
 * reads the filesystem and the configuration and compares them.
 *
 * This test does that. It enumerates every `*.test.ts` / `*.test.tsx` on disk, resolves the
 * projects named by `vitest.workspace.ts` and the `include` globs in each project's own
 * `vitest.config.ts`, and fails — naming the files — when any test file is matched by no project.
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

/** The two extensions this repo writes tests in. `.tsx` is here because web's hole was `.tsx`. */
const TEST_FILE = /\.test\.tsx?$/;

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
    const exclude = Array.isArray(test.exclude) ? (test.exclude as string[]) : [];
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

describe('vitest project coverage', () => {
  it('collects every test file on disk under at least one project', () => {
    const orphaned = testFiles
      .filter((file) => projectsMatching(projects, file).length === 0)
      .map(rel);

    expect(
      orphaned,
      orphaned.length === 0
        ? ''
        : `${orphaned.length} test file(s) exist on disk but are matched by NO vitest project, so ` +
          `\`npm test\` runs none of them and stays green:\n  ${orphaned.join('\n  ')}\n` +
          'Add a project to vitest.workspace.ts, or widen the include globs of the project that ' +
          'should own them.',
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
});
