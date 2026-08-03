import { useEffect, useState } from 'react';
import { ApiError, getBootstrapStatus, getHealth, type HealthResponse } from './api/client.js';

export function App(): JSX.Element {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [bootstrapRequired, setBootstrapRequired] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [healthResult, bootstrapResult] = await Promise.all([
          getHealth(),
          getBootstrapStatus(),
        ]);
        if (cancelled) return;
        setHealth(healthResult);
        setBootstrapRequired(bootstrapResult.required);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Could not reach the GrantSpotter API.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>GrantSpotter</h1>
      <p>A self-hosted funding desk for collegiate and educational amateur radio.</p>
      {error !== null && <p role="alert">{error}</p>}
      {health !== null && (
        <dl>
          <dt>Version</dt>
          <dd>{health.version}</dd>
          <dt>Migrations applied</dt>
          <dd>{health.migrations}</dd>
          <dt>Programs in the corpus</dt>
          <dd>{health.programs}</dd>
        </dl>
      )}
      {bootstrapRequired === true && (
        <p>
          No account exists yet. Check the server log for the one-time bootstrap token, then POST
          it to <code>/api/auth/bootstrap</code>.
        </p>
      )}
    </main>
  );
}
