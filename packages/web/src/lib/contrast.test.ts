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

/**
 * THE PARSER WAS THE ESCAPE HATCH — AND IT USED TO FAIL OPEN.
 *
 * The Plan 3 close-out review defeated this file by execution without touching a single assertion.
 * It added `--text-dim: #cdd` — a THREE-DIGIT hex, which is valid CSS and renders — symmetrically
 * to all three theme blocks, and the suite passed 142 of 142. `--text-dim` matches `TEXT_INK`, so
 * rules A and E should have asserted it against seven backgrounds per theme. They asserted nothing,
 * because the old regex demanded `#` + exactly six hex digits, and a declaration it could not read
 * was silently `continue`d. The token measures **1.32:1** against `--bg`. AA needs 4.5. It would
 * have shipped as effectively invisible text, and this file — the file whose entire purpose is to
 * make that impossible — would have reported the palette as fully compliant.
 *
 * The old comment even said the quiet part: "a token that does not parse goes MISSING, and the
 * derivation below then cannot pair it, which the vacuity guards catch." It does not catch it. The
 * vacuity guards count pairs and require MORE than 50; dropping one token leaves 142, which is
 * more than 50. A floor cannot detect an omission.
 *
 * So the parser now FAILS CLOSED. Every `--name: value;` in the block is read, not only the ones
 * matching one syntax, and each is classified exactly three ways:
 *
 *   MEASURABLE   resolved to an opaque `#rrggbb`: 3- and 6-digit hex, `rgb()`/`rgba()`, `hsl()`,
 *                a CSS named colour, or a `var(--x)` chain ending in one of those. It joins the
 *                matrix and is asserted like every other colour.
 *   NOT A COLOUR a compound value (two or more top-level terms: a font stack, a shadow, the focus
 *                ring) or a plain number/length. These cannot be an ink or a fill, and are skipped.
 *   UNMEASURABLE anything else — `color-mix()`, `oklch()`, `transparent`, `currentColor`, a hex
 *                with alpha, a `var()` that resolves to nothing. THIS NOW FAILS, by name, with its
 *                value quoted. Not being able to measure a colour is not evidence it is fine.
 *
 * ...and the classification is overridden in one direction only: a token the derivation grammar
 * calls an ink, a surface or a fill (`--text*`, `--bg`, `--surface*`, `--X-soft`, `--X-hover`,
 * `--X-ink`) MUST be MEASURABLE whatever its value looks like. `--text-dim: 4px` is a failure, not
 * a length.
 */

/** CSS named colours a design system plausibly reaches for. Anything else is UNMEASURABLE. */
const NAMED_COLOURS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  lime: '#00ff00',
  blue: '#0000ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
};

/** Colour functions that exist and that this file deliberately refuses to guess the sRGB value of. */
const UNRESOLVABLE_FUNCTIONS = ['color-mix(', 'oklch(', 'oklab(', 'lab(', 'lch(', 'hwb(', 'color(', 'light-dark('];

type Classified =
  | { readonly kind: 'measurable'; readonly hex: string }
  | { readonly kind: 'not-a-colour'; readonly why: string }
  | { readonly kind: 'unmeasurable'; readonly why: string };

