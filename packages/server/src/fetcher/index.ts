import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FetchRequest, FetchedPayload } from '@grantspotter/core';
import { ConfigError, buildUserAgent } from '../config.js';
import { assertNotBlocked, normalizeHost } from './blocklist.js';
import { HostQueue } from './hostQueue.js';
import {
  type RobotsRules,
  ROBOTS_MAX_REDIRECTS,
  RobotsDisallowedError,
  isPathAllowed,
  robotsFromResponse,
  robotsUnread,
} from './robots.js';

export const AGENT_TOKEN = 'GrantSpotter';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/**
 * How long a robots.txt may be believed. Six hours: comfortably shorter than the nightly crawl
 * interval, so even a path that never calls `forgetRobots` re-reads at least daily.
 *
 * IT USED TO BE FOREVER, and the comment in `robots.ts` claimed otherwise ("until the next nightly
 * poll re-reads it"). There was no re-read: `robotsCache` was a `Map` keyed by origin that nothing
 * ever removed from, so a container up for months never noticed a `Disallow: /` added weeks ago.
 * That is not an ordinary stale comment — `robots.txt` is the remedy the README and the crawler
 * issue template give a site owner as THE way to stop every deployment of this software, so the
 * gap was between what we tell an annoyed stranger to do and what the code does with it.
 *
 * Two mechanisms, because they cover different paths: `runCrawl` calls `forgetRobots()` at the
 * start of every run, which makes "a new robots.txt takes effect on the next nightly crawl" exact
 * rather than approximate; this TTL bounds every other path (the admin "Verify now" action, a
 * manual re-poll) without depending on anyone remembering to call anything.
 */
export const ROBOTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * How long a FAILED read of robots.txt is remembered — fifteen minutes, not six hours.
 *
 * The verdict for an origin we could not read is `Disallow: /` (see `robotsUnread`), and until
 * 2026-08-04 that was stored in the cache exactly like a file we had read, for the full
 * ROBOTS_CACHE_TTL_MS. One dropped connection therefore refused a whole origin for a quarter of a
 * day, including to the admin "Verify now" button pressed thirty seconds later by somebody watching
 * the site load fine in their browser.
 *
 * NOT CACHING IT AT ALL IS WORSE, WHICH IS WHY THIS IS A NUMBER AND NOT A DELETION. `robotsFor` is
 * consulted once per PAGE, so an uncached failure means every page queued against that origin
 * re-reads `/robots.txt` — each read now costing up to four attempts (see `fetchWithRetries`) — at a
 * host that has just proved it is in trouble. The cache is what makes one failure cost one read.
 *
 * Fifteen minutes is chosen against the two bounds that actually exist rather than picked. Below:
 * the entry must outlive the run that created it, and one failing origin costs at most
 * maxRetries+1 attempts, each bounded by DEFAULT_TIMEOUT_MS with backoffs capped at MAX_BACKOFF_MS
 * — a little over two minutes at the default settings — against a nightly run of ~25 sources.
 * Above: it must be short enough that a human who fixes the problem and re-triggers does not meet
 * their own stale refusal, and short enough that a blip cannot span two crawls. Anything in tens of
 * minutes satisfies both; this is the middle of that range, and `runCrawl`'s `forgetRobots()` makes
 * the exact figure irrelevant to the nightly path in any case.
 */
export const ROBOTS_UNREAD_CACHE_TTL_MS = 15 * 60 * 1000;

export interface FetchOptions {
  userAgent: string;
  contactUrl: string;
  timeoutMs?: number;
  /** When set, every payload is persisted under `${dataDir}/snapshots/`. */
  dataDir?: string;
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  maxRetries?: number;
  maxRedirects?: number;
  defaultMinIntervalMs?: number;
  /**
   * Extra request headers keyed by exact hostname (Task 24). FetchRequest carries no headers and
   * the optional Simpler.Grants.gov key must travel as `X-Auth`. The User-Agent is written after
   * these and is therefore not overridable: no UA spoofing, ever.
   */
  headersByHost?: Record<string, Record<string, string>>;
  /** Defaults to ROBOTS_CACHE_TTL_MS. Tests set it to exercise expiry against an injected clock. */
  robotsTtlMs?: number;
  /** Defaults to ROBOTS_UNREAD_CACHE_TTL_MS, and applies only to a read that failed. */
  robotsUnreadTtlMs?: number;
}

