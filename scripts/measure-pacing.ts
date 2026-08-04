/**
 * WHAT THIS IS FOR. The README and `.github/ISSUE_TEMPLATE/crawler-contact.md` make two promises to
 * people whose sites this software polls: a minimum interval between requests to one host, and a
 * bound on how many requests one page or one `/robots.txt` can cost them. Both are claims about
 * behaviour under failure — a 429, a 503, a redirect chain — and neither is visible in a unit test
 * that injects a clock, because an injected clock cannot show a gap that did not happen.
 *
 * So this drives the REAL fetcher, with real timers and real sockets, against throwaway HTTP
 * servers on loopback, and prints the millisecond gap between consecutive requests each server
 * ACTUALLY RECEIVED. Every figure quoted in those two documents comes from here.
 *
 * It is a measurement harness and not a test: it takes about two minutes (one scenario waits out a
 * `Retry-After: 30`), which is why the same properties are also pinned deterministically in
 * `packages/server/src/fetcher/index.test.ts` against an injected clock. That file is the guard;
 * this is the evidence.
 *
 *   npm run measure-pacing              # every scenario
 *   npm run measure-pacing -- happy     # one of them
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildUserAgent, resolveContactUrl } from '../packages/server/src/config.js';
import { createFetcher } from '../packages/server/src/fetcher/index.js';

/**
 * THE ONE ENTRY POINT THAT DOES NOT READ THE OPERATOR'S CONTACT_URL, and the reason is the whole
 * point of this file rather than an exemption from it.
 *
 * `scripts/verify-sources.ts` and `scripts/capture-fixture.ts` call `resolveContactUrl()` with no
 * argument, so an unset CONTACT_URL makes them refuse to run — correct, because they poll ~25 live
 * volunteer-run sites and those sites are owed an address that reaches whoever is polling them.
 * This harness polls nobody. Every request it makes goes to a throwaway server it started
 * milliseconds earlier on 127.0.0.1 and then destroys, so there is no stranger to name and no
 * operator to name them to.
 *
 * It matters that this stays runnable by somebody who has no deployment at all, because the README
 * and the crawler-contact issue template now tell a SITE OWNER — a stranger reading their own
 * access log — that they can reproduce the numbers those documents quote by running this. A
 * command that answers "CONTACT_URL is required" to that reader would make the reproducibility
 * claim exactly as hollow as the bound it was written to replace.
 *
 * The value still goes through `resolveContactUrl`, which is the same predicate the server runs, so
 * this file cannot introduce a User-Agent the server would refuse — it just supplies the env rather
 * than reading it. `test/contactUrlEntryPointContract.test.ts` lists this file for both reasons.
 */
const CONTACT = resolveContactUrl({ CONTACT_URL: 'https://w9xyz-radio-club.org/grantspotter' });
/** The shipped `DEFAULT_MIN_INTERVAL_MS`, restated so the harness measures against the real floor. */
const FLOOR = 1_000;

interface Hit {
  at: number;
  path: string;
}