/** Split a CSS value on top-level whitespace and commas, ignoring anything inside `()` or quotes. */
function topLevelTerms(value: string): string[] {
  const terms: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | undefined;
  for (const c of value.trim()) {
    if (quote !== undefined) {
      current += c;
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (depth === 0 && (c === ' ' || c === '\t' || c === '\n' || c === ',')) {
      if (current !== '') terms.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  if (current !== '') terms.push(current);
  return terms;
}

const clamp255 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
const toByte = (n: number): string => clamp255(n).toString(16).padStart(2, '0');

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((((h / 60) % 2) + 2) % 2 - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `#${toByte(((r ?? 0) + m) * 255)}${toByte(((g ?? 0) + m) * 255)}${toByte(((b ?? 0) + m) * 255)}`;
}

/**
 * Classify one CSS custom-property value. `declarations` is the whole block, so `var(--x)` chains
 * resolve; `seen` breaks a cycle rather than recursing forever.
 */
export function classifyValue(
  raw: string,
  declarations: Record<string, string> = {},
  seen: ReadonlySet<string> = new Set(),
): Classified {
  const value = raw.trim();
  if (value === '') return { kind: 'unmeasurable', why: 'empty value' };

  const terms = topLevelTerms(value);
  if (terms.length > 1) {
    return { kind: 'not-a-colour', why: `a compound value of ${terms.length} terms, not an ink` };
  }
  const term = terms[0] ?? value;

  const varMatch = /^var\(\s*(--[a-z0-9-]+)\s*(?:,([\s\S]*))?\)$/i.exec(term);
  if (varMatch) {
    const name = varMatch[1] ?? '';
    const fallback = varMatch[2];
    if (seen.has(name)) return { kind: 'unmeasurable', why: `var(${name}) is a cycle` };
    const target = declarations[name];
    if (target !== undefined) return classifyValue(target, declarations, new Set([...seen, name]));
    if (fallback !== undefined) return classifyValue(fallback, declarations, new Set([...seen, name]));
    return { kind: 'unmeasurable', why: `var(${name}) resolves to nothing in this block` };
  }

  const hex = /^#([0-9a-f]{3,8})$/i.exec(term);
  if (hex) {
    const digits = hex[1] ?? '';
    if (digits.length === 3) {
      const [r, g, b] = [...digits];
      return { kind: 'measurable', hex: `#${r}${r}${g}${g}${b}${b}`.toLowerCase() };
    }
    if (digits.length === 6) return { kind: 'measurable', hex: `#${digits}`.toLowerCase() };
    return {
      kind: 'unmeasurable',
      why: `${digits.length}-digit hex carries alpha, and alpha over an unknown backdrop has no ratio`,
    };
  }

  const rgb = /^rgba?\(([^)]*)\)$/i.exec(term);
  if (rgb) {
    const body = (rgb[1] ?? '').replace(/\//g, ' ').split(/[\s,]+/).filter((p) => p !== '');
    const nums = body.map((p) => (p.endsWith('%') ? (Number.parseFloat(p) * 255) / 100 : Number(p)));
    const [r, g, b, a] = nums;
    if (nums.length < 3 || nums.slice(0, 3).some((n) => !Number.isFinite(n))) {
      return { kind: 'unmeasurable', why: `rgb() this file cannot read: ${term}` };
    }
    if (a !== undefined && a !== 255 && a < 1) {
      return { kind: 'unmeasurable', why: 'rgb() with alpha < 1 has no ratio over an unknown backdrop' };
    }
    return { kind: 'measurable', hex: `#${toByte(r ?? 0)}${toByte(g ?? 0)}${toByte(b ?? 0)}` };
  }

  const hsl = /^hsla?\(([^)]*)\)$/i.exec(term);
  if (hsl) {
    const body = (hsl[1] ?? '').replace(/\//g, ' ').split(/[\s,]+/).filter((p) => p !== '');
    const h = Number.parseFloat(body[0] ?? '');
    const s = Number.parseFloat(body[1] ?? '') / 100;
    const l = Number.parseFloat(body[2] ?? '') / 100;
    const a = body[3] === undefined ? 1 : Number.parseFloat(body[3]);
    if (![h, s, l].every(Number.isFinite)) {
      return { kind: 'unmeasurable', why: `hsl() this file cannot read: ${term}` };
    }
    if (Number.isFinite(a) && a < 1) {
      return { kind: 'unmeasurable', why: 'hsl() with alpha < 1 has no ratio over an unknown backdrop' };
    }
    return { kind: 'measurable', hex: hslToHex(((h % 360) + 360) % 360, s, l) };
  }

  const named = NAMED_COLOURS[term.toLowerCase()];
  if (named !== undefined) return { kind: 'measurable', hex: named };

  if (/^-?\d*\.?\d+(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex|pt|s|ms|deg)?$/i.test(term)) {
    return { kind: 'not-a-colour', why: 'a number or length' };
  }

  const fn = UNRESOLVABLE_FUNCTIONS.find((f) => term.toLowerCase().startsWith(f));
  if (fn !== undefined) {
    return {
      kind: 'unmeasurable',
      why: `${fn.slice(0, -1)}() is a real colour this file cannot resolve to sRGB — it must not be ` +
        'assumed compliant just because the parser gave up',
    };
  }
  if (term.toLowerCase() === 'transparent' || term.toLowerCase() === 'currentcolor') {
    return { kind: 'unmeasurable', why: `\`${term}\` has no fixed value, so it has no ratio` };
  }
  return { kind: 'unmeasurable', why: `unrecognised value \`${term}\`` };
}

/** Names the derivation grammar treats as an ink, a surface or a fill. These MUST be measurable. */
function isColourByGrammar(name: string, allNames: readonly string[]): boolean {
  if (NEUTRAL_SURFACE.test(name) || TEXT_INK.test(name)) return true;
  if (/-(?:soft|hover|ink)$/.test(name)) return true;
  return allNames.includes(`${name}-soft`); // a semantic family root
}

/** Every `--name: value;` declaration in a single CSS block, values unparsed. */
export function declarationsInBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const block = css.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+);/g)) {
    const name = m[1];
    const value = m[2];
    if (name === undefined || value === undefined) continue;
    out[name] = value.trim();
  }
  return out;
}

