import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCKED_HOSTS as FETCHER_BLOCKED_HOSTS } from '../src/fetcher/blocklist.js';

/**
 * THE TWO-COPIES-OF-ONE-SECURITY-LIST INVARIANT.
 *
 * `packages/server/src/fetcher/blocklist.ts` holds the hard domain blocklist the crawler enforces.
 * `packages/web/src/lib/safety.ts` RESTATES it, because a Global Constraint makes the import
 * one-way: `web` may import `core` and never `server`. The restatement is correct and the reason
 * for it is correct. What did not exist until this file is anything that notices when the two
 * copies stop agreeing — and until then, "the lists are kept in sync" was a sentence in a comment,
 * which is the same class of guarantee as `adminUsersRouter.ts`'s cascade note: true when written,
 * silent when it stops being.
 *
 * WHY THE DRIFT IS NOT COSMETIC. The two lists guard two different doors:
 *   - the server's stops a FETCH. `farweb.org` is the Foundation for Amateur Radio's domain, taken
 *     over between 2025-10-17 and 2026-02-10 and now 301ing to `batualam.org`, an Indonesian
 *     gambling site, while ARRL, QCWA and club pages still tell applicants to "apply at the FAR
 *     website". Candid, GrantWatch, GrantStation and Instrumentl each prohibit automated access;
 *     three of them ban LLM use of the data outright and Instrumentl's robots.txt names ClaudeBot.
 *   - the web copy stops a LINK. The fetcher never sees `applyUrl` — it is a value the pipeline
 *     stores and the detail page renders, with nothing in between that would refuse it.
 * So a host added to the fetcher's list alone does not fail closed on the UI side: the page keeps
 * rendering a clickable anchor to a domain the crawler has already been told is unsafe, and the
 * failure is invisible from the server, whose own tests all still pass.
 *
 * WHAT THIS FILE DOES, AND WHY IT READS TEXT. It walks `packages/server/src` and `packages/web/src`
 * for the files that DECLARE `export const BLOCKED_HOSTS`, parses the array literal out of each
 * one's source text, and compares them. Reading text rather than importing is what keeps the
 * one-way import rule intact: a server test that imported `packages/web/src/lib/safety.ts` would
 * create the server→web edge in the opposite direction and drag a browser module into a node
 * project to make a point about coupling. It also means this invariant keeps working if the web
 * copy is moved or renamed — the walk finds it wherever it is, and says so by name when there is
 * no longer exactly one of it on each side.
 *
 * It follows the invariants this repo already relies on and is guarded the same way they are:
 * `sources/registry.test.ts` (every module on disk is registered), `normalize/rawFieldsContract`
 * (keys written and read by nothing) and `test/vitestCoverageContract.test.ts` (every test file is
 * matched by a project). The lesson taken from those three is that a filesystem scanner's
 * characteristic failure is to stop seeing anything and pass on an empty set, so the guards below
 * are not decoration:
 *   1. the text-parsed SERVER list must equal the list the fetcher's module actually exports at
 *      runtime — the parser is checked against the real thing, so it cannot pass by hallucinating
 *      the same wrong answer twice;
 *   2. each side must resolve to exactly one declaring file, and each list must be non-trivial and
 *      must still contain the named safety hosts;
 *   3. the parser must THROW, by name, on anything it cannot read as a literal — a spread, a
 *      concat, a computed entry, a template literal — rather than returning a short list that
 *      happens to match;
 *   4. the comparison itself is exercised on synthetic inputs that DO differ, so the red path is
 *      proven in the suite rather than only in the author's memory.
 * Proven by deliberate break on 2026-08-04: adding `example-drift.test` to the web copy alone
 * turned `names exactly the same hosts on both sides` red and printed the host and both file
 * paths. The break was then reverted and the file confirmed byte-identical.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/** The two trees that may declare a copy, and the label each is named by in failure output. */
const SIDES = [
  { label: 'server (the fetcher — the one with teeth)', root: 'packages/server/src' },
  { label: 'web (the UI copy — the one that stops a link)', root: 'packages/web/src' },
] as const;

const DECLARATION = 'export const BLOCKED_HOSTS';

/**
 * Hosts that must be on BOTH lists whatever else changes.
 *
 * `farweb.org` and `batualam.org` are the takeover pair — the hijacked domain and its destination
 * — and are the only two entries here for SAFETY rather than licensing, so they are the two whose
 * silent removal would be worst. Naming them is also the vacuity guard with teeth: a parser that
 * quietly returned `[]` for both sides would satisfy an equality check and fail this one.
 */
const MUST_BE_BLOCKED = ['farweb.org', 'batualam.org'] as const;

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      out.push(...(await walk(p)));
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(p);
    }
  }
  return out.sort();
}

