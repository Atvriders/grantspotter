import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * THE RESPONSIVE CONTRACT: no route may require a horizontal page scroll at any width from 320px
 * up.
 *
 * WHAT THIS FILE CAN PROVE, AND WHAT IT CANNOT.
 *
 * It cannot prove the invariant. jsdom implements no layout — every `getBoundingClientRect()` in
 * it returns zeros — so nothing here measures a pixel, and a test that "checked overflow" under
 * jsdom would be a green light wired to nothing. The measurement is a browser's job, and it lives
 * in `e2e/responsive.spec.ts`: a real Chromium, driven over the shipped corpus at 320, 360, 390,
 * 768, 1024, 1280 and 1440 in BOTH themes, comparing `document.documentElement.scrollWidth`
 * against the viewport for each of 15 records chosen for the properties that break a layout —
 * the longest address the page can print, the longest name, the longest funder, the disputed
 * record, the stale-mirror record, a club record, the blocked-host record and eight spread through
 * the corpus by id. `RESPONSIVE_ALL=1` widens that to all 143. It does not visit any route but
 * `/o/:id`, and that spec's own header says so at length.
 *
 * THAT SENTENCE WAS FALSE WHEN IT WAS FIRST WRITTEN. It described a browser test in the present
 * tense; no file under `e2e/` mentioned `scrollWidth` until 2026-08-10. What actually existed was
 * this file, honest that it cannot measure, pointing at a measurement nobody had written — which
 * is worse than saying nothing, because a reader checking whether the invariant is held stops
 * here. The pointer above is now a real file, and the wording is kept deliberately specific
 * (widths, themes, sample, and the routes it skips) so that the next time it drifts from what the
 * suite does, the drift is visible rather than plausible.
 *
 * What it CAN do is assert the CAUSES, because every one of them is written down in the CSS. The
 * blowout this file exists to prevent had exactly one root cause and it was structural: a grid
 * item's `min-width` defaults to `auto`, i.e. its min-content width, so the `1fr` track of
 * `.browse` and of `.shell` was floored at the results table's ~2280px and the document measured
 * 2565px wide AT EVERY VIEWPORT, a 1440px desktop included. `min-width: 0` appeared nowhere in
 * the 3,161 lines of CSS in this repo. Two collapse-to-one-column media queries had been written
 * against that layout and neither had ever changed anything, because one column of 2565px is
 * still 2565px.
 *
 * So the four rules below are the shape of that bug, stated so it cannot come back:
 *
 *   1. every multi-track grid frees its items with `min-width: 0`;
 *   2. every `<table>` in shipped markup sits in a box that scrolls instead of the page;
 *   3. nothing is pinned wider than the narrowest supported viewport;
 *   4. no responsive rule may hide an honesty marker — the product's thesis is that a projected
 *      deadline is never presented as a published one, and a design that drops the "(estimated)"
 *      mark to save room on a phone has inverted the product. Decoration goes first; these go
 *      never.
 *
 * A rule can pass all four and still overflow, and one did: `SourceLink` printed the funder's
 * address as its own link text, an address has no spaces in it, and one unbreakable word floors
 * every box it sits in exactly as a min-content track does. All four rules above were green
 * throughout, because none of them reads the markup — 112 of the 143 shipped records scrolled
 * sideways at every width but 768, in both themes, until 2026-08-10. The remaining shapes of it
 * are the same: a `<pre>` of unbreakable text, an SVG with a hard-coded viewBox, an inline style
 * in a `.tsx`. That is what the browser pass is for. These assertions catch the class of defect
 * that happened FIRST — a structural one, written in the CSS — at the moment it is typed.
 */

const WEB_SRC = path.resolve(import.meta.dirname, '..');

/** The narrowest window this product supports. Nothing may demand more than this to fit. */
const MIN_VIEWPORT_PX = 320;

// ---------------------------------------------------------------------------------------------
// A very small CSS reader. Enough to know a rule's selector, its declarations, and which
// `@media` / `@container` blocks it is nested inside — which is all four assertions need.
// ---------------------------------------------------------------------------------------------

interface Decl {
  prop: string;
  value: string;
}

interface Rule {
  file: string;
  selector: string;
  decls: Decl[];
  /** The `@media …` / `@container …` preludes enclosing this rule, outermost first. */
  conditions: string[];
}

