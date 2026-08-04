import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The same JSX transform the app builds with, so a component test compiles the way the bundle
  // does rather than through a second, subtly different pipeline.
  plugins: [react()],
  test: {
    name: 'web',
    // Components need a DOM to render into; 'node' can't do that.
    environment: 'jsdom',
    // Every test imports what it uses. No ambient `describe`/`it`/`expect`.
    globals: false,
    // jest-dom matchers + an automatic RTL `cleanup()` between tests.
    setupFiles: ['./src/test/setup.ts'],
    // Plans 3-5 put every web test beside the code under `src/`, most of them
    // `.tsx`. With only a `test/**` glob here, `npm test` goes GREEN while
    // running none of the web suite — and every later "expect N tests passing"
    // step becomes a gate that silently checks nothing. Verified on this host
    // with vitest 3.2.7: a `src/**/*.test.tsx` probe is invisible to
    // `test/**/*.test.ts` alone and only appears once both the `src/**` tree
    // and the `.tsx` extension are included.
    //
    // `test/**` was dropped in Plan 3 Task 15 with the tree itself: Plan 1's
    // lone `test/client.test.ts` was folded into `src/api/client.test.ts`, so
    // the glob now points at nothing. An include that matches no file is the
    // config-side half of the same defect — see
    // packages/server/test/vitestCoverageContract.test.ts, which fails when a
    // project matches nothing at all.
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