/**
 * The body between the brackets of the `BLOCKED_HOSTS` array literal.
 *
 * Handles both the bare `= [...]` and the `= Object.freeze([...])` form the two files use today by
 * scanning for the first `[` AFTER THE ASSIGNMENT and tracking depth. A `]` inside a string
 * literal would end the scan early; that produces an unterminated string, which `parseHosts`
 * throws on rather than silently returning a truncated list.
 *
 * "After the assignment" is load-bearing and was not obvious. Both real declarations are
 * `export const BLOCKED_HOSTS: readonly string[] = Object.freeze([…])`, so the first `[` after the
 * NAME is the empty pair in the TYPE ANNOTATION — this function's first draft parsed `readonly
 * string[]` and returned an empty body for both files, and the parity check went green because
 * `[] === []`. That is precisely the vacuous pass this whole family of invariants exists to
 * prevent, and it was the vacuity guards below, not the comparison, that caught it.
 *
 * The TRAILER is checked for the same reason: `Object.freeze([…])` and `[…] as const` are the
 * shapes in use, but `[…].concat(EXTRA)` would let the depth scan finish happily on a literal
 * prefix while the real list continued past the bracket.
 */
export function extractArrayBody(source: string, file: string): string {
  const decl = source.indexOf(DECLARATION);
  if (decl === -1) {
    throw new Error(`${file} no longer contains \`${DECLARATION}\``);
  }
  // The assignment `=`, not a comparison or an arrow, and not the `[]` of a type annotation.
  let assign = -1;
  for (let i = decl + DECLARATION.length; i < source.length; i += 1) {
    if (source[i] !== '=') continue;
    if (source[i + 1] === '=' || source[i + 1] === '>') continue;
    if ('=!<>'.includes(source[i - 1] ?? '')) continue;
    assign = i;
    break;
  }
  if (assign === -1) {
    throw new Error(`${file}: \`${DECLARATION}\` is never assigned an array literal`);
  }
  const open = source.indexOf('[', assign);
  if (open === -1) {
    throw new Error(`${file}: \`${DECLARATION}\` is not followed by an array literal`);
  }
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1;
    else if (source[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        const tail = source.slice(i + 1);
        const ends = [tail.indexOf(';'), tail.indexOf('\n')].filter((n) => n >= 0);
        const trailer = tail.slice(0, ends.length > 0 ? Math.min(...ends) : tail.length);
        const residue = trailer.replace(/as\s+const/g, '').replace(/[\s)]/g, '');
        if (residue !== '') {
          throw new Error(
            `${file}: \`${DECLARATION}\` continues past its array literal with "${trailer.trim()}". ` +
              'The list must BE the literal, not a literal something else is added to, or this ' +
              'invariant compares a prefix of the real blocklist and calls it a match.',
          );
        }
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error(`${file}: \`${DECLARATION}\` has an unterminated array literal`);
}

/**
 * Every string literal in an array body, refusing anything else BY NAME.
 *
 * A tokenizer rather than a `match(/'([^']*)'/g)` sweep, because the regex form is exactly how
 * this kind of check goes quietly wrong: `[...EXTRA_HOSTS, 'a.example']` would yield one host and
 * look like a complete answer, and a comment containing an apostrophe would yield a phantom one.
 * Anything that is not whitespace, a comma, a comment or a plain quoted string stops the parse,
 * because a list assembled at runtime is a list this invariant cannot compare and must not
 * pretend to have compared.
 */
export function parseHosts(body: string, file: string): string[] {
  const hosts: string[] = [];
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === ',') {
      i += 1;
    } else if (c === '/' && body[i + 1] === '/') {
      const nl = body.indexOf('\n', i);
      i = nl === -1 ? body.length : nl;
    } else if (c === '/' && body[i + 1] === '*') {
      const end = body.indexOf('*/', i + 2);
      if (end === -1) throw new Error(`${file}: unterminated block comment inside BLOCKED_HOSTS`);
      i = end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      let host = '';
      while (j < body.length && body[j] !== c) {
        if (body[j] === '\\') {
          host += body[j + 1] ?? '';
          j += 2;
        } else {
          host += body[j];
          j += 1;
        }
      }
      if (j >= body.length) {
        throw new Error(`${file}: unterminated string literal inside BLOCKED_HOSTS`);
      }
      hosts.push(host);
      i = j + 1;
    } else {
      const snippet = body.slice(i, i + 40).replace(/\s+/g, ' ').trim();
      throw new Error(
        `${file}: BLOCKED_HOSTS contains something that is not a plain string literal, near ` +
          `"${snippet}". This invariant compares the two lists LITERALLY; a list built at runtime ` +
          'cannot be compared by reading the file, and silently skipping the entry would be the ' +
          'drift this test exists to catch. Keep both copies as flat arrays of quoted hosts.',
      );
    }
  }
  if (hosts.length === 0) {
    throw new Error(
      `${file}: BLOCKED_HOSTS parsed to ZERO hosts. An empty list is never a legitimate answer ` +
        'here, and two empty lists compare equal — so this throws rather than reporting parity ' +
        'between two things it failed to read.',
    );
  }
  return hosts;
}

