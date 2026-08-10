/**
 * "Is there room for the wide layout?" — asked once, in one place, by every dense screen.
 *
 * WHY A HOOK AND NOT A MEDIA QUERY. Three of this product's dense screens do not want a
 * *restyled* table on a phone, they want DIFFERENT MARKUP: a `<table>` is a grid of cells a
 * reader scans across and down, and a deadline a club officer reads on a phone at a meeting is
 * not that — it is one record at a time. A `<table>` forced into `display: block` by a media
 * query keeps the tags and loses the semantics: browsers drop the table roles the moment the
 * display type stops being tabular, so assistive technology is told "table" by the markup and
 * "not a table" by the box tree. Choosing the markup in TypeScript means each layout says what
 * it is, and the switch is one value both the component and its stylesheet agree on.
 *
 * THE BREAKPOINTS DO NOT LIVE HERE. Each screen exports its own, next to the measurement that
 * produced it, because "the width at which the accounts table stops fitting" is a fact about the
 * accounts table and about nothing else. A shared table of device sizes is the thing this module
 * exists to avoid.
 */
import { useMemo, useSyncExternalStore } from 'react';

interface QueryStore {
  subscribe: (onChange: () => void) => () => void;
  get: () => boolean;
}

/**
 * `matchMedia` is missing in jsdom, and its absence has to mean the WIDE layout.
 *
 * Every existing route test asserts against the table — `test/a11y.test.tsx` waits on
 * `role="table"` by name — so a test environment that reported "narrow" would silently swap the
 * markup under an entire suite. Absent means "no viewport to measure", and the honest answer to
 * that is the layout that assumes nothing has been taken away.
 */
function makeStore(query: string): QueryStore {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return { subscribe: () => () => undefined, get: () => false };
  }
  const list = window.matchMedia(query);
  return {
    subscribe: (onChange) => {
      list.addEventListener('change', onChange);
      return () => {
        list.removeEventListener('change', onChange);
      };
    },
    get: () => list.matches,
  };
}

/**
 * True while the viewport is NARROWER than `widePx`.
 *
 * `widePx` is the first width at which the wide layout fits, so the query has to stop one
 * hair below it. `- 0.02` rather than `- 1`: a fractional viewport (a zoomed page, a Windows
 * display scale of 125%) can land at 964.5, which is neither `max-width: 964px` nor
 * `min-width: 965px`, and the two layouts would both stand down and leave the screen unstyled
 * by either rule.
 */
export function useNarrowerThan(widePx: number): boolean {
  const store = useMemo(() => makeStore(`(max-width: ${String(widePx - 0.02)}px)`), [widePx]);
  return useSyncExternalStore(store.subscribe, store.get, () => false);
}
