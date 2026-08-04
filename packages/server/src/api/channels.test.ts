import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedTestUser } from '../test/fixtures/programs.js';
import {
  assertSafeWebhookUrl,
  loadChannel,
  saveChannel,
  deliverExternal,
  recordDelivery,
  loadDeliveryHealth,
  deliverForUser,
  type DeliverableNotification,
} from './channels.js';

const NOW = '2026-08-02T12:00:00.000Z';
const LATER = '2026-08-02T13:00:00.000Z';

/**
 * Task 8 owns `NotificationRow`; this is the subset of it that delivery reads.
 * See the note on {@link DeliverableNotification} for why this file does not
 * import Task 8's type.
 */
const notification: DeliverableNotification = {
  programId: 'arrl-foundation-scholarship',
  programName: 'ARRL Foundation Scholarship Program',
  kind: 'deadline_changed',
  title: 'Deadline changed: ARRL Foundation Scholarship Program',
  body: 'Changed from 2027-01-31T17:00:00.000Z to 2026-12-30T17:00:00.000Z (deadline.closesAt).',
  fieldPath: 'deadline.closesAt',
  before: '2027-01-31T17:00:00.000Z',
  after: '2026-12-30T17:00:00.000Z',
  createdAt: NOW,
};

describe('assertSafeWebhookUrl', () => {
  it('accepts a plain https URL', () => {
    expect(() => assertSafeWebhookUrl('https://hooks.example.com/grantspotter')).not.toThrow();
  });

  it('accepts a non-default port, because self-hosted ntfy routinely uses one', () => {
    expect(() => assertSafeWebhookUrl('https://ntfy.example.com:8443/topic')).not.toThrow();
  });

  it('accepts every documentation range, which is what tests use', () => {
    // RFC 5737 TEST-NET-1/2/3. These are the repo-wide stand-in for a real
    // public address (Global Constraints: no real LAN IPs anywhere), and none
    // of them is internal-scoped, so refusing them would refuse the fixtures.
    expect(() => assertSafeWebhookUrl('https://192.0.2.10/hooks/grantspotter')).not.toThrow();
    expect(() => assertSafeWebhookUrl('https://198.51.100.7/hooks/grantspotter')).not.toThrow();
    expect(() => assertSafeWebhookUrl('https://203.0.113.9/hooks/grantspotter')).not.toThrow();
  });

  it('rejects http', () => {
    expect(() => assertSafeWebhookUrl('http://hooks.example.com/x')).toThrow(/https/i);
  });

  it('rejects non-web schemes outright', () => {
    for (const raw of ['file:///etc/passwd', 'gopher://example.com/x', 'ftp://example.com/x']) {
      expect(() => assertSafeWebhookUrl(raw)).toThrow(/https/i);
    }
  });

  it('rejects loopback', () => {
    expect(() => assertSafeWebhookUrl('https://127.0.0.1/x')).toThrow(/private/i);
    expect(() => assertSafeWebhookUrl('https://localhost/x')).toThrow(/private/i);
  });

  it('rejects RFC 1918 and link-local literals', () => {
    expect(() => assertSafeWebhookUrl('https://10.1.2.3/x')).toThrow(/private/i);
    expect(() => assertSafeWebhookUrl('https://172.16.4.5/x')).toThrow(/private/i);
    expect(() => assertSafeWebhookUrl('https://192.168.1.9/x')).toThrow(/private/i);
    expect(() => assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).toThrow(/private/i);
  });

  /**
   * The bypass a dotted-quad regex cannot see. WHATWG `new URL` normalizes
   * decimal, hex, octal and short-form IPv4 to dotted decimal BEFORE any check
   * runs, so these all arrive as 127.0.0.1 — but only if the check reads
   * `url.hostname` rather than the raw string. Asserted so a future refactor
   * that pattern-matches the raw input fails here.
   */
  it('rejects the alternate encodings of 127.0.0.1', () => {
    for (const raw of [
      'https://2130706433/x',
      'https://0x7f000001/x',
      'https://017700000001/x',
      'https://127.1/x',
    ]) {
      expect(() => assertSafeWebhookUrl(raw), raw).toThrow(/private/i);
    }
  });

  it('rejects 0.0.0.0, which routes to every local interface', () => {
    expect(() => assertSafeWebhookUrl('https://0.0.0.0/x')).toThrow(/private/i);
  });

  it('rejects the reserved IPv4 ranges an internal host can hide in', () => {
    for (const raw of [
      'https://100.64.0.1/x', // CGNAT
      'https://192.0.0.8/x', // IETF protocol assignments
      'https://198.18.0.1/x', // benchmarking
      'https://224.0.0.1/x', // multicast
      'https://255.255.255.255/x', // broadcast
    ]) {
      expect(() => assertSafeWebhookUrl(raw), raw).toThrow(/private/i);
    }
  });

  it('rejects internal IPv6 literals, including the IPv4-mapped disguise', () => {
    for (const raw of [
      'https://[::1]/x', // loopback
      'https://[::]/x', // unspecified
      'https://[fd00::1]/x', // unique local
      'https://[fc00::1]/x', // unique local
      'https://[fe80::1]/x', // link local
      'https://[ff02::1]/x', // multicast
      'https://[::ffff:127.0.0.1]/x', // IPv4-mapped loopback
      'https://[::ffff:169.254.169.254]/x', // IPv4-mapped cloud metadata
      'https://[::ffff:10.1.2.3]/x', // IPv4-mapped RFC 1918
    ]) {
      expect(() => assertSafeWebhookUrl(raw), raw).toThrow(/private/i);
    }
  });

  it('accepts a public IPv6 literal', () => {
    // RFC 3849 documentation prefix — the IPv6 equivalent of TEST-NET.
    expect(() => assertSafeWebhookUrl('https://[2001:db8::1]/x')).not.toThrow();
  });

  it('rejects a single-label host, which resolves through the search domain', () => {
    expect(() => assertSafeWebhookUrl('https://intranet/x')).toThrow(/private/i);
  });

  it('rejects the special-use internal name suffixes', () => {
    for (const raw of [
      'https://printer.local/x',
      'https://api.internal/x',
      'https://box.lan/x',
      'https://app.corp/x',
      'https://thing.home.arpa/x',
      'https://svc.localhost/x',
    ]) {
      expect(() => assertSafeWebhookUrl(raw), raw).toThrow(/private/i);
    }
  });

  it('rejects embedded credentials', () => {
    expect(() => assertSafeWebhookUrl('https://user:pass@hooks.example.com/x')).toThrow(
      /credential/i,
    );
  });

  it('rejects a blocklisted host, so the fetcher rule cannot be routed around', () => {
    expect(() => assertSafeWebhookUrl('https://farweb.org/hook')).toThrow();
  });

  it('rejects a subdomain of a blocklisted host', () => {
    expect(() => assertSafeWebhookUrl('https://api.instrumentl.com/hook')).toThrow();
    expect(() => assertSafeWebhookUrl('https://fconline.foundationcenter.org/hook')).toThrow();
  });

  it('rejects garbage', () => {
    expect(() => assertSafeWebhookUrl('not a url')).toThrow();
  });
});

