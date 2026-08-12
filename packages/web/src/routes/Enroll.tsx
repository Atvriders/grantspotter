import { useState } from 'react';
import type { FormEvent } from 'react';
import { apiSend, ApiError } from '../api/client.js';
import type { SessionUser } from '../store/session.js';
import { MIN_PASSWORD_LENGTH, meetsPasswordFloor } from '../lib/passwordPolicy.js';
import { humanRetryAfter, retryAfterSecOf } from '../lib/retryAfter.js';
import { SignedOutPage } from './Login.js';
import '../components/signedOut.css';

/**
 * SIGNING UP, FROM A BROWSER.
 *
 * The third signed-out screen. First-run setup creates the one administrator a deployment starts
 * with; the sign-in form serves everybody who already has an account; this serves everybody else.
 * It composes `SignedOutPage` for the same reason `FirstRun` does — the signed-out tree has exactly
 * one `main`, whichever of the three forms is showing.
 *
 * WHAT THIS SCREEN LOST ON 2026-08-11, and it is most of it. It used to open with an enrollment
 * code: a field, a paragraph explaining that GrantSpotter stores only a hash of one, and five
 * distinct refusals for the states a code can be in (unknown, mistyped, expired, revoked, used up)
 * — none of which the person reading them had caused or could fix. All of that is gone with the
 * code itself. What is left is an email, a password and a display name, which is the smallest thing
 * that can create an account, and the only failure this form has left that is really the person's
 * own is a password below the floor.
 */

/*
 * `postEnroll` USED TO LIVE IN `api/enrollment.ts` AND THAT FILE IS GONE — it was the browser half
 * of the enrollment-code feature (issuing, listing, revoking, and the redemption call), deleted
 * whole. What is left of it here is one `apiSend`, in the file that makes the request, which is
 * what `Login.tsx` two files over has always done for sign-in. A one-line wrapper in a shared
 * module would be the same call with a second place to look for it.
 */
interface RegistrationBody {
  email: string;
  password: string;
  displayName?: string;
}

async function postRegistration(body: RegistrationBody): Promise<{ user: SessionUser }> {
  return apiSend<{ user: SessionUser }>('POST', '/api/auth/enroll', body);
}

/**
 * The one failure on this screen that is about somebody else's account rather than this person's
 * typing, and the only meaning a 409 has here for a form that has filled in an address.
 *
 * The server says the same thing and names the address; this is what the browser says when it
 * would rather not repeat a value back into the DOM. Both end with the instruction that matters,
 * because the person reading it is usually somebody who signed up last term and forgot.
 */
const EMAIL_TAKEN =
  'There is already an account for that email address, so nothing was created. Sign in with it ' +
  'instead, or sign up with a different address.';

/**
 * A deployment nobody has finished setting up. `POST /api/auth/enroll` answers 409 for this as well
 * as for a taken address, and the two have to be told apart because the advice is opposite: one
 * says "sign in instead", and saying that to somebody looking at a deployment with NO accounts
 * would send them to a form that cannot work.
 *
 * They are separated on the server's own sentence rather than on a `details.reason`, because the
 * server does not send one — see `messageForEnroll`. The word matched is "set up", which is in the
 * server's sentence and could not be in the other one.
 */
const NOT_SET_UP =
  'This GrantSpotter has not been set up yet, so it cannot create accounts. Whoever runs it has ' +
  'to create the administrator account first — after that, anybody can sign up here.';

/**
 * What to tell the person, per failure.
 *
 * Deliberately not one sentence for everything, for the same reason `Login.tsx` and `FirstRun.tsx`
 * refuse to be. Three of the five branches that used to be here were STATES OF A CODE, which its
 * holder could not see, did not cause and could not fix from this screen; with the code gone, so
 * are they, and what is left divides into "your details" (the password floor), "somebody else's
 * account" (the address), "this deployment" (not set up, too busy) and "the network".
 */