interface Side {
  readonly label: string;
  /** Repo-relative POSIX path of the file that declares the list. */
  readonly file: string;
  readonly hosts: readonly string[];
}

/** The one file per tree that declares the list, plus the hosts parsed out of it. */
async function resolveSide(side: (typeof SIDES)[number]): Promise<Side> {
  const root = path.resolve(REPO_ROOT, side.root);
  const files = await walk(root);
  const declaring: string[] = [];
  for (const file of files) {
    if ((await readFile(file, 'utf8')).includes(DECLARATION)) declaring.push(file);
  }
  const rel = (abs: string): string => path.relative(REPO_ROOT, abs).split(path.sep).join('/');
  if (declaring.length !== 1) {
    throw new Error(
      `${side.root} declares \`${DECLARATION}\` in ${declaring.length} file(s) ` +
        `(${declaring.map(rel).join(', ') || 'none'}), expected exactly 1. ` +
        (declaring.length === 0
          ? 'If the copy moved, this walk will find it wherever it lives — if it was DELETED, the ' +
            'other side is now unguarded and that is the defect.'
          : 'Two copies on one side is the same drift risk one level down.'),
    );
  }
  const file = declaring[0];
  const source = await readFile(file, 'utf8');
  return { label: side.label, file: rel(file), hosts: parseHosts(extractArrayBody(source, rel(file)), rel(file)) };
}

/** Hosts present on one side and missing from the other, in both directions. */
export function divergence(
  a: readonly string[],
  b: readonly string[],
): { onlyInA: string[]; onlyInB: string[] } {
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    onlyInA: [...setA].filter((h) => !setB.has(h)).sort(),
    onlyInB: [...setB].filter((h) => !setA.has(h)).sort(),
  };
}

const [server, web] = await Promise.all(SIDES.map(resolveSide));

describe('blocklist parity — the fetcher list and the UI copy', () => {
  it('names exactly the same hosts on both sides', () => {
    const { onlyInA: onlyOnServer, onlyInB: onlyOnWeb } = divergence(server.hosts, web.hosts);
    const lines: string[] = [];
    if (onlyOnServer.length > 0) {
      lines.push(
        `BLOCKED BY THE FETCHER, STILL LINKABLE IN THE UI: ${onlyOnServer.join(', ')}\n` +
          `  present in ${server.file}, missing from ${web.file}\n` +
          '  The crawler refuses these hosts and the detail page will still render them as an ' +
          'anchor, because nothing between the pipeline and the page refuses an applyUrl.',
      );
    }
    if (onlyOnWeb.length > 0) {
      lines.push(
        `WITHHELD BY THE UI, STILL CRAWLABLE: ${onlyOnWeb.join(', ')}\n` +
          `  present in ${web.file}, missing from ${server.file}\n` +
          '  The fetcher is the copy with teeth; a host only the UI knows about is one the ' +
          'crawler will happily go and fetch.',
      );
    }
    expect(
      { onlyOnServer, onlyOnWeb },
      lines.length === 0
        ? ''
        : `${server.file} and ${web.file} have drifted:\n${lines.join('\n')}\n` +
          'Fix by copying the entry across, not by deleting the other one.',
    ).toEqual({ onlyOnServer: [], onlyOnWeb: [] });
  });

  it('lists them in the same order, so the two files can be read side by side', () => {
    const { onlyInA, onlyInB } = divergence(server.hosts, web.hosts);
    const sameHosts = onlyInA.length === 0 && onlyInB.length === 0;
    expect(
      web.hosts,
      sameHosts
        ? `${web.file} names the same hosts as ${server.file} but in a different order. Reorder ` +
          'the copy to match the fetcher; a diff nobody can read line-for-line is how the next ' +
          'entry gets added to one side only.'
        : 'The two lists do not hold the same hosts at all — fix the `names exactly the same ' +
          'hosts on both sides` failure first; this one is a consequence of it, not a second ' +
          'defect.',
    ).toEqual([...server.hosts]);
  });
});

