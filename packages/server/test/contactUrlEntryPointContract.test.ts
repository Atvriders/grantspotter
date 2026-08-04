import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE EVERY-PATH-USES-THE-SAME-PREDICATE INVARIANT.
 *
 * WHAT HAPPENED. `loadConfig` refuses a CONTACT_URL that is a placeholder, a reserved
 * documentation name, an unreachable address, or not a URL at all — and on 2026-08-04 two live
 * scripts did this instead:
 *
 *     const contactUrl = process.env.CONTACT_URL?.trim() || DEFAULT_CONTACT_URL;
 *     const fetcher = createFetcher({ userAgent: buildUserAgent(contactUrl), contactUrl });
 *
 * `scripts/verify-sources.ts` and `scripts/capture-fixture.ts`, both documented in the README,
 * both hitting the same ~25 small-nonprofit sites the nightly crawl hits, and neither one calling
 * the loader. Measured before the fix, against the real command:
 *
 *     $ CONTACT_URL='not a url' npm run verify-sources -- qcwa
 *      ok   qcwa   200   1/1
 *
 * A live 200 from qcwa.org, sent `GrantSpotter/0.1.0 (+not a url; …)`. Every value the loader
 * refuses went out on the wire that way.
 *
 * WHY A TEST AND NOT JUST A FIX. Because fixing the two scripts by hand fixes today's two scripts.
 * The defect is structural — a rule that lives inside one entry point and is skipped by the
 * others — and it is the same shape as this project's suppression-boundary leaks, which recurred
 * four times before `isDoNotPublish` became the one predicate everything called. So this file
 * enumerates the places a contact URL can enter the process, and fails when a new one appears
 * without going through `resolveContactUrl` / `loadConfig`.
 *
 * WHAT IT READS. Every non-test `.ts` under the four trees that can run: the server source, the
 * scripts, the e2e harness and the repo-root config. It looks for three things:
 *
 *   1. reading CONTACT_URL out of an environment,
 *   2. calling `buildUserAgent(`,
 *   3. calling `createFetcher(`,
 *
 * any of which means "this file decides what identifies the crawler". A file doing any of them
 * must be in ENTRY_POINTS below, and every ENTRY_POINT must import the shared resolver and must
 * not re-implement the default itself. The list is short on purpose: adding to it is a decision
 * somebody makes in a review, not something that happens by writing four lines in a hurry.
 *
 * NOT A LINT RULE ON STYLE. Each pattern below describes a way to get an unvalidated value onto
 * the wire, and the runtime guards close the same door from the other side: `buildUserAgent`
 * validates whatever it is handed, and `createFetcher` refuses a User-Agent that `buildUserAgent`
 * did not produce from the `contactUrl` beside it. This test is what notices the NEXT entry point;
 * those are what stop it from doing damage in the meantime.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** Trees whose files can execute. `packages/web` is a browser bundle and fetches nothing. */
const SCANNED_TREES = ['packages/server/src', 'scripts', 'e2e'];
const SCANNED_ROOT_FILES = ['playwright.config.ts'];

/**
 * The files allowed to decide what identifies this crawler. Three, and each one is a process
 * entry point: the server, and the two commands in `scripts/` that poll live sites by hand.
 */
const ENTRY_POINTS = [
  'packages/server/src/index.ts',
  'scripts/verify-sources.ts',
  'scripts/capture-fixture.ts',
];

/** Where the rules live. Naturally exempt: it is the predicate, not a caller of it. */
const THE_PREDICATE = 'packages/server/src/config.ts';

/**
 * The fetcher is exempt from the `buildUserAgent` rule and from nothing else. It calls it to
 * REFUSE a User-Agent it did not produce (see `createFetcher`), which is the opposite of the
 * defect this file guards.
 */
const THE_WIRE_BOUNDARY = 'packages/server/src/fetcher/index.ts';

