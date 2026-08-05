import { useState } from 'react';
import type { FormEvent } from 'react';
import type { EnrollmentCode } from '@grantspotter/core';
import { ApiError } from '../api/client.js';
import {
  createEnrollmentCode,
  revokeEnrollmentCode,
  ENROLLMENT_CODES_PATH,
  type CreatedEnrollmentCode,
  type EnrollmentCodeListResponse,
} from '../api/enrollment.js';
import { useApi } from '../store/useApi.js';
import { formatDate } from '../lib/trust.js';
import './admin.css';

/**
 * ENROLLMENT CODES, ON THE ADMIN CONSOLE.
 *
 * A section rather than a slab of `routes/Admin.tsx`, and it owns its own live region rather than
 * sharing that screen's single `notice`. That is deliberate: the notice there can be a generated
 * password, shown once, which an admin may not have copied yet. Creating an enrollment code must
 * not overwrite it — destroying the only copy of a password to announce a different secret is a
 * worse bug than having two live regions on one screen.
 */

export type EnrollmentCodeState = 'active' | 'revoked' | 'expired' | 'used-up';

/**
 * What a code's row says about it, in the order that decides it.
 *
 * Revocation first, because it is a decision somebody made and it outranks the rest; then expiry;
 * then exhaustion. A code can be several of these at once, and reporting the accident (it ran out)
 * over the decision (an admin withdrew it) would misattribute the reason it stopped working.
 *
 * `expiresAt` that does not parse is treated as no expiry rather than as expired: this is the
 * browser's reading of a server field, and guessing "expired" from an unreadable date would put a
 * revoke button next to a code that still works.
 */
export function enrollmentCodeState(code: EnrollmentCode, nowIso: string): EnrollmentCodeState {
  if (code.revokedAt !== null) return 'revoked';
  if (code.expiresAt !== null) {
    const expiresAt = Date.parse(code.expiresAt);
    const now = Date.parse(nowIso);
    if (!Number.isNaN(expiresAt) && !Number.isNaN(now) && expiresAt <= now) return 'expired';
  }
  if (code.maxUses !== null && code.uses >= code.maxUses) return 'used-up';
  return 'active';
}

const STATE_WORD: Record<EnrollmentCodeState, string> = {
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
  'used-up': 'Used up',
};

/** Only an active code can still create an account, so only an active code is worth revoking. */
const STATE_TAG: Record<EnrollmentCodeState, string> = {
  active: 'admin-tag admin-tag-self',
  revoked: 'admin-tag admin-tag-off',
  expired: 'admin-tag',
  'used-up': 'admin-tag',
};

type CountField = { ok: true; value: number | null } | { ok: false };

/** Blank is a deliberate "no limit", which is not the same as a typo. */
function readCount(raw: string): CountField {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false };
  const value = Number(text);
  return value >= 1 ? { ok: true, value } : { ok: false };
}

function usesLabel(code: EnrollmentCode): string {
  return code.maxUses === null
    ? `${String(code.uses)} (no limit)`
    : `${String(code.uses)} of ${String(code.maxUses)}`;
}

export interface EnrollmentCodesProps {
  /**
   * The instant expiry is judged against. Injected so a test can pin it, exactly as `Browse` and
   * `Calendar` take a `now` — a component that reads the clock itself has a row whose state
   * changes under the test that asserts it.
   */
  now?: string;
}

