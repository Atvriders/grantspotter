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
 * It is a measurement harness and not a test: it takes a little over two minutes — 2m14s for the
 * whole set on the machine this sentence was written on, most of it spent waiting out one
 * `Retry-After: 30` — which is why the same properties are also pinned deterministically in
 * `packages/server/src/fetcher/index.test.ts` against an injected clock. That file is the guard;
 * this is the evidence.
 *
 *   npm run measure-pacing                    # every scenario
 *   npm run measure-pacing -- happy           # one of them
 *
 * THREE SCENARIOS NEED SOMETHING OF THE MACHINE THEY RUN ON, in two ways, and all three say so and
 * skip rather than failing when they do not get it, because this file is quoted at a stranger
 * reading their own access log and a crash would read as "the claim is false":
 *
 *   `schemeChange` needs an `openssl` binary on PATH, to make the throwaway certificate that lets
 *   one of the two origins speak https. Nothing is committed and nothing outlives the run.
 *
 *   `twoNamesOneMachine` and `nameChangeHealthy` need `127.0.0.2` to be bindable, which is how two
 *   HOSTNAMES are put in front of one machine without asking the reader to edit `/etc/hosts`. Linux
 *   routes all of `127.0.0.0/8` to the loopback interface and needs nothing; macOS answers only on
 *   `127.0.0.1` until somebody runs `sudo ifconfig lo0 alias 127.0.0.2 up`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

/** Key material that exists only while one run of this harness does. */
interface Certificate {
  key: Buffer;
  cert: Buffer;
}

/**
 * WHERE THE CERTIFICATE COMES FROM, AND WHY THIS SCRIPT RUNS ITSELF TWICE TO GET ONE.
 *
 * The scheme-change figure the README and the crawler-contact template publish (`20 -> 9`) needs one
 * of two origins on this machine to speak https, because `http` -> `https` on one host is the shape
 * a site owner recognises. Until 2026-08-04 that number was taken with a scratchpad script and a
 * certificate that was never in this repository — so both documents called a figure reproducible
 * that nobody could reproduce, which is the same class of defect as the bound it was written to
 * prove.
 *
 * A certificate generated one second ago is in nobody's trust store, and there are exactly three
 * ways to make a client accept one. Two are bad: `NODE_TLS_REJECT_UNAUTHORIZED=0` turns verification
 * off for everything the process ever talks to, which is a thing this repository should not teach
 * anybody to run; and an `Agent` carrying a `ca` option means depending on `undici` as a package,
 * which the server does not do. The third is `NODE_EXTRA_CA_CERTS`, which trusts exactly this one
 * certificate and nothing else — but Node reads it once, at process start, which is before any code
 * here exists.
 *
 * So the parent process makes the certificate, launches THIS SAME SCRIPT again with that variable
 * set, lets the child do the measuring, and deletes the key material when the child exits. The child
 * runs with certificate verification fully ON, including the hostname check against the SAN below,
 * which makes the scenario evidence about the real TLS path rather than about a disabled one.
 *
 * WHY `openssl` AND NOT `node:crypto`. Node can generate a KEY PAIR and can parse an X.509
 * certificate; it cannot issue one. The alternatives were a new npm dependency (refused) or
 * hand-rolling ASN.1 DER in a measurement script, whose bugs would look like fetcher bugs.
 * `openssl` is already a documented prerequisite of deploying this software — the README's
 * `SESSION_SECRET` instruction is `openssl rand -hex 32` — so the harness asks for it, and says so
 * plainly when it is not there instead of failing in a way that reads as "the claim is false".
 */
const CERT_DIR_ENV = 'GRANTSPOTTER_PACING_CERT_DIR';

/** In the child: the material the parent generated and taught this one process to trust. */
function inheritedCertificate(): Certificate | null {
  const dir = process.env[CERT_DIR_ENV];
  if (dir === undefined) return null;
  return { key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) };
}

