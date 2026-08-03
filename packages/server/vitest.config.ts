import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@grantspotter/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'server',
    environment: 'node',
    // BOTH trees. Plan 1 puts its 8 server tests in `test/`, but Plans 2-5 put all 87 of
    // theirs beside the code under `src/`. With only `test/**` here, `npm test` goes GREEN
    // while running none of the server suite — and every later "expect N tests passing"
    // step becomes a gate that silently checks nothing. Verified on this host with
    // vitest 3.2.4: `npx vitest run packages/server/src/fetcher/blocklist.test.ts` against a
    // `test/**`-only include prints "No test files found, exiting with code 1".
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
