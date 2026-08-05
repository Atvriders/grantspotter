import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { apiSend, ApiError } from '../api/client.js';
import { EnrollmentCodes } from '../components/EnrollmentCodes.js';
import { useSession } from '../store/session.js';
import { useApi } from '../store/useApi.js';
import { formatDate } from '../lib/trust.js';
import '../components/admin.css';

/**
 * Mirrors `AdminUserRow` in `packages/server/src/api/adminUsersRouter.ts`.
 * Restated rather than imported: the import direction is `web → core` only.
 */
interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  isSelf: boolean;
}

interface UsersResponse {
  rows: AdminUserRow[];
}

/** What a delete destroyed. The server counts it before the cascade runs. */
interface RemovedCounts {
  profiles: number;
  watches: number;
  sessions: number;
  applications: number;
}

/**
 * One live region, two shapes. A generated password is not prose — it gets its
 * own rendering with a copy affordance, and it is never put in a URL, a query
 * string or a log line: the server has a test asserting no password reaches
 * `audit_log`, and this page must not undo that from the other side.
 */
type Notice =
  | { kind: 'secret'; email: string; password: string; note: string }
  | { kind: 'message'; text: string };

const CONFIRM_WORD = 'REPLACE';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * `FileReader`, not `File.text()`. jsdom 26 — the DOM every web test in this
 * repo runs against — does not implement `Blob.prototype.text`, so a `text()`
 * call throws `TypeError` inside the same `try` that reports "this file is not
 * JSON" and the page ends up blaming the operator's backup for a missing browser
 * API. `FileReader` exists in every browser this app supports and in jsdom, so
 * there is exactly one path here and the tests exercise it.
 */
