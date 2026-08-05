import type { Dirent } from 'node:fs';
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
 * WHAT IT READS. Every non-test source file under the four trees that can run: the server source,
 * the scripts, the e2e harness and the repo-root config. It looks for four things:
 *
 *   1. naming CONTACT_URL other than to set it,
 *   2. calling `buildUserAgent(`,
 *   3. calling `createFetcher(`,
 *   4. opening a socket without going through a fetcher,
 *
 * any of which means "this file decides what identifies the crawler, or talks to the network
 * without one". A file doing 1–3 must be in ENTRY_POINTS below, a file doing 4 must be in
 * DIRECT_NETWORK, and every ENTRY_POINT must import the shared resolver and must not re-implement
 * the default itself. Both lists are short on purpose: adding to one is a decision somebody makes
 * in a review, not something that happens by writing four lines in a hurry.
 *
 * THIS FILE WAS ITSELF WALKED PAST, THREE WAYS, on 2026-08-04. Each hole was demonstrated with a
 * scratch offender that the test as it then stood reported as clean:
 *
 *   1. `const { CONTACT_URL } = process.env` — a destructuring read matched no pattern here,
 *      because the pattern insisted on `process.env.` or `env['…']` immediately before the name.
 *   2. `scripts/poll-c.mjs` — the walk collected `/\.tsx?$/` and nothing else, so a `.mjs` that
 *      built a fetcher was not a file as far as this test was concerned. `scripts/` already
 *      contains one `.mjs`, so this was not hypothetical.
 *   3. `packages/server/src/v2.0/poll.ts` — the walk decided file-versus-directory by asking
 *      whether the NAME CONTAINED A DOT, so any directory with a dot in it (`v2.0`, `api.v2`,
 *      `data.old`) was treated as a file, failed the extension test, and was never descended into.
 *
 * All three are closed below, and each is worth naming rather than silently fixing: a guard that
 * can be walked past is not a guard, and the failure mode of a scanner is that it goes quiet.
 *
 * WHAT IT STILL CANNOT SEE, said plainly: a computed read — `process.env[nameFromSomewhere]`.
 * There is no static pattern for that. What covers it instead is the runtime half —
 * `buildUserAgent` validates whatever it is handed and `createFetcher` refuses a User-Agent that
 * `buildUserAgent` did not produce from the `contactUrl` beside it — so a value obtained that way
 * still cannot reach the wire unvalidated. This test is what notices the NEXT entry point; those
 * are what stop it from doing damage in the meantime.
 */

const REPO_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/** Trees whose files can execute. `packages/web` is a browser bundle and fetches nothing. */
const SCANNED_TREES = ['packages/server/src', 'scripts', 'e2e'];
const SCANNED_ROOT_FILES = ['playwright.config.ts'];

/**
 * The files allowed to decide what identifies this crawler. Four, and each one is a process
 * entry point: the server, the two commands in `scripts/` that poll live sites by hand, and the
 * pacing harness.
 *
 * `scripts/measure-pacing.ts` is the odd one and is listed deliberately rather than exempted. It
 * builds a real fetcher, so it decides what identifies the crawler and belongs here; but unlike the
 * other three it supplies the environment instead of reading it —
 * `resolveContactUrl({ CONTACT_URL: '…' })`, a fixed value, still through the one predicate. That
 * is right because it polls NOBODY: every request it makes goes to a throwaway HTTP server it
 * started on 127.0.0.1 a moment earlier. Making it demand a real operator address would break the
 * reason it exists — the README and the crawler-contact template send a polled site's owner here to
 * reproduce the pacing figures those documents quote, and that reader has no deployment.
 */
const ENTRY_POINTS = [
  'packages/server/src/index.ts',
  'scripts/verify-sources.ts',
  'scripts/capture-fixture.ts',
  'scripts/measure-pacing.ts',
];

/** Where the rules live. Naturally exempt: it is the predicate, not a caller of it. */
const THE_PREDICATE = 'packages/server/src/config.ts';

/**
 * The fetcher is exempt from the `buildUserAgent` rule, and from the direct-network rule below,
 * and from nothing else. It calls `buildUserAgent` to REFUSE a User-Agent it did not produce (see
 * `createFetcher`), which is the opposite of the defect this file guards, and it is the one place
 * that is SUPPOSED to hold `globalThis.fetch`.
 */
