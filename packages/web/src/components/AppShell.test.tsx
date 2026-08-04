import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell.js';
import { SessionContext, makeSessionValue } from '../store/session.js';

/**
 * `packages/web/src`, resolved from this file rather than from the process's cwd, which differs
 * between `npm test` at the root and a single-project run.
 *
 * NOT `new URL('..', import.meta.url)`. This project runs in jsdom, whose global `URL` shadows
 * Node's and resolves a relative reference against the DOCUMENT's base rather than the base it was
 * handed: measured here, `new URL('..', 'file:///…/src/components/AppShell.test.tsx')` returns
 * `http://localhost:3000/src`, and `fileURLToPath` then rejects it as "must be of scheme file".
 * `fileURLToPath` on the string builds a Node URL and is unaffected.
 */
const WEB_SRC = join(fileURLToPath(import.meta.url), '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Drop comments before looking for an element.
 *
 * Two files legitimately WRITE `<main ...>` inside a comment explaining this very rule, and a
 * guard that fires on its own documentation gets deleted rather than obeyed.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

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
    expect(within(nav).getByRole('link', { name: /templates/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /applications/i })).toBeInTheDocument();
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

  /**
   * THE COMPOSED-TREE GUARD. Read the reasoning before weakening it.
   *
   * `/applications` shipped with TWO `main` landmarks: this shell's, and a second one inside
   * `routes/Applications.tsx`. Nested `<main>` is invalid HTML, it gives the page two `main`
   * landmarks for a screen reader to choose between, it makes the skip link's `#main` target
   * ambiguous, and `page.getByRole('main')` is a Playwright strict-mode violation against it.
   *
   * Every accessibility test in this package passed anyway, because each one renders ONE
   * component. `AppShell.test.tsx` rendered the shell around an `<h1>` and found one `main`;
   * `Applications.test.tsx` rendered the route with no shell and found one `main`. Both were
   * right. The defect exists only in the composition, which is drawn for the first time by the
   * router — so it took a real browser on a served build to see it at all.
   *
   * Rendering every route inside the shell here would need every route's fetch stub and would
   * still only cover the routes somebody remembered to add. This asserts the invariant that
   * makes the composition safe by construction instead: THE SHELL WRAPS EVERY ROUTE, therefore a
   * `<main>` anywhere else in this package is nested by definition, whether or not a test ever
   * renders that screen. A route added next month is covered the moment its file exists.
   *
   * Two files are page ROOTS rather than children of the shell, and they are named rather than
   * pattern-matched so that adding a third is a decision somebody makes on purpose:
   *
   *  - `components/AppShell.tsx` — the shell itself, for every signed-in screen.
   *  - `routes/Login.tsx` — `App.tsx` returns it INSTEAD of the shell when there is no session
   *    (`if (!user) return <Login … />`), so its `<main id="main">` is that page's only one.
   *
   * `App.test.tsx` carries the rendered companion: it counts `main` elements in the REAL composed
   * tree, signed out and signed in, on every CONTRACT §2 route. So this allowlist cannot quietly
   * become wrong — move Login inside the shell and that file goes red on the count.
   */
  const MAY_RENDER_MAIN = ['components/AppShell.tsx', 'routes/Login.tsx'];

  it('shares the `main` landmark with no component that renders inside it', () => {
    const owners = sourceFiles(WEB_SRC)
      .filter((file) => /<main[\s/>]/.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(WEB_SRC, file))
      .sort();

    expect(
      owners,
      'AppShell renders `<main id="main">` around every route, so a `<main>` in a route or a ' +
        'component is a NESTED main landmark on the composed page — invalid HTML, an ambiguous ' +
        'skip-link target, and a Playwright strict-mode violation. Use a `<section>` with an ' +
        'aria-label, or a plain `<div>`. Only a screen rendered INSTEAD of the shell may own one.',
    ).toEqual([...MAY_RENDER_MAIN].sort());
  });

  it('finds exactly one main landmark once a route is composed inside it', () => {
    // The rendered half of the guard above, on the smallest tree that can carry the defect: a
    // child that is itself a `<section>` rather than a second `<main>`.
    const { container } = render(
      <MemoryRouter>
        <SessionContext.Provider
          value={makeSessionValue({
            user: { id: 'u-1', email: 'member@example.com', role: 'member' },
            completeness: { total: 5, unknownCount: 5, score: 0, fields: [] },
            unread: 0,
          })}
        >
          <AppShell>
            <section aria-label="Draft editor">
              <h1>Applications</h1>
            </section>
          </AppShell>
        </SessionContext.Provider>
      </MemoryRouter>,
    );
    expect(container.querySelectorAll('main')).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
  });

  it('offers a sign-out control to a signed-in user', () => {
    renderShell();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
