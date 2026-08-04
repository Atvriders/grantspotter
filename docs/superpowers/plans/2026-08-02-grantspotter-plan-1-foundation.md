# GrantSpotter Plan 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the npm-workspaces skeleton, the pure `@grantspotter/core` domain layer (types, amounts, deadlines, geography, eligibility matcher, content hashing), and the `@grantspotter/server` foundation (SQLite schema + migrations, repositories, argon2id accounts, sessions, roles, and the API skeleton with its frozen JSON error envelope) that Plans 2–5 build on.

**Architecture:** `packages/core` is a pure, I/O-free TypeScript library — no `node:` imports, no network, no filesystem, one runtime dependency (`zod`). It is the executable spec: every domain rule lives there and is unit-tested with no fixtures beyond hand-built objects. `packages/server` owns all I/O: a `better-sqlite3` WAL database driven by plain `.sql` migrations, thin repositories that validate JSON-shaped columns through core's zod schemas on read, and an Express app assembled by a `createApp(deps)` factory so integration tests can build it over a temp database. `packages/web` exists in this plan only as a compiling stub plus the typed API client that encodes the error envelope.

**Tech Stack:** Node v20.11.0 · TypeScript 5.9.3 (strict, `module: NodeNext`, `target: ES2022`) · zod 3 · Vitest 3 · better-sqlite3 12 · Express 4 · `@node-rs/argon2` 2 · React 18 + Vite 6.

**Prerequisite:** none. This is the first plan. Plans 2–5 all import from it.

---

## Global Constraints

- **Node v20.11.0 / npm 10.2.4.** Every shell in every step must start with `export PATH="/path/to/node20/bin:$PATH"`. Verified on this host.
- **No Docker on this host.** Local verification stops at `typecheck + build + test`. The image is Plan 5's problem and is built by GitHub Actions.
- **`packages/core` is pure.** Zero `node:` imports, zero filesystem, zero network, zero `process.*`, and exactly one runtime dependency: `zod`. Task 1 installs a test that proves this and fails the suite if it ever stops being true. Allowed platform globals in core: `Date`, `Math`, `JSON`, `Intl`, `Number`, `String`, `Object`, `Array`, `Map`, `Set`, `RegExp`.
- **Core gets SHA-256 from a vendored pure-TypeScript implementation** at `packages/core/src/sha256.ts`, not from `node:crypto` and not from a package. Rationale in Task 3. The purity allowlist therefore stays at exactly `['zod']` — **it is not amended by this plan**.
- **Import direction is one-way:** `web → core`, `server → core`. `core` imports nothing of ours.
- **CONTRACT names are frozen.** Every type, field, function name, file path, package name, env var, and npm script comes from `docs/superpowers/plans/CONTRACT.md` verbatim. Where this plan needs something the CONTRACT does not define, it is marked **PLAN-LOCAL** in the task text and lives inside `packages/core` or `packages/server`.
- **ESM with explicit extensions.** All packages are `"type": "module"` with `moduleResolution: NodeNext`. Every relative import must carry a `.js` extension even though the source file is `.ts` — `import { parseAmount } from './amount.js'`. This is the single most common way this repo will fail to compile.
- **`SESSION_SECRET` has no default.** The server refuses to start without it, and refuses a value shorter than 32 characters. Same rule as ham-net-assistant's `JWT_SECRET`. `CONTACT_URL` is likewise required (it goes in the crawler User-Agent).
- **Hard blocklist (enforced in Plan 2's fetcher, named here so it is never re-litigated):** `farweb.org` (the Foundation for Amateur Radio's domain was taken over and now 301s to an Indonesian gambling site — Wayback pins the takeover between 2025-10-17 and 2026-02-10, and QCWA/ARRL pages still tell applicants to "apply at the FAR website"), plus `candid.org`, `fconline.foundationcenter.org`, `grantwatch.com`, `grantstation.com`, `instrumentl.com` on licence/ToS grounds.
- **The AI prompt button copy is exactly** `Copy AI Prompt — includes AI-detection avoidance` (Plan 4 renders it; recorded here because it is frozen copy).
- **No real LAN IPs, hostnames, or host paths** in code, fixtures, seed data, or config. Loopback (`127.0.0.1`) and RFC 5737 ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) only.
- **Commits stay local.** Every task ends in `git add` + `git commit`. **No task in this plan runs `git push`.** The single push happens at the very end of Plan 5, after the completeness audit and the debug audit.
- **Conventional commit prefixes:** `feat:`, `fix:`, `test:`, `chore:`, `docs:`.
- **TDD rhythm, no exceptions:** write the failing test → run it and see it fail → write the minimal implementation → run it and see it pass → commit.

### Deviation from CONTRACT §8, recorded deliberately

CONTRACT §8 specifies `npm run typecheck` = `tsc -b --noEmit`. **That command cannot work** and was verified failing on this host: with TypeScript project references, `tsc -b --noEmit` errors with

```
error TS6310: Referenced project '.../packages/core' may not disable emit.
```

This plan therefore keeps the script *name* and *effect* (`npm run typecheck` type-checks every workspace, including test files) but implements it as a single non-composite root type-check project plus the web project:

```
"typecheck": "tsc --noEmit -p tsconfig.json && npm run typecheck -w @grantspotter/web"
```

This was built and run green on this host before the plan was written. Nothing else in CONTRACT §8 changes. `npm run test:e2e` and `npm run verify-sources` are **not** created by this plan — Plan 3 adds `test:e2e` (Playwright) and Plan 2 adds `verify-sources` (RESOLUTIONS R13). Declaring them here would leave scripts pointing at files that do not exist. The two developer-only scripts CONTRACT §8 also lists, `capture-fixture` (Plan 2) and `seed:arrl` (Plan 5), are likewise added by their own plans and are never part of `build`, `test` or CI.

### Domain facts an engineer new to this space needs

- **Amateur ("ham") radio callsign** — e.g. `W1AW`, `K5UTD`, `W8UM`. In the US the digit in the callsign is the *call district* (`W5XYZ` → district 5). Licences come in classes: Technician < General < Extra (plus "no licence").
- **ARRL** — the American Radio Relay League, the US national ham association. Its charitable arm, the **ARRL Foundation**, runs a scholarship catalogue of 111 entries that share **one** application and **one** deadline. Roughly 75% of this app's entire corpus lives on one ARRL page.
- **ARRL Field Organization geography** — the US is divided into **15 Divisions**, each containing several of the **71 Sections**. A Section is usually one state, sometimes part of one (Eastern/Western Pennsylvania), sometimes several (Maryland-DC = MD + DC; the "Pacific" section = HI + AS + GU + MP). Scholarship eligibility is written in this vocabulary ("open to residents of the ARRL Central Division"), so the app ships a Division/Section ↔ state table as data.
- **ARDC** — Amateur Radio Digital Communications, the largest funder in the space (~$3.4–3.8M/yr). Four fixed deadlines a year: Feb 1, Apr 1, Jul 1, Sep 1. Requires all funded output to be open-source/open-access and caps indirect costs at 20%.
- **QCWA** — Quarter Century Wireless Association. Its scholarship is administered through ARRL's application, so its deadline is *inherited* from ARRL's cycle. This is why `DeadlineSource` has an `inherited` variant.
- **Why arrl.org is hostile to change detection:** it serves `Cache-Control: nocache` with **no ETag and no Last-Modified**, and every `<lastmod>` in its sitemap is frozen at 2010. There is no cheap header-based "did this change?" signal, so the app hashes *parsed entries* instead — which is why `hashProgram` exists in core and why it must exclude `lastVerifiedAt`.

---
### Task 1: Workspace scaffold, toolchain, and the core purity gate

The deliverable is a workspace whose `core` package is *provably* pure. The purity test is not an afterthought bolted on later — it is this task's acceptance criterion, because Plans 2–5 will add code to core and the gate has to already be standing.

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.workspace.ts`, `.env.example`
- Create: `packages/core/package.json`, `packages/core/tsconfig.build.json`, `packages/core/vitest.config.ts`, `packages/core/src/index.ts`
- Create: `packages/server/package.json`, `packages/server/tsconfig.build.json`, `packages/server/vitest.config.ts`, `packages/server/src/index.ts`
- Test: `packages/core/test/purity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the workspaces `@grantspotter/core` and `@grantspotter/server`; root scripts `typecheck`, `build`, `test`, `dev`; the purity invariant that every later task must not break.

- [ ] **Step 1: Write the failing test**

  Create `packages/core/test/purity.test.ts`:

  ```ts
  import { readdirSync, readFileSync, statSync } from 'node:fs';
  import { join } from 'node:path';
  import { fileURLToPath } from 'node:url';
  import { describe, expect, it } from 'vitest';

  // This test file is ALLOWED to use node: imports. The purity rule applies to
  // packages/core/src only — the shipped library — not to the tests that police it.
  const CORE_ROOT = fileURLToPath(new URL('..', import.meta.url));
  const SRC_ROOT = join(CORE_ROOT, 'src');

  const ALLOWED_RUNTIME_DEPS = ['zod'];

  function listTsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
      else if (entry.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  // Comments are stripped before scanning so that a doc comment explaining
  // "we deliberately do not use node:crypto here" does not trip the scanner.
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  function importSpecifiers(src: string): string[] {
    const specs: string[] = [];
    const fromRe = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;
    const bareRe = /\bimport\s*['"]([^'"]+)['"]/g;
    for (const re of [fromRe, bareRe]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) specs.push(m[1]);
    }
    return specs;
  }

  describe('packages/core purity', () => {
    it('declares exactly one runtime dependency: zod', () => {
      const pkg = JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      };
      expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(ALLOWED_RUNTIME_DEPS);
      expect(Object.keys(pkg.peerDependencies ?? {})).toEqual([]);
      expect(Object.keys(pkg.optionalDependencies ?? {})).toEqual([]);
    });

    it('imports nothing but zod and relative paths', () => {
      const offenders: string[] = [];
      for (const file of listTsFiles(SRC_ROOT)) {
        const src = stripComments(readFileSync(file, 'utf8'));
        for (const spec of importSpecifiers(src)) {
          const ok = spec.startsWith('.') || ALLOWED_RUNTIME_DEPS.includes(spec);
          if (!ok) offenders.push(`${file}: ${spec}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it('contains no node: imports and no host globals', () => {
      const banned: Array<[RegExp, string]> = [
        [/\bnode:/, 'node: builtin import'],
        [/\bprocess\s*\./, 'process.*'],
        [/\b__dirname\b/, '__dirname'],
        [/\brequire\s*\(/, 'require()'],
        [/\bimport\.meta\b/, 'import.meta'],
        [/\bfetch\s*\(/, 'fetch()'],
        [/\bBuffer\b/, 'Buffer'],
      ];
      const offenders: string[] = [];
      for (const file of listTsFiles(SRC_ROOT)) {
        const src = stripComments(readFileSync(file, 'utf8'));
        for (const [re, label] of banned) {
          if (re.test(src)) offenders.push(`${file}: ${label}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test
  ```

  Expected failure: `npm error Missing script: "test"` (there is no root `package.json` yet). That is the correct red state for a scaffold task.

- [ ] **Step 3: Create the root workspace files**

  `package.json`:

  ```json
  {
    "name": "grantspotter",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "description": "A self-hosted funding desk for collegiate and educational amateur radio.",
    "license": "MIT",
    "workspaces": ["packages/*"],
    "scripts": {
      "typecheck": "tsc --noEmit -p tsconfig.json",
      "build": "npm run build -w @grantspotter/core && npm run build -w @grantspotter/server",
      "test": "vitest run",
      "test:watch": "vitest",
      "dev": "concurrently -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
      "dev:server": "npm run dev -w @grantspotter/server",
      "dev:web": "echo \"web workspace arrives in Task 18\""
    },
    "devDependencies": {
      "@types/node": "20.19.43",
      "concurrently": "10.0.4",
      "typescript": "5.9.3",
      "vitest": "3.2.7"
    },
    "engines": { "node": ">=20.11.0" }
  }
  ```

  `tsconfig.base.json`:

  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "lib": ["ES2022"],
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "strict": true,
      "noImplicitOverride": true,
      "noFallthroughCasesInSwitch": true,
      "noUnusedLocals": true,
      "noUnusedParameters": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "forceConsistentCasingInFileNames": true,
      "declaration": true,
      "declarationMap": true,
      "sourceMap": true,
      "isolatedModules": true
    }
  }
  ```

  `tsconfig.json` — the single non-composite type-check project (see the recorded deviation above; `paths` lets `server` resolve `@grantspotter/core` straight to source so type-checking never needs a prior build):

  ```json
  {
    "extends": "./tsconfig.base.json",
    "compilerOptions": {
      "noEmit": true,
      "types": ["node"],
      "baseUrl": ".",
      "paths": { "@grantspotter/core": ["packages/core/src/index.ts"] }
    },
    "include": [
      "packages/core/src/**/*.ts",
      "packages/core/test/**/*.ts",
      "packages/server/src/**/*.ts",
      "packages/server/test/**/*.ts",
      "vitest.workspace.ts",
      "packages/*/vitest.config.ts"
    ]
  }
  ```

  `vitest.workspace.ts` (the filename is fixed by CONTRACT §2; Vitest 3 prints a deprecation notice for workspace files, which is expected and harmless):

  ```ts
  import { defineWorkspace } from 'vitest/config';

  export default defineWorkspace(['packages/core', 'packages/server']);
  ```

  `.env.example` (Plan 5 extends this file; every variable here is from CONTRACT §7):

  ```bash
  # Host port published by docker-compose. Container listens on PORT.
  HOST_PORT=3030
  PORT=3030

  # REQUIRED. No default. The server refuses to start without it.
  # Generate with: openssl rand -hex 32
  SESSION_SECRET=

  # REQUIRED. No default. Goes in the crawler User-Agent so the ~25 small
  # nonprofits we poll can identify and contact the operator.
  CONTACT_URL=https://example.org/grantspotter

  # SQLite database, snapshots and fixture cache live here.
  DATA_DIR=/data

  CRAWL_ENABLED=true
  CRAWL_CRON=17 3 * * *

  # Optional. With no key everything still works; the crawler simply skips
  # LLM-assisted parsing of messy pages. Never on the read path.
  ANTHROPIC_API_KEY=

  # Optional. Free Login.gov key for api.simpler.grants.gov. Never a hard dependency.
  SIMPLER_GRANTS_API_KEY=
  ```

- [ ] **Step 4: Create the core package**

  `packages/core/package.json` — note `dependencies` has exactly one key, which the purity test asserts:

  ```json
  {
    "name": "@grantspotter/core",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": {
      ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
    },
    "files": ["dist"],
    "scripts": {
      "build": "tsc -p tsconfig.build.json"
    },
    "dependencies": {
      "zod": "3.25.76"
    }
  }
  ```

  `packages/core/tsconfig.build.json` — `"types": []` keeps `@types/node` out of core's compilation entirely, so a stray `process.env` fails to compile rather than merely failing the purity test:

  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": [] },
    "include": ["src/**/*.ts"]
  }
  ```

  `packages/core/vitest.config.ts`:

  ```ts
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: { name: 'core', environment: 'node', include: ['test/**/*.test.ts'] },
  });
  ```

  `packages/core/src/index.ts` — the barrel. Later tasks append to it:

  ```ts
  export const CORE_VERSION = '0.1.0';
  ```

- [ ] **Step 5: Create the server package**

  `packages/server/package.json`:

  ```json
  {
    "name": "@grantspotter/server",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "main": "./dist/index.js",
    "scripts": {
      "build": "tsc -p tsconfig.build.json && node ./scripts/copy-sql.mjs",
      "dev": "tsx watch src/index.ts",
      "start": "node dist/index.js"
    },
    "dependencies": {
      "@grantspotter/core": "*",
      "@node-rs/argon2": "2.0.2",
      "better-sqlite3": "12.11.1",
      "cookie-parser": "1.4.7",
      "express": "4.22.2",
      "zod": "3.25.76"
    },
    "devDependencies": {
      "@types/better-sqlite3": "7.6.13",
      "@types/cookie-parser": "1.4.10",
      "@types/express": "4.17.25",
      "@types/supertest": "7.2.1",
      "supertest": "7.2.2",
      "tsx": "4.23.5"
    }
  }
  ```

  `packages/server/tsconfig.build.json`:

  ```json
  {
    "extends": "../../tsconfig.base.json",
    "compilerOptions": { "rootDir": "src", "outDir": "dist", "types": ["node"] },
    "include": ["src/**/*.ts"],
    "exclude": ["src/**/*.test.ts", "src/test/**"]
  }
  ```

  **The `exclude` is load-bearing, not tidiness.** Plans 2-5 put their tests beside the code
  under `src/`, and several import upward out of `rootDir` — Plan 3's
  `src/test/testDb.ts` imports `../../test/helpers/tempDb.js`, and ~15 of Plan 2's
  `src/sources/*.test.ts` import `../../test/fixtures.js`. Without the exclude those files
  join the emitting program and `tsc` fails with
  `TS6059: File '.../test/helpers/tempDb.ts' is not under 'rootDir' '.../src'`, so
  `npm run build` breaks from Plan 2 onward, `packages/server/dist/index.js` is never emitted,
  and Playwright's `webServer` (`npm run build && … node packages/server/dist/index.js`) never
  starts — failing every e2e spec before its first assertion. The root `tsconfig.json` used by
  `npm run typecheck` is `noEmit` with no `rootDir`, so it stays green and hides this. Nothing
  in the emitted `dist` imports either tree: `src/test/fixtures/programs.ts` is consumed only
  by `*.test.ts` and by `e2e/seed.ts`, which runs under `tsx` outside this project.

  `packages/server/vitest.config.ts` — **the alias is required, not cosmetic.** Without it, any server test that imports `@grantspotter/core` fails with `Failed to resolve entry for package "@grantspotter/core"` whenever `packages/core/dist` is absent, which is the normal state during development. Verified on this host:

  ```ts
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
  ```

  `packages/server/src/index.ts` — a real placeholder entrypoint that Task 17 replaces:

  ```ts
  export const SERVER_VERSION = '0.1.0';
  ```

  `packages/server/scripts/copy-sql.mjs` — `tsc` does not copy `.sql` files, and `migrate.ts` (Task 13) reads them from `dist/db/migrations` at runtime:

  ```js
  import { cpSync, existsSync, mkdirSync } from 'node:fs';
  import { dirname, join } from 'node:path';
  import { fileURLToPath } from 'node:url';

  const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
  const from = join(root, 'src', 'db', 'migrations');
  const to = join(root, 'dist', 'db', 'migrations');

  if (!existsSync(from)) {
    console.log('[copy-sql] no migrations directory yet, nothing to copy');
    process.exit(0);
  }
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`[copy-sql] copied ${from} -> ${to}`);
  ```

- [ ] **Step 6: Install dependencies**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm install
  ```

  Expect roughly `added N packages`. `better-sqlite3` compiles from source via `node-gyp`; `python3`, `make` and `g++` are all present on this host and the compile was verified to succeed. `@node-rs/argon2` installs a prebuilt native binary (verified: it produced a `$argon2id$v=19$m=19456,t=2,p=1$…` hash and verified it).

- [ ] **Step 7: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck && npm run build
  ```

  Expect `Test Files 1 passed (1)` / `Tests 3 passed (3)`, then a clean typecheck, then `packages/core/dist/index.js` and `packages/server/dist/index.js` on disk.

- [ ] **Step 8: Commit**

  ```bash
  cd /path/to/grantspotter
  git add package.json package-lock.json tsconfig.base.json tsconfig.json vitest.workspace.ts .env.example packages
  git commit -m "chore: scaffold npm workspaces, toolchain, and the core purity gate"
  ```

---
### Task 2: Domain types, zod mirrors, and the shared test fixtures

`types.ts` is a **verbatim transcription of CONTRACT §3**. Do not improve it, rename anything, reorder the union members, or add fields. Plans 2–5 import these exact names. `schema.ts` mirrors them in zod because CONTRACT §6 stores `constraints.spec`, `programs.amount` and `programs.obligations` as TEXT-containing-JSON and validates them through these schemas on read.

**Files:**
- Create: `packages/core/src/types.ts`, `packages/core/src/schema.ts`
- Create: `packages/core/test/fixtures.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/schema.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: every type in CONTRACT §3; plus the zod schemas `geoSpecSchema`, `constraintSpecSchema`, `constraintSchema`, `amountSpecSchema`, `deadlineSpecSchema`, `cycleSchema`, `trustFieldsSchema`, `obligationsSchema`, `aiPolicySchema`, `funderSchema`, `programSchema`, `studentProfileSchema`, `orgProfileSchema`, `profileSchema`; plus the test helpers `makeFunder`, `makeConstraint`, `makeProgram`, `makeStudent`, `makeOrg`.

- [ ] **Step 1: Write the failing test**

  Create `packages/core/test/schema.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import {
    constraintSpecSchema,
    profileSchema,
    programSchema,
  } from '../src/schema.js';
  import { makeConstraint, makeOrg, makeProgram, makeStudent } from './fixtures.js';

  describe('zod mirrors of CONTRACT §3', () => {
    it('accepts a fully populated Program', () => {
      const program = makeProgram();
      const parsed = programSchema.parse(program);
      expect(parsed.id).toBe(program.id);
      expect(parsed.constraints).toHaveLength(program.constraints.length);
    });

    it('round-trips a Program through JSON without loss', () => {
      const program = makeProgram();
      const reparsed = programSchema.parse(JSON.parse(JSON.stringify(program)));
      expect(reparsed).toEqual(program);
    });

    it('rejects a Program with an unknown opportunity class', () => {
      const bad = { ...makeProgram(), klass: 'ham_lottery' };
      expect(() => programSchema.parse(bad)).toThrow();
    });

    it('rejects a Constraint whose spec axis is not in the union', () => {
      expect(() => constraintSpecSchema.parse({ axis: 'vibes', note: 'nope' })).toThrow();
    });

    it('accepts every one of the 13 constraint axes', () => {
      const specs = [
        { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 12, foreignLicenseOK: false },
        { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
        { axis: 'field_of_study', fields: ['Any'], excludedFields: ['Liberal Arts'] },
        {
          axis: 'institution',
          degreeLevels: ['BACH', 'GRAD'],
          tradeSchoolOK: false,
          partTimeOK: true,
          accreditationRequired: true,
        },
        { axis: 'gpa', min: 3, classRankTopPct: 10 },
        { axis: 'arrl_membership', required: true, minYears: 1 },
        { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 3 },
        { axis: 'citizenship', allowed: ['US_CITIZEN'], withinMonthsOfCitizenship: 3 },
        { axis: 'age_stage', ageMin: 17, ageMax: 25, asOf: '06-01', stages: ['UNDERGRAD'] },
        {
          axis: 'ham_activity',
          activityKinds: ['club_member', 'field_day'],
          cwProficiencyWpmMin: 15,
          proofRequired: true,
        },
        { axis: 'financial_need', weighted: true },
        { axis: 'gender', allowed: ['female'] },
        { axis: 'other', note: 'preference to a student ham from a ham family' },
      ];
      for (const spec of specs) {
        expect(() => constraintSpecSchema.parse(spec)).not.toThrow();
      }
      expect(specs).toHaveLength(13);
    });

    it('accepts both profile shapes', () => {
      expect(profileSchema.parse(makeStudent()).kind).toBe('student');
      expect(profileSchema.parse(makeOrg()).kind).toBe('organization');
    });

    it('builds constraints with rawText always populated', () => {
      const c = makeConstraint({ axis: 'gpa', min: 2.5 }, { hard: false, fallbackRank: 1 });
      expect(c.rawText.length).toBeGreaterThan(0);
      expect(c.hard).toBe(false);
      expect(c.fallbackRank).toBe(1);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test
  ```

  Expected failure: `Failed to resolve import "../src/schema.js"` — `packages/core/src/schema.ts` does not exist yet.

- [ ] **Step 3: Write `packages/core/src/types.ts`**

  Transcribe CONTRACT §3 exactly:

  ```ts
  // ---------- enums ----------
  export type LicenseClass = 'NONE' | 'TECH' | 'GENERAL' | 'EXTRA';
  export type DegreeLevel = 'CERT' | 'ASSOC' | 'BACH' | 'GRAD';
  export type Stage = 'HS_SENIOR' | 'UNDERGRAD' | 'GRAD' | 'VETERAN' | 'RETRAINING_ADULT';
  export type Citizenship = 'US_CITIZEN' | 'US_RESIDENT' | 'ANY';
  export type ActivityKind =
    | 'club_member'
    | 'ares_races_skywarn'
    | 'teaching'
    | 'on_air'
    | 'field_day'
    | 'contesting'
    | 'public_service';
  export type RecommenderType =
    | 'none'
    | 'arrl_affiliated_club_officer'
    | 'sponsor_org_member'
    | 'teacher'
    | 'any';

  export type ApplicantEntity =
    | 'individual'
    | 'club_unincorporated'
    | 'club_501c3'
    | 'club_via_fiscal_sponsor'
    | 'school_lea'
    | 'university'
    | 'university_dept'
    | 'ieee_student_branch_chapter'
    | 'teacher'
    | 'nominated_by_institution';

  export type Instrument =
    | 'cash_range'
    | 'cash_fixed'
    | 'cash_tiered_blocks'
    | 'in_kind_equipment'
    | 'in_kind_service'
    | 'discounted_purchase'
    | 'per_member_rebate'
    | 'tuition_coverage'
    | 'unknown';

  export type DeadlineKind =
    | 'n_fixed_dates'
    | 'n_fixed_windows'
    | 'annual_window'
    | 'rolling'
    | 'quarterly_rewritten'
    | 'ad_hoc'
    | 'inherited'
    | 'unpublished'
    | 'no_application_exists'
    | 'dormant';

  export type ApplyVia =
    | 'page_form'
    | 'external_spa_portal'
    | 'jotform_year_keyed'
    | 'self_hosted_portal'
    | 'email_pdf_packet'
    | 'contact_person'
    | 'none';

  export type ProgramStatus =
    | 'open'
    | 'closed'
    | 'dormant'
    | 'discontinued'
    | 'contact_only'
    | 'no_application'
    | 'unknown';

  export type AiStance =
    | 'permitted'
    | 'permitted_with_disclosure'
    | 'discouraged'
    | 'prohibited'
    | 'unaddressed';

  export type VerificationMethod = 'live_fetch' | 'api' | 'manual_curation' | 'seed_import';

  export type OpportunityClass =
    | 'ham_grant'
    | 'ham_scholarship'
    | 'adjacent_stem'
    | 'equipment_in_kind';

  export type ConstraintAxis =
    | 'license'
    | 'geography'
    | 'field_of_study'
    | 'institution'
    | 'gpa'
    | 'arrl_membership'
    | 'recommendation'
    | 'citizenship'
    | 'age_stage'
    | 'ham_activity'
    | 'financial_need'
    | 'gender'
    | 'other';

  // ---------- geography ----------
  export interface GeoSpec {
    type: 'any' | 'state' | 'arrl_division' | 'arrl_section' | 'county' | 'radius' | 'call_district';
    values: string[];
    centerLat?: number;
    centerLon?: number;
    radiusMiles?: number;
    centerLabel?: string;
  }

  // ---------- constraints ----------
  export type ConstraintSpec =
    | { axis: 'license'; licenseMin: LicenseClass; heldMonthsMin?: number; foreignLicenseOK?: boolean }
    | { axis: 'geography'; geo: GeoSpec }
    | { axis: 'field_of_study'; fields: string[]; excludedFields: string[] }
    | {
        axis: 'institution';
        degreeLevels: DegreeLevel[];
        tradeSchoolOK: boolean;
        partTimeOK: boolean;
        accreditationRequired: boolean;
      }
    | { axis: 'gpa'; min?: number; classRankTopPct?: number }
    | { axis: 'arrl_membership'; required: boolean; minYears: number }
    | { axis: 'recommendation'; recommenderType: RecommenderType; count: number }
    | { axis: 'citizenship'; allowed: Citizenship[]; withinMonthsOfCitizenship?: number }
    | { axis: 'age_stage'; ageMin?: number; ageMax?: number; asOf?: string; stages: Stage[] }
    | {
        axis: 'ham_activity';
        activityKinds: ActivityKind[];
        cwProficiencyWpmMin?: number;
        proofRequired: boolean;
      }
    | { axis: 'financial_need'; weighted: true }
    | { axis: 'gender'; allowed: Array<'female' | 'male' | 'any'> }
    | { axis: 'other'; note: string };

  export interface Constraint {
    id: string;
    hard: boolean;
    fallbackRank: number;
    rawText: string;
    spec: ConstraintSpec;
  }

  // ---------- money ----------
  export interface AwardTier {
    count: number;
    amount: number;
  }

  export interface AmountSpec {
    instrument: Instrument;
    amountMin?: number;
    amountMax?: number;
    tiers?: AwardTier[];
    amountRaw: string;
    awardCountRaw: string;
  }

  // ---------- deadlines ----------
  export type DeadlineSource = { kind: 'self' } | { kind: 'inherited'; fromProgramId: string };

  export interface DeadlineSpec {
    kind: DeadlineKind;
    source: DeadlineSource;
    note: string;
  }

  export interface Cycle {
    id: string;
    programId: string;
    opensAt?: string;
    closesAt?: string;
    timezone: string;
    label: string;
    isEstimated: boolean;
  }

  // ---------- trust ----------
  export interface DisputedClaim {
    claim: string;
    sourceUrl: string;
  }

  export interface Disputed {
    claims: DisputedClaim[];
    note: string;
  }

  export interface TrustFields {
    status: ProgramStatus;
    sourceUrl: string;
    lastVerifiedAt: string;
    verificationMethod: VerificationMethod;
    contentHash: string;
    disputed?: Disputed;
    staleMirrorWarning?: string;
  }

  export interface AiPolicy {
    stance: AiStance;
    quote?: string;
    url?: string;
  }

  export interface Obligations {
    licenseObligation?: string;
    indirectCostCapPct?: number;
    costShareRequired: boolean;
    coFunderPreference: boolean;
    sustainmentObligation?: string;
    reportingObligation?: string;
  }

  // ---------- the record ----------
  export interface Funder {
    id: string;
    name: string;
    homepage: string;
    ein?: string;
    note?: string;
  }

  export interface Program {
    id: string;
    funderId: string;
    name: string;
    klass: OpportunityClass;
    summary: string;
    applicantEntities: ApplicantEntity[];
    amount: AmountSpec;
    deadline: DeadlineSpec;
    applyVia: ApplyVia;
    applyUrl?: string;
    applyContact?: string;
    constraints: Constraint[];
    fundingRestrictions: string[];
    obligations: Obligations;
    aiPolicy: AiPolicy;
    trust: TrustFields;
    rawOtherText: string;
    tags: string[];
  }

  // ---------- profiles ----------
  export interface StudentProfile {
    kind: 'student';
    callsign?: string;
    licenseClass?: LicenseClass;
    licensedSince?: string;
    state?: string;
    county?: string;
    lat?: number;
    lon?: number;
    callDistrict?: string;
    fieldOfStudy?: string;
    degreeLevel?: DegreeLevel;
    institution?: string;
    accredited?: boolean;
    partTime?: boolean;
    gpa?: number;
    classRankTopPct?: number;
    arrlMemberSince?: string;
    citizenship?: Citizenship;
    birthDate?: string;
    stage?: Stage;
    activityKinds?: ActivityKind[];
    cwWpm?: number;
    financialNeed?: boolean;
    gender?: 'female' | 'male' | 'other' | 'prefer_not_to_say';
  }

  export interface OrgProfile {
    kind: 'organization';
    entity: ApplicantEntity;
    orgName?: string;
    callsign?: string;
    state?: string;
    lat?: number;
    lon?: number;
    ein?: string;
    is501c3?: boolean;
    hasFiscalSponsor?: boolean;
    arrlAffiliated?: boolean;
    memberCount?: number;
    institutionName?: string;
  }

  export type Profile = StudentProfile | OrgProfile;

  // ---------- matcher ----------
  export type Verdict =
    | { kind: 'eligible' }
    | { kind: 'eligible_preferred'; rank: number; met: string[] }
    | { kind: 'ineligible'; reasons: Constraint[] }
    | { kind: 'unknown'; missingProfileFields: string[] };

  // ---------- ingestion ----------
  export type SourceTier = 'A' | 'B' | 'C' | 'D';

  export interface FetchRequest {
    url: string;
    method: 'GET' | 'POST';
    body?: unknown;
    accept: 'html' | 'json' | 'xml' | 'binary';
  }

  export interface FetchedPayload {
    url: string;
    status: number;
    contentType: string;
    body: string;
    fetchedAt: string;
  }

  export interface RawOpportunity {
    sourceId: string;
    externalKey: string;
    name: string;
    rawFields: Record<string, string>;
    sourceUrl: string;
    rawText: string;
  }

  export interface SourceModule {
    id: string;
    funderId: string;
    label: string;
    tier: SourceTier;
    klass: OpportunityClass;
    requests: FetchRequest[] | (() => Promise<FetchRequest[]>);
    parse(payloads: FetchedPayload[]): RawOpportunity[];
    expectedMinRecords: number;
    notes?: string;
  }

  // ---------- change detection ----------
  export type ChangeKind =
    | 'new'
    | 'deadline_changed'
    | 'amount_changed'
    | 'eligibility_changed'
    | 'status_changed'
    | 'vanished'
    | 'parse_yield_dropped';

  export interface ChangeEvent {
    id: string;
    sourceId: string;
    programId?: string;
    kind: ChangeKind;
    before?: unknown;
    after?: unknown;
    detectedAt: string;
    fieldPath?: string;
  }

  export type ReviewDecision = 'pending' | 'approved' | 'rejected' | 'edited';

  export interface ReviewItem {
    id: string;
    changeEventId: string;
    candidate: Program;
    decision: ReviewDecision;
    decidedBy?: string;
    decidedAt?: string;
    confidence: number;
    rejectKey?: string;
  }
  ```

- [ ] **Step 4: Write `packages/core/src/schema.ts`**

  ```ts
  import { z } from 'zod';
  import type { Constraint, Cycle, Funder, Profile, Program } from './types.js';

  export const licenseClassSchema = z.enum(['NONE', 'TECH', 'GENERAL', 'EXTRA']);
  export const degreeLevelSchema = z.enum(['CERT', 'ASSOC', 'BACH', 'GRAD']);
  export const stageSchema = z.enum([
    'HS_SENIOR',
    'UNDERGRAD',
    'GRAD',
    'VETERAN',
    'RETRAINING_ADULT',
  ]);
  export const citizenshipSchema = z.enum(['US_CITIZEN', 'US_RESIDENT', 'ANY']);
  export const activityKindSchema = z.enum([
    'club_member',
    'ares_races_skywarn',
    'teaching',
    'on_air',
    'field_day',
    'contesting',
    'public_service',
  ]);
  export const recommenderTypeSchema = z.enum([
    'none',
    'arrl_affiliated_club_officer',
    'sponsor_org_member',
    'teacher',
    'any',
  ]);
  export const applicantEntitySchema = z.enum([
    'individual',
    'club_unincorporated',
    'club_501c3',
    'club_via_fiscal_sponsor',
    'school_lea',
    'university',
    'university_dept',
    'ieee_student_branch_chapter',
    'teacher',
    'nominated_by_institution',
  ]);
  export const instrumentSchema = z.enum([
    'cash_range',
    'cash_fixed',
    'cash_tiered_blocks',
    'in_kind_equipment',
    'in_kind_service',
    'discounted_purchase',
    'per_member_rebate',
    'tuition_coverage',
    'unknown',
  ]);
  export const deadlineKindSchema = z.enum([
    'n_fixed_dates',
    'n_fixed_windows',
    'annual_window',
    'rolling',
    'quarterly_rewritten',
    'ad_hoc',
    'inherited',
    'unpublished',
    'no_application_exists',
    'dormant',
  ]);
  export const applyViaSchema = z.enum([
    'page_form',
    'external_spa_portal',
    'jotform_year_keyed',
    'self_hosted_portal',
    'email_pdf_packet',
    'contact_person',
    'none',
  ]);
  export const programStatusSchema = z.enum([
    'open',
    'closed',
    'dormant',
    'discontinued',
    'contact_only',
    'no_application',
    'unknown',
  ]);
  export const aiStanceSchema = z.enum([
    'permitted',
    'permitted_with_disclosure',
    'discouraged',
    'prohibited',
    'unaddressed',
  ]);
  export const verificationMethodSchema = z.enum([
    'live_fetch',
    'api',
    'manual_curation',
    'seed_import',
  ]);
  export const opportunityClassSchema = z.enum([
    'ham_grant',
    'ham_scholarship',
    'adjacent_stem',
    'equipment_in_kind',
  ]);
  export const constraintAxisSchema = z.enum([
    'license',
    'geography',
    'field_of_study',
    'institution',
    'gpa',
    'arrl_membership',
    'recommendation',
    'citizenship',
    'age_stage',
    'ham_activity',
    'financial_need',
    'gender',
    'other',
  ]);

  export const geoSpecSchema = z.object({
    type: z.enum([
      'any',
      'state',
      'arrl_division',
      'arrl_section',
      'county',
      'radius',
      'call_district',
    ]),
    values: z.array(z.string()),
    centerLat: z.number().optional(),
    centerLon: z.number().optional(),
    radiusMiles: z.number().optional(),
    centerLabel: z.string().optional(),
  });

  export const constraintSpecSchema = z.discriminatedUnion('axis', [
    z.object({
      axis: z.literal('license'),
      licenseMin: licenseClassSchema,
      heldMonthsMin: z.number().optional(),
      foreignLicenseOK: z.boolean().optional(),
    }),
    z.object({ axis: z.literal('geography'), geo: geoSpecSchema }),
    z.object({
      axis: z.literal('field_of_study'),
      fields: z.array(z.string()),
      excludedFields: z.array(z.string()),
    }),
    z.object({
      axis: z.literal('institution'),
      degreeLevels: z.array(degreeLevelSchema),
      tradeSchoolOK: z.boolean(),
      partTimeOK: z.boolean(),
      accreditationRequired: z.boolean(),
    }),
    z.object({
      axis: z.literal('gpa'),
      min: z.number().optional(),
      classRankTopPct: z.number().optional(),
    }),
    z.object({
      axis: z.literal('arrl_membership'),
      required: z.boolean(),
      minYears: z.number(),
    }),
    z.object({
      axis: z.literal('recommendation'),
      recommenderType: recommenderTypeSchema,
      count: z.number(),
    }),
    z.object({
      axis: z.literal('citizenship'),
      allowed: z.array(citizenshipSchema),
      withinMonthsOfCitizenship: z.number().optional(),
    }),
    z.object({
      axis: z.literal('age_stage'),
      ageMin: z.number().optional(),
      ageMax: z.number().optional(),
      asOf: z.string().optional(),
      stages: z.array(stageSchema),
    }),
    z.object({
      axis: z.literal('ham_activity'),
      activityKinds: z.array(activityKindSchema),
      cwProficiencyWpmMin: z.number().optional(),
      proofRequired: z.boolean(),
    }),
    z.object({ axis: z.literal('financial_need'), weighted: z.literal(true) }),
    z.object({
      axis: z.literal('gender'),
      allowed: z.array(z.enum(['female', 'male', 'any'])),
    }),
    z.object({ axis: z.literal('other'), note: z.string() }),
  ]);

  export const constraintSchema = z.object({
    id: z.string(),
    hard: z.boolean(),
    fallbackRank: z.number(),
    rawText: z.string(),
    spec: constraintSpecSchema,
  });

  export const awardTierSchema = z.object({ count: z.number(), amount: z.number() });

  export const amountSpecSchema = z.object({
    instrument: instrumentSchema,
    amountMin: z.number().optional(),
    amountMax: z.number().optional(),
    tiers: z.array(awardTierSchema).optional(),
    amountRaw: z.string(),
    awardCountRaw: z.string(),
  });

  export const deadlineSourceSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('self') }),
    z.object({ kind: z.literal('inherited'), fromProgramId: z.string() }),
  ]);

  export const deadlineSpecSchema = z.object({
    kind: deadlineKindSchema,
    source: deadlineSourceSchema,
    note: z.string(),
  });

  export const cycleSchema = z.object({
    id: z.string(),
    programId: z.string(),
    opensAt: z.string().optional(),
    closesAt: z.string().optional(),
    timezone: z.string(),
    label: z.string(),
    isEstimated: z.boolean(),
  });

  export const disputedClaimSchema = z.object({ claim: z.string(), sourceUrl: z.string() });

  export const disputedSchema = z.object({
    claims: z.array(disputedClaimSchema),
    note: z.string(),
  });

  export const trustFieldsSchema = z.object({
    status: programStatusSchema,
    sourceUrl: z.string(),
    lastVerifiedAt: z.string(),
    verificationMethod: verificationMethodSchema,
    contentHash: z.string(),
    disputed: disputedSchema.optional(),
    staleMirrorWarning: z.string().optional(),
  });

  export const aiPolicySchema = z.object({
    stance: aiStanceSchema,
    quote: z.string().optional(),
    url: z.string().optional(),
  });

  export const obligationsSchema = z.object({
    licenseObligation: z.string().optional(),
    indirectCostCapPct: z.number().optional(),
    costShareRequired: z.boolean(),
    coFunderPreference: z.boolean(),
    sustainmentObligation: z.string().optional(),
    reportingObligation: z.string().optional(),
  });

  export const funderSchema = z.object({
    id: z.string(),
    name: z.string(),
    homepage: z.string(),
    ein: z.string().optional(),
    note: z.string().optional(),
  });

  export const programSchema = z.object({
    id: z.string(),
    funderId: z.string(),
    name: z.string(),
    klass: opportunityClassSchema,
    summary: z.string(),
    applicantEntities: z.array(applicantEntitySchema),
    amount: amountSpecSchema,
    deadline: deadlineSpecSchema,
    applyVia: applyViaSchema,
    applyUrl: z.string().optional(),
    applyContact: z.string().optional(),
    constraints: z.array(constraintSchema),
    fundingRestrictions: z.array(z.string()),
    obligations: obligationsSchema,
    aiPolicy: aiPolicySchema,
    trust: trustFieldsSchema,
    rawOtherText: z.string(),
    tags: z.array(z.string()),
  });

  export const studentProfileSchema = z.object({
    kind: z.literal('student'),
    callsign: z.string().optional(),
    licenseClass: licenseClassSchema.optional(),
    licensedSince: z.string().optional(),
    state: z.string().optional(),
    county: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    callDistrict: z.string().optional(),
    fieldOfStudy: z.string().optional(),
    degreeLevel: degreeLevelSchema.optional(),
    institution: z.string().optional(),
    accredited: z.boolean().optional(),
    partTime: z.boolean().optional(),
    gpa: z.number().optional(),
    classRankTopPct: z.number().optional(),
    arrlMemberSince: z.string().optional(),
    citizenship: citizenshipSchema.optional(),
    birthDate: z.string().optional(),
    stage: stageSchema.optional(),
    activityKinds: z.array(activityKindSchema).optional(),
    cwWpm: z.number().optional(),
    financialNeed: z.boolean().optional(),
    gender: z.enum(['female', 'male', 'other', 'prefer_not_to_say']).optional(),
  });

  export const orgProfileSchema = z.object({
    kind: z.literal('organization'),
    entity: applicantEntitySchema,
    orgName: z.string().optional(),
    callsign: z.string().optional(),
    state: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    ein: z.string().optional(),
    is501c3: z.boolean().optional(),
    hasFiscalSponsor: z.boolean().optional(),
    arrlAffiliated: z.boolean().optional(),
    memberCount: z.number().optional(),
    institutionName: z.string().optional(),
  });

  export const profileSchema = z.discriminatedUnion('kind', [
    studentProfileSchema,
    orgProfileSchema,
  ]);

  // Compile-time drift guards. If types.ts and schema.ts ever disagree, these
  // stop compiling. Bidirectional assignability is checked, not exact identity,
  // because zod's inferred optionals are structurally equivalent but not identical.
  const _inferredProgramIsProgram: Program = null as unknown as z.infer<typeof programSchema>;
  const _programIsInferredProgram: z.infer<typeof programSchema> = null as unknown as Program;
  const _inferredConstraintIsConstraint: Constraint =
    null as unknown as z.infer<typeof constraintSchema>;
  const _constraintIsInferredConstraint: z.infer<typeof constraintSchema> =
    null as unknown as Constraint;
  const _inferredProfileIsProfile: Profile = null as unknown as z.infer<typeof profileSchema>;
  const _profileIsInferredProfile: z.infer<typeof profileSchema> = null as unknown as Profile;
  const _inferredCycleIsCycle: Cycle = null as unknown as z.infer<typeof cycleSchema>;
  const _cycleIsInferredCycle: z.infer<typeof cycleSchema> = null as unknown as Cycle;
  const _inferredFunderIsFunder: Funder = null as unknown as z.infer<typeof funderSchema>;
  const _funderIsInferredFunder: z.infer<typeof funderSchema> = null as unknown as Funder;
  void _inferredProgramIsProgram;
  void _programIsInferredProgram;
  void _inferredConstraintIsConstraint;
  void _constraintIsInferredConstraint;
  void _inferredProfileIsProfile;
  void _profileIsInferredProfile;
  void _inferredCycleIsCycle;
  void _cycleIsInferredCycle;
  void _inferredFunderIsFunder;
  void _funderIsInferredFunder;
  ```

- [ ] **Step 5: Write `packages/core/test/fixtures.ts`**

  Every later core test builds on these. Defaults are modelled on a real ARRL Foundation catalogue entry so the fixtures exercise realistic shapes rather than empty ones.

  ```ts
  import type {
    Constraint,
    ConstraintSpec,
    Funder,
    OrgProfile,
    Program,
    StudentProfile,
  } from '../src/types.js';

  export function makeFunder(over: Partial<Funder> = {}): Funder {
    return {
      id: 'arrl-foundation',
      name: 'ARRL Foundation',
      homepage: 'https://www.arrl.org/arrl-foundation',
      ...over,
    };
  }

  let constraintSeq = 0;

  export function makeConstraint(
    spec: ConstraintSpec,
    over: Partial<Omit<Constraint, 'spec'>> = {},
  ): Constraint {
    constraintSeq += 1;
    return {
      id: `c${constraintSeq}`,
      hard: true,
      fallbackRank: 0,
      rawText: `constraint on ${spec.axis}`,
      spec,
      ...over,
    };
  }

  export function makeProgram(over: Partial<Program> = {}): Program {
    return {
      id: 'arrl-foundation-scholarships',
      funderId: 'arrl-foundation',
      name: 'ARRL Foundation Scholarship Program',
      klass: 'ham_scholarship',
      summary:
        'A single application across a catalogue of 111 named scholarship entries awarding 170+ scholarships to licensed students in higher education.',
      applicantEntities: ['individual'],
      amount: {
        instrument: 'cash_range',
        amountMin: 500,
        amountMax: 25000,
        amountRaw: '$500-$25,000',
        awardCountRaw: '170+',
      },
      deadline: {
        kind: 'annual_window',
        source: { kind: 'self' },
        note: 'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | Opens about Oct 30 and closes Dec 30 at 12:00 PM Eastern. Moved from Jan 31 — never hardcode the old date.',
      },
      applyVia: 'external_spa_portal',
      applyUrl: 'https://www.arrl.org/scholarship-program',
      constraints: [],
      fundingRestrictions: [],
      obligations: { costShareRequired: false, coFunderPreference: false },
      aiPolicy: { stance: 'unaddressed' },
      trust: {
        status: 'open',
        sourceUrl: 'https://www.arrl.org/scholarship-descriptions',
        lastVerifiedAt: '2026-08-02T00:00:00.000Z',
        verificationMethod: 'manual_curation',
        contentHash: '',
      },
      rawOtherText: '',
      tags: ['arrl', 'scholarship'],
      ...over,
    };
  }

  export function makeStudent(over: Partial<StudentProfile> = {}): StudentProfile {
    return { kind: 'student', ...over };
  }

  export function makeOrg(over: Partial<OrgProfile> = {}): OrgProfile {
    return { kind: 'organization', entity: 'club_501c3', ...over };
  }
  ```

- [ ] **Step 6: Extend the barrel**

  Replace `packages/core/src/index.ts` with:

  ```ts
  export const CORE_VERSION = '0.1.0';

  export * from './types.js';
  export * from './schema.js';
  ```

- [ ] **Step 7: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect `schema.test.ts` to report **7 passing tests**, the purity suite still green, and a clean typecheck.

- [ ] **Step 8: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/core
  git commit -m "feat(core): CONTRACT §3 domain types, zod mirrors, and shared test fixtures"
  ```

---
### Task 3: Vendored SHA-256 and `hashProgram`

**Why a vendored SHA-256.** CONTRACT §4 requires `hashProgram(p: Program): string` returning SHA-256, and CONTRACT §2 requires core to have *no dependency but zod* and no `node:` imports. Three options existed:

1. `node:crypto` — breaks the no-`node:` rule and makes core unusable in the browser bundle that Plan 3's web workspace imports.
2. `js-sha256` as a second allowed dependency — would require amending the frozen "no deps but zod" line in CONTRACT §2.
3. **A ~70-line pure-TypeScript SHA-256 vendored into core.** Chosen. It changes nothing in the contract, keeps the purity allowlist at exactly `['zod']`, and is fully verifiable: the test cross-checks it against `node:crypto` (legal in a test file) on nine inputs including empty, multi-block, and astral-plane UTF-8, plus three published NIST vectors.

`packages/core/src/sha256.ts` is **PLAN-LOCAL and internal.** It is not named in CONTRACT §2 and is deliberately *not* re-exported from `index.ts` — only `hash.ts` imports it, so core's public surface stays exactly what the contract describes.

`TextEncoder` is not used: it is absent from the `ES2022` lib typings that core compiles against (`"types": []`, `"lib": ["ES2022"]`), so UTF-8 encoding is done by hand.

**Files:**
- Create: `packages/core/src/sha256.ts`, `packages/core/src/hash.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/sha256.test.ts`, `packages/core/test/hash.test.ts`

**Interfaces:**
- Consumes: `Program`, `Constraint` from `./types.js`; `makeProgram`, `makeConstraint` from `../test/fixtures.js`.
- Produces: `sha256Hex(input: string): string` (internal to core) and `hashProgram(p: Program): string` (CONTRACT §4).

- [ ] **Step 1: Write the failing tests**

  Create `packages/core/test/sha256.test.ts`:

  ```ts
  import { createHash } from 'node:crypto';
  import { describe, expect, it } from 'vitest';
  import { sha256Hex } from '../src/sha256.js';

  // node:crypto is used HERE, in a test, as an independent oracle. core/src
  // must never import it — see packages/core/test/purity.test.ts.
  function reference(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  describe('sha256Hex', () => {
    it('matches the published NIST vectors', () => {
      expect(sha256Hex('')).toBe(
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      );
      expect(sha256Hex('abc')).toBe(
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      );
      expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      );
    });

    it('matches node:crypto across padding boundaries and unicode', () => {
      const cases = [
        '',
        'abc',
        'hello world',
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        'Café W1AW —   naïve \u{1F4E1}',
        'x'.repeat(1000),
        'a'.repeat(55),
        'a'.repeat(56),
        'a'.repeat(64),
      ];
      for (const c of cases) {
        expect(sha256Hex(c), `mismatch for input of length ${c.length}`).toBe(reference(c));
      }
    });

    it('always returns 64 lowercase hex characters', () => {
      expect(sha256Hex('anything')).toMatch(/^[0-9a-f]{64}$/);
    });
  });
  ```

  Create `packages/core/test/hash.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { hashProgram } from '../src/hash.js';
  import { makeConstraint, makeProgram } from './fixtures.js';

  describe('hashProgram', () => {
    it('is deterministic and returns 64 lowercase hex characters', () => {
      const p = makeProgram();
      expect(hashProgram(p)).toMatch(/^[0-9a-f]{64}$/);
      expect(hashProgram(p)).toBe(hashProgram(makeProgram()));
    });

    // THE load-bearing test. arrl.org has no ETag and no Last-Modified, so every
    // nightly crawl rewrites lastVerifiedAt. If that field were hashed, every
    // record would look changed every single night and the Inbox would be useless.
    it('ignores lastVerifiedAt', () => {
      const before = makeProgram();
      const after = makeProgram({
        trust: { ...before.trust, lastVerifiedAt: '2027-01-15T09:30:00.000Z' },
      });
      expect(hashProgram(after)).toBe(hashProgram(before));
    });

    it('ignores every other TrustField, including status and contentHash', () => {
      const before = makeProgram();
      const after = makeProgram({
        trust: {
          status: 'dormant',
          sourceUrl: 'https://example.org/moved',
          lastVerifiedAt: '2030-01-01T00:00:00.000Z',
          verificationMethod: 'live_fetch',
          contentHash: 'deadbeef',
          staleMirrorWarning: 'a third-party aggregator still lists this as open',
        },
      });
      // Status changes are detected by diffPrograms comparing trust.status
      // directly (Plan 2), not by the content hash.
      expect(hashProgram(after)).toBe(hashProgram(before));
    });

    it('changes when a substantive field changes', () => {
      const before = makeProgram();
      const after = makeProgram({
        amount: { ...before.amount, amountMax: 30000 },
      });
      expect(hashProgram(after)).not.toBe(hashProgram(before));
    });

    it('is insensitive to constraint ordering', () => {
      const a = makeConstraint({ axis: 'gpa', min: 3 }, { id: 'aaa' });
      const b = makeConstraint({ axis: 'financial_need', weighted: true }, { id: 'bbb' });
      expect(hashProgram(makeProgram({ constraints: [a, b] }))).toBe(
        hashProgram(makeProgram({ constraints: [b, a] }))
      );
    });

    it('is insensitive to tag, entity and restriction ordering', () => {
      const one = makeProgram({
        tags: ['scholarship', 'arrl'],
        applicantEntities: ['university', 'individual'],
        fundingRestrictions: ['no ongoing operating expenses', 'no emcomm equipment'],
      });
      const two = makeProgram({
        tags: ['arrl', 'scholarship'],
        applicantEntities: ['individual', 'university'],
        fundingRestrictions: ['no emcomm equipment', 'no ongoing operating expenses'],
      });
      expect(hashProgram(one)).toBe(hashProgram(two));
    });

    // arrl.org's HTML is riddled with non-breaking spaces and inconsistent
    // wrapping. Collapsing whitespace stops a reflowed paragraph reading as a
    // content change.
    it('normalises non-breaking spaces and collapsed whitespace', () => {
      const plain = makeProgram({ summary: 'A single application across 111 entries.' });
      const gnarly = makeProgram({
        summary: '  A single\u00a0application   across\n111 entries.  ',
      });
      expect(hashProgram(gnarly)).toBe(hashProgram(plain));
    });

    it('distinguishes an absent optional field from an empty one', () => {
      const absent = makeProgram();
      const present = makeProgram({ applyContact: '' });
      expect(hashProgram(present)).not.toBe(hashProgram(absent));
    });
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test
  ```

  Expected failure: `Failed to resolve import "../src/sha256.js"` and `Failed to resolve import "../src/hash.js"`.

- [ ] **Step 3: Write `packages/core/src/sha256.ts`**

  ```ts
  /**
   * Pure TypeScript SHA-256. Vendored deliberately: packages/core may not import
   * node:crypto (it must run unchanged in the browser bundle) and may not take a
   * second runtime dependency. Verified byte-for-byte against node:crypto in
   * packages/core/test/sha256.test.ts.
   */

  const K: readonly number[] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function rotr(x: number, n: number): number {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
  }

  /** UTF-8 encode by hand: TextEncoder is not in the ES2022 lib core compiles against. */
  function utf8Bytes(input: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < input.length; i += 1) {
      const cp = input.codePointAt(i) as number;
      if (cp > 0xffff) i += 1; // a surrogate pair was consumed
      if (cp < 0x80) {
        out.push(cp);
      } else if (cp < 0x800) {
        out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
      } else if (cp < 0x10000) {
        out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
      } else {
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        );
      }
    }
    return out;
  }

  export function sha256Hex(input: string): string {
    const bytes = utf8Bytes(input);
    const bitLen = bytes.length * 8;

    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0x00);
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff);
    bytes.push((lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff);

    const h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const w = new Array<number>(64);

    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i += 1) {
        const j = off + i * 4;
        w[i] = ((bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3]) >>> 0;
      }
      for (let i = 16; i < 64; i += 1) {
        const s0 = (rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
        const s1 = (rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }

      let a = h[0];
      let b = h[1];
      let c = h[2];
      let d = h[3];
      let e = h[4];
      let f = h[5];
      let g = h[6];
      let hh = h[7];

      for (let i = 0; i < 64; i += 1) {
        const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
        const ch = ((e & f) ^ (~e & g)) >>> 0;
        const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
        const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
        const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
        const t2 = (s0 + maj) >>> 0;
        hh = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }

      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + hh) >>> 0;
    }

    let out = '';
    for (const word of h) out += word.toString(16).padStart(8, '0');
    return out;
  }
  ```

- [ ] **Step 4: Write `packages/core/src/hash.ts`**

  ```ts
  import { sha256Hex } from './sha256.js';
  import type { Constraint, Program } from './types.js';

  /**
   * Collapse the whitespace noise that arrl.org's markup produces: non-breaking
   * spaces, hard line wraps inside sentences, and leading/trailing padding. Two
   * renderings of the same sentence must hash identically or the Inbox fills
   * with phantom changes.
   */
  function normalizeText(value: string): string {
    return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function canonical(value: unknown): string {
    if (value === null || value === undefined) return 'null';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
    if (typeof value === 'string') return JSON.stringify(normalizeText(value));
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }

  function byId(a: Constraint, b: Constraint): number {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  /**
   * SHA-256 over the substantive fields of a Program, EXCLUDING TrustFields.
   * Excluding trust is load-bearing: lastVerifiedAt is rewritten by every crawl,
   * and hashing it would mark every record changed every night.
   *
   * Array order is not content: parsers legitimately emit constraints and tags in
   * different orders between runs, so they are sorted before hashing.
   */
  export function hashProgram(p: Program): string {
    const { trust: _trust, ...rest } = p;
    void _trust;
    const stable = {
      ...rest,
      applicantEntities: [...p.applicantEntities].sort(),
      fundingRestrictions: [...p.fundingRestrictions].sort(),
      tags: [...p.tags].sort(),
      constraints: [...p.constraints].sort(byId),
    };
    return sha256Hex(canonical(stable));
  }
  ```

- [ ] **Step 5: Extend the barrel**

  Append to `packages/core/src/index.ts`:

  ```ts
  export { hashProgram } from './hash.js';
  ```

- [ ] **Step 6: Run tests to verify they pass**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect **3 passing tests** in `sha256.test.ts` and **8** in `hash.test.ts`, the whole run green, and a clean typecheck. If the purity test fails here, the most likely cause is a doc comment mentioning `node:crypto` outside a `/* */` or `//` comment — the scanner strips comments before checking.

- [ ] **Step 7: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/core
  git commit -m "feat(core): vendored pure SHA-256 and trust-excluding hashProgram"
  ```

---
### Task 4: `parseAmount` — including the $100,000 endowment trap

**The domain problem.** Award amounts in this corpus are free text written by volunteers. A naive "take the largest dollar figure" regex is *provably wrong*: at least one ARRL catalogue entry contains **$100,000**, which is the size of the **endowment** that funds the scholarship, not the award. The real award is $1,000. Shipping $100,000 as the award amount would be the single most embarrassing bug in the product.

**The mechanism this task specifies.** Amount text is split into sentences (on `.`/`;`/newline). Every `$N` mention inherits its *sentence's* classification. A sentence containing any term from `NON_AWARD_CONTEXT_TERMS` — endowment vocabulary (`endowment`, `bequest`, `estate of`, `corpus`, `gift of`) or cumulative-total vocabulary (`has awarded`, `since 19`, `totaling`, `to date`, `cumulative`) — marks its mentions as non-award. A per-mention **award anchor override** rescues a mention whose immediately preceding ≤25 characters end in `award of` / `awards of` / `scholarship of` / `grant:` and so on, which handles single-sentence text like *"A $100,000 endowment funds awards of $2,500."*

Sentence scope beats a fixed character window because the two figures usually live in different sentences and a window would straddle them.

Every case below was executed against this exact implementation before the plan was written.

**Files:**
- Create: `packages/core/src/amount.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/amount.test.ts`

**Interfaces:**
- Consumes: `AmountSpec` from `./types.js`.
- Produces: `parseAmount(raw: string): Pick<AmountSpec, 'amountMin' | 'amountMax' | 'tiers'>` (CONTRACT §4), plus the PLAN-LOCAL exports `NON_AWARD_CONTEXT_TERMS: readonly string[]` and `AWARD_ANCHOR: RegExp` so Plan 2's normalizer can explain a parse in the review queue.

- [ ] **Step 1: Write the failing test**

  Create `packages/core/test/amount.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { parseAmount } from '../src/amount.js';

  describe('parseAmount', () => {
    it('parses a single fixed amount', () => {
      expect(parseAmount('$1,000')).toEqual({ amountMin: 1000, amountMax: 1000 });
      expect(parseAmount('$500, 1 per year')).toEqual({ amountMin: 500, amountMax: 500 });
    });

    it('parses ranges with hyphens, en dashes and the word "to"', () => {
      expect(parseAmount('$500-$5,000')).toEqual({ amountMin: 500, amountMax: 5000 });
      expect(parseAmount('$1,000–$25,000')).toEqual({ amountMin: 1000, amountMax: 25000 });
      expect(parseAmount('Awards range from $1,000 to $25,000.')).toEqual({
        amountMin: 1000,
        amountMax: 25000,
      });
    });

    // ARDC's block of 45 scholarships, the largest single entry in the ARRL catalogue.
    it('parses tiered blocks', () => {
      expect(
        parseAmount('20 awards of $25,000, 4 of $15,000, 17 of $10,000, 4 of $5,000'),
      ).toEqual({
        amountMin: 5000,
        amountMax: 25000,
        tiers: [
          { count: 20, amount: 25000 },
          { count: 4, amount: 15000 },
          { count: 17, amount: 10000 },
          { count: 4, amount: 5000 },
        ],
      });
    });

    // THE TRAP. A naive max-regex answers 100000 for all three of these.
    it('ignores endowment figures across sentences', () => {
      expect(
        parseAmount(
          'The fund was established with a $100,000 endowment from the estate of Dr. Jane Doe, W1ABC. One award of $1,000 is made annually.',
        ),
      ).toEqual({ amountMin: 1000, amountMax: 1000 });
    });

    it('ignores endowment figures inside a single sentence', () => {
      expect(parseAmount('A $100,000 endowment supports one award of $1,000 per year.')).toEqual({
        amountMin: 1000,
        amountMax: 1000,
      });
    });

    it('rescues an award figure that shares a sentence with an endowment figure', () => {
      expect(parseAmount('A $100,000 endowment funds awards of $2,500.')).toEqual({
        amountMin: 2500,
        amountMax: 2500,
      });
    });

    it('returns nothing when the only figure is an endowment', () => {
      expect(parseAmount('Funded by a $100,000 endowment.')).toEqual({});
    });

    // QCWA: "$3,000 each; 624+ students and $930,350+ since 1978".
    it('ignores lifetime and cumulative totals', () => {
      expect(parseAmount('Awards of $1,000 each; the program has awarded $930,350 since 1978.')).toEqual(
        { amountMin: 1000, amountMax: 1000 },
      );
      expect(parseAmount('$3,000 each; 15 awards in 2024 totaling $57,000.')).toEqual({
        amountMin: 3000,
        amountMax: 3000,
      });
    });

    it('spans several discrete awards', () => {
      expect(parseAmount('$2,500 / $2,500 / $1,500')).toEqual({ amountMin: 1500, amountMax: 2500 });
      expect(parseAmount('$1,450 (DR-2X) / $1,860 (with LAN-01A)')).toEqual({
        amountMin: 1450,
        amountMax: 1860,
      });
    });

    // ARRL Amateur Radio Grants: "generally do not exceed $3,000", "up to $5,000 in 2026".
    it('records a ceiling with no floor when every figure is capped', () => {
      expect(parseAmount('up to $5,000')).toEqual({ amountMax: 5000 });
      expect(parseAmount('Grants generally do not exceed $3,000; up to $5,000 in 2026.')).toEqual({
        amountMax: 5000,
      });
      expect(parseAmount('≤$200 typical, or more with committee approval')).toEqual({
        amountMax: 200,
      });
    });

    it('records a floor with no ceiling when every figure is a minimum', () => {
      expect(parseAmount('at least $500')).toEqual({ amountMin: 500 });
    });

    // Grants.gov returns the literal string "none" for awardCeiling/awardFloor.
    it('returns an empty object when there is no money in the text', () => {
      expect(parseAmount('none')).toEqual({});
      expect(parseAmount('Unpublished')).toEqual({});
      expect(parseAmount('')).toEqual({});
      expect(parseAmount('In-kind equipment only')).toEqual({});
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- amount
  ```

  Expected failure: `Failed to resolve import "../src/amount.js"`.

- [ ] **Step 3: Write `packages/core/src/amount.ts`**

  ```ts
  import type { AmountSpec, AwardTier } from './types.js';

  /**
   * Vocabulary that marks a dollar figure as something OTHER than an award.
   * Two groups: endowment/gift vocabulary, and cumulative-total vocabulary.
   * Grounded in real ARRL catalogue and QCWA text — see the tests.
   */
  export const NON_AWARD_CONTEXT_TERMS: readonly string[] = [
    // endowment / gift
    'endowment',
    'endowed',
    'endowing',
    'bequest',
    'bequeathed',
    'estate of',
    'corpus',
    'fund was established',
    'was established with',
    'established with',
    'gift of',
    'donated',
    'donation of',
    'contributed',
    'memorial fund of',
    // cumulative totals
    'total assets',
    'has awarded',
    'have awarded',
    'awarded since',
    'distributed since',
    'since 19',
    'since 20',
    'to date',
    'cumulative',
    'in total',
    'raised',
    'totaling',
    'totalling',
    'in awards',
  ];

  /**
   * Rescues a per-award figure that shares a sentence with an endowment figure:
   * "A $100,000 endowment funds awards of $2,500."
   */
  export const AWARD_ANCHOR =
    /\b(awards?|scholarships?|grants?|prizes?|stipends?)\s+(?:of|:)?\s*$/i;

  const MONEY = /\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/g;
  const TIER_RE = /([0-9]+)\s+(?:awards?\s+)?of\s+\$\s?([0-9][0-9,]*)/gi;
  const RANGE_RE = /\$\s?([0-9][0-9,]*)\s*(?:-|–|—|to|through)\s*\$?\s?([0-9][0-9,]*)/i;
  const UP_TO =
    /(?:\b(?:up to|not to exceed|does not exceed|do not exceed|no more than|maximum of|maximum|max|under)|≤|<=)\s*$/i;
  const AT_LEAST = /(?:\b(?:at least|minimum of|starting at)|≥|>=)\s*$/i;

  function toNumber(raw: string): number {
    return Number(raw.replace(/,/g, ''));
  }

  interface Mention {
    value: number;
    isAward: boolean;
    sentence: string;
    offsetInSentence: number;
  }

  function splitSentences(raw: string): Array<{ text: string }> {
    const out: Array<{ text: string }> = [];
    const re = /(?<=[.;])\s+|\n+/g;
    let start = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      out.push({ text: raw.slice(start, m.index) });
      start = re.lastIndex;
    }
    out.push({ text: raw.slice(start) });
    return out;
  }

  function collectMentions(raw: string): Mention[] {
    const mentions: Mention[] = [];
    for (const { text } of splitSentences(raw)) {
      const lower = text.toLowerCase();
      const sentenceIsNonAward = NON_AWARD_CONTEXT_TERMS.some((t) => lower.includes(t));
      MONEY.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = MONEY.exec(text)) !== null) {
        const before = text.slice(Math.max(0, m.index - 25), m.index);
        mentions.push({
          value: toNumber(m[1]),
          isAward: !sentenceIsNonAward || AWARD_ANCHOR.test(before),
          sentence: text,
          offsetInSentence: m.index,
        });
      }
    }
    return mentions;
  }

  export function parseAmount(raw: string): Pick<AmountSpec, 'amountMin' | 'amountMax' | 'tiers'> {
    const awardMentions = collectMentions(raw).filter((m) => m.isAward);
    if (awardMentions.length === 0) return {};

    TIER_RE.lastIndex = 0;
    const tiers: AwardTier[] = [];
    let t: RegExpExecArray | null;
    while ((t = TIER_RE.exec(raw)) !== null) {
      const amount = toNumber(t[2]);
      if (awardMentions.some((m) => m.value === amount)) {
        tiers.push({ count: Number(t[1]), amount });
      }
    }
    if (tiers.length >= 2) {
      const amounts = tiers.map((x) => x.amount);
      return { amountMin: Math.min(...amounts), amountMax: Math.max(...amounts), tiers };
    }

    const range = RANGE_RE.exec(raw);
    if (range) {
      const a = toNumber(range[1]);
      const b = toNumber(range[2]);
      if (awardMentions.some((m) => m.value === a) && awardMentions.some((m) => m.value === b)) {
        return { amountMin: Math.min(a, b), amountMax: Math.max(a, b) };
      }
    }

    const qualifiers = awardMentions.map((m) => {
      const before = m.sentence
        .slice(Math.max(0, m.offsetInSentence - 30), m.offsetInSentence)
        .replace(/\$\s*$/, '');
      if (UP_TO.test(before)) return 'up_to';
      if (AT_LEAST.test(before)) return 'at_least';
      return 'exact';
    });
    const values = awardMentions.map((m) => m.value);
    if (qualifiers.every((q) => q === 'up_to')) return { amountMax: Math.max(...values) };
    if (qualifiers.every((q) => q === 'at_least')) return { amountMin: Math.min(...values) };

    return { amountMin: Math.min(...values), amountMax: Math.max(...values) };
  }
  ```

- [ ] **Step 4: Extend the barrel**

  Append to `packages/core/src/index.ts`:

  ```ts
  export { AWARD_ANCHOR, NON_AWARD_CONTEXT_TERMS, parseAmount } from './amount.js';
  ```

- [ ] **Step 5: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect **12 passing tests** in `amount.test.ts`, the whole run green, and a clean typecheck.

- [ ] **Step 6: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/core
  git commit -m "feat(core): parseAmount with endowment and cumulative-total discrimination"
  ```

---
### Task 5: Timezone arithmetic, the `RECUR` notation, and `resolveDeadlineOwner`

**Where recurrence data lives — read this before writing any code.** CONTRACT §3 freezes `DeadlineSpec` as `{ kind, source, note }`. There is no field for "which four dates" or "which three windows", and adding one would break a frozen type that Plans 2–5 transcribe. So this plan defines a **micro-format inside `DeadlineSpec.note`**, and Plans 2 and 5 must emit it. This is a *format convention for an existing field*, not a new field.

```
RECUR <kind> key=value key=value ... | free human prose
```

- The directive must be at the very start of `note`. Everything after the first ` | ` is human prose and is ignored by the parser.
- If `note` does not start with `RECUR `, `parseRecurrence` returns `{ kind: 'none' }` — that is the normal, silent case for rolling / ad-hoc / unpublished programmes.
- If `note` *does* start with `RECUR ` but is malformed, `parseRecurrence` **throws**. Loud failure is deliberate: spec §6 names a parser that silently starts returning zero records as the most likely way this app rots.

| key | kinds | value | default |
|---|---|---|---|
| `tz` | all | IANA zone, e.g. `America/New_York` | **required** |
| `dates` | `n_fixed_dates` | `MM-DD[,MM-DD…]` | **required** |
| `windows` | `n_fixed_windows` | `MM-DD..MM-DD[,MM-DD..MM-DD…]` | **required** |
| `window` | `annual_window` | `MM-DD..MM-DD` | **required** |
| `open` | window kinds | `HH:MM` local | `00:00` |
| `close` | all | `HH:MM` local | `23:59` |

The three real records this plan is built around:

```
ARDC Grants Program
RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | Applications arriving after Sep 1 roll to the next Feb 1 cycle. ARDC evaluates for 60–120 days.

ARRL Amateur Radio Grants
RECUR n_fixed_windows tz=America/New_York windows=02-01..02-28,06-01..06-30,10-01..10-31 | Three windows a year. Generally not more than $3,000, up to $5,000 in 2026.

ARRL Foundation Scholarship Program
RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | Opens about Oct 30, closes Dec 30 at 12:00 PM Eastern. Moved from Jan 31 — never hardcode the old date.
```

**Handoff — Plans 2 and 5 MUST emit this format for these three programmes.** RESOLUTIONS R12 and the CONTRACT §10 amendment make this binding, and it is the single most breakable link in the whole system because nothing about it fails loudly:

| programme id | who emits it | the exact directive |
|---|---|---|
| `ardc-grants` | Plan 2's `inferDeadline` **and** Plan 5's seed record | `RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01` (Feb 1, Apr 1, Jul 1, Sep 1) |
| `arrl-amateur-radio-grants` | Plan 2's `inferDeadline` **and** Plan 5's seed record | `RECUR n_fixed_windows tz=America/New_York windows=02-01..02-28,06-01..06-30,10-01..10-31` (Feb 1–28, Jun 1–30, Oct 1–31) |
| `arrl-foundation-scholarships` | Plan 5's seed record (Plan 2 re-emits it on re-verify) | `RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00` (opens ~Oct 30, closes ~Dec 30 at 12:00 EST) |

`expandCycles` (Task 6) projects **only** from a parsed `RECUR` directive. A `DeadlineSpec` whose `note` is ordinary prose yields `[]` with no error, no warning and no failing test. So if Plans 2 and 5 omit the directive, the calendar is **silently empty for the three most important programmes in the corpus** — ARDC is the largest funder in the space, and the ARRL Foundation entry carries the deadline that all 111 catalogue scholarships (and QCWA, by inheritance) ride on. That is roughly 75% of the corpus with no dates. Plans 2 and 5 each own a test asserting `expandCycles` returns a non-empty result for all three ids.

**Why timezones matter here and how they are done without a library.** "Dec 30 at 12:00 PM EST" is a wall-clock time in a named zone, and half of these deadlines fall on the wrong side of a DST boundary from each other. Core cannot take a date library (one dependency, `zod`). `Intl.DateTimeFormat` with a `timeZone` option is a JavaScript-standard global, not a `node:` import, and this host's Node ships full ICU (`process.config.variables.icu_small === false`), as do all target browsers. Every expected value in the test below was produced by running this algorithm on this host.

**Files:**
- Create: `packages/core/src/deadline.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/recurrence.test.ts`

**Interfaces:**
- Consumes: `Program`, `DeadlineSpec` from `./types.js`.
- Produces: `resolveDeadlineOwner(program: Program, allPrograms: Program[]): Program` (CONTRACT §4); PLAN-LOCAL: `zonedWallTimeToUtcISO`, `parseRecurrence`, `RECURRENCE_PREFIX`, `RecurrenceParseError`, and the types `Recurrence`, `MonthDay`, `DateWindow`, `TimeOfDay`.

- [ ] **Step 1: Write the failing test**

  Create `packages/core/test/recurrence.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import {
    parseRecurrence,
    RecurrenceParseError,
    resolveDeadlineOwner,
    zonedWallTimeToUtcISO,
  } from '../src/deadline.js';
  import { makeProgram } from './fixtures.js';

  describe('zonedWallTimeToUtcISO', () => {
    it('resolves an ARDC February deadline in Pacific-authored Eastern terms', () => {
      expect(zonedWallTimeToUtcISO(2027, 2, 1, 23, 59, 0, 'America/New_York')).toBe(
        '2027-02-02T04:59:00.000Z',
      );
    });

    it('applies daylight time where it applies', () => {
      expect(zonedWallTimeToUtcISO(2027, 7, 1, 23, 59, 0, 'America/Los_Angeles')).toBe(
        '2027-07-02T06:59:00.000Z',
      );
    });

    it('resolves the ARRL scholarship close of Dec 30 at 12:00 Eastern', () => {
      expect(zonedWallTimeToUtcISO(2026, 12, 30, 12, 0, 0, 'America/New_York')).toBe(
        '2026-12-30T17:00:00.000Z',
      );
    });

    it('does not blow up on a wall time that does not exist (spring forward)', () => {
      expect(zonedWallTimeToUtcISO(2027, 3, 14, 2, 30, 0, 'America/New_York')).toBe(
        '2027-03-14T06:30:00.000Z',
      );
    });
  });

  describe('parseRecurrence', () => {
    it('returns none for prose that carries no directive', () => {
      expect(parseRecurrence('Rolling; allow about two months of lead time.')).toEqual({
        kind: 'none',
      });
      expect(parseRecurrence('')).toEqual({ kind: 'none' });
    });

    it('parses the ARDC four-dates directive', () => {
      const r = parseRecurrence(
        'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | Applications arriving after Sep 1 roll to the next Feb 1 cycle.',
      );
      expect(r).toEqual({
        kind: 'n_fixed_dates',
        timezone: 'America/Los_Angeles',
        dates: [
          { month: 2, day: 1 },
          { month: 4, day: 1 },
          { month: 7, day: 1 },
          { month: 9, day: 1 },
        ],
        closeTime: { hour: 23, minute: 59 },
      });
    });

    it('parses the ARRL three-windows directive', () => {
      const r = parseRecurrence(
        'RECUR n_fixed_windows tz=America/New_York windows=02-01..02-28,06-01..06-30,10-01..10-31 | Three windows a year.',
      );
      expect(r).toEqual({
        kind: 'n_fixed_windows',
        timezone: 'America/New_York',
        windows: [
          { open: { month: 2, day: 1 }, close: { month: 2, day: 28 } },
          { open: { month: 6, day: 1 }, close: { month: 6, day: 30 } },
          { open: { month: 10, day: 1 }, close: { month: 10, day: 31 } },
        ],
        openTime: { hour: 0, minute: 0 },
        closeTime: { hour: 23, minute: 59 },
      });
    });

    it('parses the ARRL scholarship annual window with an explicit close time', () => {
      const r = parseRecurrence(
        'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | Moved from Jan 31.',
      );
      expect(r).toEqual({
        kind: 'annual_window',
        timezone: 'America/New_York',
        window: { open: { month: 10, day: 30 }, close: { month: 12, day: 30 } },
        openTime: { hour: 0, minute: 0 },
        closeTime: { hour: 12, minute: 0 },
      });
    });

    it('throws loudly rather than silently returning nothing', () => {
      expect(() => parseRecurrence('RECUR n_fixed_dates dates=02-01')).toThrow(RecurrenceParseError);
      expect(() => parseRecurrence('RECUR annual_window tz=America/New_York')).toThrow(
        RecurrenceParseError,
      );
      expect(() => parseRecurrence('RECUR fortnightly tz=America/New_York')).toThrow(
        RecurrenceParseError,
      );
      expect(() =>
        parseRecurrence('RECUR n_fixed_dates tz=Mars/Olympus_Mons dates=02-01'),
      ).toThrow(RecurrenceParseError);
      expect(() =>
        parseRecurrence('RECUR n_fixed_dates tz=America/New_York dates=13-45'),
      ).toThrow(RecurrenceParseError);
    });
  });

  describe('resolveDeadlineOwner', () => {
    const arrl = makeProgram({ id: 'arrl-foundation-scholarships' });

    // QCWA's scholarship is administered through ARRL's application, so its
    // real deadline lives inside ARRL's cycle. All 111 ARRL catalogue entries
    // share one deadline too — this is why inheritance exists at all.
    const qcwa = makeProgram({
      id: 'qcwa-memorial-scholarship',
      name: 'QCWA Memorial Scholarship Fund',
      deadline: {
        kind: 'inherited',
        source: { kind: 'inherited', fromProgramId: 'arrl-foundation-scholarships' },
        note: 'Requests accepted from Oct 31; the completed application must reach the ARRL Foundation before the first week of January.',
      },
    });

    it('returns the programme itself when it owns its own deadline', () => {
      expect(resolveDeadlineOwner(arrl, [arrl, qcwa]).id).toBe('arrl-foundation-scholarships');
    });

    it('follows a single inheritance hop', () => {
      expect(resolveDeadlineOwner(qcwa, [arrl, qcwa]).id).toBe('arrl-foundation-scholarships');
    });

    it('follows a chain of hops', () => {
      const middle = makeProgram({
        id: 'middle',
        deadline: {
          kind: 'inherited',
          source: { kind: 'inherited', fromProgramId: 'arrl-foundation-scholarships' },
          note: '',
        },
      });
      const leaf = makeProgram({
        id: 'leaf',
        deadline: {
          kind: 'inherited',
          source: { kind: 'inherited', fromProgramId: 'middle' },
          note: '',
        },
      });
      expect(resolveDeadlineOwner(leaf, [arrl, middle, leaf]).id).toBe(
        'arrl-foundation-scholarships',
      );
    });

    it('falls back to the programme itself when the owner is missing from the corpus', () => {
      expect(resolveDeadlineOwner(qcwa, [qcwa]).id).toBe('qcwa-memorial-scholarship');
    });

    it('breaks an inheritance cycle instead of looping forever', () => {
      const a = makeProgram({
        id: 'a',
        deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'b' }, note: '' },
      });
      const b = makeProgram({
        id: 'b',
        deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'a' }, note: '' },
      });
      expect(resolveDeadlineOwner(a, [a, b]).id).toBe('a');
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- recurrence
  ```

  Expected failure: `Failed to resolve import "../src/deadline.js"`.

- [ ] **Step 3: Write `packages/core/src/deadline.ts` (recurrence half)**

  ```ts
  import type { Program } from './types.js';

  export interface MonthDay {
    month: number; // 1-12
    day: number; // 1-31
  }

  export interface DateWindow {
    open: MonthDay;
    close: MonthDay;
  }

  export interface TimeOfDay {
    hour: number;
    minute: number;
  }

  /**
   * PLAN-LOCAL. CONTRACT §3 freezes DeadlineSpec as { kind, source, note }, so the
   * recurrence parameters travel in `note` using the RECUR micro-format. Plans 2
   * and 5 emit that format; this type is what it parses into.
   */
  export type Recurrence =
    | { kind: 'none' }
    | { kind: 'n_fixed_dates'; timezone: string; dates: MonthDay[]; closeTime: TimeOfDay }
    | {
        kind: 'n_fixed_windows';
        timezone: string;
        windows: DateWindow[];
        openTime: TimeOfDay;
        closeTime: TimeOfDay;
      }
    | {
        kind: 'annual_window';
        timezone: string;
        window: DateWindow;
        openTime: TimeOfDay;
        closeTime: TimeOfDay;
      };

  export const RECURRENCE_PREFIX = 'RECUR ';
  export const DEFAULT_OPEN_TIME: TimeOfDay = { hour: 0, minute: 0 };
  export const DEFAULT_CLOSE_TIME: TimeOfDay = { hour: 23, minute: 59 };

  export class RecurrenceParseError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'RecurrenceParseError';
    }
  }

  function parseMonthDay(raw: string, context: string): MonthDay {
    const m = /^(\d{2})-(\d{2})$/.exec(raw);
    if (m === null) {
      throw new RecurrenceParseError(`${context}: "${raw}" is not an MM-DD date`);
    }
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      throw new RecurrenceParseError(`${context}: "${raw}" is out of range`);
    }
    return { month, day };
  }

  function parseTimeOfDay(raw: string, context: string): TimeOfDay {
    const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
    if (m === null) {
      throw new RecurrenceParseError(`${context}: "${raw}" is not an HH:MM time`);
    }
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour > 23 || minute > 59) {
      throw new RecurrenceParseError(`${context}: "${raw}" is out of range`);
    }
    return { hour, minute };
  }

  function assertIanaZone(tz: string): string {
    try {
      // Throws RangeError for an unknown zone. Catching a typo here beats
      // silently emitting deadlines in the wrong offset.
      new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0);
    } catch {
      throw new RecurrenceParseError(`unknown IANA time zone "${tz}"`);
    }
    return tz;
  }

  function parseWindow(raw: string, context: string): DateWindow {
    const halves = raw.split('..');
    if (halves.length !== 2) {
      throw new RecurrenceParseError(`${context}: "${raw}" is not an MM-DD..MM-DD window`);
    }
    return {
      open: parseMonthDay(halves[0], context),
      close: parseMonthDay(halves[1], context),
    };
  }

  export function parseRecurrence(note: string): Recurrence {
    if (!note.startsWith(RECURRENCE_PREFIX)) return { kind: 'none' };

    const directive = note.slice(RECURRENCE_PREFIX.length).split('|')[0].trim();
    const tokens = directive.split(/\s+/).filter((t) => t.length > 0);
    const kind = tokens[0] ?? '';

    const kv = new Map<string, string>();
    for (const token of tokens.slice(1)) {
      const eq = token.indexOf('=');
      if (eq <= 0) {
        throw new RecurrenceParseError(`malformed key=value token "${token}" in RECUR directive`);
      }
      kv.set(token.slice(0, eq), token.slice(eq + 1));
    }

    const tzRaw = kv.get('tz');
    if (tzRaw === undefined) {
      throw new RecurrenceParseError(`RECUR ${kind} requires tz=<IANA zone>`);
    }
    const timezone = assertIanaZone(tzRaw);

    const openRaw = kv.get('open');
    const closeRaw = kv.get('close');
    const openTime = openRaw === undefined ? DEFAULT_OPEN_TIME : parseTimeOfDay(openRaw, 'open');
    const closeTime = closeRaw === undefined ? DEFAULT_CLOSE_TIME : parseTimeOfDay(closeRaw, 'close');

    if (kind === 'n_fixed_dates') {
      const raw = kv.get('dates');
      if (raw === undefined) {
        throw new RecurrenceParseError('RECUR n_fixed_dates requires dates=MM-DD[,MM-DD...]');
      }
      const dates = raw.split(',').map((d) => parseMonthDay(d, 'dates'));
      return { kind, timezone, dates, closeTime };
    }

    if (kind === 'n_fixed_windows') {
      const raw = kv.get('windows');
      if (raw === undefined) {
        throw new RecurrenceParseError(
          'RECUR n_fixed_windows requires windows=MM-DD..MM-DD[,MM-DD..MM-DD...]',
        );
      }
      const windows = raw.split(',').map((w) => parseWindow(w, 'windows'));
      return { kind, timezone, windows, openTime, closeTime };
    }

    if (kind === 'annual_window') {
      const raw = kv.get('window');
      if (raw === undefined) {
        throw new RecurrenceParseError('RECUR annual_window requires window=MM-DD..MM-DD');
      }
      return { kind, timezone, window: parseWindow(raw, 'window'), openTime, closeTime };
    }

    throw new RecurrenceParseError(`unknown RECUR kind "${kind}"`);
  }

  /**
   * Offset in minutes that `timeZone` was at the given UTC instant. Derived by
   * asking Intl what the local wall clock reads there and subtracting.
   */
  function offsetMinutesAt(utcMs: number, timeZone: string): number {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = dtf.formatToParts(new Date(utcMs));
    const get = (type: string): number => {
      const part = parts.find((p) => p.type === type);
      return part === undefined ? 0 : Number(part.value);
    };
    // `hour` can come back as 24 for midnight under some ICU builds.
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    return (asUtc - utcMs) / 60000;
  }

  /**
   * Convert a wall-clock time in an IANA zone to a UTC ISO instant. Two passes:
   * the first offset estimate can be wrong within a few hours of a DST
   * transition, and re-reading the offset at the corrected instant fixes it.
   */
  export function zonedWallTimeToUtcISO(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
    timeZone: string,
  ): string {
    const naive = Date.UTC(year, month - 1, day, hour, minute, second);
    let ts = naive - offsetMinutesAt(naive, timeZone) * 60000;
    ts = naive - offsetMinutesAt(ts, timeZone) * 60000;
    return new Date(ts).toISOString();
  }

  /**
   * Follow `deadline.source.inherited` to the programme that actually owns the
   * dates. Returns the input programme when it owns its own deadline, when the
   * owner is absent from `allPrograms` (an incomplete corpus must not fabricate
   * dates), or when the chain loops.
   */
  export function resolveDeadlineOwner(program: Program, allPrograms: Program[]): Program {
    const byId = new Map(allPrograms.map((p) => [p.id, p]));
    const seen = new Set<string>([program.id]);
    let current = program;
    for (let hops = 0; hops < 8; hops += 1) {
      if (current.deadline.source.kind !== 'inherited') return current;
      const next = byId.get(current.deadline.source.fromProgramId);
      if (next === undefined) return program;
      if (seen.has(next.id)) return program;
      seen.add(next.id);
      current = next;
    }
    return program;
  }
  ```

- [ ] **Step 4: Extend the barrel**

  Append to `packages/core/src/index.ts`:

  ```ts
  export {
    DEFAULT_CLOSE_TIME,
    DEFAULT_OPEN_TIME,
    parseRecurrence,
    RECURRENCE_PREFIX,
    RecurrenceParseError,
    resolveDeadlineOwner,
    zonedWallTimeToUtcISO,
  } from './deadline.js';
  export type { DateWindow, MonthDay, Recurrence, TimeOfDay } from './deadline.js';
  ```

- [ ] **Step 5: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect **14 passing tests** in `recurrence.test.ts`, the whole run green, and a clean typecheck.

- [ ] **Step 6: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/core
  git commit -m "feat(core): IANA-correct wall-time conversion, RECUR notation, deadline inheritance"
  ```

---
### Task 6: `expandCycles` — total over all ten `DeadlineKind` values

`expandCycles` projects concrete dated `Cycle` instances from a recurrence. Exactly **three** of the ten `DeadlineKind` values are projectable; the other seven return `[]`, each for a stated reason:

| `DeadlineKind` | Behaviour | Why |
|---|---|---|
| `n_fixed_dates` | projects | ARDC: Feb 1, Apr 1, Jul 1, Sep 1 |
| `n_fixed_windows` | projects | ARRL Amateur Radio Grants: Feb 1–28, Jun 1–30, Oct 1–31 |
| `annual_window` | projects | ARRL scholarships: opens ~Oct 30, closes Dec 30 12:00 Eastern |
| `inherited` | projects **the owner's** recurrence under the inheriting programme's id | QCWA rides ARRL's cycle |
| `rolling` | `[]` | NCDXF and SARA accept applications continuously; there is no dated instance. Plan 3's calendar renders these in a separate always-open lane |
| `quarterly_rewritten` | `[]` | ARISS rewrites one window sentence at a stable URL every quarter. Only the *observed* window is real; it is stored in the `cycles` table by Plan 2, never projected |
| `ad_hoc` | `[]` | Yaesu's DR-2X windows are irregular and announced in a dated PDF filename |
| `unpublished` | `[]` | RCA and the ARRL Club Grant publish no date at all |
| `no_application_exists` | `[]` | Yasme is board-initiated; there is nothing to apply to |
| `dormant` | `[]` | no active cycle |

A projectable-looking `RECUR` directive attached to a non-projectable kind is **ignored**, so a copy-paste accident cannot invent deadlines.

Every expected instant below was computed by running this algorithm on this host.

**Files:**
- Modify: `packages/core/src/deadline.ts` (append)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/cycles.test.ts`

**Interfaces:**
- Consumes: `parseRecurrence`, `resolveDeadlineOwner`, `zonedWallTimeToUtcISO` from `./deadline.js`; `Cycle`, `DeadlineKind`, `Program` from `./types.js`.
- Produces: `expandCycles(program: Program, allPrograms: Program[], fromISO: string, toISO: string): Cycle[]` (CONTRACT §4).

- [ ] **Step 1: Write the failing test**

  Create `packages/core/test/cycles.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { expandCycles } from '../src/deadline.js';
  import { makeProgram } from './fixtures.js';

  const ardc = makeProgram({
    id: 'ardc-grants',
    name: 'ARDC Grants Program',
    klass: 'ham_grant',
    deadline: {
      kind: 'n_fixed_dates',
      source: { kind: 'self' },
      note: 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | Applications arriving after Sep 1 roll to the next Feb 1 cycle.',
    },
  });

  const arrlGrants = makeProgram({
    id: 'arrl-amateur-radio-grants',
    name: 'ARRL Amateur Radio Grants',
    klass: 'ham_grant',
    deadline: {
      kind: 'n_fixed_windows',
      source: { kind: 'self' },
      note: 'RECUR n_fixed_windows tz=America/New_York windows=02-01..02-28,06-01..06-30,10-01..10-31 | Three windows a year.',
    },
  });

  // makeProgram's default is already the ARRL scholarship annual window.
  const arrlScholarships = makeProgram();

  const qcwa = makeProgram({
    id: 'qcwa-memorial-scholarship',
    name: 'QCWA Memorial Scholarship Fund',
    deadline: {
      kind: 'inherited',
      source: { kind: 'inherited', fromProgramId: 'arrl-foundation-scholarships' },
      note: 'Requests accepted from Oct 31; the application must reach the ARRL Foundation before the first week of January.',
    },
  });

  describe('expandCycles — projectable kinds', () => {
    it("projects ARDC's four fixed dates for one calendar year", () => {
      const cycles = expandCycles(ardc, [ardc], '2027-01-01T00:00:00.000Z', '2027-12-31T23:59:59.999Z');
      expect(cycles.map((c) => c.closesAt)).toEqual([
        '2027-02-02T07:59:00.000Z',
        '2027-04-02T06:59:00.000Z',
        '2027-07-02T06:59:00.000Z',
        '2027-09-02T06:59:00.000Z',
      ]);
      expect(cycles.map((c) => c.label)).toEqual([
        'Feb 1, 2027 deadline',
        'Apr 1, 2027 deadline',
        'Jul 1, 2027 deadline',
        'Sep 1, 2027 deadline',
      ]);
      expect(cycles.every((c) => c.opensAt === undefined)).toBe(true);
      expect(cycles.every((c) => c.isEstimated)).toBe(true);
      expect(cycles.every((c) => c.programId === 'ardc-grants')).toBe(true);
      expect(cycles.every((c) => c.timezone === 'America/Los_Angeles')).toBe(true);
    });

    it('projects across a multi-year range in ascending order', () => {
      const cycles = expandCycles(ardc, [ardc], '2027-01-01T00:00:00.000Z', '2028-12-31T23:59:59.999Z');
      expect(cycles).toHaveLength(8);
      expect(cycles[7].closesAt).toBe('2028-09-02T06:59:00.000Z');
      const closes = cycles.map((c) => Date.parse(c.closesAt as string));
      expect([...closes].sort((a, b) => a - b)).toEqual(closes);
    });

    it("projects ARRL's three windows with both ends of each window", () => {
      const cycles = expandCycles(
        arrlGrants,
        [arrlGrants],
        '2027-01-01T00:00:00.000Z',
        '2027-12-31T23:59:59.999Z',
      );
      expect(cycles.map((c) => [c.opensAt, c.closesAt])).toEqual([
        ['2027-02-01T05:00:00.000Z', '2027-03-01T04:59:00.000Z'],
        ['2027-06-01T04:00:00.000Z', '2027-07-01T03:59:00.000Z'],
        ['2027-10-01T04:00:00.000Z', '2027-11-01T03:59:00.000Z'],
      ]);
      expect(cycles[0].label).toBe('Feb 1–28, 2027 window');
      expect(cycles[2].label).toBe('Oct 1–31, 2027 window');
    });

    it('projects the ARRL scholarship annual window with its 12:00 Eastern close', () => {
      const cycles = expandCycles(
        arrlScholarships,
        [arrlScholarships],
        '2026-01-01T00:00:00.000Z',
        '2026-12-31T23:59:59.999Z',
      );
      expect(cycles).toHaveLength(1);
      expect(cycles[0].opensAt).toBe('2026-10-30T04:00:00.000Z');
      expect(cycles[0].closesAt).toBe('2026-12-30T17:00:00.000Z');
      expect(cycles[0].label).toBe('Oct 30 – Dec 30, 2026 window');
    });

    it('carries a window that crosses the year boundary into the following year', () => {
      const crossing = makeProgram({
        id: 'crossing',
        deadline: {
          kind: 'annual_window',
          source: { kind: 'self' },
          note: 'RECUR annual_window tz=America/New_York window=11-01..02-15 | Opens in November, closes in February.',
        },
      });
      const cycles = expandCycles(
        crossing,
        [crossing],
        '2027-01-01T00:00:00.000Z',
        '2027-06-30T00:00:00.000Z',
      );
      expect(cycles).toHaveLength(1);
      expect(cycles[0].opensAt).toBe('2026-11-01T04:00:00.000Z');
      expect(cycles[0].closesAt).toBe('2027-02-16T04:59:00.000Z');
      expect(cycles[0].label).toBe('Nov 1, 2026 – Feb 15, 2027 window');
    });

    it('clamps Feb 29 to Feb 28 in non-leap years', () => {
      const leapy = makeProgram({
        id: 'leapy',
        deadline: {
          kind: 'n_fixed_dates',
          source: { kind: 'self' },
          note: 'RECUR n_fixed_dates tz=America/New_York dates=02-29',
        },
      });
      const nonLeap = expandCycles(leapy, [leapy], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z');
      expect(nonLeap[0].closesAt).toBe('2027-03-01T04:59:00.000Z');
      expect(nonLeap[0].label).toBe('Feb 28, 2027 deadline');

      const leap = expandCycles(leapy, [leapy], '2028-01-01T00:00:00.000Z', '2028-12-31T00:00:00.000Z');
      expect(leap[0].closesAt).toBe('2028-03-01T04:59:00.000Z');
      expect(leap[0].label).toBe('Feb 29, 2028 deadline');
    });

    it('gives an inheriting programme its owner’s dates under its own id', () => {
      const cycles = expandCycles(
        qcwa,
        [arrlScholarships, qcwa],
        '2026-01-01T00:00:00.000Z',
        '2026-12-31T23:59:59.999Z',
      );
      expect(cycles).toHaveLength(1);
      expect(cycles[0].programId).toBe('qcwa-memorial-scholarship');
      expect(cycles[0].closesAt).toBe('2026-12-30T17:00:00.000Z');
      expect(cycles[0].label).toBe(
        'Oct 30 – Dec 30, 2026 window (via ARRL Foundation Scholarship Program)',
      );
      expect(cycles[0].id).toBe('qcwa-memorial-scholarship:2026-12-30T17:00:00.000Z');
    });

    it('produces stable ids so repeated crawls upsert instead of duplicating', () => {
      const a = expandCycles(ardc, [ardc], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z');
      const b = expandCycles(ardc, [ardc], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z');
      expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
      expect(a[0].id).toBe('ardc-grants:2027-02-02T07:59:00.000Z');
    });
  });

  describe('expandCycles — the seven non-projectable kinds', () => {
    const kinds = [
      'rolling',
      'quarterly_rewritten',
      'ad_hoc',
      'unpublished',
      'no_application_exists',
      'dormant',
    ] as const;

    it('returns no cycles for any kind that cannot be projected', () => {
      for (const kind of kinds) {
        const p = makeProgram({
          id: `p-${kind}`,
          deadline: { kind, source: { kind: 'self' }, note: 'No published deadline.' },
        });
        expect(
          expandCycles(p, [p], '2026-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'),
          kind,
        ).toEqual([]);
      }
      expect(kinds).toHaveLength(6);
    });

    it('ignores a RECUR directive attached to a non-projectable kind', () => {
      const bogus = makeProgram({
        id: 'bogus',
        deadline: {
          kind: 'rolling',
          source: { kind: 'self' },
          note: 'RECUR n_fixed_dates tz=America/New_York dates=02-01 | pasted here by accident',
        },
      });
      expect(expandCycles(bogus, [bogus], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z')).toEqual(
        [],
      );
    });

    it('returns nothing for a projectable kind whose note carries no directive', () => {
      const blank = makeProgram({
        id: 'blank',
        deadline: { kind: 'annual_window', source: { kind: 'self' }, note: 'Annual, date TBC by the curator.' },
      });
      expect(expandCycles(blank, [blank], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z')).toEqual(
        [],
      );
    });

    it('returns nothing for an inverted or unparsable range', () => {
      expect(expandCycles(ardc, [ardc], '2028-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')).toEqual(
        [],
      );
      expect(expandCycles(ardc, [ardc], 'not-a-date', '2027-01-01T00:00:00.000Z')).toEqual([]);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- cycles
  ```

  Expected failure: `"expandCycles" is not exported by "packages/core/src/deadline.ts"`.

- [ ] **Step 3: Append the projection code to `packages/core/src/deadline.ts`**

  ```ts
  import type { Cycle, DeadlineKind } from './types.js';

  const MONTH_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];

  /** Only these three kinds carry enough information to be projected forward. */
  const PROJECTABLE_KINDS: ReadonlySet<DeadlineKind> = new Set<DeadlineKind>([
    'n_fixed_dates',
    'n_fixed_windows',
    'annual_window',
  ]);

  function daysInMonth(year: number, month: number): number {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function clampDay(year: number, month: number, day: number): number {
    return Math.min(day, daysInMonth(year, month));
  }

  function labelDate(year: number, month: number, day: number): string {
    return `${MONTH_SHORT[month - 1]} ${day}, ${year}`;
  }

  function labelWindow(
    openYear: number,
    openMonth: number,
    openDay: number,
    closeYear: number,
    closeMonth: number,
    closeDay: number,
  ): string {
    if (openYear === closeYear && openMonth === closeMonth) {
      return `${MONTH_SHORT[openMonth - 1]} ${openDay}–${closeDay}, ${openYear} window`;
    }
    if (openYear === closeYear) {
      return `${MONTH_SHORT[openMonth - 1]} ${openDay} – ${MONTH_SHORT[closeMonth - 1]} ${closeDay}, ${openYear} window`;
    }
    return `${MONTH_SHORT[openMonth - 1]} ${openDay}, ${openYear} – ${MONTH_SHORT[closeMonth - 1]} ${closeDay}, ${closeYear} window`;
  }

  interface CycleDraft {
    opensAt?: string;
    closesAt: string;
    label: string;
  }

  function projectWindow(
    window: DateWindow,
    openYear: number,
    openTime: TimeOfDay,
    closeTime: TimeOfDay,
    timezone: string,
  ): CycleDraft {
    const crossesYearEnd =
      window.close.month < window.open.month ||
      (window.close.month === window.open.month && window.close.day < window.open.day);
    const closeYear = crossesYearEnd ? openYear + 1 : openYear;
    const openDay = clampDay(openYear, window.open.month, window.open.day);
    const closeDay = clampDay(closeYear, window.close.month, window.close.day);
    return {
      opensAt: zonedWallTimeToUtcISO(
        openYear,
        window.open.month,
        openDay,
        openTime.hour,
        openTime.minute,
        0,
        timezone,
      ),
      closesAt: zonedWallTimeToUtcISO(
        closeYear,
        window.close.month,
        closeDay,
        closeTime.hour,
        closeTime.minute,
        0,
        timezone,
      ),
      label: labelWindow(
        openYear,
        window.open.month,
        openDay,
        closeYear,
        window.close.month,
        closeDay,
      ),
    };
  }

  /**
   * Project concrete dated Cycle instances into [fromISO, toISO].
   *
   * Every projected cycle carries isEstimated: true — it comes from a recurrence
   * rule, not from an observed page. Cycles actually seen on a funder's site are
   * written to the cycles table by Plan 2 with isEstimated: false.
   *
   * Cycle ids are `${programId}:${closesAt}` so a nightly re-projection upserts
   * over the previous run rather than duplicating rows.
   */
  export function expandCycles(
    program: Program,
    allPrograms: Program[],
    fromISO: string,
    toISO: string,
  ): Cycle[] {
    const owner = resolveDeadlineOwner(program, allPrograms);
    if (!PROJECTABLE_KINDS.has(owner.deadline.kind)) return [];

    const recurrence = parseRecurrence(owner.deadline.note);
    if (recurrence.kind === 'none') return [];

    const fromMs = Date.parse(fromISO);
    const toMs = Date.parse(toISO);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs) || toMs < fromMs) return [];

    const inherited = owner.id !== program.id;
    const firstYear = new Date(fromMs).getUTCFullYear() - 1;
    const lastYear = new Date(toMs).getUTCFullYear() + 1;

    const drafts: CycleDraft[] = [];
    for (let year = firstYear; year <= lastYear; year += 1) {
      if (recurrence.kind === 'n_fixed_dates') {
        for (const date of recurrence.dates) {
          const day = clampDay(year, date.month, date.day);
          drafts.push({
            closesAt: zonedWallTimeToUtcISO(
              year,
              date.month,
              day,
              recurrence.closeTime.hour,
              recurrence.closeTime.minute,
              0,
              recurrence.timezone,
            ),
            label: `${labelDate(year, date.month, day)} deadline`,
          });
        }
      } else if (recurrence.kind === 'n_fixed_windows') {
        for (const window of recurrence.windows) {
          drafts.push(
            projectWindow(window, year, recurrence.openTime, recurrence.closeTime, recurrence.timezone),
          );
        }
      } else {
        drafts.push(
          projectWindow(
            recurrence.window,
            year,
            recurrence.openTime,
            recurrence.closeTime,
            recurrence.timezone,
          ),
        );
      }
    }

    const cycles: Cycle[] = [];
    for (const draft of drafts) {
      const closesMs = Date.parse(draft.closesAt);
      if (closesMs < fromMs || closesMs > toMs) continue;
      const cycle: Cycle = {
        id: `${program.id}:${draft.closesAt}`,
        programId: program.id,
        closesAt: draft.closesAt,
        timezone: recurrence.timezone,
        label: inherited ? `${draft.label} (via ${owner.name})` : draft.label,
        isEstimated: true,
      };
      if (draft.opensAt !== undefined) cycle.opensAt = draft.opensAt;
      cycles.push(cycle);
    }

    return cycles.sort((a, b) => {
      const delta = Date.parse(a.closesAt as string) - Date.parse(b.closesAt as string);
      if (delta !== 0) return delta;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }
  ```

  Merge the new `import type` line into the existing one at the top of the file so there is a single `import type { Cycle, DeadlineKind, Program } from './types.js';`.

- [ ] **Step 4: Extend the barrel**

  Append to `packages/core/src/index.ts`:

  ```ts
  export { expandCycles } from './deadline.js';
  ```

- [ ] **Step 5: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect **12 passing tests** in `cycles.test.ts`, the whole run green, and a clean typecheck.

- [ ] **Step 6: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/core
  git commit -m "feat(core): expandCycles projection across all ten DeadlineKind values"
  ```

---
### Task 7: ARRL geography — the Division/Section table and `geo.ts`

**Domain fact this task depends on.** ARRL scholarship eligibility is written in ARRL Field Organization vocabulary: *"open to residents of the ARRL Central Division"*, *"IL or ARRL Central Division"*. The US is divided into **15 Divisions** containing **71 Sections**. A Section is usually one state (`Ohio`), sometimes part of one (`Eastern Pennsylvania` / `Western Pennsylvania`), and occasionally several (`Maryland-DC` = MD + DC; the `Pacific` section covers HI, American Samoa, Guam and the Northern Marianas). Sections have official abbreviations (`MDC`, `WPA`, `NLI`, `LAX`) that appear in source text as often as full names. Without this table the geography axis cannot be evaluated at all.

The table ships **twice on purpose**: `data/reference/arrl-sections.json` is the shipped, human-editable data artefact named by CONTRACT §2, and `packages/core/src/arrlSections.ts` is the same table as a TypeScript constant, because core is pure and cannot read a file at runtime. A drift test proves the two are identical.

Three radius constraints in the corpus are real and this task is built around them: *"within 250 miles of Seaford, Delaware"*, *"within 70 miles of Schenectady, NY"*, *"within 175 miles of Erving, MA"*. All distances asserted below were computed with this haversine implementation on this host.

**Files:**
- Create: `data/reference/arrl-sections.json`, `packages/core/src/arrlSections.ts`, `packages/core/src/geo.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/geo.test.ts`

**Interfaces:**
- Consumes: `GeoSpec` from `./types.js`.
- Produces: `statesForArrlDivision(division: string): string[]`, `statesForArrlSection(section: string): string[]`, `withinRadius(lat: number, lon: number, geo: GeoSpec): boolean` (all CONTRACT §4); PLAN-LOCAL: `haversineMiles`, `callDistrictFromCallsign`, `evaluateGeo(geo: GeoSpec, loc: GeoLocation): GeoDecision`, `ARRL_DIVISIONS`, `ARRL_SECTIONS`, and the types `ArrlSection`, `GeoLocation`, `GeoDecision`.

- [ ] **Step 1: Write the failing test**

  Create `packages/core/test/geo.test.ts`:

  ```ts
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { describe, expect, it } from 'vitest';
  import { ARRL_DIVISIONS, ARRL_SECTIONS } from '../src/arrlSections.js';
  import {
    callDistrictFromCallsign,
    evaluateGeo,
    haversineMiles,
    statesForArrlDivision,
    statesForArrlSection,
    withinRadius,
  } from '../src/geo.js';
  import type { GeoSpec } from '../src/types.js';

  const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

  // Real centres from the three radius constraints in the corpus.
  const SEAFORD_DE = { lat: 38.6415, lon: -75.6113 };
  const SCHENECTADY_NY = { lat: 42.8142, lon: -73.9396 };
  const ERVING_MA = { lat: 42.6001, lon: -72.4326 };

  const PHILADELPHIA = { lat: 39.9526, lon: -75.1652 };
  const NEW_YORK = { lat: 40.7128, lon: -74.006 };
  const BOSTON = { lat: 42.3601, lon: -71.0589 };
  const ALBANY = { lat: 42.6526, lon: -73.7562 };
  const AMHERST_MA = { lat: 42.3732, lon: -72.5199 };
  const WASHINGTON_DC = { lat: 38.9072, lon: -77.0369 };

  function radius(center: { lat: number; lon: number }, miles: number, label: string): GeoSpec {
    return {
      type: 'radius',
      values: [],
      centerLat: center.lat,
      centerLon: center.lon,
      radiusMiles: miles,
      centerLabel: label,
    };
  }

  describe('ARRL reference table', () => {
    it('has 15 divisions and 71 sections', () => {
      expect(ARRL_DIVISIONS).toHaveLength(15);
      expect(ARRL_SECTIONS).toHaveLength(71);
      expect(new Set(ARRL_SECTIONS.map((s) => s.abbrev)).size).toBe(71);
      for (const section of ARRL_SECTIONS) {
        expect(ARRL_DIVISIONS, `${section.name} has an unknown division`).toContain(
          section.division,
        );
        expect(section.states.length).toBeGreaterThan(0);
      }
    });

    it('matches data/reference/arrl-sections.json exactly', () => {
      const json = JSON.parse(
        readFileSync(`${REPO_ROOT}/data/reference/arrl-sections.json`, 'utf8'),
      ) as { divisions: string[]; sections: typeof ARRL_SECTIONS };
      expect(json.divisions).toEqual([...ARRL_DIVISIONS]);
      expect(json.sections).toEqual([...ARRL_SECTIONS]);
    });
  });

  describe('division and section lookups', () => {
    it('resolves the Central Division to IL, IN and WI', () => {
      // The Six Meter Club of Chicago scholarship reads "IL or ARRL Central Division".
      expect(statesForArrlDivision('Central')).toEqual(['IL', 'IN', 'WI']);
    });

    it('tolerates case and a trailing "Division"/"Section" word', () => {
      expect(statesForArrlDivision('central division')).toEqual(['IL', 'IN', 'WI']);
      expect(statesForArrlDivision('  ROANOKE  ')).toEqual(['NC', 'SC', 'VA', 'WV']);
      expect(statesForArrlSection('ohio section')).toEqual(['OH']);
    });

    it('resolves multi-state sections', () => {
      expect(statesForArrlSection('Maryland-DC')).toEqual(['MD', 'DC']);
      expect(statesForArrlSection('Pacific')).toEqual(['HI', 'AS', 'GU', 'MP']);
    });

    it('resolves sections by their official abbreviation', () => {
      expect(statesForArrlSection('MDC')).toEqual(['MD', 'DC']);
      expect(statesForArrlSection('WPA')).toEqual(['PA']);
      expect(statesForArrlSection('NLI')).toEqual(['NY']);
      expect(statesForArrlSection('LAX')).toEqual(['CA']);
    });

    it('unions every section in a division, without duplicates', () => {
      expect(statesForArrlDivision('Hudson')).toEqual(['NJ', 'NY']);
      expect(statesForArrlDivision('Southwestern')).toEqual(['AZ', 'CA']);
      expect(statesForArrlDivision('West Gulf')).toEqual(['OK', 'TX']);
      expect(statesForArrlDivision('Pacific')).toEqual(['AS', 'CA', 'GU', 'HI', 'MP', 'NV']);
    });

    it('returns an empty array for names it does not know', () => {
      expect(statesForArrlDivision('Atlantis')).toEqual([]);
      expect(statesForArrlSection('Sector 7G')).toEqual([]);
    });
  });

  describe('haversineMiles and withinRadius', () => {
    it('puts one degree of latitude at about 69.1 miles', () => {
      expect(haversineMiles(0, 0, 1, 0)).toBeGreaterThan(69);
      expect(haversineMiles(0, 0, 1, 0)).toBeLessThan(69.2);
    });

    it('handles "within 250 miles of Seaford, Delaware"', () => {
      const geo = radius(SEAFORD_DE, 250, 'Seaford, Delaware');
      expect(withinRadius(PHILADELPHIA.lat, PHILADELPHIA.lon, geo)).toBe(true);
      expect(withinRadius(NEW_YORK.lat, NEW_YORK.lon, geo)).toBe(true);
      expect(withinRadius(BOSTON.lat, BOSTON.lon, geo)).toBe(false);
      expect(withinRadius(SEAFORD_DE.lat, SEAFORD_DE.lon, geo)).toBe(true);
    });

    it('handles "within 70 miles of Schenectady, NY"', () => {
      const geo = radius(SCHENECTADY_NY, 70, 'Schenectady, NY');
      expect(withinRadius(ALBANY.lat, ALBANY.lon, geo)).toBe(true);
      expect(withinRadius(NEW_YORK.lat, NEW_YORK.lon, geo)).toBe(false);
      expect(withinRadius(BOSTON.lat, BOSTON.lon, geo)).toBe(false);
    });

    it('handles "within 175 miles of Erving, MA"', () => {
      const geo = radius(ERVING_MA, 175, 'Erving, MA');
      expect(withinRadius(AMHERST_MA.lat, AMHERST_MA.lon, geo)).toBe(true);
      expect(withinRadius(BOSTON.lat, BOSTON.lon, geo)).toBe(true);
      expect(withinRadius(WASHINGTON_DC.lat, WASHINGTON_DC.lon, geo)).toBe(false);
    });

    it('is false for a non-radius spec or an incomplete centre', () => {
      expect(withinRadius(0, 0, { type: 'state', values: ['DE'] })).toBe(false);
      expect(
        withinRadius(38.6415, -75.6113, { type: 'radius', values: [], radiusMiles: 250 }),
      ).toBe(false);
    });
  });

  describe('callDistrictFromCallsign', () => {
    it('extracts the digit from US callsigns of every prefix length', () => {
      expect(callDistrictFromCallsign('W1AW')).toBe('1');
      expect(callDistrictFromCallsign('K5UTD')).toBe('5');
      expect(callDistrictFromCallsign('KG4ABC')).toBe('4');
      expect(callDistrictFromCallsign('W8UM')).toBe('8');
      expect(callDistrictFromCallsign('  kh6abc ')).toBe('6');
    });

    it('returns undefined for anything that is not a US-shaped callsign', () => {
      expect(callDistrictFromCallsign('2E0ABC')).toBeUndefined();
      expect(callDistrictFromCallsign('')).toBeUndefined();
      expect(callDistrictFromCallsign('NOTACALL')).toBeUndefined();
    });
  });

  describe('evaluateGeo across all five GeoSpec shapes', () => {
    it('passes "any" with no profile data at all', () => {
      expect(evaluateGeo({ type: 'any', values: [] }, {})).toEqual({ status: 'pass', missing: [] });
    });

    it('evaluates state', () => {
      const geo: GeoSpec = { type: 'state', values: ['LA'] };
      expect(evaluateGeo(geo, { state: 'LA' }).status).toBe('pass');
      expect(evaluateGeo(geo, { state: 'la' }).status).toBe('pass');
      expect(evaluateGeo(geo, { state: 'TX' }).status).toBe('fail');
      expect(evaluateGeo(geo, {})).toEqual({ status: 'unknown', missing: ['state'] });
    });

    it('evaluates arrl_division and arrl_section through the lookup table', () => {
      const division: GeoSpec = { type: 'arrl_division', values: ['Central'] };
      expect(evaluateGeo(division, { state: 'WI' }).status).toBe('pass');
      expect(evaluateGeo(division, { state: 'OH' }).status).toBe('fail');

      const section: GeoSpec = { type: 'arrl_section', values: ['Maryland-DC'] };
      expect(evaluateGeo(section, { state: 'DC' }).status).toBe('pass');
      expect(evaluateGeo(section, { state: 'VA' }).status).toBe('fail');
      expect(evaluateGeo(section, {})).toEqual({ status: 'unknown', missing: ['state'] });
    });

    it('evaluates county, including the state qualifier', () => {
      const geo: GeoSpec = { type: 'county', values: ['Travis County, TX', 'Hays County, TX'] };
      expect(evaluateGeo(geo, { county: 'Travis', state: 'TX' }).status).toBe('pass');
      expect(evaluateGeo(geo, { county: 'Travis County', state: 'TX' }).status).toBe('pass');
      expect(evaluateGeo(geo, { county: 'Travis', state: 'CA' }).status).toBe('fail');
      expect(evaluateGeo(geo, { county: 'Bexar', state: 'TX' }).status).toBe('fail');
      expect(evaluateGeo(geo, { county: 'Travis' })).toEqual({ status: 'unknown', missing: ['state'] });
      expect(evaluateGeo(geo, { state: 'TX' })).toEqual({ status: 'unknown', missing: ['county'] });
    });

    it('evaluates radius and reports both missing coordinates', () => {
      const geo = radius(SCHENECTADY_NY, 70, 'Schenectady, NY');
      expect(evaluateGeo(geo, { lat: ALBANY.lat, lon: ALBANY.lon }).status).toBe('pass');
      expect(evaluateGeo(geo, { lat: NEW_YORK.lat, lon: NEW_YORK.lon }).status).toBe('fail');
      expect(evaluateGeo(geo, {})).toEqual({ status: 'unknown', missing: ['lat', 'lon'] });
      expect(evaluateGeo(geo, { lat: 42 })).toEqual({ status: 'unknown', missing: ['lon'] });
    });

    it('evaluates call_district from the field or from the callsign', () => {
      const geo: GeoSpec = { type: 'call_district', values: ['5'] };
      expect(evaluateGeo(geo, { callDistrict: '5' }).status).toBe('pass');
      expect(evaluateGeo(geo, { callsign: 'K5UTD' }).status).toBe('pass');
      expect(evaluateGeo(geo, { callsign: 'W1AW' }).status).toBe('fail');
      expect(evaluateGeo(geo, {})).toEqual({ status: 'unknown', missing: ['callDistrict'] });
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- geo
  ```

  Expected failure: `Failed to resolve import "../src/arrlSections.js"`.

- [ ] **Step 3: Write `packages/core/src/arrlSections.ts`**

  ```ts
  export interface ArrlSection {
    name: string;
    abbrev: string;
    division: string;
    states: string[];
  }

  /** The 15 US ARRL Divisions. Canada left the ARRL Field Organization in 2009. */
  export const ARRL_DIVISIONS: readonly string[] = [
    'Atlantic',
    'Central',
    'Dakota',
    'Delta',
    'Great Lakes',
    'Hudson',
    'Midwest',
    'New England',
    'Northwestern',
    'Pacific',
    'Roanoke',
    'Rocky Mountain',
    'Southeastern',
    'Southwestern',
    'West Gulf',
  ];

  /** The 71 US ARRL Sections, with their official abbreviations. */
  export const ARRL_SECTIONS: readonly ArrlSection[] = [
    { name: 'Delaware', abbrev: 'DE', division: 'Atlantic', states: ['DE'] },
    { name: 'Eastern Pennsylvania', abbrev: 'EPA', division: 'Atlantic', states: ['PA'] },
    { name: 'Maryland-DC', abbrev: 'MDC', division: 'Atlantic', states: ['MD', 'DC'] },
    { name: 'Northern New York', abbrev: 'NNY', division: 'Atlantic', states: ['NY'] },
    { name: 'Southern New Jersey', abbrev: 'SNJ', division: 'Atlantic', states: ['NJ'] },
    { name: 'Western New York', abbrev: 'WNY', division: 'Atlantic', states: ['NY'] },
    { name: 'Western Pennsylvania', abbrev: 'WPA', division: 'Atlantic', states: ['PA'] },

    { name: 'Illinois', abbrev: 'IL', division: 'Central', states: ['IL'] },
    { name: 'Indiana', abbrev: 'IN', division: 'Central', states: ['IN'] },
    { name: 'Wisconsin', abbrev: 'WI', division: 'Central', states: ['WI'] },

    { name: 'Minnesota', abbrev: 'MN', division: 'Dakota', states: ['MN'] },
    { name: 'North Dakota', abbrev: 'ND', division: 'Dakota', states: ['ND'] },
    { name: 'South Dakota', abbrev: 'SD', division: 'Dakota', states: ['SD'] },

    { name: 'Arkansas', abbrev: 'AR', division: 'Delta', states: ['AR'] },
    { name: 'Louisiana', abbrev: 'LA', division: 'Delta', states: ['LA'] },
    { name: 'Mississippi', abbrev: 'MS', division: 'Delta', states: ['MS'] },
    { name: 'Tennessee', abbrev: 'TN', division: 'Delta', states: ['TN'] },

    { name: 'Kentucky', abbrev: 'KY', division: 'Great Lakes', states: ['KY'] },
    { name: 'Michigan', abbrev: 'MI', division: 'Great Lakes', states: ['MI'] },
    { name: 'Ohio', abbrev: 'OH', division: 'Great Lakes', states: ['OH'] },

    { name: 'Eastern New York', abbrev: 'ENY', division: 'Hudson', states: ['NY'] },
    { name: 'NYC-Long Island', abbrev: 'NLI', division: 'Hudson', states: ['NY'] },
    { name: 'Northern New Jersey', abbrev: 'NNJ', division: 'Hudson', states: ['NJ'] },

    { name: 'Iowa', abbrev: 'IA', division: 'Midwest', states: ['IA'] },
    { name: 'Kansas', abbrev: 'KS', division: 'Midwest', states: ['KS'] },
    { name: 'Missouri', abbrev: 'MO', division: 'Midwest', states: ['MO'] },
    { name: 'Nebraska', abbrev: 'NE', division: 'Midwest', states: ['NE'] },

    { name: 'Connecticut', abbrev: 'CT', division: 'New England', states: ['CT'] },
    { name: 'Eastern Massachusetts', abbrev: 'EMA', division: 'New England', states: ['MA'] },
    { name: 'Maine', abbrev: 'ME', division: 'New England', states: ['ME'] },
    { name: 'New Hampshire', abbrev: 'NH', division: 'New England', states: ['NH'] },
    { name: 'Rhode Island', abbrev: 'RI', division: 'New England', states: ['RI'] },
    { name: 'Vermont', abbrev: 'VT', division: 'New England', states: ['VT'] },
    { name: 'Western Massachusetts', abbrev: 'WMA', division: 'New England', states: ['MA'] },

    { name: 'Alaska', abbrev: 'AK', division: 'Northwestern', states: ['AK'] },
    { name: 'Eastern Washington', abbrev: 'EWA', division: 'Northwestern', states: ['WA'] },
    { name: 'Idaho', abbrev: 'ID', division: 'Northwestern', states: ['ID'] },
    { name: 'Montana', abbrev: 'MT', division: 'Northwestern', states: ['MT'] },
    { name: 'Oregon', abbrev: 'OR', division: 'Northwestern', states: ['OR'] },
    { name: 'Western Washington', abbrev: 'WWA', division: 'Northwestern', states: ['WA'] },

    { name: 'East Bay', abbrev: 'EB', division: 'Pacific', states: ['CA'] },
    { name: 'Nevada', abbrev: 'NV', division: 'Pacific', states: ['NV'] },
    { name: 'Pacific', abbrev: 'PAC', division: 'Pacific', states: ['HI', 'AS', 'GU', 'MP'] },
    { name: 'Sacramento Valley', abbrev: 'SV', division: 'Pacific', states: ['CA'] },
    { name: 'San Francisco', abbrev: 'SF', division: 'Pacific', states: ['CA'] },
    { name: 'San Joaquin Valley', abbrev: 'SJV', division: 'Pacific', states: ['CA'] },
    { name: 'Santa Clara Valley', abbrev: 'SCV', division: 'Pacific', states: ['CA'] },

    { name: 'North Carolina', abbrev: 'NC', division: 'Roanoke', states: ['NC'] },
    { name: 'South Carolina', abbrev: 'SC', division: 'Roanoke', states: ['SC'] },
    { name: 'Virginia', abbrev: 'VA', division: 'Roanoke', states: ['VA'] },
    { name: 'West Virginia', abbrev: 'WV', division: 'Roanoke', states: ['WV'] },

    { name: 'Colorado', abbrev: 'CO', division: 'Rocky Mountain', states: ['CO'] },
    { name: 'New Mexico', abbrev: 'NM', division: 'Rocky Mountain', states: ['NM'] },
    { name: 'Utah', abbrev: 'UT', division: 'Rocky Mountain', states: ['UT'] },
    { name: 'Wyoming', abbrev: 'WY', division: 'Rocky Mountain', states: ['WY'] },

    { name: 'Alabama', abbrev: 'AL', division: 'Southeastern', states: ['AL'] },
    { name: 'Georgia', abbrev: 'GA', division: 'Southeastern', states: ['GA'] },
    { name: 'Northern Florida', abbrev: 'NFL', division: 'Southeastern', states: ['FL'] },
    { name: 'Puerto Rico', abbrev: 'PR', division: 'Southeastern', states: ['PR'] },
    { name: 'Southern Florida', abbrev: 'SFL', division: 'Southeastern', states: ['FL'] },
    { name: 'US Virgin Islands', abbrev: 'VI', division: 'Southeastern', states: ['VI'] },
    { name: 'West Central Florida', abbrev: 'WCF', division: 'Southeastern', states: ['FL'] },

    { name: 'Arizona', abbrev: 'AZ', division: 'Southwestern', states: ['AZ'] },
    { name: 'Los Angeles', abbrev: 'LAX', division: 'Southwestern', states: ['CA'] },
    { name: 'Orange', abbrev: 'ORG', division: 'Southwestern', states: ['CA'] },
    { name: 'San Diego', abbrev: 'SDG', division: 'Southwestern', states: ['CA'] },
    { name: 'Santa Barbara', abbrev: 'SB', division: 'Southwestern', states: ['CA'] },

    { name: 'North Texas', abbrev: 'NTX', division: 'West Gulf', states: ['TX'] },
    { name: 'Oklahoma', abbrev: 'OK', division: 'West Gulf', states: ['OK'] },
    { name: 'South Texas', abbrev: 'STX', division: 'West Gulf', states: ['TX'] },
    { name: 'West Texas', abbrev: 'WTX', division: 'West Gulf', states: ['TX'] },
  ];
  ```

- [ ] **Step 4: Write `data/reference/arrl-sections.json`**

  Same data, same order. Generate it from the module rather than retyping it, then commit the generated file:

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && mkdir -p data/reference
  npx tsx -e "
  import { ARRL_DIVISIONS, ARRL_SECTIONS } from './packages/core/src/arrlSections.js';
  import { writeFileSync } from 'node:fs';
  const doc = {
    \$comment: 'ARRL Field Organization: 15 US Divisions and 71 Sections, with official section abbreviations and the states each section covers. Mirrored in packages/core/src/arrlSections.ts because core is pure and cannot read files at runtime; packages/core/test/geo.test.ts fails if the two drift.',
    capturedAt: '2026-08-02',
    divisions: ARRL_DIVISIONS,
    sections: ARRL_SECTIONS,
  };
  writeFileSync('data/reference/arrl-sections.json', JSON.stringify(doc, null, 2) + '\n');
  "
  ```

  If `npx tsx` is not resolvable from the root, run it through the server workspace which depends on it: `npm exec -w @grantspotter/server -- tsx -e "…"`.

- [ ] **Step 5: Write `packages/core/src/geo.ts`**

  ```ts
  import { ARRL_DIVISIONS, ARRL_SECTIONS } from './arrlSections.js';
  import type { GeoSpec } from './types.js';

  /** Mean Earth radius in statute miles (6371.0088 km / 1.609344). */
  const EARTH_RADIUS_MILES = 3958.7613;

  export interface GeoLocation {
    state?: string;
    county?: string;
    lat?: number;
    lon?: number;
    callDistrict?: string;
    callsign?: string;
  }

  export interface GeoDecision {
    status: 'pass' | 'fail' | 'unknown';
    missing: string[];
  }

  const PASS: GeoDecision = { status: 'pass', missing: [] };
  const FAIL: GeoDecision = { status: 'fail', missing: [] };

  /**
   * Lookup key: lowercase, punctuation flattened to single spaces, and a
   * trailing "division"/"section" word dropped, so "Maryland-DC",
   * "maryland dc" and "MARYLAND-DC Section" all agree.
   */
  function normKey(value: string): string {
    return value
      .toLowerCase()
      .replace(/\u00a0/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+(division|section)$/, '')
      .trim();
  }

  const SECTION_BY_KEY = new Map<string, (typeof ARRL_SECTIONS)[number]>();
  for (const section of ARRL_SECTIONS) {
    SECTION_BY_KEY.set(normKey(section.name), section);
    SECTION_BY_KEY.set(normKey(section.abbrev), section);
  }

  const DIVISION_STATES = new Map<string, string[]>();
  for (const division of ARRL_DIVISIONS) {
    const states: string[] = [];
    for (const section of ARRL_SECTIONS) {
      if (section.division !== division) continue;
      for (const state of section.states) if (!states.includes(state)) states.push(state);
    }
    DIVISION_STATES.set(normKey(division), states.sort());
  }

  export function statesForArrlDivision(division: string): string[] {
    const states = DIVISION_STATES.get(normKey(division));
    return states === undefined ? [] : [...states];
  }

  export function statesForArrlSection(section: string): string[] {
    const found = SECTION_BY_KEY.get(normKey(section));
    return found === undefined ? [] : [...found.states];
  }

  export function haversineMiles(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const toRad = (deg: number): number => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  export function withinRadius(lat: number, lon: number, geo: GeoSpec): boolean {
    if (geo.type !== 'radius') return false;
    if (geo.centerLat === undefined || geo.centerLon === undefined) return false;
    if (geo.radiusMiles === undefined) return false;
    return haversineMiles(lat, lon, geo.centerLat, geo.centerLon) <= geo.radiusMiles;
  }

  /** The digit in a US callsign is its call district: W5XYZ is district 5. */
  export function callDistrictFromCallsign(callsign: string): string | undefined {
    const m = /^[A-Z]{1,2}(\d)[A-Z]{1,4}$/.exec(callsign.trim().toUpperCase());
    return m === null ? undefined : m[1];
  }

  function parseCountyValue(value: string): { county: string; state?: string } {
    const parts = value.split(',');
    const county = normKey(parts[0].replace(/\bcounty\b/i, ''));
    if (parts.length < 2) return { county };
    return { county, state: parts[1].trim().toUpperCase() };
  }

  export function evaluateGeo(geo: GeoSpec, loc: GeoLocation): GeoDecision {
    switch (geo.type) {
      case 'any':
        return PASS;

      case 'state': {
        if (loc.state === undefined) return { status: 'unknown', missing: ['state'] };
        const mine = loc.state.trim().toUpperCase();
        return geo.values.some((v) => v.trim().toUpperCase() === mine) ? PASS : FAIL;
      }

      case 'arrl_division': {
        if (loc.state === undefined) return { status: 'unknown', missing: ['state'] };
        const mine = loc.state.trim().toUpperCase();
        return geo.values.some((v) => statesForArrlDivision(v).includes(mine)) ? PASS : FAIL;
      }

      case 'arrl_section': {
        if (loc.state === undefined) return { status: 'unknown', missing: ['state'] };
        const mine = loc.state.trim().toUpperCase();
        return geo.values.some((v) => statesForArrlSection(v).includes(mine)) ? PASS : FAIL;
      }

      case 'county': {
        if (loc.county === undefined) return { status: 'unknown', missing: ['county'] };
        const mine = normKey(loc.county.replace(/\bcounty\b/i, ''));
        let needsState = false;
        for (const value of geo.values) {
          const parsed = parseCountyValue(value);
          if (parsed.county !== mine) continue;
          if (parsed.state === undefined) return PASS;
          if (loc.state === undefined) {
            needsState = true;
            continue;
          }
          if (parsed.state === loc.state.trim().toUpperCase()) return PASS;
        }
        return needsState ? { status: 'unknown', missing: ['state'] } : FAIL;
      }

      case 'radius': {
        if (loc.lat === undefined || loc.lon === undefined) {
          const missing: string[] = [];
          if (loc.lat === undefined) missing.push('lat');
          if (loc.lon === undefined) missing.push('lon');
          return { status: 'unknown', missing };
        }
        return withinRadius(loc.lat, loc.lon, geo) ? PASS : FAIL;
      }

      case 'call_district': {
        const district =
          loc.callDistrict ??
          (loc.callsign === undefined ? undefined : callDistrictFromCallsign(loc.callsign));
        if (district === undefined) return { status: 'unknown', missing: ['callDistrict'] };
        return geo.values.some((v) => v.trim() === district) ? PASS : FAIL;
      }
    }
  }
  ```

- [ ] **Step 6: Extend the barrel**

  Append to `packages/core/src/index.ts`:

  ```ts
  export { ARRL_DIVISIONS, ARRL_SECTIONS } from './arrlSections.js';
  export type { ArrlSection } from './arrlSections.js';
  export {
    callDistrictFromCallsign,
    evaluateGeo,
    haversineMiles,
    statesForArrlDivision,
    statesForArrlSection,
    withinRadius,
  } from './geo.js';
  export type { GeoDecision, GeoLocation } from './geo.js';
  ```

- [ ] **Step 7: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect **20 passing tests** in `geo.test.ts`, the whole run green, and a clean typecheck.

- [ ] **Step 8: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/core data/reference/arrl-sections.json
  git commit -m "feat(core): ARRL Division/Section reference table, haversine radius, all five GeoSpec shapes"
  ```

---
### Task 8: The thirteen eligibility-axis evaluators

Spec §4.5 enumerates thirteen eligibility axes derived from all 111 ARRL catalogue entries plus the non-ARRL programmes. This task builds one total function over them. Task 9 turns axis results into `Verdict`s.

**The four-valued result is the design.** An axis evaluator returns `pass`, `fail`, `unknown`, or `not_evaluable`, and the distinction between the last two is what makes the matcher honest:

- `unknown` — *the profile could answer this but has not.* Task 9 turns a hard `unknown` into `{ kind: 'unknown', missingProfileFields }` and the UI asks for exactly that field.
- `not_evaluable` — *no profile field exists that could ever answer this.* A recommendation-letter requirement, an `other` note, or a student-only axis being asked about a club. It must never block (so hard constraints treat it as a pass) and must never count as a met preference (so soft constraints treat it as unmet).

**Applicability matrix — implement exactly this:**

| axis | student profile | organisation profile | profile fields consulted |
|---|---|---|---|
| `license` | evaluate | `not_evaluable` | `licenseClass`, `licensedSince` |
| `geography` | evaluate | evaluate | `state`, `county`, `lat`/`lon`, `callDistrict`, `callsign` |
| `field_of_study` | evaluate | `not_evaluable` | `fieldOfStudy` |
| `institution` | evaluate | `not_evaluable` | `degreeLevel`, `accredited`, `partTime` |
| `gpa` | evaluate | `not_evaluable` | `gpa`, `classRankTopPct` |
| `arrl_membership` | evaluate | evaluate | `arrlMemberSince` / `arrlAffiliated` |
| `recommendation` | `not_evaluable` | `not_evaluable` | — (shown as a requirement, never scored) |
| `citizenship` | evaluate | `not_evaluable` | `citizenship` |
| `age_stage` | evaluate | `not_evaluable` | `birthDate`, `stage` |
| `ham_activity` | evaluate | `not_evaluable` | `activityKinds`, `cwWpm` |
| `financial_need` | pass iff `financialNeed === true`, else `not_evaluable` — **never `fail`** | `not_evaluable` | `financialNeed` |
| `gender` | evaluate | `not_evaluable` | `gender` |
| `other` | `not_evaluable` | `not_evaluable` | — (`rawText` is surfaced verbatim) |

**Sub-fields with no profile counterpart are informational and never scored:** `license.foreignLicenseOK`, `institution.tradeSchoolOK`, `citizenship.withinMonthsOfCitizenship`, `ham_activity.proofRequired`, `recommendation.count`. CONTRACT §3's `StudentProfile` has no field for any of them, and inventing one would break a frozen type. Plan 3 renders them from `Constraint.rawText`.

**The clock.** CONTRACT §4 freezes `matchProgram(profile, program)`. Age and "licensed for N months" need a clock, so this plan adds an **optional third parameter** `nowISO` that defaults to `new Date().toISOString()`. Existing call shapes still compile; tests get determinism.

**Files:**
- Create: `packages/core/src/matcher.ts`
- Test: `packages/core/test/axes.test.ts`

**Interfaces:**
- Consumes: `evaluateGeo` from `./geo.js`; `ConstraintSpec`, `LicenseClass`, `Profile` from `./types.js`; `makeOrg`, `makeStudent` from `../test/fixtures.js`.
- Produces: PLAN-LOCAL `AxisStatus`, `AxisResult`, `evaluateConstraint(spec: ConstraintSpec, profile: Profile, nowISO: string): AxisResult`, `monthsBetween(fromISO, toISO): number`, `ageAt(birthISO, atISO): number`.

- [ ] **Step 1: Write the failing test**

  Create `packages/core/test/axes.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { ageAt, evaluateConstraint, monthsBetween } from '../src/matcher.js';
  import { makeOrg, makeStudent } from './fixtures.js';

  const NOW = '2027-03-01T00:00:00.000Z';

  describe('date helpers', () => {
    it('counts whole elapsed months', () => {
      expect(monthsBetween('2026-01-15T00:00:00.000Z', '2027-01-14T00:00:00.000Z')).toBe(11);
      expect(monthsBetween('2026-01-15T00:00:00.000Z', '2027-01-16T00:00:00.000Z')).toBe(12);
      expect(monthsBetween('2027-05-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z')).toBe(-4);
    });

    it('computes age in whole years', () => {
      expect(ageAt('2004-07-15T00:00:00.000Z', '2027-06-01T00:00:00.000Z')).toBe(22);
      expect(ageAt('2004-05-15T00:00:00.000Z', '2027-06-01T00:00:00.000Z')).toBe(23);
    });
  });

  describe('license axis', () => {
    it('compares licence class by rank', () => {
      const spec = { axis: 'license', licenseMin: 'GENERAL' } as const;
      expect(evaluateConstraint(spec, makeStudent({ licenseClass: 'EXTRA' }), NOW).status).toBe('pass');
      expect(evaluateConstraint(spec, makeStudent({ licenseClass: 'GENERAL' }), NOW).status).toBe('pass');
      expect(evaluateConstraint(spec, makeStudent({ licenseClass: 'TECH' }), NOW).status).toBe('fail');
    });

    it('is unknown when the licence class is missing, but passes when NONE is required', () => {
      expect(evaluateConstraint({ axis: 'license', licenseMin: 'TECH' }, makeStudent(), NOW)).toEqual({
        status: 'unknown',
        missing: ['licenseClass'],
      });
      expect(evaluateConstraint({ axis: 'license', licenseMin: 'NONE' }, makeStudent(), NOW).status).toBe(
        'pass',
      );
    });

    it('enforces a holding period', () => {
      // ARDC scholarships require the applicant to have been licensed at least a year.
      const spec = { axis: 'license', licenseMin: 'TECH', heldMonthsMin: 12 } as const;
      const short = makeStudent({ licenseClass: 'GENERAL', licensedSince: '2026-06-01T00:00:00.000Z' });
      const long = makeStudent({ licenseClass: 'GENERAL', licensedSince: '2025-06-01T00:00:00.000Z' });
      expect(evaluateConstraint(spec, short, NOW).status).toBe('fail');
      expect(evaluateConstraint(spec, long, NOW).status).toBe('pass');
      expect(
        evaluateConstraint(spec, makeStudent({ licenseClass: 'GENERAL' }), NOW),
      ).toEqual({ status: 'unknown', missing: ['licensedSince'] });
    });

    it('is not evaluable against an organisation profile', () => {
      expect(
        evaluateConstraint({ axis: 'license', licenseMin: 'EXTRA' }, makeOrg(), NOW).status,
      ).toBe('not_evaluable');
    });
  });

  describe('geography axis', () => {
    it('delegates to evaluateGeo for students and organisations alike', () => {
      const spec = { axis: 'geography', geo: { type: 'state', values: ['LA'] } } as const;
      expect(evaluateConstraint(spec, makeStudent({ state: 'LA' }), NOW).status).toBe('pass');
      expect(evaluateConstraint(spec, makeStudent({ state: 'TX' }), NOW).status).toBe('fail');
      expect(evaluateConstraint(spec, makeStudent(), NOW)).toEqual({
        status: 'unknown',
        missing: ['state'],
      });
      expect(evaluateConstraint(spec, makeOrg({ state: 'LA' }), NOW).status).toBe('pass');
    });
  });

  describe('field_of_study axis', () => {
    // A real catalogue entry reads "Any, except for Liberal Arts".
    it('honours exclusions even when the allow-list says Any', () => {
      const spec = {
        axis: 'field_of_study',
        fields: ['Any'],
        excludedFields: ['Liberal Arts'],
      } as const;
      expect(
        evaluateConstraint(spec, makeStudent({ fieldOfStudy: 'Electrical Engineering' }), NOW).status,
      ).toBe('pass');
      expect(
        evaluateConstraint(spec, makeStudent({ fieldOfStudy: 'liberal  arts' }), NOW).status,
      ).toBe('fail');
    });

    it('matches an explicit allow-list and reports a missing field', () => {
      const spec = {
        axis: 'field_of_study',
        fields: ['Electrical Engineering', 'Computer Science'],
        excludedFields: [],
      } as const;
      expect(
        evaluateConstraint(spec, makeStudent({ fieldOfStudy: 'Computer Science' }), NOW).status,
      ).toBe('pass');
      expect(evaluateConstraint(spec, makeStudent({ fieldOfStudy: 'Journalism' }), NOW).status).toBe(
        'fail',
      );
      expect(evaluateConstraint(spec, makeStudent(), NOW)).toEqual({
        status: 'unknown',
        missing: ['fieldOfStudy'],
      });
    });
  });

  describe('institution axis', () => {
    it('checks degree level, accreditation and part-time status', () => {
      const spec = {
        axis: 'institution',
        degreeLevels: ['BACH', 'GRAD'],
        tradeSchoolOK: false,
        partTimeOK: false,
        accreditationRequired: true,
      } as const;
      expect(
        evaluateConstraint(
          spec,
          makeStudent({ degreeLevel: 'BACH', accredited: true, partTime: false }),
          NOW,
        ).status,
      ).toBe('pass');
      expect(
        evaluateConstraint(
          spec,
          makeStudent({ degreeLevel: 'ASSOC', accredited: true, partTime: false }),
          NOW,
        ).status,
      ).toBe('fail');
      expect(
        evaluateConstraint(
          spec,
          makeStudent({ degreeLevel: 'BACH', accredited: true, partTime: true }),
          NOW,
        ).status,
      ).toBe('fail');
      expect(evaluateConstraint(spec, makeStudent({ degreeLevel: 'BACH' }), NOW)).toEqual({
        status: 'unknown',
        missing: ['accredited'],
      });
    });
  });

  describe('gpa axis', () => {
    it('enforces a hard floor', () => {
      const spec = { axis: 'gpa', min: 3 } as const;
      expect(evaluateConstraint(spec, makeStudent({ gpa: 3.2 }), NOW).status).toBe('pass');
      expect(evaluateConstraint(spec, makeStudent({ gpa: 2.9 }), NOW).status).toBe('fail');
      expect(evaluateConstraint(spec, makeStudent(), NOW)).toEqual({
        status: 'unknown',
        missing: ['gpa'],
      });
    });

    // YASME asks for the top 5-10% of the class instead of a GPA number.
    it('accepts a class-rank route as an alternative to GPA', () => {
      const spec = { axis: 'gpa', min: 3.5, classRankTopPct: 10 } as const;
      expect(
        evaluateConstraint(spec, makeStudent({ gpa: 3.1, classRankTopPct: 5 }), NOW).status,
      ).toBe('pass');
      expect(
        evaluateConstraint(spec, makeStudent({ gpa: 3.1, classRankTopPct: 40 }), NOW).status,
      ).toBe('fail');
      expect(evaluateConstraint(spec, makeStudent({ gpa: 3.1 }), NOW)).toEqual({
        status: 'unknown',
        missing: ['classRankTopPct'],
      });
    });
  });

  describe('arrl_membership axis', () => {
    it('enforces the two intensities for a student', () => {
      const member = { axis: 'arrl_membership', required: true, minYears: 0 } as const;
      const veteran = { axis: 'arrl_membership', required: true, minYears: 1 } as const;
      const recent = makeStudent({ arrlMemberSince: '2026-06-01T00:00:00.000Z' });
      const older = makeStudent({ arrlMemberSince: '2025-06-01T00:00:00.000Z' });
      expect(evaluateConstraint(member, recent, NOW).status).toBe('pass');
      expect(evaluateConstraint(veteran, recent, NOW).status).toBe('fail');
      expect(evaluateConstraint(veteran, older, NOW).status).toBe('pass');
      expect(evaluateConstraint(veteran, makeStudent(), NOW)).toEqual({
        status: 'unknown',
        missing: ['arrlMemberSince'],
      });
    });

    it('uses arrlAffiliated for organisations and is not evaluable when not required', () => {
      const spec = { axis: 'arrl_membership', required: true, minYears: 1 } as const;
      expect(evaluateConstraint(spec, makeOrg({ arrlAffiliated: true }), NOW).status).toBe('pass');
      expect(evaluateConstraint(spec, makeOrg({ arrlAffiliated: false }), NOW).status).toBe('fail');
      expect(evaluateConstraint(spec, makeOrg(), NOW)).toEqual({
        status: 'unknown',
        missing: ['arrlAffiliated'],
      });
      expect(
        evaluateConstraint(
          { axis: 'arrl_membership', required: false, minYears: 0 },
          makeStudent(),
          NOW,
        ).status,
      ).toBe('not_evaluable');
    });
  });

  describe('citizenship axis', () => {
    it('treats a US citizen as satisfying a US-resident requirement', () => {
      const residents = { axis: 'citizenship', allowed: ['US_RESIDENT'] } as const;
      expect(evaluateConstraint(residents, makeStudent({ citizenship: 'US_CITIZEN' }), NOW).status).toBe(
        'pass',
      );
      const citizens = { axis: 'citizenship', allowed: ['US_CITIZEN'] } as const;
      expect(evaluateConstraint(citizens, makeStudent({ citizenship: 'US_RESIDENT' }), NOW).status).toBe(
        'fail',
      );
      expect(
        evaluateConstraint({ axis: 'citizenship', allowed: ['ANY'] }, makeStudent(), NOW).status,
      ).toBe('pass');
      expect(evaluateConstraint(citizens, makeStudent(), NOW)).toEqual({
        status: 'unknown',
        missing: ['citizenship'],
      });
    });
  });

  describe('age_stage axis', () => {
    // YCCC: "22 or younger as of June 1".
    it('measures age at the constraint’s asOf date', () => {
      const spec = { axis: 'age_stage', ageMax: 22, asOf: '06-01', stages: [] } as const;
      expect(evaluateConstraint(spec, makeStudent({ birthDate: '2004-07-15' }), NOW).status).toBe('pass');
      expect(evaluateConstraint(spec, makeStudent({ birthDate: '2004-05-15' }), NOW).status).toBe('fail');
    });

    it('checks stage membership and reports both missing fields', () => {
      const spec = {
        axis: 'age_stage',
        ageMin: 17,
        ageMax: 25,
        stages: ['UNDERGRAD', 'HS_SENIOR'],
      } as const;
      expect(
        evaluateConstraint(spec, makeStudent({ stage: 'UNDERGRAD', birthDate: '2006-01-01' }), NOW)
          .status,
      ).toBe('pass');
      expect(
        evaluateConstraint(spec, makeStudent({ stage: 'GRAD', birthDate: '2006-01-01' }), NOW).status,
      ).toBe('fail');
      expect(evaluateConstraint(spec, makeStudent(), NOW)).toEqual({
        status: 'unknown',
        missing: ['stage', 'birthDate'],
      });
    });
  });

  describe('ham_activity axis', () => {
    it('needs at least one matching activity kind', () => {
      const spec = {
        axis: 'ham_activity',
        activityKinds: ['ares_races_skywarn', 'field_day'],
        proofRequired: true,
      } as const;
      expect(
        evaluateConstraint(spec, makeStudent({ activityKinds: ['field_day', 'on_air'] }), NOW).status,
      ).toBe('pass');
      expect(evaluateConstraint(spec, makeStudent({ activityKinds: ['teaching'] }), NOW).status).toBe(
        'fail',
      );
      expect(evaluateConstraint(spec, makeStudent(), NOW)).toEqual({
        status: 'unknown',
        missing: ['activityKinds'],
      });
    });

    // CWops requires an ARRL Code Proficiency certificate of at least 15 wpm.
    it('enforces a CW speed floor', () => {
      const spec = {
        axis: 'ham_activity',
        activityKinds: [],
        cwProficiencyWpmMin: 15,
        proofRequired: true,
      } as const;
      expect(evaluateConstraint(spec, makeStudent({ cwWpm: 20 }), NOW).status).toBe('pass');
      expect(evaluateConstraint(spec, makeStudent({ cwWpm: 10 }), NOW).status).toBe('fail');
    });
  });

  describe('financial_need, gender, recommendation and other axes', () => {
    // Spec §4.5 rule 11: financial need is always a weighting, never a bar.
    it('never fails on financial need', () => {
      const spec = { axis: 'financial_need', weighted: true } as const;
      expect(evaluateConstraint(spec, makeStudent({ financialNeed: true }), NOW).status).toBe('pass');
      expect(evaluateConstraint(spec, makeStudent({ financialNeed: false }), NOW).status).toBe(
        'not_evaluable',
      );
      expect(evaluateConstraint(spec, makeStudent(), NOW).status).toBe('not_evaluable');
    });

    // YLRL is the only gendered programme in the corpus.
    it('resolves gender, and refuses to guess for "other" or "prefer not to say"', () => {
      const spec = { axis: 'gender', allowed: ['female'] } as const;
      expect(evaluateConstraint(spec, makeStudent({ gender: 'female' }), NOW).status).toBe('pass');
      expect(evaluateConstraint(spec, makeStudent({ gender: 'male' }), NOW).status).toBe('fail');
      expect(evaluateConstraint(spec, makeStudent({ gender: 'other' }), NOW)).toEqual({
        status: 'unknown',
        missing: ['gender'],
      });
      expect(evaluateConstraint(spec, makeStudent({ gender: 'prefer_not_to_say' }), NOW)).toEqual({
        status: 'unknown',
        missing: ['gender'],
      });
      expect(
        evaluateConstraint({ axis: 'gender', allowed: ['any'] }, makeStudent(), NOW).status,
      ).toBe('pass');
    });

    it('never scores recommendation or other', () => {
      expect(
        evaluateConstraint(
          { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 3 },
          makeStudent(),
          NOW,
        ).status,
      ).toBe('not_evaluable');
      expect(
        evaluateConstraint(
          { axis: 'other', note: 'preference to a student ham from a ham family' },
          makeStudent(),
          NOW,
        ).status,
      ).toBe('not_evaluable');
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- axes
  ```

  Expected failure: `Failed to resolve import "../src/matcher.js"`.

- [ ] **Step 3: Write `packages/core/src/matcher.ts` (evaluator half)**

  ```ts
  import { evaluateGeo } from './geo.js';
  import type {
    ActivityKind,
    Citizenship,
    ConstraintSpec,
    DegreeLevel,
    LicenseClass,
    OrgProfile,
    Profile,
    Stage,
    StudentProfile,
  } from './types.js';

  export type AxisStatus = 'pass' | 'fail' | 'unknown' | 'not_evaluable';

  export interface AxisResult {
    status: AxisStatus;
    /** Profile fields that would resolve an `unknown`. Empty otherwise. */
    missing: string[];
  }

  const PASS: AxisResult = { status: 'pass', missing: [] };
  const FAIL: AxisResult = { status: 'fail', missing: [] };
  const NOT_EVALUABLE: AxisResult = { status: 'not_evaluable', missing: [] };

  function unknown(...fields: string[]): AxisResult {
    return { status: 'unknown', missing: fields };
  }

  const LICENSE_RANK: Record<LicenseClass, number> = { NONE: 0, TECH: 1, GENERAL: 2, EXTRA: 3 };

  /** Whole calendar months from `fromISO` to `toISO`; negative if `toISO` is earlier. */
  export function monthsBetween(fromISO: string, toISO: string): number {
    const from = new Date(fromISO);
    const to = new Date(toISO);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;
    let months =
      (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
    if (to.getUTCDate() < from.getUTCDate()) months -= 1;
    return months;
  }

  export function ageAt(birthISO: string, atISO: string): number {
    return Math.floor(monthsBetween(birthISO, atISO) / 12);
  }

  /**
   * `asOf` is either an MM-DD (resolved against the current year, e.g. YCCC's
   * "22 or younger as of June 1") or a full ISO date. Anything else falls back
   * to "now".
   */
  function asOfDateISO(asOf: string | undefined, nowISO: string): string {
    if (asOf === undefined) return nowISO;
    if (/^\d{2}-\d{2}$/.test(asOf)) {
      const year = new Date(nowISO).getUTCFullYear();
      return `${year}-${asOf}T00:00:00.000Z`;
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(asOf)) return asOf;
    return nowISO;
  }

  function normText(value: string): string {
    return value
      .toLowerCase()
      .replace(/\u00a0/g, ' ')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isStudent(profile: Profile): profile is StudentProfile {
    return profile.kind === 'student';
  }

  function isOrg(profile: Profile): profile is OrgProfile {
    return profile.kind === 'organization';
  }

  export function evaluateConstraint(
    spec: ConstraintSpec,
    profile: Profile,
    nowISO: string,
  ): AxisResult {
    switch (spec.axis) {
      case 'license': {
        if (!isStudent(profile)) return NOT_EVALUABLE;
        const needed = LICENSE_RANK[spec.licenseMin];
        if (needed > 0) {
          if (profile.licenseClass === undefined) return unknown('licenseClass');
          if (LICENSE_RANK[profile.licenseClass] < needed) return FAIL;
        }
        if (spec.heldMonthsMin !== undefined && spec.heldMonthsMin > 0) {
          if (profile.licensedSince === undefined) return unknown('licensedSince');
          if (monthsBetween(profile.licensedSince, nowISO) < spec.heldMonthsMin) return FAIL;
        }
        // foreignLicenseOK is informational: CONTRACT §3 has no profile field for it.
        return PASS;
      }

      case 'geography': {
        const decision = evaluateGeo(spec.geo, {
          state: profile.state,
          county: isStudent(profile) ? profile.county : undefined,
          lat: profile.lat,
          lon: profile.lon,
          callDistrict: isStudent(profile) ? profile.callDistrict : undefined,
          callsign: profile.callsign,
        });
        return { status: decision.status, missing: decision.missing };
      }

      case 'field_of_study': {
        if (!isStudent(profile)) return NOT_EVALUABLE;
        if (profile.fieldOfStudy === undefined) {
          if (spec.fields.length === 0 && spec.excludedFields.length === 0) return PASS;
          return unknown('fieldOfStudy');
        }
        const mine = normText(profile.fieldOfStudy);
        if (spec.excludedFields.some((f) => normText(f) === mine)) return FAIL;
        if (spec.fields.length === 0) return PASS;
        if (spec.fields.some((f) => normText(f) === 'any')) return PASS;
        return spec.fields.some((f) => normText(f) === mine) ? PASS : FAIL;
      }

      case 'institution': {
        if (!isStudent(profile)) return NOT_EVALUABLE;
        if (spec.degreeLevels.length > 0) {
          if (profile.degreeLevel === undefined) return unknown('degreeLevel');
          const levels: DegreeLevel[] = spec.degreeLevels;
          if (!levels.includes(profile.degreeLevel)) return FAIL;
        }
        if (spec.accreditationRequired) {
          if (profile.accredited === undefined) return unknown('accredited');
          if (!profile.accredited) return FAIL;
        }
        if (!spec.partTimeOK) {
          if (profile.partTime === undefined) return unknown('partTime');
          if (profile.partTime) return FAIL;
        }
        // tradeSchoolOK is informational: CONTRACT §3 has no profile field for it.
        return PASS;
      }

      case 'gpa': {
        if (!isStudent(profile)) return NOT_EVALUABLE;
        const results: AxisStatus[] = [];
        const missing: string[] = [];
        if (spec.min !== undefined) {
          if (profile.gpa === undefined) {
            results.push('unknown');
            missing.push('gpa');
          } else {
            results.push(profile.gpa >= spec.min ? 'pass' : 'fail');
          }
        }
        if (spec.classRankTopPct !== undefined) {
          if (profile.classRankTopPct === undefined) {
            results.push('unknown');
            missing.push('classRankTopPct');
          } else {
            results.push(profile.classRankTopPct <= spec.classRankTopPct ? 'pass' : 'fail');
          }
        }
        if (results.length === 0) return PASS;
        if (results.includes('pass')) return PASS; // either route satisfies the axis
        if (results.includes('unknown')) return { status: 'unknown', missing };
        return FAIL;
      }

      case 'arrl_membership': {
        if (!spec.required) return NOT_EVALUABLE;
        if (isOrg(profile)) {
          if (profile.arrlAffiliated === undefined) return unknown('arrlAffiliated');
          return profile.arrlAffiliated ? PASS : FAIL;
        }
        if (profile.arrlMemberSince === undefined) return unknown('arrlMemberSince');
        if (spec.minYears > 0 && monthsBetween(profile.arrlMemberSince, nowISO) < spec.minYears * 12) {
          return FAIL;
        }
        return PASS;
      }

      case 'recommendation':
        // No profile field can answer this. Plan 3 renders Constraint.rawText.
        return NOT_EVALUABLE;

      case 'citizenship': {
        if (!isStudent(profile)) return NOT_EVALUABLE;
        const allowed: Citizenship[] = spec.allowed;
        if (allowed.includes('ANY')) return PASS;
        if (profile.citizenship === undefined) return unknown('citizenship');
        if (allowed.includes(profile.citizenship)) return PASS;
        if (profile.citizenship === 'US_CITIZEN' && allowed.includes('US_RESIDENT')) return PASS;
        // withinMonthsOfCitizenship is informational: no profile field exists.
        return FAIL;
      }

      case 'age_stage': {
        if (!isStudent(profile)) return NOT_EVALUABLE;
        const missing: string[] = [];
        let failed = false;
        const stages: Stage[] = spec.stages;
        if (stages.length > 0) {
          if (profile.stage === undefined) missing.push('stage');
          else if (!stages.includes(profile.stage)) failed = true;
        }
        if (spec.ageMin !== undefined || spec.ageMax !== undefined) {
          if (profile.birthDate === undefined) {
            missing.push('birthDate');
          } else {
            const age = ageAt(profile.birthDate, asOfDateISO(spec.asOf, nowISO));
            if (spec.ageMin !== undefined && age < spec.ageMin) failed = true;
            if (spec.ageMax !== undefined && age > spec.ageMax) failed = true;
          }
        }
        if (failed) return FAIL;
        if (missing.length > 0) return { status: 'unknown', missing };
        return PASS;
      }

      case 'ham_activity': {
        if (!isStudent(profile)) return NOT_EVALUABLE;
        const missing: string[] = [];
        let failed = false;
        const mine = profile.activityKinds;
        const wanted: ActivityKind[] = spec.activityKinds;
        if (wanted.length > 0) {
          if (mine === undefined) missing.push('activityKinds');
          else if (!wanted.some((k) => mine.includes(k))) failed = true;
        }
        if (spec.cwProficiencyWpmMin !== undefined) {
          if (profile.cwWpm === undefined) missing.push('cwWpm');
          else if (profile.cwWpm < spec.cwProficiencyWpmMin) failed = true;
        }
        if (failed) return FAIL;
        if (missing.length > 0) return { status: 'unknown', missing };
        // proofRequired is informational.
        return PASS;
      }

      case 'financial_need': {
        // Spec §4.5 rule 11: always a weighting, never a bar. This axis can
        // never return `fail`, whatever `Constraint.hard` says.
        if (!isStudent(profile)) return NOT_EVALUABLE;
        return profile.financialNeed === true ? PASS : NOT_EVALUABLE;
      }

      case 'gender': {
        if (!isStudent(profile)) return NOT_EVALUABLE;
        if (spec.allowed.includes('any')) return PASS;
        if (
          profile.gender === undefined ||
          profile.gender === 'other' ||
          profile.gender === 'prefer_not_to_say'
        ) {
          // Refuse to guess. The UI shows the funder's own wording instead.
          return unknown('gender');
        }
        return spec.allowed.includes(profile.gender) ? PASS : FAIL;
      }

      case 'other':
        // Long-tail requirements no schema captures. Plan 3 renders rawText.
        return NOT_EVALUABLE;
    }
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect **22 passing tests** in `axes.test.ts`, the whole run green, and a clean typecheck.

- [ ] **Step 5: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/core
  git commit -m "feat(core): four-valued evaluators for all thirteen eligibility axes"
  ```

---
### Task 9: `matchProgram` and `matchAll` — the verdict rules

**The two load-bearing rules, stated once and enforced by tests.**

1. **Soft constraints (`hard: false`) never exclude. They rank.** Nearly every eligibility axis in this corpus appears in both requirement *and* preference form, frequently as an explicit cascade. The canonical wording, straight from the ARRL catalogue:

   > *"Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, …"*

   Treating that as a hard filter wrongly excludes a Texan who is genuinely eligible. `fallbackRank` orders the cascade: `0` is the primary preference, higher numbers come later.

2. **Missing profile data yields `unknown`, never `ineligible`.** The UI's job is then to ask for the one field that would resolve it. Guessing "ineligible" from an empty profile would make the whole tool untrustworthy.

**Verdict precedence — implement exactly this order:**

1. The **applicant-entity gate**. A student profile applies as `individual`; an organisation profile applies as its `entity`. If `program.applicantEntities` does not include it → `ineligible`, with a single **synthesised** `Constraint` explaining what the program does accept. (This is how RCA is handled: its `applicantEntities` is `['nominated_by_institution']` because the university selects the recipient and the student never applies to RCA at all.)
2. Any **hard** constraint returning `fail` → `ineligible` with *every* failing hard constraint in `reasons`. Definite ineligibility outranks uncertainty.
3. Any **hard** constraint returning `unknown` → `{ kind: 'unknown', missingProfileFields }`, sorted and de-duplicated.
4. Any **soft** constraint returning `pass` → `{ kind: 'eligible_preferred', rank, met }` where `rank` is the *lowest* `fallbackRank` among the passing soft constraints and `met` is their sorted ids.
5. Otherwise → `{ kind: 'eligible' }`.

Hard constraints returning `not_evaluable` are treated as passes (they cannot block). Soft constraints returning `fail`, `unknown` or `not_evaluable` are simply unmet — a soft `unknown` must **not** turn the whole verdict into `unknown`, or every preference in the corpus would demand a profile field before showing any result.

`financial_need` is forced soft regardless of its `hard` flag, per spec §4.5 rule 11.

**Files:**
- Modify: `packages/core/src/matcher.ts` (append)
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/matcher.test.ts`

**Interfaces:**
- Consumes: `evaluateConstraint` from `./matcher.js`; `ApplicantEntity`, `Constraint`, `Profile`, `Program`, `Verdict` from `./types.js`; `makeConstraint`, `makeOrg`, `makeProgram`, `makeStudent` from `../test/fixtures.js`.
- Produces: `matchProgram(profile: Profile, program: Program, nowISO?: string): Verdict` and `matchAll(profile: Profile, programs: Program[], nowISO?: string): Map<string, Verdict>` (CONTRACT §4, with an additive optional clock parameter); PLAN-LOCAL `APPLICANT_ENTITY_CONSTRAINT_SUFFIX`.

- [ ] **Step 1: Write the failing test**

  Create `packages/core/test/matcher.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { APPLICANT_ENTITY_CONSTRAINT_SUFFIX, matchAll, matchProgram } from '../src/matcher.js';
  import { makeConstraint, makeOrg, makeProgram, makeStudent } from './fixtures.js';

  const NOW = '2027-03-01T00:00:00.000Z';

  describe('matchProgram — baseline', () => {
    it('is eligible when a program has no constraints', () => {
      expect(matchProgram(makeStudent(), makeProgram(), NOW)).toEqual({ kind: 'eligible' });
    });

    it('works without an explicit clock', () => {
      expect(matchProgram(makeStudent(), makeProgram()).kind).toBe('eligible');
    });
  });

  describe('matchProgram — the applicant-entity gate', () => {
    it('refuses a student for a program only an institution can nominate', () => {
      // RCA: the university selects the recipient; the student never applies.
      const rca = makeProgram({
        id: 'rca-scholarships',
        name: 'RCA Scholarship Program',
        applicantEntities: ['nominated_by_institution'],
      });
      const verdict = matchProgram(makeStudent(), rca, NOW);
      expect(verdict.kind).toBe('ineligible');
      if (verdict.kind !== 'ineligible') throw new Error('unreachable');
      expect(verdict.reasons).toHaveLength(1);
      expect(verdict.reasons[0].id).toBe(`rca-scholarships${APPLICANT_ENTITY_CONSTRAINT_SUFFIX}`);
      expect(verdict.reasons[0].hard).toBe(true);
      expect(verdict.reasons[0].rawText).toContain('nominated_by_institution');
    });

    it('refuses a 501(c)(3) club for a program that only funds via a fiscal sponsor', () => {
      // ARDC requires clubs and individuals to apply through a fiscal sponsor.
      const ardc = makeProgram({
        id: 'ardc-grants',
        applicantEntities: ['club_via_fiscal_sponsor', 'university', 'school_lea'],
      });
      expect(matchProgram(makeOrg({ entity: 'club_501c3' }), ardc, NOW).kind).toBe('ineligible');
      expect(matchProgram(makeOrg({ entity: 'university' }), ardc, NOW).kind).toBe('eligible');
    });

    it('refuses an organisation for an individuals-only scholarship', () => {
      expect(matchProgram(makeOrg(), makeProgram(), NOW).kind).toBe('ineligible');
    });
  });

  describe('matchProgram — hard constraints', () => {
    it('reports every failing hard constraint', () => {
      const program = makeProgram({
        constraints: [
          makeConstraint(
            { axis: 'geography', geo: { type: 'state', values: ['TX'] } },
            { id: 'geo', hard: true },
          ),
          makeConstraint({ axis: 'gpa', min: 3.5 }, { id: 'gpa', hard: true }),
          makeConstraint({ axis: 'license', licenseMin: 'TECH' }, { id: 'lic', hard: true }),
        ],
      });
      const student = makeStudent({ state: 'OH', gpa: 2.0, licenseClass: 'EXTRA' });
      const verdict = matchProgram(student, program, NOW);
      expect(verdict.kind).toBe('ineligible');
      if (verdict.kind !== 'ineligible') throw new Error('unreachable');
      expect(verdict.reasons.map((c) => c.id).sort()).toEqual(['geo', 'gpa']);
    });

    it('prefers a definite failure over an unknown', () => {
      const program = makeProgram({
        constraints: [
          makeConstraint({ axis: 'gpa', min: 3.5 }, { id: 'gpa', hard: true }),
          makeConstraint({ axis: 'citizenship', allowed: ['US_CITIZEN'] }, { id: 'cit', hard: true }),
        ],
      });
      const verdict = matchProgram(makeStudent({ gpa: 2.0 }), program, NOW);
      expect(verdict.kind).toBe('ineligible');
      if (verdict.kind !== 'ineligible') throw new Error('unreachable');
      expect(verdict.reasons.map((c) => c.id)).toEqual(['gpa']);
    });

    it('returns unknown with the sorted, de-duplicated fields that would resolve it', () => {
      const program = makeProgram({
        constraints: [
          makeConstraint({ axis: 'gpa', min: 3 }, { id: 'gpa', hard: true }),
          makeConstraint({ axis: 'license', licenseMin: 'GENERAL' }, { id: 'lic', hard: true }),
          makeConstraint({ axis: 'license', licenseMin: 'EXTRA' }, { id: 'lic2', hard: true }),
        ],
      });
      expect(matchProgram(makeStudent(), program, NOW)).toEqual({
        kind: 'unknown',
        missingProfileFields: ['gpa', 'licenseClass'],
      });
    });

    it('does not let a not-evaluable hard constraint block anyone', () => {
      const program = makeProgram({
        constraints: [
          makeConstraint(
            { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 3 },
            { id: 'rec', hard: true },
          ),
          makeConstraint(
            { axis: 'other', note: 'preference to a student ham from a ham family' },
            { id: 'oth', hard: true },
          ),
        ],
      });
      expect(matchProgram(makeStudent(), program, NOW)).toEqual({ kind: 'eligible' });
    });
  });

  describe('matchProgram — the preference cascade', () => {
    // "Preference will be given to applicants residing in Louisiana. If no
    // qualified applicant is identified, ..." — a soft constraint, not a filter.
    const louisiana = makeProgram({
      constraints: [
        makeConstraint(
          { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
          {
            id: 'pref-la',
            hard: false,
            fallbackRank: 0,
            rawText:
              'Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, the award may be made to an applicant from any state.',
          },
        ),
      ],
    });

    it('ranks a Louisiana applicant as preferred', () => {
      expect(matchProgram(makeStudent({ state: 'LA' }), louisiana, NOW)).toEqual({
        kind: 'eligible_preferred',
        rank: 0,
        met: ['pref-la'],
      });
    });

    it('does NOT exclude an applicant from another state', () => {
      expect(matchProgram(makeStudent({ state: 'TX' }), louisiana, NOW)).toEqual({
        kind: 'eligible',
      });
    });

    it('does NOT turn an unanswerable preference into unknown', () => {
      expect(matchProgram(makeStudent(), louisiana, NOW)).toEqual({ kind: 'eligible' });
    });

    it('takes the lowest fallbackRank among the met preferences', () => {
      const program = makeProgram({
        constraints: [
          makeConstraint(
            { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
            { id: 'p0', hard: false, fallbackRank: 0 },
          ),
          makeConstraint(
            { axis: 'arrl_membership', required: true, minYears: 0 },
            { id: 'p2', hard: false, fallbackRank: 2 },
          ),
          makeConstraint({ axis: 'gpa', min: 3.5 }, { id: 'p5', hard: false, fallbackRank: 5 }),
        ],
      });
      const student = makeStudent({
        state: 'LA',
        arrlMemberSince: '2020-01-01T00:00:00.000Z',
        gpa: 2.1,
      });
      expect(matchProgram(student, program, NOW)).toEqual({
        kind: 'eligible_preferred',
        rank: 0,
        met: ['p0', 'p2'],
      });
    });

    it('falls back to the later preference when the primary is not met', () => {
      const program = makeProgram({
        constraints: [
          makeConstraint(
            { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
            { id: 'p0', hard: false, fallbackRank: 0 },
          ),
          makeConstraint({ axis: 'gpa', min: 3 }, { id: 'p3', hard: false, fallbackRank: 3 }),
        ],
      });
      expect(matchProgram(makeStudent({ state: 'TX', gpa: 3.4 }), program, NOW)).toEqual({
        kind: 'eligible_preferred',
        rank: 3,
        met: ['p3'],
      });
    });

    it('never excludes on financial need even when the constraint is marked hard', () => {
      const program = makeProgram({
        constraints: [
          makeConstraint(
            { axis: 'financial_need', weighted: true },
            { id: 'need', hard: true, fallbackRank: 1 },
          ),
        ],
      });
      expect(matchProgram(makeStudent({ financialNeed: false }), program, NOW)).toEqual({
        kind: 'eligible',
      });
      expect(matchProgram(makeStudent({ financialNeed: true }), program, NOW)).toEqual({
        kind: 'eligible_preferred',
        rank: 1,
        met: ['need'],
      });
    });
  });

  describe('matchAll', () => {
    it('keys verdicts by program id and preserves input order', () => {
      const open = makeProgram({ id: 'open' });
      const texanOnly = makeProgram({
        id: 'texan',
        constraints: [
          makeConstraint(
            { axis: 'geography', geo: { type: 'state', values: ['TX'] } },
            { id: 'tx', hard: true },
          ),
        ],
      });
      const results = matchAll(makeStudent({ state: 'OH' }), [open, texanOnly], NOW);
      expect([...results.keys()]).toEqual(['open', 'texan']);
      expect(results.get('open')).toEqual({ kind: 'eligible' });
      expect(results.get('texan')?.kind).toBe('ineligible');
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- matcher
  ```

  Expected failure: `"matchProgram" is not exported by "packages/core/src/matcher.ts"`.

- [ ] **Step 3: Append the verdict code to `packages/core/src/matcher.ts`**

  ```ts
  import type { ApplicantEntity, Constraint, Program, Verdict } from './types.js';

  export const APPLICANT_ENTITY_CONSTRAINT_SUFFIX = ':applicant-entity';

  function applicantEntityConstraint(program: Program, applyingAs: ApplicantEntity): Constraint {
    const accepted =
      program.applicantEntities.length > 0
        ? program.applicantEntities.join(', ')
        : '(none recorded)';
    return {
      id: `${program.id}${APPLICANT_ENTITY_CONSTRAINT_SUFFIX}`,
      hard: true,
      fallbackRank: 0,
      rawText: `This program accepts applications from: ${accepted}.`,
      spec: {
        axis: 'other',
        note: `Your profile applies as "${applyingAs}", which this program does not accept.`,
      },
    };
  }

  export function matchProgram(
    profile: Profile,
    program: Program,
    nowISO: string = new Date().toISOString(),
  ): Verdict {
    const applyingAs: ApplicantEntity = isStudent(profile) ? 'individual' : profile.entity;
    if (!program.applicantEntities.includes(applyingAs)) {
      return { kind: 'ineligible', reasons: [applicantEntityConstraint(program, applyingAs)] };
    }

    const hardFailures: Constraint[] = [];
    const missingFields = new Set<string>();
    const metPreferences: Constraint[] = [];

    for (const constraint of program.constraints) {
      // Financial need is always a weighting, never a bar (spec §4.5 rule 11),
      // so it is forced soft whatever the record says.
      const isSoft = !constraint.hard || constraint.spec.axis === 'financial_need';
      const result = evaluateConstraint(constraint.spec, profile, nowISO);

      if (isSoft) {
        if (result.status === 'pass') metPreferences.push(constraint);
        continue;
      }
      if (result.status === 'fail') hardFailures.push(constraint);
      else if (result.status === 'unknown') for (const field of result.missing) missingFields.add(field);
      // 'pass' and 'not_evaluable' do not block.
    }

    if (hardFailures.length > 0) return { kind: 'ineligible', reasons: hardFailures };
    if (missingFields.size > 0) {
      return { kind: 'unknown', missingProfileFields: [...missingFields].sort() };
    }
    if (metPreferences.length > 0) {
      return {
        kind: 'eligible_preferred',
        rank: Math.min(...metPreferences.map((c) => c.fallbackRank)),
        met: metPreferences.map((c) => c.id).sort(),
      };
    }
    return { kind: 'eligible' };
  }

  export function matchAll(
    profile: Profile,
    programs: Program[],
    nowISO: string = new Date().toISOString(),
  ): Map<string, Verdict> {
    const verdicts = new Map<string, Verdict>();
    for (const program of programs) verdicts.set(program.id, matchProgram(profile, program, nowISO));
    return verdicts;
  }
  ```

  Merge the new `import type` line into the existing one at the top of `matcher.ts`, so there is a single import listing `ActivityKind, ApplicantEntity, Citizenship, Constraint, ConstraintSpec, DegreeLevel, LicenseClass, OrgProfile, Profile, Program, Stage, StudentProfile, Verdict`.

- [ ] **Step 4: Extend the barrel**

  Append to `packages/core/src/index.ts`:

  ```ts
  export {
    ageAt,
    APPLICANT_ENTITY_CONSTRAINT_SUFFIX,
    evaluateConstraint,
    matchAll,
    matchProgram,
    monthsBetween,
  } from './matcher.js';
  export type { AxisResult, AxisStatus } from './matcher.js';
  ```

- [ ] **Step 5: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck && npm run build
  ```

  Expect **16 passing tests** in `matcher.test.ts`, the whole run green, a clean typecheck and a clean build.

- [ ] **Step 6: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/core
  git commit -m "feat(core): matchProgram verdicts, applicant-entity gate, and the soft preference cascade"
  ```

---
### Task 10: The core public API surface and its conformance test

Plans 2–5 import from `@grantspotter/core`. This task makes the barrel the *contract boundary* and adds a test that fails if any CONTRACT §4 signature stops being exported or changes shape. It also asserts that internals stay internal: `sha256Hex` is deliberately not part of the public surface.

**Files:**
- Modify: `packages/core/src/index.ts` (final, consolidated form)
- Test: `packages/core/test/contract.test.ts`

**Interfaces:**
- Consumes: every core module written in Tasks 2–9.
- Produces: the frozen public surface of `@grantspotter/core`.

- [ ] **Step 1: Write the failing test**

  Create `packages/core/test/contract.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import * as core from '../src/index.js';
  import type { Profile, Program, Verdict } from '../src/index.js';
  import { makeProgram, makeStudent } from './fixtures.js';

  describe('@grantspotter/core public surface', () => {
    it('exports every CONTRACT §4 function', () => {
      const required = [
        'parseAmount',
        'expandCycles',
        'resolveDeadlineOwner',
        'statesForArrlDivision',
        'statesForArrlSection',
        'withinRadius',
        'matchProgram',
        'matchAll',
        'hashProgram',
      ];
      for (const name of required) {
        expect(typeof (core as unknown as Record<string, unknown>)[name], name).toBe('function');
      }
      expect(required).toHaveLength(9);
    });

    it('keeps internals internal', () => {
      expect('sha256Hex' in core).toBe(false);
    });

    it('exports the zod schemas the server validates JSON columns with', () => {
      for (const name of [
        'programSchema',
        'constraintSpecSchema',
        'amountSpecSchema',
        'obligationsSchema',
        'profileSchema',
        'cycleSchema',
        'funderSchema',
        'trustFieldsSchema',
      ]) {
        expect(
          typeof (core as unknown as Record<string, { parse?: unknown }>)[name]?.parse,
          name,
        ).toBe('function');
      }
    });

    it('is callable end to end through the barrel alone', () => {
      const program: Program = makeProgram({
        id: 'ardc-grants',
        applicantEntities: ['university'],
        deadline: {
          kind: 'n_fixed_dates',
          source: { kind: 'self' },
          note: 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01',
        },
      });
      const profile: Profile = makeStudent({ state: 'CA' });

      expect(core.parseAmount('$500-$5,000')).toEqual({ amountMin: 500, amountMax: 5000 });
      expect(core.hashProgram(program)).toMatch(/^[0-9a-f]{64}$/);
      expect(core.resolveDeadlineOwner(program, [program]).id).toBe('ardc-grants');
      expect(
        core.expandCycles(program, [program], '2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z'),
      ).toHaveLength(4);
      expect(core.statesForArrlDivision('Central')).toEqual(['IL', 'IN', 'WI']);
      expect(core.statesForArrlSection('MDC')).toEqual(['MD', 'DC']);
      expect(
        core.withinRadius(42.6526, -73.7562, {
          type: 'radius',
          values: [],
          centerLat: 42.8142,
          centerLon: -73.9396,
          radiusMiles: 70,
        }),
      ).toBe(true);

      const verdict: Verdict = core.matchProgram(profile, program, '2027-03-01T00:00:00.000Z');
      expect(verdict.kind).toBe('ineligible'); // a student cannot apply as a university
      expect(core.matchAll(profile, [program], '2027-03-01T00:00:00.000Z').size).toBe(1);
    });

    it('re-exports the domain types Plans 2-5 depend on', () => {
      // Type-only assertions: these fail at compile time, not at run time.
      const status: core.ProgramStatus = 'unknown';
      const kind: core.DeadlineKind = 'inherited';
      const entity: core.ApplicantEntity = 'club_via_fiscal_sponsor';
      const change: core.ChangeKind = 'parse_yield_dropped';
      const tier: core.SourceTier = 'C';
      expect([status, kind, entity, change, tier]).toHaveLength(5);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- contract
  ```

  Expected failure: at minimum `expect('sha256Hex' in core).toBe(false)` passes but the barrel is currently assembled from eight separate append steps; the test surfaces any name that was missed. If everything happens to be present, rewrite `index.ts` as in Step 3 anyway — the consolidated form is the deliverable.

- [ ] **Step 3: Replace `packages/core/src/index.ts` with its consolidated form**

  ```ts
  export const CORE_VERSION = '0.1.0';

  // Domain types (CONTRACT §3) and their zod mirrors.
  export * from './types.js';
  export * from './schema.js';

  // Reference data.
  export { ARRL_DIVISIONS, ARRL_SECTIONS } from './arrlSections.js';
  export type { ArrlSection } from './arrlSections.js';

  // CONTRACT §4 — amounts.
  export { AWARD_ANCHOR, NON_AWARD_CONTEXT_TERMS, parseAmount } from './amount.js';

  // CONTRACT §4 — deadlines, plus the RECUR notation Plans 2 and 5 emit.
  export {
    DEFAULT_CLOSE_TIME,
    DEFAULT_OPEN_TIME,
    expandCycles,
    parseRecurrence,
    RECURRENCE_PREFIX,
    RecurrenceParseError,
    resolveDeadlineOwner,
    zonedWallTimeToUtcISO,
  } from './deadline.js';
  export type { DateWindow, MonthDay, Recurrence, TimeOfDay } from './deadline.js';

  // CONTRACT §4 — geography.
  export {
    callDistrictFromCallsign,
    evaluateGeo,
    haversineMiles,
    statesForArrlDivision,
    statesForArrlSection,
    withinRadius,
  } from './geo.js';
  export type { GeoDecision, GeoLocation } from './geo.js';

  // CONTRACT §4 — matcher.
  export {
    ageAt,
    APPLICANT_ENTITY_CONSTRAINT_SUFFIX,
    evaluateConstraint,
    matchAll,
    matchProgram,
    monthsBetween,
  } from './matcher.js';
  export type { AxisResult, AxisStatus } from './matcher.js';

  // CONTRACT §4 — content hashing. sha256.ts stays internal on purpose.
  export { hashProgram } from './hash.js';
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck && npm run build
  ```

  Expect **5 passing tests** in `contract.test.ts`, the whole run green, a clean typecheck, and `packages/core/dist/index.d.ts` containing all nine CONTRACT §4 signatures.

- [ ] **Step 5: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/core
  git commit -m "feat(core): consolidate the public barrel and assert CONTRACT §4 conformance"
  ```

---
### Task 11: Server configuration and the `SESSION_SECRET` refusal

**Why `SESSION_SECRET` has no default.** A default secret is a published secret. This repo follows the same rule as ham-net-assistant's `JWT_SECRET`: the process refuses to start rather than boot insecurely. `CONTACT_URL` is also required, for a different reason — it goes into the crawler's User-Agent so the ~25 small nonprofits this app polls can identify and contact the operator. A crawler with no contact address is the kind of thing that gets a hobby project blocked.

**Files:**
- Create: `packages/server/src/config.ts`
- Test: `packages/server/test/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AppConfig`, `ConfigError`, `MIN_SESSION_SECRET_LENGTH`, `SERVER_VERSION`, `loadConfig(env?): AppConfig`, `buildUserAgent(source: AppConfig | string): string` — Plan 2's fetcher takes its `FetchOptions.userAgent` and `contactUrl` from these.

**`buildUserAgent` is defined exactly once, here (RESOLUTIONS R10).** Plan 2's `fetcher/index.ts` previously declared a second copy taking a bare `contactUrl` string and returning a different string; that copy is deleted and Plan 2 imports this one from `../config.js`. The signature is therefore widened to accept **either** an `AppConfig` or a bare contact-URL string, so the fetcher's string-only test call sites keep working against one implementation and one output string. Two User-Agents depending on the call path is exactly the kind of drift the ~25 nonprofits we poll would see as two different crawlers.

- [ ] **Step 1: Write the failing test**

  Create `packages/server/test/config.test.ts`:

  ```ts
  import { describe, expect, it } from 'vitest';
  import { buildUserAgent, ConfigError, loadConfig } from '../src/config.js';

  const VALID = {
    SESSION_SECRET: 'a'.repeat(32),
    CONTACT_URL: 'https://example.org/grantspotter',
  };

  describe('loadConfig', () => {
    it('refuses to start with no SESSION_SECRET', () => {
      expect(() => loadConfig({ CONTACT_URL: VALID.CONTACT_URL })).toThrow(ConfigError);
      expect(() => loadConfig({ CONTACT_URL: VALID.CONTACT_URL })).toThrow(
        /SESSION_SECRET is required and has no default/,
      );
    });

    it('refuses an empty or whitespace SESSION_SECRET', () => {
      expect(() => loadConfig({ ...VALID, SESSION_SECRET: '' })).toThrow(ConfigError);
      expect(() => loadConfig({ ...VALID, SESSION_SECRET: '    ' })).toThrow(ConfigError);
    });

    it('refuses a short SESSION_SECRET', () => {
      expect(() => loadConfig({ ...VALID, SESSION_SECRET: 'tooshort' })).toThrow(
        /at least 32 characters; got 8/,
      );
    });

    it('refuses a missing or malformed CONTACT_URL', () => {
      expect(() => loadConfig({ SESSION_SECRET: VALID.SESSION_SECRET })).toThrow(
        /CONTACT_URL is required and has no default/,
      );
      expect(() => loadConfig({ ...VALID, CONTACT_URL: 'not a url' })).toThrow(
        /CONTACT_URL must be an http\(s\) URL/,
      );
      expect(() => loadConfig({ ...VALID, CONTACT_URL: 'ftp://example.org' })).toThrow(ConfigError);
    });

    it('applies the CONTRACT §7 defaults', () => {
      const config = loadConfig(VALID);
      expect(config.port).toBe(3030);
      expect(config.dataDir).toBe('/data');
      expect(config.crawlEnabled).toBe(true);
      expect(config.crawlCron).toBe('17 3 * * *');
      expect(config.nodeEnv).toBe('development');
      expect(config.anthropicApiKey).toBeUndefined();
      expect(config.simplerGrantsApiKey).toBeUndefined();
    });

    it('reads every overridable variable', () => {
      const config = loadConfig({
        ...VALID,
        PORT: '4100',
        DATA_DIR: '/srv/grantspotter-data',
        CRAWL_ENABLED: 'false',
        CRAWL_CRON: '0 4 * * *',
        NODE_ENV: 'production',
        ANTHROPIC_API_KEY: 'sk-test',
        SIMPLER_GRANTS_API_KEY: 'key-test',
      });
      expect(config.port).toBe(4100);
      expect(config.dataDir).toBe('/srv/grantspotter-data');
      expect(config.crawlEnabled).toBe(false);
      expect(config.crawlCron).toBe('0 4 * * *');
      expect(config.nodeEnv).toBe('production');
      expect(config.anthropicApiKey).toBe('sk-test');
      expect(config.simplerGrantsApiKey).toBe('key-test');
    });

    it('rejects a nonsense PORT or CRAWL_ENABLED rather than guessing', () => {
      expect(() => loadConfig({ ...VALID, PORT: 'abc' })).toThrow(/PORT must be an integer/);
      expect(() => loadConfig({ ...VALID, PORT: '70000' })).toThrow(ConfigError);
      expect(() => loadConfig({ ...VALID, CRAWL_ENABLED: 'maybe' })).toThrow(
        /CRAWL_ENABLED must be "true" or "false"/,
      );
    });

    it('ignores blank optional keys instead of storing empty strings', () => {
      const config = loadConfig({ ...VALID, ANTHROPIC_API_KEY: '', SIMPLER_GRANTS_API_KEY: '   ' });
      expect(config.anthropicApiKey).toBeUndefined();
      expect(config.simplerGrantsApiKey).toBeUndefined();
    });
  });

  describe('buildUserAgent', () => {
    // RESOLUTIONS R10: one definition, one output string. Plan 2 imports this
    // function instead of declaring its own.
    const EXPECTED =
      'GrantSpotter/0.1.0 (+https://example.org/grantspotter; nightly grant-deadline change detector)';

    it('names the app and carries the contact URL', () => {
      // Plan 2's fetcher sends this on every request. Politeness §7.1.3.
      expect(buildUserAgent(loadConfig(VALID))).toBe(EXPECTED);
    });

    it('accepts a bare contact URL and produces the identical string', () => {
      // Plan 2's fetcher tests call the string form; both forms must agree.
      expect(buildUserAgent('https://example.org/grantspotter')).toBe(EXPECTED);
      expect(buildUserAgent(loadConfig(VALID))).toBe(buildUserAgent(VALID.CONTACT_URL));
    });

    it('refuses to build an anonymous User-Agent', () => {
      expect(() => buildUserAgent('')).toThrow(/CONTACT_URL is required/);
      expect(() => buildUserAgent('   ')).toThrow(/CONTACT_URL is required/);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- config
  ```

  Expected failure: `Failed to resolve import "../src/config.js"`.

- [ ] **Step 3: Write `packages/server/src/config.ts`**

  ```ts
  export type NodeEnv = 'development' | 'test' | 'production';

  export interface AppConfig {
    nodeEnv: NodeEnv;
    port: number;
    sessionSecret: string;
    contactUrl: string;
    dataDir: string;
    crawlEnabled: boolean;
    crawlCron: string;
    anthropicApiKey?: string;
    simplerGrantsApiKey?: string;
  }

  export class ConfigError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConfigError';
    }
  }

  export const MIN_SESSION_SECRET_LENGTH = 32;
  export const SERVER_VERSION = '0.1.0';

  type Env = Record<string, string | undefined>;

  function optional(env: Env, key: string): string | undefined {
    const raw = env[key];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }

  function parseBool(env: Env, key: string, fallback: boolean): boolean {
    const raw = optional(env, key);
    if (raw === undefined) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new ConfigError(`${key} must be "true" or "false"; got "${raw}".`);
  }

  function parsePort(env: Env, key: string, fallback: number): number {
    const raw = optional(env, key);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new ConfigError(`${key} must be an integer between 1 and 65535; got "${raw}".`);
    }
    return value;
  }

  function parseNodeEnv(env: Env): NodeEnv {
    const raw = optional(env, 'NODE_ENV');
    if (raw === 'production' || raw === 'test' || raw === 'development') return raw;
    return 'development';
  }

  export function loadConfig(env: Env = process.env): AppConfig {
    const sessionSecret = optional(env, 'SESSION_SECRET');
    if (sessionSecret === undefined) {
      throw new ConfigError(
        'SESSION_SECRET is required and has no default. Generate one with: openssl rand -hex 32',
      );
    }
    if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
      throw new ConfigError(
        `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters; got ${sessionSecret.length}.`,
      );
    }

    const contactUrl = optional(env, 'CONTACT_URL');
    if (contactUrl === undefined) {
      throw new ConfigError(
        'CONTACT_URL is required and has no default. Set it to a URL identifying the operator; it goes in the crawler User-Agent so the nonprofits we poll can contact you.',
      );
    }
    let parsedContact: URL;
    try {
      parsedContact = new URL(contactUrl);
    } catch {
      throw new ConfigError(`CONTACT_URL must be an http(s) URL; got "${contactUrl}".`);
    }
    if (parsedContact.protocol !== 'http:' && parsedContact.protocol !== 'https:') {
      throw new ConfigError(`CONTACT_URL must be an http(s) URL; got "${contactUrl}".`);
    }

    const config: AppConfig = {
      nodeEnv: parseNodeEnv(env),
      port: parsePort(env, 'PORT', 3030),
      sessionSecret,
      contactUrl,
      dataDir: optional(env, 'DATA_DIR') ?? '/data',
      crawlEnabled: parseBool(env, 'CRAWL_ENABLED', true),
      crawlCron: optional(env, 'CRAWL_CRON') ?? '17 3 * * *',
    };

    const anthropicApiKey = optional(env, 'ANTHROPIC_API_KEY');
    if (anthropicApiKey !== undefined) config.anthropicApiKey = anthropicApiKey;
    const simplerGrantsApiKey = optional(env, 'SIMPLER_GRANTS_API_KEY');
    if (simplerGrantsApiKey !== undefined) config.simplerGrantsApiKey = simplerGrantsApiKey;

    return config;
  }

  /**
   * Descriptive, identifiable User-Agent. Spec §7.1 rule 3.
   *
   * RESOLUTIONS R10: this is the ONLY definition in the repository. It accepts
   * either the loaded config or a bare contact URL so Plan 2's fetcher (whose
   * call sites pass a string) imports this rather than declaring a second one.
   */
  export function buildUserAgent(source: AppConfig | string): string {
    const url = typeof source === 'string' ? source : source.contactUrl;
    if (!url.trim()) {
      throw new Error('CONTACT_URL is required: the crawler User-Agent must name a contact URL.');
    }
    return `GrantSpotter/${SERVER_VERSION} (+${url}; nightly grant-deadline change detector)`;
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect **11 passing tests** in `config.test.ts`, the whole run green, and a clean typecheck.

- [ ] **Step 5: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/server
  git commit -m "feat(server): environment configuration with a mandatory SESSION_SECRET and CONTACT_URL"
  ```

---
### Task 12: SQLite schema, migrations, and `migrate.ts`

CONTRACT §6: SQLite via `better-sqlite3`, WAL, plain `.sql` migrations in `packages/server/src/db/migrations/NNN-*.sql` applied in order by `migrate.ts`, no ORM. All fifteen tables are created now even though Plan 1 only writes repositories for seven of them — a half-applied schema is worse than a complete one, and Plans 2–5 must not each invent their own migration.

**Two gotchas that will otherwise cost an hour each:**

- **`PRAGMA foreign_keys` belongs on the connection, not in a migration file.** SQLite silently ignores it inside a transaction, and `migrate.ts` wraps every migration in one. It is set in `openDatabase`.
- **`.sql` files are not copied by `tsc`.** `packages/server/scripts/copy-sql.mjs` (written in Task 1) copies `src/db/migrations` into `dist/db/migrations` as part of `npm run build`, and `MIGRATIONS_DIR` is resolved from `import.meta.url` so it works from both source and `dist`.

**Four shapes in this DDL are settled by RESOLUTIONS and must be written exactly as given** — Plans 2, 3 and 4 already contain code that reads and writes them, and `CREATE TABLE IF NOT EXISTS` in a later plan is a silent no-op against a table this file already created, so a mismatch surfaces as a runtime `no such column` on the first crawl rather than at typecheck:

- **R1/R9 — `programs` carries `source_id` and `external_key`** plus a partial unique index. The seed corpus owns program identity; without these two columns the nightly crawler mints a fresh synthetic id for every seeded record and duplicates the whole corpus every night.
- **R2 — `review_items.candidate_json`** (not `candidate`), and `created_at` gains `DEFAULT ''` because Plan 2's insert omits it.
- **R3 — `snapshots` takes Plan 2's shape**: `INTEGER PRIMARY KEY AUTOINCREMENT`, `body_bytes`, nullable `file_path`, no `body_path`.
- **R24 — `applications` and `template_instances` carry Plan 4's column list, adopted verbatim**: `answers_json`, `fact_confirmations_json`, `include_disclosure`, `facts_confirmed_at`, a **nullable** `program_id`, and on `template_instances` `position` / `filled_markdown` / `unresolved_slots_json`. There is no `status` and no `facts` column, and `template_instances` has no `markdown`, `unresolved_slots` or `updated_at`. **Plan 1 is the sole owner of both tables.** Plan 4 ships no migration for these tables; it asserts this shape with `assertApplicationSchema(db)` in `db/repositories/applications.ts` — it creates neither table and re-declares neither index. `idx_applications_user` and `idx_template_instances_application` exist exactly once — here.

The DDL below was executed against `better-sqlite3` on this host: all fifteen tables create cleanly, the cascade from `programs` to `constraints` was verified, and so were the two cascades and the `ON DELETE SET NULL` that R24's tables add.

**Files:**
- Create: `packages/server/src/db/migrations/001-init.sql`, `packages/server/src/db/migrate.ts`
- Create: `packages/server/test/helpers/tempDb.ts`
- Test: `packages/server/test/migrate.test.ts`

**Interfaces:**
- Consumes: `better-sqlite3`.
- Produces: `Db` (alias for `Database.Database`), `openDatabase(filePath: string): Db`, `migrate(db: Db, dir?: string): MigrationResult`, `MIGRATIONS_DIR`; and the test helper `createTestDb(): TestDb`.

- [ ] **Step 1: Write the failing test**

  Create `packages/server/test/helpers/tempDb.ts`:

  ```ts
  import { mkdtempSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import type { Db } from '../../src/db/migrate.js';
  import { migrate, openDatabase } from '../../src/db/migrate.js';

  export interface TestDb {
    db: Db;
    dir: string;
    cleanup(): void;
  }

  /** A migrated SQLite database in a throwaway temp directory. */
  export function createTestDb(): TestDb {
    const dir = mkdtempSync(join(tmpdir(), 'grantspotter-test-'));
    const db = openDatabase(join(dir, 'grantspotter.sqlite'));
    migrate(db);
    return {
      db,
      dir,
      cleanup(): void {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }
  ```

  Create `packages/server/test/migrate.test.ts`:

  ```ts
  import { mkdtempSync, rmSync } from 'node:fs';
  import { tmpdir } from 'node:os';
  import { join } from 'node:path';
  import { afterEach, describe, expect, it } from 'vitest';
  import { migrate, openDatabase } from '../src/db/migrate.js';
  import { createTestDb, type TestDb } from './helpers/tempDb.js';

  const EXPECTED_TABLES = [
    'applications',
    'audit_log',
    'change_events',
    'constraints',
    'cycles',
    'funders',
    'profiles',
    'programs',
    'review_items',
    'sessions',
    'snapshots',
    'sources',
    'template_instances',
    'users',
    'watches',
  ];

  let harness: TestDb | undefined;
  afterEach(() => {
    harness?.cleanup();
    harness = undefined;
  });

  function tableNames(db: TestDb['db']): string[] {
    return db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name",
      )
      .all()
      .map((row) => (row as { name: string }).name);
  }

  describe('migrate', () => {
    it('creates all fifteen CONTRACT §6 tables', () => {
      harness = createTestDb();
      // Containment, not equality: CONTRACT §6 also blesses `review_rejects`
      // (Plan 2) and `ics_tokens` (Plan 5, migration 090-ics-tokens.sql), and
      // migrate() applies every .sql in the directory. Asserting equality here
      // would turn Plan 5's migration into a Plan 1 test failure.
      expect(EXPECTED_TABLES).toHaveLength(15);
      const present = tableNames(harness.db);
      expect(EXPECTED_TABLES.filter((t) => !present.includes(t))).toEqual([]);
    });

    it('records what it applied and is idempotent', () => {
      const dir = mkdtempSync(join(tmpdir(), 'grantspotter-mig-'));
      try {
        const db = openDatabase(join(dir, 'db.sqlite'));
        const first = migrate(db);
        expect(first.applied).toContain('001-init.sql');
        expect(first.alreadyApplied).toEqual([]);

        const second = migrate(db);
        expect(second.applied).toEqual([]);
        expect(second.alreadyApplied).toEqual(first.applied);

        const rows = db.prepare('SELECT name FROM schema_migrations').all();
        expect(rows).toHaveLength(first.applied.length);
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('opens the database in WAL mode', () => {
      const dir = mkdtempSync(join(tmpdir(), 'grantspotter-wal-'));
      try {
        const db = openDatabase(join(dir, 'db.sqlite'));
        expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
        db.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('enforces foreign keys on the connection, including cascade delete', () => {
      harness = createTestDb();
      const { db } = harness;
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

      expect(() =>
        db
          .prepare('INSERT INTO cycles (id, program_id, timezone, label, is_estimated) VALUES (?,?,?,?,0)')
          .run('c1', 'no-such-program', 'America/New_York', 'orphan'),
      ).toThrow(/FOREIGN KEY constraint failed/);

      db.prepare(
        'INSERT INTO funders (id, name, homepage, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('f1', 'ARRL Foundation', 'https://www.arrl.org/arrl-foundation', 'now', 'now');
      db.prepare(
        `INSERT INTO programs (id, funder_id, name, klass, summary, applicant_entities, amount,
          deadline, apply_via, funding_restrictions, obligations, ai_policy, trust, raw_other_text,
          tags, content_hash, status, last_verified_at, created_at, updated_at)
         VALUES ('p1','f1','X','ham_grant','s','[]','{}','{}','page_form','[]','{}','{}','{}','','[]','h','open','now','now','now')`,
      ).run();
      db.prepare(
        'INSERT INTO constraints (id, program_id, ordinal, hard, fallback_rank, raw_text, axis, spec) VALUES (?,?,0,1,0,?,?,?)',
      ).run('k1', 'p1', 'raw', 'license', '{}');

      db.prepare('DELETE FROM programs WHERE id = ?').run('p1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM constraints').get()).toEqual({ n: 0 });
    });

    it('enforces the role CHECK and the uniqueness rules the API depends on', () => {
      harness = createTestDb();
      const { db } = harness;
      const insertUser = db.prepare(
        'INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at) VALUES (?,?,?,?,?,?,?)',
      );
      insertUser.run('u1', 'A@Example.org', 'a@example.org', 'hash', 'admin', 'tok1', 'now');

      expect(() =>
        insertUser.run('u2', 'a@example.org', 'a@example.org', 'hash', 'member', 'tok2', 'now'),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        insertUser.run('u3', 'c@example.org', 'c@example.org', 'hash', 'wizard', 'tok3', 'now'),
      ).toThrow(/CHECK constraint failed/);

      const insertProfile = db.prepare(
        'INSERT INTO profiles (id, user_id, kind, data, updated_at) VALUES (?,?,?,?,?)',
      );
      insertProfile.run('pr1', 'u1', 'student', '{"kind":"student"}', 'now');
      expect(() => insertProfile.run('pr2', 'u1', 'student', '{"kind":"student"}', 'now')).toThrow(
        /UNIQUE constraint failed/,
      );
      // one student profile AND one org profile per user is allowed
      expect(() =>
        insertProfile.run('pr3', 'u1', 'organization', '{"kind":"organization"}', 'now'),
      ).not.toThrow();
    });

    // RESOLUTIONS R1/R2/R3. These three shapes are consumed verbatim by Plans 2
    // and 3; the statements below are the exact ones those plans run, so a
    // silent rename here fails this test instead of the first nightly crawl.
    it('accepts the ingest statements Plans 2 and 3 actually run', () => {
      harness = createTestDb();
      const { db } = harness;

      db.prepare(
        'INSERT INTO funders (id, name, homepage, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('ardc', 'ARDC', 'https://www.ardc.net/', 'now', 'now');
      db.prepare(
        'INSERT INTO sources (id, label, tier, klass) VALUES (?,?,?,?)',
      ).run('ardc-grants', 'ARDC grants page', 'B', 'ham_grant');

      // R3: no id, no body_path, body_bytes and a nullable file_path.
      const insertSnapshot = db.prepare(
        `INSERT INTO snapshots (source_id, url, status, content_type, body_sha256, body_bytes, file_path, fetched_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      );
      const info = insertSnapshot.run(
        'ardc-grants',
        'https://www.ardc.net/apply/',
        200,
        'text/html',
        'a'.repeat(64),
        4096,
        null,
        '2026-08-02T00:00:00.000Z',
      );
      expect(typeof info.lastInsertRowid).toBe('number');

      // R1: the ingest-identity columns and their partial unique index.
      const insertProgram = db.prepare(
        `INSERT INTO programs (id, funder_id, name, klass, summary, applicant_entities, amount,
           deadline, apply_via, funding_restrictions, obligations, ai_policy, trust, raw_other_text,
           tags, source_id, external_key, content_hash, status, last_verified_at, created_at, updated_at)
         VALUES (?,'ardc','X','ham_grant','s','[]','{}','{}','page_form','[]','{}','{}','{}','','[]',?,?,'h','open','now','now','now')`,
      );
      insertProgram.run('ardc-grants', 'ardc-grants', 'grants');
      expect(() => insertProgram.run('dupe', 'ardc-grants', 'grants')).toThrow(
        /UNIQUE constraint failed/,
      );
      // A different externalKey under the same source is fine...
      expect(() => insertProgram.run('other', 'ardc-grants', 'award-tables')).not.toThrow();
      // ...and the index is partial, so hand-curated rows with no source do not
      // collide with each other on (NULL, NULL).
      expect(() => insertProgram.run('manual-a', null, null)).not.toThrow();
      expect(() => insertProgram.run('manual-b', null, null)).not.toThrow();

      expect(
        db
          .prepare('SELECT id FROM programs WHERE source_id = ? AND external_key = ?')
          .get('ardc-grants', 'grants'),
      ).toEqual({ id: 'ardc-grants' });

      // R2: candidate_json, and created_at is defaulted rather than supplied.
      db.prepare(
        'INSERT INTO change_events (id, source_id, kind, detected_at) VALUES (?,?,?,?)',
      ).run('ce1', 'ardc-grants', 'deadline_changed', '2026-08-02T00:00:00.000Z');
      expect(() =>
        db
          .prepare(
            'INSERT INTO review_items (id, change_event_id, candidate_json, confidence, reject_key) VALUES (?,?,?,?,?)',
          )
          .run('ri1', 'ce1', '{"id":"ardc-grants"}', 0.8, 'ardc-grants|deadline'),
      ).not.toThrow();
      expect(
        db.prepare('SELECT candidate_json, created_at, decision FROM review_items WHERE id = ?').get('ri1'),
      ).toEqual({ candidate_json: '{"id":"ardc-grants"}', created_at: '', decision: 'pending' });
    });

    // RESOLUTIONS R24. Plan 4 ships no migration for these tables; it asserts
    // this shape with assertApplicationSchema(db) in
    // db/repositories/applications.ts, so this is the one place the two shapes
    // are actually created and therefore proven. The INSERTs below
    // are Plan 4's own statements — createApplication() in
    // db/repositories/applications.ts and Plan 4's template_instances insert —
    // column for column.
    it('stores application drafts and template instances in Plan 4 columns', () => {
      harness = createTestDb();
      const { db } = harness;

      db.prepare(
        'INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run('u1', 'a@example.org', 'a@example.org', 'hash', 'member', 'tok1', 'now');
      db.prepare(
        'INSERT INTO funders (id, name, homepage, created_at, updated_at) VALUES (?,?,?,?,?)',
      ).run('ardc', 'ARDC', 'https://www.ardc.net/', 'now', 'now');
      db.prepare(
        `INSERT INTO programs (id, funder_id, name, klass, summary, applicant_entities, amount,
           deadline, apply_via, funding_restrictions, obligations, ai_policy, trust, raw_other_text,
           tags, content_hash, status, last_verified_at, created_at, updated_at)
         VALUES ('ardc-grants','ardc','ARDC Grants Program','ham_grant','s','[]','{}','{}',
           'external_spa_portal','[]','{}','{}','{}','','[]','h','open','now','now','now')`,
      ).run();

      db.prepare(
        `INSERT INTO applications (id, user_id, program_id, title, body_markdown, answers_json,
           fact_confirmations_json, include_disclosure, facts_confirmed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', '{}', '{}', 1, NULL, ?, ?)`,
      ).run('app-1', 'u1', 'ardc-grants', 'ARDC station rebuild', 'now', 'now');
      db.prepare(
        `INSERT INTO template_instances (id, application_id, template_id, position,
           filled_markdown, unresolved_slots_json, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run('ti-1', 'app-1', 'need-statement', 0, '# Need statement', '["budget_total"]', 'now');

      expect(
        db
          .prepare(
            `SELECT program_id, body_markdown, answers_json, fact_confirmations_json,
               include_disclosure, facts_confirmed_at FROM applications WHERE id = ?`,
          )
          .get('app-1'),
      ).toEqual({
        program_id: 'ardc-grants',
        body_markdown: '',
        answers_json: '{}',
        fact_confirmations_json: '{}',
        include_disclosure: 1,
        facts_confirmed_at: null,
      });
      expect(
        db
          .prepare(
            'SELECT position, filled_markdown, unresolved_slots_json FROM template_instances WHERE id = ?',
          )
          .get('ti-1'),
      ).toEqual({
        position: 0,
        filled_markdown: '# Need statement',
        unresolved_slots_json: '["budget_total"]',
      });

      // program_id is nullable: a draft exists before a programme is chosen,
      // and the defaults cover every column Plan 4 omits on that path.
      db.prepare(
        `INSERT INTO applications (id, user_id, program_id, title, created_at, updated_at)
         VALUES ('app-2','u1',NULL,'Untitled draft','now','now')`,
      ).run();
      expect(
        db.prepare('SELECT answers_json, include_disclosure FROM applications WHERE id = ?').get('app-2'),
      ).toEqual({ answers_json: '{}', include_disclosure: 1 });

      // Approving a `vanished` review item deletes the programme (R26). The
      // draft survives with a null programme rather than blocking the delete.
      db.prepare('DELETE FROM programs WHERE id = ?').run('ardc-grants');
      expect(db.prepare('SELECT program_id FROM applications WHERE id = ?').get('app-1')).toEqual({
        program_id: null,
      });

      // Deleting the owner takes the drafts and their template instances too.
      db.prepare('DELETE FROM users WHERE id = ?').run('u1');
      expect(db.prepare('SELECT COUNT(*) AS n FROM applications').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM template_instances').get()).toEqual({ n: 0 });
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- migrate
  ```

  Expected failure: `Failed to resolve import "../src/db/migrate.js"`.

- [ ] **Step 3: Write `packages/server/src/db/migrations/001-init.sql`**

  ```sql
  -- GrantSpotter initial schema. CONTRACT §6.
  -- NOTE: PRAGMA foreign_keys is set on the connection in migrate.ts, not here:
  -- SQLite ignores it inside the transaction that wraps each migration.

  CREATE TABLE funders (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    homepage    TEXT NOT NULL,
    ein         TEXT,
    note        TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );

  CREATE TABLE programs (
    id                   TEXT PRIMARY KEY,
    funder_id            TEXT NOT NULL REFERENCES funders(id) ON DELETE CASCADE,
    name                 TEXT NOT NULL,
    klass                TEXT NOT NULL,
    summary              TEXT NOT NULL,
    applicant_entities   TEXT NOT NULL,   -- JSON ApplicantEntity[]
    amount               TEXT NOT NULL,   -- JSON AmountSpec
    deadline             TEXT NOT NULL,   -- JSON DeadlineSpec
    apply_via            TEXT NOT NULL,
    apply_url            TEXT,
    apply_contact        TEXT,
    funding_restrictions TEXT NOT NULL,   -- JSON string[]
    obligations          TEXT NOT NULL,   -- JSON Obligations
    ai_policy            TEXT NOT NULL,   -- JSON AiPolicy
    trust                TEXT NOT NULL,   -- JSON TrustFields
    raw_other_text       TEXT NOT NULL,
    tags                 TEXT NOT NULL,   -- JSON string[]
    -- Ingest identity (RESOLUTIONS R1/R9). The seed corpus owns program ids;
    -- the nightly crawler resolves an existing row through (source_id,
    -- external_key) instead of minting a fresh synthetic id, which would
    -- duplicate the entire corpus every night. Nullable: hand-curated records
    -- that no source module produces have neither.
    source_id            TEXT,
    external_key         TEXT,
    -- denormalised from `trust` so the browse list can filter and sort in SQL
    content_hash         TEXT NOT NULL,
    status               TEXT NOT NULL,
    last_verified_at     TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
  );
  CREATE INDEX idx_programs_funder ON programs(funder_id);
  CREATE INDEX idx_programs_klass  ON programs(klass);
  CREATE INDEX idx_programs_status ON programs(status);
  -- Partial: many rows have no source at all, and SQLite treats every NULL as
  -- distinct in a plain UNIQUE index, so the WHERE clause keeps the index small
  -- and its intent explicit.
  CREATE UNIQUE INDEX programs_source_key ON programs(source_id, external_key) WHERE source_id IS NOT NULL;

  CREATE TABLE constraints (
    id            TEXT PRIMARY KEY,
    program_id    TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    ordinal       INTEGER NOT NULL,
    hard          INTEGER NOT NULL CHECK (hard IN (0, 1)),
    fallback_rank INTEGER NOT NULL,
    raw_text      TEXT NOT NULL,
    axis          TEXT NOT NULL,
    spec          TEXT NOT NULL            -- JSON ConstraintSpec
  );
  CREATE INDEX idx_constraints_program ON constraints(program_id);

  CREATE TABLE cycles (
    id           TEXT PRIMARY KEY,
    program_id   TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    opens_at     TEXT,
    closes_at    TEXT,
    timezone     TEXT NOT NULL,
    label        TEXT NOT NULL,
    is_estimated INTEGER NOT NULL CHECK (is_estimated IN (0, 1))
  );
  CREATE INDEX idx_cycles_program ON cycles(program_id);
  CREATE INDEX idx_cycles_closes  ON cycles(closes_at);

  CREATE TABLE sources (
    id                    TEXT PRIMARY KEY,
    funder_id             TEXT,
    label                 TEXT NOT NULL,
    tier                  TEXT NOT NULL,
    klass                 TEXT NOT NULL,
    enabled               INTEGER NOT NULL DEFAULT 1,
    expected_min_records  INTEGER NOT NULL DEFAULT 0,
    baseline_record_count INTEGER,
    last_record_count     INTEGER,
    last_polled_at        TEXT,
    last_success_at       TEXT,
    last_error            TEXT,
    consecutive_failures  INTEGER NOT NULL DEFAULT 0,
    notes                 TEXT NOT NULL DEFAULT ''
  );

  -- RESOLUTIONS R3: this is Plan 2's shape, adopted verbatim. Plan 2's
  -- insertSnapshot supplies no id (autoincrement), writes body_bytes, and
  -- writes file_path only when the body was spilled to disk — so `id` is
  -- INTEGER AUTOINCREMENT, `body_path NOT NULL` is gone, and `file_path` is
  -- nullable. Plan 2 deletes its duplicate CREATE TABLE IF NOT EXISTS.
  CREATE TABLE snapshots (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url          TEXT NOT NULL,
    status       INTEGER NOT NULL,
    content_type TEXT NOT NULL DEFAULT '',
    body_sha256  TEXT NOT NULL,
    body_bytes   INTEGER NOT NULL DEFAULT 0,
    file_path    TEXT,
    fetched_at   TEXT NOT NULL
  );
  CREATE INDEX idx_snapshots_source ON snapshots(source_id, fetched_at);

  CREATE TABLE change_events (
    id          TEXT PRIMARY KEY,
    source_id   TEXT NOT NULL,
    program_id  TEXT,
    kind        TEXT NOT NULL,
    field_path  TEXT,
    before_json TEXT,
    after_json  TEXT,
    detected_at TEXT NOT NULL
  );
  CREATE INDEX idx_change_events_detected ON change_events(detected_at);
  CREATE INDEX idx_change_events_program  ON change_events(program_id);

  -- RESOLUTIONS R2: the column is `candidate_json`, not `candidate` — Plans 2
  -- and 3 both already write and read that name. `created_at` carries a DEFAULT
  -- because Plan 2's insertReviewItem does not supply it.
  CREATE TABLE review_items (
    id              TEXT PRIMARY KEY,
    change_event_id TEXT NOT NULL REFERENCES change_events(id) ON DELETE CASCADE,
    candidate_json  TEXT NOT NULL,        -- JSON Program (ReviewItem.candidate)
    decision        TEXT NOT NULL DEFAULT 'pending',
    decided_by      TEXT,
    decided_at      TEXT,
    confidence      REAL NOT NULL DEFAULT 0,
    reject_key      TEXT,
    created_at      TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_review_items_decision   ON review_items(decision);
  CREATE INDEX idx_review_items_reject_key ON review_items(reject_key);

  CREATE TABLE users (
    id               TEXT PRIMARY KEY,
    email            TEXT NOT NULL,
    email_normalized TEXT NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,
    role             TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    display_name     TEXT NOT NULL DEFAULT '',
    ics_token        TEXT NOT NULL UNIQUE,
    disabled         INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
    created_at       TEXT NOT NULL,
    last_login_at    TEXT
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,        -- sha256 of the raw session id
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent   TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_sessions_user    ON sessions(user_id);
  CREATE INDEX idx_sessions_expires ON sessions(expires_at);

  CREATE TABLE profiles (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('student', 'organization')),
    data       TEXT NOT NULL,            -- JSON Profile
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, kind)
  );

  CREATE TABLE watches (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    program_id     TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    notify_changes INTEGER NOT NULL DEFAULT 1 CHECK (notify_changes IN (0, 1)),
    created_at     TEXT NOT NULL,
    UNIQUE (user_id, program_id)
  );

  -- RESOLUTIONS R24: these two tables are Plan 1's, and the column list is
  -- Plan 4's, adopted verbatim (db/repositories/applications.ts writes exactly
  -- these names). Plan 4 ships no migration for these tables; it asserts this
  -- shape with assertApplicationSchema(db) in db/repositories/applications.ts,
  -- and no later migration may create either table: migrations run in filename
  -- order, so a later `CREATE TABLE IF NOT EXISTS applications` is a silent
  -- no-op against the table this file already made, and every Plan 4 insert
  -- then dies at runtime on `table applications has no column named
  -- answers_json`. The same trap applies to indexes — SQLite matches
  -- `IF NOT EXISTS` on the NAME, so idx_applications_user and
  -- idx_template_instances_application are declared exactly once: here.
  CREATE TABLE applications (
    id                      TEXT PRIMARY KEY,
    user_id                 TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Nullable on purpose: a draft exists before a programme is chosen. ON
    -- DELETE SET NULL rather than CASCADE or RESTRICT, because approving a
    -- `vanished` review item deletes the programme (RESOLUTIONS R26) and
    -- neither destroying the applicant's draft nor blocking that delete on a
    -- foreign key is acceptable.
    program_id              TEXT NULL REFERENCES programs(id) ON DELETE SET NULL,
    title                   TEXT NOT NULL,
    body_markdown           TEXT NOT NULL DEFAULT '',
    answers_json            TEXT NOT NULL DEFAULT '{}',   -- JSON Record<string, string>
    fact_confirmations_json TEXT NOT NULL DEFAULT '{}',   -- JSON Record<string, FactConfirmation>
    include_disclosure      INTEGER NOT NULL DEFAULT 1,
    facts_confirmed_at      TEXT,                         -- set only while every fact is confirmed
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  );
  CREATE INDEX idx_applications_user ON applications(user_id, updated_at DESC);

  CREATE TABLE template_instances (
    id                    TEXT PRIMARY KEY,
    application_id        TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    template_id           TEXT NOT NULL,
    position              INTEGER NOT NULL,
    filled_markdown       TEXT NOT NULL,
    unresolved_slots_json TEXT NOT NULL DEFAULT '[]',     -- JSON string[] (FilledTemplate.unresolvedSlots)
    created_at            TEXT NOT NULL
  );
  CREATE INDEX idx_template_instances_application ON template_instances(application_id, position);

  CREATE TABLE audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL,
    actor_user_id TEXT,
    action        TEXT NOT NULL,
    entity_type   TEXT NOT NULL,
    entity_id     TEXT NOT NULL,
    detail        TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_audit_at ON audit_log(at);
  ```

- [ ] **Step 4: Write `packages/server/src/db/migrate.ts`**

  ```ts
  import { readdirSync, readFileSync } from 'node:fs';
  import { join } from 'node:path';
  import { fileURLToPath } from 'node:url';
  import Database from 'better-sqlite3';

  export type Db = Database.Database;

  export interface MigrationResult {
    applied: string[];
    alreadyApplied: string[];
  }

  /**
   * Resolved from import.meta.url so it works from src (vitest, tsx) and from
   * dist (production), where scripts/copy-sql.mjs has placed the .sql files.
   */
  export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

  export function openDatabase(filePath: string): Db {
    const db = new Database(filePath);
    // WAL is CONTRACT §6. foreign_keys must be set here: SQLite ignores the
    // pragma inside the transaction that wraps each migration.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    return db;
  }

  export function migrate(db: Db, dir: string = MIGRATIONS_DIR): MigrationResult {
    db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
    );

    const done = new Set(
      db
        .prepare('SELECT name FROM schema_migrations')
        .all()
        .map((row) => (row as { name: string }).name),
    );
    const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');

    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      if (done.has(file)) {
        alreadyApplied.push(file);
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      db.transaction(() => {
        db.exec(sql);
        record.run(file, new Date().toISOString());
      })();
      applied.push(file);
    }

    return { applied, alreadyApplied };
  }
  ```

- [ ] **Step 5: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck && npm run build
  ```

  Expect **7 passing tests** in `migrate.test.ts`, the whole run green, a clean typecheck, and `[copy-sql] copied …` in the build output with `packages/server/dist/db/migrations/001-init.sql` on disk.

- [ ] **Step 6: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/server
  git commit -m "feat(server): CONTRACT §6 SQLite schema, WAL connection, and the migration runner"
  ```

---
### Task 13: Corpus repositories — funders, programs, constraints, cycles

Thin, hand-written repositories. No ORM (CONTRACT §6). Three rules that Plans 2–5 depend on:

- **Every JSON column is validated through core's zod schemas on read.** A corrupted or hand-edited row must fail loudly at the repository boundary, not silently produce a malformed `Program` that the matcher then misjudges.
- **The repository does not compute content hashes.** It stores `program.trust.contentHash` verbatim, because the hash is an input to change detection and Plan 2's normalizer owns that decision. `withContentHash(program)` is exported here so Plans 2 and 5 have one obvious way to set it.
- **These factories are the only program/funder/constraint/cycle data access in the repository** (RESOLUTIONS R8). There are no free functions called `listPrograms`, `listFunders` or `upsertProgram`: Plan 2's `upsertProgram` / `listProgramsBySource` / `deleteProgram` delegate to `createProgramRepo(db).upsert` / `.list` / `.remove`, and Plan 3 and Plan 5 read through `.get(id)` / `.list(filter)`. There is no `data` column on `programs` and never was.

**Ingest identity (RESOLUTIONS R1/R9).** `Program` is frozen by CONTRACT §3 and has no field naming the source record it came from, but `programs` now has `source_id` and `external_key` (Task 12). So `upsert` takes an **optional second argument**, `sourceKey`, and `findBySourceKey` reads it back. This is what stops the nightly crawl duplicating the corpus: Plan 2's `normalizeRaw` asks `findBySourceKey(sourceId, externalKey)` for an existing id before minting a synthetic one, and Plan 5's seed importer supplies each record's `sourceKey` so the crawler can find it. `upsert` called **without** a `sourceKey` (the normal path for a record already in the database) preserves whatever is stored rather than nulling it, or the reconciliation would work exactly once.

**Files:**
- Create: `packages/server/src/db/repositories/funders.ts`, `packages/server/src/db/repositories/constraints.ts`, `packages/server/src/db/repositories/programs.ts`, `packages/server/src/db/repositories/cycles.ts`
- Test: `packages/server/test/repositories.corpus.test.ts`

**Interfaces:**
- Consumes: `Db` from `../migrate.js`; `Constraint`, `Cycle`, `Funder`, `OpportunityClass`, `Program`, `ProgramStatus`, `constraintSchema`, `cycleSchema`, `funderSchema`, `hashProgram`, `programSchema` from `@grantspotter/core`.
- Produces: `createFunderRepo(db): FunderRepo`, `createConstraintRepo(db): ConstraintRepo`, `createProgramRepo(db): ProgramRepo` (with `upsert(program, sourceKey?)` and `findBySourceKey(sourceId, externalKey): Program | undefined`), `createCycleRepo(db): CycleRepo`, `withContentHash(program: Program): Program`; PLAN-LOCAL: `ProgramSourceKey`, `ProgramListFilter`.

- [ ] **Step 1: Write the failing test**

  Create `packages/server/test/repositories.corpus.test.ts`:

  ```ts
  import { hashProgram } from '@grantspotter/core';
  import type { Constraint, Cycle, Funder, Program } from '@grantspotter/core';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { createConstraintRepo } from '../src/db/repositories/constraints.js';
  import { createCycleRepo } from '../src/db/repositories/cycles.js';
  import { createFunderRepo } from '../src/db/repositories/funders.js';
  import { createProgramRepo, withContentHash } from '../src/db/repositories/programs.js';
  import { createTestDb, type TestDb } from './helpers/tempDb.js';

  const funder: Funder = {
    id: 'ardc',
    name: 'Amateur Radio Digital Communications',
    homepage: 'https://www.ardc.net/',
    ein: '45-3751971',
  };

  function constraint(id: string, over: Partial<Constraint> = {}): Constraint {
    return {
      id,
      hard: true,
      fallbackRank: 0,
      rawText: `raw text for ${id}`,
      spec: { axis: 'gpa', min: 3 },
      ...over,
    };
  }

  function program(over: Partial<Program> = {}): Program {
    return {
      id: 'ardc-grants',
      funderId: 'ardc',
      name: 'ARDC Grants Program',
      klass: 'ham_grant',
      summary: 'Four fixed application deadlines a year; all output must be open-source.',
      applicantEntities: ['club_via_fiscal_sponsor', 'university', 'school_lea'],
      amount: {
        instrument: 'cash_range',
        amountMin: 1285,
        amountMax: 258000,
        amountRaw: '$1,285-$258,000',
        awardCountRaw: 'Multiple per year',
      },
      deadline: {
        kind: 'n_fixed_dates',
        source: { kind: 'self' },
        note: 'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01',
      },
      applyVia: 'external_spa_portal',
      applyUrl: 'https://www.ardc.net/apply/',
      constraints: [],
      fundingRestrictions: ['for-profit entities are ineligible'],
      obligations: {
        licenseObligation: 'All output must be open-source/open-access (GPL/MIT/BSD/CERN-OHL/CC).',
        indirectCostCapPct: 20,
        costShareRequired: false,
        coFunderPreference: false,
      },
      aiPolicy: {
        stance: 'permitted',
        quote:
          'If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy.',
        url: 'https://www.ardc.net/apply/grant-application-instructions/',
      },
      trust: {
        status: 'open',
        sourceUrl: 'https://www.ardc.net/apply/',
        lastVerifiedAt: '2026-08-02T00:00:00.000Z',
        verificationMethod: 'live_fetch',
        contentHash: 'seeded-hash',
      },
      rawOtherText: '',
      tags: ['ardc', 'grant'],
      ...over,
    };
  }

  let harness: TestDb;
  beforeEach(() => {
    harness = createTestDb();
    createFunderRepo(harness.db).upsert(funder);
  });
  afterEach(() => harness.cleanup());

  describe('funder repository', () => {
    it('round-trips, lists, counts and removes', () => {
      const repo = createFunderRepo(harness.db);
      expect(repo.get('ardc')).toEqual(funder);
      expect(repo.count()).toBe(1);

      repo.upsert({ ...funder, name: 'ARDC' });
      expect(repo.get('ardc')?.name).toBe('ARDC');
      expect(repo.count()).toBe(1);

      repo.upsert({ id: 'arrl-foundation', name: 'ARRL Foundation', homepage: 'https://www.arrl.org/' });
      expect(repo.list().map((f) => f.id)).toEqual(['arrl-foundation', 'ardc']);

      repo.remove('ardc');
      expect(repo.get('ardc')).toBeUndefined();
    });
  });

  describe('program repository', () => {
    it('round-trips a fully populated program exactly', () => {
      const repo = createProgramRepo(harness.db);
      const p = program();
      repo.upsert(p);
      expect(repo.get('ardc-grants')).toEqual(p);
    });

    it('round-trips constraints and preserves their order', () => {
      const repo = createProgramRepo(harness.db);
      const p = program({
        constraints: [
          constraint('c-geo', { spec: { axis: 'geography', geo: { type: 'any', values: [] } } }),
          constraint('c-need', { hard: false, fallbackRank: 2, spec: { axis: 'financial_need', weighted: true } }),
          constraint('c-gpa'),
        ],
      });
      repo.upsert(p);
      const loaded = repo.get('ardc-grants');
      expect(loaded?.constraints.map((c) => c.id)).toEqual(['c-geo', 'c-need', 'c-gpa']);
      expect(loaded?.constraints[1].hard).toBe(false);
      expect(loaded?.constraints[1].fallbackRank).toBe(2);
    });

    it('replaces constraints on upsert rather than accumulating them', () => {
      const repo = createProgramRepo(harness.db);
      repo.upsert(program({ constraints: [constraint('a'), constraint('b')] }));
      repo.upsert(program({ constraints: [constraint('c')] }));
      expect(repo.get('ardc-grants')?.constraints.map((c) => c.id)).toEqual(['c']);
      expect(createConstraintRepo(harness.db).listForProgram('ardc-grants')).toHaveLength(1);
    });

    it('filters by class, funder and status', () => {
      const repo = createProgramRepo(harness.db);
      repo.upsert(program());
      repo.upsert(
        program({
          id: 'ardc-scholarships',
          klass: 'ham_scholarship',
          trust: { ...program().trust, status: 'closed' },
        }),
      );
      expect(repo.list({ klass: 'ham_grant' }).map((p) => p.id)).toEqual(['ardc-grants']);
      expect(repo.list({ status: 'closed' }).map((p) => p.id)).toEqual(['ardc-scholarships']);
      expect(repo.list({ funderId: 'ardc' })).toHaveLength(2);
      expect(repo.list({ funderId: 'nobody' })).toEqual([]);
      expect(repo.count()).toBe(2);
    });

    it('cascades constraints and cycles when a program is removed', () => {
      const repo = createProgramRepo(harness.db);
      const cycles = createCycleRepo(harness.db);
      repo.upsert(program({ constraints: [constraint('a')] }));
      cycles.upsertMany([
        {
          id: 'ardc-grants:2027-02-02T07:59:00.000Z',
          programId: 'ardc-grants',
          closesAt: '2027-02-02T07:59:00.000Z',
          timezone: 'America/Los_Angeles',
          label: 'Feb 1, 2027 deadline',
          isEstimated: true,
        },
      ]);
      repo.remove('ardc-grants');
      expect(createConstraintRepo(harness.db).listForProgram('ardc-grants')).toEqual([]);
      expect(cycles.listForProgram('ardc-grants')).toEqual([]);
    });

    it('refuses to return a row whose JSON no longer matches the schema', () => {
      const repo = createProgramRepo(harness.db);
      repo.upsert(program());
      harness.db
        .prepare('UPDATE programs SET amount = ? WHERE id = ?')
        .run('{"instrument":"gold","amountRaw":"","awardCountRaw":""}', 'ardc-grants');
      expect(() => repo.get('ardc-grants')).toThrow();
    });

    // RESOLUTIONS R1/R9: the seed corpus owns program identity, and the nightly
    // crawler resolves it through (sourceId, externalKey). Without this, every
    // crawl mints a fresh id and diffPrograms reports the whole corpus as
    // `vanished` + `new`, every single night.
    it('finds a program by its source key', () => {
      const repo = createProgramRepo(harness.db);
      repo.upsert(program(), { sourceId: 'ardc-grants', externalKey: 'grants' });
      repo.upsert(
        program({ id: 'ardc-award-tables', name: 'ARDC award tables' }),
        { sourceId: 'ardc-award-tables', externalKey: 'tables' },
      );

      expect(repo.findBySourceKey('ardc-grants', 'grants')?.id).toBe('ardc-grants');
      expect(repo.findBySourceKey('ardc-award-tables', 'tables')?.id).toBe('ardc-award-tables');
      expect(repo.findBySourceKey('ardc-grants', 'tables')).toBeUndefined();
      expect(repo.findBySourceKey('no-such-source', 'grants')).toBeUndefined();
    });

    it('returns undefined for a program stored without a source key', () => {
      const repo = createProgramRepo(harness.db);
      repo.upsert(program({ id: 'hand-curated' }));
      expect(repo.get('hand-curated')?.id).toBe('hand-curated');
      expect(repo.findBySourceKey('ardc-grants', 'grants')).toBeUndefined();
    });

    it('keeps the stored source key when a later upsert omits it', () => {
      // The crawler upserts the normalized record with no sourceKey argument.
      // If that cleared the columns, reconciliation would work exactly once and
      // the corpus would start duplicating on the second night.
      const repo = createProgramRepo(harness.db);
      repo.upsert(program(), { sourceId: 'ardc-grants', externalKey: 'grants' });
      repo.upsert(program({ name: 'ARDC Grants Program (renamed)' }));

      expect(repo.get('ardc-grants')?.name).toBe('ARDC Grants Program (renamed)');
      expect(repo.findBySourceKey('ardc-grants', 'grants')?.id).toBe('ardc-grants');
    });

    it('stores the caller’s contentHash verbatim, and withContentHash computes one', () => {
      const repo = createProgramRepo(harness.db);
      const p = program();
      repo.upsert(p);
      expect(repo.get('ardc-grants')?.trust.contentHash).toBe('seeded-hash');

      const hashed = withContentHash(p);
      expect(hashed.trust.contentHash).toBe(hashProgram(p));
      expect(hashed.trust.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(p.trust.contentHash).toBe('seeded-hash'); // input not mutated
    });
  });

  describe('cycle repository', () => {
    const base: Cycle = {
      id: 'ardc-grants:2027-02-02T07:59:00.000Z',
      programId: 'ardc-grants',
      closesAt: '2027-02-02T07:59:00.000Z',
      timezone: 'America/Los_Angeles',
      label: 'Feb 1, 2027 deadline',
      isEstimated: true,
    };

    beforeEach(() => {
      createProgramRepo(harness.db).upsert(program());
    });

    it('upserts by id so a nightly re-projection does not duplicate rows', () => {
      const repo = createCycleRepo(harness.db);
      repo.upsertMany([base]);
      repo.upsertMany([{ ...base, label: 'Feb 1, 2027 deadline (revised)' }]);
      const rows = repo.listForProgram('ardc-grants');
      expect(rows).toHaveLength(1);
      expect(rows[0].label).toBe('Feb 1, 2027 deadline (revised)');
    });

    it('lists cycles closing inside a window, in ascending order', () => {
      const repo = createCycleRepo(harness.db);
      repo.upsertMany([
        { ...base, id: 'c3', closesAt: '2027-07-02T06:59:00.000Z', label: 'Jul' },
        { ...base, id: 'c1', closesAt: '2027-02-02T07:59:00.000Z', label: 'Feb' },
        { ...base, id: 'c2', closesAt: '2027-04-02T06:59:00.000Z', label: 'Apr' },
        { ...base, id: 'c4', closesAt: '2028-02-02T07:59:00.000Z', label: 'next year' },
      ]);
      expect(
        repo
          .listClosingBetween('2027-01-01T00:00:00.000Z', '2027-12-31T00:00:00.000Z')
          .map((c) => c.label),
      ).toEqual(['Feb', 'Apr', 'Jul']);
    });

    it('drops projected cycles without touching observed ones', () => {
      const repo = createCycleRepo(harness.db);
      repo.upsertMany([
        { ...base, id: 'projected', isEstimated: true },
        {
          ...base,
          id: 'observed',
          isEstimated: false,
          opensAt: '2027-01-01T05:00:00.000Z',
          label: 'observed on the page',
        },
      ]);
      repo.removeEstimatedForProgram('ardc-grants');
      const rows = repo.listForProgram('ardc-grants');
      expect(rows.map((c) => c.id)).toEqual(['observed']);
      expect(rows[0].opensAt).toBe('2027-01-01T05:00:00.000Z');
      expect(rows[0].isEstimated).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- repositories.corpus
  ```

  Expected failure: `Failed to resolve import "../src/db/repositories/constraints.js"`.

- [ ] **Step 3: Write `packages/server/src/db/repositories/funders.ts`**

  ```ts
  import { funderSchema } from '@grantspotter/core';
  import type { Funder } from '@grantspotter/core';
  import type { Db } from '../migrate.js';

  export interface FunderRepo {
    upsert(funder: Funder): void;
    get(id: string): Funder | undefined;
    list(): Funder[];
    remove(id: string): void;
    count(): number;
  }

  interface FunderRow {
    id: string;
    name: string;
    homepage: string;
    ein: string | null;
    note: string | null;
  }

  function toFunder(row: FunderRow): Funder {
    const funder: Record<string, unknown> = {
      id: row.id,
      name: row.name,
      homepage: row.homepage,
    };
    if (row.ein !== null) funder.ein = row.ein;
    if (row.note !== null) funder.note = row.note;
    return funderSchema.parse(funder);
  }

  export function createFunderRepo(db: Db): FunderRepo {
    const upsertStmt = db.prepare(
      `INSERT INTO funders (id, name, homepage, ein, note, created_at, updated_at)
       VALUES (@id, @name, @homepage, @ein, @note, @now, @now)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, homepage = excluded.homepage,
         ein = excluded.ein, note = excluded.note, updated_at = excluded.updated_at`,
    );
    const getStmt = db.prepare('SELECT id, name, homepage, ein, note FROM funders WHERE id = ?');
    const listStmt = db.prepare('SELECT id, name, homepage, ein, note FROM funders ORDER BY name');
    const removeStmt = db.prepare('DELETE FROM funders WHERE id = ?');
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM funders');

    return {
      upsert(funder) {
        upsertStmt.run({
          id: funder.id,
          name: funder.name,
          homepage: funder.homepage,
          ein: funder.ein ?? null,
          note: funder.note ?? null,
          now: new Date().toISOString(),
        });
      },
      get(id) {
        const row = getStmt.get(id) as FunderRow | undefined;
        return row === undefined ? undefined : toFunder(row);
      },
      list() {
        return (listStmt.all() as FunderRow[]).map(toFunder);
      },
      remove(id) {
        removeStmt.run(id);
      },
      count() {
        return (countStmt.get() as { n: number }).n;
      },
    };
  }
  ```

- [ ] **Step 4: Write `packages/server/src/db/repositories/constraints.ts`**

  ```ts
  import { constraintSchema } from '@grantspotter/core';
  import type { Constraint } from '@grantspotter/core';
  import type { Db } from '../migrate.js';

  export interface ConstraintRepo {
    replaceForProgram(programId: string, constraints: Constraint[]): void;
    listForProgram(programId: string): Constraint[];
  }

  interface ConstraintRow {
    id: string;
    hard: number;
    fallback_rank: number;
    raw_text: string;
    spec: string;
  }

  export function createConstraintRepo(db: Db): ConstraintRepo {
    const deleteStmt = db.prepare('DELETE FROM constraints WHERE program_id = ?');
    const insertStmt = db.prepare(
      `INSERT INTO constraints (id, program_id, ordinal, hard, fallback_rank, raw_text, axis, spec)
       VALUES (@id, @program_id, @ordinal, @hard, @fallback_rank, @raw_text, @axis, @spec)`,
    );
    const listStmt = db.prepare(
      'SELECT id, hard, fallback_rank, raw_text, spec FROM constraints WHERE program_id = ? ORDER BY ordinal',
    );

    return {
      replaceForProgram(programId, constraints) {
        db.transaction(() => {
          deleteStmt.run(programId);
          constraints.forEach((constraint, ordinal) => {
            insertStmt.run({
              id: constraint.id,
              program_id: programId,
              ordinal,
              hard: constraint.hard ? 1 : 0,
              fallback_rank: constraint.fallbackRank,
              raw_text: constraint.rawText,
              axis: constraint.spec.axis,
              spec: JSON.stringify(constraint.spec),
            });
          });
        })();
      },
      listForProgram(programId) {
        return (listStmt.all(programId) as ConstraintRow[]).map((row) =>
          constraintSchema.parse({
            id: row.id,
            hard: row.hard === 1,
            fallbackRank: row.fallback_rank,
            rawText: row.raw_text,
            spec: JSON.parse(row.spec),
          }),
        );
      },
    };
  }
  ```

- [ ] **Step 5: Write `packages/server/src/db/repositories/programs.ts`**

  ```ts
  import { hashProgram, programSchema } from '@grantspotter/core';
  import type { OpportunityClass, Program, ProgramStatus } from '@grantspotter/core';
  import type { Db } from '../migrate.js';
  import { createConstraintRepo } from './constraints.js';

  export interface ProgramListFilter {
    klass?: OpportunityClass;
    funderId?: string;
    status?: ProgramStatus;
  }

  /**
   * PLAN-LOCAL (RESOLUTIONS R1/R9). CONTRACT §3 freezes `Program` with no field
   * for the source record it came from, so ingest identity travels alongside it
   * and lands in the programs.source_id / programs.external_key columns.
   */
  export interface ProgramSourceKey {
    sourceId: string;
    externalKey: string;
  }

  export interface ProgramRepo {
    /**
     * `sourceKey` is written only when supplied. Omitting it preserves whatever
     * is already stored, so a crawler re-upsert never orphans a seeded record
     * from its source identity.
     */
    upsert(program: Program, sourceKey?: ProgramSourceKey): void;
    get(id: string): Program | undefined;
    /** Plan 2's crawler resolves an existing id through this before minting one. */
    findBySourceKey(sourceId: string, externalKey: string): Program | undefined;
    list(filter?: ProgramListFilter): Program[];
    remove(id: string): void;
    count(): number;
  }

  /**
   * Returns a copy of `program` with trust.contentHash set to hashProgram(program).
   * The repository never does this itself: the hash is an input to change
   * detection, and Plan 2's normalizer owns when it is (re)computed.
   */
  export function withContentHash(program: Program): Program {
    return { ...program, trust: { ...program.trust, contentHash: hashProgram(program) } };
  }

  interface ProgramRow {
    id: string;
    funder_id: string;
    name: string;
    klass: string;
    summary: string;
    applicant_entities: string;
    amount: string;
    deadline: string;
    apply_via: string;
    apply_url: string | null;
    apply_contact: string | null;
    funding_restrictions: string;
    obligations: string;
    ai_policy: string;
    trust: string;
    raw_other_text: string;
    tags: string;
  }

  export function createProgramRepo(db: Db): ProgramRepo {
    const constraints = createConstraintRepo(db);

    const COLUMNS = `id, funder_id, name, klass, summary, applicant_entities, amount, deadline,
      apply_via, apply_url, apply_contact, funding_restrictions, obligations, ai_policy, trust,
      raw_other_text, tags`;

    const upsertStmt = db.prepare(
      `INSERT INTO programs (${COLUMNS}, source_id, external_key, content_hash, status,
               last_verified_at, created_at, updated_at)
       VALUES (@id, @funder_id, @name, @klass, @summary, @applicant_entities, @amount, @deadline,
               @apply_via, @apply_url, @apply_contact, @funding_restrictions, @obligations,
               @ai_policy, @trust, @raw_other_text, @tags, @source_id, @external_key,
               @content_hash, @status, @last_verified_at, @now, @now)
       ON CONFLICT(id) DO UPDATE SET
         funder_id = excluded.funder_id, name = excluded.name, klass = excluded.klass,
         summary = excluded.summary, applicant_entities = excluded.applicant_entities,
         amount = excluded.amount, deadline = excluded.deadline, apply_via = excluded.apply_via,
         apply_url = excluded.apply_url, apply_contact = excluded.apply_contact,
         funding_restrictions = excluded.funding_restrictions, obligations = excluded.obligations,
         ai_policy = excluded.ai_policy, trust = excluded.trust,
         raw_other_text = excluded.raw_other_text, tags = excluded.tags,
         -- COALESCE, not excluded.*: an upsert that supplies no sourceKey must
         -- keep the identity the seed importer or an earlier crawl wrote.
         source_id = COALESCE(excluded.source_id, programs.source_id),
         external_key = COALESCE(excluded.external_key, programs.external_key),
         content_hash = excluded.content_hash, status = excluded.status,
         last_verified_at = excluded.last_verified_at, updated_at = excluded.updated_at`,
    );
    const getStmt = db.prepare(`SELECT ${COLUMNS} FROM programs WHERE id = ?`);
    const findBySourceKeyStmt = db.prepare(
      `SELECT ${COLUMNS} FROM programs WHERE source_id = ? AND external_key = ?`,
    );
    const removeStmt = db.prepare('DELETE FROM programs WHERE id = ?');
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM programs');

    function toProgram(row: ProgramRow): Program {
      const draft: Record<string, unknown> = {
        id: row.id,
        funderId: row.funder_id,
        name: row.name,
        klass: row.klass,
        summary: row.summary,
        applicantEntities: JSON.parse(row.applicant_entities),
        amount: JSON.parse(row.amount),
        deadline: JSON.parse(row.deadline),
        applyVia: row.apply_via,
        constraints: constraints.listForProgram(row.id),
        fundingRestrictions: JSON.parse(row.funding_restrictions),
        obligations: JSON.parse(row.obligations),
        aiPolicy: JSON.parse(row.ai_policy),
        trust: JSON.parse(row.trust),
        rawOtherText: row.raw_other_text,
        tags: JSON.parse(row.tags),
      };
      if (row.apply_url !== null) draft.applyUrl = row.apply_url;
      if (row.apply_contact !== null) draft.applyContact = row.apply_contact;
      // CONTRACT §6: JSON-shaped columns are validated on read.
      return programSchema.parse(draft);
    }

    return {
      upsert(program, sourceKey) {
        db.transaction(() => {
          upsertStmt.run({
            id: program.id,
            funder_id: program.funderId,
            name: program.name,
            klass: program.klass,
            summary: program.summary,
            applicant_entities: JSON.stringify(program.applicantEntities),
            amount: JSON.stringify(program.amount),
            deadline: JSON.stringify(program.deadline),
            apply_via: program.applyVia,
            apply_url: program.applyUrl ?? null,
            apply_contact: program.applyContact ?? null,
            funding_restrictions: JSON.stringify(program.fundingRestrictions),
            obligations: JSON.stringify(program.obligations),
            ai_policy: JSON.stringify(program.aiPolicy),
            trust: JSON.stringify(program.trust),
            raw_other_text: program.rawOtherText,
            tags: JSON.stringify(program.tags),
            source_id: sourceKey?.sourceId ?? null,
            external_key: sourceKey?.externalKey ?? null,
            content_hash: program.trust.contentHash,
            status: program.trust.status,
            last_verified_at: program.trust.lastVerifiedAt,
            now: new Date().toISOString(),
          });
          constraints.replaceForProgram(program.id, program.constraints);
        })();
      },
      get(id) {
        const row = getStmt.get(id) as ProgramRow | undefined;
        return row === undefined ? undefined : toProgram(row);
      },
      findBySourceKey(sourceId, externalKey) {
        const row = findBySourceKeyStmt.get(sourceId, externalKey) as ProgramRow | undefined;
        return row === undefined ? undefined : toProgram(row);
      },
      list(filter = {}) {
        const wheres: string[] = [];
        const params: unknown[] = [];
        if (filter.klass !== undefined) {
          wheres.push('klass = ?');
          params.push(filter.klass);
        }
        if (filter.funderId !== undefined) {
          wheres.push('funder_id = ?');
          params.push(filter.funderId);
        }
        if (filter.status !== undefined) {
          wheres.push('status = ?');
          params.push(filter.status);
        }
        const sql = `SELECT ${COLUMNS} FROM programs${
          wheres.length > 0 ? ` WHERE ${wheres.join(' AND ')}` : ''
        } ORDER BY name`;
        return (db.prepare(sql).all(...params) as ProgramRow[]).map(toProgram);
      },
      remove(id) {
        removeStmt.run(id);
      },
      count() {
        return (countStmt.get() as { n: number }).n;
      },
    };
  }
  ```

- [ ] **Step 6: Write `packages/server/src/db/repositories/cycles.ts`**

  ```ts
  import { cycleSchema } from '@grantspotter/core';
  import type { Cycle } from '@grantspotter/core';
  import type { Db } from '../migrate.js';

  export interface CycleRepo {
    upsertMany(cycles: Cycle[]): void;
    listForProgram(programId: string): Cycle[];
    listClosingBetween(fromISO: string, toISO: string): Cycle[];
    removeEstimatedForProgram(programId: string): void;
    count(): number;
  }

  interface CycleRow {
    id: string;
    program_id: string;
    opens_at: string | null;
    closes_at: string | null;
    timezone: string;
    label: string;
    is_estimated: number;
  }

  function toCycle(row: CycleRow): Cycle {
    const draft: Record<string, unknown> = {
      id: row.id,
      programId: row.program_id,
      timezone: row.timezone,
      label: row.label,
      isEstimated: row.is_estimated === 1,
    };
    if (row.opens_at !== null) draft.opensAt = row.opens_at;
    if (row.closes_at !== null) draft.closesAt = row.closes_at;
    return cycleSchema.parse(draft);
  }

  const COLUMNS = 'id, program_id, opens_at, closes_at, timezone, label, is_estimated';

  export function createCycleRepo(db: Db): CycleRepo {
    const upsertStmt = db.prepare(
      `INSERT INTO cycles (id, program_id, opens_at, closes_at, timezone, label, is_estimated)
       VALUES (@id, @program_id, @opens_at, @closes_at, @timezone, @label, @is_estimated)
       ON CONFLICT(id) DO UPDATE SET
         program_id = excluded.program_id, opens_at = excluded.opens_at,
         closes_at = excluded.closes_at, timezone = excluded.timezone,
         label = excluded.label, is_estimated = excluded.is_estimated`,
    );
    const listForProgramStmt = db.prepare(
      `SELECT ${COLUMNS} FROM cycles WHERE program_id = ? ORDER BY closes_at, id`,
    );
    const listBetweenStmt = db.prepare(
      `SELECT ${COLUMNS} FROM cycles WHERE closes_at IS NOT NULL AND closes_at >= ? AND closes_at <= ?
       ORDER BY closes_at, id`,
    );
    const removeEstimatedStmt = db.prepare(
      'DELETE FROM cycles WHERE program_id = ? AND is_estimated = 1',
    );
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM cycles');

    return {
      upsertMany(cycles) {
        db.transaction(() => {
          for (const cycle of cycles) {
            upsertStmt.run({
              id: cycle.id,
              program_id: cycle.programId,
              opens_at: cycle.opensAt ?? null,
              closes_at: cycle.closesAt ?? null,
              timezone: cycle.timezone,
              label: cycle.label,
              is_estimated: cycle.isEstimated ? 1 : 0,
            });
          }
        })();
      },
      listForProgram(programId) {
        return (listForProgramStmt.all(programId) as CycleRow[]).map(toCycle);
      },
      listClosingBetween(fromISO, toISO) {
        return (listBetweenStmt.all(fromISO, toISO) as CycleRow[]).map(toCycle);
      },
      removeEstimatedForProgram(programId) {
        removeEstimatedStmt.run(programId);
      },
      count() {
        return (countStmt.get() as { n: number }).n;
      },
    };
  }
  ```

- [ ] **Step 7: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck && npm run build
  ```

  Expect **14 passing tests** in `repositories.corpus.test.ts`, the whole run green, a clean typecheck and a clean build.

- [ ] **Step 8: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/server
  git commit -m "feat(server): funder, program, constraint and cycle repositories with zod-validated reads"
  ```

---
### Task 14: Account repositories and argon2id password hashing

Spec §12: local accounts, argon2id password hashing, two roles. `@node-rs/argon2` is used rather than the `argon2` package because it ships prebuilt binaries for `linux-x64-gnu` and `linux-arm64-gnu`, which is what Plan 5's multi-arch image needs. It was installed and exercised on this host: it produced `$argon2id$v=19$m=19456,t=2,p=1$…` and verified correctly.

Parameters are the OWASP 2024 baseline for Argon2id: **m = 19456 KiB (19 MiB), t = 2, p = 1**.

**Files:**
- Create: `packages/server/src/auth/password.ts`
- Create: `packages/server/src/db/repositories/users.ts`, `packages/server/src/db/repositories/sessions.ts`, `packages/server/src/db/repositories/profiles.ts`
- Test: `packages/server/test/accounts.test.ts`

**Interfaces:**
- Consumes: `Db` from `../migrate.js`; `Profile`, `profileSchema` from `@grantspotter/core`.
- Produces: `hashPassword`, `verifyPassword`, `assertPasswordPolicy`, `WeakPasswordError`, `ARGON2_OPTIONS`, `MIN_PASSWORD_LENGTH`; `Role`, `UserRecord`, `PublicUser`, `toPublicUser`, `normalizeEmail`, `createUserRepo(db): UserRepo`; `SessionRecord`, `createSessionRepo(db): SessionRepo`; `createProfileRepo(db): ProfileRepo`.

- [ ] **Step 1: Write the failing test**

  Create `packages/server/test/accounts.test.ts`:

  ```ts
  import type { Profile } from '@grantspotter/core';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import {
    assertPasswordPolicy,
    hashPassword,
    verifyPassword,
    WeakPasswordError,
  } from '../src/auth/password.js';
  import { createProfileRepo } from '../src/db/repositories/profiles.js';
  import { createSessionRepo } from '../src/db/repositories/sessions.js';
  import { createUserRepo, normalizeEmail, toPublicUser } from '../src/db/repositories/users.js';
  import { createTestDb, type TestDb } from './helpers/tempDb.js';

  let harness: TestDb;
  beforeEach(() => {
    harness = createTestDb();
  });
  afterEach(() => harness.cleanup());

  describe('password hashing', () => {
    it('produces an argon2id hash that verifies', async () => {
      const hash = await hashPassword('correct horse battery staple');
      expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
      expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
      expect(await verifyPassword(hash, 'correct horse battery stapl')).toBe(false);
    });

    it('salts, so the same password hashes differently every time', async () => {
      const a = await hashPassword('correct horse battery staple');
      const b = await hashPassword('correct horse battery staple');
      expect(a).not.toBe(b);
    });

    it('returns false rather than throwing on a malformed stored hash', async () => {
      expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
      expect(await verifyPassword('', 'anything')).toBe(false);
    });

    it('rejects passwords below the minimum length', () => {
      expect(() => assertPasswordPolicy('short')).toThrow(WeakPasswordError);
      expect(() => assertPasswordPolicy('           ')).toThrow(WeakPasswordError);
      expect(() => assertPasswordPolicy('a-long-enough-password')).not.toThrow();
    });
  });

  describe('user repository', () => {
    it('normalises email for lookup while preserving what the user typed', () => {
      expect(normalizeEmail('  Student@Example.ORG ')).toBe('student@example.org');

      const repo = createUserRepo(harness.db);
      const created = repo.create({
        email: '  Student@Example.ORG ',
        passwordHash: 'hash',
        role: 'member',
        displayName: 'Student',
      });
      expect(created.email).toBe('Student@Example.ORG');
      expect(created.emailNormalized).toBe('student@example.org');
      expect(repo.findByEmail('STUDENT@example.org')?.id).toBe(created.id);
      expect(repo.findById(created.id)?.role).toBe('member');
      expect(repo.count()).toBe(1);
    });

    it('rejects a duplicate email', () => {
      const repo = createUserRepo(harness.db);
      repo.create({ email: 'a@example.org', passwordHash: 'h', role: 'admin' });
      expect(() =>
        repo.create({ email: 'A@Example.org', passwordHash: 'h', role: 'member' }),
      ).toThrow(/UNIQUE constraint failed/);
    });

    it('issues a unique ICS token per user and can look one up', () => {
      const repo = createUserRepo(harness.db);
      const a = repo.create({ email: 'a@example.org', passwordHash: 'h', role: 'admin' });
      const b = repo.create({ email: 'b@example.org', passwordHash: 'h', role: 'member' });
      expect(a.icsToken).not.toBe(b.icsToken);
      expect(a.icsToken.length).toBeGreaterThanOrEqual(24);
      expect(repo.findByIcsToken(b.icsToken)?.id).toBe(b.id);
      expect(repo.findByIcsToken('nope')).toBeUndefined();
    });

    it('never leaks the password hash or the ICS token to the API layer', () => {
      const repo = createUserRepo(harness.db);
      const user = repo.create({ email: 'a@example.org', passwordHash: 'secret', role: 'admin' });
      const publicUser = toPublicUser(user);
      expect(Object.keys(publicUser).sort()).toEqual([
        'createdAt',
        'displayName',
        'email',
        'id',
        'role',
      ]);
      expect(JSON.stringify(publicUser)).not.toContain('secret');
    });

    it('records logins and updates role and disabled state', () => {
      const repo = createUserRepo(harness.db);
      const user = repo.create({ email: 'a@example.org', passwordHash: 'h', role: 'member' });
      expect(user.lastLoginAt).toBeUndefined();

      repo.recordLogin(user.id, '2027-03-01T10:00:00.000Z');
      expect(repo.findById(user.id)?.lastLoginAt).toBe('2027-03-01T10:00:00.000Z');

      repo.setRole(user.id, 'admin');
      expect(repo.findById(user.id)?.role).toBe('admin');

      repo.setDisabled(user.id, true);
      expect(repo.findById(user.id)?.disabled).toBe(true);
      expect(repo.list()).toHaveLength(1);
    });
  });

  describe('session repository', () => {
    it('creates, finds, touches, removes and expires sessions', () => {
      const users = createUserRepo(harness.db);
      const sessions = createSessionRepo(harness.db);
      const user = users.create({ email: 'a@example.org', passwordHash: 'h', role: 'admin' });

      sessions.create({
        id: 'hash-a',
        userId: user.id,
        expiresAt: '2027-04-01T00:00:00.000Z',
        userAgent: 'vitest',
        nowISO: '2027-03-01T00:00:00.000Z',
      });
      const found = sessions.find('hash-a');
      expect(found?.userId).toBe(user.id);
      expect(found?.userAgent).toBe('vitest');
      expect(found?.lastSeenAt).toBe('2027-03-01T00:00:00.000Z');

      sessions.touch('hash-a', '2027-03-02T00:00:00.000Z');
      expect(sessions.find('hash-a')?.lastSeenAt).toBe('2027-03-02T00:00:00.000Z');

      sessions.create({
        id: 'hash-old',
        userId: user.id,
        expiresAt: '2027-01-01T00:00:00.000Z',
        nowISO: '2026-12-01T00:00:00.000Z',
      });
      expect(sessions.removeExpired('2027-03-05T00:00:00.000Z')).toBe(1);
      expect(sessions.find('hash-old')).toBeUndefined();
      expect(sessions.find('hash-a')).toBeDefined();

      sessions.remove('hash-a');
      expect(sessions.count()).toBe(0);
    });

    it('deletes a user’s sessions when the user is deleted', () => {
      const users = createUserRepo(harness.db);
      const sessions = createSessionRepo(harness.db);
      const user = users.create({ email: 'a@example.org', passwordHash: 'h', role: 'admin' });
      sessions.create({ id: 's1', userId: user.id, expiresAt: '2027-04-01T00:00:00.000Z' });
      harness.db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
      expect(sessions.count()).toBe(0);
    });
  });

  describe('profile repository', () => {
    it('stores one student and one organisation profile per user', () => {
      const users = createUserRepo(harness.db);
      const profiles = createProfileRepo(harness.db);
      const user = users.create({ email: 'a@example.org', passwordHash: 'h', role: 'member' });

      const student: Profile = {
        kind: 'student',
        callsign: 'W8UM',
        licenseClass: 'GENERAL',
        state: 'MI',
        degreeLevel: 'BACH',
        gpa: 3.4,
      };
      const org: Profile = {
        kind: 'organization',
        entity: 'club_501c3',
        orgName: 'Example Collegiate Radio Club',
        state: 'MI',
        arrlAffiliated: true,
        memberCount: 42,
      };

      profiles.upsert(user.id, student);
      profiles.upsert(user.id, org);
      expect(profiles.get(user.id, 'student')).toEqual(student);
      expect(profiles.get(user.id, 'organization')).toEqual(org);
      expect(profiles.listForUser(user.id).map((p) => p.kind).sort()).toEqual([
        'organization',
        'student',
      ]);

      profiles.upsert(user.id, { ...student, gpa: 3.9 });
      expect(profiles.get(user.id, 'student')?.kind).toBe('student');
      expect(profiles.listForUser(user.id)).toHaveLength(2);

      profiles.remove(user.id, 'organization');
      expect(profiles.get(user.id, 'organization')).toBeUndefined();
    });

    it('refuses to return a profile whose stored JSON no longer validates', () => {
      const users = createUserRepo(harness.db);
      const profiles = createProfileRepo(harness.db);
      const user = users.create({ email: 'a@example.org', passwordHash: 'h', role: 'member' });
      profiles.upsert(user.id, { kind: 'student', state: 'MI' });
      harness.db
        .prepare('UPDATE profiles SET data = ? WHERE user_id = ? AND kind = ?')
        .run('{"kind":"student","licenseClass":"SUPER"}', user.id, 'student');
      expect(() => profiles.get(user.id, 'student')).toThrow();
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- accounts
  ```

  Expected failure: `Failed to resolve import "../src/auth/password.js"`.

- [ ] **Step 3: Write `packages/server/src/auth/password.ts`**

  ```ts
  import { Algorithm, hash, verify } from '@node-rs/argon2';

  /** OWASP 2024 baseline for Argon2id: m = 19 MiB, t = 2, p = 1. */
  export const ARGON2_OPTIONS = {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
    outputLen: 32,
  } as const;

  export const MIN_PASSWORD_LENGTH = 12;

  export class WeakPasswordError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WeakPasswordError';
    }
  }

  export function assertPasswordPolicy(plain: string): void {
    if (plain.trim().length < MIN_PASSWORD_LENGTH) {
      throw new WeakPasswordError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
    }
  }

  export async function hashPassword(plain: string): Promise<string> {
    return hash(plain, ARGON2_OPTIONS);
  }

  /** Returns false — never throws — for a malformed or empty stored hash. */
  export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
    try {
      return await verify(storedHash, plain);
    } catch {
      return false;
    }
  }
  ```

- [ ] **Step 4: Write `packages/server/src/db/repositories/users.ts`**

  ```ts
  import { randomBytes, randomUUID } from 'node:crypto';
  import type { Db } from '../migrate.js';

  export type Role = 'admin' | 'member';

  export interface UserRecord {
    id: string;
    email: string;
    emailNormalized: string;
    passwordHash: string;
    role: Role;
    displayName: string;
    icsToken: string;
    disabled: boolean;
    createdAt: string;
    lastLoginAt?: string;
  }

  /** What the API is allowed to serialise. Never the hash, never the ICS token. */
  export interface PublicUser {
    id: string;
    email: string;
    displayName: string;
    role: Role;
    createdAt: string;
    lastLoginAt?: string;
  }

  export function normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  export function toPublicUser(user: UserRecord): PublicUser {
    const publicUser: PublicUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
    };
    if (user.lastLoginAt !== undefined) publicUser.lastLoginAt = user.lastLoginAt;
    return publicUser;
  }

  export interface CreateUserInput {
    email: string;
    passwordHash: string;
    role: Role;
    displayName?: string;
  }

  export interface UserRepo {
    create(input: CreateUserInput): UserRecord;
    findById(id: string): UserRecord | undefined;
    findByEmail(email: string): UserRecord | undefined;
    findByIcsToken(token: string): UserRecord | undefined;
    list(): UserRecord[];
    count(): number;
    recordLogin(id: string, atISO: string): void;
    setRole(id: string, role: Role): void;
    setDisabled(id: string, disabled: boolean): void;
  }

  interface UserRow {
    id: string;
    email: string;
    email_normalized: string;
    password_hash: string;
    role: Role;
    display_name: string;
    ics_token: string;
    disabled: number;
    created_at: string;
    last_login_at: string | null;
  }

  function toUser(row: UserRow): UserRecord {
    const user: UserRecord = {
      id: row.id,
      email: row.email,
      emailNormalized: row.email_normalized,
      passwordHash: row.password_hash,
      role: row.role,
      displayName: row.display_name,
      icsToken: row.ics_token,
      disabled: row.disabled === 1,
      createdAt: row.created_at,
    };
    if (row.last_login_at !== null) user.lastLoginAt = row.last_login_at;
    return user;
  }

  const COLUMNS =
    'id, email, email_normalized, password_hash, role, display_name, ics_token, disabled, created_at, last_login_at';

  export function createUserRepo(db: Db): UserRepo {
    const insertStmt = db.prepare(
      `INSERT INTO users (id, email, email_normalized, password_hash, role, display_name, ics_token, created_at)
       VALUES (@id, @email, @email_normalized, @password_hash, @role, @display_name, @ics_token, @created_at)`,
    );
    const byIdStmt = db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ?`);
    const byEmailStmt = db.prepare(`SELECT ${COLUMNS} FROM users WHERE email_normalized = ?`);
    const byIcsStmt = db.prepare(`SELECT ${COLUMNS} FROM users WHERE ics_token = ?`);
    const listStmt = db.prepare(`SELECT ${COLUMNS} FROM users ORDER BY created_at, email_normalized`);
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM users');
    const loginStmt = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');
    const roleStmt = db.prepare('UPDATE users SET role = ? WHERE id = ?');
    const disabledStmt = db.prepare('UPDATE users SET disabled = ? WHERE id = ?');

    return {
      create(input) {
        const row = {
          id: randomUUID(),
          email: input.email.trim(),
          email_normalized: normalizeEmail(input.email),
          password_hash: input.passwordHash,
          role: input.role,
          display_name: input.displayName ?? '',
          ics_token: randomBytes(24).toString('base64url'),
          created_at: new Date().toISOString(),
        };
        insertStmt.run(row);
        return toUser({ ...row, disabled: 0, last_login_at: null });
      },
      findById(id) {
        const row = byIdStmt.get(id) as UserRow | undefined;
        return row === undefined ? undefined : toUser(row);
      },
      findByEmail(email) {
        const row = byEmailStmt.get(normalizeEmail(email)) as UserRow | undefined;
        return row === undefined ? undefined : toUser(row);
      },
      findByIcsToken(token) {
        const row = byIcsStmt.get(token) as UserRow | undefined;
        return row === undefined ? undefined : toUser(row);
      },
      list() {
        return (listStmt.all() as UserRow[]).map(toUser);
      },
      count() {
        return (countStmt.get() as { n: number }).n;
      },
      recordLogin(id, atISO) {
        loginStmt.run(atISO, id);
      },
      setRole(id, role) {
        roleStmt.run(role, id);
      },
      setDisabled(id, disabled) {
        disabledStmt.run(disabled ? 1 : 0, id);
      },
    };
  }
  ```

- [ ] **Step 5: Write `packages/server/src/db/repositories/sessions.ts`**

  ```ts
  import type { Db } from '../migrate.js';

  export interface SessionRecord {
    id: string;
    userId: string;
    createdAt: string;
    expiresAt: string;
    lastSeenAt: string;
    userAgent: string;
  }

  export interface CreateSessionInput {
    /** sha256 of the raw session id — the raw value never touches the database. */
    id: string;
    userId: string;
    expiresAt: string;
    userAgent?: string;
    nowISO?: string;
  }

  export interface SessionRepo {
    create(input: CreateSessionInput): SessionRecord;
    find(id: string): SessionRecord | undefined;
    touch(id: string, atISO: string): void;
    remove(id: string): void;
    removeAllForUser(userId: string): void;
    removeExpired(nowISO: string): number;
    count(): number;
  }

  interface SessionRow {
    id: string;
    user_id: string;
    created_at: string;
    expires_at: string;
    last_seen_at: string;
    user_agent: string;
  }

  function toSession(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      userAgent: row.user_agent,
    };
  }

  const COLUMNS = 'id, user_id, created_at, expires_at, last_seen_at, user_agent';

  export function createSessionRepo(db: Db): SessionRepo {
    const insertStmt = db.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent)
       VALUES (@id, @user_id, @created_at, @expires_at, @last_seen_at, @user_agent)`,
    );
    const findStmt = db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`);
    const touchStmt = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
    const removeStmt = db.prepare('DELETE FROM sessions WHERE id = ?');
    const removeUserStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
    const removeExpiredStmt = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM sessions');

    return {
      create(input) {
        const now = input.nowISO ?? new Date().toISOString();
        const row: SessionRow = {
          id: input.id,
          user_id: input.userId,
          created_at: now,
          expires_at: input.expiresAt,
          last_seen_at: now,
          user_agent: input.userAgent ?? '',
        };
        insertStmt.run(row);
        return toSession(row);
      },
      find(id) {
        const row = findStmt.get(id) as SessionRow | undefined;
        return row === undefined ? undefined : toSession(row);
      },
      touch(id, atISO) {
        touchStmt.run(atISO, id);
      },
      remove(id) {
        removeStmt.run(id);
      },
      removeAllForUser(userId) {
        removeUserStmt.run(userId);
      },
      removeExpired(nowISO) {
        return removeExpiredStmt.run(nowISO).changes;
      },
      count() {
        return (countStmt.get() as { n: number }).n;
      },
    };
  }
  ```

- [ ] **Step 6: Write `packages/server/src/db/repositories/profiles.ts`**

  ```ts
  import { randomUUID } from 'node:crypto';
  import { profileSchema } from '@grantspotter/core';
  import type { Profile } from '@grantspotter/core';
  import type { Db } from '../migrate.js';

  export type ProfileKind = Profile['kind'];

  export interface ProfileRepo {
    upsert(userId: string, profile: Profile): void;
    get(userId: string, kind: ProfileKind): Profile | undefined;
    listForUser(userId: string): Profile[];
    remove(userId: string, kind: ProfileKind): void;
  }

  export function createProfileRepo(db: Db): ProfileRepo {
    const upsertStmt = db.prepare(
      `INSERT INTO profiles (id, user_id, kind, data, updated_at)
       VALUES (@id, @user_id, @kind, @data, @updated_at)
       ON CONFLICT(user_id, kind) DO UPDATE SET
         data = excluded.data, updated_at = excluded.updated_at`,
    );
    const getStmt = db.prepare('SELECT data FROM profiles WHERE user_id = ? AND kind = ?');
    const listStmt = db.prepare('SELECT data FROM profiles WHERE user_id = ? ORDER BY kind');
    const removeStmt = db.prepare('DELETE FROM profiles WHERE user_id = ? AND kind = ?');

    return {
      upsert(userId, profile) {
        upsertStmt.run({
          id: randomUUID(),
          user_id: userId,
          kind: profile.kind,
          data: JSON.stringify(profile),
          updated_at: new Date().toISOString(),
        });
      },
      get(userId, kind) {
        const row = getStmt.get(userId, kind) as { data: string } | undefined;
        if (row === undefined) return undefined;
        // CONTRACT §6: JSON columns are validated on read.
        return profileSchema.parse(JSON.parse(row.data));
      },
      listForUser(userId) {
        return (listStmt.all(userId) as Array<{ data: string }>).map((row) =>
          profileSchema.parse(JSON.parse(row.data)),
        );
      },
      remove(userId, kind) {
        removeStmt.run(userId, kind);
      },
    };
  }
  ```

- [ ] **Step 7: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect **13 passing tests** in `accounts.test.ts`, the whole run green, and a clean typecheck.

- [ ] **Step 8: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/server
  git commit -m "feat(server): argon2id password hashing and user, session and profile repositories"
  ```

---
### Task 15: The Express app — error envelope, request ids, health

**This task defines the JSON error envelope that Plans 2–5 must match.** It is written down here so nobody invents a second one.

**Success responses have no wrapper.** A route returning a `Program` returns the `Program` object as the body. Lists return `{ items: T[], total: number }` where pagination matters (Plan 3 uses that shape); everything else returns the resource directly.

**Every failure response — without exception — has this body:**

```jsonc
{
  "error": {
    "code": "not_found",            // one of the nine codes below
    "message": "Program not found", // safe to show a user; never a stack trace
    "details": { }                  // optional, structured; zod issues live here
  },
  "requestId": "0f2b1f0a-…"         // also returned in the x-request-id header
}
```

| `code` | HTTP | when |
|---|---|---|
| `bad_request` | 400 | malformed input that is not a schema violation (e.g. unparsable JSON body) |
| `unauthorized` | 401 | no valid session |
| `forbidden` | 403 | authenticated but the role matrix says no |
| `not_found` | 404 | no such route or resource |
| `conflict` | 409 | state conflict (bootstrap after users exist, duplicate email) |
| `payload_too_large` | 413 | body over the 1 MB limit |
| `validation_failed` | 422 | zod rejected the payload; `details` carries `ZodIssue[]` |
| `rate_limited` | 429 | login throttle; `details.retryAfterSec` |
| `internal` | 500 | anything unexpected. The message is always the generic string — stacks are logged, never served |

### `createApp` seals the app: every later router mounts through `AppDeps.mountRoutes`

**This is the single highest-consequence line in Plan 1 (RESOLUTIONS R5, CONTRACT §10.3).** `createApp` finishes by registering `notFoundHandler()` and `errorHandler()`. Express matches middleware **in registration order**, so anything added to the returned app afterwards sits *behind* the 404 handler and never runs. There is no error, no warning, and no failing typecheck — every request to those routes simply comes back as Plan 1's `not_found` envelope. Left unfixed this would have made roughly twenty routers across Plans 3, 4 and 5 permanently unreachable.

So `AppDeps` carries a mount hook:

```ts
mountRoutes?: (app: Express) => void;
```

invoked on the line **immediately above** `app.use(notFoundHandler());`.

- **Calling `app.use(...)` on the object `createApp` returns is forbidden.** No plan does it. If you find yourself writing `const app = createApp(...); app.use('/api/whatever', …)`, the route is dead.
- Plans 3, 4 and 5 mount **exclusively** through this hook, from one call site in `packages/server/src/index.ts`. The callback is **filled incrementally, not written once** (RESOLUTIONS R25): Plan 3 Task 14 creates it with Plan 3's own routers and a comment reserving its final position, Plan 4 Task 17 Step 5 adds its four `create*Router(routerDeps)` lines above that comment, and Plan 5 Task 9 Step 9 adds its exports and calendar-feed mounts there too. No plan forward-references a module another plan has not written yet.
- **Static SPA serving lives inside the hook too, as its last statement** (RESOLUTIONS R16 + R25). Plan 1 neither creates nor mounts it, so to be unambiguous about who does: **Plan 3 Task 14 creates the callback and reserves its final position; Plan 5 Task 17** — the `api/spa.ts` task, inserted immediately before Plan 5's Dockerfile task — creates `packages/server/src/api/spa.ts` exporting `createSpaMiddleware(webDistDir: string): RequestHandler` and installs `a.use(createSpaMiddleware(webDistRoot()));` there as the last statement, after every `/api` mount. That middleware is `express.static(webDistDir, { index: false })` followed by a history fallback that sends `index.html` for any **GET** whose path does not start with `/api` or `/calendar`; every other request falls through untouched, so `notFoundHandler()` below still governs the API.
- Read Plan 1 on its own and the consequence is easy to get backwards, so state it plainly: in the shipped single-process container `GET /` and `GET /browse` return the SPA's `index.html` and **must not** reach `notFoundHandler()` — that is what makes `page.goto('/')` work for every Playwright spec — while `GET /api/anything-unknown` still returns the JSON `not_found` envelope. The `mountRoutes` tests in Step 1 therefore probe **`/api/...`** paths, never `/`.

**Files:**
- Create: `packages/server/src/api/errors.ts`, `packages/server/src/api/health.ts`, `packages/server/src/app.ts`
- Test: `packages/server/test/errors.test.ts`, `packages/server/test/app.health.test.ts`

**Interfaces:**
- Consumes: `Db` from `./db/migrate.js`; `AppConfig`, `SERVER_VERSION` from `./config.js`; `createProgramRepo` from `./db/repositories/programs.js`.
- Produces: `ApiErrorCode`, `ERROR_STATUS`, `ApiErrorBody`, `AppError`, `requestIdMiddleware()`, `notFoundHandler()`, `errorHandler(opts)`, `createHealthRouter(deps)`, `AppDeps` (including the `mountRoutes?: (app: Express) => void` hook that Plans 3–5 mount through), `createApp(deps): Express`.

- [ ] **Step 1: Write the failing tests**

  Create `packages/server/test/errors.test.ts`:

  ```ts
  import express, { type RequestHandler } from 'express';
  import request from 'supertest';
  import { describe, expect, it, vi } from 'vitest';
  import { z } from 'zod';
  import { AppError, ERROR_STATUS, errorHandler, notFoundHandler, requestIdMiddleware } from '../src/api/errors.js';

  function harness(handler: RequestHandler, logger = vi.fn()) {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use(requestIdMiddleware());
    app.post('/boom', handler);
    app.use(notFoundHandler());
    app.use(errorHandler({ logger }));
    return { app, logger };
  }

  describe('error envelope', () => {
    it('maps every AppError code to its documented status', async () => {
      for (const [code, status] of Object.entries(ERROR_STATUS)) {
        const { app } = harness(() => {
          throw new AppError(code as keyof typeof ERROR_STATUS, `failed: ${code}`);
        });
        const res = await request(app).post('/boom').send({});
        expect(res.status, code).toBe(status);
        expect(res.body.error.code).toBe(code);
        expect(res.body.error.message).toBe(`failed: ${code}`);
        expect(typeof res.body.requestId).toBe('string');
        expect(res.headers['x-request-id']).toBe(res.body.requestId);
      }
      expect(Object.keys(ERROR_STATUS)).toHaveLength(9);
    });

    it('carries structured details', async () => {
      const { app } = harness(() => {
        throw new AppError('rate_limited', 'Too many attempts.', { retryAfterSec: 900 });
      });
      const res = await request(app).post('/boom').send({});
      expect(res.status).toBe(429);
      expect(res.body.error.details).toEqual({ retryAfterSec: 900 });
    });

    it('turns a ZodError into 422 validation_failed with the issues attached', async () => {
      const schema = z.object({ email: z.string().email() });
      const { app } = harness((req) => {
        schema.parse(req.body);
      });
      const res = await request(app).post('/boom').send({ email: 'nope' });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('validation_failed');
      expect(Array.isArray(res.body.error.details)).toBe(true);
      expect(res.body.error.details[0].path).toEqual(['email']);
    });

    it('turns an unparsable JSON body into 400 bad_request', async () => {
      const { app } = harness((_req, res) => {
        res.json({ ok: true });
      });
      const res = await request(app)
        .post('/boom')
        .set('content-type', 'application/json')
        .send('{ not json');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('bad_request');
    });

    it('hides unexpected errors behind a generic 500 and logs them', async () => {
      const { app, logger } = harness(() => {
        throw new Error('secret database path /srv/private/db.sqlite');
      });
      const res = await request(app).post('/boom').send({});
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('internal');
      expect(res.body.error.message).toBe('Something went wrong.');
      expect(JSON.stringify(res.body)).not.toContain('/srv/private');
      expect(logger).toHaveBeenCalledTimes(1);
      expect(logger.mock.calls[0][0]).toContain('secret database path');
    });

    // `harness` is notFoundHandler in isolation — no SPA middleware — so a
    // non-/api path 404s here. In the assembled app that same path is answered
    // by the SPA history fallback Plan 5 Task 17 installs as the last statement
    // of Plan 3 Task 14's mountRoutes callback (RESOLUTIONS R16 + R25); the
    // createApp-level test below therefore probes an unknown /api path.
    it('answers an unknown route with a 404 envelope', async () => {
      const { app } = harness((_req, res) => {
        res.json({ ok: true });
      });
      const res = await request(app).get('/no/such/route');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    });

    it('echoes a well-formed inbound x-request-id and replaces a hostile one', async () => {
      const { app } = harness((_req, res) => {
        res.json({ ok: true });
      });
      const good = await request(app).get('/no/such/route').set('x-request-id', 'abc-123_XYZ');
      expect(good.body.requestId).toBe('abc-123_XYZ');

      const bad = await request(app).get('/no/such/route').set('x-request-id', '<script>x</script>');
      expect(bad.body.requestId).not.toBe('<script>x</script>');
      expect(bad.body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
  ```

  Create `packages/server/test/app.health.test.ts`:

  ```ts
  import { Router } from 'express';
  import request from 'supertest';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { createApp } from '../src/app.js';
  import { loadConfig } from '../src/config.js';
  import { createTestDb, type TestDb } from './helpers/tempDb.js';

  const config = loadConfig({
    SESSION_SECRET: 'x'.repeat(32),
    CONTACT_URL: 'https://example.org/grantspotter',
    NODE_ENV: 'test',
  });

  let harness: TestDb;
  beforeEach(() => {
    harness = createTestDb();
  });
  afterEach(() => harness.cleanup());

  describe('GET /api/health', () => {
    it('reports readiness without requiring a session', async () => {
      const app = createApp({ db: harness.db, config });
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.name).toBe('grantspotter');
      expect(res.body.version).toBe('0.1.0');
      // >= 1 rather than exactly 1: Plan 5 adds 090-ics-tokens.sql later.
      expect(res.body.migrations).toBeGreaterThanOrEqual(1);
      expect(res.body.programs).toBe(0);
      expect(typeof res.body.now).toBe('string');
    });

    it('returns the error envelope for an unknown API route', async () => {
      const app = createApp({ db: harness.db, config });
      const res = await request(app).get('/api/does-not-exist');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
      expect(typeof res.body.requestId).toBe('string');
    });
  });

  // RESOLUTIONS R5. createApp seals the app with notFoundHandler, so Plans 3-5
  // can only reach the router table through this hook. These two assertions are
  // what stop ~20 routers being silently unreachable.
  describe('AppDeps.mountRoutes', () => {
    function laterPlanRouter() {
      const router = Router();
      router.get('/mounted', (_req, res) => {
        res.json({ mounted: true });
      });
      return router;
    }

    it('reaches a router mounted through the hook', async () => {
      const app = createApp({
        db: harness.db,
        config,
        mountRoutes: (a) => {
          a.use('/api', laterPlanRouter());
        },
      });
      const res = await request(app).get('/api/mounted');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ mounted: true });
    });

    // RESOLUTIONS R16 + R25: this must stay an /api path. Once Plan 5 Task 17
    // installs createSpaMiddleware as the last statement of Plan 3 Task 14's
    // callback, an unknown non-/api GET is answered with index.html, but
    // /api/* still falls to this envelope.
    it('still answers an unknown /api path with the 404 envelope', async () => {
      const app = createApp({
        db: harness.db,
        config,
        mountRoutes: (a) => {
          a.use('/api', laterPlanRouter());
        },
      });
      const res = await request(app).get('/api/still-unknown');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
      expect(typeof res.body.requestId).toBe('string');
    });

    it('proves why mounting after createApp returns does not work', async () => {
      // This is the anti-pattern the hook exists to prevent. It is asserted
      // rather than merely described so nobody re-discovers it in Plan 4.
      const app = createApp({ db: harness.db, config });
      app.use('/api', laterPlanRouter());
      const res = await request(app).get('/api/mounted');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
    });
  });
  ```

- [ ] **Step 2: Run tests to verify they fail**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- errors app.health
  ```

  Expected failure: `Failed to resolve import "../src/api/errors.js"`.

- [ ] **Step 3: Write `packages/server/src/api/errors.ts`**

  ```ts
  import { randomUUID } from 'node:crypto';
  import type { ErrorRequestHandler, RequestHandler } from 'express';
  import { ZodError } from 'zod';

  export type ApiErrorCode =
    | 'bad_request'
    | 'validation_failed'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'rate_limited'
    | 'payload_too_large'
    | 'internal';

  export const ERROR_STATUS: Record<ApiErrorCode, number> = {
    bad_request: 400,
    unauthorized: 401,
    forbidden: 403,
    not_found: 404,
    conflict: 409,
    payload_too_large: 413,
    validation_failed: 422,
    rate_limited: 429,
    internal: 500,
  };

  export interface ApiErrorBody {
    error: { code: ApiErrorCode; message: string; details?: unknown };
    requestId: string;
  }

  export class AppError extends Error {
    readonly code: ApiErrorCode;
    readonly details?: unknown;

    constructor(code: ApiErrorCode, message: string, details?: unknown) {
      super(message);
      this.name = 'AppError';
      this.code = code;
      if (details !== undefined) this.details = details;
    }

    get status(): number {
      return ERROR_STATUS[this.code];
    }
  }

  const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

  export function requestIdMiddleware(): RequestHandler {
    return (req, res, next) => {
      const inbound = req.header('x-request-id');
      const requestId = inbound !== undefined && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
      res.locals.requestId = requestId;
      res.setHeader('x-request-id', requestId);
      next();
    };
  }

  export function notFoundHandler(): RequestHandler {
    return (_req, _res, next) => {
      next(new AppError('not_found', 'Not found.'));
    };
  }

  export interface ErrorHandlerOptions {
    logger?: (line: string) => void;
  }

  export function errorHandler(options: ErrorHandlerOptions = {}): ErrorRequestHandler {
    const log = options.logger ?? ((line: string) => console.error(line));

    return (err, _req, res, _next) => {
      const requestId = typeof res.locals.requestId === 'string' ? res.locals.requestId : randomUUID();

      let appError: AppError;
      if (err instanceof AppError) {
        appError = err;
      } else if (err instanceof ZodError) {
        appError = new AppError('validation_failed', 'The request body is invalid.', err.issues);
      } else if (
        err instanceof SyntaxError &&
        (err as SyntaxError & { type?: string }).type === 'entity.parse.failed'
      ) {
        appError = new AppError('bad_request', 'The request body is not valid JSON.');
      } else if ((err as { type?: string }).type === 'entity.too.large') {
        appError = new AppError('payload_too_large', 'The request body is too large.');
      } else {
        log(
          `[error] requestId=${requestId} ${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}`,
        );
        appError = new AppError('internal', 'Something went wrong.');
      }

      const body: ApiErrorBody = {
        error: { code: appError.code, message: appError.message },
        requestId,
      };
      if (appError.details !== undefined) body.error.details = appError.details;

      res.status(appError.status).json(body);
    };
  }
  ```

- [ ] **Step 4: Write `packages/server/src/api/health.ts`**

  ```ts
  import { Router } from 'express';
  import { SERVER_VERSION } from '../config.js';
  import type { Db } from '../db/migrate.js';
  import { createProgramRepo } from '../db/repositories/programs.js';

  export function createHealthRouter(db: Db): Router {
    const programs = createProgramRepo(db);
    const migrationCount = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations');

    const router = Router();
    router.get('/health', (_req, res) => {
      res.json({
        ok: true,
        name: 'grantspotter',
        version: SERVER_VERSION,
        migrations: (migrationCount.get() as { n: number }).n,
        programs: programs.count(),
        now: new Date().toISOString(),
      });
    });
    return router;
  }
  ```

- [ ] **Step 5: Write `packages/server/src/app.ts`**

  ```ts
  import cookieParser from 'cookie-parser';
  import express, { type Express } from 'express';
  import { errorHandler, notFoundHandler, requestIdMiddleware } from './api/errors.js';
  import { createHealthRouter } from './api/health.js';
  import type { AppConfig } from './config.js';
  import type { Db } from './db/migrate.js';

  export interface AppDeps {
    db: Db;
    config: AppConfig;
    logger?: (line: string) => void;
    /**
     * The ONLY way Plans 3-5 add routes. createApp seals the app with
     * notFoundHandler(), and Express matches in registration order, so calling
     * app.use(...) on the returned object registers routes behind the 404 and
     * they never run. Plan 3 owns the single call site, in src/index.ts, and
     * the callback is filled incrementally: Plan 3 Task 14 creates it and
     * reserves its final position, Plan 4 Task 17 and Plan 5 Task 9 add their
     * routers above that position (RESOLUTIONS R25).
     * The static SPA middleware goes through this hook as well, last of all:
     * Plan 5 Task 17 creates api/spa.ts and installs
     * a.use(createSpaMiddleware(webDistRoot())) in the reserved position, as
     * the callback's last statement (RESOLUTIONS R16 + R25).
     */
    mountRoutes?: (app: Express) => void;
  }

  export function createApp(deps: AppDeps): Express {
    const app = express();

    // Behind a reverse proxy (Cloudflare Tunnel, nginx) so req.secure and
    // req.ip reflect the client, which the session cookie flags depend on.
    app.set('trust proxy', 1);
    app.disable('x-powered-by');

    app.use(express.json({ limit: '1mb' }));
    app.use(cookieParser());
    app.use(requestIdMiddleware());

    app.use('/api', createHealthRouter(deps.db));

    // Everything Plans 3, 4 and 5 mount goes here, and nowhere else. The
    // callback is filled incrementally (RESOLUTIONS R25): Plan 3 Task 14
    // creates it and reserves its final position, Plan 4 Task 17 and Plan 5
    // Task 9 add their /api routers above that position. The static SPA
    // belongs in here too (RESOLUTIONS R16): Plan 5 Task 17 installs
    // a.use(createSpaMiddleware(webDistRoot())) in the reserved position, as
    // the LAST statement of this callback, after every /api router, so it
    // never shadows them and GET / never reaches notFoundHandler(). Nothing
    // may be added to the returned app: the two lines below seal it.
    deps.mountRoutes?.(app);

    app.use(notFoundHandler());
    const errorOptions = deps.logger === undefined ? {} : { logger: deps.logger };
    app.use(errorHandler(errorOptions));

    return app;
  }
  ```

- [ ] **Step 6: Run tests to verify they pass**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect **7 passing tests** in `errors.test.ts` and **5** in `app.health.test.ts` (two health, three `mountRoutes`), the whole run green, and a clean typecheck.

- [ ] **Step 7: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/server
  git commit -m "feat(server): JSON error envelope, request ids, health endpoint, and the mountRoutes hook"
  ```

---
### Task 16: Sessions, cookies, auth middleware, and the role matrix

**How sessions work here.** The session id is opaque random data, not a JWT. The raw id lives only in the cookie; the database stores its SHA-256, so a database leak does not hand over live sessions. `SESSION_SECRET` earns its keep by HMAC-signing the cookie: a forged or corrupted cookie is rejected by signature comparison before it ever touches the database. (Plan 5 reuses the same secret to sign per-user ICS feed tokens.)

**Spec §12 role matrix — implemented as named guards so Plans 2–5 use them verbatim instead of re-deriving them:**

| capability | admin | member | guard to use |
|---|---|---|---|
| Browse, match, calendar, watchlist, applications, exports | yes | yes | `requireBrowse` |
| **Verify now** on a single record | yes | yes (rate-limited per user, Plan 2) | `requireVerifyNow` |
| Review queue (Inbox): read | yes | yes | `requireInboxRead` |
| Review queue (Inbox): approve / reject / edit | yes | **no** | `requireInboxWrite` |
| Sources health and configuration: read | yes | yes | `requireSourcesRead` |
| Source configuration, crawl trigger | yes | **no** | `requireSourcesWrite` |
| User management | yes | **no** | `requireUserAdmin` |
| Full JSON backup / restore | yes | **no** | `requireBackup` |

Members see the Inbox read-only on purpose: knowing a deadline change is *pending review* is useful, and hiding it invites the "why is this list wrong?" complaint the trust surfaces exist to prevent.

**`requireUserAdmin` exists here and is consumed by Plan 3.** Plan 1 defines the guard (Step 5 below) and the `users` repository already supports `updateRole` / `setDisabled` (Task 14), but Plan 1 ships **no** user-management endpoint or page: per RESOLUTIONS R15, Plan 3 owns `/api/admin/users` (`GET` list, `POST` create, `PATCH` role/disabled, `DELETE`, all behind `requireUserAdmin()`) and `packages/web/src/routes/Admin.tsx`. Until Plan 3 lands, a deployed instance has exactly one account — the bootstrap admin — so nothing exercises the `member` half of this matrix.

**Files:**
- Create: `packages/server/src/api/types.ts`, `packages/server/src/auth/session.ts`, `packages/server/src/auth/middleware.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/session.test.ts`

**Interfaces:**
- Consumes: `AppError` from `../api/errors.js`; `SessionRepo`, `UserRepo`, `Role` from the repositories.
- Produces: `SESSION_COOKIE`, `SESSION_TTL_MS`, `newSessionId()`, `sessionIdHash()`, `signSessionCookie()`, `verifySessionCookie()`, `sessionCookieOptions()`; `AuthedUser`; `AuthDeps`, `attachUser(deps)`, `requireAuth()`, `requireRole(role)`, `requireAdmin()`, and the eight named role-matrix guards.

- [ ] **Step 1: Write the failing test**

  Create `packages/server/test/session.test.ts`:

  ```ts
  import express from 'express';
  import cookieParser from 'cookie-parser';
  import request from 'supertest';
  import { afterEach, beforeEach, describe, expect, it } from 'vitest';
  import { errorHandler, notFoundHandler, requestIdMiddleware } from '../src/api/errors.js';
  import {
    attachUser,
    requireAdmin,
    requireAuth,
    requireInboxRead,
    requireInboxWrite,
  } from '../src/auth/middleware.js';
  import {
    newSessionId,
    SESSION_COOKIE,
    sessionIdHash,
    signSessionCookie,
    verifySessionCookie,
  } from '../src/auth/session.js';
  import { createSessionRepo } from '../src/db/repositories/sessions.js';
  import { createUserRepo, type Role } from '../src/db/repositories/users.js';
  import { createTestDb, type TestDb } from './helpers/tempDb.js';

  const SECRET = 's'.repeat(32);

  let harness: TestDb;
  beforeEach(() => {
    harness = createTestDb();
  });
  afterEach(() => harness.cleanup());

  function buildApp() {
    const users = createUserRepo(harness.db);
    const sessions = createSessionRepo(harness.db);
    const app = express();
    app.use(cookieParser());
    app.use(requestIdMiddleware());
    app.use(attachUser({ users, sessions, sessionSecret: SECRET }));
    app.get('/who', (req, res) => {
      res.json({ auth: req.auth ?? null });
    });
    app.get('/private', requireAuth(), (req, res) => {
      res.json({ role: req.auth?.role });
    });
    app.get('/inbox', requireInboxRead(), (_req, res) => {
      res.json({ ok: true });
    });
    app.post('/inbox/approve', requireInboxWrite(), (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/admin', requireAdmin(), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(notFoundHandler());
    app.use(errorHandler({ logger: () => undefined }));
    return { app, users, sessions };
  }

  function login(
    users: ReturnType<typeof createUserRepo>,
    sessions: ReturnType<typeof createSessionRepo>,
    role: Role,
    expiresAt = new Date(Date.now() + 86_400_000).toISOString(),
  ) {
    const user = users.create({ email: `${role}@example.org`, passwordHash: 'h', role });
    const rawId = newSessionId();
    sessions.create({ id: sessionIdHash(rawId), userId: user.id, expiresAt });
    return { user, cookie: `${SESSION_COOKIE}=${signSessionCookie(rawId, SECRET)}` };
  }

  describe('session cookie crypto', () => {
    it('mints high-entropy, unique ids', () => {
      const a = newSessionId();
      const b = newSessionId();
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThanOrEqual(43);
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('hashes the id with SHA-256 so the raw value never reaches the database', () => {
      const raw = newSessionId();
      expect(sessionIdHash(raw)).toMatch(/^[0-9a-f]{64}$/);
      expect(sessionIdHash(raw)).toBe(sessionIdHash(raw));
      expect(sessionIdHash(raw)).not.toContain(raw);
    });

    it('round-trips a signed cookie', () => {
      const raw = newSessionId();
      expect(verifySessionCookie(signSessionCookie(raw, SECRET), SECRET)).toBe(raw);
    });

    it('rejects tampering, a wrong secret and malformed values', () => {
      const raw = newSessionId();
      const signed = signSessionCookie(raw, SECRET);
      expect(verifySessionCookie(`${signed}x`, SECRET)).toBeNull();
      expect(verifySessionCookie(signed, 'w'.repeat(32))).toBeNull();
      expect(verifySessionCookie(signSessionCookie('other-id', SECRET).replace('other-id', raw), SECRET)).toBeNull();
      expect(verifySessionCookie('no-dot-here', SECRET)).toBeNull();
      expect(verifySessionCookie('', SECRET)).toBeNull();
      expect(verifySessionCookie('.sig', SECRET)).toBeNull();
    });
  });

  describe('attachUser', () => {
    it('attaches the user for a valid signed cookie', async () => {
      const { app, users, sessions } = buildApp();
      const { user, cookie } = login(users, sessions, 'member');
      const res = await request(app).get('/who').set('Cookie', cookie);
      expect(res.body.auth).toEqual({
        id: user.id,
        email: user.email,
        displayName: '',
        role: 'member',
      });
    });

    it('ignores a missing, unsigned, unknown or expired session', async () => {
      const { app, users, sessions } = buildApp();
      expect((await request(app).get('/who')).body.auth).toBeNull();
      expect(
        (await request(app).get('/who').set('Cookie', `${SESSION_COOKIE}=garbage`)).body.auth,
      ).toBeNull();

      const orphan = signSessionCookie(newSessionId(), SECRET);
      expect(
        (await request(app).get('/who').set('Cookie', `${SESSION_COOKIE}=${orphan}`)).body.auth,
      ).toBeNull();

      const expired = login(users, sessions, 'admin', '2020-01-01T00:00:00.000Z');
      expect((await request(app).get('/who').set('Cookie', expired.cookie)).body.auth).toBeNull();
      // the expired row is swept as a side effect
      expect(sessions.count()).toBe(0);
    });

    it('ignores a disabled user', async () => {
      const { app, users, sessions } = buildApp();
      const { user, cookie } = login(users, sessions, 'admin');
      users.setDisabled(user.id, true);
      expect((await request(app).get('/who').set('Cookie', cookie)).body.auth).toBeNull();
    });
  });

  describe('role guards', () => {
    it('answers 401 with the error envelope when signed out', async () => {
      const { app } = buildApp();
      const res = await request(app).get('/private');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('answers 403 when the role is wrong', async () => {
      const { app, users, sessions } = buildApp();
      const { cookie } = login(users, sessions, 'member');
      const res = await request(app).get('/admin').set('Cookie', cookie);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    });

    it('gives members the Inbox read-only and admins full access', async () => {
      const { app, users, sessions } = buildApp();
      const member = login(users, sessions, 'member');
      const admin = login(users, sessions, 'admin');

      expect((await request(app).get('/inbox').set('Cookie', member.cookie)).status).toBe(200);
      expect((await request(app).post('/inbox/approve').set('Cookie', member.cookie)).status).toBe(403);
      expect((await request(app).get('/inbox').set('Cookie', admin.cookie)).status).toBe(200);
      expect((await request(app).post('/inbox/approve').set('Cookie', admin.cookie)).status).toBe(200);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- session
  ```

  Expected failure: `Failed to resolve import "../src/auth/session.js"`.

- [ ] **Step 3: Write `packages/server/src/api/types.ts`**

  ```ts
  import type { Role } from '../db/repositories/users.js';

  export interface AuthedUser {
    id: string;
    email: string;
    displayName: string;
    role: Role;
  }

  // Module augmentation: attachUser populates these on the request. This file
  // is imported by auth/middleware.ts, which is what loads the augmentation.
  declare module 'express-serve-static-core' {
    interface Request {
      auth?: AuthedUser;
      /** SHA-256 of the raw session id — the primary key of the sessions row. */
      sessionKey?: string;
    }
  }
  ```

- [ ] **Step 4: Write `packages/server/src/auth/session.ts`**

  ```ts
  import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
  import type { CookieOptions, Request } from 'express';

  export const SESSION_COOKIE = 'gs_session';
  export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

  /** 32 bytes of entropy. The raw value exists only in the cookie. */
  export function newSessionId(): string {
    return randomBytes(32).toString('base64url');
  }

  /** What is stored in the sessions table, so a database leak yields no live sessions. */
  export function sessionIdHash(rawId: string): string {
    return createHash('sha256').update(rawId, 'utf8').digest('hex');
  }

  function sign(rawId: string, secret: string): string {
    return createHmac('sha256', secret).update(rawId).digest('base64url');
  }

  export function signSessionCookie(rawId: string, secret: string): string {
    return `${rawId}.${sign(rawId, secret)}`;
  }

  /** Returns the raw session id, or null if the value is forged or malformed. */
  export function verifySessionCookie(value: string, secret: string): string | null {
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const rawId = value.slice(0, dot);
    const provided = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(sign(rawId, secret));
    if (provided.length !== expected.length) return null;
    return timingSafeEqual(provided, expected) ? rawId : null;
  }

  export function sessionCookieOptions(req: Request, maxAgeMs: number = SESSION_TTL_MS): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      // `trust proxy` is set in createApp, so req.secure reflects the client's
      // scheme through a reverse proxy rather than the internal hop.
      secure: req.secure,
      path: '/',
      maxAge: maxAgeMs,
    };
  }
  ```

- [ ] **Step 5: Write `packages/server/src/auth/middleware.ts`**

  ```ts
  import type { RequestHandler } from 'express';
  import { AppError } from '../api/errors.js';
  import type { AuthedUser } from '../api/types.js';
  import type { SessionRepo } from '../db/repositories/sessions.js';
  import type { Role, UserRepo } from '../db/repositories/users.js';
  import { SESSION_COOKIE, sessionIdHash, verifySessionCookie } from './session.js';

  export interface AuthDeps {
    users: UserRepo;
    sessions: SessionRepo;
    sessionSecret: string;
  }

  /** Only rewrite last_seen_at when it is this stale, to avoid a write per request. */
  const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

  /**
   * Populates req.auth when the request carries a valid session. Never rejects:
   * anonymous requests simply continue with req.auth undefined, and the route
   * guards decide what that means.
   */
  export function attachUser(deps: AuthDeps): RequestHandler {
    return (req, _res, next) => {
      const cookies = req.cookies as Record<string, string | undefined> | undefined;
      const raw = cookies?.[SESSION_COOKIE];
      if (typeof raw !== 'string') return next();

      const rawId = verifySessionCookie(raw, deps.sessionSecret);
      if (rawId === null) return next();

      const key = sessionIdHash(rawId);
      const session = deps.sessions.find(key);
      if (session === undefined) return next();

      const nowMs = Date.now();
      if (Date.parse(session.expiresAt) <= nowMs) {
        deps.sessions.remove(key);
        return next();
      }

      const user = deps.users.findById(session.userId);
      if (user === undefined || user.disabled) return next();

      const auth: AuthedUser = {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      };
      req.auth = auth;
      req.sessionKey = key;

      if (nowMs - Date.parse(session.lastSeenAt) > TOUCH_INTERVAL_MS) {
        deps.sessions.touch(key, new Date(nowMs).toISOString());
      }
      return next();
    };
  }

  export function requireAuth(): RequestHandler {
    return (req, _res, next) => {
      if (req.auth === undefined) return next(new AppError('unauthorized', 'Sign in to continue.'));
      return next();
    };
  }

  export function requireRole(role: Role): RequestHandler {
    return (req, _res, next) => {
      if (req.auth === undefined) return next(new AppError('unauthorized', 'Sign in to continue.'));
      if (req.auth.role !== role) {
        return next(new AppError('forbidden', `This action requires the ${role} role.`));
      }
      return next();
    };
  }

  export function requireAdmin(): RequestHandler {
    return requireRole('admin');
  }

  // Spec §12 role matrix, named once so Plans 2-5 never re-derive it.
  export const requireBrowse = requireAuth;
  export const requireVerifyNow = requireAuth;
  export const requireInboxRead = requireAuth;
  export const requireInboxWrite = requireAdmin;
  export const requireSourcesRead = requireAuth;
  export const requireSourcesWrite = requireAdmin;
  export const requireUserAdmin = requireAdmin;
  export const requireBackup = requireAdmin;
  ```

- [ ] **Step 6: Wire `attachUser` into `createApp`**

  In `packages/server/src/app.ts`, add these imports:

  ```ts
  import { attachUser } from './auth/middleware.js';
  import { createSessionRepo } from './db/repositories/sessions.js';
  import { createUserRepo } from './db/repositories/users.js';
  ```

  and insert this immediately after `app.use(requestIdMiddleware());`:

  ```ts
    app.use(
      attachUser({
        users: createUserRepo(deps.db),
        sessions: createSessionRepo(deps.db),
        sessionSecret: deps.config.sessionSecret,
      }),
    );
  ```

- [ ] **Step 7: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck
  ```

  Expect **10 passing tests** in `session.test.ts`, the whole run green, and a clean typecheck. If TypeScript reports `Property 'auth' does not exist on type 'Request'`, `api/types.ts` is not being imported anywhere — `auth/middleware.ts` must import `AuthedUser` from it for the module augmentation to load.

- [ ] **Step 8: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/server
  git commit -m "feat(server): HMAC-signed opaque sessions, auth middleware, and the spec §12 role matrix"
  ```

---
### Task 17: Auth routes — first-run bootstrap, rate-limited login, logout, me

Spec §12: *"First-run admin bootstrap via a one-time token printed to the container log. No public signup by default. Login is rate-limited."*

**Why the bootstrap token lives in memory, not in a table.** The token exists only until the first admin is created. Holding it in the process and printing it to stdout is exactly the "printed to the container log" behaviour the spec asks for, it adds no table outside CONTRACT §6's fifteen, and a restart simply prints a fresh one. Once any user exists, the bootstrap endpoint answers `409 conflict` forever.

**Files:**
- Create: `packages/server/src/auth/rateLimit.ts`, `packages/server/src/auth/bootstrap.ts`
- Create: `packages/server/src/api/asyncHandler.ts`, `packages/server/src/api/auth.ts`
- Modify: `packages/server/src/app.ts`
- Replace: `packages/server/src/index.ts`
- Test: `packages/server/test/api.auth.test.ts`

**Interfaces:**
- Consumes: `AppError` from `./errors.js`; `hashPassword`, `verifyPassword`, `assertPasswordPolicy`, `WeakPasswordError`; the user/session repos; `SESSION_COOKIE`, `SESSION_TTL_MS`, `newSessionId`, `sessionIdHash`, `signSessionCookie`, `sessionCookieOptions`; `requireAuth`.
- Produces: `createRateLimiter(opts): RateLimiter`, `createBootstrapState(db, log?): BootstrapState`, `asyncHandler(fn)`, `createAuthRouter(deps): Router`, and a runnable `packages/server/src/index.ts`.

- [ ] **Step 1: Write the failing test**

  Create `packages/server/test/api.auth.test.ts`:

  ```ts
  import request from 'supertest';
  import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
  import { createApp } from '../src/app.js';
  import { createBootstrapState } from '../src/auth/bootstrap.js';
  import { createRateLimiter } from '../src/auth/rateLimit.js';
  import { SESSION_COOKIE } from '../src/auth/session.js';
  import { loadConfig } from '../src/config.js';
  import { createSessionRepo } from '../src/db/repositories/sessions.js';
  import { createTestDb, type TestDb } from './helpers/tempDb.js';

  const config = loadConfig({
    SESSION_SECRET: 'z'.repeat(32),
    CONTACT_URL: 'https://example.org/grantspotter',
    NODE_ENV: 'test',
  });

  const GOOD_PASSWORD = 'a-long-enough-password';

  let harness: TestDb;
  beforeEach(() => {
    harness = createTestDb();
  });
  afterEach(() => harness.cleanup());

  function build(logLines: string[] = []) {
    const bootstrap = createBootstrapState(harness.db, (line) => logLines.push(line));
    const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, maxFailures: 5 });
    const app = createApp({
      db: harness.db,
      config,
      bootstrap,
      loginLimiter,
      logger: () => undefined,
    });
    return { app, bootstrap, loginLimiter, logLines };
  }

  function cookieFrom(res: request.Response): string {
    const header = res.headers['set-cookie'];
    const raw = Array.isArray(header) ? header : [header];
    const found = raw.find((c) => typeof c === 'string' && c.startsWith(`${SESSION_COOKIE}=`));
    if (found === undefined) throw new Error('no session cookie was set');
    return found.split(';')[0];
  }

  describe('rate limiter', () => {
    it('blocks after the configured number of failures and recovers after the window', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 3 });
      expect(limiter.check('k', 0).allowed).toBe(true);
      limiter.recordFailure('k', 0);
      limiter.recordFailure('k', 10);
      expect(limiter.check('k', 20).allowed).toBe(true);
      limiter.recordFailure('k', 20);

      const blocked = limiter.check('k', 30);
      expect(blocked.allowed).toBe(false);
      expect(blocked.retryAfterSec).toBeGreaterThan(0);

      expect(limiter.check('k', 1500).allowed).toBe(true);
    });

    it('forgets a key on reset and keys are independent', () => {
      const limiter = createRateLimiter({ windowMs: 1000, maxFailures: 1 });
      limiter.recordFailure('a', 0);
      expect(limiter.check('a', 0).allowed).toBe(false);
      expect(limiter.check('b', 0).allowed).toBe(true);
      limiter.reset('a');
      expect(limiter.check('a', 0).allowed).toBe(true);
    });
  });

  describe('first-run bootstrap', () => {
    it('prints a one-time token to the log when no accounts exist', () => {
      const { logLines } = build();
      expect(logLines.join('\n')).toContain('GrantSpotter first-run setup');
      expect(logLines.join('\n')).toMatch(/[0-9a-f]{48}/);
    });

    it('reports that bootstrap is required, then that it is not', async () => {
      const { app, bootstrap } = build();
      expect((await request(app).get('/api/auth/bootstrap-status')).body).toEqual({ required: true });

      const res = await request(app).post('/api/auth/bootstrap').send({
        token: bootstrap.token(),
        email: 'admin@example.org',
        password: GOOD_PASSWORD,
        displayName: 'First Admin',
      });
      expect(res.status).toBe(201);
      expect(res.body.user.role).toBe('admin');
      expect(res.body.user.email).toBe('admin@example.org');
      expect(res.body.user.displayName).toBe('First Admin');
      expect(JSON.stringify(res.body)).not.toContain('argon2');
      expect(cookieFrom(res)).toContain(`${SESSION_COOKIE}=`);

      expect((await request(app).get('/api/auth/bootstrap-status')).body).toEqual({
        required: false,
      });
    });

    it('sets an httpOnly cookie on the bootstrap response', async () => {
      const { app, bootstrap } = build();
      const res = await request(app)
        .post('/api/auth/bootstrap')
        .send({ token: bootstrap.token(), email: 'admin@example.org', password: GOOD_PASSWORD });
      const header = res.headers['set-cookie'];
      const raw = (Array.isArray(header) ? header : [header]).join(';');
      expect(raw).toContain('HttpOnly');
      expect(raw).toContain('SameSite=Lax');
    });

    it('rejects a wrong token and burns the right one after use', async () => {
      const { app, bootstrap } = build();
      const token = bootstrap.token();
      const wrong = await request(app)
        .post('/api/auth/bootstrap')
        .send({ token: 'nope', email: 'a@example.org', password: GOOD_PASSWORD });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe('unauthorized');

      await request(app)
        .post('/api/auth/bootstrap')
        .send({ token, email: 'admin@example.org', password: GOOD_PASSWORD });

      const again = await request(app)
        .post('/api/auth/bootstrap')
        .send({ token, email: 'second@example.org', password: GOOD_PASSWORD });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('conflict');
    });

    it('rejects a weak password and an invalid body', async () => {
      const { app, bootstrap } = build();
      const weak = await request(app)
        .post('/api/auth/bootstrap')
        .send({ token: bootstrap.token(), email: 'admin@example.org', password: 'short' });
      expect(weak.status).toBe(422);
      expect(weak.body.error.code).toBe('validation_failed');

      const malformed = await request(app).post('/api/auth/bootstrap').send({ token: 'x' });
      expect(malformed.status).toBe(422);
    });
  });

  describe('login, me and logout', () => {
    async function seedAdmin(app: ReturnType<typeof build>['app'], bootstrap: ReturnType<typeof build>['bootstrap']) {
      await request(app)
        .post('/api/auth/bootstrap')
        .send({ token: bootstrap.token(), email: 'admin@example.org', password: GOOD_PASSWORD });
    }

    it('signs in, identifies the user, and signs out', async () => {
      const { app, bootstrap } = build();
      await seedAdmin(app, bootstrap);

      const login = await request(app)
        .post('/api/auth/login')
        .send({ email: 'ADMIN@example.org', password: GOOD_PASSWORD });
      expect(login.status).toBe(200);
      expect(login.body.user.role).toBe('admin');
      const cookie = cookieFrom(login);

      const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe('admin@example.org');
      expect(me.body.user.lastLoginAt).toBeDefined();
      expect(Object.keys(me.body.user)).not.toContain('passwordHash');
      expect(Object.keys(me.body.user)).not.toContain('icsToken');

      const logout = await request(app).post('/api/auth/logout').set('Cookie', cookie);
      expect(logout.status).toBe(204);
      expect(createSessionRepo(harness.db).count()).toBe(0);

      const after = await request(app).get('/api/auth/me').set('Cookie', cookie);
      expect(after.status).toBe(401);
    });

    it('answers 401 for /api/auth/me with no session', async () => {
      const { app } = build();
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('gives the same generic answer for a wrong password and an unknown email', async () => {
      const { app, bootstrap } = build();
      await seedAdmin(app, bootstrap);

      const wrongPassword = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@example.org', password: 'a-different-password' });
      const unknownEmail = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@example.org', password: GOOD_PASSWORD });

      expect(wrongPassword.status).toBe(401);
      expect(unknownEmail.status).toBe(401);
      expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
      expect(wrongPassword.body.error.message).toBe('Incorrect email or password.');
    });

    it('refuses a disabled account', async () => {
      const { app, bootstrap } = build();
      await seedAdmin(app, bootstrap);
      harness.db.prepare('UPDATE users SET disabled = 1').run();
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@example.org', password: GOOD_PASSWORD });
      expect(res.status).toBe(401);
    });

    it('rate-limits repeated failures and clears the counter on success', async () => {
      const { app, bootstrap } = build();
      await seedAdmin(app, bootstrap);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await request(app)
          .post('/api/auth/login')
          .send({ email: 'admin@example.org', password: 'wrong-password-here' });
        expect(res.status).toBe(401);
      }

      const blocked = await request(app)
        .post('/api/auth/login')
        .send({ email: 'admin@example.org', password: GOOD_PASSWORD });
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('rate_limited');
      expect(blocked.body.error.details.retryAfterSec).toBeGreaterThan(0);
    }, 20_000);

    it('does not expose a signup route', async () => {
      const { app } = build();
      const res = await request(app).post('/api/auth/register').send({});
      expect(res.status).toBe(404);
    });
  });

  describe('bootstrap state is derived from the database, not cached', () => {
    it('is not required when a user already exists at startup', () => {
      harness.db
        .prepare(
          'INSERT INTO users (id, email, email_normalized, password_hash, role, ics_token, created_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run('u1', 'a@example.org', 'a@example.org', 'h', 'admin', 'tok', 'now');
      const log = vi.fn();
      const bootstrap = createBootstrapState(harness.db, log);
      expect(bootstrap.required()).toBe(false);
      expect(bootstrap.token()).toBeNull();
      expect(log).not.toHaveBeenCalled();
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- api.auth
  ```

  Expected failure: `Failed to resolve import "../src/auth/bootstrap.js"`.

- [ ] **Step 3: Write `packages/server/src/auth/rateLimit.ts`**

  ```ts
  export interface RateLimitDecision {
    allowed: boolean;
    retryAfterSec: number;
  }

  export interface RateLimiter {
    check(key: string, nowMs?: number): RateLimitDecision;
    recordFailure(key: string, nowMs?: number): void;
    reset(key: string): void;
  }

  export interface RateLimiterOptions {
    windowMs: number;
    maxFailures: number;
  }

  /**
   * In-memory sliding-window failure counter. Single-process by design: this app
   * runs as one Node process (spec §3), so a shared store would be ceremony.
   */
  export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
    const failures = new Map<string, number[]>();

    function recent(key: string, nowMs: number): number[] {
      const kept = (failures.get(key) ?? []).filter((at) => nowMs - at < options.windowMs);
      if (kept.length === 0) failures.delete(key);
      else failures.set(key, kept);
      return kept;
    }

    return {
      check(key, nowMs = Date.now()) {
        const hits = recent(key, nowMs);
        if (hits.length < options.maxFailures) return { allowed: true, retryAfterSec: 0 };
        const oldest = hits[0];
        const retryAfterMs = options.windowMs - (nowMs - oldest);
        return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      },
      recordFailure(key, nowMs = Date.now()) {
        const hits = recent(key, nowMs);
        hits.push(nowMs);
        failures.set(key, hits);
      },
      reset(key) {
        failures.delete(key);
      },
    };
  }
  ```

- [ ] **Step 4: Write `packages/server/src/auth/bootstrap.ts`**

  ```ts
  import { randomBytes, timingSafeEqual } from 'node:crypto';
  import type { Db } from '../db/migrate.js';

  export interface BootstrapState {
    /** True while no account exists. Recomputed from the database on each call. */
    required(): boolean;
    /** The one-time token, or null once an account exists. */
    token(): string | null;
    /** Timing-safe comparison; clears the token on success. */
    consume(candidate: string): boolean;
  }

  function banner(token: string): string {
    return [
      '============================================================',
      ' GrantSpotter first-run setup',
      '',
      ' No accounts exist yet. Create the first administrator by',
      ' POSTing to /api/auth/bootstrap with this one-time token:',
      '',
      `     ${token}`,
      '',
      ' { "token": "...", "email": "...", "password": "..." }',
      '',
      ' A fresh token is printed on every restart until an admin',
      ' account exists. There is no public signup.',
      '============================================================',
    ].join('\n');
  }

  export function createBootstrapState(
    db: Db,
    log: (line: string) => void = (line) => console.log(line),
  ): BootstrapState {
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM users');
    const userCount = (): number => (countStmt.get() as { n: number }).n;

    let token: string | null = null;
    if (userCount() === 0) {
      token = randomBytes(24).toString('hex');
      log(banner(token));
    }

    return {
      required() {
        return userCount() === 0;
      },
      token() {
        return userCount() === 0 ? token : null;
      },
      consume(candidate) {
        if (token === null || userCount() > 0) return false;
        const a = Buffer.from(candidate);
        const b = Buffer.from(token);
        if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
        token = null;
        return true;
      },
    };
  }
  ```

- [ ] **Step 5: Write `packages/server/src/api/asyncHandler.ts`**

  ```ts
  import type { NextFunction, Request, RequestHandler, Response } from 'express';

  /**
   * Express 4 does not forward rejected promises to the error handler, so every
   * async route must be wrapped or a thrown AppError becomes a hung request.
   */
  export function asyncHandler(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  ): RequestHandler {
    return (req, res, next) => {
      void fn(req, res, next).catch(next);
    };
  }
  ```

- [ ] **Step 6: Write `packages/server/src/api/auth.ts`**

  ```ts
  import { randomBytes } from 'node:crypto';
  import { Router, type Request, type Response } from 'express';
  import { z } from 'zod';
  import type { BootstrapState } from '../auth/bootstrap.js';
  import { requireAuth } from '../auth/middleware.js';
  import {
    assertPasswordPolicy,
    hashPassword,
    verifyPassword,
    WeakPasswordError,
  } from '../auth/password.js';
  import type { RateLimiter } from '../auth/rateLimit.js';
  import {
    newSessionId,
    SESSION_COOKIE,
    SESSION_TTL_MS,
    sessionCookieOptions,
    sessionIdHash,
    signSessionCookie,
  } from '../auth/session.js';
  import type { AppConfig } from '../config.js';
  import type { Db } from '../db/migrate.js';
  import { createSessionRepo } from '../db/repositories/sessions.js';
  import { createUserRepo, normalizeEmail, toPublicUser } from '../db/repositories/users.js';
  import { asyncHandler } from './asyncHandler.js';
  import { AppError } from './errors.js';

  export interface AuthRouterDeps {
    db: Db;
    config: AppConfig;
    bootstrap: BootstrapState;
    loginLimiter: RateLimiter;
  }

  const credentialsSchema = z.object({
    email: z.string().min(3).max(320),
    password: z.string().min(1).max(512),
  });

  const bootstrapSchema = credentialsSchema.extend({
    token: z.string().min(1).max(256),
    displayName: z.string().max(120).optional(),
  });

  export function createAuthRouter(deps: AuthRouterDeps): Router {
    const users = createUserRepo(deps.db);
    const sessions = createSessionRepo(deps.db);
    const router = Router();

    // Compared against on a failed lookup so an unknown email costs roughly the
    // same wall time as a wrong password. Computed once, lazily.
    let dummyHash: Promise<string> | undefined;
    const getDummyHash = (): Promise<string> => {
      dummyHash ??= hashPassword(randomBytes(24).toString('hex'));
      return dummyHash;
    };

    function startSession(req: Request, res: Response, userId: string): void {
      const rawId = newSessionId();
      sessions.create({
        id: sessionIdHash(rawId),
        userId,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        userAgent: (req.header('user-agent') ?? '').slice(0, 255),
      });
      res.cookie(
        SESSION_COOKIE,
        signSessionCookie(rawId, deps.config.sessionSecret),
        sessionCookieOptions(req),
      );
    }

    router.get('/auth/bootstrap-status', (_req, res) => {
      res.json({ required: deps.bootstrap.required() });
    });

    router.post(
      '/auth/bootstrap',
      asyncHandler(async (req, res) => {
        const body = bootstrapSchema.parse(req.body);

        if (!deps.bootstrap.required()) {
          throw new AppError('conflict', 'An account already exists; bootstrap is closed.');
        }
        if (!deps.bootstrap.consume(body.token)) {
          throw new AppError('unauthorized', 'That bootstrap token is not valid.');
        }
        try {
          assertPasswordPolicy(body.password);
        } catch (err) {
          if (err instanceof WeakPasswordError) {
            throw new AppError('validation_failed', err.message);
          }
          throw err;
        }

        const user = users.create({
          email: body.email,
          passwordHash: await hashPassword(body.password),
          role: 'admin',
          ...(body.displayName === undefined ? {} : { displayName: body.displayName }),
        });
        startSession(req, res, user.id);
        res.status(201).json({ user: toPublicUser(user) });
      }),
    );

    router.post(
      '/auth/login',
      asyncHandler(async (req, res) => {
        const body = credentialsSchema.parse(req.body);
        const key = `${req.ip ?? 'unknown'}|${normalizeEmail(body.email)}`;

        const decision = deps.loginLimiter.check(key);
        if (!decision.allowed) {
          throw new AppError('rate_limited', 'Too many sign-in attempts. Try again later.', {
            retryAfterSec: decision.retryAfterSec,
          });
        }

        const user = users.findByEmail(body.email);
        const ok =
          user !== undefined && !user.disabled
            ? await verifyPassword(user.passwordHash, body.password)
            : await verifyPassword(await getDummyHash(), body.password);

        if (!ok || user === undefined) {
          deps.loginLimiter.recordFailure(key);
          throw new AppError('unauthorized', 'Incorrect email or password.');
        }

        deps.loginLimiter.reset(key);
        const at = new Date().toISOString();
        users.recordLogin(user.id, at);
        startSession(req, res, user.id);
        res.json({ user: toPublicUser({ ...user, lastLoginAt: at }) });
      }),
    );

    router.post('/auth/logout', (req, res) => {
      if (req.sessionKey !== undefined) sessions.remove(req.sessionKey);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.status(204).end();
    });

    router.get('/auth/me', requireAuth(), (req, res) => {
      const user = req.auth === undefined ? undefined : users.findById(req.auth.id);
      if (user === undefined) throw new AppError('unauthorized', 'Sign in to continue.');
      res.json({ user: toPublicUser(user) });
    });

    return router;
  }
  ```

- [ ] **Step 7: Wire the auth router into `createApp`**

  In `packages/server/src/app.ts`, add:

  ```ts
  import { createAuthRouter } from './api/auth.js';
  import { createBootstrapState, type BootstrapState } from './auth/bootstrap.js';
  import { createRateLimiter, type RateLimiter } from './auth/rateLimit.js';
  ```

  extend `AppDeps` with two optional injection points (keeping Task 15's `mountRoutes` hook — it is the only way Plans 3–5 reach the router table, and dropping it while editing this interface would silently make every one of their routes unreachable):

  ```ts
  export interface AppDeps {
    db: Db;
    config: AppConfig;
    logger?: (line: string) => void;
    /** RESOLUTIONS R5 — see Task 15. Called immediately before notFoundHandler(). */
    mountRoutes?: (app: Express) => void;
    bootstrap?: BootstrapState;
    loginLimiter?: RateLimiter;
  }
  ```

  and mount the router immediately after the health router:

  ```ts
    const bootstrap = deps.bootstrap ?? createBootstrapState(deps.db);
    const loginLimiter =
      deps.loginLimiter ?? createRateLimiter({ windowMs: 15 * 60 * 1000, maxFailures: 5 });

    app.use('/api', createAuthRouter({ db: deps.db, config: deps.config, bootstrap, loginLimiter }));
  ```

- [ ] **Step 8: Replace `packages/server/src/index.ts` with the real entrypoint**

  ```ts
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
  ```

- [ ] **Step 9: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test && npm run typecheck && npm run build
  ```

  Expect **14 passing tests** in `api.auth.test.ts`, the whole run green, a clean typecheck and a clean build. The login rate-limit test performs six argon2 verifications and is given a 20-second timeout for that reason.

- [ ] **Step 10: Prove the refusal to start, by hand**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter
  SESSION_SECRET= CONTACT_URL=https://example.org/gs DATA_DIR=./.tmp-data \
    node packages/server/dist/index.js; echo "exit=$?"
  ```

  Expect `[config] SESSION_SECRET is required and has no default. Generate one with: openssl rand -hex 32`, then `[config] Refusing to start. See .env.example.` and `exit=1`. Then remove the scratch directory: `rm -rf ./.tmp-data`.

- [ ] **Step 11: Commit**

  ```bash
  cd /path/to/grantspotter
  git add packages/server
  git commit -m "feat(server): first-run bootstrap, rate-limited login, logout, me, and the entrypoint"
  ```

---
### Task 18: The web workspace stub, the typed API client, and full Plan 1 verification

Plan 3 builds the real SPA. This task delivers only what Plans 2–5 need to exist now: a `@grantspotter/web` workspace that type-checks and builds, and the API client that encodes the error envelope so no later plan invents a second one.

**The error-code union is duplicated in `packages/web/src/api/client.ts` on purpose.** Import direction is one-way — `web → core`, `server → core` — so the web package may not import from `server`. The duplicate carries a comment naming `packages/server/src/api/errors.ts` as the source of truth, and Task 15's `ERROR_STATUS` test guards the server half.

**This task owns the `packages/web` scaffold and the typed client; Plan 3 MODIFIES these eight files and must not re-create them** (RESOLUTIONS R11, CONTRACT §10.6): `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/api/client.ts`. Re-creating them would delete `apiFetch<T>()`, `ApiErrorCode`, `ApiErrorBody`, `ApiFetchOptions`, `PublicUser` and the six endpoint wrappers, break `packages/web/test/client.test.ts`, and downgrade the pinned `vite 6.4.3` / `@vitejs/plugin-react 4.7.0` to a caret range. Plan 1's pinned, exact (non-caret) versions stand; Plan 3 adds only `react-router-dom` and its test dependencies, replaces `App.tsx`'s body with the router, and folds `packages/web/test/client.test.ts`'s assertions into `packages/web/src/api/client.test.ts` before deleting the old file. **`ApiError`'s signature is canonical and does not change: `(code: ApiErrorCode, message: string, status: number, requestId: string, details?: unknown)`** — Plan 3 defines `apiGet` / `apiSend` as thin wrappers over `apiFetch` rather than a second error class.

`packages/web/src/styles/index.css` is Plan 1's only stylesheet and the ninth file in that set. Plan 3 supersedes it with `tokens.css` + `base.css` and deletes it **together with its `main.tsx` import**, so no orphaned stylesheet ships.

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vite.config.ts`, `packages/web/vitest.config.ts`, `packages/web/index.html`
- Create: `packages/web/src/main.tsx`, `packages/web/src/App.tsx`, `packages/web/src/api/client.ts`, `packages/web/src/styles/index.css`
- Modify: `package.json` (root scripts), `vitest.workspace.ts`
- Test: `packages/web/test/client.test.ts`

**Interfaces:**
- Consumes: `/api/health`, `/api/auth/*` from Task 15 and Task 17.
- Produces: `ApiError`, `ApiErrorCode`, `ApiErrorBody`, `apiFetch<T>()`, `getHealth()`, `getBootstrapStatus()`, `postBootstrap()`, `postLogin()`, `postLogout()`, `getMe()`, and the `PublicUser` shape the SPA renders.

- [ ] **Step 1: Write the failing test**

  Create `packages/web/test/client.test.ts`:

  ```ts
  import { afterEach, describe, expect, it, vi } from 'vitest';
  import { ApiError, apiFetch, getHealth, postLogin } from '../src/api/client.js';

  function stubFetch(response: Response): ReturnType<typeof vi.fn> {
    const fn = vi.fn(async () => response);
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('apiFetch', () => {
    it('returns the parsed body on success and sends cookies', async () => {
      const fetchMock = stubFetch(jsonResponse(200, { ok: true, programs: 0 }));
      await expect(getHealth()).resolves.toEqual({ ok: true, programs: 0 });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/health');
      expect(init.credentials).toBe('include');
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
    });

    it('serialises a JSON body with the right content type', async () => {
      const fetchMock = stubFetch(jsonResponse(200, { user: { id: 'u1' } }));
      await postLogin({ email: 'a@example.org', password: 'a-long-enough-password' });

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/auth/login');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({
        email: 'a@example.org',
        password: 'a-long-enough-password',
      });
    });

    it('turns the server error envelope into an ApiError', async () => {
      stubFetch(
        jsonResponse(429, {
          error: {
            code: 'rate_limited',
            message: 'Too many sign-in attempts. Try again later.',
            details: { retryAfterSec: 900 },
          },
          requestId: 'req-42',
        }),
      );

      await expect(apiFetch('/api/auth/login', { method: 'POST', body: {} })).rejects.toThrow(
        ApiError,
      );

      try {
        await apiFetch('/api/auth/login', { method: 'POST', body: {} });
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        const apiError = err as ApiError;
        expect(apiError.code).toBe('rate_limited');
        expect(apiError.status).toBe(429);
        expect(apiError.requestId).toBe('req-42');
        expect(apiError.message).toBe('Too many sign-in attempts. Try again later.');
        expect(apiError.details).toEqual({ retryAfterSec: 900 });
      }
    });

    it('falls back to an internal ApiError when the body is not an envelope', async () => {
      stubFetch(new Response('<html>502 Bad Gateway</html>', { status: 502 }));
      try {
        await getHealth();
        expect.unreachable('should have thrown');
      } catch (err) {
        const apiError = err as ApiError;
        expect(apiError).toBeInstanceOf(ApiError);
        expect(apiError.code).toBe('internal');
        expect(apiError.status).toBe(502);
        expect(apiError.requestId).toBe('');
      }
    });

    it('resolves undefined for a 204', async () => {
      stubFetch(new Response(null, { status: 204 }));
      await expect(apiFetch<void>('/api/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- client
  ```

  Expected failure: no `web` project exists yet, so vitest reports `No test files found` (or fails to resolve `../src/api/client.js` once the project is registered).

- [ ] **Step 3: Create the web workspace files**

  `packages/web/package.json`:

  ```json
  {
    "name": "@grantspotter/web",
    "version": "0.1.0",
    "private": true,
    "type": "module",
    "scripts": {
      "dev": "vite",
      "build": "vite build",
      "preview": "vite preview",
      "typecheck": "tsc --noEmit -p tsconfig.json"
    },
    "dependencies": {
      "@grantspotter/core": "*",
      "react": "18.3.1",
      "react-dom": "18.3.1"
    },
    "devDependencies": {
      "@types/react": "18.3.31",
      "@types/react-dom": "18.3.7",
      "@vitejs/plugin-react": "4.7.0",
      "vite": "6.4.3"
    }
  }
  ```

  `packages/web/tsconfig.json` — bundler resolution and JSX, which is why web cannot live in the root type-check project:

  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "lib": ["ES2022", "DOM", "DOM.Iterable"],
      "module": "ESNext",
      "moduleResolution": "Bundler",
      "jsx": "react-jsx",
      "strict": true,
      "noUnusedLocals": true,
      "noUnusedParameters": true,
      "noFallthroughCasesInSwitch": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "forceConsistentCasingInFileNames": true,
      "resolveJsonModule": true,
      "isolatedModules": true,
      "noEmit": true,
      "types": ["vite/client"]
    },
    "include": ["src/**/*.ts", "src/**/*.tsx", "test/**/*.ts", "vite.config.ts", "vitest.config.ts"]
  }
  ```

  `packages/web/vite.config.ts` — 127.0.0.1 is loopback, not a LAN address, so it is safe to commit:

  ```ts
  import react from '@vitejs/plugin-react';
  import { defineConfig } from 'vite';

  export default defineConfig({
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { '/api': { target: 'http://127.0.0.1:3030', changeOrigin: false } },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  });
  ```

  `packages/web/vitest.config.ts` — `client.ts` is framework-free, so it needs no DOM environment:

  ```ts
  import { defineConfig } from 'vitest/config';

  export default defineConfig({
    test: { name: 'web', environment: 'node', include: ['test/**/*.test.ts'] },
  });
  ```

  `packages/web/index.html`:

  ```html
  <!doctype html>
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>GrantSpotter</title>
    </head>
    <body>
      <div id="root"></div>
      <script type="module" src="/src/main.tsx"></script>
    </body>
  </html>
  ```

  `packages/web/src/styles/index.css`:

  ```css
  :root {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
    color-scheme: light dark;
  }

  body {
    margin: 0;
    padding: 2rem;
  }

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  ```

- [ ] **Step 4: Write `packages/web/src/api/client.ts`**

  ```ts
  /**
   * Source of truth for these codes is packages/server/src/api/errors.ts.
   * They are restated here because import direction is one-way: web may import
   * from core, never from server.
   */
  export type ApiErrorCode =
    | 'bad_request'
    | 'validation_failed'
    | 'unauthorized'
    | 'forbidden'
    | 'not_found'
    | 'conflict'
    | 'rate_limited'
    | 'payload_too_large'
    | 'internal';

  export interface ApiErrorBody {
    error: { code: ApiErrorCode; message: string; details?: unknown };
    requestId: string;
  }

  export class ApiError extends Error {
    readonly code: ApiErrorCode;
    readonly status: number;
    readonly requestId: string;
    readonly details?: unknown;

    constructor(
      code: ApiErrorCode,
      message: string,
      status: number,
      requestId: string,
      details?: unknown,
    ) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
      this.requestId = requestId;
      if (details !== undefined) this.details = details;
    }
  }

  export interface ApiFetchOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    body?: unknown;
    signal?: AbortSignal;
  }

  function isErrorBody(value: unknown): value is ApiErrorBody {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = (value as { error?: unknown }).error;
    return (
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof (candidate as { code?: unknown }).code === 'string' &&
      typeof (candidate as { message?: unknown }).message === 'string'
    );
  }

  export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
    const init: RequestInit = {
      method: options.method ?? 'GET',
      credentials: 'include',
    };
    if (options.signal !== undefined) init.signal = options.signal;
    if (options.body !== undefined) {
      init.headers = { 'content-type': 'application/json' };
      init.body = JSON.stringify(options.body);
    }

    const response = await fetch(path, init);
    if (response.status === 204) return undefined as T;

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      if (isErrorBody(payload)) {
        throw new ApiError(
          payload.error.code,
          payload.error.message,
          response.status,
          payload.requestId ?? '',
          payload.error.details,
        );
      }
      throw new ApiError('internal', `Request failed with status ${response.status}.`, response.status, '');
    }

    return payload as T;
  }

  // ---- typed endpoint wrappers ----

  export interface HealthResponse {
    ok: boolean;
    name: string;
    version: string;
    migrations: number;
    programs: number;
    now: string;
  }

  export interface PublicUser {
    id: string;
    email: string;
    displayName: string;
    role: 'admin' | 'member';
    createdAt: string;
    lastLoginAt?: string;
  }

  export async function getHealth(): Promise<HealthResponse> {
    return apiFetch<HealthResponse>('/api/health');
  }

  export async function getBootstrapStatus(): Promise<{ required: boolean }> {
    return apiFetch<{ required: boolean }>('/api/auth/bootstrap-status');
  }

  export async function postBootstrap(body: {
    token: string;
    email: string;
    password: string;
    displayName?: string;
  }): Promise<{ user: PublicUser }> {
    return apiFetch<{ user: PublicUser }>('/api/auth/bootstrap', { method: 'POST', body });
  }

  export async function postLogin(body: {
    email: string;
    password: string;
  }): Promise<{ user: PublicUser }> {
    return apiFetch<{ user: PublicUser }>('/api/auth/login', { method: 'POST', body });
  }

  export async function postLogout(): Promise<void> {
    return apiFetch<void>('/api/auth/logout', { method: 'POST' });
  }

  export async function getMe(): Promise<{ user: PublicUser }> {
    return apiFetch<{ user: PublicUser }>('/api/auth/me');
  }
  ```

- [ ] **Step 5: Write `packages/web/src/App.tsx` and `packages/web/src/main.tsx`**

  `App.tsx` — a real status page, not a placeholder. Plan 3 replaces it with the router:

  ```tsx
  import { useEffect, useState } from 'react';
  import { ApiError, getBootstrapStatus, getHealth, type HealthResponse } from './api/client.js';

  export function App(): JSX.Element {
    const [health, setHealth] = useState<HealthResponse | null>(null);
    const [bootstrapRequired, setBootstrapRequired] = useState<boolean | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      let cancelled = false;
      void (async () => {
        try {
          const [healthResult, bootstrapResult] = await Promise.all([
            getHealth(),
            getBootstrapStatus(),
          ]);
          if (cancelled) return;
          setHealth(healthResult);
          setBootstrapRequired(bootstrapResult.required);
        } catch (err) {
          if (cancelled) return;
          setError(err instanceof ApiError ? err.message : 'Could not reach the GrantSpotter API.');
        }
      })();
      return () => {
        cancelled = true;
      };
    }, []);

    return (
      <main>
        <h1>GrantSpotter</h1>
        <p>A self-hosted funding desk for collegiate and educational amateur radio.</p>
        {error !== null && <p role="alert">{error}</p>}
        {health !== null && (
          <dl>
            <dt>Version</dt>
            <dd>{health.version}</dd>
            <dt>Migrations applied</dt>
            <dd>{health.migrations}</dd>
            <dt>Programs in the corpus</dt>
            <dd>{health.programs}</dd>
          </dl>
        )}
        {bootstrapRequired === true && (
          <p>
            No account exists yet. Check the server log for the one-time bootstrap token, then POST
            it to <code>/api/auth/bootstrap</code>.
          </p>
        )}
      </main>
    );
  }
  ```

  `main.tsx`:

  ```tsx
  import { StrictMode } from 'react';
  import { createRoot } from 'react-dom/client';
  import { App } from './App.js';
  import './styles/index.css';

  const container = document.getElementById('root');
  if (container === null) throw new Error('#root is missing from index.html');

  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  ```

- [ ] **Step 6: Register web in the workspace and the root scripts**

  `vitest.workspace.ts`:

  ```ts
  import { defineWorkspace } from 'vitest/config';

  export default defineWorkspace(['packages/core', 'packages/server', 'packages/web']);
  ```

  In the root `package.json`, replace the `typecheck`, `build` and `dev:web` scripts:

  ```json
      "typecheck": "tsc --noEmit -p tsconfig.json && npm run typecheck -w @grantspotter/web",
      "build": "npm run build -w @grantspotter/core && npm run build -w @grantspotter/server && npm run build -w @grantspotter/web",
      "dev:web": "npm run dev -w @grantspotter/web",
  ```

  Then install the new workspace's dependencies:

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm install
  ```

- [ ] **Step 7: Run test to verify it passes**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter && npm test -- client
  ```

  Expect `Tests 5 passed (5)` in the `web` project.

- [ ] **Step 8: Run the full Plan 1 verification**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter
  npm run typecheck && npm test && npm run build
  ```

  Expect, in order:
  - a clean `tsc --noEmit` for core + server, then a clean `tsc --noEmit` for web;
  - every test green across the `core`, `server` and `web` vitest projects, with zero skipped;
  - `packages/core/dist/index.js`, `packages/server/dist/index.js`, `packages/server/dist/db/migrations/001-init.sql` and `packages/web/dist/index.html` all on disk.

- [ ] **Step 9: Smoke-test the running server by hand**

  ```bash
  export PATH="/path/to/node20/bin:$PATH"
  cd /path/to/grantspotter
  SESSION_SECRET="$(openssl rand -hex 32)" CONTACT_URL=https://example.org/grantspotter \
    DATA_DIR=./.tmp-smoke PORT=3031 CRAWL_ENABLED=false \
    node packages/server/dist/index.js &
  sleep 2
  curl -s http://127.0.0.1:3031/api/health
  curl -s http://127.0.0.1:3031/api/auth/bootstrap-status
  curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3031/api/auth/me
  kill %1
  rm -rf ./.tmp-smoke
  ```

  Expect the boxed first-run banner with a 48-hex-character token in the server output, a health JSON body with `"ok":true`, `{"required":true}`, and `401` for `/api/auth/me`.

- [ ] **Step 10: Commit**

  ```bash
  cd /path/to/grantspotter
  git add package.json package-lock.json vitest.workspace.ts packages/web
  git commit -m "feat(web): workspace stub and the typed API client encoding the error envelope"
  ```

  **Do not push.** Commits stay local through all five plans; the single push happens at the end of Plan 5 after the completeness audit and the debug audit.

---

## Plan 1 is done when

- [ ] `npm run typecheck` is clean across `core`, `server` and `web`.
- [ ] `npm test` is green across the three vitest projects (`core`, `server`, `web`) with nothing skipped.
- [ ] `npm run build` produces `packages/core/dist`, `packages/server/dist` (including `dist/db/migrations/001-init.sql`) and `packages/web/dist`.
- [ ] The purity test passes: `packages/core` declares exactly one runtime dependency (`zod`) and its `src/` contains no `node:` import, no `process.*`, no `require(`, no `import.meta`, no `fetch(` and no `Buffer`.
- [ ] The matcher suite covers **all thirteen eligibility axes** and **all four shape-conflicts** (applicant entity, award instrument via `parseAmount` tiers, deadline via all ten `DeadlineKind` values, apply-via as a typed enum), which is the "done when" condition spec §17 sets for this plan.
- [ ] The two load-bearing matcher rules are proven by test: a soft constraint never excludes (the Louisiana cascade), and missing profile data yields `unknown` with the specific fields that would resolve it.
- [ ] `hashProgram` provably ignores `lastVerifiedAt`.
- [ ] The server refuses to start with no `SESSION_SECRET`, exits 1, and says why.
- [ ] A router mounted through `AppDeps.mountRoutes` is reachable, the 404 envelope still fires for an unknown **`/api`** path, and the anti-pattern test proves a router added after `createApp` returns is **not** reachable (RESOLUTIONS R5). The hook is also where the SPA is served from — Plan 3 Task 14 creates the callback and reserves its final position; **Plan 5 Task 17** installs `a.use(createSpaMiddleware(webDistRoot()));` there as the last statement (RESOLUTIONS R16 + R25) — so no Plan 1 assertion may claim that a non-`/api` `GET` 404s in the assembled app.
- [ ] `createProgramRepo(db).findBySourceKey(sourceId, externalKey)` round-trips, the partial unique index on `programs(source_id, external_key)` rejects a duplicate, and an `upsert` with no `sourceKey` preserves the stored one (RESOLUTIONS R1/R9).
- [ ] `001-init.sql` declares `review_items.candidate_json`, `review_items.created_at ... DEFAULT ''`, and the autoincrementing `snapshots` shape with `body_bytes` + nullable `file_path` (RESOLUTIONS R2/R3), each proven by the migrate test running the exact statements Plans 2 and 3 issue.
- [ ] `001-init.sql` declares `applications` and `template_instances` in Plan 4's column list (RESOLUTIONS R24) — `answers_json`, `fact_confirmations_json`, `include_disclosure`, `facts_confirmed_at`, nullable `program_id`; `position`, `filled_markdown`, `unresolved_slots_json` — with no `status`, no `facts`, no `markdown`, no `unresolved_slots` and no `template_instances.updated_at`, proven by the migrate test running Plan 4's own INSERT statements. And the completeness gate — `grep -rn "CREATE TABLE.*applications\|CREATE TABLE.*template_instances\|idx_applications_user\|idx_template_instances_application" packages/server/src/db/migrations | grep -v ':[[:space:]]*--'` — returns **exactly four non-comment lines, all in `001-init.sql`**: `CREATE TABLE applications`, `CREATE INDEX idx_applications_user`, `CREATE TABLE template_instances`, `CREATE INDEX idx_template_instances_application`. The `grep -v` is load-bearing: without it the same search returns **seven**, because three further matches are inside `001-init.sql`'s own R24 explanatory comment, which quotes those identifiers deliberately. **Never reconcile the count by deleting lines from `001-init.sql`** — removing `CREATE TABLE applications` orphans `CREATE INDEX idx_applications_user` and migration 001 aborts with `no such table: applications`, so nothing boots. The count matters because SQLite matches `IF NOT EXISTS` on the name, so a second `CREATE TABLE` or `CREATE INDEX` in any other migration file silently never runs. (Plan 4 Task 16's equivalent gate asks a different question — it counts matches *outside* `001-init.sql` and requires `0` — and is correct as written.)
- [ ] `buildUserAgent` exists in exactly one file, accepts `AppConfig | string`, and both forms produce the identical string (RESOLUTIONS R10).
- [ ] **`packages/server/vitest.config.ts` includes BOTH `src/**/*.test.ts` and `test/**/*.test.ts`.** Plan 1 has no `src` test of its own to catch this, so assert it directly: `grep -q "src/\*\*/\*.test.ts" packages/server/vitest.config.ts`. Plans 2-5 put all 87 of their server tests under `src/`; with a `test/**`-only include, `npm test` reports success while running none of them, and every later "expect N tests passing" gate silently checks nothing.
- [ ] **`packages/server/tsconfig.build.json` excludes `src/**/*.test.ts` and `src/test/**`.** Assert with `grep -q '"src/test/\*\*"' packages/server/tsconfig.build.json`. Without it, test files that import upward out of `rootDir` (Plan 3's `src/test/testDb.ts`, ~15 of Plan 2's `src/sources/*.test.ts`) fail the build with `TS6059`, `packages/server/dist/index.js` is never emitted, and Playwright's `webServer` never starts. `npm run typecheck` stays green regardless, so it will not warn you.
- [ ] Nothing has been pushed.

## What Plan 1 hands to the later plans

| Plan | What it consumes from here |
|---|---|
| **2 — Ingestion** | `RawOpportunity`, `SourceModule`, `FetchRequest`, `FetchedPayload`, `ChangeEvent`, `ReviewItem` types; `parseAmount`, `parseRecurrence`/`RECURRENCE_PREFIX` (which its normalizer must emit into `DeadlineSpec.note` — see the R12 handoff in Task 5), `hashProgram` and `withContentHash` for diffing, `expandCycles` for projecting cycles into the `cycles` table, the `sources`/`snapshots`/`change_events`/`review_items` tables (Task 12's DDL is authoritative: `snapshots` autoincrements and has `body_bytes`/`file_path`; `review_items` uses `candidate_json`; source health lives on `sources`, there is no `source_health` table), `createProgramRepo` including `findBySourceKey` for id reconciliation, `buildUserAgent` from `config.ts` (Plan 2 defines no second copy), `AppError` + the error envelope, `asyncHandler`, and the role guards `requireInboxRead` / `requireInboxWrite` / `requireSourcesRead` / `requireSourcesWrite`. It adds the root `verify-sources` script. |
| **3 — Product surface** | `matchProgram` / `matchAll` and the `Verdict` union, `expandCycles` for the calendar, `evaluateGeo`, `statesForArrl*`, `createProgramRepo` (`.get(id)` / `.list(filter)` — `programs` has no `data` column), `createProfileRepo`, `createCycleRepo`, `requireBrowse` / `requireVerifyNow` / `requireUserAdmin` (for its `/api/admin/users` router), **`AppDeps.mountRoutes` — the single mount site for every later router: Plan 3 Task 14 creates the callback with its own routers and reserves its final position, Plan 4 Task 17 and Plan 5 Task 9 Step 9 add theirs above it, and Plan 5 Task 17 installs `a.use(createSpaMiddleware(webDistRoot()));` there as the last statement so the SPA answers `GET /` (RESOLUTIONS R16 + R25)**, and the `packages/web` scaffold + `apiFetch` / `ApiError` from Task 18, which it modifies rather than re-creates. It adds the root `test:e2e` script and the Playwright config. |
| **4 — Writing tools** | `Program`, `AiPolicy`, `Obligations`, `Constraint.rawText`, `Profile` for slot filling, `AppError` for the analyzer routes, `AppDeps.mountRoutes` (its four routers go inside Plan 3 Task 14's callback, added there by Plan 4's own Task 17 Step 5; Plan 4 never calls `app.use` on the app `createApp` returns), and **the `applications` and `template_instances` tables — Task 12's DDL is authoritative and carries Plan 4's own column list verbatim (RESOLUTIONS R24)**. Plan 4 ships no migration for these tables; it asserts this shape with `assertApplicationSchema(db)` in `db/repositories/applications.ts` — it creates neither table and declares neither index, and nothing deletes these two `CREATE TABLE` statements from `001-init.sql` — doing so would leave `CREATE INDEX idx_applications_user` pointing at a table that does not exist and migration 001 would fail outright. |
| **5 — Exports, seed, deploy** | Every core type for the seed corpus, `withContentHash` for seeded records, `RECURRENCE_PREFIX` notation in seeded `DeadlineSpec.note` values (Task 5's R12 handoff names the three programmes that must carry it), `createFunderRepo` / `createProgramRepo` — including `upsert(program, sourceKey)` so each seeded record's `sourceKey` reaches `programs.source_id` / `external_key` — `createCycleRepo` for the importer, `requireBackup`, `AppDeps.mountRoutes` (Plan 5 mounts its own exports and calendar-feed routers inside Plan 3 Task 14's callback via its Task 9 Step 9 — `a.use('/api', createExportsRouter(exportDeps))` and `a.use('/', createCalendarFeedRouter(exportDeps))`, built from `req.auth?.id`, never `req.session` — and its Task 17 installs `a.use(createSpaMiddleware(webDistRoot()));` in the position Plan 3 reserved, as the callback's last statement; RESOLUTIONS R16 + R25), `.env.example`, and `migrate.ts` for the container start-up path. It performs the single push. |