const THE_WIRE_BOUNDARY = 'packages/server/src/fetcher/index.ts';

/**
 * The files allowed to open a socket without a fetcher, and why each one is not a poll of a
 * funder's site — which is the only thing `createFetcher` was ever the boundary for.
 *
 * `packages/server/src/ai/assist.ts` constructs the Anthropic SDK client, which makes its own
 * HTTPS request to api.anthropic.com. That is a paid API this operator holds a key for, not one
 * of the ~25 volunteer-run sites; robots.txt, per-host serialisation and a contact URL in the
 * User-Agent are rules about polling strangers and mean nothing here.
 *
 * `e2e/shippedSeed.ts` calls `fetch` against `127.0.0.1:<port>`, which is the server this same
 * harness just started. Routing our own test server's health check through the crawler's politeness
 * machinery would test the machinery, not the server.
 *
 * `packages/server/src/index.ts` supplies the transport for the user-initiated callsign lookup
 * (`POST /api/callsign/lookup`). ADDED 2026-08-04, and it is a decision, not a convenience.
 *
 *   WHY IT IS NOT A POLL. It is one request, to one host, made because a person pressed a button
 *   about their own public licence record, carrying no state and following no link. It enumerates
 *   nothing, repeats nothing and is not scheduled. That is a different act from visiting ~25
 *   volunteer-run sites on a timer, which is the act `createFetcher` is the boundary for, and
 *   `callsign/callook.ts` sets out at length why routing it through the crawler instead would
 *   both be wrong and delete the feature.
 *
 *   WHY IT IS INDEX.TS AND NOT THE CLIENT. `callook.ts` requires its transport and refuses to
 *   default one, precisely so no file below the composition root holds a `fetch`. The transport
 *   therefore has to be built somewhere, and the somewhere has to be a file allowed to call
 *   `buildUserAgent` — which is this list's sibling above, and which is the point: until
 *   2026-08-04 the lookup went out as `user-agent: node`, the only anonymous request this
 *   software made. It now comes off the same factory and the same CONTACT_URL as every crawl
 *   request, differing in ONE clause: the one that says what the request is for, which for a
 *   lookup is not `nightly grant-deadline change detector` (see `config.ts`, and
 *   `CALLSIGN_LOOKUP_PURPOSE` in `callsign/callook.ts`). That clause is a PARAMETER of the single
 *   factory and not a second factory — the check below still requires `buildUserAgent(config)` to
 *   appear in this file and still refuses a hand-spelled `GrantSpotter/…`. Exempting this file is
 *   what let the anonymous request be fixed WITHOUT minting a second User-Agent somewhere the rule
 *   above cannot see.
 *
 *   WHAT THE EXEMPTION COSTS. index.ts can now open a socket without anything noticing, and it is
 *   the largest file on this list. That is bearable only because it is the composition root: it
 *   has no callers, cannot be imported (it runs `main()` at module load), and every line in it is
 *   read by whoever changes how this application is assembled. It is not a licence for a second
 *   `fetch` in here, and a third file wanting one is a decision for whoever is reading this next.
 *
 * `scripts/measure-pacing.ts` imports `node:http` to LISTEN, not to poll. It is the harness that
 * measures the per-host interval this project advertises, and measuring the gap between requests
 * requires a server that records when each one arrived. Its outbound side is a real fetcher — it is
 * in ENTRY_POINTS above for exactly that — so the only thing exempted here is binding a socket on
 * loopback, which no politeness rule has anything to say about. The pattern that catches it is
 * `from 'node:http'`, which cannot tell a listener from a client; the list is what tells them apart.
 *
 * Anything else that wants to talk to the network is polling somebody, and goes through a fetcher.
 */
const DIRECT_NETWORK = [
  'packages/server/src/ai/assist.ts',
  'packages/server/src/index.ts',
  'e2e/shippedSeed.ts',
  'scripts/measure-pacing.ts',
];

