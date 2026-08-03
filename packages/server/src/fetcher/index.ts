import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FetchRequest, FetchedPayload } from '@grantspotter/core';
import { assertNotBlocked, normalizeHost } from './blocklist.js';
import { HostQueue } from './hostQueue.js';
import {
  type RobotsRules,
  RobotsDisallowedError,
  isPathAllowed,
  robotsFromResponse,
} from './robots.js';

export const AGENT_TOKEN = 'GrantSpotter';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

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
}

export interface Fetcher {
  fetch(req: FetchRequest): Promise<FetchedPayload>;
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
  const robotsCache = new Map<string, Promise<RobotsRules>>();

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

  async function rawGet(url: string, accept: FetchRequest['accept']): Promise<Response> {
    return transport(url, {
      method: 'GET',
      headers: headers(url, accept, false),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function robotsFor(origin: string): Promise<RobotsRules> {
    const cached = robotsCache.get(origin);
    if (cached) return cached;
    const promise = (async () => {
      const url = `${origin}/robots.txt`;
      assertNotBlocked(url);
      try {
        const response = await rawGet(url, 'html');
        const body = response.status === 200 ? await response.text() : '';
        return robotsFromResponse(response.status, body, AGENT_TOKEN, new Date(now()).toISOString());
      } catch {
        // A network error reading robots.txt is not a licence to crawl freely, but it is also
        // not a permanent ban: treat it as "no rules for this run" and let backoff handle the
        // real request. ncdxf.org, which 403s robots.txt, is covered by robotsFromResponse.
        return robotsFromResponse(404, '', AGENT_TOKEN, new Date(now()).toISOString());
      }
    })();
    robotsCache.set(origin, promise);
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
  };
}