export interface Fetcher {
  fetch(req: FetchRequest): Promise<FetchedPayload>;
  /**
   * Drop every cached robots.txt, so the next fetch to each origin re-reads it.
   *
   * Required, not optional, and that is deliberate: every implementation of this interface —
   * including the fixture fetchers in the test suite — has to answer the question "what happens
   * when a site publishes new rules?", and an optional method is answered by forgetting to
   * implement it. `runCrawl` calls this at the start of every run.
   */
  forgetRobots(): void;
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(url: string, status: number) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.url = url;
  }
}

// RESOLUTIONS R10: `buildUserAgent` is defined ONCE, in packages/server/src/config.ts, widened
// there to `buildUserAgent(source: AppConfig | string): string`. This module must not define a
// second copy — two definitions meant two different User-Agent strings on the wire depending on
// the call path. Callers pass the result in as `FetchOptions.userAgent`.

/** Exponential backoff with full jitter, capped at 30s. Retry-After wins outright. */
export function backoffMs(attempt: number, rand: () => number, retryAfterSec?: number): number {
  if (typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
    return Math.min(MAX_BACKOFF_MS, Math.round(retryAfterSec * 1000));
  }
  const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return Math.round(ceiling * (0.5 + 0.5 * rand()));
}

const EXT: Record<FetchRequest['accept'], string> = {
  html: 'html',
  json: 'json',
  xml: 'xml',
  binary: 'bin',
};

const ACCEPT_HEADER: Record<FetchRequest['accept'], string> = {
  html: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  json: 'application/json,*/*;q=0.5',
  xml: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5',
  binary: '*/*',
};

export function snapshotPathFor(
  dataDir: string,
  url: string,
  accept: FetchRequest['accept'],
  fetchedAt: string,
): string {
  const host = normalizeHost(url);
  const bucket = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const stamp = fetchedAt.replace(/[:.]/g, '-');
  return path.join(dataDir, 'snapshots', host, bucket, `${stamp}.${EXT[accept]}`);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return seconds;
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, Math.round((when - Date.now()) / 1000));
  return undefined;
}

