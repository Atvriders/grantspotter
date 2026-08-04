import type Database from 'better-sqlite3';
import type { ChangeKind } from '@grantspotter/core';
import { assertNotBlocked } from '../fetcher/blocklist.js';
import { canonicalHostname, embeddedIpv4, ipv6Bytes } from '../net/hosts.js';

/** PLAN-LOCAL to Plan 3. */
export interface ChannelConfig {
  inApp: boolean;
  webhookUrl: string | null;
  ntfyServer: string | null;
  ntfyTopic: string | null;
}

/** PLAN-LOCAL to Plan 3. */
export interface DeliveryResult {
  channel: 'webhook' | 'ntfy';
  ok: boolean;
  status?: number;
  error?: string;
}

/** PLAN-LOCAL to Plan 3. One row per (user, channel); see migration 035. */
export interface DeliveryHealth {
  channel: 'webhook' | 'ntfy';
  lastAttemptAt: string;
  lastOkAt: string | null;
  lastStatus: number | null;
  lastError: string | null;
  consecutiveFailures: number;
}

/**
 * PLAN-LOCAL to Plan 3. Exactly the fields an external delivery reads off a
 * notification, and nothing else.
 *
 * DEVIATION FROM THE TASK BRIEF (2026-08-02), and a deliberate one. The brief
 * has this module `import type { NotificationRow } from './notify.js'`.
 * `notify.ts` is Task 8's file and does not exist yet, and the Global
 * Constraints forbid forward-referencing a module another task has not created
 * — an unresolved import fails `npm run build`, which takes `dist/index.js`,
 * Playwright's `webServer` and the whole e2e suite with it.
 *
 * Structural typing makes the import unnecessary: Task 8's `NotificationRow`
 * (`id`, `userId`, `changeEventId`, `readAt` and these nine fields) is
 * assignable to this type without either module knowing about the other, which
 * is the same seam `RouterDeps` uses to restate Plan 1's auth contract. Field
 * names and types below are copied from the plan's own declaration of
 * `NotificationRow`, so the two cannot drift silently: a rename upstream makes
 * the call site in Task 8's drain fail to typecheck.
 */
export interface DeliverableNotification {
  kind: ChangeKind;
  title: string;
  body: string;
  programId: string | null;
  programName: string | null;
  fieldPath: string | null;
  before: string | null;
  after: string | null;
  createdAt: string;
}

/** A delivery that has not answered in this long is treated as failed. */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Names that only ever mean "somewhere inside this network". RFC 6761
 * (`localhost`, `invalid`), RFC 6762 (`local`), RFC 8375 (`home.arpa`) and the
 * strings ICANN reserved against private use. A single-label host is refused
 * separately: `https://intranet/` resolves through the resolver's search
 * domain, which is by definition an internal name.
 *
 * `invalid` is NOT here. It never resolves, so it is a dead webhook rather than
 * an internal one — the delivery fails, `notification_channel_health` records
 * why, and the user sees it. That is a better outcome than a validator that
 * appears to reject a name on security grounds it does not have.
 */
const INTERNAL_SUFFIXES: readonly string[] = Object.freeze([
  'localhost',
  'local',
  'internal',
  'intranet',
  'lan',
  'corp',
  'private',
  'home.arpa',
]);

function ipv4Reason(octets: readonly number[]): string | null {
  const [a = 0, b = 0] = octets;
  // "This network" — and 0.0.0.0 specifically routes to every local interface.
  if (a === 0) return 'this-network';
  if (a === 10) return 'RFC 1918 private';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-grade NAT';
  if (a === 127) return 'loopback';
  // 169.254.0.0/16 is link-local, and 169.254.169.254 is the cloud instance
  // metadata endpoint on AWS, GCP, Azure, DigitalOcean and Oracle alike. It is
  // the single most valuable destination an SSRF can reach.
  if (a === 169 && b === 254) return 'link-local';
  if (a === 172 && b >= 16 && b <= 31) return 'RFC 1918 private';
  if (a === 192 && b === 0 && octets[2] === 0) return 'IETF protocol assignments';
  if (a === 192 && b === 168) return 'RFC 1918 private';
  if (a === 198 && (b === 18 || b === 19)) return 'benchmarking';
  if (a >= 224 && a <= 239) return 'multicast';
  if (a >= 240) return 'reserved';
  return null;
}