/**
 * Declarations this file cannot measure, and therefore refuses to pass over in silence. Empty is
 * the healthy state; see UNMEASURABLE_BY_DESIGN for the only way an entry is allowed to persist.
 */
export function unmeasurableIn(
  css: string,
  selector: string,
): Array<{ name: string; value: string; why: string }> {
  const declarations = declarationsInBlock(css, selector);
  const names = Object.keys(declarations);
  const out: Array<{ name: string; value: string; why: string }> = [];
  for (const [name, value] of Object.entries(declarations)) {
    const verdict = classifyValue(value, declarations);
    if (verdict.kind === 'measurable') continue;
    if (verdict.kind === 'not-a-colour' && !isColourByGrammar(name, names)) continue;
    out.push({
      name,
      value,
      why:
        verdict.kind === 'not-a-colour'
          ? `the token grammar says ${name} is an ink, a surface or a fill, but its value is ${verdict.why}`
          : verdict.why,
    });
  }
  return out;
}

/** Every token in a block that resolves to an opaque `#rrggbb`, which is the matrix's input. */
function tokensInBlock(css: string, selector: string): Record<string, string> {
  const declarations = declarationsInBlock(css, selector);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(declarations)) {
    const verdict = classifyValue(value, declarations);
    if (verdict.kind === 'measurable') out[name] = verdict.hex;
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

/**
 * Declarations this file cannot resolve to an opaque colour and that are nevertheless allowed to
 * stand, keyed by token name, each with the reason.
 *
 * EMPTY, and an entry is expensive on purpose. It is the only way past `fails closed on any colour
 * it cannot measure`, and it is the exact shape the Plan 3 review's `--text-dim: #cdd` would have
 * needed if the parser had been honest: somebody would have had to write down that a 1.32:1 ink is
 * fine, instead of the parser writing it down for them by saying nothing. The guards below refuse a
 * stale entry — the token must still exist in every theme, and must still be unmeasurable, so an
 * entry cannot outlive its cause and be mistaken for documentation of a real constraint.
 */
const UNMEASURABLE_BY_DESIGN: Record<string, string> = {};

/** The two blocks the AA matrix is derived over. */
const THEMES: ReadonlyArray<readonly [selector: string, label: string]> = [
  [':root', 'light'],
  [':root[data-theme="dark"]', 'dark'],
];

/**
 * EVERY block in the file, including the `prefers-color-scheme` copy — which is the one most users
 * actually get, since most never touch the in-app toggle. The matrix is derived over THEMES only
 * (the media block is held byte-for-byte equal to the data-theme block below, so measuring it twice
 * would assert nothing new), but the FAIL-CLOSED check runs over all three: a token this file
 * cannot measure, added to the media block alone, must not be able to slip in behind an equality
 * test that only ever compared the tokens the parser managed to resolve.
 */
const ALL_BLOCKS: readonly string[] = [
  ':root',
  ':root[data-theme="dark"]',
  ':root:not([data-theme="light"])',
];

describe('contrastRatio', () => {
  it('computes the canonical black-on-white ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('parses hex into 0-255 channels', () => {
    expect(parseHex('#0f6f7a')).toEqual([15, 111, 122]);
  });
});

/**
 * THE FAIL-CLOSED RULE. Everything else in this file measures colours; this asserts that there is
 * no colour it declined to measure. It is listed first because it is the precondition for every
 * ratio below meaning anything: a matrix over a subset the parser happened to understand is not a
 * statement about the palette.
 */
