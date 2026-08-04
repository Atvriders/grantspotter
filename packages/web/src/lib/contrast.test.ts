import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { contrastRatio, parseHex } from './contrast.js';

/**
 * THE DESIGN SYSTEM'S ACCESSIBILITY CLAIM, MADE EXECUTABLE — AND SELF-EXTENDING.
 *
 * The first version of this file carried a hand-written `AA_PAIRS` list of 11 foreground/background
 * pairs. It was green, and it was hiding a real defect: `--text-faint` was listed only against
 * `--surface`, pure white — the single background it happened to clear. Against `--bg`, the actual
 * page background, it measured 4.45:1 and shipped below AA. A list that must be kept in sync by
 * hand is silent exactly where it is incomplete, which is this repository's signature defect:
 * `do_not_publish` written by sources and read by nothing, `adjacencyScore` computed and passed
 * nowhere, every source-parsed date discarded, and a vitest config that four separate times
 * covered less than the tree it appeared to describe.
 *
 * So the pairs are no longer written down. They are DERIVED from the token grammar of
 * `tokens.css`, which means a token added by any of Plan 3's remaining tasks is asserted the
 * moment it is declared, or it fails this suite until someone writes down why it is exempt.
 *
 * THE GRAMMAR (the naming convention IS the contract):
 *   `--bg`, `--surface`, `--surface-N`  neutral page and panel fills
 *   `--text`, `--text-*`                inks that render body copy and metadata
 *   `--X` where `--X-soft` exists       a semantic family root (accent, ok, pref, no, unk, warn)
 *   `--X-soft`                          that family's chip fill
 *   `--X-hover`                         that family's hover variant
 *   `--X-ink`                           the ink that renders ON `--X`
 *
 * THE DERIVED RULES:
 *   A  every text ink on every neutral surface — `body` paints `--text` on `--bg`, and
 *      `.grid-table tbody tr:hover td` repaints any row's text onto `--surface-2`, so a text
 *      ink genuinely lands on all of them
 *   B  every family root on its own chip fill (`--ok` on `--ok-soft`)
 *   C  every family root, and its hover variant, on every neutral surface — verdict colours
 *      render as plain coloured text in a cell, not only inside a chip
 *   D  every `--X-ink` on `--X` and on `--X-hover` — `.btn-primary` and its hover state
 *   E  every text ink on every chip fill — a chip may carry neutral metadata beside its label
 *
 * WHAT IS DELIBERATELY NOT DERIVED: pairs with no possible co-occurrence, such as one family's
 * ink on another family's chip (`--ok` on `--no-soft`). Nothing in the design puts them together,
 * and asserting them would constrain the palette for no user benefit.
 */

/**
 * NOT `fileURLToPath(new URL('../styles/tokens.css', import.meta.url))`.
 *
 * This project runs under `environment: 'jsdom'`, and Vite's `vite:asset-import-meta-url` plugin
 * rewrites the literal `new URL('<static path>', import.meta.url)` PATTERN into an asset URL —
 * `new URL('/src/styles/tokens.css', self.location)` — before the module ever executes. Under
 * jsdom `self.location` is `http://localhost:3000/`, so `fileURLToPath` threw
 * `TypeError: The URL must be of scheme file`. `import.meta.dirname` is untouched by that plugin
 * and is the form that survives the transform. Verified on this host, vitest 3.2.7 + vite 6.4.3.
 */
const tokensCss = readFileSync(path.resolve(import.meta.dirname, '../styles/tokens.css'), 'utf8');

/** Pull `--name: #rrggbb;` pairs out of a single CSS block. */
function tokensInBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const block = css.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    const name = m[1];
    const value = m[2];
    // `noUncheckedIndexedAccess` is on, and a capture group is `string | undefined` to the
    // compiler even when the pattern guarantees it. Skipping instead of asserting keeps the
    // failure mode honest: a token that does not parse goes MISSING, and the derivation below
    // then cannot pair it, which the vacuity guards catch.
    if (name === undefined || value === undefined) continue;
    out[name] = value;
  }
  return out;
}

interface Pair {
  readonly fg: string;
  readonly bg: string;
  /** Which derivation rule produced this pair, so a failure says WHY the pair is asserted. */
  readonly rule: string;
}

const NEUTRAL_SURFACE = /^--(?:bg|surface(?:-\d+)?)$/;
const TEXT_INK = /^--text(?:-[a-z]+)?$/;

