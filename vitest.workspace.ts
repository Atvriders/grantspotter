import { defineWorkspace } from 'vitest/config';

// `scripts/` is a project like any other. It was left out until 2026-08-03, which made the tests
// for `scripts/profile-corpus.ts` homeless — they had to be smuggled into a core test file in
// another package to run at all. Any directory that holds a `*.test.ts` needs an entry here;
// `packages/server/test/vitestCoverageContract.test.ts` fails by name when one does not.
export default defineWorkspace(['packages/core', 'packages/server', 'packages/web', 'scripts']);
