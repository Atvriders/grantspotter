import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError, buildUserAgent } from '../config.js';
import { BlockedHostError } from './blocklist.js';
import { ROBOTS_MAX_REDIRECTS, RobotsDisallowedError } from './robots.js';
import { ROBOTS_CACHE_TTL_MS, backoffMs, createFetcher } from './index.js';

/**
 * NOT `https://grantspotter.example.test/about`, which is what this was until 2026-08-04.
 *
 * `.test` is an RFC 6761 reserved TLD, and `loadConfig` has refused it for CONTACT_URL since the
 * day that rule was written — so this file was building its User-Agent out of a value the server
 * would not start on. That was harmless while `buildUserAgent` validated nothing and exactly the
 * inconsistency the 2026-08-04 remediation is about: one rule, applied on one path. It validates
 * now, so the fixture has to be a value a real deployment could hold.
 */
const CONTACT = 'https://w9xyz-radio-club.org/grantspotter';

function res(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) },
  });
}

/** Routes by URL; every unmatched URL is a test failure. */
function router(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const transport = vi.fn(async (url: string) => {
    calls.push(url);
    const make = routes[url];
    if (!make) throw new Error(`unexpected fetch: ${url}`);
    return make();
  });
  return { transport, calls };
}

const baseOpts = {
  userAgent: buildUserAgent(CONTACT),
  contactUrl: CONTACT,
  sleep: async () => {},
  rand: () => 0.5,
  now: () => 0,
  defaultMinIntervalMs: 0,
};

describe('the User-Agent has exactly one definition', () => {
  it('comes from config.ts and embeds the contact URL', () => {
    const ua = buildUserAgent(CONTACT);
    expect(ua).toContain('GrantSpotter');
    expect(ua).toContain(CONTACT);
    expect(ua).toContain('nightly grant-deadline change detector');
  });

  it('is not re-exported by the fetcher — RESOLUTIONS R10', async () => {
    const mod = (await import('./index.js')) as Record<string, unknown>;
    expect(mod.buildUserAgent).toBeUndefined();
  });

  /**
   * THE WIRE BOUNDARY (2026-08-04). R10 said there is one definition of the User-Agent; it did not
   * say every caller uses it, and two scripts did not — they read `process.env.CONTACT_URL` and
   * sent whatever was there, including values `loadConfig` refuses. A fetcher is the only thing in
   * this codebase that can make a request, so it is the one place where that can be made
   * impossible rather than merely discouraged.
   */
  it('refuses to exist with a User-Agent buildUserAgent did not produce', () => {
    const { transport } = router({});
    // A hand-assembled string, which is how a second User-Agent gets onto the wire.
    expect(() =>
      createFetcher({ ...baseOpts, transport, userAgent: 'GrantSpotter/0.1.0' }),
    ).toThrow(/exactly one User-Agent/);
    // The right string for a DIFFERENT contact URL is still the wrong string here.
    expect(() =>
      createFetcher({
        ...baseOpts,
        transport,
        userAgent: buildUserAgent('https://elsewhere-radio-club.org/x'),
      }),
    ).toThrow(/exactly one User-Agent/);
  });

  it('refuses a contact URL the server would refuse, before any transport is touched', () => {
    const { transport, calls } = router({});
    for (const bad of [
      'not a url',
      'https://example.org/grantspotter',
      'http://127.0.0.1:3030/grantspotter',
      'https://w9xyz-radio-club.org/a\r\nX-Injected: yes',
    ]) {
      expect(() =>
        createFetcher({ ...baseOpts, transport, contactUrl: bad, userAgent: `GrantSpotter (+${bad})` }),
        bad,
      ).toThrow(ConfigError);
    }
    expect(calls).toEqual([]); // nothing reached the network to find out
  });
});

