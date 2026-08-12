import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom implements neither. `api/exports.ts`'s blob-download path
 * (`URL.createObjectURL(blob)` → a synthetic `<a download>` click →
 * `URL.revokeObjectURL(url)`) is exactly what a real browser does for the three POST exports
 * (DOCX / Markdown / packet ZIP), and there is no alternative code path the way `Blob.text()` had
 * one in `FileReader` — a download has to produce SOME object URL to point the anchor at. The
 * stub below is a fixed string, never a real object URL, so nothing here should assert on its
 * shape; the point is only that `saveBlob` does not throw `TypeError: URL.createObjectURL is not
 * a function` in the test environment.
 */
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:jsdom-stub';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => undefined;
}

/**
 * A VALUE THAT DID NOT EXIST MAY NOT BE PRINTED AS THOUGH IT DID — CHECKED AFTER EVERY TEST IN THE
 * WEB SUITE, WITHOUT ANY TEST HAVING TO ASK FOR IT.
 *
 * WHAT THIS IS FOR. Round two shipped a callsign panel that headed its own result
 * `FCC record for undefined`, and the suite was green: every test around it asserted structure —
 * that a heading existed, that a button was enabled, that a field was marked — and none of them
 * read the words. That is the recurring shape of every defect four rounds of review have found
 * here, and it is not a shape a per-component assertion catches, because the author who writes
 * `${record.callsign}` is precisely the author who believes `record.callsign` is always there.
 *
 * WHY IT IS A HOOK AND NOT A TEST. A guard that must be invoked is a guard somebody forgets on the
 * one component that needed it. This runs over `document.body` after every single test in the web
 * project — 149 files at the time of writing — so the coverage it gives is exactly the coverage
 * the suite already has, and a new component inherits it by existing rather than by remembering.
 *
 * WHY IT SURVIVES A COPY EDIT. It asserts nothing about WHAT the product says. It says that
 * whatever the product says must not contain the JavaScript spellings of "I had nothing here":
 * `undefined`, `null`, `NaN`, `Infinity`, `[object Object]`. Rewording a sentence cannot make this
 * fail; only rendering a hole can. That is the difference between a check that fails when a
 * sentence is WRONG and a snapshot that fails when a sentence CHANGES — the second gets re-blessed
 * on sight and stops being a guard the first time somebody is in a hurry.
 *
 * WHY THE MATCH IS ON WORD BOUNDARIES. `null` inside "annulled" and `NaN` inside "Nanaimo" are
 * words; the bare tokens are not. `[object Object]` needs no boundary — nothing writes that on
 * purpose.
 *
 * WHAT IT CANNOT SEE, said plainly: a hole rendered into an attribute nobody reads back
 * (`aria-label="Verified undefined"` lives in the attribute, not in `textContent`), and a hole in a
 * state no test ever renders. The first is covered below by sweeping the prose attributes too; the
 * second is what `packages/server/test/userFacingCopyContract.test.ts` measures and ratchets.
 */
const HOLE_IN_A_SENTENCE = /(\[object [A-Z]\w*\]|\b(?:undefined|null|NaN|Infinity)\b)/;

/**
 * THE ONE EXEMPTION, AND IT IS DELIBERATELY TOO NARROW TO HIDE ANYTHING.
 *
 * A product that reports what arrived on the wire sometimes has to print the word `null`, because
 * `null` is what arrived — `CallsignLookup`'s "the body was “null”" is naming a JSON value, not
 * failing to name a callsign. What separates that from "FCC record for undefined" is that the
 * token is QUOTED, standing alone inside curly quotes, as the whole of the quotation.
 *
 * `“Verified undefined”` does not match. `“undefined and 3 others”` does not match. Only a bare
 * scalar being quoted as itself does, which is a shape nobody writes by accident and which a
 * reviewer reading `“${value}”` can see for what it is.
 */
const QUOTED_AS_ITSELF = /[“"](?:undefined|null|NaN|Infinity)[”"]/g;

/** The attributes whose value a screen reader speaks, which `textContent` does not include. */
const SPOKEN_ATTRIBUTES = ['aria-label', 'aria-description', 'aria-valuetext', 'alt', 'title'];

/**
 * The hole a sentence printed, or `null` if it printed none.
 *
 * Exported so it can be tested against the sentences that actually shipped — a scanner nobody has
 * demonstrated firing is indistinguishable from one that has gone quiet, which is the failure mode
 * `contactUrlEntryPointContract.test.ts` was walked past three ways. See `renderedHoles.test.ts`.
 */
export function findRenderedHole(text: string): string | null {
  const hit = HOLE_IN_A_SENTENCE.exec(text.replace(QUOTED_AS_ITSELF, ''));
  return hit === null ? null : hit[0];
}

/** Everything on this page a person reads or hears: text nodes, plus the spoken attributes. */
export function spokenText(root: ParentNode & { textContent: string | null }): string[] {
  const spoken: string[] = [root.textContent ?? ''];
  for (const attribute of SPOKEN_ATTRIBUTES) {
    for (const element of root.querySelectorAll(`[${attribute}]`)) {
      spoken.push(element.getAttribute(attribute) ?? '');
    }
  }
  return spoken;
}

function assertNoRenderedHoles(): void {
  const { body } = document;
  // A test that rendered nothing has nothing to say.
  if (body.childElementCount === 0 && (body.textContent ?? '') === '') return;

  for (const text of spokenText(body)) {
    const hole = findRenderedHole(text);
    if (hole === null) continue;
    // The excerpt is cut from the same string the match was found in. Locating the token in the
    // RAW text would point at an exempted `“null”` earlier in the sentence and quote the wrong
    // place — a failure message that sends the reader to a line that is fine.
    const cleaned = text.replace(QUOTED_AS_ITSELF, '');
    const at = Math.max(0, cleaned.indexOf(hole) - 70);
    throw new Error(
      `A rendered sentence printed the absence of a value as though it were one: "${hole}".\n` +
        `  …${cleaned.slice(at, at + 160).replace(/\s+/g, ' ')}…\n` +
        'A person reading this screen is being shown a JavaScript spelling of "there was nothing ' +
        'here". Branch on the missing value and say something true about it, or leave the clause ' +
        'out. See the note above this check in packages/web/src/test/setup.ts.',
    );
  }
}

afterEach(() => {
  try {
    assertNoRenderedHoles();
  } finally {
    // Unmount regardless, or one failure leaks its DOM into every test that follows it and the
    // report names files that are fine.
    cleanup();
  }
});
