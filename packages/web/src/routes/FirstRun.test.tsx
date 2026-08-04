import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { FirstRun, SignedOut } from './FirstRun.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A well-formed error envelope, the shape `apiFetch` parses: `{ error: { code, message }, requestId }`. */
function errorResponse(status: number, code: string, message: string) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { code, message }, requestId: 'req-test-1' }),
  };
}

function okResponse(body: unknown, status = 200) {
  return { ok: true, status, json: async () => body };
}

function renderGate(onAuthenticated = vi.fn()) {
  return render(
    <MemoryRouter>
      <SignedOut onAuthenticated={onAuthenticated} />
    </MemoryRouter>,
  );
}

function renderForm(onAuthenticated = vi.fn(), onBootstrapClosed = vi.fn()) {
  render(
    <MemoryRouter>
      <FirstRun onAuthenticated={onAuthenticated} onBootstrapClosed={onBootstrapClosed} />
    </MemoryRouter>,
  );
  return { onAuthenticated, onBootstrapClosed };
}

async function fillForm(password = 'a-long-enough-password', confirm = password): Promise<void> {
  await userEvent.type(screen.getByLabelText(/setup token/i), 'deadbeef');
  await userEvent.type(screen.getByLabelText(/^email$/i), 'admin@example.org');
  await userEvent.type(screen.getByLabelText(/^password$/i), password);
  await userEvent.type(screen.getByLabelText(/confirm password/i), confirm);
}

function submitForm(): Promise<void> {
  return userEvent.click(screen.getByRole('button', { name: /create administrator/i }));
}

describe('SignedOut gate', () => {
  it('offers first-run setup, not a sign-in form, when the server says bootstrap is required', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ required: true })));
    renderGate();

    expect(await screen.findByRole('heading', { name: /set up grantspotter/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/setup token/i)).toBeInTheDocument();
    // The defect this replaces: a sign-in form for an account that does not exist.
    expect(screen.queryByRole('button', { name: /^sign in$/i })).not.toBeInTheDocument();
  });

  it('shows the ordinary sign-in form, with nothing added, when bootstrap is not required', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ required: false })));
    renderGate();

    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /set up grantspotter/i })).not.toBeInTheDocument();
    // `required: false` is a definite answer, so there is nothing to warn about.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('draws neither form while the check is still in flight', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<never>(() => undefined)),
    );
    renderGate();

    // Guessing here is how the wrong operator gets the wrong screen: a fresh install would
    // flash a sign-in form, or an established one would flash an invitation to set it up.
    expect(screen.getByText(/checking whether this deployment/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /set up grantspotter/i })).not.toBeInTheDocument();
  });

  it('says the check failed rather than silently presenting a bare sign-in form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    renderGate();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not check whether this deployment has been set up/i);
    // Still usable by an operator whose deployment IS set up — the form is offered, the
    // uncertainty is stated, and neither is hidden behind the other.
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('reaches the setup screen on retry once the server finishes starting', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(okResponse({ required: true }));
    vi.stubGlobal('fetch', fetchMock);
    renderGate();

    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(await screen.findByRole('heading', { name: /set up grantspotter/i })).toBeInTheDocument();
  });
});

describe('FirstRun form', () => {
  it('states the password requirement before anything is submitted', () => {
    renderForm();
    // Before submit, before any request, and attached to the field it governs.
    const hint = screen.getByText(/at least 12 characters/i);
    expect(hint).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute(
      'aria-describedby',
      hint.getAttribute('id'),
    );
  });

  it('tells the operator where the setup token comes from', () => {
    renderForm();
    // A token-shaped field with no explanation is a dead end: the value is only ever
    // printed to the server's log.
    expect(screen.getByText(/printed in the server.s log/i)).toBeInTheDocument();
  });

  it('posts the token, email and password and signs the new administrator in', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ user: { id: 'u-1', email: 'admin@example.org', role: 'admin' } }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { onAuthenticated } = renderForm();

    await fillForm();
    await submitForm();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/bootstrap');
    expect(JSON.parse(init.body as string)).toEqual({
      token: 'deadbeef',
      email: 'admin@example.org',
      password: 'a-long-enough-password',
    });
    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalled();
    });
  });

  it('sends an optional display name only when one was typed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ user: { id: 'u-1', email: 'admin@example.org', role: 'admin' } }, 201),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    await fillForm();
    await userEvent.type(screen.getByLabelText(/display name/i), 'W1AW Club');
    await submitForm();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).displayName).toBe('W1AW Club');
  });

  it('refuses a below-floor password without spending the token on a round trip', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { onAuthenticated } = renderForm();

    await fillForm('short');
    await submitForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/at least 12 characters/i);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('catches a mistyped confirmation, because this account has no reset path', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderForm();

    await fillForm('a-long-enough-password', 'a-long-enough-passwerd');
    await submitForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the token as the problem when the server rejects it', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorResponse(401, 'unauthorized', 'That bootstrap token is not valid.'),
        ),
    );
    const { onAuthenticated } = renderForm();

    await fillForm();
    await submitForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/setup token was not accepted/i);
    expect(alert).toHaveTextContent(/every restart/i);
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('quotes the server when it refuses the password, rather than inventing a rule', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorResponse(422, 'validation_failed', 'Password must be at least 12 characters.'),
        ),
    );
    renderForm();

    // Long enough to clear the client-side floor, so the server's answer is what is shown.
    await fillForm('            !');
    await submitForm();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /password must be at least 12 characters/i,
    );
  });

  it('does not blame the operator when the API never answered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const { onAuthenticated } = renderForm();

    await fillForm();
    await submitForm();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not be reached/i);
    expect(alert).not.toHaveTextContent(/token was not accepted/i);
    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('re-enables the button after a failure so the operator can try again', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorResponse(401, 'unauthorized', 'That bootstrap token is not valid.'),
        ),
    );
    renderForm();

    await fillForm();
    await submitForm();

    await screen.findByRole('alert');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create administrator/i })).toBeEnabled();
    });
  });
});

describe('losing the race for the first account', () => {
  /**
   * Two operators open the setup screen at once, or one opens it in two tabs. The status
   * check said `required: true` for both; only one POST can win. The loser must be told
   * that an account now exists — the failure mode worth a test is a form that reports
   * nothing and looks like it worked.
   */
  it('reports the conflict and hands the operator the sign-in form they now need', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ required: true }))
      .mockResolvedValueOnce(
        errorResponse(409, 'conflict', 'An account already exists; bootstrap is closed.'),
      );
    vi.stubGlobal('fetch', fetchMock);
    const onAuthenticated = vi.fn();
    renderGate(onAuthenticated);

    await screen.findByRole('heading', { name: /set up grantspotter/i });
    await fillForm();
    await submitForm();

    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i);
    // It did not appear to succeed: nothing signed anybody in.
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: /set up grantspotter/i })).not.toBeInTheDocument();
  });
});
