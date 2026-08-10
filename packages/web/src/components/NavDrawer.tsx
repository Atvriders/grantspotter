import { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';
import { useNarrowerThan } from '../lib/narrowLayout.js';
import type { SessionUser } from '../store/session.js';

/**
 * WHY A DRAWER AND NOT A TAB BAR.
 *
 * There are eleven places to be in this app (ten rail destinations plus the opportunity record a
 * row opens). A bottom tab bar carries five before the labels start being abbreviated, and the
 * three destinations that would survive the cut — Browse, Calendar, Watchlist — are exactly the
 * ones a user can already reach from the screen they are on. A collapsed icon rail was the other
 * candidate and was rejected on the design direction rather than on space: this product has no
 * icon vocabulary anywhere (the rail is words with a 3px keel), so eleven glyphs would be a new
 * visual language invented for the smallest screen, where guessing costs the most.
 *
 * So: the same eleven words, in the same order, in a panel that is not on screen until it is
 * asked for. The trigger is a word too.
 */

export interface NavItem {
  to: string;
  label: string;
  end: boolean;
  /** Admin-only entries are omitted for members, not rendered disabled. */
  adminOnly?: boolean;
}

/**
 * THE ONE BREAKPOINT, MEASURED FROM THE CONTENT.
 *
 * Not 768, and not the 720 that was in `AppShell.css` — that number came from a device list and
 * had never been verified (an intrinsic 2565px blowout, fixed separately, made every query in this
 * file a no-op, so nobody could see what it did).
 *
 * Measured in Chromium against the shipped 143-programme seed:
 *
 *  - The rail costs 208px (`--rail-w`, border included — the whole app is `border-box`) and
 *    `.shell-main` spends 48 on padding, so a viewport of W leaves W - 256 for content.
 *    `.row-warning` and `.row-danger` — the stale-mirror and hijacked-domain warnings, both
 *    honesty markers — declare their own measure as `max-width: 46ch`, which measures 383.73px at
 *    the 15px body font. 384 + 256 = 640: at 640 the rail and that declared measure both fit, at
 *    639 the rail is taking room the warning was promised. Hence 639.
 *  - The hard failures sit well below it, which is the point of putting it here: with the rail
 *    forced on at every width, route content first overflows `main` at 552px (/admin), 544
 *    (/sources), 512 (/) and 472 (/profile), and the page itself starts scrolling sideways at 508.
 *    Handing navigation to the drawer at 639 means none of those widths is ever reached with a
 *    rail on screen.
 *
 * The number is exported rather than written twice. `NavDrawer.test.tsx` asserts that the `@media`
 * block in `AppShell.css` carries the width this constant produces: a JS breakpoint and a CSS
 * breakpoint that disagree leave the shell half in each mode — at 639.5px that is a drawer with
 * the rail's empty 208px column still reserved beside it.
 */
export const SHELL_WIDE_MIN_PX = 640;

/** The panel's id, shared with the trigger's `aria-controls`. */
export const DRAWER_ID = 'shell-drawer';

/**
 * Whether the shell is in drawer mode.
 *
 * `lib/narrowLayout.ts` owns the `matchMedia` plumbing for the whole app — including its absence
 * in jsdom meaning WIDE, which is what keeps every test written against the rail passing
 * unchanged. This shell contributes only its own measured width, which is the division that
 * module asks for: the breakpoint lives next to the thing it was measured on.
 */
export function useDrawerLayout(): boolean {
  return useNarrowerThan(SHELL_WIDE_MIN_PX);
}

/**
 * The unread count, in one place because it is rendered in two.
 *
 * `role="img"`, not a bare span. `<span aria-label>` maps to the `generic` role, which does not
 * support naming from the author, so the label was discarded and the rail link read as
 * "Watchlist 3" — a number with no unit. `test/a11y.ts` enforces the rule.
 */
export function UnreadBadge({ unread }: { unread: number }): JSX.Element | null {
  if (unread <= 0) return null;
  return (
    <span className="badge-count" role="img" aria-label={`${String(unread)} unread notifications`}>
      {unread}
    </span>
  );
}

/**
 * The primary navigation, rendered by the rail on a wide viewport and by the drawer on a narrow
 * one — the same component both times, so the two can never drift into different destinations,
 * different order or a badge in only one of them.
 */
export function PrimaryNav({
  items,
  unread,
  onNavigate,
}: {
  items: readonly NavItem[];
  unread: number;
  /** Choosing a destination closes the drawer. The rail passes nothing. */
  onNavigate?: () => void;
}): JSX.Element {
  return (
    <nav className="shell-nav" aria-label="Primary">
      {items.map((item) => (
        <NavLink key={item.to} to={item.to} end={item.end} onClick={onNavigate}>
          <span>{item.label}</span>
          {item.to === '/watchlist' && <UnreadBadge unread={unread} />}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The name of the screen the user is on, for the topbar of a viewport whose rail is not on screen
 * to say so.
 *
 * Every branch is a real address in `App.tsx`, and the fallback is not a shrug: an unrecognised
 * path inside the shell renders `NotFound`, whose heading is "Not found", so that IS the name of
 * the screen. A title that guesses would be this product's own failure mode in miniature.
 */
export function screenTitle(pathname: string, items: readonly NavItem[]): string {
  // `/browse` is an alias for `/` (App.tsx redirects it), and the redirect can be mid-flight.
  if (pathname === '/browse') return 'Browse';
  // The record a Browse row opens. Its own <h1> is the programme name; this is the screen.
  if (pathname.startsWith('/o/')) return 'Opportunity';
  const exact = items.find((item) => item.to === pathname);
  if (exact !== undefined) return exact.label;
  const nested = items.find((item) => !item.end && pathname.startsWith(`${item.to}/`));
  return nested?.label ?? 'Not found';
}

/** Everything inside the panel that a Tab can land on, in document order. */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

export interface NavDrawerProps {
  items: readonly NavItem[];
  unread: number;
  user: SessionUser | null;
  /** Closes the drawer AND returns focus to the trigger; `AppShell` owns both halves. */
  onClose: () => void;
  /** Omitted when nobody is signed in, which is the only state with nothing to sign out of. */
  onSignOut?: () => void;
}

/**
 * The panel itself. It is mounted only while open, which is what makes the three obligations below
 * expressible as plain effects rather than as state machines:
 *
 *  - focus goes into the dialog on mount and the trigger takes it back on close;
 *  - Tab cannot leave the panel while it is up, including from a `document.body` that a scrim
 *    click left focused;
 *  - the page behind does not scroll, and is put back exactly as it was found.
 */
export function NavDrawer({
  items,
  unread,
  user,
  onClose,
  onSignOut,
}: NavDrawerProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  useEffect(() => {
    /*
      On `document`, not on the panel. Escape has to work after a scrim click, which leaves focus
      on the body — a handler bound to the panel would never see the key, and the only way out
      would be the pointer that just failed to close it.
    */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (panel === null) return;
      const stops = focusablesIn(panel);
      if (stops.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = stops[0] as HTMLElement;
      const last = stops[stops.length - 1] as HTMLElement;
      const active = document.activeElement;
      if (!panel.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    // Restored to what it WAS, not to '': a future page-level scroll lock must survive this one.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <>
      {/* Decoration with a click target. It holds nothing focusable, so `aria-hidden` here costs
          a keyboard user nothing — Escape and the Close button are the accessible dismissals. */}
      <div className="shell-scrim no-print" aria-hidden="true" onClick={onClose} />
      <div
        className="shell-drawer no-print"
        id={DRAWER_ID}
        role="dialog"
        aria-modal="true"
        aria-label="Main menu"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="shell-drawer-head">
          <div className="shell-brand">
            <strong>GrantSpotter</strong>
            <span className="eyebrow">Funding desk</span>
          </div>
          <button type="button" className="btn shell-drawer-close" onClick={onClose}>
            Close
          </button>
        </div>

        <PrimaryNav items={items} unread={unread} onNavigate={onClose} />

        {/*
          WHO YOU ARE, AND HOW TO STOP BEING THEM, TOGETHER AND DOWN HERE.

          Both were in the topbar, and at 320px the two of them left 97px for the screen name —
          measured, and "Applications" broke across two lines mid-word to fit it. Neither is a
          trust marker (those belong to the records, and this component moves none of them), so
          they are what gives way to the thing that says where you are. Nothing is lost: they are
          one press away, in the panel that already carries the brand.
        */}
        <div className="shell-drawer-foot">
          <p className="eyebrow shell-drawer-identity">
            {user ? `${user.email} · ${user.role}` : 'Not signed in'}
          </p>
          {onSignOut !== undefined && (
            <button type="button" className="btn shell-drawer-signout" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </div>
    </>
  );
}
