import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/**
 * THE SAME SWEEP AS `packages/web/src/test/setup.ts`, IN A REAL BROWSER, ON EVERY STATE THE PAGE
 * PASSES THROUGH.
 *
 * WHY IT IS HERE AS WELL AS THERE. jsdom renders one component against a stub. Chromium renders
 * the shipped bundle against the shipped server, and the round-two defect that headed a panel
 * "FCC record for undefined" came from a field that the API's TYPE promised and the WIRE did not —
 * a disagreement no component test can have, because the component test writes both sides. The
 * e2e suite is the only place in this repo where the words on the screen were produced by the real
 * server's real answer.
 *
 * WHY A MUTATION OBSERVER AND NOT A CHECK AT THE END OF THE TEST. A hole is often transient: a
 * banner that flashes "Deleted [object Object]" and is replaced by a reload two hundred
 * milliseconds later is a sentence a person read and an assertion at the end of the test cannot
 * see. The observer is installed by `addInitScript`, so it is re-armed on every navigation, and it
 * looks only at the nodes that actually changed — never at the whole document — which is what
 * keeps it off the critical path. Measured cost across the full suite is reported in the round's
 * notes; the run stayed inside its existing timings.
 *
 * WHY IT IS INSTALLED BY IMPORTING A FUNCTION AND CALLING IT. Playwright has no global setup hook
 * that owns `page`. So each browser-driving spec calls {@link installRenderedHoleSweep} once at
 * the top, and `packages/server/test/userFacingCopyContract.test.ts` fails by name when a spec
 * drives a page without it — a guard you can forget to install is a guard the next spec forgets.
 */

/** The tokens, the exemption and the spoken attributes, kept identical to the jsdom sweep. */
const BROWSER_SWEEP = `(() => {
  const HOLE = /\\[object [A-Z]\\w*\\]|\\b(?:undefined|null|NaN|Infinity)\\b/;
  const QUOTED_AS_ITSELF = /[“"](?:undefined|null|NaN|Infinity)[”"]/g;
  const SPOKEN = ['aria-label', 'aria-description', 'aria-valuetext', 'alt', 'title'];
  const hits = [];
  window.__renderedHoles = hits;

  const look = (text, where) => {
    if (typeof text !== 'string' || text.length === 0 || hits.length >= 12) return;
    const cleaned = text.replace(QUOTED_AS_ITSELF, '');
    const found = HOLE.exec(cleaned);
    if (found === null) return;
    const from = Math.max(0, found.index - 70);
    hits.push(where + ' printed "' + found[0] + '": …' +
      cleaned.slice(from, from + 170).replace(/\\s+/g, ' ') + '…');
  };

  const sweepTree = (node) => {
    look(node.textContent, 'text');
    if (typeof node.querySelectorAll !== 'function') return;
    for (const attribute of SPOKEN) {
      for (const el of node.querySelectorAll('[' + attribute + ']')) {
        look(el.getAttribute(attribute), attribute);
      }
      if (typeof node.getAttribute === 'function' && node.hasAttribute(attribute)) {
        look(node.getAttribute(attribute), attribute);
      }
    }
  };

  const arm = () => {
    if (document.body === null) { setTimeout(arm, 10); return; }
    sweepTree(document.body);
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'characterData') look(record.target.textContent, 'text');
        else if (record.type === 'attributes') {
          look(record.target.getAttribute(record.attributeName), record.attributeName);
        } else {
          for (const added of record.addedNodes) sweepTree(added);
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: SPOKEN,
    });
  };
  arm();
})();`;

/**
 * What the page collected, READ AND CLEARED in one step.
 *
 * Draining rather than peeking is what lets {@link drainRenderedHoles} exist: a test that proves
 * this sweep works has to render a hole on purpose, and if the read left it behind, the per-test
 * check would then fail on the offender the demonstration just made.
 *
 * Typed narrowly rather than with `any`, as `flow.spec.ts` explains: the root tsconfig ships no
 * `dom` lib and `npm run typecheck` covers `e2e/`, so `window` has to be described here.
 */
function collectHoles(): string[] {
  const holes = (globalThis as unknown as { __renderedHoles?: string[] }).__renderedHoles;
  return holes === undefined ? [] : holes.splice(0, holes.length);
}

/**
 * Render a hole on purpose, so the sweep can be watched catching one.
 *
 * The sentence is round two's, verbatim: `frameFor('found', callsign)` built `FCC record for
 * ${callsign}` out of a record whose `callsign` had not arrived, and the panel headed itself with
 * the word "undefined" while every test around it passed.
 */
export function injectHoleForSelfTest(): void {
  const { document } = globalThis as unknown as {
    document: {
      createElement(tag: string): { textContent: string };
      body: { append(node: unknown): void };
    };
  };
  const paragraph = document.createElement('p');
  paragraph.textContent = `FCC record for ${String(undefined)}`;
  document.body.append(paragraph);
}

/** Everything the sweep has seen on this page so far, clearing it as it reads. */
export async function drainRenderedHoles(page: Page): Promise<string[]> {
  return page.evaluate(collectHoles);
}

/** Install the observer on every page this target opens from now on. */
export async function armRenderedHoleSweep(target: Page | BrowserContext): Promise<void> {
  await target.addInitScript(BROWSER_SWEEP);
}

/** Fail with what the page printed, if it printed a hole in any state it passed through. */
export async function expectNoRenderedHoles(page: Page): Promise<void> {
  // A page that never navigated has nothing to report, and asking a closed one anything throws an
  // error that would be blamed on the test rather than on the sweep.
  if (page.isClosed() || page.url() === 'about:blank') return;
  const holes = await page.evaluate(collectHoles).catch(() => [] as string[]);
  expect(
    holes,
    'A sentence on this page printed the absence of a value as though it were one. A person ' +
      'reading it is being shown a JavaScript spelling of "there was nothing here" — branch on ' +
      'the missing value and say something true about it, or leave the clause out. See ' +
      'e2e/renderedHoles.ts.',
  ).toEqual([]);
}

/**
 * Arm and sweep every test in the calling spec file, for specs that drive the `page` fixture.
 *
 * Call once, at module top level, before any `test.describe`. The `beforeEach` registered here
 * runs before the spec's own, so the observer is in place for the first navigation.
 *
 * A spec that opens its own contexts in `beforeAll` — `responsive.spec.ts`, `signedOut.spec.ts` —
 * cannot use this, because the `page` fixture is not where its pages come from. Those call
 * {@link armRenderedHoleSweep} on the context and {@link expectNoRenderedHoles} before closing.
 */
export function installRenderedHoleSweep(): void {
  test.beforeEach(async ({ page }: { page: Page }) => {
    await armRenderedHoleSweep(page);
  });

  test.afterEach(async ({ page }: { page: Page }) => {
    await expectNoRenderedHoles(page);
  });
}
