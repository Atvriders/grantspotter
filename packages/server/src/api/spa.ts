import { resolve, sep } from 'node:path';
import express, { type RequestHandler } from 'express';

// NOTE: this file exports ONE symbol. `webDistRoot()` lives in ./webDist.ts and
// belongs to Plan 3 (RESOLUTIONS R27) — it resolves packages/web/dist from
// import.meta.url rather than process.cwd(), so it is correct both for
// `tsx packages/server/src/index.ts` in development and for
// `node packages/server/dist/index.js` with cwd=/app in the container. Defining a
// second copy here is how the two drift. The caller passes the directory in.

/**
 * Paths the server owns. A GET whose path starts with one of these never
 * receives the SPA shell: it falls through untouched, so Plan 1's
 * notFoundHandler still answers with the one JSON envelope (RESOLUTIONS R16).
 *
 * '/calendar/' keeps its trailing slash deliberately. Task 9's feed router owns
 * '/calendar/:token', but bare '/calendar' is the SPA's own Calendar page and is
 * in the nav rail; reserving the bare word would answer JSON to anyone who
 * bookmarks it or presses reload on it.
 */
const SERVER_OWNED_PREFIXES = ['/api', '/calendar/'] as const;

function isServerOwned(pathname: string): boolean {
  return SERVER_OWNED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * One year, in seconds — the conventional ceiling for `max-age`.
 */
const ONE_YEAR_SECONDS = 31_536_000;

/**
 * Vite content-hashes every file it emits into `dist/assets`, so those URLs are
 * immutable by construction: a changed byte is a changed filename. They are the
 * one thing here worth caching hard. `index.html` is the exact opposite — it
 * names the current hashed bundles, so a cached copy is how a browser keeps
 * loading the previous deploy's JavaScript. Hence `no-cache` on the shell (which
 * means "revalidate", not "do not store") and a year on the hashed assets.
 *
 * serve-static only applies its own `public, max-age=0` when Cache-Control is
 * unset, so setting it from the `headers` hook wins.
 */
const ASSETS_PREFIX = `${sep}assets${sep}`;

/**
 * Serve the built SPA: real files first, then the history fallback.
 *
 * Mounted at the root and LAST, from the mountRoutes callback in index.ts, after
 * every /api router and after the /calendar/:token feed (RESOLUTIONS R5, R16,
 * R25). It is the only middleware in the application that answers a path it has
 * never heard of, which is exactly why it must be registered last.
 *
 * `index: false` disables serve-static's directory-index handling: that would
 * answer '/' and leave '/browse' 404ing. Owning the fallback ourselves means
 * every client-side route returns one byte-identical shell.
 */
export function createSpaMiddleware(webDistDir: string): RequestHandler {
  const indexHtml = resolve(webDistDir, 'index.html');
  const assets = express.static(webDistDir, {
    index: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      if (filePath.includes(ASSETS_PREFIX)) {
        res.setHeader('Cache-Control', `public, max-age=${String(ONE_YEAR_SECONDS)}, immutable`);
      }
    },
  });

  return (req, res, next) => {
    assets(req, res, (staticError?: unknown) => {
      if (staticError !== undefined && staticError !== null) {
        next(staticError);
        return;
      }
      if (req.method !== 'GET') {
        next();
        return;
      }
      if (isServerOwned(req.path)) {
        next();
        return;
      }
      res.setHeader('Cache-Control', 'no-cache');
      // An ENOENT here means the image was built without `npm run build`. Forward
      // it so it surfaces as a loud 500 rather than a blank 200.
      res.sendFile(indexHtml, { cacheControl: false }, (sendError?: Error) => {
        if (sendError !== undefined && sendError !== null) next(sendError);
      });
    });
  };
}
