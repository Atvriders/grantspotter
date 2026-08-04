import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useSession } from '../store/session.js';
import './AppShell.css';

interface NavItem {
  to: string;
  label: string;
  end: boolean;
  /** Admin-only entries are omitted for members, not rendered disabled. */
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Browse', end: true },
  { to: '/calendar', label: 'Calendar', end: false },
  { to: '/watchlist', label: 'Watchlist', end: false },
  { to: '/inbox', label: 'Inbox', end: false },
  { to: '/sources', label: 'Sources', end: false },
  { to: '/profile', label: 'Profile', end: false },
  { to: '/admin', label: 'Admin', end: false, adminOnly: true },
];

export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  const { user, unread, logout } = useSession();
  const nav = NAV.filter((item) => item.adminOnly !== true || user?.role === 'admin');

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>

      <aside className="shell-rail">
        <div className="shell-brand">
          <strong>GrantSpotter</strong>
          <span className="eyebrow">Funding desk</span>
        </div>
        <nav className="shell-nav" aria-label="Primary">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              <span>{item.label}</span>
              {item.to === '/watchlist' && unread > 0 && (
                <span className="badge-count" aria-label={`${unread} unread notifications`}>
                  {unread}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <header className="shell-topbar">
        <span className="eyebrow">{user ? `${user.email} · ${user.role}` : 'Not signed in'}</span>
        <span className="shell-topbar-spacer" />
        {user && (
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
    </div>
  );
}
