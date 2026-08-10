import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell.js';
import { SHELL_WIDE_MIN_PX, screenTitle } from './NavDrawer.js';
import type { NavItem } from './NavDrawer.js';
import { SessionContext, makeSessionValue } from '../store/session.js';
import { setViewportWidth, restoreViewport } from '../test/viewport.js';
import { auditA11y } from '../test/a11y.js';

/**
 * THE SHELL ON A PHONE.
 *
 * Every assertion here renders `AppShell` rather than the drawer alone, because the behaviour
 * under test is a RELATIONSHIP: the rail is gone when the drawer exists, focus leaves the trigger
 * and comes back to it, the count that lived on the Watchlist row rides the trigger while the
 * panel is shut. A test of the panel in isolation can be green while the shell around it has two
 * navigations, or none.
 *
 * `setViewportWidth` is `test/viewport.ts`, which is the only viewport jsdom has. Note what it
 * does NOT do: its `addEventListener` is a no-op, so a resize cannot be simulated by dispatching
 * one. The resize path is covered by rendering at each width instead, which is the same question
 * asked without the event.
 */

/** Just inside drawer mode, and a real phone: `SHELL_WIDE_MIN_PX` is the first WIDE width. */
const PHONE = 390;
const DESKTOP = 1280;

function renderShell({
  width = PHONE,
  role = 'member' as 'admin' | 'member',
  unread = 0,
  path = '/',
} = {}) {
  setViewportWidth(width);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionContext.Provider
        value={makeSessionValue({
          user: { id: 'u-1', email: 'member@example.com', role },
          unread,
        })}
      >
        <AppShell>
          <h1>Browse opportunities</h1>
        </AppShell>
      </SessionContext.Provider>
    </MemoryRouter>,
  );
}

const menuButton = (): HTMLElement => screen.getByRole('button', { name: /^menu/i });
const drawer = (): HTMLElement => screen.getByRole('dialog', { name: /main menu/i });

async function openDrawer(): Promise<HTMLElement> {
  await userEvent.click(menuButton());
  return drawer();
}

afterEach(() => {
  restoreViewport();
});

describe('the shell below the breakpoint', () => {
  it('replaces the rail rather than hiding it: no primary nav is left in the tab order', () => {
    const { container } = renderShell();
    expect(screen.queryByRole('navigation', { name: /primary/i })).not.toBeInTheDocument();
    expect(container.querySelector('.shell-rail')).toBeNull();
    // Nothing offscreen for a Tab to land on either — the count is the point, not the classes.
    expect(container.querySelectorAll('a[href]')).toHaveLength(1); // the skip link
  });

  it('keeps the rail, and no menu button, above the breakpoint', () => {
    renderShell({ width: DESKTOP });
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^menu/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the rail at the last width it fits, and swaps one pixel below', () => {
    // 640 is the first width at which the rail and the 46ch honesty measure both fit; the switch
    // has to be exactly there, or the breakpoint is a device size wearing a measurement's clothes.
    const wide = renderShell({ width: SHELL_WIDE_MIN_PX });
    expect(screen.getByRole('navigation', { name: /primary/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^menu/i })).not.toBeInTheDocument();
    wide.unmount();
    restoreViewport();

    renderShell({ width: SHELL_WIDE_MIN_PX - 1 });
    expect(screen.queryByRole('navigation', { name: /primary/i })).not.toBeInTheDocument();
    expect(menuButton()).toBeInTheDocument();
  });

  it('says which screen you are on, since the rail is no longer there to say it', () => {
    renderShell({ path: '/calendar' });
    expect(screen.getByText('Calendar')).toBeInTheDocument();
  });

  it('does not put the screen name in the topbar when the rail is showing it', () => {
    renderShell({ width: DESKTOP, path: '/calendar' });
    // One "Calendar" on the page: the rail link. Not a second, silent copy in the bar.
    expect(screen.getAllByText('Calendar')).toHaveLength(1);
  });
});