/**
 * Resolved once, at the bottom of this file, before any scenario runs — and read by `schemeChange`,
 * which is the only scenario that needs TLS and the only one that can be skipped for want of it.
 */
let certificate: Certificate | null = null;
let noCertificateBecause = 'this run did not ask for a certificate';

/**
 * In the parent: generate, re-launch, clean up. Returns the child's exit code, or the reason there
 * is no certificate — in which case the caller carries on in THIS process and the one scenario that
 * needs TLS prints why it produced no number.
 */
function measureInAChildThatTrustsAThrowawayCertificate(): { code: number } | { unavailable: string } {
  let dir: string;
  try {
    dir = mkdtempSync(path.join(tmpdir(), 'grantspotter-pacing-tls-'));
  } catch (err) {
    return { unavailable: `no writable temporary directory: ${(err as Error).message}` };
  }
  const certFile = path.join(dir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes',
        '-keyout', path.join(dir, 'key.pem'), '-out', certFile,
        '-subj', '/CN=127.0.0.1',
        // Both loopback addresses this harness ever binds, so the hostname check passes wherever a
        // TLS origin is used.
        '-addext', 'subjectAltName=IP:127.0.0.1,IP:127.0.0.2',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    const e = err as NodeJS.ErrnoException;
    return {
      unavailable:
        e.code === 'ENOENT'
          ? 'no `openssl` on PATH, and this repository commits no key material to fall back on'
          : `openssl failed: ${e.message}`,
    };
  }
  try {
    // `execArgv` carries the tsx loader flags, so the child parses TypeScript exactly as this
    // process did. `argv[1]` is this file; the scenario names the reader asked for follow it.
    const child = spawnSync(
      process.execPath,
      [...process.execArgv, process.argv[1] as string, ...process.argv.slice(2)],
      { stdio: 'inherit', env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile, [CERT_DIR_ENV]: dir } },
    );
    if (child.error !== undefined) return { unavailable: `could not re-launch: ${child.error.message}` };
    return { code: child.status ?? 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One listener in front of the one machine every scenario below is about. */
interface Origin {
  /**
   * The loopback address to bind. Two ADDRESSES is the only way this harness can put two
   * HOSTNAMES in front of one machine: `127.0.0.1` and `127.0.0.2` are two `normalizeHost` keys,
   * one kernel, one access log — and neither needs a name server or a line in `/etc/hosts`, which
   * is what an apex/`www` pair would need and what a stranger running this cannot be asked for.
   */
  address?: string;
  /** Serve https instead of http, with a certificate that will not outlive the scenario. */
  tls?: Certificate;
}

/** N ordinary http listeners on 127.0.0.1 — several ORIGINS, one host, one bandwidth bill. */
const plainOrigins = (count: number): Origin[] => Array.from({ length: count }, () => ({}));

class OriginUnavailable extends Error {}

/**
 * ONE MACHINE ANSWERING ON SEVERAL ORIGINS, which is what every ceiling scenario below is about.
 *
 * `http://127.0.0.1:A` and `http://127.0.0.1:B` are two origins to RFC 9309 (§2.3 puts
 * `/robots.txt` at the authority's root, and the authority includes the port) and one host to the
 * person paying for the bandwidth. `https://127.0.0.1:C` is a third, and `http://127.0.0.2:D` is a
 * fourth that is also a different HOSTNAME. Every listener here pushes into the SAME `hits` array,
 * so the count a scenario prints is the count a single site owner would see in a single access
 * log — the question the whole "at most N requests to your server" claim is about.
 */
async function withOrigins<T>(
  origins: readonly Origin[],
  handler: (req: IncomingMessage, res: ServerResponse, index: number) => void,
  body: (bases: string[], hits: Hit[]) => Promise<T>,
): Promise<T> {
  const hits: Hit[] = [];
  const servers: (HttpServer | TlsServer)[] = origins.map((origin, index) => {
    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      hits.push({ at: Date.now(), path: `:${index}${req.url ?? ''}` });
      handler(req, res, index);
    };
    const server =
      origin.tls === undefined
        ? createServer(onRequest)
        : createTlsServer({ key: origin.tls.key, cert: origin.tls.cert }, onRequest);
    server.keepAliveTimeout = 120_000;
    server.headersTimeout = 125_000;
    return server;
  });
  const started: (HttpServer | TlsServer)[] = [];
  try {
    for (const [index, server] of servers.entries()) {
      const address = origins[index]?.address ?? '127.0.0.1';
      await new Promise<void>((resolve, reject) => {
        server.once('error', (err: NodeJS.ErrnoException) =>
          reject(
            err.code === 'EADDRNOTAVAIL'
              ? new OriginUnavailable(
                  `this machine will not bind ${address} (${err.code}). On macOS: ` +
                    `sudo ifconfig lo0 alias ${address} up`,
                )
              : err,
          ),
        );
        server.listen(0, address, resolve);
      });
      started.push(server);
    }
    const bases = servers.map((server, index) => {
      const origin = origins[index] as Origin;
      const scheme = origin.tls === undefined ? 'http' : 'https';
      return `${scheme}://${origin.address ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}`;
    });
    return await body(bases, hits);
  } finally {
    await Promise.all(
      started.map((server) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }
}

/** Say why a scenario produced no number, in the same shape as the scenarios that did. */
function skipped(name: string, why: string): void {
  console.log(`\n### ${name}\n  NOT MEASURED HERE: ${why}`);
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
 * loopback spelling of a chain that switches scheme or port; the chain that switches HOSTNAME is
 * `twoNamesOneMachine` below, and since 2026-08-04 it costs the same nine.
 *
 * The `by origin` line is the interesting one: the allowance is gone before the chain leaves the
 * first origin, so the other five listeners never hear from us at all.
 */
async function ceilingManyOrigins(): Promise<void> {
  const seen = new Map<string, number>();
  // Assigned once `listen(0)` has handed out ports, which is after the handler below is built.
  let origins: string[] = [];
  await withOrigins(
    plainOrigins(6),
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
    plainOrigins(2),
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
    plainOrigins(2),
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

/**
 * ONE MACHINE ANSWERING http AND https, OVER REAL TLS, WHICH IS THE WHOLE POINT OF THE CERTIFICATE.
 *
 * `http://example.org` redirecting to `https://example.org` is two origins to RFC 9309 and one
 * machine to the person paying for it, and it is the redirect a site owner is likeliest to have
 * configured deliberately. The README and the crawler-contact template have published a figure for
 * this shape since 2026-08-04 and called it reproducible while the harness in this repository could
 * not serve https at all — the number was taken with a scratchpad script and a certificate nobody
 * else had. This is that scenario, shipped.
 *
 * The http origin's page is in distress (three 429s, then the redirect) and the https origin's
 * `/robots.txt` is too (three 429s, then the file), so the allowance is gone by the time the page
 * under it could be asked for. What it costs the machine is the number printed; what it does NOT do
 * is start again at nine because the scheme changed.
 */
async function schemeChange(): Promise<void> {
  const name = 'SCHEME CHANGE: http -> https on ONE machine, over real TLS';
  if (certificate === null) return skipped(name, noCertificateBecause);
  const seen = new Map<string, number>();
  let origins: string[] = [];
  await withOrigins(
    [{}, { tls: certificate }],
    (req, res, index) => {
      const url = req.url ?? '';
      const key = `${index}${url}`;
      if (index === 1 && url !== '/robots.txt') return html(res, '<p>end</p>');
      if (index === 0 && url === '/robots.txt') return text(res, 200, ALLOW_ALL);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      if (n <= 3) return text(res, 429, 'slow down', { 'retry-after': '0' });
      if (index === 1) return text(res, 200, ALLOW_ALL);
      res.writeHead(301, { location: `${origins[1] ?? ''}/p` });
      return res.end();
    },
    async (bases, hits) => {
      origins = bases;
      const f = fetcher();
      const note = await f
        .fetch({ url: `${bases[0] ?? ''}/p`, method: 'GET', accept: 'html' })
        .then((p) => `payload status ${p.status}`, explain);
      reportFootprint(name, hits, FLOOR, `:1 is ${bases[1]?.split(':').slice(0, 2).join(':')}; ${note}`);
    },
  );
}

/**
 * TWO HOSTNAMES, ONE MACHINE — the apex-to-`www` redirect, which is the commonest redirect there is.
 *
 * `127.0.0.1` and `127.0.0.2` are two different `normalizeHost` keys and one kernel, one access log,
 * one bandwidth bill. That is the same relationship `example.org` and `www.example.org` have, and it
 * is the one shape a loopback harness can produce without a name server or a line in the reader's
 * `/etc/hosts`.
 *
 * WHAT THIS CAUGHT. Until 2026-08-04 the request purse was keyed by hostname, so crossing from one
 * of a machine's names to another bought a whole second allowance: measured HERE, at commit 8ec9873,
 * 18 requests to one machine against a published ceiling of nine — and the crossover gap was 10 ms
 * against a 1000 ms floor, because the second name's lane had never run a request and so had no
 * floor to compute from. Both are fixed; the numbers this prints now are in the README.
 *
 * The construction spends the whole purse at the first name with the LAST of the nine being the
 * redirect, which is the arrangement that maximises what the second name can be charged. The second
 * name's `/robots.txt` is then the expensive one, so anything left would be spent immediately.
 */
async function twoNamesOneMachine(): Promise<void> {
  const name = 'CEILING: one machine answering to TWO NAMES (the apex -> www redirect)';
  const seen = new Map<string, number>();
  let origins: string[] = [];
  try {
    await withOrigins(
      [{}, { address: '127.0.0.2' }],
      (req, res, index) => {
        const url = req.url ?? '';
        if (index === 1) {
          if (serveExpensiveRobots(seen, '1', url, res)) return;
          return html(res, '<p>end</p>');
        }
        if (url === '/robots.txt') return text(res, 200, ALLOW_ALL);
        const hop = Number(/^\/p(\d+)$/.exec(url)?.[1] ?? '0');
        const n = (seen.get(url) ?? 0) + 1;
        seen.set(url, n);
        if (n <= 3) return text(res, 429, 'slow down', { 'retry-after': '0' });
        // The fourth request to each page is the redirect: /p0 -> /p1 -> the machine's other name.
        res.writeHead(301, { location: hop === 0 ? '/p1' : `${origins[1] ?? ''}/p` });
        return res.end();
      },
      async (bases, hits) => {
        origins = bases;
        const f = fetcher();
        const note = await f
          .fetch({ url: `${bases[0] ?? ''}/p0`, method: 'GET', accept: 'html' })
          .then((p) => `payload status ${p.status}`, explain);
        reportFootprint(name, hits, FLOOR, note);
      },
    );
  } catch (err) {
    if (err instanceof OriginUnavailable) return skipped(name, err.message);
    throw err;
  }
}

/**
 * THE ORDINARY VERSION OF THE ABOVE, AND THE ONE THE FLOOR FIX IS ACTUALLY ABOUT: a healthy site
 * whose apex redirects to `www`. Four requests — a `/robots.txt` and a page at each name, since
 * rules are per origin — and the number that matters is the middle GAP, where one name hands over to
 * the other. Measured at 8ec9873 it was 5 ms against a 1000 ms floor; the lane for a name we have
 * never contacted has nothing to pace against, and a redirect is exactly the moment we already know
 * we are about to ask the same machine for something else.
 */
async function nameChangeHealthy(): Promise<void> {
  const name = 'ORDINARY: apex -> www on one machine, healthy robots.txt at both names';
  let origins: string[] = [];
  try {
    await withOrigins(
      [{}, { address: '127.0.0.2' }],
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
        report(name, hits, () => FLOOR, note);
      },
    );
  } catch (err) {
    if (err instanceof OriginUnavailable) return skipped(name, err.message);
    throw err;
  }
}

/**
 * THE arrl.org SHAPE WITH THE ONE THING THE MEASURED SCENARIO LEAVES OUT: a `/robots.txt` that
 * redirects.
 *
 * `twoOriginsOneHost` above measures two requests a night for a two-origin site that blocks us, and
 * that is exact — for a site that serves `/robots.txt` directly at both origins. The shipped registry
 * names `http://www.arrl.org` twice and `https://www.arrl.org` six times, and a site that answers
 * `http://` at all in 2026 is overwhelmingly likely to 301 it to `https://`. If arrl.org does, the
 * nightly cost of a `Disallow: /` there is THREE requests and not two: the `http` origin's read is a
 * redirect plus the file at the far end, and the `https` origin still reads its own copy, because the
 * rules we fetched across that redirect are attributed to the origin we ASKED.
 *
 * Which of the two shapes arrl.org actually has is not measured here and this project will not poll
 * them to find out for a footnote. What is measured here is what EACH shape costs, so the README can
 * say which number is measured and which is inferred instead of quietly printing the flattering one.
 */
async function twoOriginsRedirectingRobots(): Promise<void> {
  let origins: string[] = [];
  await withOrigins(
    plainOrigins(2),
    (req, res, index) => {
      if (req.url !== '/robots.txt') return html(res, '<p>should never be fetched</p>');
      if (index === 1) return text(res, 200, 'User-agent: GrantSpotter\nDisallow: /\n');
      res.writeHead(301, { location: `${origins[1] ?? ''}/robots.txt` });
      return res.end();
    },
    async (bases, hits) => {
      origins = bases;
      const f = fetcher();
      const notes: string[] = [];
      for (const [i, p] of ['/news/rss', '/etp-grants'].entries()) {
        const note = await f
          .fetch({ url: `${bases[i] ?? ''}${p}`, method: 'GET', accept: 'html' })
          .then(() => 'FETCHED — the Disallow was not obeyed', explain);
        notes.push(note);
      }
      reportFootprint(
        "REGISTRY SHAPE: two origins where the first one's robots.txt 301s to the second",
        hits,
        FLOOR,
        notes.join('; '),
      );
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
  schemeChange,
  twoNamesOneMachine,
  nameChangeHealthy,
  twoOriginsOneHost,
  twoOriginsRedirectingRobots,
  portChangeHealthy,
};

const wanted = process.argv.slice(2);
const names = wanted.length > 0 ? wanted : Object.keys(SCENARIOS);
// Every name is checked BEFORE anything runs, and before the re-launch below: a typo should cost a
// message, not two minutes followed by a message.
const runs = names.map((name) => {
  const run = SCENARIOS[name];
  if (run === undefined) {
    throw new Error(`no scenario "${name}". Known: ${Object.keys(SCENARIOS).join(', ')}`);
  }
  return run;
});

certificate = inheritedCertificate();
if (certificate === null && names.includes('schemeChange')) {
  // The parent half of the arrangement described at CERT_DIR_ENV: make a certificate, run this
  // whole script again in a child that trusts that one certificate and nothing else, and take the
  // child's exit code as ours. If there is no certificate to be had, fall through and measure
  // everything else in this process — `schemeChange` will print why it produced no number.
  const outcome = measureInAChildThatTrustsAThrowawayCertificate();
  if ('code' in outcome) process.exit(outcome.code);
  noCertificateBecause = outcome.unavailable;
}

for (const run of runs) {
  await run();
}
