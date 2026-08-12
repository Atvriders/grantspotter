import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ACCOUNTS_TABLE_MIN_PX, Admin } from './Admin.js';
import { restoreViewport, setViewportWidth } from '../test/viewport.js';
import { SessionContext, makeSessionValue } from '../store/session.js';

interface AdminUserFixture {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  isSelf: boolean;
}

const ADMIN_ROW: AdminUserFixture = {
  id: 'u-admin',
  email: 'admin@example.com',
  displayName: 'The Admin',
  role: 'admin',
  disabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: '2026-08-02T09:00:00.000Z',
  isSelf: true,
};

const MEMBER_ROW: AdminUserFixture = {
  id: 'u-member',
  email: 'member@example.com',
  displayName: 'A Member',
  role: 'member',
  disabled: false,
  createdAt: '2026-02-01T00:00:00.000Z',
  lastLoginAt: null,
  isSelf: false,
};

const USERS = { rows: [ADMIN_ROW, MEMBER_ROW] };

type Override = (url: string, init?: RequestInit) => unknown;

/**
 * A permissive fake API. `overrides` answers the one call a test is about;
 * everything else gets a shape the console can render, so a test never fails on
 * a request it was not written about.
 */
function stubFetch(overrides: Override = () => undefined, users: { rows: AdminUserFixture[] } = USERS) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const custom = overrides(url, init);
    if (custom !== undefined) return Promise.resolve(custom);
    if (init?.method === 'POST' && url === '/api/admin/users') {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({
          user: {
            id: 'u-new',
            email: 'new@example.com',
            displayName: '',
            role: 'member',
            disabled: false,
            createdAt: '2026-08-02T12:00:00.000Z',
            lastLoginAt: null,
            isSelf: false,
          },
          generatedPassword: 'Zx9-generated-password-value',
        }),
      });
    }
    if (init?.method !== undefined && init.method !== 'GET') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => users });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function conflict(message: string) {
  return {
    ok: false,
    status: 409,
    json: async () => ({
      error: { code: 'conflict', message },
      requestId: 'req-test-1',
    }),
  };
}

function renderAdmin() {
  return render(
    <MemoryRouter>
      <SessionContext.Provider
        value={makeSessionValue({
          user: { id: 'u-admin', email: 'admin@example.com', role: 'admin' },
        })}
      >
        <Admin />
      </SessionContext.Provider>
    </MemoryRouter>,
  );
}