describe('opening and closing the drawer', () => {
  it('opens on the menu button and puts focus inside the dialog', async () => {
    renderShell();
    const panel = await openDrawer();
    expect(panel).toHaveAttribute('aria-modal', 'true');
    expect(panel).toHaveFocus();
  });

  it('names the panel from the trigger only while the panel exists', async () => {
    renderShell();
    // A dangling `aria-controls` is a reference assistive technology drops in silence.
    expect(menuButton()).not.toHaveAttribute('aria-controls');
    expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    const panel = await openDrawer();
    expect(menuButton()).toHaveAttribute('aria-controls', panel.id);
    expect(menuButton()).toHaveAttribute('aria-expanded', 'true');
  });

  it('carries every destination the rail carries, in the rail’s order', async () => {
    renderShell({ role: 'admin' });
    const panel = await openDrawer();
    const nav = within(panel).getByRole('navigation', { name: /primary/i });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Browse',
      'Calendar',
      'Exports',
      'Watchlist',
      'Templates',
      'Applications',
      'Inbox',
      'Sources',
      'Profile',
      'Admin',
    ]);
  });

  it('still omits Admin from a member, because the drawer is the same navigation', async () => {
    renderShell({ role: 'member' });
    const panel = await openDrawer();
    expect(within(panel).queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('marks the current destination inside the drawer', async () => {
    renderShell({ path: '/watchlist' });
    const panel = await openDrawer();
    expect(within(panel).getByRole('link', { name: /watchlist/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('closes on Escape and gives focus back to the trigger', async () => {
    renderShell();
    await openDrawer();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(menuButton()).toHaveFocus();
  });

  it('closes when a destination is chosen', async () => {
    renderShell();
    const panel = await openDrawer();
    await userEvent.click(within(panel).getByRole('link', { name: /calendar/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(menuButton()).toHaveFocus();
    // …and the bar now names the screen that was chosen.
    expect(screen.getByText('Calendar')).toBeInTheDocument();
  });

  it('closes on the Close button', async () => {
    renderShell();
    const panel = await openDrawer();
    await userEvent.click(within(panel).getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(menuButton()).toHaveFocus();
  });

  it('closes on the scrim, and the scrim holds nothing a keyboard can reach', async () => {
    const { container } = renderShell();
    await openDrawer();
    const scrim = container.querySelector('.shell-scrim');
    expect(scrim).not.toBeNull();
    expect(scrim?.querySelectorAll('a[href], button, [tabindex]')).toHaveLength(0);
    await userEvent.click(scrim as Element);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('takes the drawer down with the breakpoint, so a widened window has no orphan panel', async () => {
    const { unmount } = renderShell();
    await openDrawer();
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    // The effect cleanup, not a guess: an unmount that left the lock on would freeze the page.
    expect(document.body.style.overflow).toBe('');
  });
});

describe('the keyboard, alone', () => {
  it('reaches the menu button with Tab, after the skip link', async () => {
    renderShell();
    await userEvent.tab();
    expect(screen.getByRole('link', { name: /skip to main content/i })).toHaveFocus();
    await userEvent.tab();
    expect(menuButton()).toHaveFocus();
  });

  it('opens on Enter, like any button', async () => {
    renderShell();
    menuButton().focus();
    await userEvent.keyboard('{Enter}');
    expect(drawer()).toBeInTheDocument();
  });

  /** Every stop inside the panel, in document order: Close, the destinations, then Sign out. */
  const stopsIn = (panel: HTMLElement): HTMLElement[] => [
    ...panel.querySelectorAll<HTMLElement>('a[href], button'),
  ];

  it('wraps Tab from the last stop back to the first', async () => {
    renderShell();
    const panel = await openDrawer();
    const stops = stopsIn(panel);
    (stops[stops.length - 1] as HTMLElement).focus();
    expect(document.activeElement).toHaveTextContent(/sign out/i);
    await userEvent.tab();
    expect(stops[0]).toHaveFocus();
    expect(document.activeElement).toHaveTextContent(/close/i);
  });

  it('wraps Shift+Tab from the first stop to the last', async () => {
    renderShell();
    const panel = await openDrawer();
    const stops = stopsIn(panel);
    (stops[0] as HTMLElement).focus();
    await userEvent.tab({ shift: true });
    expect(stops[stops.length - 1]).toHaveFocus();
  });

  it('walks the whole panel and comes back to where it started, touching nothing outside', async () => {
    renderShell({ role: 'admin' });
    const panel = await openDrawer();
    const stops = stopsIn(panel);
    stops[0]?.focus();
    for (let i = 0; i < stops.length; i += 1) {
      expect(panel.contains(document.activeElement)).toBe(true);
      await userEvent.tab();
    }
    expect(stops[0]).toHaveFocus();
  });

  it('will not let Shift+Tab off the front of the panel into the page behind', async () => {
    renderShell();
    const panel = await openDrawer();
    expect(panel).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('pulls focus back in if it is outside the panel when Tab is pressed', async () => {
    renderShell();
    const panel = await openDrawer();
    // What a scrim click leaves behind: focus on the body, with the dialog still up.
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.tab();
    expect(panel.contains(document.activeElement)).toBe(true);
  });

  it('answers Escape even from there', async () => {
    renderShell();
    await openDrawer();
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('the page behind', () => {
  it('does not scroll while the drawer is open, and is put back as it was found', async () => {
    renderShell();
    expect(document.body.style.overflow).toBe('');
    await openDrawer();
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('');
  });

  it('restores a lock the page already had rather than clearing it', async () => {
    document.body.style.overflow = 'clip';
    renderShell();
    await openDrawer();
    expect(document.body.style.overflow).toBe('hidden');
    await userEvent.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('clip');
    document.body.style.overflow = '';
  });
});

/**
 * WHAT SURVIVES WHEN THE SCREEN RUNS OUT.
 *
 * This product exists to refuse to show a projected deadline as a published one, so on the
 * narrowest screen the markers are the last thing to go and the chrome is the first. The shell
 * owns exactly one marker of its own — the unread count, which is "a programme you watch has
 * changed" — and one piece of chrome, the signed-in address. These assert which is which.
 */
describe('what gives way first', () => {
  it('keeps the unread count on screen with the drawer shut, where the rail used to hold it', () => {
    renderShell({ unread: 3 });
    const badge = screen.getByLabelText('3 unread notifications');
    expect(menuButton()).toContainElement(badge);
  });

  it('moves the count to the Watchlist row once the drawer is open, and shows it once', async () => {
    renderShell({ unread: 3 });
    const panel = await openDrawer();
    const badge = screen.getByLabelText('3 unread notifications');
    expect(within(panel).getByRole('link', { name: /watchlist/i })).toContainElement(badge);
  });

  it('omits the count at zero rather than drawing an empty marker', () => {
    renderShell({ unread: 0 });
    expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument();
  });

  it('is the account, not the screen name, that gives way in the bar', async () => {
    renderShell({ path: '/sources' });
    const bar = screen.getByRole('banner');
    expect(within(bar).getByText('Sources')).toBeInTheDocument();
    expect(within(bar).queryByText(/member@example\.com/)).not.toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();

    // Displaced, not dropped: both are one press away, under the brand they belong to.
    const panel = await openDrawer();
    expect(within(panel).getByText(/member@example\.com · member/)).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('signs out from the drawer, because that is where the control went', async () => {
    const logout = vi.fn(async () => undefined);
    setViewportWidth(PHONE);
    render(
      <MemoryRouter>
        <SessionContext.Provider
          value={makeSessionValue({
            user: { id: 'u-1', email: 'member@example.com', role: 'member' },
            logout,
          })}
        >
          <AppShell>
            <h1>Browse opportunities</h1>
          </AppShell>
        </SessionContext.Provider>
      </MemoryRouter>,
    );
    const panel = await openDrawer();
    await userEvent.click(within(panel).getByRole('button', { name: /sign out/i }));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('keeps sign-out in the bar on a wide viewport, where it has always been', () => {
    renderShell({ width: DESKTOP });
    const bar = screen.getByRole('banner');
    expect(within(bar).getByRole('button', { name: /sign out/i })).toBeInTheDocument();
    expect(within(bar).getByText(/member@example\.com · member/)).toBeInTheDocument();
  });
});

describe('the audit, in drawer mode', () => {
  it('finds no violation with the drawer shut', () => {
    const { container } = renderShell({ unread: 3 });
    expect(auditA11y(container)).toEqual([]);
  });

  it('finds no violation with the drawer open', async () => {
    const { container } = renderShell({ unread: 3, role: 'admin' });
    await openDrawer();
    expect(auditA11y(container)).toEqual([]);
  });
});

/**
 * The screen's name, which the topbar states as fact on every small viewport. Every branch below
 * is an address `App.tsx` really routes, and the fallback is not a shrug: an unrecognised path
 * renders `NotFound`, whose heading is "Not found".
 */
describe('screenTitle', () => {
  const ITEMS: NavItem[] = [
    { to: '/', label: 'Browse', end: true },
    { to: '/calendar', label: 'Calendar', end: false },
    { to: '/applications', label: 'Applications', end: false },
  ];

  it('names the destination for an exact path', () => {
    expect(screenTitle('/', ITEMS)).toBe('Browse');
    expect(screenTitle('/calendar', ITEMS)).toBe('Calendar');
  });

  it('names the parent destination for a path nested under one', () => {
    expect(screenTitle('/applications/draft-7', ITEMS)).toBe('Applications');
  });

  it('resolves the /browse alias the router redirects', () => {
    expect(screenTitle('/browse', ITEMS)).toBe('Browse');
  });

  it('names the record screen a Browse row opens', () => {
    expect(screenTitle('/o/arrl-amateur-radio-grants', ITEMS)).toBe('Opportunity');
  });

  it('says "Not found" for an address no screen answers to, because that is the screen', () => {
    expect(screenTitle('/nowhere', ITEMS)).toBe('Not found');
  });

  it('never mistakes a sibling path for a nested one', () => {
    expect(screenTitle('/calendars-of-the-world', ITEMS)).toBe('Not found');
  });
});

/**
 * The stylesheet, read as text, for the two rules jsdom cannot see: it computes no layout, so a
 * 44px target and a breakpoint are only checkable here or in a real browser. Both were also
 * measured in Chromium — see the notes in `AppShell.css`.
 */
describe('AppShell.css', () => {
  const css = readFileSync(
    join(fileURLToPath(import.meta.url), '..', 'AppShell.css'),
    'utf8',
  );

  /** Flat `selector { body }` pairs; a `@media` prelude is skipped rather than parsed. */
  function rules(): Array<{ selector: string; body: string }> {
    const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: Array<{ selector: string; body: string }> = [];
    const pattern = /([^{}]+)\{([^{}]*)\}/g;
    let match = pattern.exec(source);
    while (match !== null) {
      out.push({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' });
      match = pattern.exec(source);
    }
    return out;
  }

  it('has ONE breakpoint, and it is the one the component switches on', () => {
    const widths = [...css.matchAll(/@media\s*\(max-width:\s*([\d.]+)px\)/g)].map((m) =>
      Number(m[1]),
    );
    expect(
      widths,
      'the stylesheet and `SHELL_WIDE_MIN_PX` have to describe the same edge, including its ' +
        'fraction: at 639.5px a mismatch renders the drawer with the rail’s empty column beside it',
    ).toEqual([SHELL_WIDE_MIN_PX - 0.02]);
  });

  /**
   * base.css floors `button` and `.btn` under `pointer: coarse`, which covers the trigger and the
   * Close button on a phone but covers no ANCHOR anywhere — and the drawer's eleven destinations
   * are anchors. These three state the floor themselves; `AppShell.css` says why.
   */
  it('gives every drawer target the pointer floor', () => {
    for (const selector of [
      '.shell-menu-trigger',
      '.shell-drawer-close',
      '.shell-drawer .shell-nav a',
    ]) {
      const rule = rules().find((r) => r.selector === selector);
      expect(rule, `${selector} has no rule at all`).toBeDefined();
      expect(rule?.body, `${selector} is a touch target below the pointer floor`).toMatch(
        /min-height:\s*var\(--tap-min\)/,
      );
    }
  });

  /**
   * THE THESIS, AS A RULE ABOUT CSS.
   *
   * A responsive pass that buys room by hiding the `(estimated)` prefix, the last-verified badge,
   * the status pill or the disputed marker has inverted this product: those are the reason it
   * exists. Decoration goes first and they go never — so this stylesheet may not hide them at any
   * width, and the shell reclaims its room by laying out differently instead.
   */
  it('hides no honesty marker at any width', () => {
    const markers = [
      '.estimated-mark',
      '.row-warning',
      '.row-danger',
      '.trust',
      '.trust-unverified',
      '.trust-date',
      '.status-pill',
      '.disputed',
      '.stale-mirror',
      '.badge-count',
    ];
    const hiding = rules().filter((r) => /display:\s*none|visibility:\s*hidden/.test(r.body));
    for (const rule of hiding) {
      for (const marker of markers) {
        expect(rule.selector, `${rule.selector} hides ${marker}`).not.toContain(marker);
      }
    }
  });
});