function readFileText(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

export interface AdminProps {
  /**
   * The instant the enrollment-code table judges expiry against, passed straight through. Optional
   * and normally absent — `Browse` and `Calendar` take the same prop for the same reason, which is
   * that a test cannot assert "expired" about a row whose state depends on when the suite runs.
   */
  now?: string;
}

export function Admin({ now }: AdminProps): JSX.Element {
  const { user } = useSession();
  const users = useApi<UsersResponse>('/api/admin/users');

  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'member'>('member');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'unavailable'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoreNonce, setRestoreNonce] = useState(0);
  const [confirmWord, setConfirmWord] = useState('');

  const rows = users.data?.rows ?? [];

  /**
   * The server's rule, mirrored so it can be stated BEFORE a control is used —
   * not re-implemented as the gate. `assertNotLastAdmin` in
   * `adminUsersRouter.ts` is still the authority, and it counts ENABLED admins
   * only: `attachUser` refuses a disabled user, so a disabled admin is not a way
   * back into an instance whose only console is behind this login.
   */
  const lastEnabledAdminId = useMemo<string | null>(() => {
    const enabled = rows.filter((row) => row.role === 'admin' && !row.disabled);
    const only = enabled.length === 1 ? enabled[0] : undefined;
    return only?.id ?? null;
  }, [rows]);

  function begin(): void {
    setError(null);
    setNotice(null);
    setCopied('idle');
  }

  function fail(err: unknown, fallback: string): void {
    // An `ApiError` carries the server's own sentence — "This is the last admin
    // who can still sign in; promote or enable another admin first." Replacing
    // it with a generic message is how a refusal becomes a mystery.
    setError(err instanceof ApiError ? err.message : fallback);
  }

  async function copyPassword(value: string): Promise<void> {
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

  async function createUser(event: FormEvent): Promise<void> {
    event.preventDefault();
    begin();
    const email = newEmail.trim();
    if (email === '') {
      setError('Enter an email address for the new account.');
      return;
    }
    try {
      const created = await apiSend<{ user: AdminUserRow; generatedPassword: string }>(
        'POST',
        '/api/admin/users',
        { email, role: newRole },
      );
      setNotice({
        kind: 'secret',
        email: created.user.email,
        password: created.generatedPassword,
        note: `${created.user.email} can sign in with this password and change it afterwards.`,
      });
      setNewEmail('');
      users.reload();
    } catch (err) {
      fail(err, 'That account could not be created.');
    }
  }

  async function setRole(row: AdminUserRow, role: 'admin' | 'member'): Promise<void> {
    begin();
    try {
      await apiSend('PATCH', `/api/admin/users/${row.id}/role`, { role });
    } catch (err) {
      fail(err, 'That role change was refused.');
    } finally {
      // Re-read the server's truth either way, so the select cannot keep showing
      // a change that never happened.
      users.reload();
    }
  }

  async function setDisabled(row: AdminUserRow, disabled: boolean): Promise<void> {
    begin();
    try {
      await apiSend('PATCH', `/api/admin/users/${row.id}/disabled`, { disabled });
    } catch (err) {
      fail(err, 'That account could not be changed.');
    } finally {
      users.reload();
    }
  }

  async function resetPassword(row: AdminUserRow): Promise<void> {
    begin();
    try {
      const reset = await apiSend<{ generatedPassword: string; revokedSessions?: number }>(
        'POST',
        `/api/admin/users/${row.id}/reset-password`,
      );
      const revoked = reset.revokedSessions;
      setNotice({
        kind: 'secret',
        email: row.email,
        password: reset.generatedPassword,
        note:
          revoked === undefined
            ? `${row.email} must sign in again with this password.`
            : `${plural(revoked, 'signed-in session was', 'signed-in sessions were')} signed out, so a stolen cookie for this account is now useless.`,
      });
    } catch (err) {
      fail(err, 'That password could not be reset.');
    }
  }

  async function deleteUser(row: AdminUserRow): Promise<void> {
    begin();
    setConfirmingDeleteId(null);
    try {
      const result = await apiSend<{ removed: RemovedCounts }>(
        'DELETE',
        `/api/admin/users/${row.id}`,
      );
      const removed = result.removed;
      setNotice({
        kind: 'message',
        text:
          `Deleted ${row.email}. Removed with it: ${plural(removed.profiles, 'profile', 'profiles')}, ` +
          `${plural(removed.watches, 'watchlist entry', 'watchlist entries')}, ` +
          `${plural(removed.sessions, 'session', 'sessions')} and ` +
          `${plural(removed.applications, 'application', 'applications')}. ` +
          'The audit trail of what this account did is kept.',
      });
      users.reload();
    } catch (err) {
      fail(err, 'That account could not be deleted.');
      users.reload();
    }
  }

  async function restore(): Promise<void> {
    if (restoreFile === null || confirmWord !== CONFIRM_WORD) return;
    begin();
    let text: string;
    try {
      text = await readFileText(restoreFile);
    } catch {
      setError(
        `${restoreFile.name} could not be read from disk, so nothing was sent and nothing was replaced.`,
      );
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      setError(
        `${restoreFile.name} is not a readable JSON document — a truncated download reads like this — so nothing was sent and nothing was replaced.`,
      );
      return;
    }
    try {
      // The backup IS a JSON document, so it is posted as JSON — the restore
      // endpoint reads the parsed body, not multipart form data.
      const result = await apiSend<{
        tablesRestored?: string[];
        tablesSkipped?: string[];
        rowsRestored?: number;
        programsReindexed?: number | null;
      }>('POST', '/api/admin/restore', payload);
      const tables = result.tablesRestored?.length ?? 0;
      const restored = result.rowsRestored ?? 0;
      const skipped = result.tablesSkipped ?? [];
      // `programsReindexed` is `null`, never `0`, when this build has no browse projection to
      // rebuild — restore now genuinely calls `reindexBrowse` inside the same transaction, so
      // there is a real count to report and no reason left to tell the operator to restart the
      // server for Browse to catch up.
      const reindexed = result.programsReindexed ?? null;
      const reindexSentence =
        reindexed === null
          ? 'This build has no browse projection to rebuild, so whether Browse reflects this restore could not be determined here.'
          : `The browse index was rebuilt for ${plural(reindexed, 'programme', 'programmes')}.`;
      const skippedSentence =
        skipped.length > 0
          ? ` ${plural(skipped.length, 'table', 'tables')} in that file ${skipped.length === 1 ? 'is' : 'are'} not known to this build and ${skipped.length === 1 ? 'was' : 'were'} skipped: ${skipped.join(', ')}.`
          : '';
      setNotice({
        kind: 'message',
        text:
          `Restored ${plural(restored, 'row', 'rows')} across ${plural(tables, 'table', 'tables')}. ` +
          `${reindexSentence}${skippedSentence}`,
      });
      setConfirmWord('');
      setRestoreFile(null);
      setRestoreNonce((n) => n + 1);
    } catch (err) {
      fail(err, 'That backup could not be restored.');
    }
  }

  async function revokeIcsToken(): Promise<void> {
    begin();
    try {
      await apiSend('DELETE', '/api/exports/ics-token');
      setNotice({
        kind: 'message',
        text:
          'Calendar feed link revoked. Any calendar subscribed to the old URL stops updating now; ' +
          'create a new feed when you need one again.',
      });
    } catch (err) {
      fail(err, 'That token could not be revoked.');
    }
  }

  return (
    <>
      <p className="eyebrow">Administration</p>
      <h1 style={{ marginBottom: 'var(--s-4)' }}>Admin</h1>

      {error !== null && (
        <p role="alert" className="admin-alert">
          {error}
        </p>
      )}

      {notice !== null && notice.kind === 'secret' && (
        <div className="secret-banner" role="status">
          <span>
            Password for {notice.email}: <span className="secret-value">{notice.password}</span>
          </span>
          <p className="admin-prose" style={{ marginTop: 'var(--s-2)', marginBottom: 0 }}>
            This is shown once. Copy it now — the server keeps only an argon2id hash and can never
            show it again. {notice.note}
          </p>
          <span className="secret-actions">
            <button
              type="button"
              className="btn"
              aria-label="Copy the password to the clipboard"
              onClick={() => {
                void copyPassword(notice.password);
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

      {notice !== null && notice.kind === 'message' && (
        <p role="status" className="admin-notice">
          {notice.text}
        </p>
      )}

      <section className="admin-section card" aria-label="Accounts">
        <h2>Accounts</h2>
        <p className="admin-prose">
          Members can browse, match, watch, export and read the review Inbox. Admins additionally
          decide review items, configure sources, trigger crawls and manage accounts. Passwords are
          generated here rather than chosen: you never type another person’s password, and the one
          this page shows is the only time it exists outside a hash.
        </p>

        <form className="admin-form" noValidate onSubmit={(e) => void createUser(e)}>
          <label htmlFor="new-email">
            New account email
            <input
              id="new-email"
              type="email"
              autoComplete="off"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </label>
          <label htmlFor="new-role">
            New account role
            <select
              id="new-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as 'admin' | 'member')}
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button type="submit" className="btn btn-primary">
            Create account
          </button>
        </form>

        {users.loading && <p className="eyebrow">Loading…</p>}
        {users.error !== null && (
          <p role="alert" className="admin-alert">
            Could not load accounts ({users.error.code}). {users.error.message}
          </p>
        )}

        {users.data !== null && (
          <div className="admin-table-wrap">
            <table className="grid-table" aria-label="User accounts">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Role</th>
                  <th scope="col" className="num">
                    Created (UTC)
                  </th>
                  <th scope="col" className="num">
                    Last login (UTC)
                  </th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className="admin-row-email">{row.email}</span>
                      <span className="admin-row-meta">
                        {row.isSelf && <span className="admin-tag admin-tag-self">you</span>}
                        {row.disabled && <span className="admin-tag admin-tag-off">disabled</span>}
                        {row.displayName === '' ? 'No display name' : row.displayName}
                      </span>
                      {row.id === lastEnabledAdminId && (
                        <span className="admin-row-note">
                          Last admin who can sign in. GrantSpotter refuses to demote, disable or
                          delete this account, because an instance with no admin who can sign in
                          cannot be recovered from inside the app.
                        </span>
                      )}
                    </td>
                    <td>
                      <select
                        aria-label={`Role for ${row.email}`}
                        value={row.role}
                        onChange={(e) => {
                          void setRole(row, e.target.value as 'admin' | 'member');
                        }}
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="num">{formatDate(row.createdAt)}</td>
                    <td className="num">
                      {row.lastLoginAt === null ? 'Never signed in' : formatDate(row.lastLoginAt)}
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        <button
                          type="button"
                          className="btn"
                          aria-label={
                            row.disabled ? `Enable ${row.email}` : `Disable ${row.email}`
                          }
                          onClick={() => {
                            void setDisabled(row, !row.disabled);
                          }}
                        >
                          {row.disabled ? 'Enable' : 'Disable'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          aria-label={`Reset password for ${row.email}`}
                          onClick={() => {
                            void resetPassword(row);
                          }}
                        >
                          Reset password
                        </button>
                        {/* Absent, not disabled: the server refuses self-deletion
                            outright, so a greyed-out control here would only look
                            like a permissions bug. */}
                        {!row.isSelf && confirmingDeleteId !== row.id && (
                          <button
                            type="button"
                            className="btn"
                            aria-label={`Delete ${row.email}`}
                            onClick={() => {
                              begin();
                              setConfirmingDeleteId(row.id);
                            }}
                          >
                            Delete
                          </button>
                        )}
                        {!row.isSelf && confirmingDeleteId === row.id && (
                          <>
                            <button
                              type="button"
                              className="btn"
                              aria-label={`Permanently delete ${row.email}`}
                              onClick={() => {
                                void deleteUser(row);
                              }}
                            >
                              Delete permanently
                            </button>
                            <button
                              type="button"
                              className="btn"
                              aria-label={`Keep ${row.email}`}
                              onClick={() => setConfirmingDeleteId(null)}
                            >
                              Cancel
                            </button>
                          </>
                        )}
                      </div>
                      {row.isSelf && (
                        <span className="admin-row-note">
                          You cannot delete your own account — another admin can delete it, and
                          disabling it is the reversible path.
                        </span>
                      )}
                      {confirmingDeleteId === row.id && (
                        <span className="admin-row-confirm">
                          Deleting {row.email} also deletes their profiles, watchlist entries,
                          sessions and applications — the server counts them and says what went.
                          The audit trail of what they did is kept. This cannot be undone.
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <EnrollmentCodes now={now} />

      <section className="admin-section card" aria-label="Calendar feed">
        <h2>Calendar feed link</h2>
        <p className="admin-prose">
          Your ICS feed URL carries a token so calendar clients — which cannot send a session
          cookie — can subscribe. Revoke it if that URL has been shared or pasted somewhere public.
          Every subscribed calendar will stop updating until a new link is created.
        </p>
        <p className="admin-prose">
          This revokes only your own feed{user === null ? '' : ` (${user.email})`}. Another
          person’s feed can only be revoked from their own account — being an admin does not reach
          it.
        </p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            void revokeIcsToken();
          }}
        >
          Revoke my calendar feed link
        </button>
      </section>

      <section className="admin-section card danger-zone" aria-label="Backup and restore">
        <h2>Backup and restore</h2>
        <p className="admin-prose">
          The backup is a single JSON document holding the whole corpus, the profiles, the
          watchlists and the review history. Restoring one replaces every program, funder, cycle and
          review item currently in this instance. There is no undo, so download a backup first.
        </p>
        <p className="admin-prose">
          It also replaces the user accounts. Restoring a backup taken before your account existed
          removes it and signs you out, and any account created since that backup is gone with it.
        </p>

        <p>
          <a className="btn" href="/api/admin/backup.json" download>
            Download full backup
          </a>
        </p>

        <div className="admin-form">
          <label htmlFor="restore-file">
            Backup file
            <input
              key={restoreNonce}
              id="restore-file"
              type="file"
              accept="application/json,.json"
              onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <label htmlFor="restore-confirm">
            Type REPLACE to confirm
            <input
              id="restore-confirm"
              type="text"
              autoComplete="off"
              value={confirmWord}
              onChange={(e) => setConfirmWord(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={confirmWord !== CONFIRM_WORD || restoreFile === null}
            onClick={() => {
              void restore();
            }}
          >
            Restore from backup
          </button>
        </div>
      </section>
    </>
  );
}
