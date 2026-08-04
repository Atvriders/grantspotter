import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell.js';
import { SessionContext, makeSessionValue } from '../store/session.js';

function renderShell(role: 'admin' | 'member' = 'member', unread = 0, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <SessionContext.Provider
        value={makeSessionValue({
          user: { id: 'u-1', email: 'member@example.com', role },
          completeness: { total: 5, unknownCount: 5, score: 0, fields: [] },
          unread,
        })}
      >
        <AppShell>
          <h1>Browse</h1>
        </AppShell>
      </SessionContext.Provider>
    </MemoryRouter>,
  );
}

describe('AppShell', () => {
  it('puts a skip link first so keyboard users can bypass the rail', () => {
    renderShell();
    const link = screen.getByRole('link', { name: /skip to main content/i });
    expect(link).toHaveAttribute('href', '#main');
  });

  it('makes the skip link the first focusable element on the page, not merely present', () => {
    const { container } = renderShell();
    const focusable = container.querySelectorAll('a[href], button, input, select, textarea');
    expect(focusable[0]).toHaveTextContent(/skip to main content/i);
  });

  it('renders the primary navigation as a labelled landmark', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: /primary/i });
    expect(within(nav).getByRole('link', { name: /browse/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /calendar/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /watchlist/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /inbox/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /sources/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /profile/i })).toBeInTheDocument();
  });

  it('shows the Inbox to members too, because pending review is trust information', () => {
    renderShell('member');
    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
  });

  it('shows Admin only to an admin — a member has nothing to do there', () => {
    renderShell('admin');
    expect(screen.getByRole('link', { name: /admin/i })).toBeInTheDocument();
  });

  it('hides Admin from a member rather than rendering a link that 403s', () => {
    renderShell('member');
    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('announces the unread count rather than showing a bare number', () => {
    renderShell('member', 3);
    expect(screen.getByLabelText('3 unread notifications')).toBeInTheDocument();
  });

  it('omits the unread badge entirely at zero', () => {
    renderShell('member', 0);
    expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument();
  });

  it('marks the current route, so the rail says where you are', () => {
    renderShell('member', 0, '/calendar');
    expect(screen.getByRole('link', { name: /calendar/i })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: /^browse$/i })).not.toHaveAttribute('aria-current');
  });

  it('renders its children inside the main landmark', () => {
    renderShell();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { name: 'Browse' })).toBeInTheDocument();
    expect(main).toHaveAttribute('id', 'main');
  });

  it('offers a sign-out control to a signed-in user', () => {
    renderShell();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
