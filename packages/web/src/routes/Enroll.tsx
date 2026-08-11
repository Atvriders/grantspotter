import { useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError } from '../api/client.js';
import { postEnroll } from '../api/enrollment.js';
import { MIN_PASSWORD_LENGTH, meetsPasswordFloor } from '../lib/passwordPolicy.js';
import { humanRetryAfter, retryAfterSecOf } from '../lib/retryAfter.js';
import { SignedOutPage } from './Login.js';
import '../components/signedOut.css';

/**
 * ENROLMENT, FROM A BROWSER.
 *
 * The third signed-out screen. First-run setup creates the one administrator a deployment starts
 * with; the sign-in form serves everybody who already has an account; this serves the person a
 * club officer handed a code to. It composes `SignedOutPage` for the same reason `FirstRun` does —
 * the signed-out tree has exactly one `main`, whichever of the three forms is showing.
 */

/*
 * This file's copies of `FIELD` and `HINT` are gone with `FirstRun.tsx`'s, into
 * `components/signedOut.css`. They were duplicated here because the two forms are the same shape,
 * which is exactly why neither could be corrected on its own: see the note in `FirstRun.tsx`.
 */

/**
 * The states a code can be refused in, when the server names one in `AppError.details.reason`.
 *
 * IT DOES NOT TODAY. `POST /api/auth/enroll` answers an unknown code with `unauthorized`, and an
 * expired, revoked or used-up one with `forbidden` plus a sentence naming which — and no
 * `details`. So the branch below that quotes `err.message` is the live path for those three, and
 * it is specific and blameless because the server's three sentences are specific and blameless.
 *
 * This mapping exists because the nine API error codes cannot tell those three apart — all of
 * them are `forbidden` — so a screen that wants to say anything OF ITS OWN about which state a
 * code is in has exactly one place to read it from, and `details.reason` is that place. Until the
 * server sends one, the person still gets a specific answer; once it does, the browser owns the
 * words rather than borrowing them.
 *
 * `unknown_code` is listed for completeness and is answered with exactly the same sentence as a
 * bare 401: an unknown code and a wrong one are the same event, and this screen must not become a
 * way to find out which codes exist.
 */
const REFUSALS = ['expired', 'revoked', 'exhausted', 'email_taken', 'unknown_code'] as const;
type Refusal = (typeof REFUSALS)[number];

function refusalOf(details: unknown): Refusal | null {
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  if (typeof reason !== 'string') return null;
  return (REFUSALS as readonly string[]).includes(reason) ? (reason as Refusal) : null;
}

/**
 * A code that was not accepted, with no hint about whether it ever existed.
 *
 * This is the answer for an unknown code AND for a mistyped real one, deliberately: a code is
 * guessable only by trying, and a screen that says "no such code" for one and something else for
 * the other turns the guessing into a search. What it can honestly do is name the mistakes a
 * person actually makes with a copied secret.
 */
const NOT_ACCEPTED =
  'That enrollment code was not accepted. Check it against the one you were sent — a single ' +
  'missing or swapped character is enough — and ask whoever gave it to you if it still will not ' +
  'work.';

/**
 * The one failure on this screen that is about the person's email rather than their code, and the
 * only meaning a 409 has here: `POST /api/auth/enroll` raises exactly one conflict, and the
 * contract names no other. Reading it off the code rather than waiting for `details.reason` is
 * what lets this sentence — the one that says where to go instead — be said today.
 */
const EMAIL_TAKEN =
  'There is already an account for that email address, so nothing was created. Sign in with it ' +
  'instead, or enrol with a different address.';

/**
 * What to tell the person, per failure.
 *
 * Deliberately not one sentence for everything, for the same reason `Login.tsx` and
 * `FirstRun.tsx` refuse to be — and here the distinction carries more than tone. Three of these
 * failures are STATES OF THE CODE, which the holder cannot see, did not cause and cannot fix from
 * this screen; telling them "something went wrong" would send them back to re-typing a code that
 * was correct every time. The copy for those says whose problem it is and where to go next.
 */