/** Enough of the accessible-name algorithm to catch an unlabelled control. */
function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria !== null && aria.trim() !== '') return aria.trim();
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement ||
    el instanceof HTMLTextAreaElement
  ) {
    const labelled = Array.from(el.labels ?? [])
      .map((l) => l.textContent ?? '')
      .join(' ')
      .trim();
    if (labelled !== '') return labelled;
  }
  return (el.textContent ?? '').trim();
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Admin console — users', () => {
  it('lists every account with its role and last login', async () => {
    renderAdmin();
    const table = await screen.findByRole('table', { name: /user accounts/i });
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2
    expect(within(table).getByText('member@example.com')).toBeInTheDocument();
    expect(within(table).getByText(/never signed in/i)).toBeInTheDocument();
  });

  it('marks the signed-in admin so they cannot mistake whose row is whose', async () => {
    renderAdmin();
    const table = await screen.findByRole('table', { name: /user accounts/i });
    expect(within(table).getByText('you')).toBeInTheDocument();
  });

  it('creates a user and shows the generated password exactly once, with a copy affordance', async () => {
    const user = userEvent.setup();
    const fetchMock = stubFetch();
    renderAdmin();
    await user.type(await screen.findByLabelText(/new account email/i), 'new@example.com');
    await user.selectOptions(screen.getByLabelText(/new account role/i), 'member');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toMatchObject({
        email: 'new@example.com',
        role: 'member',
      });
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Zx9-generated-password-value');
    expect(banner).toHaveTextContent(/shown once/i);

    await user.click(within(banner).getByRole('button', { name: /copy the password/i }));
    await expect(navigator.clipboard.readText()).resolves.toBe('Zx9-generated-password-value');
    expect(await screen.findByText(/copied/i)).toBeInTheDocument();
  });

  it('never puts a generated password in a request URL', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    await userEvent.type(await screen.findByLabelText(/new account email/i), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    await screen.findByRole('status');
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).not.toContain('Zx9-generated-password-value');
    }
  });

  it('asks for an email instead of posting an empty one', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    await screen.findByRole('table', { name: /user accounts/i });
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/email address/i);
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'POST'),
    ).toBe(false);
  });

  it('surfaces a duplicate-email conflict instead of appearing to succeed', async () => {
    stubFetch((url, init) =>
      init?.method === 'POST' && url === '/api/admin/users'
        ? conflict('new@example.com already has an account.')
        : undefined);
    renderAdmin();
    await userEvent.type(await screen.findByLabelText(/new account email/i), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already has an account/i);
  });

  it('changes a role through the labelled select', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    const select = await screen.findByLabelText(/role for member@example.com/i);
    await userEvent.selectOptions(select, 'admin');
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[0] as string) === '/api/admin/users/u-member/role',
      );
      expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({ role: 'admin' });
    });
  });

  it('disables an account', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    await userEvent.click(
      await screen.findByRole('button', { name: /disable member@example.com/i }),
    );
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[0] as string) === '/api/admin/users/u-member/disabled',
      );
      expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({ disabled: true });
    });
  });

  it('offers the way back in for an account that is already disabled', async () => {
    const fetchMock = stubFetch(() => undefined, {
      rows: [ADMIN_ROW, { ...MEMBER_ROW, disabled: true }],
    });
    renderAdmin();
    const row = (await screen.findByText('member@example.com')).closest('tr');
    expect(within(row as HTMLElement).getByText('disabled')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /enable member@example.com/i }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[0] as string) === '/api/admin/users/u-member/disabled',
      );
      expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({ disabled: false });
    });
  });

  it('resets a password, shows the new one once, and says how many sessions it killed', async () => {
    stubFetch((url, init) =>
      init?.method === 'POST' && url === '/api/admin/users/u-member/reset-password'
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              user: MEMBER_ROW,
              generatedPassword: 'fresh-generated-password-1',
              revokedSessions: 2,
            }),
          }
        : undefined);
    renderAdmin();
    await userEvent.click(
      await screen.findByRole('button', { name: /reset password for member@example.com/i }),
    );
    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('fresh-generated-password-1');
    expect(banner).toHaveTextContent(/2 signed-in sessions/i);
  });

  it('explains a last-admin refusal rather than silently reverting the select', async () => {
    stubFetch((url) =>
      url === '/api/admin/users/u-admin/role'
        ? conflict('This is the last admin who can still sign in; promote or enable another admin first.')
        : undefined);
    renderAdmin();
    const select = await screen.findByLabelText(/role for admin@example.com/i);
    await userEvent.selectOptions(select, 'member');
    expect(await screen.findByRole('alert')).toHaveTextContent(/last admin/i);
    // The server refused, so the account is still an admin and the select says so.
    await waitFor(() => {
      expect((select as HTMLSelectElement).value).toBe('admin');
    });
  });

  it('warns on the last enabled admin BEFORE anything is clicked, and only on that row', async () => {
    renderAdmin();
    const adminRow = (await screen.findByText('admin@example.com')).closest('tr') as HTMLElement;
    const memberRow = screen.getByText('member@example.com').closest('tr') as HTMLElement;
    expect(within(adminRow).getByText(/last admin who can sign in/i)).toBeInTheDocument();
    expect(within(adminRow).getByText(/cannot be recovered/i)).toBeInTheDocument();
    expect(within(memberRow).queryByText(/last admin who can sign in/i)).not.toBeInTheDocument();
  });

  it('drops the last-admin warning once a second admin can sign in', async () => {
    stubFetch(() => undefined, {
      rows: [ADMIN_ROW, { ...MEMBER_ROW, role: 'admin' }],
    });
    renderAdmin();
    await screen.findByRole('table', { name: /user accounts/i });
    expect(screen.queryByText(/last admin who can sign in/i)).not.toBeInTheDocument();
  });

  it('confirms a delete before sending it, then names everything it destroyed', async () => {
    const fetchMock = stubFetch((url, init) =>
      init?.method === 'DELETE' && url === '/api/admin/users/u-member'
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              user: MEMBER_ROW,
              removed: { profiles: 1, watches: 3, sessions: 2, applications: 0 },
            }),
          }
        : undefined);
    renderAdmin();
    await userEvent.click(await screen.findByRole('button', { name: /^delete member@example.com/i }));

    // Nothing has been sent yet: the first click only asks.
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole('button', { name: /permanently delete member@example.com/i }),
    );
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(del?.[0]).toBe('/api/admin/users/u-member');
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/1 profile/);
    expect(banner).toHaveTextContent(/3 watchlist entries/);
    expect(banner).toHaveTextContent(/2 sessions/);
    expect(banner).toHaveTextContent(/0 applications/);
    expect(banner).toHaveTextContent(/audit/i);
  });

  it('sends nothing when the delete confirmation is cancelled', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    await userEvent.click(await screen.findByRole('button', { name: /^delete member@example.com/i }));
    await userEvent.click(screen.getByRole('button', { name: /keep member@example.com/i }));
    expect(screen.queryByText(/cannot be undone/i)).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE'),
    ).toBe(false);
  });

  it('offers no delete on your own row, and says what to do instead', async () => {
    renderAdmin();
    const ownRow = (await screen.findByText('admin@example.com')).closest('tr') as HTMLElement;
    expect(
      within(ownRow).queryByRole('button', { name: /delete admin@example.com/i }),
    ).not.toBeInTheDocument();
    expect(within(ownRow).getByText(/another admin can delete it/i)).toBeInTheDocument();
  });

  it('labels every control and titles the page exactly once', async () => {
    const { container } = renderAdmin();
    await screen.findByRole('table', { name: /user accounts/i });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    const controls = container.querySelectorAll('button, select, input, a[href]');
    expect(controls.length).toBeGreaterThan(8);
    for (const control of controls) {
      expect(accessibleName(control)).not.toBe('');
    }
  });
});

