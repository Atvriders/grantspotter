import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The layout rules the dense screens cannot survive without, read as text.
 *
 * These are pure-CSS facts with no component behaviour to assert through React Testing Library,
 * and jsdom computes no layout — the same position `calendar.css.test.ts` is in, and it reads its
 * stylesheet the same way. What is pinned here is the small set of declarations whose ABSENCE was
 * the bug, each of which looks removable to somebody tidying up:
 *
 *   - `overflow-x: auto` on a table wrapper does nothing on its own. `/sources` and `/admin`
 *     forced the whole page to 858 px and 723 px at a 320 px viewport with that rule already in
 *     place, because a grid item's automatic minimum width is its min-content and `.shell-main`
 *     is a grid item. The wrapper has to have no intrinsic width of its own — one
 *     `minmax(0, 1fr)` track — before the overflow can clip anything.
 *   - the amount cell is the one cell allowed to wrap, and the marker cells beside it are not.
 *   - the month grid needs a floor under its column width, or seven columns of a 320 px screen
 *     are 39 px each and every mark in them is an ellipsis.
 */

function read(file: string): string {
  return readFileSync(path.resolve(import.meta.dirname, file), 'utf8');
}

/**
 * The declarations a browser would apply to an EXACT selector, or `undefined` if no rule names it.
 *
 * Comments are stripped first, so a rule quoted in a comment cannot satisfy an assertion about a
 * rule. Selector lists are split, so `.a, .b { … }` answers for both — a substring search would
 * instead let `.record-name` be satisfied by `.record-name-suffix`, and let a rule that only
 * mentions the selector inside a longer compound count as a rule about it.
 */
function blockFor(css: string, selector: string): string | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  const found: string[] = [];
  for (const rule of rules) {
    const prelude = (rule[1] ?? '').trim();
    if (prelude.startsWith('@')) continue;
    const names = prelude.split(',').map((name) => name.trim().replace(/\s+/g, ' '));
    if (names.includes(selector)) found.push(rule[2] ?? '');
  }
  return found.length === 0 ? undefined : found.join('\n');
}

/** Every wrapper whose job is to let a wide table scroll without taking the page with it. */
const SCROLL_WRAPPERS: Array<[string, string]> = [
  ['browse.css', '.table-wrap'],
  ['sources.css', '.sources-table-wrap'],
  ['admin.css', '.admin-table-wrap'],
  ['watchlist.css', '.wl-scroll'],
  ['calendar.css', '.month-frame'],
];

describe('a dense table scrolls inside its own box, and the page does not', () => {
  for (const [file, selector] of SCROLL_WRAPPERS) {
    it(`${file} ${selector} has no intrinsic width of its own`, () => {
      const block = blockFor(read(file), selector);
      expect(block, `${selector} is missing from ${file}`).toBeDefined();
      expect(block).toMatch(/display:\s*grid/);
      expect(block).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    });

    it(`${file} ${selector} still clips what overflows it`, () => {
      expect(blockFor(read(file), selector)).toMatch(/overflow-x:\s*auto/);
    });
  }
});

