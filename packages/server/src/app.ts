import cookieParser from 'cookie-parser';
import express, { type Express } from 'express';
import { errorHandler, notFoundHandler, requestIdMiddleware } from './api/errors.js';
import { createHealthRouter } from './api/health.js';
import type { AppConfig } from './config.js';
import type { Db } from './db/migrate.js';

export interface AppDeps {
  db: Db;
  config: AppConfig;
  logger?: (line: string) => void;
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

export function createApp(deps: AppDeps): Express {
  const app = express();

  // Behind a reverse proxy (Cloudflare Tunnel, nginx) so req.secure and
  // req.ip reflect the client, which the session cookie flags depend on.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestIdMiddleware());

  app.use('/api', createHealthRouter(deps.db));

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
