import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { apiSend, ApiError, getBootstrapStatus, postBootstrap } from '../api/client.js';
import { CallsignLookup } from '../components/CallsignLookup.js';
import { fillFromLookup, type AcceptedCallsign } from '../lib/callsignFill.js';
import { Login, SignedOutPage } from './Login.js';

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

/**
 * Mirrors `MIN_PASSWORD_LENGTH` in `packages/server/src/auth/password.ts`, which is the
 * source of truth and the only thing that can actually refuse a password. Restated rather
 * than imported because the import direction is one-way — web may import from core, never
 * from server — the same reason `client.ts` restates the API error codes. The server-side
 * test `api/auth.test.ts` asserts the refusal message names this number, so a change there
 * that this file missed shows up as a screen promising one rule and a server enforcing
 * another, rather than silently.
 */
const MIN_PASSWORD_LENGTH = 12;

/** Trimmed, because `assertPasswordPolicy` trims before it counts. Twelve spaces is not a password. */
function meetsFloor(password: string): boolean {
  return password.trim().length >= MIN_PASSWORD_LENGTH;
}

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
    case 'rate_limited':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return err.status === 0
        ? 'The GrantSpotter API could not be reached. Check that the server is running.'
        : `Setup failed: the server answered ${err.status}. No administrator account was created.`;
  }
}

const FIELD: React.CSSProperties = {
  width: '100%',
  marginBottom: 'var(--s-4)',
  padding: 'var(--s-2)',
};

const HINT: React.CSSProperties = {
  marginTop: 'calc(-1 * var(--s-3))',
  marginBottom: 'var(--s-4)',
  fontSize: '0.85em',
  color: 'var(--ink-2)',
};

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