describe('channel storage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    // `notification_channels.user_id` REFERENCES users(id) ON DELETE CASCADE
    // and `openDatabase` sets PRAGMA foreign_keys = ON, so the row needs a
    // parent (the same rule RESOLUTIONS R19 spells out for `watches`).
    seedTestUser(db, 'u-member');
    seedTestUser(db, 'u-other');
  });

  afterEach(() => {
    db.close();
  });

  it('defaults to in-app only', () => {
    expect(loadChannel(db, 'u-member')).toEqual({
      inApp: true, webhookUrl: null, ntfyServer: null, ntfyTopic: null,
    });
  });

  it('round-trips a saved configuration', () => {
    saveChannel(db, 'u-member', {
      inApp: true,
      webhookUrl: 'https://hooks.example.com/grantspotter',
      ntfyServer: 'https://ntfy.example.com',
      ntfyTopic: 'grantspotter-deadlines',
    }, NOW);
    expect(loadChannel(db, 'u-member')).toEqual({
      inApp: true,
      webhookUrl: 'https://hooks.example.com/grantspotter',
      ntfyServer: 'https://ntfy.example.com',
      ntfyTopic: 'grantspotter-deadlines',
    });
  });

  it('overwrites rather than accumulating, and can clear back to in-app only', () => {
    saveChannel(db, 'u-member', {
      inApp: true, webhookUrl: 'https://hooks.example.com/one',
      ntfyServer: null, ntfyTopic: null,
    }, NOW);
    saveChannel(db, 'u-member', {
      inApp: false, webhookUrl: null, ntfyServer: null, ntfyTopic: null,
    }, LATER);
    expect(loadChannel(db, 'u-member')).toEqual({
      inApp: false, webhookUrl: null, ntfyServer: null, ntfyTopic: null,
    });
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM notification_channels WHERE user_id = ?')
      .get('u-member') as { n: number };
    expect(count.n).toBe(1);
  });

  it('keeps one user out of another user’s configuration', () => {
    saveChannel(db, 'u-member', {
      inApp: true, webhookUrl: 'https://hooks.example.com/mine',
      ntfyServer: null, ntfyTopic: null,
    }, NOW);
    expect(loadChannel(db, 'u-other').webhookUrl).toBeNull();
  });

  /**
   * A webhook URL is a destination the deployment will POST to. Leaving one
   * behind after the account it belonged to is gone is a live outbound
   * endpoint with no owner, so the row cascades exactly as `watches` does.
   */
  it('drops the configuration with the user, leaving no orphan destination', () => {
    saveChannel(db, 'u-member', {
      inApp: true, webhookUrl: 'https://hooks.example.com/mine',
      ntfyServer: null, ntfyTopic: null,
    }, NOW);
    recordDelivery(db, 'u-member', [{ channel: 'webhook', ok: true, status: 204 }], NOW);
    db.prepare('DELETE FROM users WHERE id = ?').run('u-member');
    const channels = db
      .prepare('SELECT COUNT(*) AS n FROM notification_channels')
      .get() as { n: number };
    const health = db
      .prepare('SELECT COUNT(*) AS n FROM notification_channel_health')
      .get() as { n: number };
    expect([channels.n, health.n]).toEqual([0, 0]);
  });
});

