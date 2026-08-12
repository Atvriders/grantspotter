import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'node:path';
import type { Request } from 'express';
import { createApp } from './app.js';
import { buildUserAgent, ConfigError, loadConfig, type AppConfig } from './config.js';
import { createAiAssist, runCrawl, startScheduler } from './crawl/index.js';
import { ensureIngestionSchema } from './db/ingestSchema.js';
import { migrate, openDatabase } from './db/migrate.js';
import { createFetcher } from './fetcher/index.js';
import { requireAdmin, requireAuth } from './auth/middleware.js';
import { createBootstrapState } from './auth/bootstrap.js';
import { currentSessionUser, mountProductApi } from './api/mount.js';
import { createCallsignRouter } from './api/callsign.js';
import { CALLSIGN_LOOKUP_PURPOSE } from './callsign/callook.js';
import { createVerifyRunner } from './api/verify.js';
import { reindexBrowse } from './api/reindex.js';
import { drainChangeEvents } from './api/notify.js';
import { importSeedIfEmpty } from './seed/import.js';
import { SOURCES } from './sources/registry.js';
// Plan 2's optional transport wiring. It must be identical on the scheduled and
// the admin-triggered path (RESOLUTIONS R23), which is why the one fetcher that
// carries it is constructed once below and shared by both.
import { simplerAuthHeaders } from './federal/simplerGrants.js';
import type { RouterDeps } from './api/deps.js';
// Plan 4's four routers, added here with their mount lines below, exactly as
// R25 prescribes: the import and the mount call land in the same commit, so
// the build never references a module that is not yet mounted or vice versa.
// (Prose here deliberately does not spell the mount call out: Task 17 Step 6
// and Task 23 §15 grep this file for it, and a comment that quotes one is
// indistinguishable from a real mount to a grep.)
import { createApplicationsRouter } from './api/applications.js';
import { createTemplatesRouter } from './api/templates.js';
import { createProseRouter } from './api/prose.js';
import { createPromptsRouter } from './api/prompts.js';
// Plan 5 Task 17: the built SPA and its history fallback, mounted last below.
// `webDistRoot` is Plan 3's and lives in api/webDist.ts — imported here, never
// re-declared in api/spa.ts (RESOLUTIONS R27).
import { createSpaMiddleware } from './api/spa.js';
import { webDistRoot } from './api/webDist.js';
// Plan 5 Task 9: the export routes (csv/xlsx/ics/docx/md/zip plus the admin
// backup and restore) and the token-authenticated public ICS feed, which is
// mounted at the ROOT because a subscribing calendar client cannot send a
// session cookie. Imported here, with the mount lines below, in the one commit
// (RESOLUTIONS R25).
import { createCalendarFeedRouter, createExportsRouter } from './api/exports.js';
import { createSqliteExportDataSource } from './exports/dataSource.js';
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
      // Not "Edit docker-compose.yml." full stop. This line prints on EVERY ConfigError, and one
      // of the two ways this process is started is `npm run dev`, where no compose file is read
      // and the advice would name a file that has nothing to do with the failure. There is no
      // reliable way to tell the two apart from inside the process — NODE_ENV, DATA_DIR and PORT
      // are all set to the same things by a developer as by the image — so the message names the
      // one thing that is true either way (the environment this process was handed) and then
      // names where that environment comes from in each case.
      console.error(
        '[config] Refusing to start. These values come from the environment this process was ' +
          'given: the environment: block of docker-compose.yml if you started it with docker ' +
          'compose, or your shell if you started it with npm run dev.',
      );
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

  // THE FIRST-RUN CORPUS. A fresh install has an empty database, and nothing else in this process
  // would ever put a funder in front of a user: the crawl is nightly and everything it finds waits
  // in a review queue for an admin. So the shipped corpus lands here, and only here.
  //
  // The position is the whole of it. AFTER migrate(), because the import writes source_id and
  // external_key. BEFORE startScheduler below, because a crawl against an empty programs table
  // resolves no existing record for any (sourceId, externalKey) and mints a fresh id for the whole
  // corpus — after which the seed, arriving second, is the duplicate. And BEFORE the
  // reindexBrowse() call further down, which is what puts these records into the browse
  // projection; the importer deliberately does not reindex itself (see seed/import.ts).
  //
  // The log line is for the operator: on a fresh container it prints the corpus size at boot, and
  // on every restart after that it says their reviewed data was left alone.
  const seedResult = importSeedIfEmpty(db);
  console.log(`[seed] ${seedResult.reason}`);

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
  // The SIGTERM handler is registered AFTER app.listen, at the bottom of this
  // function, because it has to close the listener too. Registering it here —
  // as this file used to — replaced Node's default terminate-on-SIGTERM with a
  // handler that stopped the scheduler and then returned, leaving the process
  // alive and listening forever. See installShutdown below.

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

  /**
   * THE ONE REQUEST IN THIS PRODUCT THAT DOES NOT GO THROUGH THE FETCHER, AND THE NAME IT SIGNS.
   *
   * `callsign/callook.ts` deliberately does not hold a fetch of its own — it takes a transport and
   * refuses to default one, so the unit suite cannot reach the network from it even by accident.
   * The transport therefore has to be supplied HERE, and this is the right place for a second
   * reason: `buildUserAgent` may only be called from a declared entry point (see
   * `test/contactUrlEntryPointContract.test.ts`), and minting a second User-Agent anywhere else
   * would be exactly the shared-identity defect that file exists to prevent.
   *
   * WHY IT CARRIES ONE AT ALL. Until 2026-08-04 it did not: measured against a loopback server,
   * the lookup arrived as `user-agent: node` while every crawl request from the same process
   * arrived as `GrantSpotter/0.1.0 (+<the operator's page>; …)`. This project spent its whole
   * design on the rule that no outbound request is anonymous — a small site's owner must be able
   * to see who is asking and reach a human — and then made one request that was. callook.info is
   * a volunteer-run service answering these for free; it is entitled to the same courtesy, and to
   * knowing which deployment to write to. It comes from the same factory as every crawl request,
   * off the same `CONTACT_URL` the server refuses to start without.
   *
   * AND IT SAYS WHAT THIS ACTUALLY IS. Until later the same day it was byte-identical to the
   * crawler's, purpose clause included — `nightly grant-deadline change detector`, on a request
   * that is not nightly, detects nothing, and is about one licence a person asked us to read. A
   * site owner reading that line was being identified at correctly and described at wrongly. The
   * clause is a parameter of the ONE factory (RESOLUTIONS R10 — see `config.ts`), never a second
   * factory, and the value is the lookup's own constant so that the sentence lives beside the code
   * it describes.
   *
   * `Headers` rather than a spread of `init.headers`: the client sends a plain object today, and a
   * spread would silently drop the caller's `accept` the day it sends a `Headers` instance
   * instead. `set` (not `append`) so a transport-level identity can never end up doubled.
   */
  const callsignUserAgent = buildUserAgent(config, CALLSIGN_LOOKUP_PURPOSE);
  const callsignTransport = (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('user-agent', callsignUserAgent);
    return fetch(url, { ...init, headers });
  };

  /**
   * ONE BootstrapState FOR THE PROCESS, constructed here rather than left to `createApp`.
   *
   * Two routers now read the same one-time token: `createAuthRouter`, which SPENDS it to create
   * the first administrator, and `createCallsignRouter`, which only READS it to authorise the
   * first-run screen's lookup. `createApp` builds its own when `deps.bootstrap` is absent, and two
   * instances would mean two different random tokens — the setup screen would hold one that the
   * lookup route had never heard of, and vice versa. Passing one in is what makes them the same
   * token. The first-run banner is printed as a side effect of this call, once, exactly as before.
   */
  const bootstrap = createBootstrapState(db);

  // PLAN-LOCAL dependency bundle, satisfying the ExportDeps interface exported
  // by api/exports.ts. Built inline: there is deliberately no createExportDeps
  // factory, because a second definition of the same bundle is a second thing
  // to keep in sync (RESOLUTIONS R22). `requireAuth`, `requireAdmin` and `now`
  // are the same values routerDeps above was built from.
  const exportDeps = {
    data: createSqliteExportDataSource(db),
    requireAuth: requireAuth(),
    requireAdmin: requireAdmin(),
    now,
    // req.auth is populated by Plan 1's attachUser middleware through a module
    // augmentation of Express's Request. THERE IS NO express-session IN THIS
    // STACK: an express-session style `session` property does not exist on
    // Request, does not compile, and must appear nowhere (R22). Plan 1's own
    // `sessionKey` property on Request is a different, legitimate thing — its
    // logout route reads it back to revoke the session row — and is not
    // affected.
    userIdOf: (req: Request) => req.auth?.id,
    // The public base for a subscribable feed URL. `app.set('trust proxy', 1)`
    // in app.ts means req.protocol and req.get('host') reflect the CLIENT's
    // view through a Cloudflare Tunnel or nginx, which is the only view that
    // produces a URL a phone can actually fetch.
    publicBaseUrl: (req: Request) => `${req.protocol}://${req.get('host') ?? '127.0.0.1'}`,
  };

  // THE SINGLE COMPOSITION SITE FOR THE WHOLE APPLICATION (RESOLUTIONS R5 /
  // CONTRACT §10.3). createApp invokes deps.mountRoutes and then seals the app
  // with the not-found handler and the error handler, so a router registered
  // after createApp returns is dead code that can never match. Every router
  // from Plans 3, 4 and 5 is constructed inside the one mountRoutes callback
  // below, and NO plan mounts anything on the returned app. (Task 23 §15 greps
  // this file for a mount on the returned app and expects zero hits, so this
  // note describes the forbidden call rather than quoting it.)
  console.log(`[callsign] lookup enabled=${String(config.callsignLookupEnabled)}`);

  const app = createApp({
    db,
    config,
    bootstrap,
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

      // --- Plan 5 Task 9: exports, and the public ICS feed at the root ---
      // '/api' plus the router's own '/exports/…' paths gives
      // /api/exports/opportunities.csv. The feed router owns '/calendar/:token'
      // and is mounted at '/' on purpose: a calendar client cannot send a
      // session cookie, so the token in the path IS the credential. It sits
      // ABOVE the SPA middleware below and can never be after it — api/spa.ts
      // reserves the '/calendar/' prefix (with the trailing slash, so the SPA's
      // own bare /calendar page still resolves), but a router registered after
      // the fallback would never be reached at all.
      a.use('/api', createExportsRouter(exportDeps));
      a.use('/', createCalendarFeedRouter(exportDeps));

      // --- The user-initiated callsign lookup. ABOVE the SPA middleware below,
      //     like every other /api router; a router registered after the
      //     fallback is never reached for a GET, and this one would 404 on a
      //     POST for the ordinary reason that nothing matched.
      //
      //     Conditional, and the ONLY conditional mount in this callback. This
      //     is the one path in the product that contacts a host publishing
      //     `Disallow: /` — the argument for why that is legitimate is written
      //     out in api/callsign.ts, in callsign/callook.ts and in the README,
      //     and an operator who does not accept it needs a way to act on that
      //     which is not "fork the image". With it false the route is never
      //     registered, so the SPA's profile form falls back to what a non-US
      //     licensee already gets: four fields typed in by hand.
      //
      //     `bootstrap.token()` is READ, never consumed — spending the one-time
      //     token on a callsign lookup would leave the operator holding one that
      //     can no longer create the administrator account. ---
      if (config.callsignLookupEnabled) {
        a.use(
          '/api/callsign',
          createCallsignRouter({
            transport: callsignTransport,
            setupToken: () => bootstrap.token(),
          }),
        );
      }

      // --- The built SPA. THIS IS THE LAST STATEMENT IN THIS CALLBACK
      //     (RESOLUTIONS R16, R25). Real files first, then index.html for any
      //     GET the routers above did not claim, so /browse and /o/:id survive
      //     a hard refresh. Registered after every router, so it can never
      //     shadow /api or /calendar/:token; anything registered after IT would
      //     be shadowed in turn. Without this line GET / reaches Plan 1's
      //     notFoundHandler and the browser is handed a JSON 404 instead of the
      //     application. `webDistRoot` is Plan 3's, from api/webDist.ts — it is
      //     imported, never re-declared (RESOLUTIONS R27). ---
      a.use(createSpaMiddleware(webDistRoot()));
    },
  });

  // The browse projection is derived state. Rebuild it at boot so a restore, a
  // seed import, or a migration can never leave stale filters behind, and drain
  // the change-event queue so a digest is never missing a night the process was
  // down for.
  reindexBrowse(db, now());
  drainChangeEvents(db, now());

  const server = app.listen(config.port, () => {
    console.log(`[server] GrantSpotter listening on port ${config.port}`);
  });

  installShutdown({ server, scheduler: crawlScheduler, db });
}