describe('Admin console — backup, restore and ICS tokens', () => {
  it('offers a backup download that points at the real endpoint', async () => {
    renderAdmin();
    const link = await screen.findByRole('link', { name: /download full backup/i });
    expect(link).toHaveAttribute('href', '/api/admin/backup.json');
    expect(link).toHaveAttribute('download');
  });

  it('keeps restore disabled until a file is chosen AND the operator types REPLACE', async () => {
    renderAdmin();
    const button = await screen.findByRole('button', { name: /restore from backup/i });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByLabelText(/type replace to confirm/i), 'REPLACE');
    // Typed the word, chose no file: still nothing to restore FROM.
    expect(button).toBeDisabled();

    const file = new File(['{"app":"grantspotter"}'], 'backup.json', { type: 'application/json' });
    await userEvent.upload(screen.getByLabelText(/backup file/i), file);
    expect(button).toBeEnabled();
  });

  it('states what restore destroys before it is used', async () => {
    renderAdmin();
    expect(
      await screen.findByText(/replaces every program, funder, cycle and review item/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/user accounts/i)).toBeInTheDocument();
  });

  it('posts the chosen file to the restore endpoint and reports what came back, including the real reindex count', async () => {
    const fetchMock = stubFetch((url, init) =>
      init?.method === 'POST' && url === '/api/admin/restore'
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              tablesRestored: ['funders', 'programs'],
              tablesSkipped: [],
              rowsRestored: 176,
              programsReindexed: 150,
            }),
          }
        : undefined);
    renderAdmin();
    const file = new File(['{"app":"grantspotter","tables":{}}'], 'backup.json', {
      type: 'application/json',
    });
    await userEvent.upload(await screen.findByLabelText(/backup file/i), file);
    await userEvent.type(screen.getByLabelText(/type replace to confirm/i), 'REPLACE');
    await userEvent.click(screen.getByRole('button', { name: /restore from backup/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[0] as string) === '/api/admin/restore');
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({
        app: 'grantspotter',
        tables: {},
      });
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent(/176 rows/i);
    expect(banner).toHaveTextContent(/2 tables/i);
    // Restore now genuinely calls reindexBrowse in the same transaction, so the copy states the
    // real count rather than telling the operator to restart the server for Browse to catch up
    // (the plan's own "restart the server" claim was never true once the reindex call was real).
    expect(banner).toHaveTextContent(/rebuilt for 150 programmes/i);
    expect(banner).not.toHaveTextContent(/restart/i);
  });

  it('reports null reindex honestly rather than rendering it as zero', async () => {
    const fetchMock = stubFetch((url, init) =>
      init?.method === 'POST' && url === '/api/admin/restore'
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              tablesRestored: ['funders'],
              tablesSkipped: ['a_future_table'],
              rowsRestored: 26,
              programsReindexed: null,
            }),
          }
        : undefined);
    renderAdmin();
    const file = new File(['{"app":"grantspotter","tables":{}}'], 'backup.json', {
      type: 'application/json',
    });
    await userEvent.upload(await screen.findByLabelText(/backup file/i), file);
    await userEvent.type(screen.getByLabelText(/type replace to confirm/i), 'REPLACE');
    await userEvent.click(screen.getByRole('button', { name: /restore from backup/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const banner = await screen.findByRole('status');
    expect(banner).not.toHaveTextContent(/rebuilt for 0/i);
    expect(banner).toHaveTextContent(/no browse projection to rebuild/i);
    expect(banner).toHaveTextContent(/a_future_table/);
    expect(banner).toHaveTextContent(/skipped/i);
  });

  it('names the file as the problem when it is not JSON, and posts nothing', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    // A truncated download, not a text file: `<input accept>` (and
    // `userEvent.upload`, which honours it) already turns away a .txt, so the
    // reachable failure is a .json whose CONTENTS are not JSON.
    const file = new File(['{"app":"grantspo'], 'backup.json', { type: 'application/json' });
    await userEvent.upload(await screen.findByLabelText(/backup file/i), file);
    await userEvent.type(screen.getByLabelText(/type replace to confirm/i), 'REPLACE');
    await userEvent.click(screen.getByRole('button', { name: /restore from backup/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a readable json/i);
    expect(fetchMock.mock.calls.some((c) => (c[0] as string) === '/api/admin/restore')).toBe(false);
  });

  it('revokes the calendar feed token and says what that breaks', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    expect(
      await screen.findByText(/every subscribed calendar will stop updating/i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /revoke my calendar feed link/i }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(del?.[0]).toBe('/api/exports/ics-token');
    });
  });

  it('does not pretend an admin can revoke someone else’s feed from here', async () => {
    renderAdmin();
    expect(await screen.findByText(/only your own/i)).toBeInTheDocument();
  });
});

