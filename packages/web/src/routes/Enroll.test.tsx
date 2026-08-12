import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Enroll } from './Enroll.js';

/**
 * THE SIGN-UP SCREEN.
 *
 * WHAT WENT FROM THIS FILE ON 2026-08-11, and it is a third of it: every test about an enrollment
 * code. There were five failures that were STATES OF A CODE — unknown, expired, revoked, used up,
 * and a wrong-but-plausible one that had to read identically to an unknown one — and a whole
 * describe block ("what the enrolment screen refuses to reveal") pinning that this form could not
 * be used to find out which codes exist. None of those states can occur any more, so the tests are
 * deleted rather than adapted: a test for a branch that cannot be reached is a test that will pass
 * forever and mean nothing.
 *
 * What replaces them is smaller and is the whole of what this screen can now be told: the password
 * is too short, the address is taken, the deployment is not set up yet, the server is too busy, or
 * it could not be reached.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The envelope `apiFetch` parses: `{ error: { code, message, details? }, requestId }`. */
function errorResponse(status: number, code: string, message: string, details?: unknown) {
  return {
    ok: false,
    status,
    json: async () => ({
      error: details === undefined ? { code, message } : { code, message, details },
      requestId: 'req-test-1',
    }),
  };
}

function okResponse(body: unknown, status = 200) {
  return { ok: true, status, json: async () => body };
}

const CREATED = okResponse(
  { user: { id: 'u-9', email: 'student@example.edu', role: 'member' } },
  201,
);

function renderEnroll(onAuthenticated = vi.fn(), onCancel = vi.fn()) {
  render(
    <MemoryRouter>
      <Enroll onAuthenticated={onAuthenticated} onCancel={onCancel} />
    </MemoryRouter>,
  );
  return { onAuthenticated, onCancel };
}

async function fillSignUp(options: { password?: string; email?: string } = {}): Promise<void> {
  await userEvent.type(screen.getByLabelText(/^email$/i), options.email ?? 'student@example.edu');
  await userEvent.type(
    screen.getByLabelText(/^password$/i),
    options.password ?? 'a-long-enough-password',
  );
}

function submit(): Promise<void> {
  return userEvent.click(screen.getByRole('button', { name: /create my account/i }));
}

/** The one sentence every failure must NOT be. */
function expectNotGeneric(text: string): void {
  expect(text).not.toMatch(/something went wrong/i);
}

