import { useState } from 'react';
import type { FormEvent } from 'react';
import { apiSend, ApiError } from '../api/client.js';

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
    case 'rate_limited':
      return 'Too many attempts. Wait a minute and try again.';
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

export function Login({ onAuthenticated }: { onAuthenticated: () => void }): JSX.Element {
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
    <main
      id="main"
      style={{ maxWidth: 380, margin: '12vh auto', padding: 'var(--s-5)' }}
      className="card"
    >
      <p className="eyebrow">GrantSpotter</p>
      <h1 style={{ marginBottom: 'var(--s-5)' }}>Sign in</h1>

      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
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
          style={{ width: '100%', marginBottom: 'var(--s-4)', padding: 'var(--s-2)' }}
        />

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
          style={{ width: '100%', marginBottom: 'var(--s-5)', padding: 'var(--s-2)' }}
        />

        {error !== null && (
          <p role="alert" style={{ color: 'var(--no)' }}>
            {error}
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
