import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ConfigError, buildUserAgent } from '../config.js';
import { BlockedHostError } from './blocklist.js';
import { ROBOTS_MAX_REDIRECTS, RobotsDisallowedError } from './robots.js';
import {
  ROBOTS_CACHE_TTL_MS,
  ROBOTS_UNREAD_CACHE_TTL_MS,
  RequestBudgetExhaustedError,
  backoffMs,
  createFetcher,
  maxRequestsPerFetch,
} from './index.js';

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

/**
 * A clock where sleeping is the only thing that moves time, so a "gap" in these tests is exactly
 * the gap the shipped code would produce with real timers and nothing else.
 *
 * The equivalent figures against real sockets and real timers come from `scripts/measure-pacing.ts`
 * and are quoted in the doc comments below; this is the deterministic guard for them.
 */
function pacingClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

/** Records the instant of every transport call, which is what "gap" means for these tests. */
function timeline(now: () => number, handler: (url: string) => Response) {
  const at: number[] = [];
  const transport = vi.fn(async (url: string) => {
    at.push(now());
    return handler(url);
  });
  return {
    transport,
    at,
    gaps: (): number[] => at.slice(1).map((when, i) => when - (at[i] as number)),
  };
}

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
   * Every request sends `redirect: 'manual'` so the blocklist can be re-asserted on every hop. That is
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

  /**
   * READING robots.txt IS A REQUEST LIKE ANY OTHER, AND FAILING TO READ IT IS NOT PERMISSION.
   *
   * Three defects that compounded into one hole. `readRobots` called the transport directly, so
   * (a) it got a single attempt where every page under it gets four, (b) none of its requests
   * entered the host queue, so the redirect chain could burst, and (c) a transport failure was
   * turned into `robotsFromResponse(404, …)` — the allow-all branch — directly contradicting the
   * comment on the same lines, which said a network error "is not a licence to crawl freely".
   * Together: one dropped connection on `/robots.txt` opened the whole origin.
   */
  describe('a robots.txt we could not read', () => {
    const dropped = (): never => {
      throw new TypeError('fetch failed');
    };

    it('does not open the origin — a dropped connection is not permission', async () => {
      const transport = vi.fn(async (url: string) =>
        url.endsWith('/robots.txt') ? dropped() : res('<p>grants</p>'),
      );
      const f = createFetcher({ ...baseOpts, transport });
      await expect(
        f.fetch({ url: 'https://w9xyz-club.org/grants', method: 'GET', accept: 'html' }),
      ).rejects.toBeInstanceOf(RobotsDisallowedError);
      // Measured before the fix: the page was fetched and returned 200.
      expect(transport.mock.calls.filter(([u]) => !u.endsWith('/robots.txt'))).toEqual([]);
    });

    it('gets the same retry budget a page under it gets', async () => {
      // The file that governs a whole origin was the least-retried request the crawler made.
      let attempts = 0;
      const transport = vi.fn(async (url: string) => {
        if (!url.endsWith('/robots.txt')) return res('<p>grants</p>');
        attempts += 1;
        return attempts <= 2 ? res('busy', { status: 503 }) : res('User-agent: *\nDisallow: /x\n');
      });
      const f = createFetcher({ ...baseOpts, transport });
      const payload = await f.fetch({
        url: 'https://w9xyz-club.org/grants',
        method: 'GET',
        accept: 'html',
      });
      expect(attempts).toBe(3); // two 503s ridden out, exactly as a page would be
      expect(payload.status).toBe(200);
    });

    it('backs off when the retries run out, rather than treating 503 as no rules', async () => {
      const transport = vi.fn(async (url: string) =>
        url.endsWith('/robots.txt') ? res('busy', { status: 503 }) : res('<p>grants</p>'),
      );
      const f = createFetcher({ ...baseOpts, transport, maxRetries: 2 });
      await expect(
        f.fetch({ url: 'https://w9xyz-club.org/grants', method: 'GET', accept: 'html' }),
      ).rejects.toBeInstanceOf(RobotsDisallowedError);
      expect(transport.mock.calls.filter(([u]) => u.endsWith('/robots.txt'))).toHaveLength(3);
    });

    it('is not remembered as long as rules we actually read', async () => {
      // The verdict a failure manufactures was stored exactly like a real one, for
      // ROBOTS_CACHE_TTL_MS. One lost packet refused an origin for six hours — including to the
      // admin "Verify now" pressed a minute later by somebody watching the site load in a browser.
      let t = 0;
      let healthy = false;
      const transport = vi.fn(async (url: string) => {
        if (!url.endsWith('/robots.txt')) return res('<p>grants</p>');
        if (!healthy) return dropped();
        return res('User-agent: *\n');
      });
      const f = createFetcher({
        ...baseOpts,
        transport,
        now: () => t,
        robotsTtlMs: 1_000_000,
        robotsUnreadTtlMs: 1_000,
        maxRetries: 0, // one attempt per READ, so the counts below are reads and not retries
      });
      const req = { url: 'https://w9xyz-club.org/grants', method: 'GET', accept: 'html' } as const;
      await expect(f.fetch(req)).rejects.toBeInstanceOf(RobotsDisallowedError);

      t = 999; // still inside the SHORT ttl: not re-read, and still refused
      await expect(f.fetch(req)).rejects.toBeInstanceOf(RobotsDisallowedError);
      expect(transport.mock.calls.filter(([u]) => u.endsWith('/robots.txt'))).toHaveLength(1);

      t = 1_000; // the failure has expired, though the full TTL has barely started
      healthy = true;
      expect((await f.fetch(req)).status).toBe(200);
      expect(transport.mock.calls.filter(([u]) => u.endsWith('/robots.txt'))).toHaveLength(2);
    });

    it('keeps the full TTL for a 404, which IS an answer about this site’s rules', async () => {
      // The distinction the cache did not draw. "This site publishes no rules" is a real reading;
      // "we could not find out" is not, and only the second one expires in minutes.
      let t = 0;
      const transport = vi.fn(async (url: string) =>
        url.endsWith('/robots.txt') ? res('', { status: 404 }) : res('<p>grants</p>'),
      );
      const f = createFetcher({
        ...baseOpts,
        transport,
        now: () => t,
        robotsTtlMs: 1_000_000,
        robotsUnreadTtlMs: 1_000,
      });
      const req = { url: 'https://w9xyz-club.org/grants', method: 'GET', accept: 'html' } as const;
      await f.fetch(req);
      t = 500_000; // far past the unread TTL, far inside the real one
      await f.fetch(req);
      expect(transport.mock.calls.filter(([u]) => u.endsWith('/robots.txt'))).toHaveLength(1);
    });

    it('holds the failed-read lifetime well under the real one', () => {
      expect(ROBOTS_UNREAD_CACHE_TTL_MS).toBeLessThan(ROBOTS_CACHE_TTL_MS / 10);
      // …and long enough to outlast the run that created it, so one failure costs one read.
      expect(ROBOTS_UNREAD_CACHE_TTL_MS).toBeGreaterThan(5 * 60 * 1000);
    });
  });

  /**
   * THE REDIRECT CHAIN THAT BYPASSED THE HOST QUEUE (2026-08-04).
   *
   * `readRobots` called the transport directly, so the chain the previous commit added could fire
   * ROBOTS_MAX_REDIRECTS + 1 requests at one host with no spacing at all — against the one-per-
   * second floor this project's README advertises to the sites it polls. The commit that made the
   * crawler more obedient made it burstier, which is the worst possible trade for a product whose
   * central claim is politeness.
   */
  it('spaces every hop of a robots.txt redirect chain by the per-host floor', async () => {
    let t = 0;
    const at: number[] = [];
    const hop = (n: number): string => `https://w9xyz-club.org/robots${n}.txt`;
    const transport = vi.fn(async (url: string) => {
      at.push(t);
      const match = /robots(\d*)\.txt$/.exec(url);
      if (match === null) return res('<p>grants</p>'); // the page at the end of it all
      const n = Number(match[1] === '' ? '0' : match[1]);
      if (n < 4) return res('', { status: 301, headers: { location: hop(n + 1) } });
      return res('User-agent: *\nDisallow: /private\n');
    });
    const f = createFetcher({
      ...baseOpts,
      transport,
      defaultMinIntervalMs: 1_000,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    });
    await f.fetch({ url: 'https://w9xyz-club.org/grants', method: 'GET', accept: 'html' });

    expect(at).toHaveLength(6); // five robots hops, then the page
    const gaps = at.slice(1).map((when, i) => when - (at[i] as number));
    // Measured before the fix, real fetcher against a loopback HTTP server serving a five-hop
    // /robots.txt chain: gaps of 18, 2, 2, 2 and 5 ms. After: 1013, 1004, 1002, 1003, 1004.
    expect(gaps.every((gap) => gap >= 1_000), `gaps were ${gaps.join(', ')} ms`).toBe(true);
    // …and the page that follows the chain is spaced from the last hop, not fired on top of it.
    expect(gaps).toHaveLength(5);
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

/**
 * THE GATE IS ENTERED ONCE PER HTTP REQUEST, NOT ONCE PER LOGICAL FETCH.
 *
 * One mistake, four measured symptoms. `fetchWithRetries` ran INSIDE a single `queue.run(...)`
 * slot, so the per-host gate governed only the FIRST attempt of the first hop; every retry and
 * every redirect hop after it went straight to the wire from inside a slot the lane was already
 * holding. Against the real fetcher and loopback HTTP servers (`scripts/measure-pacing.ts`), at the
 * commit before this one:
 *
 *   429, `Retry-After: 0`      gaps of 2, 5, 3 ms against a 1000 ms floor
 *   503, no header             gaps of 975, 1848, 3385 ms — the first under the floor
 *   `Crawl-delay: 5` + 503     gaps of 1004 and 783 ms, never 5000
 *   `Crawl-delay: 5`, page 1   1002 ms after `/robots.txt`, not 5000
 *   robots.txt 429ing AND 301ing   19 requests in 6052 ms, 12 of the 18 gaps under the floor
 *
 * After: 0 gaps under the floor in every one of those scenarios, and the last costs 9 requests.
 * These tests pin the same properties against an injected clock so they are checked on every run.
 */
describe('every request that reaches the network passes the host gate exactly once', () => {
  const PAGE = { url: 'https://w9xyz-club.org/grants', method: 'GET', accept: 'html' } as const;
  const FLOOR = 1_000;

  /** Every scenario below shares this shape: a fetcher on a virtual clock with the shipped floor. */
  function paced(handler: (url: string) => Response, extra: Record<string, unknown> = {}) {
    const clock = pacingClock();
    const line = timeline(clock.now, handler);
    const fetcher = createFetcher({
      ...baseOpts,
      transport: line.transport,
      defaultMinIntervalMs: FLOOR,
      now: clock.now,
      sleep: clock.sleep,
      ...extra,
    });
    return { ...line, fetcher };
  }

  it('spaces every RETRY of a 429 that says Retry-After: 0', async () => {
    const t = paced((url) =>
      url.endsWith('/robots.txt')
        ? res('User-agent: *\n')
        : res('slow down', { status: 429, headers: { 'retry-after': '0' } }),
    );
    await expect(t.fetcher.fetch(PAGE)).rejects.toThrow(/429/);
    expect(t.at).toHaveLength(5); // robots.txt, then four attempts
    const gaps = t.gaps();
    // "You may retry immediately" is the SERVER's constraint. Ours still applies.
    expect(gaps.every((gap) => gap >= FLOOR), `gaps were ${gaps.join(', ')} ms`).toBe(true);
  });

  it('waits the whole Retry-After when the server asks for more than the floor', async () => {
    const t = paced((url) =>
      url.endsWith('/robots.txt')
        ? res('User-agent: *\n')
        : res('slow down', { status: 429, headers: { 'retry-after': '30' } }),
    );
    await expect(t.fetcher.fetch(PAGE)).rejects.toThrow(/429/);
    // 30000 and not 31000: Retry-After and the floor compose by MAX, so a server that asks for
    // thirty seconds gets thirty seconds.
    expect(t.gaps()).toEqual([FLOOR, 30_000, 30_000, 30_000]);
  });

  it('spaces every retry of a 503 that sends no header at all', async () => {
    const t = paced((url) =>
      url.endsWith('/robots.txt') ? res('User-agent: *\n') : res('busy', { status: 503 }),
    );
    await expect(t.fetcher.fetch(PAGE)).rejects.toThrow(/503/);
    const gaps = t.gaps();
    // Jittered backoff is 750, 1500, 3000 ms at rand()=0.5, so the floor is what carries the first.
    expect(gaps.every((gap) => gap >= FLOOR), `gaps were ${gaps.join(', ')} ms`).toBe(true);
  });

  it('honours Crawl-delay on the retry path, which is where it was ignored entirely', async () => {
    const t = paced(
      (url) =>
        url.endsWith('/robots.txt')
          ? res('User-agent: *\nCrawl-delay: 5\n')
          : res('busy', { status: 503 }),
      { maxRetries: 2 },
    );
    await expect(t.fetcher.fetch(PAGE)).rejects.toThrow(/503/);
    const gaps = t.gaps();
    expect(gaps.every((gap) => gap >= 5_000), `gaps were ${gaps.join(', ')} ms`).toBe(true);
  });

  it('honours Crawl-delay from the FIRST page it governs, not the second', async () => {
    const t = paced((url) =>
      url.endsWith('/robots.txt') ? res('User-agent: *\nCrawl-delay: 5\n') : res('<p>ok</p>'),
    );
    expect((await t.fetcher.fetch(PAGE)).status).toBe(200);
    // The request that READ the file cannot be governed by it; the very next one must be.
    expect(t.gaps()).toEqual([5_000]);
  });

  /**
   * THE MULTIPLICATIVE WORST CASE, WHICH THE DOCS DESCRIBED ADDITIVELY.
   *
   * `.github/ISSUE_TEMPLATE/crawler-contact.md` promised a site owner "up to five hops … plus up to
   * four attempts". The retry loop sat inside the per-hop loop, so the truth was the PRODUCT:
   * (5 + 1) x (3 + 1) = 24 requests for one `/robots.txt`. The purse makes the promise true.
   */
  it('caps a robots.txt that both 429s and 301s at the additive bound', async () => {
    const seen = new Map<string, number>();
    const t = paced((url) => {
      if (!url.includes('robots')) return res('<p>ok</p>');
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      if (n <= 2) return res('slow down', { status: 429, headers: { 'retry-after': '0' } });
      const hop = Number(/robots(\d*)\.txt/.exec(url)?.[1] || '0');
      return hop < ROBOTS_MAX_REDIRECTS
        ? res('', { status: 301, headers: { location: `/robots${hop + 1}.txt` } })
        : res('User-agent: *\n');
    });
    // The purse ran out before the chain resolved, so we never read the rules — and a read we could
    // not complete is not permission. The page is never requested.
    await expect(t.fetcher.fetch(PAGE)).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(t.at).toHaveLength(maxRequestsPerFetch(ROBOTS_MAX_REDIRECTS, 3));
    const gaps = t.gaps();
    expect(gaps.every((gap) => gap >= FLOOR), `gaps were ${gaps.join(', ')} ms`).toBe(true);
  });

  /**
   * THE ASSERTION THIS REPLACES WAS THE DEFECT, WRITTEN DOWN AND PINNED.
   *
   * It read `expect(pageRequests).toBe(maxRequestsPerFetch(5, 3))` over `t.at.length - 1`, and the
   * comment beside it explained away the subtraction as "minus the one robots.txt read". That
   * subtraction is the whole bug: the README tells a site owner that one page fetch costs their
   * server at most nine requests, and the test was checking that the PAGE cost nine while quietly
   * excusing a tenth request to the same machine. Nothing in an access log is excused that way.
   * The `/robots.txt` read was not the only thing outside the count either — `readRobots` opened a
   * fresh nine per ORIGIN, so the same shape across an http -> https hop measured 20 requests and
   * across five hops over six origins on one host, 63 (`npm run measure-pacing`, loopback servers,
   * commit 2c098d9). Both are 9 now.
   *
   * So the number asserted here is the TOTAL a single server saw, robots.txt included, which is the
   * only number the published sentence can honestly be about. It is unchanged at nine; what changed
   * is what it counts.
   */
  it('costs one server at most nine requests IN TOTAL, robots.txt read included', async () => {
    const seen = new Map<string, number>();
    const t = paced((url) => {
      if (url.endsWith('/robots.txt')) return res('User-agent: *\n');
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      if (n <= 2) return res('slow down', { status: 429, headers: { 'retry-after': '0' } });
      const hop = Number(/\/p(\d+)$/.exec(url)?.[1] ?? '0');
      return res('', { status: 301, headers: { location: `/p${hop + 1}` } });
    });
    // The allowance runs out mid-attempt rather than between hops, so what surfaces is the last
    // thing the server actually said. It said 429 nine times over; we stop asking.
    await expect(
      t.fetcher.fetch({ url: 'https://w9xyz-club.org/p0', method: 'GET', accept: 'html' }),
    ).rejects.toThrow(/429/);
    expect(t.at).toHaveLength(maxRequestsPerFetch(5, 3));
    const gaps = t.gaps();
    expect(gaps.every((gap) => gap >= FLOOR), `gaps were ${gaps.join(', ')} ms`).toBe(true);
  });

  it('still lets the 3xx be the payload when the purse runs out between hops', async () => {
    // The other way a chain ends, and the one that has always returned a payload rather than
    // throwing: the hop we just made succeeded, and there is nothing left to follow it with.
    const seen = new Map<string, number>();
    const t = paced((url) => {
      if (url.endsWith('/robots.txt')) return res('User-agent: *\n');
      const hop = Number(/\/p(\d+)$/.exec(url)?.[1] ?? '0');
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      // /p0 costs four requests, /p1 three, /p2 one — nine with the robots read, and the ninth is
      // a 301 nothing is left to follow.
      const failures = hop === 0 ? 3 : hop === 1 ? 2 : 0;
      if (n <= failures) return res('slow down', { status: 429, headers: { 'retry-after': '0' } });
      return res('', { status: 301, headers: { location: `/p${hop + 1}` } });
    });
    const payload = await t.fetcher.fetch({
      url: 'https://w9xyz-club.org/p0',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.status).toBe(301);
    expect(t.at).toHaveLength(maxRequestsPerFetch(5, 3));
  });

  it('bounds one fetch additively rather than by the product of two limits', () => {
    expect(maxRequestsPerFetch(5, 3)).toBe(9);
    // The number the docs used to imply, and the number the code actually produced.
    expect(maxRequestsPerFetch(5, 3)).toBeLessThan((5 + 1) * (3 + 1));
  });

  /**
   * FINDING 5: THE LAST TWO HOST-DERIVED VALUES THAT SKIPPED `canonicalHostname`.
   *
   * `queue.run(parsed.host, …)` and `robotsFor(parsed.origin)` compared raw values, so
   * `example.org` and `example.org.` were two lanes, two robots reads and two independent request
   * budgets — the same trailing-dot bug already fixed three times elsewhere in this repository, one
   * of them in the blocklist check that stops `farweb.org`.
   */
  it('treats a trailing root dot as the same host: one robots read, one lane', async () => {
    const t = paced((url) =>
      url.endsWith('/robots.txt') ? res('User-agent: *\n') : res('<p>ok</p>'),
    );
    await t.fetcher.fetch({ url: 'https://w9xyz-club.org./a', method: 'GET', accept: 'html' });
    await t.fetcher.fetch({ url: 'https://w9xyz-club.org/b', method: 'GET', accept: 'html' });

    const robots = t.transport.mock.calls.filter(([u]) => u.endsWith('/robots.txt'));
    expect(robots).toHaveLength(1);
    // …and it was read from the canonical origin, so it is the same cache entry either way.
    expect(robots[0]?.[0]).toBe('https://w9xyz-club.org/robots.txt');
    const gaps = t.gaps();
    expect(gaps.every((gap) => gap >= FLOOR), `gaps were ${gaps.join(', ')} ms`).toBe(true);
  });

  /**
   * NO DEADLOCK, AND THE REASON IS AN ORDERING RATHER THAN A LOCK.
   *
   * `robotsFor` may have to fetch `/robots.txt`, which enters the SAME host's lane. `fetchOne`
   * awaits it while holding no slot, so the lane is always free for that read to take. If a future
   * edit moves a `robotsFor` call inside a `queue.run` callback, this test hangs and then fails on
   * timeout rather than passing quietly.
   */
  it('never awaits robots.txt from inside a slot, so pages racing one origin cannot deadlock', async () => {
    const t = paced((url) =>
      url.endsWith('/robots.txt') ? res('User-agent: *\n') : res('<p>ok</p>'),
    );
    const [a, b] = await Promise.all([
      t.fetcher.fetch({ url: 'https://w9xyz-club.org/a', method: 'GET', accept: 'html' }),
      // Queued while the first page's robots.txt read is still in flight.
      t.fetcher.fetch({ url: 'https://w9xyz-club.org/b', method: 'GET', accept: 'html' }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(t.at).toHaveLength(3); // one shared read, then the two pages
    expect(t.gaps()).toEqual([FLOOR, FLOOR]);
  });
});

/**
 * THE BUDGET BELONGS TO THE FETCH, THE ROBOTS CACHE BELONGS TO THE ORIGIN, AND ONLY ONE OF THEM HAS
 * A KEY.
 *
 * The purse was keyed twice and wrong twice. Keyed per ORIGIN, every scheme or port a machine
 * answered on bought a fresh nine, and the `/robots.txt` read was not counted against the page at
 * all. Keyed per HOSTNAME — the fix of 516bcab — an apex that 301s to `www` bought a second nine,
 * because two names are two keys and one machine. There is no third key that is right: a URL does
 * not say who owns it (see `newFetchState` in the module under test for what was considered and why
 * each guess is worse than the disease). So the purse is now per LOGICAL FETCH and has no key at
 * all, which makes the published sentence true for shapes nobody has enumerated.
 *
 * Measured with `npm run measure-pacing` against loopback servers, ONE page fetch, at 2c098d9 /
 * 8ec9873 / this commit:
 *
 *   ceilingOneOrigin      one origin, robots + page at full purse    18 -> 9  -> 9
 *   schemeChange          http -> https, real TLS on loopback        20 -> 9  -> 9
 *   ceilingManyOrigins    five hops across six origins               63 -> 9  -> 9
 *   twoNamesOneMachine    apex -> www, both names in distress         - -> 18 -> 9
 *   nameChangeHealthy     apex -> www, healthy                        - ->  4 ->  4  (handover 4 ms -> over a second)
 *   twoOriginsOneHost     two origins, both blocked by robots.txt     2 ->  2 ->  2  (the arrl.org shape)
 *   portChangeHealthy     one page fetch across a port change          4 ->  4 ->  4  (the ordinary case)
 *
 * The last three are the point of the last three: the fix costs the ordinary cases nothing, and the
 * robots cache's key was NOT merged into the purse's absence of one.
 */
describe('one purse per fetch, not per origin and not per name', () => {
  const FLOOR = 1_000;

  function paced(handler: (url: string) => Response, extra: Record<string, unknown> = {}) {
    const clock = pacingClock();
    const line = timeline(clock.now, handler);
    const fetcher = createFetcher({
      ...baseOpts,
      transport: line.transport,
      defaultMinIntervalMs: FLOOR,
      now: clock.now,
      sleep: clock.sleep,
      ...extra,
    });
    return { ...line, fetcher };
  }

  /** A `/robots.txt` that costs the full purse on its own and still resolves: 4 + 4 + 1. */
  function expensiveRobots(seen: Map<string, number>) {
    return (url: string): Response | null => {
      const match = /\/robots(\d*)\.txt$/.exec(url);
      if (match === null) return null;
      const hop = Number(match[1] === '' ? '0' : match[1]);
      if (hop >= 2) return res('User-agent: *\n');
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      if (n <= 3) return res('slow down', { status: 429, headers: { 'retry-after': '0' } });
      const next = new URL(`/robots${hop + 1}.txt`, url).toString();
      return res('', { status: 301, headers: { location: next } });
    };
  }

  /**
   * A flaky server, which is the ordinary way this goes wrong: `/robots.txt` 503s three times and
   * then answers, at each of the two origins. Four requests, one page request, four requests, and
   * the allowance is gone before the second page can be asked for.
   *
   * The counts are what discriminate. Per SERVER (this commit): 4 + 1 + 4 = 9, and we stop. Per
   * ORIGIN (before it): 4 + 1 + 4 + 1 = 10, and the page comes back 200 — one request past a
   * ceiling published in a README as a promise to the person whose server that is.
   */
  function flakyRobots(seen: Map<string, number>) {
    return (url: string): Response | null => {
      if (!url.endsWith('/robots.txt')) return null;
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      return n <= 3 ? res('busy', { status: 503 }) : res('User-agent: *\n');
    };
  }

  it('does not buy a second allowance by crossing http to https on one host', async () => {
    const seen = new Map<string, number>();
    const robots = flakyRobots(seen);
    const t = paced((url) => {
      const rules = robots(url);
      if (rules !== null) return rules;
      return url.startsWith('http://')
        ? res('', { status: 301, headers: { location: 'https://w9xyz-club.org/p' } })
        : res('<p>end</p>');
    });
    await expect(
      t.fetcher.fetch({ url: 'http://w9xyz-club.org/p', method: 'GET', accept: 'html' }),
    ).rejects.toBeInstanceOf(RequestBudgetExhaustedError);
    expect(t.at).toHaveLength(9);
    // The last request was the https origin's robots.txt, not its page: the chain did cross, and
    // what stopped it was the machine's allowance rather than the origin's.
    expect(t.transport.mock.calls.at(-1)?.[0]).toBe('https://w9xyz-club.org/robots.txt');
  });

  it('does not buy a second allowance by crossing a port on one host', async () => {
    const seen = new Map<string, number>();
    const robots = flakyRobots(seen);
    const t = paced((url) => {
      const rules = robots(url);
      if (rules !== null) return rules;
      return url.includes(':8443')
        ? res('<p>end</p>')
        : res('', { status: 301, headers: { location: 'https://w9xyz-club.org:8443/p' } });
    });
    await expect(
      t.fetcher.fetch({ url: 'https://w9xyz-club.org/p', method: 'GET', accept: 'html' }),
    ).rejects.toBeInstanceOf(RequestBudgetExhaustedError);
    expect(t.at).toHaveLength(9);
    expect(t.transport.mock.calls.at(-1)?.[0]).toBe('https://w9xyz-club.org:8443/robots.txt');
  });

  it('holds at nine however many origins one host answers on', async () => {
    // Six origins on one hostname, each publishing its own allow-all robots.txt — so each hop is a
    // cache miss and a real read. Before the fix this cost 12 requests here and 63 in the
    // constructed worst case (`npm run measure-pacing ceilingManyOrigins`).
    const chain = [
      'https://w9xyz-club.org/p',
      'https://w9xyz-club.org:8443/p',
      'https://w9xyz-club.org:8444/p',
      'https://w9xyz-club.org:8445/p',
      'http://w9xyz-club.org/p',
      'http://w9xyz-club.org:8080/p',
    ];
    const t = paced((url) => {
      if (url.endsWith('/robots.txt')) return res('User-agent: *\n');
      const at = chain.indexOf(url);
      const next = chain[at + 1];
      return next === undefined
        ? res('<p>end</p>')
        : res('', { status: 301, headers: { location: next } });
    });
    await expect(
      t.fetcher.fetch({ url: chain[0] as string, method: 'GET', accept: 'html' }),
    ).rejects.toBeInstanceOf(RequestBudgetExhaustedError);
    expect(t.at).toHaveLength(9);
  });

  /**
   * THE CLAIM THIS TEST USED TO MAKE WAS "gives a genuinely different host its own nine", AND IT IS
   * NOT TRUE ANY MORE — deliberately, and this is the reasoning rather than a note that it changed.
   *
   * The old rationale was that a different host is a different machine owned by somebody else, so
   * each is entitled to a full allowance. What that argument could not survive is that a URL does
   * not say who owns it: `example.org` and `www.example.org` are two hosts by the same test and one
   * machine in almost every deployment on the internet, and the "entitlement" was worth 18 requests
   * to one kernel (`npm run measure-pacing twoNamesOneMachine` at 8ec9873). Every way of telling the
   * two cases apart is a guess that fails badly in the other direction — see `newFetchState`.
   *
   * So the entitlement is gone and what replaces it is stricter: nine per FETCH, wherever it wanders.
   * The assertions below are the ones that always mattered and they are unchanged — a healthy chain
   * across two hosts pays two requests at each, and neither paid for the other.
   *
   * What this costs is stated rather than hidden: a chain that crosses hosts and hits trouble can
   * run out and be skipped for the run, which the next test pins.
   */
  it('charges a chain across two hosts to one purse, and the healthy case still costs four', async () => {
    const t = paced((url) => {
      if (url.endsWith('/robots.txt')) return res('User-agent: *\n');
      return url.includes('k4abc')
        ? res('<p>end</p>')
        : res('', { status: 301, headers: { location: 'https://k4abc-club.org/p' } });
    });
    const payload = await t.fetcher.fetch({
      url: 'https://w9xyz-club.org/p',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.status).toBe(200);
    // Two requests each: its own robots.txt, then its own page. Neither paid for the other.
    const perHost = (needle: string): number =>
      t.transport.mock.calls.filter(([u]) => (u as string).includes(needle)).length;
    expect([perHost('w9xyz'), perHost('k4abc')]).toEqual([2, 2]);
    // …and the handover is paced like everything else, which it was not until this commit.
    expect(t.gaps()).toEqual([FLOOR, FLOOR, FLOOR]);
  });

  /**
   * THE MEASURED DEFECT, PINNED: one machine, two names, one page fetch, eighteen requests.
   *
   * `npm run measure-pacing twoNamesOneMachine` runs this shape against two loopback ADDRESSES
   * (127.0.0.1 and 127.0.0.2 are two hostnames and one kernel, which is the relationship an apex has
   * with its `www`). At 8ec9873 it printed 18 requests to the one machine and 1 of its 17 gaps under
   * the 1000 ms floor; at this commit, 9 and 0 of 8.
   *
   * The construction spends the purse at the first name with the LAST of the nine being the
   * redirect, which is what maximises the second name's share. The second name's `/robots.txt` is
   * the expensive kind, so anything left would go on it — and the assertion is that the second name
   * is never contacted at all.
   */
  it('does not buy a second allowance by crossing to another NAME on one machine', async () => {
    const seen = new Map<string, number>();
    const t = paced((url) => {
      if (url.endsWith('/robots.txt')) return res('User-agent: *\n');
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      if (n <= 3) return res('slow down', { status: 429, headers: { 'retry-after': '0' } });
      const hop = Number(/\/p(\d+)$/.exec(url)?.[1] ?? '0');
      // The fourth request to each page is its redirect: /p0 -> /p1 -> the machine's other name.
      return res('', {
        status: 301,
        headers: { location: hop === 0 ? 'https://w9xyz-club.org/p1' : 'https://www.w9xyz-club.org/p' },
      });
    });
    const payload = await t.fetcher.fetch({
      url: 'https://w9xyz-club.org/p0',
      method: 'GET',
      accept: 'html',
    });
    // 1 robots + 4 + 4 = 9, the ninth being the redirect there is nothing left to follow, so the
    // 3xx becomes the payload exactly as it does when the hop count runs out.
    expect(payload.status).toBe(301);
    expect(t.at).toHaveLength(maxRequestsPerFetch(5, 3));
    expect(t.transport.mock.calls.filter(([u]) => (u as string).includes('www.'))).toEqual([]);
    const gaps = t.gaps();
    expect(gaps.every((gap) => gap >= FLOOR), `gaps were ${gaps.join(', ')} ms`).toBe(true);
  });

  /**
   * THE FLOOR ACROSS THE HANDOVER, which is the half of this finding that is about politeness rather
   * than about arithmetic — and the half that is measurable in an ordinary healthy site.
   *
   * A lane that has never run a request has nothing to pace against, which is right for the first
   * request of a nightly run and wrong in the middle of a redirect chain. Measured at 8ec9873 with
   * `npm run measure-pacing nameChangeHealthy`: the apex -> `www` handover landed 4 ms after the
   * redirect, against the 1000 ms floor this project publishes to the sites it polls. One of four
   * requests, in the commonest redirect there is.
   */
  it('paces the handover when a page redirects from one of a machine’s names to another', async () => {
    const t = paced((url) => {
      if (url.endsWith('/robots.txt')) return res('User-agent: *\n');
      return url.startsWith('https://www.')
        ? res('<p>end</p>')
        : res('', { status: 301, headers: { location: 'https://www.w9xyz-club.org/p' } });
    });
    const payload = await t.fetcher.fetch({
      url: 'https://w9xyz-club.org/p',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.status).toBe(200);
    // apex robots, apex page, www robots, www page — rules are per origin, so the second read is the
    // RFC doing its job rather than a duplicate.
    expect(t.transport.mock.calls.map(([u]) => u)).toEqual([
      'https://w9xyz-club.org/robots.txt',
      'https://w9xyz-club.org/p',
      'https://www.w9xyz-club.org/robots.txt',
      'https://www.w9xyz-club.org/p',
    ]);
    expect(t.gaps()).toEqual([FLOOR, FLOOR, FLOOR]);
  });

  /**
   * THE DIRECTION THE FIRST ATTEMPT AT THIS FIX MISSED: the way BACK.
   *
   * Pacing at the point of redirect covers apex -> `www`. It does not cover what happens next when
   * the redirect was the `/robots.txt` chain: the rules are read at `www` and then the PAGE is
   * fetched from the apex, whose lane last ran a request before the handover and is therefore free
   * to fire immediately. Two requests, one machine, same millisecond. Pacing at the point of
   * REQUEST — every request against wherever this fetch's previous one went — is what covers both,
   * and this test fails if anyone moves it back to the redirect site.
   */
  it('paces the way back, when a robots.txt at one name is answered at another', async () => {
    const t = paced((url) => {
      if (url === 'https://w9xyz-club.org/robots.txt') {
        return res('', {
          status: 301,
          headers: { location: 'https://www.w9xyz-club.org/robots.txt' },
        });
      }
      if (url === 'https://www.w9xyz-club.org/robots.txt') return res('User-agent: *\n');
      return res('<p>ok</p>');
    });
    const payload = await t.fetcher.fetch({
      url: 'https://w9xyz-club.org/p',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.status).toBe(200);
    expect(t.transport.mock.calls.map(([u]) => u)).toEqual([
      'https://w9xyz-club.org/robots.txt',
      'https://www.w9xyz-club.org/robots.txt',
      'https://w9xyz-club.org/p',
    ]);
    expect(t.gaps()).toEqual([FLOOR, FLOOR]);
  });

  /**
   * THE TWO KEYS ARE STILL TWO KEYS, and this is the test that fails if somebody "simplifies" the
   * fix by keying the robots cache on the host as well. RFC 9309 §2.3 scopes `/robots.txt` to a
   * scheme/host/port triple; a service on :8443 that publishes `Disallow: /` must not be crawled
   * because :443 published nothing.
   */
  it('still reads one robots.txt per ORIGIN even though they share one purse', async () => {
    const t = paced((url) => {
      if (url === 'https://w9xyz-club.org/robots.txt') return res('User-agent: *\n');
      if (url === 'https://w9xyz-club.org:8443/robots.txt') {
        return res('User-agent: GrantSpotter\nDisallow: /\n');
      }
      return res('<p>ok</p>');
    });
    expect(
      (await t.fetcher.fetch({ url: 'https://w9xyz-club.org/p', method: 'GET', accept: 'html' }))
        .status,
    ).toBe(200);
    await expect(
      t.fetcher.fetch({ url: 'https://w9xyz-club.org:8443/p', method: 'GET', accept: 'html' }),
    ).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(t.transport.mock.calls.filter(([u]) => (u as string).endsWith('/robots.txt'))).toHaveLength(2);
  });

  /**
   * THE FOOTPRINT THE SHIPPED REGISTRY ACTUALLY HAS. `sources/arrl-news-rss.ts:6` and
   * `sources/arrl-scholarship-descriptions.ts:13` name `http://www.arrl.org`; six other modules name
   * `https://www.arrl.org`. That is two origins on one machine, so a nightly run against an
   * arrl.org that published `Disallow: /` costs it TWO requests and not one — and no amount of
   * sharing the purse changes that, because the second read is the RFC doing its job rather than a
   * bug: we genuinely have not read the rules for `https://www.arrl.org` until we ask it.
   *
   * Making it one is a REGISTRY decision, not a fetcher one: spell both source URLs `https://`.
   * That is not done here because `CATALOG_URL` in `arrl-scholarship-descriptions.ts` is also the
   * `sourceUrl` stamped on all 111 shipped ARRL scholarship records and on the seed corpus, so
   * changing it rewrites published provenance — a different change, owned by whoever owns
   * `sources/` and `seed/`.
   */
  it('costs a blocked two-origin host two requests a night, which is what the registry asks for', async () => {
    const t = paced(() => res('User-agent: GrantSpotter\nDisallow: /\n'));
    for (const url of ['http://www.arrl.org/news/rss', 'https://www.arrl.org/etp-grants']) {
      await expect(
        t.fetcher.fetch({ url, method: 'GET', accept: 'xml' }),
      ).rejects.toBeInstanceOf(RobotsDisallowedError);
    }
    expect(t.transport.mock.calls.map(([u]) => u)).toEqual([
      'http://www.arrl.org/robots.txt',
      'https://www.arrl.org/robots.txt',
    ]);
  });

  it('names the server and the number when it stops, rather than reading as a network failure', async () => {
    const seen = new Map<string, number>();
    const robots = expensiveRobots(seen);
    const t = paced((url) => robots(url) ?? res('<p>ok</p>'));
    const err = await t.fetcher
      .fetch({ url: 'https://w9xyz-club.org/p', method: 'GET', accept: 'html' })
      .then(() => null, (e: unknown) => e as Error);
    expect(err).toBeInstanceOf(RequestBudgetExhaustedError);
    expect(err?.message).toContain('w9xyz-club.org');
    expect(err?.message).toContain('9 HTTP requests');
    // The generic fall-through it used to hit said only this, which sends whoever is on call to
    // look at the network for a crawler that is working exactly as designed.
    expect(err?.message).not.toContain('fetch failed');
  });

  /**
   * A CONFIG KNOB MAY NOT TURN DOWN AN RFC. `maxRedirects` governs how far a PAGE is chased;
   * `ROBOTS_MAX_REDIRECTS` is a floor RFC 9309 §2.3.1.2 puts on being polite and is deliberately
   * not configurable. Sizing one shared purse off `maxRedirects` alone would let `maxRedirects: 0`
   * shrink the allowance to four and stop a robots.txt chain the RFC says we must follow.
   */
  it('does not let a low maxRedirects shrink what a robots.txt chain may spend', async () => {
    const t = paced(
      (url) => {
        const match = /\/robots(\d*)\.txt$/.exec(url);
        if (match === null) return res('<p>end</p>');
        const hop = Number(match[1] === '' ? '0' : match[1]);
        if (hop >= ROBOTS_MAX_REDIRECTS) return res('User-agent: *\nDisallow: /nope\n');
        const next = new URL(`/robots${hop + 1}.txt`, url).toString();
        return res('', { status: 301, headers: { location: next } });
      },
      { maxRedirects: 0 },
    );
    const payload = await t.fetcher.fetch({
      url: 'https://w9xyz-club.org/p',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.status).toBe(200);
    // All five hops walked, then the page: six requests, inside a purse of nine.
    expect(t.at).toHaveLength(ROBOTS_MAX_REDIRECTS + 2);
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
