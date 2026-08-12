import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, getBootstrapStatus, postBootstrap } from '../api/client.js';
import { MIN_PASSWORD_LENGTH, meetsPasswordFloor } from '../lib/passwordPolicy.js';
import { humanRetryAfter, retryAfterSecOf } from '../lib/retryAfter.js';
import { Enroll } from './Enroll.js';
import { Login, SignedOutPage } from './Login.js';
import '../components/signedOut.css';

/**
 * FIRST RUN, FROM A BROWSER.
 *
 * A fresh install has no accounts, so `GET /api/auth/bootstrap-status` answers
 * `{ required: true }` and `POST /api/auth/bootstrap` is the only way to create the first
 * administrator. Both endpoints shipped; nothing in the SPA called either, so the very
 * first screen a self-hoster saw was a sign-in form for an account that did not exist yet.
 * The only way past it was a hand-written curl, which is not a first run a club officer or
 * a faculty advisor can complete.
 *
 * `client.ts` had already declared `getBootstrapStatus` and `postBootstrap` — they were
 * dead code, called from nowhere. This file is their caller.
 */

/*
 * The password floor and its check now live in `lib/passwordPolicy.ts`. They were declared here
 * when this was the only screen where somebody chose their own password; enrolment is the second,
 * and two copies of the number would be two policies with one of them free to go stale.
 */

/**
 * What to tell the operator, per failure.
 *
 * Deliberately not one sentence for everything, for the same reason `Login.tsx` refuses to
 * be: on this screen the four failures have four different fixes, and three of them are not
 * the operator's mistake.
 */
function messageForBootstrap(err: unknown): string {
  if (!(err instanceof ApiError)) {
    return 'The GrantSpotter API could not be reached. Check that the server is running.';
  }
  switch (err.code) {
    case 'unauthorized':
      return (
        'That setup token was not accepted. Copy it from the server log printed at startup — ' +
        'a fresh token is issued on every restart until an administrator exists, so a token ' +
        'from an earlier run will not work.'
      );
    case 'conflict':
      return 'An administrator account already exists on this deployment.';
    case 'validation_failed':
    case 'bad_request':
      // The server's own words. For the password floor that is a plain sentence naming the
      // minimum; for a malformed email it is generic, which the field hints already cover.
      return err.message;
    /*
      THE SERVER'S SENTENCE AND THE SERVER'S NUMBER, ON A ROUTE THAT CANNOT PRODUCE EITHER TODAY.

      This arm returned a hardcoded "Too many attempts. Wait a minute and try again." until
      2026-08-12. `POST /api/auth/bootstrap` has no limiter and does not go through `hashUnderGate`
      — it calls `hashPassword` directly — so nothing on that route answers 429 and this branch has
      never executed. It is written the only way that could be true anyway, for two reasons.

      The first is that "wait a minute" is the exact sentence round one found on the sign-up screen
      over a fifteen-minute lockout, and dead copy is where a defect waits: the gate is one line
      away, this file would not be reopened when it lands, and the reader would be told sixty
      seconds over whatever the ladder actually decided.

      The second is that there is nothing to invent. `api/auth.ts`: "There is one number, it is
      `retryAfterSec`, and these sentences say what happened rather than when to come back."
      `lib/retryAfter.ts` returns `null` when no usable number arrived, and this then says nothing
      about time at all — which is the correct behaviour for a 429 from a route whose refusals
      nobody has written yet.
    */
    case 'rate_limited': {
      const wait = retryAfterSecOf(err.details);
      const suffix = wait === null ? '' : ` Try again in ${humanRetryAfter(wait)}.`;
      return `${err.message}${suffix}`;
    }
    default:
      /*
        "NO ADMINISTRATOR ACCOUNT WAS CREATED" IS GONE (2026-08-12), BECAUSE THIS SCREEN DOES NOT
        KNOW THAT, AND ON THIS ROUTE IT IS THE MOST EXPENSIVE THING IT COULD GET WRONG.

        `api/auth.ts`'s bootstrap handler runs `users.create(...)` and THEN `startSession(req, res,
        user.id)`. A fault in the second — a session write that fails, anything the error handler
        turns into `internal` — answers 500 with the administrator account already in the database
        and the one-time setup token already consumed. The operator was then told nothing had been
        created, retried, and got 409 "An administrator account already exists on this deployment"
        with a token that no longer works. The route's own comment explains at length why a
        rejected body must not spend the token; this sentence spent the operator's next attempt
        instead. It is round one's "No account has been created" over two hundred created rows,
        on the one screen where the reader cannot simply try again.

        What replaces it is a fact this screen can check and the reader can act on: whether setup
        is still being offered IS whether the account exists. `App.tsx` shows this page only while
        `GET /api/auth/bootstrap-status` answers `required: true`, and `users.create` is what makes
        it stop.
      */
      return err.status === 0
        ? 'The GrantSpotter API could not be reached. Check that the server is running.'
        : `Setup failed: the server answered ${String(err.status)}, which is a fault on the ` +
            'server rather than anything you can fix here. It did not say whether the ' +
            'administrator account was created, so reload this page before trying again: if ' +
            'setup is still being offered, it was not.';
  }
}

