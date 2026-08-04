import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE FILE-THAT-NOTHING-TYPECHECKS INVARIANT.
 *
 * THIS TEST DID NOT EXIST. It was CLAIMED as one of this project's ~10 invariants, and the Plan 3
 * close-out review went looking for it: it is a PROSE COMMENT inside `tsconfig.json`, lines 16-28,
 * plus a passing mention in `normalize/index.test.ts:8`. No test in the repository read
 * `tsconfig.json` at all. The review proved the claim empty by deleting `"scripts/**\/*.ts"` from
 * the include list — which un-typechecks `scripts/profile-corpus.ts`, the corpus profiler that
 * every acceptance figure in the Plan 2 remediation was measured with and that
 * `licenseFloorContract.test.ts` imports — and the full suite stayed green. Nothing noticed.
 *
 * That the comment exists is itself the tell. It was written the last time this bit
 * (`scripts/vitest.config.ts` was invisible to `packages/*​/vitest.config.ts`, so the profiler went
 * untypechecked for a whole plan), and the response was to write down what happened rather than to
 * make it impossible. A comment inside the very file that would be edited to reintroduce the defect
 * is the weakest possible guard: it is deleted by the same keystroke as the line it protects.
 *
 * So this file makes the claim executable, in the same shape as the two invariants it sits beside
 * in `packages/server/test/` — `vitestCoverageContract.test.ts` (files on disk vs vitest projects)
 * and `blocklistParity.test.ts` (one list vs its twin). Every `.ts`/`.tsx` on disk outside
 * `node_modules`/`dist` must be matched by the `include` of a config that `npm run typecheck`
 * actually runs, or be signed for in NOT_TYPECHECKED with a reason.
 *
 * THE CONFIG SET IS DERIVED FROM THE TYPECHECK COMMAND, NOT LISTED HERE. `npm run typecheck` is
 * what "typechecked" MEANS in this repo, and a hard-coded copy of which configs to read would go
 * stale in exactly the situation this exists to catch — someone drops the `&& npm run typecheck -w
 * @grantspotter/web` leg and 11,000 lines of web source stop being checked while a list in this
 * file still names `packages/web/tsconfig.json`. It is the same lesson `vitestCoverageContract`
 * learned one layer down: read the thing that runs, not a description of it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not re-implement `tsc`'s file resolution. It reads
 * `include`/`exclude`/`files` and matches them with TypeScript's documented glob rules, and THROWS
 * BY NAME on any config shape it does not understand — a `references` array, a glob syntax it
 * cannot read, an `extends` chain it cannot resolve. A matcher that silently matches nothing turns
 * this invariant into the very bug it exists to catch, which is the mistake the vitest contract
 * documented and this file inherits rather than rediscovers.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/** Same set the vitest contract ignores, and for the same reasons: not first-party source. */
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.superpowers']);

/** What TypeScript would compile: `.ts`, `.tsx`, `.mts`, `.cts`. `.d.ts` is a declaration, not source. */
const TS_FILE = /\.(?:[cm]?ts|tsx)$/;

/**
 * Files that no typecheck config covers, on purpose, each with the reason.
 *
 * EMPTY, and an entry is expensive. The guards below refuse a vacuous one: the path must exist on
 * disk and must STILL be matched by no config, so an entry cannot outlive the condition it excuses.
 * That is the same trap this repo has already sprung once — an allow-list entry marked "known
 * defect" was simultaneously being cited as evidence a regression canary was healthy — and the
 * response to a red here is either to add the file to a config's `include` or to sign a statement,
 * never to widen IGNORED_DIRS.
 */
const NOT_TYPECHECKED: ReadonlyMap<string, string> = new Map<string, string>();

/* --------------------------------------------------------------------------------------------- *
 * Resolving WHICH configs `npm run typecheck` runs.
 * --------------------------------------------------------------------------------------------- */

interface PackageJson {
  readonly name?: string;
  readonly scripts?: Record<string, string>;
  readonly workspaces?: readonly string[];
}

async function readPackageJson(dir: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as PackageJson;
}