/** Every foreground/background pair the token grammar says can co-occur. */
export function derivePairs(tokens: Record<string, string>): Pair[] {
  const names = Object.keys(tokens);
  const surfaces = names.filter((n) => NEUTRAL_SURFACE.test(n));
  const textInks = names.filter((n) => TEXT_INK.test(n));
  const roots = names.filter((n) => names.includes(`${n}-soft`));

  const pairs: Pair[] = [];
  const add = (fg: string, bg: string, rule: string): void => {
    pairs.push({ fg, bg, rule });
  };

  for (const fg of textInks) for (const bg of surfaces) add(fg, bg, 'A text-on-surface');
  for (const root of roots) add(root, `${root}-soft`, 'B ink-on-own-chip');
  for (const root of roots) {
    const inks = names.includes(`${root}-hover`) ? [root, `${root}-hover`] : [root];
    for (const fg of inks) for (const bg of surfaces) add(fg, bg, 'C semantic-ink-on-surface');
  }
  for (const name of names) {
    if (!name.endsWith('-ink')) continue;
    const base = name.slice(0, -'-ink'.length);
    if (names.includes(base)) add(name, base, 'D ink-on-base');
    if (names.includes(`${base}-hover`)) add(name, `${base}-hover`, 'D ink-on-base-hover');
  }
  for (const fg of textInks) for (const root of roots) add(fg, `${root}-soft`, 'E text-on-chip');

  return pairs;
}

/**
 * Pairs the derivation produces that are knowingly allowed to fail AA, each with a written
 * reason. EMPTY, and it should stay that way — an entry here is a reviewed statement that a
 * derived pair cannot really co-occur, never a parking space for a contrast defect.
 *
 * Stale entries are themselves a trap this repository has already sprung: an allow-list entry
 * marked "known defect" was once cited as proof that a regression canary was healthy. So the
 * guards below fail when an entry names a pair that is not derived, AND when an entry names a
 * pair that now PASSES — at which point the exemption is a lie and must be deleted.
 *
 * Keyed `"<fg> on <bg>"`.
 */
const EXEMPT: Record<string, string> = {};

const THEMES: ReadonlyArray<readonly [selector: string, label: string]> = [
  [':root', 'light'],
  [':root[data-theme="dark"]', 'dark'],
];

describe('contrastRatio', () => {
  it('computes the canonical black-on-white ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('parses hex into 0-255 channels', () => {
    expect(parseHex('#0f6f7a')).toEqual([15, 111, 122]);
  });
});

describe.each(THEMES)('token block %s (%s theme)', (selector) => {
  const tokens = tokensInBlock(tokensCss, selector);
  const pairs = derivePairs(tokens);

  it.each(pairs.map((p): [string, string, string] => [p.fg, p.bg, p.rule]))(
    '%s on %s clears WCAG AA 4.5:1 [%s]',
    (fg, bg) => {
      const fgHex = tokens[fg];
      const bgHex = tokens[bg];
      expect(fgHex, `${fg} missing from ${selector}`).toBeTruthy();
      expect(bgHex, `${bg} missing from ${selector}`).toBeTruthy();
      if (fgHex === undefined || bgHex === undefined) {
        throw new Error(`unreachable: the assertions above already failed for ${selector}`);
      }
      if (`${fg} on ${bg}` in EXEMPT) return;
      expect(contrastRatio(fgHex, bgHex)).toBeGreaterThanOrEqual(4.5);
    },
  );
});

/**
 * The vacuity guards. A derivation that quietly stops deriving passes on an empty set, which is
 * indistinguishable from success and is the same silence the whole file exists to break.
 */