/*
 * The `FIELD` and `HINT` inline styles that used to sit here are gone, into
 * `components/signedOut.css`. `HINT` carried `marginTop: calc(-1 * var(--s-3))`, which is what put
 * every explanation 4px INSIDE the bottom edge of the input it explains, and `FIELD`'s
 * `marginBottom` was what it was cancelling. The spacing between a control and its own hint is now
 * one grid gap, stated once, next to the gap between fields it has to be smaller than.
 */

export interface FirstRunProps {
  /** Bootstrap signs the new administrator in, so this is the same callback a login uses. */
  onAuthenticated: () => void;
  /**
   * Someone else finished setup between the status check and this submit. The gate uses it
   * to fall back to the sign-in form, because there is now an account to sign in to and
   * this form can never succeed again.
   */
  onBootstrapClosed: () => void;
}

/*
 * THE CALLSIGN FIELD AND ITS LOOKUP PANEL WERE HERE AND ARE GONE (2026-08-11), along with the
 * starter profile this screen used to write and the `stranded` state that existed for the one case
 * where the account was created and that write then failed.
 *
 * The owner asked for account creation to stop asking for a callsign. The lookup is not deleted —
 * it moves to the profile screen, where the same panel fills the same fields for somebody who is
 * already signed in and can see what it did. Setup is the wrong place for it twice over: it made
 * the very first screen of the product a six-field form with a network call in the middle of it,
 * and it was the reason an unauthenticated caller holding the setup token could ask this server to
 * reach callook at all (`api/callsign.ts` still accepts that token; see the report).
 *
 * What this costs: the first screen after setup no longer knows anything about the operator. That
 * was the argument for having it here, and it is a smaller thing than it sounds — the profile
 * screen is one click away, it has the same lookup, and it can show what was filled in.
 */