/**
 * Why this IPv6 address is not somewhere a webhook may point, or null.
 *
 * THIS USED TO COMPARE SPELLINGS, and it was the second copy of the defect
 * `net/hosts.ts` was written to end. It asked "do the first five groups read
 * zero, and does the sixth read ffff?", which recognises `::ffff:127.0.0.1`
 * and misses every other way of writing the same destination. Measured against
 * this function before the fix, each one ACCEPTED:
 *
 *     https://[::ffff:0:127.0.0.1]/x   IPv4-translated (RFC 2765) loopback
 *     https://[::ffff:0:c0a8:12b]/x    the same form, LAN address in hex
 *     https://[2002:7f00:1::]/x        6to4 (RFC 3056) around loopback
 *     https://[2002:c0a8:105::1]/x     6to4 around 192.168.1.5
 *
 * Spellings are unbounded and keep arriving; there are only ever sixteen
 * bytes. So the parsing is `net/hosts.ts`'s — one parser, shared with the
 * CONTACT_URL rule — and what stays here is the POLICY, which is genuinely
 * different: a webhook may point at RFC 3849 documentation space (this
 * repository's stand-in for a public address) and may not point at multicast,
 * benchmarking or IETF protocol-assignment space, and the contact-URL rule is
 * the other way round on both. Sharing the policy would have been wrong;
 * sharing the parser is the whole point.
 */
function ipv6Reason(bytes: Uint8Array): string | null {
  if (bytes.every((b) => b === 0)) return 'unspecified';
  if (bytes.every((b, i) => b === (i === 15 ? 1 : 0))) return 'loopback';

  // Before the scope tests below, because an IPv4 address inside an IPv6 one is
  // the destination that actually has to answer: the packet lands on 127.0.0.1
  // however the literal was spelled. `::` and `::1` are checked above because
  // both also read as an IPv4-compatible address, and "loopback" is the more
  // useful answer than "0.0.0.1 is in this-network".
  const v4 = embeddedIpv4(bytes);
  if (v4 !== null) {
    const reason = ipv4Reason(v4.split('.').map((o) => Number(o)));
    if (reason !== null) return reason;
  }

  const firstHextet = ((bytes[0] as number) << 8) | (bytes[1] as number);
  if ((firstHextet & 0xfe00) === 0xfc00) return 'unique-local';
  if ((firstHextet & 0xffc0) === 0xfe80) return 'link-local';
  if ((firstHextet & 0xff00) === 0xff00) return 'multicast';
  return null;
}

/**
 * A user-supplied outbound URL is a server-side request forgery surface: the
 * server, not the user, opens the connection, so it reaches everything the
 * user cannot — loopback services, the RFC 1918 LAN around a self-hosted
 * deployment, and the cloud metadata endpoint at 169.254.169.254.
 *
 * WHAT IS ALLOWED: `https` to a public host, on any port. Ports are open
 * because a self-hosted ntfy commonly answers on 8443 and refusing that would
 * push users to the plaintext they should not use; the residual risk is a
 * blind timing scan of PUBLIC ports only, since every internal destination is
 * already refused by address.
 *
 * WHAT IS REFUSED, and why each one:
 *   - anything but https. `http` would let a MITM read the change feed and,
 *     more to the point, `http://169.254.169.254/` is how the metadata service
 *     is actually reached; `file:`, `gopher:` and friends are refused with it.
 *   - embedded credentials, which leak into logs and make `@`-confusion URLs
 *     readable as something they are not.
 *   - loopback, this-network, RFC 1918, CGNAT, link-local (which is where
 *     cloud metadata lives), IETF-assignment, benchmarking, multicast and
 *     reserved IPv4; and unspecified, loopback, unique-local, link-local and
 *     multicast IPv6 — INCLUDING the IPv4-mapped, IPv4-compatible and NAT64
 *     forms, which are the same destinations spelled differently.
 *   - any IPv6 literal this module cannot parse. An address whose scope is
 *     unknown is not an address to POST to.
 *   - single-label hosts and the special-use internal suffixes.
 *   - every host in the fetcher blocklist, so the rule that keeps a crawler
 *     off a hijacked domain cannot be routed around by pasting it into a
 *     webhook field instead.
 *
 * The documentation ranges (RFC 5737 TEST-NET-1/2/3, RFC 3849 2001:db8::/32)
 * are deliberately ALLOWED. They are this repo's stand-in for a real public
 * address — the Global Constraints forbid real hosts anywhere, including test
 * URLs — and they are globally non-routable rather than internal, so allowing
 * them adds no reachable destination.
 *
 * WHAT THIS CANNOT DO: it validates a URL, not a socket. A public hostname
 * whose DNS answers 127.0.0.1 today, or answers differently on the second
 * lookup, is not stopped here — that is DNS rebinding, and closing it needs
 * resolve-then-pin inside the HTTP client. Three things bound the damage
 * instead: `redirect: 'error'` in {@link deliverExternal}, so a public
 * endpoint cannot 302 into the metadata service; the response body is never
 * read, stored or returned, so the forgery stays blind; and only an
 * authenticated user can configure a destination, and only for themselves.
 *
 * Synchronous and throwing, not async. `assertNotBlocked` is synchronous
 * (`packages/server/src/fetcher/blocklist.ts`), and an async validator whose
 * rejection is easy to leave un-awaited fails OPEN — it would permit
 * everything while looking like it checked. There is deliberately no boolean
 * form, for the same reason `assertNotBlocked` has none.
 */
