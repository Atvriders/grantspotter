import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ROOT } from '../../test/fixtures.js';
import { SOURCES, getSource, listSourceIds } from './registry.js';
import { hasFollowUp, isSignalSource, resolveRequests } from './types.js';

const SOURCES_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Every `.ts` file under `sources/`, at any depth, that is not a test.
 *
 * RECURSIVE ON PURPOSE (Plan 2 close-out review). `registry completeness` below used a
 * non-recursive `readdir`, so a fully-formed unregistered `SourceModule` at
 * `sources/<anything>/foo.ts` was invisible to it — `sources/util/` already sets the subdirectory
 * precedent, so that was one `mkdir` away from silently never being crawled.
 */
async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(p);
    }
  };
  await walk(SOURCES_DIR);
  return out.sort();
}

/** Repo-relative-to-`sources/` POSIX path, which is how every message and allow-list below names a file. */
const relToSources = (abs: string): string => path.relative(SOURCES_DIR, abs).split(path.sep).join('/');

/**
 * Files under `sources/` that deliberately export NO `SourceModule`, each with the reason it is
 * not one. The guards below refuse a stale entry: a listed file must still exist and must still
 * export no module, so wiring a source into one of these turns this list red instead of letting
 * the module ride in unregistered.
 */
const NOT_A_SOURCE_MODULE: ReadonlyMap<string, string> = new Map([
  // `registry.ts` is deliberately NOT here: it re-exports every registered module, so it passes
  // the rule below on its own terms and stays under the unregistered-module check.
  ['types.ts', 'The SourceModule type and its guards; no source data of its own.'],
  ['util/dates.ts', 'Date parsing shared by parsers. Pure text helpers, no module.'],
  ['util/ids.ts', 'Stable external-key hashing shared by parsers. Pure, no module.'],
  ['util/payload.ts', 'Payload selection/decoding helpers used by parse() implementations.'],
  [
    'util/proseWindow.ts',
    'Reads a funder\'s window sentence ("open May 1 and close July 31 each year") into month-days, ' +
      'and a year only when the page prints one. A pure string->object function shared by the four ' +
      'sources that state a window in prose; no payloads, no module.',
  ],
  ['util/rss.ts', 'RSS/Atom item extraction shared by the three feed parsers.'],
  ['util/singlePage.ts', 'The single-landing-page parser body that Tier C modules are built from.'],
  ['util/text.ts', 'HTML-to-text flattening and label matching shared by every HTML parser.'],
]);

/**
 * The only module specifiers a source module may import.
 *
 * AN ALLOW-LIST, NOT A DENY-LIST (Plan 2 close-out review). `FORBIDDEN` used to be a handful of
 * substrings — `globalThis.fetch`, `node-fetch`, `node:https`, `node:http`, `better-sqlite3` — and
 * the reviewer walked straight past it with `node:fs`, `undici` (already in `node_modules`),
 * `node:child_process`, un-prefixed `'https'`, and a bare `await fetch(url)`. A deny-list of an
 * open set can only ever enumerate the paths somebody already thought of; the set of things a
 * parser is ALLOWED to reach is tiny, closed, and stated here.
 */
const ALLOWED_IMPORTS: ReadonlySet<string> = new Set([
  'cheerio', // the HTML parser every Tier B/C module is built on
  '@grantspotter/core', // shared types only
  'node:crypto', // util/ids.ts: stable hashing, no I/O
]);

