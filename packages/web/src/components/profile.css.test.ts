import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * TWO RULES IN `profile.css` WHOSE ABSENCE WAS THE BUG, read as text.
 *
 * jsdom computes no layout and paints nothing, so neither of these can be asserted by rendering
 * the component — the same position `calendar.css.test.ts` and `denseLayout.css.test.ts` are in,
 * and they read their stylesheets the same way. Both rules below look removable to somebody
 * tidying up, and both were measured in Chromium against a local build on 2026-08-13.
 */

function read(file: string): string {
  return readFileSync(path.resolve(import.meta.dirname, file), 'utf8');
}

/** Declarations a browser would apply to an EXACT selector, comments stripped first. */
function blockFor(css: string, selector: string): string | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const found: string[] = [];
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = (rule[1] ?? '').trim();
    if (prelude.startsWith('@')) continue;
    const names = prelude.split(',').map((name) => name.trim().replace(/\s+/g, ' '));
    if (names.includes(selector)) found.push(rule[2] ?? '');
  }
  return found.length === 0 ? undefined : found.join('\n');
}

const profile = read('profile.css');
const explain = read('explain.css');

/**
 * THE LADDER IS IN THE RAIL ON THIS PAGE, AND ITS OWN STYLESHEET STACKS IT BY WINDOW WIDTH.
 *
 * `.unknown-ladder li` is `minmax(0, 1fr) auto` with a `white-space: nowrap` count in the second
 * track, and `explain.css` gives it one column at `@media (max-width: 803px)` — right on `/browse`,
 * where the card spans the main region, and blind on `/profile`, where the completeness meter puts
 * it in a `minmax(300px, 380px)` aside that takes its 380px maximum at every window from 1011px up.
 *
 * Measured in Chromium at a 1440px window, on a student profile with the seed corpus behind it: the
 * row computed `grid-template-columns: 29.75px 304.25px`. The field name had collapsed to its
 * link's min-content and "36 unknown verdicts are waiting on this" took 304px of the card's 346px
 * of content, so the two rendered on one line and the help sentence beneath wrapped one word per
 * line down a 30px column — thirteen rows of it, on every profile that has a saved profile.
 */
describe('the unknown-fields ladder, where the profile page puts it', () => {
  it('takes one column in the rail, whatever the window is doing', () => {
    expect(blockFor(profile, '.profile-grid .unknown-ladder li')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/,
    );
    expect(blockFor(profile, '.profile-grid .unknown-ladder .waiting')).toMatch(
      /white-space:\s*normal/,
    );
  });

  it('is still the two-column row everywhere else, which is what needed scoping', () => {
    // If `explain.css` ever stops laying this out in two columns, the rule above is dead weight
    // rather than a fix, and this test says so instead of going quietly green.
    expect(blockFor(explain, '.unknown-ladder li')).toMatch(
      /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*auto/,
    );
    expect(blockFor(explain, '.unknown-ladder .waiting')).toMatch(/white-space:\s*nowrap/);
  });

  it('states it without a second copy of the breakpoint below it', () => {
    // A `@media` here would duplicate the 1010 the grid stacks at, and the two would drift the day
    // one of them moved. `profile.css` is allowed exactly one media query, the stacking one.
    const queries = profile.replace(/\/\*[\s\S]*?\*\//g, '').match(/@media[^{]*/g) ?? [];
    expect(queries.map((q) => q.trim())).toEqual(['@media (max-width: 1010px)']);
  });
});

/**
 * A LOSS IS NOT PAINTED IN THE COLOUR OF A WIN.
 *
 * "Values you had stated were replaced by this record: State was CA, Latitude was 42.3601…" was
 * rendered in `.profile-status`, which is `var(--ok)` — measured `rgb(22, 112, 62)`, the green this
 * product uses for a verdict that went the applicant's way — beside the neutral teal of the
 * "Read from callook.info" provenance notes (`--accent`, measured `rgb(15, 111, 122)`). It has its
 * own region now, and the region has the amber the panel's own copy of that warning already used.
 */
describe('what accepting a record moved, and how it is drawn', () => {
  it('is warned in, not congratulated in', () => {
    const chip = blockFor(profile, '.profile-moved:not(:empty)') ?? '';
    expect(chip).toMatch(/color:\s*var\(--warn\)/);
    expect(chip).toMatch(/background:\s*var\(--warn-soft\)/);
    expect(chip).not.toMatch(/--ok|--accent/);
  });

  it('draws no chrome at all while it is empty, because it is always mounted', () => {
    // The region is in the DOM whether or not it has anything to say — that is what makes an
    // assistive technology announce the update rather than miss the node — so the padded amber
    // box has to be conditional on there being something in it, or every profile that has never
    // run a lookup carries an empty warning.
    const base = blockFor(profile, '.profile-moved') ?? '';
    expect(base).not.toMatch(/background|padding/);
  });

  it('leaves the save confirmation as the only thing wearing the success colour', () => {
    expect(blockFor(profile, '.profile-status')).toMatch(/color:\s*var\(--ok\)/);
  });
});
