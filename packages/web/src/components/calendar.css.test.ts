import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * CLOSE-OUT REVIEW RESIDUAL — `.prep-mark.estimated` had no rule at all.
 *
 * `MonthGrid`'s `PrepMark` has carried the `estimated` class since it gained the "(projected
 * date)" wording in its visible text (see `MonthGrid.tsx`), matching `CloseChip`'s `estimated`
 * class for parity. But `calendar.css` was out of scope for that fix, so the class landed with
 * nowhere to attach: 123 of a 12-month window's 127 prep marks carry `estimated` and render
 * pixel-identical to the 4 that are funder-published. The text alone carries the distinction for
 * a screen reader, but a sighted reader scanning the grid gets nothing — exactly the gap
 * `.chip.estimated` exists to close for the chips beside it.
 *
 * This is a pure-CSS fix, so there is no component behaviour to assert through React Testing
 * Library — `PrepMark` already applies the class (see `MonthGrid.test.tsx`). What is missing is
 * the rule itself, so this reads the stylesheet as text, the same way `lib/contrast.test.ts`
 * verifies `tokens.css`, and asserts the DECLARATIONS a browser would actually apply rather than
 * just grepping for the selector's presence.
 */

const cssPath = path.resolve(import.meta.dirname, 'calendar.css');
const css = readFileSync(cssPath, 'utf8');

/** The declaration block for an exact selector, or `undefined` if the selector never appears. */
function blockFor(selector: string): string | undefined {
  // Matches `selector {` at the start of a rule — not merely a substring of a longer selector
  // list — so `.prep-mark.estimated` is not accidentally matched by a search for `.prep-mark`.
  const pattern = new RegExp(
    `(?:^|[\\s,}])${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  );
  const match = css.match(pattern);
  return match?.[1];
}

describe('calendar.css — .prep-mark.estimated', () => {
  it('has a rule at all', () => {
    expect(blockFor('.prep-mark.estimated')).toBeDefined();
  });

  it('draws a dashed edge, matching the ordinary .prep-mark rule it overrides', () => {
    const plain = blockFor('.prep-mark');
    const estimated = blockFor('.prep-mark.estimated');
    expect(plain).toBeDefined();
    expect(estimated).toBeDefined();
    // The base rule is the dotted edge every prep mark starts with.
    expect(plain).toMatch(/border-left:\s*3px dotted/);
    // The estimated rule turns it dashed — the same edge style `.chip.estimated` uses for the
    // identical reason, so the two projected treatments read as one system rather than two.
    expect(estimated).toMatch(/dashed/);
    expect(estimated).not.toMatch(/dotted/);
  });

  it('adds an inset outline, consistent with .chip.estimated — dash and colour must not be the only signal', () => {
    const chipEstimated = blockFor('.chip.estimated');
    const prepMarkEstimated = blockFor('.prep-mark.estimated');
    expect(chipEstimated).toBeDefined();
    expect(prepMarkEstimated).toMatch(/outline:\s*1px dashed currentColor/);
    expect(prepMarkEstimated).toMatch(/outline-offset:\s*-1px/);
    // Same declarations `.chip.estimated` uses, not merely the same idea reworded.
    expect(chipEstimated).toMatch(/outline:\s*1px dashed currentColor/);
  });

  it('never applies the dashed/outline treatment to a funder-published prep mark', () => {
    // A bare `.prep-mark` (no `.estimated`) is what the 4-of-127 funder-published marks render as
    // (see MonthGrid.tsx's PrepMark). Its own rule must stay dotted with no outline, or a
    // published mark would start looking projected instead.
    const plain = blockFor('.prep-mark');
    expect(plain).not.toMatch(/outline/);
  });
});
