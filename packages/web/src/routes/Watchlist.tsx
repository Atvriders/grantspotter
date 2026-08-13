import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Program } from '@grantspotter/core';
import { useApi } from '../store/useApi.js';
import { useSession } from '../store/session.js';
import { apiSend, ApiError } from '../api/client.js';
import { NotificationList, type NotificationRow } from '../components/NotificationList.js';
import { TrustBadge } from '../components/TrustBadge.js';
import { StatusPill } from '../components/StatusPill.js';
import { formatDate, NO_DATE } from '../lib/trust.js';
import { useNarrowerThan } from '../lib/narrowLayout.js';
import '../components/watchlist.css';

/**
 * The first viewport width at which the watched-programmes table fits without scrolling sideways.
 *
 * MEASURED in Chromium against the running instance with six programmes starred,
 * `el.style.width = 'min-content'` on the table: 726 px. Plus `AppShell`'s 208 px rail and 48 px
 * of page padding, that is 982.
 *
 * Below it, each watch becomes a card. This is the screen the brief's club officer is holding at
 * a meeting: one deadline, read once, decided on. Its rows are records, not a matrix — nobody
 * scans the Closes column of their own watchlist looking for an outlier; they read the programme
 * they came for and want to know whether the date under it was published or projected.
 */
export const WATCH_TABLE_MIN_PX = 982;

/** `WatchRow` from `packages/server/src/api/watchRouter.ts`, restated (web never imports server). */
interface WatchRow {
  program: Program;
  funderName: string;
  nextOpensAt: string | null;
  nextClosesAt: string | null;
  /**
   * `false` means the FUNDER published that window; `true` means GrantSpotter projected it from a
   * recurrence rule. Only meaningful when `nextClosesAt` is non-null — the server sends `false`
   * with a null date, which is the absence of a claim, not a funder-published one.
   *
   * No count here on purpose. Three different totals for "how many are funder-published" were
   * committed across this tree at once, and on the corpus that ships the answer is a function of
   * the wall clock: `data/seed/` holds 3 records that declare a funder-published window, of which
   * 2 still resolve to a future deadline on 2026-08-04 and 0 from 2026-10-01, once the ARISS and
   * Yaesu windows close. The census under `Watched programs` counts the rows it is holding
   * instead, so it cannot say something the table contradicts.
   */
  nextIsEstimated: boolean;
  /** IANA zone the instants above are expressed in. `null` = not recorded, never "assume local". */
  nextTimezone: string | null;
}

/** `ChannelConfig` from `packages/server/src/api/channels.ts`. */
interface ChannelConfig {
  inApp: boolean;
  webhookUrl: string | null;
  ntfyServer: string | null;
  ntfyTopic: string | null;
}