export function assertSafeWebhookUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error('webhook URLs must use https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('webhook URLs must not embed credentials');
  }

  // `url.hostname` and never the raw string: WHATWG normalizes 2130706433,
  // 0x7f000001, 017700000001 and 127.1 to 127.0.0.1 before this reads it, and
  // a check against the raw text would see none of them.
  //
  // `canonicalHostname` and not a `.replace(/\.$/, '')` written here. That
  // expression was this repository's fourth inline copy and the one nobody
  // unified, and one dot deep is not enough: `new URL` keeps the hostname of
  // `https://localhost../` as `localhost..`, one dot came off, and what was
  // left was neither `localhost` nor a dotted-quad, so it fell to the
  // multi-label branch and was ACCEPTED. Measured before the fix, all three
  // accepted by this function: `https://localhost../`, `https://127.0.0.1../`,
  // `https://192.168.1.5../`. A resolver treats every trailing dot as the same
  // root, so an SSRF guard that does not is not a guard.
  const host = canonicalHostname(url.hostname);
  const refuse = (why: string): never => {
    throw new Error(`refusing a private or internal webhook host (${why}): ${host}`);
  };

  if (host.startsWith('[')) {
    const bytes = ipv6Bytes(host);
    if (bytes === null) refuse('unparseable IPv6 literal');
    const reason = ipv6Reason(bytes as Uint8Array);
    if (reason !== null) refuse(reason);
  } else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const reason = ipv4Reason(host.split('.').map((o) => Number(o)));
    if (reason !== null) refuse(reason);
  } else {
    if (!host.includes('.')) refuse('single-label name');
    for (const suffix of INTERNAL_SUFFIXES) {
      if (host === suffix || host.endsWith(`.${suffix}`)) refuse(`special-use name .${suffix}`);
    }
  }

  assertNotBlocked(raw);
}

export function loadChannel(db: Database.Database, userId: string): ChannelConfig {
  const row = db
    .prepare(
      'SELECT in_app, webhook_url, ntfy_server, ntfy_topic FROM notification_channels WHERE user_id = ?',
    )
    .get(userId) as
    | {
        in_app: number;
        webhook_url: string | null;
        ntfy_server: string | null;
        ntfy_topic: string | null;
      }
    | undefined;
  if (row === undefined) return { inApp: true, webhookUrl: null, ntfyServer: null, ntfyTopic: null };
  return {
    inApp: row.in_app === 1,
    webhookUrl: row.webhook_url,
    ntfyServer: row.ntfy_server,
    ntfyTopic: row.ntfy_topic,
  };
}

export function saveChannel(
  db: Database.Database,
  userId: string,
  config: ChannelConfig,
  nowISO: string,
): void {
  db.prepare(
    `INSERT INTO notification_channels
       (user_id, in_app, webhook_url, ntfy_server, ntfy_topic, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       in_app = excluded.in_app,
       webhook_url = excluded.webhook_url,
       ntfy_server = excluded.ntfy_server,
       ntfy_topic = excluded.ntfy_topic,
       updated_at = excluded.updated_at`,
  ).run(
    userId,
    config.inApp ? 1 : 0,
    config.webhookUrl,
    config.ntfyServer,
    config.ntfyTopic,
    nowISO,
  );
}

/**
 * Every external delivery attempt, durable. This is what keeps "no grant
 * changed this week" distinguishable from "the webhook has been refusing
 * connections since Tuesday": the second leaves a `consecutive_failures` that
 * climbs and a `last_error` naming the reason, and `GET /api/channels` returns
 * both. A delivery that failed silently would be indistinguishable from one
 * that was never needed.
 */
