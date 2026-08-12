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

  /**
   * THE SECOND `unauthorized` SENTENCE, WHICH THIS SCREEN USED TO OVERWRITE WITH THE FIRST.
   *
   * `POST /api/auth/login` answers 401 for two different states. One is the credentials; the other
   * is an account an administrator has switched off, and `api/auth.ts` carries a long argument for
   * why that one must not be told their password was wrong — there is no reset mail on this
   * product, so the sentence sends the one person who cannot fix anything to ask the administrator
   * who just switched them off. `packages/server/test/api.auth.test.ts` has covered the API's half
   * since 2026-08-12. Nothing covered the browser's, and the browser was discarding it: the arm was
   * `case 'unauthorized': return 'That email or password was not recognised.'`.
   *
   * Two assertions and not one. The first is that the truth arrives; the second names the specific
   * falsehood, because "the right words are present" and "the wrong words are gone" are different
   * claims and only the pair rules out a screen printing both.
   */
  it('prints the server’s own sentence for a switched-off account instead of blaming the password', async () => {
    const disabled =
      'That account has been switched off by an administrator, so GrantSpotter will not sign it ' +
      'in. Your password is correct and there is nothing wrong with it — changing it would not ' +
      'help. Ask whoever runs this GrantSpotter to switch the account back on.';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'unauthorized', message: disabled },
          requestId: 'req-test-1',
        }),
      }),
    );
    const refresh = vi.fn();
    renderLogin(refresh);

    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/switched off by an administrator/i);
    expect(alert).not.toHaveTextContent(/was not recognised/i);
    expect(refresh).not.toHaveBeenCalled();
  });

  /**
   * The fallback, which is the only reason a hardcoded sentence survives in that arm at all: a 401
   * whose envelope carries an empty message still has to say something. Asserted so the fallback is
   * a decision with a test on it rather than dead code nobody can see the shape of.
   */
  it('falls back to its own sentence when a 401 carries no message to print', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({
          error: { code: 'unauthorized', message: '   ' },
          requestId: 'req-test-1',
        }),
      }),
    );
    renderLogin();

    await signIn();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /that email or password was not recognised/i,
    );
  });

  /**
   * THE SERVER'S OWN 429, WORD FOR WORD, AND THE BODY BELOW IS A REAL ONE.
   *
   * `POST /api/auth/login` answers 429 in two states and this is the one that is not about the
   * reader at all: `hashUnderGate` shedding because the argon2id queue is full. MEASURED against
   * the built server on this host, 2026-08-12 — 500 concurrent sign-ins, 216 of them answered with
   * exactly this message and `retryAfterSec: 1`.
   *
   * This screen printed "Too many attempts. Try again in 1 second." over it: eight words of its
   * own, blaming a member who had made ONE attempt for a queue somebody else filled. It is the
   * same defect as the `unauthorized` arm eight lines above in `Login.tsx`, corrected one round
   * earlier, and the same argument applies — the API's sentences are written for this reader and a
   * screen that re-words them is a second place the copy has to be kept true.
   */
  it('prints the server’s sentence for a shed request instead of blaming the attempt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          error: {
            code: 'rate_limited',
            message:
              'This server is already doing as much password checking as it can right now. ' +
              'Nothing is wrong with your details, nothing has been used up, and nobody needs to ' +
              'do anything about it.',
            details: { retryAfterSec: 1 },
          },
          requestId: 'req-test-1',
        }),
      }),
    );
    renderLogin();
    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/as much password checking as it can right now/i);
    expect(alert).toHaveTextContent(/nothing is wrong with your details/i);
    // The server's number, once, appended — and none of this screen's invented arithmetic.
    expect(alert).toHaveTextContent(/try again in 1 second\./i);
    expect(alert).not.toHaveTextContent(/too many attempts/i);
    expect(alert).not.toHaveTextContent(/not recognised/i);
  });

  /**
   * THE OTHER 429 ON THIS ROUTE: the per-(peer, address) bucket. Behind the owner's tunnel the peer
   * is one value for the whole deployment, so the server says whose attempts they may have been and
   * that moving will not help — and that is exactly the part a hardcoded "Too many attempts" threw
   * away. MEASURED against the built server: six wrong passwords for one address, the sixth
   * answered 429 with `retryAfterSec: 900`.
   */
  it('does not re-word the sentence that says the attempts may not have been yours', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          error: {
            code: 'rate_limited',
            message:
              'Sign-ins for this email address have been refused too many times. This ' +
              'GrantSpotter is behind a proxy, so every sign-in arrives the same way and the ' +
              'failed attempts may not have been yours: signing in from another network or ' +
              'another device will not get past this. Nothing has been changed and no account has ' +
              'been locked: what is refused is trying this address again, and it lifts on its own.',
            details: { retryAfterSec: 900 },
          },
          requestId: 'req-test-1',
        }),
      }),
    );
    renderLogin();
    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/the failed attempts may not have been yours/i);
    expect(alert).toHaveTextContent(/no account has been locked/i);
    expect(alert).toHaveTextContent(/try again in 15 minutes\./i);
  });

  /**
   * AND THE ONE STATE WHERE THIS SCREEN STILL HAS TO SAY SOMETHING OF ITS OWN. A 429 whose envelope
   * carries no sentence leaves nothing to print, and `lib/retryAfter.ts`'s rule covers the number:
   * with no `retryAfterSec` there is no figure to invent, so the screen says nothing about time.
   */
  it('says nothing about time when the server sent neither a sentence nor a number', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        json: async () => ({
          error: { code: 'rate_limited', message: '   ' },
          requestId: 'req-test-1',
        }),
      }),
    );
    renderLogin();
    await signIn();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/too many sign-in attempts\./i);
    expect(alert).not.toHaveTextContent(/wait a minute/i);
    expect(alert).not.toHaveTextContent(/try again in/i);
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