/** `DeliveryHealth` — one row per (user, channel). This is what keeps a dead webhook visible. */
interface DeliveryHealth {
  channel: 'webhook' | 'ntfy';
  lastAttemptAt: string;
  lastOkAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

interface ChannelsResponse extends ChannelConfig {
  health?: DeliveryHealth[];
}

/** `DeliveryResult` — the outcome of one attempt. A failure is DATA, not a 500. */
interface DeliveryResult {
  channel: 'webhook' | 'ntfy';
  ok: boolean;
  status?: number;
  error?: string;
}

/** `FanoutHealth` from `packages/server/src/api/notify.ts`. Admin-only. */
interface FanoutHealth {
  pendingEvents: number;
  fannedOutEvents: number;
  zeroRecipientEvents: number;
  suppressed: Array<{ reason: string; events: number; watchers: number }>;
  lastFanoutAt: string | null;
  notifications: { total: number; unread: number };
}

/**
 * The corpus keeps a `safety_warning` record for the Foundation for Amateur Radio because
 * QCWA, ARRL and club pages still tell applicants to "apply at the FAR website" and that domain
 * now redirects to a gambling site. `normalizeRaw` puts the record type on `tags`.
 */
const SAFETY_WARNING_TAG = 'safety_warning';

const CHANNEL_LABEL: Record<DeliveryResult['channel'], string> = {
  webhook: 'Webhook',
  ntfy: 'ntfy',
};

/**
 * The next close date, plus the two facts that qualify it.
 *
 * A deadline is stored as the UTC instant of a LOCAL 23:59 wall time, so the ARRL's
 * "closes 28 February 2027" is `2027-03-01T04:59:00.000Z`. Rendered without its zone that prints
 * 2027-03-01 — one day LATE, which is the direction that costs an applicant the deadline. Migration
 * 037 carries `nextTimezone` this far for exactly this call.
 */
function DeadlineCell({ row }: { row: WatchRow }): JSX.Element {
  if (row.nextClosesAt === null) {
    return (
      <span className="wl-deadline">
        <span className="data">{NO_DATE}</span>
        <span className="wl-qualifier">No close date recorded</span>
      </span>
    );
  }

  const zone =
    row.nextTimezone === null ? 'UTC (no zone recorded)' : row.nextTimezone;
  const provenance = row.nextIsEstimated ? 'Projected' : 'Published by the funder';

  return (
    <span className="wl-deadline">
      <span className="data">{formatDate(row.nextClosesAt, row.nextTimezone)}</span>
      <span
        className={`wl-qualifier${row.nextIsEstimated ? ' wl-qualifier-projected' : ''}`}
        title={
          row.nextIsEstimated
            ? 'Projected from a recurrence rule, not published by the funder for this cycle. ' +
              'Confirm before you rely on it.'
            : 'The funder published this window. It is still worth confirming on their own page.'
        }
      >
        {provenance} · {zone}
      </span>
    </span>
  );
}

/**
 * Everything that makes an empty digest legible.
 *
 * A steady-state night on the real crawl is 553 change events and 0 notifications, by design. The
 * night the ARRL moved a close date AND a parser returned zero was 555 events and 2 notifications;
 * the six following nights of the same broken source delivered nothing more, because a repeat of an
 * unread alarm is suppressed. So "you have no notifications" is the NORMAL output of a healthy
 * pipeline — which is exactly why it must never be rendered as a report that the pipeline ran.
 *
 * `GET /api/notifications/health` separates the three readings, and it is `requireAdmin`: a member
 * is never asked for it (a 403 would render as an outage), and is instead told plainly that this
 * page is not the place that answer lives.
 */
function DigestHealth({
  fanout,
  channelHealth,
  isAdmin,
  quiet,
}: {
  fanout: FanoutHealth | null;
  channelHealth: DeliveryHealth[];
  isAdmin: boolean;
  quiet: boolean;
}): JSX.Element {
  const failing = channelHealth.filter((h) => h.consecutiveFailures > 0);

  return (
    <>
      {failing.map((h) => (
        <p className="wl-note wl-note-warn" role="alert" key={h.channel}>
          {`Your ${CHANNEL_LABEL[h.channel].toLowerCase()} destination has failed ` +
            `${h.consecutiveFailures} deliveries in a row, so nothing below has reached it. ` +
            'The in-app digest you are reading is unaffected — a quiet week and a refused ' +
            'channel are not the same thing.'}
        </p>
      ))}

      {!isAdmin && quiet && (
        <p className="wl-note">
          That is a statement about your watchlist, and not a report on the change pipeline. Whether
          last night’s crawl ran at all is an administrator’s question, and this page cannot answer
          it for you.
        </p>
      )}

      {isAdmin && fanout !== null && (fanout.pendingEvents > 0 || fanout.lastFanoutAt === null) && (
        <p className="wl-note wl-note-warn" role="alert">
          {`Change pipeline: ${fanout.pendingEvents} change events are waiting and have not been ` +
            `fanned out, and the drain ${
              fanout.lastFanoutAt === null ? 'has never run' : `last ran ${formatDate(fanout.lastFanoutAt)}`
            }. An empty digest is therefore not evidence that nothing changed.`}
        </p>
      )}

      {isAdmin && fanout !== null && fanout.pendingEvents === 0 && fanout.lastFanoutAt !== null && (
        <div className="wl-note">
          <span>
            {`Change pipeline: the drain last ran ${formatDate(fanout.lastFanoutAt)} with nothing ` +
              `waiting, across ${fanout.fannedOutEvents} fanned-out events. An empty digest here ` +
              'does mean nothing you watch changed.'}
          </span>
          {fanout.zeroRecipientEvents > 0 && (
            <span>
              {`${fanout.zeroRecipientEvents} of those events reached nobody at all — they concern ` +
                'programmes no user watches.'}
            </span>
          )}
          {fanout.suppressed.length > 0 && (
            <ul className="wl-suppressed">
              {fanout.suppressed.map((s) => (
                <li key={s.reason}>
                  {`${s.reason.replace(/_/g, ' ')}: ${s.events} events, ${s.watchers} watchers`}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isAdmin && fanout === null && (
        <p className="wl-note">
          The change-pipeline check could not be read, so this page cannot say whether an empty
          digest means silence or a stalled drain.
        </p>
      )}
    </>
  );
}

/**
 * Why a save was refused, in words the reader can act on — and never a claim about their input
 * that GrantSpotter is not entitled to make.
 *
 * `apiSend` propagates the transport failure itself (a rejected `fetch`), and `useApi` reports one
 * as `ApiError` with `status: 0`. Answering either with "that delivery target was rejected" would
 * be a false statement about an address the server never saw — the same defect as telling a user
 * their password was wrong when the API was down.
 */
function saveRefusalMessage(err: unknown): string {
  const unreachable =
    !(err instanceof ApiError) || err.status === 0
      ? 'Nothing was saved: the request to GrantSpotter never completed, so the API could not be ' +
        'reached. Your delivery settings are unchanged, and this says nothing about the address ' +
        'you entered.'
      : null;
  if (unreachable !== null) return unreachable;

  const apiError = err as ApiError;
  if (apiError.code === 'validation_failed') {
    return (
      `GrantSpotter refused that delivery target: ${apiError.message} Nothing was saved. This ` +
      'check is not configurable — it is what keeps a notification out of a private address, a ' +
      'cloud metadata endpoint, or a domain that has been taken over since you saved it.'
    );
  }
  return `Nothing was saved: ${apiError.message}`;
}

/** The field the server named, so the input that caused the refusal can be marked. */
function refusedField(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  const field = (details as { field?: unknown }).field;
  return typeof field === 'string' ? field : null;
}

/**
 * The programme's identity, exactly as both layouts show it.
 *
 * The safety note travels WITH the name and not in a column of its own, because the instruction
 * it carries ("do not apply at this funder's former domain") is meaningless detached from the
 * funder it is about — and a card layout that put it anywhere else would be free to lose it.
 */
function WatchName({ row }: { row: WatchRow }): JSX.Element {
  return (
    <span className="wl-name">
      {/* Every link on this page is an in-app path. The corpus deliberately holds a record about
          a hijacked domain, and the one guarantee that survives every future edit is that this
          page opens nothing outbound. */}
      <Link to={`/o/${row.program.id}`}>{row.program.name}</Link>
      <span className="wl-funder">{row.funderName}</span>
      {/*
        `role="note"` and a real sentence, matching the browse row.

        This shipped as a bare `<span>` whose only explanation was a `title`. A `title` is not
        reachable by touch or keyboard and is announced by screen readers inconsistently and only
        as a description, so the one row on this page that carries an instruction not to visit a
        domain was the row whose reason was least likely to be heard.
      */}
      {row.program.tags.includes(SAFETY_WARNING_TAG) && (
        <span className="wl-safety" role="note" aria-label="Safety warning">
          Safety warning — do not apply at this funder&rsquo;s former domain. It no longer belongs
          to them. Open the record for where to apply instead.
        </span>
      )}
    </span>
  );
}

export function Watchlist({ now }: { now?: string }): JSX.Element {
  const nowISO = now ?? new Date().toISOString();
  const session = useSession();
  const isAdmin = session.user?.role === 'admin';
  const stacked = useNarrowerThan(WATCH_TABLE_MIN_PX);

  const watches = useApi<{ rows: WatchRow[] }>('/api/watches');
  const notifications = useApi<{ rows: NotificationRow[]; unread: number }>('/api/notifications');
  const channels = useApi<ChannelsResponse>('/api/channels');
  // `requireAdmin` on the server. Asking as a member would 403, and an outage is exactly what a
  // 403 would be mistaken for on a page whose subject is "what does silence mean".
  const fanout = useApi<FanoutHealth>(isAdmin ? '/api/notifications/health' : null);

  const [form, setForm] = useState<ChannelConfig>({
    inApp: true,
    webhookUrl: null,
    ntfyServer: null,
    ntfyTopic: null,
  });
  const [channelError, setChannelError] = useState<string | null>(null);
  const [channelField, setChannelField] = useState<string | null>(null);
  const [channelSaved, setChannelSaved] = useState(false);
  const [testResults, setTestResults] = useState<DeliveryResult[] | null>(null);
  const [digestError, setDigestError] = useState<string | null>(null);

  useEffect(() => {
    const loaded = channels.data;
    if (loaded === null) return;
    setForm({
      inApp: loaded.inApp,
      webhookUrl: loaded.webhookUrl,
      ntfyServer: loaded.ntfyServer,
      ntfyTopic: loaded.ntfyTopic,
    });
  }, [channels.data]);

  async function markRead(id: string): Promise<void> {
    setDigestError(null);
    try {
      await apiSend('POST', `/api/notifications/${id}/read`);
      notifications.reload();
      // Keeps the rail's unread badge honest without a second source of truth for the count.
      session.refresh();
    } catch (err) {
      setDigestError(
        err instanceof ApiError
          ? `That notification could not be marked read: ${err.message}`
          : 'That notification could not be marked read: the request never completed.',
      );
    }
  }

  async function markAllRead(): Promise<void> {
    setDigestError(null);
    try {
      await apiSend('POST', '/api/notifications/read-all');
      notifications.reload();
      session.refresh();
    } catch (err) {
      setDigestError(
        err instanceof ApiError
          ? `Nothing was marked read: ${err.message}`
          : 'Nothing was marked read: the request never completed.',
      );
    }
  }

  async function unwatch(programId: string): Promise<void> {
    await apiSend('DELETE', `/api/watches/${programId}`).catch(() => null);
    watches.reload();
  }

  async function saveChannels(): Promise<void> {
    setChannelError(null);
    setChannelField(null);
    setChannelSaved(false);
    setTestResults(null);
    try {
      await apiSend('PUT', '/api/channels', form);
      setChannelSaved(true);
      channels.reload();
    } catch (err) {
      setChannelError(saveRefusalMessage(err));
      setChannelField(refusedField(err));
    }
  }

  async function sendTest(): Promise<void> {
    setChannelError(null);
    setChannelSaved(false);
    setTestResults(null);
    try {
      const response = await apiSend<{ results: DeliveryResult[] }>('POST', '/api/channels/test');
      // A refused delivery arrives HERE, as data with a 200 — not as a thrown error. The endpoint
      // is deliberately built that way: a 500 would hide which channel failed and why.
      setTestResults(response.results);
      channels.reload();
    } catch (err) {
      setChannelError(
        err instanceof ApiError
          ? err.message
          : 'The test could not be sent: the request never completed.',
      );
    }
  }

  const watchRows = watches.data?.rows ?? [];
  const digestRows = notifications.data?.rows ?? [];
  const channelHealth = channels.data?.health ?? [];

  // COUNTED FROM THE ROWS ON SCREEN, never from a figure typed into the source.
  //
  // The sentence this replaces lived in a `title` on every projected row and read "Only 4 of the
  // corpus's 244 cycles are funder-published". It was wrong three ways at once: the tree carried
  // 243 and 244 for the same claim, the shipping corpus is neither, and a `title` is unreachable
  // by touch and keyboard and is announced inconsistently by screen readers — so the one number
  // that told a reader how much of this table to distrust was both false and hard to hear.
  // Derived from `watchRows`, it is true for whatever corpus is installed, on whatever day.
  //
  // `nextIsEstimated` is only a claim when a date exists: the server sends `false` alongside a
  // null `nextClosesAt`, so an undated row counted as funder-published would invent 22 published
  // deadlines on a fresh install. Undated rows get their own tally instead of being hidden.
  const datedRows = watchRows.filter((row) => row.nextClosesAt !== null);
  const funderPublishedCount = datedRows.filter((row) => !row.nextIsEstimated).length;
  const projectedCount = datedRows.length - funderPublishedCount;
  const undatedCount = watchRows.length - datedRows.length;

  return (
    <>
      <p className="eyebrow">Subscriptions</p>
      <h1>Watchlist</h1>
      <p className="wl-lede">
        Starring a program subscribes you to every change GrantSpotter detects on it — not just its
        deadline. A star is kept when the program closes, is withdrawn or is reclassified, because a
        program changing state is precisely the event you asked to hear about.
      </p>

      <section className="card wl-panel" aria-labelledby="wl-watched-h">
        <h2 id="wl-watched-h">Watched programs</h2>

        {watches.error !== null && (
          <p className="wl-error" role="alert">
            {`Your watchlist could not be loaded: ${watches.error.message} Nothing here is a ` +
              'statement about what you are watching.'}
          </p>
        )}
        {watches.loading && <p className="eyebrow">Loading…</p>}
        {watches.error === null && !watches.loading && watchRows.length === 0 && (
          <p className="wl-empty">
            You are not watching anything yet. Open any record and choose{' '}
            <strong>Watch this program</strong>.
          </p>
        )}

        {/* `wl-lede` rather than a class of its own: `components/watchlist.css` belongs to another
            pass and this needs no styling that muted 70ch prose does not already give it. */}
        {watchRows.length > 0 && (
          <p className="wl-lede">
            {`Close dates below: ${String(funderPublishedCount)} funder-published, ` +
              `${String(projectedCount)} projected, ${String(undatedCount)} with no close date ` +
              'recorded. A projected date was worked out from the recurrence this program has ' +
              'followed; the funder has not announced it, so confirm it before you plan around it.'}
          </p>
        )}

        {watchRows.length > 0 && stacked && (
          <ul className="wl-record-list" aria-label="Watched programs">
            {watchRows.map((row) => (
              <li key={row.program.id} className="wl-record">
                <WatchName row={row} />
                {/* Markers first, under the name. A card clipped by the bottom of a phone screen
                    has already said what state this programme is in and how old the check is. */}
                <div className="wl-record-marks">
                  <StatusPill status={row.program.trust.status} />
                  <TrustBadge lastVerifiedAt={row.program.trust.lastVerifiedAt} now={nowISO} />
                </div>
                <div className="wl-record-field">
                  <span className="eyebrow">Closes</span>
                  <DeadlineCell row={row} />
                </div>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void unwatch(row.program.id);
                  }}
                >
                  Stop watching
                </button>
              </li>
            ))}
          </ul>
        )}

        {watchRows.length > 0 && !stacked && (
          <div className="wl-scroll">
            <table className="grid-table" aria-label="Watched programs">
              <thead>
                <tr>
                  <th scope="col">Program</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Closes
                  </th>
                  <th scope="col">Provenance</th>
                  <th scope="col">
                    <span className="eyebrow">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {watchRows.map((row) => (
                  <tr key={row.program.id}>
                    <td>
                      <WatchName row={row} />
                    </td>
                    <td>
                      <StatusPill status={row.program.trust.status} />
                    </td>
                    <td className="num">
                      <DeadlineCell row={row} />
                    </td>
                    <td>
                      <TrustBadge lastVerifiedAt={row.program.trust.lastVerifiedAt} now={nowISO} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          void unwatch(row.program.id);
                        }}
                      >
                        Stop watching
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card wl-panel" aria-labelledby="wl-digest-h">
        <div className="wl-head">
          <h2 id="wl-digest-h">Change digest</h2>
          <span className="eyebrow">
            {`${notifications.data?.unread ?? 0} unread`}
          </span>
          <span className="wl-head-spacer" />
          <button
            type="button"
            className="btn"
            onClick={() => {
              void markAllRead();
            }}
          >
            Mark all read
          </button>
        </div>

        {notifications.error !== null && (
          <p className="wl-error" role="alert">
            {`The digest could not be loaded: ${notifications.error.message} An empty list below is ` +
              'this page failing, not a report that nothing changed.'}
          </p>
        )}
        {digestError !== null && (
          <p className="wl-error" role="alert">
            {digestError}
          </p>
        )}

        <DigestHealth
          fanout={fanout.data}
          channelHealth={channelHealth}
          isAdmin={isAdmin}
          quiet={digestRows.length === 0}
        />

        <NotificationList
          rows={digestRows}
          onMarkRead={(id) => {
            void markRead(id);
          }}
        />
      </section>

      <section className="card wl-panel wl-channels" aria-labelledby="wl-delivery-h">
        <h2 id="wl-delivery-h">Delivery</h2>
        {/*
          "AND NO ADDRESS IS STORED" WAS PRINTED TWO INCHES BELOW THE STORED ADDRESS.

          The header of this very page reads `<your email> · MEMBER`: registration takes an email,
          it is the sign-in identifier, `users.email` holds it, and the account header renders it on
          every screen in the product. Whatever that clause was written to promise — almost
          certainly "no mailing list, no digest in your inbox" — as printed it denied storing the
          thing the reader could see on screen, which discredits every other privacy claim this
          page makes, including the true ones.

          The true claims, kept: GrantSpotter runs no mail server and sends no email to anybody,
          and no delivery target below is an address. Those are properties of the software. What
          the account holds is a separate fact and is now stated rather than contradicted.
        */}
        <p className="wl-lede">
          The in-app digest is always on and is the only channel GrantSpotter guarantees. Everything
          below is optional and is delivered to a destination you own. There is no email channel at
          all: no mail server to configure, no digest sent to an inbox, and no field below that
          takes an address. The address you signed in with is stored as your account identifier and
          is used for signing in — nothing is ever delivered to it.
        </p>

        <label className="wl-field" htmlFor="ch-webhook">
          Webhook URL
          <input
            id="ch-webhook"
            type="url"
            value={form.webhookUrl ?? ''}
            placeholder="https://hooks.example.com/grantspotter"
            aria-invalid={channelField === 'webhookUrl' ? 'true' : undefined}
            aria-describedby="ch-webhook-hint"
            onChange={(e) => {
              setForm({ ...form, webhookUrl: e.target.value === '' ? null : e.target.value });
            }}
          />
          <span className="wl-hint" id="ch-webhook-hint">
            https only, and never a private, loopback or link-local address. The check runs again at
            delivery time, because a domain can stop being safe after you save it.
          </span>
        </label>

        <label className="wl-field" htmlFor="ch-ntfy-server">
          ntfy server
          <input
            id="ch-ntfy-server"
            type="url"
            value={form.ntfyServer ?? ''}
            placeholder="https://ntfy.example.com"
            aria-invalid={channelField === 'ntfyServer' ? 'true' : undefined}
            onChange={(e) => {
              setForm({ ...form, ntfyServer: e.target.value === '' ? null : e.target.value });
            }}
          />
        </label>

        <label className="wl-field" htmlFor="ch-ntfy-topic">
          ntfy topic
          <input
            id="ch-ntfy-topic"
            type="text"
            value={form.ntfyTopic ?? ''}
            placeholder="grantspotter-deadlines"
            aria-invalid={channelField === 'ntfyTopic' ? 'true' : undefined}
            aria-describedby="ch-ntfy-hint"
            onChange={(e) => {
              setForm({ ...form, ntfyTopic: e.target.value === '' ? null : e.target.value });
            }}
          />
          <span className="wl-hint" id="ch-ntfy-hint">
            A server without a topic delivers nowhere while looking configured, so GrantSpotter
            takes both or neither.
          </span>
        </label>

        {channelError !== null && (
          <p className="wl-alert" role="alert">
            {channelError}
          </p>
        )}
        {channelSaved && <p role="status">Delivery settings saved.</p>}

        <span className="wl-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void saveChannels();
            }}
          >
            Save delivery settings
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void sendTest();
            }}
          >
            Send a test notification
          </button>
        </span>

        {testResults !== null && (
          <ul className="wl-results" aria-label="Test delivery results">
            {testResults.length === 0 && <li>No external channel was configured, so nothing was sent.</li>}
            {testResults.map((result) => (
              <li key={result.channel} className={result.ok ? 'wl-good' : 'wl-bad'}>
                {`${CHANNEL_LABEL[result.channel]}: ${
                  result.ok
                    ? `delivered${result.status === undefined ? '' : ` (HTTP ${result.status})`}`
                    : `not delivered${result.status === undefined ? '' : ` (HTTP ${result.status})`}${
                        result.error === undefined ? '' : ` — ${result.error}`
                      }`
                }`}
              </li>
            ))}
          </ul>
        )}

        {channelHealth.length > 0 && (
          <>
            <h3>Delivery health</h3>
            <ul className="wl-health">
              {channelHealth.map((h) => (
                <li key={h.channel} className={h.consecutiveFailures > 0 ? 'wl-bad' : 'wl-good'}>
                  <span>
                    {h.consecutiveFailures > 0
                      ? `${CHANNEL_LABEL[h.channel]}: ${h.consecutiveFailures} deliveries in a row have failed${
                          h.lastStatus === null ? '' : ` (last status HTTP ${h.lastStatus})`
                        }${h.lastError === null ? '' : ` — ${h.lastError}`}.`
                      : `${CHANNEL_LABEL[h.channel]}: the last delivery succeeded.`}
                  </span>
                  <span className="eyebrow">
                    Last attempt <span className="data">{formatDate(h.lastAttemptAt)}</span>
                    {' · last success '}
                    {h.lastOkAt === null ? (
                      <span>never</span>
                    ) : (
                      <span className="data">{formatDate(h.lastOkAt)}</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
