import { defineConfig } from '@playwright/test';
import { BASE_URL, DATA_DIR, E2E_PORT, HEALTH_URL } from './e2e/helpers.js';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
  },
  webServer: {
    // Build the SPA, seed a throwaway database, then run the real server.
    command: 'npm run build && npm run e2e:seed && node packages/server/dist/index.js',
    // NOT `BASE_URL`. Playwright polls this URL and accepts 2xx/3xx/400/401/402/403 as "ready";
    // `/` is Plan 1's JSON 404 until Plan 5 Task 17 mounts the SPA middleware, so pointing the
    // readiness probe at it makes every run end in `Timed out waiting … from config.webServer`
    // with no spec collected. See the note on HEALTH_URL in e2e/helpers.ts.
    url: HEALTH_URL,
    reuseExistingServer: false,
    // A full workspace build (core + server + web, ~9s measured) followed by a corpus seed that
    // normalizes every committed fixture through every source module and projects 703 records'
    // cycles (~40s measured), then the boot itself.
    timeout: 240_000,
    stdout: 'pipe',
    env: {
      PORT: String(E2E_PORT),
      // The server opens `${DATA_DIR}/grantspotter.sqlite` — the exact file
      // e2e/seed.ts just wrote. There is no DB-path env var; DATA_DIR is it.
      DATA_DIR,
      SESSION_SECRET: 'e2e-session-secret-not-a-real-secret',
      CONTACT_URL: 'https://example.com/grantspotter',
      // No nightly scheduler in the e2e process: the manual crawl button and
      // the injected change_events row are the only things that move data.
      CRAWL_ENABLED: 'false',
    },
  },
});