/** `process.env.CONTACT_URL`, `env.CONTACT_URL`, `env['CONTACT_URL']` — reads, not writes. */
const ENV_READ = /(?:process\.env|\benv)\s*(?:\.\s*CONTACT_URL\b|\[\s*['"]CONTACT_URL['"]\s*\])/;
const BUILDS_A_USER_AGENT = /\bbuildUserAgent\s*\(/;
const MAKES_A_FETCHER = /\bcreateFetcher\s*\(/;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out; // tree absent in a partial checkout
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.tmp') continue;
    const full = path.join(dir, entry);
    if (entry.includes('.')) {
      if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
    } else {
      await walk(full, out);
    }
  }
  return out;
}

/**
 * Comments out, code in.
 *
 * This file's whole subject is a defect that a comment cannot fix, and the fix for it QUOTES the
 * offending line — `scripts/verify-sources.ts` records what it used to do and what that cost, which
 * is how this codebase keeps its reasons. A scanner that matched inside comments would either fail
 * on that record or force it to be deleted, and deleting the record to satisfy the guard is the
 * worst of the available outcomes.
 *
 * Block comments and whole-line `//` comments only. A trailing `//` is deliberately NOT stripped:
 * every URL in this repository contains `//`, and a naive line-comment strip would delete real code
 * after one — the scanner would then go quiet, which is the one failure mode a guard may not have.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

async function scannedFiles(): Promise<Array<{ rel: string; source: string }>> {
  const files: string[] = [];
  for (const tree of SCANNED_TREES) files.push(...(await walk(path.join(REPO_ROOT, tree))));
  for (const file of SCANNED_ROOT_FILES) files.push(path.join(REPO_ROOT, file));
  return Promise.all(
    files.map(async (full) => ({
      rel: path.relative(REPO_ROOT, full),
      source: code(await readFile(full, 'utf8')),
    })),
  );
}

describe('every path that can name this crawler goes through one predicate', () => {
  it('scans a tree that is actually there', async () => {
    // Vacuity guard. Every assertion below is a filter over this list; an empty or tiny list would
    // make all of them pass while checking nothing — which is precisely how the invariant this
    // file replaces ("the scripts check it too", written in a comment) stayed true-looking.
    const files = await scannedFiles();
    expect(files.length).toBeGreaterThan(80);
    for (const entry of ENTRY_POINTS) {
      expect(files.map((f) => f.rel)).toContain(entry);
    }
    expect(files.map((f) => f.rel)).toContain(THE_PREDICATE);
  });

  it('lets nobody but a declared entry point read CONTACT_URL from an environment', async () => {
    const offenders = (await scannedFiles())
      .filter((f) => f.rel !== THE_PREDICATE && ENV_READ.test(f.source))
      .map((f) => f.rel);
    // Note what is NOT an offence: SETTING it (`CONTACT_URL: '…'` in playwright.config.ts or a
    // spawned child's env) is how a harness configures a server, and the server then validates it.
    expect(offenders).toEqual([]);
  });

  it('lets nobody but a declared entry point mint a User-Agent or build a fetcher', async () => {
    const allowed = new Set([...ENTRY_POINTS, THE_PREDICATE, THE_WIRE_BOUNDARY]);
    const offenders = (await scannedFiles())
      .filter((f) => !allowed.has(f.rel))
      .filter((f) => BUILDS_A_USER_AGENT.test(f.source) || MAKES_A_FETCHER.test(f.source))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it('holds every entry point to the shared resolver', async () => {
    const files = await scannedFiles();
    for (const entry of ENTRY_POINTS) {
      const source = files.find((f) => f.rel === entry)?.source ?? '';
      expect(source, entry).not.toBe('');
      // It obtains the value from the one predicate…
      expect(source, entry).toMatch(/\b(resolveContactUrl|loadConfig)\s*\(/);
      // …and does not read the variable itself, or re-implement the default beside it. Both
      // spellings below are the exact shape of the code this file exists to prevent returning.
      expect(source, entry).not.toMatch(ENV_READ);
      expect(source, entry).not.toMatch(/(?:\?\?|\|\|)\s*DEFAULT_CONTACT_URL/);
    }
  });

  /**
   * The same question from the other end. The tests above start at the file tree; this one starts
   * at the list of commands a human is offered — `npm run …` — and follows each to the file it
   * runs. A script added to package.json that quietly fetches something is caught here by being a
   * command, before anybody has to notice it is also a file.
   */
  it('covers every npm script that reaches the network', async () => {
    const pkg = JSON.parse(await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const files = await scannedFiles();
    const networked: string[] = [];
    for (const command of Object.values(pkg.scripts)) {
      for (const match of command.matchAll(/([\w/-]+\.ts)\b/g)) {
        const rel = match[1] as string;
        const source = files.find((f) => f.rel === rel)?.source;
        if (source !== undefined && MAKES_A_FETCHER.test(source)) networked.push(rel);
      }
    }
    expect(networked.length).toBeGreaterThan(0); // vacuity guard on the walk above
    for (const rel of networked) expect(ENTRY_POINTS, rel).toContain(rel);
  });
});
