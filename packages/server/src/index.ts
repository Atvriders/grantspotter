import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { migrate, openDatabase } from './db/migrate.js';

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

  // The crawl scheduler is added by Plan 2; CRAWL_ENABLED is read here so the
  // operator sees its value at boot.
  console.log(`[crawl] enabled=${String(config.crawlEnabled)} cron="${config.crawlCron}"`);

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