export function EnrollmentCodes({ now }: EnrollmentCodesProps): JSX.Element {
  const codes = useApi<EnrollmentCodeListResponse>(ENROLLMENT_CODES_PATH);
  const nowIso = now ?? new Date().toISOString();

  const [label, setLabel] = useState('');
  const [maxUses, setMaxUses] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('');
  const [created, setCreated] = useState<CreatedEnrollmentCode | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'unavailable'>('idle');

  // A well-formed body that is missing `codes` is a server this build does not understand, not an
  // instance with no codes — but there is nothing useful to render either way, and `useApi`
  // already raises a body that failed to parse as an error.
  const rows = codes.data?.codes ?? [];

  function begin(): void {
    setError(null);
    setMessage(null);
    // The one-time plaintext goes with it. Leaving a stale code on screen while a different
    // action reports its own result invites copying the wrong secret.
    setCreated(null);
    setCopied('idle');
  }

  function fail(err: unknown, fallback: string): void {
    setError(err instanceof ApiError ? err.message : fallback);
  }

  async function copyCode(value: string): Promise<void> {
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard === undefined) {
      setCopied('unavailable');
      return;
    }
    try {
      await clipboard.writeText(value);
      setCopied('done');
    } catch {
      setCopied('unavailable');
    }
  }

  async function create(event: FormEvent): Promise<void> {
    event.preventDefault();
    begin();

    const trimmed = label.trim();
    if (trimmed === '') {
      setError(
        'Say what this code is for. The label is the only way to tell one code from another ' +
          'afterwards — the code itself is never readable again.',
      );
      return;
    }
    const uses = readCount(maxUses);
    if (!uses.ok) {
      setError('Maximum uses must be a whole number of 1 or more, or blank for no limit.');
      return;
    }
    const days = readCount(expiresInDays);
    if (!days.ok) {
      setError('Expires in must be a whole number of days, 1 or more, or blank for no expiry.');
      return;
    }

    try {
      const result = await createEnrollmentCode({
        label: trimmed,
        maxUses: uses.value,
        expiresInDays: days.value,
      });
      setCreated(result);
      setLabel('');
      setMaxUses('');
      setExpiresInDays('');
      codes.reload();
    } catch (err) {
      fail(err, 'That enrollment code could not be created.');
    }
  }

  async function revoke(code: EnrollmentCode): Promise<void> {
    begin();
    try {
      await revokeEnrollmentCode(code.id);
      setMessage(
        `Revoked “${code.label}”. Anyone still holding that code can no longer create an ` +
          'account with it; accounts it already created are untouched.',
      );
    } catch (err) {
      fail(err, 'That enrollment code could not be revoked.');
    } finally {
      // The server's truth either way, so a row cannot keep claiming a state the revoke never
      // reached.
      codes.reload();
    }
  }

  return (
    <section className="admin-section card" aria-label="Enrollment codes">
      <h2>Enrollment codes</h2>
      <p className="admin-prose">
        An enrollment code lets somebody create their own account from the sign-in screen, without
        an admin typing a password for them. Every account a code creates is a member — enrolment
        cannot grant admin, whoever holds the code. Give a code to one intake, one club or one
        person, and revoke it when that is over.
      </p>
      <p className="admin-prose">
        The code is shown once, here, when it is created. GrantSpotter stores only a hash of it, so
        neither this console nor the server can ever show it again — a lost code is replaced, not
        recovered.
      </p>

      {error !== null && (
        <p role="alert" className="admin-alert">
          {error}
        </p>
      )}

      {created !== null && (
        <div className="secret-banner" role="status">
          <span>
            Enrollment code for {created.code.label}:{' '}
            <span className="secret-value">{created.plaintext}</span>
          </span>
          <p className="admin-prose" style={{ marginTop: 'var(--s-2)', marginBottom: 0 }}>
            This is shown once. Copy it now — the server keeps only a hash and can never show it
            again. Anyone holding it can create a member account until it expires, is used up, or
            is revoked, so send it the way you would send a password.
          </p>
          <span className="secret-actions">
            <button
              type="button"
              className="btn"
              aria-label="Copy the enrollment code to the clipboard"
              onClick={() => {
                void copyCode(created.plaintext);
              }}
            >
              Copy
            </button>
            {copied === 'done' && <span className="admin-copied">Copied to the clipboard.</span>}
            {copied === 'unavailable' && (
              <span className="admin-copied">
                This browser would not let the page reach the clipboard. Select the value and copy
                it by hand.
              </span>
            )}
          </span>
        </div>
      )}

      {message !== null && (
        <p role="status" className="admin-notice">
          {message}
        </p>
      )}

      <form className="admin-form" noValidate onSubmit={(e) => void create(e)}>
        <label htmlFor="new-code-label">
          What this code is for
          <input
            id="new-code-label"
            type="text"
            autoComplete="off"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label htmlFor="new-code-max-uses">
          Maximum uses (blank for no limit)
          <input
            id="new-code-max-uses"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          />
        </label>
        <label htmlFor="new-code-expires">
          Expires in days (blank for no expiry)
          <input
            id="new-code-expires"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={expiresInDays}
            onChange={(e) => setExpiresInDays(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary">
          Create enrollment code
        </button>
      </form>

      {codes.loading && <p className="eyebrow">Loading…</p>}
      {codes.error !== null && (
        <p role="alert" className="admin-alert">
          Could not load enrollment codes ({codes.error.code}). {codes.error.message}
        </p>
      )}

      {codes.data !== null && rows.length === 0 && (
        <p className="admin-prose">
          No enrollment codes yet. Until one exists, accounts are created here by an admin, or by
          the first-run setup token.
        </p>
      )}

      {rows.length > 0 && (
        <div className="admin-table-wrap">
          <table className="grid-table" aria-label="Enrollment codes">
            <thead>
              <tr>
                <th scope="col">Code</th>
                <th scope="col" className="num">
                  Uses
                </th>
                <th scope="col" className="num">
                  Expires (UTC)
                </th>
                <th scope="col">State</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((code) => {
                const state = enrollmentCodeState(code, nowIso);
                return (
                  <tr key={code.id}>
                    <td>
                      <span className="admin-row-email">{code.label}</span>
                      <span className="admin-row-meta">
                        Created {formatDate(code.createdAt)} ·{' '}
                        {code.lastUsedAt === null
                          ? 'never used'
                          : `last used ${formatDate(code.lastUsedAt)}`}
                      </span>
                    </td>
                    <td className="num">{usesLabel(code)}</td>
                    <td className="num">
                      {code.expiresAt === null ? 'No expiry' : formatDate(code.expiresAt)}
                    </td>
                    <td>
                      {/* A tag, not a bare word: the state is what an admin scans this table for. */}
                      <span className={STATE_TAG[state]}>{STATE_WORD[state]}</span>
                      {state === 'revoked' && (
                        <span className="admin-row-meta">
                          Revoked {formatDate(code.revokedAt)}
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        {/*
                          Absent, not disabled, once the code is revoked: there is nothing left to
                          revoke, and a greyed-out button reads as a permissions fault. Expired and
                          used-up codes keep the button, because revoking one is still meaningful —
                          an expiry can be the only thing standing between a leaked code and a new
                          account if the clock is ever wrong.
                        */}
                        {state !== 'revoked' && (
                          <button
                            type="button"
                            className="btn"
                            aria-label={`Revoke ${code.label}`}
                            onClick={() => {
                              void revoke(code);
                            }}
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