describe('deliverExternal', () => {
  it('does nothing when only in-app is configured', async () => {
    const fetchImpl = vi.fn();
    const results = await deliverExternal(
      { inApp: true, webhookUrl: null, ntfyServer: null, ntfyTopic: null },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs a JSON body to the webhook', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const results = await deliverExternal(
      { inApp: true, webhookUrl: 'https://hooks.example.com/gs', ntfyServer: null, ntfyTopic: null },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(results).toEqual([{ channel: 'webhook', ok: true, status: 204 }]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/gs');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(init.body as string);
    expect(sent.kind).toBe('deadline_changed');
    expect(sent.after).toBe('2026-12-30T17:00:00.000Z');
  });

  /**
   * A public webhook that answers 302 Location: http://169.254.169.254/ is the
   * whole point of validating the URL and then following the redirect anyway.
   * `redirect: 'error'` is what makes the host check mean something at the
   * socket, and the timeout is what stops a blackholed destination from
   * wedging the fan-out that calls this.
   */
  it('refuses to follow redirects and bounds the attempt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    await deliverExternal(
      { inApp: true, webhookUrl: 'https://hooks.example.com/gs', ntfyServer: null, ntfyTopic: null },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('POSTs the plain-text body to ntfy with a title header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await deliverExternal(
      {
        inApp: true, webhookUrl: null,
        ntfyServer: 'https://ntfy.example.com', ntfyTopic: 'grantspotter-deadlines',
      },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ntfy.example.com/grantspotter-deadlines');
    expect((init.headers as Record<string, string>).Title)
      .toBe('Deadline changed: ARRL Foundation Scholarship Program');
    expect(init.body).toContain('2026-12-30T17:00:00.000Z');
  });

  it('does not double a trailing slash on the ntfy server', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await deliverExternal(
      {
        inApp: true, webhookUrl: null,
        ntfyServer: 'https://ntfy.example.com/', ntfyTopic: 'grantspotter-deadlines',
      },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0])
      .toBe('https://ntfy.example.com/grantspotter-deadlines');
  });

  it('delivers to both channels when both are configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const results = await deliverExternal(
      {
        inApp: true, webhookUrl: 'https://hooks.example.com/gs',
        ntfyServer: 'https://ntfy.example.com', ntfyTopic: 'gs',
      },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(results.map((r) => r.channel)).toEqual(['webhook', 'ntfy']);
  });

  it('reports a failed delivery instead of throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const results = await deliverExternal(
      { inApp: true, webhookUrl: 'https://hooks.example.com/gs', ntfyServer: null, ntfyTopic: null },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(results).toEqual([{ channel: 'webhook', ok: false, error: 'ECONNREFUSED' }]);
  });

  it('reports a non-2xx as a failure, not a success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    const results = await deliverExternal(
      { inApp: true, webhookUrl: 'https://hooks.example.com/gs', ntfyServer: null, ntfyTopic: null },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(results).toEqual([{ channel: 'webhook', ok: false, status: 500 }]);
  });

  it('a dead webhook does not stop the ntfy delivery beside it', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const results = await deliverExternal(
      {
        inApp: true, webhookUrl: 'https://hooks.example.com/gs',
        ntfyServer: 'https://ntfy.example.com', ntfyTopic: 'gs',
      },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(results).toEqual([
      { channel: 'webhook', ok: false, error: 'ECONNREFUSED' },
      { channel: 'ntfy', ok: true, status: 200 },
    ]);
  });

  /**
   * Defence in depth, and not hypothetical: `farweb.org` was ADDED to the
   * blocklist after its domain was hijacked, so a URL that passed validation
   * on the day it was saved can become one the fetcher refuses. Revalidating
   * at delivery means the stored row cannot outlive the rule.
   */
  it('revalidates the stored URL and refuses one that has since become unsafe', async () => {
    const fetchImpl = vi.fn();
    const results = await deliverExternal(
      { inApp: true, webhookUrl: 'https://farweb.org/hook', ntfyServer: null, ntfyTopic: null },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.error).toMatch(/blocked host/i);
  });

  it('never puts the response body anywhere a caller could read it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('ami-0123456789 SECRET-METADATA'),
    });
    const results = await deliverExternal(
      { inApp: true, webhookUrl: 'https://hooks.example.com/gs', ntfyServer: null, ntfyTopic: null },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(JSON.stringify(results)).not.toContain('SECRET-METADATA');
    expect(Object.keys(results[0] ?? {}).sort()).toEqual(['channel', 'ok', 'status']);
  });
});