describe('the sign-up form, before anything is submitted', () => {
  it('opens the shared panel at the width its explanations need, and puts each hint in its field', () => {
    /*
      `SignedOutPage` is one wrapper for three screens, and the measure is the screen's decision:
      the sign-in box has two fields and no prose, this has three fields under a lede with one of
      them explained in a paragraph. Rendered rather than grepped, because the class has to be on
      the landmark that `components/signedOut.css` styles — see that stylesheet for the
      66-character measure the prose width is derived from, and `signedOut.css.test.ts` for the
      spacing relationship it carries.

      ONE HINT, NOT TWO. The second belonged to the enrollment-code field and said that
      GrantSpotter stores only a hash of a code, so nobody — including an administrator — could
      read one back. There is no code to say it about.
    */
    const { container } = render(
      <MemoryRouter>
        <Enroll onAuthenticated={vi.fn()} onCancel={vi.fn()} />
      </MemoryRouter>,
    );
    const panel = container.querySelector('main#main');
    expect(panel).toHaveClass('signed-out-prose');
    expect(panel).not.toHaveClass('signed-out-compact');
    for (const hint of container.querySelectorAll('.signed-out-hint')) {
      expect(hint.closest('.signed-out-field')).not.toBeNull();
    }
    expect(container.querySelectorAll('.signed-out-hint')).toHaveLength(1);
  });

  it('states the 12-character password rule up front, attached to the field it governs', () => {
    renderEnroll();
    const hint = screen.getByText(/at least 12 characters/i);
    expect(hint).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute(
      'aria-describedby',
      hint.getAttribute('id'),
    );
  });

  it('says that anybody may sign up, and that it is not an administrator account', () => {
    renderEnroll();
    expect(screen.getByText(/anybody can create an account/i)).toBeInTheDocument();
    expect(screen.getByText(/never administrator access/i)).toBeInTheDocument();
  });

  /**
   * THE FIELD THAT IS GONE IS THE POINT OF THE CHANGE, so it is asserted absent rather than left to
   * the absence of a test. A code field that came back — from a revert, a merge, a copied screen —
   * would fail here and nowhere else.
   */
  it('asks for an email, a password and an optional display name, and nothing else', () => {
    renderEnroll();
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/enrollment code/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/code/i)).not.toBeInTheDocument();
    // Nothing on this screen may ask for, or offer, a role.
    expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument();
    // Or a callsign: sign-up asks for the smallest thing that can make an account, and the lookup
    // that used to run during setup now lives on the profile.
    expect(screen.queryByLabelText(/callsign/i)).not.toBeInTheDocument();
  });

  it('offers the way back for somebody who already has an account', async () => {
    const { onCancel } = renderEnroll();
    await userEvent.click(screen.getByRole('button', { name: /already have an account/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('creating the account', () => {
  it('posts the email and password, and signs the new member in', async () => {
    const fetchMock = vi.fn().mockResolvedValue(CREATED);
    vi.stubGlobal('fetch', fetchMock);
    const { onAuthenticated } = renderEnroll();

    await fillSignUp();
    await submit();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/enroll');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'student@example.edu',
      password: 'a-long-enough-password',
    });
    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalled();
    });
  });

  it('never asks for a role, so the body cannot carry one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(CREATED);
    vi.stubGlobal('fetch', fetchMock);
    renderEnroll();

    await fillSignUp();
    await submit();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(JSON.parse(init.body as string))).toEqual(['email', 'password']);
  });

  it('sends a display name only when one was typed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(CREATED);
    vi.stubGlobal('fetch', fetchMock);
    renderEnroll();

    await fillSignUp();
    await userEvent.type(screen.getByLabelText(/display name/i), '  Jo Student  ');
    await submit();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).displayName).toBe('Jo Student');
  });

  /**
   * ONE PRESS, ONE ACCOUNT. The button is disabled while a request is in flight and `submit`
   * refuses as well, because Enter submits a form from any field. Two POSTs from one intent is how
   * a person ends up reading that their own address already has an account — and now that every
   * attempt is charged to the registration ladder, it is also how they spend two of their own
   * places instead of one. Both clicks are dispatched before the in-flight POST resolves.
   */
  it('sends exactly one request when the button is pressed twice in a row', async () => {
    let release: (value: unknown) => void = () => undefined;
    const inFlight = new Promise((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn().mockImplementation(async () => {
      await inFlight;
      return CREATED;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { onAuthenticated } = renderEnroll();

    await fillSignUp();
    const button = screen.getByRole('button', { name: /create my account/i });
    await userEvent.click(button);
    await userEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Let the one request finish, so the component settles inside the test rather than after it.
    release(null);
    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalled();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('every way signing up fails has its own words', () => {
  async function failWith(response: unknown): Promise<HTMLElement> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    renderEnroll();
    await fillSignUp();
    await submit();
    return screen.findByRole('alert');
  }

  it('refuses a below-floor password without spending an attempt on the server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { onAuthenticated } = renderEnroll();

    await fillSignUp({ password: 'short' });
    await submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/at least 12 characters/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();

    // The same claim `FirstRun.test.tsx` makes at its own password field, and for the same reason:
    // jsdom runs no interactive validation, so this test could not tell a sentence that renders
    // from one a `minLength` attribute keeps the browser from ever reaching. Chromium's bubble was
    // what a person saw here; nothing in this environment could say so.
    expect(screen.getByLabelText(/^password$/i)).not.toHaveAttribute('minlength');
  });

  it('quotes the server when it refuses the password, rather than inventing a second rule', async () => {
    // Long enough to clear the client-side floor, so the server's answer is what is shown.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorResponse(422, 'validation_failed', 'Password must be at least 12 characters.'),
        ),
    );
    renderEnroll();
    await fillSignUp({ password: '              !' });
    await submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /password must be at least 12 characters/i,
    );
  });

  it('names a registered email as a registered email, and points at signing in', async () => {
    const alert = await failWith(
      errorResponse(409, 'conflict', 'student@example.edu already has an account.'),
    );
    expect(alert).toHaveTextContent(/already an account for that email address/i);
    expect(alert).toHaveTextContent(/sign in with it instead/i);
    expectNotGeneric(alert.textContent ?? '');
  });

  /**
   * THE OTHER 409, AND THE ONE THAT MUST NOT BE MISTAKEN FOR THE FIRST.
   *
   * `POST /api/auth/enroll` refuses everybody while no administrator exists, because a stranger's
   * account on a fresh deployment would make the operator's one-time setup token useless forever.
   * The advice is the opposite of the taken-address advice: telling somebody to "sign in instead"
   * on a deployment with NO accounts sends them to a form that cannot work.
   */
  it('tells somebody at an unclaimed deployment to wait for its operator, not to sign in', async () => {
    const alert = await failWith(
      errorResponse(
        409,
        'conflict',
        'This GrantSpotter has not been set up yet, so it cannot create accounts. Whoever runs ' +
          'it has to create the administrator account first — once they have, anybody can sign up here.',
      ),
    );
    expect(alert).toHaveTextContent(/has not been set up yet/i);
    expect(alert).toHaveTextContent(/administrator account first/i);
    expect(alert).not.toHaveTextContent(/already an account for that email/i);
  });

  /**
   * THE SERVER'S OWN SENTENCE FOR A 429, because there are two conditions behind that status and
   * only the server knows which it hit: the registration ladder (this connection, this network or
   * this whole server has created too many accounts in the last fifteen minutes) and the hash queue
   * shedding under load. Its sentences already distinguish them, and both say the thing this screen
   * would otherwise have to guess at — that nothing is wrong with the person's details.
   */
  it('repeats what the server said about the ladder, and how long it asked for', async () => {
    /*
      THE BODY BELOW IS THE ONE THE SHIPPED SERVER SENDS, copied from `registrationRefusal` in
      `packages/server/src/api/auth.ts`, and it is worth keeping in step by hand for one reason: the
      defect this test now guards was a composition of the two halves, so a stand-in that says
      something the server never says cannot see it. The server's sentence carries no duration; this
      screen appends the one number the server sent. Both halves in one paragraph, once each.
    */
    const alert = await failWith(
      errorResponse(
        429,
        'rate_limited',
        '200 accounts have been created from this connection in the last fifteen minutes, which ' +
          'is as many as GrantSpotter will make in that time, so it is not making another one ' +
          'yet. Nothing is wrong with your details, and the accounts already created are fine. ' +
          'If you already have an account, signing in is not affected by this.',
        { retryAfterSec: 900 },
      ),
    );
    expect(alert).toHaveTextContent(/200 accounts have been created from this connection/i);
    expect(alert).toHaveTextContent(/nothing is wrong with your details/i);
    expect(alert).toHaveTextContent(/signing in is not affected/i);
    // The number the server actually sent, not a made-up minute.
    expect(alert).toHaveTextContent(/try again in 15 minutes/i);
    /*
      AND EXACTLY ONE STATEMENT OF WHEN. MEASURED against the built server, 130 students behind one
      campus NAT: the paragraph read "… so it is not starting another one this second. Nothing is
      wrong with your details — wait a moment and try again. … Try again in 15 minutes." Two
      durations from two sources, disagreeing by three orders of magnitude. The server stopped
      saying when; this asserts that this screen says it once and that nothing reintroduces a second.
    */
    const shown = alert.textContent ?? '';
    expect(shown.match(/try again/gi) ?? []).toHaveLength(1);
    expect(shown).not.toMatch(/wait a (moment|minute|few)/i);
  });

  it('says nothing about time when the server named no number', async () => {
    const alert = await failWith(
      errorResponse(429, 'rate_limited', 'This server is already doing as much password checking as it can right now.'),
    );
    expect(alert).toHaveTextContent(/as much password checking as it can/i);
    expect(alert.textContent ?? '').not.toMatch(/\d+ (second|minute)/i);
  });

  it('does not blame the person when the API never answered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderEnroll();
    await fillSignUp();
    await submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be reached/i);
    // The honest hedge: the request may have arrived, so the account may exist.
    expect(alert).toHaveTextContent(/signing in with this email and password will work/i);
  });

  it('reports a server fault as a server fault', async () => {
    const alert = await failWith(errorResponse(503, 'internal', 'upstream unavailable'));
    expect(alert).toHaveTextContent(/fault on the server/i);
    expectNotGeneric(alert.textContent ?? '');
  });

  it('re-enables the button after a failure so the form can be retried', async () => {
    await failWith(errorResponse(409, 'conflict', 'student@example.edu already has an account.'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create my account/i })).toBeEnabled();
    });
  });
});