/**
 * Stop cleanly when the container does, in the order that makes the next boot safe.
 *
 * This process previously registered `SIGTERM` to stop the crawl scheduler and NOTHING ELSE.
 * Registering any handler for SIGTERM replaces Node's default behaviour, which is to terminate;
 * a handler that returns without exiting therefore turns SIGTERM into a no-op. The process stayed
 * alive and listening, `docker stop` waited out its full 10-second grace period on every single
 * deploy and restart before SIGKILL, and SIGKILL is exactly the way to leave a WAL-mode SQLite
 * file mid-write. `kill -9` was needed to stop it by hand.
 *
 * The order below is the point of the function:
 *
 *  1. `server.close()` stops accepting NEW connections and resolves once the open ones finish, so
 *     a request already in flight gets to write its response instead of losing it.
 *  2. `closeIdleConnections()` immediately drops keep-alive sockets that are sitting between
 *     requests. Without it a single browser tab holds `server.close()` open until its socket
 *     times out, which is the whole grace period again for no work.
 *  3. Only then the scheduler stops and the database closes. `db.close()` checkpoints the WAL
 *     back into the main file, which is the difference between a clean restart and a recovery.
 *  4. `process.exit(0)` — a clean stop is a success, and `docker stop` reads the code.
 *
 * The 5-second fallback is for a request that hangs: it fires, says so, and exits non-zero rather
 * than letting the deploy hang. It is `unref`'d so it can never be the reason the process stays up.
 *
 * SIGINT gets the same treatment. Ctrl-C in `npm run dev:server` had the same defect for the same
 * reason, and a shutdown path that only one signal exercises is a shutdown path nobody tests.
 */
function installShutdown(deps: {
  server: Server;
  scheduler: ReturnType<typeof startScheduler>;
  db: ReturnType<typeof openDatabase>;
}): void {
  let stopping = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    // A second signal must not run the teardown twice: closing an already-closed better-sqlite3
    // handle throws, and an exception here would turn a clean stop into a non-zero exit.
    if (stopping) return;
    stopping = true;
    console.log(`[server] ${signal} received — shutting down`);

    const forced = setTimeout(() => {
      console.error('[server] connections did not drain in 5s, exiting anyway');
      process.exit(1);
    }, 5_000);
    forced.unref();

    deps.server.close(() => {
      clearTimeout(forced);
      deps.scheduler.stop();
      deps.db.close();
      console.log('[server] stopped cleanly');
      process.exit(0);
    });
    deps.server.closeIdleConnections();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
