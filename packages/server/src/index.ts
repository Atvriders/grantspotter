import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { buildUserAgent, ConfigError, loadConfig, type AppConfig } from './config.js';
import { runCrawl, startScheduler } from './crawl/index.js';
import { ensureIngestionSchema } from './db/ingestSchema.js';
import { migrate, openDatabase } from './db/migrate.js';
import { createFetcher } from './fetcher/index.js';

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

  // Nightly, jittered — never hourly. Nothing in this corpus changes faster than weekly, and
  // ~25 small-nonprofit sites should not all be hit at the same second by every deployment of
  // this app. CRAWL_ENABLED=false starts nothing at all.
  console.log(`[crawl] enabled=${String(config.crawlEnabled)} cron="${config.crawlCron}"`);
  const crawlScheduler = startScheduler(
    { cron: config.crawlCron, enabled: config.crawlEnabled },
    () =>
      runCrawl({
        db,
        fetcher: createFetcher({
          userAgent: buildUserAgent(config),
          contactUrl: config.contactUrl,
          dataDir: config.dataDir,
        }),
        nowISO: () => new Date().toISOString(),
      }),
  );
  process.on('SIGTERM', () => crawlScheduler.stop());

  // Plan 3 Task 14 modifies exactly this call to add the `mountRoutes` hook,
  // mounts its own routers inside the callback, and reserves its final
  // position; Plan 4 Task 17 and Plan 5 Task 9 add their routers above that
  // reserved position (RESOLUTIONS R5 + R25). Plan 5 Task 17 then installs
  // a.use(createSpaMiddleware(webDistRoot())) there as the callback's last
  // statement, so the built SPA — not notFoundHandler — answers GET /
  // (RESOLUTIONS R16). Nothing may append routes to `app` afterwards.
  const app = createApp({ db, config });
  app.listen(config.port, () => {
    console.log(`[server] GrantSpotter listening on port ${config.port}`);
  });
}

main();