describe('delivery health', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedTestUser(db, 'u-member');
  });

  afterEach(() => {
    db.close();
  });

  /**
   * The precedent this exists for: an absence of notifications must not look
   * the same as a webhook that has been failing for a week. Health is written
   * on every attempt and read back by `GET /api/channels`.
   */
  it('starts empty, because nothing has been attempted', () => {
    expect(loadDeliveryHealth(db, 'u-member')).toEqual([]);
  });

  it('records a success', () => {
    recordDelivery(db, 'u-member', [{ channel: 'webhook', ok: true, status: 204 }], NOW);
    expect(loadDeliveryHealth(db, 'u-member')).toEqual([
      {
        channel: 'webhook',
        lastAttemptAt: NOW,
        lastOkAt: NOW,
        lastStatus: 204,
        lastError: null,
        consecutiveFailures: 0,
      },
    ]);
  });

  it('counts consecutive failures and keeps the last success visible', () => {
    recordDelivery(db, 'u-member', [{ channel: 'webhook', ok: true, status: 204 }], NOW);
    recordDelivery(db, 'u-member', [{ channel: 'webhook', ok: false, error: 'ECONNREFUSED' }], LATER);
    recordDelivery(db, 'u-member', [{ channel: 'webhook', ok: false, status: 500 }], LATER);
    const [health] = loadDeliveryHealth(db, 'u-member');
    expect(health?.consecutiveFailures).toBe(2);
    expect(health?.lastOkAt).toBe(NOW);
    expect(health?.lastAttemptAt).toBe(LATER);
  });

  it('resets the failure streak once a delivery lands', () => {
    recordDelivery(db, 'u-member', [{ channel: 'webhook', ok: false, error: 'ECONNREFUSED' }], NOW);
    recordDelivery(db, 'u-member', [{ channel: 'webhook', ok: true, status: 204 }], LATER);
    const [health] = loadDeliveryHealth(db, 'u-member');
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.lastError).toBeNull();
  });

  it('tracks the two channels separately', () => {
    recordDelivery(
      db,
      'u-member',
      [
        { channel: 'webhook', ok: false, error: 'ECONNREFUSED' },
        { channel: 'ntfy', ok: true, status: 200 },
      ],
      NOW,
    );
    const health = loadDeliveryHealth(db, 'u-member');
    expect(health.map((h) => [h.channel, h.consecutiveFailures])).toEqual([
      ['ntfy', 0],
      ['webhook', 1],
    ]);
  });
});

describe('deliverForUser', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedTestUser(db, 'u-member');
  });

  afterEach(() => {
    db.close();
  });

  it('is a no-op for a user who has configured nothing', async () => {
    const fetchImpl = vi.fn();
    const results = await deliverForUser(
      db, 'u-member', notification, NOW, fetchImpl as unknown as typeof fetch,
    );
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loadDeliveryHealth(db, 'u-member')).toEqual([]);
  });

  it('delivers and leaves the failure recorded where a reader can find it', async () => {
    saveChannel(db, 'u-member', {
      inApp: true, webhookUrl: 'https://hooks.example.com/gs',
      ntfyServer: null, ntfyTopic: null,
    }, NOW);
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const results = await deliverForUser(
      db, 'u-member', notification, LATER, fetchImpl as unknown as typeof fetch,
    );
    expect(results).toEqual([{ channel: 'webhook', ok: false, error: 'ECONNREFUSED' }]);
    expect(loadDeliveryHealth(db, 'u-member')).toEqual([
      {
        channel: 'webhook',
        lastAttemptAt: LATER,
        lastOkAt: null,
        lastStatus: null,
        lastError: 'ECONNREFUSED',
        consecutiveFailures: 1,
      },
    ]);
  });
});
