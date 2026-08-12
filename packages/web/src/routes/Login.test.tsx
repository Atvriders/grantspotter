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
  it('keeps the compact measure that suits two fields and no prose', () => {
    /*
      The one screen that does NOT take the wider panel, and the reason is what sets the width in
      the first place: there is no help text here to measure. 380px was a good decision for a
      sign-in box; what was wrong was that `SignedOutPage` applied it inline to two other screens
      as well, where six fields each carry a paragraph. See `components/signedOut.css`.
    */
    const { container } = render(
      <MemoryRouter>
        <Login onAuthenticated={vi.fn()} />
      </MemoryRouter>,
    );
    const panel = container.querySelector('main#main');
    expect(panel).toHaveClass('signed-out-compact');
    expect(panel).not.toHaveClass('signed-out-prose');
    expect(container.querySelectorAll('.signed-out-hint')).toHaveLength(0);
    // An inline width is unreachable by a media query, which is the whole defect.
    expect(panel?.getAttribute('style')).toBeNull();
  });

  /**
   * THE ASIDE UNDER THE FORM, AND THE SENTENCE THAT CHANGED WITH THE PRODUCT.
   *
   * It read "Been given an enrollment code? / I have an enrollment code" and pointed at a form
   * that only a code holder could complete. Registration is open (2026-08-11), so it asks the
   * question everybody without an account can answer, and the gate now passes `onEnrol`
   * unconditionally because there is nothing left to be unsure about.
   *
   * The prop stays optional for the renders that have nowhere to send anybody — the accessibility
   * audit is the caller — so both halves are pinned here: present when there is a destination,
   * absent when there is not, and never a dangling offer.
   */
  it('offers sign-up when there is somewhere to send them, and nothing when there is not', async () => {
    const onEnrol = vi.fn();
    const { unmount } = render(
      <MemoryRouter>
        <Login onAuthenticated={vi.fn()} onEnrol={onEnrol} />
      </MemoryRouter>,
    );
    const offer = screen.getByRole('button', { name: /create an account/i });
    expect(offer).toBeInTheDocument();
    expect(screen.queryByText(/enrollment code/i)).not.toBeInTheDocument();
    await userEvent.click(offer);
    expect(onEnrol).toHaveBeenCalled();
    unmount();

    render(
      <MemoryRouter>
        <Login onAuthenticated={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('button', { name: /create an account/i })).not.toBeInTheDocument();
  });

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

  /** The same correction as `Enroll.test.tsx`: the server's own number, not a guess of ours. */
  it('repeats the server’s retryAfterSec rather than inventing a minute', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          error: {
            code: 'rate_limited',
            message: 'Too many sign-in attempts.',
            details: { retryAfterSec: 900 },
          },
          requestId: 'req-test-1',
        }),
      }),
    );
    renderLogin();
    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/try again in 15 minutes/i);
    expect(alert).not.toHaveTextContent(/wait a minute/i);
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