export function createFetcher(opts: FetchOptions): Fetcher {
  /*
   * THE POLLING BOUNDARY. Every request this software makes TO A SITE IT POLLS is made by a
   * fetcher, so this is where "the User-Agent on the wire was validated" stops being a convention
   * and becomes a fact about polling.
   *
   * `buildUserAgent` runs `assertUsableContactUrl`, so an unusable contactUrl throws here — before
   * a transport exists, let alone a request. The equality then closes the other half: a
   * hand-assembled User-Agent that never went through the single UA factory (RESOLUTIONS R10) is
   * refused even if it looks right. Both halves are what the two scripts in `scripts/` needed and
   * did not have.
   *
   * WHAT THIS IS NOT, because the sentence above used to be broader and was FALSE AS WRITTEN. It
   * said "every User-Agent this codebase sends leaves through this function", and two files
   * already contradicted it: `realClient` in the `ai/` tree constructs the Anthropic SDK, which
   * makes its own HTTPS request to api.anthropic.com, and `e2e/shippedSeed.ts` calls
   * `globalThis.fetch` against the server the harness itself just started. Neither is a defect —
   * an SDK call to a paid API the operator holds a key for is not a poll of a volunteer-run
   * funder's site, and driving our own test server through the crawler's politeness machinery
   * would test the machinery rather than the server — but a structural guarantee that two files in
   * the same repository already break is a claim, and this codebase's whole history is the removal
   * of claims like it.
   *
   * (The module is named by path in the contract test rather than here. The assist's own test
   * enforces "never on a read path" by scanning every file under `src/` for its import path as
   * TEXT, comments included, so writing that path in this comment would fail a guard that has
   * nothing to do with this one.)
   *
   * The narrowed claim is checked rather than asserted:
   * `test/contactUrlEntryPointContract.test.ts` fixes the list of files that reach the network
   * without a fetcher at exactly those two, and fails when a third appears.
   */
  const expectedUserAgent = buildUserAgent(opts.contactUrl);
  if (opts.userAgent !== expectedUserAgent) {
    throw new ConfigError(
      'createFetcher was given a User-Agent that buildUserAgent did not produce from the ' +
        'contactUrl beside it. There is exactly one User-Agent in this software (config.ts, ' +
        `RESOLUTIONS R10); pass \`buildUserAgent(contactUrl)\`. Expected "${expectedUserAgent}", ` +
        `got "${opts.userAgent}".`,
    );
  }
  const transport = opts.transport ?? ((url, init) => globalThis.fetch(url, init));
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const rand = opts.rand ?? Math.random;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 3;
  const maxRedirects = opts.maxRedirects ?? 5;
  const queue = new HostQueue({
    defaultMinIntervalMs: opts.defaultMinIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    now,
    sleep,
  });
  const robotsTtlMs = opts.robotsTtlMs ?? ROBOTS_CACHE_TTL_MS;
  const robotsUnreadTtlMs = opts.robotsUnreadTtlMs ?? ROBOTS_UNREAD_CACHE_TTL_MS;
  const robotsCache = new Map<string, { expiresAtMs: number; rules: Promise<RobotsRules> }>();

  function headers(
    url: string,
    accept: FetchRequest['accept'],
    isJsonBody: boolean,
  ): Headers {
    const host = normalizeHost(url);
    const extra = opts.headersByHost?.[host];
    const h = new Headers({
      ...(extra ?? {}),
      accept: ACCEPT_HEADER[accept],
      'accept-language': 'en-US,en;q=0.9',
    });
    if (isJsonBody) h.set('content-type', 'application/json');
    // Written last: the descriptive, contact-URL-bearing User-Agent is never overridable by
    // headersByHost or anything else. No UA spoofing, ever.
    h.set('user-agent', opts.userAgent);
    return h;
  }

  /**
   * Read one origin's robots.txt, following redirects.
   *
   * Every request here sends `redirect: 'manual'` — every request this fetcher makes does, so that
   * the blocklist can be re-asserted on each hop rather than trusting `fetch` to land somewhere
   * acceptable. That is right for pages and it was silently wrong here: nothing followed the
   * redirect, the 3xx fell through `robotsFromResponse` to its allow-all branch, and a site whose
   * `/robots.txt` 301s (apex to `www`, http to https — the default behaviour of most hosting a
   * small nonprofit uses) was crawled as though it had published no rules at all.
   *
   * The rules that come back apply to the origin we ASKED, wherever the chain ends: RFC 9309
   * §2.3.1.2, which requires following at least five redirects, explicitly across authorities.
   * A chain that does not resolve within ROBOTS_MAX_REDIRECTS hops, or that we decline to follow,
   * is handed to `robotsFromResponse` as a 3xx, which backs off for this run — see the
   * enumeration there for why that is not the same choice the RFC makes.
   *
   * TWO THINGS THIS FUNCTION HAD TO STOP DOING BY ITSELF, both self-inflicted by the commit that
   * added redirect following:
   *
   *   IT WENT ROUND THE HOST QUEUE. It called the transport directly, so the redirect chain above
   *   could issue up to ROBOTS_MAX_REDIRECTS + 1 requests to one host back to back, against a
   *   shipped floor of one per second that the README advertises to the sites being polled.
   *   Measured with the real fetcher against a loopback HTTP server serving a five-hop chain, the
   *   gaps one host saw were 18, 2, 2, 2 and 5 ms; after this change, 1013, 1004, 1002, 1003 and
   *   1004. The commit that made this crawler more obedient made it burstier. Every hop
   *   goes through `queue.run` now, on the host of THAT hop, so a chain that crosses authorities is
   *   still spaced per host and the page fetch that follows is spaced from the last hop.
   *
   *   IT GOT ONE ATTEMPT WHERE A PAGE GETS FOUR. It called the raw transport rather than
   *   `fetchWithRetries`, so the file that governs a whole origin was the least-retried request the
   *   crawler makes — and a single dropped connection then opened the origin, because the `catch`
   *   below manufactured a 404. Both halves are fixed together because either alone leaves the hole:
   *   retries without the verdict change still open the origin on the fourth failure, and the
   *   verdict change without retries refuses an origin over one lost packet.
   */
  async function readRobots(origin: string): Promise<RobotsRules> {
    const stamp = (): string => new Date(now()).toISOString();
    let url = `${origin}/robots.txt`;
    assertNotBlocked(url);
    for (let hop = 0; ; hop += 1) {
      let response: Response;
      let body = '';
      try {
        const request: FetchRequest = { url, method: 'GET', accept: 'html' };
        // `new URL(url).host` and not the origin we were asked about: a chain may cross
        // authorities, and the host that has to be spaced is the one about to be asked.
        response = await queue.run(new URL(url).host, () => fetchWithRetries(url, request));
        if (response.status === 200) body = await response.text();
      } catch (err) {
        if (err instanceof HttpStatusError) {
          // 429 or 5xx, after every retry. The server did answer, so record what it said and let
          // `robotsFromResponse` back off on it — that branch already refuses to read a server in
          // distress as permission.
          return robotsFromResponse(err.status, '', AGENT_TOKEN, stamp());
        }
        // A transport failure: connection refused, reset, or timed out on every attempt. THIS USED
        // TO RETURN `robotsFromResponse(404, …)`, which is the allow-all branch — flatly against
        // the comment sitting on top of it, which said a network error "is not a licence to crawl
        // freely". A site that drops the connection on `/robots.txt` was crawled as though it had
        // published nothing, and dropping that one connection is exactly what an overloaded box or
        // a WAF in front of a volunteer-run site does. We did not read the rules, so we do not get
        // to act as though they permit us; `robotsUnread` says so, and `robotsFor` gives that
        // verdict a much shorter lifetime than a real one so the refusal costs the source minutes
        // rather than a quarter of a day.
        return robotsUnread(stamp());
      }
      if (response.status < 300 || response.status >= 400) {
        return robotsFromResponse(response.status, body, AGENT_TOKEN, stamp());
      }
      const location = response.headers.get('location');
      if (location === null || hop >= ROBOTS_MAX_REDIRECTS) {
        return robotsFromResponse(response.status, '', AGENT_TOKEN, stamp());
      }
      let next: string;
      try {
        next = new URL(location, url).toString();
        // Re-asserted on every hop, exactly as `fetchOne` does: a robots.txt that redirects into
        // the farweb.org -> batualam.org takeover chain must not be fetched either.
        assertNotBlocked(next);
      } catch {
        // An unparseable `Location`, a non-http scheme, or a blocked host. We did not read this
        // site's rules, so we do not get to act as if they permit us.
        return robotsFromResponse(response.status, '', AGENT_TOKEN, stamp());
      }
      url = next;
    }
  }

  async function robotsFor(origin: string): Promise<RobotsRules> {
    const cached = robotsCache.get(origin);
    // Cached for the run, never for the life of the process. `now()` is injected, so this is the
    // same clock the host queue and the payload timestamps use.
    if (cached && now() < cached.expiresAtMs) return cached.rules;
    const readAtMs = now();
    const promise = readRobots(origin);
    // Optimistic: assume the read will succeed, so a second page queued against this origin while
    // the first read is still in flight shares it rather than starting a second one.
    const entry = { expiresAtMs: readAtMs + robotsTtlMs, rules: promise };
    robotsCache.set(origin, entry);
    promise.then(
      (rules) => {
        // The lifetime depends on the OUTCOME, which is not known when the entry is created. A
        // verdict we failed to read expires in minutes; one we read keeps the full TTL. Revised
        // here rather than at read time because that is the earliest moment the answer exists.
        if (!rules.wasRead) entry.expiresAtMs = readAtMs + robotsUnreadTtlMs;
      },
      () => {
        // `readRobots` rejects only when the origin itself is blocklisted, which is decided with no
        // network access at all. Caching a rejected promise would hand the same rejection to every
        // later caller; dropping it costs one synchronous re-check.
        robotsCache.delete(origin);
      },
    );
    return promise;
  }

  async function attempt(url: string, req: FetchRequest): Promise<Response> {
    const isPost = req.method === 'POST';
    return transport(url, {
      method: req.method,
      headers: headers(url, req.accept, isPost && req.body !== undefined),
      body: isPost && req.body !== undefined ? JSON.stringify(req.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function fetchWithRetries(url: string, req: FetchRequest): Promise<Response> {
    let lastError: unknown;
    for (let i = 0; i <= maxRetries; i += 1) {
      try {
        const response = await attempt(url, req);
        if (response.status === 429 || response.status >= 500) {
          if (i === maxRetries) throw new HttpStatusError(url, response.status);
          await sleep(backoffMs(i, rand, parseRetryAfter(response.headers.get('retry-after'))));
          continue;
        }
        return response;
      } catch (err) {
        if (err instanceof HttpStatusError) throw err;
        lastError = err;
        if (i === maxRetries) break;
        await sleep(backoffMs(i, rand));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`fetch failed for ${url}`);
  }

  async function fetchOne(url: string, req: FetchRequest, hop: number): Promise<FetchedPayload> {
    assertNotBlocked(url);
    const parsed = new URL(url);
    const rules = await robotsFor(parsed.origin);
    if (!isPathAllowed(rules, `${parsed.pathname}${parsed.search}`)) {
      throw new RobotsDisallowedError(url);
    }
    if (rules.crawlDelaySec !== undefined) {
      queue.setMinInterval(parsed.host, Math.round(rules.crawlDelaySec * 1000));
    }

    const response = await queue.run(parsed.host, () => fetchWithRetries(url, req));

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location && hop < maxRedirects) {
        const next = new URL(location, url).toString();
        // Re-assert on every hop. This is what stops farweb.org -> batualam.org and any
        // future takeover chain from reaching a parser.
        assertNotBlocked(next);
        return fetchOne(next, req, hop + 1);
      }
    }

    const fetchedAt = new Date(now()).toISOString();
    const contentType = response.headers.get('content-type') ?? '';
    const body =
      req.accept === 'binary'
        ? Buffer.from(await response.arrayBuffer()).toString('base64')
        : await response.text();

    const payload: FetchedPayload = {
      url,
      status: response.status,
      contentType,
      body,
      fetchedAt,
    };

    if (opts.dataDir) {
      const file = snapshotPathFor(opts.dataDir, url, req.accept, fetchedAt);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body, 'utf8');
    }
    return payload;
  }

  return {
    // async: assertNotBlocked must surface as a rejected Promise, not a synchronous throw, so
    // every caller can uniformly `await` or `.catch()` the fetcher regardless of which guard
    // (blocklist, robots, retries) is what ultimately fails.
    async fetch(req: FetchRequest): Promise<FetchedPayload> {
      assertNotBlocked(req.url);
      return fetchOne(req.url, req, 0);
    },
    forgetRobots(): void {
      robotsCache.clear();
    },
  };
}
