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
    /*
      THE SERVER'S OWN SENTENCE, BECAUSE THERE IS MORE THAN ONE OF THEM AND THIS SCREEN CANNOT
      TELL WHICH IT IS HOLDING.

      This arm returned a hardcoded "That email or password was not recognised." until 2026-08-12.
      `POST /api/auth/login` answers `unauthorized` in two different states and only one of them is
      about the credentials: a wrong password ("Incorrect email or password.") and an account an
      administrator has switched off, which `api/auth.ts` gave a sentence of its own precisely
      because blaming the password there is false in the direction that costs the reader the most
      — this product has no reset mail, so it sends the one person who cannot fix anything to ask
      the same administrator who just switched them off. The browser overwrote both with the first.
      MEASURED in Chromium against the real server (`e2e/flow.spec.ts`, "a member an administrator
      switched off"): API 401 "That account has been switched off by an administrator …", screen
      "That email or password was not recognised."

      PRINTING THE SERVER'S SENTENCE RATHER THAN MATCHING FOR THE DISABLED ONE, which is where this
      differs from `Enroll.tsx`'s `/set up/i` test. There, two conditions share one status and the
      screen has something longer and kinder to say than the API does. Here the API's sentences are
      already written for this reader, and a screen that re-words them is a second place the copy
      has to be kept true — which is the defect, not a guard against it. The fallback below covers
      the only case that leaves nothing to print.
    */
    case 'unauthorized':
      return err.message.trim() === ''
        ? 'That email or password was not recognised.'
        : err.message;
    /*
      THE SERVER'S OWN SENTENCE, THEN THE SERVER'S OWN NUMBER — THE SAME ARM AS ABOVE, ONE SWITCH
      CASE LOWER, AND IT SHIPPED FOR A DAY AFTER THE ARM ABOVE WAS FIXED.

      This kept `retryAfterSec` and threw `err.message` away, so it rendered the SAME eight words
      whichever of the two rate-limited conditions on this route had happened. MEASURED against the
      built server on this host, 2026-08-12: 240 of 500 concurrent sign-ins were answered "This
      server is already doing as much password checking as it can right now. Nothing is wrong with
      your details, nothing has been used up, and nobody needs to do anything about it." — a
      statement about the server's CPU, carrying `retryAfterSec: 1` — and this screen rendered "Too
      many attempts. Try again in 1 second." to a member who had made exactly one. The other
      condition is the per-account bucket, whose sentence says whose attempts they may have been and
      that no account has been locked. Neither is "too many attempts" by this reader.

      The argument is the one the `unauthorized` arm above was corrected with and it is the same
      argument for the whole file: the API's sentences are written for this reader, and a screen
      that re-words them is a second place the copy has to be kept true. `Enroll.tsx` has done this
      since 2026-08-05; `lib/retryAfter.ts` is the shared half.

      THE NUMBER IS SAID EXACTLY ONCE, which is only true because `api/auth.ts` carries no duration
      in either sentence — both said one until this change, and "…nobody needs to do anything about
      it. Try again in 1 second." would be two statements of when from two sources, the defect this
      product has already paid for on the sign-up screen.
    */
    case 'rate_limited': {
      const wait = retryAfterSecOf(err.details);
      const suffix = wait === null ? '' : ` Try again in ${humanRetryAfter(wait)}.`;
      const said = err.message.trim();
      // The fallback says nothing about time when the server sent no number, by the rule
      // `lib/retryAfter.ts` states: a figure this screen invents is a figure nobody can keep.
      return said === '' ? `Too many sign-in attempts.${suffix}` : `${said}${suffix}`;
    }
    /*
      THIS SCREEN'S OWN SENTENCE, AND IT IS THE ONE ARM WHERE THAT IS STILL RIGHT — checked rather
      than assumed, because the two arms above were both corrected for doing it.

      The test is whether the server has a sentence written for this reader. For `unauthorized` and
      `rate_limited` it has several and only it knows which. Here it has exactly one and it is
      `api/errors.ts` turning a ZodError into "The request body is invalid.", MEASURED against the
      built server by POSTing `{}` to `/api/auth/login`. Printing that would tell somebody who left
      a box empty about a body they never knew they sent. There is no password floor on this route
      to state and no second condition hiding behind the status, so the specific sentence is this
      one, and it names the two things the form wants.
    */
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
   * Switch to the sign-up form.
   *
   * OPTIONAL, AND THE REASON HAS CHANGED. It used to be optional because WHETHER a deployment
   * accepted enrollment codes was a question only the server could answer (`GET
   * /api/auth/enrollment-open`), and a sign-in form offering a way in that did not exist was worse
   * than one offering none. Registration is open on every deployment now, so the gate always
   * passes this and the answer is never in doubt.
   *
   * It stays optional because one caller still needs it absent: the accessibility audit renders
   * this form on its own, and a prop that has to be threaded through every such render to say
   * something that is always true is ceremony. Absent now means "this render has nowhere to send
   * them", not "this deployment is closed".
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
          No account yet?{' '}
          <button type="button" className="btn" onClick={onEnrol}>
            Create an account
          </button>
        </p>
      )}
    </SignedOutPage>
  );
}
