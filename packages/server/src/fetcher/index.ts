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
 * the entry must outlive the run that created it, and one failing origin costs at most the whole
 * per-fetch purse (9 at the shipped defaults — see `createFetcher`'s `purseSize`), each request
 * bounded by DEFAULT_TIMEOUT_MS and separated by at least the host interval — a few minutes at the
 * default settings — against a nightly run of ~25 sources.
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
 * `MAX_DETAIL_FETCHES`), 12 to `www.ardc.net` and 10 to `www.arrl.org` — the last of those being
 * eight source URLs (six spelled `https://`, two still `http://`) plus one `/robots.txt` read at
 * each of the two origins that spelling puts them under. (It read "9" until 2026-08-04, which
 * counted the pages and one robots read; two origins means two reads, and three if the `http://`
 * one redirects.) A single flat per-origin cap
 * would therefore have to sit at 40-plus to avoid truncating a legitimate federal crawl — far above
 * anything a volunteer-run club site could ever see, so it would bound nothing that anyone is
 * worried about while being able to silently cut a crawl short. The per-fetch purse is the tighter
 * bound where it matters: a site that publishes `Disallow: /` is fetched once per run and its whole
 * nightly footprint is this number.
 *
 * IT IS ONE PURSE PER LOGICAL FETCH, AND IT HAS BEEN THREE DIFFERENT THINGS IN ONE DAY.
 * `fetchOne` opened one for the page and `readRobots` opened another for EVERY origin the fetch
 * touched, so the number below bounded neither of the two things the README says it bounds.
 * Measured at 2c098d9 with `npm run measure-pacing`, against loopback servers, one page fetch:
 *
 *   ceilingOneOrigin    one host, one origin                   18 requests   (2 x 9)
 *   schemeChange        one host, http -> https                20 requests
 *   ceilingManyOrigins  one host, five hops across 6 origins   63 requests   (7 x 9)
 *
 * Keying one purse per HOSTNAME fixed those three and left the commonest redirect on the internet
 * uncovered: an apex that 301s to `www` is one machine answering to two names, and two names were
 * two purses. Measured at 8ec9873, `npm run measure-pacing twoNamesOneMachine`: 18 requests to one
 * machine, and the crossover gap 4 ms against a 1000 ms floor.
 *
 * See {@link createFetcher}'s `newFetchState` for what replaced the key — nothing, which is the
 * point — and why the robots cache still keys on the origin. Every one measures 9 now.
 */
export function maxRequestsPerFetch(maxHops: number, maxRetries: number): number {
  return maxHops + maxRetries + 1;
}

