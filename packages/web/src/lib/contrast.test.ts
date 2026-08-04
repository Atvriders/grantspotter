import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { contrastRatio, parseHex } from './contrast.js';

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
const tokensCss = readFileSync(
  path.resolve(import.meta.dirname, '../styles/tokens.css'),
  'utf8',
);

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
    // failure mode honest: a token that does not parse goes MISSING, and the per-pair
    // `toBeTruthy` below names it, rather than a cast smuggling `undefined` into the ratio.
    if (name === undefined || value === undefined) continue;
    out[name] = value;
  }
  return out;
}

/** [foreground, background] pairs that must clear WCAG AA for normal text. */
const AA_PAIRS: Array<[string, string]> = [
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

describe('contrastRatio', () => {
  it('computes the canonical black-on-white ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('parses hex into 0-255 channels', () => {
    expect(parseHex('#0f6f7a')).toEqual([15, 111, 122]);
  });
});

describe.each([
  [':root', 'light'],
  [':root[data-theme="dark"]', 'dark'],
])('token block %s (%s theme)', (selector) => {
  const tokens = tokensInBlock(tokensCss, selector);

  it.each(AA_PAIRS)('%s on %s clears WCAG AA 4.5:1', (fg, bg) => {
    const fgHex = tokens[fg];
    const bgHex = tokens[bg];
    expect(fgHex, `${fg} missing from ${selector}`).toBeTruthy();
    expect(bgHex, `${bg} missing from ${selector}`).toBeTruthy();
    if (fgHex === undefined || bgHex === undefined) {
      throw new Error(`unreachable: the assertions above already failed for ${selector}`);
    }
    expect(contrastRatio(fgHex, bgHex)).toBeGreaterThanOrEqual(4.5);
  });
});