/**
 * Follow `npm run typecheck` — including `&&` chains and `-w <workspace>` hops into another
 * package's own `typecheck` script — and collect every `tsc -p <config>` target it reaches.
 *
 * Anything else throws by name. A `typecheck` script this cannot read is a typecheck whose coverage
 * this file cannot vouch for, and saying so is the only honest outcome.
 */
async function typecheckedConfigs(): Promise<string[]> {
  const configs: string[] = [];
  const visit = async (dir: string, seen: ReadonlySet<string>): Promise<void> => {
    const pkg = await readPackageJson(dir);
    const script = pkg.scripts?.typecheck;
    if (script === undefined) {
      throw new Error(`${path.relative(REPO_ROOT, dir) || '.'} has no \`typecheck\` script to follow`);
    }
    for (const leg of script.split('&&').map((s) => s.trim())) {
      const tokens = leg.split(/\s+/).filter((t) => t !== '');
      if (tokens[0] === 'tsc') {
        const at = tokens.indexOf('-p') === -1 ? tokens.indexOf('--project') : tokens.indexOf('-p');
        if (at === -1 || tokens[at + 1] === undefined) {
          throw new Error(`\`${leg}\` runs tsc with no -p <config>; teach this test to resolve it`);
        }
        configs.push(path.resolve(dir, tokens[at + 1] ?? ''));
        continue;
      }
      if (tokens[0] === 'npm' && tokens[1] === 'run' && tokens[2] === 'typecheck') {
        const at = tokens.indexOf('-w');
        const target = at === -1 ? undefined : tokens[at + 1];
        if (target === undefined) {
          throw new Error(`\`${leg}\` recurses into typecheck without naming a workspace`);
        }
        const workspaceDir = await workspaceDirFor(target);
        if (seen.has(workspaceDir)) throw new Error(`\`${leg}\` is a cycle through ${target}`);
        await visit(workspaceDir, new Set([...seen, workspaceDir]));
        continue;
      }
      throw new Error(
        `\`${leg}\` is a typecheck step this test cannot read. Teach it before trusting this ` +
          'invariant again — an unread step can hide a whole package.',
      );
    }
  };
  await visit(REPO_ROOT, new Set([REPO_ROOT]));
  return [...new Set(configs)];
}

/** `@grantspotter/web` -> the directory whose package.json declares that name. */
async function workspaceDirFor(name: string): Promise<string> {
  const packagesDir = path.join(REPO_ROOT, 'packages');
  for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const pkg = await readPackageJson(dir).catch(() => undefined);
    if (pkg?.name === name) return dir;
  }
  throw new Error(`no workspace package is named ${name}`);
}

/* --------------------------------------------------------------------------------------------- *
 * Reading a tsconfig.
 * --------------------------------------------------------------------------------------------- */

/**
 * tsconfig is JSON WITH COMMENTS — this repo's root config carries three comment blocks explaining
 * the holes this file exists to close — plus trailing commas, so both are removed before parsing.
 *
 * IT IS A SCANNER, NOT A PAIR OF REGEXES, and that is not gold-plating. The first draft stripped
 * `/\/\*[\s\S]*?\*\//g`, and the very first config it met contains the glob
 * `"packages/*​/vitest.config.ts"` — whose `/*` opened a "comment" that ran on until the `*​/` inside
 * `"scripts/**\/*.ts"` closed it, silently deleting two include patterns and corrupting the rest.
 * A parser that mangles the configuration it is auditing reports whatever the mangling produced,
 * which is the failure mode this whole file exists to break. Strings are tracked, so a `/*` inside
 * one is glob syntax and not a comment.
 */