/**
 * ENROLLMENT CODES WERE A PANEL ON THIS SCREEN AND ARE NOT (2026-08-11).
 *
 * The two tests here asserted that the console MOUNTED the codes panel, and that the instant it
 * judged expiry against came from this screen's `now` prop rather than from the clock the suite
 * happened to run on. Both were right; the panel is deleted, and `AdminProps.now` went with it
 * because no other panel on this screen renders anything time-dependent.
 *
 * What is asserted instead is the absence, at the two places it would show: no codes table, and no
 * form that could issue one. That is worth a test rather than nothing, because the failure mode of
 * a half-removed feature is a screen that still offers a control which 404s.
 */
describe('Admin console — the enrollment codes panel is gone', () => {
  it('renders the accounts panel and nothing about codes', async () => {
    renderAdmin();

    // The panel that stayed, so this is not passing because the screen failed to render at all.
    expect(await screen.findByRole('table', { name: /user accounts/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/new account email/i)).toBeInTheDocument();

    expect(screen.queryByRole('table', { name: /enrollment codes/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /enrollment codes/i })).toBeNull();
    expect(screen.queryByLabelText(/what this code is for/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /create enrollment code/i })).toBeNull();
  });
});

/**
 * Accounts on a phone.
 *
 * Unlike the source-health matrix, this table has nothing to scan down. Every row is a thing you
 * act ON — change this person's role, disable them, reset their password, delete them — and the
 * cells are one decision's worth of context around four controls. Below `ACCOUNTS_TABLE_MIN_PX`
 * each account becomes a card, and both layouts are built from the same three functions so that
 * a lock-out warning or a delete confirmation cannot be dropped from one of them.
 */
