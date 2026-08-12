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
    /*
      A router rather than one body for every call, because the gate now asks TWO questions: is
      this a fresh install, and does this deployment accept enrollment codes. Answering the second
      with `{ required: false }` would leave the enrolment offer standing (that is what an
      unreadable answer means, deliberately — see `SignedOut`), and this test is about the screen
      with NOTHING added, so it is answered with the definite no it describes.
    */
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === '/api/auth/enrollment-open'
          ? okResponse({ open: false })
          : okResponse({ required: false }),
      ),
    );
    renderGate();

    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /set up grantspotter/i })).not.toBeInTheDocument();
    // `required: false` is a definite answer, so there is nothing to warn about.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // And `open: false` is a definite answer too: a deployment that issues no codes offers no
    // way in that ends in "that code was not accepted".
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /i have an enrollment code/i }),
      ).not.toBeInTheDocument();
    });
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
  it('opens the shared panel at the width its explanations need, and puts each hint in its field', () => {
    /*
      The owner's second and third reports, as a structure. `SignedOutPage` is one wrapper for
      three screens and it used to hard-code the sign-in box's 380px inline, where no media query
      could reach it; the measure is now the SCREEN'S decision, and this is the screen with the
      most explanation on it. The hint living inside its field is what makes one grid gap able to
      say "these belong together" — see `components/signedOut.css`.

      TWO HINTS, NOT THREE, and the measure does not change with it: the callsign field and its
      lookup panel are gone (2026-08-11), and what is left — the setup token's paragraph and the
      password's — is still prose that wraps at 43 characters in the sign-in box's width.
    */
    const { container } = render(
      <MemoryRouter>
        <FirstRun onAuthenticated={vi.fn()} onBootstrapClosed={vi.fn()} />
      </MemoryRouter>,
    );
    const panel = container.querySelector('main#main');
    expect(panel).toHaveClass('signed-out-prose');
    expect(panel).not.toHaveClass('signed-out-compact');
    for (const hint of container.querySelectorAll('.signed-out-hint')) {
      expect(hint.closest('.signed-out-field')).not.toBeNull();
    }
    expect(container.querySelectorAll('.signed-out-hint')).toHaveLength(2);
    // Nothing on the setup screen asks a network question any more, which is what the lookup was.
    expect(container.querySelector('#first-run-callsign')).toBeNull();
    expect(container.querySelector('.callsign-lookup')).toBeNull();
  });

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

  /**
   * WHERE THE TOKEN COMES FROM, AND THE ANSWER CHANGED ON 2026-08-11.
   *
   * This used to require the hint to say the token was "printed in the server's log", which was
   * true and is now the thing that was wrong with it: `docker logs` keeps a secret for the life of
   * the container. The server writes the token to a file in its data directory and prints only the
   * PATH, so the hint has to send the operator to the log for the path and to the file for the
   * token. A token-shaped field with no explanation is still a dead end, which is why this test
   * exists at all.
   */
  it('tells the operator where the setup token comes from', () => {
    renderForm();
    expect(screen.getByText(/first-run-token\.txt/i)).toBeInTheDocument();
    expect(screen.getByText(/data directory/i)).toBeInTheDocument();
    // The claim that has to be visible on the screen as well as true in the server: the value is
    // not in the log, so an operator who greps for it and finds nothing is not looking at a bug.
    expect(screen.getByText(/the token itself is not/i)).toBeInTheDocument();
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

    /*
      AND NOTHING UPSTREAM OF THAT CHECK REFUSES THE PRESS IN A REAL BROWSER, which is a separate
      claim and one jsdom cannot make: it performs no interactive validation, so every assertion
      above passed unchanged for as long as `minLength={12}` sat on this field and Chromium was
      answering the same press with a bubble of its own. Measured at 390px with the attribute in
      place: five characters produced no request, no `role="alert"` anywhere in the document, and
      `validationMessage` = "Please lengthen this text to 12 characters or more (you are currently
      using 5 characters)". The sentence this test asserts was unreachable by typing.

      Its absence is asserted rather than its effect, because the effect is exactly the thing this
      environment renders invisible. See the note at the field in `FirstRun.tsx` for why the
      product's rule and `minlength`'s rule are not the same rule.
    */
    expect(screen.getByLabelText(/^password$/i)).not.toHaveAttribute('minlength');
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
/*
 * THE LOOKUP ON THE SETUP SCREEN WAS TESTED HERE, IN TEN TESTS, AND THEY ARE GONE WITH IT
 * (2026-08-11). They covered the panel's presence, the setup token being sent as its credential
 * because there is no session yet, the starter profile written after the account, a licence class
 * the operator picked being recorded as the operator's rather than as callook's, the refusal to
 * swap in a record found under another callsign until the operator confirms, a typed callsign
 * stored with no lookup at all, no profile written when the box was empty, no invented
 * organization for a club station, and the "administrator created, profile did not save" screen.
 *
 * The owner asked for account creation to stop asking for a callsign. Not one of those properties
 * is wrong; they are properties of a control that is moving to the profile screen, where a sibling
 * change is taking them with it. Deleting them here rather than leaving them to fail is the honest
 * option, because the only thing they would be testing on this screen is markup that no longer
 * exists — and `stubFirstRun`, `PERSON_RECORD`, `CLUB_RECORD`, `putCalls` and `acceptLookup` go
 * with them for the same reason.
 *
 * WHAT IS NOT DELETED IS THE PROPERTY THEY EXISTED TO PROTECT: the administrator account must
 * never be held hostage to a second write. That is now true by construction — there is no second
 * write — which is why the "did not pretend setup failed when only the starter profile did" screen
 * and its `stranded` state went too.
 */

/**
 * THE THIRD SIGNED-OUT SCREEN, AND THE QUESTION THE GATE NO LONGER ASKS.
 *
 * It used to ask two: is this a fresh install, and does this deployment accept enrollment codes.
 * The second is gone with the codes — registration is open on every deployment, so the answer is a
 * constant and the four-state machine that carried it (unasked / open / closed / did-not-say) was
 * a way of being unsure about one.
 *
 * FOUR TESTS WENT WITH IT and are named here rather than left as a gap: "offers enrolment when the
 * deployment accepts codes", "leaves the offer standing when the question could not be answered",
 * "leaves the offer standing when the server answers without saying", and "takes the offer away
 * only on a definite no". The last of those pinned the ONLY behaviour that has actually changed —
 * there is no definite no any more — and the three before it are subsumed by the one below, which
 * asserts the stronger thing: the offer is there whatever the server says.
 */

/** One router, so each of the gate's questions is answered as its own endpoint. */
function stubGate(options: { required?: boolean } = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/auth/bootstrap-status') {
      return Promise.resolve(okResponse({ required: options.required ?? false }));
    }
    if (url === '/api/auth/enroll') {
      return Promise.resolve(
        okResponse({ user: { id: 'u-9', email: 'student@example.edu', role: 'member' } }, 201),
      );
    }
    return Promise.resolve(okResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function signUpLink(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: /create an account/i });
}

describe('the sign-up branch of the signed-out gate', () => {
  it('offers sign-up beside the sign-in form', async () => {
    stubGate();
    renderGate();

    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    expect(await signUpLink()).toBeInTheDocument();
  });

  /**
   * THE OFFER NO LONGER DEPENDS ON A SECOND REQUEST, so the gate must not make one. Asserted on
   * the calls rather than on the screen, because a request whose answer is ignored is invisible
   * from the outside and would come back the first time somebody re-added the state it fed.
   */
  it('asks nothing about enrollment codes, on any deployment', async () => {
    const fetchMock = stubGate();
    renderGate();

    await signUpLink();
    expect(fetchMock.mock.calls.map((call) => call[0])).not.toContain('/api/auth/enrollment-open');
  });

  it('offers no sign-up on a deployment with no accounts at all, because there is no form to put it on', async () => {
    // The setup screen is what a fresh install gets, and `POST /api/auth/enroll` refuses while it
    // does: until the administrator exists, nothing can create an account here.
    stubGate({ required: true });
    renderGate();

    await screen.findByRole('heading', { name: /set up grantspotter/i });
    expect(screen.queryByRole('button', { name: /create an account/i })).not.toBeInTheDocument();
  });

  /**
   * THE OFFER STANDS EVEN ON THE SCREEN THAT ADMITS IT COULD NOT CHECK. The two mistakes are not
   * symmetric: hiding the way in from somebody with no account strands them with nothing to do,
   * and showing it to somebody who has one costs a line they ignore.
   */
  it('offers sign-up even when the first-run check failed', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/auth/bootstrap-status') {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve(okResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderGate();

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not check/i);
    expect(await signUpLink()).toBeInTheDocument();
  });

  it('swaps the sign-in form for the sign-up form, and back again', async () => {
    stubGate();
    renderGate();

    await userEvent.click(await signUpLink());
    expect(await screen.findByRole('heading', { name: /create your account/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^sign in$/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /already have an account/i }));
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
  });

  it('lands a new member exactly where a sign-in lands them', async () => {
    stubGate();
    const onAuthenticated = vi.fn();
    renderGate(onAuthenticated);

    await userEvent.click(await signUpLink());
    await userEvent.type(screen.getByLabelText(/^email$/i), 'student@example.edu');
    await userEvent.type(screen.getByLabelText(/^password$/i), 'a-long-enough-password');
    await userEvent.click(screen.getByRole('button', { name: /create my account/i }));

    await waitFor(() => {
      expect(onAuthenticated).toHaveBeenCalled();
    });
  });

  /**
   * The gate has something to say when it could not check for a fresh install, and a trip to the
   * sign-up form and back must not lose it: the deployment is still in the state that made the
   * sentence true.
   */
  it('keeps the gate’s own notice through a visit to the sign-up form', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/auth/bootstrap-status') {
        return Promise.reject(new TypeError('Failed to fetch'));
      }
      return Promise.resolve(okResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    renderGate();

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not check/i);
    await userEvent.click(await signUpLink());
    await screen.findByRole('heading', { name: /create your account/i });
    await userEvent.click(screen.getByRole('button', { name: /already have an account/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not check/i);
  });
});
