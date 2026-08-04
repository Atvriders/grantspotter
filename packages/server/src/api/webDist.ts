import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the built SPA (`packages/web/dist`), for
 * `createSpaMiddleware` (Plan 5's api/spa.ts, RESOLUTIONS R16).
 *
 * THIS IS THE ONLY DEFINITION (RESOLUTIONS R27). Plan 5's `api/spa.ts` imports
 * `webDistRoot` from `./webDist.js`; it must not declare a second copy. Two
 * answers to "where is the built SPA" diverge silently and the divergence only
 * shows up as a 404 inside the container, which is the hardest place to see it.
 *
 * Resolved from import.meta.url rather than process.cwd() because the server is
 * started from three different working directories: the repo root (`npm run
 * dev`, vitest), `packages/server` (tsx), and `/app` in the image.
 *
 * `../../../web/dist` is correct from BOTH `packages/server/src/api/` and
 * `packages/server/dist/api/` — `src` and `dist` are siblings under
 * `packages/server`, so each is exactly three levels below `packages/`, and
 * Plan 5's Dockerfile COPYs `packages/web/dist` to the matching place in the
 * image. One expression, three contexts.
 */
export function webDistRoot(): string {
  return fileURLToPath(new URL('../../../web/dist', import.meta.url));
}
