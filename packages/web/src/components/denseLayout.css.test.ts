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
  // The prose check's per-paragraph table. It had no wrapper at all until 2026-08-13 — the padded
  // `.prose-check` card was the scrollport, which clipped a 1,053px table inside an 818px column
  // flush against its own border and left the verdict column off screen at a 1400px window.
  ['applications.css', '.prose-table-wrap'],
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

/**
 * WHY THE COLUMN HEADS ARE NOT STICKY, held as a rule so the one-liner cannot come back.
 *
 * `.grid-table th { position: sticky; top: 0 }` shipped for the life of this app and never did
 * anything. `position: sticky` resolves against the nearest scrollport, and every box above is
 * one: `overflow-x: auto` makes `overflow-y: visible` compute to `auto` (CSS Overflow 3), so each
 * wrapper is a scrollport in both axes. None of them has a height, so none of them ever scrolls
 * vertically, so the header was pinned to an edge that cannot move. Measured in Chromium at
 * 1024x768 and 1440x900 on /, /sources and /admin: a 400px page scroll moved the header 400px and
 * moved the wrapper 400px.
 *
 * The two assertions below are one decision in two halves and have to move together. Giving a
 * wrapper a `max-height` is the only way to make the header stick, and doing it turns the table
 * into a nested scroll region: measured with `max-height: 70vh` injected, /sources at 1024x768
 * ends up showing 25px of a table the wheel has scrolled 2,400px into, with the page itself never
 * scrolling (window.scrollY 0). If some future table really does want a sticky head, it needs a
 * height AND an answer to that measurement — so change both halves deliberately, with a browser
 * open, rather than deleting whichever one is in the way.
 */