describe('the contrast invariant can still see', () => {
  it.each(THEMES)('derives a real matrix for %s (%s)', (selector) => {
    const tokens = tokensInBlock(tokensCss, selector);
    const pairs = derivePairs(tokens);
    expect(Object.keys(tokens).length).toBeGreaterThan(20);
    expect(pairs.length).toBeGreaterThan(50);
    // Every rule must actually fire. A regex typo that silently matched nothing would otherwise
    // drop a whole rule while the remaining pairs kept the suite green.
    expect([...new Set(pairs.map((p) => p.rule))].sort()).toEqual([
      'A text-on-surface',
      'B ink-on-own-chip',
      'C semantic-ink-on-surface',
      'D ink-on-base',
      'D ink-on-base-hover',
      'E text-on-chip',
    ]);
  });

  it.each(THEMES)('subsumes every pair the old hand-written list checked in %s (%s)', (selector) => {
    // The 11 pairs this file used to enumerate by hand. Derivation must be a strict superset:
    // if a refactor of the rules ever stops covering one of them, that is a regression.
    const HISTORICAL: ReadonlyArray<readonly [string, string]> = [
      ['--text', '--bg'],
      ['--text', '--surface'],
      ['--text-muted', '--surface'],
      ['--text-faint', '--surface'],
      ['--accent', '--surface'],
      ['--accent-ink', '--accent'],
      ['--ok', '--ok-soft'],
      ['--pref', '--pref-soft'],
      ['--no', '--no-soft'],
      ['--unk', '--unk-soft'],
      ['--warn', '--warn-soft'],
    ];
    const derived = new Set(
      derivePairs(tokensInBlock(tokensCss, selector)).map((p) => `${p.fg} on ${p.bg}`),
    );
    const missing = HISTORICAL.filter(([fg, bg]) => !derived.has(`${fg} on ${bg}`)).map(
      ([fg, bg]) => `${fg} on ${bg}`,
    );
    expect(missing).toEqual([]);
  });

  it('derives every semantic family, so a new one cannot arrive unasserted', () => {
    const tokens = tokensInBlock(tokensCss, ':root');
    const names = Object.keys(tokens);
    const roots = names.filter((n) => names.includes(`${n}-soft`));
    // The families the spec names today. A NEW family adds itself to `roots` automatically and is
    // asserted by rules B, C and E without anyone editing this file; this assertion exists only
    // so that a family DISAPPEARING is loud too.
    expect(roots.sort()).toEqual(['--accent', '--no', '--ok', '--pref', '--unk', '--warn']);
  });

  it('holds both themes to the same matrix', () => {
    const shape = (selector: string): string[] =>
      derivePairs(tokensInBlock(tokensCss, selector))
        .map((p) => `${p.fg} on ${p.bg}`)
        .sort();
    // A token defined in one theme but forgotten in the other would produce a smaller matrix on
    // the side that forgot it, and the missing pairs would never be asserted anywhere.
    expect(shape(':root[data-theme="dark"]')).toEqual(shape(':root'));
  });

  it('keeps the prefers-color-scheme block identical to the data-theme block', () => {
    // tokens.css states the dark palette TWICE: once under `:root[data-theme="dark"]` for the
    // in-app toggle, and once under `@media (prefers-color-scheme: dark)` for everyone who never
    // touches it — which is most users, so the media block is the one that usually applies.
    // Only the first is exercised by the matrix above. This was found by the deliberate break
    // that proved this file: a new family was added to the data-theme block alone and NOTHING
    // complained, so in system dark mode it would silently have fallen back to its LIGHT value.
    const explicit = tokensInBlock(tokensCss, ':root[data-theme="dark"]');
    const media = tokensInBlock(tokensCss, ':root:not([data-theme="light"])');
    expect(Object.keys(explicit).length).toBeGreaterThan(15);
    expect(media).toEqual(explicit);
  });

  it('carries no stale exemption', () => {
    for (const [key, reason] of Object.entries(EXEMPT)) {
      expect(reason.length, `exemption "${key}" has no written reason`).toBeGreaterThan(20);

      const parts = key.split(' on ');
      const fg = parts[0];
      const bg = parts[1];
      expect(fg, `exemption key "${key}" is malformed`).toBeTruthy();
      expect(bg, `exemption key "${key}" is malformed`).toBeTruthy();
      if (fg === undefined || bg === undefined) continue;

      for (const [selector] of THEMES) {
        const tokens = tokensInBlock(tokensCss, selector);
        const derived = derivePairs(tokens).map((p) => `${p.fg} on ${p.bg}`);
        expect(
          derived,
          `exemption "${key}" names a pair no rule derives in ${selector}`,
        ).toContain(key);

        // The trap: an exemption that is no longer needed reads as documentation of a real
        // constraint, and gets cited as proof the canary is healthy. If the pair now clears AA,
        // the entry is a lie — delete it.
        const fgHex = tokens[fg];
        const bgHex = tokens[bg];
        if (fgHex === undefined || bgHex === undefined) continue;
        expect(
          contrastRatio(fgHex, bgHex),
          `exemption "${key}" is STALE in ${selector}: it now clears AA. Delete the entry.`,
        ).toBeLessThan(4.5);
      }
    }
  });
});