function cssFiles(): string[] {
  const dirs = [path.join(WEB_SRC, 'styles'), path.join(WEB_SRC, 'components')];
  return dirs
    .flatMap((dir) =>
      readdirSync(dir)
        .filter((name) => name.endsWith('.css'))
        .map((name) => path.join(dir, name)),
    )
    .sort();
}

function parseDecls(body: string): Decl[] {
  return body
    .split(';')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk !== '' && chunk.includes(':'))
    .map((chunk) => ({
      prop: chunk.slice(0, chunk.indexOf(':')).trim().toLowerCase(),
      value: chunk.slice(chunk.indexOf(':') + 1).trim(),
    }));
}

function parseCss(source: string, file: string): Rule[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];

  const walk = (from: number, to: number, conditions: string[]): void => {
    let i = from;
    let prelude = '';
    while (i < to) {
      const ch = src[i];
      if (ch === '{') {
        const bodyStart = i + 1;
        let depth = 1;
        i = bodyStart;
        while (i < to && depth > 0) {
          if (src[i] === '{') depth += 1;
          else if (src[i] === '}') depth -= 1;
          i += 1;
        }
        const bodyEnd = i - 1;
        const selector = prelude.trim().replace(/\s+/g, ' ');
        prelude = '';
        if (selector.startsWith('@')) {
          // A conditional group (`@media`, `@container`, `@supports`) holds rules, not
          // declarations. `@page` holds declarations and has no selector worth recording.
          if (/^@(media|container|supports)\b/.test(selector)) {
            walk(bodyStart, bodyEnd, [...conditions, selector]);
          }
        } else {
          rules.push({ file, selector, decls: parseDecls(src.slice(bodyStart, bodyEnd)), conditions });
        }
      } else if (ch === ';' && prelude.trim().startsWith('@')) {
        prelude = '';
        i += 1;
      } else {
        prelude += ch;
        i += 1;
      }
    }
  };

  walk(0, src.length, []);
  return rules;
}

const ALL_RULES: Rule[] = cssFiles().flatMap((file) =>
  parseCss(readFileSync(file, 'utf8'), path.relative(WEB_SRC, file)),
);

/** Every individual selector in the sheet, normalised, with the rule it came from. */
function selectorsOf(rule: Rule): string[] {
  return rule.selector.split(',').map((s) => s.trim().replace(/\s+/g, ' '));
}

function declared(rule: Rule, prop: string): string | undefined {
  return rule.decls.find((d) => d.prop === prop)?.value;
}

it('the reader found the stylesheets it is supposed to be reading', () => {
  // A parser that silently matched nothing would make every assertion below vacuously true.
  expect(cssFiles().length).toBeGreaterThanOrEqual(18);
  expect(ALL_RULES.length).toBeGreaterThan(300);
  expect(ALL_RULES.some((r) => r.selector === '.shell')).toBe(true);
  expect(ALL_RULES.some((r) => r.conditions.length > 0)).toBe(true);
});

// ---------------------------------------------------------------------------------------------
// 1. Every multi-track grid frees its items.
// ---------------------------------------------------------------------------------------------