describe('createFetcher blocklist enforcement', () => {
  it('throws before the transport is called at all', async () => {
    const { transport } = router({});
    const f = createFetcher({ ...baseOpts, transport });
    await expect(
      f.fetch({ url: 'https://farweb.org/scholarships', method: 'GET', accept: 'html' }),
    ).rejects.toBeInstanceOf(BlockedHostError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('throws when an allowed host redirects to a blocked host', async () => {
    const { transport } = router({
      'https://www.qcwa.example.test/robots.txt': () => res('', { status: 404 }),
      'https://www.qcwa.example.test/apply': () =>
        res('', { status: 301, headers: { location: 'https://farweb.org/apply' } }),
    });
    const f = createFetcher({ ...baseOpts, transport });
    await expect(
      f.fetch({ url: 'https://www.qcwa.example.test/apply', method: 'GET', accept: 'html' }),
    ).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('exposes no option that could re-enable a blocked host', () => {
    const keys = Object.keys(baseOpts);
    expect(keys.some((k) => /allow|bypass|override|blocklist/i.test(k))).toBe(false);
  });
});

describe('createFetcher politeness', () => {
  it('sends the descriptive User-Agent on every request including robots.txt', async () => {
    const seen: Array<Record<string, string>> = [];
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init.headers).entries()));
      if (url.endsWith('/robots.txt')) return res('User-agent: *\nCrawl-delay: 5\n');
      return res('<html><body>ok</body></html>');
    });
    const f = createFetcher({ ...baseOpts, transport });
    await f.fetch({ url: 'http://www.arrl.org/etp-grants', method: 'GET', accept: 'html' });
    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers['user-agent']).toContain('GrantSpotter');
      expect(headers['user-agent']).toContain(CONTACT);
    }
  });

  it('applies the robots Crawl-delay as the per-host minimum interval', async () => {
    const slept: number[] = [];
    let t = 0;
    const transport = vi.fn(async (url: string) =>
      url.endsWith('/robots.txt') ? res('User-agent: *\nCrawl-delay: 5\n') : res('<p>x</p>'),
    );
    const f = createFetcher({
      ...baseOpts,
      transport,
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    await f.fetch({ url: 'http://www.arrl.org/etp-grants', method: 'GET', accept: 'html' });
    await f.fetch({ url: 'http://www.arrl.org/club-grant-program', method: 'GET', accept: 'html' });
    expect(slept).toContain(5000);
  });

  it('fetches robots.txt once per host', async () => {
    const { transport, calls } = router({
      'http://www.arrl.org/robots.txt': () => res('User-agent: *\n'),
      'http://www.arrl.org/a': () => res('<p>a</p>'),
      'http://www.arrl.org/b': () => res('<p>b</p>'),
    });
    const f = createFetcher({ ...baseOpts, transport });
    await f.fetch({ url: 'http://www.arrl.org/a', method: 'GET', accept: 'html' });
    await f.fetch({ url: 'http://www.arrl.org/b', method: 'GET', accept: 'html' });
    expect(calls.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
  });

  /**
   * ONCE PER HOST, NOT ONCE PER PROCESS — the distinction the test above does not draw and the
   * code did not either.
   *
   * `robots.txt` is the remedy the README and the crawler issue template hand a site owner as the
   * way to stop EVERY deployment of this software. The cache that made the test above pass had no
   * expiry and nothing ever removed an entry, so a container running since February was still
   * acting on February's file: the documented remedy did not work on a long-lived instance, which
   * is the only kind that would be worth complaining about.
   */
  it('re-reads robots.txt when the cached copy expires', async () => {
    let t = 0;
    let served = 'User-agent: *\n';
    const transport = vi.fn(async (url: string) =>
      url.endsWith('/robots.txt') ? res(served) : res('<p>x</p>'),
    );
    const f = createFetcher({ ...baseOpts, transport, now: () => t, robotsTtlMs: 1_000 });
    const req = { url: 'http://www.arrl.org/a', method: 'GET', accept: 'html' } as const;
    await f.fetch(req);

    t = 999; // still inside the TTL: the cached copy stands
    await f.fetch(req);
    expect(transport.mock.calls.filter(([u]) => u.endsWith('/robots.txt'))).toHaveLength(1);

    t = 1_000; // expired
    served = 'User-agent: GrantSpotter\nDisallow: /\n'; // the site owner acted while we were up
    await expect(f.fetch(req)).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(transport.mock.calls.filter(([u]) => u.endsWith('/robots.txt'))).toHaveLength(2);
  });

  it('forgets every cached robots.txt on demand, which is what runCrawl calls', async () => {
    let served = 'User-agent: *\n';
    const transport = vi.fn(async (url: string) =>
      url.endsWith('/robots.txt') ? res(served) : res('<p>x</p>'),
    );
    const f = createFetcher({ ...baseOpts, transport });
    const req = { url: 'http://www.arrl.org/a', method: 'GET', accept: 'html' } as const;
    await f.fetch(req);
    await f.fetch(req);
    expect(transport.mock.calls.filter(([u]) => u.endsWith('/robots.txt'))).toHaveLength(1);

    served = 'User-agent: GrantSpotter\nDisallow: /\n';
    f.forgetRobots();
    // No clock moved. The next run re-reads because it was told to, not because time passed.
    await expect(f.fetch(req)).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(transport.mock.calls.filter(([u]) => u.endsWith('/robots.txt'))).toHaveLength(2);
  });

  it('holds the default TTL below the nightly crawl interval', () => {
    // The number itself, because the reasoning is the number: a path that never calls
    // forgetRobots must still re-read at least daily, and CRAWL_CRON is nightly.
    expect(ROBOTS_CACHE_TTL_MS).toBeLessThan(24 * 60 * 60 * 1000);
    expect(ROBOTS_CACHE_TTL_MS).toBeGreaterThan(60 * 60 * 1000);
  });

  /**
   * A REDIRECTED robots.txt IS RULES, NOT PERMISSION.
   *
   * `rawGet` sends `redirect: 'manual'` so the blocklist can be re-asserted on every hop. That is
   * right for pages, and it was silently wrong here until 2026-08-04: nothing followed the
   * redirect, the 3xx reached `robotsFromResponse`, which had no 3xx branch, and the site was
   * crawled as though it published no rules. Apex-to-`www` and http-to-https redirects on
   * `/robots.txt` are the default behaviour of most hosting a volunteer-run club uses, so this is
   * the ordinary case, not an exotic one.
   */
  describe('robots.txt redirects (RFC 9309 §2.3.1.2)', () => {
    it('follows a 301 and obeys the rules at the far end', async () => {
      const { transport, calls } = router({
        'https://w9xyz-club.org/robots.txt': () =>
          res('', { status: 301, headers: { location: 'https://www.w9xyz-club.org/robots.txt' } }),
        'https://www.w9xyz-club.org/robots.txt': () => res('User-agent: GrantSpotter\nDisallow: /\n'),
      });
      const f = createFetcher({ ...baseOpts, transport });
      await expect(
        f.fetch({ url: 'https://w9xyz-club.org/grants', method: 'GET', accept: 'html' }),
      ).rejects.toBeInstanceOf(RobotsDisallowedError);
      // The page was never requested, and both hops were.
      expect(calls).toEqual([
        'https://w9xyz-club.org/robots.txt',
        'https://www.w9xyz-club.org/robots.txt',
      ]);
    });

    it('applies rules fetched across a redirect to the origin we asked, not the one that answered', async () => {
      const { transport } = router({
        'http://w9xyz-club.org/robots.txt': () =>
          res('', { status: 308, headers: { location: 'https://w9xyz-club.org/robots.txt' } }),
        'https://w9xyz-club.org/robots.txt': () => res('User-agent: *\nDisallow: /members\n'),
        'http://w9xyz-club.org/grants': () => res('<p>grants</p>'),
      });
      const f = createFetcher({ ...baseOpts, transport });
      const payload = await f.fetch({
        url: 'http://w9xyz-club.org/grants',
        method: 'GET',
        accept: 'html',
      });
      expect(payload.status).toBe(200);
      await expect(
        f.fetch({ url: 'http://w9xyz-club.org/members', method: 'GET', accept: 'html' }),
      ).rejects.toBeInstanceOf(RobotsDisallowedError);
    });

    it('backs off rather than crawling when the chain never resolves', async () => {
      // A loop. RFC 9309 would let us assume "no robots.txt" after five hops; we take the reading
      // that polls less, because we did not read the site's rules and so cannot claim they permit
      // us. It costs one run: the next crawl re-reads.
      const { transport, calls } = router({
        'https://w9xyz-club.org/robots.txt': () =>
          res('', { status: 302, headers: { location: 'https://w9xyz-club.org/robots.txt' } }),
      });
      const f = createFetcher({ ...baseOpts, transport });
      await expect(
        f.fetch({ url: 'https://w9xyz-club.org/grants', method: 'GET', accept: 'html' }),
      ).rejects.toBeInstanceOf(RobotsDisallowedError);
      expect(calls).toHaveLength(ROBOTS_MAX_REDIRECTS + 1);
    });

    it('backs off on a 3xx with no Location to follow', async () => {
      const { transport } = router({
        'https://w9xyz-club.org/robots.txt': () => res('', { status: 302 }),
      });
      const f = createFetcher({ ...baseOpts, transport });
      await expect(
        f.fetch({ url: 'https://w9xyz-club.org/grants', method: 'GET', accept: 'html' }),
      ).rejects.toBeInstanceOf(RobotsDisallowedError);
    });

    it('will not follow a robots.txt redirect into the blocklist', async () => {
      // farweb.org -> batualam.org is a live takeover, and a robots.txt hop is a route to it that
      // `fetchOne`'s per-hop check never saw. We decline the hop and back off for the run.
      const { transport, calls } = router({
        'https://w9xyz-club.org/robots.txt': () =>
          res('', { status: 301, headers: { location: 'https://batualam.org/robots.txt' } }),
      });
      const f = createFetcher({ ...baseOpts, transport });
      await expect(
        f.fetch({ url: 'https://w9xyz-club.org/grants', method: 'GET', accept: 'html' }),
      ).rejects.toBeInstanceOf(RobotsDisallowedError);
      expect(calls).toEqual(['https://w9xyz-club.org/robots.txt']);
    });
  });

  it('refuses a path robots.txt disallows', async () => {
    const { transport } = router({
      'http://www.arrl.org/robots.txt': () => res('User-agent: *\nDisallow: /admin\n'),
    });
    const f = createFetcher({ ...baseOpts, transport });
    await expect(
      f.fetch({ url: 'http://www.arrl.org/admin', method: 'GET', accept: 'html' }),
    ).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it('treats a 403 robots.txt as no rules — ncdxf.org 403s its own robots.txt', async () => {
    const { transport } = router({
      'https://www.ncdxf.org/robots.txt': () => res('', { status: 403 }),
      'https://www.ncdxf.org/pages/grant-app.html': () => res('<p>grant</p>'),
    });
    const f = createFetcher({ ...baseOpts, transport });
    const payload = await f.fetch({
      url: 'https://www.ncdxf.org/pages/grant-app.html',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.status).toBe(200);
  });
});

describe('createFetcher headersByHost (Task 24)', () => {
  it('applies a per-host header only to requests against that host', async () => {
    const seen: Record<string, Record<string, string>> = {};
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      seen[url] = Object.fromEntries(new Headers(init.headers).entries());
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      return res('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    });
    const f = createFetcher({
      ...baseOpts,
      transport,
      headersByHost: { 'api.simpler.grants.gov': { 'X-Auth': 'secret-key' } },
    });
    await f.fetch({
      url: 'https://api.simpler.grants.gov/v1/opportunities/search',
      method: 'POST',
      accept: 'json',
      body: { query: 'amateur radio' },
    });
    await f.fetch({ url: 'https://api.grants.gov/v1/api/search2', method: 'POST', accept: 'json' });

    expect(seen['https://api.simpler.grants.gov/v1/opportunities/search']['x-auth']).toBe(
      'secret-key',
    );
    // The unrelated host never sees the credential meant for the other one.
    expect(seen['https://api.grants.gov/v1/api/search2']['x-auth']).toBeUndefined();
  });

  it('cannot override the User-Agent, even if headersByHost tries to set one', async () => {
    let captured: Record<string, string> = {};
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      captured = Object.fromEntries(new Headers(init.headers).entries());
      return res('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    });
    const f = createFetcher({
      ...baseOpts,
      transport,
      headersByHost: {
        'api.simpler.grants.gov': { 'User-Agent': 'spoofed-agent/1.0', 'X-Auth': 'secret-key' },
      },
    });
    await f.fetch({
      url: 'https://api.simpler.grants.gov/v1/opportunities/search',
      method: 'POST',
      accept: 'json',
      body: {},
    });
    // The X-Auth header still rides through headersByHost...
    expect(captured['x-auth']).toBe('secret-key');
    // ...but the descriptive, contact-URL-bearing User-Agent always wins. No UA spoofing, ever.
    expect(captured['user-agent']).toContain('GrantSpotter');
    expect(captured['user-agent']).toContain(CONTACT);
    expect(captured['user-agent']).not.toBe('spoofed-agent/1.0');
  });

  it('adds nothing when headersByHost is unset — the optional key path costs nothing by default', async () => {
    let captured: Record<string, string> = {};
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      captured = Object.fromEntries(new Headers(init.headers).entries());
      return res('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    });
    const f = createFetcher({ ...baseOpts, transport });
    await f.fetch({ url: 'https://api.grants.gov/v1/api/search2', method: 'POST', accept: 'json' });
    expect(captured['x-auth']).toBeUndefined();
    expect(captured['user-agent']).toContain('GrantSpotter');
  });
});

describe('createFetcher retries', () => {
  it('backs off and retries on 503, then succeeds', async () => {
    let n = 0;
    const transport = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      n += 1;
      return n < 3 ? res('slow down', { status: 503 }) : res('<p>ok</p>');
    });
    const slept: number[] = [];
    const f = createFetcher({ ...baseOpts, transport, sleep: async (ms) => void slept.push(ms) });
    const payload = await f.fetch({
      url: 'https://api.example.test/x',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.body).toContain('ok');
    expect(slept).toHaveLength(2);
    expect(slept[1]).toBeGreaterThan(slept[0]);
  });

  it('honours Retry-After on a 429', async () => {
    let first = true;
    const transport = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      if (first) {
        first = false;
        return res('', { status: 429, headers: { 'retry-after': '7' } });
      }
      return res('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    });
    const slept: number[] = [];
    const f = createFetcher({ ...baseOpts, transport, sleep: async (ms) => void slept.push(ms) });
    await f.fetch({ url: 'https://api.example.test/y', method: 'GET', accept: 'json' });
    expect(slept).toEqual([7000]);
  });

  it('gives up after maxRetries and surfaces the status', async () => {
    const transport = vi.fn(async (url: string) =>
      url.endsWith('/robots.txt') ? res('', { status: 404 }) : res('nope', { status: 500 }),
    );
    const f = createFetcher({ ...baseOpts, transport, maxRetries: 2 });
    await expect(
      f.fetch({ url: 'https://api.example.test/z', method: 'GET', accept: 'json' }),
    ).rejects.toThrow(/500/);
  });

  it('does not retry a 404 — a missing page is an answer, not a failure', async () => {
    let hits = 0;
    const transport = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      hits += 1;
      return res('missing', { status: 404 });
    });
    const f = createFetcher({ ...baseOpts, transport });
    const payload = await f.fetch({
      url: 'https://example.test/gone',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.status).toBe(404);
    expect(hits).toBe(1);
  });
});

describe('backoffMs', () => {
  it('doubles per attempt, applies jitter and caps at 30s', () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(1, () => 1)).toBe(2000);
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(10, () => 1)).toBe(30000);
  });

  it('lets Retry-After win outright', () => {
    expect(backoffMs(0, () => 1, 7)).toBe(7000);
  });
});

describe('createFetcher POST and snapshots', () => {
  it('sends a JSON body for POST and returns the parsed payload envelope', async () => {
    let capturedInit: RequestInit | undefined;
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      capturedInit = init;
      return res('{"data":{"hitCount":3}}', { headers: { 'content-type': 'application/json' } });
    });
    const f = createFetcher({ ...baseOpts, transport });
    const payload = await f.fetch({
      url: 'https://api.grants.gov/v1/api/search2',
      method: 'POST',
      accept: 'json',
      body: { keyword: 'amateur radio', rows: 10 },
    });
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.body).toBe('{"keyword":"amateur radio","rows":10}');
    expect(new Headers(capturedInit?.headers).get('content-type')).toBe('application/json');
    expect(payload.contentType).toContain('application/json');
    expect(JSON.parse(payload.body).data.hitCount).toBe(3);
    expect(payload.url).toBe('https://api.grants.gov/v1/api/search2');
    expect(payload.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes a snapshot file under DATA_DIR/snapshots when dataDir is set', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'gs-snap-'));
    const { transport } = router({
      'https://example.test/robots.txt': () => res('', { status: 404 }),
      'https://example.test/p': () => res('<html><body>snap</body></html>'),
    });
    const f = createFetcher({ ...baseOpts, transport, dataDir });
    await f.fetch({ url: 'https://example.test/p', method: 'GET', accept: 'html' });
    const hostDir = path.join(dataDir, 'snapshots', 'example.test');
    const buckets = await readdir(hostDir);
    expect(buckets).toHaveLength(1);
    const files = await readdir(path.join(hostDir, buckets[0]));
    expect(files[0]).toMatch(/\.html$/);
    const body = await readFile(path.join(hostDir, buckets[0], files[0]), 'utf8');
    expect(body).toContain('snap');
  });
});
