import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * THE CONTROL THIS APP NEVER DESIGNED, AND THE COLOUR IT PAINTED ON IT.
 *
 * MEASURED in Chromium at 1280x900 against the shipped corpus, signed in as a member, on
 * /applications:
 *
 *   Download DOCX                       21px tall, border rgb(0,0,0) 2px outset
 *   Download Markdown                   21px tall, border rgb(0,0,0) 2px outset
 *   Download application packet (ZIP)   21px tall, border rgb(0,0,0) 2px outset
 *   the selected draft in the list      21px tall, border rgb(0,0,0) 2px outset
 *   `.btn` beside them                  40.5px tall
 *
 * Those are Chromium's own button defaults, reached because the elements carry no class and
 * nothing in this app styled the `button` ELEMENT. The heights are the visible half. The half that
 * matters is the background: `html { color-scheme: light dark }` makes the UA paint `ButtonFace`
 * as #efefef in light and #6b6b6b in dark, and `.draft-list li.selected > button` puts
 * `color: var(--accent)` on it — so the SELECTED draft, the one row in that list whose entire job
 * is to be identifiable, measured
 *
 *   light   #0f6f7a on #efefef   5.11:1   passes
 *   dark    #3fb6c0 on #6b6b6b   2.20:1   fails 4.5:1
 *
 * A colour defined in one theme and not the other is the failure `lib/contrast.test.ts` exists to
 * make impossible — and it could not see this one, because it derives its pairs from `tokens.css`
 * and NEITHER THEME EVER DECLARED THIS BACKGROUND. The failing colour belonged to the browser.
 *
 * So the invariant is not another contrast pair. It is that no control in this app can end up on
 * a background this app did not choose: `base.css` styles the bare `button` element, so a button
 * written next year with no class on it is correct by default rather than by somebody remembering.
 * `styles/print.test.ts` is the precedent for reading a stylesheet as text; jsdom computes no
 * cascade and would answer nothing useful here.
 */
const STYLES_DIR = join(fileURLToPath(import.meta.url), '..');
const WEB_SRC = join(STYLES_DIR, '..');
const baseCss = readFileSync(join(STYLES_DIR, 'base.css'), 'utf8');
const shellCss = readFileSync(join(WEB_SRC, 'components', 'AppShell.css'), 'utf8');
const calendarCss = readFileSync(join(WEB_SRC, 'components', 'calendar.css'), 'utf8');

/** A CSS source with its comments blanked, so prose in them is never read as a rule. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/**
 * The declaration block of the rule whose selector list is exactly `selector`, or undefined.
 *
 * Exact, not "contains": `.shell-drawer` and `.shell-drawer .shell-nav` are different rules with
 * different jobs, and a substring match would let one answer for the other.
 */
function ruleBody(source: string, selector: string): string | undefined {
  const clean = withoutComments(source);
  for (const match of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if ((match[1] ?? '').trim() === selector) return match[2] ?? '';
  }
  return undefined;
}