describe.each(ALL_BLOCKS)('the token block %s', (selector) => {
  it('fails closed on any colour it cannot measure', () => {
    const unresolved = unmeasurableIn(tokensCss, selector).filter(
      (u) => !(u.name in UNMEASURABLE_BY_DESIGN),
    );
    expect(
      unresolved.map((u) => `${u.name}: ${u.value} — ${u.why}`),
      'these declarations are not asserted by ANY pair below, because this file cannot resolve ' +
        'them to an opaque colour. Silently skipping them is how `--text-dim: #cdd` (a 3-digit ' +
        'hex, 1.32:1 against --bg) passed 142/142. Either write the value in a form this file can ' +
        'measure, or sign it in UNMEASURABLE_BY_DESIGN with a reason.',
    ).toEqual([]);
  });

  it('resolves a real palette, so "nothing unmeasurable" is not "nothing at all"', () => {
    // The vacuity guard for the guard: a classifier that returned `not-a-colour` for everything
    // would satisfy the check above while measuring none of the palette.
    const declarations = declarationsInBlock(tokensCss, selector);
    const measured = tokensInBlock(tokensCss, selector);
    expect(Object.keys(declarations).length).toBeGreaterThan(20);
    expect(Object.keys(measured).length).toBeGreaterThan(20);
    for (const name of ['--bg', '--surface', '--text', '--text-muted', '--accent', '--ok', '--warn']) {
      expect(measured[name], `${name} must resolve to a measurable colour`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('the colour classifier', () => {
  it('reads every colour syntax that renders, not only the one this palette happens to use', () => {
    expect(classifyValue('#0f6f7a')).toEqual({ kind: 'measurable', hex: '#0f6f7a' });
    expect(classifyValue('#FFF')).toEqual({ kind: 'measurable', hex: '#ffffff' });
    // The exact token the Plan 3 review shipped past 142 green tests.
    expect(classifyValue('#cdd')).toEqual({ kind: 'measurable', hex: '#ccdddd' });
    expect(classifyValue('rgb(15, 111, 122)')).toEqual({ kind: 'measurable', hex: '#0f6f7a' });
    expect(classifyValue('rgb(15 111 122)')).toEqual({ kind: 'measurable', hex: '#0f6f7a' });
    expect(classifyValue('hsl(0, 0%, 100%)')).toEqual({ kind: 'measurable', hex: '#ffffff' });
    expect(classifyValue('white')).toEqual({ kind: 'measurable', hex: '#ffffff' });
    expect(classifyValue('var(--a)', { '--a': '#123456' })).toEqual({
      kind: 'measurable',
      hex: '#123456',
    });
    expect(classifyValue('var(--missing, #abc)')).toEqual({ kind: 'measurable', hex: '#aabbcc' });
  });

  it('calls a number, a length and a compound value what they are', () => {
    for (const value of ['4px', '1.2', '0.06em', '208px', '#000 0 1px', 'ui-monospace, Menlo']) {
      expect(classifyValue(value).kind, `${value} is not an ink`).toBe('not-a-colour');
    }
  });

  it('refuses to call an unresolvable colour compliant', () => {
    for (const value of [
      'color-mix(in srgb, #fff 50%, #000)',
      'oklch(0.7 0.1 200)',
      'lab(50% 20 -30)',
      'hwb(200 20% 30%)',
      'light-dark(#fff, #000)',
      '#ffffff80', // 8-digit hex: alpha over an unknown backdrop
      '#fff8', // 4-digit hex, same
      'rgba(255, 255, 255, 0.4)',
      'transparent',
      'currentColor',
      'var(--nope)',
      'not-a-real-value',
    ]) {
      expect(classifyValue(value).kind, `${value} must not be treated as fine`).toBe('unmeasurable');
    }
    // ...and a var() cycle terminates rather than hanging the suite.
    expect(classifyValue('var(--a)', { '--a': 'var(--b)', '--b': 'var(--a)' }).kind).toBe('unmeasurable');
  });

  it('holds a grammar-named ink to the colour rule whatever its value looks like', () => {
    // `4px` is an honest `not-a-colour` in general — but a token the derivation calls a text ink
    // cannot be a length, and reporting it as "not a colour, skip" is how the hole worked.
    const css = ':root { --text-dim: 4px; --r-9: 4px; }';
    expect(unmeasurableIn(css, ':root').map((u) => u.name)).toEqual(['--text-dim']);
  });

  it('reads a declaration whatever its value syntax, not only #rrggbb', () => {
    const css = ':root { --a: #cdd; --b: color-mix(in srgb, red, blue); --c: 4px; --d: rgb(1 2 3); }';
    expect(Object.keys(declarationsInBlock(css, ':root'))).toEqual(['--a', '--b', '--c', '--d']);
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
    //
    // It compares RAW DECLARATIONS, not resolved colours. Comparing `tokensInBlock` output would
    // compare only what the parser managed to measure, so a token the parser cannot read would be
    // absent from both sides and the blocks would look identical while differing — the same
    // fail-open shape as the parser hole itself, one level up.
    const explicit = declarationsInBlock(tokensCss, ':root[data-theme="dark"]');
    const media = declarationsInBlock(tokensCss, ':root:not([data-theme="light"])');
    expect(Object.keys(explicit).length).toBeGreaterThan(15);
    expect(media).toEqual(explicit);
  });

  it('carries no stale UNMEASURABLE_BY_DESIGN entry', () => {
    for (const [name, reason] of Object.entries(UNMEASURABLE_BY_DESIGN)) {
      expect(reason.trim().length, `${name} needs a real reason, not a placeholder`).toBeGreaterThan(40);
      for (const selector of ALL_BLOCKS) {
        const declared = declarationsInBlock(tokensCss, selector)[name];
        expect(declared, `${name} is signed as unmeasurable but is not declared in ${selector}`)
          .toBeDefined();
        expect(
          unmeasurableIn(tokensCss, selector).map((u) => u.name),
          `${name} is now measurable in ${selector} — the exemption is a lie. Delete the entry so ` +
            'the matrix starts asserting it.',
        ).toContain(name);
      }
    }
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
