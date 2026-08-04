import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createSpaMiddleware } from './spa.js';
// webDistRoot is Plan 3's, from api/webDist.ts (RESOLUTIONS R27). It is imported here
// rather than redefined, and the last describe block asserts the contract this
// middleware depends on: that it points at packages/web/dist from src and from dist alike.
import { webDistRoot } from './webDist.js';
import { errorHandler, notFoundHandler, requestIdMiddleware } from './errors.js';

const INDEX_HTML =
  '<!doctype html><html><head><title>GrantSpotter</title></head>' +
  '<body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>';

let server: Server;
let base: string;
let dist: string;

beforeAll(async () => {
  // A stand-in for `npm run build`'s output. The test never needs the real Vite
  // bundle: what is under test is routing, not bundling.
  dist = mkdtempSync(join(tmpdir(), 'gs-spa-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX_HTML, 'utf8');
  writeFileSync(join(dist, 'assets', 'main.js'), 'export const built = true;\n', 'utf8');

  // Deliberately the same shape as the real app: request id, an API router, the
  // SPA middleware LAST, then Plan 1's notFoundHandler and errorHandler. If the
  // ordering here stops matching the mountRoutes callback in index.ts, this suite
  // is testing a different application from the one that ships.
  const app = express();
  app.use(requestIdMiddleware());
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(createSpaMiddleware(dist));
  app.use(notFoundHandler());
  app.use(errorHandler({ logger: () => {} }));
  await new Promise<void>((done) => {
    server = app.listen(0, '127.0.0.1', done);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

describe('createSpaMiddleware', () => {
  it('serves the built index.html on /', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('serves the same shell for a client-side route, so a deep link and a reload both work', async () => {
    const root = await (await fetch(`${base}/`)).text();
    const deep = await fetch(`${base}/browse`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get('content-type')).toContain('text/html');
    expect(await deep.text()).toBe(root);
  });

  it('serves the shell for a nested client-side route too', async () => {
    const res = await fetch(`${base}/o/arrl-foundation-scholarships`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('serves a real asset as itself, not as the shell', async () => {
    const res = await fetch(`${base}/assets/main.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('export const built = true;');
  });

  it('leaves /api alone: an unknown API route still gets Plan 1 JSON 404 envelope', async () => {
    const res = await fetch(`${base}/api/unknown`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: { code: string }; requestId: string };
    expect(body.error.code).toBe('not_found');
    expect(typeof body.requestId).toBe('string');
  });

  it('never shadows a real API route', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('reserves the calendar feed path, so a bad token stays JSON and never becomes HTML', async () => {
    const res = await fetch(`${base}/calendar/not-a-real-token.ics`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('still serves the SPA Calendar page, which is /calendar with no token', async () => {
    const res = await fetch(`${base}/calendar`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('does not answer a POST with HTML', async () => {
    const res = await fetch(`${base}/`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).not.toContain('<div id="root"></div>');
  });

  it('never serves a file from outside the dist directory', async () => {
    // /package.json exists at the repository root and must NOT be reachable:
    // the static root is the build output, not the working directory.
    const res = await fetch(`${base}/package.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="root"></div>');
  });
});

// DEVIATION FROM THE TASK BRIEF, recorded here because it is behaviour the brief's
// snippet does not specify and the caller asked to have confirmed: cache headers.
// Vite content-hashes everything it writes into dist/assets, so those URLs are
// immutable by construction and are the one thing worth caching for a year. The
// shell is the opposite: it names the current hashed bundles, so a cached copy is
// how a browser keeps loading the previous deploy's JavaScript forever. Without
// this block serve-static's default `public, max-age=0` applies to both, which is
// safe but revalidates every asset on every navigation.
describe('cache headers', () => {
  it('caches a content-hashed asset hard, because its URL changes when its bytes do', async () => {
    const res = await fetch(`${base}/assets/main.js`);
    const cacheControl = res.headers.get('cache-control') ?? '';
    expect(cacheControl).toContain('max-age=31536000');
    expect(cacheControl).toContain('immutable');
  });

  it('never lets the shell be cached, so a deploy is picked up on the next load', async () => {
    for (const path of ['/', '/browse']) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });
});

describe('webDistRoot (Plan 3 owns it; this is the contract the middleware is handed)', () => {
  it('is an absolute path ending in packages/web/dist', () => {
    const root = webDistRoot();
    expect(isAbsolute(root)).toBe(true);
    expect(root.endsWith(['packages', 'web', 'dist'].join(sep))).toBe(true);
  });

  it('is anchored on the repository root, which is what makes it work from src and from dist', () => {
    // src/api/webDist.ts and dist/api/webDist.js are both exactly four directories
    // below the root, so one piece of arithmetic serves tsx in dev and node in /app.
    const repoRoot = resolve(webDistRoot(), '..', '..', '..');
    expect(existsSync(join(repoRoot, 'package.json'))).toBe(true);
    expect(existsSync(join(repoRoot, 'packages', 'server'))).toBe(true);
  });
});