function messageForEnroll(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return (
      'GrantSpotter could not be reached, so this browser never got an answer. Wait a moment and ' +
      'try again — and if the account was created after all, signing in with this email and ' +
      'password will work.'
    );
  }

  switch (refusalOf(err.details)) {
    case 'expired':
      return (
        'That enrollment code has expired, so it can no longer create an account. Nothing you ' +
        'typed is wrong, and there is no way to renew it from this screen — ask whoever gave you ' +
        'the code for a new one.'
      );
    case 'revoked':
      return (
        'That enrollment code has been withdrawn by an administrator, so it can no longer create ' +
        'an account. That is not something you did — ask whoever gave you the code for a new one.'
      );
    case 'exhausted':
      return (
        'That enrollment code has already been used as many times as it allows. That is not ' +
        'something you did — ask whoever gave you the code for one of your own.'
      );
    case 'email_taken':
      return EMAIL_TAKEN;
    case 'unknown_code':
      return NOT_ACCEPTED;
    case null:
      break;
  }

  switch (err.code) {
    // 404 is folded in on purpose: "no such code" and "wrong code" have to read identically.
    case 'unauthorized':
    case 'not_found':
      return NOT_ACCEPTED;
    case 'conflict':
      return EMAIL_TAKEN;
    /*
      THE SERVER'S OWN SENTENCE, for the three codes where it is the specific one.

      `forbidden` is a code this deployment really issued, refused for a state the server named in
      words but not in `details` — which is what it does today, with one distinct sentence for
      expired, revoked and used-up. `validation_failed` and `bad_request` are the password floor (a
      plain sentence naming the minimum) and a malformed email (generic, which the field hints
      already cover). Replacing any of them with an apology of our own is how a refusal becomes a
      mystery; `routes/Admin.tsx` takes the same line with `ApiError.message` for the last-admin
      refusal.
    */
    case 'forbidden':
    case 'validation_failed':
    case 'bad_request':
      return err.message;
    /*
      THE SERVER'S OWN NUMBER, AND ONLY WHEN IT SENT ONE.

      This branch used to read "Too many attempts. Wait a minute and try again." for every
      `rate_limited` answer, while `apiFetch` had already parsed `details.retryAfterSec` and handed
      it over. Three conditions read as one sentence and two of them were false: a per-code pause
      answered 900 seconds and a queue answered 1, and the screen said sixty to all of them.

      There is now one rate-limited condition on this route — too many wrong CODES from this
      connection — and it is the only one, because nothing else here refuses anybody: the per-code
      conflict budget makes the answer vaguer instead of stopping the enrolment, and the hash gate
      queues. So this says what it is, whose fault it is not, and how long the server said.
    */
    case 'rate_limited': {
      const wait = retryAfterSecOf(err.details);
      const opening =
        'Too many attempts from this connection. Nothing is wrong with your code or your details, ' +
        'and no other club is affected.';
      return wait === null
        ? `${opening} Wait a little and try again.`
        : `${opening} Try again in ${humanRetryAfter(wait)}.`;
    }
    default:
      return err.status === 0
        ? 'The GrantSpotter API could not be reached, so nothing was sent.'
        : `Enrolment failed: the server answered ${String(err.status)}, which is a fault on the ` +
            'server rather than anything you can fix here. Try again in a moment, or ask whoever ' +
            'gave you the code.';
  }
}

export interface EnrollProps {
  /** Enrolment signs the new member in, so this is the same callback a login uses. */
  onAuthenticated: () => void;
  /** Back to the sign-in form, for somebody who followed this link and already has an account. */
  onCancel: () => void;
}

export function Enroll({ onAuthenticated, onCancel }: EnrollProps): JSX.Element {
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    /*
      ONE PRESS, ONE REDEMPTION.

      The button is disabled while a request is in flight, and this line refuses the submit as
      well, because a form can be submitted by the Enter key while the pointer is nowhere near the
      button. A single-use code redeemed twice is the server's problem to make atomic — and it
      does — but a screen that fires two POSTs from one intent is how a person ends up reading
      "already used as many times as it allows" about a code they used exactly once.
    */
    if (busy) return;

    // Checked here as well as on the server: the floor is stated above this field before anything
    // is typed, and a round trip that can only answer with the rule we already printed spends one
    // of the attempts the rate limiter allows.
    if (!meetsPasswordFloor(password)) {
      setError(`Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await postEnroll({
        // Trimmed because this value is always pasted, and a trailing newline out of a chat
        // message or an email is not a different code.
        code: code.trim(),
        email,
        password,
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
      });
      onAuthenticated();
    } catch (err) {
      setError(messageForEnroll(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    // `prose` for the same reason the setup screen takes it: four fields, two of them explained in
    // a paragraph, under a lead paragraph of three sentences. The sign-in box's width is for the
    // screen that has none of that.
    <SignedOutPage measure="prose">
      <h1>Create your account</h1>
      <p className="signed-out-lede">
        An enrollment code from a club officer, an advisor or an administrator creates your own
        member account. It gives you the same account an admin would have made for you — browsing,
        matching, watchlists, exports and the review queue — and never administrator access.
      </p>

      <form
        className="signed-out-form"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <div className="signed-out-field">
          <label htmlFor="enrol-code" className="eyebrow">
            Enrollment code
          </label>
          <input
            id="enrol-code"
            className="signed-out-code"
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            aria-describedby="enrol-code-hint"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <p id="enrol-code-hint" className="signed-out-hint">
            Paste it exactly as you were given it. GrantSpotter stores only a hash of a code, so
            nobody — including an administrator — can read yours back to you if it goes missing.
          </p>
        </div>

        <div className="signed-out-field">
          <label htmlFor="enrol-email" className="eyebrow">
            Email
          </label>
          <input
            id="enrol-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="signed-out-field">
          <label htmlFor="enrol-name" className="eyebrow">
            Display name (optional)
          </label>
          <input
            id="enrol-name"
            type="text"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="signed-out-field">
          <label htmlFor="enrol-password" className="eyebrow">
            Password
          </label>
          <input
            id="enrol-password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_PASSWORD_LENGTH}
            aria-describedby="enrol-password-hint"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {/*
            Stated before the form is submitted, not after it is refused. The rule is cheap to
            satisfy and expensive to discover by rejection, and here a rejection also spends an
            attempt against the rate limiter that protects the code.
          */}
          <p id="enrol-password-hint" className="signed-out-hint">
            At least {MIN_PASSWORD_LENGTH} characters, and yours to choose. GrantSpotter sends no
            password-reset email: a forgotten password has to be reset by an administrator.
          </p>
        </div>

        {error !== null && (
          <p role="alert" className="signed-out-alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating your account…' : 'Create my account'}
        </button>
      </form>

      <p className="signed-out-aside">
        <button type="button" className="btn" onClick={onCancel}>
          I already have an account
        </button>
      </p>
    </SignedOutPage>
  );
}
