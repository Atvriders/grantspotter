import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * No compiler output may sit beside its source.
 *
 * WHY THIS EXISTS, AND WHY .gitignore WAS NOT ENOUGH.
 *
 * A failed `tsc` run without `-outDir` emits `.js` / `.d.ts` / `.map` files
 * next to the `.ts` files they came from. Forty-four of them appeared in
 * `packages/core/src` and `scripts/` during Plan 5.
 *
 * This codebase uses ESM with explicit `.js` extensions on relative imports
 * (`import './amount.js'`), so a stale `amount.js` sitting beside `amount.ts`
 * WINS runtime resolution. The observed consequence was not theoretical: a
 * re-emitted set silently re-opened the export suppression leak, and the only
 * thing that caught it was an unrelated byte-identity comparison.
 *
 * Commit eb3e74a then gitignored the pattern — correct, because they must never
 * be committed to a public repo, but it made the hazard INVISIBLE to
 * `git status` while leaving the cause untouched. Ignoring a symptom is how
 * this project's worst defects have always survived; the fix is to ignore them
 * in git AND fail loudly when they exist.
 *
 * If this test is red: delete the files (they are regenerable), then find the
 * build that emitted them. Real output belongs in each package's own dist
 * directory, never beside the source.
 *
 * (Note for editors: do not write a glob containing an asterisk-slash in this
 * comment — it closes the block early and the rest of the file parses as code.
 * That is exactly how this file first failed to compile.)
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Source trees that must contain only source. */
const SOURCE_TREES = ['packages/core/src', 'packages/server/src', 'packages/web/src', 'scripts'];

const EMITTED = /\.(js|jsx|d\.ts|js\.map|d\.ts\.map)$/;

/**
 * `packages/web/src` is Vite's tree and legitimately holds hand-written `.js`
 * only if someone adds one; today it holds none. Anything matching EMITTED in
 * these trees is compiler output, because every source file here is `.ts`/`.tsx`.
 * Config files at a package root (`vitest.config.ts`) are outside these trees.
 */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // tree absent in a partial checkout — nothing to police
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EMITTED.test(entry)) out.push(relative(REPO_ROOT, full));
  }
  return out;
}

describe('no compiler output beside its source', () => {
  it('finds no emitted .js/.d.ts/.map in any source tree', () => {
    const stray = SOURCE_TREES.flatMap((t) => walk(join(REPO_ROOT, t))).sort();
    expect(
      stray,
      'Compiler output is sitting beside its source. These files win ESM resolution over the ' +
        '.ts they shadow, so tests can silently exercise code that no longer exists — that is ' +
        'how a fixed suppression leak briefly came back. Delete them, then find the build that ' +
        'emitted them; real output goes to packages/*/dist.',
    ).toEqual([]);
  });

  // Vacuity guard: a walker that stopped walking would pass the check above on
  // an empty list, which is the same silence the check exists to break.
  //
  // It counts .ts AND .tsx, recursively. The first version counted only
  // top-level `.ts` and went red on a clean tree, because packages/web/src
  // holds .tsx and keeps its sources in subdirectories — a vacuity guard that
  // cries wolf gets deleted, which would leave the real check unguarded.
  it('actually walks the source trees it claims to police', () => {
    function countSources(dir: string): number {
      let n = 0;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return 0;
      }
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) n += countSources(full);
        else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) n += 1;
      }
      return n;
    }

    for (const tree of SOURCE_TREES) {
      expect(
        countSources(join(REPO_ROOT, tree)),
        `${tree} contains no TypeScript — the path is wrong, so the check above is walking nothing`,
      ).toBeGreaterThan(0);
    }
  });
});

/**
 * No source file may contain a literal NUL byte.
 *
 * WHY THIS IS WORTH A TEST AND NOT A STYLE NOTE. A NUL is what `grep` uses to decide a file is
 * BINARY, and a binary file is one it reports nothing about instead of reporting a match. So a
 * source file carrying one drops silently out of every search anybody runs over this repository —
 * including the searches this codebase relies on to keep its own invariants, several of which are
 * tests that walk the tree looking for a pattern.
 *
 * TWO FILES HAD ONE, both the same slip: `\x00` and `\0` are what somebody meant to type, and the
 * literal character is what arrived. `api/auth.ts:1187` used it to join a peer address to an email
 * for a rate-limit key — a NUL is a good separator there precisely because neither half can contain
 * one — and `web/src/test/responsive.test.ts:418` used it as a sentinel that could not match.
 * Both intents were right; only the spelling was wrong, and it cost nothing until you searched.
 *
 * It was found by an adversarial verifier, and the way it was found is the argument for this test:
 * an earlier agent had ALREADY met the symptom, noted that `grep` was skipping `auth.ts` as binary,
 * and worked around it by passing `-a` — treating a broken file as a broken tool. A repository this
 * one searches to check itself cannot afford a file that searches cannot see.
 *
 * Write the escape. It compiles to the same byte at runtime and leaves the source readable to
 * everything that reads source.
 */
describe('no source file is invisible to search', () => {
  it('contains no literal NUL byte in any source tree', () => {
    const offenders: string[] = [];
    const scan = (dir: string): void => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          scan(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        if (readFileSync(full).includes(0)) offenders.push(relative(REPO_ROOT, full));
      }
    };
    for (const tree of SOURCE_TREES) scan(join(REPO_ROOT, tree));

    expect(
      offenders.sort(),
      'These files carry a literal NUL, so `grep` calls them binary and silently reports nothing ' +
        'about them — including to the tests in this repository that search the tree to check an ' +
        'invariant. Write the escape (`\\x00`, `\\0`) instead: same byte at runtime, still readable ' +
        'to every tool that reads source.',
    ).toEqual([]);
  });
});