describe('blocklist parity — the invariant can still see', () => {
  it('parses a real, non-trivial list out of each file', () => {
    for (const side of [server, web]) {
      expect(side.hosts.length, `${side.file} parsed to nothing`).toBeGreaterThanOrEqual(6);
      expect(new Set(side.hosts).size, `${side.file} repeats a host`).toBe(side.hosts.length);
      for (const host of side.hosts) {
        expect(host, `${side.file} parsed a value that is not a hostname`).toMatch(
          /^[a-z0-9.-]+\.[a-z]{2,}$/,
        );
      }
    }
  });

  it('still blocks the hijacked FAR domain and its gambling destination, on both sides', () => {
    for (const side of [server, web]) {
      for (const host of MUST_BE_BLOCKED) {
        expect(side.hosts, `${side.file} no longer blocks ${host}`).toContain(host);
      }
    }
  });

  it('agrees with the module the fetcher actually loads', () => {
    // The parser checked against the real thing. Without this, a text scan that returned the same
    // wrong answer for both files would pass every test above.
    expect(server.hosts).toEqual([...FETCHER_BLOCKED_HOSTS]);
  });

  it('would notice a one-host divergence, in either direction', () => {
    expect(divergence(['a.test', 'b.test'], ['a.test'])).toEqual({
      onlyInA: ['b.test'],
      onlyInB: [],
    });
    expect(divergence(['a.test'], ['a.test', 'b.test'])).toEqual({
      onlyInA: [],
      onlyInB: ['b.test'],
    });
    expect(divergence(['a.test'], ['a.test'])).toEqual({ onlyInA: [], onlyInB: [] });
    // Order alone is not a divergence — that is the second test's job, with its own message.
    expect(divergence(['a.test', 'b.test'], ['b.test', 'a.test'])).toEqual({
      onlyInA: [],
      onlyInB: [],
    });
  });

  it('reads hosts out of both declaration forms, past comments', () => {
    const frozen = `${DECLARATION}: readonly string[] = Object.freeze([\n  'a.test', // why\n  /* also */ 'b.test',\n]);`;
    expect(parseHosts(extractArrayBody(frozen, 'synthetic'), 'synthetic')).toEqual([
      'a.test',
      'b.test',
    ]);
    const bare = `${DECLARATION} = ["a.test", 'b.test'];`;
    expect(parseHosts(extractArrayBody(bare, 'synthetic'), 'synthetic')).toEqual([
      'a.test',
      'b.test',
    ]);
  });

  it('refuses a list it cannot read literally, instead of comparing a short one', () => {
    const cases: Array<[string, RegExp]> = [
      [`${DECLARATION} = [...EXTRA, 'a.test'];`, /not a plain string literal/],
      [`${DECLARATION} = [MORE_HOSTS[0], 'a.test'];`, /not a plain string literal/],
      [`${DECLARATION} = [\`\${prefix}.test\`];`, /not a plain string literal/],
      // The list is a PREFIX of the real one. The depth scan finishes on a valid literal, so only
      // the trailer check stands between this and a parity report about half a blocklist.
      [`${DECLARATION} = ['a.test'].concat(EXTRA);`, /continues past its array literal/],
      [`${DECLARATION} = [...EXTRA];`, /not a plain string literal/],
      [`${DECLARATION} = [];`, /parsed to ZERO hosts/],
    ];
    for (const [source, message] of cases) {
      expect(() => parseHosts(extractArrayBody(source, 'synthetic'), 'synthetic'), source).toThrow(
        message,
      );
    }
    expect(() => extractArrayBody('const OTHER = [];', 'synthetic')).toThrow(/no longer contains/);
    expect(() => extractArrayBody(`${DECLARATION}: readonly string[];`, 'synthetic')).toThrow(
      /never assigned an array literal/,
    );
    expect(() => extractArrayBody(`${DECLARATION} = ;`, 'synthetic')).toThrow(
      /not followed by an array literal/,
    );
    expect(() => extractArrayBody(`${DECLARATION} = ['a.test';`, 'synthetic')).toThrow(
      /unterminated array literal/,
    );
    expect(() => parseHosts(`'a.test`, 'synthetic')).toThrow(/unterminated string literal/);
    expect(() => parseHosts("/* open 'a.test'", 'synthetic')).toThrow(/unterminated block comment/);
  });

  it('reads past a type annotation rather than parsing the "[]" in it', () => {
    // The bug this file shipped with for ten minutes, pinned as a property. Both real
    // declarations carry `: readonly string[]`, and taking the first `[` after the NAME returns
    // that empty pair — for BOTH files, so the comparison passed on two empty lists.
    const annotated = `${DECLARATION}: readonly string[] = Object.freeze(['a.test', 'b.test']);`;
    expect(parseHosts(extractArrayBody(annotated, 'synthetic'), 'synthetic')).toEqual([
      'a.test',
      'b.test',
    ]);
  });

  it('found the two files by walking, not by trusting a hard-coded path', () => {
    // Named here so a failure says WHICH file drifted; the paths are an output of the walk, not an
    // input to it, so moving either copy keeps this invariant working.
    expect(server.file).toBe('packages/server/src/fetcher/blocklist.ts');
    expect(web.file).toBe('packages/web/src/lib/safety.ts');
  });
});
