import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  CHOSEN_CODE_MAX_DAYS,
  CHOSEN_CODE_MAX_INPUT,
  CHOSEN_CODE_MAX_USES,
  CHOSEN_CODE_MIN_LENGTH,
  describeEnrollmentCodeFold,
  describeEnrollmentCodeStripped,
  ENROLLMENT_CODE_FOLD,
  normalizeEnrollmentCode,
  type EnrollmentCode,
} from '@grantspotter/core';
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

/**
 * A SECOND SPELLING OF THE SAME CODE — the trap, shown to the administrator as their own string
 * rather than described in the abstract.
 *
 * Every digit the fold can PRODUCE — only `0` and `1` — is written back as a letter that folds onto
 * it, so `W1MXFA112026` comes back as `WIMXFAII2O26`. Other digits are left alone, because nothing
 * folds onto them. The result is a genuinely different-looking string that opens the same door,
 * which is the fact an administrator has to understand before a collision can surprise them.
 *
 * Built by INVERTING `ENROLLMENT_CODE_FOLD` rather than by writing `0 -> O` here, so a change to
 * the fold cannot leave this example lying. Where two letters fold onto one digit (`I` and `L` both
 * give `1`) the first wins, because the example only has to be A valid alternative spelling.
 */
export function confusableTwin(normalized: string): string {
  const unfold = new Map<string, string>();
  for (const [letter, digit] of Object.entries(ENROLLMENT_CODE_FOLD)) {
    if (!unfold.has(digit)) unfold.set(digit, letter);
  }
  return [...normalized].map((c) => unfold.get(c) ?? c).join('');
}

/**
 * The sentence that says the fold out loud, assembled from the map so it cannot drift from what the
 * server hashes. `api/enrollment.ts` builds its refusals from the same function.
 */
const FOLD_SENTENCE = describeEnrollmentCodeFold();

/**
 * "capitals, dashes, spaces and U" — what comes out of a code before it is measured, assembled in
 * core so the hint under the field cannot go on quoting a length arrived at by a rule it does not
 * state. `U` is deleted rather than folded, so `W1MX-AUTUMN-2026` is fourteen of the characters an
 * officer typed and twelve of the ones this floor counts.
 */