describe('when the programme table runs out of room, the amount gives way and the markers do not', () => {
  const css = read('browse.css');
  const tsx = readFileSync(
    path.resolve(import.meta.dirname, 'ProgramTable.tsx'),
    'utf8',
  );

  it('lets the amount cell wrap', () => {
    const block = blockFor(css, '.grid-table td.amount');
    expect(block).toBeDefined();
    expect(block).toMatch(/white-space:\s*normal/);
    // A funder's amount can be one unbroken figure or a sentence; both have to fit a 272px card.
    expect(block).toMatch(/overflow-wrap:\s*anywhere/);
  });

  /**
   * `.num` is the class for a date, a count and a figure, and it carries `white-space: nowrap`.
   * The amount cell must not wear it: `amountRaw` is the funder's own wording and is frequently a
   * sentence, and under that nowrap one cell measured 1,905 px and held the table open at
   * 2,563 px. Asserted against the MARKUP, because the class not being applied is the fix — a
   * stylesheet override would be one specificity accident away from silently losing.
   */
  it('does not put the amount cell in the numeric column class at all', () => {
    expect(tsx).toMatch(/<td className="amount">/);
    expect(tsx).not.toMatch(/className="num amount"/);
  });

  /**
   * The close cell is the other half of the same trade: it may break BETWEEN the date and the
   * mark, which took 90 px off the table's min-content, while the marks themselves may not break
   * at all.
   */
  it('lets the close cell break between the date and its mark', () => {
    expect(blockFor(css, '.grid-table td.num.deadline')).toMatch(/white-space:\s*normal/);
  });

  /**
   * The priority order, made mechanical: the amount is clipped to a fixed number of lines and no
   * marker is clipped at all. `overflow: hidden` without the line clamp would hide the ellipsis
   * and turn a visible truncation into a silent one, so both halves are pinned.
   */
  it('clips the amount to a fixed number of lines, visibly', () => {
    const block = blockFor(css, '.amount-clip');
    expect(block).toBeDefined();
    expect(block).toMatch(/-webkit-line-clamp:\s*4/);
    expect(block).toMatch(/overflow:\s*hidden/);
  });

  it('clips no marker, in the table or anywhere else', () => {
    for (const marker of ['.estimated-mark', '.published-mark', '.zone-mark', '.status-pill']) {
      const block = blockFor(css, marker);
      if (block === undefined) continue;
      expect(block, `${marker} must never be clipped`).not.toMatch(/line-clamp|text-overflow/);
    }
  });

  it('never lets a marker itself wrap or clip', () => {
    for (const marker of ['.estimated-mark', '.published-mark', '.zone-mark', '.deadline-day']) {
      const block = blockFor(css, marker);
      expect(block, `${marker} has no rule in browse.css`).toBeDefined();
      expect(block, `${marker} must stay on one line`).toMatch(/white-space:\s*nowrap/);
    }
  });
});

describe('the month grid keeps a legible column', () => {
  const css = read('calendar.css');

  it('puts a floor under the grid width rather than dividing the viewport by seven', () => {
    const block = blockFor(css, '.month-grid');
    expect(block).toMatch(/min-width:\s*672px/);
  });

  it('still lays its columns out evenly', () => {
    expect(blockFor(css, '.month-grid')).toMatch(/table-layout:\s*fixed/);
  });
});

describe('the touch floor', () => {
  /**
   * 44 px, on the controls this pass owns. `.btn` itself is 41 px and lives in `styles/base.css`,
   * which belongs to another territory — so each dense screen raises its own rather than reaching
   * across. These assert the floor is written down, not that it is honoured at runtime; the
   * browser measurement that showed 41 px buttons, 38 px inputs and 13 px checkboxes is what the
   * rules were derived from.
   */
  const CONTROLS: Array<[string, string]> = [
    ['browse.css', '.filter-sheet > summary'],
    ['browse.css', '.record-name'],
    ['browse.css', '.record-marks button.badge'],
    ['admin.css', '.admin-section .btn'],
    ['watchlist.css', '.wl-record .btn'],
    ['calendar.css', '.cal-tabs button'],
    ['calendar.css', '.cal-nav .btn'],
    ['calendar.css', '.agenda .agenda-name'],
    ['sources.css', '.source-config label'],
  ];

  for (const [file, selector] of CONTROLS) {
    it(`${file} ${selector} is at least 44px tall`, () => {
      const block = blockFor(read(file), selector);
      expect(block, `${selector} is missing from ${file}`).toBeDefined();
      expect(block).toMatch(/min-height:\s*44px/);
    });
  }

  it('enlarges the filter checkboxes rather than leaving 13px squares in a sheet', () => {
    const block = blockFor(read('browse.css'), ".filter-sheet .filter-panel input[type='checkbox']");
    expect(block).toMatch(/width:\s*20px/);
    expect(block).toMatch(/height:\s*20px/);
  });
});

describe('the breakpoints that were replaced', () => {
  /**
   * The rail used to drop at 900 px, which left the results table a 644 px column against a
   * 691 px min-content — a page that fitted around a table that did not. It is gone, and the
   * class `Browse` now sets from a measured constant is what replaced it.
   */
  it('browse.css no longer switches layout at a round 900', () => {
    const css = read('browse.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/@media[^{]*900px/);
  });

  it('browse.css states the stacked layouts as classes, not as widths', () => {
    const css = read('browse.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toContain('.browse-sheet');
    expect(css).toContain('.record-list');
    // The only `@media` left in this file is the print rule.
    const queries = css.match(/@media[^{]*/g) ?? [];
    expect(queries.map((q) => q.trim())).toEqual(['@media print']);
  });
});
