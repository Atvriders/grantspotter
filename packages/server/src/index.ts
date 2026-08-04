import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { buildUserAgent, ConfigError, loadConfig, type AppConfig } from './config.js';
import { createAiAssist, runCrawl, startScheduler } from './crawl/index.js';
import { ensureIngestionSchema } from './db/ingestSchema.js';
import { migrate, openDatabase } from './db/migrate.js';
import { createFetcher } from './fetcher/index.js';
import { requireAdmin, requireAuth } from './auth/middleware.js';
import { currentSessionUser, mountProductApi } from './api/mount.js';
import { createVerifyRunner } from './api/verify.js';
import { reindexBrowse } from './api/reindex.js';
import { drainChangeEvents } from './api/notify.js';
import { SOURCES } from './sources/registry.js';
// Plan 2's optional transport wiring. It must be identical on the scheduled and
// the admin-triggered path (RESOLUTIONS R23), which is why the one fetcher that
// carries it is constructed once below and shared by both.
import { simplerAuthHeaders } from './federal/simplerGrants.js';
import type { RouterDeps } from './api/deps.js';
// Plan 4's four routers, added here with their mount lines below, exactly as
// R25 prescribes: the import and the `a.use(...)` land in the same commit, so
// the build never references a module that is not yet mounted or vice versa.
import { createApplicationsRouter } from './api/applications.js';
import { createTemplatesRouter } from './api/templates.js';
import { createProseRouter } from './api/prose.js';
import { createPromptsRouter } from './api/prompts.js';
// NOTE (RESOLUTIONS R25): there are still deliberately NO imports here from
// api/exports.ts, exports/dataSource.ts or api/spa.ts (Plan 5). That plan adds
// its own import lines when it adds its own mount lines. Adding them now
// breaks `npm run build`, and a broken build takes the e2e suite with it.
//
// DEVIATION FROM THE TASK BRIEF (2026-08-04): `createAiAssist` is imported from
// ./crawl/index.js, NOT from the assist module directly as the brief's snippet
// writes it. Plan 2 re-exported it from crawl/ precisely so the composition
// root reaches the optional assist through crawl/, and the assist suite
// enforces that by reading the source of every server file that names the
// assist module's path. Following the brief literally turns that suite red.
// (That guard matches raw file text, so this comment states the path in prose
// rather than spelling it — the same comment-blindness recorded in progress.md
// for the schema-ownership guard.)

