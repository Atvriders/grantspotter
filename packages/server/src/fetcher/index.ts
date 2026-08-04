import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FetchRequest, FetchedPayload } from '@grantspotter/core';
import { ConfigError, buildUserAgent } from '../config.js';
import { canonicalOrigin } from '../net/hosts.js';
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
 * re-reads `/robots.txt` — each read now costing up to `maxRequestsPerFetch` requests — at a host
 * that has just proved it is in trouble. The cache is what makes one failure cost one read.
 *
 * Fifteen minutes is chosen against the two bounds that actually exist rather than picked. Below:
 * the entry must outlive the run that created it, and one failing origin costs at most
 * `maxRequestsPerFetch(ROBOTS_MAX_REDIRECTS, maxRetries)` = 9 requests, each bounded by
 * DEFAULT_TIMEOUT_MS and separated by at least the host interval — a few minutes at the default
 * settings — against a nightly run of ~25 sources.
 * Above: it must be short enough that a human who fixes the problem and re-triggers does not meet
 * their own stale refusal, and short enough that a blip cannot span two crawls. Anything in tens of
 * minutes satisfies both; this is the middle of that range, and `runCrawl`'s `forgetRobots()` makes
 * the exact figure irrelevant to the nightly path in any case.
 */
export const ROBOTS_UNREAD_CACHE_TTL_MS = 15 * 60 * 1000;

/**
 * The most HTTP requests one logical fetch may cost the host it is aimed at — ONE PURSE shared by
 * redirect hops and retries, rather than two independent limits that multiply.
 *
 * WHAT THIS REPLACES. `maxRedirects` bounded hops and `maxRetries` bounded attempts, and the
 * retry loop sat INSIDE the per-hop loop, so the real bound was their product: a `/robots.txt`
 * that both 429s and 301s cost (5 hops + 1) x (3 retries + 1) = 24 requests. Measured at HEAD
 * against a loopback server serving exactly that: 19 requests in 6051 ms with 12 of the 18 gaps
 * under the 1000 ms floor. The crawler-contact issue template, meanwhile, promised "up to five
 * hops, spaced at least a second apart, plus up to four attempts" — the ADDITIVE bound, which
 * nothing enforced. Two ways to fix a false promise: correct the promise, or make it true. This is
 * the second, because the number in the template is the number a site owner uses to decide whether
 * what they are seeing in their logs is us misbehaving.
 *
 * `hops + retries + 1`: enough to follow a full-length redirect chain (each hop costs one) and
 * still hold the whole retry budget in reserve for whichever hop actually fails, which is the case
 * the two limits were sized for individually. What it refuses is spending the retry budget again at
 * every hop. When the purse runs out mid-chain the chain simply stops, and an unresolved chain is
 * already handled the polite way — `robotsFromResponse` reads a 3xx as "we never read the rules"
 * and backs off for the run.
 *
 * NOT A PER-ORIGIN-PER-RUN BUDGET, which was the other candidate, and the reason is arithmetic
 * rather than taste. Measured over the shipped source registry (27 sources, 17 hosts), one crawl
 * run legitimately makes 30 requests to `api.grants.gov` (5 searches + up to 25 detail fetches,
 * `MAX_DETAIL_FETCHES`), 12 to `www.ardc.net` and 9 to `www.arrl.org`. A single flat per-origin cap
 * would therefore have to sit at 40-plus to avoid truncating a legitimate federal crawl — far above
 * anything a volunteer-run club site could ever see, so it would bound nothing that anyone is
 * worried about while being able to silently cut a crawl short. The per-fetch purse is the tighter
 * bound where it matters: a site that publishes `Disallow: /` is fetched once per run and its whole
 * nightly footprint is this number.
 */