export function recordDelivery(
  db: Database.Database,
  userId: string,
  results: readonly DeliveryResult[],
  nowISO: string,
): void {
  const upsert = db.prepare(
    `INSERT INTO notification_channel_health
       (user_id, channel, last_attempt_at, last_ok_at, last_status, last_error, consecutive_failures)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, channel) DO UPDATE SET
       last_attempt_at = excluded.last_attempt_at,
       last_ok_at = COALESCE(excluded.last_ok_at, notification_channel_health.last_ok_at),
       last_status = excluded.last_status,
       last_error = excluded.last_error,
       consecutive_failures = CASE
         WHEN excluded.consecutive_failures = 0 THEN 0
         ELSE notification_channel_health.consecutive_failures + 1
       END`,
  );
  db.transaction(() => {
    for (const result of results) {
      upsert.run(
        userId,
        result.channel,
        nowISO,
        result.ok ? nowISO : null,
        result.status ?? null,
        result.ok ? null : (result.error ?? `HTTP ${result.status ?? 'error'}`),
        result.ok ? 0 : 1,
      );
    }
  })();
}

export function loadDeliveryHealth(db: Database.Database, userId: string): DeliveryHealth[] {
  const rows = db
    .prepare(
      `SELECT channel, last_attempt_at, last_ok_at, last_status, last_error, consecutive_failures
         FROM notification_channel_health WHERE user_id = ? ORDER BY channel`,
    )
    .all(userId) as Array<{
    channel: 'webhook' | 'ntfy';
    last_attempt_at: string;
    last_ok_at: string | null;
    last_status: number | null;
    last_error: string | null;
    consecutive_failures: number;
  }>;
  return rows.map((row) => ({
    channel: row.channel,
    lastAttemptAt: row.last_attempt_at,
    lastOkAt: row.last_ok_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    consecutiveFailures: row.consecutive_failures,
  }));
}

async function attempt(
  channel: 'webhook' | 'ntfy',
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<DeliveryResult> {
  // Revalidated here and not only at save time. `farweb.org` was ADDED to the
  // blocklist after its domain was hijacked, so a URL that was safe on the day
  // it was stored can stop being safe without anyone editing the row.
  try {
    assertSafeWebhookUrl(url);
  } catch (err) {
    return { channel, ok: false, error: (err as Error).message };
  }
  try {
    const response = await fetchImpl(url, {
      ...init,
      // A validated public host that answers 302 Location: http://169.254.169.254/
      // would otherwise walk straight past every check above.
      redirect: 'error',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    // The response BODY is never read, stored or returned — only ok/status.
    // That is what keeps this forgery blind even if a destination check is
    // ever wrong: there is no channel by which the answer reaches a user.
    return response.ok
      ? { channel, ok: true, status: response.status }
      : { channel, ok: false, status: response.status };
  } catch (err) {
    return { channel, ok: false, error: (err as Error).message };
  }
}

/**
 * Push one notification to whatever external channels the user configured.
 * Never throws and never short-circuits: a dead webhook must not break the
 * in-app digest, and must not stop the ntfy delivery beside it.
 */
export async function deliverExternal(
  config: ChannelConfig,
  n: DeliverableNotification,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult[]> {
  const out: DeliveryResult[] = [];

  if (config.webhookUrl !== null) {
    out.push(
      await attempt(
        'webhook',
        config.webhookUrl,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            source: 'grantspotter',
            kind: n.kind,
            title: n.title,
            body: n.body,
            programId: n.programId,
            programName: n.programName,
            fieldPath: n.fieldPath,
            before: n.before,
            after: n.after,
            createdAt: n.createdAt,
          }),
        },
        fetchImpl,
      ),
    );
  }

  if (config.ntfyServer !== null && config.ntfyTopic !== null) {
    const url = `${config.ntfyServer.replace(/\/+$/, '')}/${config.ntfyTopic}`;
    out.push(
      await attempt(
        'ntfy',
        url,
        {
          method: 'POST',
          headers: { Title: n.title, 'content-type': 'text/plain; charset=utf-8' },
          body: n.body,
        },
        fetchImpl,
      ),
    );
  }

  return out;
}

/**
 * The whole delivery path for one user: load the configuration, attempt every
 * external channel, record the outcome. This is the single entry point Task
 * 8's change-event fan-out (and Task 9's own test route) calls — the seam is
 * deliberately one function so no caller can deliver without recording, which
 * is the only way a failure stays visible.
 */
export async function deliverForUser(
  db: Database.Database,
  userId: string,
  n: DeliverableNotification,
  nowISO: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult[]> {
  const results = await deliverExternal(loadChannel(db, userId), n, fetchImpl);
  if (results.length > 0) recordDelivery(db, userId, results, nowISO);
  return results;
}