function readConfig(): AppConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[config] ${err.message}`);
      console.error('[config] Refusing to start. See .env.example.');
      process.exit(1);
    }
    throw err;
  }
}

function main(): void {
  const config = readConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const db = openDatabase(join(config.dataDir, 'grantspotter.sqlite'));
  const result = migrate(db);
  console.log(
    `[db] migrations: ${result.applied.length} applied, ${result.alreadyApplied.length} already present`,
  );

  // AFTER migrate(db): ensureIngestionSchema asserts Plan 1's shape (including sources.enabled,
  // which runCrawl gates on — RESOLUTIONS R20) and would throw MissingSchemaError against an
  // unmigrated database.
  ensureIngestionSchema(db);

  const now = (): string => new Date().toISOString();

  // ONE fetcher for the whole process — the nightly scheduler (Plan 2), "Verify
  // now" (Task 10) and the admin crawl trigger (Task 14) all share it.
  // `headersByHost` carries the optional Simpler.Grants.gov X-Auth key (Plan 2
  // Task 24) and is `{}` when SIMPLER_GRANTS_API_KEY is unset; omitting it here
  // would make an admin-triggered crawl of `grants-gov-federal` silently drop
  // the key while the identical 03:17 run kept it (RESOLUTIONS R23).
  const fetcher = createFetcher({
    userAgent: buildUserAgent(config),
    contactUrl: config.contactUrl,
    dataDir: config.dataDir,
    headersByHost: simplerAuthHeaders(),
  });

  // Spec §9, strictly optional. Disabled and calls nothing when ANTHROPIC_API_KEY is
  // unset — createAiAssist's own isEnabled() gate makes this safe to pass unconditionally.
  // Constructed once so the manual and the scheduled crawl paths are identical (R23).
  const assist = createAiAssist(config);

  // The one CrawlDeps in the process. Both callers below are handed this exact
  // object, so "Crawl now" cannot drift from the 03:17 run (RESOLUTIONS R23).
  const crawlDeps = { db, fetcher, nowISO: now, assist };

  // Nightly, jittered — never hourly. Nothing in this corpus changes faster than weekly, and
  // ~25 small-nonprofit sites should not all be hit at the same second by every deployment of
  // this app. CRAWL_ENABLED=false starts nothing at all.
  console.log(`[crawl] enabled=${String(config.crawlEnabled)} cron="${config.crawlCron}"`);
  const crawlScheduler = startScheduler(
    { cron: config.crawlCron, enabled: config.crawlEnabled },
    () => runCrawl(crawlDeps),
  );
  process.on('SIGTERM', () => crawlScheduler.stop());

  // Plan 1's attachUser middleware has already put the authenticated user on
  // req.auth by the time any of these routers run; requireAuth guarantees it,
  // and currentSessionUser throws rather than invent one if it is missing.
  const routerDeps: RouterDeps = {
    db,
    now,
    requireAuth: requireAuth(),
    requireAdmin: requireAdmin(),
    currentUser: currentSessionUser,
  };

  const verifyRunner = createVerifyRunner({ db, fetcher, sources: SOURCES, now });

  // THE SINGLE COMPOSITION SITE FOR THE WHOLE APPLICATION (RESOLUTIONS R5 /
  // CONTRACT §10.3). createApp finishes with `deps.mountRoutes?.(app);
  // app.use(notFoundHandler()); app.use(errorHandler(...));`, so a router
  // registered after createApp returns is dead code that can never match.
  // Every router from Plans 3, 4 and 5 is constructed inside the one
  // mountRoutes callback below, and NO plan calls app.use(...) on the
  // returned app.
  const app = createApp({
    db,
    config,
    mountRoutes: (a) => {
      // --- Plan 3: browse, detail, verify, profiles, watches, notifications,
      //     channels, calendar, inbox, admin users, sources ---
      // The crawl argument list is IDENTICAL to Plan 2's scheduler call above:
      // the same crawlDeps object, therefore the same fetcher (and the same
      // headersByHost) and the same assist. An admin pressing "Crawl now"
      // after fixing a parser must reproduce the 03:17 run exactly (R23).
      mountProductApi(a, routerDeps, verifyRunner, (sourceIds) => runCrawl(crawlDeps, sourceIds));

      // Nothing is EVER mounted after createApp returns: this callback is the
      // whole seam, and Plan 1 seals the app with notFoundHandler() the moment
      // it hands the app back (RESOLUTIONS R5).

      // --- Plan 4: application drafts, templates, prose analysis, AI prompts ---
      // FULL routerDeps (R17). `createTemplatesRouter` takes an optional second
      // argument (a `templatesRoot` test seam); production passes none, so the
      // shipped `content/` tree is always what serves.
      a.use('/api/applications', createApplicationsRouter(routerDeps));
      a.use('/api/templates', createTemplatesRouter(routerDeps));
      a.use('/api/prose', createProseRouter(routerDeps));
      a.use('/api/prompts', createPromptsRouter(routerDeps));

      // Plan 5 Task 9 Step 9 adds, with an exportDeps satisfying ExportDeps and
      // reading `req.auth?.id` (R22 — there is no express-session in this stack):
      //     a.use('/api', createExportsRouter(exportDeps));
      //     a.use('/',    createCalendarFeedRouter(exportDeps));
      // Plan 5 Task 17 adds, ALWAYS LAST (R16), so client-side routes resolve on
      // a hard refresh and nothing it would shadow is registered after it:
      //     a.use(createSpaMiddleware(webDistRoot()));
      // `webDistRoot` already exists, in api/webDist.ts. Import it there; do
      // not write a second copy (RESOLUTIONS R27).
      //
      // ---------------------------------------------------------------------
      // Plans 4 and 5 append their routers below. The SPA middleware (Plan 5
      // Task 17) MUST remain the last statement. (RESOLUTIONS R25)
      // ---------------------------------------------------------------------
    },
  });

  // The browse projection is derived state. Rebuild it at boot so a restore, a
  // seed import, or a migration can never leave stale filters behind, and drain
  // the change-event queue so a digest is never missing a night the process was
  // down for.
  reindexBrowse(db, now());
  drainChangeEvents(db, now());

  app.listen(config.port, () => {
    console.log(`[server] GrantSpotter listening on port ${config.port}`);
  });
}

main();
