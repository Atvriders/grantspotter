import { useState } from 'react';
import { apiSend, ApiError } from '../api/client.js';
import './detail.css';

/** Mirrors `packages/server/src/api/verify.ts`. Restated: `web` never imports `server`. */
export interface VerifyFieldDiff {
  label: string;
  before: string | null;
  after: string | null;
}

/** Mirrors `packages/server/src/api/verify.ts`. */
export interface VerifyResult {
  programId: string;
  attemptedAt: string;
  ok: boolean;
  error?: string;
  changed: boolean;
  diffs: VerifyFieldDiff[];
  lastVerifiedAt: string;
  changeEventIds: string[];
}

export interface VerifyButtonProps {
  programId: string;
  /**
   * Called ONLY when a fetch actually happened and succeeded. A refused or failed fetch changed
   * nothing on the server, so reloading the record would repaint the same staleness while
   * looking like a refresh.
   */
  onVerified: () => void;
}

/**
 * Spec §8's "Verify now": refetch the funder's page on demand and say what moved.
 *
 * Three outcomes, deliberately rendered as three different things:
 *
 *  - **changed** — the diff, before and after, field by field.
 *  - **unchanged** — a plain sentence. Silence would read as "nothing happened".
 *  - **refused** — HTTP 200 carrying `ok: false` and the fetcher's OWN sentence. A blocked host
 *    or an unreachable server is not an application fault, and flattening it into "something
 *    went wrong" throws away the only explanation the reader gets. The record stays exactly as
 *    stale as it was, so the freshness badge stays amber; that is the honest reading and the
 *    reason `onVerified` is not called.
 *
 * The rate limit is charged BEFORE the fetch (1 per programme per hour, 10 an hour for a member)
 * and is not refunded on failure: these pages belong to small volunteer-run organisations, and
 * refunding failures would let a user whose target is already timing out retry as fast as they
 * can click.
 */
export function VerifyButton({ programId, onVerified }: VerifyButtonProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const value = await apiSend<VerifyResult>('POST', `/api/programs/${programId}/verify`);
      setResult(value);
      if (value.ok) onVerified();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'rate_limited') {
        // Plan 1's ApiError exposes the envelope's `error.details` as `details`.
        const detail = err.details as { reason?: string; retryAfterSec?: number } | undefined;
        setError(
          detail?.reason === 'program_cooldown'
            ? 'You already verified this recently. Try again in about an hour — the funders in this corpus are small nonprofits and we poll them politely.'
            : 'You have used your verification allowance for this hour. Try again shortly.',
        );
      } else if (err instanceof ApiError && err.status === 0) {
        // Never "the source is unreachable": the request never left this browser, and blaming
        // the funder's server for a transport failure here is a false statement about them.
        setError('GrantSpotter could not be reached, so nothing was verified. Check your connection and try again.');
      } else {
        setError('The verification could not be started. Nothing was re-checked.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy}
        onClick={() => {
          void run();
        }}
      >
        {busy ? 'Verifying…' : 'Verify now'}
      </button>

      {error !== null && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}

      {result !== null && (
        <section className="panel card" aria-label="Verification result">
          <h2>Verification result</h2>

          {!result.ok && (
            <div className="notice">
              <p>
                Nothing was refetched, so this record is exactly as fresh as it was before. That
                is not a failure of GrantSpotter — it is what the fetcher reported:
              </p>
              <p className="verbatim">{result.error ?? 'The fetcher gave no reason.'}</p>
            </div>
          )}

          {result.ok && !result.changed && (
            <p>
              Checked at <span className="data">{result.attemptedAt}</span>. The source still says
              the same thing.
            </p>
          )}

          {result.ok && result.changed && (
            <div className="table-wrap">
              <table className="grid-table diff-table" aria-label="What changed">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Was</th>
                    <th scope="col">Now</th>
                  </tr>
                </thead>
                <tbody>
                  {result.diffs.map((d) => (
                    <tr key={d.label}>
                      <td className="data">{d.label}</td>
                      <td className="data before">{d.before ?? 'Not stated'}</td>
                      <td className="data after">{d.after ?? 'Not stated'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