export interface FetchOptions {
  userAgent: string;
  contactUrl: string;
  timeoutMs?: number;
  /** When set, payloads are persisted under `${dataDir}/snapshots/` — see {@link SNAPSHOT_MAX_BYTES}. */
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

/**
 * One fetch spent everything it was allowed to spend at one server, and stopped.
 *
 * A DISTINCT ERROR RATHER THAN `Error("fetch failed for …")`, which is what the exhausted retry
 * loop used to fall through to, because those are two different things to the operator reading the
 * log: "the site never answered" and "the site answered badly enough, often enough, that we
 * declined to keep asking". The second is the crawler working, and a message that reads like a
 * transport failure sends whoever is on call to look at the network.
 *
 * Reachable when the `/robots.txt` read at the head of a hop consumes the last of the allowance —
 * a site that has just answered `429` or `503` several times in a row. The page is not requested,
 * which is the whole point.
 *
 * `host` is where the fetch STOPPED, which is not necessarily where the allowance went: one purse
 * now covers a whole redirect chain (see `newFetchState`), so a chain that spent eight requests at an
 * apex and stopped at `www` names `www` here and the URL beside it says the rest. Both are in the
 * message because an operator reading a log needs the second to make sense of the first.
 */
export class RequestBudgetExhaustedError extends Error {
  readonly url: string;
  readonly host: string;
  readonly limit: number;
  constructor(url: string, host: string, limit: number) {
    super(
      `Request budget exhausted at ${host} (${url}): one fetch may cost at most ${limit} HTTP ` +
        `requests in total — every redirect hop, every retry, and the /robots.txt read at each ` +
        `origin it touches, across every host in the chain. Skipping this source for the run.`,
    );
    this.name = 'RequestBudgetExhaustedError';
    this.url = url;
    this.host = host;
    this.limit = limit;
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

/**
 * The largest payload that is kept on disk under `${dataDir}/snapshots/`. 16 MiB.
 *
 * WHAT A SNAPSHOT IS FOR, which is what decides the number. It is forensics: when a parser starts
 * finding nothing, an operator wants the bytes the site actually served that night. Nothing reads
 * these files back — `insertSnapshot` records the URL, the status, the sha256 and the byte count in
 * the `snapshots` table and the runner does not even pass it a path — so the DATABASE remains the
 * record that a payload arrived and what it hashed to whether or not a file is written.
 *
 * WHAT IT WAS COSTING. `grants-gov-extract` fetches the Grants.gov daily archive, and every one of
 * them landed here as a 103,866,232-byte base64 TEXT file. Seven days of retention window, once a
 * night: 727,063,624 bytes per crawl, measured, on a self-hosted box whose entire database is one
 * SQLite file. That is 265 GB a year of a file that is re-downloadable from a stable URL for a
 * week, to serve a purpose (what did the site say?) it does not serve better than the sha256
 * already in the row.
 *
 * 16 MiB because it must sit far above every payload this crawler exists to read and far below the
 * one bulk archive it fetches: the largest capture in `fixtures/` is 306,359 bytes of NASA CSLI
 * HTML, and the Grants.gov extract is 77,899,674. Two and a half orders of magnitude of daylight,
 * and nothing this crawler polls lives in between.
 *
 * IT IS MEASURED ON THE BODY WE ARE HOLDING, not on the bytes that would land on disk, and for a
 * `binary` payload those differ: the body is base64, which is 4/3 of the wire bytes. Deliberately
 * the larger of the two — the ceiling exists to bound what one payload costs this machine, and the
 * base64 is what the machine is holding.
 */
export const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;

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

/**
 * Persist one payload under `${dataDir}/snapshots/`, unless it is too big to be worth keeping.
 *
 * BYTES, NOT BASE64 TEXT, for a binary payload. `FetchedPayload.body` is a string, so the fetcher
 * base64s a binary response to carry it; writing that string out meant a file named `.bin` whose
 * contents were ASCII, 4/3 the size of what the server sent, and not openable by anything that
 * understands the format. The snapshot is supposed to be what the site served.
 *
 * A payload over {@link SNAPSHOT_MAX_BYTES} is not written and SAYS SO. Silently skipping would
 * leave an operator looking for a file that was never going to exist; the row in `snapshots` still
 * carries the URL, the status, the sha256 and the byte count, so nothing about "this payload
 * arrived and here is what it hashed to" is lost with it.
 */
async function writeSnapshot(
  dataDir: string,
  url: string,
  accept: FetchRequest['accept'],
  fetchedAt: string,
  body: string,
): Promise<void> {
  const held = Buffer.byteLength(body, 'utf8');
  if (held > SNAPSHOT_MAX_BYTES) {
    console.warn(
      `[fetcher] not snapshotting ${url}: ${String(held)} bytes is over the ` +
        `${String(SNAPSHOT_MAX_BYTES)}-byte SNAPSHOT_MAX_BYTES ceiling. The snapshots row still ` +
        'records its status, size and sha256; only the copy on disk is skipped.',
    );
    return;
  }
  const file = snapshotPathFor(dataDir, url, accept, fetchedAt);
  await mkdir(path.dirname(file), { recursive: true });
  if (accept === 'binary') await writeFile(file, Buffer.from(body, 'base64'));
  else await writeFile(file, body, 'utf8');
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

  /**
   * How large one fetch's purse is, and why it is not simply `maxRequestsPerFetch(maxRedirects, …)`.
   *
   * The purse now pays for the `/robots.txt` read as well as the page, and `ROBOTS_MAX_REDIRECTS`
   * is deliberately NOT configurable (see `robots.ts`: it is a floor RFC 9309 §2.3.1.2 puts on
   * being polite, and an operator turning it down would be turning down the site owner's ability
   * to be heard). An operator who sets `maxRedirects: 1` is saying something about how far to
   * chase a PAGE; letting that shrink the allowance below what a robots.txt chain is entitled to
   * walk would let a config knob quietly disable the RFC's requirement. So the purse is sized for
   * whichever of the two chains is longer. At the shipped defaults both are 5 and this is 9.
   */
  const purseSize = maxRequestsPerFetch(Math.max(maxRedirects, ROBOTS_MAX_REDIRECTS), maxRetries);

  /**
   * WHAT ONE LOGICAL FETCH CARRIES WITH IT WHEREVER ITS CHAIN GOES: an allowance, and a memory of
   * where the last request went. Both of the properties this file publishes — a ceiling on requests
   * and a floor between them — are facts about the CHAIN, and a chain is free to wander across
   * origins and hostnames, so neither can be stored per address.
   */
  interface FetchState {
    /** The purse: what this fetch has left to spend, anywhere. See {@link newFetchState}. */
    remaining: number;
    /** The lane the previous request of this fetch went out on; undefined before the first one. */
    lastHost?: string;
  }

  /**
   * ONE PURSE PER LOGICAL FETCH, WITH NO KEY AT ALL — which is the third answer this question has
   * had in one day, and the only one that does not require guessing who owns what.
   *
   * The purse exists to make one sentence in the README true: a page fetch costs at most nine HTTP
   * requests. Every version of it has failed on the same move — the chain crosses to somewhere the
   * key says is new, and a whole second allowance appears. Keyed per ORIGIN it was a scheme or a
   * port (measured 18, 20 and 63 at commit 2c098d9). Keyed per HOSTNAME it was a second NAME on the
   * same machine: `npm run measure-pacing twoNamesOneMachine` at 8ec9873 printed 18 requests to one
   * kernel, because `example.org` and `www.example.org` are two hostnames, and an apex that 301s to
   * `www` is the commonest redirect on the internet.
   *
   * WHY NOT KEY IT BY THE SITE, THEN. Because a URL does not say who owns it, and every available
   * way of guessing is wrong in a direction that hurts somebody who cannot tell it is happening:
   *
   *   Registrable domain (eTLD+1) is the textbook answer and needs the Public Suffix List, which is
   *   a dependency this repository will not take for a politeness heuristic and which is a
   *   downloaded file that goes stale. Deriving it without one means "the last two labels", and
   *   that merges `alice.github.io` with `bob.github.io` and every `*.co.uk` in existence into a
   *   single nine-request budget — different owners, different servers, one purse, and our crawl of
   *   one club's site truncated because another club's site was flaky. Nobody can see that happen
   *   and nobody can fix it from outside.
   *
   *   Resolving both names and comparing addresses is network I/O inside a politeness decision, it
   *   cannot run in a unit suite that makes no requests, and it answers wrongly in both directions
   *   behind a CDN (one address, many owners) and behind round-robin DNS (one owner, many
   *   addresses).
   *
   *   Stripping a leading `www.` is the narrow version of the same guess. It is right almost always
   *   and it still leaves `example.org` -> `example-club.net` on one box uncovered, so it buys a
   *   special case without buying the property.
   *
   * So the bound is expressed as the thing we actually know: this is ONE FETCH, and one fetch may
   * cost nine requests wherever they land. No key, nothing to be wrong about, and the published
   * sentence is true for every shape including the ones nobody has thought of yet.
   *
   * WHAT IT COSTS, SAID PLAINLY. A redirect chain that legitimately crosses several hosts can now
   * run out partway and be skipped for the run, where before each host had its own allowance. That
   * costs US a source for a night; it never costs a stranger a request, which is the direction this
   * trade has to point. The case is also rare and already pathological — a healthy apex -> `www`
   * hop costs four requests against a purse of nine — and when it happens it is explicit
   * ({@link RequestBudgetExhaustedError}) rather than silent.
   *
   * THE ROBOTS CACHE STILL KEYS ON `canonicalOrigin`, SCHEME AND PORT KEPT, and that is not an
   * inconsistency. "How much may I spend?" and "whose rules am I reading?" are different questions:
   * RFC 9309 §2.3 puts `/robots.txt` at the authority's root, so a service on :8443 publishes its
   * own file and must not inherit :443's. Merging those two keys would make us obey rules the site
   * never wrote for that service, which is the opposite of a fix.
   */
  function newFetchState(): FetchState {
    return { remaining: purseSize };
  }

  /**
   * Carry this fetch's pacing across a change of hostname, so the handover is spaced like every
   * other gap in the chain.
   *
   * WHAT THIS FIXES. `HostQueue` paces per lane, and a lane that has never run a request has nothing
   * to pace against — right for the first request of a nightly run, and wrong in the middle of a
   * redirect chain, because the machine about to answer may well be the machine that just answered.
   * `example.org` and `www.example.org` are two lanes to this file and one kernel to the person
   * whose bandwidth it is. Measured at 8ec9873: `npm run measure-pacing nameChangeHealthy` put the
   * apex -> `www` handover 4 ms after the redirect against a 1000 ms floor, and
   * `twoNamesOneMachine` had 1 of its 17 gaps under the floor for the same reason.
   *
   * We cannot know whether the next request is the same machine (see `newFetchState` for why every
   * way of guessing is worse), so we pace as though it were. When it is, the site owner gets the
   * interval we published. When it is not, the cost is one second of OUR time, once, at the exact
   * moment we already know we are being sent somewhere else.
   *
   * IT IS DONE HERE, NOT AT THE REDIRECT, and the difference is a case the first version of this
   * missed: a chain that goes apex -> `www` and BACK. A `/robots.txt` at the apex that 301s to
   * `www` is read at `www`, and then the page under it is fetched from the apex — whose own lane
   * last ran a request before the handover and is therefore free immediately. Pacing at the point
   * of redirect covers one direction; pacing at the point of REQUEST covers every direction, and
   * this is the single place every request in this file passes through.
   *
   * `defer` and not a sleep: the wait belongs to the lane, so a page queued behind this one waits
   * too, and it composes with `Retry-After` and `Crawl-delay` by MAX rather than replacing them.
   */
  function paceAcrossHostChange(state: FetchState, host: string): void {
    if (state.lastHost !== undefined && state.lastHost !== host) {
      queue.defer(host, queue.minIntervalFor(host));
    }
    state.lastHost = host;
  }

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
   * is handed to `robotsFromResponse` as a 3xx; a chain that runs out of the server's purse goes to
   * `robotsUnread` instead, because there is no response to attribute the stop to — we simply
   * stopped asking. Both back off for this run and both record `wasRead: false`, which is what
   * decides how long the verdict is believed. See the enumeration on `robotsFromResponse` for why
   * backing off is not the same choice the RFC makes.
   *
   * THIS FUNCTION IS NOT SPECIAL, and that is the point of the shape it now has: it walks hops and
   * spends a purse exactly like `fetchOne` does, through the same `gatedRequest`, so `/robots.txt`
   * gets the same retry budget, the same per-host gate on every single attempt, and the same
   * additive cap on how many requests one read can cost. Two earlier rounds of this bug were both
   * "robots.txt does its own thing": first it called the raw transport (one attempt where a page
   * got four, and a dropped connection manufactured a 404 that opened the whole origin), then it
   * wrapped a whole retry loop in one queue slot (bursts of 2-5 ms against a 1000 ms floor).
   *
   * IT NO LONGER OWNS THE PURSE, which was the third round of the same bug. `purse` belongs to the
   * logical fetch that needed these rules and is shared with the page under them, so a read cannot
   * buy a machine a second allowance by being aimed at a second origin on it. That also means the
   * purse can be empty when this is called — `gatedRequest` throws `RequestBudgetExhaustedError`,
   * which lands in the same `catch` as a dropped connection and produces the same verdict, because
   * it means the same thing: we did not read this site's rules.
   */
  async function readRobots(origin: string, state: FetchState): Promise<RobotsRules> {
    const stamp = (): string => new Date(now()).toISOString();
    let url = `${origin}/robots.txt`;
    assertNotBlocked(url);
    for (let hop = 0; ; hop += 1) {
      let response: Response;
      let body = '';
      try {
        const request: FetchRequest = { url, method: 'GET', accept: 'html' };
        response = await gatedRequest(url, request, state);
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
      //
      // No purse test here, unlike the version that owned its own budget: the next hop may be a
      // different machine with a full one, and if it is not, `gatedRequest` refuses at the top of
      // the loop and the `catch` above turns that into the same back-off this branch produces.
      if (!location || hop >= ROBOTS_MAX_REDIRECTS) {
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
      // RFC 9309 §2.3.1.2 has this chain following redirects "across authorities", so hop two can
      // be a different hostname. Nothing is done about that here: `gatedRequest` paces every request
      // against wherever this fetch's previous one went, which covers this hop, the page under it,
      // and the way back.
      url = next;
    }
  }

  /**
   * KEYED BY ORIGIN, WHICH IS THE ONLY KEY LEFT IN THIS FILE, ON PURPOSE. RFC 9309 §2.3 puts
   * `/robots.txt` at the authority's root, so the file that governs `https://example.org:8443` is
   * a different file from the one that governs `https://example.org`, and reading one as the other
   * would be obeying rules the site never wrote for that service. The purse deliberately has no key
   * at all — see `newFetchState` for why those two facts are consistent rather than in tension.
   *
   * `purse` belongs to whichever logical fetch got here first and is spent by the read it starts.
   * A second fetch that arrives while that read is in flight shares the promise and pays nothing,
   * which is right: the requests happened once, so they are charged once.
   */
  async function robotsFor(origin: string, state: FetchState): Promise<RobotsRules> {
    const cached = robotsCache.get(origin);
    // Cached for the run, never for the life of the process. `now()` is injected, so this is the
    // same clock the host queue and the payload timestamps use.
    if (cached && now() < cached.expiresAtMs) return cached.rules;
    const readAtMs = now();
    const promise = readRobots(origin, state);
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
   * `state.remaining` is what this whole fetch has left to spend, anywhere (see `newFetchState`).
   * Every attempt
   * costs one, whichever hop of whichever chain it belongs to, whether it is a page or the
   * `/robots.txt` above it, and whichever host it is aimed at. An empty purse is refused here rather
   * than silently returning nothing, because this is the single place every request in this file
   * passes through.
   */
  async function gatedRequest(
    url: string,
    req: FetchRequest,
    state: FetchState,
  ): Promise<Response> {
    // The pacing lane is keyed by CANONICAL HOSTNAME, port and trailing root dots removed, so
    // `example.org`, `example.org.` and `example.org:8443` are one lane and not three. The two
    // host-derived values in this file were the last places that still compared raw
    // `URL.host` — four copies of the trailing-dot bug have been found in this repository, one of
    // them in a blocklist check, so there is exactly one spelling of it now (`net/hosts.ts`).
    // Dropping the port deliberately errs towards polling less: two ports are two servers to HTTP
    // and one machine to the person whose bandwidth it is. What the lane cannot see is a machine
    // answering to two NAMES, which is what the line below is for.
    const host = normalizeHost(url);
    if (state.remaining <= 0) throw new RequestBudgetExhaustedError(url, host, purseSize);
    // Before the gate, not inside it: this raises the lane's floor, and the gate is what waits on it.
    paceAcrossHostChange(state, host);
    let last: Attempted | undefined;
    for (let i = 0; i <= maxRetries && state.remaining > 0; i += 1) {
      state.remaining -= 1;
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
   *
   * THE PURSE IS CREATED HERE AND PASSED DOWN INTO `robotsFor`, so the read that authorises a hop
   * is charged to the same allowance the hop itself is charged to. That single line is what makes
   * the published ceiling true; before it, `readRobots` opened its own nine per ORIGIN and one page
   * fetch could cost one machine 63 requests.
   */
  async function fetchOne(startUrl: string, req: FetchRequest): Promise<FetchedPayload> {
    const state = newFetchState();
    let url = startUrl;
    let response: Response;
    for (let hop = 0; ; hop += 1) {
      assertNotBlocked(url);
      const parsed = new URL(url);
      const rules = await robotsFor(canonicalOrigin(parsed), state);
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

      // May throw `RequestBudgetExhaustedError` if the robots read above spent the last of this
      // fetch's allowance. Throwing beats returning the 3xx that brought us here: we did not read
      // the page, and handing a redirect body to a parser as though it were the page is exactly the
      // kind of "derived value presented as a stated one" this codebase exists to refuse.
      response = await gatedRequest(url, req, state);

      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      // Out of hops: the 3xx itself becomes the payload, exactly as it did when only `maxRedirects`
      // could stop the chain. `!location` and not `=== null` because an empty `Location` resolves
      // back to this same URL — see the matching note in `readRobots`.
      if (!location || hop >= maxRedirects) break;
      const next = new URL(location, url).toString();
      // Re-assert on every hop. This is what stops farweb.org -> batualam.org and any
      // future takeover chain from reaching a parser.
      assertNotBlocked(next);
      // Out of allowance. Same outcome as running out of hops: stop, and let the 3xx be the payload.
      if (state.remaining <= 0) break;
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

    if (opts.dataDir) await writeSnapshot(opts.dataDir, url, req.accept, fetchedAt, body);
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
