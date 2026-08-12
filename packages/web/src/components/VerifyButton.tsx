import { useState } from 'react';
import { apiSend, ApiError } from '../api/client.js';
import { humanRetryAfter, retryAfterSecOf } from '../lib/retryAfter.js';
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
        /*
         * THE SERVER'S NUMBER, SAID ONCE, INSTEAD OF TWO DURATIONS THIS SCREEN INVENTED.
         *
         * FIXED 2026-08-12, and the product was wrong rather than the test. Both arms here read
         * `retryAfterSec` off the envelope — it is in the type annotation one line up — and then
         * threw it away in favour of a phrase:
         *
         *   program_cooldown → "Try again in about an hour"
         *   hourly_cap       → "Try again shortly."
         *
         * `api/verify.ts` computes both of those numbers from the ledger and says so in its own
         * docblock: "Both `retryAfterSec` values are computed from the ledger, never rounded to a
         * number that merely looks plausible: the cooldown expires an hour after the attempt that
         * set it, and the cap frees the moment the oldest attempt still inside the window ages out
         * of it." Neither phrase is that number, and each is wrong in a different direction:
         *
         *   - A member who verified this programme 59 minutes ago is told to come back in about an
         *     hour. `retryAfterSec` is 60. They are sent away for sixty times the real wait.
         *   - A member who spent all ten of their hourly verifications two minutes ago is told
         *     "shortly". `retryAfterSec` is 3,480 — fifty-eight minutes. This is the same sentence
         *     as round one's "wait a minute" over a fifteen-minute lockout, one file across.
         *
         * `api/auth.ts` already states the rule this now obeys, and states it as settled: "There
         * is one number, it is `retryAfterSec`, and these sentences say what happened rather than
         * when to come back." `Enroll.tsx` and `Login.tsx` were both brought to it on 2026-08-05
         * and 2026-08-12. This screen was the one client left reading the field and printing
         * something else. `lib/retryAfter.ts` is the shared renderer for exactly this reason, and
         * it returns `null` for an envelope with no usable number — in which case nothing at all
         * is said about time, which is the whole of its second rule.
         */
        const detail = err.details as { reason?: string } | undefined;
        const wait = retryAfterSecOf(err.details);
        const when = wait === null ? '' : ` Try again in ${humanRetryAfter(wait)}.`;
        setError(
          detail?.reason === 'program_cooldown'
            ? 'You already verified this programme recently. The funders in this corpus are small ' +
                'nonprofits and we poll them politely.' +
                when
            : 'You have used every verification in your hourly allowance.' + when,
        );
      } else if (!(err instanceof ApiError) || err.status === 0) {
        /*
         * A REQUEST THAT NEVER LEFT THIS BROWSER — AND THE CONDITION IS `!(err instanceof
         * ApiError)`, NOT `status === 0`, WHICH IS WHY THIS SENTENCE NEVER APPEARED.
         *
         * FIXED 2026-08-12; the product was wrong. `api/client.ts` gives `status: 0` to nothing:
         * its own comment says "0 is reserved by `useApi` for a request that never reached a
         * server", and `useApi` is the hook the ROUTES use. This component calls `apiSend`, where
         * a rejected `fetch` propagates as the raw `TypeError` the browser threw. So `err
         * instanceof ApiError && err.status === 0` was false for every transport failure that has
         * ever happened here, the arm below answered them instead, and the one sentence written
         * to avoid blaming the funder for the reader's own wifi has never once been printed.
         * `routes/Watchlist.tsx`'s `saveRefusalMessage` already spells the condition correctly
         * (`!(err instanceof ApiError) || err.status === 0`); this is that predicate.
         *
         * Never "the source is unreachable": the request never left this browser, and blaming the
         * funder's server for a transport failure here is a false statement about them.
         */
        setError(
          'GrantSpotter could not be reached, so nothing was verified. Check your connection and ' +
            'try again.',
        );
      } else {
        /*
         * A SERVER FAULT, WHICH IS NOT THE SAME AS NOTHING HAVING HAPPENED.
         *
         * This arm said "The verification could not be started. Nothing was re-checked." until
         * 2026-08-12, and the second sentence is a claim this screen is not entitled to make.
         * `api/verifyRouter.ts` charges the attempt to the ledger, THEN calls `runner.verify`,
         * which fetches the funder's page and then writes `change_events` rows, provenance and the
         * programme itself. Every one of those writes is after the fetch, and any of them can
         * throw — a busy database is enough. The 500 that arrives here therefore covers states in
         * which the funder's page was read, the member's hourly allowance was spent, and rows were
         * written; "nothing was re-checked" is false in all of them, and it is false in the
         * direction that tells somebody their allowance is intact when it is not.
         *
         * What is true is that the server faulted and did not say how far it got.
         */
        setError(
          `GrantSpotter answered ${String(err.status)}, which is a fault on the server rather ` +
            'than anything you can fix here. It did not say whether the funder’s page was ' +
            'refetched before it failed, so this screen is not claiming either way.',
        );
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