/**
 * Any mention of the variable that is not WRITING it.
 *
 * Deliberately broader than "reads it off `process.env`", which is what it used to be: that shape
 * missed `const { CONTACT_URL } = process.env` outright, and would equally have missed
 * `const e = process.env; e.CONTACT_URL`. Every way of getting at the value mentions its name, so
 * the name is what this matches, and the exception is the one shape that is not a read at all:
 * `CONTACT_URL:` or `CONTACT_URL =` followed by something other than `=`, i.e. SETTING it, which
 * is how a harness configures a server it is about to start (`playwright.config.ts`, a spawned
 * child's env). `CONTACT_URL ===` is a comparison, so it stays an offence.
 *
 * `PLACEHOLDER_CONTACT_URL` does not match: `\b` finds no boundary between `_` and `C`, both being
 * word characters. (`DEFAULT_CONTACT_URL` was the other such constant, and is gone — CONTACT_URL is
 * required with no default again, for the reason recorded in `config.ts`.)
 *
 * The second alternative exists because `CONTACT_URL:` is not always a write. In
 * `const { CONTACT_URL: url } = env` it is a RENAMING DESTRUCTURE — a read wearing the punctuation
 * of a write — and the first alternative excused it. What tells the two apart is the `=` after the
 * closing brace: an object literal is not followed by one, an assignment target always is.
 */
