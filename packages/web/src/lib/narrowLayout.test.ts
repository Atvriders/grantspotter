import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useNarrowerThan } from './narrowLayout.js';
import { restoreViewport, setViewportWidth } from '../test/viewport.js';

afterEach(() => {
  restoreViewport();
});

describe('useNarrowerThan', () => {
  /**
   * The default that every other test file in this package depends on without saying so.
   *
   * jsdom implements no `matchMedia`, and three dense screens choose their MARKUP from this hook.
   * If "no viewport" answered "narrow", `test/a11y.test.tsx` — which waits on `role="table"` by
   * name for both Browse and Admin — would stop finding the element it audits, and so would every
   * assertion written against a `<tr>`. Absent means "nothing has been taken away".
   */
  it('answers wide when there is no viewport to measure', () => {
    expect(typeof window.matchMedia).toBe('undefined');
    const { result } = renderHook(() => useNarrowerThan(947));
    expect(result.current).toBe(false);
  });

  it('is narrow below the width it was given', () => {
    setViewportWidth(390);
    expect(renderHook(() => useNarrowerThan(947)).result.current).toBe(true);
  });

  it('is wide at exactly the width it was given', () => {
    setViewportWidth(947);
    expect(renderHook(() => useNarrowerThan(947)).result.current).toBe(false);
  });

  it('is narrow one pixel below it', () => {
    setViewportWidth(946);
    expect(renderHook(() => useNarrowerThan(947)).result.current).toBe(true);
  });

  /**
   * The gap a `max-width: 946px` / `min-width: 947px` pair leaves open.
   *
   * A zoomed page or a 125% display scale puts the viewport on a fraction, and 946.5 is neither
   * of those two queries — both layouts would stand down. The hook asks for `946.98px` so that
   * every real number below 947 is covered.
   */
  it('is narrow at a fractional width inside the one-pixel gap', () => {
    setViewportWidth(946.5);
    expect(renderHook(() => useNarrowerThan(947)).result.current).toBe(true);
  });

  it('asks about the width it was handed, not a fixed one', () => {
    setViewportWidth(960);
    // 960 is wide for the programme table (947) and narrow for the watchlist (982).
    expect(renderHook(() => useNarrowerThan(947)).result.current).toBe(false);
    expect(renderHook(() => useNarrowerThan(982)).result.current).toBe(true);
  });
});