export function FirstRun({ onAuthenticated, onBootstrapClosed }: FirstRunProps): JSX.Element {
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();

    // Checked here as well as on the server, and the order matters: this is the account
    // that cannot be recovered. There is no second administrator to reset it and no email
    // reset in this product, so a typo in a password nobody can read back locks the
    // deployment out of itself. The confirm field is the whole reason it is caught here.
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    if (!meetsPasswordFloor(password)) {
      setError(`Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await postBootstrap({
        token: token.trim(),
        email,
        password,
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
      });
      // Nothing runs between the account existing and the handover now. The starter-profile write
      // that used to sit here is gone with the callsign field, and with it the one state this
      // screen had for "the administrator exists but the second write failed" — a screen a person
      // could reach, and could do nothing about, and which cannot happen any more.
      onAuthenticated();
    } catch (err) {
      setError(messageForBootstrap(err));
      // A lost race is not a failure this form can retry — the account exists now. Hand
      // the page back to the gate so the operator is shown the sign-in form they actually
      // need, rather than a form that will answer 409 forever.
      if (err instanceof ApiError && err.code === 'conflict') onBootstrapClosed();
    } finally {
      setBusy(false);
    }
  }

  return (
    /*
      `prose`, not the sign-in box's width: five fields, two of which carry a paragraph explaining
      themselves. At the 380px this screen inherited from the sign-in form those paragraphs
      wrapped at 43 characters; see `components/signedOut.css` for the measure they are sized to
      now. It was six fields until the callsign went, which is a change of degree and not of kind:
      the token hint and the password hint are still paragraphs.
    */
    <SignedOutPage measure="prose">
      <h1>Set up GrantSpotter</h1>
      <p className="signed-out-lede">
        This deployment has no accounts yet. Create the first administrator to continue — until it
        exists, nobody can create any account here, and once it does, anybody can sign up.
      </p>

      <form
        className="signed-out-form"
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <div className="signed-out-field">
          <label htmlFor="first-run-token" className="eyebrow">
            Setup token
          </label>
          <input
            id="first-run-token"
            className="signed-out-code"
            type="text"
            autoComplete="off"
            spellCheck={false}
            required
            aria-describedby="first-run-token-hint"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {/*
            THE HINT MOVED WITH THE TOKEN. It used to say the token was printed in the log, which
            was true and is now the thing that was wrong with it: a secret in `docker logs` stays
            in `docker logs`. The server writes it to a file in its data directory instead, and
            says the exact path in the banner it still prints on startup — so this hint names the
            file and sends the operator to the log for the path rather than for the secret.
          */}
          <p id="first-run-token-hint" className="signed-out-hint">
            Written to <code>first-run-token.txt</code> in the server&rsquo;s data directory when it
            starts, readable only by the user the server runs as. Its full path is in the
            &ldquo;GrantSpotter first-run setup&rdquo; block in the startup log (<code>docker logs</code>{' '}
            for a container deployment); the token itself is not. A new one is issued on every
            restart until this form is completed, and the file is deleted the moment it is used.
          </p>
        </div>

        <div className="signed-out-field">
          <label htmlFor="first-run-email" className="eyebrow">
            Email
          </label>
          <input
            id="first-run-email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="signed-out-field">
          <label htmlFor="first-run-name" className="eyebrow">
            Display name (optional)
          </label>
          <input
            id="first-run-name"
            type="text"
            autoComplete="name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>

        <div className="signed-out-field">
          <label htmlFor="first-run-password" className="eyebrow">
            Password
          </label>
          {/*
            NO `minLength` ATTRIBUTE, AND THAT IS THE DECISION RATHER THAN AN OMISSION.

            It stated a DIFFERENT RULE from the one this product enforces. `minlength` counts
            characters; `meetsPasswordFloor` and the server's `assertPasswordPolicy` both count
            TRIMMED characters. Measured in Chromium at 390px with the attribute in place: a
            five-character password never reached `submit` at all — no request, no `role="alert"`,
            just the UA's own "Please lengthen this text to 12 characters or more (you are
            currently using 5 characters)" — while twelve spaces satisfied the attribute and was
            refused by the sentence below. The only input the browser let through was the one the
            two rules disagree about, so the product's own message rendered in exactly the case it
            was not written for and never in the case it was.

            One rule, then, stated once in the hint and enforced by one predicate in the browser
            and the same one on the server. `required` stays: a field left blank is a different
            failure, it is how every other field on this form already behaves, and this screen has
            no sentence of its own for it to displace.
          */}
          <input
            id="first-run-password"
            type="password"
            autoComplete="new-password"
            required
            aria-describedby="first-run-password-hint"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {/*
            Stated before the operator submits, not after they are refused. The rule is
            cheap to satisfy and expensive to discover by rejection, and this is the one
            account in the product with no way back if it is lost.
          */}
          <p id="first-run-password-hint" className="signed-out-hint">
            At least {MIN_PASSWORD_LENGTH} characters. There is no password reset for the first
            administrator — store it somewhere you can find it again.
          </p>
        </div>

        <div className="signed-out-field">
          <label htmlFor="first-run-confirm" className="eyebrow">
            Confirm password
          </label>
          <input
            id="first-run-confirm"
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {error !== null && (
          <p role="alert" className="signed-out-alert">
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Creating administrator…' : 'Create administrator'}
        </button>
      </form>
    </SignedOutPage>
  );
}

/**
 * Which screen an unauthenticated visitor gets.
 *
 * Four states, because a self-hoster meets all of them and only one is the ordinary one. The
 * check is a request, so it can be in flight, and it can fail — a server that is still opening its
 * database answers nothing at all, and guessing in that moment is how a screen ends up lying:
 * offering setup on a deployment that has accounts, or a sign-in form on one that has none.
 */
type Gate =
  | { kind: 'checking' }
  | { kind: 'first-run' }
  /** `notice` is null for the ordinary case: accounts exist, nothing to explain. */
  | { kind: 'sign-in'; notice: string | null }
  /**
   * Signing up. It carries the sign-in notice it interrupted so that going back does not
   * silently drop something the gate had to say — "we could not check", most of all.
   */
  | { kind: 'enrol'; notice: string | null };

/*
 * `EnrolmentOffer` WAS HERE AND IS GONE (2026-08-11), along with the second request that answered
 * it. It was a four-state answer — unasked, open, closed, did-not-say — to "does this deployment
 * accept enrollment codes", because a sign-in form that offers a way in which does not exist is
 * worse than one that offers none.
 *
 * Registration is open on every deployment now, so the question has one answer and the state
 * machine that carried it was a way of being unsure about a constant. The sign-up link is
 * unconditional. What that costs, stated: a visitor to a deployment whose first administrator does
 * not exist yet would be offered sign-up — except that they never see the sign-in form at all,
 * because `bootstrap-status` sends them to the setup screen, and the one moment where both could
 * be true (setup finished in another tab between the two renders) ends in the server's own
 * "not set up yet" sentence, which `Enroll.tsx` renders in full.
 */

export function SignedOut({ onAuthenticated }: { onAuthenticated: () => void }): JSX.Element {
  const [gate, setGate] = useState<Gate>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);

  const recheck = useCallback(() => {
    setGate({ kind: 'checking' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getBootstrapStatus()
      .then((status) => {
        if (cancelled) return;
        // A deployment with no accounts cannot create one except through the setup form, which is
        // the whole of the first-run design: `POST /api/auth/enroll` refuses while
        // `bootstrap-status` says `required`, so there is no second door to offer here.
        setGate(status.required ? { kind: 'first-run' } : { kind: 'sign-in', notice: null });
      })
      .catch(() => {
        if (cancelled) return;
        // WE DO NOT KNOW, AND THE SCREEN MUST NOT PRETEND TO.
        //
        // The sign-in form is the right thing to show — an operator whose deployment is
        // already set up can still use it, and offering to create an administrator on a
        // deployment that may already have one invites a 409 the operator cannot read as
        // anything but a bug. But it is shown WITH the failure stated, because a bare
        // sign-in form here is precisely the misleading screen this whole change exists
        // to remove: on a fresh install it silently asks for an account that does not
        // exist. Saying "we could not check" costs an existing operator one sentence and
        // saves a new one the curl.
        setGate({
          kind: 'sign-in',
          notice:
            'Could not check whether this deployment has been set up yet — the server may ' +
            'still be starting. If this is a fresh install, retry to reach the setup screen.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (gate.kind === 'checking') {
    // Matches `Authenticated()`'s own loading line: no form is drawn until it is known
    // which form is the true one, so neither can flash in front of the wrong operator.
    return <p className="eyebrow">Checking whether this deployment has been set up…</p>;
  }

  if (gate.kind === 'first-run') {
    return (
      <FirstRun
        onAuthenticated={onAuthenticated}
        onBootstrapClosed={() => {
          setGate({
            kind: 'sign-in',
            notice:
              'Someone finished setting up this deployment first, so the administrator ' +
              'account already exists. Sign in with it below.',
          });
        }}
      />
    );
  }

  const { notice } = gate;

  if (gate.kind === 'enrol') {
    return (
      <Enroll
        onAuthenticated={onAuthenticated}
        onCancel={() => setGate({ kind: 'sign-in', notice })}
      />
    );
  }

  return (
    <Login
      onAuthenticated={onAuthenticated}
      notice={
        notice === null ? undefined : (
          <p role="alert" className="signed-out-notice">
            {notice}{' '}
            <button type="button" className="btn" onClick={recheck}>
              Retry
            </button>
          </p>
        )
      }
      // Unconditional: there is nothing left to be unsure about. Even on the one screen that
      // admits it could not reach the server, the offer stands — the person who needs it is
      // somebody with no account, and sending them nowhere is the worse of the two mistakes.
      onEnrol={() => setGate({ kind: 'enrol', notice })}
    />
  );
}
