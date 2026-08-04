import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Login } from './Login.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderLogin(refresh = vi.fn()) {
  return render(
    <MemoryRouter>
      <Login onAuthenticated={refresh} />
    </MemoryRouter>,
  );
}

async function signIn(password = 'correct horse battery'): Promise<void> {
  await userEvent.type(screen.getByLabelText(/email/i), 'member@example.com');
  await userEvent.type(screen.getByLabelText(/password/i), password);
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

describe('Login', () => {
  it('labels both fields', () => {
    renderLogin();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toHaveAttribute('type', 'password');
  });

  it('posts the credentials and calls back on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.fn();
    renderLogin(refresh);

    await signIn();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'member@example.com',
      password: 'correct horse battery',
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('shows a live-region error on a rejected login and does not call back', async () => {
    // Plan 1's envelope, not an ad-hoc string: { error: { code, message }, requestId }.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'unauthorized', message: 'Invalid email or password.' },
          requestId: 'req-test-1',
        }),
      }),
    );
    const refresh = vi.fn();
    renderLogin(refresh);

    await signIn('wrong');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/email or password/i);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('names the cooldown when the server rate-limits the attempt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          error: { code: 'rate_limited', message: 'Too many sign-in attempts.' },
          requestId: 'req-test-1',
        }),
      }),
    );
    renderLogin();
    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too many attempts/i);
    expect(alert).not.toHaveTextContent(/not recognised/i);
  });

  it('does not blame the credentials when the API never answered', async () => {
    // "That email or password was not recognised" for a transport failure is a
    // false statement about the user's password. The two are different failures
    // and only one of them is the user's to fix.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
    );
    const refresh = vi.fn();
    renderLogin(refresh);

    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be reached/i);
    expect(alert).not.toHaveTextContent(/password/i);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('re-enables the button after a failure so the user can try again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'unauthorized', message: 'Invalid email or password.' },
          requestId: 'req-test-1',
        }),
      }),
    );
    renderLogin();
    await signIn('wrong');

    await screen.findByRole('alert');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
    });
  });
});
