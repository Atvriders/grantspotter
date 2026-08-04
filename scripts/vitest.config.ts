import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Same alias as packages/server: `scripts/profile-corpus.ts` pulls in
      // `packages/server/src/normalize/index.ts`, and 74 server modules import
      // `@grantspotter/core` by package name. Without the alias that name resolves through the
      // workspace symlink to `packages/core/dist`, so the scripts suite would silently test the
      // LAST BUILD instead of the working tree — green against stale JavaScript.
      '@grantspotter/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'scripts',
    environment: 'node',
    // `scripts/` is flat today, so `*.test.ts` would be enough — but a flat glob is exactly the
    // hole this project was added to close. The fourth occurrence of that defect in this repo was
    // `scripts/` having no project at all; the previous three were projects whose include named
    // one tree while the tests lived in another. `**` plus both extensions cannot re-open either.
    include: ['**/*.test.{ts,tsx}'],
  },
});