function text(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

async function withServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  body: (base: string, hits: Hit[]) => Promise<T>,
): Promise<T> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    hits.push({ at: Date.now(), path: req.url ?? '' });
    handler(req, res);
  });
  /*
   * MEASURED, DIAGNOSED, AND NOT A FETCHER DEFECT — but it corrupts the numbers, so it is pinned.
   *
   * Node's HTTP server closes an idle keep-alive socket after `keepAliveTimeout`, which defaults to
   * 5000 ms — EXACTLY the `Crawl-delay: 5` two scenarios below measure. Undici then reuses a socket
   * the server is closing in the same millisecond and the fetch rejects with ECONNRESET before
   * anything reaches the wire. The fetcher handles that correctly (it retries, and the retry is
   * gated like every other request, which is the whole point of the change this harness measures),
   * but it shows up as a spurious extra request and a gap of two intervals instead of one. Raising
   * the timeout well past the longest gap under test takes the harness's own socket lifecycle out
   * of the measurement.
   */
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await body(`http://127.0.0.1:${port}`, hits);
  } finally {
    // `close` alone waits for every keep-alive socket to go idle, which the line above just made
    // take two minutes.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/**
 * ONE SERVER ANSWERING ON SEVERAL PORTS, which is the only shape in which a loopback harness can
 * put two ORIGINS in front of one MACHINE.
 *
 * `http://127.0.0.1:A` and `http://127.0.0.1:B` are two origins to RFC 9309 (§2.3 puts
 * `/robots.txt` at the authority's root, and the authority includes the port) and one host to the
 * person paying for the bandwidth. Every listener here pushes into the SAME `hits` array, so the
 * count a scenario prints is the count a single site owner would see in a single access log — the
 * question the whole "at most N requests to your server" claim is about.
 *
 * A scheme change (`http` -> `https`) keys identically: `canonicalOrigin` keeps the scheme,
 * `normalizeHost` drops it, exactly as they do with the port. Ports are what a harness with no
 * certificate authority can serve, so ports are what is measured here; `fetcher/index.test.ts`
 * pins the scheme-crossing case against an injected transport where no TLS is needed.
 */
async function withOrigins<T>(
  count: number,
  handler: (req: IncomingMessage, res: ServerResponse, index: number) => void,
  body: (bases: string[], hits: Hit[]) => Promise<T>,
): Promise<T> {
  const hits: Hit[] = [];
  const servers = Array.from({ length: count }, (_unused, index) => {
    const server = createServer((req, res) => {
      hits.push({ at: Date.now(), path: `:${index}${req.url ?? ''}` });
      handler(req, res, index);
    });
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;
    return server;
  });
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
  );
  const bases = servers.map((server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try {
    return await body(bases, hits);
  } finally {
    await Promise.all(
      servers.map((server) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }
}

/**
 * Print one scenario's gaps against the floor that applies TO EACH GAP.
 *
 * Per gap and not per scenario, because the applicable floor genuinely varies within a run: the gap
 * after a `Retry-After: 30` is bounded by 30 s, and the gap either side of it by the host interval.
 * A single scenario-wide number would either excuse a real violation or invent a fake one.
 */
function report(name: string, hits: Hit[], floorFor: (index: number) => number, note = ''): void {
  const gaps = hits.slice(1).map((hit, i) => hit.at - (hits[i] as Hit).at);
  const under = gaps.filter((gap, i) => gap < floorFor(i));
  const shown = gaps.map((gap, i) => `${gap}${gap < floorFor(i) ? ` (<${floorFor(i)})` : ''}`);
  console.log(
    `\n### ${name}${note === '' ? '' : ` — ${note}`}\n` +
      `  requests : ${hits.length}   ${hits.map((h) => h.path).join(' ')}\n` +
      `  gaps(ms) : ${shown.join(', ') || '(none)'}\n` +
      `  floors   : ${gaps.map((_, i) => floorFor(i)).join(', ') || '(none)'}\n` +
      `  UNDER FLOOR: ${under.length}/${gaps.length}`,
  );
}

/**
 * Print the COUNT rather than every gap, for the scenarios whose subject is the count.
 *
 * `report` above prints one number per gap, which is the right shape when there are five of them
 * and the question is spacing. The ceiling scenarios below produce sixty-odd, and the question
 * there is "how many requests did one page fetch cost this machine" — so this prints the total,
 * splits it by origin (the key the robots cache uses) against the single host they all share (the
 * key the pacing lane uses), and reduces the gaps to the one fact that still matters: whether any
 * of them was under the floor.
 */
function reportFootprint(name: string, hits: Hit[], floor: number, note = ''): void {
  const gaps = hits.slice(1).map((hit, i) => hit.at - (hits[i] as Hit).at);
  const under = gaps.filter((gap) => gap < floor);
  const byOrigin = new Map<string, number>();
  for (const hit of hits) {
    const origin = hit.path.slice(0, hit.path.indexOf('/'));
    byOrigin.set(origin, (byOrigin.get(origin) ?? 0) + 1);
  }
  const split = [...byOrigin.entries()].map(([origin, n]) => `${origin}=${n}`).join(' ');
  console.log(
    `\n### ${name}${note === '' ? '' : ` — ${note}`}\n` +
      `  REQUESTS TO THE ONE HOST : ${hits.length}\n` +
      `  by origin                : ${split || '(none)'}\n` +
      `  gaps(ms)                 : min ${gaps.length === 0 ? '(none)' : Math.min(...gaps)}, ` +
      `max ${gaps.length === 0 ? '(none)' : Math.max(...gaps)}\n` +
      `  UNDER FLOOR(${floor})       : ${under.length}/${gaps.length}`,
  );
}

function fetcher(extra: Record<string, unknown> = {}) {
  return createFetcher({
    userAgent: buildUserAgent(CONTACT),
    contactUrl: CONTACT,
    defaultMinIntervalMs: FLOOR,
    ...extra,
  });
}

/**
 * A rejection turned into a note for {@link report}, never hidden and never printed on its own:
 * several scenarios are SUPPOSED to end in one, and a bare `console.log` in a `.catch` prints
 * before its own heading, which reads as if it belonged to the scenario above.
 */
const explain = (err: unknown): string => {
  const e = err as Error;
  return `rejected with ${e.name}: ${e.message}`;
};

/** A robots.txt that publishes no rules, so only the pacing under test is being measured. */
const ALLOW_ALL = 'User-agent: *\n';

async function happy(): Promise<void> {
  await withServer(
    (req, res) => (req.url === '/robots.txt' ? text(res, 200, ALLOW_ALL) : html(res, '<p>ok</p>')),
    async (base, hits) => {
      const f = fetcher();
      for (const p of ['/a', '/b', '/c']) {
        await f.fetch({ url: `${base}${p}`, method: 'GET', accept: 'html' });
      }
      report('happy path: robots.txt then three pages', hits, () => FLOOR);
    },
  );
}

/** `failures` 429s carrying `Retry-After: <seconds>`, then a 200. */
async function retryAfter(seconds: number, failures: number, maxRetries?: number): Promise<void> {
  let served = 0;
  await withServer(
    (req, res) => {
      if (req.url === '/robots.txt') return text(res, 200, ALLOW_ALL);
      served += 1;
      if (served <= failures) return text(res, 429, 'slow down', { 'retry-after': String(seconds) });
      return html(res, '<p>ok</p>');
    },
    async (base, hits) => {
      const f = fetcher(maxRetries === undefined ? {} : { maxRetries });
      const note = await f
        .fetch({ url: `${base}/page`, method: 'GET', accept: 'html' })
        .then(() => '', explain);
      // Gap 0 is robots.txt -> the first attempt, which only the host floor governs. Every later
      // gap follows a 429, so the floor there is max(Retry-After, host interval) — the composition
      // this whole change is about.
      report(
        `429 with Retry-After: ${seconds}`,
        hits,
        (i) => (i === 0 ? FLOOR : Math.max(seconds * 1000, FLOOR)),
        note,
      );
    },
  );
}

async function serverError(): Promise<void> {
  await withServer(
    (req, res) =>
      req.url === '/robots.txt' ? text(res, 200, ALLOW_ALL) : text(res, 503, 'busy'),
    async (base, hits) => {
      const f = fetcher();
      const note = await f
        .fetch({ url: `${base}/page`, method: 'GET', accept: 'html' })
        .then(() => '', explain);
      report('503 with no Retry-After (jittered backoff)', hits, () => FLOOR, note);
    },
  );
}

async function redirectChain(): Promise<void> {
  await withServer(
    (req, res) => {
      if (req.url === '/robots.txt') return text(res, 200, ALLOW_ALL);
      const n = Number(/^\/p(\d+)$/.exec(req.url ?? '')?.[1] ?? '0');
      if (n < 5) {
        res.writeHead(301, { location: `/p${n + 1}` });
        return res.end();
      }
      return html(res, '<p>end</p>');
    },
    async (base, hits) => {
      const f = fetcher();
      const note = await f
        .fetch({ url: `${base}/p0`, method: 'GET', accept: 'html' })
        .then(() => '', explain);
      report('page redirect chain of 5', hits, () => FLOOR, note);
    },
  );
}

/**
 * THE MULTIPLICATIVE CASE. `/robots.txt` 301s five times AND every hop 429s twice before it
 * redirects, so the retry budget is spent again at every hop.
 */
async function redirectChainThat429s(): Promise<void> {
  const seen = new Map<string, number>();
  await withServer(
    (req, res) => {
      const url = req.url ?? '';
      if (!url.includes('robots')) return html(res, '<p>ok</p>');
      const count = (seen.get(url) ?? 0) + 1;
      seen.set(url, count);
      if (count <= 2) return text(res, 429, 'slow down', { 'retry-after': '0' });
      const n = Number(/robots(\d*)\.txt/.exec(url)?.[1] || '0');
      if (n < 5) {
        res.writeHead(301, { location: `/robots${n + 1}.txt` });
        return res.end();
      }
      return text(res, 200, ALLOW_ALL);
    },
    async (base, hits) => {
      const f = fetcher();
      const started = Date.now();
      const note = await f
        .fetch({ url: `${base}/page`, method: 'GET', accept: 'html' })
        .then(() => '', explain);
      report(
        'robots.txt chain that BOTH 429s and 301s',
        hits,
        () => FLOOR,
        `${Date.now() - started} ms wall clock; ${note}`,
      );
    },
  );
}

async function crawlDelay(paths: string[], name: string, maxRetries?: number): Promise<void> {
  let served = 0;
  const failFirst = maxRetries !== undefined;
  await withServer(
    (req, res) => {
      if (req.url === '/robots.txt') return text(res, 200, 'User-agent: *\nCrawl-delay: 5\n');
      served += 1;
      if (failFirst && served === 1) return text(res, 503, 'busy');
      return html(res, '<p>ok</p>');
    },
    async (base, hits) => {
      const f = fetcher(maxRetries === undefined ? {} : { maxRetries });
      const notes: string[] = [];
      for (const p of paths) {
        const note = await f
          .fetch({ url: `${base}${p}`, method: 'GET', accept: 'html' })
          .then(() => '', explain);
        if (note !== '') notes.push(note);
      }
      // EVERY gap, including robots.txt -> the first page: a Crawl-delay is in force for the first
      // request it governs, and the request that read the file is not one of them.
      report(name, hits, () => 5_000, notes.join('; '));
    },
  );
}

/**
 * A `/robots.txt` that spends the WHOLE nine-request purse and still resolves: two hops, each
 * ridden out through three `429`s, then a 200 on the third hop's first request. 4 + 4 + 1 = 9.
 *
 * It has to RESOLVE, which is the fiddly part and the reason the third hop answers immediately: a
 * chain that runs out of purse unresolved is read as "we never learned the rules", the page under
 * it is never requested, and the scenario would measure nine requests instead of the two purses it
 * exists to show. Every request here is one a site owner sees in their log, whatever we conclude
 * from it.
 */
function serveExpensiveRobots(
  seen: Map<string, number>,
  key: string,
  url: string,
  res: ServerResponse,
): boolean {
  const match = /^\/robots(\d*)\.txt$/.exec(url);
  if (match === null) return false;
  const hop = Number(match[1] === '' ? '0' : match[1]);
  if (hop >= 2) {
    text(res, 200, ALLOW_ALL);
    return true;
  }
  const seenKey = `${key}${url}`;
  const n = (seen.get(seenKey) ?? 0) + 1;
  seen.set(seenKey, n);
  if (n <= 3) {
    text(res, 429, 'slow down', { 'retry-after': '0' });
    return true;
  }
  res.writeHead(301, { location: `/robots${hop + 1}.txt` });
  res.end();
  return true;
}

/**
 * THE SIMPLEST CASE THE PUBLISHED CEILING WAS WRONG ABOUT. One host, one origin, one page fetch,
 * no cleverness: a `/robots.txt` that costs the full purse and a page that costs the full purse.
 */
async function ceilingOneOrigin(): Promise<void> {
  const seen = new Map<string, number>();
  await withServer(
    (req, res) => {
      const url = req.url ?? '';
      if (serveExpensiveRobots(seen, '', url, res)) return;
      const hop = Number(/^\/p(\d+)$/.exec(url)?.[1] ?? '0');
      if (hop >= 2) {
        res.writeHead(301, { location: `/p${hop + 1}` });
        return res.end();
      }
      const n = (seen.get(url) ?? 0) + 1;
      seen.set(url, n);
      if (n <= 3) return text(res, 429, 'slow down', { 'retry-after': '0' });
      res.writeHead(301, { location: `/p${hop + 1}` });
      return res.end();
    },
    async (base, hits) => {
      const f = fetcher();
      const note = await f
        .fetch({ url: `${base}/p0`, method: 'GET', accept: 'html' })
        .then((p) => `payload status ${p.status}`, explain);
      reportFootprint('CEILING: one origin, robots.txt + page both at full purse', hits, FLOOR, note);
    },
  );
}

/**
 * THE WORST CASE. Six origins, ONE machine, one page fetch.
 *
 * The page chain walks the maximum five redirects, and every hop lands on an origin the robots
 * cache has never seen — so each one is a fresh `/robots.txt` read. Six ports on 127.0.0.1 is the
 * loopback spelling of a chain that switches scheme or port; a chain that switched HOST would be
 * six different site owners, which is a different question and not this one.
 */
async function ceilingManyOrigins(): Promise<void> {
  const seen = new Map<string, number>();
  // Assigned once `listen(0)` has handed out ports, which is after the handler below is built.
  let origins: string[] = [];
  await withOrigins(
    6,
    (req, res, index) => {
      const url = req.url ?? '';
      if (serveExpensiveRobots(seen, `${index}`, url, res)) return;
      if (index === 5) return html(res, '<p>end</p>');
      if (index === 0) {
        const n = (seen.get(`page${url}`) ?? 0) + 1;
        seen.set(`page${url}`, n);
        if (n <= 3) return text(res, 429, 'slow down', { 'retry-after': '0' });
      }
      res.writeHead(301, { location: `${origins[index + 1] ?? ''}/p` });
      return res.end();
    },
    async (bases, hits) => {
      origins = bases;
      const f = fetcher();
      const note = await f
        .fetch({ url: `${bases[0] ?? ''}/p`, method: 'GET', accept: 'html' })
        .then((p) => `payload status ${p.status}`, explain);
      reportFootprint('CEILING: five redirects across six origins on ONE host', hits, FLOOR, note);
    },
  );
}

/**
 * THE SHAPE THE SHIPPED REGISTRY ALREADY HAS. `sources/arrl-news-rss.ts` and
 * `sources/arrl-scholarship-descriptions.ts` name `http://www.arrl.org`; six other modules name
 * `https://www.arrl.org`. Two origins, one machine — so the "footprint of a site that blocks us"
 * is what this prints, not one request.
 *
 * The robots.txt here is the remedy the README hands a site owner: `User-agent: GrantSpotter` /
 * `Disallow: /`. Both fetches are refused, and what remains is the cost of finding that out.
 */
async function twoOriginsOneHost(): Promise<void> {
  await withOrigins(
    2,
    (req, res) => {
      if (req.url === '/robots.txt') return text(res, 200, 'User-agent: GrantSpotter\nDisallow: /\n');
      return html(res, '<p>should never be fetched</p>');
    },
    async (bases, hits) => {
      const f = fetcher();
      const notes: string[] = [];
      for (const [i, path] of ['/news/rss', '/scholarship-descriptions'].entries()) {
        const note = await f
          .fetch({ url: `${bases[i] ?? ''}${path}`, method: 'GET', accept: 'html' })
          .then(() => 'FETCHED — the Disallow was not obeyed', explain);
        notes.push(note);
      }
      reportFootprint(
        'REGISTRY SHAPE: two origins on one host, both blocked by robots.txt',
        hits,
        FLOOR,
        notes.join('; '),
      );
    },
  );
}

/**
 * THE ORDINARY CASE THE CEILING MUST NOT BREAK: a page that redirects to another port on the same
 * machine, with a `/robots.txt` that answers first time at each origin. Two robots reads (RFC 9309
 * scopes the file to scheme, host AND port, so the second is not a duplicate) and two page
 * requests. This is the number that must stay four.
 */
async function portChangeHealthy(): Promise<void> {
  let origins: string[] = [];
  await withOrigins(
    2,
    (req, res, index) => {
      if (req.url === '/robots.txt') return text(res, 200, ALLOW_ALL);
      if (index === 1) return html(res, '<p>end</p>');
      res.writeHead(301, { location: `${origins[1] ?? ''}/p` });
      return res.end();
    },
    async (bases, hits) => {
      origins = bases;
      const f = fetcher();
      const note = await f
        .fetch({ url: `${bases[0] ?? ''}/p`, method: 'GET', accept: 'html' })
        .then((p) => `payload status ${p.status}`, explain);
      reportFootprint('ORDINARY: one page fetch across a port change, healthy robots.txt', hits, FLOOR, note);
    },
  );
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  happy,
  retryAfter0: () => retryAfter(0, 3),
  retryAfter1: () => retryAfter(1, 3),
  retryAfter30: () => retryAfter(30, 1, 1),
  serverError,
  redirectChain,
  redirectChainThat429s,
  crawlDelay5: () => crawlDelay(['/a', '/b', '/c'], 'Crawl-delay: 5, three pages'),
  crawlDelay5FirstPage: () =>
    crawlDelay(['/first'], 'Crawl-delay: 5 governing the FIRST page after robots.txt'),
  crawlDelay5OnRetry: () =>
    crawlDelay(['/a'], 'Crawl-delay: 5 across a 503 retry', 2),
  ceilingOneOrigin,
  ceilingManyOrigins,
  twoOriginsOneHost,
  portChangeHealthy,
};

const wanted = process.argv.slice(2);
const names = wanted.length > 0 ? wanted : Object.keys(SCENARIOS);
for (const name of names) {
  const run = SCENARIOS[name];
  if (run === undefined) {
    throw new Error(`no scenario "${name}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  await run();
}
