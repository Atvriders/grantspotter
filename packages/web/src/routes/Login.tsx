import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { apiSend, ApiError } from '../api/client.js';
import { humanRetryAfter, retryAfterSecOf } from '../lib/retryAfter.js';
import '../components/signedOut.css';

/**
 * How wide this screen's panel may get.
 *
 * A property of the SCREEN'S CONTENTS, which is why the wrapper cannot decide it: the three
 * screens sharing this landmark are three different objects. `compact` is the sign-in box — two
 * labelled fields, no prose, nothing on it that has to be read a line at a time. `prose` is a form
 * whose fields each carry a paragraph of explanation, and its width is derived from the measure
 * that text wants. `components/signedOut.css` states both numbers and the derivation.
 *
 * One inline `maxWidth: 380` on the element below used to answer for all three, which is how a
 * six-field setup form full of help text came to render at 43 characters a line.
 */
export type SignedOutMeasure = 'compact' | 'prose';

/**
 * The signed-out page's ONE `main` landmark.
 *
 * `App.tsx` returns this page INSTEAD of `AppShell` when there is no session, so nothing
 * else on screen owns a `main` — which is why `AppShell.test.tsx` names `routes/Login.tsx`
 * in `MAY_RENDER_MAIN`. The first-run screen is the same page in a different mode, so it
 * composes this wrapper rather than opening a second landmark: a `<main>` of its own would
 * be a nested landmark on the composed page and would put a third entry on that allowlist,
 * which that test's comment asks be a deliberate decision. Keeping the element here means
 * the signed-out tree has exactly one, in exactly one file, whichever form is showing.
 */
export function SignedOutPage({
  children,
  measure = 'compact',
}: {
  children: ReactNode;
  measure?: SignedOutMeasure;
}): JSX.Element {
  return (
    <main id="main" className={`card signed-out signed-out-${measure}`}>
      <p className="eyebrow">GrantSpotter</p>
      {children}
    </main>
  );
}

/**
 * What to tell the user, per failure. Deliberately NOT one sentence for
 * everything: "that email or password was not recognised" is a statement about
 * the user's credentials, and saying it when the request never reached the
 * server sends them off to reset a password that was never wrong.
 */
function messageFor(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return 'The GrantSpotter API could not be reached. Check that the server is running.';
  }
  switch (err.code) {
    case 'unauthorized':
      return 'That email or password was not recognised.';
    /*
      The server sends `details.retryAfterSec` with this and this screen used to throw it away,
      printing "wait a minute" for a pause the server had already said was fifteen. The same
      correction as `Enroll.tsx`, from the same helper; see `lib/retryAfter.ts`.
    */
    case 'rate_limited': {
      const wait = retryAfterSecOf(err.details);
      return wait === null
        ? 'Too many attempts. Wait a minute and try again.'
        : `Too many attempts. Try again in ${humanRetryAfter(wait)}.`;
    }
    case 'validation_failed':
    case 'bad_request':
      return 'Enter an email address and the password for that account.';
    default:
      // status 0 is `apiFetch` never getting an answer; anything else is a
      // server fault, and neither is the credentials' fault.
      return err.status === 0
        ? 'The GrantSpotter API could not be reached. Check that the server is running.'
        : `Sign-in failed: the server answered ${err.status}. It could not be reached for a verdict on these credentials.`;
  }
}

export function Login({
  onAuthenticated,
  notice,
  onEnrol,
}: {
  onAuthenticated: () => void;
  /**
   * Something the signed-out gate needs to say ABOVE the form — that the first-run
   * check could not be made, or that another operator finished setup first. It is
   * rendered inside this page's one landmark rather than beside it so the page keeps
   * a single `main`, and it is a prop rather than state because the fact belongs to
   * whoever chose to show this form, not to the form.
   */
  notice?: ReactNode;
  /**
   * Switch to the enrolment form. Optional, and absent is meaningful: WHETHER a deployment
   * accepts enrollment codes is a question only the server can answer (`GET
   * /api/auth/enrollment-open`), the gate is what asks it, and a sign-in form that offers a
   * way in that does not exist is worse than one that offers none.
   */
  onEnrol?: () => void;
}): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiSend('POST', '/api/auth/login', { email, password });
      onAuthenticated();
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SignedOutPage>
      <h1>Sign in</h1>
      {notice}

      <form
        className="signed-out-form"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <div className="signed-out-field">
          <label htmlFor="login-email" className="eyebrow">
            Email
          </label>
          <input
            id="login-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="signed-out-field">
          <label htmlFor="login-password" className="eyebrow">
            Password
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        {error !== null && (
          <p role="alert" className="signed-out-alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {/*
        OUTSIDE the form, so pressing Enter in the password field still signs in rather than
        landing on a second submit. It is a button and not a link because there is no second
        address to go to: the signed-out gate swaps which form it is showing.
      */}
      {onEnrol !== undefined && (
        <p className="signed-out-aside">
          Been given an enrollment code?{' '}
          <button type="button" className="btn" onClick={onEnrol}>
            I have an enrollment code
          </button>
        </p>
      )}
    </SignedOutPage>
  );
}