export function FirstRun({ onAuthenticated, onBootstrapClosed }: FirstRunProps): JSX.Element {
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [callsign, setCallsign] = useState('');
  const [accepted, setAccepted] = useState<AcceptedCallsign | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * The administrator exists and this browser is signed in, but the starter profile did not
   * save. There is no retry that helps here — bootstrap answers 409 from now on — so the
   * form is replaced by the truth and a way onwards, rather than a form that can only fail.
   */
  const [stranded, setStranded] = useState<string | null>(null);

  /**
   * The starter profile, written AFTER the account exists because that is the first moment
   * there is a session to write it with. It carries only what the profile actually stores:
   * a callsign, a state and — when the record's operator class maps exactly onto one of
   * GrantSpotter's four — a licence class. No street address, and never `licensedSince`.
   *
   * A club station is deliberately NOT written. Club details belong on the organization
   * profile, which cannot be stored without an entity type, and this screen does not ask for
   * one; inventing an entity to make the write succeed is exactly the kind of guess this
   * product refuses. The lookup panel says so before the account is created.
   */
  async function saveStarterProfile(): Promise<void> {
    if (accepted !== null && accepted.type === 'CLUB') return;
    const typed = callsign.trim().toUpperCase();
    if (typed === '') return;

    // WHICH values are recorded as fetched is `fillFromLookup`'s decision, not this screen's, so
    // the setup screen and the profile editor cannot disagree about it — and neither can disagree
    // with core's schema, which the registry behind it is asserted against. It marks only the
    // values the SOURCE stated: a licence class the operator picked for a legacy record is theirs,
    // and so is the callsign they typed. A callsign the lookup ANSWERED with — callook returns the
    // licensee's current record for a superseded call — is the source's, and is marked as such.
    const fill = accepted === null ? null : fillFromLookup(accepted, 'student');
    const fieldSources = fill?.fieldSources ?? {};

    await apiSend('PUT', '/api/profiles/student', {
      kind: 'student',
      callsign: typed,
      ...fill?.values,
      ...(Object.keys(fieldSources).length === 0 ? {} : { fieldSources }),
    });
  }

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
    if (!meetsFloor(password)) {
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
      // From here the account exists and this browser holds its session, so a failure below
      // is no longer a failure to set the deployment up.
      try {
        await saveStarterProfile();
      } catch (err) {
        setStranded(
          err instanceof ApiError && err.status !== 0
            ? err.message
            : 'The GrantSpotter API could not be reached.',
        );
        return;
      }
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

  if (stranded !== null) {
    return (
      <SignedOutPage>
        <h1 style={{ marginBottom: 'var(--s-3)' }}>Administrator created</h1>
        <p role="alert" style={{ marginBottom: 'var(--s-5)' }}>
          The administrator account was created and this browser is signed in. The callsign was
          not saved to a profile: {stranded} Nothing else was lost, and setup is finished — open
          the Profile screen to enter it there.
        </p>
        <button type="button" className="btn btn-primary" onClick={onAuthenticated}>
          Continue to GrantSpotter
        </button>
      </SignedOutPage>
    );
  }

  return (
    <SignedOutPage>
      <h1 style={{ marginBottom: 'var(--s-3)' }}>Set up GrantSpotter</h1>
      <p style={{ marginBottom: 'var(--s-5)' }}>
        This deployment has no accounts yet. Create the first administrator to continue.
      </p>

      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <label htmlFor="first-run-token" className="eyebrow">
          Setup token
        </label>
        <input
          id="first-run-token"
          type="text"
          autoComplete="off"
          spellCheck={false}
          required
          aria-describedby="first-run-token-hint"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ ...FIELD, marginBottom: 'var(--s-2)', fontFamily: 'var(--mono, monospace)' }}
        />
        <p id="first-run-token-hint" style={HINT}>
          Printed in the server&rsquo;s log when it starts — look for &ldquo;GrantSpotter
          first-run setup&rdquo; (<code>docker logs</code> for a container deployment). A new
          token is issued on every restart until this form is completed.
        </p>

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
          style={FIELD}
        />

        <label htmlFor="first-run-name" className="eyebrow">
          Display name (optional)
        </label>
        <input
          id="first-run-name"
          type="text"
          autoComplete="name"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          style={FIELD}
        />

        <label htmlFor="first-run-callsign" className="eyebrow">
          Callsign (optional)
        </label>
        <input
          id="first-run-callsign"
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-describedby="first-run-callsign-hint"
          value={callsign}
          onChange={(e) => {
            setCallsign(e.target.value);
            // A hand-edited callsign is no longer the one that was looked up, so the values
            // that came with it stop applying. Keeping them would attach somebody else's
            // state and licence class to a callsign nobody checked.
            setAccepted(null);
          }}
          style={{ ...FIELD, marginBottom: 'var(--s-2)', textTransform: 'uppercase' }}
        />
        <p id="first-run-callsign-hint" style={HINT}>
          The callsign you operate under. GrantSpotter starts a student profile with it, so the
          first screen after setup already knows something about you — everything on it can be
          changed later, and leaving this empty stores nothing at all.
        </p>
        <CallsignLookup
          callsign={callsign}
          target="student"
          setupToken={token.trim()}
          onAccept={(values) => {
            setAccepted(values);
            // The record's own callsign, which is not always the one that was typed: the panel
            // does not hand a substituted callsign over until the operator has confirmed it.
            setCallsign(values.callsign.value);
          }}
          clubNotice={
            'This is a club station licence. GrantSpotter keeps a club on an organization ' +
            'profile, which cannot be stored without an entity type, and this screen does not ' +
            'ask for one — so nothing from this record will be stored here. Create the ' +
            'administrator, then open the Profile screen: the same lookup is on its ' +
            'Organization tab.'
          }
        />

        <label htmlFor="first-run-password" className="eyebrow">
          Password
        </label>
        <input
          id="first-run-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          aria-describedby="first-run-password-hint"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ ...FIELD, marginBottom: 'var(--s-2)' }}
        />
        {/*
          Stated before the operator submits, not after they are refused. The rule is
          cheap to satisfy and expensive to discover by rejection, and this is the one
          account in the product with no way back if it is lost.
        */}
        <p id="first-run-password-hint" style={HINT}>
          At least {MIN_PASSWORD_LENGTH} characters. There is no password reset for the first
          administrator — store it somewhere you can find it again.
        </p>

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
          style={{ ...FIELD, marginBottom: 'var(--s-5)' }}
        />

        {error !== null && (
          <p role="alert" style={{ color: 'var(--no)' }}>
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
 * Four states, because a self-hoster meets all four and only one of them is the ordinary
 * one. The check is a request, so it can be in flight, and it can fail — a server that is
 * still opening its database answers nothing at all, and guessing in that moment is how a
 * screen ends up lying: offering setup on a deployment that has accounts, or a sign-in form
 * on one that has none.
 */
type Gate =
  | { kind: 'checking' }
  | { kind: 'first-run' }
  /** `notice` is null for the ordinary case: accounts exist, nothing to explain. */
  | { kind: 'sign-in'; notice: string | null };

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
  return (
    <Login
      onAuthenticated={onAuthenticated}
      notice={
        notice === null ? undefined : (
          <p role="alert" style={{ color: 'var(--warn, var(--ink-2))' }}>
            {notice}{' '}
            <button type="button" className="btn" onClick={recheck}>
              Retry
            </button>
          </p>
        )
      }
    />
  );
}