describe('a column head does not stick to a box that never scrolls', () => {
  /** Every box a `.grid-table` sits in. `.prose-check` is the panel around the one bare table. */
  const TABLE_BOXES: Array<[string, string]> = [
    ...SCROLL_WRAPPERS,
    ['detail.css', '.table-wrap'],
    ['applications.css', '.prose-check'],
  ];

  for (const [file, selector] of TABLE_BOXES) {
    it(`${file} ${selector} is not height-constrained, so nothing inside it can stick`, () => {
      const block = blockFor(read(file), selector);
      expect(block, `${selector} is missing from ${file}`).toBeDefined();
      expect(block).not.toMatch(/(^|[\s;])(max-)?height:/);
    });
  }

  it('base.css leaves the table head in normal flow', () => {
    const block = blockFor(read('../styles/base.css'), '.grid-table th');
    expect(block, '.grid-table th is missing from styles/base.css').toBeDefined();
    expect(
      block,
      'A sticky table head inside an `overflow-x: auto` wrapper with no height is inert — it ' +
        'pins to a box that cannot scroll. Read the note above this test before re-adding it.',
    ).not.toMatch(/position:\s*sticky/);
  });

  it('the one sticky rule that does work is untouched', () => {
    // `.filter-panel` sits in ordinary page flow with no scrollport between it and the document,
    // so it pins to the window and always has: measured, a 600px page scroll moves it 153px and
    // then holds it at `top: var(--s-4)`. Sticky is not the problem; sticking to a dead box was.
    const block = blockFor(read('browse.css'), '.filter-panel');
    expect(block).toMatch(/position:\s*sticky/);
    expect(block).toMatch(/top:\s*var\(--s-4\)/);
  });
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

/**
 * WHERE THE PROFILE PAGE STACKS, derived rather than transcribed.
 *
 * The width in `profile.css` is not free: the form column is an exact function of the window,
 * because the rail, the two page paddings, the grid gap and the aside are all fixed and the form
 * is the only track that gives. This block recomputes that function FROM THE STYLESHEETS and
 * checks the breakpoint against what was measured to break — so widening the rail, or raising the
 * aside's 380px, fails here and makes somebody re-derive the number instead of leaving a stale
 * one behind. That is the failure this block exists for: the figure it replaced (1043) was
 * derived once, by hand, against `--fs-300`'s `ch` when `.profile-help` is `--fs-100`, and it
 * stacked a 1024 laptop for a legibility problem that does not begin until 994. (996 until
 * 2026-08-10, when the sweep in the note over the floor below put the 45-character measure at
 * 45.10ch on a 995px window and 44.95ch on a 994px one.)
 */
describe('the profile page stacks where the second column stops paying for itself', () => {
  const px = (source: string, pattern: RegExp): number => {
    const found = pattern.exec(source.replace(/\/\*[\s\S]*?\*\//g, ''));
    expect(found, `nothing matched ${String(pattern)}`).not.toBeNull();
    return Number(found?.[1]);
  };

  const tokens = read('../styles/tokens.css');
  const railW = px(tokens, /--rail-w:\s*(\d+)px/);
  const gap = px(tokens, /--s-5:\s*(\d+)px/);
  const profile = read('profile.css');
  const asideW = px(profile, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\([^,]+,\s*(\d+)px\)/);
  const stacksAtOrBelow = px(profile, /@media\s*\(max-width:\s*(\d+)px\)/);

  it('.shell-main still pays for its padding out of the same token as the gap', () => {
    // The arithmetic below assumes one `--s-5` each side of `main`. If that changes, so does the
    // form column, and every figure in profile.css's note goes with it.
    expect(blockFor(read('AppShell.css'), '.shell-main')).toMatch(/padding:\s*var\(--s-5\)/);
  });

  /** The form column at a given window, side by side. Verified in Chromium: 364px at 1024. */
  const formColumnAt = (viewport: number): number =>
    viewport - railW - gap * 2 - gap - asideW;

  it('reproduces the measured form column, so the model is the page', () => {
    expect(formColumnAt(1024)).toBe(364);
    expect(formColumnAt(900)).toBe(240);
    expect(formColumnAt(1440)).toBe(780);
  });

  /**
   * THE FLOOR MOVED FROM 340 TO 335 BECAUSE THE COMMENT UNDER IT MISSTATED ITS OWN MEASUREMENT.
   *
   * It read "340px is the narrowest form column swept with nothing truncated: below it the widest
   * <option> ('Certificate, trade or professional school', 261px of text) stops fitting its
   * control, and the 66ch help text drops under a 45-character measure at 336px." Two of those
   * three numbers were wrong, and the assertion was a round number sitting above them rather than
   * a measurement — so a reader taking the sentence at its word would have taken 261 and 336 with
   * it. Re-swept in Chromium on 2026-08-10, second column held open below its breakpoint, 960 to
   * 1060 at 1px (the same pass profile.css's note now records):
   *
   *   · 261px is the WIDTH OF THE STRING, not of the control. The control has to hold the string
   *     plus 39px of padding, border and arrow: `max-content` on that `<select>` is 299px, and the
   *     control is the form column less 34px, so the option is drawn whole at a 333px form column
   *     and cut below it. At 340 it had 6px of slack, not 0.
   *   · the help text is 45.10ch at a 335px form column and 44.95ch at 334, so the 45-character
   *     measure gives out between those two — not at 336.
   *
   * 335 is the wider of the two floors and therefore the one that binds. It is a measured number
   * again rather than a rounded-up one, which is the only reason the sentence above it can be
   * trusted by whoever reads it next.
   *
   * BOTH FLOORS ARE FONT-DEPENDENT, and this file cannot re-measure them: it reads stylesheets, not
   * a rendering. `--font-text` resolved to Liberation Sans on the machine that swept it. What the
   * assertion is really holding is the ORDER of two numbers — the breakpoint must not leave a form
   * column narrower than the narrowest one anybody has rendered and looked at — and 16px of margin
   * at today's breakpoint is wide enough that another platform's advance widths cannot invert it.
   */
  it('leaves the narrowest two-column form wider than anything measured to break in it', () => {
    const narrowest = formColumnAt(stacksAtOrBelow + 1);
    expect(
      narrowest,
      `stacking at ${String(stacksAtOrBelow)}px leaves a ${String(narrowest)}px form column at ` +
        `${String(stacksAtOrBelow + 1)}px — narrower than the 335px floor the sweep measured`,
    ).toBeGreaterThanOrEqual(335);
  });

  it('does not stack a 1024 laptop', () => {
    // The measurement that prompted the review: at 1024 the two-column page is 3,417px tall and
    // the stacked one 3,460px, so stacking there costs height AND puts the completeness meter
    // 3,248px down the page instead of 307px.
    expect(stacksAtOrBelow).toBeLessThan(1024);
  });
});
