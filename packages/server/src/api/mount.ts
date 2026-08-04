import type { Express, Request } from 'express';
import type { CrawlTrigger, RouterDeps, SessionUser } from './deps.js';
import { AppError } from './errors.js';
import type { VerifyRunner } from './verify.js';
import { createProgramsRouter } from './programsRouter.js';
import { createVerifyRouter } from './verifyRouter.js';
import { createProfileRouter, createMeRouter } from './profileRouter.js';
import { createWatchRouter } from './watchRouter.js';
import { createNotificationRouter } from './notificationRouter.js';
import { createChannelRouter } from './channelRouter.js';
import { createCalendarRouter } from './calendarRouter.js';
import { createInboxRouter } from './inboxRouter.js';
import { createAdminUsersRouter } from './adminUsersRouter.js';
import { createSourcesRouter } from './sourcesRouter.js';

/**
 * `RouterDeps.currentUser` as the server entrypoint supplies it.
 *
 * Plan 1's `attachUser` middleware has already put the authenticated user on
 * `req.auth` by the time any Plan 3 router runs, and `requireAuth` guarantees
 * it is there. Reaching the throw therefore means a route was registered
 * without a guard — which is worth failing loudly for, because the alternative
 * is scoping somebody's watchlist, profile or (Plan 4) application to an
 * invented anonymous id.
 *
 * It lives here, beside `mountProductApi`, rather than inline in `index.ts`,
 * so the function production runs is the function the composition test covers:
 * `index.ts` calls `main()` at import time and cannot be imported by a test.
 */
export function currentSessionUser(req: Request): SessionUser {
  if (req.auth === undefined) throw new AppError('unauthorized', 'Sign in to continue.');
  return { id: req.auth.id, email: req.auth.email, role: req.auth.role };
}

/**
 * Mount every Plan 3 product router. The verify router is mounted on the same
 * base path as the programs router and is registered FIRST so its
 * POST /:id/verify is matched before the programs router's GET /:id.
 *
 * This function is only ever called from inside `AppDeps.mountRoutes`
 * (RESOLUTIONS R5). Calling it on an app that `createApp` has already returned
 * would register every router AFTER Plan 1's notFoundHandler, and all eleven
 * would silently 404.
 */
export function mountProductApi(
  app: Express,
  deps: RouterDeps,
  runner: VerifyRunner,
  crawl: CrawlTrigger,
): void {
  app.use('/api/programs', createVerifyRouter(deps, runner));
  app.use('/api/programs', createProgramsRouter(deps));
  app.use('/api/profiles', createProfileRouter(deps));
  app.use('/api/me', createMeRouter(deps));
  app.use('/api/watches', createWatchRouter(deps));
  app.use('/api/notifications', createNotificationRouter(deps));
  app.use('/api/channels', createChannelRouter(deps));
  app.use('/api/calendar', createCalendarRouter(deps));
  app.use('/api/inbox', createInboxRouter(deps));
  app.use('/api/admin/users', createAdminUsersRouter(deps));
  app.use('/api/sources', createSourcesRouter(deps, crawl));
}
