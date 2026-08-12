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
 * A MISSING IMAGE IS A 404, NOT A 200 CARRYING THE SHELL.
 *
 * The history fallback below answers every GET it does not recognise with `index.html`, which is
 * what makes `/browse` and `/o/:id` survive a reload. Applied to an image request it produces the
 * worst shape a failure can have: **HTTP 200, `text/html`, and a browser that renders nothing** —
 * the file is missing and nothing anywhere reports it. That is the exact hazard `/favicon.ico` was
 * added to `packages/web/public` to close, and adding one file closed one instance of it.
 *
 * It closes the rest here, at the layer that decides. When no `apple-touch-icon` link is present
 * iOS guesses a sequence of root paths on its own — `apple-touch-icon-152x152-precomposed.png`,
 * `apple-touch-icon-152x152.png`, `apple-touch-icon-precomposed.png`, `apple-touch-icon.png` — and
 * `index.html` links the last of those, so the earlier guesses are not requested today. "Not
 * requested today" is a property of the current markup and not of this server: one edited `<link>`
 * and the guessing starts, silently, into a fallback that answers 200 to all of it. A rule is the
 * only form of that fix that survives an edit somewhere else.
 *
 * SCOPED TO ONE SEGMENT AT THE ROOT, deliberately. That is exactly where a user agent guesses on
 * its own initiative rather than where a person navigates, and no client-side route in `App.tsx` is
 * a single root segment ending in an image extension — the nested ones (`/o/:programId`) are left
 * alone, so a programme id that happened to end in `.png` still renders the SPA's own Not Found
 * page rather than a JSON envelope a browser cannot show.
 *
 * A real file is unaffected: `express.static` runs FIRST and has already answered by the time this
 * is consulted, so the three icons in `packages/web/public` serve their own bytes as they always
 * did. This decides only what happens when the file is not there.
 *
 * `/package.json` and friends keep the shell, and that is not an oversight — see the standing test
 * `never serves a file from outside the dist directory`, whose point is that the static root is the
 * build output. A non-image path with a dot in it is a navigation until something says otherwise.
 */
const IMAGE_FILE_AT_THE_ROOT = /^\/[^/]+\.(?:png|ico|svg|jpe?g|gif|webp|avif|apng|bmp)$/i;

function isMissingImage(pathname: string): boolean {
  return IMAGE_FILE_AT_THE_ROOT.test(pathname);
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
      // Not found, and it was asking for a picture. Falling through hands it to Plan 1's
      // notFoundHandler, which is the one JSON envelope — a 404 a browser reports rather than a
      // 200 it silently renders as nothing.
      if (isMissingImage(req.path)) {
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
