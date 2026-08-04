import cookieParser from 'cookie-parser';
import express, { type Express, type RequestHandler } from 'express';
import { createAuthRouter } from './api/auth.js';
import { errorHandler, notFoundHandler, requestIdMiddleware } from './api/errors.js';
import { createHealthRouter } from './api/health.js';
import { createBootstrapState, type BootstrapState } from './auth/bootstrap.js';
import { attachUser } from './auth/middleware.js';
import { createRateLimiter, type RateLimiter } from './auth/rateLimit.js';
import type { AppConfig } from './config.js';
import { createSessionRepo } from './db/repositories/sessions.js';
import { createUserRepo } from './db/repositories/users.js';
import type { Db } from './db/migrate.js';

export interface AppDeps {
  db: Db;
  config: AppConfig;
  logger?: (line: string) => void;
  bootstrap?: BootstrapState;
  loginLimiter?: RateLimiter;
  /**
   * The ONLY way Plans 3-5 add routes. createApp seals the app with
   * notFoundHandler(), and Express matches in registration order, so calling
   * app.use(...) on the returned object registers routes behind the 404 and
   * they never run. Plan 3 owns the single call site, in src/index.ts, and
   * the callback is filled incrementally: Plan 3 Task 14 creates it and
   * reserves its final position, Plan 4 Task 17 and Plan 5 Task 9 add their
   * routers above that position (RESOLUTIONS R25).
   * The static SPA middleware goes through this hook as well, last of all:
   * Plan 5 Task 17 creates api/spa.ts and installs
   * a.use(createSpaMiddleware(webDistRoot())) in the reserved position, as
   * the callback's last statement (RESOLUTIONS R16 + R25).
   */
  mountRoutes?: (app: Express) => void;
}

/**
 * The one route whose request body is legitimately a whole database.
 *
 * DEVIATION FROM PLAN 5 TASK 9'S FILE LIST, found by running the route rather than by reading it.
 * `GET /api/admin/backup.json` on the committed corpus serves **2.2 MB**, and posting that exact
 * document back to `POST /api/admin/restore` answered **413 payload_too_large** — the global
 * `express.json({ limit: '1mb' })` rejects it before any router sees it. A restore endpoint that
 * cannot accept the backup its own sibling route just produced is decorative, and nothing in
 * either task's unit suite could see it: both mount their own bare express app with their own
 * parser, and the fixtures are a handful of rows.
 *
 * The limit stays at 1 MB for EVERY OTHER ROUTE. Raising it globally would widen the memory a
 * single unauthenticated POST can make this process buffer, on every endpoint, to fix one — and
 * `test/app.health.test.ts` pins the 1 MB refusal on `/api/health` precisely so that cannot happen
 * quietly.
 *
 * The residual exposure is stated rather than hidden: body parsing runs before `attachUser`, so an
 * anonymous caller can make the process buffer up to this much on this one path before the
 * `requireAdmin` guard refuses them. 32 MB is roughly fifteen times the current corpus's backup —
 * headroom for a deployment that has grown, not an open door — and this is a single-process,
 * self-hosted application behind the operator's own tunnel.
 */
const BACKUP_RESTORE_PATH = '/api/admin/restore';
const BACKUP_JSON_LIMIT = '32mb';
const STANDARD_JSON_LIMIT = '1mb';

function bodyParsers(): RequestHandler {
  const standard = express.json({ limit: STANDARD_JSON_LIMIT });
  const backup = express.json({ limit: BACKUP_JSON_LIMIT });
  return (req, res, next) => {
    if (req.method === 'POST' && req.path === BACKUP_RESTORE_PATH) {
      backup(req, res, next);
      return;
    }
    standard(req, res, next);
  };
}

export function createApp(deps: AppDeps): Express {
  const app = express();

  // Behind a reverse proxy (Cloudflare Tunnel, nginx) so req.secure and
  // req.ip reflect the client, which the session cookie flags depend on.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // requestIdMiddleware() must run first, before express.json() and
  // cookieParser(). Body-parser and cookie-parser failures skip straight to
  // errorHandler without reaching any later middleware; if requestId
  // middleware ran after them, the x-request-id RESPONSE HEADER would never
  // be set on those paths (errorHandler's randomUUID() fallback covers the
  // response body regardless, which is what let this slip past body-only
  // assertions in review). Fix round 1 finding, app.ts:39-41.
  app.use(requestIdMiddleware());
  app.use(bodyParsers());
  app.use(cookieParser());
  app.use(
    attachUser({
      users: createUserRepo(deps.db),
      sessions: createSessionRepo(deps.db),
      sessionSecret: deps.config.sessionSecret,
    }),
  );

  app.use('/api', createHealthRouter(deps.db));

  const bootstrap = deps.bootstrap ?? createBootstrapState(deps.db);
  const loginLimiter =
    deps.loginLimiter ?? createRateLimiter({ windowMs: 15 * 60 * 1000, maxFailures: 5 });
  app.use('/api', createAuthRouter({ db: deps.db, config: deps.config, bootstrap, loginLimiter }));

  // Everything Plans 3, 4 and 5 mount goes here, and nowhere else. The
  // callback is filled incrementally (RESOLUTIONS R25): Plan 3 Task 14
  // creates it and reserves its final position, Plan 4 Task 17 and Plan 5
  // Task 9 add their /api routers above that position. The static SPA
  // belongs in here too (RESOLUTIONS R16): Plan 5 Task 17 installs
  // a.use(createSpaMiddleware(webDistRoot())) in the reserved position, as
  // the LAST statement of this callback, after every /api router, so it
  // never shadows them and GET / never reaches notFoundHandler(). Nothing
  // may be added to the returned app: the two lines below seal it.
  deps.mountRoutes?.(app);

  app.use(notFoundHandler());
  const errorOptions = deps.logger === undefined ? {} : { logger: deps.logger };
  app.use(errorHandler(errorOptions));

  return app;
}