describe('Admin accounts on a phone', () => {
  afterEach(() => {
    restoreViewport();
  });

  it('keeps the table at the width the table fits at', async () => {
    setViewportWidth(ACCOUNTS_TABLE_MIN_PX);
    renderAdmin();
    expect(await screen.findByRole('table', { name: /user accounts/i })).toBeInTheDocument();
  });

  it('stacks into cards one pixel below it', async () => {
    setViewportWidth(ACCOUNTS_TABLE_MIN_PX - 1);
    renderAdmin();
    expect(await screen.findByRole('list', { name: /user accounts/i })).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /user accounts/i })).not.toBeInTheDocument();
  });

  it('keeps the lock-out warning on the account it is about', async () => {
    setViewportWidth(390);
    renderAdmin();
    await screen.findByRole('list', { name: /user accounts/i });
    expect(screen.getByText(/last admin who can sign in/i)).toBeInTheDocument();
  });

  it('keeps the "you" and "disabled" tags', async () => {
    setViewportWidth(390);
    stubFetch(() => undefined, {
      rows: [ADMIN_ROW, { ...MEMBER_ROW, disabled: true }],
    });
    renderAdmin();
    await screen.findByRole('list', { name: /user accounts/i });
    expect(screen.getByText('you')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('keeps both dates, labelled, rather than dropping the columns that held them', async () => {
    setViewportWidth(390);
    renderAdmin();
    await screen.findByRole('list', { name: /user accounts/i });
    expect(screen.getAllByText('Created (UTC)')).toHaveLength(2);
    expect(screen.getAllByText('Last login (UTC)')).toHaveLength(2);
    expect(screen.getByText('Never signed in')).toBeInTheDocument();
  });

  it('keeps every control, and the delete confirmation behind the delete', async () => {
    setViewportWidth(390);
    renderAdmin();
    await screen.findByRole('list', { name: /user accounts/i });
    expect(screen.getByRole('combobox', { name: /role for member@example.com/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disable member@example.com/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /reset password for member@example.com/i }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^delete member@example.com/i }));
    expect(screen.getByText(/this cannot be undone/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /permanently delete member@example.com/i }),
    ).toBeInTheDocument();
  });

  it('never offers to delete the signed-in account, on either layout', async () => {
    setViewportWidth(390);
    renderAdmin();
    await screen.findByRole('list', { name: /user accounts/i });
    expect(screen.queryByRole('button', { name: /^delete admin@example.com/i })).not.toBeInTheDocument();
    expect(screen.getByText(/you cannot delete your own account/i)).toBeInTheDocument();
  });
});
