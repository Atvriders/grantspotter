import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * NOT `new URL('./print.css', import.meta.url)`. This project runs in jsdom, whose global `URL`
 * shadows Node's and resolves a relative reference against the DOCUMENT's base rather than the
 * base it was handed — `AppShell.test.tsx` documents the same trap. `fileURLToPath` on the plain
 * string is unaffected, so navigation from here on is `node:path`, never `new URL(...)`.
 */
const PRINT_CSS_PATH = join(fileURLToPath(import.meta.url), '..', 'print.css');
const WEB_SRC = join(fileURLToPath(import.meta.url), '..', '..');
const css = readFileSync(PRINT_CSS_PATH, 'utf8');

/** A CSS source with its `/* … *\/` comments blanked out, so prose in them is never read as code. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * Every class selector a stylesheet mentions, deduplicated — COMMENTS EXCLUDED.
 *
 * The exclusion is not cosmetic. `print.css`'s own header lists the class names it styles in
 * prose and names `print.test.ts`, so reading the raw text produced `test` and `ts` as class
 * names (from "print.test.ts") and put two selectors nothing could ever ship into the drift
 * check below.
 */
function classesIn(source: string): string[] {
  const matches = withoutComments(source).match(/\.[A-Za-z_][A-Za-z0-9_-]*/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

/**
 * Every class name a component really puts on an element, read out of `className`.
 *
 * Both spellings this codebase uses: a plain string, and a `{...}` expression holding template
 * literals and conditional branches (`` `print-button no-print ${className}` ``,
 * `mark === undefined ? 'profile-help' : 'callsign-filled'`). The interpolations themselves are
 * unknowable statically, so a class assembled entirely at runtime is invisible here — but no rule
 * in `print.css` names one, and a false "this is dead" is worse than a false "this is alive".
 */
function renderedClassNames(source: string): string[] {
  const body = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1 ');
  const out: string[] = [];
  const take = (value: string): void => {
    for (const token of value.split(/[\s${}]+/)) if (token !== '') out.push(token);
  };
  for (const m of body.matchAll(/className\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) take(m[1] ?? m[2] ?? '');
  for (const m of body.matchAll(/className\s*=\s*\{([\s\S]{0,400}?)\}\s*(?:\n|\/|[a-zA-Z-]+=|>)/g)) {
    for (const quoted of (m[1] ?? '').matchAll(/['"`]([^'"`]*)['"`]/g)) take(quoted[1] ?? '');
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (path === PRINT_CSS_PATH) continue;
    if (['.tsx', '.ts', '.css'].includes(extname(path)) && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The two ways a class can really be alive in this app: a component puts it on an element, or
 * another stylesheet has a rule for it. Built as a SET of names rather than a blob of text —
 * see the drift guard at the bottom for what that changes.
 */
const shippedClasses: ReadonlySet<string> = (() => {
  const names = new Set<string>();
  for (const file of sourceFiles(WEB_SRC)) {
    const source = readFileSync(file, 'utf8');
    if (extname(file) === '.css') for (const name of classesIn(source)) names.add(name);
    else for (const name of renderedClassNames(source)) names.add(name);
  }
  return names;
})();

describe('print.css', () => {
  it('has an @media print block and a @page rule with margins', () => {
    expect(css).toContain('@media print');
    expect(css).toMatch(/@page\s*\{[^}]*margin/);
  });

  it('hides the app chrome Plan 3 actually renders', () => {
    for (const selector of ['.no-print', 'nav', '.shell-rail', '.shell-topbar', '.skip-link']) {
      expect(css).toContain(selector);
    }
    expect(css).toContain('display: none !important');
  });

  it('flattens the shell grid so the page uses the full print width', () => {
    expect(css).toMatch(/\.shell,[\s\S]{0,120}display:\s*block/);
    expect(css).toContain('grid-template-areas: none');
    expect(css).toContain('.shell-main');
  });

  it('repeats table headers across pages and avoids splitting rows', () => {
    expect(css).toContain('display: table-header-group');
    expect(css).toContain('break-inside: avoid');
  });

  it('expands link URLs so a printed page is still navigable', () => {
    expect(css).toContain('content: " (" attr(href) ")"');
  });

  it('keeps the trust surfaces visible in print, under their real class names', () => {
    for (const selector of ['.trust', '.trust-unverified', '.disputed', '.stale-mirror', '.row-warning', '.estimated-mark']) {
      expect(css).toContain(selector);
    }
  });

  /**
   * THE DRIFT GUARD, AND THE COMPARISON IT SPENT TWO ROUNDS NOT MAKING.
   *
   * Why it exists: print.css once styled `.app-sidebar`, `.trust-badge` and
   * `.stale-mirror-warning`, none of which any component renders, so every rule was a dead
   * selector and a string-matching test stayed green.
   *
   * What it actually did until 2026-08-12: `markup.includes(name)` over the CONCATENATED TEXT of
   * every `.ts`, `.tsx` and `.css` file — comments and docblocks included. That is a substring
   * search for a bare word, and the words in question are the vocabulary this codebase writes its
   * comments in. Measured against the tree as it stands: `stale-mirror` occurs in prose in
   * `NavDrawer.tsx` and `Opportunity.tsx` ("the stale-mirror warning"), and `disputed` occurs as
   * an identifier and in prose all over `ProgramTable.tsx`. Delete the rendering of either and the
   * old guard still passed — on the strength of a sentence describing the thing that had just been
   * removed. It also read `print.test` and `print.ts` out of print.css's own header comment and
   * checked for classes named `test` and `ts`, which no stylesheet could ever ship.
   *
   * What it does now: the class must appear either as a rule's selector in another stylesheet or
   * inside a `className` on an element. Both are places a class is USED; neither is a place it can
   * be merely mentioned. The header above no longer describes something the assertion is not doing.
   */
  it('names no class that no component renders and no stylesheet styles', () => {
    const orphans = classesIn(css).filter((name) => !shippedClasses.has(name));
    expect(orphans).toEqual([]);
  });

  /**
   * The guard's own eyesight, checked. A drift guard that cannot fail is the defect it is for, and
   * the previous one could not fail on the very names it was written to catch — so the three
   * historical orphans are put back through it here. They are not in `print.css`; they are fed to
   * the same comparison, which is the only way to show it separates a rendered class from a
   * mentioned one without breaking the stylesheet to prove it.
   */
  it('would reject a class that only a comment mentions', () => {
    // Retired for real: no component renders these, and `.stale-mirror-warning` in particular is
    // one word away from `.stale-mirror`, which IS rendered — a substring search cannot tell them
    // apart in either direction.
    for (const dead of ['app-sidebar', 'trust-badge', 'stale-mirror-warning']) {
      expect(shippedClasses.has(dead), `${dead} is not rendered anywhere`).toBe(false);
    }
    // And it still sees the live ones, including the two whose names also appear in prose and the
    // one assembled inside a template literal.
    for (const live of ['stale-mirror', 'disputed', 'print-button', 'no-print', 'shell-rail']) {
      expect(shippedClasses.has(live), `${live} is rendered and must be seen`).toBe(true);
    }
  });
});