function messageForEnroll(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return (
      'GrantSpotter could not be reached, so this browser never got an answer. Wait a moment and ' +
      'try again — and if the account was created after all, signing in with this email and ' +
      'password will work.'
    );
  }

  switch (err.code) {
    case 'conflict':
      // Two conditions, one status. The server's own sentence is the thing that distinguishes
      // them, and it is matched rather than parroted: the "not set up" case is about the
      // deployment and belongs in this screen's own words, which can be longer and kinder than an
      // API message.
      return /set up/i.test(err.message) ? NOT_SET_UP : EMAIL_TAKEN;
    /*
      THE SERVER'S OWN SENTENCE, for the codes where it is the specific one. `validation_failed`
      and `bad_request` are the password floor (a plain sentence naming the minimum) and a
      malformed email (generic, which the field hints already cover). Replacing either with an
      apology of our own is how a refusal becomes a mystery; `routes/Admin.tsx` takes the same line
      with `ApiError.message` for the last-admin refusal.
    */
    case 'validation_failed':
    case 'bad_request':
      return err.message;
    /*
      THE SERVER'S OWN SENTENCE, THEN THE SERVER'S OWN NUMBER, AND THE NUMBER IS SAID EXACTLY ONCE.

      There are two rate-limited conditions on this route and they mean different things: the
      registration ladder (too many accounts created from this connection, this network, or this
      server, in the last fifteen minutes) and the hash queue shedding a request (the server is
      doing as much password work as it can this second, retry-after 1). Both are answered with the
      server's own sentence, because the server is the only party that knows which one happened and
      its sentences already say so — and both are followed by the wait it actually stated, instead
      of the flat "wait a minute" this screen used to print over a fifteen-minute pause.

      THE CONCATENATION IS ONLY HONEST BECAUSE THE OTHER HALF STOPPED SAYING WHEN, and that half was
      wrong for a day. `api/auth.ts` used to end its refusals with "wait a moment and try again" or
      "wait a few minutes and try again", so this line produced, MEASURED against the built server
      with 130 students behind one campus NAT: "… so it is not starting another one this second.
      Nothing is wrong with your details — wait a moment and try again. … Try again in 15 minutes."
      One paragraph, two durations, from two sources, disagreeing by three orders of magnitude. The
      server's sentences carry no duration at all now (`registrationRefusal`); `retryAfterSec` is
      the one statement of when, and this is the one place it is rendered.

      What this branch adds is the thing neither sentence can say from the server side: somebody
      who ALREADY has an account is not affected by any of it, and can sign in right now.
    */
    case 'rate_limited': {
      const wait = retryAfterSecOf(err.details);
      const suffix = wait === null ? '' : ` Try again in ${humanRetryAfter(wait)}.`;
      return `${err.message}${suffix}`;
    }
    default:
      return err.status === 0
        ? 'The GrantSpotter API could not be reached, so nothing was sent.'
        : `Sign-up failed: the server answered ${String(err.status)}, which is a fault on the ` +
            'server rather than anything you can fix here. Try again in a moment.';
  }
}

export interface EnrollProps {
  /** Signing up signs the new member in, so this is the same callback a login uses. */
  onAuthenticated: () => void;
  /** Back to the sign-in form, for somebody who came here and already has an account. */
  onCancel: () => void;
}

export function Enroll({ onAuthenticated, onCancel }: EnrollProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    /*
      ONE PRESS, ONE ACCOUNT.

      The button is disabled while a request is in flight, and this line refuses the submit as
      well, because a form can be submitted by the Enter key while the pointer is nowhere near the
      button. Two POSTs from one intent is how a person ends up reading "there is already an
      account for that email address" about the account they are in the middle of creating.

      IT DOES NOT COST THEM A PLACE IN THE REGISTRATION LADDER, AND THIS COMMENT SAID IT DID until
      2026-08-12 ("now that every attempt is charged to the registration ladder, it is also how they
      spend two of their own places instead of one"). The server charges that budget when
      `users.create` returns and at no other moment, so a duplicate POST that loses the race, or is
      answered "already has an account", leaves no mark on it. The reason above is the whole reason:
      the second POST buys a confusing sentence, not a smaller allowance.
    */
    if (busy) return;

    // Checked here as well as on the server: the floor is stated above this field before anything
    // is typed, and a round trip that can only answer with the rule we already printed is a
    // pointless wait for the person. (It is only that. It costs them nothing in the registration
    // ladder — the server charges that when an account is created and at no other moment, and the
    // 422 is refused before any hash runs — and this comment claimed otherwise until 2026-08-12.)
    if (!meetsPasswordFloor(password)) {
      setError(`Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await postRegistration({
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
    // `prose` for the same reason the setup screen takes it: a lead paragraph of two sentences and
    // a field that carries a paragraph of its own. The sign-in box's width is for the screen that
    // has none of that.
    <SignedOutPage measure="prose">
      <h1>Create your account</h1>
      <p className="signed-out-lede">
        Anybody can create an account on this GrantSpotter — you do not need an invitation or a code
        from anybody. It is a member account: browsing, matching, watchlists, exports and the review
        queue, and never administrator access.
      </p>

      <form
        className="signed-out-form"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
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
          {/*
            No `minLength`, for the reason `FirstRun.tsx` sets out at the same field: the attribute
            counts characters and this product counts trimmed ones, so it refused — in the browser's
            words, not ours — every password the two rules agree about and passed the one they do
            not. Here it also hid the sentence that says a forgotten password needs an administrator.
          */}
          <input
            id="enrol-password"
            type="password"
            autoComplete="new-password"
            required
            aria-describedby="enrol-password-hint"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {/*
            Stated before the form is submitted, not after it is refused. The rule is cheap to
            satisfy and expensive to discover by rejection.
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
