import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useSession } from '../store/session.js';
import {
  DRAWER_ID,
  NavDrawer,
  PrimaryNav,
  UnreadBadge,
  screenTitle,
  useDrawerLayout,
} from './NavDrawer.js';
import type { NavItem } from './NavDrawer.js';
import './AppShell.css';

const NAV: NavItem[] = [
  { to: '/', label: 'Browse', end: true },
  { to: '/calendar', label: 'Calendar', end: false },
  { to: '/exports', label: 'Exports', end: false },
  { to: '/watchlist', label: 'Watchlist', end: false },
  { to: '/templates', label: 'Templates', end: false },
  { to: '/applications', label: 'Applications', end: false },
  { to: '/inbox', label: 'Inbox', end: false },
  { to: '/sources', label: 'Sources', end: false },
  { to: '/profile', label: 'Profile', end: false },
  { to: '/admin', label: 'Admin', end: false, adminOnly: true },
];

/**
 * TWO SHAPES, ONE NAVIGATION.
 *
 * Above 640px this is the shell it has always been: a permanent rail beside the content. At or
 * below it the rail is not rendered at all — not hidden, not stacked — and the same destinations
 * are reached through a drawer. `NavDrawer.tsx` documents why that width and why a drawer.
 *
 * The rail is REPLACED rather than CSS-hidden because a hidden rail is still eleven links in the
 * tab order and still a `navigation` landmark a screen reader will offer, both of them pointing
 * at something nobody can see. What the small viewport loses in exchange is the rail's other job,
 * saying which screen you are on — so the topbar takes it, and `screenTitle` never guesses.
 */
export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const { user, unread, logout } = useSession();
  const nav = NAV.filter((item) => item.adminOnly !== true || user?.role === 'admin');
  const drawerLayout = useDrawerLayout();
  const [menuOpen, setMenuOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();

  // A viewport that grows past the breakpoint takes the drawer with it: the rail comes back, and
  // an open-drawer state left behind would put the page back under a scroll lock next time.
  useEffect(() => {
    if (!drawerLayout) setMenuOpen(false);
  }, [drawerLayout]);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    // Where the person was before they opened it. A dialog that returns focus to the top of the
    // document makes the keyboard user walk the whole page back to where they were.
    triggerRef.current?.focus();
  }, []);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      {!drawerLayout && (
        <aside className="shell-rail">
          <div className="shell-brand">
            <strong>GrantSpotter</strong>
            <span className="eyebrow">Funding desk</span>
          </div>
          <PrimaryNav items={nav} unread={unread} />
        </aside>
      )}

      <header className="shell-topbar">
        {drawerLayout && (
          <button
            type="button"
            ref={triggerRef}
            className="btn shell-menu-trigger"
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            /*
              Only while the panel exists. `aria-controls` pointing at an id that is not in the
              document is a reference assistive technology silently drops — and `test/a11y.ts`
              reports it, because a dangling IDREF is the quietest bug in this file.
            */
            {...(menuOpen ? { 'aria-controls': DRAWER_ID } : {})}
            onClick={() => {
              setMenuOpen(true);
            }}
          >
            Menu
            {/*
              The unread count follows the Watchlist entry into the drawer, so with the drawer shut
              it would be the one signal the small screen simply loses. It rides the trigger
              instead — and steps aside once the drawer is open, where the real badge is on screen
              beside the destination it belongs to.
            */}
            {!menuOpen && <UnreadBadge unread={unread} />}
          </button>
        )}

        {drawerLayout ? (
          <span className="shell-screen-name">{screenTitle(pathname, nav)}</span>
        ) : (
          <span className="eyebrow">
            {user ? `${user.email} · ${user.role}` : 'Not signed in'}
          </span>
        )}

        <span className="shell-topbar-spacer" />
        {/*
          The address and the sign-out control are the topbar's whole contents on a wide viewport,
          and on a narrow one they are what the screen name displaces — measured: with both in the
          bar at 320px, "Applications" had 97px and broke across two lines mid-word. They move
          together into the drawer's foot, where the account they belong to is already named.
        */}
        {!drawerLayout && user && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              void logout();
            }}
          >
            Sign out
          </button>
        )}
      </header>

      <main className="shell-main" id="main">
        {children}
      </main>

      {drawerLayout && menuOpen && (
        <NavDrawer
          items={nav}
          unread={unread}
          user={user}
          onClose={closeMenu}
          onSignOut={
            user
              ? () => {
                  void logout();
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
