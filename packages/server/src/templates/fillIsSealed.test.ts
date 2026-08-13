/**
 * WHAT THE FILL IS ALLOWED TO DEPEND ON, WALKED OFF DISK.
 *
 * `shippedText.ts`'s own header calls itself "the seam": it turns the shipped templates into the
 * line-lists `prose/facts.ts` matches a draft against, and it exists for the FACT CHECKLIST. When
 * `e2e/writing.spec.ts:735` went red on the draft BODY three commits after `shippedTextOf` was
 * rewritten, that description was the first thing in doubt — a seam module that had quietly grown
 * a second consumer on the fill path would explain the failure exactly, and nothing in the suite
 * could rule it out. Reading the imports by hand did; `renderedFill.test.ts` then proved the fill
 * was byte-identical across the rewrite and the real defect was elsewhere entirely. Hours went
 * into establishing a property that is one directed graph.
 *
 * So the property is now a test. `fillTemplate`, `buildSlotContext` and `getTemplate` are the
 * three functions `POST /api/templates/:id/fill` composes, and between them they must not be able
 * to reach `shippedText.ts` or anything under `prose/` — not because those modules are bad, but
 * because a REVIEWER has to be able to read a diff to `shippedText.ts` and know, without running
 * a browser, that no student's draft moved. This is what makes that reading sound.
 *
 * It walks the real `import`/`from` specifiers in the real files, transitively, so it sees a
 * dependency added three modules deep the same as one added at the top of `fill.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(import.meta.dirname, '..');

/**
 * Every module reachable from `entry` by a relative import, as paths relative to `src/`.
 * Package specifiers (`@grantspotter/core`, `node:fs`) are not followed: this asks which of THIS
 * server's modules the fill is built out of.
 */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [path.resolve(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const rel = path.relative(SRC, file);
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = fs.readFileSync(file, 'utf8');
    const specifiers = [
      ...[...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string),
      ...[...src.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] as string),
      ...[...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1] as string),
    ];
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      // ESM with explicit `.js` extensions: the file on disk is the `.ts` beside it.
      const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts'));
      if (fs.existsSync(resolved)) queue.push(resolved);
    }
  }
  return seen;
}

/** The three entry points `api/templates.ts`'s fill handler calls, and nothing else. */
const FILL_PATH = ['templates/fill.ts', 'templates/slots.ts', 'templates/load.ts'];

describe('the fill path is sealed from the fact-checklist seam', () => {
  it('reaches neither shippedText.ts nor prose/ from any fill entry point', () => {
    for (const entry of FILL_PATH) {
      const modules = reachable(entry);
      expect(modules.size, `${entry} resolved to nothing — the walk is broken`).toBeGreaterThan(0);
      expect(modules, `${entry} can reach the module the walk starts at`).toContain(entry);

      expect(
        [...modules].filter((m) => m === 'templates/shippedText.ts'),
        `${entry} now reaches shippedText.ts. That module is the fact checklist's seam; if the ` +
          'fill depends on it, editing it can silently change the draft a student is handed and ' +
          'the header calling it a checklist-only module is wrong.',
      ).toEqual([]);

      expect(
        [...modules].filter((m) => m.startsWith(`prose${path.sep}`)),
        `${entry} now reaches prose/. Prose analysis reads a draft; it must never help build one.`,
      ).toEqual([]);
    }
  });

  it('sees the dependency the checklist really does have, so the walk is proved to work', () => {
    // The negative above is only worth something if the same walk finds a real edge. The
    // checklist path genuinely goes repository -> seam -> prose, and that is the exact shape the
    // fill path is asserted not to have.
    const checklist = reachable('db/repositories/applications.ts');
    expect(checklist).toContain('templates/shippedText.ts');
    expect([...checklist].some((m) => m.startsWith(`prose${path.sep}`))).toBe(true);
  });
});