/** Top-level tracks of a `grid-template-columns` value, `minmax(a, b)` counted as one. */
function tracks(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (/\s/.test(ch) && depth === 0) {
      if (current !== '') out.push(current);
      current = '';
    } else current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

const multiTrackGrids = ALL_RULES.flatMap((rule) => {
  const value = declared(rule, 'grid-template-columns');
  if (value === undefined || value === 'none') return [];
  const count = value.includes('repeat(') ? 2 : tracks(value).length;
  return count >= 2 ? selectorsOf(rule).map((selector) => ({ selector, rule, value })) : [];
});

describe('every multi-track grid frees its items from the min-content floor', () => {
  it('finds the grids to check', () => {
    // If this ever reads zero the suite has stopped checking anything at all.
    expect(multiTrackGrids.length).toBeGreaterThanOrEqual(10);
  });

  it.each(multiTrackGrids.map((g) => [g.selector, g.value] as const))(
    '%s (%s) declares min-width: 0 on its children',
    (selector) => {
      const freed = ALL_RULES.some(
        (rule) =>
          declared(rule, 'min-width') === '0' && selectorsOf(rule).includes(`${selector} > *`),
      );
      expect(
        freed,
        `\`${selector}\` lays out in columns, and a grid item's min-width defaults to auto — its ` +
          `MIN-CONTENT width — so one wide child pins the whole track open and the page scrolls ` +
          `sideways. Add \`${selector} > * { min-width: 0; }\`. minmax(0, 1fr) on the track is ` +
          `not a substitute: it frees the track, not the item standing in it.`,
      ).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// 2. Every table scrolls inside its own box.
// ---------------------------------------------------------------------------------------------

/**
 * Each `<table>` this app ships, and the box that is responsible for it. Named rather than
 * inferred: matching a wrapper to a table by walking JSX with a regex is guesswork, and the
 * count assertion underneath means a new table cannot slip past this list unlisted.
 */
const TABLES: ReadonlyArray<{ file: string; container: string }> = [
  { file: 'components/ProgramTable.tsx', container: 'table-wrap' },
  { file: 'components/ProvenanceTable.tsx', container: 'table-wrap' },
  { file: 'components/VerifyButton.tsx', container: 'table-wrap' },
  { file: 'components/EnrollmentCodes.tsx', container: 'admin-table-wrap' },
  // The one table with no wrapper element of its own, so the panel around it is the container.
  { file: 'components/ProseCheckPanel.tsx', container: 'prose-check' },
  { file: 'components/MonthGrid.tsx', container: 'month-frame' },
  { file: 'routes/Watchlist.tsx', container: 'wl-scroll' },
  { file: 'routes/Sources.tsx', container: 'sources-table-wrap' },
  { file: 'routes/Admin.tsx', container: 'admin-table-wrap' },
];

function tsxFilesWithTables(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!entry.name.endsWith('.tsx') || entry.name.includes('.test.')) return [];
      return readFileSync(full, 'utf8').includes('<table') ? [path.relative(WEB_SRC, full)] : [];
    });
  return walk(WEB_SRC).sort();
}

describe('every table scrolls inside its own box rather than moving the page', () => {
  it('no table in shipped markup is missing from the list above', () => {
    expect(tsxFilesWithTables()).toEqual([...TABLES].map((t) => t.file).sort());
  });

  it.each(TABLES.map((t) => [t.file, t.container]))(
    '%s: .%s is a horizontal scroll container',
    (_file, container) => {
      const rules = ALL_RULES.filter((rule) => selectorsOf(rule).includes(`.${container}`));
      const overflow = rules
        .map((rule) => declared(rule, 'overflow-x') ?? declared(rule, 'overflow'))
        .filter((v): v is string => v !== undefined);
      expect(
        overflow.some((v) => v.startsWith('auto') || v.startsWith('scroll')),
        `.${container} holds a table. Without \`overflow-x: auto\` on it the table's min-content ` +
          `width becomes the page's, and a 2280px table makes a 2280px page at every viewport.`,
      ).toBe(true);
    },
  );

});

// ---------------------------------------------------------------------------------------------
// 3. Nothing is pinned wider than the narrowest supported viewport.
// ---------------------------------------------------------------------------------------------

const CUSTOM_PROPS = new Map<string, string>(
  ALL_RULES.filter((r) => r.selector === ':root')
    .flatMap((r) => r.decls)
    .filter((d) => d.prop.startsWith('--'))
    .map((d) => [d.prop, d.value]),
);

/** A length in CSS px, or null when it is not a fixed length (a percentage, an fr, a keyword). */
function fixedPx(raw: string): number | null {
  const value = raw.trim();
  const variable = /^var\((--[\w-]+)\)$/.exec(value);
  if (variable !== null) {
    const resolved = CUSTOM_PROPS.get(variable[1] ?? '');
    return resolved === undefined ? null : fixedPx(resolved);
  }
  const px = /^(\d+(?:\.\d+)?)px$/.exec(value);
  if (px !== null) return Number(px[1]);
  const rem = /^(\d+(?:\.\d+)?)rem$/.exec(value);
  if (rem !== null) return Number(rem[1]) * 16;
  return null;
}

/**
 * The floors a rule imposes: values that a box cannot go BELOW. `max-width` and the upper half of
 * a `minmax()` are ceilings and are allowed to be any size — a ceiling never forces a scrollbar.
 */
function floorsOf(rule: Rule): Array<{ where: string; px: number }> {
  const out: Array<{ where: string; px: number }> = [];
  for (const decl of rule.decls) {
    if (decl.prop === 'width' || decl.prop === 'min-width' || decl.prop === 'flex-basis') {
      const px = fixedPx(decl.value);
      if (px !== null) out.push({ where: decl.prop, px });
    }
    if (decl.prop === 'grid-template-columns') {
      for (const track of tracks(decl.value)) {
        const minmax = /^minmax\(([^,]+),/.exec(track);
        const px = fixedPx(minmax?.[1] ?? track);
        if (px !== null) out.push({ where: `track ${track}`, px });
      }
    }
  }
  return out;
}

/**
 * The one legitimate reason to be wider than the narrowest phone: living inside a box that
 * scrolls. Each entry has to name that box, and the box has to actually scroll — so the escape
 * hatch cannot be used to smuggle a fixed width into ordinary page flow.
 */
const WIDER_THAN_THE_VIEWPORT: ReadonlyArray<{
  selector: string;
  scrollContainer: string;
}> = [
  // A month is seven columns wide whatever the phone is. Divided into 320px they are 39px cells
  // holding 22px of ellipsis, which is a month view with the marks taken out — so the grid keeps
  // a readable cell and `.month-frame` scrolls instead.
  { selector: '.month-grid', scrollContainer: '.month-frame' },
];

describe(`nothing demands more than the ${String(MIN_VIEWPORT_PX)}px narrowest viewport`, () => {
  const exempt = new Set(WIDER_THAN_THE_VIEWPORT.map((e) => e.selector));
  const offenders = ALL_RULES.flatMap((rule) =>
    selectorsOf(rule).some((s) => exempt.has(s))
      ? []
      : floorsOf(rule)
          .filter((f) => f.px > MIN_VIEWPORT_PX)
          .map((f) => `${rule.file} ${rule.selector} { ${f.where}: ${String(f.px)}px }`),
  );

  it('no rule sets a fixed width wider than the smallest screen it has to fit on', () => {
    // A single `width: 400px` in ordinary flow is a horizontal scrollbar on every phone, and no
    // amount of `min-width: 0` above it can help: the box was told to be that wide.
    expect(offenders).toEqual([]);
  });

  it.each(WIDER_THAN_THE_VIEWPORT.map((e) => [e.selector, e.scrollContainer]))(
    '%s is allowed to exceed it only because %s scrolls',
    (_selector, container) => {
      const overflow = ALL_RULES.filter((rule) => selectorsOf(rule).includes(container))
        .map((rule) => declared(rule, 'overflow-x') ?? declared(rule, 'overflow'))
        .filter((v): v is string => v !== undefined);
      expect(overflow.some((v) => v.startsWith('auto') || v.startsWith('scroll'))).toBe(true);
    },
  );

  it('the rail, the widest fixed track in the app, still fits inside it', () => {
    expect(fixedPx(CUSTOM_PROPS.get('--rail-w') ?? '')).toBeLessThanOrEqual(MIN_VIEWPORT_PX);
  });
});

// ---------------------------------------------------------------------------------------------
// 4. The honesty markers are the last thing to go, which means they never go.
// ---------------------------------------------------------------------------------------------

/**
 * The marks that say a fact is weaker than it looks. GrantSpotter exists because it refuses to
 * present a projected deadline as a published one; these are where that refusal is visible.
 */
const HONESTY_MARKERS = [
  'estimated-mark', // "(estimated)" before a projected close date
  'published-mark', // and its funder-published counterpart
  'zone-mark', // which timezone the day is expressed in
  'estimated', // .chip.estimated / .prep-mark.estimated / .agenda li.estimated
  'trust', // the lastVerifiedAt badge
  'trust-unverified', // …and its over-90-days state
  'status-pill', // open / unknown / discontinued
  'disputed', // sources do not agree
  'row-disputed',
  'stale-mirror', // this record came from a mirror, not the funder
  'row-warning', // the honesty prose on a results row
  'row-danger', // …and the hijacked-domain version of it
  'wl-qualifier', // published vs projected, on the watchlist
  'wl-safety',
  'cycle-published',
  'cycle-projected',
  'provenance', // how the date was arrived at, on the agenda
] as const;

function mentionsMarker(selector: string): string | undefined {
  return HONESTY_MARKERS.find((marker) => new RegExp(`\\.${marker}(?![\\w-])`).test(selector));
}

const HIDING: ReadonlyArray<[string, RegExp]> = [
  ['display', /^none/],
  ['visibility', /^(hidden|collapse)/],
  ['content-visibility', /^hidden/],
  ['opacity', /^0(\.0+)?$/],
  ['font-size', /^0(px|rem|em)?$/],
  ['width', /^0(px|rem|em)?$/],
  ['height', /^0(px|rem|em)?$/],
  ['max-height', /^0(px|rem|em)?$/],
];

describe('a narrow screen never buys room by dropping an honesty marker', () => {
  const hidesAMarker = ALL_RULES.flatMap((rule) =>
    selectorsOf(rule).flatMap((selector) => {
      const marker = mentionsMarker(selector);
      if (marker === undefined) return [];
      return HIDING.filter(([prop, bad]) => bad.test(declared(rule, prop) ?? ' ')).map(
        ([prop]) => `${rule.file} ${rule.conditions.join(' ')} ${selector} { ${prop} }`,
      );
    }),
  );

  it('no rule, responsive or otherwise, hides one', () => {
    expect(hidesAMarker).toEqual([]);
  });

  it('no conditional rule outside print hides anything at all', () => {
    // Stronger than the rule above and the one that keeps it honest as markup changes: a
    // breakpoint may re-flow, re-space and re-order, but it may not delete. Print is the single
    // exception, and it hides controls — filters, buttons, the nav rail — never a fact.
    const deletions = ALL_RULES.filter(
      (rule) =>
        rule.conditions.length > 0 &&
        !rule.conditions.some((c) => c.includes('print')) &&
        (declared(rule, 'display') ?? '').startsWith('none'),
    ).map((rule) => `${rule.file} ${rule.conditions.join(' ')} ${rule.selector}`);
    expect(deletions).toEqual([]);
  });

  it('print keeps the trust surfaces it names, rather than dropping them with the chrome', () => {
    const kept = ALL_RULES.filter(
      (rule) =>
        rule.file === 'styles/print.css' && (declared(rule, 'display') ?? '').startsWith('block'),
    ).flatMap(selectorsOf);
    for (const marker of ['.trust', '.trust-unverified', '.row-warning', '.estimated-mark']) {
      expect(kept).toContain(marker);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The rest of the quality floor, in the same place, for the same reason: each is a property of
// the stylesheet's text, so each can be held to without a browser.
// ---------------------------------------------------------------------------------------------

describe('the quality floor', () => {
  it('states a touch target minimum of at least 44px, keyed on the pointer and not on the width', () => {
    const tap = fixedPx(CUSTOM_PROPS.get('--tap-min') ?? '');
    expect(tap).not.toBeNull();
    expect(tap).toBeGreaterThanOrEqual(44);

    // `pointer: coarse` rather than `max-width`, because 44px is a fact about a fingertip: a
    // narrow window on a desktop is still a mouse, and a wide tablet is still a thumb.
    const coarse = ALL_RULES.filter((rule) =>
      rule.conditions.some((c) => /pointer\s*:\s*coarse/.test(c)),
    );
    expect(coarse.some((rule) => declared(rule, 'min-height') === 'var(--tap-min)')).toBe(true);
  });

  it('never removes focus without putting something back', () => {
    const stripped = ALL_RULES.filter(
      (rule) =>
        (declared(rule, 'outline') ?? '').startsWith('none') &&
        declared(rule, 'box-shadow') === undefined,
    ).map((rule) => `${rule.file} ${rule.selector}`);
    expect(stripped).toEqual([]);
  });

  it('still honours prefers-reduced-motion, across both animation and transition', () => {
    const reduced = ALL_RULES.filter((rule) =>
      rule.conditions.some((c) => c.includes('prefers-reduced-motion')),
    );
    const universal = reduced.find((rule) => rule.selector.startsWith('*'));
    expect(universal).toBeDefined();
    expect(declared(universal!, 'animation-duration')).toMatch(/!important/);
    expect(declared(universal!, 'transition-duration')).toMatch(/!important/);
  });
});