const STRIPPED_SENTENCE = describeEnrollmentCodeStripped();

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
  const [chosen, setChosen] = useState('');
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

  /**
   * WHAT THE ADMINISTRATOR IS ACTUALLY COMMITTING TO, WORKED OUT AS THEY TYPE.
   *
   * `normalizeEnrollmentCode` is core's, which is the same function the server hashes with — that
   * is why it lives in core rather than in the server package, and it is the only reason this
   * preview can be trusted rather than approximated.
   */
  const chosenCode = chosen.trim();
  const normalized = normalizeEnrollmentCode(chosenCode);
  const twin = confusableTwin(normalized);
  const belowFloor = chosenCode !== '' && normalized.length < CHOSEN_CODE_MIN_LENGTH;

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
        // Blank means "generate one", which is the default this form opens on.
        //
        // NOTHING ABOUT THE FLOOR, THE EXPIRY OR THE LABEL IS CHECKED HERE, deliberately, and it is
        // not an oversight: those three refusals each carry a paragraph explaining a number, and a
        // second copy of a paragraph in the browser is a paragraph that will disagree with the
        // server's one edit from now. The preview under the field warns before the press; the
        // server's own sentence is what the administrator reads if they press anyway. The checks
        // above stay because they are about the SHAPE of a field, which has no argument to drift.
        code: chosenCode === '' ? null : chosenCode,
        maxUses: uses.value,
        expiresInDays: days.value,
      });
      setCreated(result);
      setLabel('');
      setChosen('');
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
          {/*
            THE SECOND PARAGRAPH EXISTS ONLY FOR A CODE THE ADMINISTRATOR TYPED, and it is the last
            moment anything can tell them what they have just made. The list below carries a
            "Chosen" tag afterwards, but a tag is a reminder and this is the explanation.

            It says the stored form because that, and not their typing, is the code; it names a
            second spelling of it, because the collision that spelling can cause is the surprise
            waiting for them next term; and it says plainly that this one can be guessed, because
            the rest of this panel's prose was written when no code could be.
          */}
          {created.code.chosen && (
            <p className="admin-prose" style={{ marginTop: 'var(--s-2)', marginBottom: 0 }}>
              GrantSpotter stores that as{' '}
              <span className="secret-value">{created.normalized}</span> — capitals, dashes and
              spaces are ignored and {FOLD_SENTENCE}, so{' '}
              <span className="secret-value">{confusableTwin(created.normalized)}</span> is the same
              code and no other code on this instance can use those characters now. You chose this
              one, so unlike a generated code it is short enough for somebody to think of: it is
              safe from being worked through character by character and it is not safe from being
              guessed by anyone who knows your club. What bounds that is its expiry and the{' '}
              {created.code.maxUses === null
                ? 'accounts'
                : `${String(created.code.maxUses)} accounts`}{' '}
              it may create — not its length — so revoke it the day the intake closes rather than
              leaving it to run.
            </p>
          )}
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
        <label htmlFor="new-code-value">
          Code (blank to generate one)
          <input
            id="new-code-value"
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={CHOSEN_CODE_MAX_INPUT}
            placeholder="W1MX-FALL-2026"
            aria-describedby="new-code-note"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
          />
        </label>
        {/*
          THE TRADE, STATED WHERE IT IS BEING MADE.

          It occupies a whole row of the form (`.admin-form-note`) rather than sitting under the
          panel heading, because a paragraph at the top of a screen is read once by the person who
          set the instance up and never again by the officer issuing next term's code. This is
          under the cursor.

          `aria-describedby` AND NOT A LIVE REGION, which is the second thing this was. `role=
          "status"` announced the whole sentence on every keystroke — a half-typed code read out
          twelve times — and, because this section already renders the one-time code inside a
          `role="status"` banner, it made "the status region" ambiguous for anybody looking for the
          code they had just been shown. A description belongs TO the field: it is read when the
          field is reached, and it does not interrupt.

          The inner span is not decoration: `.admin-form-note` is the full-width flex item and the
          span is what carries the readable measure, because a `max-width` on the item itself is
          what stopped it breaking the row. `admin.css` has the measurement.
        */}
        <p id="new-code-note" className="admin-form-note">
          <span>
            {chosenCode === '' ? (
              <>
                Blank generates twenty random characters that nobody can guess. Type your own to get
                one an officer can read out at a meeting — that is a real trade, because a code
                somebody can remember is a code somebody can guess. A code you choose needs at
                least {CHOSEN_CODE_MIN_LENGTH} characters once {STRIPPED_SENTENCE} are taken out,
                and has to expire within {CHOSEN_CODE_MAX_DAYS} days.
              </>
            ) : (
              <>
                GrantSpotter will store that as{' '}
                <span className="secret-value">{normalized}</span> — {normalized.length}{' '}
                {normalized.length === 1 ? 'character' : 'characters'}
                {belowFloor
                  ? `, and a code you choose needs at least ${CHOSEN_CODE_MIN_LENGTH}`
                  : ''}
                . Capitals, dashes and spaces are ignored and {FOLD_SENTENCE}
                {twin === normalized ? '' : `, so ${twin} is the same code`}.
              </>
            )}
          </span>
        </p>
        <label htmlFor="new-code-max-uses">
          {/*
            The same conditional the expiry field carries, for the same reason and now for a second
            one. "Blank for no limit" stops being true the moment a code is typed — a chosen code
            has to say how many accounts it may create — and a form that invites a value the server
            refuses is the defect this codebase keeps writing down: a limit that turns away
            legitimate work. The number of uses is also the only bound on what a GUESSED chosen code
            is worth, so the label says the ceiling rather than making the officer find it by being
            refused.
          */}
          {chosenCode === ''
            ? 'Maximum uses (blank for no limit)'
            : `Maximum uses (required for a code you choose, up to ${String(CHOSEN_CODE_MAX_USES)})`}
          <input
            id="new-code-max-uses"
            type="number"
            min={1}
            step={1}
            max={chosenCode === '' ? undefined : CHOSEN_CODE_MAX_USES}
            inputMode="numeric"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
          />
        </label>
        <label htmlFor="new-code-expires">
          {/*
            The label changes with the other field, because "blank for no expiry" stops being true
            the moment a code is typed and an input that lies about being optional is a refusal
            waiting to happen. The leading words are the same in both readings, so the control is
            still findable by the name it has always had.
          */}
          {chosenCode === ''
            ? 'Expires in days (blank for no expiry)'
            : `Expires in days (required for a code you choose, up to ${String(CHOSEN_CODE_MAX_DAYS)})`}
          <input
            id="new-code-expires"
            type="number"
            min={1}
            step={1}
            max={chosenCode === '' ? undefined : CHOSEN_CODE_MAX_DAYS}
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
                      {/*
                        WHICH KIND OF CODE THIS IS, ON EVERY ROW AND NOT ONLY ON THE ONE JUST MADE.
                        The two are not equally strong and nothing else on this screen can tell them
                        apart — only a digest is stored, so the row is the only place the fact can
                        live. An officer deciding which of eight codes to revoke first needs it.

                        Both words are printed rather than tagging only the chosen ones: absence is
                        not a statement, and a reader who does not know a tag exists cannot read
                        anything from its absence.
                      */}
                      <span className={code.chosen ? 'admin-tag admin-tag-off' : 'admin-tag'}>
                        {code.chosen ? 'Chosen' : 'Generated'}
                      </span>
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
