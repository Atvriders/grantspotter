import type Database from 'better-sqlite3';
import type { ChangeKind } from '@grantspotter/core';
import { assertNotBlocked } from '../fetcher/blocklist.js';

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
 * Expand an IPv6 literal (brackets already stripped) into eight 16-bit groups.
 * Returns null for anything it cannot parse, and the caller refuses those —
 * an address whose scope cannot be determined is not an address to POST to.
 */
function expandIpv6(text: string): number[] | null {
  const zoned = text.split('%')[0] ?? '';
  const halves = zoned.split('::');
  if (halves.length > 2) return null;

  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      // A trailing dotted quad, as in ::ffff:127.0.0.1, occupies two groups.
      if (piece.includes('.')) {
        const octets = piece.split('.');
        if (octets.length !== 4) return null;
        const nums = octets.map((o) => Number(o));
        if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        groups.push(((nums[0] ?? 0) << 8) | (nums[1] ?? 0), ((nums[2] ?? 0) << 8) | (nums[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(Number.parseInt(piece, 16));
    }
    return groups;
  };

  const head = parse(halves[0] ?? '');
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = parse(halves[1] ?? '');
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

function ipv6Reason(groups: readonly number[]): string | null {
  const leading = groups.slice(0, 5).every((g) => g === 0);
  const embedded = (): string | null =>
    ipv4Reason([
      ((groups[6] ?? 0) >> 8) & 0xff,
      (groups[6] ?? 0) & 0xff,
      ((groups[7] ?? 0) >> 8) & 0xff,
      (groups[7] ?? 0) & 0xff,
    ]) ?? null;

  if (groups.every((g) => g === 0)) return 'unspecified';
  if (leading && groups[5] === 0 && groups[6] === 0 && groups[7] === 1) return 'loopback';
  // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 hat, and the reason a
  // check that stops at "is this IPv6?" lets 127.0.0.1 straight through.
  if (leading && groups[5] === 0xffff) return embedded() ?? null;
  // ::a.b.c.d, the deprecated IPv4-compatible form, and 64:ff9b::/96 (NAT64)
  // reach the same IPv4 destination by a different route.
  if (leading && groups[5] === 0) return embedded() ?? null;
  if (groups[0] === 0x64 && groups[1] === 0xff9b) return embedded() ?? null;
  if (((groups[0] ?? 0) & 0xfe00) === 0xfc00) return 'unique-local';
  if (((groups[0] ?? 0) & 0xffc0) === 0xfe80) return 'link-local';
  if (((groups[0] ?? 0) & 0xff00) === 0xff00) return 'multicast';
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
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const refuse = (why: string): never => {
    throw new Error(`refusing a private or internal webhook host (${why}): ${host}`);
  };

  if (host.startsWith('[')) {
    const groups = expandIpv6(host.slice(1, -1));
    if (groups === null) refuse('unparseable IPv6 literal');
    const reason = ipv6Reason(groups as number[]);
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