export function maxRequestsPerFetch(maxHops: number, maxRetries: number): number {
  return maxHops + maxRetries + 1;
}

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
   * A chain that does not resolve within ROBOTS_MAX_REDIRECTS hops, that exhausts the request
   * purse, or that we decline to follow, is handed to `robotsFromResponse` as a 3xx, which backs
   * off for this run — see the enumeration there for why that is not the same choice the RFC makes.
   *
   * THIS FUNCTION IS NOT SPECIAL, and that is the point of the shape it now has: it walks hops and
   * spends a purse exactly like `fetchOne` does, through the same `gatedRequest`, so `/robots.txt`
   * gets the same retry budget, the same per-host gate on every single attempt, and the same
   * additive cap on how many requests one read can cost. Two earlier rounds of this bug were both
   * "robots.txt does its own thing": first it called the raw transport (one attempt where a page
   * got four, and a dropped connection manufactured a 404 that opened the whole origin), then it
   * wrapped a whole retry loop in one queue slot (bursts of 2-5 ms against a 1000 ms floor).
   */
  async function readRobots(origin: string): Promise<RobotsRules> {
    const stamp = (): string => new Date(now()).toISOString();
    const budget = { remaining: maxRequestsPerFetch(ROBOTS_MAX_REDIRECTS, maxRetries) };
    let url = `${origin}/robots.txt`;
    assertNotBlocked(url);
    for (let hop = 0; ; hop += 1) {
      let response: Response;
      let body = '';
      try {
        const request: FetchRequest = { url, method: 'GET', accept: 'html' };
        response = await gatedRequest(url, request, budget);
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
      // Empty counts as absent. `new URL('', url)` resolves to `url` itself, so following an empty
      // `Location` would re-request the same address until the hop budget ran out — five wasted
      // requests to a server that is already answering strangely, ending in the same back-off.
      if (!location || hop >= ROBOTS_MAX_REDIRECTS || budget.remaining <= 0) {
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

  /** What one gated attempt did, reported back OUT of the queue slot rather than thrown from it. */
  type Attempted =
    | { kind: 'ok'; response: Response }
    | { kind: 'status'; status: number }
    | { kind: 'error'; error: unknown };

  /**
   * ONE HTTP REQUEST PER GATE ENTRY. This is the whole fix, and everything else in this file is
   * arranged so that this stays true.
   *
   * The retry loop is OUTSIDE `queue.run` and each attempt is INSIDE it. It used to be the other
   * way round — `queue.run(host, () => fetchWithRetries(url, req))` — which meant the gate was
   * entered once per LOGICAL fetch, and every retry after the first went straight to the wire from
   * inside a slot the lane was already holding. Measured at HEAD against a loopback server
   * answering `429` with `Retry-After: 0`, one host saw gaps of 4, 3 and 3 ms against the 1000 ms
   * floor this project's README advertises; a host publishing `Crawl-delay: 5` saw 971, 1008 and
   * 2618 ms on a 503, never 5000.
   *
   * THE PENALTY IS RECORDED ON THE LANE, NOT SLEPT THROUGH HERE, and it is recorded from inside the
   * slot — see `HostQueue.defer`. `Retry-After` composes with the host floor by MAX: 0 s still costs
   * the floor, 30 s costs 30 s. That composition lives in one place, `HostQueue.releaseAt`, because
   * it is the same question the gate already answers for every other request.
   *
   * The penalty is recorded even on the attempt we have no budget to follow: a 429 is the server
   * asking us to stop asking, and the next request to that host is exactly what it was asking
   * about, even if that request belongs to a different page.
   *
   * `budget` is the shared purse (see `maxRequestsPerFetch`). Every attempt costs one, whichever
   * hop of whichever chain it belongs to.
   */
  async function gatedRequest(
    url: string,
    req: FetchRequest,
    budget: { remaining: number },
  ): Promise<Response> {
    // The pacing lane is keyed by CANONICAL HOSTNAME, port and trailing root dots removed, so
    // `example.org`, `example.org.` and `example.org:8443` are one budget and not three. The two
    // host-derived values in this file were the last places that still compared raw
    // `URL.host` — four copies of the trailing-dot bug have been found in this repository, one of
    // them in a blocklist check, so there is exactly one spelling of it now (`net/hosts.ts`).
    // Dropping the port deliberately errs towards polling less: two ports are two servers to HTTP
    // and one machine to the person whose bandwidth it is.
    const host = normalizeHost(url);
    let last: Attempted | undefined;
    for (let i = 0; i <= maxRetries && budget.remaining > 0; i += 1) {
      budget.remaining -= 1;
      const outcome = await queue.run(host, async (): Promise<Attempted> => {
        try {
          const response = await attempt(url, req);
          if (response.status === 429 || response.status >= 500) {
            const askedFor = parseRetryAfter(response.headers.get('retry-after'));
            queue.defer(host, backoffMs(i, rand, askedFor));
            return { kind: 'status', status: response.status };
          }
          return { kind: 'ok', response };
        } catch (error) {
          queue.defer(host, backoffMs(i, rand));
          return { kind: 'error', error };
        }
      });
      if (outcome.kind === 'ok') return outcome.response;
      last = outcome;
    }
    if (last?.kind === 'status') throw new HttpStatusError(url, last.status);
    const error = last?.kind === 'error' ? last.error : undefined;
    throw error instanceof Error ? error : new Error(`fetch failed for ${url}`);
  }

  /**
   * Fetch one page, following redirects, spending one purse across every hop and every retry.
   *
   * WHY robots.txt IS READ OUTSIDE THE GATE AND CANNOT DEADLOCK. `robotsFor` may have to fetch
   * `/robots.txt`, and that read enters the SAME host's lane through `gatedRequest`. It is awaited
   * here, at the top of a hop, while this function holds no slot at all — `gatedRequest` acquires
   * and releases a slot per attempt and never spans an `await robotsFor`. So the lane is always
   * free for the robots read to take, and the ordering is: resolve the rules, then queue the
   * request they govern. Awaiting `robotsFor` from inside a slot would be a self-deadlock (the read
   * waits for a lane this call is holding), and the shared in-flight promise in `robotsFor` would
   * make it a deadlock for every other page on that origin too. Any future edit that moves a
   * `robotsFor` call inside a `queue.run` callback reintroduces it.
   *
   * This was recursion (`fetchOne(next, req, hop + 1)`) and is now a loop, because the purse and
   * the hop count have to be one piece of state that every hop shares rather than an argument each
   * level is free to reset.
   */
  async function fetchOne(startUrl: string, req: FetchRequest): Promise<FetchedPayload> {
    const budget = { remaining: maxRequestsPerFetch(maxRedirects, maxRetries) };
    let url = startUrl;
    let response: Response;
    for (let hop = 0; ; hop += 1) {
      assertNotBlocked(url);
      const parsed = new URL(url);
      const rules = await robotsFor(canonicalOrigin(parsed));
      if (!isPathAllowed(rules, `${parsed.pathname}${parsed.search}`)) {
        throw new RobotsDisallowedError(url);
      }
      if (rules.crawlDelaySec !== undefined) {
        // Set BEFORE the request it governs, and honoured because `HostQueue` reads the interval
        // when it releases rather than stamping a deadline when the previous request ended. Those
        // two facts together are what make a `Crawl-delay` apply to the first page after the
        // robots.txt that asked for it instead of the second.
        queue.setMinInterval(normalizeHost(url), Math.round(rules.crawlDelaySec * 1000));
      }

      response = await gatedRequest(url, req, budget);

      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      // Out of hops or out of purse: the 3xx itself becomes the payload, exactly as it did when
      // only `maxRedirects` could stop the chain. `!location` and not `=== null` because an empty
      // `Location` resolves back to this same URL — see the matching note in `readRobots`.
      if (!location || hop >= maxRedirects || budget.remaining <= 0) break;
      const next = new URL(location, url).toString();
      // Re-assert on every hop. This is what stops farweb.org -> batualam.org and any
      // future takeover chain from reaching a parser.
      assertNotBlocked(next);
      url = next;
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
      return fetchOne(req.url, req);
    },
    forgetRobots(): void {
      robotsCache.clear();
    },
  };
}
