import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Enroll } from './Enroll.js';

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

async function fillEnrol(
  options: { code?: string; password?: string; email?: string } = {},
): Promise<void> {
  await userEvent.type(screen.getByLabelText(/enrollment code/i), options.code ?? 'JOIN-W1MX-2026');
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

describe('the enrolment form, before anything is submitted', () => {
  it('states the 12-character password rule up front, attached to the field it governs', () => {
    renderEnroll();
    const hint = screen.getByText(/at least 12 characters/i);
    expect(hint).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute(
      'aria-describedby',
      hint.getAttribute('id'),
    );
  });

  it('says what an enrolled account is — and is not — before the code is spent on finding out', () => {
    renderEnroll();
    expect(screen.getByText(/never administrator access/i)).toBeInTheDocument();
  });

  it('collects a code, an email, a password and an optional display name, and nothing else', () => {
    renderEnroll();
    expect(screen.getByLabelText(/enrollment code/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    // Nothing on this screen may ask for, or offer, a role.
    expect(screen.queryByLabelText(/role/i)).not.toBeInTheDocument();
  });

  it('offers the way back for somebody who already has an account', async () => {
    const { onCancel } = renderEnroll();
    await userEvent.click(screen.getByRole('button', { name: /already have an account/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('redeeming a code', () => {
  it('posts the code, email and password, and signs the new member in', async () => {
    const fetchMock = vi.fn().mockResolvedValue(CREATED);
    vi.stubGlobal('fetch', fetchMock);
    const { onAuthenticated } = renderEnroll();

    await fillEnrol();
    await submit();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/enroll');
    expect(JSON.parse(init.body as string)).toEqual({
      code: 'JOIN-W1MX-2026',
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

    await fillEnrol();
    await submit();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual([
      'code',
      'email',
      'password',
    ]);
  });

  it('sends a display name only when one was typed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(CREATED);
    vi.stubGlobal('fetch', fetchMock);
    renderEnroll();

    await fillEnrol();
    await userEvent.type(screen.getByLabelText(/display name/i), 'Jamie (KD9XYZ)');
    await submit();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).displayName).toBe('Jamie (KD9XYZ)');
  });

  it('trims the code, because it is always pasted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(CREATED);
    vi.stubGlobal('fetch', fetchMock);
    renderEnroll();

    await fillEnrol({ code: '  JOIN-W1MX-2026  ' });
    await submit();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).code).toBe('JOIN-W1MX-2026');
  });

  /**
   * ONE PRESS, ONE REDEMPTION.
   *
   * The server makes redemption atomic, and that is where a single-use code redeemed by two
   * people at the same instant is decided. This is the other half, and it is the browser's own:
   * an impatient double-press must not spend a one-use code twice and leave the person reading
   * that their code is used up. Both clicks are dispatched before the in-flight POST resolves.
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

    await fillEnrol();
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

describe('every way enrolment fails has its own words', () => {
  async function failWith(response: unknown): Promise<HTMLElement> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    renderEnroll();
    await fillEnrol();
    await submit();
    return screen.findByRole('alert');
  }

  it('refuses a below-floor password without spending an attempt on the server', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { onAuthenticated } = renderEnroll();

    await fillEnrol({ password: 'short' });
    await submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/at least 12 characters/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
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
    await fillEnrol({ password: '              !' });
    await submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /password must be at least 12 characters/i,
    );
  });

  it('tells the holder of a wrong code what to check, and calls it nothing else', async () => {
    const alert = await failWith(
      errorResponse(401, 'unauthorized', 'That enrollment code was not accepted.'),
    );
    expect(alert).toHaveTextContent(/was not accepted/i);
    // Something the person can actually act on. It does not mention trailing whitespace, because
    // the form trims the code before sending it and that can no longer be the cause.
    expect(alert).toHaveTextContent(/missing or swapped character/i);
    expectNotGeneric(alert.textContent ?? '');
  });

  it('says a code has expired, and whose problem that is', async () => {
    const alert = await failWith(
      errorResponse(403, 'forbidden', 'This enrollment code expired on 2026-07-01.', {
        reason: 'expired',
      }),
    );
    expect(alert).toHaveTextContent(/has expired/i);
    // Not the person's mistake, and the fix is not on this screen.
    expect(alert).toHaveTextContent(/nothing you typed is wrong/i);
    expect(alert).toHaveTextContent(/ask whoever gave you the code/i);
    expect(alert).not.toHaveTextContent(/was not accepted/i);
  });

  it('says a code has been revoked, without implying the person did something', async () => {
    const alert = await failWith(
      errorResponse(403, 'forbidden', 'This enrollment code has been revoked.', {
        reason: 'revoked',
      }),
    );
    expect(alert).toHaveTextContent(/withdrawn by an administrator/i);
    expect(alert).toHaveTextContent(/not something you did/i);
    expect(alert).toHaveTextContent(/ask whoever gave you the code/i);
  });

  it('says a code is used up, and sends them back for one of their own', async () => {
    const alert = await failWith(
      errorResponse(403, 'forbidden', 'This enrollment code has no uses left.', {
        reason: 'exhausted',
      }),
    );
    expect(alert).toHaveTextContent(/used as many times as it allows/i);
    expect(alert).toHaveTextContent(/not something you did/i);
    expect(alert).toHaveTextContent(/one of your own/i);
  });

  it('names a registered email as a registered email, and points at signing in', async () => {
    const alert = await failWith(
      errorResponse(409, 'conflict', 'student@example.edu already has an account.', {
        reason: 'email_taken',
      }),
    );
    expect(alert).toHaveTextContent(/already an account for that email/i);
    expect(alert).toHaveTextContent(/sign in with it instead/i);
    // It is an email problem, not a code problem: nothing here may send them back to the code.
    expect(alert).not.toHaveTextContent(/was not accepted/i);
  });

  it('says the same thing about a bare 409, because that is all a 409 means here', async () => {
    // `POST /api/auth/enroll` raises exactly one conflict, and it is this one — so the sentence
    // that says where to go instead does not have to wait for the server to label it.
    const alert = await failWith(
      errorResponse(409, 'conflict', 'student@example.edu already has an account.'),
    );
    expect(alert).toHaveTextContent(/already an account for that email/i);
    expect(alert).toHaveTextContent(/sign in with it instead/i);
  });

  /**
   * THE SHAPE THE SERVER SENDS TODAY.
   *
   * `/api/auth/enroll` refuses a real-but-unusable code with `forbidden` and a sentence of its
   * own, and attaches no `details.reason` — so this is the branch a live holder of an expired code
   * actually reaches. What it must never do is swallow that sentence for one of ours: the
   * server's copy is the only thing on screen that says which state the code is in.
   */
  it('shows the server’s own sentence when it names no reason, rather than an apology of ours', async () => {
    const alert = await failWith(
      errorResponse(
        403,
        'forbidden',
        'That enrollment code has expired. Ask whoever gave it to you for a new one — they can issue one immediately.',
      ),
    );
    expect(alert).toHaveTextContent(/has expired/i);
    expect(alert).toHaveTextContent(/ask whoever gave it to you/i);
    expect(alert).not.toHaveTextContent(/was not accepted/i);
    expectNotGeneric(alert.textContent ?? '');
  });

  it('names the cooldown when the attempt is rate-limited, and blames neither the code nor the person', async () => {
    const alert = await failWith(
      errorResponse(429, 'rate_limited', 'Too many enrolment attempts.'),
    );
    expect(alert).toHaveTextContent(/too many attempts/i);
    expect(alert).not.toHaveTextContent(/was not accepted/i);
  });

  it('does not blame the code when the API never answered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { onAuthenticated } = renderEnroll();
    await fillEnrol();
    await submit();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be reached/i);
    expect(alert).not.toHaveTextContent(/was not accepted/i);
    // A request with no answer is not a request that failed: it may have created the account.
    expect(alert).toHaveTextContent(/signing in with this email and password will work/i);
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('reports a server fault as a server fault, not as a bad code', async () => {
    const alert = await failWith(errorResponse(500, 'internal', 'Something went wrong.'));
    expect(alert).toHaveTextContent(/the server answered 500/i);
    expect(alert).not.toHaveTextContent(/was not accepted/i);
  });

  it('re-enables the button after a failure so the code can be retyped', async () => {
    await failWith(errorResponse(401, 'unauthorized', 'That enrollment code was not accepted.'));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create my account/i })).toBeEnabled();
    });
  });
});

/**
 * NO ENUMERATION.
 *
 * A code is guessable only by trying, so the one thing this screen must never become is an oracle
 * for which codes exist. An unknown code and a mistyped real one have to be indistinguishable
 * here, whichever way the server phrases its refusal.
 */
describe('what the enrolment screen refuses to reveal', () => {
  async function messageFor(response: unknown): Promise<string> {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const { unmount } = render(
      <MemoryRouter>
        <Enroll onAuthenticated={vi.fn()} onCancel={vi.fn()} />
      </MemoryRouter>,
    );
    await fillEnrol();
    await submit();
    const text = (await screen.findByRole('alert')).textContent ?? '';
    unmount();
    vi.unstubAllGlobals();
    return text;
  }

  it('answers a code that does not exist exactly as it answers a wrong one', async () => {
    const unnamed = await messageFor(
      errorResponse(401, 'unauthorized', 'That enrollment code was not accepted.'),
    );
    const named = await messageFor(
      errorResponse(401, 'unauthorized', 'No such enrollment code.', {
        reason: 'unknown_code',
      }),
    );
    // Same words, and the server's own "no such code" is not one of them.
    expect(named).toBe(unnamed);
    expect(named).not.toMatch(/no such/i);
  });

  it('does not turn a 404 into a different answer than a 401', async () => {
    const notFound = await messageFor(errorResponse(404, 'not_found', 'Unknown code.'));
    const unauthorized = await messageFor(errorResponse(401, 'unauthorized', 'Nope.'));
    expect(notFound).toBe(unauthorized);
  });

  it('says nothing about how many codes exist, or who else holds one', async () => {
    const text = await messageFor(errorResponse(401, 'unauthorized', 'Not accepted.'));
    expect(text).not.toMatch(/\d+ codes?\b/i);
    expect(text).not.toMatch(/other (code|account|person)/i);
  });
});