function declaration(body: string | undefined, property: string): string | undefined {
  if (body === undefined) return undefined;
  const found = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]+)`).exec(body);
  return found?.[1]?.trim();
}

function filesUnder(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, extensions));
    else if (extensions.includes(extname(entry))) out.push(full);
  }
  return out;
}

describe('a button with no class on it is this product’s button, not the browser’s', () => {
  const button = ruleBody(baseCss, 'button');

  it('is styled at all — the whole defect was that nothing named the element', () => {
    expect(button, 'base.css declares no rule for the bare `button` element').toBeDefined();
  });

  /**
   * The four properties that decide whether a control is on a surface this palette knows about.
   * `background` and `color` are the contrast pair; `border` is SC 1.4.11's boundary; `font` is
   * what keeps a 2px `outset` UA border from arriving with a 13px UA font underneath it.
   */
  it.each([
    ['background', /var\(--surface\)/],
    ['color', /var\(--text\)/],
    ['border', /var\(--border-strong\)/],
    ['font', /inherit/],
  ])('sets %s from the palette, never from the user agent', (property, expected) => {
    expect(declaration(button, property) ?? '').toMatch(expected);
  });

  /**
   * The padding is what makes the height, and the height is the measured symptom: 21px against
   * `.btn`'s 40.5px. Stated as "the same two spacing steps `.btn` uses" rather than as a number,
   * because two controls side by side being different heights is the defect, not any one value.
   */
  it('is the same height as `.btn`, by using the same padding', () => {
    expect(declaration(button, 'padding')).toBe(declaration(ruleBody(baseCss, '.btn'), 'padding'));
  });

  /**
   * NO `min-height` ON THE ELEMENT. `button.badge` is a small inline verdict control inside the
   * results table, and a floor stated here would inflate every one of them. The touch floor is the
   * `pointer: coarse` block's job and covers `button` there.
   */
  it('states no height floor of its own, which is the badge’s protection', () => {
    expect(declaration(button, 'min-height')).toBeUndefined();
    expect(baseCss).toMatch(/@media \(pointer: coarse\)[\s\S]*?\bbutton,[\s\S]*?--tap-min/);
  });

  /**
   * THE STATE RULES ARE SPECIFICITY-ZERO ON PURPOSE. A bare `button:hover` is (0,1,1) — the same
   * as `.profile-tabs button` and `.cal-tabs button`, which declare their own backgrounds — so
   * which rule painted a hovered tab would come down to the order Vite concatenated the
   * stylesheets in. `:where()` contributes nothing to specificity, so every class rule in the app
   * wins by construction rather than by luck.
   */
  it('wraps its hover and disabled states in :where() so no component rule can lose to them', () => {
    const clean = withoutComments(baseCss);
    expect(clean).toMatch(/button:where\(:hover\)\s*\{/);
    expect(clean).toMatch(/button:where\(\[disabled\]\)\s*\{/);
    expect(clean).not.toMatch(/(?:^|[\s,}])button:hover\s*\{/);
    expect(clean).not.toMatch(/(?:^|[\s,}])button\[disabled\]\s*\{/);
  });

  /**
   * THE VACUITY GUARD, and the reason this file is not just about `base.css`. The rule above is
   * only worth something if unclassed buttons really exist — if every one of them had a class, the
   * measurement that opened this file could not have happened. They do: counted across
   * `packages/web/src`, `<button` tags with no `className` on the same or the following line.
   */
  it('has real call sites: unclassed buttons ship in this app', () => {
    const sources = filesUnder(WEB_SRC, ['.tsx']).filter((f) => !f.endsWith('.test.tsx'));
    const unclassed: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/<button\b([^>]*)>/g)) {
        if (!/className/.test(match[1] ?? '')) {
          unclassed.push(relative(WEB_SRC, file));
        }
      }
    }
    expect(
      [...new Set(unclassed)].length,
      'no unclassed button ships, so the element rule above is asserting nothing',
    ).toBeGreaterThan(0);
  });
});

/**
 * THE DRAWER'S ACCOUNT CONTROLS ARE NOT BELOW THE FOLD.
 *
 * MEASURED in Chromium with a member signed in: the drawer's content is 690px tall, and the panel
 * is `inset: 0 auto 0 0` — exactly the viewport. "Sign out" laid out from y=630 to y=674 against
 * a 667px window at 375x667, and against a 640px window at 360x640. Sliced by the bottom edge in
 * both. `overflow-y: auto` on the panel meant scrolling recovered it and nothing said so: the
 * first thing a new member saw of their own account controls was a cut-off word.
 *
 * The fix is which box scrolls. The panel does not; the list of eleven destinations inside it
 * does — so the brand row and the account foot are on screen at any viewport height, and what
 * gives way is the middle of a list where a half-visible row IS the affordance.
 */
describe('the mobile drawer scrolls its destinations, not its account controls', () => {
  const drawer = ruleBody(shellCss, '.shell-drawer');
  const nav = ruleBody(shellCss, '.shell-drawer .shell-nav');

  it('does not make the panel itself a scrollport', () => {
    expect(drawer).toBeDefined();
    expect(declaration(drawer, 'overflow')).toBe('hidden');
    expect(declaration(drawer, 'overflow-y')).toBeUndefined();
  });

  it('makes the destination list the scrollport instead', () => {
    expect(nav).toBeDefined();
    expect(declaration(nav, 'overflow-y')).toBe('auto');
    expect(declaration(nav, 'flex')).toBe('1');
  });

  /**
   * `min-height: 0` is the load-bearing half. A flex item's `min-height` defaults to `auto`, which
   * resolves to its content height, so `flex: 1` alone leaves the list as tall as its eleven rows
   * and pushes the foot straight back off the bottom edge — the same trap `.shell > *` documents
   * with `min-width`, on the other axis.
   */
  it('lets that list shrink below its content, or the foot goes off the edge again', () => {
    expect(declaration(nav, 'min-height')).toBe('0');
  });

  /** A flick that reaches the end of the list must not start scrolling the page underneath it. */
  it('keeps the overscroll containment with the box that now scrolls', () => {
    expect(declaration(nav, 'overscroll-behavior')).toBe('contain');
    expect(declaration(drawer, 'overscroll-behavior')).toBeUndefined();
  });
});

/**
 * ONE BOX IN A MONTH-GRID MARK TRUNCATES, AND IT IS NOT THE ONE CARRYING THE QUALIFIER.
 *
 * MEASURED in Chromium against the shipped corpus, October 2026: 4 of 4 marks clipped at a 1400px
 * viewport (147px of cell against 174-342px of text), and 4 of 4 at 900px and 375px, where the
 * grid sits at its 672px `min-width` and each cell gives its marks 80px. `MonthGrid.tsx`'s own
 * comment claimed the marker had been moved in front of the programme name so it would survive;
 * at 80px the ellipsis fell inside the word "preparing", so the projected/funder-published
 * qualifier rendered at no width tested.
 */
describe('a month-grid mark truncates only the part that can be recovered elsewhere', () => {
  it('lets the kind and the provenance word wrap rather than ellipse', () => {
    const body = ruleBody(calendarCss, '.mark-kind,\n.mark-flag');
    expect(body, '`.mark-kind, .mark-flag` is not a rule in calendar.css').toBeDefined();
    expect(declaration(body, 'white-space')).toBe('normal');
    // "Funder-published" is one word to the line breaker; without this it sets the cell's floor.
    expect(declaration(body, 'overflow-wrap')).toBe('anywhere');
  });

  it('ellipses the programme name, whose full text is in the link’s name and the agenda', () => {
    const body = ruleBody(calendarCss, '.mark-name');
    expect(body).toBeDefined();
    expect(declaration(body, 'white-space')).toBe('nowrap');
    expect(declaration(body, 'text-overflow')).toBe('ellipsis');
  });

  /**
   * The three mark classes must NOT re-declare the whole-mark truncation they used to carry:
   * `white-space: nowrap` on `.chip` or `.prep-mark` would apply to the qualifier's box too and
   * put the defect straight back, with the new markup still in place to make it look fixed.
   */
  it.each(['.chip', '.prep-mark,\n.opens-mark'])(
    'no longer truncates %s as one line',
    (selector) => {
      const body = ruleBody(calendarCss, selector);
      expect(body).toBeDefined();
      expect(declaration(body, 'white-space')).toBeUndefined();
      expect(declaration(body, 'text-overflow')).toBeUndefined();
    },
  );
});