/** Egress and side-effect shapes that need no import at all, so the import rule above cannot see them. */
const FORBIDDEN_CALLS: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /(?<![\w$.])fetch\s*\(/, what: 'a bare fetch() call — the global one is still egress' },
  { re: /globalThis\s*\.\s*fetch/, what: 'globalThis.fetch' },
  { re: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { re: /\bWebSocket\b/, what: 'a WebSocket' },
  { re: /\bEventSource\b/, what: 'an EventSource' },
  { re: /(?<![\w$.])require\s*\(/, what: 'CommonJS require()' },
  { re: /\bcreateRequire\b/, what: 'createRequire(), which reaches the module loader at runtime' },
  { re: /(?<![\w$.])import\s*\(/, what: 'a dynamic import(), which can name anything at runtime' },
  { re: /\bprocess\s*\.\s*(?:env|argv|binding|cwd)\b/, what: 'the process environment' },
  // Bare calls only. `(?<![\w$.])` keeps `RE.exec(text)` — which every parser here uses — from
  // reading as `child_process.exec`; the import allow-list is what actually bars the module, and
  // these patterns are the second line for a global that needs no import.
  {
    re: /(?<![\w$.])(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/,
    what: 'a child process',
  },
  {
    re: /(?<![\w$.])(?:readFile|readFileSync|writeFile|writeFileSync|appendFile|appendFileSync|createReadStream|createWriteStream|readdir|readdirSync)\s*\(/,
    what: 'the filesystem',
  },
];

/** Comments are stripped before scanning: prose about fetching is not fetching. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every module specifier a file imports or re-exports, including type-only imports. */
function importSpecifiers(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:^|[\s;}])(?:import|export)\b[^'"();]*?from\s*['"]([^'"]+)['"]/g)) {
    out.push(m[1]);
  }
  for (const m of src.matchAll(/(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  return out;
}

describe('source registry invariants', () => {
  it('has unique kebab-case ids', () => {
    const ids = listSourceIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('gives every module a funderId, label, tier, klass and a non-negative expectedMinRecords', () => {
    for (const m of SOURCES) {
      expect(m.funderId).not.toBe('');
      expect(m.label).not.toBe('');
      expect(['A', 'B', 'C', 'D']).toContain(m.tier);
      expect(['ham_grant', 'ham_scholarship', 'adjacent_stem', 'equipment_in_kind']).toContain(
        m.klass,
      );
      expect(m.expectedMinRecords).toBeGreaterThanOrEqual(0);
    }
  });

  it('resolves every requests list without touching the network', async () => {
    for (const m of SOURCES) {
      const requests = await resolveRequests(m);
      for (const r of requests) {
        expect(['GET', 'POST']).toContain(r.method);
        expect(['html', 'json', 'xml', 'binary']).toContain(r.accept);
        expect(() => new URL(r.url)).not.toThrow();
        expect(new URL(r.url).protocol).toMatch(/^https?:$/);
      }
    }
  });

  it('getSource throws a useful error for an unknown id', () => {
    expect(() => getSource('nope')).toThrow(/nope/);
  });

  it('type guards agree with the shape of each module', () => {
    for (const m of SOURCES) {
      if (hasFollowUp(m)) expect(typeof m.followUp).toBe('function');
      if (isSignalSource(m)) expect(m.signalOnly).toBe(true);
    }
  });

  /**
   * A REAL CAPTURE, not a directory (Plan 2 close-out review).
   *
   * This used to assert `readdir(dir).length > 0`, which the reviewer satisfied with a directory
   * holding one `README.md` — so "every registered source has a fixture directory" could be true
   * of a source that has never been captured at all, which is precisely the state the check exists
   * to make impossible. The convention across this repo (and in `scripts/profile-corpus.ts`) is
   * that a REAL captured payload is named `NN-<host-and-path>.<ext>`; `pathological.*` and
   * `README.md` are hand-written. So: at least one non-empty `NN-` file, or a signed exemption.
   */
  it('every registered source has a real captured fixture, not just a directory', async () => {
    const missing: string[] = [];
    for (const m of SOURCES) {
      if (NO_CAPTURE_BY_DESIGN.has(m.id)) continue;
      const dir = path.join(FIXTURE_ROOT, m.id);
      if ((await realCaptures(dir)).length === 0) {
        missing.push(
          `source "${m.id}" has no real captured fixture (a non-empty NN-*.* file) at ${dir}`,
        );
      }
    }
    expect(missing).toEqual([]);
  });

  /**
   * THE FETCHER IS THE ONLY EGRESS PATH — enforced as a closed allow-list of imports plus a list
   * of the egress shapes that need no import (see ALLOWED_IMPORTS / FORBIDDEN_CALLS above for why
   * the old substring deny-list was not a gate).
   */
  it('no source module performs I/O — the fetcher is the only egress path', async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(10);
    const violations: string[] = [];
    for (const file of files) {
      const src = stripComments(await readFile(file, 'utf8'));
      const where = relToSources(file);
      for (const spec of importSpecifiers(src)) {
        if (spec.startsWith('./') || spec.startsWith('../')) continue;
        if (ALLOWED_IMPORTS.has(spec)) continue;
        violations.push(
          `${where} imports "${spec}", which is not in ALLOWED_IMPORTS. A parser takes payloads ` +
            'in and returns records out; anything it needs to reach belongs in the fetcher.',
        );
      }
      for (const { re, what } of FORBIDDEN_CALLS) {
        if (re.test(src)) violations.push(`${where} reaches ${what}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

/**
 * Fixture directories that hold no real capture, on purpose. Same contract as every other
 * allow-list here: it must name a registered source, the condition must still hold, and the reason
 * is what somebody signed.
 */
const NO_CAPTURE_BY_DESIGN: ReadonlyMap<string, string> = new Map([
  [
    'manual-tier-d',
    'Tier D is hand-curated records with `requests: []` — there is no poll to capture. Its 16 ' +
      'records live in the module itself and its README records where each came from.',
  ],
]);

/** Non-empty files following the `NN-…` real-capture naming convention. */
async function realCaptures(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^\d\d-/.test(entry.name)) continue;
    if ((await stat(path.join(dir, entry.name))).size > 0) out.push(entry.name);
  }
  return out;
}

describe('the fixture exemption list stays honest', () => {
  it('names registered sources that really do have no capture, with a reason', async () => {
    for (const [id, reason] of NO_CAPTURE_BY_DESIGN) {
      expect(listSourceIds(), `${id} is exempted but is not a registered source`).toContain(id);
      expect(reason.trim().length, `${id} needs a real reason, not a placeholder`).toBeGreaterThan(20);
      const captures = await realCaptures(path.join(FIXTURE_ROOT, id));
      expect(
        captures,
        `${id} now HAS a real capture (${captures.join(', ')}) — delete its NO_CAPTURE_BY_DESIGN ` +
          'entry so the check above starts guarding it',
      ).toEqual([]);
    }
  });
});

/**
 * Every source module on disk must be reachable from SOURCES.
 *
 * This exists because nine parser tasks ran concurrently and all had to edit this one
 * shared file. They converged correctly, but nothing proved it: the other tests in this
 * file only validate the modules that ARE registered, so a module that exists and is
 * simply never wired in would be silently never crawled — a gate that checks nothing.
 *
 * THE PLAN 2 CLOSE-OUT REVIEW GOT THREE MODULES PAST IT, full suite green each time:
 *   - a fully-formed module in a SUBDIRECTORY (`readdir` was not recursive);
 *   - a module returned by a FACTORY (`typeof candidate === 'object'` rejects functions);
 *   - a module inside a WRAPPER OBJECT or a `Map` (`Object.values(mod).flatMap(...)` unwrapped
 *     arrays, one level, and nothing else).
 * All three are now reachable: the walk is recursive, and `sourceModulesIn` descends through
 * arrays, Maps, Sets, plain objects and zero-argument factories.
 *
 * And because no reflection can ever be exhaustive, the rule is inverted as well as widened: a
 * file under `sources/` must CONTRIBUTE a registered module or be signed for in
 * `NOT_A_SOURCE_MODULE`. A shape this scan cannot see yields nothing, and yielding nothing is now
 * itself the failure — which is the only form of this check that does not depend on having
 * imagined the smuggler's export shape in advance.
 */
function sourceModulesIn(
  value: unknown,
  seen: Set<unknown> = new Set(),
  depth = 0,
): Array<{ id: string }> {
  if (depth > 4 || value === null || value === undefined) return [];
  if (typeof value === 'function') {
    if (value.length !== 0) return [];
    try {
      return sourceModulesIn((value as () => unknown)(), seen, depth + 1);
    } catch {
      return []; // a factory that needs a world we are not giving it is not smuggling anything
    }
  }
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const self = value as { id?: unknown; parse?: unknown };
  if (typeof self.id === 'string' && typeof self.parse === 'function') return [{ id: self.id }];

  const children: unknown[] =
    value instanceof Map
      ? [...value.values()]
      : value instanceof Set || Array.isArray(value)
        ? [...(value as Iterable<unknown>)]
        : Object.values(value);
  return children.flatMap((child) => sourceModulesIn(child, seen, depth + 1));
}

describe('registry completeness', () => {
  it('registers every source module that exists on disk, in every export shape', async () => {
    const registered = new Set(listSourceIds());
    const problems: string[] = [];

    for (const file of await sourceFiles()) {
      const where = relToSources(file);
      // An allow-listed helper is exempt from "must contribute a module" — never from "may not
      // smuggle an unregistered one", so it is scanned either way.
      const mod: Record<string, unknown> = await import(pathToFileURL(file).href);
      const found = sourceModulesIn(mod);
      for (const candidate of found) {
        if (!registered.has(candidate.id)) {
          problems.push(`${where} exports SourceModule "${candidate.id}" which is not in SOURCES`);
        }
      }
      if (found.length === 0 && !NOT_A_SOURCE_MODULE.has(where)) {
        problems.push(
          `${where} exports no SourceModule at all. Either it is a source (export its module so ` +
            'the registry can be checked against it) or it is a helper, which has to be named in ' +
            'NOT_A_SOURCE_MODULE with a reason.',
        );
      }
    }

    expect(problems).toEqual([]);
  });

  it('keeps NOT_A_SOURCE_MODULE honest: every entry exists and still exports no module', async () => {
    const onDisk = new Set((await sourceFiles()).map(relToSources));
    for (const [where, reason] of NOT_A_SOURCE_MODULE) {
      expect(reason.trim().length, `${where} needs a real reason, not a placeholder`).toBeGreaterThan(
        20,
      );
      expect([...onDisk], `${where} is listed but no longer exists`).toContain(where);
      const mod: Record<string, unknown> = await import(
        pathToFileURL(path.join(SOURCES_DIR, where)).href
      );
      expect(
        sourceModulesIn(mod).map((m) => m.id),
        `${where} is listed as "not a source module" but now exports one — delete the entry`,
      ).toEqual([]);
    }
  });

  /**
   * The vacuity guard. Every check in this file is a scan, and a scan that stops seeing the tree
   * passes on an empty set. These pin both halves against facts known from reading the code.
   */
  it('can still see the tree it is scanning', async () => {
    const files = (await sourceFiles()).map(relToSources);
    expect(files.length).toBeGreaterThan(15);
    expect(files).toContain('registry.ts');
    expect(files).toContain('util/text.ts'); // the subdirectory the recursive walk exists for
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
    expect(SOURCES.length).toBeGreaterThan(20);

    // The four export shapes that reach a module today, plus the three the review smuggled past
    // the old scan. Each must be found by value, not by name.
    const single = { m: { id: 'x', parse: (): [] => [] } };
    expect(sourceModulesIn(single).map((m) => m.id)).toEqual(['x']);
    expect(sourceModulesIn({ arr: [{ id: 'a', parse: (): [] => [] }] }).map((m) => m.id)).toEqual(['a']);
    expect(
      sourceModulesIn({ f: () => ({ id: 'factory', parse: (): [] => [] }) }).map((m) => m.id),
    ).toEqual(['factory']);
    expect(
      sourceModulesIn({ w: { nested: { id: 'wrapped', parse: (): [] => [] } } }).map((m) => m.id),
    ).toEqual(['wrapped']);
    expect(
      sourceModulesIn({ m: new Map([['k', { id: 'mapped', parse: (): [] => [] }]]) }).map((m) => m.id),
    ).toEqual(['mapped']);
    expect(
      sourceModulesIn({ s: new Set([{ id: 'setted', parse: (): [] => [] }]) }).map((m) => m.id),
    ).toEqual(['setted']);
    // ...and a cycle must terminate rather than hang the suite.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(sourceModulesIn(cyclic)).toEqual([]);
  });
});