export function parseTsconfigJson(text: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

interface ResolvedConfig {
  /** Repo-relative path, which is how failures name it. */
  readonly label: string;
  /** Absolute directory the globs are relative to. */
  readonly root: string;
  readonly include: readonly RegExp[];
  readonly exclude: readonly RegExp[];
}

/** TypeScript's own default exclude when a config declares none. `outDir` is added on top. */
const TS_DEFAULT_EXCLUDE = ['node_modules', 'bower_components', 'jspm_packages'] as const;

async function resolveConfig(configPath: string): Promise<ResolvedConfig> {
  const root = path.dirname(configPath);
  const raw = parseTsconfigJson(await readFile(configPath, 'utf8'));

  if (Array.isArray(raw.references)) {
    throw new Error(
      `${path.relative(REPO_ROOT, configPath)} uses project references, which change which files ` +
        'are checked; teach resolveConfig() to follow them before trusting this invariant again.',
    );
  }
  if (raw.files !== undefined && raw.include === undefined) {
    throw new Error(
      `${path.relative(REPO_ROOT, configPath)} declares \`files\` and no \`include\`; teach ` +
        'resolveConfig() to honour it before trusting this invariant again.',
    );
  }
  // `extends` cannot introduce include/exclude here without this test knowing about it.
  if (typeof raw.extends === 'string') {
    const parent = parseTsconfigJson(
      await readFile(path.resolve(root, raw.extends as string), 'utf8'),
    );
    if (parent.include !== undefined || parent.exclude !== undefined || parent.files !== undefined) {
      throw new Error(
        `${path.relative(REPO_ROOT, configPath)} extends a config that declares include/exclude/` +
          'files; teach resolveConfig() to merge them before trusting this invariant again.',
      );
    }
  }

  const include = Array.isArray(raw.include) ? (raw.include as string[]) : ['**/*'];
  const declaredExclude = Array.isArray(raw.exclude) ? (raw.exclude as string[]) : undefined;
  const compilerOptions = (raw.compilerOptions ?? {}) as Record<string, unknown>;
  const outDir = typeof compilerOptions.outDir === 'string' ? [compilerOptions.outDir] : [];
  const exclude = declaredExclude ?? [...TS_DEFAULT_EXCLUDE, ...outDir];

  return {
    label: path.relative(REPO_ROOT, configPath).split(path.sep).join('/'),
    root,
    include: include.map(tsGlobToRegExp),
    exclude: exclude.map(tsGlobToRegExp),
  };
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A tsconfig glob, anchored, over a POSIX path relative to the config's directory.
 *
 * TypeScript's documented wildcards, and nothing invented: `*` is zero or more characters excluding
 * a separator, `?` is exactly one, `**​/` is any number of directories. A pattern with no extension
 * and no wildcard names a DIRECTORY, which TypeScript expands to every supported source file under
 * it — that is how `"exclude": ["node_modules"]` works, and getting it wrong in the permissive
 * direction would silently un-cover a whole tree.
 *
 * Anything else throws. Under-matching is what hides an unchecked file, so an unrecognised glob has
 * to be loud rather than quietly true.
 */
export function tsGlobToRegExp(glob: string): RegExp {
  const looksLikeDirectory = !/[*?]/.test(glob) && !/\.[cm]?[jt]sx?$/.test(glob) && !glob.endsWith('.json');
  const pattern = looksLikeDirectory ? `${glob.replace(/\/$/, '')}/**/*` : glob;

  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const atSegmentStart = i === 0 || pattern[i - 1] === '/';
        if (!atSegmentStart) throw new Error(`unsupported tsconfig glob (\`**\` mid-segment): ${glob}`);
        if (pattern[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
        } else if (i + 2 === pattern.length) {
          out += '.*';
          i += 1;
        } else {
          throw new Error(`unsupported tsconfig glob (\`**\` not a whole segment): ${glob}`);
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c !== undefined && '[]{}()!+@|'.includes(c)) {
      throw new Error(`unsupported tsconfig glob (character classes/extglob/braces): ${glob}`);
    } else {
      out += escapeRegExp(c ?? '');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Every config whose include matches `absFile` and whose exclude does not. */
function configsCovering(configs: readonly ResolvedConfig[], absFile: string): string[] {
  const covering: string[] = [];
  for (const config of configs) {
    const rel = path.relative(config.root, absFile).split(path.sep).join('/');
    if (rel.startsWith('../') || path.isAbsolute(rel)) continue;
    if (!config.include.some((re) => re.test(rel))) continue;
    if (config.exclude.some((re) => re.test(rel))) continue;
    covering.push(config.label);
  }
  return covering;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...(await walk(path.join(dir, entry.name))));
    } else if (entry.isFile() && TS_FILE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out.sort();
}

const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

const tsFiles = await walk(REPO_ROOT);
const configPaths = await typecheckedConfigs();
const configs = await Promise.all(configPaths.map(resolveConfig));
const uncovered = tsFiles.filter((f) => configsCovering(configs, f).length === 0).map(rel);

describe('tsconfig coverage', () => {
  it('typechecks every TypeScript file on disk under at least one config', () => {
    const orphaned = uncovered.filter((file) => !NOT_TYPECHECKED.has(file));
    expect(
      orphaned,
      orphaned.length === 0
        ? ''
        : `${orphaned.length} TypeScript file(s) exist on disk and are matched by NO config that ` +
          `\`npm run typecheck\` runs, so a type error in them is invisible:\n  ${orphaned.join('\n  ')}\n` +
          'Add them to an `include`, or sign them in NOT_TYPECHECKED with a reason. Writing a ' +
          'comment in tsconfig.json is what was tried last time; it is deleted by the same ' +
          'keystroke as the line it protects.',
    ).toEqual([]);
  });

  it('covers the specific trees the last three occurrences of this defect uncovered', () => {
    // Each of these was, at some point, real source that nothing typechecked. Naming them
    // individually means a config edit that re-opens one fails HERE with the history attached,
    // rather than only in the anonymous list above.
    for (const file of [
      'scripts/profile-corpus.ts', // the corpus profiler every Plan 2 acceptance figure came from
      'scripts/vitest.config.ts', // invisible to `packages/*/vitest.config.ts`, which is how it started
      'e2e/api.spec.ts', // imports server internals across the repo root; run by a command that does not typecheck
      'playwright.config.ts',
      'packages/web/src/lib/contrast.ts', // the whole web tree hangs off the second typecheck leg
      'packages/core/src/matcher.ts',
      'packages/server/src/api/verifyRouter.ts',
    ]) {
      expect(
        configsCovering(configs, path.join(REPO_ROOT, file)),
        `${file} is typechecked by nothing`,
      ).not.toEqual([]);
    }
  });
});

/**
 * The vacuity guards. A filesystem-scanning invariant fails by seeing nothing and passing on the
 * empty set, which is indistinguishable from success — the same silence the whole file breaks.
 */
describe('tsconfig coverage — the invariant can still see', () => {
  it('finds the real TypeScript tree', () => {
    expect(tsFiles.length).toBeGreaterThan(100);
    expect(tsFiles.map(rel)).toContain('packages/server/test/tsconfigCoverage.test.ts');
    expect(tsFiles.map(rel)).toContain('packages/web/src/lib/contrast.ts'); // a .ts under the web tree
    expect(tsFiles.map(rel).some((f) => f.endsWith('.tsx'))).toBe(true);
  });

  it('resolves the configs `npm run typecheck` actually runs, both legs', async () => {
    const labels = configs.map((c) => c.label);
    expect(labels).toContain('tsconfig.json');
    expect(
      labels,
      'the web leg of `npm run typecheck` is gone, so the entire web package is unchecked',
    ).toContain('packages/web/tsconfig.json');
    for (const config of configs) {
      expect(config.include.length, `${config.label} declares no include`).toBeGreaterThan(0);
    }
  });

  it('refuses a typecheck script it cannot read, instead of resolving to nothing', async () => {
    // Proved against the real resolver: an unreadable step must throw, not yield zero configs and
    // then report perfect coverage over an empty config set.
    await expect(resolveConfig(path.join(REPO_ROOT, 'does-not-exist.json'))).rejects.toThrow();
  });

  it('leaves no config matching nothing — the same defect seen from the config side', () => {
    const empty = configs
      .filter((c) => !tsFiles.some((f) => configsCovering([c], f).length > 0))
      .map((c) => c.label);
    expect(empty).toEqual([]);
  });

  it('matches tsconfig globs precisely, and never by matching everything', () => {
    const deep = tsGlobToRegExp('packages/core/src/**/*.ts');
    expect(deep.test('packages/core/src/a.ts')).toBe(true);
    expect(deep.test('packages/core/src/deep/b.ts')).toBe(true);
    expect(deep.test('packages/core/test/a.ts')).toBe(false);
    expect(deep.test('packages/core/src/a.tsx')).toBe(false);

    // The pattern the `scripts/` hole lived in: `*` is one segment and does not reach `scripts/`.
    const oneSegment = tsGlobToRegExp('packages/*/vitest.config.ts');
    expect(oneSegment.test('packages/core/vitest.config.ts')).toBe(true);
    expect(oneSegment.test('scripts/vitest.config.ts')).toBe(false);
    expect(oneSegment.test('packages/a/b/vitest.config.ts')).toBe(false);

    expect(tsGlobToRegExp('vitest.workspace.ts').test('vitest.workspace.ts')).toBe(true);
    expect(tsGlobToRegExp('vitest.workspace.ts').test('a/vitest.workspace.ts')).toBe(false);

    // A bare name with no extension is a DIRECTORY to tsc, which is how `exclude: ["node_modules"]`
    // works. Reading it as a filename would make every default exclude match nothing.
    const dir = tsGlobToRegExp('node_modules');
    expect(dir.test('node_modules/x/index.ts')).toBe(true);
    expect(dir.test('node_modules')).toBe(false);
    expect(tsGlobToRegExp('src/**/*.test.ts').test('src/a/b.test.ts')).toBe(true);
  });

  it('refuses glob syntax it does not understand instead of matching nothing', () => {
    expect(() => tsGlobToRegExp('src/[abc]/*.ts')).toThrow(/unsupported tsconfig glob/);
    expect(() => tsGlobToRegExp('src/{a,b}/*.ts')).toThrow(/unsupported tsconfig glob/);
    expect(() => tsGlobToRegExp('src/**.ts')).toThrow(/unsupported tsconfig glob/);
    expect(() => tsGlobToRegExp('src/a**/b.ts')).toThrow(/unsupported tsconfig glob/);
  });

  it('reads tsconfig as JSON-with-comments, which is what tsconfig.json really is', () => {
    expect(
      parseTsconfigJson('{\n  // a comment\n  "include": ["src/**/*.ts"] /* and a block */\n}'),
    ).toEqual({ include: ['src/**/*.ts'] });
    expect(parseTsconfigJson('{ "include": ["a.ts",] }')).toEqual({ include: ['a.ts'] });
    // THE ONE THAT BIT: a glob containing `/*` is not the start of a comment. Reading it as one
    // deleted two include patterns from the real root config and corrupted everything after them,
    // so this invariant would have been auditing a config nobody wrote.
    expect(
      parseTsconfigJson('{ "include": ["packages/*/vitest.config.ts", "scripts/**/*.ts"] }'),
    ).toEqual({ include: ['packages/*/vitest.config.ts', 'scripts/**/*.ts'] });
    // The real root config carries three explanatory comment blocks AND that glob; parsing it must
    // yield every one of its include patterns, not a subset.
    expect(configs[0]?.include.length).toBeGreaterThan(8);
  });
});

/**
 * The allow-list guards, in the shape the blocklist-parity and user-cascade invariants use: an
 * entry must name a real file, must still be uncovered, and must carry a written reason. A stale
 * exemption is worse than none, because it reads as a reviewed decision while hiding the next one.
 */
describe('tsconfig coverage — no exemption may be vacuous', () => {
  it('names only files that exist and are still typechecked by nothing', () => {
    const wrong = [...NOT_TYPECHECKED.keys()].filter((file) => !uncovered.includes(file));
    expect(
      wrong,
      'listed in NOT_TYPECHECKED but either gone from disk or now covered by a config — delete ' +
        'the entry; a stale exemption hides the next real orphan',
    ).toEqual([]);
  });

  it('gives every exemption a written reason', () => {
    for (const [file, reason] of NOT_TYPECHECKED) {
      expect(reason.trim().length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(20);
    }
  });
});
