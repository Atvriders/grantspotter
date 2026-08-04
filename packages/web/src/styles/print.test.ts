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

/** Every class selector print.css mentions, deduplicated. */
function classesIn(source: string): string[] {
  const matches = source.match(/\.[A-Za-z_][A-Za-z0-9_-]*/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1)))];
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

const markup = sourceFiles(WEB_SRC).map((f) => readFileSync(f, 'utf8')).join('\n');

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
   * The drift guard. print.css previously styled `.app-sidebar`, `.trust-badge` and
   * `.stale-mirror-warning` — none of which any component renders — so every rule was a
   * dead selector and a string-matching test still passed. This asserts each class is
   * really in the markup.
   */
  it('names no class that no component or stylesheet ships', () => {
    const orphans = classesIn(css).filter((name) => !markup.includes(name));
    expect(orphans).toEqual([]);
  });
});