const NAMES_THE_VARIABLE = new RegExp(
  [
    String.raw`\bCONTACT_URL\b(?!\s*[:=][^=])`,
    String.raw`\{[^{}]*\bCONTACT_URL\b[^{}]*\}\s*=[^=]`,
  ].join('|'),
);
const BUILDS_A_USER_AGENT = /\bbuildUserAgent\s*\(/;
const MAKES_A_FETCHER = /\bcreateFetcher\s*\(/;

/**
 * Ways to reach the network with no fetcher in the way. Applied line by line, so that a TypeScript
 * method SIGNATURE — `fetch(req: FetchRequest): Promise<FetchedPayload>;`, which is how the
 * `Fetcher` interface and its several test doubles declare themselves — is not mistaken for a call.
 */
const OPENS_A_SOCKET: readonly RegExp[] = [
  /\bglobalThis\s*\.\s*fetch\b/,
  /(?<![.\w$])fetch\s*\(/,
  /\bnew\s+Anthropic\s*\(/,
  /\bfrom\s+['"](?:node:)?https?['"]/,
  /\brequire\s*\(\s*['"](?:node:)?https?['"]\s*\)/,
];
/** `fetch(x: T): R` declares; `fetch(x)` calls. Also skips `import type … from 'node:http'`. */
const NOT_A_CALL = [/(?<![.\w$])fetch\s*\([^)]*\)\s*:/, /\bimport\s+type\b/];

/**
 * Every extension Node will execute, not only `.tsx?`. `scripts/` already contains a `.mjs`, and
 * a `scripts/poll-c.mjs` that built a fetcher was invisible to this file until 2026-08-04.
 */
const RUNNABLE = /\.(?:[cm]?[jt]sx?)$/;
const IS_A_TEST = /\.test\.(?:[cm]?[jt]sx?)$/;

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  let entries: Dirent[];
  try {
    // withFileTypes, not a guess from the name. Deciding file-versus-directory by "does the name
    // contain a dot" made `packages/server/src/v2.0/` a file that failed the extension test, so
    // nothing under it was ever scanned.
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // tree absent in a partial checkout
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.tmp') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, out);
    } else if (RUNNABLE.test(entry.name) && !IS_A_TEST.test(entry.name)) {
      out.push(full);
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
    for (const entry of [...ENTRY_POINTS, ...DIRECT_NETWORK, THE_PREDICATE]) {
      expect(files.map((f) => f.rel)).toContain(entry);
    }
    // The walk descends into a directory whose name contains a dot, and collects every extension
    // Node runs. Both were holes; each is pinned by a file that only the fix can see.
    expect(files.map((f) => f.rel)).toContain('scripts/make-extract-fixture.mjs');
    expect(files.some((f) => /\.mjs$/.test(f.rel))).toBe(true);
  });

  it('lets nobody but a declared entry point name CONTACT_URL', async () => {
    const offenders = (await scannedFiles())
      .filter((f) => f.rel !== THE_PREDICATE && NAMES_THE_VARIABLE.test(f.source))
      .map((f) => f.rel);
    // Note what is NOT an offence: SETTING it (`CONTACT_URL: '…'` in playwright.config.ts or a
    // spawned child's env) is how a harness configures a server, and the server then validates it.
    expect(offenders).toEqual([]);
  });

  it('catches the three shapes that walked past this file', () => {
    // Pinned as data rather than only as behaviour, so that a later "simplification" of the
    // patterns above has to come past the exact strings that defeated their predecessors.
    expect(NAMES_THE_VARIABLE.test('const { CONTACT_URL } = process.env;')).toBe(true);
    expect(NAMES_THE_VARIABLE.test('const { CONTACT_URL: url } = env;')).toBe(true);
    expect(NAMES_THE_VARIABLE.test('const e = process.env;\nconst u = e.CONTACT_URL;')).toBe(true);
    expect(NAMES_THE_VARIABLE.test("if (process.env.CONTACT_URL === '') return;")).toBe(true);
    // …and does not fire on setting it, or on the two constants whose names end in it.
    expect(NAMES_THE_VARIABLE.test("env: { CONTACT_URL: 'https://w9xyz.org/x' }")).toBe(false);
    expect(NAMES_THE_VARIABLE.test("process.env.CONTACT_URL = 'https://w9xyz.org/x';")).toBe(false);
    expect(NAMES_THE_VARIABLE.test('PLACEHOLDER_CONTACT_URL,')).toBe(false);
    expect(NAMES_THE_VARIABLE.test('return DEFAULT_CONTACT_URL;')).toBe(false);
    // A `.mjs` is a file, and `v2.0` is a directory.
    expect(RUNNABLE.test('poll-c.mjs')).toBe(true);
    expect(RUNNABLE.test('poll.cjs')).toBe(true);
    expect(RUNNABLE.test('v2.0')).toBe(false);
    expect(IS_A_TEST.test('robots.test.mjs')).toBe(true);
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
      // …and does not read the variable itself.
      expect(source, entry).not.toMatch(NAMES_THE_VARIABLE);
    }
  });

  /**
   * NOBODY REINTRODUCES A SHARED DEFAULT, UNDER ANY NAME.
   *
   * This assertion was `not.toMatch(/(?:\?\?|\|\|)\s*DEFAULT_CONTACT_URL/)` on the entry points
   * alone, which was the right shape while such a constant existed. It is gone — the owner removed
   * the default because a shared address makes the maintainers of the software the contact for
   * deployments they do not run — so that pattern would now be a gate on nothing.
   *
   * What replaces it is broader in two ways, and is a gate on the restored design rather than on a
   * vanished identifier: it covers EVERY scanned file rather than the three entry points, and it
   * matches the fallback by SHAPE (`?? 'https://…'`) rather than by the name a future author
   * happens to give the constant. `config.ts` is not exempt: it is the file the default lived in.
   */
  it('lets nothing supply a fallback contact URL, by name or by literal', async () => {
    const SUPPLIES_A_FALLBACK = new RegExp(
      [
        String.raw`(?:\?\?|\|\|)\s*['"\`]https?://`, // `process.env.CONTACT_URL ?? 'https://…'`
        String.raw`(?:\?\?|\|\|)\s*[A-Z][A-Z0-9_]*CONTACT_URL\b`, // …or via any such constant
        String.raw`\b(?:DEFAULT|FALLBACK)_CONTACT_URL\b`, // …or one merely declared, awaiting a caller
      ].join('|'),
    );
    const offenders = (await scannedFiles())
      .filter((f) => SUPPLIES_A_FALLBACK.test(f.source))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
    // Vacuity guards: the pattern must fire on each shape it claims to catch.
    for (const offender of [
      "const url = process.env.CONTACT_URL ?? 'https://github.com/x/y/issues';",
      'const url = readIt() || DEFAULT_CONTACT_URL;',
      "export const FALLBACK_CONTACT_URL = 'https://github.com/x/y/issues';",
    ]) {
      expect(SUPPLIES_A_FALLBACK.test(offender), offender).toBe(true);
    }
    // …and not on the shipped placeholder, which is a value the loader REFUSES rather than a
    // fallback it accepts.
    expect(SUPPLIES_A_FALLBACK.test('PLACEHOLDER_CONTACT_URL,')).toBe(false);
    expect(SUPPLIES_A_FALLBACK.test("optional(env, 'CONTACT_URL') ?? ''")).toBe(false);
  });

  /**
   * WHAT `createFetcher` IS AND IS NOT THE BOUNDARY FOR — checked, not asserted in a comment.
   *
   * Its own doc comment used to say "THE WIRE BOUNDARY. Every User-Agent this codebase sends
   * leaves through this function", and two files made that false as written: `ai/assist.ts`
   * constructs the Anthropic SDK, which does its own HTTPS, and `e2e/shippedSeed.ts` calls
   * `globalThis.fetch` against the harness's own server. Neither is a defect — see DIRECT_NETWORK
   * for why each is legitimate — but a structural guarantee that two files already break is a
   * claim, not a guarantee, and this project has spent its whole history deleting exactly that.
   *
   * So the claim was narrowed to the thing that is actually true and worth having (every poll of a
   * third party goes through a fetcher), and this test is what keeps it true: the set of files
   * that reach the network directly is FIXED. A third one is a decision, made here, in review.
   */
  it('keeps the list of files that reach the network without a fetcher closed', async () => {
    const allowed = new Set([...DIRECT_NETWORK, THE_WIRE_BOUNDARY]);
    const offenders: string[] = [];
    for (const file of await scannedFiles()) {
      if (allowed.has(file.rel)) continue;
      const hit = file.source
        .split('\n')
        .filter((line) => !NOT_A_CALL.some((exempt) => exempt.test(line)))
        .some((line) => OPENS_A_SOCKET.some((pattern) => pattern.test(line)));
      if (hit) offenders.push(file.rel);
    }
    expect(offenders).toEqual([]);
  });

  it('finds the direct-network files it exempts, so the exemption is not vacuous', async () => {
    // If a pattern above stops matching, the test before this one goes quiet and passes forever.
    // These two files are the only things standing between that and a real guard.
    const files = await scannedFiles();
    for (const rel of [...DIRECT_NETWORK, THE_WIRE_BOUNDARY]) {
      const source = files.find((f) => f.rel === rel)?.source ?? '';
      const hit = source
        .split('\n')
        .filter((line) => !NOT_A_CALL.some((exempt) => exempt.test(line)))
        .some((line) => OPENS_A_SOCKET.some((pattern) => pattern.test(line)));
      expect(hit, rel).toBe(true);
    }
  });

  /**
   * THE ONE EXEMPTION THAT COULD RE-CREATE THE DEFECT, HELD SHUT.
   *
   * `index.ts` is on DIRECT_NETWORK so that the callsign lookup can be given a transport at the
   * composition root. That exemption switches off the only structural guarantee this file has
   * about that file — and the defect it was granted to FIX was an anonymous request. If somebody
   * later adds a second `fetch` in there, or drops the header while keeping the call, the request
   * goes back to `user-agent: node` and nothing above notices, because the file is on the list.
   *
   * So the exemption is narrowed to exactly what was argued for: ONE call, carrying a User-Agent
   * that came from the one factory. Nothing here checks the wire — `e2e/api.spec.ts` does that
   * against a real socket — this checks that the composition root cannot quietly stop trying.
   */
  it('holds the one exempted fetch in index.ts to a single identified call', async () => {
    const rel = 'packages/server/src/index.ts';
    const source = (await scannedFiles()).find((f) => f.rel === rel)?.source ?? '';
    expect(source, rel).not.toBe('');

    const calls = source.split('\n').filter((line) => /(?<![.\w$])fetch\s*\(/.test(line));
    expect(calls, `${rel} may open exactly one socket of its own`).toHaveLength(1);

    // The identity, and where it came from. `buildUserAgent(config)` and not a literal: a
    // hand-written "GrantSpotter/0.1.0 (…)" here would be a second User-Agent that agrees with
    // the real one until the day somebody changes one of them.
    expect(source).toMatch(/headers\.set\(\s*['"]user-agent['"]/);
    expect(source).toMatch(/buildUserAgent\s*\(\s*config\s*\)/);
    expect(source, `${rel} must not re-spell the User-Agent`).not.toMatch(/GrantSpotter\/\d/);
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
