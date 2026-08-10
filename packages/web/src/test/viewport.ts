/**
 * A viewport for jsdom, which has none.
 *
 * `lib/narrowLayout.ts` reads `window.matchMedia`, which jsdom does not implement, and treats its
 * absence as "wide" so that every existing route test keeps asserting against the table it was
 * written for. A test that wants the NARROW variant therefore has to supply the one thing jsdom
 * is missing, and this is it: a `matchMedia` that answers `(max-width: Npx)` against a width the
 * test names.
 *
 * It parses the query rather than returning a fixed boolean. A stub that answered `true` to
 * everything would make a component look narrow at 1920 as readily as at 320, and the assertions
 * that matter here are the ones about WHICH width flips a layout.
 */
const MAX_WIDTH = /\(\s*max-width:\s*([0-9.]+)px\s*\)/;

let original: typeof window.matchMedia | undefined;
let installed = false;

export function setViewportWidth(widthPx: number): void {
  if (!installed) {
    original = window.matchMedia as typeof window.matchMedia | undefined;
    installed = true;
  }
  window.matchMedia = ((query: string): MediaQueryList => {
    const max = MAX_WIDTH.exec(query);
    const matches = max === null ? false : widthPx <= Number(max[1]);
    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}

/** Put jsdom back the way it was, so one narrow test cannot leak into the next file. */
export function restoreViewport(): void {
  if (!installed) return;
  if (original === undefined) {
    delete (window as { matchMedia?: unknown }).matchMedia;
  } else {
    window.matchMedia = original;
  }
  installed = false;
  original = undefined;
}
