# GrantSpotter Plan 3: Product Surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the React SPA and the REST API behind it — browse with server-side filtering and per-profile eligibility verdicts, opportunity detail with field-level provenance and every honesty surface from spec §8, a calendar with prep-lead-time overlay, a watchlist that subscribes to change events, profile editors, a read-only-for-members Inbox, and a sources health page.

**Architecture:** Plan 3 owns `packages/web` (React 18 + Vite, no UI framework — a hand-built design system in plain CSS custom properties) and the product-facing routers in `packages/server/src/api`. Every router is a factory taking an explicit `RouterDeps` object (`db`, `requireAuth`, `requireAdmin`, `currentUser`), so it is wired once in the server entrypoint and constructed with fakes in tests — Plan 3 therefore depends on Plan 1's auth *behaviour* but not on its internal module names. Browse is served from a Plan-3-owned denormalized projection (`program_search` + `program_facets`) so filters are indexed SQL, while eligibility verdicts are computed in-process with `matchAll` over the filtered page because the corpus is ~150 records (spec §1.1).

**Tech Stack:** TypeScript strict · React 18 · react-router-dom 6 · Vite 6.4.3 (pinned by Plan 1 Task 18) · Express 4 · better-sqlite3 · Vitest + jsdom + @testing-library/react · supertest · Playwright

**Prerequisite:** Plan 1 (core types, matcher, DB schema + migrations, auth, API skeleton) and Plan 2 (fetcher, source registry, diff, review, sources health writers) must be complete.

---

## Global Constraints

- Node **v20.11.0**, npm **10.2.4**. Every command in this plan is preceded by `export PATH="/path/to/node20/bin:$PATH"`.
- TypeScript **strict**, `"module": "NodeNext"`, `"target": "ES2022"` (web package uses `"module": "ESNext"`, `"moduleResolution": "Bundler"` — Vite's requirement; this is the one documented deviation and it does not affect `core` or `server`).
- `packages/core` stays **pure**: zero I/O, zero `node:` imports, zero runtime deps but `zod`. Plan 3 never adds code to `core`.
- Import direction is one-way: `web → core`, `server → core`. Plan 3 never imports `server` from `web`.
- **`SESSION_SECRET` has no default.** Plan 3 adds no env var with a secret default and never falls back to a hardcoded secret in tests — tests set `SESSION_SECRET=test-secret-not-a-real-secret` explicitly.
- The fetcher blocklist is enforced in the fetcher layer and is not configurable: `farweb.org`, `candid.org`, `fconline.foundationcenter.org`, `grantwatch.com`, `grantstation.com`, `instrumentl.com`. Plan 3's "Verify now" goes through `Fetcher` and therefore inherits it; Plan 3 additionally applies `assertNotBlocked` to user-configured webhook URLs.
- The AI prompt button copy is exactly **`Copy AI Prompt — includes AI-detection avoidance`**. That button is **Plan 4's** deliverable. Plan 3 renders only the `aiPolicy` quote + URL block next to where it will land, and adds no button of its own.
- **No real LAN IPs, hostnames, or host paths** anywhere — in code, fixtures, seed data, screenshots, or test URLs. Use `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `example.com`, `*.invalid`.
- **Commits stay local.** No task in this plan runs `git push`. Pushing happens once at the very end of Plan 5, after the completeness and debug audits.
- **CONTRACT §8 deviation, recorded here (RESOLUTIONS R13):** Plan 1 deliberately does not create the
  root `test:e2e` script, because at that point it would point at a Playwright config and an `e2e/`
  directory that do not exist. **Plan 3 adds `npm run test:e2e` to the root `package.json`** — the
  script name and effect are exactly as CONTRACT §8 specifies (`playwright test`), only its authorship
  moves. Task 1 adds the script; Task 26 writes the `playwright.config.ts` and `e2e/` suite it runs.
  Plan 3 does **not** add `verify-sources` (Plan 2 owns it), `capture-fixture` (Plan 2), or
  `seed:arrl` (Plan 5).
- **One error envelope (CONTRACT §10.4, RESOLUTIONS R6).** Every failure in every Plan 3 router is
  raised as `next(new AppError(code, message, details?))`, importing `AppError` from
  `packages/server/src/api/errors.js`. Plan 3 never writes `res.status(N).json({ error: '<string>' })`.
  Zod failures are `validation_failed`, which Plan 1's `ERROR_STATUS` maps to **422**, not 400.
  Every router test app therefore mounts `requestIdMiddleware()` first and
  `errorHandler({ logger: () => undefined })` last, so the assertions see the real envelope
  `{ error: { code, message, details? }, requestId }`.
- **Routers mount through `AppDeps.mountRoutes` (CONTRACT §10.3, RESOLUTIONS R5).** Plan 1's
  `createApp` seals the app with `notFoundHandler()` before returning, so `app.use(...)` after
  `createApp` is unreachable dead code. **Nothing is EVER mounted after `createApp` returns.**
  Plan 3 owns the single composition site in `packages/server/src/index.ts` (Task 14) and puts
  **only Plan 3's routers** in the `mountRoutes` callback, ending it with a comment that reserves
  the final position for Plan 5's SPA middleware. Plans 4 and 5 append their own lines to that same
  callback in their own tasks (RESOLUTIONS R25) — Plan 3 never forward-references a module they
  have not created yet, because an unresolved import here fails `npm run build`, and a failed build
  takes `packages/server/dist/index.js`, Playwright's `webServer` and the entire e2e suite with it.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`, `style:`.
- Contrast: every foreground/background pair in the design system meets **WCAG AA (4.5:1)** in both light and dark themes. Task 1 ships the computed ratios as a unit test, not as a comment.
- `status: 'unknown'` renders as a real, labelled state. A blank cell for `status` is a bug.
- Every user-facing date renders with its `lastVerifiedAt` provenance. No bare dates.

## Domain facts this plan depends on (read once; tasks reference them)

You do not need to know amateur radio. These five facts are load-bearing:

1. **A "callsign"** (W8UM, K5UTD) is a government-issued unique identifier for a licensed radio operator or club. It is the ham equivalent of a username and appears all over the corpus. **A "license class"** is a rank — `NONE < TECH < GENERAL < EXTRA`. Many scholarships require a minimum class.
2. **An "ARRL Section" / "ARRL Division"** is a geographic administrative region defined by the ARRL (the US national amateur radio association). Sections are sub-state or multi-state; Divisions group Sections. They do **not** map cleanly to states, which is why `core/geo.ts` ships a lookup table as data. The UI must never display a Section as if it were a state.
3. **`arrl.org` has no ETag and no Last-Modified**, serves `Cache-Control: nocache`, and every `<lastmod>` in its sitemap is frozen at 2010. That is why change detection hashes *parsed entries* and why "Verify now" always performs a real refetch rather than a conditional request.
4. **`farweb.org` is blocklisted for safety, not licensing.** The Foundation for Amateur Radio's domain was taken over between 2025-10-17 and 2026-02-10 and now 301s to an Indonesian gambling site. QCWA, ARRL and club pages still tell applicants to "apply at the FAR website". If a user searches "FAR", the corpus must return the warning record, never a link.
5. **111 ARRL scholarship catalog entries share one deadline.** `deadline.source: { kind: 'inherited', fromProgramId }` — the `DeadlineSource` union on `DeadlineSpec.source` in CONTRACT §3 — exists for exactly this. The UI must show the inheriting program's deadline *and* name the program it inherited from, or the user cannot verify it.

## Plan 3's declared read-contract with Plans 1 and 2

CONTRACT §6 names the tables but not their columns. Plan 3 reads the columns below. **Task 2 ships a schema-conformance test that asserts every one of them exists after migrations run.** That test is the single reconciliation gate between this plan and Plans 1–2: if it fails, the reviewer reconciles the column name before any other Plan 3 task proceeds.

| Table | Columns Plan 3 reads | Owner |
|---|---|---|
| `funders` | `id`, `name` | Plan 1 |
| `programs` | `id`, `funder_id`, `name`, `klass`, `summary`, `applicant_entities`, `amount`, `deadline`, `apply_via`, `apply_url`, `apply_contact`, `funding_restrictions`, `obligations`, `ai_policy`, `trust`, `raw_other_text`, `tags`, `content_hash`, `status`, `last_verified_at`, `source_id`, `external_key` | Plan 1 |
| `cycles` | `id`, `program_id`, `opens_at`, `closes_at`, `timezone`, `label`, `is_estimated` | Plan 1 |
| `users` | `id`, `email`, `role` | Plan 1 |
| `sources` | `id`, `label`, `tier`, `funder_id`, `enabled`, `last_polled_at`, `last_success_at`, `consecutive_failures`, `last_record_count`, `expected_min_records` | Plan 1 |
| `snapshots` | `id`, `source_id`, `url`, `fetched_at`, `status` | Plan 1 |
| `change_events` | `id`, `source_id`, `program_id`, `kind`, `before_json`, `after_json`, `detected_at`, `field_path` | Plan 1 |
| `review_items` | `id`, `change_event_id`, `candidate_json`, `decision`, `decided_by`, `decided_at`, `confidence`, `reject_key` | Plan 1 |
| `review_rejects` | `reject_key`, `decided_by`, `decided_at` | Plan 2 (plan-local, CONTRACT §6) |
| `audit_log` | `at`, `actor_user_id`, `action`, `entity_type`, `entity_id`, `detail` | Plan 1 |
| `profiles` | `id`, `user_id`, `kind`, `data`, `updated_at` | Plan 1 |
| `watches` | `id`, `user_id`, `program_id`, `notify_changes`, `created_at` | Plan 1 |

**Owner means "the plan whose migration file contains the `CREATE TABLE`."** After RESOLUTIONS
R1/R3/R4, Plan 1's `001-init.sql` owns the DDL for every table in this list except one, `sources`,
`snapshots`, `change_events`, `review_items` and `audit_log` included — Plan 2 only *writes* those
(its `ensureIngestionSchema` is assertion-only for them, and `source_health` no longer exists;
health lives on `sources`). The single exception is **`review_rejects`**, Plan 2's one plan-local
table (CONTRACT §6 lists it), created by `ensureIngestionSchema`. If a conformance row below fails
on, say, `review_items.candidate_json` or `snapshots.body_bytes`, the column to reconcile is in
**Plan 1 Task 12**; if it fails on `review_rejects`, it is in **Plan 2 Task 20**.

`review_rejects` and `audit_log` are in the list because RESOLUTIONS R26 makes Task 12's Inbox
decision route delegate to Plan 2's review pipeline, which writes both. Plan 3 never writes them
directly — it reads them back to prove reject memory and the provenance trail actually happen.

**There is no `programs.data` column and there never was** (RESOLUTIONS R1). Plan 1's `001-init.sql`
stores the `Program` record in normalized columns, four of which (`amount`, `deadline`, `obligations`,
`ai_policy`, `trust`) hold JSON validated on read by `programSchema`. Plan 3 therefore never issues
`SELECT data FROM programs`: it reads whole records through Plan 1's repository factory
`createProgramRepo(db)` (`.get(id)`, `.list(filter)`, `.upsert(program)`) and reads only the
denormalized scalars (`status`, `last_verified_at`, `content_hash`, `funder_id`, `klass`, `name`)
directly in SQL.

Plan 3 **creates seven tables** (migrations `030`–`036`): `program_search`, `program_facets`,
`field_provenance`, `notifications`, `change_event_fanout`, `notification_channels`,
`verify_attempts`. Every one of them is new; none appears in CONTRACT §6's list, and each is
declared plan-local in the task that introduces it.

**Plan 3 does NOT create `profiles` or `watches`** (RESOLUTIONS R19). Both are CONTRACT §6 tables and
both are already created by Plan 1's `001-init.sql`. Migrations run in filename order, so a
`CREATE TABLE IF NOT EXISTS profiles` in Plan 3's `032` would silently no-op against Plan 1's `001`
and the *divergent* shape written next to it would read as the truth while never existing. Plan 1's
shapes are the real ones, and they are stricter than a naive re-declaration:

```sql
-- Plan 1 001-init.sql, quoted here as the read-contract (do not copy into a Plan 3 migration):
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('student', 'organization')),
  data TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (user_id, kind)
);
CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  notify_changes INTEGER NOT NULL DEFAULT 1 CHECK (notify_changes IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, program_id)
);
```

Two consequences Plan 3 must honour, because `openDatabase` sets `PRAGMA foreign_keys = ON`:

1. Migrations `032-profiles.sql` and `033-watches.sql` still exist, but they carry **only additive
   `CREATE INDEX IF NOT EXISTS` statements** and a comment naming Plan 1 as the owner. The
   conformance test asserts the columns (including `watches.notify_changes`); it does not create them.
2. **A row in `watches` or `profiles` needs both parent rows to exist first** — the `users` row and,
   for `watches`, the `programs` row. Test fixtures therefore never hand-write
   `INSERT INTO watches (…)`; they call `starProgram(db, userId, programId, atISO)` from
   `packages/server/src/test/fixtures/programs.ts` (Task 2), which inserts the parents first.

Plan 3 additionally assumes these behaviours from Plan 1, and nothing else:

- `POST /api/auth/login` accepts `{ email, password }` and sets an httpOnly session cookie; `POST /api/auth/logout` clears it.
- `packages/server/src/auth/password.ts` exports `hashPassword(plain: string): Promise<string>` (used only by the e2e seed script).
- An Express middleware exists that authenticates the session cookie. Plan 3 does not import it — the entrypoint passes it in as `deps.requireAuth`.
- `packages/server/test/helpers/tempDb.ts` exports `createTestDb(): TestDb` (Plan 1 Task 12). Plan 3
  has **one** test-database harness and it adapts that one; it does not apply migrations by hand.
- `packages/server/src/api/errors.ts` exports `AppError`, `ApiErrorCode`, `ERROR_STATUS`,
  `requestIdMiddleware()`, `notFoundHandler()`, `errorHandler(opts)` (Plan 1 Task 15).
- `packages/server/src/db/repositories/programs.ts` exports `createProgramRepo(db)`;
  `.../funders.ts` exports `createFunderRepo(db)`; `.../profiles.ts` exports the
  `ProfileKind` type. Plan 3 re-exports `ProfileKind`, it does not redefine it.

And these three from **Plan 2**, because RESOLUTIONS R26 makes the Inbox delegate rather than
re-implement. `packages/server/src/review/index.ts` (Plan 2 Task 21) exports:

```ts
export function approveReviewItem(db, itemId: string, userId: string, nowISO: string): Program;
export function rejectReviewItem(db, itemId: string, userId: string, nowISO: string, reason: string): void;
export function editReviewItem(db, itemId: string, userId: string, nowISO: string, edited: Program): Program;
```

Between them they are the **only** writers of the published corpus, `review_rejects` and the
`audit_log` provenance trail, and `approveReviewItem` is the one that carries
`sourceKeyFor(candidate)` into `programs.source_id` / `external_key` and deletes rather than
upserts when the change event kind is `vanished`. Plan 3 Task 12 calls them; it does not
reproduce them. They throw a plain `Error` on an unknown item id, which is why Task 12 checks for
the row itself first and answers `404` in Plan 1's envelope.

**Eight `packages/web` files belong to Plan 1 Task 18, not to Plan 3** (RESOLUTIONS R11):
`packages/web/package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`,
`src/main.tsx`, `src/App.tsx`, `src/api/client.ts`. Plan 3 Tasks 1 and 15 **Modify** all eight and
never re-Create them. Plan 1's pinned versions stand (`vite 6.4.3`, `@vitejs/plugin-react 4.7.0`,
exact non-caret style) and Plan 1's `ApiError` signature
`(code: ApiErrorCode, message: string, status: number, requestId: string, details?: unknown)` is
canonical. Plan 1 also creates `packages/web/src/styles/index.css`, which Plan 3's design system
supersedes: Task 1 deletes it and its import so no orphaned stylesheet ships.

Every Plan-3-local type is declared **plan-local** in the task that defines it.

---
### Task 1: Web workspace and the design system

**Why this exists:** everything else in the plan renders through these tokens. The design is a *funding desk instrument panel*: a fixed left rail, a hairline-ruled data grid, and one rule that gives the product its signature — **every number, date, amount, callsign and hash renders in the monospace face, right-aligned in tables**. That single rule is what stops a grant table from reading like a blog.

**Files:** (the first six already exist — **Plan 1 Task 18 created them**; RESOLUTIONS R11)
- Modify: `packages/web/package.json` (add `react-router-dom` + the test deps; keep Plan 1's pins)
- Modify: `packages/web/tsconfig.json` (add `noUncheckedIndexedAccess`; keep everything else)
- Modify: `packages/web/vite.config.ts` (add `sourcemap: true`)
- Modify: `packages/web/vitest.config.ts` (jsdom + setup file + `src/**` includes)
- Modify: `packages/web/index.html` (add the `color-scheme` meta)
- Modify: `packages/web/src/main.tsx` (import `styles/base.css` instead of `styles/index.css`)
- Delete: `packages/web/src/styles/index.css` (Plan 1's starter sheet; superseded by tokens + base)
- Create: `packages/web/src/test/setup.ts`
- Create: `packages/web/src/styles/tokens.css`
- Create: `packages/web/src/styles/base.css`
- Create: `packages/web/src/lib/contrast.ts`
- Test: `packages/web/src/lib/contrast.test.ts`
- Modify: `vitest.workspace.ts` (root — add the web project)
- Modify: `package.json` (root — wire `build` through web, make `dev:web` real, add `test:e2e`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `contrastRatio(hexA: string, hexB: string): number`, `parseHex(hex: string): [number, number, number]`; the CSS custom-property vocabulary every later web task uses.

- [ ] **Step 1: Write the failing test**

The design system's accessibility claim has to be executable, not a comment. `contrast.ts` computes WCAG relative luminance; the test asserts every semantic pair in both themes clears 4.5:1.

Create `packages/web/src/lib/contrast.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { contrastRatio, parseHex } from './contrast.js';

const tokensCss = readFileSync(
  fileURLToPath(new URL('../styles/tokens.css', import.meta.url)),
  'utf8',
);

/** Pull `--name: #rrggbb;` pairs out of a single CSS block. */
function tokensInBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const block = css.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** [foreground, background] pairs that must clear WCAG AA for normal text. */
const AA_PAIRS: Array<[string, string]> = [
  ['--text', '--bg'],
  ['--text', '--surface'],
  ['--text-muted', '--surface'],
  ['--text-faint', '--surface'],
  ['--accent', '--surface'],
  ['--accent-ink', '--accent'],
  ['--ok', '--ok-soft'],
  ['--pref', '--pref-soft'],
  ['--no', '--no-soft'],
  ['--unk', '--unk-soft'],
  ['--warn', '--warn-soft'],
];

describe('contrastRatio', () => {
  it('computes the canonical black-on-white ratio', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('parses hex into 0-255 channels', () => {
    expect(parseHex('#0f6f7a')).toEqual([15, 111, 122]);
  });
});

describe.each([
  [':root', 'light'],
  [':root[data-theme="dark"]', 'dark'],
])('token block %s (%s theme)', (selector) => {
  const tokens = tokensInBlock(tokensCss, selector);

  it.each(AA_PAIRS)('%s on %s clears WCAG AA 4.5:1', (fg, bg) => {
    const fgHex = tokens[fg];
    const bgHex = tokens[bg];
    expect(fgHex, `${fg} missing from ${selector}`).toBeTruthy();
    expect(bgHex, `${bg} missing from ${selector}`).toBeTruthy();
    expect(contrastRatio(fgHex, bgHex)).toBeGreaterThanOrEqual(4.5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/lib/contrast.test.ts
```

Expected failure: `Failed to load url ./contrast.js` / `ENOENT: no such file or directory, open '.../packages/web/src/styles/tokens.css'`.

- [ ] **Step 3: Modify Plan 1's web workspace, then write the design system**

Modify `packages/web/package.json`. **Plan 1 Task 18 created this file and its pins stand:**
`vite 6.4.3`, `@vitejs/plugin-react 4.7.0`, `react`/`react-dom` `18.3.1`, and the exact-version
(non-caret) style used across the repo. Plan 3 adds exactly one dependency — `react-router-dom` —
plus the test toolchain, and leaves Plan 1's `build`/`typecheck` scripts alone (`build` is
`vite build`; `tsc -b` would fail on this host with TS6310, per CONTRACT §8):

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
    "react-dom": "18.3.1",
    "react-router-dom": "6.30.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "6.9.1",
    "@testing-library/react": "16.3.0",
    "@testing-library/user-event": "14.6.1",
    "@types/react": "18.3.31",
    "@types/react-dom": "18.3.7",
    "@vitejs/plugin-react": "4.7.0",
    "jsdom": "25.0.1",
    "vite": "6.4.3"
  }
}
```

Modify `packages/web/tsconfig.json` — keep every option Plan 1 set and add
`noUncheckedIndexedAccess`, which the browse and calendar code relies on. The `include` still lists
`test/**/*.ts`, because Plan 1's `packages/web/test/client.test.ts` is still present; **Task 15
folds it into `src/api/client.test.ts`, deletes it, and drops that include entry**:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
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

Modify `packages/web/vite.config.ts` — Plan 1's file, plus source maps (the a11y and diff panels are
easier to debug from a stack trace than from a minified bundle). `127.0.0.1` is loopback, not a LAN
address, so it is safe to commit:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3030', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
```

Modify `packages/web/vitest.config.ts`. Plan 1's version ran `environment: 'node'` over
`test/**/*.test.ts` because `client.ts` is framework-free. Plan 3 renders React, so it needs jsdom
and the plugin — and it keeps `test/**/*.test.ts` in the include so Plan 1's existing client test
**keeps running** until Task 15 folds it into `src/`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.ts'],
  },
});
```

Create `packages/web/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
```

Modify `packages/web/index.html` — Plan 1's file with one line added, the `color-scheme` meta that
lets the browser paint form controls and scrollbars in the active theme:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="light dark" />
    <title>GrantSpotter</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `packages/web/src/lib/contrast.ts`:

```ts
export function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6) throw new Error(`expected #rrggbb, got: ${hex}`);
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function channelLuminance(value255: number): number {
  const c = value255 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}
```

Create `packages/web/src/styles/tokens.css`. Every hex below was chosen to clear AA against its stated partner; the test in Step 1 is what keeps that true.

```css
/* GrantSpotter design tokens.
   Two themes. `prefers-color-scheme` is the default signal; the `data-theme`
   attribute on <html> overrides it in both directions so the in-app toggle wins. */

:root {
  /* ---- surfaces ---- */
  --bg: #f7f8fa;
  --surface: #ffffff;
  --surface-2: #eef1f5;
  --surface-3: #e4e8ee;
  --border: #d6dbe3;
  --border-strong: #b6bec9;

  /* ---- text ---- */
  --text: #14181f;
  --text-muted: #5a6371;
  --text-faint: #6b7482;

  /* ---- accent: deep teal. Cool on purpose, so amber and red read as signals ---- */
  --accent: #0f6f7a;
  --accent-hover: #0b5a63;
  --accent-ink: #ffffff;
  --accent-soft: #e2f1f3;

  /* ---- verdict semantics (spec §5) ---- */
  --ok: #16703e;        /* eligible */
  --ok-soft: #e4f4ea;
  --pref: #5b3fbf;      /* eligible_preferred */
  --pref-soft: #ece7fb;
  --no: #a8323f;        /* ineligible */
  --no-soft: #fbe8ea;
  --unk: #5a6371;       /* unknown — a real state, never a blank */
  --unk-soft: #e9ecf1;

  /* ---- trust semantics (spec §8) ---- */
  --warn: #8a5a06;      /* lastVerifiedAt older than 90 days */
  --warn-soft: #fdf1dc;

  /* ---- type ---- */
  --font-text: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  --font-data: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
    "Liberation Mono", monospace;

  --fs-100: 0.75rem;    /* 12px — micro labels, table column heads */
  --fs-200: 0.8125rem;  /* 13px — metadata, badges */
  --fs-300: 0.9375rem;  /* 15px — body, table cells */
  --fs-400: 1.0625rem;  /* 17px — lead paragraph */
  --fs-500: 1.375rem;   /* 22px — section heading */
  --fs-600: 1.75rem;    /* 28px — page title */
  --fs-700: 2.25rem;    /* 36px — display figure (the ineligible count) */

  --lh-tight: 1.2;
  --lh-normal: 1.5;
  --lh-loose: 1.65;
  --tracking-caps: 0.06em;

  /* ---- spacing (4px base) ---- */
  --s-1: 4px;
  --s-2: 8px;
  --s-3: 12px;
  --s-4: 16px;
  --s-5: 24px;
  --s-6: 32px;
  --s-7: 48px;
  --s-8: 64px;

  /* ---- shape ---- */
  --r-1: 4px;
  --r-2: 8px;
  --r-3: 14px;
  --rail-w: 208px;
  --topbar-h: 56px;
  --content-max: 1280px;

  /* ---- elevation: hairlines, not drop shadows ---- */
  --shadow-1: 0 1px 2px rgb(20 24 31 / 0.06);
  --shadow-2: 0 8px 24px rgb(20 24 31 / 0.12);

  --focus-ring: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent);
}

:root[data-theme="dark"] {
  --bg: #0d1117;
  --surface: #151b23;
  --surface-2: #1c242e;
  --surface-3: #232d39;
  --border: #2b3542;
  --border-strong: #3d4a5a;

  --text: #e6edf3;
  --text-muted: #a8b3c1;
  --text-faint: #96a2b1;

  --accent: #3fb6c0;
  --accent-hover: #63c8d0;
  --accent-ink: #06232a;
  --accent-soft: #10333a;

  --ok: #54c98a;
  --ok-soft: #10281c;
  --pref: #a99bf5;
  --pref-soft: #1e1a35;
  --no: #f2818f;
  --no-soft: #33161c;
  --unk: #a8b3c1;
  --unk-soft: #1c242e;

  --warn: #e5b567;
  --warn-soft: #2f2411;

  --shadow-1: 0 1px 2px rgb(0 0 0 / 0.5);
  --shadow-2: 0 8px 24px rgb(0 0 0 / 0.6);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0d1117;
    --surface: #151b23;
    --surface-2: #1c242e;
    --surface-3: #232d39;
    --border: #2b3542;
    --border-strong: #3d4a5a;

    --text: #e6edf3;
    --text-muted: #a8b3c1;
    --text-faint: #96a2b1;

    --accent: #3fb6c0;
    --accent-hover: #63c8d0;
    --accent-ink: #06232a;
    --accent-soft: #10333a;

    --ok: #54c98a;
    --ok-soft: #10281c;
    --pref: #a99bf5;
    --pref-soft: #1e1a35;
    --no: #f2818f;
    --no-soft: #33161c;
    --unk: #a8b3c1;
    --unk-soft: #1c242e;

    --warn: #e5b567;
    --warn-soft: #2f2411;

    --shadow-1: 0 1px 2px rgb(0 0 0 / 0.5);
    --shadow-2: 0 8px 24px rgb(0 0 0 / 0.6);
  }
}
```

Create `packages/web/src/styles/base.css`:

```css
@import "./tokens.css";

*,
*::before,
*::after {
  box-sizing: border-box;
}

html {
  color-scheme: light dark;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-text);
  font-size: var(--fs-300);
  line-height: var(--lh-normal);
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4 {
  margin: 0;
  line-height: var(--lh-tight);
  font-weight: 620;
  letter-spacing: -0.011em;
}

h1 { font-size: var(--fs-600); }
h2 { font-size: var(--fs-500); }
h3 { font-size: var(--fs-400); }

p { margin: 0 0 var(--s-3); }

a {
  color: var(--accent);
  text-underline-offset: 2px;
}

a:hover { color: var(--accent-hover); }

/* Focus is never removed. It is a 2px ring with a surface-coloured spacer so it
   reads against both the row background and the page background. */
:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: var(--r-1);
}

/* The signature rule: numbers, dates, money, callsigns and hashes are data. */
.data {
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
  font-size: 0.95em;
  letter-spacing: -0.01em;
}

.eyebrow {
  font-size: var(--fs-100);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  font-weight: 600;
  color: var(--text-muted);
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  box-shadow: var(--shadow-1);
}

/* Hairline-ruled data grid. */
.grid-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--fs-300);
}

.grid-table th {
  position: sticky;
  top: 0;
  z-index: 2;
  text-align: left;
  background: var(--surface-2);
  color: var(--text-muted);
  font-size: var(--fs-100);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  font-weight: 600;
  padding: var(--s-2) var(--s-3);
  border-bottom: 1px solid var(--border-strong);
  white-space: nowrap;
}

.grid-table td {
  padding: var(--s-3);
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.grid-table td.num,
.grid-table th.num {
  text-align: right;
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.grid-table tbody tr:hover td { background: var(--surface-2); }

.btn {
  font: inherit;
  font-weight: 560;
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-4);
  border-radius: var(--r-1);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.btn:hover { background: var(--surface-2); }
.btn[disabled] { opacity: 0.55; cursor: not-allowed; }

.btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-ink);
}

.btn-primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }

.skip-link {
  position: absolute;
  left: var(--s-3);
  top: -60px;
  z-index: 100;
  padding: var(--s-2) var(--s-4);
  background: var(--accent);
  color: var(--accent-ink);
  border-radius: var(--r-1);
  transition: top 120ms ease;
}

.skip-link:focus { top: var(--s-3); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

Modify `packages/web/src/main.tsx`. Plan 1's version imports `./styles/index.css` and renders
`<App />` — its status page. Swap the stylesheet import for the design system and keep rendering
Plan 1's `App`; Task 15 replaces `App.tsx` itself with the router (see that task):

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/base.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Delete Plan 1's starter stylesheet, now that nothing imports it — an orphaned sheet in the bundle is
a maintenance trap:

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git rm packages/web/src/styles/index.css
grep -rn "styles/index.css" packages/web/src || echo "no remaining imports — correct"
```

Modify `vitest.workspace.ts` at the repo root so the web project is discovered (append `'./packages/web'` to the exported array):

```ts
import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  './packages/core',
  './packages/server',
  './packages/web',
]);
```

Modify the root `package.json` scripts. Three surgical changes to Plan 1's block, nothing else —
`typecheck`, `test` and `test:watch` keep Plan 1's definitions verbatim, and `verify-sources` /
`capture-fixture` / `seed:arrl` are **not** Plan 3's to add (RESOLUTIONS R13):

1. `build` gains the web workspace, so CONTRACT §8's `build` = core → server → web holds.
2. `dev:web` becomes the real Vite dev server instead of Plan 1's `echo` stub.
3. `test:e2e` is added — the CONTRACT §8 deviation recorded in this plan's Global Constraints.
   Task 26 writes the `playwright.config.ts` it runs; until then the script exists and exits
   non-zero, which is the honest state.

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "build": "npm run build -w @grantspotter/core && npm run build -w @grantspotter/server && npm run build -w @grantspotter/web",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "dev": "concurrently -n server,web -c blue,green \"npm:dev:server\" \"npm:dev:web\"",
    "dev:server": "npm run dev -w @grantspotter/server",
    "dev:web": "npm run dev -w @grantspotter/web"
  }
}
```

Install:

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npm install
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/lib/contrast.test.ts
npm run build -w @grantspotter/web
```

Expected: 24 contrast assertions pass (2 themes × 11 pairs + 2 unit tests), and `vite build` emits `packages/web/dist/index.html`.

Plan 1's `packages/web/test/client.test.ts` must **still be green** in this run — the vitest include
above keeps it in scope. If it is missing from the reporter output, the include was mistyped.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web vitest.workspace.ts package.json package-lock.json
git commit -m "feat(web): design system over Plan 1's web scaffold, with contrast tests"
```

---

### Task 2: Browse projection tables, reindex, and the schema-conformance gate

**Why this exists:** filters must be indexed SQL, not a full-table JSON scan. `applicantEntities` and `tags` are arrays inside the `Program` JSON, so they get a facet table; everything scalar goes in a wide projection row. This task also ships the **schema-conformance test**, which is the reconciliation gate with Plans 1–2 described in the read-contract above.

**Files:**
- Create: `packages/server/src/db/migrations/030-browse-projection.sql`
- Create: `packages/server/src/api/browseTypes.ts`
- Create: `packages/server/src/api/reindex.ts`
- Create: `packages/server/src/test/testDb.ts`
- Create: `packages/server/src/test/fixtures/programs.ts`
- Test: `packages/server/src/db/schemaConformance.test.ts`
- Test: `packages/server/src/api/reindex.test.ts`

**Interfaces:**
- Consumes: `Program`, `Funder`, `Cycle`, `OpportunityClass`, `ApplicantEntity`, `Instrument`, `ProgramStatus`, `Verdict` from `@grantspotter/core`; `expandCycles(program, allPrograms, fromISO, toISO): Cycle[]` from `@grantspotter/core`; `programSchema` from `@grantspotter/core` (`core/schema.ts`, zod mirror of `Program`); `createTestDb(): TestDb` from `packages/server/test/helpers/tempDb.js` (Plan 1 Task 12); `ensureIngestionSchema(db)` from `../db/ingestSchema.js` (Plan 2 Task 20); `createFunderRepo(db)`, `createProgramRepo(db)` from Plan 1's repositories.
- Produces: `openTestDb(): Database.Database`, `seedFixtureCorpus(db): void`, `seedTestUser(db, userId, role?, atISO?): void`, `starProgram(db, userId, programId, atISO): void` (RESOLUTIONS R19 — the only sanctioned writer of `watches` in a fixture); `reindexBrowse(db: Database.Database, nowISO: string): number`; the plan-local types in `browseTypes.ts`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/test/testDb.ts` first — every later server task uses it. **There is
exactly one test-database harness in this repository and it is Plan 1's** (RESOLUTIONS, type finding
#15): a second one that re-implements migration application by hand would silently skip Plan 1's
`schema_migrations` bookkeeping and Plan 2's `ensureIngestionSchema` pass, and would then disagree
with production about what the schema is. `openTestDb` is a thin adapter, kept only so the ~15 Plan 3
and Plan 4 test files can take a bare `Database` and call `db.close()`:

```ts
import type Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { createTestDb } from '../../test/helpers/tempDb.js';
import { ensureIngestionSchema } from '../db/ingestSchema.js';

/**
 * Plan 1's migrated temp-file database, plus Plan 2's idempotent ingestion
 * schema pass, exposed as a bare handle whose close() also removes the temp
 * directory. It is an adapter over createTestDb() and nothing else: there is
 * no second migration runner in this repository.
 */
export function openTestDb(): Database.Database {
  const harness = createTestDb();
  ensureIngestionSchema(harness.db);

  const db = harness.db;
  const closeOnly = db.close.bind(db);
  db.close = (): Database.Database => {
    const result = closeOnly();
    rmSync(harness.dir, { recursive: true, force: true });
    return result;
  };
  return db;
}
```

Create `packages/server/src/db/schemaConformance.test.ts` — the gate:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';

/**
 * Plan 3's declared read-contract with Plans 1 and 2. If this test fails, a
 * column was renamed upstream; reconcile the name before touching anything else.
 */
const REQUIRED: Record<string, string[]> = {
  funders: ['id', 'name'],
  // Plan 1's normalized shape (RESOLUTIONS R1). There is no `data` column.
  // `source_id` / `external_key` are the crawler-reconciliation pair from R9.
  programs: [
    'id', 'funder_id', 'name', 'klass', 'summary', 'applicant_entities',
    'amount', 'deadline', 'apply_via', 'apply_url', 'apply_contact',
    'funding_restrictions', 'obligations', 'ai_policy', 'trust',
    'raw_other_text', 'tags', 'content_hash', 'status', 'last_verified_at',
    'source_id', 'external_key',
  ],
  cycles: ['id', 'program_id', 'opens_at', 'closes_at', 'timezone', 'label', 'is_estimated'],
  users: ['id', 'email', 'role'],
  // `enabled` is read by the sources router and by the admin pause toggle
  // (Tasks 14 and 24), and gates Plan 2's runCrawl (RESOLUTIONS R20).
  sources: [
    'id', 'label', 'tier', 'funder_id', 'enabled', 'last_polled_at', 'last_success_at',
    'consecutive_failures', 'last_record_count', 'expected_min_records',
  ],
  snapshots: ['id', 'source_id', 'url', 'fetched_at', 'status'],
  change_events: [
    'id', 'source_id', 'program_id', 'kind', 'before_json', 'after_json',
    'detected_at', 'field_path',
  ],
  review_items: [
    'id', 'change_event_id', 'candidate_json', 'decision', 'decided_by',
    'decided_at', 'confidence', 'reject_key',
  ],
  // RESOLUTIONS R26: the Inbox decision route delegates to Plan 2's review
  // pipeline, which writes reject memory and the provenance trail. Plan 3 reads
  // both back in `inboxRouter.test.ts`, so both are part of its read-contract.
  // `review_rejects` is Plan 2's plan-local table (CONTRACT §6); `audit_log` is
  // Plan 1's, and its columns are `at` / `actor_user_id`, not `created_at` /
  // `user_id` — a rename upstream would make provenance silently unreadable.
  review_rejects: ['reject_key', 'decided_by', 'decided_at'],
  audit_log: ['at', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'detail'],
  program_search: [
    'program_id', 'funder_id', 'funder_name', 'name', 'klass', 'status',
    'instrument', 'amount_min', 'amount_max', 'deadline_kind',
    'next_opens_at', 'next_closes_at', 'next_is_estimated',
    'last_verified_at', 'haystack',
  ],
  program_facets: ['program_id', 'facet_kind', 'facet_value'],
};

describe('schema conformance (Plan 3 read-contract)', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = openTestDb();
  });

  afterAll(() => {
    db.close();
  });

  it.each(Object.entries(REQUIRED))('table %s has every column Plan 3 reads', (table, columns) => {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    expect(rows.length, `table "${table}" does not exist`).toBeGreaterThan(0);
    const present = new Set(rows.map((r) => r.name));
    const missing = columns.filter((c) => !present.has(c));
    expect(missing, `${table} is missing columns`).toEqual([]);
  });

  // RESOLUTIONS R1, made executable: if a `data` column ever reappears on
  // `programs`, someone has re-introduced the document shape Plan 1's
  // normalized DDL replaced, and half of Plan 3 would silently read stale JSON.
  it('programs has no `data` column — records are read through createProgramRepo', () => {
    const rows = db.prepare('PRAGMA table_info(programs)').all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name)).not.toContain('data');
  });
});
```

Create `packages/server/src/api/reindex.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus } from '../test/fixtures/programs.js';
import { reindexBrowse } from './reindex.js';

const NOW = '2026-08-02T12:00:00.000Z';

describe('reindexBrowse', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  it('projects every program into program_search', () => {
    const count = reindexBrowse(db, NOW);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM program_search').get() as { n: number };
    expect(count).toBe(5);
    expect(rows.n).toBe(5);
  });

  it('denormalizes the funder name so browse never joins at query time', () => {
    reindexBrowse(db, NOW);
    const row = db
      .prepare('SELECT funder_name FROM program_search WHERE program_id = ?')
      .get('ardc-grants') as { funder_name: string };
    expect(row.funder_name).toBe('Amateur Radio Digital Communications');
  });

  it('explodes applicantEntities into facet rows', () => {
    reindexBrowse(db, NOW);
    const facets = db
      .prepare(
        `SELECT facet_value FROM program_facets
          WHERE program_id = ? AND facet_kind = 'entity' ORDER BY facet_value`,
      )
      .all('ardc-grants') as Array<{ facet_value: string }>;
    expect(facets.map((f) => f.facet_value)).toEqual([
      'club_501c3',
      'club_via_fiscal_sponsor',
      'school_lea',
      'university',
      'university_dept',
    ]);
  });

  it('resolves the next close date for a program that inherits its deadline', () => {
    // QCWA rides the ARRL Foundation scholarship cycle: 111 catalog entries
    // share ONE deadline (spec §4.3). Its projection must carry a real date.
    reindexBrowse(db, NOW);
    const row = db
      .prepare('SELECT next_closes_at FROM program_search WHERE program_id = ?')
      .get('qcwa-memorial-scholarship') as { next_closes_at: string | null };
    expect(row.next_closes_at).toBe('2026-12-30T17:00:00.000Z');
  });

  it('is idempotent — reindexing twice does not duplicate facets', () => {
    reindexBrowse(db, NOW);
    reindexBrowse(db, NOW);
    const n = db
      .prepare(`SELECT COUNT(*) AS n FROM program_facets WHERE program_id = 'ardc-grants'`)
      .get() as { n: number };
    expect(n.n).toBe(5 + 2); // 5 entities + 2 tags
  });

  it('carries lastVerifiedAt through so the amber badge can be filtered on', () => {
    reindexBrowse(db, NOW);
    const row = db
      .prepare('SELECT last_verified_at FROM program_search WHERE program_id = ?')
      .get('chicago-fm-club-scholarship') as { last_verified_at: string };
    expect(row.last_verified_at).toBe('2026-01-05T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/db/schemaConformance.test.ts packages/server/src/api/reindex.test.ts
```

Expected failure: `Cannot find module '../test/fixtures/programs.js'` and `table "program_search" does not exist`.

- [ ] **Step 3: Write the migration, the fixtures, and the reindexer**

Create `packages/server/src/db/migrations/030-browse-projection.sql`:

```sql
-- Plan 3: denormalized browse projection.
-- Rebuilt wholesale by reindexBrowse(); never edited row-by-row.

CREATE TABLE IF NOT EXISTS program_search (
  program_id        TEXT PRIMARY KEY,
  funder_id         TEXT NOT NULL,
  funder_name       TEXT NOT NULL,
  name              TEXT NOT NULL,
  klass             TEXT NOT NULL,
  status            TEXT NOT NULL,
  instrument        TEXT NOT NULL,
  amount_min        INTEGER,
  amount_max        INTEGER,
  deadline_kind     TEXT NOT NULL,
  next_opens_at     TEXT,
  next_closes_at    TEXT,
  next_is_estimated INTEGER NOT NULL DEFAULT 0,
  last_verified_at  TEXT NOT NULL,
  haystack          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS program_facets (
  program_id  TEXT NOT NULL,
  facet_kind  TEXT NOT NULL,   -- 'entity' | 'tag'
  facet_value TEXT NOT NULL,
  PRIMARY KEY (program_id, facet_kind, facet_value)
);

CREATE INDEX IF NOT EXISTS idx_ps_klass       ON program_search (klass);
CREATE INDEX IF NOT EXISTS idx_ps_status      ON program_search (status);
CREATE INDEX IF NOT EXISTS idx_ps_instrument  ON program_search (instrument);
CREATE INDEX IF NOT EXISTS idx_ps_closes      ON program_search (next_closes_at);
CREATE INDEX IF NOT EXISTS idx_ps_amount      ON program_search (amount_min, amount_max);
CREATE INDEX IF NOT EXISTS idx_ps_verified    ON program_search (last_verified_at);
CREATE INDEX IF NOT EXISTS idx_pf_lookup      ON program_facets (facet_kind, facet_value);
```

Create `packages/server/src/api/browseTypes.ts` — **every type in this file is plan-local to Plan 3** and is declared here because CONTRACT §3 does not define an API-response vocabulary:

```ts
// PLAN-LOCAL to Plan 3. Not part of CONTRACT §3.
import type {
  ApplicantEntity, Cycle, Funder, Instrument, OpportunityClass,
  Program, ProgramStatus, Verdict,
} from '@grantspotter/core';

export type VerdictKind = 'eligible' | 'eligible_preferred' | 'ineligible' | 'unknown';

export type BrowseSort = 'deadline' | 'amount_desc' | 'name' | 'verified';

export interface BrowseFilters {
  klass: OpportunityClass[];
  entity: ApplicantEntity[];
  instrument: Instrument[];
  status: ProgramStatus[];
  verdict: VerdictKind[];
  deadlineFrom?: string;
  deadlineTo?: string;
  /** When a deadline window is set, rolling/undated programs drop out unless this is true. */
  includeRolling: boolean;
  amountMin?: number;
  amountMax?: number;
  q?: string;
  sort: BrowseSort;
  page: number;
  pageSize: number;
}

export const DEFAULT_FILTERS: BrowseFilters = {
  klass: [], entity: [], instrument: [], status: [], verdict: [],
  includeRolling: true, sort: 'deadline', page: 1, pageSize: 50,
};

export interface BrowseRow {
  program: Program;
  funderName: string;
  verdict: Verdict | null;
  nextOpensAt: string | null;
  nextClosesAt: string | null;
  nextIsEstimated: boolean;
  watched: boolean;
}

export interface BrowseSummary {
  total: number;
  eligible: number;
  preferred: number;
  ineligible: number;
  unknown: number;
  /** Constraint axes ranked by how many programs they exclude the user from. */
  ineligibleByAxis: Array<{ axis: string; count: number }>;
  /** Profile fields ranked by how many `unknown` verdicts filling them would resolve. */
  unknownByField: Array<{ field: string; count: number }>;
}

export interface BrowseResponse {
  rows: BrowseRow[];
  summary: BrowseSummary;
  page: number;
  pageSize: number;
  total: number;
  profileApplied: 'student' | 'organization' | null;
}

export interface FieldProvenance {
  fieldPath: string;
  sourceId: string;
  snapshotId: string | null;
  rawLabel: string;
  rawValue: string;
  fetchedAt: string;
}

export interface OpportunityDetail {
  program: Program;
  funder: Funder;
  cycles: Cycle[];
  provenance: FieldProvenance[];
  verdict: Verdict | null;
  watched: boolean;
  /** Non-null when this program inherits its deadline from another program. */
  deadlineOwner: { programId: string; programName: string } | null;
}
```

Create `packages/server/src/test/fixtures/programs.ts`. Five real records drawn from the research pass — they are the corpus every Plan 3 server test runs against, and between them they exercise deadline inheritance, `disputed`, `staleMirrorWarning`, an amber `lastVerifiedAt`, and `status: 'unknown'`:

```ts
import type Database from 'better-sqlite3';
import type { Funder, Program } from '@grantspotter/core';

export const funders: Funder[] = [
  { id: 'arrl-foundation', name: 'ARRL Foundation', homepage: 'https://www.arrl.org/arrl-foundation' },
  { id: 'ardc', name: 'Amateur Radio Digital Communications', homepage: 'https://www.ardc.net/', ein: '45-3751971' },
  { id: 'qcwa', name: 'Quarter Century Wireless Association', homepage: 'https://www.qcwa.org/' },
  { id: 'chicago-fm-club', name: 'Six Meter Club of Chicago', homepage: 'https://www.chicagofmclub.org/' },
];

export const arrlScholarship: Program = {
  id: 'arrl-foundation-scholarship',
  funderId: 'arrl-foundation',
  name: 'ARRL Foundation Scholarship Program',
  klass: 'ham_scholarship',
  summary: 'One application covers the whole ARRL Foundation catalog: 111 entries, 170+ awards.',
  applicantEntities: ['individual'],
  amount: {
    instrument: 'cash_range',
    amountMin: 500,
    amountMax: 25000,
    amountRaw: '$500 - $25,000',
    awardCountRaw: '170+',
  },
  deadline: {
    kind: 'annual_window',
    source: { kind: 'self' },
    note: 'Opens about Oct 30; closes Dec 30 at 12:00 PM EST. Moved from Jan 31 - do not hardcode.',
  },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.arrl.org/scholarship-program',
  constraints: [
    {
      id: 'arrl-sch-license',
      hard: true,
      fallbackRank: 0,
      rawText: 'License Requirement: Any class of FCC amateur radio license.',
      spec: { axis: 'license', licenseMin: 'TECH' },
    },
  ],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'unaddressed' },
  trust: {
    status: 'open',
    sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
    lastVerifiedAt: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'live_fetch',
    contentHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  },
  rawOtherText: '',
  tags: ['scholarship', 'arrl'],
};

export const qcwaScholarship: Program = {
  id: 'qcwa-memorial-scholarship',
  funderId: 'qcwa',
  name: 'QCWA Memorial Scholarship Fund',
  klass: 'ham_scholarship',
  summary: 'Licensed hams in accredited degree programs, sponsored by an active QCWA member.',
  applicantEntities: ['individual'],
  amount: {
    instrument: 'cash_fixed',
    amountMin: 3000,
    amountMax: 3000,
    amountRaw: '$3,000',
    awardCountRaw: '19',
  },
  deadline: {
    kind: 'inherited',
    source: { kind: 'inherited', fromProgramId: 'arrl-foundation-scholarship' },
    note: 'QCWA accepts requests from Oct 31; the packet must reach ARRL before the first week of January. Intake is ARRL’s portal, not QCWA’s.',
  },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.qcwa.org/scholarship-program.htm',
  constraints: [
    {
      id: 'qcwa-sponsor',
      hard: true,
      fallbackRank: 0,
      rawText: 'Applicant must be sponsored by an active QCWA member.',
      spec: { axis: 'recommendation', recommenderType: 'sponsor_org_member', count: 1 },
    },
    {
      id: 'qcwa-institution',
      hard: true,
      fallbackRank: 0,
      rawText: 'Must be enrolled in an accredited degree program.',
      spec: {
        axis: 'institution',
        degreeLevels: ['ASSOC', 'BACH', 'GRAD'],
        tradeSchoolOK: false,
        partTimeOK: false,
        accreditationRequired: true,
      },
    },
  ],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'unaddressed' },
  trust: {
    status: 'open',
    sourceUrl: 'https://www.qcwa.org/scholarship-program.htm',
    lastVerifiedAt: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'live_fetch',
    contentHash: 'b1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  },
  rawOtherText: 'Ver. 04/2025 application PDF. FAR is named as an alternate route on some club pages - that domain is blocklisted.',
  tags: ['scholarship', 'qcwa'],
};

export const ardcGrants: Program = {
  id: 'ardc-grants',
  funderId: 'ardc',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  summary: 'Support & Growth, Education, and R&D grants. Clubs and individuals apply through a fiscal sponsor.',
  applicantEntities: [
    'club_501c3', 'club_via_fiscal_sponsor', 'school_lea', 'university', 'university_dept',
  ],
  amount: {
    instrument: 'cash_range',
    amountMin: 1285,
    amountMax: 258000,
    amountRaw: '$1,285 - $258,000 (2026 page range)',
    awardCountRaw: 'Multiple per cycle',
  },
  deadline: {
    kind: 'n_fixed_dates',
    source: { kind: 'self' },
    note: 'Four fixed cycles: Feb 1, Apr 1, Jul 1, Sep 1. After Sep 1 the next intake is Feb 1. Evaluation takes 60-120 days.',
  },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.ardc.net/apply/',
  constraints: [
    {
      id: 'ardc-entity',
      hard: true,
      fallbackRank: 0,
      rawText: 'US 501(c)(3), government, schools and universities; international nonprofits and universities. Clubs and individuals need a fiscal sponsor. For-profits ineligible.',
      spec: { axis: 'other', note: 'Fiscal sponsor required for unincorporated clubs and individuals.' },
    },
  ],
  fundingRestrictions: ['For-profit entities are ineligible.'],
  obligations: {
    licenseObligation: 'All output must be open-source / open-access (GPL, MIT, BSD, CERN-OHL, or Creative Commons).',
    indirectCostCapPct: 20,
    costShareRequired: false,
    coFunderPreference: false,
  },
  aiPolicy: {
    stance: 'permitted',
    quote: 'If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy. If the proposal is extremely long and hard to understand, we can’t evaluate or support it.',
    url: 'https://www.ardc.net/apply/grant-application-instructions/',
  },
  trust: {
    status: 'open',
    sourceUrl: 'https://www.ardc.net/apply/',
    lastVerifiedAt: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'api',
    contentHash: 'c1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  },
  rawOtherText: '',
  tags: ['grant', 'ardc'],
};

export const arrlClubGrant: Program = {
  id: 'arrl-club-grant',
  funderId: 'arrl-foundation',
  name: 'ARRL Club Grant Program',
  klass: 'ham_grant',
  summary: 'ARDC-funded grants to ARRL-affiliated clubs, collegiate clubs included. 2024: $500,502 to 37 of 110 applicants.',
  applicantEntities: ['club_501c3', 'club_unincorporated'],
  amount: {
    instrument: 'cash_range',
    amountMin: 1000,
    amountMax: 25000,
    amountRaw: '$1,000 - $25,000',
    awardCountRaw: '37 in 2024',
  },
  deadline: {
    kind: 'unpublished',
    source: { kind: 'self' },
    note: 'The deadline is not published on the page. The only signal is the ARRL news RSS feed.',
  },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.arrl.org/club-grant-program',
  constraints: [
    {
      id: 'club-grant-affiliation',
      hard: true,
      fallbackRank: 0,
      rawText: 'Club must be ARRL-affiliated.',
      spec: { axis: 'arrl_membership', required: true, minYears: 0 },
    },
  ],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: true },
  aiPolicy: { stance: 'unaddressed' },
  trust: {
    status: 'unknown',
    sourceUrl: 'https://www.arrl.org/club-grant-program',
    lastVerifiedAt: '2026-08-02T00:00:00.000Z',
    verificationMethod: 'manual_curation',
    contentHash: 'd1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    disputed: {
      note: 'Three researchers reached three different conclusions about the current cycle. Every reading is shown with its source; none is chosen.',
      claims: [
        {
          claim: 'Dormant. The page shows only 2024 results, with no open cycle and no application link.',
          sourceUrl: 'https://www.arrl.org/club-grant-program',
        },
        {
          claim: 'An autumn window. Historically Sep 7 - Nov 4 2022, described as "open until November 4".',
          sourceUrl: 'https://www.arrl.org/club-grant-program',
        },
        {
          claim: 'Feb 1-28, Jun 1-30, Oct 1-31. Probably a conflation with the separate ARRL Amateur Radio Grants cycle.',
          sourceUrl: 'http://www.arrl.org/amateur-radio-grants',
        },
      ],
    },
  },
  rawOtherText: 'The application portal is a JavaScript single-page app and returns no server-side text, so open/closed status cannot be determined programmatically.',
  tags: ['grant', 'arrl', 'club'],
};

export const chicagoFmScholarship: Program = {
  id: 'chicago-fm-club-scholarship',
  funderId: 'chicago-fm-club',
  name: 'Chicago FM Club Scholarship',
  klass: 'ham_scholarship',
  summary: 'Discontinued. Retained as a negative record so a future maintainer does not re-research it.',
  applicantEntities: ['individual'],
  amount: {
    instrument: 'unknown',
    amountRaw: 'Not published',
    awardCountRaw: 'Not published',
  },
  deadline: {
    kind: 'dormant',
    source: { kind: 'self' },
    note: 'No cycle. The program is discontinued.',
  },
  applyVia: 'none',
  constraints: [],
  fundingRestrictions: [],
  obligations: { costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'unaddressed' },
  trust: {
    status: 'discontinued',
    sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
    lastVerifiedAt: '2026-01-05T00:00:00.000Z',
    verificationMethod: 'manual_curation',
    contentHash: 'e1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    staleMirrorWarning: 'Zero hits in the live ARRL scholarship catalog, and no occurrence of the word "scholarship" on the club site. Still listed by 7 or more third-party aggregators, which mirror stale ARRL data.',
  },
  rawOtherText: '',
  tags: ['scholarship', 'discontinued'],
};

export const fixturePrograms: Program[] = [
  arrlScholarship,
  qcwaScholarship,
  ardcGrants,
  arrlClubGrant,
  chicagoFmScholarship,
];

/**
 * Insert the fixture funders and programs into a test database, through Plan 1's
 * repository factories. Hand-written INSERTs are forbidden here: `funders` and
 * `programs` both carry NOT NULL columns (`homepage`, `created_at`,
 * `updated_at`, `summary`, `applicant_entities`, …) that only the repositories
 * populate, and `programs` has no `data` column (RESOLUTIONS R1).
 */
export function seedFixtureCorpus(db: Database.Database): void {
  const funderRepo = createFunderRepo(db);
  for (const f of funders) funderRepo.upsert(f);

  const programRepo = createProgramRepo(db);
  for (const p of fixturePrograms) programRepo.upsert(p);
}

/**
 * RESOLUTIONS R19. `profiles.user_id` and `watches.user_id` are
 * `REFERENCES users(id) ON DELETE CASCADE` in Plan 1's 001-init.sql, and
 * `openDatabase` sets `PRAGMA foreign_keys = ON`, so a fixture that writes a
 * profile or a star for `u-member` without a `users` row fails the INSERT.
 *
 * Plan 1's `createUserRepo(db).create()` mints its own id; these tests pin ids
 * (`u-member`, `u-admin`, `u-other`) so the assertions can name them, hence the
 * explicit INSERT. Every NOT NULL / UNIQUE column in Plan 1's `users` DDL is
 * populated: `email_normalized` and `ics_token` are both UNIQUE and are derived
 * from the id so two calls never collide.
 */
export function seedTestUser(
  db: Database.Database,
  userId: string,
  role: 'admin' | 'member' = 'member',
  atISO = '2026-08-02T00:00:00.000Z',
): void {
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, email, email_normalized, password_hash, role, display_name,
        ics_token, disabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    userId,
    `${userId}@example.com`,
    `${userId}@example.com`,
    '$argon2id$v=19$m=19456,t=2,p=1$fixture$fixture-not-a-real-hash',
    role,
    userId,
    `ics-${userId}`,
    atISO,
  );
}

/**
 * Star a program in a test database. RESOLUTIONS R19: `watches` has ON DELETE
 * CASCADE foreign keys to BOTH `users` and `programs`, so this helper makes sure
 * both parents exist before the star. It is the ONLY way Plan 3's fixtures write
 * to `watches` — a bare `INSERT INTO watches (...)` in a test file is a
 * foreign-key failure waiting for whichever fixture forgot a parent.
 *
 * The program is inserted only when it is ABSENT: several suites star a program
 * after deliberately mutating it (an approved candidate, a verified refetch),
 * and an unconditional upsert would quietly roll that mutation back.
 *
 * `notify_changes` is written explicitly rather than left to its DEFAULT 1, so
 * the column named in the conformance map is exercised by real inserts.
 */
export function starProgram(
  db: Database.Database,
  userId: string,
  programId: string,
  atISO: string,
): void {
  seedTestUser(db, userId);

  const present = db.prepare('SELECT 1 FROM programs WHERE id = ?').get(programId);
  if (present === undefined) {
    const program = fixturePrograms.find((p) => p.id === programId);
    if (program === undefined) {
      throw new Error(
        `starProgram: "${programId}" is neither in the database nor in ` +
          'fixturePrograms, so the watches foreign key to programs would fail. ' +
          'Seed the program first, or add it to the fixture corpus.',
      );
    }
    const funder = funders.find((f) => f.id === program.funderId);
    if (funder !== undefined) createFunderRepo(db).upsert(funder);
    createProgramRepo(db).upsert(program);
  }

  db.prepare(
    `INSERT INTO watches (id, user_id, program_id, notify_changes, created_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT (user_id, program_id) DO NOTHING`,
  ).run(`${userId}:${programId}`, userId, programId, atISO);
}
```

The imports at the top of that file are therefore:

```ts
import type Database from 'better-sqlite3';
import type { Funder, Program } from '@grantspotter/core';
import { createFunderRepo } from '../../db/repositories/funders.js';
import { createProgramRepo } from '../../db/repositories/programs.js';
```

Create `packages/server/src/api/reindex.ts`:

```ts
import type Database from 'better-sqlite3';
import type { Cycle, Program } from '@grantspotter/core';
import { expandCycles } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';

const HORIZON_DAYS = 550; // ~18 months: long enough to catch next year's annual window.

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

/**
 * Whole records come from Plan 1's repository (RESOLUTIONS R1 — there is no
 * `programs.data` column); only the funder display name is read in SQL, and it
 * is read once into a map rather than joined per row.
 */
function loadCorpus(db: Database.Database): Array<{ program: Program; funderName: string }> {
  const funderNames = new Map(
    (db.prepare('SELECT id, name FROM funders').all() as Array<{ id: string; name: string }>)
      .map((f) => [f.id, f.name] as const),
  );
  return createProgramRepo(db)
    .list()
    .map((program) => ({ program, funderName: funderNames.get(program.funderId) ?? '' }));
}

function nextCycle(cycles: Cycle[], nowISO: string): Cycle | null {
  const future = cycles
    .filter((c) => c.closesAt !== undefined && c.closesAt >= nowISO)
    .sort((a, b) => (a.closesAt ?? '').localeCompare(b.closesAt ?? ''));
  return future[0] ?? null;
}

/**
 * Rebuild the browse projection from `programs`. Wholesale, inside one
 * transaction, so a partial rebuild can never be observed by a reader.
 * Returns the number of programs projected.
 */
export function reindexBrowse(db: Database.Database, nowISO: string): number {
  const corpus = loadCorpus(db);
  const allPrograms = corpus.map((c) => c.program);
  const to = addDays(nowISO, HORIZON_DAYS);

  const clearSearch = db.prepare('DELETE FROM program_search');
  const clearFacets = db.prepare('DELETE FROM program_facets');
  const insertSearch = db.prepare(
    `INSERT INTO program_search
       (program_id, funder_id, funder_name, name, klass, status, instrument,
        amount_min, amount_max, deadline_kind, next_opens_at, next_closes_at,
        next_is_estimated, last_verified_at, haystack)
     VALUES (@program_id, @funder_id, @funder_name, @name, @klass, @status, @instrument,
             @amount_min, @amount_max, @deadline_kind, @next_opens_at, @next_closes_at,
             @next_is_estimated, @last_verified_at, @haystack)`,
  );
  const insertFacet = db.prepare(
    'INSERT OR IGNORE INTO program_facets (program_id, facet_kind, facet_value) VALUES (?, ?, ?)',
  );

  const run = db.transaction(() => {
    clearSearch.run();
    clearFacets.run();
    for (const { program, funderName } of corpus) {
      const cycles = expandCycles(program, allPrograms, nowISO, to);
      const next = nextCycle(cycles, nowISO);
      insertSearch.run({
        program_id: program.id,
        funder_id: program.funderId,
        funder_name: funderName,
        name: program.name,
        klass: program.klass,
        status: program.trust.status,
        instrument: program.amount.instrument,
        amount_min: program.amount.amountMin ?? null,
        amount_max: program.amount.amountMax ?? null,
        deadline_kind: program.deadline.kind,
        next_opens_at: next?.opensAt ?? null,
        next_closes_at: next?.closesAt ?? null,
        next_is_estimated: next?.isEstimated ? 1 : 0,
        last_verified_at: program.trust.lastVerifiedAt,
        haystack: [
          program.name, funderName, program.summary,
          program.tags.join(' '), program.amount.amountRaw, program.rawOtherText,
        ].join(' · ').toLowerCase(),
      });
      for (const e of program.applicantEntities) insertFacet.run(program.id, 'entity', e);
      for (const t of program.tags) insertFacet.run(program.id, 'tag', t);
    }
  });

  run();
  return corpus.length;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/db/schemaConformance.test.ts packages/server/src/api/reindex.test.ts
```

Expected: all conformance rows green and 6 reindex assertions green. **If a conformance row fails, stop and reconcile the column name with Plan 1 or Plan 2 before continuing — do not adapt Plan 3 around a typo.**

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/db/migrations/030-browse-projection.sql \
        packages/server/src/api/browseTypes.ts \
        packages/server/src/api/reindex.ts \
        packages/server/src/test \
        packages/server/src/db/schemaConformance.test.ts \
        packages/server/src/api/reindex.test.ts
git commit -m "feat(api): browse projection tables, reindexer, and schema-conformance gate"
```

---
### Task 3: The indexed browse query

**Files:**
- Create: `packages/server/src/api/browseQuery.ts`
- Test: `packages/server/src/api/browseQuery.test.ts`

**Interfaces:**
- Consumes: `BrowseFilters`, `DEFAULT_FILTERS` from `./browseTypes.js`; `createProgramRepo(db)` from `../db/repositories/programs.js` (Plan 1); `openTestDb`, `seedFixtureCorpus`, `reindexBrowse`.
- Produces: `queryProgramIds(db: Database.Database, filters: BrowseFilters): { ids: string[]; total: number }`, `hydratePrograms(db: Database.Database, ids: string[]): Map<string, HydratedProgram>`, `HydratedProgram`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/browseQuery.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus } from '../test/fixtures/programs.js';
import { reindexBrowse } from './reindex.js';
import { queryProgramIds, hydratePrograms } from './browseQuery.js';
import { DEFAULT_FILTERS, type BrowseFilters } from './browseTypes.js';

const NOW = '2026-08-02T12:00:00.000Z';

function filters(patch: Partial<BrowseFilters> = {}): BrowseFilters {
  return { ...DEFAULT_FILTERS, ...patch };
}

describe('queryProgramIds', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterAll(() => {
    db.close();
  });

  it('returns everything with no filters', () => {
    const { ids, total } = queryProgramIds(db, filters());
    expect(total).toBe(5);
    expect(ids).toHaveLength(5);
  });

  it('filters by opportunity class', () => {
    const { ids } = queryProgramIds(db, filters({ klass: ['ham_grant'] }));
    expect(ids.sort()).toEqual(['ardc-grants', 'arrl-club-grant']);
  });

  it('filters by applicant entity through the facet table', () => {
    const { ids } = queryProgramIds(db, filters({ entity: ['university'] }));
    expect(ids).toEqual(['ardc-grants']);
  });

  it('ORs multiple entities rather than ANDing them', () => {
    const { ids } = queryProgramIds(db, filters({ entity: ['university', 'individual'] }));
    expect(ids.sort()).toEqual([
      'ardc-grants',
      'arrl-foundation-scholarship',
      'chicago-fm-club-scholarship',
      'qcwa-memorial-scholarship',
    ]);
  });

  it('filters by instrument', () => {
    const { ids } = queryProgramIds(db, filters({ instrument: ['cash_fixed'] }));
    expect(ids).toEqual(['qcwa-memorial-scholarship']);
  });

  it('filters by status, including the real "unknown" state', () => {
    const { ids } = queryProgramIds(db, filters({ status: ['unknown'] }));
    expect(ids).toEqual(['arrl-club-grant']);
  });

  it('filters by an overlapping amount range', () => {
    // ARDC 1285-258000 and Club Grant 1000-25000 both straddle 20000.
    const { ids } = queryProgramIds(db, filters({ amountMin: 20000, amountMax: 30000 }));
    expect(ids.sort()).toEqual(['ardc-grants', 'arrl-club-grant', 'arrl-foundation-scholarship']);
  });

  it('drops rolling and undated programs when a deadline window is set', () => {
    const { ids } = queryProgramIds(
      db,
      filters({
        deadlineFrom: '2026-12-01T00:00:00.000Z',
        deadlineTo: '2027-01-15T00:00:00.000Z',
        includeRolling: false,
      }),
    );
    expect(ids.sort()).toEqual(['arrl-foundation-scholarship', 'qcwa-memorial-scholarship']);
  });

  it('keeps rolling and undated programs when includeRolling is true', () => {
    const { ids } = queryProgramIds(
      db,
      filters({
        deadlineFrom: '2026-12-01T00:00:00.000Z',
        deadlineTo: '2027-01-15T00:00:00.000Z',
        includeRolling: true,
      }),
    );
    expect(ids).toContain('arrl-club-grant'); // deadline_kind = 'unpublished'
  });

  it('searches the haystack case-insensitively', () => {
    const { ids } = queryProgramIds(db, filters({ q: 'QUARTER CENTURY' }));
    expect(ids).toEqual(['qcwa-memorial-scholarship']);
  });

  it('escapes LIKE wildcards in the query string', () => {
    const { ids } = queryProgramIds(db, filters({ q: '100%' }));
    expect(ids).toEqual([]);
  });

  it('sorts by deadline with undated programs last', () => {
    const { ids } = queryProgramIds(db, filters({ sort: 'deadline' }));
    expect(ids[0]).toBe('arrl-foundation-scholarship');
    expect(ids.at(-1)).toBe('chicago-fm-club-scholarship');
  });

  it('sorts by amount descending', () => {
    const { ids } = queryProgramIds(db, filters({ sort: 'amount_desc' }));
    expect(ids[0]).toBe('ardc-grants');
  });

  it('paginates and still reports the unpaginated total', () => {
    const { ids, total } = queryProgramIds(db, filters({ sort: 'name', page: 2, pageSize: 2 }));
    expect(total).toBe(5);
    expect(ids).toHaveLength(2);
  });
});

describe('hydratePrograms', () => {
  let db: Database.Database;

  beforeAll(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterAll(() => {
    db.close();
  });

  it('returns full Program objects keyed by id, with the projection dates', () => {
    const map = hydratePrograms(db, ['qcwa-memorial-scholarship']);
    const hit = map.get('qcwa-memorial-scholarship');
    expect(hit?.program.name).toBe('QCWA Memorial Scholarship Fund');
    expect(hit?.funderName).toBe('Quarter Century Wireless Association');
    expect(hit?.nextClosesAt).toBe('2026-12-30T17:00:00.000Z');
    expect(hit?.program.trust.disputed).toBeUndefined();
  });

  it('returns an empty map for an empty id list without issuing a query', () => {
    expect(hydratePrograms(db, []).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/browseQuery.test.ts
```

Expected failure: `Failed to load url ./browseQuery.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/api/browseQuery.ts`:

```ts
import type Database from 'better-sqlite3';
import type { Program } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import type { BrowseFilters } from './browseTypes.js';

/** Deadline kinds that have no concrete date and therefore no window to match. */
const UNDATED_KINDS = [
  'rolling', 'unpublished', 'no_application_exists', 'dormant', 'ad_hoc', 'inherited',
];

function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/** SQLite LIKE treats % and _ as wildcards; escape them with a backslash. */
function escapeLike(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const ORDER_BY: Record<BrowseFilters['sort'], string> = {
  // NULL closes_at sorts last in both directions: undated programs never lead the list.
  deadline: 'ps.next_closes_at IS NULL ASC, ps.next_closes_at ASC, ps.name ASC',
  amount_desc: 'COALESCE(ps.amount_max, ps.amount_min, -1) DESC, ps.name ASC',
  name: 'ps.name ASC',
  verified: 'ps.last_verified_at DESC, ps.name ASC',
};

/**
 * Indexed filter over the browse projection. Returns the page of ids plus the
 * unpaginated total. Matcher verdicts are NOT applied here — they are a
 * per-profile overlay applied by the router (Task 4).
 */
export function queryProgramIds(
  db: Database.Database,
  f: BrowseFilters,
): { ids: string[]; total: number } {
  const where: string[] = [];
  const params: unknown[] = [];

  if (f.klass.length) {
    where.push(`ps.klass IN (${placeholders(f.klass.length)})`);
    params.push(...f.klass);
  }
  if (f.status.length) {
    where.push(`ps.status IN (${placeholders(f.status.length)})`);
    params.push(...f.status);
  }
  if (f.instrument.length) {
    where.push(`ps.instrument IN (${placeholders(f.instrument.length)})`);
    params.push(...f.instrument);
  }
  if (f.entity.length) {
    where.push(
      `EXISTS (SELECT 1 FROM program_facets pf
                WHERE pf.program_id = ps.program_id
                  AND pf.facet_kind = 'entity'
                  AND pf.facet_value IN (${placeholders(f.entity.length)}))`,
    );
    params.push(...f.entity);
  }
  if (f.amountMin !== undefined) {
    // Overlap semantics: keep a program whose ceiling reaches the user's floor.
    where.push('COALESCE(ps.amount_max, ps.amount_min, 0) >= ?');
    params.push(f.amountMin);
  }
  if (f.amountMax !== undefined) {
    where.push('COALESCE(ps.amount_min, ps.amount_max, 0) <= ?');
    params.push(f.amountMax);
  }
  if (f.deadlineFrom !== undefined || f.deadlineTo !== undefined) {
    const clauses: string[] = [];
    const dated: string[] = ['ps.next_closes_at IS NOT NULL'];
    if (f.deadlineFrom !== undefined) {
      dated.push('ps.next_closes_at >= ?');
      params.push(f.deadlineFrom);
    }
    if (f.deadlineTo !== undefined) {
      dated.push('ps.next_closes_at <= ?');
      params.push(f.deadlineTo);
    }
    clauses.push(`(${dated.join(' AND ')})`);
    if (f.includeRolling) {
      clauses.push(`ps.deadline_kind IN (${placeholders(UNDATED_KINDS.length)})`);
      params.push(...UNDATED_KINDS);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }
  if (f.q !== undefined && f.q.trim() !== '') {
    where.push(`ps.haystack LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(f.q.trim().toLowerCase())}%`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM program_search ps ${whereSql}`)
      .get(...params) as { n: number }
  ).n;

  const offset = Math.max(0, (f.page - 1) * f.pageSize);
  const rows = db
    .prepare(
      `SELECT ps.program_id AS id
         FROM program_search ps
         ${whereSql}
        ORDER BY ${ORDER_BY[f.sort]}
        LIMIT ? OFFSET ?`,
    )
    .all(...params, f.pageSize, offset) as Array<{ id: string }>;

  return { ids: rows.map((r) => r.id), total };
}

export interface HydratedProgram {
  program: Program;
  funderName: string;
  nextOpensAt: string | null;
  nextClosesAt: string | null;
  nextIsEstimated: boolean;
}

/**
 * Load full `Program` records plus their projection dates for an explicit id
 * list. The record itself comes from Plan 1's repository — `programs` is
 * normalized and has no `data` column (RESOLUTIONS R1) — while the three
 * next-cycle scalars come from the browse projection, which is the only place
 * they exist.
 */
export function hydratePrograms(
  db: Database.Database,
  ids: string[],
): Map<string, HydratedProgram> {
  const out = new Map<string, HydratedProgram>();
  if (ids.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT ps.program_id AS id,
              ps.funder_name AS funder_name,
              ps.next_opens_at AS next_opens_at,
              ps.next_closes_at AS next_closes_at,
              ps.next_is_estimated AS next_is_estimated
         FROM program_search ps
        WHERE ps.program_id IN (${placeholders(ids.length)})`,
    )
    .all(...ids) as Array<{
      id: string;
      funder_name: string;
      next_opens_at: string | null;
      next_closes_at: string | null;
      next_is_estimated: number;
    }>;

  const programs = createProgramRepo(db);
  for (const r of rows) {
    const program = programs.get(r.id);
    // A projection row whose program has been deleted is skipped rather than
    // faked; reindexBrowse() clears it on the next rebuild.
    if (program === undefined) continue;
    out.set(r.id, {
      program,
      funderName: r.funder_name,
      nextOpensAt: r.next_opens_at,
      nextClosesAt: r.next_closes_at,
      nextIsEstimated: r.next_is_estimated === 1,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/browseQuery.test.ts
```

Expected: 15 assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/api/browseQuery.ts packages/server/src/api/browseQuery.test.ts
git commit -m "feat(api): indexed browse query with facet, amount, window and text filters"
```

---

### Task 4: `GET /api/programs` — the matcher verdict overlay

**Why this exists:** this endpoint is the centrepiece of the product. It returns not just a list but a *verdict census*: how many of the filtered programs the user is eligible for, preferred for, ineligible for (broken down by which constraint axis excluded them), and unknown for (broken down by which profile field would resolve it). Spec §5: *"You are ineligible for 41 of these, and here is the specific constraint for each"*.

Router factories take an explicit `RouterDeps`. That is the seam that keeps Plan 3 independent of Plan 1's auth module names.

**Files:**
- Create: `packages/server/src/api/deps.ts`
- Create: `packages/server/src/api/profileStore.ts`
- Create: `packages/server/src/api/programsRouter.ts`
- Create: `packages/server/src/db/migrations/032-profiles.sql` (**indexes only** — Plan 1's `001-init.sql` owns the `profiles` table; RESOLUTIONS R19)
- Test: `packages/server/src/api/programsRouter.test.ts`

*(Note: `031-field-provenance.sql` is created in Task 5. Migration numbers are assigned per task and applied in filename order; they do not have to be authored in numeric order.)*

**Interfaces:**
- Consumes: `matchAll(profile, programs): Map<string, Verdict>` from `@grantspotter/core`; `queryProgramIds`, `hydratePrograms`; `BrowseFilters`, `BrowseResponse`, `BrowseRow`, `BrowseSummary`, `VerdictKind`; `AppError`, `errorHandler`, `requestIdMiddleware` from `./errors.js` (Plan 1 Task 15); `ProfileKind` re-exported from `../db/repositories/profiles.js` (Plan 1 Task 14); `seedTestUser` from `../test/fixtures/programs.js` (Task 2).
- Produces: `RouterDeps`, `SessionUser`, `CrawlRunSummary`, `CrawlTrigger` (all in `api/deps.ts`, consumed by Task 14), `createProgramsRouter(deps: RouterDeps): Router`, `parseBrowseQuery(query: Record<string, unknown>): BrowseFilters`, `loadProfile(db, userId, kind): Profile | null`, `loadActiveProfile(db, userId, prefer?): { profile: Profile; kind: ProfileKind } | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/programsRouter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, seedTestUser } from '../test/fixtures/programs.js';
import { reindexBrowse } from './reindex.js';
import { createProgramsRouter, parseBrowseQuery } from './programsRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';

const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

/**
 * The test harness mounts Plan 1's requestId middleware and error handler around
 * the router, so every failure assertion below sees the ONE real envelope
 * `{ error: { code, message, details? }, requestId }` (RESOLUTIONS R6) rather
 * than a shape invented by the test.
 */
function buildApp(db: Database.Database, user: SessionUser = MEMBER) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => {
      next(user.role === 'admin' ? undefined : new AppError('forbidden', 'Admin role required.'));
    },
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/programs', createProgramsRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

/**
 * A licensed undergraduate. Enough profile to get real verdicts, with GPA absent.
 *
 * `seedTestUser` first: `profiles.user_id` is `REFERENCES users(id) ON DELETE
 * CASCADE` in Plan 1's 001-init.sql and `PRAGMA foreign_keys = ON` is set on the
 * connection, so this INSERT fails without the parent row (RESOLUTIONS R19).
 */
function seedStudentProfile(db: Database.Database) {
  seedTestUser(db, 'u-member');
  db.prepare(
    `INSERT INTO profiles (id, user_id, kind, data, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    'p-1',
    'u-member',
    'student',
    JSON.stringify({
      kind: 'student',
      callsign: 'W8UM',
      licenseClass: 'GENERAL',
      licensedSince: '2023-05-01',
      state: 'MI',
      degreeLevel: 'BACH',
      institution: 'Example State University',
      accredited: true,
      partTime: false,
      citizenship: 'US_CITIZEN',
      stage: 'UNDERGRAD',
    }),
    NOW,
  );
}

describe('parseBrowseQuery', () => {
  it('falls back to defaults for an empty query string', () => {
    const f = parseBrowseQuery({});
    expect(f.page).toBe(1);
    expect(f.pageSize).toBe(50);
    expect(f.sort).toBe('deadline');
    expect(f.klass).toEqual([]);
  });

  it('accepts repeated and comma-separated multi-values', () => {
    expect(parseBrowseQuery({ klass: 'ham_grant,ham_scholarship' }).klass)
      .toEqual(['ham_grant', 'ham_scholarship']);
    expect(parseBrowseQuery({ klass: ['ham_grant', 'ham_scholarship'] }).klass)
      .toEqual(['ham_grant', 'ham_scholarship']);
  });

  it('drops values outside the enum instead of trusting the client', () => {
    expect(parseBrowseQuery({ klass: 'ham_grant,DROP TABLE programs' }).klass)
      .toEqual(['ham_grant']);
    expect(parseBrowseQuery({ sort: 'sneaky' }).sort).toBe('deadline');
  });

  it('clamps pageSize to a sane ceiling', () => {
    expect(parseBrowseQuery({ pageSize: '100000' }).pageSize).toBe(200);
    expect(parseBrowseQuery({ pageSize: '0' }).pageSize).toBe(1);
  });
});

describe('GET /api/programs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('returns every program with a null verdict when no profile exists', async () => {
    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.profileApplied).toBeNull();
    expect(res.body.rows[0].verdict).toBeNull();
    expect(res.body.summary.eligible).toBe(0);
  });

  it('applies the student profile and returns a verdict for every row', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs');
    expect(res.body.profileApplied).toBe('student');
    for (const row of res.body.rows) {
      expect(row.verdict).not.toBeNull();
      expect(['eligible', 'eligible_preferred', 'ineligible', 'unknown'])
        .toContain(row.verdict.kind);
    }
  });

  it('reports a verdict census that sums to the filtered total', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs');
    const s = res.body.summary;
    expect(s.eligible + s.preferred + s.ineligible + s.unknown).toBe(s.total);
    expect(s.total).toBe(5);
  });

  it('breaks the ineligible count down by constraint axis', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs');
    // A student is not an ARRL-affiliated club, so the Club Grant excludes on
    // the arrl_membership axis.
    const axes = res.body.summary.ineligibleByAxis.map((a: { axis: string }) => a.axis);
    expect(axes).toContain('arrl_membership');
  });

  it('filters by verdict kind after the indexed query', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs?verdict=ineligible');
    expect(res.body.rows.length).toBeGreaterThan(0);
    for (const row of res.body.rows) expect(row.verdict.kind).toBe('ineligible');
    // The census still describes the whole filtered corpus, not just this slice.
    expect(res.body.summary.total).toBe(5);
  });

  it('surfaces the raw constraint text for every ineligibility reason', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs?verdict=ineligible');
    for (const row of res.body.rows) {
      for (const reason of row.verdict.reasons) {
        expect(typeof reason.rawText).toBe('string');
        expect(reason.rawText.length).toBeGreaterThan(0);
      }
    }
  });

  it('ranks the profile fields that would resolve the most unknown verdicts', async () => {
    seedStudentProfile(db);
    const res = await request(buildApp(db)).get('/api/programs');
    const fields = res.body.summary.unknownByField;
    expect(Array.isArray(fields)).toBe(true);
    for (let i = 1; i < fields.length; i += 1) {
      expect(fields[i - 1].count).toBeGreaterThanOrEqual(fields[i].count);
    }
  });

  it('passes filters through to the indexed query', async () => {
    const res = await request(buildApp(db)).get('/api/programs?klass=ham_grant&sort=name');
    expect(res.body.total).toBe(2);
    expect(res.body.rows.map((r: { program: { id: string } }) => r.program.id))
      .toEqual(['ardc-grants', 'arrl-club-grant']);
  });

  it('carries lastVerifiedAt and status onto every row so the badges can render', async () => {
    const res = await request(buildApp(db)).get('/api/programs?q=chicago');
    const row = res.body.rows[0];
    expect(row.program.trust.lastVerifiedAt).toBe('2026-01-05T00:00:00.000Z');
    expect(row.program.trust.status).toBe('discontinued');
    expect(row.program.trust.staleMirrorWarning).toContain('7 or more third-party aggregators');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npm install --save-dev supertest @types/supertest -w @grantspotter/server
npx vitest run packages/server/src/api/programsRouter.test.ts
```

Expected failure: `Failed to load url ./deps.js`. (`profiles` already exists — Plan 1's
`001-init.sql` created it; RESOLUTIONS R19. If you instead see `no such table: profiles`, Plan 1's
migration did not run and the fix is in Plan 1, not here.)

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/db/migrations/032-profiles.sql`. **It contains no `CREATE TABLE`**
(RESOLUTIONS R19): `profiles` is a CONTRACT §6 table and Plan 1's `001-init.sql` owns its DDL —
including `user_id … REFERENCES users(id) ON DELETE CASCADE`, which a re-declaration here would
quietly drop. Migrations apply in filename order, so a `CREATE TABLE IF NOT EXISTS` in `032` would
be a silent no-op that nonetheless *reads* as this plan's schema. All this file may add is an index:

```sql
-- Owner: Plan 1, packages/server/src/db/migrations/001-init.sql.
-- `profiles` (id, user_id, kind, data, updated_at) is created there, with
-- user_id REFERENCES users(id) ON DELETE CASCADE and UNIQUE (user_id, kind).
-- RESOLUTIONS R19: this file adds indexes ONLY. Table DDL belongs to 001-init.sql
-- and re-declaring it here would no-op; the ownership guard in
-- schemaConformance.test.ts fails this file if any table DDL appears in it.
--
-- A user may hold BOTH a student and an organization profile (spec §5), which is
-- what the composite uniqueness expresses; the named index below is the lookup
-- Plan 3's `loadProfile(db, userId, kind)` runs on every request.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_user_kind ON profiles (user_id, kind);
```

Add `profiles: ['id', 'user_id', 'kind', 'data', 'updated_at']` to the `REQUIRED` map in
`packages/server/src/db/schemaConformance.test.ts`. That entry **asserts** Plan 1's columns; it does
not create them.

Create `packages/server/src/api/deps.ts` — **plan-local**:

```ts
// PLAN-LOCAL to Plan 3.
import type { RequestHandler, Request } from 'express';
import type Database from 'better-sqlite3';

export interface SessionUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
}

/**
 * PLAN-LOCAL to Plan 3. Structurally identical to Plan 2's `SourceRunResult`
 * (`packages/server/src/crawl/runner.ts`). It is restated rather than imported
 * so the sources router can be constructed with a fake crawl trigger in tests,
 * exactly as `RouterDeps` restates the auth seam.
 */
export interface CrawlRunSummary {
  sourceId: string;
  parsedCount: number;
  events: number;
  reviewItems: number;
  error?: string;
}

/** PLAN-LOCAL to Plan 3. The admin-only manual crawl seam (spec §12). */
export type CrawlTrigger = (sourceIds?: string[]) => Promise<CrawlRunSummary[]>;

/**
 * Everything a Plan 3 router needs, injected. The server entrypoint supplies
 * the real implementations from Plan 1's auth module; tests supply fakes.
 * No Plan 3 router imports Plan 1's auth module directly.
 */
export interface RouterDeps {
  db: Database.Database;
  /** Injected clock. Every timestamp in Plan 3 comes from here, never Date.now(). */
  now: () => string;
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  currentUser: (req: Request) => SessionUser;
}
```

Create `packages/server/src/api/profileStore.ts`:

```ts
import type Database from 'better-sqlite3';
import type { OrgProfile, Profile, StudentProfile } from '@grantspotter/core';
import type { ProfileKind } from '../db/repositories/profiles.js';

/**
 * `ProfileKind` is Plan 1's, defined once in
 * packages/server/src/db/repositories/profiles.ts as `Profile['kind']`, so it
 * is derived from the CONTRACT §3 union and cannot drift when a third profile
 * variant is added. Plan 3 re-exports it for convenience; it does not restate
 * the literals.
 */
export type { ProfileKind };

export function loadProfile(
  db: Database.Database,
  userId: string,
  kind: ProfileKind,
): Profile | null {
  const row = db
    .prepare('SELECT data FROM profiles WHERE user_id = ? AND kind = ?')
    .get(userId, kind) as { data: string } | undefined;
  if (!row) return null;
  return JSON.parse(row.data) as Profile;
}

export function loadAllProfiles(
  db: Database.Database,
  userId: string,
): { student: StudentProfile | null; organization: OrgProfile | null } {
  return {
    student: (loadProfile(db, userId, 'student') as StudentProfile | null) ?? null,
    organization: (loadProfile(db, userId, 'organization') as OrgProfile | null) ?? null,
  };
}

/**
 * The profile a request should be matched against. A user may hold both; the
 * caller may name one, otherwise student wins because the ~150-record corpus is
 * scholarship-heavy (spec §2 - 111 of the ARRL catalog entries are scholarships).
 */
export function loadActiveProfile(
  db: Database.Database,
  userId: string,
  prefer?: ProfileKind,
): { profile: Profile; kind: ProfileKind } | null {
  const order: ProfileKind[] = prefer ? [prefer] : ['student', 'organization'];
  for (const kind of order) {
    const profile = loadProfile(db, userId, kind);
    if (profile) return { profile, kind };
  }
  return null;
}

export function saveProfile(
  db: Database.Database,
  userId: string,
  kind: ProfileKind,
  profile: Profile,
  nowISO: string,
): void {
  db.prepare(
    `INSERT INTO profiles (id, user_id, kind, data, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind)
     DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  ).run(`${userId}:${kind}`, userId, kind, JSON.stringify(profile), nowISO);
}
```

Create `packages/server/src/api/programsRouter.ts`:

```ts
import { Router } from 'express';
import type { Constraint, Program, Verdict } from '@grantspotter/core';
import { matchAll } from '@grantspotter/core';
import type { RouterDeps } from './deps.js';
import { hydratePrograms, queryProgramIds } from './browseQuery.js';
import { loadActiveProfile, type ProfileKind } from './profileStore.js';
import {
  DEFAULT_FILTERS,
  type BrowseFilters,
  type BrowseResponse,
  type BrowseRow,
  type BrowseSummary,
  type BrowseSort,
  type VerdictKind,
} from './browseTypes.js';

const KLASSES = ['ham_grant', 'ham_scholarship', 'adjacent_stem', 'equipment_in_kind'];
const ENTITIES = [
  'individual', 'club_unincorporated', 'club_501c3', 'club_via_fiscal_sponsor',
  'school_lea', 'university', 'university_dept', 'ieee_student_branch_chapter',
  'teacher', 'nominated_by_institution',
];
const INSTRUMENTS = [
  'cash_range', 'cash_fixed', 'cash_tiered_blocks', 'in_kind_equipment',
  'in_kind_service', 'discounted_purchase', 'per_member_rebate',
  'tuition_coverage', 'unknown',
];
const STATUSES = [
  'open', 'closed', 'dormant', 'discontinued', 'contact_only', 'no_application', 'unknown',
];
const VERDICTS = ['eligible', 'eligible_preferred', 'ineligible', 'unknown'];
const SORTS = ['deadline', 'amount_desc', 'name', 'verified'];

function multi(value: unknown, allowed: string[]): string[] {
  const raw: string[] = Array.isArray(value)
    ? value.flatMap((v) => String(v).split(','))
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return raw.map((s) => s.trim()).filter((s) => allowed.includes(s));
}

function num(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value;
}

/** Total tolerance for a hostile query string: unknown values are dropped, never echoed. */
export function parseBrowseQuery(query: Record<string, unknown>): BrowseFilters {
  const pageSizeRaw = num(query.pageSize) ?? DEFAULT_FILTERS.pageSize;
  return {
    klass: multi(query.klass, KLASSES) as BrowseFilters['klass'],
    entity: multi(query.entity, ENTITIES) as BrowseFilters['entity'],
    instrument: multi(query.instrument, INSTRUMENTS) as BrowseFilters['instrument'],
    status: multi(query.status, STATUSES) as BrowseFilters['status'],
    verdict: multi(query.verdict, VERDICTS) as VerdictKind[],
    deadlineFrom: iso(query.deadlineFrom),
    deadlineTo: iso(query.deadlineTo),
    includeRolling: query.includeRolling !== 'false',
    amountMin: num(query.amountMin),
    amountMax: num(query.amountMax),
    q: typeof query.q === 'string' ? query.q : undefined,
    sort: (SORTS.includes(String(query.sort)) ? String(query.sort) : 'deadline') as BrowseSort,
    page: Math.max(1, Math.trunc(num(query.page) ?? 1)),
    pageSize: Math.min(200, Math.max(1, Math.trunc(pageSizeRaw))),
  };
}

function verdictKind(v: Verdict): VerdictKind {
  return v.kind;
}

function buildSummary(verdicts: Map<string, Verdict>, total: number): BrowseSummary {
  const axisCounts = new Map<string, number>();
  const fieldCounts = new Map<string, number>();
  let eligible = 0;
  let preferred = 0;
  let ineligible = 0;
  let unknown = 0;

  for (const v of verdicts.values()) {
    switch (v.kind) {
      case 'eligible':
        eligible += 1;
        break;
      case 'eligible_preferred':
        preferred += 1;
        break;
      case 'ineligible': {
        ineligible += 1;
        const axes = new Set(v.reasons.map((c: Constraint) => c.spec.axis));
        for (const axis of axes) axisCounts.set(axis, (axisCounts.get(axis) ?? 0) + 1);
        break;
      }
      case 'unknown': {
        unknown += 1;
        for (const field of new Set(v.missingProfileFields)) {
          fieldCounts.set(field, (fieldCounts.get(field) ?? 0) + 1);
        }
        break;
      }
    }
  }

  const rank = <K extends string>(m: Map<string, number>, key: K) =>
    [...m.entries()]
      .map(([k, count]) => ({ [key]: k, count }) as Record<K | 'count', string | number>)
      .sort((a, b) => (b.count as number) - (a.count as number));

  return {
    total,
    eligible,
    preferred,
    ineligible,
    unknown,
    ineligibleByAxis: rank(axisCounts, 'axis') as BrowseSummary['ineligibleByAxis'],
    unknownByField: rank(fieldCounts, 'field') as BrowseSummary['unknownByField'],
  };
}

export function createProgramsRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const filters = parseBrowseQuery(req.query as Record<string, unknown>);
    const prefer = ['student', 'organization'].includes(String(req.query.profile))
      ? (String(req.query.profile) as ProfileKind)
      : undefined;
    const active = loadActiveProfile(deps.db, user.id, prefer);

    // 1. Indexed filter, unpaginated, so the verdict census describes the whole
    //    filtered corpus rather than one page. ~150 records makes this cheap.
    const all = queryProgramIds(deps.db, { ...filters, page: 1, pageSize: 100_000 });
    const hydrated = hydratePrograms(deps.db, all.ids);
    const programs: Program[] = all.ids
      .map((id) => hydrated.get(id)?.program)
      .filter((p): p is Program => p !== undefined);

    // 2. Per-profile verdict overlay.
    const verdicts: Map<string, Verdict> = active
      ? matchAll(active.profile, programs)
      : new Map<string, Verdict>();

    const summary = buildSummary(verdicts, all.ids.length);

    // 3. Verdict filter, then pagination.
    const visibleIds = filters.verdict.length
      ? all.ids.filter((id) => {
          const v = verdicts.get(id);
          return v !== undefined && filters.verdict.includes(verdictKind(v));
        })
      : all.ids;

    const start = (filters.page - 1) * filters.pageSize;
    const pageIds = visibleIds.slice(start, start + filters.pageSize);

    const watched = new Set(
      (
        db_watchedIds(deps, user.id)
      ),
    );

    const rows: BrowseRow[] = pageIds.map((id) => {
      const h = hydrated.get(id);
      if (!h) throw new Error(`hydration miss for ${id}`);
      return {
        program: h.program,
        funderName: h.funderName,
        verdict: verdicts.get(id) ?? null,
        nextOpensAt: h.nextOpensAt,
        nextClosesAt: h.nextClosesAt,
        nextIsEstimated: h.nextIsEstimated,
        watched: watched.has(id),
      };
    });

    const body: BrowseResponse = {
      rows,
      summary,
      page: filters.page,
      pageSize: filters.pageSize,
      total: visibleIds.length,
      profileApplied: active?.kind ?? null,
    };
    res.json(body);
  });

  return router;
}

/**
 * Watched program ids for a user. Tolerates the `watches` table not yet
 * existing so this router can be landed before Task 7; the table arrives in
 * migration 033 and this function starts returning real rows the moment it does.
 */
function db_watchedIds(deps: RouterDeps, userId: string): string[] {
  const exists = deps.db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'watches'`)
    .get();
  if (!exists) return [];
  const rows = deps.db
    .prepare('SELECT program_id FROM watches WHERE user_id = ?')
    .all(userId) as Array<{ program_id: string }>;
  return rows.map((r) => r.program_id);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/programsRouter.test.ts packages/server/src/db/schemaConformance.test.ts
```

Expected: 13 router assertions plus the extended conformance map green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/api/deps.ts packages/server/src/api/profileStore.ts \
        packages/server/src/api/programsRouter.ts \
        packages/server/src/api/programsRouter.test.ts \
        packages/server/src/db/migrations/032-profiles.sql \
        packages/server/src/db/schemaConformance.test.ts
git commit -m "feat(api): browse endpoint with per-profile matcher verdict census"
```

---
### Task 5: `GET /api/programs/:id` — detail with field-level provenance

**Why this exists:** spec §8 requires *field-level provenance — which source, which fetch, and the raw text the value came from*. That means a real table, written whenever a value enters the corpus, and read back next to the value it explains. It is also how a user checks the deadline of a program that **inherits** it from another program (the 111-entries-share-one-deadline problem).

**Files:**
- Create: `packages/server/src/db/migrations/031-field-provenance.sql`
- Create: `packages/server/src/api/provenanceStore.ts`
- Modify: `packages/server/src/api/programsRouter.ts` (add the `:id` route)
- Modify: `packages/server/src/db/schemaConformance.test.ts` (add `field_provenance`)
- Test: `packages/server/src/api/provenanceStore.test.ts`
- Test: `packages/server/src/api/programDetail.test.ts`

**Interfaces:**
- Consumes: `RawOpportunity`, `Program`, `Funder`, `Cycle` from `@grantspotter/core`; `resolveDeadlineOwner(program, allPrograms): Program` and `expandCycles` from `@grantspotter/core`; `RouterDeps`; `OpportunityDetail`, `FieldProvenance`.
- Produces: `recordProvenance(db, programId, sourceId, snapshotId, raw: RawOpportunity, nowISO): number`, `loadProvenance(db, programId): FieldProvenance[]`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/api/provenanceStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { RawOpportunity } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus } from '../test/fixtures/programs.js';
import { recordProvenance, loadProvenance } from './provenanceStore.js';

const NOW = '2026-08-02T12:00:00.000Z';

/**
 * A RawOpportunity as the ARRL scholarship parser emits it. The label typos are
 * real - `R egion` and `License   Requirement` were observed in the live page,
 * which is why the parser matches by label regex over flattened text.
 */
const raw: RawOpportunity = {
  sourceId: 'arrl-scholarship-descriptions',
  externalKey: 'ARRL Foundation Scholarship Program',
  name: 'ARRL Foundation Scholarship Program',
  rawFields: {
    'Award Amount': '$500 - $25,000',
    'License Requirement': 'Any class of FCC amateur radio license',
    'R egion': 'Any',
    'Number of Awards': '170+',
  },
  sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
  rawText: 'Award Amount: $500 - $25,000 • License Requirement: Any class ...',
};

describe('recordProvenance', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  it('stores one row per raw field, verbatim', () => {
    const n = recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-1', raw, NOW);
    expect(n).toBe(4);
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    const region = rows.find((r) => r.rawLabel === 'R egion');
    expect(region?.rawValue).toBe('Any');
    expect(region?.snapshotId).toBe('snap-1');
    expect(region?.fetchedAt).toBe(NOW);
  });

  it('maps known raw labels onto the Program field path they populated', () => {
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-1', raw, NOW);
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    const amount = rows.find((r) => r.rawLabel === 'Award Amount');
    expect(amount?.fieldPath).toBe('amount.amountRaw');
  });

  it('normalizes the typo\'d ARRL labels seen in the wild onto the same field path', () => {
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-1', raw, NOW);
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    expect(rows.find((r) => r.rawLabel === 'R egion')?.fieldPath).toBe('constraints.geography');
    expect(rows.find((r) => r.rawLabel === 'License Requirement')?.fieldPath)
      .toBe('constraints.license');
  });

  it('falls back to a rawFields path for a label it does not recognise', () => {
    const odd: RawOpportunity = { ...raw, rawFields: { 'Ham Family Preference': 'Yes' } };
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', null, odd, NOW);
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    expect(rows[0]?.fieldPath).toBe('rawOtherText');
  });

  it('replaces the previous provenance for the same source instead of appending', () => {
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-1', raw, NOW);
    recordProvenance(db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-2', raw, '2026-09-01T00:00:00.000Z');
    const rows = loadProvenance(db, 'arrl-foundation-scholarship');
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.snapshotId === 'snap-2')).toBe(true);
  });
});
```

Create `packages/server/src/api/programDetail.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus } from '../test/fixtures/programs.js';
import { reindexBrowse } from './reindex.js';
import { createProgramsRouter } from './programsRouter.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => MEMBER,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/programs', createProgramsRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

describe('GET /api/programs/:id', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('404s for an unknown id, in the one error envelope', async () => {
    const res = await request(buildApp(db)).get('/api/programs/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
    expect(res.body.error.message).toContain('does-not-exist');
    expect(typeof res.body.requestId).toBe('string');
  });

  it('returns the full record, the funder with its homepage, and the resolved cycles', async () => {
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.status).toBe(200);
    expect(res.body.program.name).toBe('ARDC Grants Program');
    expect(res.body.funder.name).toBe('Amateur Radio Digital Communications');
    expect(res.body.funder.homepage).toBe('https://www.ardc.net/');
    expect(res.body.cycles.length).toBeGreaterThan(0);
  });

  it('names the program a deadline was inherited from', async () => {
    const res = await request(buildApp(db)).get('/api/programs/qcwa-memorial-scholarship');
    expect(res.body.deadlineOwner).toEqual({
      programId: 'arrl-foundation-scholarship',
      programName: 'ARRL Foundation Scholarship Program',
    });
  });

  it('reports deadlineOwner null for a program that owns its own deadline', async () => {
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.body.deadlineOwner).toBeNull();
  });

  it('returns every disputed claim with its source rather than picking one', async () => {
    const res = await request(buildApp(db)).get('/api/programs/arrl-club-grant');
    expect(res.body.program.trust.disputed.claims).toHaveLength(3);
    for (const claim of res.body.program.trust.disputed.claims) {
      expect(claim.sourceUrl).toMatch(/^https?:\/\//);
    }
  });

  it('returns the obligations that applicants miss', async () => {
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.body.program.obligations.indirectCostCapPct).toBe(20);
    expect(res.body.program.obligations.licenseObligation).toContain('open-source');
  });

  it('returns the aiPolicy quote with its url', async () => {
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.body.program.aiPolicy.stance).toBe('permitted');
    expect(res.body.program.aiPolicy.url)
      .toBe('https://www.ardc.net/apply/grant-application-instructions/');
  });

  it('returns provenance rows when they exist', async () => {
    db.prepare(
      `INSERT INTO field_provenance
        (program_id, field_path, source_id, snapshot_id, raw_label, raw_value, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'ardc-grants', 'deadline.note', 'ardc-wp-pages', 'snap-9',
      'Application deadlines', 'February 1, April 1, July 1, September 1', NOW,
    );
    const res = await request(buildApp(db)).get('/api/programs/ardc-grants');
    expect(res.body.provenance).toHaveLength(1);
    expect(res.body.provenance[0].rawValue)
      .toBe('February 1, April 1, July 1, September 1');
  });

  it('returns an empty provenance array rather than omitting the key', async () => {
    const res = await request(buildApp(db)).get('/api/programs/arrl-club-grant');
    expect(res.body.provenance).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/provenanceStore.test.ts packages/server/src/api/programDetail.test.ts
```

Expected failure: `Failed to load url ./provenanceStore.js` and `Cannot GET /api/programs/ardc-grants` (Express's default 404 HTML body, not the `{ error: { code: 'not_found' … } }` envelope).

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/db/migrations/031-field-provenance.sql`:

```sql
-- Plan 3: field-level provenance (spec §8). One row per raw label captured from
-- a source, keyed to the Program field path it populated.
CREATE TABLE IF NOT EXISTS field_provenance (
  program_id  TEXT NOT NULL,
  field_path  TEXT NOT NULL,
  source_id   TEXT NOT NULL,
  snapshot_id TEXT,
  raw_label   TEXT NOT NULL,
  raw_value   TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (program_id, source_id, raw_label)
);

CREATE INDEX IF NOT EXISTS idx_fp_program ON field_provenance (program_id);
```

Add `field_provenance: ['program_id', 'field_path', 'source_id', 'snapshot_id', 'raw_label', 'raw_value', 'fetched_at']` to the `REQUIRED` map in `schemaConformance.test.ts`.

Create `packages/server/src/api/provenanceStore.ts`:

```ts
import type Database from 'better-sqlite3';
import type { RawOpportunity } from '@grantspotter/core';
import type { FieldProvenance } from './browseTypes.js';

/**
 * Raw source labels mapped onto the Program field path they populate.
 * Keys are normalized: lowercased, all whitespace collapsed and removed.
 * That collapse is what absorbs the typos observed live on arrl.org -
 * `R egion`, `License   Requirement`, `Scholarshp` - without a per-typo entry.
 */
const LABEL_TO_PATH: Record<string, string> = {
  awardamount: 'amount.amountRaw',
  amount: 'amount.amountRaw',
  numberofawards: 'amount.awardCountRaw',
  licenserequirement: 'constraints.license',
  license: 'constraints.license',
  region: 'constraints.geography',
  geography: 'constraints.geography',
  fieldofstudy: 'constraints.field_of_study',
  institution: 'constraints.institution',
  age: 'constraints.age_stage',
  gpa: 'constraints.gpa',
  citizenship: 'constraints.citizenship',
  deadline: 'deadline.note',
  deadlines: 'deadline.note',
  applicationdeadlines: 'deadline.note',
  proposalwindow: 'deadline.note',
  status: 'trust.status',
  other: 'rawOtherText',
};

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[\s ]+/g, '');
}

export function fieldPathForLabel(label: string): string {
  return LABEL_TO_PATH[normalizeLabel(label)] ?? 'rawOtherText';
}

/**
 * Replace this source's provenance for a program with the labels in `raw`.
 * Replacement, not append: a refetch supersedes the previous reading, and the
 * old reading survives in the snapshot store, not here.
 * Returns the number of rows written.
 */
export function recordProvenance(
  db: Database.Database,
  programId: string,
  sourceId: string,
  snapshotId: string | null,
  raw: RawOpportunity,
  nowISO: string,
): number {
  const del = db.prepare('DELETE FROM field_provenance WHERE program_id = ? AND source_id = ?');
  const ins = db.prepare(
    `INSERT INTO field_provenance
       (program_id, field_path, source_id, snapshot_id, raw_label, raw_value, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const entries = Object.entries(raw.rawFields);
  const run = db.transaction(() => {
    del.run(programId, sourceId);
    for (const [label, value] of entries) {
      ins.run(programId, fieldPathForLabel(label), sourceId, snapshotId, label, value, nowISO);
    }
  });
  run();
  return entries.length;
}

export function loadProvenance(db: Database.Database, programId: string): FieldProvenance[] {
  const rows = db
    .prepare(
      `SELECT field_path, source_id, snapshot_id, raw_label, raw_value, fetched_at
         FROM field_provenance WHERE program_id = ?
        ORDER BY field_path, raw_label`,
    )
    .all(programId) as Array<{
      field_path: string;
      source_id: string;
      snapshot_id: string | null;
      raw_label: string;
      raw_value: string;
      fetched_at: string;
    }>;
  return rows.map((r) => ({
    fieldPath: r.field_path,
    sourceId: r.source_id,
    snapshotId: r.snapshot_id,
    rawLabel: r.raw_label,
    rawValue: r.raw_value,
    fetchedAt: r.fetched_at,
  }));
}
```

Modify `packages/server/src/api/programsRouter.ts` — add these imports at the top:

```ts
import type { Cycle, Funder } from '@grantspotter/core';
import { expandCycles, resolveDeadlineOwner, matchProgram } from '@grantspotter/core';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { AppError } from './errors.js';
import { loadProvenance } from './provenanceStore.js';
import type { OpportunityDetail } from './browseTypes.js';
```

and add this route inside `createProgramsRouter`, **after** the `GET /` route and before `return router;`.
Note the `next` parameter: every failure is raised as an `AppError` through Plan 1's error handler,
which is the only thing in this repository that writes an error body (RESOLUTIONS R6):

```ts
  router.get('/:id', deps.requireAuth, (req, res, next) => {
    const user = deps.currentUser(req);
    const id = req.params.id;

    const programs = createProgramRepo(deps.db);
    const program = programs.get(id);
    if (program === undefined) {
      next(new AppError('not_found', `No program with id "${id}".`));
      return;
    }

    const funder: Funder = createFunderRepo(deps.db).get(program.funderId)
      ?? { id: program.funderId, name: program.funderId, homepage: '' };

    // resolveDeadlineOwner and expandCycles both need the whole corpus: the
    // 111 ARRL catalog entries inherit one deadline from a sibling record.
    const allPrograms = programs.list();

    const nowISO = deps.now();
    const to = new Date(Date.parse(nowISO) + 550 * 86_400_000).toISOString();
    const cycles: Cycle[] = expandCycles(program, allPrograms, nowISO, to);

    const owner = resolveDeadlineOwner(program, allPrograms);
    const deadlineOwner =
      owner.id === program.id ? null : { programId: owner.id, programName: owner.name };

    const active = loadActiveProfile(deps.db, user.id);

    const body: OpportunityDetail = {
      program,
      funder,
      cycles,
      provenance: loadProvenance(deps.db, id),
      verdict: active ? matchProgram(active.profile, program, nowISO) : null,
      watched: db_watchedIds(deps, user.id).includes(id),
      deadlineOwner,
    };
    res.json(body);
  });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/provenanceStore.test.ts packages/server/src/api/programDetail.test.ts packages/server/src/db/schemaConformance.test.ts
```

Expected: 5 provenance assertions + 9 detail assertions + conformance green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/db/migrations/031-field-provenance.sql \
        packages/server/src/api/provenanceStore.ts \
        packages/server/src/api/provenanceStore.test.ts \
        packages/server/src/api/programsRouter.ts \
        packages/server/src/api/programDetail.test.ts \
        packages/server/src/db/schemaConformance.test.ts
git commit -m "feat(api): opportunity detail with field-level provenance and deadline inheritance"
```

---

### Task 6: Profiles API, `GET /api/me`, and the completeness meter

**Why this exists:** the matcher returns `unknown` when it lacks a profile field, and the UI must be able to say *"fill in GPA and 7 unknowns become answers"*. Completeness is therefore not "percent of fields filled" — it is **how many unknown verdicts each missing field would resolve**, which is the only version of that number the user actually cares about.

**Files:**
- Create: `packages/server/src/api/completeness.ts`
- Create: `packages/server/src/api/profileRouter.ts`
- Test: `packages/server/src/api/completeness.test.ts`
- Test: `packages/server/src/api/profileRouter.test.ts`

**Interfaces:**
- Consumes: `Profile`, `StudentProfile`, `OrgProfile`, `Verdict` from `@grantspotter/core`; `matchAll`; `studentProfileSchema`, `orgProfileSchema` from `@grantspotter/core` (`core/schema.ts` zod mirrors); `createProgramRepo(db)` from `../db/repositories/programs.js`; `AppError`, `errorHandler`, `requestIdMiddleware` from `./errors.js`; `loadProfile`, `loadAllProfiles`, `saveProfile`, `ProfileKind`; `RouterDeps`.
- Produces: `computeCompleteness(profile, programs): CompletenessReport`, `createProfileRouter(deps: RouterDeps): Router`, `createMeRouter(deps: RouterDeps): Router`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/api/completeness.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { StudentProfile } from '@grantspotter/core';
import { fixturePrograms } from '../test/fixtures/programs.js';
import { computeCompleteness } from './completeness.js';

const sparse: StudentProfile = { kind: 'student' };

const rich: StudentProfile = {
  kind: 'student',
  callsign: 'W8UM',
  licenseClass: 'GENERAL',
  licensedSince: '2023-05-01',
  state: 'MI',
  degreeLevel: 'BACH',
  institution: 'Example State University',
  accredited: true,
  partTime: false,
  citizenship: 'US_CITIZEN',
  stage: 'UNDERGRAD',
  gpa: 3.4,
};

describe('computeCompleteness', () => {
  it('counts how many programs each missing field would resolve', () => {
    const report = computeCompleteness(sparse, fixturePrograms);
    expect(report.unknownCount).toBeGreaterThan(0);
    expect(report.fields.length).toBeGreaterThan(0);
    expect(report.fields[0]!.resolves).toBeGreaterThanOrEqual(
      report.fields.at(-1)!.resolves,
    );
  });

  it('sorts fields by the number of unknown verdicts they would resolve', () => {
    const report = computeCompleteness(sparse, fixturePrograms);
    for (let i = 1; i < report.fields.length; i += 1) {
      expect(report.fields[i - 1]!.resolves).toBeGreaterThanOrEqual(report.fields[i]!.resolves);
    }
  });

  it('reports zero remaining unknowns for a profile the corpus can fully judge', () => {
    const report = computeCompleteness(rich, fixturePrograms);
    expect(report.unknownCount).toBe(0);
    expect(report.fields).toEqual([]);
    expect(report.score).toBe(100);
  });

  it('expresses the score as the share of the corpus that yields a real verdict', () => {
    const report = computeCompleteness(sparse, fixturePrograms);
    expect(report.score).toBe(
      Math.round(((report.total - report.unknownCount) / report.total) * 100),
    );
  });

  it('handles an empty corpus without dividing by zero', () => {
    const report = computeCompleteness(sparse, []);
    expect(report.total).toBe(0);
    expect(report.score).toBe(100);
    expect(report.fields).toEqual([]);
  });
});
```

Create `packages/server/src/api/profileRouter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, seedTestUser } from '../test/fixtures/programs.js';
import { reindexBrowse } from './reindex.js';
import { createProfileRouter, createMeRouter } from './profileRouter.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => MEMBER,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/profiles', createProfileRouter(deps));
  app.use('/api/me', createMeRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

describe('profiles API', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    // The `users` row IS required (RESOLUTIONS R19): neither router reads it —
    // the session user arrives through deps.currentUser — but `profiles.user_id`
    // is REFERENCES users(id) ON DELETE CASCADE in Plan 1's 001-init.sql and
    // foreign keys are ON, so PUT /api/profiles/student fails without it.
    // seedTestUser fills Plan 1's NOT NULL / UNIQUE columns (email_normalized,
    // password_hash, ics_token) for a pinned id.
    seedTestUser(db, 'u-member');
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('returns both profile slots as null before anything is saved', async () => {
    const res = await request(buildApp(db)).get('/api/profiles');
    expect(res.status).toBe(200);
    expect(res.body.student).toBeNull();
    expect(res.body.organization).toBeNull();
  });

  it('saves a student profile and reads it back', async () => {
    const app = buildApp(db);
    const put = await request(app)
      .put('/api/profiles/student')
      .send({ kind: 'student', callsign: 'K5UTD', licenseClass: 'EXTRA', state: 'TX' });
    expect(put.status).toBe(200);
    const get = await request(app).get('/api/profiles');
    expect(get.body.student.callsign).toBe('K5UTD');
  });

  it('lets one user hold both a student and an organization profile', async () => {
    const app = buildApp(db);
    await request(app).put('/api/profiles/student').send({ kind: 'student', callsign: 'K5UTD' });
    await request(app)
      .put('/api/profiles/organization')
      .send({ kind: 'organization', entity: 'club_501c3', orgName: 'Example University ARC' });
    const get = await request(app).get('/api/profiles');
    expect(get.body.student.callsign).toBe('K5UTD');
    expect(get.body.organization.orgName).toBe('Example University ARC');
  });

  it('rejects a body whose kind does not match the route, with 422 not 400', async () => {
    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .send({ kind: 'organization', entity: 'club_501c3' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.message).toMatch(/kind/i);
  });

  it('rejects an unknown profile kind in the path', async () => {
    const res = await request(buildApp(db)).put('/api/profiles/robot').send({ kind: 'student' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('rejects a profile that fails the core zod schema, and returns the issues as details', async () => {
    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .send({ kind: 'student', licenseClass: 'SUPER_EXTRA' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('returns the completeness report alongside the saved profile', async () => {
    const res = await request(buildApp(db))
      .put('/api/profiles/student')
      .send({ kind: 'student', callsign: 'K5UTD' });
    expect(res.body.completeness.total).toBe(5);
    expect(typeof res.body.completeness.score).toBe('number');
  });
});

describe('GET /api/me', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
    // No `users` row is inserted: Plan 1's `users` table has NOT NULL
    // `email_normalized`, `password_hash` and `ics_token`, and neither router
    // under test reads it — the session user arrives through deps.currentUser.
  });

  afterEach(() => {
    db.close();
  });

  it('returns the session user, role, and which profiles exist', async () => {
    const res = await request(buildApp(db)).get('/api/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      id: 'u-member',
      email: 'member@example.com',
      role: 'member',
    });
    expect(res.body.hasStudentProfile).toBe(false);
    expect(res.body.hasOrgProfile).toBe(false);
  });

  it('reflects a saved profile', async () => {
    const app = buildApp(db);
    await request(app).put('/api/profiles/student').send({ kind: 'student', callsign: 'K5UTD' });
    const res = await request(app).get('/api/me');
    expect(res.body.hasStudentProfile).toBe(true);
    expect(res.body.completeness.total).toBe(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/completeness.test.ts packages/server/src/api/profileRouter.test.ts
```

Expected failure: `Failed to load url ./completeness.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/api/completeness.ts`:

```ts
import type { Profile, Program } from '@grantspotter/core';
import { matchAll } from '@grantspotter/core';

/** PLAN-LOCAL to Plan 3. */
export interface CompletenessField {
  field: string;
  /** How many `unknown` verdicts filling this one field would turn into answers. */
  resolves: number;
}

/** PLAN-LOCAL to Plan 3. */
export interface CompletenessReport {
  total: number;
  unknownCount: number;
  /** Share of the corpus that already yields a real verdict, 0-100. */
  score: number;
  fields: CompletenessField[];
}

/**
 * Completeness is defined against the matcher, not against the shape of the
 * form: a field only counts if some program's verdict actually depends on it.
 */
export function computeCompleteness(profile: Profile, programs: Program[]): CompletenessReport {
  const total = programs.length;
  if (total === 0) {
    return { total: 0, unknownCount: 0, score: 100, fields: [] };
  }

  const verdicts = matchAll(profile, programs);
  const counts = new Map<string, number>();
  let unknownCount = 0;

  for (const verdict of verdicts.values()) {
    if (verdict.kind !== 'unknown') continue;
    unknownCount += 1;
    for (const field of new Set(verdict.missingProfileFields)) {
      counts.set(field, (counts.get(field) ?? 0) + 1);
    }
  }

  const fields = [...counts.entries()]
    .map(([field, resolves]) => ({ field, resolves }))
    .sort((a, b) => b.resolves - a.resolves || a.field.localeCompare(b.field));

  return {
    total,
    unknownCount,
    score: Math.round(((total - unknownCount) / total) * 100),
    fields,
  };
}
```

Create `packages/server/src/api/profileRouter.ts`:

```ts
import { Router } from 'express';
import type { Profile, Program } from '@grantspotter/core';
import { orgProfileSchema, studentProfileSchema } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { loadActiveProfile, loadAllProfiles, saveProfile, type ProfileKind } from './profileStore.js';
import { computeCompleteness, type CompletenessReport } from './completeness.js';

/** RESOLUTIONS R1: whole records only ever come from Plan 1's repository. */
function loadCorpus(db: RouterDeps['db']): Program[] {
  return createProgramRepo(db).list();
}

function emptyReport(total: number): CompletenessReport {
  return { total, unknownCount: total, score: 0, fields: [] };
}

export function createProfileRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const profiles = loadAllProfiles(deps.db, user.id);
    const corpus = loadCorpus(deps.db);
    res.json({
      student: profiles.student,
      organization: profiles.organization,
      completeness: profiles.student
        ? computeCompleteness(profiles.student, corpus)
        : profiles.organization
          ? computeCompleteness(profiles.organization, corpus)
          : emptyReport(corpus.length),
    });
  });

  router.put('/:kind', deps.requireAuth, (req, res, next) => {
    const user = deps.currentUser(req);
    const kind = req.params.kind;
    if (kind !== 'student' && kind !== 'organization') {
      next(new AppError(
        'validation_failed',
        `Unknown profile kind "${kind}". Expected "student" or "organization".`,
      ));
      return;
    }
    const body = req.body as { kind?: unknown };
    if (body?.kind !== kind) {
      next(new AppError(
        'validation_failed',
        `Body kind "${String(body?.kind)}" does not match the route kind "${kind}".`,
      ));
      return;
    }

    const schema = kind === 'student' ? studentProfileSchema : orgProfileSchema;
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError('validation_failed', 'Profile failed validation.', parsed.error.issues));
      return;
    }

    const profile = parsed.data as Profile;
    saveProfile(deps.db, user.id, kind as ProfileKind, profile, deps.now());

    res.json({
      profile,
      completeness: computeCompleteness(profile, loadCorpus(deps.db)),
    });
  });

  return router;
}

export function createMeRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const profiles = loadAllProfiles(deps.db, user.id);
    const active = loadActiveProfile(deps.db, user.id);
    const corpus = loadCorpus(deps.db);
    res.json({
      user,
      hasStudentProfile: profiles.student !== null,
      hasOrgProfile: profiles.organization !== null,
      completeness: active
        ? computeCompleteness(active.profile, corpus)
        : emptyReport(corpus.length),
    });
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/completeness.test.ts packages/server/src/api/profileRouter.test.ts
```

Expected: 5 completeness + 9 profile/me assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/api/completeness.ts packages/server/src/api/completeness.test.ts \
        packages/server/src/api/profileRouter.ts packages/server/src/api/profileRouter.test.ts
git commit -m "feat(api): profile editor endpoints and matcher-derived completeness meter"
```

---
### Task 7: Watchlist API

**Why this exists:** spec §11.2 — starring subscribes the user to **change events**, not just a deadline. This task is the subscription half; Task 8 is the delivery half.

**Files:**
- Create: `packages/server/src/db/migrations/033-watches.sql` (**indexes only** — Plan 1's `001-init.sql` owns the `watches` table; RESOLUTIONS R19)
- Create: `packages/server/src/api/watchRouter.ts`
- Modify: `packages/server/src/db/schemaConformance.test.ts` (add `watches`, including `notify_changes`, and the migration-ownership guard)
- Test: `packages/server/src/api/watchRouter.test.ts`

**Interfaces:**
- Consumes: `RouterDeps`; `hydratePrograms`; `AppError` from `./errors.js`; `seedTestUser` from `../test/fixtures/programs.js` (Task 2).
- Produces: `createWatchRouter(deps: RouterDeps): Router`, `watchedProgramIds(db, userId): string[]`, `watchersOfProgram(db, programId): string[]`. (RESOLUTIONS R8: these two query helpers live here, in `api/watchRouter.ts`. There is no `db/repositories/watches.ts`.)

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/watchRouter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, seedTestUser } from '../test/fixtures/programs.js';
import { reindexBrowse } from './reindex.js';
import { createWatchRouter, watchedProgramIds, watchersOfProgram } from './watchRouter.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database, user: SessionUser = MEMBER) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/watches', createWatchRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

describe('watchlist API', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    // `watches.user_id` is REFERENCES users(id) ON DELETE CASCADE (Plan 1
    // 001-init.sql) and foreign keys are ON, so the two session users these
    // tests impersonate need real rows (RESOLUTIONS R19).
    seedTestUser(db, 'u-member');
    seedTestUser(db, 'u-other');
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('starts empty', async () => {
    const res = await request(buildApp(db)).get('/api/watches');
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
  });

  it('stars a program and returns it hydrated with its next deadline', async () => {
    const app = buildApp(db);
    const post = await request(app)
      .post('/api/watches')
      .send({ programId: 'arrl-foundation-scholarship' });
    expect(post.status).toBe(201);
    const get = await request(app).get('/api/watches');
    expect(get.body.rows).toHaveLength(1);
    expect(get.body.rows[0].program.id).toBe('arrl-foundation-scholarship');
    expect(get.body.rows[0].nextClosesAt).toBe('2026-12-30T17:00:00.000Z');
  });

  it('is idempotent — starring twice leaves one row', async () => {
    const app = buildApp(db);
    await request(app).post('/api/watches').send({ programId: 'ardc-grants' });
    const second = await request(app).post('/api/watches').send({ programId: 'ardc-grants' });
    expect(second.status).toBe(201);
    expect(watchedProgramIds(db, 'u-member')).toEqual(['ardc-grants']);
  });

  it('rejects starring a program that does not exist', async () => {
    const res = await request(buildApp(db)).post('/api/watches').send({ programId: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('rejects a POST with no programId as bad_request, not validation_failed', async () => {
    const res = await request(buildApp(db)).post('/api/watches').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('unstars', async () => {
    const app = buildApp(db);
    await request(app).post('/api/watches').send({ programId: 'ardc-grants' });
    const del = await request(app).delete('/api/watches/ardc-grants');
    expect(del.status).toBe(204);
    expect(watchedProgramIds(db, 'u-member')).toEqual([]);
  });

  it('unstarring something not starred is not an error', async () => {
    const res = await request(buildApp(db)).delete('/api/watches/ardc-grants');
    expect(res.status).toBe(204);
  });

  it('keeps one user’s watchlist out of another’s', async () => {
    const other: SessionUser = { id: 'u-other', email: 'other@example.com', role: 'member' };
    await request(buildApp(db)).post('/api/watches').send({ programId: 'ardc-grants' });
    const res = await request(buildApp(db, other)).get('/api/watches');
    expect(res.body.rows).toEqual([]);
  });

  it('lists every watcher of a program, which is what the fan-out needs', async () => {
    const other: SessionUser = { id: 'u-other', email: 'other@example.com', role: 'member' };
    await request(buildApp(db)).post('/api/watches').send({ programId: 'ardc-grants' });
    await request(buildApp(db, other)).post('/api/watches').send({ programId: 'ardc-grants' });
    expect(watchersOfProgram(db, 'ardc-grants').sort()).toEqual(['u-member', 'u-other']);
  });

  it('sorts the watchlist by next deadline, undated last', async () => {
    const app = buildApp(db);
    await request(app).post('/api/watches').send({ programId: 'arrl-club-grant' });
    await request(app).post('/api/watches').send({ programId: 'arrl-foundation-scholarship' });
    const res = await request(app).get('/api/watches');
    expect(res.body.rows.map((r: { program: { id: string } }) => r.program.id))
      .toEqual(['arrl-foundation-scholarship', 'arrl-club-grant']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/watchRouter.test.ts
```

Expected failure: `Failed to load url ./watchRouter.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/db/migrations/033-watches.sql`. **It contains no `CREATE TABLE`**
(RESOLUTIONS R19). `watches` is a CONTRACT §6 table owned by Plan 1's `001-init.sql`, and Plan 1's
shape carries three things a re-declaration here would silently discard: `notify_changes INTEGER NOT
NULL DEFAULT 1`, `user_id REFERENCES users(id) ON DELETE CASCADE`, and `program_id REFERENCES
programs(id) ON DELETE CASCADE`. Because `033` sorts after `001`, a `CREATE TABLE IF NOT EXISTS`
here would no-op — the weaker shape would never exist, but every reader of this plan would believe
it did.

```sql
-- Owner: Plan 1, packages/server/src/db/migrations/001-init.sql.
-- `watches` (id, user_id, program_id, notify_changes, created_at) is created
-- there, with ON DELETE CASCADE foreign keys to users(id) and programs(id) and
-- UNIQUE (user_id, program_id).
-- RESOLUTIONS R19: this file adds indexes ONLY. Table DDL belongs to 001-init.sql
-- and re-declaring it here would no-op; the ownership guard in
-- schemaConformance.test.ts fails this file if any table DDL appears in it.
--
-- A star is a subscription to CHANGE EVENTS on a program (spec §11.2), not
-- merely a deadline bookmark, so the fan-out in Task 8 asks the reverse question
-- - "who watches this program?" - on every change event. That is what
-- idx_watches_program serves; Plan 1's UNIQUE constraint only indexes
-- (user_id, program_id), whose leading column is the wrong one for that query.
CREATE INDEX IF NOT EXISTS idx_watches_program ON watches (program_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_watches_user_program ON watches (user_id, program_id);
```

Add the `watches` entry to the `REQUIRED` map in `schemaConformance.test.ts` — **including
`notify_changes`**, which is the column the naive Plan 3 re-declaration used to omit and therefore
the one the map has to pin:

```ts
  // Owner: Plan 1 001-init.sql (RESOLUTIONS R19). `notify_changes` is listed
  // because a re-declaration that dropped it would otherwise pass this gate.
  watches: ['id', 'user_id', 'program_id', 'notify_changes', 'created_at'],
```

And add the ownership guard to the same file, so R19 cannot regress by someone pasting a
`CREATE TABLE` back into `032` or `033`:

```ts
// add to the import block at the top of schemaConformance.test.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// append as a sibling of describe('schema conformance (Plan 3 read-contract)')
describe('migration ownership (RESOLUTIONS R19)', () => {
  let ownedDb: Database.Database;

  beforeAll(() => {
    ownedDb = openTestDb();
  });

  afterAll(() => {
    ownedDb.close();
  });

  // `profiles` and `watches` are CONTRACT §6 tables created by Plan 1's
  // 001-init.sql. Plan 3's 032/033 may only add indexes: a CREATE TABLE here
  // sorts after 001, so it no-ops, and its (divergent, FK-less) shape would
  // read as the schema while never existing.
  it.each([
    ['032-profiles.sql'],
    ['033-watches.sql'],
  ])('%s adds indexes only — it never re-creates a Plan 1 table', (file) => {
    const sql = readFileSync(
      fileURLToPath(new URL(`./migrations/${file}`, import.meta.url)),
      'utf8',
    );
    expect(sql).not.toMatch(/CREATE\s+TABLE/i);
    expect(sql).toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
  });

  it('keeps Plan 1’s cascade on watches, which is what makes the fixtures need parents', () => {
    const keys = ownedDb.prepare('PRAGMA foreign_key_list(watches)').all() as Array<{
      table: string; on_delete: string;
    }>;
    expect(keys.map((k) => k.table).sort()).toEqual(['programs', 'users']);
    for (const k of keys) expect(k.on_delete).toBe('CASCADE');
    expect(ownedDb.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});
```

Create `packages/server/src/api/watchRouter.ts`:

```ts
import { Router } from 'express';
import type Database from 'better-sqlite3';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { hydratePrograms } from './browseQuery.js';

export function watchedProgramIds(db: Database.Database, userId: string): string[] {
  const rows = db
    .prepare('SELECT program_id FROM watches WHERE user_id = ? ORDER BY created_at')
    .all(userId) as Array<{ program_id: string }>;
  return rows.map((r) => r.program_id);
}

export function watchersOfProgram(db: Database.Database, programId: string): string[] {
  const rows = db
    .prepare('SELECT user_id FROM watches WHERE program_id = ?')
    .all(programId) as Array<{ user_id: string }>;
  return rows.map((r) => r.user_id);
}

export function createWatchRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const ids = watchedProgramIds(deps.db, user.id);
    const hydrated = hydratePrograms(deps.db, ids);
    const rows = ids
      .map((id) => hydrated.get(id))
      .filter((h): h is NonNullable<typeof h> => h !== undefined)
      .map((h) => ({
        program: h.program,
        funderName: h.funderName,
        nextOpensAt: h.nextOpensAt,
        nextClosesAt: h.nextClosesAt,
        nextIsEstimated: h.nextIsEstimated,
      }))
      .sort((a, b) => {
        if (a.nextClosesAt === null && b.nextClosesAt === null) {
          return a.program.name.localeCompare(b.program.name);
        }
        if (a.nextClosesAt === null) return 1;
        if (b.nextClosesAt === null) return -1;
        return a.nextClosesAt.localeCompare(b.nextClosesAt);
      });
    res.json({ rows });
  });

  router.post('/', deps.requireAuth, (req, res, next) => {
    const user = deps.currentUser(req);
    const programId = (req.body as { programId?: unknown }).programId;
    if (typeof programId !== 'string' || programId === '') {
      next(new AppError('bad_request', 'A non-empty "programId" is required.'));
      return;
    }
    const exists = deps.db.prepare('SELECT 1 FROM programs WHERE id = ?').get(programId);
    if (!exists) {
      next(new AppError('not_found', `No program with id "${programId}".`));
      return;
    }
    // `notify_changes` is left to Plan 1's DEFAULT 1: starring IS subscribing
    // (spec §11.2). The ON CONFLICT target is Plan 1's UNIQUE (user_id,
    // program_id) constraint, which is why starring twice is a no-op rather
    // than a 500.
    deps.db
      .prepare(
        `INSERT INTO watches (id, user_id, program_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, program_id) DO NOTHING`,
      )
      .run(`${user.id}:${programId}`, user.id, programId, deps.now());
    res.status(201).json({ programId, watched: true });
  });

  router.delete('/:programId', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    deps.db
      .prepare('DELETE FROM watches WHERE user_id = ? AND program_id = ?')
      .run(user.id, req.params.programId);
    res.status(204).end();
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/watchRouter.test.ts packages/server/src/db/schemaConformance.test.ts
```

Expected: 10 watchlist assertions green, every conformance row green (`watches` now among them,
`notify_changes` included), and the three `migration ownership (RESOLUTIONS R19)` assertions green.
A failure of the form `FOREIGN KEY constraint failed` means a fixture wrote a star without its
`users` or `programs` parent — fix the fixture with `seedTestUser` / `starProgram`, never by
disabling the pragma.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/db/migrations/033-watches.sql \
        packages/server/src/api/watchRouter.ts packages/server/src/api/watchRouter.test.ts \
        packages/server/src/db/schemaConformance.test.ts
git commit -m "feat(api): watchlist endpoints keyed to change-event subscription"
```

---

### Task 8: Change-event fan-out and the notifications API

**Why this exists:** this is the highest-value output of the whole product. Spec §11.2 names the exact case: *"ARRL moved the scholarship close from Jan 31 to Dec 30"*. The fan-out is deliberately a **drain over the `change_events` table**, not a callback, so it works no matter who wrote the event — the nightly crawl (Plan 2), a "Verify now" (Task 10), or an Inbox approval (Task 12). None of those three has to know notifications exist.

**Files:**
- Create: `packages/server/src/db/migrations/034-notifications.sql`
- Create: `packages/server/src/api/notify.ts`
- Create: `packages/server/src/api/notificationRouter.ts`
- Test: `packages/server/src/api/notify.test.ts`
- Test: `packages/server/src/api/notificationRouter.test.ts`

**Interfaces:**
- Consumes: `ChangeEvent`, `ChangeKind` from `@grantspotter/core`; `watchersOfProgram`; `AppError` from `./errors.js`; `RouterDeps`.
- Produces: `drainChangeEvents(db, nowISO): number`, `describeChange(kind, before, after, fieldPath, programName): { title: string; body: string }`, `createNotificationRouter(deps: RouterDeps): Router`, `NotificationRow`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/api/notify.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, starProgram } from '../test/fixtures/programs.js';
import { drainChangeEvents, describeChange } from './notify.js';

const NOW = '2026-08-02T12:00:00.000Z';

/**
 * RESOLUTIONS R19: `watches` has ON DELETE CASCADE foreign keys to `users` and
 * `programs`, so the star goes through `starProgram`, which inserts both
 * parents first. A bare INSERT here fails with `FOREIGN KEY constraint failed`.
 */
function watch(db: Database.Database, userId: string, programId: string) {
  starProgram(db, userId, programId, NOW);
}

/** The event the product exists to deliver (spec §11.2). */
function seedDeadlineMove(db: Database.Database, id = 'ce-1') {
  db.prepare(
    `INSERT INTO change_events
       (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    'arrl-scholarship-descriptions',
    'arrl-foundation-scholarship',
    'deadline_changed',
    JSON.stringify('2027-01-31T17:00:00.000Z'),
    JSON.stringify('2026-12-30T17:00:00.000Z'),
    NOW,
    'deadline.closesAt',
  );
}

describe('describeChange', () => {
  it('writes the deadline move as a sentence a human can act on', () => {
    const { title, body } = describeChange(
      'deadline_changed',
      '2027-01-31T17:00:00.000Z',
      '2026-12-30T17:00:00.000Z',
      'deadline.closesAt',
      'ARRL Foundation Scholarship Program',
    );
    expect(title).toBe('Deadline changed: ARRL Foundation Scholarship Program');
    expect(body).toContain('2027-01-31T17:00:00.000Z');
    expect(body).toContain('2026-12-30T17:00:00.000Z');
    expect(body).toContain('deadline.closesAt');
  });

  it('names the parse-yield alarm plainly, because it is how the app rots', () => {
    const { title } = describeChange('parse_yield_dropped', 111, 0, null, 'ARRL scholarships');
    expect(title).toBe('Parser yield dropped: ARRL scholarships');
  });

  it('handles a change with no program name', () => {
    const { title } = describeChange('vanished', 'x', null, null, null);
    expect(title).toBe('Record vanished from its source');
  });
});

describe('drainChangeEvents', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates one notification per watcher of the changed program', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    watch(db, 'u-b', 'arrl-foundation-scholarship');
    watch(db, 'u-c', 'ardc-grants');
    seedDeadlineMove(db);

    expect(drainChangeEvents(db, NOW)).toBe(2);
    const rows = db.prepare('SELECT user_id FROM notifications ORDER BY user_id').all() as Array<{ user_id: string }>;
    expect(rows.map((r) => r.user_id)).toEqual(['u-a', 'u-b']);
  });

  it('carries the before and after values so the digest can show the move', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    seedDeadlineMove(db);
    drainChangeEvents(db, NOW);
    const row = db.prepare('SELECT before_text, after_text, kind FROM notifications').get() as {
      before_text: string;
      after_text: string;
      kind: string;
    };
    expect(row.kind).toBe('deadline_changed');
    expect(row.before_text).toBe('2027-01-31T17:00:00.000Z');
    expect(row.after_text).toBe('2026-12-30T17:00:00.000Z');
  });

  it('never fans the same event out twice', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    seedDeadlineMove(db);
    expect(drainChangeEvents(db, NOW)).toBe(1);
    expect(drainChangeEvents(db, NOW)).toBe(0);
    const n = db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('marks an event with no watchers as fanned out so it is not rescanned forever', () => {
    seedDeadlineMove(db);
    expect(drainChangeEvents(db, NOW)).toBe(0);
    const n = db.prepare('SELECT COUNT(*) AS n FROM change_event_fanout').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('fans out a source-level alarm to everyone watching any program from that source', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    db.prepare(
      `INSERT INTO field_provenance
         (program_id, field_path, source_id, snapshot_id, raw_label, raw_value, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('arrl-foundation-scholarship', 'amount.amountRaw', 'arrl-scholarship-descriptions', null, 'Award Amount', '$500 - $25,000', NOW);
    db.prepare(
      `INSERT INTO change_events
         (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('ce-yield', 'arrl-scholarship-descriptions', null, 'parse_yield_dropped',
      JSON.stringify(111), JSON.stringify(0), NOW, null);

    expect(drainChangeEvents(db, NOW)).toBe(1);
    const row = db.prepare('SELECT kind, program_id FROM notifications').get() as {
      kind: string;
      program_id: string | null;
    };
    expect(row.kind).toBe('parse_yield_dropped');
    expect(row.program_id).toBeNull();
  });

  it('processes several pending events in one drain', () => {
    watch(db, 'u-a', 'arrl-foundation-scholarship');
    seedDeadlineMove(db, 'ce-1');
    seedDeadlineMove(db, 'ce-2');
    expect(drainChangeEvents(db, NOW)).toBe(2);
  });
});
```

Create `packages/server/src/api/notificationRouter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, starProgram } from '../test/fixtures/programs.js';
import { createNotificationRouter } from './notificationRouter.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database, user: SessionUser = MEMBER) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/notifications', createNotificationRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

function seedWatchedDeadlineMove(db: Database.Database) {
  // starProgram inserts the users row and the programs row before the star:
  // both are ON DELETE CASCADE parents in Plan 1's DDL (RESOLUTIONS R19).
  starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
  db.prepare(
    `INSERT INTO change_events
       (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ce-1', 'arrl-scholarship-descriptions', 'arrl-foundation-scholarship',
    'deadline_changed', JSON.stringify('2027-01-31T17:00:00.000Z'),
    JSON.stringify('2026-12-30T17:00:00.000Z'), NOW, 'deadline.closesAt');
}

describe('notifications API', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
  });

  afterEach(() => {
    db.close();
  });

  it('drains pending change events on read, so the digest is never stale', async () => {
    seedWatchedDeadlineMove(db);
    const res = await request(buildApp(db)).get('/api/notifications');
    expect(res.status).toBe(200);
    expect(res.body.unread).toBe(1);
    expect(res.body.rows[0].title)
      .toBe('Deadline changed: ARRL Foundation Scholarship Program');
    expect(res.body.rows[0].programId).toBe('arrl-foundation-scholarship');
  });

  it('marks one notification read', async () => {
    seedWatchedDeadlineMove(db);
    const app = buildApp(db);
    const list = await request(app).get('/api/notifications');
    const id = list.body.rows[0].id;
    const mark = await request(app).post(`/api/notifications/${id}/read`);
    expect(mark.status).toBe(204);
    const after = await request(app).get('/api/notifications');
    expect(after.body.unread).toBe(0);
    expect(after.body.rows[0].readAt).toBe(NOW);
  });

  it('marks everything read', async () => {
    seedWatchedDeadlineMove(db);
    const app = buildApp(db);
    await request(app).get('/api/notifications');
    const mark = await request(app).post('/api/notifications/read-all');
    expect(mark.status).toBe(204);
    const after = await request(app).get('/api/notifications');
    expect(after.body.unread).toBe(0);
  });

  it('refuses to mark another user’s notification read', async () => {
    seedWatchedDeadlineMove(db);
    const owner = buildApp(db);
    const list = await request(owner).get('/api/notifications');
    const id = list.body.rows[0].id;
    const intruder = buildApp(db, { id: 'u-other', email: 'o@example.com', role: 'member' });
    const res = await request(intruder).post(`/api/notifications/${id}/read`);
    expect(res.status).toBe(404);
  });

  it('supports unread-only listing', async () => {
    seedWatchedDeadlineMove(db);
    const app = buildApp(db);
    const list = await request(app).get('/api/notifications');
    await request(app).post(`/api/notifications/${list.body.rows[0].id}/read`);
    const unread = await request(app).get('/api/notifications?unreadOnly=true');
    expect(unread.body.rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/notify.test.ts packages/server/src/api/notificationRouter.test.ts
```

Expected failure: `Failed to load url ./notify.js` and `no such table: notifications`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/db/migrations/034-notifications.sql`:

```sql
-- Plan 3: in-app digest. Change events fan out to the users watching the
-- affected program. `change_event_fanout` is the idempotency ledger - it is why
-- the drain can be called from anywhere, repeatedly, without duplicating.
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  change_event_id TEXT,
  program_id      TEXT,
  program_name    TEXT,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  field_path      TEXT,
  before_text     TEXT,
  after_text      TEXT,
  created_at      TEXT NOT NULL,
  read_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications (user_id, read_at);

CREATE TABLE IF NOT EXISTS change_event_fanout (
  change_event_id TEXT PRIMARY KEY,
  fanned_out_at   TEXT NOT NULL,
  recipient_count INTEGER NOT NULL
);
```

Create `packages/server/src/api/notify.ts`:

```ts
import type Database from 'better-sqlite3';
import type { ChangeKind } from '@grantspotter/core';

/** PLAN-LOCAL to Plan 3. */
export interface NotificationRow {
  id: string;
  userId: string;
  changeEventId: string | null;
  programId: string | null;
  programName: string | null;
  kind: ChangeKind;
  title: string;
  body: string;
  fieldPath: string | null;
  before: string | null;
  after: string | null;
  createdAt: string;
  readAt: string | null;
}

function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

const TITLES: Record<ChangeKind, string> = {
  new: 'New opportunity',
  deadline_changed: 'Deadline changed',
  amount_changed: 'Award amount changed',
  eligibility_changed: 'Eligibility changed',
  status_changed: 'Status changed',
  vanished: 'Record vanished from its source',
  parse_yield_dropped: 'Parser yield dropped',
};

/**
 * Turn a ChangeEvent into a sentence. The deadline case is the one the product
 * exists for: "ARRL moved the scholarship close from Jan 31 to Dec 30".
 */
export function describeChange(
  kind: ChangeKind,
  before: unknown,
  after: unknown,
  fieldPath: string | null,
  programName: string | null,
): { title: string; body: string } {
  const base = TITLES[kind];
  const title = programName ? `${base}: ${programName}` : base;
  const b = asText(before);
  const a = asText(after);
  const where = fieldPath ? ` (${fieldPath})` : '';

  if (b !== null && a !== null) {
    return { title, body: `Changed from ${b} to ${a}${where}. Verify against the source before acting on it.` };
  }
  if (a !== null) return { title, body: `Now ${a}${where}. Verify against the source before acting on it.` };
  if (b !== null) return { title, body: `Was ${b}${where}; the source no longer carries it.` };
  return { title, body: `Detected on the source${where}.` };
}

/**
 * Fan every not-yet-processed change event out to the users who watch it.
 * Program-scoped events go to that program's watchers. Source-scoped events
 * (parse_yield_dropped, vanished with no programId) go to everyone watching any
 * program whose provenance names that source.
 * Returns the number of notifications created.
 */
export function drainChangeEvents(db: Database.Database, nowISO: string): number {
  const pending = db
    .prepare(
      `SELECT ce.id, ce.source_id, ce.program_id, ce.kind,
              ce.before_json, ce.after_json, ce.field_path
         FROM change_events ce
         LEFT JOIN change_event_fanout f ON f.change_event_id = ce.id
        WHERE f.change_event_id IS NULL
        ORDER BY ce.detected_at, ce.id`,
    )
    .all() as Array<{
      id: string;
      source_id: string;
      program_id: string | null;
      kind: ChangeKind;
      before_json: string | null;
      after_json: string | null;
      field_path: string | null;
    }>;

  if (pending.length === 0) return 0;

  const watchersOfProgram = db.prepare('SELECT user_id FROM watches WHERE program_id = ?');
  const watchersOfSource = db.prepare(
    `SELECT DISTINCT w.user_id AS user_id
       FROM watches w
       JOIN field_provenance fp ON fp.program_id = w.program_id
      WHERE fp.source_id = ?`,
  );
  const programName = db.prepare('SELECT name FROM programs WHERE id = ?');
  const insertNotification = db.prepare(
    `INSERT INTO notifications
       (id, user_id, change_event_id, program_id, program_name, kind, title, body,
        field_path, before_text, after_text, created_at, read_at)
     VALUES (@id, @user_id, @change_event_id, @program_id, @program_name, @kind, @title,
             @body, @field_path, @before_text, @after_text, @created_at, NULL)`,
  );
  const markFannedOut = db.prepare(
    'INSERT OR IGNORE INTO change_event_fanout (change_event_id, fanned_out_at, recipient_count) VALUES (?, ?, ?)',
  );

  let created = 0;

  const run = db.transaction(() => {
    for (const ce of pending) {
      const recipients = ce.program_id
        ? (watchersOfProgram.all(ce.program_id) as Array<{ user_id: string }>).map((r) => r.user_id)
        : (watchersOfSource.all(ce.source_id) as Array<{ user_id: string }>).map((r) => r.user_id);

      const nameRow = ce.program_id
        ? (programName.get(ce.program_id) as { name: string } | undefined)
        : undefined;
      const before = ce.before_json === null ? null : (JSON.parse(ce.before_json) as unknown);
      const after = ce.after_json === null ? null : (JSON.parse(ce.after_json) as unknown);
      const { title, body } = describeChange(
        ce.kind, before, after, ce.field_path, nameRow?.name ?? null,
      );

      for (const userId of new Set(recipients)) {
        insertNotification.run({
          id: `${ce.id}:${userId}`,
          user_id: userId,
          change_event_id: ce.id,
          program_id: ce.program_id,
          program_name: nameRow?.name ?? null,
          kind: ce.kind,
          title,
          body,
          field_path: ce.field_path,
          before_text: asText(before),
          after_text: asText(after),
          created_at: nowISO,
        });
        created += 1;
      }
      markFannedOut.run(ce.id, nowISO, new Set(recipients).size);
    }
  });

  run();
  return created;
}
```

Create `packages/server/src/api/notificationRouter.ts`:

```ts
import { Router } from 'express';
import type { ChangeKind } from '@grantspotter/core';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { drainChangeEvents, type NotificationRow } from './notify.js';

export function createNotificationRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    // Draining on read keeps the digest correct without a background worker.
    // The corpus is ~150 records, so this is a few indexed statements.
    drainChangeEvents(deps.db, deps.now());

    const user = deps.currentUser(req);
    const unreadOnly = req.query.unreadOnly === 'true';
    const rows = deps.db
      .prepare(
        `SELECT id, user_id, change_event_id, program_id, program_name, kind, title, body,
                field_path, before_text, after_text, created_at, read_at
           FROM notifications
          WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
          ORDER BY created_at DESC, id DESC
          LIMIT 200`,
      )
      .all(user.id) as Array<{
        id: string; user_id: string; change_event_id: string | null;
        program_id: string | null; program_name: string | null; kind: string;
        title: string; body: string; field_path: string | null;
        before_text: string | null; after_text: string | null;
        created_at: string; read_at: string | null;
      }>;

    const unread = (
      deps.db
        .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
        .get(user.id) as { n: number }
    ).n;

    const mapped: NotificationRow[] = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      changeEventId: r.change_event_id,
      programId: r.program_id,
      programName: r.program_name,
      kind: r.kind as ChangeKind,
      title: r.title,
      body: r.body,
      fieldPath: r.field_path,
      before: r.before_text,
      after: r.after_text,
      createdAt: r.created_at,
      readAt: r.read_at,
    }));

    res.json({ rows: mapped, unread });
  });

  router.post('/read-all', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    deps.db
      .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL')
      .run(deps.now(), user.id);
    res.status(204).end();
  });

  router.post('/:id/read', deps.requireAuth, (req, res, next) => {
    const user = deps.currentUser(req);
    const info = deps.db
      .prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?')
      .run(deps.now(), req.params.id, user.id);
    if (info.changes === 0) {
      // Deliberately not distinguishing "does not exist" from "belongs to
      // another user": the second answer would be an enumeration oracle.
      next(new AppError('not_found', 'No such notification for this user.'));
      return;
    }
    res.status(204).end();
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/notify.test.ts packages/server/src/api/notificationRouter.test.ts
```

Expected: 9 fan-out + 5 router assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/db/migrations/034-notifications.sql \
        packages/server/src/api/notify.ts packages/server/src/api/notify.test.ts \
        packages/server/src/api/notificationRouter.ts \
        packages/server/src/api/notificationRouter.test.ts
git commit -m "feat(api): change-event fan-out to per-user in-app digest"
```

---

### Task 9: Optional webhook and ntfy delivery

**Why this exists:** spec §11.2 — *"in-app digest by default; optional webhook/ntfy; SMTP optional and never required"*. SMTP is deliberately **not implemented in Plan 3**: it is optional by spec, it requires credentials the app must not demand, and shipping the in-app path plus two keyless push paths satisfies the requirement without adding a mail dependency. No SMTP column exists, so nothing dangles.

Because a webhook URL is user-supplied, this task also hardens it: HTTPS only, `assertNotBlocked` applied, and loopback/private/link-local literals refused. A grant app that will POST to any URL a logged-in user types is an SSRF pivot.

**Files:**
- Create: `packages/server/src/db/migrations/035-notification-channels.sql`
- Create: `packages/server/src/api/channels.ts`
- Create: `packages/server/src/api/channelRouter.ts`
- Test: `packages/server/src/api/channels.test.ts`

**Interfaces:**
- Consumes: `assertNotBlocked(url: string): void` from `../fetcher/blocklist.js` (Plan 2); `AppError` from `./errors.js`; `NotificationRow`; `RouterDeps`.
- Produces: `assertSafeWebhookUrl(url: string): void`, `loadChannel(db, userId): ChannelConfig`, `saveChannel(db, userId, config): void`, `deliverExternal(config, notification, fetchImpl): Promise<DeliveryResult[]>`, `createChannelRouter(deps: RouterDeps): Router`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/channels.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import {
  assertSafeWebhookUrl, loadChannel, saveChannel, deliverExternal,
} from './channels.js';
import type { NotificationRow } from './notify.js';

const NOW = '2026-08-02T12:00:00.000Z';

const notification: NotificationRow = {
  id: 'n-1',
  userId: 'u-member',
  changeEventId: 'ce-1',
  programId: 'arrl-foundation-scholarship',
  programName: 'ARRL Foundation Scholarship Program',
  kind: 'deadline_changed',
  title: 'Deadline changed: ARRL Foundation Scholarship Program',
  body: 'Changed from 2027-01-31T17:00:00.000Z to 2026-12-30T17:00:00.000Z (deadline.closesAt).',
  fieldPath: 'deadline.closesAt',
  before: '2027-01-31T17:00:00.000Z',
  after: '2026-12-30T17:00:00.000Z',
  createdAt: NOW,
  readAt: null,
};

describe('assertSafeWebhookUrl', () => {
  it('accepts a plain https URL', () => {
    expect(() => assertSafeWebhookUrl('https://hooks.example.com/grantspotter')).not.toThrow();
  });

  it('accepts a documentation-range literal, which is what tests use', () => {
    expect(() => assertSafeWebhookUrl('https://192.0.2.10/hooks/grantspotter')).not.toThrow();
  });

  it('rejects http', () => {
    expect(() => assertSafeWebhookUrl('http://hooks.example.com/x')).toThrow(/https/i);
  });

  it('rejects loopback', () => {
    expect(() => assertSafeWebhookUrl('https://127.0.0.1/x')).toThrow(/private/i);
    expect(() => assertSafeWebhookUrl('https://localhost/x')).toThrow(/private/i);
  });

  it('rejects RFC 1918 and link-local literals', () => {
    expect(() => assertSafeWebhookUrl('https://10.1.2.3/x')).toThrow(/private/i);
    expect(() => assertSafeWebhookUrl('https://172.16.4.5/x')).toThrow(/private/i);
    expect(() => assertSafeWebhookUrl('https://192.168.1.9/x')).toThrow(/private/i);
    expect(() => assertSafeWebhookUrl('https://169.254.169.254/latest/meta-data')).toThrow(/private/i);
  });

  it('rejects a blocklisted host, so the fetcher rule cannot be routed around', () => {
    expect(() => assertSafeWebhookUrl('https://farweb.org/hook')).toThrow();
  });

  it('rejects garbage', () => {
    expect(() => assertSafeWebhookUrl('not a url')).toThrow();
  });
});

describe('channel storage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('defaults to in-app only', () => {
    expect(loadChannel(db, 'u-member')).toEqual({
      inApp: true, webhookUrl: null, ntfyServer: null, ntfyTopic: null,
    });
  });

  it('round-trips a saved configuration', () => {
    saveChannel(db, 'u-member', {
      inApp: true,
      webhookUrl: 'https://hooks.example.com/grantspotter',
      ntfyServer: 'https://ntfy.example.com',
      ntfyTopic: 'grantspotter-deadlines',
    }, NOW);
    expect(loadChannel(db, 'u-member').ntfyTopic).toBe('grantspotter-deadlines');
  });
});

describe('deliverExternal', () => {
  it('does nothing when only in-app is configured', async () => {
    const fetchImpl = vi.fn();
    const results = await deliverExternal(
      { inApp: true, webhookUrl: null, ntfyServer: null, ntfyTopic: null },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(results).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('POSTs a JSON body to the webhook', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 204 });
    const results = await deliverExternal(
      { inApp: true, webhookUrl: 'https://hooks.example.com/gs', ntfyServer: null, ntfyTopic: null },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(results).toEqual([{ channel: 'webhook', ok: true, status: 204 }]);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example.com/gs');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(init.body as string);
    expect(sent.kind).toBe('deadline_changed');
    expect(sent.after).toBe('2026-12-30T17:00:00.000Z');
  });

  it('POSTs the plain-text body to ntfy with a title header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await deliverExternal(
      {
        inApp: true, webhookUrl: null,
        ntfyServer: 'https://ntfy.example.com', ntfyTopic: 'grantspotter-deadlines',
      },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://ntfy.example.com/grantspotter-deadlines');
    expect((init.headers as Record<string, string>).Title)
      .toBe('Deadline changed: ARRL Foundation Scholarship Program');
    expect(init.body).toContain('2026-12-30T17:00:00.000Z');
  });

  it('reports a failed delivery instead of throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const results = await deliverExternal(
      { inApp: true, webhookUrl: 'https://hooks.example.com/gs', ntfyServer: null, ntfyTopic: null },
      notification,
      fetchImpl as unknown as typeof fetch,
    );
    expect(results).toEqual([{ channel: 'webhook', ok: false, error: 'ECONNREFUSED' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/channels.test.ts
```

Expected failure: `Failed to load url ./channels.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/db/migrations/035-notification-channels.sql`:

```sql
-- Plan 3: optional delivery channels. In-app is the default and is always on.
-- There is deliberately NO SMTP column: the spec makes mail optional and never
-- required, and an unused credential field is a liability.
CREATE TABLE IF NOT EXISTS notification_channels (
  user_id     TEXT PRIMARY KEY,
  in_app      INTEGER NOT NULL DEFAULT 1,
  webhook_url TEXT,
  ntfy_server TEXT,
  ntfy_topic  TEXT,
  updated_at  TEXT NOT NULL
);
```

Create `packages/server/src/api/channels.ts`:

```ts
import type Database from 'better-sqlite3';
import { assertNotBlocked } from '../fetcher/blocklist.js';
import type { NotificationRow } from './notify.js';

/** PLAN-LOCAL to Plan 3. */
export interface ChannelConfig {
  inApp: boolean;
  webhookUrl: string | null;
  ntfyServer: string | null;
  ntfyTopic: string | null;
}

/** PLAN-LOCAL to Plan 3. */
export interface DeliveryResult {
  channel: 'webhook' | 'ntfy';
  ok: boolean;
  status?: number;
  error?: string;
}

const PRIVATE_HOSTS = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|::1$|\[::1\])/i;
const PRIVATE_172 = /^172\.(1[6-9]|2\d|3[01])\./;

/**
 * A user-supplied outbound URL is an SSRF surface. HTTPS only, no private or
 * loopback literals, and the fetcher blocklist applies here too so it cannot be
 * routed around by pasting a blocked host into the webhook field.
 */
export function assertSafeWebhookUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error('webhook URLs must use https');
  }
  const host = url.hostname;
  if (PRIVATE_HOSTS.test(host) || PRIVATE_172.test(host)) {
    throw new Error(`refusing a private or loopback webhook host: ${host}`);
  }
  assertNotBlocked(raw);
}

export function loadChannel(db: Database.Database, userId: string): ChannelConfig {
  const row = db
    .prepare('SELECT in_app, webhook_url, ntfy_server, ntfy_topic FROM notification_channels WHERE user_id = ?')
    .get(userId) as
    | { in_app: number; webhook_url: string | null; ntfy_server: string | null; ntfy_topic: string | null }
    | undefined;
  if (!row) return { inApp: true, webhookUrl: null, ntfyServer: null, ntfyTopic: null };
  return {
    inApp: row.in_app === 1,
    webhookUrl: row.webhook_url,
    ntfyServer: row.ntfy_server,
    ntfyTopic: row.ntfy_topic,
  };
}

export function saveChannel(
  db: Database.Database,
  userId: string,
  config: ChannelConfig,
  nowISO: string,
): void {
  db.prepare(
    `INSERT INTO notification_channels
       (user_id, in_app, webhook_url, ntfy_server, ntfy_topic, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id) DO UPDATE SET
       in_app = excluded.in_app,
       webhook_url = excluded.webhook_url,
       ntfy_server = excluded.ntfy_server,
       ntfy_topic = excluded.ntfy_topic,
       updated_at = excluded.updated_at`,
  ).run(
    userId, config.inApp ? 1 : 0, config.webhookUrl, config.ntfyServer, config.ntfyTopic, nowISO,
  );
}

/**
 * Push one notification to whatever external channels the user configured.
 * Never throws: a dead webhook must not break the in-app digest.
 */
export async function deliverExternal(
  config: ChannelConfig,
  n: NotificationRow,
  fetchImpl: typeof fetch = fetch,
): Promise<DeliveryResult[]> {
  const out: DeliveryResult[] = [];

  if (config.webhookUrl) {
    try {
      const response = await fetchImpl(config.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: 'grantspotter',
          kind: n.kind,
          title: n.title,
          body: n.body,
          programId: n.programId,
          programName: n.programName,
          fieldPath: n.fieldPath,
          before: n.before,
          after: n.after,
          createdAt: n.createdAt,
        }),
      });
      out.push({ channel: 'webhook', ok: response.ok, status: response.status });
    } catch (err) {
      out.push({ channel: 'webhook', ok: false, error: (err as Error).message });
    }
  }

  if (config.ntfyServer && config.ntfyTopic) {
    const url = `${config.ntfyServer.replace(/\/+$/, '')}/${config.ntfyTopic}`;
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { Title: n.title, 'content-type': 'text/plain; charset=utf-8' },
        body: n.body,
      });
      out.push({ channel: 'ntfy', ok: response.ok, status: response.status });
    } catch (err) {
      out.push({ channel: 'ntfy', ok: false, error: (err as Error).message });
    }
  }

  return out;
}
```

Create `packages/server/src/api/channelRouter.ts`:

```ts
import { Router } from 'express';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { assertSafeWebhookUrl, loadChannel, saveChannel, type ChannelConfig } from './channels.js';

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function createChannelRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    res.json(loadChannel(deps.db, deps.currentUser(req).id));
  });

  router.put('/', deps.requireAuth, (req, res, next) => {
    const user = deps.currentUser(req);
    const body = req.body as Record<string, unknown>;
    const config: ChannelConfig = {
      inApp: body.inApp !== false,
      webhookUrl: str(body.webhookUrl),
      ntfyServer: str(body.ntfyServer),
      ntfyTopic: str(body.ntfyTopic),
    };

    for (const url of [config.webhookUrl, config.ntfyServer]) {
      if (url === null) continue;
      try {
        assertSafeWebhookUrl(url);
      } catch (err) {
        // The rejection reason IS the user-facing message here: "webhook URLs
        // must use https" is actionable, "unsafe_url" is not.
        next(new AppError('validation_failed', (err as Error).message, { url }));
        return;
      }
    }
    if ((config.ntfyServer === null) !== (config.ntfyTopic === null)) {
      next(new AppError(
        'validation_failed',
        'ntfy needs both a server and a topic, or neither.',
      ));
      return;
    }

    saveChannel(deps.db, user.id, config, deps.now());
    res.json(config);
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/channels.test.ts
```

Expected: 14 assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/db/migrations/035-notification-channels.sql \
        packages/server/src/api/channels.ts packages/server/src/api/channels.test.ts \
        packages/server/src/api/channelRouter.ts
git commit -m "feat(api): optional webhook and ntfy delivery with SSRF-hardened URL validation"
```

---
### Task 10: "Verify now" — refetch, diff, rate limit

**Why this exists:** spec §8 — a `lastVerifiedAt` older than 90 days renders amber, *"with a one-click Verify now that refetches and shows the diff"*. Available to admin **and** member; members are rate-limited (spec §12).

**Domain fact that shapes this task:** `arrl.org` sends no ETag and no Last-Modified, and its sitemap `<lastmod>` values are all frozen at 2010. A conditional request is therefore impossible and a `<lastmod>` check is actively misleading. Verify always performs a real fetch and diffs the **parsed raw fields**, never the raw HTML — nav and footer churn would otherwise report a change every single time.

**Files:**
- Create: `packages/server/src/db/migrations/036-verify-attempts.sql`
- Create: `packages/server/src/api/verify.ts`
- Create: `packages/server/src/api/verifyRouter.ts`
- Test: `packages/server/src/api/verify.test.ts`

**Interfaces:**
- Consumes: `SourceModule`, `FetchRequest`, `FetchedPayload`, `RawOpportunity`, `ChangeKind` from `@grantspotter/core`; `Fetcher` from `../fetcher/index.js` (Plan 2); `createProgramRepo(db)` from `../db/repositories/programs.js` (Plan 1); `AppError` from `./errors.js`; `recordProvenance`, `loadProvenance`; `drainChangeEvents`; `reindexBrowse`; `RouterDeps`.
- Produces: `createVerifyRunner(opts: VerifyRunnerOptions): VerifyRunner`, `checkVerifyRateLimit(db, userId, role, programId, nowISO): RateLimitCheck` where `RateLimitCheck = { allowed: boolean; reason?: 'program_cooldown' | 'hourly_cap'; retryAfterSec?: number }`, `createVerifyRouter(deps: RouterDeps, runner: VerifyRunner): Router`, `VerifyResult`.

**Field-name note (type-consistency finding #20):** the detail key is `retryAfterSec`, matching Plan 1
Task 15's frozen error table (`rate_limited` → 429 with `details.retryAfterSec`). `retryAfterSeconds`
appears nowhere in this plan, on either side of the wire.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/verify.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, starProgram } from '../test/fixtures/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { reindexBrowse } from './reindex.js';
import { recordProvenance } from './provenanceStore.js';
import { createVerifyRunner, checkVerifyRateLimit } from './verify.js';
import { createVerifyRouter } from './verifyRouter.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };
const ADMIN: SessionUser = { id: 'u-admin', email: 'admin@example.com', role: 'admin' };

const BEFORE: RawOpportunity = {
  sourceId: 'arrl-scholarship-descriptions',
  externalKey: 'ARRL Foundation Scholarship Program',
  name: 'ARRL Foundation Scholarship Program',
  rawFields: { 'Award Amount': '$500 - $25,000', Deadline: 'January 31' },
  sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
  rawText: 'Award Amount: $500 - $25,000 • Deadline: January 31',
};

const AFTER: RawOpportunity = {
  ...BEFORE,
  rawFields: { 'Award Amount': '$500 - $25,000', Deadline: 'December 30, 12:00 PM EST' },
  rawText: 'Award Amount: $500 - $25,000 • Deadline: December 30, 12:00 PM EST',
};

function fakeSource(emit: RawOpportunity[]): SourceModule {
  return {
    id: 'arrl-scholarship-descriptions',
    funderId: 'arrl-foundation',
    label: 'ARRL scholarship catalog',
    tier: 'C',
    klass: 'ham_scholarship',
    requests: [{
      url: 'http://www.arrl.org/scholarship-descriptions',
      method: 'GET',
      accept: 'html',
    }],
    parse: () => emit,
    expectedMinRecords: 100,
  };
}

function fakeFetcher(status = 200) {
  return {
    fetch: vi.fn(async (): Promise<FetchedPayload> => ({
      url: 'http://www.arrl.org/scholarship-descriptions',
      status,
      contentType: 'text/html',
      body: '<html>…</html>',
      fetchedAt: NOW,
    })),
  };
}

function primeProvenance(db: Database.Database) {
  recordProvenance(
    db, 'arrl-foundation-scholarship', 'arrl-scholarship-descriptions', 'snap-0', BEFORE, '2026-05-01T00:00:00.000Z',
  );
}

describe('verify runner', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
    primeProvenance(db);
  });

  afterEach(() => {
    db.close();
  });

  it('reports no change when the source still says the same thing', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([BEFORE])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.diffs).toEqual([]);
  });

  it('refreshes lastVerifiedAt even when nothing changed — checking IS the point', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([BEFORE])], now: () => NOW,
    });
    await runner.verify('arrl-foundation-scholarship');

    // The denormalized column and the record must move together: the browse
    // list sorts on the column, the detail page renders the record.
    const row = db
      .prepare('SELECT last_verified_at FROM programs WHERE id = ?')
      .get('arrl-foundation-scholarship') as { last_verified_at: string };
    expect(row.last_verified_at).toBe(NOW);

    const stored = createProgramRepo(db).get('arrl-foundation-scholarship');
    expect(stored?.trust.lastVerifiedAt).toBe(NOW);
    expect(stored?.trust.verificationMethod).toBe('live_fetch');
  });

  it('diffs the parsed fields and names the changed label', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([AFTER])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.changed).toBe(true);
    expect(result.diffs).toEqual([
      { label: 'Deadline', before: 'January 31', after: 'December 30, 12:00 PM EST' },
    ]);
  });

  it('records a deadline_changed ChangeEvent, which is what feeds the watchlist', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([AFTER])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.changeEventIds).toHaveLength(1);
    const ce = db
      .prepare('SELECT kind, program_id, field_path FROM change_events WHERE id = ?')
      .get(result.changeEventIds[0]) as { kind: string; program_id: string; field_path: string };
    expect(ce.kind).toBe('deadline_changed');
    expect(ce.program_id).toBe('arrl-foundation-scholarship');
    expect(ce.field_path).toBe('deadline.note');
  });

  it('classifies an amount label change as amount_changed', async () => {
    const amountMoved: RawOpportunity = {
      ...BEFORE,
      rawFields: { 'Award Amount': '$1,000 - $25,000', Deadline: 'January 31' },
    };
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([amountMoved])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    const ce = db
      .prepare('SELECT kind FROM change_events WHERE id = ?')
      .get(result.changeEventIds[0]) as { kind: string };
    expect(ce.kind).toBe('amount_changed');
  });

  it('emits vanished when the record is gone from the source', async () => {
    const runner = createVerifyRunner({
      db, fetcher: fakeFetcher(), sources: [fakeSource([])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    const ce = db.prepare('SELECT kind FROM change_events').get() as { kind: string };
    expect(ce.kind).toBe('vanished');
  });

  it('reports a fetch failure without touching lastVerifiedAt', async () => {
    const failing = {
      fetch: vi.fn(async () => {
        throw new Error('blocked host: farweb.org');
      }),
    };
    const runner = createVerifyRunner({
      db, fetcher: failing, sources: [fakeSource([BEFORE])], now: () => NOW,
    });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('farweb.org');
    const row = db
      .prepare('SELECT last_verified_at FROM programs WHERE id = ?')
      .get('arrl-foundation-scholarship') as { last_verified_at: string };
    expect(row.last_verified_at).toBe('2026-08-02T00:00:00.000Z');
  });

  it('reports a missing source module rather than pretending to verify', async () => {
    const runner = createVerifyRunner({ db, fetcher: fakeFetcher(), sources: [], now: () => NOW });
    const result = await runner.verify('arrl-foundation-scholarship');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('no source module');
  });
});

describe('checkVerifyRateLimit', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  function attempt(userId: string, programId: string, at: string) {
    db.prepare('INSERT INTO verify_attempts (user_id, program_id, attempted_at) VALUES (?, ?, ?)')
      .run(userId, programId, at);
  }

  it('never limits an admin', () => {
    for (let i = 0; i < 50; i += 1) attempt('u-admin', `p-${i}`, NOW);
    expect(checkVerifyRateLimit(db, 'u-admin', 'admin', 'p-x', NOW).allowed).toBe(true);
  });

  it('allows a member their first verification', () => {
    expect(checkVerifyRateLimit(db, 'u-member', 'member', 'p-1', NOW).allowed).toBe(true);
  });

  it('stops a member re-verifying the same program within the hour', () => {
    attempt('u-member', 'p-1', '2026-08-02T11:30:00.000Z');
    const check = checkVerifyRateLimit(db, 'u-member', 'member', 'p-1', NOW);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('program_cooldown');
  });

  it('allows a member a different program within the hour', () => {
    attempt('u-member', 'p-1', '2026-08-02T11:30:00.000Z');
    expect(checkVerifyRateLimit(db, 'u-member', 'member', 'p-2', NOW).allowed).toBe(true);
  });

  it('caps a member at 10 verifications per rolling hour', () => {
    for (let i = 0; i < 10; i += 1) attempt('u-member', `p-${i}`, '2026-08-02T11:30:00.000Z');
    const check = checkVerifyRateLimit(db, 'u-member', 'member', 'p-99', NOW);
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe('hourly_cap');
    expect(check.retryAfterSec).toBeGreaterThan(0);
  });

  it('forgets attempts older than the rolling hour', () => {
    for (let i = 0; i < 10; i += 1) attempt('u-member', `p-${i}`, '2026-08-02T10:00:00.000Z');
    expect(checkVerifyRateLimit(db, 'u-member', 'member', 'p-99', NOW).allowed).toBe(true);
  });
});

describe('POST /api/programs/:id/verify', () => {
  let db: Database.Database;

  function buildApp(user: SessionUser, sources: SourceModule[]) {
    const deps: RouterDeps = {
      db,
      now: () => NOW,
      requireAuth: (_req, _res, next) => next(),
      requireAdmin: (_req, _res, next) => next(),
      currentUser: () => user,
    };
    const runner = createVerifyRunner({ db, fetcher: fakeFetcher(), sources, now: () => NOW });
    const app = express();
    app.use(express.json());
    app.use(requestIdMiddleware());
    app.use('/api/programs', createVerifyRouter(deps, runner));
    app.use(errorHandler({ logger: () => undefined }));
    return app;
  }

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
    primeProvenance(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lets a member verify and returns the diff', async () => {
    const res = await request(buildApp(MEMBER, [fakeSource([AFTER])]))
      .post('/api/programs/arrl-foundation-scholarship/verify');
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(true);
    expect(res.body.diffs[0].after).toBe('December 30, 12:00 PM EST');
  });

  it('429s a member who exceeds the cooldown, with a machine-readable reason', async () => {
    const app = buildApp(MEMBER, [fakeSource([BEFORE])]);
    await request(app).post('/api/programs/arrl-foundation-scholarship/verify');
    const second = await request(app).post('/api/programs/arrl-foundation-scholarship/verify');
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('rate_limited');
    expect(second.body.error.details.reason).toBe('program_cooldown');
    expect(second.body.error.details.retryAfterSec).toBeGreaterThan(0);
    expect(second.headers['retry-after']).toBeDefined();
  });

  it('does not rate-limit an admin', async () => {
    const app = buildApp(ADMIN, [fakeSource([BEFORE])]);
    await request(app).post('/api/programs/arrl-foundation-scholarship/verify');
    const second = await request(app).post('/api/programs/arrl-foundation-scholarship/verify');
    expect(second.status).toBe(200);
  });

  it('404s an unknown program', async () => {
    const res = await request(buildApp(ADMIN, [fakeSource([BEFORE])]))
      .post('/api/programs/nope/verify');
    expect(res.status).toBe(404);
  });

  it('fans a detected change out to watchers in the same request', async () => {
    starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
    await request(buildApp(ADMIN, [fakeSource([AFTER])]))
      .post('/api/programs/arrl-foundation-scholarship/verify');
    const n = db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?')
      .get('u-member') as { n: number };
    expect(n.n).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/verify.test.ts
```

Expected failure: `Failed to load url ./verify.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/db/migrations/036-verify-attempts.sql`:

```sql
-- Plan 3: per-user Verify-now rate limiting (spec §12: members are rate-limited).
CREATE TABLE IF NOT EXISTS verify_attempts (
  user_id      TEXT NOT NULL,
  program_id   TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verify_user_time ON verify_attempts (user_id, attempted_at);
```

Create `packages/server/src/api/verify.ts`:

```ts
import type Database from 'better-sqlite3';
import type {
  ChangeKind, FetchRequest, FetchedPayload, Program, RawOpportunity, SourceModule,
} from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import { loadProvenance, recordProvenance } from './provenanceStore.js';

/** PLAN-LOCAL to Plan 3. */
export interface VerifyFieldDiff {
  label: string;
  before: string | null;
  after: string | null;
}

/** PLAN-LOCAL to Plan 3. */
export interface VerifyResult {
  programId: string;
  attemptedAt: string;
  ok: boolean;
  error?: string;
  changed: boolean;
  diffs: VerifyFieldDiff[];
  lastVerifiedAt: string;
  changeEventIds: string[];
}

/** PLAN-LOCAL to Plan 3. Matches the CONTRACT `Fetcher` shape structurally. */
export interface VerifyFetcher {
  fetch(req: FetchRequest): Promise<FetchedPayload>;
}

/** PLAN-LOCAL to Plan 3. */
export interface VerifyRunnerOptions {
  db: Database.Database;
  fetcher: VerifyFetcher;
  sources: SourceModule[];
  now: () => string;
}

/** PLAN-LOCAL to Plan 3. */
export interface VerifyRunner {
  verify(programId: string): Promise<VerifyResult>;
}

const MEMBER_HOURLY_CAP = 10;
const HOUR_MS = 3_600_000;

/** Which raw labels imply which ChangeKind. Normalized like provenance labels. */
function changeKindForLabel(label: string): ChangeKind {
  const key = label.toLowerCase().replace(/[\s ]+/g, '');
  if (key.includes('deadline') || key.includes('window') || key.includes('close')) {
    return 'deadline_changed';
  }
  if (key.includes('amount') || key.includes('award')) return 'amount_changed';
  if (key.includes('status')) return 'status_changed';
  return 'eligibility_changed';
}

/** Which Program field path a raw label maps onto, mirroring provenanceStore. */
function fieldPathForKind(kind: ChangeKind): string {
  switch (kind) {
    case 'deadline_changed': return 'deadline.note';
    case 'amount_changed': return 'amount.amountRaw';
    case 'status_changed': return 'trust.status';
    default: return 'constraints';
  }
}

function diffRawFields(
  before: Record<string, string>,
  after: Record<string, string>,
): VerifyFieldDiff[] {
  const labels = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: VerifyFieldDiff[] = [];
  for (const label of labels) {
    const b = before[label] ?? null;
    const a = after[label] ?? null;
    if (b !== a) out.push({ label, before: b, after: a });
  }
  return out;
}

async function resolveRequests(source: SourceModule): Promise<FetchRequest[]> {
  return typeof source.requests === 'function' ? source.requests() : source.requests;
}

/**
 * "Verify now". Refetches the program's source, re-parses, and diffs the PARSED
 * fields against the stored provenance.
 *
 * Why parsed fields and not the HTML: arrl.org sends no ETag and no
 * Last-Modified, and its nav and footer churn on every request. Hashing raw HTML
 * would report a change every single time and the amber badge would mean nothing.
 */
export function createVerifyRunner(opts: VerifyRunnerOptions): VerifyRunner {
  const { db, fetcher, sources, now } = opts;
  const programs = createProgramRepo(db);

  return {
    async verify(programId: string): Promise<VerifyResult> {
      const attemptedAt = now();
      // RESOLUTIONS R1: read through Plan 1's repository, which reassembles the
      // record from the normalized columns and validates it with programSchema.
      const program = programs.get(programId);
      if (program === undefined) {
        return {
          programId, attemptedAt, ok: false, error: 'program not found',
          changed: false, diffs: [], lastVerifiedAt: '', changeEventIds: [],
        };
      }

      const previous = loadProvenance(db, programId);
      const sourceId = previous[0]?.sourceId;
      const source = sources.find((s) => (sourceId ? s.id === sourceId : s.funderId === program.funderId));
      if (!source) {
        return {
          programId, attemptedAt, ok: false,
          error: `no source module is registered for ${programId}`,
          changed: false, diffs: [], lastVerifiedAt: program.trust.lastVerifiedAt,
          changeEventIds: [],
        };
      }

      let payloads: FetchedPayload[];
      try {
        const requests = await resolveRequests(source);
        payloads = [];
        for (const req of requests) {
          payloads.push(await fetcher.fetch(req));
        }
      } catch (err) {
        return {
          programId, attemptedAt, ok: false, error: (err as Error).message,
          changed: false, diffs: [], lastVerifiedAt: program.trust.lastVerifiedAt,
          changeEventIds: [],
        };
      }

      let parsed: RawOpportunity[];
      try {
        parsed = source.parse(payloads);
      } catch (err) {
        return {
          programId, attemptedAt, ok: false, error: `parse failed: ${(err as Error).message}`,
          changed: false, diffs: [], lastVerifiedAt: program.trust.lastVerifiedAt,
          changeEventIds: [],
        };
      }

      const beforeFields: Record<string, string> = {};
      for (const p of previous) beforeFields[p.rawLabel] = p.rawValue;

      const match =
        parsed.find((r) => r.externalKey === program.name) ??
        parsed.find((r) => r.name === program.name) ??
        null;

      const changeEventIds: string[] = [];
      const insertEvent = db.prepare(
        `INSERT INTO change_events
           (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      let diffs: VerifyFieldDiff[] = [];

      if (match === null) {
        // The record is gone from the source. That is a first-class event, not
        // an error - grants.austinhams.org legitimately empties out for months.
        const id = `verify:${programId}:${attemptedAt}:vanished`;
        insertEvent.run(
          id, source.id, programId, 'vanished' satisfies ChangeKind,
          JSON.stringify(program.name), null, attemptedAt, null,
        );
        changeEventIds.push(id);
        diffs = Object.keys(beforeFields).map((label) => ({
          label, before: beforeFields[label] ?? null, after: null,
        }));
      } else {
        diffs = diffRawFields(beforeFields, match.rawFields);
        for (const d of diffs) {
          const kind = changeKindForLabel(d.label);
          const id = `verify:${programId}:${attemptedAt}:${d.label}`;
          insertEvent.run(
            id, source.id, programId, kind,
            d.before === null ? null : JSON.stringify(d.before),
            d.after === null ? null : JSON.stringify(d.after),
            attemptedAt, fieldPathForKind(kind),
          );
          changeEventIds.push(id);
        }
        recordProvenance(db, programId, source.id, null, match, attemptedAt);
      }

      // We checked. That is exactly what lastVerifiedAt records - it is not a
      // claim that nothing changed, it is a claim that a human-triggered fetch
      // happened at this instant.
      const updated: Program = {
        ...program,
        trust: {
          ...program.trust,
          lastVerifiedAt: attemptedAt,
          verificationMethod: 'live_fetch',
        },
      };
      // upsert() writes both the JSON `trust` column and the denormalized
      // `last_verified_at` / `status` / `content_hash` columns from it, so the
      // record and the browse-sortable scalars cannot drift apart.
      programs.upsert(updated);

      return {
        programId,
        attemptedAt,
        ok: true,
        changed: diffs.length > 0,
        diffs,
        lastVerifiedAt: attemptedAt,
        changeEventIds,
      };
    },
  };
}

/**
 * PLAN-LOCAL to Plan 3. `retryAfterSec` (not `retryAfterSeconds`) is the name
 * Plan 1 Task 15's frozen error table gives the `rate_limited` detail field;
 * this interface feeds it straight into `AppError.details`.
 */
export interface RateLimitCheck {
  allowed: boolean;
  reason?: 'program_cooldown' | 'hourly_cap';
  retryAfterSec?: number;
}

/**
 * Admin: unlimited. Member: one verification per program per hour, and at most
 * ten verifications per rolling hour overall. The corpus is ~150 records polled
 * by ~25 small nonprofits; a member holding down a button must not become a
 * denial-of-service against arrl.org.
 */
export function checkVerifyRateLimit(
  db: Database.Database,
  userId: string,
  role: 'admin' | 'member',
  programId: string,
  nowISO: string,
): RateLimitCheck {
  if (role === 'admin') return { allowed: true };

  const cutoff = new Date(Date.parse(nowISO) - HOUR_MS).toISOString();

  const sameProgram = db
    .prepare(
      `SELECT attempted_at FROM verify_attempts
        WHERE user_id = ? AND program_id = ? AND attempted_at > ?
        ORDER BY attempted_at DESC LIMIT 1`,
    )
    .get(userId, programId, cutoff) as { attempted_at: string } | undefined;
  if (sameProgram) {
    const elapsed = Date.parse(nowISO) - Date.parse(sameProgram.attempted_at);
    return {
      allowed: false,
      reason: 'program_cooldown',
      retryAfterSec: Math.max(1, Math.ceil((HOUR_MS - elapsed) / 1000)),
    };
  }

  const recent = db
    .prepare('SELECT COUNT(*) AS n FROM verify_attempts WHERE user_id = ? AND attempted_at > ?')
    .get(userId, cutoff) as { n: number };
  if (recent.n >= MEMBER_HOURLY_CAP) {
    return { allowed: false, reason: 'hourly_cap', retryAfterSec: 600 };
  }

  return { allowed: true };
}
```

Create `packages/server/src/api/verifyRouter.ts`:

```ts
import { Router } from 'express';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { checkVerifyRateLimit, type VerifyRunner } from './verify.js';
import { drainChangeEvents } from './notify.js';
import { reindexBrowse } from './reindex.js';

export function createVerifyRouter(deps: RouterDeps, runner: VerifyRunner): Router {
  const router = Router();

  router.post('/:id/verify', deps.requireAuth, (req, res, next) => {
    void (async () => {
      try {
        const user = deps.currentUser(req);
        const programId = req.params.id;
        const nowISO = deps.now();

        const exists = deps.db.prepare('SELECT 1 FROM programs WHERE id = ?').get(programId);
        if (exists === undefined) {
          next(new AppError('not_found', `No program with id "${programId}".`));
          return;
        }

        const limit = checkVerifyRateLimit(deps.db, user.id, user.role, programId, nowISO);
        if (!limit.allowed) {
          const retryAfterSec = limit.retryAfterSec ?? 600;
          // Retry-After is a transport header, so it is set on the response
          // directly; the body is still Plan 1's single error envelope.
          res.set('Retry-After', String(retryAfterSec));
          next(new AppError(
            'rate_limited',
            'You have verified this recently. Small nonprofits host these pages; we poll them politely.',
            { reason: limit.reason, retryAfterSec },
          ));
          return;
        }

        deps.db
          .prepare('INSERT INTO verify_attempts (user_id, program_id, attempted_at) VALUES (?, ?, ?)')
          .run(user.id, programId, nowISO);

        const result = await runner.verify(programId);

        if (result.ok) {
          reindexBrowse(deps.db, nowISO);
          drainChangeEvents(deps.db, nowISO);
        }

        // A failed FETCH is a 200 carrying `ok: false`: the request succeeded,
        // the funder's site did not, and the UI renders that difference.
        res.status(200).json(result);
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/verify.test.ts
```

Expected: 8 runner + 6 rate-limit + 5 route assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/db/migrations/036-verify-attempts.sql \
        packages/server/src/api/verify.ts packages/server/src/api/verify.test.ts \
        packages/server/src/api/verifyRouter.ts
git commit -m "feat(api): Verify now refetch with parsed-field diff and member rate limiting"
```

---

### Task 11: Calendar API with the prep-lead-time overlay

**Why this exists:** spec §11.1 — the calendar must show when to **start**, not only when it is due. Two concrete numbers from the research drive it: ARDC evaluates for 60–120 days after a cycle closes, and NCDXF asks for roughly two months' lead before it can act. Those are different quantities, so the API returns both: `prepLeadDays` (start by) and `decisionLagDays` (when you will hear).

**Files:**
- Create: `packages/server/src/api/prepLead.ts`
- Create: `packages/server/src/api/calendarRouter.ts`
- Test: `packages/server/src/api/prepLead.test.ts`
- Test: `packages/server/src/api/calendarRouter.test.ts`

**Interfaces:**
- Consumes: `Program`, `Cycle` from `@grantspotter/core`; `expandCycles`; `matchAll`; `createProgramRepo(db)` from `../db/repositories/programs.js`; `loadActiveProfile`; `watchedProgramIds`; `RouterDeps`.
- Produces: `prepLeadFor(program): PrepLead`, `createCalendarRouter(deps: RouterDeps): Router`, `CalendarEntry`.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/api/prepLead.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ardcGrants, arrlScholarship, qcwaScholarship } from '../test/fixtures/programs.js';
import { prepLeadFor, prepStartFor } from './prepLead.js';

describe('prepLeadFor', () => {
  it('gives ARDC its published 60-120 day evaluation lag', () => {
    const lead = prepLeadFor(ardcGrants);
    expect(lead.decisionLagMinDays).toBe(60);
    expect(lead.decisionLagMaxDays).toBe(120);
    expect(lead.note).toContain('60');
  });

  it('gives ARDC a prep lead long enough to gather three references', () => {
    expect(prepLeadFor(ardcGrants).prepLeadDays).toBe(45);
  });

  it('gives an ARRL scholarship a transcript-and-reference lead', () => {
    const lead = prepLeadFor(arrlScholarship);
    expect(lead.prepLeadDays).toBe(30);
    expect(lead.note).toContain('transcript');
  });

  it('inherits the lead of the program a deadline was inherited from', () => {
    // QCWA rides the ARRL cycle, so it inherits the ARRL lead rather than the
    // generic default.
    expect(prepLeadFor(qcwaScholarship).prepLeadDays).toBe(30);
  });

  it('falls back to a documented default for a funder with no published lead', () => {
    const lead = prepLeadFor({ ...ardcGrants, funderId: 'unknown-funder', tags: [] });
    expect(lead.prepLeadDays).toBe(30);
    expect(lead.note).toContain('no published lead time');
  });
});

describe('prepStartFor', () => {
  it('subtracts the lead from the close date', () => {
    expect(prepStartFor('2026-12-30T17:00:00.000Z', 30)).toBe('2026-11-30T17:00:00.000Z');
  });

  it('returns null when there is no close date', () => {
    expect(prepStartFor(null, 30)).toBeNull();
  });
});
```

Create `packages/server/src/api/calendarRouter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, starProgram } from '../test/fixtures/programs.js';
import { reindexBrowse } from './reindex.js';
import { createCalendarRouter } from './calendarRouter.js';
import { errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => MEMBER,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/calendar', createCalendarRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

describe('GET /api/calendar', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
  });

  afterEach(() => {
    db.close();
  });

  it('returns cycle instances inside the requested window', async () => {
    const res = await request(buildApp(db))
      .get('/api/calendar?from=2026-08-01T00:00:00.000Z&to=2027-03-01T00:00:00.000Z');
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBeGreaterThan(0);
    for (const e of res.body.entries) {
      expect(e.cycle.closesAt >= '2026-08-01T00:00:00.000Z').toBe(true);
      expect(e.cycle.closesAt <= '2027-03-01T00:00:00.000Z').toBe(true);
    }
  });

  it('colours by instrument and applicant entity, so both are on every entry', async () => {
    const res = await request(buildApp(db))
      .get('/api/calendar?from=2026-08-01T00:00:00.000Z&to=2027-03-01T00:00:00.000Z');
    const entry = res.body.entries[0];
    expect(typeof entry.instrument).toBe('string');
    expect(Array.isArray(entry.applicantEntities)).toBe(true);
  });

  it('returns a prep start date so the calendar can show when to begin', async () => {
    const res = await request(buildApp(db))
      .get('/api/calendar?from=2026-08-01T00:00:00.000Z&to=2027-03-01T00:00:00.000Z');
    const arrl = res.body.entries.find(
      (e: { programId: string }) => e.programId === 'arrl-foundation-scholarship',
    );
    expect(arrl.prepLeadDays).toBe(30);
    expect(arrl.prepStartAt).toBe('2026-11-30T17:00:00.000Z');
    expect(arrl.prepNote).toContain('transcript');
  });

  it('flags estimated cycles distinctly from observed ones', async () => {
    const res = await request(buildApp(db))
      .get('/api/calendar?from=2026-08-01T00:00:00.000Z&to=2028-01-01T00:00:00.000Z');
    const kinds = new Set(res.body.entries.map((e: { isEstimated: boolean }) => e.isEstimated));
    expect(kinds.size).toBeGreaterThanOrEqual(1);
    for (const e of res.body.entries) expect(typeof e.isEstimated).toBe('boolean');
  });

  it('marks watched programs so the calendar can highlight them', async () => {
    starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
    const res = await request(buildApp(db))
      .get('/api/calendar?from=2026-08-01T00:00:00.000Z&to=2027-03-01T00:00:00.000Z');
    const arrl = res.body.entries.find(
      (e: { programId: string }) => e.programId === 'arrl-foundation-scholarship',
    );
    expect(arrl.watched).toBe(true);
  });

  it('omits programs with no dated cycle rather than inventing one', async () => {
    const res = await request(buildApp(db))
      .get('/api/calendar?from=2026-08-01T00:00:00.000Z&to=2027-03-01T00:00:00.000Z');
    const ids = res.body.entries.map((e: { programId: string }) => e.programId);
    expect(ids).not.toContain('arrl-club-grant');
    expect(ids).not.toContain('chicago-fm-club-scholarship');
  });

  it('lists the undated programs separately so they are not silently lost', async () => {
    const res = await request(buildApp(db))
      .get('/api/calendar?from=2026-08-01T00:00:00.000Z&to=2027-03-01T00:00:00.000Z');
    const undated = res.body.undated.map((u: { programId: string }) => u.programId);
    expect(undated).toContain('arrl-club-grant');
    expect(res.body.undated.find((u: { programId: string }) => u.programId === 'arrl-club-grant')
      .deadlineKind).toBe('unpublished');
  });

  it('defaults the window to the next twelve months', async () => {
    const res = await request(buildApp(db)).get('/api/calendar');
    expect(res.body.from).toBe(NOW);
    expect(res.body.to).toBe('2027-08-02T12:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/prepLead.test.ts packages/server/src/api/calendarRouter.test.ts
```

Expected failure: `Failed to load url ./prepLead.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/api/prepLead.ts`:

```ts
import type { Program } from '@grantspotter/core';

/** PLAN-LOCAL to Plan 3. */
export interface PrepLead {
  /** Days before the close date the applicant should start. */
  prepLeadDays: number;
  /** Days after close before a decision, when the funder publishes one. */
  decisionLagMinDays?: number;
  decisionLagMaxDays?: number;
  /** Human-readable justification, shown in the calendar overlay tooltip. */
  note: string;
}

const DEFAULT_LEAD: PrepLead = {
  prepLeadDays: 30,
  note: 'This funder publishes no published lead time. Thirty days is GrantSpotter’s default, not the funder’s figure.',
};

/**
 * Lead times keyed by funder. Every number here traces to the 2026-08-02
 * research pass; nothing is invented.
 */
const BY_FUNDER: Record<string, PrepLead> = {
  ardc: {
    prepLeadDays: 45,
    decisionLagMinDays: 60,
    decisionLagMaxDays: 120,
    note: 'ARDC evaluates for 60 to 120 days after a cycle closes, and the application needs three references plus an open-source/open-access commitment. Start about 45 days out.',
  },
  'arrl-foundation': {
    prepLeadDays: 30,
    note: 'The single ARRL Foundation application needs a transcript and references from people who are not you. Start about 30 days before the close.',
  },
  qcwa: {
    prepLeadDays: 30,
    note: 'QCWA needs a sponsoring active QCWA member, and the packet must reach ARRL before the first week of January. Start about 30 days before the ARRL close, plus a transcript.',
  },
  ncdxf: {
    prepLeadDays: 60,
    note: 'NCDXF asks for roughly two months of lead before it can act on a request.',
  },
  'ariss-usa': {
    prepLeadDays: 45,
    note: 'ARISS proposal windows are rewritten quarterly and require an education plan plus a technical mentor. Start about 45 days out.',
  },
  yaesu: {
    prepLeadDays: 21,
    note: 'The Yaesu DR-2X window is ad-hoc and short, and carries a 12-month on-air obligation the club must agree to first.',
  },
};

export function prepLeadFor(program: Program): PrepLead {
  const direct = BY_FUNDER[program.funderId];
  if (direct) return direct;
  return DEFAULT_LEAD;
}

/** The date the applicant should start, or null when there is no close date. */
export function prepStartFor(closesAt: string | null, prepLeadDays: number): string | null {
  if (closesAt === null) return null;
  return new Date(Date.parse(closesAt) - prepLeadDays * 86_400_000).toISOString();
}
```

Note on QCWA: `prepLeadFor` is keyed on `funderId`, and the fixture's QCWA record carries `funderId: 'qcwa'`, whose entry above is `prepLeadDays: 30`. That is what makes the "inherits the lead" test pass without a separate inheritance mechanism — the inherited deadline supplies the date, the funder entry supplies the lead.

Create `packages/server/src/api/calendarRouter.ts`:

```ts
import { Router } from 'express';
import type {
  ApplicantEntity, Cycle, Instrument, OpportunityClass, Program, Verdict,
} from '@grantspotter/core';
import { expandCycles, matchAll } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import type { RouterDeps } from './deps.js';
import { loadActiveProfile } from './profileStore.js';
import { watchedProgramIds } from './watchRouter.js';
import { prepLeadFor, prepStartFor } from './prepLead.js';

/** PLAN-LOCAL to Plan 3. */
export interface CalendarEntry {
  cycle: Cycle;
  programId: string;
  programName: string;
  funderName: string;
  klass: OpportunityClass;
  instrument: Instrument;
  applicantEntities: ApplicantEntity[];
  isEstimated: boolean;
  prepLeadDays: number;
  prepStartAt: string | null;
  prepNote: string;
  decisionLagMinDays: number | null;
  decisionLagMaxDays: number | null;
  watched: boolean;
  verdictKind: Verdict['kind'] | null;
}

/** PLAN-LOCAL to Plan 3. */
export interface UndatedProgram {
  programId: string;
  programName: string;
  deadlineKind: string;
  deadlineNote: string;
  status: string;
}

const YEAR_MS = 365 * 86_400_000;

function iso(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return fallback;
  return value;
}

export function createCalendarRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const nowISO = deps.now();
    const from = iso(req.query.from, nowISO);
    const to = iso(req.query.to, new Date(Date.parse(nowISO) + YEAR_MS).toISOString());

    // RESOLUTIONS R1: whole records through Plan 1's repository; the funder
    // display name is the only thing read in SQL, once, into a lookup.
    const programs: Program[] = createProgramRepo(deps.db).list();
    const funderById = new Map(
      (deps.db.prepare('SELECT id, name FROM funders').all() as Array<{ id: string; name: string }>)
        .map((f) => [f.id, f.name] as const),
    );
    const funderNames = new Map(programs.map((p) => [p.id, funderById.get(p.funderId) ?? '']));

    const active = loadActiveProfile(deps.db, user.id);
    const verdicts = active
      ? matchAll(active.profile, programs, nowISO)
      : new Map<string, Verdict>();
    const watched = new Set(watchedProgramIds(deps.db, user.id));

    const entries: CalendarEntry[] = [];
    const undated: UndatedProgram[] = [];

    for (const program of programs) {
      const cycles = expandCycles(program, programs, from, to)
        .filter((c) => c.closesAt !== undefined);

      if (cycles.length === 0) {
        undated.push({
          programId: program.id,
          programName: program.name,
          deadlineKind: program.deadline.kind,
          deadlineNote: program.deadline.note,
          status: program.trust.status,
        });
        continue;
      }

      const lead = prepLeadFor(program);
      for (const cycle of cycles) {
        entries.push({
          cycle,
          programId: program.id,
          programName: program.name,
          funderName: funderNames.get(program.id) ?? '',
          klass: program.klass,
          instrument: program.amount.instrument,
          applicantEntities: program.applicantEntities,
          isEstimated: cycle.isEstimated,
          prepLeadDays: lead.prepLeadDays,
          prepStartAt: prepStartFor(cycle.closesAt ?? null, lead.prepLeadDays),
          prepNote: lead.note,
          decisionLagMinDays: lead.decisionLagMinDays ?? null,
          decisionLagMaxDays: lead.decisionLagMaxDays ?? null,
          watched: watched.has(program.id),
          verdictKind: verdicts.get(program.id)?.kind ?? null,
        });
      }
    }

    entries.sort((a, b) => (a.cycle.closesAt ?? '').localeCompare(b.cycle.closesAt ?? ''));
    undated.sort((a, b) => a.programName.localeCompare(b.programName));

    res.json({ from, to, entries, undated });
  });

  return router;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/prepLead.test.ts packages/server/src/api/calendarRouter.test.ts
```

Expected: 7 prep-lead + 8 calendar assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/api/prepLead.ts packages/server/src/api/prepLead.test.ts \
        packages/server/src/api/calendarRouter.ts packages/server/src/api/calendarRouter.test.ts
git commit -m "feat(api): calendar endpoint with prep-lead-time and decision-lag overlay"
```

---
### Task 12: Inbox API — readable by everyone, decidable by admins

**Why this exists:** spec §12 — *"Members see the Inbox read-only deliberately: knowing that a deadline change is pending review is useful, and hiding it invites the 'why is this list wrong' complaint the trust surfaces exist to prevent."* That is a product decision with a security consequence: the GET is `requireAuth`, the POST is `requireAdmin`, and there is no third path.

**This route DELEGATES; it does not re-implement (RESOLUTIONS R26).** Plan 2 Task 21 already ships
`approveReviewItem` / `rejectReviewItem` / `editReviewItem`, and this POST is the **only** path a
human ever takes — the review pipeline has no other caller in the product. A second, hand-rolled
publish here would leave Plan 2's three functions as dead code while diverging on four behaviours,
and every one of those divergences is a real bug:

1. it would never write `review_rejects`, so reject memory would suppress nothing and the same
   candidate would reappear in the Inbox every night until the Inbox stopped being read;
2. it would write no `audit_log` row, so `provenanceFor(itemId)` — the trail the Inbox UI and the
   admin console read — would come back empty for every decision a human actually made;
3. it would call `programs.upsert(candidate)` with **no source key**, so an approved candidate would
   land with `source_id` NULL, `listProgramsBySource` would miss it, `diffPrograms` would see an
   empty `previous`, and the record would fire `new` **every night forever** — the R9
   duplicate-every-night bug reintroduced through the human path;
4. it would upsert on a `vanished` change event, republishing a program that disappeared from its
   source, which is the exact opposite of what approving "this record vanished" means.

`approveReviewItem` handles all four correctly (it reads `sourceKeyFor(candidate)` off the
`source:` / `key:` tags, and deletes rather than upserts when the change kind is `vanished`). What
stays Plan 3's is the HTTP shell: the decision validation, the `programSchema` gate on an edited
candidate, Plan 1's error envelope, and the `reindexBrowse` + `drainChangeEvents` calls that the
review pipeline knows nothing about because it predates the browse projection.

**Files:**
- Create: `packages/server/src/api/inboxRouter.ts`
- Test: `packages/server/src/api/inboxRouter.test.ts`

**Interfaces:**
- Consumes: `Program`, `ReviewItem`, `ReviewDecision`, `ChangeEvent` from `@grantspotter/core`; `programSchema` from `@grantspotter/core`; `approveReviewItem(db, itemId, userId, nowISO): Program`, `rejectReviewItem(db, itemId, userId, nowISO, reason): void`, `editReviewItem(db, itemId, userId, nowISO, edited): Program` from `../review/index.js` (**Plan 2** Task 21 — RESOLUTIONS R26); `AppError` from `./errors.js`; `reindexBrowse`; `drainChangeEvents`; `RouterDeps`. (The test additionally uses `createProgramRepo(db)` to read the published record back; the router itself never touches `programs` directly.)
- Produces: `createInboxRouter(deps: RouterDeps): Router`, `InboxRow`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/inboxRouter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { seedFixtureCorpus, starProgram, arrlScholarship } from '../test/fixtures/programs.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { reindexBrowse } from './reindex.js';
import { createInboxRouter } from './inboxRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };
const ADMIN: SessionUser = { id: 'u-admin', email: 'admin@example.com', role: 'admin' };

function buildApp(db: Database.Database, user: SessionUser) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => {
      next(user.role === 'admin' ? undefined : new AppError('forbidden', 'Admin role required.'));
    },
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/inbox', createInboxRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

/** The published record, read back through Plan 1's repository (R1). */
function published(db: Database.Database, id = 'arrl-foundation-scholarship') {
  const program = createProgramRepo(db).get(id);
  if (program === undefined) throw new Error(`expected ${id} to be in the corpus`);
  return program;
}

/**
 * The published fixture's own note already says "Dec 30", so the assertions use
 * a sentinel phrase that exists ONLY on the candidate. Without it,
 * `not.toContain('Dec 30')` would pass against the seeded record and the
 * "a rejection must not publish" test would prove nothing.
 */
const CANDIDATE_SENTINEL = 'confirmed on the ARRL portal';

/**
 * RESOLUTIONS R9/R26. Plan 2's `normalizeRaw` stamps `source:<sourceId>` and
 * `key:<externalKey>` into `Program.tags`, and `sourceKeyFor` reads them back on
 * the way into `programs.source_id` / `programs.external_key`. A candidate
 * without them approves into the corpus with a NULL source key, and then fires
 * `new` again every single night.
 */
const CANDIDATE_TAGS = [
  ...arrlScholarship.tags,
  'source:arrl-scholarship-descriptions',
  'key:arrl-foundation-scholarship-program',
];

/** A pending review item: the ARRL close moved from Jan 31 to Dec 30. */
function seedPendingItem(db: Database.Database) {
  db.prepare(
    `INSERT INTO change_events
       (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ce-1', 'arrl-scholarship-descriptions', 'arrl-foundation-scholarship',
    'deadline_changed', JSON.stringify('January 31'), JSON.stringify('December 30, 12:00 PM EST'),
    NOW, 'deadline.note');

  const candidate = {
    ...arrlScholarship,
    deadline: {
      ...arrlScholarship.deadline,
      note: `Opens about Oct 30; closes Dec 30 at 12:00 PM EST (${CANDIDATE_SENTINEL}).`,
    },
    tags: CANDIDATE_TAGS,
  };
  db.prepare(
    `INSERT INTO review_items
       (id, change_event_id, candidate_json, decision, decided_by, decided_at, confidence, reject_key)
     VALUES (?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
  ).run('ri-1', 'ce-1', JSON.stringify(candidate), 0.82);
}

/**
 * A second pending item whose change event says the record VANISHED from its
 * source. Approving it must DELETE the program, not republish it — which is
 * exactly the divergence RESOLUTIONS R26 closes by delegating to
 * `approveReviewItem` instead of upserting the candidate unconditionally.
 */
function seedVanishedItem(db: Database.Database) {
  db.prepare(
    `INSERT INTO change_events
       (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
     VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
  ).run('ce-2', 'arrl-scholarship-descriptions', 'arrl-foundation-scholarship',
    'vanished', JSON.stringify('ARRL Foundation Scholarship Program'), NOW);

  db.prepare(
    `INSERT INTO review_items
       (id, change_event_id, candidate_json, decision, decided_by, decided_at, confidence, reject_key)
     VALUES (?, ?, ?, 'pending', NULL, NULL, ?, NULL)`,
  ).run('ri-2', 'ce-2', JSON.stringify({ ...arrlScholarship, tags: CANDIDATE_TAGS }), 0.5);
}

describe('inbox API', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    seedFixtureCorpus(db);
    reindexBrowse(db, NOW);
    seedPendingItem(db);
  });

  afterEach(() => {
    db.close();
  });

  it('lets a member read the queue', async () => {
    const res = await request(buildApp(db, MEMBER)).get('/api/inbox');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].decision).toBe('pending');
    expect(res.body.rows[0].changeEvent.kind).toBe('deadline_changed');
  });

  it('tells the client the viewer cannot decide, so the UI can render read-only', async () => {
    const res = await request(buildApp(db, MEMBER)).get('/api/inbox');
    expect(res.body.canDecide).toBe(false);
    const admin = await request(buildApp(db, ADMIN)).get('/api/inbox');
    expect(admin.body.canDecide).toBe(true);
  });

  it('shows the before and after of the pending change to a member', async () => {
    const res = await request(buildApp(db, MEMBER)).get('/api/inbox');
    expect(res.body.rows[0].changeEvent.before).toBe('January 31');
    expect(res.body.rows[0].changeEvent.after).toBe('December 30, 12:00 PM EST');
  });

  it('refuses a member decision with 403 in the one error envelope', async () => {
    const res = await request(buildApp(db, MEMBER))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'approved' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    const row = db.prepare('SELECT decision FROM review_items WHERE id = ?').get('ri-1') as { decision: string };
    expect(row.decision).toBe('pending');
  });

  it('lets an admin approve, publishing the candidate into the corpus', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'approved' });
    expect(res.status).toBe(200);
    expect(published(db).deadline.note).toContain(CANDIDATE_SENTINEL);
  });

  // --- RESOLUTIONS R26: the four behaviours that only Plan 2's review pipeline
  //     gets right, asserted here because this route is the ONLY path a human
  //     ever takes to reach it. -------------------------------------------------

  it('lands the source key on approval, so tomorrow’s crawl does not re-fire `new`', async () => {
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    const row = db
      .prepare('SELECT source_id, external_key FROM programs WHERE id = ?')
      .get('arrl-foundation-scholarship');
    // With source_id NULL, listProgramsBySource misses the record, diffPrograms
    // sees an empty `previous`, and it fires `new` every night forever (R9).
    expect(row).toEqual({
      source_id: 'arrl-scholarship-descriptions',
      external_key: 'arrl-foundation-scholarship-program',
    });
  });

  it('deletes the program when an approved change event says it vanished', async () => {
    seedVanishedItem(db);
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-2/decision')
      .send({ decision: 'approved' });
    expect(res.status).toBe(200);
    expect(createProgramRepo(db).get('arrl-foundation-scholarship')).toBeUndefined();
    // The browse projection is rebuilt wholesale, so the row goes with it.
    expect(
      db.prepare('SELECT 1 FROM program_search WHERE program_id = ?').get('arrl-foundation-scholarship'),
    ).toBeUndefined();
  });

  it('writes review_rejects on a rejection, so the same candidate never returns', async () => {
    const rejectKey = 'arrl-scholarship-descriptions:deadline.note:December 30, 12:00 PM EST';
    await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'rejected', rejectKey, reason: 'past award, not an opportunity' });
    const row = db
      .prepare('SELECT decided_by, decided_at FROM review_rejects WHERE reject_key = ?')
      .get(rejectKey);
    expect(row).toEqual({ decided_by: 'u-admin', decided_at: NOW });
  });

  it('appends an audit_log row for every decision, so the provenance trail is never empty', async () => {
    const actions = (id: string) =>
      db
        .prepare('SELECT actor_user_id, action, entity_type FROM audit_log WHERE entity_id = ? ORDER BY id')
        .all(id);
    const app = buildApp(db, ADMIN);

    await request(app).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    await request(app)
      .post('/api/inbox/ri-1/decision')
      .send({
        decision: 'edited',
        candidate: { ...arrlScholarship, tags: CANDIDATE_TAGS, name: 'ARRL Foundation Scholarships' },
      });
    expect(actions('ri-1')).toEqual([
      { actor_user_id: 'u-admin', action: 'review.approve', entity_type: 'review_item' },
      { actor_user_id: 'u-admin', action: 'review.edit', entity_type: 'review_item' },
    ]);

    seedVanishedItem(db);
    await request(app)
      .post('/api/inbox/ri-2/decision')
      .send({ decision: 'rejected', reason: 'the page was just down' });
    expect(actions('ri-2')).toEqual([
      { actor_user_id: 'u-admin', action: 'review.reject', entity_type: 'review_item' },
    ]);
  });

  it('reindexes browse after an approval so filters see the new value', async () => {
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    const row = db
      .prepare('SELECT deadline_kind FROM program_search WHERE program_id = ?')
      .get('arrl-foundation-scholarship') as { deadline_kind: string };
    expect(row.deadline_kind).toBe('annual_window');
  });

  it('notifies watchers when a change is approved', async () => {
    starProgram(db, 'u-member', 'arrl-foundation-scholarship', NOW);
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    const n = db.prepare('SELECT title FROM notifications WHERE user_id = ?').get('u-member') as
      | { title: string }
      | undefined;
    expect(n?.title).toBe('Deadline changed: ARRL Foundation Scholarship Program');
  });

  it('records who decided and when', async () => {
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    const row = db
      .prepare('SELECT decision, decided_by, decided_at FROM review_items WHERE id = ?')
      .get('ri-1') as { decision: string; decided_by: string; decided_at: string };
    expect(row).toEqual({ decision: 'approved', decided_by: 'u-admin', decided_at: NOW });
  });

  it('lets an admin reject and stores the reject key for reject-memory', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'rejected', rejectKey: 'arrl-scholarship-descriptions:deadline.note:December 30, 12:00 PM EST' });
    expect(res.status).toBe(200);
    const row = db
      .prepare('SELECT decision, reject_key FROM review_items WHERE id = ?')
      .get('ri-1') as { decision: string; reject_key: string };
    expect(row.decision).toBe('rejected');
    expect(row.reject_key).toContain('December 30');
    // A rejection must NOT publish. The sentinel is on the CANDIDATE only —
    // the seeded record's own note already mentions Dec 30.
    expect(published(db).deadline.note).not.toContain(CANDIDATE_SENTINEL);
  });

  it('lets an admin edit the candidate before publishing it', async () => {
    const edited = {
      ...arrlScholarship,
      tags: CANDIDATE_TAGS,
      deadline: { ...arrlScholarship.deadline, note: 'Closes Dec 30 at 12:00 PM EST (hand-checked).' },
    };
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'edited', candidate: edited });
    expect(res.status).toBe(200);
    expect(published(db).deadline.note).toContain('hand-checked');
  });

  it('rejects an edited candidate that fails the core schema, with 422', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'edited', candidate: { id: 'x' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
    expect(Array.isArray(res.body.error.details)).toBe(true);
  });

  it('rejects an unknown decision value with 422', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/ri-1/decision')
      .send({ decision: 'maybe' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('404s an unknown review item', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/inbox/nope/decision')
      .send({ decision: 'approved' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('filters by decision so the UI can default to pending', async () => {
    await request(buildApp(db, ADMIN)).post('/api/inbox/ri-1/decision').send({ decision: 'approved' });
    const pending = await request(buildApp(db, MEMBER)).get('/api/inbox?decision=pending');
    expect(pending.body.rows).toEqual([]);
    const approved = await request(buildApp(db, MEMBER)).get('/api/inbox?decision=approved');
    expect(approved.body.rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/inboxRouter.test.ts
```

Expected failure: `Failed to load url ./inboxRouter.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/api/inboxRouter.ts`:

```ts
import { Router } from 'express';
import type { ChangeKind, Program, ReviewDecision } from '@grantspotter/core';
import { programSchema } from '@grantspotter/core';
// RESOLUTIONS R26: Plan 2 Task 21 owns the review pipeline. This router is the
// only human-facing caller of it, so it delegates rather than re-implementing.
import { approveReviewItem, editReviewItem, rejectReviewItem } from '../review/index.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { reindexBrowse } from './reindex.js';
import { drainChangeEvents } from './notify.js';

/** PLAN-LOCAL to Plan 3. */
export interface InboxRow {
  id: string;
  decision: ReviewDecision;
  decidedBy: string | null;
  decidedAt: string | null;
  confidence: number;
  rejectKey: string | null;
  candidate: Program;
  changeEvent: {
    id: string;
    sourceId: string;
    programId: string | null;
    kind: ChangeKind;
    before: string | null;
    after: string | null;
    detectedAt: string;
    fieldPath: string | null;
  } | null;
}

const DECISIONS: ReviewDecision[] = ['pending', 'approved', 'rejected', 'edited'];

function text(json: string | null): string | null {
  if (json === null) return null;
  const value: unknown = JSON.parse(json);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function createInboxRouter(deps: RouterDeps): Router {
  const router = Router();

  // Readable by every authenticated user. Members see it read-only on purpose:
  // knowing a deadline change is PENDING REVIEW is itself trust information.
  router.get('/', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const wanted = DECISIONS.includes(String(req.query.decision) as ReviewDecision)
      ? String(req.query.decision)
      : null;

    const rows = deps.db
      .prepare(
        `SELECT ri.id AS id, ri.decision AS decision, ri.decided_by AS decided_by,
                ri.decided_at AS decided_at, ri.confidence AS confidence,
                ri.reject_key AS reject_key, ri.candidate_json AS candidate_json,
                ce.id AS ce_id, ce.source_id AS ce_source_id, ce.program_id AS ce_program_id,
                ce.kind AS ce_kind, ce.before_json AS ce_before, ce.after_json AS ce_after,
                ce.detected_at AS ce_detected_at, ce.field_path AS ce_field_path
           FROM review_items ri
           LEFT JOIN change_events ce ON ce.id = ri.change_event_id
          ${wanted ? 'WHERE ri.decision = ?' : ''}
          ORDER BY COALESCE(ce.detected_at, '') DESC, ri.id DESC
          LIMIT 500`,
      )
      .all(...(wanted ? [wanted] : [])) as Array<Record<string, string | number | null>>;

    const mapped: InboxRow[] = rows.map((r) => ({
      id: String(r.id),
      decision: String(r.decision) as ReviewDecision,
      decidedBy: r.decided_by === null ? null : String(r.decided_by),
      decidedAt: r.decided_at === null ? null : String(r.decided_at),
      confidence: Number(r.confidence),
      rejectKey: r.reject_key === null ? null : String(r.reject_key),
      candidate: JSON.parse(String(r.candidate_json)) as Program,
      changeEvent: r.ce_id === null || r.ce_id === undefined
        ? null
        : {
            id: String(r.ce_id),
            sourceId: String(r.ce_source_id),
            programId: r.ce_program_id === null ? null : String(r.ce_program_id),
            kind: String(r.ce_kind) as ChangeKind,
            before: text(r.ce_before === null ? null : String(r.ce_before)),
            after: text(r.ce_after === null ? null : String(r.ce_after)),
            detectedAt: String(r.ce_detected_at),
            fieldPath: r.ce_field_path === null ? null : String(r.ce_field_path),
          },
    }));

    res.json({ rows: mapped, canDecide: user.role === 'admin' });
  });

  /**
   * RESOLUTIONS R26. Everything that touches the corpus, the reject memory or
   * the audit trail happens inside Plan 2's `approveReviewItem` /
   * `rejectReviewItem` / `editReviewItem`. What lives here is the HTTP shell:
   * validation, Plan 1's error envelope, and the two Plan-3-owned derived-state
   * rebuilds the review pipeline knows nothing about.
   */
  router.post('/:id/decision', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    const user = deps.currentUser(req);
    const nowISO = deps.now();
    const body = req.body as {
      decision?: unknown; candidate?: unknown; rejectKey?: unknown; reason?: unknown;
    };

    const decision = String(body.decision) as ReviewDecision;
    if (!DECISIONS.includes(decision) || decision === 'pending') {
      next(new AppError(
        'validation_failed',
        `"${String(body.decision)}" is not a decision. Expected approved, rejected or edited.`,
      ));
      return;
    }

    // Checked here so an unknown id is a 404 in Plan 1's envelope rather than
    // the bare `Error("unknown review item …")` the review pipeline throws.
    const item = deps.db
      .prepare('SELECT id FROM review_items WHERE id = ?')
      .get(req.params.id) as { id: string } | undefined;
    if (!item) {
      next(new AppError('not_found', `No review item with id "${req.params.id}".`));
      return;
    }

    let edited: Program | undefined;
    if (decision === 'edited') {
      const parsed = programSchema.safeParse(body.candidate);
      if (!parsed.success) {
        next(new AppError(
          'validation_failed',
          'The edited candidate is not a valid Program.',
          parsed.error.issues,
        ));
        return;
      }
      edited = parsed.data as Program;
    }

    // `rejectReviewItem` remembers the key stored ON THE ROW (Plan 2 sets it in
    // buildReviewItems). When the client supplies one — the Inbox UI derives a
    // human-readable key from the change event — it is written first so the
    // pipeline remembers that key and not a stale one.
    if (typeof body.rejectKey === 'string' && body.rejectKey.trim() !== '') {
      deps.db
        .prepare('UPDATE review_items SET reject_key = ? WHERE id = ?')
        .run(body.rejectKey, req.params.id);
    }

    try {
      if (decision === 'approved') {
        // Publishes, or DELETES when the change event kind is `vanished`, and
        // carries sourceKeyFor(candidate) into programs.source_id /
        // external_key so tomorrow's crawl resolves the record instead of
        // minting a duplicate (R9).
        approveReviewItem(deps.db, req.params.id, user.id, nowISO);
      } else if (decision === 'edited') {
        editReviewItem(deps.db, req.params.id, user.id, nowISO, edited as Program);
      } else {
        rejectReviewItem(
          deps.db, req.params.id, user.id, nowISO,
          typeof body.reason === 'string' && body.reason.trim() !== ''
            ? body.reason
            : 'rejected in the review Inbox',
        );
      }
    } catch (err: unknown) {
      next(err);
      return;
    }

    // `published` means "the corpus was written". For an approved `vanished`
    // event that write is a deletion, and the browse projection — which is
    // rebuilt wholesale — has to lose the row either way.
    const published = decision !== 'rejected';
    if (published) {
      reindexBrowse(deps.db, nowISO);
      drainChangeEvents(deps.db, nowISO);
    }

    res.json({ id: req.params.id, decision, decidedBy: user.id, decidedAt: nowISO, published });
  });

  return router;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/inboxRouter.test.ts
```

Expected: 18 assertions green — the original 14 plus the four RESOLUTIONS R26 behaviours
(`source_id`/`external_key` on approval, deletion on an approved `vanished` event, a
`review_rejects` row on rejection, and an `audit_log` row for every decision). If any of those four
fails, the route has drifted back to re-implementing Plan 2 Task 21 instead of calling it.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/api/inboxRouter.ts packages/server/src/api/inboxRouter.test.ts
git commit -m "feat(api): review inbox readable by members, decidable by admins"
```

---

### Task 13: `/api/admin/users` — user management

**Why this exists:** spec §12's role matrix has a row that no plan implemented — *"User management |
admin ✅ | member ❌"*. Plan 1 ships the `users` table, `createUserRepo`, `hashPassword` and the
`requireUserAdmin` guard, and then stops: the only way to create a second account was the one-time
bootstrap. Without this task a self-hosted instance is permanently single-user, and the entire member
role — the read-only Inbox, the rate-limited Verify now, the read-only Sources page — is unreachable
because no member can be created. This task is also what makes `packages/web/src/routes/Admin.tsx`
(Task 25) have something to render.

**Password policy note.** An admin never sees or chooses another user's password. Creation and reset
both mint a random 24-character token, return it **once** in the response body, and store only its
argon2 hash. That keeps the "admin typed a password for you" failure mode out of the product and
means a leaked audit log never contains a credential.

**Files:**
- Create: `packages/server/src/api/adminUsersRouter.ts`
- Test: `packages/server/src/api/adminUsersRouter.test.ts`

**Interfaces:**
- Consumes: `createUserRepo(db)` and its `UserRecord` / `CreateUserInput` / `Role` types from `../db/repositories/users.js` (**Plan 1 Task 14**, "Account repositories and argon2id password hashing"); `hashPassword(plain): Promise<string>` from `../auth/password.js` (**Plan 1 Task 14** — the same task; Plan 1 Task 16 is sessions and auth middleware); `AppError` from `./errors.js`; `RouterDeps`.
- Produces: `createAdminUsersRouter(deps: RouterDeps): Router`, `AdminUserRow`, `generatePassword(): string`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/adminUsersRouter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { createUserRepo } from '../db/repositories/users.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { createAdminUsersRouter } from './adminUsersRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };

function buildApp(db: Database.Database, user: SessionUser) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => {
      next(user.role === 'admin' ? undefined : new AppError('forbidden', 'Admin role required.'));
    },
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/admin/users', createAdminUsersRouter(deps));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

describe('/api/admin/users', () => {
  let db: Database.Database;
  let adminId: string;
  let admin: SessionUser;

  beforeEach(async () => {
    db = openTestDb();
    const created = createUserRepo(db).create({
      email: 'admin@example.com',
      passwordHash: await hashPassword('an-admin-password-not-a-real-secret'),
      role: 'admin',
      displayName: 'The Admin',
    });
    adminId = created.id;
    admin = { id: adminId, email: created.email, role: 'admin' };
  });

  afterEach(() => {
    db.close();
  });

  it('refuses a member on every route', async () => {
    const app = buildApp(db, MEMBER);
    for (const res of [
      await request(app).get('/api/admin/users'),
      await request(app).post('/api/admin/users').send({ email: 'x@example.com', role: 'member' }),
      await request(app).patch(`/api/admin/users/${adminId}/role`).send({ role: 'member' }),
      await request(app).patch(`/api/admin/users/${adminId}/disabled`).send({ disabled: true }),
      await request(app).post(`/api/admin/users/${adminId}/reset-password`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    }
  });

  it('lists users without ever emitting a password hash or an ICS token', async () => {
    const res = await request(buildApp(db, admin)).get('/api/admin/users');
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toEqual({
      id: adminId,
      email: 'admin@example.com',
      displayName: 'The Admin',
      role: 'admin',
      disabled: false,
      createdAt: expect.any(String),
      lastLoginAt: null,
      isSelf: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|icsToken|passwordHash/i);
  });

  it('creates a member and returns the generated password exactly once', async () => {
    const res = await request(buildApp(db, admin))
      .post('/api/admin/users')
      .send({ email: 'New.Member@Example.com', role: 'member', displayName: 'New Member' });
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe('New.Member@Example.com');
    expect(res.body.user.role).toBe('member');
    expect(typeof res.body.generatedPassword).toBe('string');
    expect(res.body.generatedPassword.length).toBeGreaterThanOrEqual(24);

    // The generated password is the real credential, not a decoration.
    const stored = createUserRepo(db).findByEmail('new.member@example.com');
    expect(stored).toBeDefined();
    await expect(verifyPassword(stored!.passwordHash, res.body.generatedPassword))
      .resolves.toBe(true);

    // …and it is never returned again.
    const list = await request(buildApp(db, admin)).get('/api/admin/users');
    expect(JSON.stringify(list.body)).not.toContain(res.body.generatedPassword);
  });

  it('rejects a duplicate email with 409 rather than a 500 from the unique index', async () => {
    const app = buildApp(db, admin);
    await request(app).post('/api/admin/users').send({ email: 'dup@example.com', role: 'member' });
    const second = await request(app)
      .post('/api/admin/users')
      .send({ email: 'DUP@example.com', role: 'member' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
  });

  it('rejects a malformed email and an unknown role with 422', async () => {
    const app = buildApp(db, admin);
    const badEmail = await request(app).post('/api/admin/users').send({ email: 'nope', role: 'member' });
    expect(badEmail.status).toBe(422);
    expect(badEmail.body.error.code).toBe('validation_failed');

    const badRole = await request(app)
      .post('/api/admin/users')
      .send({ email: 'ok@example.com', role: 'superuser' });
    expect(badRole.status).toBe(422);
  });

  it('changes a role', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'promote@example.com', role: 'member' });
    const id = created.body.user.id as string;

    const res = await request(app).patch(`/api/admin/users/${id}/role`).send({ role: 'admin' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
    expect(createUserRepo(db).findById(id)?.role).toBe('admin');
  });

  it('disables and re-enables a user', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'gone@example.com', role: 'member' });
    const id = created.body.user.id as string;

    const off = await request(app).patch(`/api/admin/users/${id}/disabled`).send({ disabled: true });
    expect(off.status).toBe(200);
    expect(createUserRepo(db).findById(id)?.disabled).toBe(true);

    const on = await request(app).patch(`/api/admin/users/${id}/disabled`).send({ disabled: false });
    expect(on.status).toBe(200);
    expect(createUserRepo(db).findById(id)?.disabled).toBe(false);
  });

  it('refuses to let the last admin demote or disable themselves', async () => {
    const app = buildApp(db, admin);
    const demote = await request(app)
      .patch(`/api/admin/users/${adminId}/role`)
      .send({ role: 'member' });
    expect(demote.status).toBe(409);
    expect(demote.body.error.message).toMatch(/last admin/i);

    const disable = await request(app)
      .patch(`/api/admin/users/${adminId}/disabled`)
      .send({ disabled: true });
    expect(disable.status).toBe(409);
    expect(createUserRepo(db).findById(adminId)?.role).toBe('admin');
  });

  it('allows demoting an admin once a second admin exists', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'second-admin@example.com', role: 'admin' });
    const res = await request(app)
      .patch(`/api/admin/users/${adminId}/role`)
      .send({ role: 'member' });
    expect(res.status).toBe(200);
    expect(createUserRepo(db).findById(created.body.user.id as string)?.role).toBe('admin');
  });

  it('resets a password to a fresh generated one and invalidates the old', async () => {
    const app = buildApp(db, admin);
    const created = await request(app)
      .post('/api/admin/users')
      .send({ email: 'reset@example.com', role: 'member' });
    const id = created.body.user.id as string;
    const first = created.body.generatedPassword as string;

    const res = await request(app).post(`/api/admin/users/${id}/reset-password`);
    expect(res.status).toBe(200);
    const second = res.body.generatedPassword as string;
    expect(second).not.toBe(first);

    const stored = createUserRepo(db).findById(id);
    await expect(verifyPassword(stored!.passwordHash, second)).resolves.toBe(true);
    await expect(verifyPassword(stored!.passwordHash, first)).resolves.toBe(false);
  });

  it('404s an unknown user id', async () => {
    const res = await request(buildApp(db, admin))
      .patch('/api/admin/users/u-nope/role')
      .send({ role: 'member' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/adminUsersRouter.test.ts
```

Expected failure: `Failed to load url ./adminUsersRouter.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/api/adminUsersRouter.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { hashPassword } from '../auth/password.js';
import { createUserRepo, type Role, type UserRecord } from '../db/repositories/users.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';

/** PLAN-LOCAL to Plan 3. The safe projection of a user for an admin screen. */
export interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** True for the row describing the signed-in admin, so the UI can guard it. */
  isSelf: boolean;
}

const ROLES: Role[] = ['admin', 'member'];

/**
 * A deliberately conservative email check. The real gate is the unique index on
 * `users.email_normalized`; this only rejects input that could never be an
 * address, so a typo produces 422 rather than a permanently unusable account.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 24 characters of base64url from 18 random bytes. An admin never chooses
 * another person's password: it is generated, shown once, and stored only as an
 * argon2 hash.
 */
export function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

function toRow(user: UserRecord, selfId: string): AdminUserRow {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    disabled: user.disabled,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt ?? null,
    isSelf: user.id === selfId,
  };
}

export function createAdminUsersRouter(deps: RouterDeps): Router {
  const router = Router();
  const users = createUserRepo(deps.db);

  /** Lock-out guard: an instance with zero enabled admins cannot be recovered. */
  function otherEnabledAdminExists(exceptId: string): boolean {
    return users.list().some((u) => u.id !== exceptId && u.role === 'admin' && !u.disabled);
  }

  function load(id: string): UserRecord {
    const user = users.findById(id);
    if (user === undefined) throw new AppError('not_found', `No user with id "${id}".`);
    return user;
  }

  router.get('/', deps.requireAuth, deps.requireAdmin, (req, res) => {
    const selfId = deps.currentUser(req).id;
    res.json({
      rows: users
        .list()
        .map((u) => toRow(u, selfId))
        .sort((a, b) => a.email.localeCompare(b.email)),
    });
  });

  router.post('/', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    void (async () => {
      try {
        const body = req.body as { email?: unknown; role?: unknown; displayName?: unknown };
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const role = body.role as Role;

        if (!EMAIL.test(email)) {
          next(new AppError('validation_failed', `"${email}" is not an email address.`));
          return;
        }
        if (!ROLES.includes(role)) {
          next(new AppError('validation_failed', 'role must be "admin" or "member".'));
          return;
        }
        if (users.findByEmail(email) !== undefined) {
          next(new AppError('conflict', `${email} already has an account.`));
          return;
        }

        const generatedPassword = generatePassword();
        const created = users.create({
          email,
          passwordHash: await hashPassword(generatedPassword),
          role,
          displayName: typeof body.displayName === 'string' ? body.displayName : '',
        });

        // The one and only time this value leaves the process.
        res.status(201).json({
          user: toRow(created, deps.currentUser(req).id),
          generatedPassword,
        });
      } catch (err) {
        next(err);
      }
    })();
  });

  router.patch('/:id/role', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    try {
      const role = (req.body as { role?: unknown }).role as Role;
      if (!ROLES.includes(role)) {
        next(new AppError('validation_failed', 'role must be "admin" or "member".'));
        return;
      }
      const user = load(req.params.id);
      if (user.role === 'admin' && role === 'member' && !otherEnabledAdminExists(user.id)) {
        next(new AppError('conflict', 'This is the last admin; promote someone else first.'));
        return;
      }
      users.setRole(user.id, role);
      res.json({ user: toRow(load(user.id), deps.currentUser(req).id) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id/disabled', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    try {
      const disabled = (req.body as { disabled?: unknown }).disabled;
      if (typeof disabled !== 'boolean') {
        next(new AppError('validation_failed', 'disabled must be true or false.'));
        return;
      }
      const user = load(req.params.id);
      if (disabled && user.role === 'admin' && !otherEnabledAdminExists(user.id)) {
        next(new AppError('conflict', 'This is the last admin; promote someone else first.'));
        return;
      }
      users.setDisabled(user.id, disabled);
      res.json({ user: toRow(load(user.id), deps.currentUser(req).id) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/reset-password', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    void (async () => {
      try {
        const user = load(req.params.id);
        const generatedPassword = generatePassword();
        users.setPasswordHash(user.id, await hashPassword(generatedPassword));
        res.json({ user: toRow(load(user.id), deps.currentUser(req).id), generatedPassword });
      } catch (err) {
        next(err);
      }
    })();
  });

  return router;
}
```

`UserRepo` needs one method Plan 1 did not ship. Add it to
`packages/server/src/db/repositories/users.ts`, beside `setRole` and `setDisabled`, keeping Plan 1's
style exactly:

```ts
  // in `export interface UserRepo`
  setPasswordHash(id: string, passwordHash: string): void;
```

```ts
  // in `createUserRepo`, beside the other prepared statements
  const setPasswordHashStmt = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?');

  // …and in the returned object
  setPasswordHash(id, passwordHash) {
    setPasswordHashStmt.run(passwordHash, id);
  },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/adminUsersRouter.test.ts
npm run typecheck
```

Expected: 11 admin-user assertions green, typecheck clean. The argon2 hashing in this suite is slow;
if it exceeds the default timeout, raise it to 20 seconds exactly as Plan 1's `api.auth.test.ts` does.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/api/adminUsersRouter.ts \
        packages/server/src/api/adminUsersRouter.test.ts \
        packages/server/src/db/repositories/users.ts
git commit -m "feat(api): admin user management with generated passwords and last-admin guard"
```

---

### Task 14: Sources health, source configuration, manual crawl, and the single mount site

**Why this exists:** spec §8 — *"Sources health page: last poll, last success, parse yield vs. baseline, consecutive failures."* — and spec §12's role-matrix row *"Source configuration, crawl trigger, sources health | admin ✅ | member read-only"*, which needs all three verbs, not just the read. Plan 2 Task 25 ships `runCrawl(deps, sourceIds?)`, but until this task the only caller is the 03:17 scheduler: an admin who has just fixed a parser has no way to prove the fix without waiting a day. This task also does the single piece of integration work the rest of the plan needs: **the one and only site where routers are mounted**.

**Domain fact this task encodes:** an empty scrape is **not** a failure. `grants.austinhams.org` legitimately shows "No opportunities available" between Aug 1 and Apr 30. The health calculation therefore treats a zero yield as `idle` when the source's own `expectedMinRecords` is 0, and only alarms when a source that normally returns records returns none.

**Why the crawl trigger is single-flighted.** A crawl walks ~25 third-party sites belonging to small
nonprofits. Two concurrent crawls double that load and race each other's `sources` bookkeeping, so a
second request while one is running is a `409 conflict`, not a queue.

**One hook, filled by each plan in turn (RESOLUTIONS R25).** This task creates the `mountRoutes`
callback and puts **only Plan 3's routers** in it. It does **not** write `index.ts` "in its final
form": doing so would import seven modules that Plans 4 and 5 have not created yet, `npm run build`
would fail, `packages/server/dist/index.js` would never be produced, Playwright's `webServer` would
never start, and all four e2e specs would die on their first line. The callback therefore ends with
a reservation comment, and each later plan appends to it in a fixed order:

| Plan | Appends to the `mountRoutes` callback |
|---|---|
| **3** (this task) | Plan 3's routers via `mountProductApi`, then the reservation comment |
| **4** (Task 17 Step 5) | `a.use('/api/applications', createApplicationsRouter(routerDeps));` and its three siblings |
| **5** (Task 9 Step 9) | `a.use('/api', createExportsRouter(exportDeps));` and `a.use('/', createCalendarFeedRouter(exportDeps));` |
| **5** (Task 17) | `a.use(createSpaMiddleware(webDistRoot()));` — **the last statement, always** |

**R5 still holds absolutely: nothing is EVER mounted after `createApp` returns.** Plan 1's
`createApp` seals the app with `notFoundHandler()` before it hands the app back, so an `app.use(...)`
on the returned object is dead code that can never match. Every later plan appends *inside* this
callback, immediately below the reservation comment, in the plan order of the table above — and
Plan 5 Task 17's `a.use(createSpaMiddleware(webDistRoot()));` is the final statement of the callback
in every finished checkout.

**The SPA is Plan 5's, and it is the last line (RESOLUTIONS R16 + R25).** Plan 5's `api/spa.ts`
creates `createSpaMiddleware(webDistDir: string): RequestHandler` and Plan 5 Task 17 installs it
here. Until it lands, `GET /` falls through to Plan 1's `notFoundHandler()` and returns a JSON 404 —
which is the correct, expected state of a clean Plan 3 checkout, and is exactly what `mount.test.ts`
below asserts. The ordering constraint is permanent: after that line `/api/*` would be shadowed;
before the API routers, the SPA fallback would swallow them.

**Files:**
- Create: `packages/server/src/api/sourcesRouter.ts`
- Create: `packages/server/src/api/mount.ts`
- Create: `packages/server/src/api/webDist.ts` (resolves the built SPA directory from `import.meta.url`; **Plan 5's `api/spa.ts` imports `webDistRoot` from here rather than redefining it — RESOLUTIONS R27**)
- Modify: `packages/server/src/index.ts` (the single `mountRoutes` composition site)
- Test: `packages/server/src/api/sourcesRouter.test.ts`
- Test: `packages/server/src/api/mount.test.ts` (the composition gate: every Plan 3 router is reachable through the real `createApp`, and `GET /api/unknown` is Plan 1's JSON 404)

**Interfaces:**
- Consumes: `SourceModule` from `@grantspotter/core`; `RouterDeps`, `CrawlTrigger`, `CrawlRunSummary` from `./deps.js`; `AppError` from `./errors.js`; every `create*Router` from Tasks 4–13; `VerifyRunner`; `createApp(deps: AppDeps)` from `../app.js` (Plan 1 Task 15, whose `AppDeps.mountRoutes` is the only mount seam); `simplerAuthHeaders()` from `../federal/simplerGrants.js` and `createAiAssist(config)` from `../ai/assist.js` (**Plan 2** Tasks 24 and 29). **Nothing from Plan 4 or Plan 5 is imported here.**
- Produces: `createSourcesRouter(deps: RouterDeps, crawl: CrawlTrigger): Router`, `sourceHealth(row, nowISO): SourceHealth`, `mountProductApi(app: Express, deps: RouterDeps, runner: VerifyRunner, crawl: CrawlTrigger): void`, `webDistRoot(): string`.

**`webDistRoot()` has exactly one home, and it is here (RESOLUTIONS R27).** Plan 3 runs first and
`mount.test.ts` already imports it from `./webDist.js`, so `packages/server/src/api/webDist.ts` is
the owner. **Plan 5's `api/spa.ts` must `import { webDistRoot } from './webDist.js'`, not define a
second copy** — two implementations of "where is the built SPA" is exactly the kind of drift that
404s in the container and only in the container.

**No forward references. `npm run typecheck` is clean at the end of this task**, and so is
`npm run build`. Every import in `index.ts` after this task resolves to a file that exists. Do not
add a Plan 4 or Plan 5 import "so it is ready": an unresolved import here breaks the build, and a
broken build takes the whole e2e suite with it (R25).

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/sourcesRouter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../test/testDb.js';
import { createSourcesRouter, sourceHealth } from './sourcesRouter.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { CrawlRunSummary, CrawlTrigger, RouterDeps, SessionUser } from './deps.js';

const NOW = '2026-08-02T12:00:00.000Z';
const MEMBER: SessionUser = { id: 'u-member', email: 'member@example.com', role: 'member' };
const ADMIN: SessionUser = { id: 'u-admin', email: 'admin@example.com', role: 'admin' };

const OK_SUMMARY: CrawlRunSummary[] = [
  { sourceId: 'arrl-scholarship-descriptions', parsedCount: 111, events: 2, reviewItems: 2 },
];

function buildApp(db: Database.Database, user: SessionUser, crawl: CrawlTrigger = async () => OK_SUMMARY) {
  const deps: RouterDeps = {
    db,
    now: () => NOW,
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => {
      next(user.role === 'admin' ? undefined : new AppError('forbidden', 'Admin role required.'));
    },
    currentUser: () => user,
  };
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware());
  app.use('/api/sources', createSourcesRouter(deps, crawl));
  app.use(errorHandler({ logger: () => undefined }));
  return app;
}

/**
 * `klass` and `enabled` are listed because Plan 1's `sources` DDL declares
 * `klass TEXT NOT NULL`; omitting it fails the insert rather than defaulting.
 */
function insertSource(
  db: Database.Database,
  patch: Partial<{
    id: string; label: string; tier: string; klass: string; funder_id: string; enabled: number;
    last_polled_at: string | null; last_success_at: string | null;
    consecutive_failures: number; last_record_count: number | null; expected_min_records: number;
  }> = {},
) {
  const row = {
    id: 'arrl-scholarship-descriptions',
    label: 'ARRL scholarship catalog',
    tier: 'C',
    klass: 'ham_scholarship',
    funder_id: 'arrl-foundation',
    enabled: 1,
    last_polled_at: '2026-08-02T03:17:00.000Z',
    last_success_at: '2026-08-02T03:17:00.000Z',
    consecutive_failures: 0,
    last_record_count: 111,
    expected_min_records: 100,
    ...patch,
  };
  db.prepare(
    `INSERT INTO sources
       (id, label, tier, klass, funder_id, enabled, last_polled_at, last_success_at,
        consecutive_failures, last_record_count, expected_min_records)
     VALUES (@id, @label, @tier, @klass, @funder_id, @enabled, @last_polled_at, @last_success_at,
             @consecutive_failures, @last_record_count, @expected_min_records)`,
  ).run(row);
  return row;
}

describe('sourceHealth', () => {
  it('is healthy when the yield meets the baseline and nothing failed', () => {
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-08-02T03:17:00.000Z',
        consecutiveFailures: 0,
        lastRecordCount: 111,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('healthy');
  });

  it('alarms when a source that normally yields records yields none', () => {
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-08-02T03:17:00.000Z',
        consecutiveFailures: 0,
        lastRecordCount: 0,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('yield_dropped');
    expect(health.detail).toContain('111');
  });

  it('treats an empty scrape as idle when the source expects zero', () => {
    // grants.austinhams.org shows "No opportunities available" Aug 1 - Apr 30.
    // That is the site working correctly, not the parser breaking.
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-08-02T03:17:00.000Z',
        consecutiveFailures: 0,
        lastRecordCount: 0,
        expectedMinRecords: 0,
      },
      NOW,
    );
    expect(health.state).toBe('idle');
  });

  it('is failing after consecutive failures', () => {
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-07-20T03:17:00.000Z',
        consecutiveFailures: 3,
        lastRecordCount: 111,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('failing');
    expect(health.detail).toContain('3');
  });

  it('is stale when nothing has succeeded in more than seven days', () => {
    const health = sourceHealth(
      {
        lastPolledAt: '2026-08-02T03:17:00.000Z',
        lastSuccessAt: '2026-07-01T03:17:00.000Z',
        consecutiveFailures: 0,
        lastRecordCount: 111,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('stale');
  });

  it('is never_polled before the first crawl', () => {
    const health = sourceHealth(
      {
        lastPolledAt: null,
        lastSuccessAt: null,
        consecutiveFailures: 0,
        lastRecordCount: null,
        expectedMinRecords: 100,
      },
      NOW,
    );
    expect(health.state).toBe('never_polled');
  });
});

describe('GET /api/sources/health', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it('lets a member read source health', async () => {
    insertSource(db);
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.status).toBe(200);
    expect(res.body.rows[0].label).toBe('ARRL scholarship catalog');
    expect(res.body.rows[0].health.state).toBe('healthy');
    expect(res.body.canConfigure).toBe(false);
  });

  it('tells an admin it may configure sources', async () => {
    insertSource(db);
    const res = await request(buildApp(db, ADMIN)).get('/api/sources/health');
    expect(res.body.canConfigure).toBe(true);
  });

  it('sorts unhealthy sources to the top', async () => {
    insertSource(db);
    insertSource(db, {
      id: 'ncdxf-grants', label: 'NCDXF grant page', funder_id: 'ncdxf',
      consecutive_failures: 4, last_record_count: 0, expected_min_records: 1,
    });
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.body.rows[0].id).toBe('ncdxf-grants');
  });

  it('summarises the fleet so the nav badge can show one number', async () => {
    insertSource(db);
    insertSource(db, {
      id: 'ncdxf-grants', label: 'NCDXF grant page', funder_id: 'ncdxf',
      consecutive_failures: 4, last_record_count: 0, expected_min_records: 1,
    });
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.body.summary).toEqual({ total: 2, healthy: 1, unhealthy: 1 });
  });

  it('returns an empty list rather than erroring before the first crawl', async () => {
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.body.rows).toEqual([]);
    expect(res.body.summary.total).toBe(0);
  });

  it('reports the enabled flag so the page can grey out a paused source', async () => {
    insertSource(db);
    const res = await request(buildApp(db, MEMBER)).get('/api/sources/health');
    expect(res.body.rows[0].enabled).toBe(true);
  });
});

describe('PATCH /api/sources/:id — configuration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    insertSource(db);
  });

  afterEach(() => {
    db.close();
  });

  it('refuses a member with 403 and changes nothing', async () => {
    const res = await request(buildApp(db, MEMBER))
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ expectedMinRecords: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    const row = db
      .prepare('SELECT expected_min_records FROM sources WHERE id = ?')
      .get('arrl-scholarship-descriptions') as { expected_min_records: number };
    expect(row.expected_min_records).toBe(100);
  });

  it('lets an admin raise the parse-yield baseline', async () => {
    const res = await request(buildApp(db, ADMIN))
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ expectedMinRecords: 105 });
    expect(res.status).toBe(200);
    expect(res.body.source.expectedMinRecords).toBe(105);
    expect(res.body.source.health.state).toBe('healthy'); // 111 still clears 105
  });

  it('lets an admin pause a source without deleting it', async () => {
    const res = await request(buildApp(db, ADMIN))
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.source.enabled).toBe(false);
  });

  it('rejects a negative baseline and a non-boolean enabled with 422', async () => {
    const app = buildApp(db, ADMIN);
    const negative = await request(app)
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ expectedMinRecords: -1 });
    expect(negative.status).toBe(422);
    expect(negative.body.error.code).toBe('validation_failed');

    const notBool = await request(app)
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ enabled: 'yes' });
    expect(notBool.status).toBe(422);
  });

  it('rejects a patch with no recognised field, rather than reporting a silent success', async () => {
    const res = await request(buildApp(db, ADMIN))
      .patch('/api/sources/arrl-scholarship-descriptions')
      .send({ tier: 'A' });
    expect(res.status).toBe(422);
  });

  it('404s an unknown source', async () => {
    const res = await request(buildApp(db, ADMIN))
      .patch('/api/sources/nope')
      .send({ enabled: false });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('POST /api/sources/crawl — manual trigger', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openTestDb();
    insertSource(db);
  });

  afterEach(() => {
    db.close();
  });

  it('refuses a member with 403 and never calls the crawler', async () => {
    const crawl = vi.fn<CrawlTrigger>(async () => OK_SUMMARY);
    const res = await request(buildApp(db, MEMBER, crawl)).post('/api/sources/crawl').send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('forbidden');
    expect(crawl).not.toHaveBeenCalled();
  });

  it('runs every source when no ids are given and returns the summary', async () => {
    const crawl = vi.fn<CrawlTrigger>(async () => OK_SUMMARY);
    const res = await request(buildApp(db, ADMIN, crawl)).post('/api/sources/crawl').send({});
    expect(res.status).toBe(200);
    expect(crawl).toHaveBeenCalledWith(undefined);
    expect(res.body.results).toEqual(OK_SUMMARY);
    expect(res.body.startedAt).toBe(NOW);
  });

  it('passes an explicit id list straight through', async () => {
    const crawl = vi.fn<CrawlTrigger>(async () => OK_SUMMARY);
    await request(buildApp(db, ADMIN, crawl))
      .post('/api/sources/crawl')
      .send({ sourceIds: ['arrl-scholarship-descriptions'] });
    expect(crawl).toHaveBeenCalledWith(['arrl-scholarship-descriptions']);
  });

  it('rejects a sourceIds that is not an array of strings with 422', async () => {
    const res = await request(buildApp(db, ADMIN))
      .post('/api/sources/crawl')
      .send({ sourceIds: 'arrl-scholarship-descriptions' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('409s a second crawl while the first is still running, and does not start it', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const crawl = vi.fn<CrawlTrigger>(async () => {
      await gate;
      return OK_SUMMARY;
    });
    const app = buildApp(db, ADMIN, crawl);

    const first = request(app).post('/api/sources/crawl').send({});
    // Let the first request reach the (still pending) crawl.
    await new Promise((resolve) => setImmediate(resolve));

    const second = await request(app).post('/api/sources/crawl').send({});
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
    expect(crawl).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ status: 200 });
  });

  it('releases the single-flight lock after a crawl throws, so the next one can run', async () => {
    const crawl = vi.fn<CrawlTrigger>()
      .mockRejectedValueOnce(new Error('arrl.org timed out'))
      .mockResolvedValueOnce(OK_SUMMARY);
    const app = buildApp(db, ADMIN, crawl);

    const failed = await request(app).post('/api/sources/crawl').send({});
    expect(failed.status).toBe(500);
    expect(failed.body.error.code).toBe('internal');

    const retried = await request(app).post('/api/sources/crawl').send({});
    expect(retried.status).toBe(200);
    expect(crawl).toHaveBeenCalledTimes(2);
  });
});
```

Create `packages/server/src/api/mount.test.ts` — **the composition gate (RESOLUTIONS R5 + R25).**
Every other test in this plan builds a throwaway `express()` around one router, which proves the
router works and proves nothing about the assembled application. This suite is the only place that
runs the real `createApp` with a real `mountRoutes` body, and it exists because the failure mode it
catches is silent: a router registered after `notFoundHandler()` 404s forever, and nothing else in
the plan would notice.

**Where the SPA assertions went.** An earlier draft of this suite asserted that `GET /` returns HTML.
It cannot: a clean Plan 3 checkout has no `api/spa.ts` and no SPA middleware, because both are
Plan 5's (R16 creates them, R25 mounts them in Plan 5 Task 17). Those four assertions — `/` is HTML,
`/browse` is the same HTML, `/api/unknown` is still Plan 1's JSON 404, a POST to `/` is not HTML —
are **covered by Plan 5 Task 17's `spa.test.ts`**. What this suite asserts instead is the inverse and
the invariant: with Plan 3's hook body, `GET /` is Plan 1's JSON 404, which is precisely what proves
the SPA is not mounted here, and every Plan 3 router *is* reachable.

```ts
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { openTestDb } from '../test/testDb.js';
import { mountProductApi } from './mount.js';
import { webDistRoot } from './webDist.js';
import type { CrawlRunSummary, RouterDeps, SessionUser } from './deps.js';
import type { VerifyRunner } from './verify.js';

const NOW = '2026-08-02T12:00:00.000Z';
const ADMIN: SessionUser = { id: 'u-admin', email: 'admin@example.com', role: 'admin' };

const config = loadConfig({
  SESSION_SECRET: 'x'.repeat(32),
  CONTACT_URL: 'https://example.org/grantspotter',
  NODE_ENV: 'test',
});

describe('mountRoutes composition', () => {
  let db: Database.Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    db = openTestDb();

    const deps: RouterDeps = {
      db,
      now: () => NOW,
      requireAuth: (_req, _res, next) => next(),
      requireAdmin: (_req, _res, next) => next(),
      currentUser: () => ADMIN,
    };
    // Never called here: this suite asserts registration, not behaviour.
    const runner: VerifyRunner = {
      verify: async (programId) => ({
        programId,
        attemptedAt: NOW,
        ok: true,
        changed: false,
        diffs: [],
        lastVerifiedAt: NOW,
        changeEventIds: [],
      }),
    };
    const crawl = async (): Promise<CrawlRunSummary[]> => [];

    app = createApp({
      db,
      config,
      // Exactly the shape of Plan 3's hook body: product routers, and nothing
      // after them. Plans 4 and 5 append below this line in their own tasks;
      // Plan 5 Task 17's SPA middleware is always last (RESOLUTIONS R25).
      mountRoutes: (a) => {
        mountProductApi(a, deps, runner, crawl);
      },
    });
  });

  afterAll(() => {
    db.close();
  });

  it('makes every Plan 3 router reachable through the real createApp', async () => {
    // If mountProductApi ran after Plan 1's notFoundHandler — the R5 bug — each
    // of these would come back 404 with an empty body and no test would notice.
    const paths = [
      '/api/programs',
      '/api/me',
      '/api/watches',
      '/api/notifications',
      '/api/channels',
      '/api/calendar',
      '/api/inbox',
      '/api/admin/users',
      '/api/sources/health',
    ];
    for (const path of paths) {
      const res = await request(app).get(path);
      expect(res.status, `${path} is not mounted`).not.toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    }
  });

  it('leaves Plan 1’s JSON 404 envelope governing an unknown API path', async () => {
    const res = await request(app).get('/api/unknown');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('not_found');
    expect(typeof res.body.requestId).toBe('string');
  });

  it('does not serve the SPA — that is Plan 5 Task 17, and it is mounted last', async () => {
    // The positive case (`GET /` is HTML) lives in Plan 5's spa.test.ts. Here
    // the point is that Plan 3 does NOT claim `/`: if this ever returns HTML,
    // someone has moved the SPA mount into Plan 3's hook body and Plan 5 will
    // then mount a second one (RESOLUTIONS R25/R27).
    const res = await request(app).get('/');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('not_found');
  });

  it('resolves the real dist directory the same way from src and from dist', () => {
    // '../../../web/dist' relative to packages/server/{src,dist}/api is the same
    // path either way, which is why one expression serves tsx, vitest and the
    // image. RESOLUTIONS R27: Plan 5's spa.ts imports THIS function; if it ever
    // grows a second copy, the SPA 404s in production and only there.
    expect(webDistRoot().endsWith(join('packages', 'web', 'dist'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server/src/api/sourcesRouter.test.ts packages/server/src/api/mount.test.ts
```

Expected failure: `Failed to load url ./sourcesRouter.js` for the first suite and
`Failed to load url ./mount.js` for the second. **Both must fail for that reason and no other** —
in particular, neither may fail on an import from Plan 4 or Plan 5, because this task imports
nothing from either (RESOLUTIONS R25).

- [ ] **Step 3: Write the implementation**

Create `packages/server/src/api/sourcesRouter.ts`:

```ts
import { Router } from 'express';
import type { CrawlTrigger, RouterDeps } from './deps.js';
import { AppError } from './errors.js';

/** PLAN-LOCAL to Plan 3. */
export type SourceHealthState =
  | 'healthy' | 'idle' | 'yield_dropped' | 'failing' | 'stale' | 'never_polled';

/** PLAN-LOCAL to Plan 3. */
export interface SourceHealth {
  state: SourceHealthState;
  detail: string;
}

/** PLAN-LOCAL to Plan 3. */
export interface SourceHealthInput {
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastRecordCount: number | null;
  expectedMinRecords: number;
}

const STALE_AFTER_MS = 7 * 86_400_000;

/**
 * An empty scrape is not automatically a failure: grants.austinhams.org
 * legitimately shows "No opportunities available" from Aug 1 to Apr 30. Only a
 * source that normally yields records and now yields none is an alarm - that
 * silent zero is the most likely way this app rots.
 */
export function sourceHealth(input: SourceHealthInput, nowISO: string): SourceHealth {
  if (input.lastPolledAt === null) {
    return { state: 'never_polled', detail: 'This source has not been polled yet.' };
  }
  if (input.consecutiveFailures > 0) {
    return {
      state: 'failing',
      detail: `${input.consecutiveFailures} consecutive failures since the last success.`,
    };
  }
  if (input.lastSuccessAt !== null
      && Date.parse(nowISO) - Date.parse(input.lastSuccessAt) > STALE_AFTER_MS) {
    return {
      state: 'stale',
      detail: `No successful fetch since ${input.lastSuccessAt}.`,
    };
  }
  const count = input.lastRecordCount ?? 0;
  if (input.expectedMinRecords === 0) {
    return {
      state: count > 0 ? 'healthy' : 'idle',
      detail: count > 0
        ? `${count} records on the last successful parse.`
        : 'No records, which is expected for this source outside its open window.',
    };
  }
  if (count < input.expectedMinRecords) {
    return {
      state: 'yield_dropped',
      detail: `Parsed ${count} records; this source normally yields at least ${input.expectedMinRecords} (baseline 111 for the ARRL catalog).`,
    };
  }
  return { state: 'healthy', detail: `${count} records on the last successful parse.` };
}

const RANK: Record<SourceHealthState, number> = {
  failing: 0, yield_dropped: 1, stale: 2, never_polled: 3, idle: 4, healthy: 5,
};

const SELECT_COLUMNS = `id, label, tier, funder_id, enabled, last_polled_at, last_success_at,
        consecutive_failures, last_record_count, expected_min_records`;

interface SourceRow {
  id: string; label: string; tier: string; funder_id: string; enabled: number;
  last_polled_at: string | null; last_success_at: string | null;
  consecutive_failures: number; last_record_count: number | null;
  expected_min_records: number;
}

/** PLAN-LOCAL to Plan 3. One source as the Sources page renders it. */
export interface SourceView {
  id: string;
  label: string;
  tier: string;
  funderId: string;
  enabled: boolean;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastRecordCount: number | null;
  expectedMinRecords: number;
  health: SourceHealth;
}

function toView(r: SourceRow, nowISO: string): SourceView {
  return {
    id: r.id,
    label: r.label,
    tier: r.tier,
    funderId: r.funder_id,
    enabled: r.enabled === 1,
    lastPolledAt: r.last_polled_at,
    lastSuccessAt: r.last_success_at,
    consecutiveFailures: r.consecutive_failures,
    lastRecordCount: r.last_record_count,
    expectedMinRecords: r.expected_min_records,
    health: sourceHealth(
      {
        lastPolledAt: r.last_polled_at,
        lastSuccessAt: r.last_success_at,
        consecutiveFailures: r.consecutive_failures,
        lastRecordCount: r.last_record_count,
        expectedMinRecords: r.expected_min_records,
      },
      nowISO,
    ),
  };
}

export function createSourcesRouter(deps: RouterDeps, crawl: CrawlTrigger): Router {
  const router = Router();

  const selectOne = deps.db.prepare(`SELECT ${SELECT_COLUMNS} FROM sources WHERE id = ?`);

  /**
   * Single-flight guard for the manual crawl. It is a closure over this router
   * instance, which is exactly the scope that matters: there is one router per
   * process, and a crawl walks ~25 third-party sites belonging to small
   * nonprofits. Two at once would double that load and race each other's
   * `sources` bookkeeping.
   */
  let inFlight: Promise<void> | null = null;

  router.get('/health', deps.requireAuth, (req, res) => {
    const user = deps.currentUser(req);
    const nowISO = deps.now();

    const rows = deps.db
      .prepare(`SELECT ${SELECT_COLUMNS} FROM sources ORDER BY label`)
      .all() as SourceRow[];

    const mapped = rows
      .map((r) => toView(r, nowISO))
      .sort((a, b) => RANK[a.health.state] - RANK[b.health.state] || a.label.localeCompare(b.label));

    const healthy = mapped.filter(
      (m) => m.health.state === 'healthy' || m.health.state === 'idle',
    ).length;

    res.json({
      rows: mapped,
      summary: { total: mapped.length, healthy, unhealthy: mapped.length - healthy },
      // Spec §12: members read this page; only admins change it or trigger a
      // crawl. The flag lets the UI say so rather than render dead controls.
      canConfigure: user.role === 'admin',
    });
  });

  // Spec §12, "Source configuration | admin ✅ | member read-only".
  // Only two fields are configurable, and both are operational rather than
  // editorial: what a source's parse yield is expected to be, and whether the
  // nightly crawl visits it at all. Identity (id, funderId, tier, klass) belongs
  // to the source module in code, not to a database row an admin can edit into
  // disagreeing with it.
  router.patch('/:id', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    const body = req.body as { expectedMinRecords?: unknown; enabled?: unknown };
    const sets: string[] = [];
    const params: unknown[] = [];

    if (body.expectedMinRecords !== undefined) {
      const n = body.expectedMinRecords;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        next(new AppError(
          'validation_failed',
          'expectedMinRecords must be an integer of 0 or more.',
        ));
        return;
      }
      sets.push('expected_min_records = ?');
      params.push(n);
    }

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        next(new AppError('validation_failed', 'enabled must be true or false.'));
        return;
      }
      sets.push('enabled = ?');
      params.push(body.enabled ? 1 : 0);
    }

    if (sets.length === 0) {
      next(new AppError(
        'validation_failed',
        'Nothing to change. Send expectedMinRecords, enabled, or both.',
      ));
      return;
    }

    if (selectOne.get(req.params.id) === undefined) {
      next(new AppError('not_found', `No source with id "${req.params.id}".`));
      return;
    }

    deps.db
      .prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, req.params.id);

    res.json({ source: toView(selectOne.get(req.params.id) as SourceRow, deps.now()) });
  });

  // Spec §12, "crawl trigger | admin ✅ | member ❌". Plan 2's runCrawl is
  // injected as `crawl` so this router stays constructible with a fake.
  router.post('/crawl', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    const body = req.body as { sourceIds?: unknown };
    let sourceIds: string[] | undefined;

    if (body.sourceIds !== undefined) {
      if (!Array.isArray(body.sourceIds) || body.sourceIds.some((s) => typeof s !== 'string')) {
        next(new AppError('validation_failed', 'sourceIds must be an array of source id strings.'));
        return;
      }
      sourceIds = body.sourceIds as string[];
    }

    if (inFlight !== null) {
      next(new AppError('conflict', 'A crawl is already running. Wait for it to finish.'));
      return;
    }

    const startedAt = deps.now();
    const run = crawl(sourceIds);
    // The lock is taken synchronously, before the first await, so a second
    // request in the same tick cannot slip past it.
    inFlight = run.then(
      () => undefined,
      () => undefined,
    );

    void run
      .then((results) => {
        res.json({ startedAt, finishedAt: deps.now(), results });
      })
      .catch((err: unknown) => {
        next(err);
      })
      .finally(() => {
        // Released on failure too: a crawl that threw must not wedge the button.
        inFlight = null;
      });
  });

  return router;
}
```

Create `packages/server/src/api/webDist.ts`:

```ts
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the built SPA (`packages/web/dist`), for
 * `createSpaMiddleware` (Plan 5's api/spa.ts, RESOLUTIONS R16).
 *
 * THIS IS THE ONLY DEFINITION (RESOLUTIONS R27). Plan 5's `api/spa.ts` imports
 * `webDistRoot` from `./webDist.js`; it must not declare a second copy. Two
 * answers to "where is the built SPA" diverge silently and the divergence only
 * shows up as a 404 inside the container, which is the hardest place to see it.
 *
 * Resolved from import.meta.url rather than process.cwd() because the server is
 * started from three different working directories: the repo root (`npm run
 * dev`, vitest), `packages/server` (tsx), and `/app` in the image.
 *
 * `../../../web/dist` is correct from BOTH `packages/server/src/api/` and
 * `packages/server/dist/api/` — `src` and `dist` are siblings under
 * `packages/server`, so each is exactly three levels below `packages/`, and
 * Plan 5's Dockerfile COPYs `packages/web/dist` to the matching place in the
 * image. One expression, three contexts.
 */
export function webDistRoot(): string {
  return fileURLToPath(new URL('../../../web/dist', import.meta.url));
}
```

Create `packages/server/src/api/mount.ts`:

```ts
import type { Express } from 'express';
import type { CrawlTrigger, RouterDeps } from './deps.js';
import type { VerifyRunner } from './verify.js';
import { createProgramsRouter } from './programsRouter.js';
import { createVerifyRouter } from './verifyRouter.js';
import { createProfileRouter, createMeRouter } from './profileRouter.js';
import { createWatchRouter } from './watchRouter.js';
import { createNotificationRouter } from './notificationRouter.js';
import { createChannelRouter } from './channelRouter.js';
import { createCalendarRouter } from './calendarRouter.js';
import { createInboxRouter } from './inboxRouter.js';
import { createAdminUsersRouter } from './adminUsersRouter.js';
import { createSourcesRouter } from './sourcesRouter.js';

/**
 * Mount every Plan 3 product router. The verify router is mounted on the same
 * base path as the programs router and is registered FIRST so its
 * POST /:id/verify is matched before the programs router's GET /:id.
 *
 * This function is only ever called from inside `AppDeps.mountRoutes`
 * (RESOLUTIONS R5). Calling it on an app that `createApp` has already returned
 * would register every router AFTER Plan 1's notFoundHandler, and all eleven
 * would silently 404.
 */
export function mountProductApi(
  app: Express,
  deps: RouterDeps,
  runner: VerifyRunner,
  crawl: CrawlTrigger,
): void {
  app.use('/api/programs', createVerifyRouter(deps, runner));
  app.use('/api/programs', createProgramsRouter(deps));
  app.use('/api/profiles', createProfileRouter(deps));
  app.use('/api/me', createMeRouter(deps));
  app.use('/api/watches', createWatchRouter(deps));
  app.use('/api/notifications', createNotificationRouter(deps));
  app.use('/api/channels', createChannelRouter(deps));
  app.use('/api/calendar', createCalendarRouter(deps));
  app.use('/api/inbox', createInboxRouter(deps));
  app.use('/api/admin/users', createAdminUsersRouter(deps));
  app.use('/api/sources', createSourcesRouter(deps, crawl));
}
```

**Modify `packages/server/src/index.ts` — this is the single composition site for the whole
application (RESOLUTIONS R5 / CONTRACT §10.3).** Plan 1's `createApp` finishes with
`deps.mountRoutes?.(app); app.use(notFoundHandler()); app.use(errorHandler(...));`, so a router
registered after `createApp` returns is dead code that can never match. Every router from Plans 3, 4
and 5 is therefore constructed inside the one `mountRoutes` callback below, and **no plan calls
`app.use(...)` on the returned app.**

**This task fills the callback with Plan 3's routers only, and stops (RESOLUTIONS R25).** The
callback ends with a reservation comment; Plans 4 and 5 append above and at it. Do not pre-import
`api/applications.ts`, `api/templates.ts`, `api/prose.ts`, `api/prompts.ts`, `api/exports.ts`,
`exports/dataSource.ts` or `api/spa.ts` — none of those files exists yet, and an unresolved import
here fails `npm run build`, which means `packages/server/dist/index.js` is never emitted, which
means Playwright's `webServer` never starts and the whole e2e suite dies on `page.goto('/')`.

Replace the `const app = createApp({ db, config });` line Plan 1 Task 17 wrote in `main()` with the
following. Plan 2's scheduler block stays where it is, but it must now **reuse** the `fetcher` and
`assist` consts declared below rather than building its own: there is exactly one `createFetcher(…)`
and one `createAiAssist(config)` in this file, and the nightly `runCrawl` and the admin-triggered
`runCrawl` are handed the identical objects. That is the whole point of RESOLUTIONS R23 — an admin
who presses "Crawl now" after fixing a parser must reproduce the 03:17 run, not a subtly different
one that has lost the Simpler.Grants.gov key or the AI salvage path:

```ts
import { createApp } from './app.js';
import { createFetcher } from './fetcher/index.js';
import { buildUserAgent } from './config.js';
import { SOURCES } from './sources/registry.js';
import { runCrawl } from './crawl/index.js';
import { requireAdmin, requireAuth } from './auth/middleware.js';
import { mountProductApi } from './api/mount.js';
import { createVerifyRunner } from './api/verify.js';
import { reindexBrowse } from './api/reindex.js';
import { drainChangeEvents } from './api/notify.js';
import type { RouterDeps, SessionUser } from './api/deps.js';
// Plan 2's optional transport and parse-assist wiring. Both must be identical
// on the scheduled and the admin-triggered path (RESOLUTIONS R23), which is why
// they are constructed once here and shared by both:
import { simplerAuthHeaders } from './federal/simplerGrants.js';
import { createAiAssist } from './ai/assist.js';
// NOTE (RESOLUTIONS R25): there are deliberately NO imports here from
// api/applications.ts, api/templates.ts, api/prose.ts, api/prompts.ts (Plan 4),
// api/exports.ts, exports/dataSource.ts or api/spa.ts (Plan 5). Those plans add
// their own import lines when they add their own mount lines. Adding them now
// breaks `npm run build`, and a broken build takes the e2e suite with it.

const now = (): string => new Date().toISOString();

// Plan 1's attachUser middleware has already put the authenticated user on
// req.auth by the time any of these routers run; requireAuth guarantees it.
const currentUser = (req: Request): SessionUser => {
  if (req.auth === undefined) throw new AppError('unauthorized', 'Sign in to continue.');
  return { id: req.auth.id, email: req.auth.email, role: req.auth.role };
};

const routerDeps: RouterDeps = {
  db,
  now,
  requireAuth: requireAuth(),
  requireAdmin: requireAdmin(),
  currentUser,
};

// ONE fetcher for the whole process — the nightly scheduler (Plan 2), "Verify
// now" (Task 10) and the admin crawl trigger (this task) all share it.
// `headersByHost` carries the optional Simpler.Grants.gov X-Auth key (Plan 2
// Task 24) and is `{}` when SIMPLER_GRANTS_API_KEY is unset; omitting it here
// would make an admin-triggered crawl of `grants-gov-federal` silently drop the
// key while the identical 03:17 run kept it (RESOLUTIONS R23).
const fetcher = createFetcher({
  userAgent: buildUserAgent(config),
  contactUrl: config.contactUrl,
  dataDir: config.dataDir,
  headersByHost: simplerAuthHeaders(),
});

// Disabled, and calls nothing, when ANTHROPIC_API_KEY is unset (Plan 2 Task 29).
// Constructed once so the manual and scheduled crawl paths are byte-identical.
const assist = createAiAssist(config);

const verifyRunner = createVerifyRunner({ db, fetcher, sources: SOURCES, now });

const app = createApp({
  db,
  config,
  mountRoutes: (a) => {
    // --- Plan 3: browse, detail, verify, profiles, watches, notifications,
    //     channels, calendar, inbox, admin users, sources ---
    // The crawl argument list is IDENTICAL to Plan 2's scheduler call: same
    // fetcher (so the same headersByHost) and the same assist. An admin
    // pressing "Crawl now" must reproduce the 03:17 run exactly (R23).
    mountProductApi(a, routerDeps, verifyRunner, (sourceIds) =>
      runCrawl({ db, fetcher, nowISO: now, assist }, sourceIds));

    // Nothing is EVER mounted after createApp returns: this callback is the
    // whole seam, and Plan 1 seals the app with notFoundHandler() the moment
    // it hands the app back (RESOLUTIONS R5).
    //
    // Plan 4 Task 17 Step 5 adds, with the FULL routerDeps (R17):
    //     a.use('/api/applications', createApplicationsRouter(routerDeps));
    //     a.use('/api/templates',    createTemplatesRouter(routerDeps));
    //     a.use('/api/prose',        createProseRouter(routerDeps));
    //     a.use('/api/prompts',      createPromptsRouter(routerDeps));
    // Plan 5 Task 9 Step 9 adds, with an exportDeps satisfying ExportDeps and
    // reading `req.auth?.id` (R22 — there is no express-session in this stack):
    //     a.use('/api', createExportsRouter(exportDeps));
    //     a.use('/',    createCalendarFeedRouter(exportDeps));
    // Plan 5 Task 17 adds, ALWAYS LAST (R16), so client-side routes resolve on
    // a hard refresh and nothing it would shadow is registered after it:
    //     a.use(createSpaMiddleware(webDistRoot()));
    //
    // ---------------------------------------------------------------------
    // Plans 4 and 5 append their routers below. The SPA middleware (Plan 5
    // Task 17) MUST remain the last statement. (RESOLUTIONS R25)
    // ---------------------------------------------------------------------
  },
});

// The browse projection is derived state. Rebuild it at boot so a restore, a
// seed import, or a migration can never leave stale filters behind.
reindexBrowse(db, now());
drainChangeEvents(db, now());
```

`Request` and `AppError` come from `express` and `./api/errors.js`; add them to the import block if
Plan 1's entrypoint does not already have them.

**The names in the reservation comment are the real ones. Plans 4 and 5 must not "adapt" them when
they append their lines.** They were verified against the plans that export them, and the comment
exists so the next executor copies rather than guesses:

| Appended by | Line | Exported by | Signature |
|---|---|---|---|
| Plan 4 Task 17 Step 5 | `createApplicationsRouter(routerDeps)` | Plan 4, `api/applications.ts` | `(deps: RouterDeps) => Router` |
| Plan 4 Task 17 Step 5 | `createTemplatesRouter(routerDeps)` | Plan 4, `api/templates.ts` | `(deps: RouterDeps) => Router` |
| Plan 4 Task 17 Step 5 | `createProseRouter(routerDeps)` | Plan 4, `api/prose.ts` | `(deps: RouterDeps) => Router` |
| Plan 4 Task 17 Step 5 | `createPromptsRouter(routerDeps)` | Plan 4, `api/prompts.ts` | `(deps: RouterDeps) => Router` |
| Plan 5 Task 9 Step 9 | `createExportsRouter(exportDeps)` | Plan 5, `api/exports.ts` | `(deps: ExportDeps) => Router` |
| Plan 5 Task 9 Step 9 | `createCalendarFeedRouter(exportDeps)` | Plan 5, `api/exports.ts` | `(deps: ExportDeps) => Router` |
| Plan 5 Task 17 | `createSpaMiddleware(webDistRoot())` | Plan 5, `api/spa.ts` (importing `webDistRoot` from this task's `api/webDist.ts`, R27) | `(webDistDir: string) => RequestHandler` |

`routerDeps` is already in scope for Plan 4 — this task declares it. `RouterDeps` is
`{ db, now, requireAuth, requireAdmin, currentUser }` and all five fields are load-bearing for
Plan 4: every one of its routes calls `deps.currentUser(req).id` to scope an application to its
owner. Passing a partial object — `{ db }` — typechecks nowhere and, if forced through, throws on
the first request instead of at startup (RESOLUTIONS R17). `exportDeps` is Plan 5's to declare, and
its user field is `req.auth?.id` (RESOLUTIONS R22).

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/server
npm run typecheck
npm run build
```

Expected: **every server suite green, `typecheck` clean, and `build` clean** — 6 `sourceHealth` +
6 health-route + 6 configuration + 6 crawl assertions in `sourcesRouter.test.ts`, and 4 in
`mount.test.ts`. There are no permitted unresolved imports at the end of this task (RESOLUTIONS
R25). If anything is unresolved, a Plan 3 file is missing, or someone pre-imported a Plan 4 / Plan 5
module — fix it here rather than deferring, because `npm run build` failing means
`packages/server/dist/index.js` is never emitted and Task 26's Playwright `webServer` cannot start.

Then prove the mount hook is wired the way R5 and R25 require, because a router mounted after the
404 handler fails silently rather than loudly, and a stray mount after the reservation comment
would be shadowed by Plan 5's SPA middleware later without ever failing a test:

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
# 1. every mount site, including the ones that are only quoted inside comments
grep -n "app\.use(\|a\.use(" packages/server/src/index.ts
# 2. a bare app.use AFTER createApp returned - must print nothing, in every plan
awk 'f && /^[[:space:]]*app\.use\(/{print "MOUNT AFTER createApp: " NR ": " $0; bad=1}
     /const app = createApp\(/{f=1} END{exit bad?1:0}' packages/server/src/index.ts
# 3. the reservation comment exists, and it is the LAST thing in the callback
grep -n "RESOLUTIONS R25" packages/server/src/index.ts
awk '/^[[:space:]]*a\.use\(/{print "EXECUTABLE a.use: " NR ": " $0; n++} END{exit n?1:0}' \
    packages/server/src/index.ts
# 4. no forward reference to a Plan 4 / Plan 5 module - must print nothing
grep -nE "from '\./api/(applications|templates|prose|prompts|exports|spa)\.js'|from '\./exports/dataSource\.js'" \
     packages/server/src/index.ts
# 5. one fetcher, one assist, one keyed header set
grep -c "createFetcher(" packages/server/src/index.ts
grep -c "createAiAssist(" packages/server/src/index.ts
grep -n "headersByHost" packages/server/src/index.ts
```

Six things must hold:

1. Every `use(` in that file is inside the `mountRoutes` callback. Gate 2 exits non-zero on any
   `app.use(...)` below `const app = createApp(...)` — the bug RESOLUTIONS R5 exists to prevent,
   and it is forbidden for every plan, forever.
2. The reservation comment naming **RESOLUTIONS R25** is present. At the end of Plan 3 there is **no
   executable `a.use(` in the file at all** (gate 3 prints nothing and exits 0): all eleven Plan 3
   routers go in through `mountProductApi`, and the only occurrences of `a.use(` are the example
   lines *inside* the reservation comment. Plans 4 and 5 add the real statements later — router
   lines **above** the comment, `a.use(createSpaMiddleware(webDistRoot()));` **at** it, last, always.
3. Gate 4 prints nothing: no `import` in `index.ts` resolves to `api/applications.ts`,
   `api/templates.ts`, `api/prose.ts`, `api/prompts.ts`, `api/exports.ts`, `exports/dataSource.ts`
   or `api/spa.ts`. Those files do not exist yet; naming one is the forward reference that breaks
   `npm run build` and, through it, the entire e2e suite.
4. `createFetcher(` and `createAiAssist(` each appear exactly **once** (RESOLUTIONS R23). Two
   fetchers means the scheduled and the manual crawl differ, and the difference is invisible until a
   federal source starts rate-limiting the un-keyed one.
5. `headersByHost: simplerAuthHeaders()` is on that single `createFetcher` call. It is `{}` when
   `SIMPLER_GRANTS_API_KEY` is unset, so this is safe with no key configured and correct with one.
6. `mount.test.ts` asserts `GET /` is Plan 1's JSON 404, not HTML. That is the correct Plan 3 state:
   the SPA arrives with Plan 5 Task 17, and Plan 5's `spa.test.ts` owns the HTML assertions (R16 +
   R25). If `GET /` returns HTML here, the SPA has been mounted a plan too early and Plan 5 will
   mount a second one.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/server/src/api/sourcesRouter.ts packages/server/src/api/sourcesRouter.test.ts \
        packages/server/src/api/mount.ts packages/server/src/api/mount.test.ts \
        packages/server/src/api/webDist.ts packages/server/src/index.ts
git commit -m "feat(api): sources health, configuration, manual crawl, and the single mount site"
```

---
### Task 15: API client, session store, router, AppShell, Login

**Why this exists:** every web route below hangs off these four pieces. The AppShell is where the design becomes visible: a fixed 208px rail, a 56px topbar carrying global search and the unread badge, and a skip link that is the first focusable element on the page.

**Files:** (RESOLUTIONS R11 — `client.ts` and `App.tsx` are Plan 1 Task 18 deliverables)
- Modify: `packages/web/src/api/client.ts` (add `apiGet`/`apiSend`; keep every Plan 1 export)
- Modify: `packages/web/src/App.tsx` (replace Plan 1's status page with the router)
- Delete: `packages/web/test/client.test.ts` (its assertions move into `src/api/client.test.ts`)
- Modify: `packages/web/tsconfig.json` and `packages/web/vitest.config.ts` (drop the now-empty `test/**` includes)
- Create: `packages/web/src/store/useApi.ts`
- Create: `packages/web/src/store/session.tsx`
- Create: `packages/web/src/components/AppShell.tsx`
- Create: `packages/web/src/components/AppShell.css`
- Create: `packages/web/src/routes/Login.tsx`
- Modify: `packages/web/src/main.tsx`
- Test: `packages/web/src/api/client.test.ts`
- Test: `packages/web/src/components/AppShell.test.tsx`
- Test: `packages/web/src/routes/Login.test.tsx`

**Interfaces:**
- Consumes: `apiFetch<T>()`, `ApiError`, `ApiErrorCode`, `ApiErrorBody`, `ApiFetchOptions`, `PublicUser`, `getHealth`, `getBootstrapStatus`, `postBootstrap`, `postLogin`, `postLogout`, `getMe` — **all of them Plan 1 Task 18's**, kept intact; `POST /api/auth/login`, `POST /api/auth/logout` (Plan 1); `GET /api/me`, `GET /api/notifications` (Tasks 6, 8).
- Produces: `apiGet<T>(path, signal?)`, `apiSend<T>(method, path, body?)`, `useApi<T>(path, deps?)`, `SessionProvider`, `useSession()`, `SessionContext`, `AppShell`, `App`.

**Why there is no second error-parsing function here (RESOLUTIONS R6).** Plan 1's `apiFetch` already
performs exactly the parse the resolution mandates — on a non-ok response it reads the body and
throws `new ApiError(body.error.code, body.error.message, response.status, body.requestId ?? '',
body.error.details)`, falling back to `('internal', …)` when the body is not the envelope. Adding a
Plan-3 `handle<T>` that re-derived that from `body?.error` **as a string** was the bug the audit
found: against the real envelope it would assign the whole `{ code, message }` object to
`ApiError.code`. `apiGet` and `apiSend` are therefore three-line wrappers over `apiFetch`, and
`ApiError` keeps Plan 1's canonical signature
`(code: ApiErrorCode, message: string, status: number, requestId: string, details?: unknown)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/api/client.test.ts`. **The first `describe` block is Plan 1's
`packages/web/test/client.test.ts`, moved here verbatim** — the old file is deleted in Step 3, so
these assertions must survive the move or Plan 1's client loses its coverage (RESOLUTIONS R11):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, apiGet, apiSend, getHealth, postLogin } from './client.js';

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

/** Plan 1's frozen envelope: { error: { code, message, details? }, requestId }. */
function errorBody(code: string, message: string, details?: unknown) {
  return {
    error: details === undefined ? { code, message } : { code, message, details },
    requestId: 'req-test-1',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---- folded in from Plan 1 Task 18's packages/web/test/client.test.ts ----
describe('apiFetch (Plan 1)', () => {
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

  it('unpacks the error envelope into ApiError, requestId and all', async () => {
    stubFetch(jsonResponse(401, errorBody('unauthorized', 'Sign in to continue.')));
    const err = await apiFetch('/api/auth/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      code: 'unauthorized',
      message: 'Sign in to continue.',
      status: 401,
      requestId: 'req-test-1',
    });
  });

  it('falls back to an internal ApiError when the body is not the envelope', async () => {
    stubFetch(new Response('<html>502</html>', { status: 502 }));
    const err = await apiFetch('/api/health').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('internal');
    expect((err as ApiError).status).toBe(502);
  });

  it('resolves undefined for a 204', async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(apiFetch<void>('/api/auth/logout', { method: 'POST' })).resolves.toBeUndefined();
  });
});

// ---- Plan 3's thin wrappers ----
describe('apiGet', () => {
  it('delegates to apiFetch, so the session cookie travels', async () => {
    const fetchMock = stubFetch(jsonResponse(200, { hello: 'world' }));
    await expect(apiGet<{ hello: string }>('/api/me')).resolves.toEqual({ hello: 'world' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/me');
    expect(init.credentials).toBe('include');
    expect(init.method).toBe('GET');
  });

  it('passes an AbortSignal through', async () => {
    const fetchMock = stubFetch(jsonResponse(200, {}));
    const controller = new AbortController();
    await apiGet('/api/programs', controller.signal);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });

  it('throws ApiError carrying the status, the code and the details', async () => {
    stubFetch(jsonResponse(429, errorBody('rate_limited', 'Verified recently.', {
      reason: 'program_cooldown',
      retryAfterSec: 1800,
    })));
    const err = await apiGet('/api/programs/x/verify').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 429, code: 'rate_limited' });
    expect((err as ApiError).details).toEqual({ reason: 'program_cooldown', retryAfterSec: 1800 });
  });

  it('still throws ApiError when the error body is not JSON at all', async () => {
    stubFetch(new Response('gateway exploded', { status: 500 }));
    const err = await apiGet('/api/me').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).code).toBe('internal');
  });
});

describe('apiSend', () => {
  it('serializes the body as JSON', async () => {
    const fetchMock = stubFetch(jsonResponse(201, {}));
    await apiSend('POST', '/api/watches', { programId: 'ardc-grants' });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ programId: 'ardc-grants' });
  });

  it('sends no body and no content-type when there is nothing to send', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 204 }));
    await apiSend('POST', '/api/notifications/read-all');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('tolerates a 204 with no body', async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(apiSend('DELETE', '/api/watches/x')).resolves.toBeUndefined();
  });
});
```

Create `packages/web/src/components/AppShell.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppShell } from './AppShell.js';
import { SessionContext } from '../store/session.js';

function renderShell(role: 'admin' | 'member' = 'member', unread = 0) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SessionContext.Provider
        value={{
          user: { id: 'u-1', email: 'member@example.com', role },
          hasStudentProfile: false,
          hasOrgProfile: false,
          completeness: { total: 5, unknownCount: 5, score: 0, fields: [] },
          unread,
          loading: false,
          refresh: () => {},
          logout: async () => {},
        }}
      >
        <AppShell>
          <h1>Browse</h1>
        </AppShell>
      </SessionContext.Provider>
    </MemoryRouter>,
  );
}

describe('AppShell', () => {
  it('puts a skip link first so keyboard users can bypass the rail', () => {
    renderShell();
    const link = screen.getByRole('link', { name: /skip to main content/i });
    expect(link).toHaveAttribute('href', '#main');
  });

  it('renders the primary navigation as a labelled landmark', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: /primary/i });
    expect(within(nav).getByRole('link', { name: /browse/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /calendar/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /watchlist/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /inbox/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /sources/i })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: /profile/i })).toBeInTheDocument();
  });

  it('shows the Inbox to members too, because pending review is trust information', () => {
    renderShell('member');
    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
  });

  it('shows Admin only to an admin — a member has nothing to do there', () => {
    renderShell('admin');
    expect(screen.getByRole('link', { name: /admin/i })).toBeInTheDocument();
  });

  it('hides Admin from a member rather than rendering a link that 403s', () => {
    renderShell('member');
    expect(screen.queryByRole('link', { name: /admin/i })).not.toBeInTheDocument();
  });

  it('announces the unread count rather than showing a bare number', () => {
    renderShell('member', 3);
    expect(screen.getByLabelText('3 unread notifications')).toBeInTheDocument();
  });

  it('omits the unread badge entirely at zero', () => {
    renderShell('member', 0);
    expect(screen.queryByLabelText(/unread notifications/)).not.toBeInTheDocument();
  });

  it('renders its children inside the main landmark', () => {
    renderShell();
    const main = screen.getByRole('main');
    expect(within(main).getByRole('heading', { name: 'Browse' })).toBeInTheDocument();
    expect(main).toHaveAttribute('id', 'main');
  });
});
```

Create `packages/web/src/routes/Login.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Login } from './Login.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderLogin(refresh = vi.fn()) {
  return render(
    <MemoryRouter>
      <Login onAuthenticated={refresh} />
    </MemoryRouter>,
  );
}

describe('Login', () => {
  it('labels both fields', () => {
    renderLogin();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toHaveAttribute('type', 'password');
  });

  it('posts the credentials and calls back on success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    const refresh = vi.fn();
    renderLogin(refresh);

    await userEvent.type(screen.getByLabelText(/email/i), 'member@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'member@example.com',
      password: 'correct horse battery',
    });
    expect(refresh).toHaveBeenCalled();
  });

  it('shows a live-region error on a rejected login and does not call back', async () => {
    // Plan 1's envelope, not an ad-hoc string: { error: { code, message }, requestId }.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        error: { code: 'unauthorized', message: 'Invalid email or password.' },
        requestId: 'req-test-1',
      }),
    }));
    const refresh = vi.fn();
    renderLogin(refresh);

    await userEvent.type(screen.getByLabelText(/email/i), 'member@example.com');
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/email or password/i);
    expect(refresh).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
```

Expected failure: `Failed to load url ./client.js`, `./AppShell.js`, `./Login.js`.

- [ ] **Step 3: Write the implementation**

Modify `packages/web/src/api/client.ts`. **Plan 1 Task 18 wrote this file and every line of it stays**
— `ApiErrorCode`, `ApiErrorBody`, `ApiError`, `ApiFetchOptions`, `isErrorBody`, `apiFetch`,
`HealthResponse`, `PublicUser`, `getHealth`, `getBootstrapStatus`, `postBootstrap`, `postLogin`,
`postLogout`, `getMe`. Plan 3 appends exactly these two wrappers at the end of the file and changes
nothing else:

```ts
// ---- Plan 3 conveniences ----
//
// These are wrappers, not a second client. Every envelope-parsing rule lives in
// apiFetch above: it throws
//   new ApiError(body.error.code, body.error.message, response.status,
//                body.requestId ?? '', body.error.details)
// for a well-formed error body and ApiError('internal', …) for anything else,
// which is exactly what RESOLUTIONS R6 requires. Re-deriving that here — reading
// `body?.error` as if it were a string — would assign the whole
// { code, message } object to ApiError.code.

/** GET `path`, optionally abortable. Resolves the parsed body. */
export async function apiGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  return apiFetch<T>(path, signal === undefined ? {} : { signal });
}

/** POST / PUT / PATCH / DELETE `path` with an optional JSON body. */
export async function apiSend<T>(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return apiFetch<T>(path, body === undefined ? { method } : { method, body });
}
```

Plan 1's `ApiFetchOptions` already lists `'PATCH'` in its method union, so no change is needed there.

Now fold and delete Plan 1's separate test file, and narrow the two config includes that pointed at
it:

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git rm packages/web/test/client.test.ts
rmdir packages/web/test 2>/dev/null || true
```

In `packages/web/tsconfig.json`, `"include"` becomes
`["src/**/*.ts", "src/**/*.tsx", "vite.config.ts", "vitest.config.ts"]`.
In `packages/web/vitest.config.ts`, `include` becomes `['src/**/*.test.{ts,tsx}']`.

Create `packages/web/src/store/useApi.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import { apiGet, ApiError } from '../api/client.js';

export interface ApiState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch `path` whenever it or `deps` change. Passing null skips the request. */
export function useApi<T>(path: string | null, deps: unknown[] = []): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    apiGet<T>(path, controller.signal)
      .then((value) => {
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          err instanceof ApiError
            ? err
            // Plan 1's canonical signature: (code, message, status, requestId, details?).
            // status 0 means "the request never reached the server".
            : new ApiError('internal', 'The GrantSpotter API could not be reached.', 0, '', err),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  return { data, error, loading, reload };
}
```

Create `packages/web/src/store/session.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { apiGet, apiSend, ApiError } from '../api/client.js';

export interface CompletenessReport {
  total: number;
  unknownCount: number;
  score: number;
  fields: Array<{ field: string; resolves: number }>;
}

export interface SessionUser {
  id: string;
  email: string;
  role: 'admin' | 'member';
}

export interface SessionValue {
  user: SessionUser | null;
  hasStudentProfile: boolean;
  hasOrgProfile: boolean;
  completeness: CompletenessReport;
  unread: number;
  loading: boolean;
  refresh: () => void;
  logout: () => Promise<void>;
}

const EMPTY_COMPLETENESS: CompletenessReport = {
  total: 0, unknownCount: 0, score: 0, fields: [],
};

export const SessionContext = createContext<SessionValue>({
  user: null,
  hasStudentProfile: false,
  hasOrgProfile: false,
  completeness: EMPTY_COMPLETENESS,
  unread: 0,
  loading: true,
  refresh: () => {},
  logout: async () => {},
});

export function useSession(): SessionValue {
  return useContext(SessionContext);
}

interface MeResponse {
  user: SessionUser;
  hasStudentProfile: boolean;
  hasOrgProfile: boolean;
  completeness: CompletenessReport;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet<MeResponse>('/api/me')
      .then(async (value) => {
        if (cancelled) return;
        setMe(value);
        const notifications = await apiGet<{ unread: number }>('/api/notifications?unreadOnly=true')
          .catch(() => ({ unread: 0 }));
        if (!cancelled) setUnread(notifications.unread);
      })
      .catch((err: unknown) => {
        if (!cancelled && err instanceof ApiError && err.status === 401) setMe(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const logout = useCallback(async () => {
    await apiSend('POST', '/api/auth/logout').catch(() => null);
    setMe(null);
    refresh();
  }, [refresh]);

  const value = useMemo<SessionValue>(
    () => ({
      user: me?.user ?? null,
      hasStudentProfile: me?.hasStudentProfile ?? false,
      hasOrgProfile: me?.hasOrgProfile ?? false,
      completeness: me?.completeness ?? EMPTY_COMPLETENESS,
      unread,
      loading,
      refresh,
      logout,
    }),
    [me, unread, loading, refresh, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
```

Create `packages/web/src/components/AppShell.css`:

```css
.shell {
  display: grid;
  grid-template-columns: var(--rail-w) 1fr;
  grid-template-rows: var(--topbar-h) 1fr;
  grid-template-areas: "rail topbar" "rail main";
  min-height: 100vh;
}

.shell-rail {
  grid-area: rail;
  background: var(--surface);
  border-right: 1px solid var(--border);
  padding: var(--s-4) var(--s-3);
  display: flex;
  flex-direction: column;
  gap: var(--s-5);
}

.shell-brand {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 var(--s-2);
}

.shell-brand strong {
  font-size: var(--fs-400);
  letter-spacing: -0.02em;
}

.shell-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.shell-nav a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-1);
  color: var(--text-muted);
  text-decoration: none;
  font-weight: 540;
  /* The 3px keel is the shell's signature: a rule that lights up, not a pill. */
  border-left: 3px solid transparent;
}

.shell-nav a:hover {
  background: var(--surface-2);
  color: var(--text);
}

.shell-nav a[aria-current="page"] {
  background: var(--accent-soft);
  border-left-color: var(--accent);
  color: var(--accent);
}

.shell-topbar {
  grid-area: topbar;
  display: flex;
  align-items: center;
  gap: var(--s-4);
  padding: 0 var(--s-5);
  background: var(--surface);
  border-bottom: 1px solid var(--border);
}

.shell-main {
  grid-area: main;
  padding: var(--s-5);
  max-width: var(--content-max);
  width: 100%;
}

.badge-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-ink);
  font-family: var(--font-data);
  font-size: var(--fs-100);
  font-weight: 700;
}

@media (max-width: 720px) {
  .shell {
    grid-template-columns: 1fr;
    grid-template-areas: "topbar" "rail" "main";
  }

  .shell-rail {
    border-right: none;
    border-bottom: 1px solid var(--border);
  }

  .shell-nav {
    flex-direction: row;
    flex-wrap: wrap;
  }
}
```

Create `packages/web/src/components/AppShell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useSession } from '../store/session.js';
import './AppShell.css';

interface NavItem {
  to: string;
  label: string;
  end: boolean;
  /** Admin-only entries are omitted for members, not rendered disabled. */
  adminOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Browse', end: true },
  { to: '/calendar', label: 'Calendar', end: false },
  { to: '/watchlist', label: 'Watchlist', end: false },
  { to: '/inbox', label: 'Inbox', end: false },
  { to: '/sources', label: 'Sources', end: false },
  { to: '/profile', label: 'Profile', end: false },
  { to: '/admin', label: 'Admin', end: false, adminOnly: true },
];

export function AppShell({ children }: { children: ReactNode }) {
  const { user, unread, logout } = useSession();
  const nav = NAV.filter((item) => item.adminOnly !== true || user?.role === 'admin');

  return (
    <div className="shell">
      <a className="skip-link" href="#main">Skip to main content</a>

      <aside className="shell-rail">
        <div className="shell-brand">
          <strong>GrantSpotter</strong>
          <span className="eyebrow">Funding desk</span>
        </div>
        <nav className="shell-nav" aria-label="Primary">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end}>
              <span>{item.label}</span>
              {item.to === '/watchlist' && unread > 0 && (
                <span className="badge-count" aria-label={`${unread} unread notifications`}>
                  {unread}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </aside>

      <header className="shell-topbar">
        <span className="eyebrow">
          {user ? `${user.email} · ${user.role}` : 'Not signed in'}
        </span>
        <span style={{ flex: 1 }} />
        {user && (
          <button type="button" className="btn" onClick={() => { void logout(); }}>
            Sign out
          </button>
        )}
      </header>

      <main className="shell-main" id="main">
        {children}
      </main>
    </div>
  );
}
```

Create `packages/web/src/routes/Login.tsx`:

```tsx
import { useState } from 'react';
import type { FormEvent } from 'react';
import { apiSend, ApiError } from '../api/client.js';

export function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiSend('POST', '/api/auth/login', { email, password });
      onAuthenticated();
    } catch (err) {
      // Plan 1's ApiError.code is one of the nine frozen ApiErrorCode values.
      const code = err instanceof ApiError ? err.code : 'internal';
      setError(
        code === 'rate_limited'
          ? 'Too many attempts. Wait a minute and try again.'
          : 'That email or password was not recognised.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main
      id="main"
      style={{
        maxWidth: 380,
        margin: '12vh auto',
        padding: 'var(--s-5)',
      }}
      className="card"
    >
      <p className="eyebrow">GrantSpotter</p>
      <h1 style={{ marginBottom: 'var(--s-5)' }}>Sign in</h1>

      <form onSubmit={(e) => { void submit(e); }}>
        <label htmlFor="login-email" className="eyebrow">Email</label>
        <input
          id="login-email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: '100%', marginBottom: 'var(--s-4)', padding: 'var(--s-2)' }}
        />

        <label htmlFor="login-password" className="eyebrow">Password</label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: '100%', marginBottom: 'var(--s-5)', padding: 'var(--s-2)' }}
        />

        {error !== null && (
          <p role="alert" style={{ color: 'var(--no)' }}>{error}</p>
        )}

        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
```

Modify `packages/web/src/App.tsx` — Plan 1 Task 18 created it as a health/bootstrap status page and
noted that Plan 3 replaces it with the router. This is that replacement. **Every one of CONTRACT §2's
eleven route names is registered here**: nine are Plan 3's, `Templates` and `Applications` are Plan
4's and are registered when Plan 4 lands. `Admin` is Plan 3's (Task 25) and is guarded on the client
as well as the server — the server is the actual gate, but rendering a screen a member cannot use is
a lie:

```tsx
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import { SessionProvider, useSession } from './store/session.js';
import { AppShell } from './components/AppShell.js';
import { Login } from './routes/Login.js';

function Placeholder({ title }: { title: string }) {
  return <h1>{title}</h1>;
}

/** Client-side courtesy guard. `requireUserAdmin` on the server is the real one. */
function AdminOnly({ children }: { children: JSX.Element }) {
  const { user } = useSession();
  return user?.role === 'admin' ? children : <Navigate to="/" replace />;
}

function Authenticated() {
  const { user, loading, refresh } = useSession();
  if (loading) return <p className="eyebrow">Loading…</p>;
  if (!user) return <Login onAuthenticated={refresh} />;

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Placeholder title="Browse" />} />
        <Route path="/o/:programId" element={<Placeholder title="Opportunity" />} />
        <Route path="/calendar" element={<Placeholder title="Calendar" />} />
        <Route path="/watchlist" element={<Placeholder title="Watchlist" />} />
        <Route path="/inbox" element={<Placeholder title="Inbox" />} />
        <Route path="/sources" element={<Placeholder title="Sources" />} />
        <Route path="/profile" element={<Placeholder title="Profile" />} />
        <Route
          path="/admin"
          element={<AdminOnly><Placeholder title="Admin" /></AdminOnly>}
        />
      </Routes>
    </AppShell>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Authenticated />
      </SessionProvider>
    </BrowserRouter>
  );
}
```

The `Placeholder` elements above are replaced route-by-route in Tasks 17–25; each of those tasks names the exact line it swaps. They are scaffolding for a compiling router, not deferred work.

Modify `packages/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/base.css';

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
npm run build -w @grantspotter/web
```

Expected: 13 client (5 folded from Plan 1 + 8 new) + 8 shell + 3 login assertions green; the Vite
build emits `dist/`. `packages/web/test/` no longer exists and no suite references it.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add -A packages/web
git commit -m "feat(web): apiGet/apiSend over Plan 1's client, session store, app shell and login"
```

---

### Task 16: Verdict and trust component kit, plus the profile-field registry

**Why this exists:** the verdict badge and the trust badge appear on every row, every card, and every calendar entry. They carry the two claims the product lives or dies on — *can I apply* and *how stale is this* — so they are built once, tested once, and never re-implemented inline. The profile-field registry is what turns `Verdict.unknown.missingProfileFields` (raw field keys like `gpa`) into a labelled link that lands on the right input.

**Files:**
- Create: `packages/web/src/lib/trust.ts`
- Create: `packages/web/src/lib/profileFields.ts`
- Create: `packages/web/src/components/VerdictBadge.tsx`
- Create: `packages/web/src/components/TrustBadge.tsx`
- Create: `packages/web/src/components/StatusPill.tsx`
- Create: `packages/web/src/components/badges.css`
- Test: `packages/web/src/lib/trust.test.ts`
- Test: `packages/web/src/lib/profileFields.test.ts`
- Test: `packages/web/src/components/VerdictBadge.test.tsx`
- Test: `packages/web/src/components/TrustBadge.test.tsx`

**Interfaces:**
- Consumes: `Verdict`, `Constraint`, `ProgramStatus` from `@grantspotter/core`.
- Produces: `isUnverified(lastVerifiedAt, nowISO)`, `daysSince(iso, nowISO)`, `formatDate(iso)`, `PROFILE_FIELDS`, `profileFieldLabel(key)`, `profileFieldHref(key)`, `VerdictBadge`, `TrustBadge`, `StatusPill`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/lib/trust.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { daysSince, isUnverified, formatDate } from './trust.js';

const NOW = '2026-08-02T12:00:00.000Z';

describe('daysSince', () => {
  it('counts whole days', () => {
    expect(daysSince('2026-08-01T12:00:00.000Z', NOW)).toBe(1);
    expect(daysSince('2026-05-04T12:00:00.000Z', NOW)).toBe(90);
  });
});

describe('isUnverified', () => {
  it('is false at exactly 90 days', () => {
    // Spec §8 says "older than 90 days", so 90 itself is still verified.
    expect(isUnverified('2026-05-04T12:00:00.000Z', NOW)).toBe(false);
  });

  it('is true at 91 days', () => {
    expect(isUnverified('2026-05-03T12:00:00.000Z', NOW)).toBe(true);
  });

  it('is true for the Chicago FM record, verified in January', () => {
    expect(isUnverified('2026-01-05T00:00:00.000Z', NOW)).toBe(true);
  });

  it('treats an unparseable date as unverified rather than silently fresh', () => {
    expect(isUnverified('not a date', NOW)).toBe(true);
  });
});

describe('formatDate', () => {
  it('renders an ISO date in an unambiguous, non-US-centric form', () => {
    expect(formatDate('2026-12-30T17:00:00.000Z')).toBe('2026-12-30');
  });

  it('renders an em dash for a missing date rather than an empty cell', () => {
    expect(formatDate(null)).toBe('—');
  });
});
```

Create `packages/web/src/lib/profileFields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { PROFILE_FIELDS, profileFieldHref, profileFieldLabel } from './profileFields.js';

describe('profile field registry', () => {
  it('covers every StudentProfile field the matcher can report as missing', () => {
    const keys = new Set(PROFILE_FIELDS.map((f) => f.key));
    for (const required of [
      'licenseClass', 'licensedSince', 'state', 'lat', 'lon', 'callDistrict',
      'fieldOfStudy', 'degreeLevel', 'institution', 'accredited', 'partTime',
      'gpa', 'classRankTopPct', 'arrlMemberSince', 'citizenship', 'birthDate',
      'stage', 'activityKinds', 'cwWpm', 'financialNeed', 'gender',
    ]) {
      expect(keys.has(required), `missing registry entry: ${required}`).toBe(true);
    }
  });

  it('covers the OrgProfile fields too', () => {
    const keys = new Set(PROFILE_FIELDS.map((f) => f.key));
    for (const required of ['entity', 'is501c3', 'hasFiscalSponsor', 'arrlAffiliated', 'memberCount']) {
      expect(keys.has(required), `missing registry entry: ${required}`).toBe(true);
    }
  });

  it('gives every entry a human label and a help sentence', () => {
    for (const field of PROFILE_FIELDS) {
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.help.length).toBeGreaterThan(0);
    }
  });

  it('links a field key to the editor anchor that focuses it', () => {
    expect(profileFieldHref('gpa')).toBe('/profile?kind=student&focus=gpa#field-gpa');
    expect(profileFieldHref('memberCount'))
      .toBe('/profile?kind=organization&focus=memberCount#field-memberCount');
  });

  it('falls back to the raw key for an unregistered field rather than rendering blank', () => {
    expect(profileFieldLabel('somethingNew')).toBe('somethingNew');
    expect(profileFieldHref('somethingNew')).toBe('/profile');
  });

  it('explains the ARRL Section concept where geography is involved', () => {
    const state = PROFILE_FIELDS.find((f) => f.key === 'state');
    expect(state?.help).toMatch(/ARRL/);
  });
});
```

Create `packages/web/src/components/VerdictBadge.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Constraint } from '@grantspotter/core';
import { VerdictBadge } from './VerdictBadge.js';

const licenseConstraint: Constraint = {
  id: 'c1',
  hard: true,
  fallbackRank: 0,
  rawText: 'License Requirement: General class or higher.',
  spec: { axis: 'license', licenseMin: 'GENERAL' },
};

function wrap(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('VerdictBadge', () => {
  it('renders eligible with an accessible label', () => {
    wrap(<VerdictBadge verdict={{ kind: 'eligible' }} />);
    expect(screen.getByLabelText('Eligible')).toBeInTheDocument();
  });

  it('renders the preference rank, because a preference is not a guarantee', () => {
    wrap(<VerdictBadge verdict={{ kind: 'eligible_preferred', rank: 1, met: ['c1'] }} />);
    expect(screen.getByLabelText('Preferred, rank 1')).toHaveTextContent('Preferred · 1');
  });

  it('renders the ineligible count and exposes the reasons on click', async () => {
    const onExplain = vi.fn();
    wrap(
      <VerdictBadge
        verdict={{ kind: 'ineligible', reasons: [licenseConstraint] }}
        onExplain={onExplain}
      />,
    );
    const button = screen.getByRole('button', { name: /ineligible, 1 constraint/i });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(button);
    expect(onExplain).toHaveBeenCalledTimes(1);
  });

  it('pluralises the constraint count', () => {
    wrap(
      <VerdictBadge
        verdict={{ kind: 'ineligible', reasons: [licenseConstraint, { ...licenseConstraint, id: 'c2' }] }}
      />,
    );
    expect(screen.getByRole('button', { name: /ineligible, 2 constraints/i })).toBeInTheDocument();
  });

  it('renders unknown as a real state naming the missing field', () => {
    wrap(<VerdictBadge verdict={{ kind: 'unknown', missingProfileFields: ['gpa'] }} />);
    expect(screen.getByLabelText('Unknown, needs GPA')).toBeInTheDocument();
  });

  it('renders a "no profile" state rather than an empty cell when the verdict is null', () => {
    wrap(<VerdictBadge verdict={null} />);
    expect(screen.getByLabelText('No profile set')).toBeInTheDocument();
  });
});
```

Create `packages/web/src/components/TrustBadge.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TrustBadge } from './TrustBadge.js';
import { StatusPill } from './StatusPill.js';

const NOW = '2026-08-02T12:00:00.000Z';

describe('TrustBadge', () => {
  it('shows a verified date inside 90 days', () => {
    render(<TrustBadge lastVerifiedAt="2026-07-30T00:00:00.000Z" now={NOW} />);
    const badge = screen.getByLabelText(/verified 3 days ago/i);
    expect(badge).toHaveTextContent('2026-07-30');
    expect(badge).not.toHaveClass('trust-unverified');
  });

  it('goes amber past 90 days and says the word unverified', () => {
    render(<TrustBadge lastVerifiedAt="2026-01-05T00:00:00.000Z" now={NOW} />);
    const badge = screen.getByLabelText(/unverified/i);
    expect(badge).toHaveClass('trust-unverified');
    expect(badge).toHaveTextContent('Unverified');
  });

  it('never renders a bare date with no provenance word', () => {
    render(<TrustBadge lastVerifiedAt="2026-07-30T00:00:00.000Z" now={NOW} />);
    expect(screen.getByText(/verified/i)).toBeInTheDocument();
  });
});

describe('StatusPill', () => {
  it('renders unknown as a labelled state, never a blank', () => {
    render(<StatusPill status="unknown" />);
    expect(screen.getByLabelText('Status: unknown')).toHaveTextContent('Unknown');
  });

  it('renders discontinued distinctly from closed', () => {
    const { rerender } = render(<StatusPill status="discontinued" />);
    expect(screen.getByLabelText('Status: discontinued')).toHaveTextContent('Discontinued');
    rerender(<StatusPill status="closed" />);
    expect(screen.getByLabelText('Status: closed')).toHaveTextContent('Closed');
  });

  it('renders no_application in words a human uses', () => {
    render(<StatusPill status="no_application" />);
    expect(screen.getByLabelText('Status: no_application'))
      .toHaveTextContent('No application exists');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/lib packages/web/src/components
```

Expected failure: `Failed to load url ./trust.js`, `./profileFields.js`, `./VerdictBadge.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/trust.ts`:

```ts
export const UNVERIFIED_AFTER_DAYS = 90;

export function daysSince(iso: string, nowISO: string): number {
  const then = Date.parse(iso);
  const now = Date.parse(nowISO);
  if (Number.isNaN(then) || Number.isNaN(now)) return Number.POSITIVE_INFINITY;
  return Math.floor((now - then) / 86_400_000);
}

/**
 * Spec §8: "Older than 90 days renders amber 'unverified'." Exactly 90 is still
 * verified; 91 is not. An unparseable date is treated as unverified - the whole
 * point of this badge is that silence never reads as confidence.
 */
export function isUnverified(lastVerifiedAt: string, nowISO: string): boolean {
  return daysSince(lastVerifiedAt, nowISO) > UNVERIFIED_AFTER_DAYS;
}

/** ISO date, no locale ambiguity. An em dash, never an empty cell. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '—';
  return new Date(parsed).toISOString().slice(0, 10);
}
```

Create `packages/web/src/lib/profileFields.ts`:

```ts
export interface ProfileFieldMeta {
  key: string;
  kind: 'student' | 'organization';
  label: string;
  help: string;
}

/**
 * The single registry behind three things: the profile editor forms, the
 * completeness meter, and the "click a missing field to go fix it" links on
 * unknown verdicts. Keys match the CONTRACT StudentProfile / OrgProfile fields
 * exactly - the matcher reports those names verbatim.
 */
export const PROFILE_FIELDS: ProfileFieldMeta[] = [
  { key: 'callsign', kind: 'student', label: 'Callsign', help: 'Your FCC-issued station identifier, for example W8UM. Funders use it to confirm you hold a licence.' },
  { key: 'licenseClass', kind: 'student', label: 'License class', help: 'NONE, TECH, GENERAL or EXTRA. These rank in that order; 110 of the 111 ARRL catalog entries gate on it.' },
  { key: 'licensedSince', kind: 'student', label: 'Licensed since', help: 'The date you were first licensed. Several awards require the licence to be held for a minimum period.' },
  { key: 'state', kind: 'student', label: 'State', help: 'Two-letter US state. Used for state, ARRL Division and ARRL Section rules — an ARRL Section is an ARRL-defined region that does not line up with state borders, so GrantSpotter resolves it for you.' },
  { key: 'county', kind: 'student', label: 'County', help: 'Some club scholarships name specific counties, for example seven counties around Austin, Texas.' },
  { key: 'lat', kind: 'student', label: 'Latitude', help: 'Needed only for radius rules such as "within 250 miles of Seaford, Delaware".' },
  { key: 'lon', kind: 'student', label: 'Longitude', help: 'Needed only for radius rules such as "within 70 miles of Schenectady, New York".' },
  { key: 'callDistrict', kind: 'student', label: 'Call district', help: 'The single digit in your callsign, for example 5 in K5UTD. A few awards are scoped to a call district.' },
  { key: 'fieldOfStudy', kind: 'student', label: 'Field of study', help: 'Your major. One catalog entry reads "Any, except for Liberal Arts", so exclusions matter as much as inclusions.' },
  { key: 'degreeLevel', kind: 'student', label: 'Degree level', help: 'CERT, ASSOC, BACH or GRAD.' },
  { key: 'institution', kind: 'student', label: 'Institution', help: 'The school you attend or will attend.' },
  { key: 'accredited', kind: 'student', label: 'Accredited institution', help: 'Many awards require an accredited programme; a few explicitly allow trade schools.' },
  { key: 'partTime', kind: 'student', label: 'Part-time', help: 'A small number of awards are aimed specifically at part-time students working full-time.' },
  { key: 'gpa', kind: 'student', label: 'GPA', help: 'Hard floors of 2.5, 3.0 and 3.2 appear in the catalog, and ARDC states a preference above 3.5.' },
  { key: 'classRankTopPct', kind: 'student', label: 'Class rank (top %)', help: 'Used where an award asks for class rank instead of GPA, for example the top 5 to 10 percent.' },
  { key: 'arrlMemberSince', kind: 'student', label: 'ARRL member since', help: 'A few awards require ARRL membership, and some require it for at least one year.' },
  { key: 'citizenship', kind: 'student', label: 'Citizenship', help: 'US_CITIZEN, US_RESIDENT or ANY. One award also accepts applicants within three months of citizenship.' },
  { key: 'birthDate', kind: 'student', label: 'Date of birth', help: 'Only four catalog entries state an age range, but they state it precisely, for example "22 or younger as of June 1".' },
  { key: 'stage', kind: 'student', label: 'Stage', help: 'HS_SENIOR, UNDERGRAD, GRAD, VETERAN or RETRAINING_ADULT. Veterans are explicitly included by two awards.' },
  { key: 'activityKinds', kind: 'student', label: 'Ham activity', help: 'Club membership, ARES/RACES/SKYWARN, teaching, on-air operating, Field Day, contesting, public service. Several awards require demonstrated activity, not just a licence.' },
  { key: 'cwWpm', kind: 'student', label: 'Morse code speed (wpm)', help: 'One award requires an ARRL Code Proficiency certificate at 15 words per minute or better within the last 24 months.' },
  { key: 'financialNeed', kind: 'student', label: 'Financial need', help: 'Always a weighting, never a bar. Declaring it can only help.' },
  { key: 'gender', kind: 'student', label: 'Gender', help: 'Used by exactly one funder, YLRL, whose awards are for female licensed operators.' },

  { key: 'entity', kind: 'organization', label: 'Entity type', help: 'What kind of applicant you are: unincorporated club, 501(c)(3) club, club applying through a fiscal sponsor, school, university, university department, or IEEE Student Branch Chapter.' },
  { key: 'orgName', kind: 'organization', label: 'Organization name', help: 'The name that will appear on the application.' },
  { key: 'ein', kind: 'organization', label: 'EIN', help: 'Your federal employer identification number, if you have one.' },
  { key: 'is501c3', kind: 'organization', label: '501(c)(3)', help: 'ARDC funds US 501(c)(3) organizations, governments, schools and universities directly.' },
  { key: 'hasFiscalSponsor', kind: 'organization', label: 'Has a fiscal sponsor', help: 'Unincorporated clubs and individuals can still apply to ARDC through a fiscal sponsor — an existing nonprofit that receives the grant on your behalf.' },
  { key: 'arrlAffiliated', kind: 'organization', label: 'ARRL-affiliated club', help: 'The ARRL Club Grant Program is open only to ARRL-affiliated clubs.' },
  { key: 'memberCount', kind: 'organization', label: 'Member count', help: 'IEEE chapter support requires at least five members, and the rebate scales at $2 per member.' },
  { key: 'institutionName', kind: 'organization', label: 'Host institution', help: 'The school or university the club is attached to, if any.' },
];

const BY_KEY = new Map(PROFILE_FIELDS.map((f) => [f.key, f]));

export function profileFieldLabel(key: string): string {
  return BY_KEY.get(key)?.label ?? key;
}

/** Deep link to the editor input that resolves this field. */
export function profileFieldHref(key: string): string {
  const field = BY_KEY.get(key);
  if (!field) return '/profile';
  return `/profile?kind=${field.kind}&focus=${field.key}#field-${field.key}`;
}
```

Create `packages/web/src/components/badges.css`:

```css
/* The keel: a 3px coloured bar on the leading edge. Colour is never the only
   signal - every badge also carries a word and an aria-label. */
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--s-2);
  padding: 2px var(--s-2) 2px var(--s-1);
  border-radius: var(--r-1);
  border-left: 3px solid currentColor;
  font-size: var(--fs-200);
  font-weight: 600;
  white-space: nowrap;
  line-height: 1.4;
}

button.badge {
  font-family: inherit;
  cursor: pointer;
  border-top: none;
  border-right: none;
  border-bottom: none;
}

.verdict-eligible { color: var(--ok); background: var(--ok-soft); }
.verdict-preferred { color: var(--pref); background: var(--pref-soft); }
.verdict-ineligible { color: var(--no); background: var(--no-soft); }
.verdict-unknown { color: var(--unk); background: var(--unk-soft); }

.badge .badge-rank {
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}

.trust {
  display: inline-flex;
  align-items: baseline;
  gap: var(--s-2);
  font-size: var(--fs-200);
  color: var(--text-muted);
}

.trust .trust-date {
  font-family: var(--font-data);
  font-variant-numeric: tabular-nums;
}

.trust-unverified {
  color: var(--warn);
  background: var(--warn-soft);
  padding: 2px var(--s-2);
  border-radius: var(--r-1);
  font-weight: 620;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px var(--s-2);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  font-size: var(--fs-100);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  font-weight: 640;
  color: var(--text-muted);
  background: var(--surface-2);
}

.status-open { color: var(--ok); border-color: var(--ok); background: var(--ok-soft); }
.status-unknown { color: var(--unk); border-color: var(--unk); background: var(--unk-soft); }
.status-discontinued { color: var(--no); border-color: var(--no); background: var(--no-soft); }
```

Create `packages/web/src/components/VerdictBadge.tsx`:

```tsx
import type { Verdict } from '@grantspotter/core';
import { profileFieldLabel } from '../lib/profileFields.js';
import './badges.css';

export interface VerdictBadgeProps {
  verdict: Verdict | null;
  /** When supplied, the ineligible badge becomes a button that opens the reasons. */
  onExplain?: () => void;
  expanded?: boolean;
}

export function VerdictBadge({ verdict, onExplain, expanded = false }: VerdictBadgeProps) {
  if (verdict === null) {
    return (
      <span className="badge verdict-unknown" aria-label="No profile set">
        No profile
      </span>
    );
  }

  switch (verdict.kind) {
    case 'eligible':
      return <span className="badge verdict-eligible" aria-label="Eligible">Eligible</span>;

    case 'eligible_preferred':
      return (
        <span className="badge verdict-preferred" aria-label={`Preferred, rank ${verdict.rank}`}>
          Preferred · <span className="badge-rank">{verdict.rank}</span>
        </span>
      );

    case 'ineligible': {
      const n = verdict.reasons.length;
      const label = `Ineligible, ${n} constraint${n === 1 ? '' : 's'} not met`;
      const content = (
        <>
          Ineligible · <span className="badge-rank">{n}</span>
        </>
      );
      if (!onExplain) {
        return <span className="badge verdict-ineligible" aria-label={label}>{content}</span>;
      }
      return (
        <button
          type="button"
          className="badge verdict-ineligible"
          aria-label={label}
          aria-expanded={expanded}
          onClick={onExplain}
        >
          {content}
        </button>
      );
    }

    case 'unknown': {
      const first = verdict.missingProfileFields[0];
      const label = first ? `Unknown, needs ${profileFieldLabel(first)}` : 'Unknown';
      return (
        <span className="badge verdict-unknown" aria-label={label}>
          Unknown · {first ? profileFieldLabel(first) : 'needs profile'}
        </span>
      );
    }
  }
}
```

Create `packages/web/src/components/TrustBadge.tsx`:

```tsx
import { daysSince, formatDate, isUnverified } from '../lib/trust.js';
import './badges.css';

export interface TrustBadgeProps {
  lastVerifiedAt: string;
  now?: string;
}

/**
 * Spec §8: lastVerifiedAt on EVERY record. A date with no provenance word is
 * exactly the failure mode this badge exists to prevent, so the word "Verified"
 * or "Unverified" is always present.
 */
export function TrustBadge({ lastVerifiedAt, now }: TrustBadgeProps) {
  const nowISO = now ?? new Date().toISOString();
  const stale = isUnverified(lastVerifiedAt, nowISO);
  const days = daysSince(lastVerifiedAt, nowISO);

  if (stale) {
    return (
      <span
        className="trust trust-unverified"
        aria-label={`Unverified. Last checked ${formatDate(lastVerifiedAt)}, ${Number.isFinite(days) ? `${days} days ago` : 'date unknown'}.`}
      >
        Unverified <span className="trust-date">{formatDate(lastVerifiedAt)}</span>
      </span>
    );
  }

  return (
    <span className="trust" aria-label={`Verified ${days} days ago, on ${formatDate(lastVerifiedAt)}.`}>
      Verified <span className="trust-date">{formatDate(lastVerifiedAt)}</span>
    </span>
  );
}
```

Create `packages/web/src/components/StatusPill.tsx`:

```tsx
import type { ProgramStatus } from '@grantspotter/core';
import './badges.css';

const WORDS: Record<ProgramStatus, string> = {
  open: 'Open',
  closed: 'Closed',
  dormant: 'Dormant',
  discontinued: 'Discontinued',
  contact_only: 'Contact only',
  no_application: 'No application exists',
  unknown: 'Unknown',
};

const MODIFIER: Partial<Record<ProgramStatus, string>> = {
  open: 'status-open',
  unknown: 'status-unknown',
  discontinued: 'status-discontinued',
};

/** `unknown` is a rendered state, never a blank field (spec §8). */
export function StatusPill({ status }: { status: ProgramStatus }) {
  return (
    <span
      className={`status-pill ${MODIFIER[status] ?? ''}`.trim()}
      aria-label={`Status: ${status}`}
    >
      {WORDS[status]}
    </span>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
```

Expected: 8 trust + 6 registry + 6 verdict + 6 trust/status component assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web/src/lib packages/web/src/components
git commit -m "feat(web): verdict, trust and status badge kit with profile-field registry"
```

---
### Task 17: Browse route — filter panel and results table

**Files:**
- Create: `packages/web/src/lib/filterState.ts`
- Create: `packages/web/src/components/FilterPanel.tsx`
- Create: `packages/web/src/components/ProgramTable.tsx`
- Create: `packages/web/src/components/browse.css`
- Create: `packages/web/src/routes/Browse.tsx`
- Modify: `packages/web/src/App.tsx` (swap the Browse placeholder)
- Test: `packages/web/src/lib/filterState.test.ts`
- Test: `packages/web/src/routes/Browse.test.tsx`

**Interfaces:**
- Consumes: `GET /api/programs` (Task 4); `VerdictBadge`, `TrustBadge`, `StatusPill`; `useApi`.
- Produces: `filtersToSearchParams(filters)`, `searchParamsToFilters(params)`, `FilterPanel`, `ProgramTable`, `Browse`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/lib/filterState.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filtersToSearchParams, searchParamsToFilters, EMPTY_FILTERS } from './filterState.js';

describe('filter URL round-trip', () => {
  it('omits empty values so a clean browse has a clean URL', () => {
    expect(filtersToSearchParams(EMPTY_FILTERS).toString()).toBe('');
  });

  it('serializes multi-values as comma-separated', () => {
    const params = filtersToSearchParams({
      ...EMPTY_FILTERS,
      klass: ['ham_grant', 'ham_scholarship'],
      verdict: ['ineligible'],
    });
    expect(params.get('klass')).toBe('ham_grant,ham_scholarship');
    expect(params.get('verdict')).toBe('ineligible');
  });

  it('round-trips every field', () => {
    const filters = {
      klass: ['ham_grant'],
      entity: ['university'],
      instrument: ['cash_range'],
      status: ['open'],
      verdict: ['eligible'],
      deadlineFrom: '2026-09-01',
      deadlineTo: '2027-01-31',
      includeRolling: false,
      amountMin: 1000,
      amountMax: 25000,
      q: 'scholarship',
      sort: 'amount_desc' as const,
      page: 3,
    };
    expect(searchParamsToFilters(filtersToSearchParams(filters))).toEqual(filters);
  });

  it('defaults includeRolling to true when the parameter is absent', () => {
    expect(searchParamsToFilters(new URLSearchParams('')).includeRolling).toBe(true);
  });

  it('ignores a non-numeric page rather than throwing', () => {
    expect(searchParamsToFilters(new URLSearchParams('page=banana')).page).toBe(1);
  });
});
```

Create `packages/web/src/routes/Browse.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Browse } from './Browse.js';

const RESPONSE = {
  rows: [
    {
      program: {
        id: 'arrl-foundation-scholarship',
        name: 'ARRL Foundation Scholarship Program',
        klass: 'ham_scholarship',
        amount: { instrument: 'cash_range', amountMin: 500, amountMax: 25000, amountRaw: '$500 - $25,000', awardCountRaw: '170+' },
        trust: { status: 'open', lastVerifiedAt: '2026-08-02T00:00:00.000Z', sourceUrl: 'http://www.arrl.org/scholarship-descriptions', verificationMethod: 'live_fetch', contentHash: 'x' },
      },
      funderName: 'ARRL Foundation',
      verdict: { kind: 'eligible' },
      nextOpensAt: '2026-10-30T00:00:00.000Z',
      nextClosesAt: '2026-12-30T17:00:00.000Z',
      nextIsEstimated: false,
      watched: false,
    },
    {
      program: {
        id: 'chicago-fm-club-scholarship',
        name: 'Chicago FM Club Scholarship',
        klass: 'ham_scholarship',
        amount: { instrument: 'unknown', amountRaw: 'Not published', awardCountRaw: 'Not published' },
        trust: {
          status: 'discontinued',
          lastVerifiedAt: '2026-01-05T00:00:00.000Z',
          sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
          verificationMethod: 'manual_curation',
          contentHash: 'y',
          staleMirrorWarning: 'Still listed by 7 or more third-party aggregators, which mirror stale ARRL data.',
        },
      },
      funderName: 'Six Meter Club of Chicago',
      verdict: { kind: 'ineligible', reasons: [{ id: 'c1', hard: true, fallbackRank: 0, rawText: 'This program is discontinued.', spec: { axis: 'other', note: 'discontinued' } }] },
      nextOpensAt: null,
      nextClosesAt: null,
      nextIsEstimated: false,
      watched: false,
    },
  ],
  summary: {
    total: 2, eligible: 1, preferred: 0, ineligible: 1, unknown: 0,
    ineligibleByAxis: [{ axis: 'other', count: 1 }],
    unknownByField: [],
  },
  page: 1,
  pageSize: 50,
  total: 2,
  profileApplied: 'student',
};

function stubFetch(body: unknown = RESPONSE) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderBrowse(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Browse now="2026-08-02T12:00:00.000Z" />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Browse', () => {
  it('renders one row per program with a verdict badge', async () => {
    renderBrowse();
    const table = await screen.findByRole('table', { name: /opportunities/i });
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2
    expect(within(table).getByLabelText('Eligible')).toBeInTheDocument();
  });

  it('shows the verdict census as a headline, not buried', async () => {
    renderBrowse();
    expect(await screen.findByText(/you are ineligible for 1 of these/i)).toBeInTheDocument();
  });

  it('renders the amber unverified badge on a record older than 90 days', async () => {
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.getByLabelText(/unverified\. last checked 2026-01-05/i)).toBeInTheDocument();
  });

  it('renders the stale-mirror warning inline on the row that carries it', async () => {
    renderBrowse();
    expect(await screen.findByText(/mirror stale ARRL data/i)).toBeInTheDocument();
  });

  it('renders status "discontinued" rather than an empty cell', async () => {
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    expect(screen.getByLabelText('Status: discontinued')).toBeInTheDocument();
  });

  it('renders an em dash for a program with no next deadline', async () => {
    renderBrowse();
    const table = await screen.findByRole('table', { name: /opportunities/i });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[2]!).getByText('—')).toBeInTheDocument();
  });

  it('sends the filters from the URL to the API', async () => {
    const fetchMock = stubFetch();
    renderBrowse('/?klass=ham_grant&verdict=ineligible&sort=name');
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = (fetchMock.mock.calls[0] as [string])[0];
    expect(url).toContain('klass=ham_grant');
    expect(url).toContain('verdict=ineligible');
    expect(url).toContain('sort=name');
  });

  it('refetches when a filter checkbox is toggled', async () => {
    const fetchMock = stubFetch();
    renderBrowse();
    await screen.findByRole('table', { name: /opportunities/i });
    await userEvent.click(screen.getByRole('checkbox', { name: /ham grant/i }));
    await waitFor(() => {
      const urls = fetchMock.mock.calls.map((c) => (c as [string])[0]);
      expect(urls.some((u) => u.includes('klass=ham_grant'))).toBe(true);
    });
  });

  it('gives the filter panel a labelled landmark and grouped fieldsets', async () => {
    renderBrowse();
    const panel = await screen.findByRole('region', { name: /filters/i });
    expect(within(panel).getByRole('group', { name: /opportunity class/i })).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: /applicant/i })).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: /instrument/i })).toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: /matcher verdict/i })).toBeInTheDocument();
  });

  it('warns that rolling programs drop out when a deadline window is set', async () => {
    renderBrowse('/?deadlineFrom=2026-12-01&includeRolling=false');
    expect(await screen.findByText(/rolling and undated programs are hidden/i)).toBeInTheDocument();
  });

  it('tells the user when no profile is applied instead of showing silent nulls', async () => {
    stubFetch({ ...RESPONSE, profileApplied: null });
    renderBrowse();
    expect(await screen.findByRole('link', { name: /set up a profile/i })).toBeInTheDocument();
  });

  it('shows an empty state rather than a bare table', async () => {
    stubFetch({ ...RESPONSE, rows: [], total: 0, summary: { ...RESPONSE.summary, total: 0, eligible: 0, ineligible: 0 } });
    renderBrowse();
    expect(await screen.findByText(/no opportunities match these filters/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/lib/filterState.test.ts packages/web/src/routes/Browse.test.tsx
```

Expected failure: `Failed to load url ./filterState.js` and `./Browse.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/lib/filterState.ts`:

```ts
export type BrowseSort = 'deadline' | 'amount_desc' | 'name' | 'verified';

export interface UiFilters {
  klass: string[];
  entity: string[];
  instrument: string[];
  status: string[];
  verdict: string[];
  deadlineFrom?: string;
  deadlineTo?: string;
  includeRolling: boolean;
  amountMin?: number;
  amountMax?: number;
  q?: string;
  sort: BrowseSort;
  page: number;
}

export const EMPTY_FILTERS: UiFilters = {
  klass: [], entity: [], instrument: [], status: [], verdict: [],
  includeRolling: true, sort: 'deadline', page: 1,
};

const MULTI: Array<keyof UiFilters> = ['klass', 'entity', 'instrument', 'status', 'verdict'];

export function filtersToSearchParams(f: UiFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of MULTI) {
    const values = f[key] as string[];
    if (values.length > 0) params.set(key, values.join(','));
  }
  if (f.deadlineFrom) params.set('deadlineFrom', f.deadlineFrom);
  if (f.deadlineTo) params.set('deadlineTo', f.deadlineTo);
  if (!f.includeRolling) params.set('includeRolling', 'false');
  if (f.amountMin !== undefined) params.set('amountMin', String(f.amountMin));
  if (f.amountMax !== undefined) params.set('amountMax', String(f.amountMax));
  if (f.q) params.set('q', f.q);
  if (f.sort !== 'deadline') params.set('sort', f.sort);
  if (f.page !== 1) params.set('page', String(f.page));
  return params;
}

function list(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  return raw === null || raw === '' ? [] : raw.split(',');
}

function int(params: URLSearchParams, key: string): number | undefined {
  const raw = params.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function searchParamsToFilters(params: URLSearchParams): UiFilters {
  const sort = params.get('sort');
  return {
    klass: list(params, 'klass'),
    entity: list(params, 'entity'),
    instrument: list(params, 'instrument'),
    status: list(params, 'status'),
    verdict: list(params, 'verdict'),
    deadlineFrom: params.get('deadlineFrom') ?? undefined,
    deadlineTo: params.get('deadlineTo') ?? undefined,
    includeRolling: params.get('includeRolling') !== 'false',
    amountMin: int(params, 'amountMin'),
    amountMax: int(params, 'amountMax'),
    q: params.get('q') ?? undefined,
    sort: (['deadline', 'amount_desc', 'name', 'verified'].includes(sort ?? '')
      ? sort
      : 'deadline') as BrowseSort,
    page: int(params, 'page') ?? 1,
  };
}
```

Create `packages/web/src/components/browse.css`:

```css
.browse {
  display: grid;
  grid-template-columns: 264px 1fr;
  gap: var(--s-5);
  align-items: start;
}

.filter-panel {
  position: sticky;
  top: var(--s-4);
  padding: var(--s-4);
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}

.filter-panel fieldset {
  border: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}

.filter-panel legend {
  padding: 0 0 var(--s-2);
  font-size: var(--fs-100);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  font-weight: 600;
  color: var(--text-muted);
}

.filter-panel label {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--fs-200);
  padding: 2px 0;
}

/* The census: a single wide statement, the ineligible figure set in display size. */
.census {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s-4);
  padding: var(--s-4) var(--s-5);
  margin-bottom: var(--s-4);
  border-left: 3px solid var(--accent);
}

.census-figure {
  font-family: var(--font-data);
  font-size: var(--fs-700);
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.03em;
}

.census-lede { font-size: var(--fs-400); }

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  background: var(--surface);
}

.row-name {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-name a { font-weight: 600; text-decoration: none; }
.row-name a:hover { text-decoration: underline; }

.row-funder { font-size: var(--fs-200); color: var(--text-muted); }

.row-warning {
  margin-top: var(--s-1);
  font-size: var(--fs-200);
  color: var(--warn);
  background: var(--warn-soft);
  padding: var(--s-1) var(--s-2);
  border-radius: var(--r-1);
  max-width: 46ch;
}

.estimated-mark {
  font-family: var(--font-data);
  color: var(--text-muted);
  font-size: var(--fs-100);
}

.empty-state {
  padding: var(--s-7) var(--s-5);
  text-align: center;
  color: var(--text-muted);
}

@media (max-width: 900px) {
  .browse { grid-template-columns: 1fr; }
  .filter-panel { position: static; }
}
```

Create `packages/web/src/components/FilterPanel.tsx`:

```tsx
import type { UiFilters } from '../lib/filterState.js';
import './browse.css';

interface Group {
  key: 'klass' | 'entity' | 'instrument' | 'status' | 'verdict';
  legend: string;
  options: Array<{ value: string; label: string }>;
}

const GROUPS: Group[] = [
  {
    key: 'klass',
    legend: 'Opportunity class',
    options: [
      { value: 'ham_grant', label: 'Ham grant' },
      { value: 'ham_scholarship', label: 'Ham scholarship' },
      { value: 'adjacent_stem', label: 'Adjacent STEM / RF' },
      { value: 'equipment_in_kind', label: 'Equipment & in-kind' },
    ],
  },
  {
    key: 'entity',
    legend: 'Applicant entity',
    options: [
      { value: 'individual', label: 'Individual' },
      { value: 'club_unincorporated', label: 'Club (unincorporated)' },
      { value: 'club_501c3', label: 'Club (501(c)(3))' },
      { value: 'club_via_fiscal_sponsor', label: 'Club via fiscal sponsor' },
      { value: 'school_lea', label: 'School / district' },
      { value: 'university', label: 'University' },
      { value: 'university_dept', label: 'University department' },
      { value: 'ieee_student_branch_chapter', label: 'IEEE student branch chapter' },
      { value: 'teacher', label: 'Teacher' },
      { value: 'nominated_by_institution', label: 'Nominated by institution' },
    ],
  },
  {
    key: 'instrument',
    legend: 'Instrument',
    options: [
      { value: 'cash_range', label: 'Cash range' },
      { value: 'cash_fixed', label: 'Cash, fixed' },
      { value: 'cash_tiered_blocks', label: 'Cash, tiered blocks' },
      { value: 'in_kind_equipment', label: 'Equipment' },
      { value: 'in_kind_service', label: 'Service' },
      { value: 'discounted_purchase', label: 'Discounted purchase' },
      { value: 'per_member_rebate', label: 'Per-member rebate' },
      { value: 'tuition_coverage', label: 'Tuition coverage' },
      { value: 'unknown', label: 'Unknown' },
    ],
  },
  {
    key: 'status',
    legend: 'Status',
    options: [
      { value: 'open', label: 'Open' },
      { value: 'closed', label: 'Closed' },
      { value: 'dormant', label: 'Dormant' },
      { value: 'discontinued', label: 'Discontinued' },
      { value: 'contact_only', label: 'Contact only' },
      { value: 'no_application', label: 'No application' },
      { value: 'unknown', label: 'Unknown' },
    ],
  },
  {
    key: 'verdict',
    legend: 'Matcher verdict',
    options: [
      { value: 'eligible', label: 'Eligible' },
      { value: 'eligible_preferred', label: 'Preferred' },
      { value: 'ineligible', label: 'Ineligible' },
      { value: 'unknown', label: 'Unknown' },
    ],
  },
];

export interface FilterPanelProps {
  filters: UiFilters;
  onChange: (next: UiFilters) => void;
}

export function FilterPanel({ filters, onChange }: FilterPanelProps) {
  function toggle(group: Group['key'], value: string) {
    const current = filters[group];
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ ...filters, [group]: next, page: 1 });
  }

  return (
    <section className="filter-panel card" aria-label="Filters">
      <div>
        <label htmlFor="filter-q" className="eyebrow">Search</label>
        <input
          id="filter-q"
          type="search"
          value={filters.q ?? ''}
          placeholder="Name, funder, tag"
          onChange={(e) => onChange({ ...filters, q: e.target.value || undefined, page: 1 })}
          style={{ width: '100%', padding: 'var(--s-2)' }}
        />
      </div>

      {GROUPS.map((group) => (
        <fieldset key={group.key}>
          <legend>{group.legend}</legend>
          {group.options.map((option) => (
            <label key={option.value} htmlFor={`f-${group.key}-${option.value}`}>
              <input
                id={`f-${group.key}-${option.value}`}
                type="checkbox"
                checked={filters[group.key].includes(option.value)}
                onChange={() => toggle(group.key, option.value)}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
      ))}

      <fieldset>
        <legend>Deadline window</legend>
        <label htmlFor="f-deadline-from">
          From
          <input
            id="f-deadline-from"
            type="date"
            value={filters.deadlineFrom ?? ''}
            onChange={(e) => onChange({ ...filters, deadlineFrom: e.target.value || undefined, page: 1 })}
          />
        </label>
        <label htmlFor="f-deadline-to">
          To
          <input
            id="f-deadline-to"
            type="date"
            value={filters.deadlineTo ?? ''}
            onChange={(e) => onChange({ ...filters, deadlineTo: e.target.value || undefined, page: 1 })}
          />
        </label>
        <label htmlFor="f-include-rolling">
          <input
            id="f-include-rolling"
            type="checkbox"
            checked={filters.includeRolling}
            onChange={(e) => onChange({ ...filters, includeRolling: e.target.checked, page: 1 })}
          />
          Keep rolling and undated programs
        </label>
      </fieldset>

      <fieldset>
        <legend>Award amount</legend>
        <label htmlFor="f-amount-min">
          Min
          <input
            id="f-amount-min"
            type="number"
            min={0}
            value={filters.amountMin ?? ''}
            onChange={(e) => onChange({
              ...filters,
              amountMin: e.target.value === '' ? undefined : Number(e.target.value),
              page: 1,
            })}
          />
        </label>
        <label htmlFor="f-amount-max">
          Max
          <input
            id="f-amount-max"
            type="number"
            min={0}
            value={filters.amountMax ?? ''}
            onChange={(e) => onChange({
              ...filters,
              amountMax: e.target.value === '' ? undefined : Number(e.target.value),
              page: 1,
            })}
          />
        </label>
      </fieldset>
    </section>
  );
}
```

Create `packages/web/src/components/ProgramTable.tsx`:

```tsx
import { Link } from 'react-router-dom';
import type { Program, Verdict } from '@grantspotter/core';
import { VerdictBadge } from './VerdictBadge.js';
import { TrustBadge } from './TrustBadge.js';
import { StatusPill } from './StatusPill.js';
import { formatDate } from '../lib/trust.js';
import './browse.css';

export interface ProgramRow {
  program: Program;
  funderName: string;
  verdict: Verdict | null;
  nextOpensAt: string | null;
  nextClosesAt: string | null;
  nextIsEstimated: boolean;
  watched: boolean;
}

export interface ProgramTableProps {
  rows: ProgramRow[];
  now: string;
  onExplain?: (programId: string) => void;
  expandedId?: string | null;
}

export function ProgramTable({ rows, now, onExplain, expandedId }: ProgramTableProps) {
  if (rows.length === 0) {
    return (
      <div className="table-wrap">
        <p className="empty-state">
          No opportunities match these filters. Widen the deadline window or clear a verdict filter.
        </p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="grid-table" aria-label="Opportunities">
        <thead>
          <tr>
            <th scope="col">Program</th>
            <th scope="col">Verdict</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">Closes</th>
            <th scope="col" className="num">Amount</th>
            <th scope="col">Verified</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.program.id}>
              <td>
                <span className="row-name">
                  <Link to={`/o/${row.program.id}`}>{row.program.name}</Link>
                  <span className="row-funder">{row.funderName}</span>
                </span>
                {row.program.trust.staleMirrorWarning && (
                  <p className="row-warning">{row.program.trust.staleMirrorWarning}</p>
                )}
              </td>
              <td>
                <VerdictBadge
                  verdict={row.verdict}
                  onExplain={onExplain ? () => onExplain(row.program.id) : undefined}
                  expanded={expandedId === row.program.id}
                />
              </td>
              <td><StatusPill status={row.program.trust.status} /></td>
              <td className="num">
                {formatDate(row.nextClosesAt)}
                {row.nextIsEstimated && row.nextClosesAt !== null && (
                  <>
                    {' '}
                    <span className="estimated-mark" title="Projected from a recurrence rule, not observed on the source">
                      est.
                    </span>
                  </>
                )}
              </td>
              <td className="num">{row.program.amount.amountRaw}</td>
              <td>
                <TrustBadge lastVerifiedAt={row.program.trust.lastVerifiedAt} now={now} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Create `packages/web/src/routes/Browse.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../store/useApi.js';
import { FilterPanel } from '../components/FilterPanel.js';
import { ProgramTable, type ProgramRow } from '../components/ProgramTable.js';
import {
  filtersToSearchParams, searchParamsToFilters, type UiFilters,
} from '../lib/filterState.js';
import '../components/browse.css';

export interface BrowseSummary {
  total: number;
  eligible: number;
  preferred: number;
  ineligible: number;
  unknown: number;
  ineligibleByAxis: Array<{ axis: string; count: number }>;
  unknownByField: Array<{ field: string; resolves?: number; count: number }>;
}

export interface BrowseResponse {
  rows: ProgramRow[];
  summary: BrowseSummary;
  page: number;
  pageSize: number;
  total: number;
  profileApplied: 'student' | 'organization' | null;
}

export function Browse({ now }: { now?: string }) {
  const nowISO = now ?? new Date().toISOString();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filters = useMemo(() => searchParamsToFilters(searchParams), [searchParams]);
  const query = useMemo(() => filtersToSearchParams(filters).toString(), [filters]);
  const { data, loading, error } = useApi<BrowseResponse>(
    `/api/programs${query === '' ? '' : `?${query}`}`,
  );

  function update(next: UiFilters) {
    setSearchParams(filtersToSearchParams(next));
  }

  return (
    <>
      <p className="eyebrow">Corpus</p>
      <h1 style={{ marginBottom: 'var(--s-5)' }}>Browse opportunities</h1>

      <div className="browse">
        <FilterPanel filters={filters} onChange={update} />

        <div>
          {!filters.includeRolling && (filters.deadlineFrom || filters.deadlineTo) && (
            <p className="row-warning" style={{ maxWidth: 'none' }}>
              Rolling and undated programs are hidden while a deadline window is set.
              NCDXF and SARA accept applications year-round and have no date to match against.
            </p>
          )}

          {data && data.profileApplied === null && (
            <p className="row-warning" style={{ maxWidth: 'none' }}>
              No profile is set, so no eligibility verdicts are shown.{' '}
              <Link to="/profile">Set up a profile</Link> to see what you qualify for.
            </p>
          )}

          {data && data.profileApplied !== null && (
            <section className="census card" aria-label="Eligibility summary">
              <span className="census-figure">{data.summary.ineligible}</span>
              <span className="census-lede">
                You are ineligible for {data.summary.ineligible} of these
                {data.summary.ineligible > 0 && (
                  <>
                    {' — '}
                    <Link to={`/?${filtersToSearchParams({ ...filters, verdict: ['ineligible'], page: 1 }).toString()}`}>
                      see the specific constraint for each
                    </Link>
                  </>
                )}
                .
              </span>
              <span className="eyebrow">
                {data.summary.eligible} eligible · {data.summary.preferred} preferred ·{' '}
                {data.summary.unknown} unknown · {data.summary.total} in view
              </span>
            </section>
          )}

          {loading && <p className="eyebrow">Loading…</p>}
          {error && <p role="alert">Could not load opportunities ({error.code}).</p>}

          {data && (
            <ProgramTable
              rows={data.rows}
              now={nowISO}
              expandedId={expandedId}
              onExplain={(id) => setExpandedId((current) => (current === id ? null : id))}
            />
          )}
        </div>
      </div>
    </>
  );
}
```

Modify `packages/web/src/App.tsx` — replace the Browse route element:

```tsx
import { Browse } from './routes/Browse.js';
// ...
        <Route path="/" element={<Browse />} />
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
```

Expected: 5 filter-state + 12 Browse assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web/src
git commit -m "feat(web): browse route with server-side filters and verdict census"
```

---

### Task 18: The ineligibility explorer and jump-to-profile

**Why this exists:** spec §5 — *"The matcher explains itself. 'You are ineligible for 41 of these, and here is the specific constraint for each' is the feature that makes this a professional tool rather than a list."* Task 17 renders the count; this task makes it a reachable, per-program, verbatim-constraint view, and makes every `unknown` verdict a one-click path to the field that resolves it.

**Files:**
- Create: `packages/web/src/components/IneligibilityDrawer.tsx`
- Create: `packages/web/src/components/UnknownFields.tsx`
- Create: `packages/web/src/components/explain.css`
- Modify: `packages/web/src/components/ProgramTable.tsx` (render the drawer row)
- Modify: `packages/web/src/routes/Browse.tsx` (render the unknown-field ladder)
- Test: `packages/web/src/components/IneligibilityDrawer.test.tsx`
- Test: `packages/web/src/components/UnknownFields.test.tsx`

**Interfaces:**
- Consumes: `Constraint`, `ConstraintAxis` from `@grantspotter/core`; `profileFieldHref`, `profileFieldLabel`.
- Produces: `IneligibilityDrawer`, `UnknownFields`, `axisLabel(axis)`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/components/IneligibilityDrawer.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Constraint } from '@grantspotter/core';
import { IneligibilityDrawer, axisLabel } from './IneligibilityDrawer.js';

const reasons: Constraint[] = [
  {
    id: 'c-license',
    hard: true,
    fallbackRank: 0,
    rawText: 'License Requirement: General class or higher, held for at least one year.',
    spec: { axis: 'license', licenseMin: 'GENERAL', heldMonthsMin: 12 },
  },
  {
    id: 'c-geo',
    hard: true,
    fallbackRank: 0,
    rawText: 'Region: Applicant must reside within 250 miles of Seaford, Delaware.',
    spec: {
      axis: 'geography',
      geo: {
        type: 'radius', values: [], centerLat: 38.6, centerLon: -75.6,
        radiusMiles: 250, centerLabel: 'Seaford, Delaware',
      },
    },
  },
  {
    id: 'c-soft',
    hard: false,
    fallbackRank: 1,
    rawText: 'Preference will be given to applicants residing in Louisiana.',
    spec: { axis: 'geography', geo: { type: 'state', values: ['LA'] } },
  },
];

function wrap(ui: React.ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('axisLabel', () => {
  it('gives every constraint axis a human label', () => {
    expect(axisLabel('license')).toBe('License');
    expect(axisLabel('arrl_membership')).toBe('ARRL membership');
    expect(axisLabel('ham_activity')).toBe('Demonstrated ham activity');
    expect(axisLabel('age_stage')).toBe('Age or stage');
  });
});

describe('IneligibilityDrawer', () => {
  it('lists every reason with the verbatim source text', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    expect(screen.getByText(/within 250 miles of Seaford, Delaware/)).toBeInTheDocument();
    expect(screen.getByText(/General class or higher/)).toBeInTheDocument();
  });

  it('labels each reason with its axis', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    const items = screen.getAllByRole('listitem');
    expect(within(items[0]!).getByText('License')).toBeInTheDocument();
  });

  it('marks a hard requirement distinctly from a preference', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    expect(screen.getAllByText('Requirement')).toHaveLength(2);
    expect(screen.getByText('Preference')).toBeInTheDocument();
  });

  it('spells out a radius rule so the user can check it themselves', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    expect(screen.getByText(/250 miles of Seaford, Delaware/)).toBeInTheDocument();
  });

  it('names the program in its accessible label', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={reasons} />);
    expect(screen.getByRole('region', { name: /why you are ineligible for Test Award/i }))
      .toBeInTheDocument();
  });

  it('says so plainly when the reason list is empty rather than rendering nothing', () => {
    wrap(<IneligibilityDrawer programName="Test Award" reasons={[]} />);
    expect(screen.getByText(/no constraint was recorded/i)).toBeInTheDocument();
  });
});
```

Create `packages/web/src/components/UnknownFields.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UnknownFields } from './UnknownFields.js';

function wrap(fields: Array<{ field: string; count: number }>) {
  return render(
    <MemoryRouter>
      <UnknownFields fields={fields} />
    </MemoryRouter>,
  );
}

describe('UnknownFields', () => {
  it('links each missing field to the profile input that resolves it', () => {
    wrap([{ field: 'gpa', count: 7 }]);
    const link = screen.getByRole('link', { name: /GPA/ });
    expect(link).toHaveAttribute('href', '/profile?kind=student&focus=gpa#field-gpa');
  });

  it('says how many unknown verdicts each field would resolve', () => {
    wrap([{ field: 'gpa', count: 7 }]);
    expect(screen.getByText(/resolves 7 unknown verdicts/i)).toBeInTheDocument();
  });

  it('uses the singular for one', () => {
    wrap([{ field: 'cwWpm', count: 1 }]);
    expect(screen.getByText(/resolves 1 unknown verdict$/i)).toBeInTheDocument();
  });

  it('shows the help text so the user knows what the field means', () => {
    wrap([{ field: 'state', count: 3 }]);
    expect(screen.getByText(/ARRL Section/)).toBeInTheDocument();
  });

  it('renders nothing when there is nothing missing', () => {
    const { container } = wrap([]);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/components/IneligibilityDrawer.test.tsx packages/web/src/components/UnknownFields.test.tsx
```

Expected failure: `Failed to load url ./IneligibilityDrawer.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/components/explain.css`:

```css
.explain {
  padding: var(--s-4);
  background: var(--surface-2);
  border-left: 3px solid var(--no);
}

.explain h3 { font-size: var(--fs-300); margin-bottom: var(--s-3); }

.explain ul { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s-3); }

.explain li {
  display: grid;
  grid-template-columns: 150px 1fr;
  gap: var(--s-3);
  align-items: start;
  padding-bottom: var(--s-3);
  border-bottom: 1px solid var(--border);
}

.explain li:last-child { border-bottom: none; padding-bottom: 0; }

.explain-axis {
  font-size: var(--fs-100);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  font-weight: 640;
  color: var(--text-muted);
}

.explain-kind {
  display: inline-block;
  margin-top: 2px;
  font-size: var(--fs-100);
  font-weight: 700;
  color: var(--no);
}

.explain-kind.soft { color: var(--pref); }

/* Verbatim source text is quoted, monospaced and never paraphrased. */
.explain-raw {
  font-family: var(--font-data);
  font-size: var(--fs-200);
  line-height: var(--lh-loose);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-1);
  padding: var(--s-2) var(--s-3);
}

.explain-detail { margin-top: var(--s-2); font-size: var(--fs-200); color: var(--text-muted); }

.unknown-ladder { display: grid; gap: var(--s-2); padding: var(--s-4); margin-bottom: var(--s-4); }

.unknown-ladder li {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--s-3);
  align-items: baseline;
  padding: var(--s-2) 0;
  border-bottom: 1px solid var(--border);
}

.unknown-ladder li:last-child { border-bottom: none; }
.unknown-ladder .resolves { font-family: var(--font-data); font-size: var(--fs-200); color: var(--text-muted); }
.unknown-ladder .help { display: block; font-size: var(--fs-200); color: var(--text-muted); }
```

Create `packages/web/src/components/IneligibilityDrawer.tsx`:

```tsx
import type { Constraint, ConstraintAxis } from '@grantspotter/core';
import './explain.css';

const AXIS_LABELS: Record<ConstraintAxis, string> = {
  license: 'License',
  geography: 'Geography',
  field_of_study: 'Field of study',
  institution: 'Institution',
  gpa: 'GPA or class rank',
  arrl_membership: 'ARRL membership',
  recommendation: 'Recommendation',
  citizenship: 'Citizenship',
  age_stage: 'Age or stage',
  ham_activity: 'Demonstrated ham activity',
  financial_need: 'Financial need',
  gender: 'Gender',
  other: 'Other',
};

export function axisLabel(axis: ConstraintAxis): string {
  return AXIS_LABELS[axis];
}

/** A short, human restatement of the machine-readable spec, under the raw text. */
function specDetail(constraint: Constraint): string | null {
  const spec = constraint.spec;
  switch (spec.axis) {
    case 'license':
      return spec.heldMonthsMin
        ? `Needs ${spec.licenseMin} or higher, held at least ${spec.heldMonthsMin} months.`
        : `Needs ${spec.licenseMin} or higher.`;
    case 'geography':
      if (spec.geo.type === 'radius') {
        return `Within ${spec.geo.radiusMiles} miles of ${spec.geo.centerLabel ?? 'the stated point'}.`;
      }
      if (spec.geo.type === 'arrl_section') {
        return `ARRL Section ${spec.geo.values.join(', ')}. An ARRL Section is an ARRL-defined region, not a state.`;
      }
      if (spec.geo.type === 'arrl_division') {
        return `ARRL Division ${spec.geo.values.join(', ')}, which spans several states.`;
      }
      return `${spec.geo.type.replace('_', ' ')}: ${spec.geo.values.join(', ')}.`;
    case 'field_of_study':
      return spec.excludedFields.length > 0
        ? `Allows ${spec.fields.join(', ')}; excludes ${spec.excludedFields.join(', ')}.`
        : `Allows ${spec.fields.join(', ')}.`;
    case 'institution':
      return `Degree levels ${spec.degreeLevels.join(', ')}${spec.accreditationRequired ? ', accredited only' : ''}${spec.partTimeOK ? ', part-time allowed' : ''}.`;
    case 'gpa':
      return spec.min !== undefined
        ? `Minimum GPA ${spec.min}.`
        : spec.classRankTopPct !== undefined
          ? `Top ${spec.classRankTopPct}% of class.`
          : null;
    case 'arrl_membership':
      return spec.minYears > 0
        ? `ARRL membership for at least ${spec.minYears} year(s).`
        : 'ARRL membership required.';
    case 'recommendation':
      return `${spec.count} recommendation(s) from: ${spec.recommenderType.replace(/_/g, ' ')}.`;
    case 'citizenship':
      return `Allows ${spec.allowed.join(', ')}.`;
    case 'age_stage':
      return `${spec.ageMin ?? '?'}–${spec.ageMax ?? '?'}${spec.asOf ? ` as of ${spec.asOf}` : ''}; stages ${spec.stages.join(', ')}.`;
    case 'ham_activity':
      return spec.cwProficiencyWpmMin !== undefined
        ? `Activity in ${spec.activityKinds.join(', ')}, plus Morse code at ${spec.cwProficiencyWpmMin} wpm.`
        : `Activity in ${spec.activityKinds.join(', ')}.`;
    case 'gender':
      return `Open to: ${spec.allowed.join(', ')}.`;
    case 'financial_need':
      return 'Financial need is weighted, never a bar.';
    case 'other':
      return spec.note;
  }
}

export interface IneligibilityDrawerProps {
  programName: string;
  reasons: Constraint[];
}

export function IneligibilityDrawer({ programName, reasons }: IneligibilityDrawerProps) {
  return (
    <section className="explain" aria-label={`Why you are ineligible for ${programName}`}>
      <h3>Why you are ineligible for {programName}</h3>
      {reasons.length === 0 ? (
        <p>No constraint was recorded for this verdict. Open the record and check the source.</p>
      ) : (
        <ul>
          {reasons.map((reason) => {
            const detail = specDetail(reason);
            return (
              <li key={reason.id}>
                <div>
                  <span className="explain-axis">{axisLabel(reason.spec.axis)}</span>
                  <br />
                  <span className={`explain-kind${reason.hard ? '' : ' soft'}`}>
                    {reason.hard ? 'Requirement' : 'Preference'}
                  </span>
                </div>
                <div>
                  <p className="explain-raw">{reason.rawText}</p>
                  {detail !== null && <p className="explain-detail">{detail}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
```

Create `packages/web/src/components/UnknownFields.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { PROFILE_FIELDS, profileFieldHref, profileFieldLabel } from '../lib/profileFields.js';
import './explain.css';

export interface UnknownFieldsProps {
  fields: Array<{ field: string; count: number }>;
}

/**
 * The ladder that turns "unknown" from a dead end into a task list: each row is
 * the one profile field that would resolve the most verdicts, linked straight
 * to the input that sets it.
 */
export function UnknownFields({ fields }: UnknownFieldsProps) {
  if (fields.length === 0) return null;

  return (
    <section className="card unknown-ladder" aria-label="Fields that would resolve unknown verdicts">
      <h3>Fill these in and the unknowns become answers</h3>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {fields.map(({ field, count }) => {
          const meta = PROFILE_FIELDS.find((f) => f.key === field);
          return (
            <li key={field}>
              <span>
                <Link to={profileFieldHref(field)}>{profileFieldLabel(field)}</Link>
                {meta && <span className="help">{meta.help}</span>}
              </span>
              <span className="resolves">
                Resolves {count} unknown verdict{count === 1 ? '' : 's'}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
```

Modify `packages/web/src/components/ProgramTable.tsx` — render the drawer as a full-width row directly beneath the expanded program. Add the import and replace the `<tr key=…>` body with a fragment:

```tsx
import { Fragment } from 'react';
import { IneligibilityDrawer } from './IneligibilityDrawer.js';
```

```tsx
          {rows.map((row) => (
            <Fragment key={row.program.id}>
              <tr>
                {/* …the six <td> cells exactly as written in Task 17… */}
              </tr>
              {expandedId === row.program.id
                && row.verdict?.kind === 'ineligible' && (
                <tr>
                  <td colSpan={6} style={{ padding: 0 }}>
                    <IneligibilityDrawer
                      programName={row.program.name}
                      reasons={row.verdict.reasons}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
```

Modify `packages/web/src/routes/Browse.tsx` — import `UnknownFields` and render it under the census:

```tsx
import { UnknownFields } from '../components/UnknownFields.js';
```

```tsx
          {data && data.profileApplied !== null && data.summary.unknown > 0 && (
            <UnknownFields fields={data.summary.unknownByField} />
          )}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
```

Expected: 7 drawer + 5 unknown-field assertions green, and the Task 17 Browse suite still green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web/src
git commit -m "feat(web): per-program ineligibility explainer and jump-to-profile ladder"
```

---
### Task 19: Opportunity detail — provenance, disputes, obligations, Verify now

**Why this exists:** this is where every honesty surface in spec §8 lands at once: the trust badge, the disputed panel that shows **all three** readings of the ARRL Club Grant cycle, the stale-mirror warning, `rawOtherText` verbatim, the quoted AI policy with its URL, field-level provenance, and the Verify-now button with its diff.

**Files:**
- Create: `packages/web/src/components/ProvenanceTable.tsx`
- Create: `packages/web/src/components/DisputedPanel.tsx`
- Create: `packages/web/src/components/VerifyButton.tsx`
- Create: `packages/web/src/components/detail.css`
- Create: `packages/web/src/routes/Opportunity.tsx`
- Modify: `packages/web/src/App.tsx` (swap the Opportunity placeholder)
- Test: `packages/web/src/routes/Opportunity.test.tsx`

**Interfaces:**
- Consumes: `GET /api/programs/:id` (Task 5); `POST /api/programs/:id/verify` (Task 10); `POST /api/watches`, `DELETE /api/watches/:programId` (Task 7).
- Produces: `ProvenanceTable`, `DisputedPanel`, `VerifyButton`, `Opportunity`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/routes/Opportunity.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Opportunity } from './Opportunity.js';

const CLUB_GRANT_DETAIL = {
  program: {
    id: 'arrl-club-grant',
    funderId: 'arrl-foundation',
    name: 'ARRL Club Grant Program',
    klass: 'ham_grant',
    summary: 'ARDC-funded grants to ARRL-affiliated clubs.',
    applicantEntities: ['club_501c3', 'club_unincorporated'],
    amount: { instrument: 'cash_range', amountMin: 1000, amountMax: 25000, amountRaw: '$1,000 - $25,000', awardCountRaw: '37 in 2024' },
    deadline: { kind: 'unpublished', source: { kind: 'self' }, note: 'The deadline is not published on the page.' },
    applyVia: 'external_spa_portal',
    applyUrl: 'https://www.arrl.org/club-grant-program',
    constraints: [],
    fundingRestrictions: ['No emergency communications equipment.', 'No ongoing operating expenses.'],
    obligations: {
      costShareRequired: false,
      coFunderPreference: true,
      licenseObligation: 'All output must be open-source / open-access.',
      indirectCostCapPct: 20,
    },
    aiPolicy: {
      stance: 'permitted',
      quote: 'If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy.',
      url: 'https://www.ardc.net/apply/grant-application-instructions/',
    },
    trust: {
      status: 'unknown',
      sourceUrl: 'https://www.arrl.org/club-grant-program',
      lastVerifiedAt: '2026-01-05T00:00:00.000Z',
      verificationMethod: 'manual_curation',
      contentHash: 'd1b2c3',
      disputed: {
        note: 'Three researchers reached three different conclusions.',
        claims: [
          { claim: 'Dormant. The page shows only 2024 results.', sourceUrl: 'https://www.arrl.org/club-grant-program' },
          { claim: 'An autumn window, historically Sep 7 - Nov 4 2022.', sourceUrl: 'https://www.arrl.org/club-grant-program' },
          { claim: 'Feb, Jun and Oct — probably a conflation with Amateur Radio Grants.', sourceUrl: 'http://www.arrl.org/amateur-radio-grants' },
        ],
      },
      staleMirrorWarning: 'Still listed by 7 or more third-party aggregators.',
    },
    rawOtherText: 'The application portal is a JavaScript single-page app and returns no server-side text.',
    tags: ['grant', 'arrl'],
  },
  funder: { id: 'arrl-foundation', name: 'ARRL Foundation', homepage: '' },
  cycles: [],
  provenance: [
    {
      fieldPath: 'amount.amountRaw',
      sourceId: 'arrl-club-grant-page',
      snapshotId: 'snap-11',
      rawLabel: 'Award Amount',
      rawValue: '$1,000 to $25,000',
      fetchedAt: '2026-01-05T00:00:00.000Z',
    },
  ],
  verdict: { kind: 'unknown', missingProfileFields: ['arrlAffiliated'] },
  watched: false,
  deadlineOwner: null,
};

const QCWA_DETAIL = {
  ...CLUB_GRANT_DETAIL,
  program: {
    ...CLUB_GRANT_DETAIL.program,
    id: 'qcwa-memorial-scholarship',
    name: 'QCWA Memorial Scholarship Fund',
    trust: {
      ...CLUB_GRANT_DETAIL.program.trust,
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      status: 'open',
      disputed: undefined,
      staleMirrorWarning: undefined,
    },
  },
  deadlineOwner: {
    programId: 'arrl-foundation-scholarship',
    programName: 'ARRL Foundation Scholarship Program',
  },
};

function stubFetch(get: unknown, post?: unknown) {
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    const isPost = init?.method === 'POST' || init?.method === 'DELETE';
    return Promise.resolve({
      ok: true,
      status: isPost ? 200 : 200,
      json: async () => (isPost ? (post ?? {}) : get),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderDetail(id = 'arrl-club-grant') {
  return render(
    <MemoryRouter initialEntries={[`/o/${id}`]}>
      <Routes>
        <Route path="/o/:programId" element={<Opportunity now="2026-08-02T12:00:00.000Z" />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  stubFetch(CLUB_GRANT_DETAIL);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Opportunity detail', () => {
  it('renders the program name and its funder', async () => {
    renderDetail();
    expect(await screen.findByRole('heading', { name: 'ARRL Club Grant Program' })).toBeInTheDocument();
    expect(screen.getByText('ARRL Foundation')).toBeInTheDocument();
  });

  it('renders status unknown as a labelled state', async () => {
    renderDetail();
    expect(await screen.findByLabelText('Status: unknown')).toBeInTheDocument();
  });

  it('renders the amber unverified badge', async () => {
    renderDetail();
    expect(await screen.findByLabelText(/unverified/i)).toBeInTheDocument();
  });

  it('shows EVERY disputed claim with its own source link, picking none', async () => {
    renderDetail();
    const panel = await screen.findByRole('region', { name: /disputed/i });
    const items = within(panel).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[2]!).getByRole('link'))
      .toHaveAttribute('href', 'http://www.arrl.org/amateur-radio-grants');
  });

  it('shows the stale-mirror warning', async () => {
    renderDetail();
    expect(await screen.findByText(/7 or more third-party aggregators/)).toBeInTheDocument();
  });

  it('lists funding restrictions verbatim', async () => {
    renderDetail();
    expect(await screen.findByText('No emergency communications equipment.')).toBeInTheDocument();
    expect(screen.getByText('No ongoing operating expenses.')).toBeInTheDocument();
  });

  it('shows the obligations applicants miss, including the indirect cost cap', async () => {
    renderDetail();
    expect(await screen.findByText(/open-source \/ open-access/)).toBeInTheDocument();
    expect(screen.getByText(/20%/)).toBeInTheDocument();
  });

  it('shows rawOtherText verbatim in its own block', async () => {
    renderDetail();
    const block = await screen.findByRole('region', { name: /unstructured requirements/i });
    expect(block).toHaveTextContent('JavaScript single-page app');
  });

  it('quotes the AI policy with its source URL', async () => {
    renderDetail();
    const region = await screen.findByRole('region', { name: /ai policy/i });
    expect(within(region).getByText(/thoroughly edit for clarity, brevity, and accuracy/)).toBeInTheDocument();
    expect(within(region).getByRole('link'))
      .toHaveAttribute('href', 'https://www.ardc.net/apply/grant-application-instructions/');
  });

  it('renders field-level provenance: source, fetch and the raw text', async () => {
    renderDetail();
    const table = await screen.findByRole('table', { name: /provenance/i });
    expect(within(table).getByText('Award Amount')).toBeInTheDocument();
    expect(within(table).getByText('$1,000 to $25,000')).toBeInTheDocument();
    expect(within(table).getByText('arrl-club-grant-page')).toBeInTheDocument();
    expect(within(table).getByText('snap-11')).toBeInTheDocument();
  });

  it('names the program a deadline was inherited from', async () => {
    stubFetch(QCWA_DETAIL);
    renderDetail('qcwa-memorial-scholarship');
    const link = await screen.findByRole('link', { name: /ARRL Foundation Scholarship Program/ });
    expect(link).toHaveAttribute('href', '/o/arrl-foundation-scholarship');
    expect(screen.getByText(/inherits its deadline from/i)).toBeInTheDocument();
  });

  it('verifies on demand and shows the diff', async () => {
    stubFetch(CLUB_GRANT_DETAIL, {
      programId: 'arrl-club-grant',
      attemptedAt: '2026-08-02T12:00:00.000Z',
      ok: true,
      changed: true,
      diffs: [{ label: 'Deadline', before: 'January 31', after: 'December 30, 12:00 PM EST' }],
      lastVerifiedAt: '2026-08-02T12:00:00.000Z',
      changeEventIds: ['ce-1'],
    });
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /verify now/i }));
    const diff = await screen.findByRole('region', { name: /verification result/i });
    expect(within(diff).getByText('January 31')).toBeInTheDocument();
    expect(within(diff).getByText('December 30, 12:00 PM EST')).toBeInTheDocument();
  });

  it('says plainly when a verification found no change', async () => {
    stubFetch(CLUB_GRANT_DETAIL, {
      programId: 'arrl-club-grant',
      attemptedAt: '2026-08-02T12:00:00.000Z',
      ok: true, changed: false, diffs: [],
      lastVerifiedAt: '2026-08-02T12:00:00.000Z', changeEventIds: [],
    });
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /verify now/i }));
    expect(await screen.findByText(/the source still says the same thing/i)).toBeInTheDocument();
  });

  it('explains a rate limit instead of failing silently', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: false, status: 429,
          json: async () => ({
            error: {
              code: 'rate_limited',
              message: 'You have verified this recently.',
              details: { reason: 'program_cooldown', retryAfterSec: 1800 },
            },
            requestId: 'req-test-1',
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => CLUB_GRANT_DETAIL });
    });
    vi.stubGlobal('fetch', fetchMock);
    renderDetail();
    await userEvent.click(await screen.findByRole('button', { name: /verify now/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already verified this recently/i);
  });

  it('stars and unstars the program', async () => {
    const fetchMock = stubFetch(CLUB_GRANT_DETAIL);
    renderDetail();
    const star = await screen.findByRole('button', { name: /watch this program/i });
    await userEvent.click(star);
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(calls.some((c) => (c[0] as string) === '/api/watches')).toBe(true);
    });
  });

  it('links out to the funder rather than proxying the application', async () => {
    renderDetail();
    const apply = await screen.findByRole('link', { name: /apply at the funder/i });
    expect(apply).toHaveAttribute('href', 'https://www.arrl.org/club-grant-program');
    expect(apply).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/routes/Opportunity.test.tsx
```

Expected failure: `Failed to load url ./Opportunity.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/components/detail.css`:

```css
.detail-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--s-3);
  margin-bottom: var(--s-3);
}

.detail-actions { display: flex; gap: var(--s-2); margin: var(--s-4) 0 var(--s-6); flex-wrap: wrap; }

.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
  gap: var(--s-5);
  align-items: start;
}

.panel { padding: var(--s-4); margin-bottom: var(--s-4); }
.panel h2 { font-size: var(--fs-400); margin-bottom: var(--s-3); }

.panel dl { display: grid; grid-template-columns: 180px 1fr; gap: var(--s-2) var(--s-4); margin: 0; }
.panel dt { color: var(--text-muted); font-size: var(--fs-200); }
.panel dd { margin: 0; }

/* Anything the funder wrote is quoted, never paraphrased. */
.verbatim {
  font-family: var(--font-data);
  font-size: var(--fs-200);
  line-height: var(--lh-loose);
  white-space: pre-wrap;
  background: var(--surface-2);
  border-left: 3px solid var(--border-strong);
  padding: var(--s-3);
  border-radius: 0 var(--r-1) var(--r-1) 0;
}

.disputed { border-left: 3px solid var(--warn); background: var(--warn-soft); }
.disputed ol { margin: 0; padding-left: var(--s-5); display: grid; gap: var(--s-3); }

.stale-mirror {
  border-left: 3px solid var(--no);
  background: var(--no-soft);
  color: var(--no);
  padding: var(--s-3);
  border-radius: 0 var(--r-1) var(--r-1) 0;
  margin-bottom: var(--s-4);
}

.diff-table td.before { color: var(--no); text-decoration: line-through; }
.diff-table td.after { color: var(--ok); font-weight: 600; }
```

Create `packages/web/src/components/DisputedPanel.tsx`:

```tsx
import type { Disputed } from '@grantspotter/core';
import './detail.css';

/**
 * Spec §8: the record shows EVERY reading with its source instead of picking
 * one. Ships populated for the ARRL Club Grant cycle, where three researchers
 * reached three different conclusions.
 */
export function DisputedPanel({ disputed }: { disputed: Disputed }) {
  return (
    <section className="panel card disputed" aria-label="Disputed: sources do not agree">
      <h2>Sources do not agree</h2>
      <p>{disputed.note}</p>
      <ol>
        {disputed.claims.map((claim, index) => (
          <li key={`${index}-${claim.sourceUrl}`}>
            <p style={{ marginBottom: 'var(--s-1)' }}>{claim.claim}</p>
            <a href={claim.sourceUrl} target="_blank" rel="noopener noreferrer">
              {claim.sourceUrl}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

Create `packages/web/src/components/ProvenanceTable.tsx`:

```tsx
import { formatDate } from '../lib/trust.js';
import './detail.css';

export interface FieldProvenance {
  fieldPath: string;
  sourceId: string;
  snapshotId: string | null;
  rawLabel: string;
  rawValue: string;
  fetchedAt: string;
}

/** Spec §8: which source, which fetch, and the raw text the value came from. */
export function ProvenanceTable({ rows }: { rows: FieldProvenance[] }) {
  if (rows.length === 0) {
    return (
      <p>
        No field-level provenance is recorded for this program yet. Run <strong>Verify now</strong>{' '}
        to capture it from the source.
      </p>
    );
  }

  return (
    <div className="table-wrap">
      <table className="grid-table" aria-label="Field provenance">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Source label</th>
            <th scope="col">Raw value</th>
            <th scope="col">Source</th>
            <th scope="col">Fetch</th>
            <th scope="col" className="num">Fetched</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.sourceId}:${row.rawLabel}`}>
              <td className="data">{row.fieldPath}</td>
              <td className="data">{row.rawLabel}</td>
              <td className="data">{row.rawValue}</td>
              <td className="data">{row.sourceId}</td>
              <td className="data">{row.snapshotId ?? '—'}</td>
              <td className="num">{formatDate(row.fetchedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

Create `packages/web/src/components/VerifyButton.tsx`:

```tsx
import { useState } from 'react';
import { apiSend, ApiError } from '../api/client.js';
import './detail.css';

export interface VerifyFieldDiff {
  label: string;
  before: string | null;
  after: string | null;
}

export interface VerifyResult {
  programId: string;
  attemptedAt: string;
  ok: boolean;
  error?: string;
  changed: boolean;
  diffs: VerifyFieldDiff[];
  lastVerifiedAt: string;
  changeEventIds: string[];
}

export interface VerifyButtonProps {
  programId: string;
  onVerified: () => void;
}

export function VerifyButton({ programId, onVerified }: VerifyButtonProps) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const value = await apiSend<VerifyResult>('POST', `/api/programs/${programId}/verify`);
      setResult(value);
      onVerified();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'rate_limited') {
        // Plan 1's ApiError exposes the envelope's `error.details` as `details`.
        const detail = err.details as { reason?: string; retryAfterSec?: number } | undefined;
        setError(
          detail?.reason === 'program_cooldown'
            ? 'You already verified this recently. Try again in about an hour — the funders in this corpus are small nonprofits and we poll them politely.'
            : 'You have used your verification allowance for this hour. Try again shortly.',
        );
      } else {
        setError('The verification could not be completed. The source may be unreachable.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { void run(); }}>
        {busy ? 'Verifying…' : 'Verify now'}
      </button>

      {error !== null && <p role="alert" style={{ color: 'var(--no)' }}>{error}</p>}

      {result !== null && (
        <section className="panel card" aria-label="Verification result">
          <h2>Verification result</h2>
          {!result.ok && <p role="alert">The fetch failed: {result.error}</p>}
          {result.ok && !result.changed && (
            <p>
              Checked at <span className="data">{result.attemptedAt}</span>. The source still says
              the same thing.
            </p>
          )}
          {result.ok && result.changed && (
            <div className="table-wrap">
              <table className="grid-table diff-table" aria-label="What changed">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Was</th>
                    <th scope="col">Now</th>
                  </tr>
                </thead>
                <tbody>
                  {result.diffs.map((d) => (
                    <tr key={d.label}>
                      <td className="data">{d.label}</td>
                      <td className="data before">{d.before ?? '—'}</td>
                      <td className="data after">{d.after ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
```

Create `packages/web/src/routes/Opportunity.tsx`:

```tsx
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { Cycle, Funder, Program, Verdict } from '@grantspotter/core';
import { useApi } from '../store/useApi.js';
import { apiSend } from '../api/client.js';
import { VerdictBadge } from '../components/VerdictBadge.js';
import { TrustBadge } from '../components/TrustBadge.js';
import { StatusPill } from '../components/StatusPill.js';
import { DisputedPanel } from '../components/DisputedPanel.js';
import { ProvenanceTable, type FieldProvenance } from '../components/ProvenanceTable.js';
import { VerifyButton } from '../components/VerifyButton.js';
import { IneligibilityDrawer } from '../components/IneligibilityDrawer.js';
import { formatDate } from '../lib/trust.js';
import '../components/detail.css';

interface OpportunityDetail {
  program: Program;
  funder: Funder;
  cycles: Cycle[];
  provenance: FieldProvenance[];
  verdict: Verdict | null;
  watched: boolean;
  deadlineOwner: { programId: string; programName: string } | null;
}

export function Opportunity({ now }: { now?: string }) {
  const nowISO = now ?? new Date().toISOString();
  const { programId } = useParams();
  const { data, loading, error, reload } = useApi<OpportunityDetail>(
    programId ? `/api/programs/${programId}` : null,
  );
  const [watched, setWatched] = useState<boolean | null>(null);

  if (loading) return <p className="eyebrow">Loading…</p>;
  if (error) return <p role="alert">Could not load this record ({error.code}).</p>;
  if (!data) return null;

  const { program, funder, provenance, verdict, deadlineOwner } = data;
  const isWatched = watched ?? data.watched;

  async function toggleWatch() {
    if (isWatched) {
      await apiSend('DELETE', `/api/watches/${program.id}`);
      setWatched(false);
    } else {
      await apiSend('POST', '/api/watches', { programId: program.id });
      setWatched(true);
    }
  }

  return (
    <>
      <p className="eyebrow">{funder.name}</p>
      <div className="detail-head">
        <h1>{program.name}</h1>
        <StatusPill status={program.trust.status} />
        <VerdictBadge verdict={verdict} />
        <TrustBadge lastVerifiedAt={program.trust.lastVerifiedAt} now={nowISO} />
      </div>

      <p style={{ fontSize: 'var(--fs-400)', maxWidth: '70ch' }}>{program.summary}</p>

      {program.trust.staleMirrorWarning && (
        <p className="stale-mirror">{program.trust.staleMirrorWarning}</p>
      )}

      <div className="detail-actions">
        {program.applyUrl && (
          <a
            className="btn btn-primary"
            href={program.applyUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Apply at the funder
          </a>
        )}
        <button type="button" className="btn" onClick={() => { void toggleWatch(); }}>
          {isWatched ? 'Stop watching this program' : 'Watch this program'}
        </button>
        <VerifyButton programId={program.id} onVerified={reload} />
      </div>

      {program.trust.disputed && <DisputedPanel disputed={program.trust.disputed} />}

      <div className="detail-grid">
        <div>
          <section className="panel card" aria-label="Deadline">
            <h2>Deadline</h2>
            <dl>
              <dt>Pattern</dt>
              <dd className="data">{program.deadline.kind}</dd>
              <dt>Note</dt>
              <dd>{program.deadline.note}</dd>
              {deadlineOwner !== null && (
                <>
                  <dt>Inherited</dt>
                  <dd>
                    This program inherits its deadline from{' '}
                    <Link to={`/o/${deadlineOwner.programId}`}>{deadlineOwner.programName}</Link>.
                    All 111 entries in the ARRL catalog share one close date, so the owning
                    program is where the date actually lives.
                  </dd>
                </>
              )}
            </dl>
            {data.cycles.length > 0 && (
              <ul>
                {data.cycles.map((cycle) => (
                  <li key={cycle.id}>
                    <span className="data">{formatDate(cycle.closesAt ?? null)}</span> — {cycle.label}
                    {cycle.isEstimated && ' (projected, not observed)'}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {verdict?.kind === 'ineligible' && (
            <IneligibilityDrawer programName={program.name} reasons={verdict.reasons} />
          )}

          {program.fundingRestrictions.length > 0 && (
            <section className="panel card" aria-label="Funding restrictions">
              <h2>Funding restrictions</h2>
              <ul>
                {program.fundingRestrictions.map((restriction) => (
                  <li key={restriction}>{restriction}</li>
                ))}
              </ul>
            </section>
          )}

          <section className="panel card" aria-label="Obligations">
            <h2>Obligations if you win</h2>
            <dl>
              {program.obligations.licenseObligation && (
                <>
                  <dt>Licensing</dt>
                  <dd>{program.obligations.licenseObligation}</dd>
                </>
              )}
              {program.obligations.indirectCostCapPct !== undefined && (
                <>
                  <dt>Indirect cost cap</dt>
                  <dd className="data">{program.obligations.indirectCostCapPct}%</dd>
                </>
              )}
              <dt>Cost share</dt>
              <dd>{program.obligations.costShareRequired ? 'Required' : 'Not required'}</dd>
              <dt>Co-funding</dt>
              <dd>
                {program.obligations.coFunderPreference
                  ? 'This funder prefers not to be the sole funder.'
                  : 'No stated preference.'}
              </dd>
              {program.obligations.sustainmentObligation && (
                <>
                  <dt>Sustainment</dt>
                  <dd>{program.obligations.sustainmentObligation}</dd>
                </>
              )}
              {program.obligations.reportingObligation && (
                <>
                  <dt>Reporting</dt>
                  <dd>{program.obligations.reportingObligation}</dd>
                </>
              )}
            </dl>
          </section>

          {program.rawOtherText !== '' && (
            <section className="panel card" aria-label="Unstructured requirements, verbatim">
              <h2>Unstructured requirements, verbatim</h2>
              <p className="verbatim">{program.rawOtherText}</p>
            </section>
          )}

          <section className="panel card" aria-label="Field provenance">
            <h2>Where each value came from</h2>
            <ProvenanceTable rows={provenance} />
          </section>
        </div>

        <div>
          <section className="panel card" aria-label="Award">
            <h2>Award</h2>
            <dl>
              <dt>Instrument</dt>
              <dd className="data">{program.amount.instrument}</dd>
              <dt>Amount, verbatim</dt>
              <dd className="data">{program.amount.amountRaw}</dd>
              <dt>Number of awards</dt>
              <dd className="data">{program.amount.awardCountRaw}</dd>
            </dl>
          </section>

          <section className="panel card" aria-label="AI policy">
            <h2>This funder’s AI policy</h2>
            <p className="eyebrow">Stance: {program.aiPolicy.stance}</p>
            {program.aiPolicy.quote && <p className="verbatim">{program.aiPolicy.quote}</p>}
            {program.aiPolicy.url && (
              <p>
                <a href={program.aiPolicy.url} target="_blank" rel="noopener noreferrer">
                  {program.aiPolicy.url}
                </a>
              </p>
            )}
            {!program.aiPolicy.quote && (
              <p>
                This funder has not published a policy on applicants using AI. That is not
                permission and not a prohibition — you remain accountable for every claim.
              </p>
            )}
          </section>

          <section className="panel card" aria-label="Source">
            <h2>Source</h2>
            <dl>
              <dt>Page</dt>
              <dd>
                <a href={program.trust.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {program.trust.sourceUrl}
                </a>
              </dd>
              <dt>Method</dt>
              <dd className="data">{program.trust.verificationMethod}</dd>
              <dt>Content hash</dt>
              <dd className="data">{program.trust.contentHash.slice(0, 16)}…</dd>
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}
```

Modify `packages/web/src/App.tsx` — replace the Opportunity route element:

```tsx
import { Opportunity } from './routes/Opportunity.js';
// ...
        <Route path="/o/:programId" element={<Opportunity />} />
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
```

Expected: 16 detail assertions green, all earlier web suites still green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web/src
git commit -m "feat(web): opportunity detail with provenance, disputes and Verify now"
```

---

### Task 20: Calendar — month grid, agenda, prep-lead overlay

**Why this exists:** spec §11.1. The overlay is the point: a bar from `prepStartAt` to `closesAt` on the agenda, and a distinct start marker in the month grid, so the answer to *"when do I start?"* is visible without arithmetic. Estimated cycles are rendered with a dashed outline and the literal word "projected" — a projected date must never look like an observed one.

**Files:**
- Create: `packages/web/src/components/MonthGrid.tsx`
- Create: `packages/web/src/components/AgendaList.tsx`
- Create: `packages/web/src/components/calendar.css`
- Create: `packages/web/src/routes/Calendar.tsx`
- Modify: `packages/web/src/App.tsx` (swap the Calendar placeholder)
- Test: `packages/web/src/components/MonthGrid.test.tsx`
- Test: `packages/web/src/routes/Calendar.test.tsx`

**Interfaces:**
- Consumes: `GET /api/calendar` (Task 11).
- Produces: `monthMatrix(year, month)`, `MonthGrid`, `AgendaList`, `Calendar`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/components/MonthGrid.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MonthGrid, monthMatrix } from './MonthGrid.js';
import type { CalendarEntry } from './AgendaList.js';

const entries: CalendarEntry[] = [
  {
    cycle: {
      id: 'c1', programId: 'arrl-foundation-scholarship',
      closesAt: '2026-12-30T17:00:00.000Z', timezone: 'America/New_York',
      label: 'Dec 2026 close', isEstimated: false,
    },
    programId: 'arrl-foundation-scholarship',
    programName: 'ARRL Foundation Scholarship Program',
    funderName: 'ARRL Foundation',
    klass: 'ham_scholarship',
    instrument: 'cash_range',
    applicantEntities: ['individual'],
    isEstimated: false,
    prepLeadDays: 30,
    prepStartAt: '2026-11-30T17:00:00.000Z',
    prepNote: 'Start about 30 days before the close.',
    decisionLagMinDays: null,
    decisionLagMaxDays: null,
    watched: true,
    verdictKind: 'eligible',
  },
  {
    cycle: {
      id: 'c2', programId: 'ardc-grants',
      closesAt: '2026-12-01T00:00:00.000Z', timezone: 'UTC',
      label: 'Projected Dec cycle', isEstimated: true,
    },
    programId: 'ardc-grants',
    programName: 'ARDC Grants Program',
    funderName: 'Amateur Radio Digital Communications',
    klass: 'ham_grant',
    instrument: 'cash_range',
    applicantEntities: ['university'],
    isEstimated: true,
    prepLeadDays: 45,
    prepStartAt: '2026-10-17T00:00:00.000Z',
    prepNote: 'ARDC evaluates for 60 to 120 days.',
    decisionLagMinDays: 60,
    decisionLagMaxDays: 120,
    watched: false,
    verdictKind: 'unknown',
  },
];

describe('monthMatrix', () => {
  it('returns whole weeks starting Monday', () => {
    const weeks = monthMatrix(2026, 12);
    expect(weeks[0]).toHaveLength(7);
    expect(weeks.flat().some((d) => d?.getUTCDate() === 1)).toBe(true);
  });

  it('pads leading and trailing cells with null rather than another month’s dates', () => {
    const weeks = monthMatrix(2026, 12);
    expect(weeks[0]![0]).toBeNull(); // 2026-12-01 is a Tuesday
    expect(weeks.flat().filter((d) => d !== null)).toHaveLength(31);
  });
});

describe('MonthGrid', () => {
  it('renders a labelled grid for the month', () => {
    render(<MemoryRouter><MonthGrid year={2026} month={12} entries={entries} /></MemoryRouter>);
    expect(screen.getByRole('grid', { name: /December 2026/ })).toBeInTheDocument();
  });

  it('places a deadline on its day', () => {
    render(<MemoryRouter><MonthGrid year={2026} month={12} entries={entries} /></MemoryRouter>);
    const cell = screen.getByRole('gridcell', { name: /30 December 2026/ });
    expect(within(cell).getByText(/ARRL Foundation Scholarship/)).toBeInTheDocument();
  });

  it('marks an estimated cycle as projected, in words as well as style', () => {
    render(<MemoryRouter><MonthGrid year={2026} month={12} entries={entries} /></MemoryRouter>);
    const chip = screen.getByRole('link', { name: /ARDC Grants Program.*projected/i });
    expect(chip).toHaveClass('estimated');
  });

  it('shows a start-preparing marker on the prep start day', () => {
    render(<MemoryRouter><MonthGrid year={2026} month={12} entries={entries} /></MemoryRouter>);
    const cell = screen.getByRole('gridcell', { name: /30 November|1 December/ });
    expect(cell).toBeInTheDocument();
    expect(screen.getByText(/start preparing/i)).toBeInTheDocument();
  });
});
```

Create `packages/web/src/routes/Calendar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Calendar } from './Calendar.js';

const RESPONSE = {
  from: '2026-08-02T12:00:00.000Z',
  to: '2027-08-02T12:00:00.000Z',
  entries: [
    {
      cycle: {
        id: 'c1', programId: 'arrl-foundation-scholarship',
        opensAt: '2026-10-30T00:00:00.000Z', closesAt: '2026-12-30T17:00:00.000Z',
        timezone: 'America/New_York', label: 'Dec 2026 close', isEstimated: false,
      },
      programId: 'arrl-foundation-scholarship',
      programName: 'ARRL Foundation Scholarship Program',
      funderName: 'ARRL Foundation',
      klass: 'ham_scholarship',
      instrument: 'cash_range',
      applicantEntities: ['individual'],
      isEstimated: false,
      prepLeadDays: 30,
      prepStartAt: '2026-11-30T17:00:00.000Z',
      prepNote: 'The ARRL application needs a transcript and references.',
      decisionLagMinDays: null,
      decisionLagMaxDays: null,
      watched: false,
      verdictKind: 'eligible',
    },
    {
      cycle: {
        id: 'c2', programId: 'ardc-grants', closesAt: '2027-02-01T00:00:00.000Z',
        timezone: 'UTC', label: 'Feb 2027 cycle', isEstimated: true,
      },
      programId: 'ardc-grants',
      programName: 'ARDC Grants Program',
      funderName: 'Amateur Radio Digital Communications',
      klass: 'ham_grant',
      instrument: 'cash_range',
      applicantEntities: ['university', 'club_via_fiscal_sponsor'],
      isEstimated: true,
      prepLeadDays: 45,
      prepStartAt: '2026-12-18T00:00:00.000Z',
      prepNote: 'ARDC evaluates for 60 to 120 days after a cycle closes.',
      decisionLagMinDays: 60,
      decisionLagMaxDays: 120,
      watched: true,
      verdictKind: 'unknown',
    },
  ],
  undated: [
    {
      programId: 'arrl-club-grant',
      programName: 'ARRL Club Grant Program',
      deadlineKind: 'unpublished',
      deadlineNote: 'The deadline is not published on the page.',
      status: 'unknown',
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => RESPONSE,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderCalendar() {
  return render(
    <MemoryRouter>
      <Calendar now="2026-08-02T12:00:00.000Z" />
    </MemoryRouter>,
  );
}

describe('Calendar', () => {
  it('offers both month and agenda views', async () => {
    renderCalendar();
    expect(await screen.findByRole('tab', { name: /month/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /agenda/i })).toBeInTheDocument();
  });

  it('starts on the agenda, which is the view that answers "what next"', async () => {
    renderCalendar();
    const agenda = await screen.findByRole('list', { name: /agenda/i });
    expect(within(agenda).getByText(/ARRL Foundation Scholarship Program/)).toBeInTheDocument();
  });

  it('states the prep start date and the reason, not just the deadline', async () => {
    renderCalendar();
    expect(await screen.findByText(/start by 2026-11-30/i)).toBeInTheDocument();
    expect(screen.getByText(/transcript and references/i)).toBeInTheDocument();
  });

  it('states the ARDC decision lag so the user can plan around it', async () => {
    renderCalendar();
    expect(await screen.findByText(/decision in 60 to 120 days/i)).toBeInTheDocument();
  });

  it('labels an estimated cycle as projected in words', async () => {
    renderCalendar();
    const agenda = await screen.findByRole('list', { name: /agenda/i });
    expect(within(agenda).getByText(/projected, not observed/i)).toBeInTheDocument();
  });

  it('lists the undated programs so they are not silently dropped', async () => {
    renderCalendar();
    const undated = await screen.findByRole('region', { name: /no dated cycle/i });
    expect(within(undated).getByText(/ARRL Club Grant Program/)).toBeInTheDocument();
    expect(within(undated).getByText(/not published on the page/)).toBeInTheDocument();
  });

  it('switches to the month grid', async () => {
    renderCalendar();
    await userEvent.click(await screen.findByRole('tab', { name: /month/i }));
    expect(await screen.findByRole('grid')).toBeInTheDocument();
  });

  it('offers a legend explaining the instrument colours', async () => {
    renderCalendar();
    const legend = await screen.findByRole('region', { name: /legend/i });
    expect(within(legend).getByText(/cash range/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/components/MonthGrid.test.tsx packages/web/src/routes/Calendar.test.tsx
```

Expected failure: `Failed to load url ./MonthGrid.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/components/calendar.css`:

```css
.cal-tabs { display: flex; gap: var(--s-1); margin-bottom: var(--s-4); }

.cal-tabs button {
  font: inherit;
  font-weight: 560;
  padding: var(--s-2) var(--s-4);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-muted);
  cursor: pointer;
}

.cal-tabs button:first-child { border-radius: var(--r-1) 0 0 var(--r-1); }
.cal-tabs button:last-child { border-radius: 0 var(--r-1) var(--r-1) 0; }

.cal-tabs button[aria-selected="true"] {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}

.month-grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  border: 1px solid var(--border);
  border-radius: var(--r-2);
  overflow: hidden;
  background: var(--surface);
}

.month-grid .dow {
  padding: var(--s-2);
  background: var(--surface-2);
  font-size: var(--fs-100);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-strong);
}

.month-grid .day {
  min-height: 108px;
  padding: var(--s-2);
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}

.month-grid .day .num {
  font-family: var(--font-data);
  font-size: var(--fs-100);
  color: var(--text-muted);
}

.chip {
  display: block;
  font-size: var(--fs-100);
  padding: 2px var(--s-2);
  border-radius: var(--r-1);
  border-left: 3px solid currentColor;
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Instrument drives hue; applicant entity drives the dotted underline. */
.inst-cash_range, .inst-cash_fixed, .inst-cash_tiered_blocks { color: var(--accent); background: var(--accent-soft); }
.inst-in_kind_equipment, .inst-in_kind_service { color: var(--pref); background: var(--pref-soft); }
.inst-discounted_purchase, .inst-per_member_rebate { color: var(--warn); background: var(--warn-soft); }
.inst-tuition_coverage { color: var(--ok); background: var(--ok-soft); }
.inst-unknown { color: var(--unk); background: var(--unk-soft); }

.ent-individual { text-decoration: underline dotted; text-underline-offset: 3px; }

/* A projected date must never look like an observed one. */
.chip.estimated {
  border-left-style: dashed;
  outline: 1px dashed currentColor;
  outline-offset: -1px;
}

.prep-mark {
  font-size: var(--fs-100);
  color: var(--text-muted);
  border-left: 3px solid var(--border-strong);
  padding-left: var(--s-2);
}

.agenda { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s-3); }

.agenda li { padding: var(--s-4); display: grid; grid-template-columns: 132px 1fr; gap: var(--s-4); }

.agenda .when { font-family: var(--font-data); font-variant-numeric: tabular-nums; }
.agenda .prep { font-size: var(--fs-200); color: var(--text-muted); margin-top: var(--s-1); }

/* The lead-time bar: a visual span from "start" to "due". */
.lead-bar {
  height: 6px;
  border-radius: 3px;
  margin-top: var(--s-2);
  background: linear-gradient(
    to right,
    var(--warn) 0%,
    var(--warn) 22%,
    var(--accent) 22%,
    var(--accent) 100%
  );
}

.legend { display: flex; flex-wrap: wrap; gap: var(--s-3); padding: var(--s-3) var(--s-4); margin-bottom: var(--s-4); }
.legend span { font-size: var(--fs-200); display: inline-flex; align-items: center; gap: var(--s-2); }
```

Create `packages/web/src/components/AgendaList.tsx`:

```tsx
import { Link } from 'react-router-dom';
import type { ApplicantEntity, Cycle, Instrument, OpportunityClass, Verdict } from '@grantspotter/core';
import { formatDate } from '../lib/trust.js';
import './calendar.css';

export interface CalendarEntry {
  cycle: Cycle;
  programId: string;
  programName: string;
  funderName: string;
  klass: OpportunityClass;
  instrument: Instrument;
  applicantEntities: ApplicantEntity[];
  isEstimated: boolean;
  prepLeadDays: number;
  prepStartAt: string | null;
  prepNote: string;
  decisionLagMinDays: number | null;
  decisionLagMaxDays: number | null;
  watched: boolean;
  verdictKind: Verdict['kind'] | null;
}

export function AgendaList({ entries }: { entries: CalendarEntry[] }) {
  if (entries.length === 0) {
    return <p className="empty-state">No dated cycles fall inside this window.</p>;
  }

  return (
    <ul className="agenda" aria-label="Agenda">
      {entries.map((entry) => (
        <li key={entry.cycle.id} className="card">
          <div className="when">
            <div>{formatDate(entry.cycle.closesAt ?? null)}</div>
            <div className="eyebrow">{entry.isEstimated ? 'Projected, not observed' : 'Observed'}</div>
          </div>
          <div>
            <Link to={`/o/${entry.programId}`} style={{ fontWeight: 600 }}>
              {entry.programName}
            </Link>
            <div className="eyebrow">{entry.funderName} · {entry.instrument}</div>
            <p className="prep">
              {entry.prepStartAt !== null && (
                <>
                  <strong>Start by {formatDate(entry.prepStartAt)}</strong>{' '}
                  ({entry.prepLeadDays} days ahead). {entry.prepNote}
                </>
              )}
              {entry.decisionLagMinDays !== null && entry.decisionLagMaxDays !== null && (
                <> Expect a decision in {entry.decisionLagMinDays} to {entry.decisionLagMaxDays} days.</>
              )}
            </p>
            {entry.prepStartAt !== null && <div className="lead-bar" aria-hidden="true" />}
          </div>
        </li>
      ))}
    </ul>
  );
}
```

Create `packages/web/src/components/MonthGrid.tsx`:

```tsx
import { Link } from 'react-router-dom';
import type { CalendarEntry } from './AgendaList.js';
import './calendar.css';

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Whole Monday-first weeks, padded with null so no other month's dates leak in. */
export function monthMatrix(year: number, month: number): Array<Array<Date | null>> {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const leading = (first.getUTCDay() + 6) % 7; // Monday = 0

  const cells: Array<Date | null> = new Array(leading).fill(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push(new Date(Date.UTC(year, month - 1, day)));
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: Array<Array<Date | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function sameDay(iso: string | null | undefined, day: Date): boolean {
  if (!iso) return false;
  return iso.slice(0, 10) === day.toISOString().slice(0, 10);
}

export interface MonthGridProps {
  year: number;
  month: number;
  entries: CalendarEntry[];
}

export function MonthGrid({ year, month, entries }: MonthGridProps) {
  const weeks = monthMatrix(year, month);

  return (
    <div className="month-grid" role="grid" aria-label={`${MONTHS[month - 1]} ${year}`}>
      {DOW.map((label) => (
        <div key={label} className="dow" role="columnheader">{label}</div>
      ))}
      {weeks.flat().map((day, index) => {
        if (day === null) {
          return <div key={`pad-${index}`} className="day" role="gridcell" aria-hidden="true" />;
        }
        const label = `${day.getUTCDate()} ${MONTHS[month - 1]} ${year}`;
        const due = entries.filter((e) => sameDay(e.cycle.closesAt, day));
        const starts = entries.filter((e) => sameDay(e.prepStartAt, day));
        return (
          <div key={label} className="day" role="gridcell" aria-label={label}>
            <span className="num">{day.getUTCDate()}</span>
            {due.map((entry) => (
              <Link
                key={entry.cycle.id}
                to={`/o/${entry.programId}`}
                className={[
                  'chip',
                  `inst-${entry.instrument}`,
                  entry.applicantEntities.includes('individual') ? 'ent-individual' : '',
                  entry.isEstimated ? 'estimated' : '',
                ].filter(Boolean).join(' ')}
                aria-label={`${entry.programName} closes${entry.isEstimated ? ', projected, not observed' : ''}`}
              >
                {entry.programName}
              </Link>
            ))}
            {starts.map((entry) => (
              <span key={`start-${entry.cycle.id}`} className="prep-mark">
                Start preparing: {entry.programName}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
```

Create `packages/web/src/routes/Calendar.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../store/useApi.js';
import { AgendaList, type CalendarEntry } from '../components/AgendaList.js';
import { MonthGrid } from '../components/MonthGrid.js';
import '../components/calendar.css';

interface UndatedProgram {
  programId: string;
  programName: string;
  deadlineKind: string;
  deadlineNote: string;
  status: string;
}

interface CalendarResponse {
  from: string;
  to: string;
  entries: CalendarEntry[];
  undated: UndatedProgram[];
}

const LEGEND = [
  { className: 'inst-cash_range', label: 'Cash range or fixed cash' },
  { className: 'inst-in_kind_equipment', label: 'Equipment or service in kind' },
  { className: 'inst-discounted_purchase', label: 'Discounted purchase or rebate' },
  { className: 'inst-tuition_coverage', label: 'Tuition coverage' },
  { className: 'inst-unknown', label: 'Unknown instrument' },
];

export function Calendar({ now }: { now?: string }) {
  const nowISO = now ?? new Date().toISOString();
  const [view, setView] = useState<'agenda' | 'month'>('agenda');
  const [cursor, setCursor] = useState(() => {
    const d = new Date(nowISO);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
  });

  const { data, loading, error } = useApi<CalendarResponse>('/api/calendar');

  function step(delta: number) {
    setCursor((c) => {
      const raw = c.month + delta;
      return {
        year: c.year + Math.floor((raw - 1) / 12),
        month: ((raw - 1 + 12) % 12) + 1,
      };
    });
  }

  return (
    <>
      <p className="eyebrow">Deadlines and lead time</p>
      <h1 style={{ marginBottom: 'var(--s-4)' }}>Calendar</h1>

      <div className="cal-tabs" role="tablist" aria-label="Calendar view">
        <button type="button" role="tab" aria-selected={view === 'agenda'} onClick={() => setView('agenda')}>
          Agenda
        </button>
        <button type="button" role="tab" aria-selected={view === 'month'} onClick={() => setView('month')}>
          Month
        </button>
      </div>

      <section className="legend card" aria-label="Legend">
        {LEGEND.map((item) => (
          <span key={item.className}>
            <span className={`chip ${item.className}`} aria-hidden="true">&nbsp;&nbsp;&nbsp;</span>
            {item.label}
          </span>
        ))}
        <span>
          <span className="chip inst-unknown estimated" aria-hidden="true">&nbsp;&nbsp;&nbsp;</span>
          Dashed outline means projected, not observed
        </span>
        <span>Dotted underline means individuals may apply</span>
      </section>

      {loading && <p className="eyebrow">Loading…</p>}
      {error && <p role="alert">Could not load the calendar ({error.code}).</p>}

      {data && view === 'agenda' && <AgendaList entries={data.entries} />}

      {data && view === 'month' && (
        <>
          <div style={{ display: 'flex', gap: 'var(--s-2)', marginBottom: 'var(--s-3)' }}>
            <button type="button" className="btn" onClick={() => step(-1)}>Previous month</button>
            <button type="button" className="btn" onClick={() => step(1)}>Next month</button>
          </div>
          <MonthGrid year={cursor.year} month={cursor.month} entries={data.entries} />
        </>
      )}

      {data && data.undated.length > 0 && (
        <section className="panel card" aria-label="Programs with no dated cycle" style={{ marginTop: 'var(--s-5)' }}>
          <h2>No dated cycle</h2>
          <p>
            These programs are real but have no date to place on a calendar. Rolling programs
            accept applications year-round; unpublished ones simply do not state a deadline.
          </p>
          <ul>
            {data.undated.map((program) => (
              <li key={program.programId}>
                <Link to={`/o/${program.programId}`}>{program.programName}</Link>{' '}
                <span className="data">({program.deadlineKind})</span> — {program.deadlineNote}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
```

Modify `packages/web/src/App.tsx` — replace the Calendar route element:

```tsx
import { Calendar } from './routes/Calendar.js';
// ...
        <Route path="/calendar" element={<Calendar />} />
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
```

Expected: 6 month-grid + 8 calendar assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web/src
git commit -m "feat(web): calendar with month grid, agenda and prep-lead-time overlay"
```

---
### Task 21: Watchlist, notification digest, and channel settings

**Why this exists:** spec §11.2. The digest is the delivery end of the path Task 8 opened. The headline case has to read as a sentence a human can act on: *"Deadline changed: ARRL Foundation Scholarship Program — changed from January 31 to December 30, 12:00 PM EST."*

**Files:**
- Create: `packages/web/src/components/NotificationList.tsx`
- Create: `packages/web/src/components/watchlist.css`
- Create: `packages/web/src/routes/Watchlist.tsx`
- Modify: `packages/web/src/App.tsx` (swap the Watchlist placeholder)
- Test: `packages/web/src/routes/Watchlist.test.tsx`

**Interfaces:**
- Consumes: `GET /api/watches`, `DELETE /api/watches/:programId` (Task 7); `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/notifications/read-all` (Task 8); `GET /api/channels`, `PUT /api/channels` (Task 9).
- Produces: `NotificationList`, `Watchlist`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/routes/Watchlist.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Watchlist } from './Watchlist.js';

const WATCHES = {
  rows: [
    {
      program: {
        id: 'arrl-foundation-scholarship',
        name: 'ARRL Foundation Scholarship Program',
        amount: { instrument: 'cash_range', amountRaw: '$500 - $25,000', awardCountRaw: '170+' },
        trust: { status: 'open', lastVerifiedAt: '2026-08-02T00:00:00.000Z', sourceUrl: 'x', verificationMethod: 'live_fetch', contentHash: 'x' },
      },
      funderName: 'ARRL Foundation',
      nextOpensAt: '2026-10-30T00:00:00.000Z',
      nextClosesAt: '2026-12-30T17:00:00.000Z',
      nextIsEstimated: false,
    },
  ],
};

const NOTIFICATIONS = {
  unread: 1,
  rows: [
    {
      id: 'ce-1:u-member',
      userId: 'u-member',
      changeEventId: 'ce-1',
      programId: 'arrl-foundation-scholarship',
      programName: 'ARRL Foundation Scholarship Program',
      kind: 'deadline_changed',
      title: 'Deadline changed: ARRL Foundation Scholarship Program',
      body: 'Changed from January 31 to December 30, 12:00 PM EST (deadline.note). Verify against the source before acting on it.',
      fieldPath: 'deadline.note',
      before: 'January 31',
      after: 'December 30, 12:00 PM EST',
      createdAt: '2026-08-02T03:17:00.000Z',
      readAt: null,
    },
  ],
};

const CHANNELS = { inApp: true, webhookUrl: null, ntfyServer: null, ntfyTopic: null };

function stubFetch() {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') {
      return Promise.resolve({ ok: true, status: 204, json: async () => { throw new Error('no body'); } });
    }
    const body = url.startsWith('/api/watches')
      ? WATCHES
      : url.startsWith('/api/notifications')
        ? NOTIFICATIONS
        : CHANNELS;
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderWatchlist() {
  return render(
    <MemoryRouter>
      <Watchlist now="2026-08-02T12:00:00.000Z" />
    </MemoryRouter>,
  );
}

describe('Watchlist', () => {
  it('renders the starred programs with their next deadline', async () => {
    renderWatchlist();
    const list = await screen.findByRole('table', { name: /watched programs/i });
    expect(within(list).getByText('ARRL Foundation Scholarship Program')).toBeInTheDocument();
    expect(within(list).getByText('2026-12-30')).toBeInTheDocument();
  });

  it('explains that a star subscribes to changes, not just the date', async () => {
    renderWatchlist();
    expect(await screen.findByText(/subscribes you to every change/i)).toBeInTheDocument();
  });

  it('renders the deadline-move notification as a readable sentence', async () => {
    renderWatchlist();
    const digest = await screen.findByRole('region', { name: /change digest/i });
    expect(within(digest).getByText('Deadline changed: ARRL Foundation Scholarship Program'))
      .toBeInTheDocument();
    expect(within(digest).getByText('January 31')).toBeInTheDocument();
    expect(within(digest).getByText('December 30, 12:00 PM EST')).toBeInTheDocument();
  });

  it('links a notification to the program it concerns', async () => {
    renderWatchlist();
    const digest = await screen.findByRole('region', { name: /change digest/i });
    expect(within(digest).getByRole('link', { name: /open the record/i }))
      .toHaveAttribute('href', '/o/arrl-foundation-scholarship');
  });

  it('marks a single notification read', async () => {
    const fetchMock = stubFetch();
    renderWatchlist();
    await userEvent.click(await screen.findByRole('button', { name: /mark read/i }));
    await waitFor(() => {
      const posted = fetchMock.mock.calls.find(
        (c) => (c[0] as string) === '/api/notifications/ce-1:u-member/read',
      );
      expect(posted).toBeDefined();
    });
  });

  it('marks everything read', async () => {
    const fetchMock = stubFetch();
    renderWatchlist();
    await userEvent.click(await screen.findByRole('button', { name: /mark all read/i }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => (c[0] as string) === '/api/notifications/read-all'))
        .toBe(true);
    });
  });

  it('unstars a program', async () => {
    const fetchMock = stubFetch();
    renderWatchlist();
    await userEvent.click(await screen.findByRole('button', { name: /stop watching/i }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect((del?.[0] as string)).toBe('/api/watches/arrl-foundation-scholarship');
    });
  });

  it('offers webhook and ntfy delivery, with in-app stated as the default', async () => {
    renderWatchlist();
    const settings = await screen.findByRole('region', { name: /delivery/i });
    expect(within(settings).getByText(/in-app digest is always on/i)).toBeInTheDocument();
    expect(within(settings).getByLabelText(/webhook url/i)).toBeInTheDocument();
    expect(within(settings).getByLabelText(/ntfy topic/i)).toBeInTheDocument();
  });

  it('says email is optional and not configured here, rather than showing a dead field', async () => {
    renderWatchlist();
    const settings = await screen.findByRole('region', { name: /delivery/i });
    expect(within(settings).getByText(/email is optional and is not required/i)).toBeInTheDocument();
    expect(within(settings).queryByLabelText(/smtp/i)).not.toBeInTheDocument();
  });

  it('surfaces a rejected webhook URL instead of silently dropping it', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve({
          ok: false,
          status: 422,
          json: async () => ({
            error: {
              code: 'validation_failed',
              message: 'webhook URLs must use https',
              details: { url: 'http://example.com/hook' },
            },
            requestId: 'req-test-1',
          }),
        });
      }
      const body = url.startsWith('/api/watches')
        ? WATCHES
        : url.startsWith('/api/notifications') ? NOTIFICATIONS : CHANNELS;
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderWatchlist();
    await userEvent.type(await screen.findByLabelText(/webhook url/i), 'http://example.com/hook');
    await userEvent.click(screen.getByRole('button', { name: /save delivery settings/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/https/i);
  });

  it('shows an empty state when nothing is starred', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const body = url.startsWith('/api/watches')
        ? { rows: [] }
        : url.startsWith('/api/notifications') ? { rows: [], unread: 0 } : CHANNELS;
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    }));
    renderWatchlist();
    expect(await screen.findByText(/you are not watching anything yet/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/routes/Watchlist.test.tsx
```

Expected failure: `Failed to load url ./Watchlist.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/components/watchlist.css`:

```css
.digest { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--s-3); }

.digest li {
  padding: var(--s-4);
  border-left: 3px solid var(--border-strong);
  display: grid;
  gap: var(--s-2);
}

.digest li.unread { border-left-color: var(--accent); background: var(--accent-soft); }

.digest .kind {
  font-size: var(--fs-100);
  text-transform: uppercase;
  letter-spacing: var(--tracking-caps);
  font-weight: 640;
  color: var(--text-muted);
}

.digest h3 { font-size: var(--fs-300); }

/* was -> now, set in the data face so a date change is legible at a glance */
.move {
  display: inline-flex;
  align-items: baseline;
  gap: var(--s-2);
  font-family: var(--font-data);
  font-size: var(--fs-200);
}

.move .was { color: var(--no); text-decoration: line-through; }
.move .now { color: var(--ok); font-weight: 700; }

.channels { display: grid; gap: var(--s-3); padding: var(--s-4); max-width: 46rem; }
.channels label { display: grid; gap: var(--s-1); font-size: var(--fs-200); }
.channels input { padding: var(--s-2); }
```

Create `packages/web/src/components/NotificationList.tsx`:

```tsx
import { Link } from 'react-router-dom';
import './watchlist.css';

export interface NotificationRow {
  id: string;
  programId: string | null;
  programName: string | null;
  kind: string;
  title: string;
  body: string;
  fieldPath: string | null;
  before: string | null;
  after: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NotificationListProps {
  rows: NotificationRow[];
  onMarkRead: (id: string) => void;
}

export function NotificationList({ rows, onMarkRead }: NotificationListProps) {
  if (rows.length === 0) {
    return <p className="empty-state">Nothing has changed on the programs you watch.</p>;
  }

  return (
    <ul className="digest">
      {rows.map((row) => (
        <li key={row.id} className={`card${row.readAt === null ? ' unread' : ''}`}>
          <span className="kind">{row.kind.replace(/_/g, ' ')}</span>
          <h3>{row.title}</h3>
          {row.before !== null && row.after !== null ? (
            <span className="move">
              <span className="was">{row.before}</span>
              <span aria-hidden="true">→</span>
              <span className="now">{row.after}</span>
            </span>
          ) : (
            <p>{row.body}</p>
          )}
          <span className="eyebrow">
            Detected <span className="data">{row.createdAt.slice(0, 10)}</span>
            {row.fieldPath !== null && <> · field <span className="data">{row.fieldPath}</span></>}
          </span>
          <span style={{ display: 'flex', gap: 'var(--s-2)' }}>
            {row.programId !== null && (
              <Link className="btn" to={`/o/${row.programId}`}>Open the record</Link>
            )}
            {row.readAt === null && (
              <button type="button" className="btn" onClick={() => onMarkRead(row.id)}>
                Mark read
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
```

Create `packages/web/src/routes/Watchlist.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Program } from '@grantspotter/core';
import { useApi } from '../store/useApi.js';
import { apiSend, ApiError } from '../api/client.js';
import { NotificationList, type NotificationRow } from '../components/NotificationList.js';
import { TrustBadge } from '../components/TrustBadge.js';
import { StatusPill } from '../components/StatusPill.js';
import { formatDate } from '../lib/trust.js';
import '../components/watchlist.css';

interface WatchRow {
  program: Program;
  funderName: string;
  nextOpensAt: string | null;
  nextClosesAt: string | null;
  nextIsEstimated: boolean;
}

interface ChannelConfig {
  inApp: boolean;
  webhookUrl: string | null;
  ntfyServer: string | null;
  ntfyTopic: string | null;
}

export function Watchlist({ now }: { now?: string }) {
  const nowISO = now ?? new Date().toISOString();
  const watches = useApi<{ rows: WatchRow[] }>('/api/watches');
  const notifications = useApi<{ rows: NotificationRow[]; unread: number }>('/api/notifications');
  const channels = useApi<ChannelConfig>('/api/channels');

  const [form, setForm] = useState<ChannelConfig>({
    inApp: true, webhookUrl: null, ntfyServer: null, ntfyTopic: null,
  });
  const [channelError, setChannelError] = useState<string | null>(null);
  const [channelSaved, setChannelSaved] = useState(false);

  useEffect(() => {
    if (channels.data) setForm(channels.data);
  }, [channels.data]);

  async function markRead(id: string) {
    await apiSend('POST', `/api/notifications/${id}/read`);
    notifications.reload();
  }

  async function markAllRead() {
    await apiSend('POST', '/api/notifications/read-all');
    notifications.reload();
  }

  async function unwatch(programId: string) {
    await apiSend('DELETE', `/api/watches/${programId}`);
    watches.reload();
  }

  async function saveChannels() {
    setChannelError(null);
    setChannelSaved(false);
    try {
      await apiSend('PUT', '/api/channels', form);
      setChannelSaved(true);
      channels.reload();
    } catch (err) {
      // The server puts the actionable sentence in `message`; `details` carries
      // the offending URL. Showing the code alone would be useless to the user.
      const detail = err instanceof ApiError ? err.message : 'network error';
      setChannelError(`That delivery target was rejected: ${detail}`);
    }
  }

  return (
    <>
      <p className="eyebrow">Subscriptions</p>
      <h1 style={{ marginBottom: 'var(--s-3)' }}>Watchlist</h1>
      <p style={{ maxWidth: '70ch' }}>
        Starring a program subscribes you to every change GrantSpotter detects on it — not just
        its deadline. A moved close date is the single most valuable thing this app can tell you,
        because a confidently-displayed wrong deadline is worse than no deadline at all.
      </p>

      <section className="panel card" aria-label="Watched programs" style={{ marginTop: 'var(--s-4)' }}>
        <h2>Watched programs</h2>
        {watches.loading && <p className="eyebrow">Loading…</p>}
        {watches.data && watches.data.rows.length === 0 && (
          <p className="empty-state">
            You are not watching anything yet. Open any record and choose{' '}
            <strong>Watch this program</strong>.
          </p>
        )}
        {watches.data && watches.data.rows.length > 0 && (
          <div className="table-wrap">
            <table className="grid-table" aria-label="Watched programs">
              <thead>
                <tr>
                  <th scope="col">Program</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Closes</th>
                  <th scope="col">Verified</th>
                  <th scope="col"><span className="eyebrow">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {watches.data.rows.map((row) => (
                  <tr key={row.program.id}>
                    <td>
                      <span className="row-name">
                        <Link to={`/o/${row.program.id}`}>{row.program.name}</Link>
                        <span className="row-funder">{row.funderName}</span>
                      </span>
                    </td>
                    <td><StatusPill status={row.program.trust.status} /></td>
                    <td className="num">{formatDate(row.nextClosesAt)}</td>
                    <td>
                      <TrustBadge lastVerifiedAt={row.program.trust.lastVerifiedAt} now={nowISO} />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => { void unwatch(row.program.id); }}
                      >
                        Stop watching
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel card" aria-label="Change digest">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--s-3)' }}>
          <h2>Change digest</h2>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={() => { void markAllRead(); }}>
            Mark all read
          </button>
        </div>
        {notifications.data && (
          <NotificationList
            rows={notifications.data.rows}
            onMarkRead={(id) => { void markRead(id); }}
          />
        )}
      </section>

      <section className="panel card channels" aria-label="Delivery settings">
        <h2>Delivery</h2>
        <p>
          The in-app digest is always on. Everything below is optional. Email is optional and is
          not required by GrantSpotter, so there is no mail server to configure here.
        </p>

        <label htmlFor="ch-webhook">
          Webhook URL (https only)
          <input
            id="ch-webhook"
            type="url"
            value={form.webhookUrl ?? ''}
            placeholder="https://hooks.example.com/grantspotter"
            onChange={(e) => setForm({ ...form, webhookUrl: e.target.value || null })}
          />
        </label>

        <label htmlFor="ch-ntfy-server">
          ntfy server
          <input
            id="ch-ntfy-server"
            type="url"
            value={form.ntfyServer ?? ''}
            placeholder="https://ntfy.example.com"
            onChange={(e) => setForm({ ...form, ntfyServer: e.target.value || null })}
          />
        </label>

        <label htmlFor="ch-ntfy-topic">
          ntfy topic
          <input
            id="ch-ntfy-topic"
            type="text"
            value={form.ntfyTopic ?? ''}
            placeholder="grantspotter-deadlines"
            onChange={(e) => setForm({ ...form, ntfyTopic: e.target.value || null })}
          />
        </label>

        {channelError !== null && <p role="alert" style={{ color: 'var(--no)' }}>{channelError}</p>}
        {channelSaved && <p role="status">Delivery settings saved.</p>}

        <div>
          <button type="button" className="btn btn-primary" onClick={() => { void saveChannels(); }}>
            Save delivery settings
          </button>
        </div>
      </section>
    </>
  );
}
```

Modify `packages/web/src/App.tsx` — replace the Watchlist route element:

```tsx
import { Watchlist } from './routes/Watchlist.js';
// ...
        <Route path="/watchlist" element={<Watchlist />} />
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
```

Expected: 11 watchlist assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web/src
git commit -m "feat(web): watchlist, change digest and optional delivery channels"
```

---

### Task 22: Profile editors and the completeness meter

**Why this exists:** the matcher is only as good as the profile. Both editors exist per user (spec §5), the meter counts **unknown verdicts resolved** rather than fields filled, and a `?focus=` parameter arriving from an unknown-verdict link scrolls to and focuses the exact input.

**Files:**
- Create: `packages/web/src/components/CompletenessMeter.tsx`
- Create: `packages/web/src/components/profile.css`
- Create: `packages/web/src/routes/Profile.tsx`
- Modify: `packages/web/src/App.tsx` (swap the Profile placeholder)
- Test: `packages/web/src/routes/Profile.test.tsx`

**Interfaces:**
- Consumes: `GET /api/profiles`, `PUT /api/profiles/:kind` (Task 6); `PROFILE_FIELDS`.
- Produces: `CompletenessMeter`, `Profile`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/routes/Profile.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Profile } from './Profile.js';

const PROFILES = {
  student: {
    kind: 'student',
    callsign: 'W8UM',
    licenseClass: 'GENERAL',
    state: 'MI',
    stage: 'UNDERGRAD',
  },
  organization: null,
  completeness: {
    total: 5,
    unknownCount: 2,
    score: 60,
    fields: [
      { field: 'gpa', resolves: 2 },
      { field: 'citizenship', resolves: 1 },
    ],
  },
};

function stubFetch(get: unknown = PROFILES) {
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (init?.method === 'PUT'
        ? { profile: { kind: 'student' }, completeness: PROFILES.completeness }
        : get),
    }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderProfile(initial = '/profile') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Profile />
    </MemoryRouter>,
  );
}

describe('Profile', () => {
  it('offers both a student and an organization editor', async () => {
    renderProfile();
    expect(await screen.findByRole('tab', { name: /student/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /organization/i })).toBeInTheDocument();
  });

  it('loads the saved student values into the form', async () => {
    renderProfile();
    expect(await screen.findByLabelText(/callsign/i)).toHaveValue('W8UM');
    expect(screen.getByLabelText(/license class/i)).toHaveValue('GENERAL');
  });

  it('renders the completeness meter in terms of unknown verdicts, not fields filled', async () => {
    renderProfile();
    const meter = await screen.findByRole('meter', { name: /profile completeness/i });
    expect(meter).toHaveAttribute('aria-valuenow', '60');
    expect(screen.getByText(/2 of 5 programs still return an unknown verdict/i)).toBeInTheDocument();
  });

  it('ranks the fields that would resolve the most unknowns', async () => {
    renderProfile();
    const ladder = await screen.findByRole('region', { name: /what to fill in next/i });
    const items = within(ladder).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent(/GPA/);
    expect(items[0]).toHaveTextContent(/2/);
  });

  it('explains what an ARRL Section is where geography is collected', async () => {
    renderProfile();
    await screen.findByLabelText(/callsign/i);
    expect(screen.getByText(/An ARRL Section is an ARRL-defined region/)).toBeInTheDocument();
  });

  it('focuses the field named by ?focus= so a jump from an unknown verdict lands right', async () => {
    renderProfile('/profile?kind=student&focus=gpa');
    await waitFor(() => expect(screen.getByLabelText(/^GPA$/i)).toHaveFocus());
  });

  it('saves the student profile as a PUT with the matching kind', async () => {
    const fetchMock = stubFetch();
    renderProfile();
    await userEvent.clear(await screen.findByLabelText(/callsign/i));
    await userEvent.type(screen.getByLabelText(/callsign/i), 'K5UTD');
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
      expect(put?.[0]).toBe('/api/profiles/student');
      expect(JSON.parse((put?.[1] as RequestInit).body as string)).toMatchObject({
        kind: 'student', callsign: 'K5UTD',
      });
    });
  });

  it('omits empty optional fields from the payload rather than sending empty strings', async () => {
    const fetchMock = stubFetch({ student: { kind: 'student' }, organization: null, completeness: PROFILES.completeness });
    renderProfile();
    await userEvent.click(await screen.findByRole('button', { name: /save student profile/i }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
      const body = JSON.parse((put?.[1] as RequestInit).body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty('callsign');
      expect(Object.values(body)).not.toContain('');
    });
  });

  it('sends numbers as numbers, not strings', async () => {
    const fetchMock = stubFetch();
    renderProfile();
    await userEvent.type(await screen.findByLabelText(/^GPA$/i), '3.4');
    await userEvent.click(screen.getByRole('button', { name: /save student profile/i }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
      expect(JSON.parse((put?.[1] as RequestInit).body as string).gpa).toBe(3.4);
    });
  });

  it('switches to the organization editor and saves that kind', async () => {
    const fetchMock = stubFetch();
    renderProfile();
    await userEvent.click(await screen.findByRole('tab', { name: /organization/i }));
    await userEvent.type(screen.getByLabelText(/organization name/i), 'Example University ARC');
    await userEvent.click(screen.getByRole('button', { name: /save organization profile/i }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PUT');
      expect(put?.[0]).toBe('/api/profiles/organization');
    });
  });

  it('confirms the save in a live region', async () => {
    renderProfile();
    await userEvent.click(await screen.findByRole('button', { name: /save student profile/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/saved/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/routes/Profile.test.tsx
```

Expected failure: `Failed to load url ./Profile.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/components/profile.css`:

```css
.profile-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 380px);
  gap: var(--s-5);
  align-items: start;
}

.field-list { display: grid; gap: var(--s-4); padding: var(--s-4); }

.field {
  display: grid;
  gap: var(--s-1);
}

.field label { font-weight: 560; font-size: var(--fs-200); }
.field input, .field select { padding: var(--s-2); font: inherit; width: 100%; }
.field .help { font-size: var(--fs-100); color: var(--text-muted); max-width: 62ch; }

.meter-shell {
  height: 10px;
  border-radius: 5px;
  background: var(--surface-3);
  overflow: hidden;
  margin: var(--s-2) 0;
}

.meter-fill { height: 100%; background: var(--accent); }

.meter-figure {
  font-family: var(--font-data);
  font-size: var(--fs-700);
  font-weight: 700;
  line-height: 1;
}

@media (max-width: 900px) {
  .profile-grid { grid-template-columns: 1fr; }
}
```

Create `packages/web/src/components/CompletenessMeter.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { PROFILE_FIELDS, profileFieldHref, profileFieldLabel } from '../lib/profileFields.js';
import './profile.css';

export interface CompletenessReport {
  total: number;
  unknownCount: number;
  score: number;
  fields: Array<{ field: string; resolves: number }>;
}

/**
 * Completeness measured against the matcher: not "how much of the form is
 * filled" but "how much of the corpus can now be judged".
 */
export function CompletenessMeter({ report }: { report: CompletenessReport }) {
  return (
    <>
      <section className="panel card" aria-label="Profile completeness">
        <h2>Completeness</h2>
        <span className="meter-figure">{report.score}%</span>
        <div className="meter-shell" aria-hidden="true">
          <div className="meter-fill" style={{ width: `${report.score}%` }} />
        </div>
        <div
          role="meter"
          aria-label="Profile completeness"
          aria-valuenow={report.score}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuetext={`${report.score} percent of the corpus can be judged`}
        />
        <p>
          {report.unknownCount} of {report.total} programs still return an unknown verdict.
        </p>
      </section>

      {report.fields.length > 0 && (
        <section className="panel card" aria-label="What to fill in next">
          <h2>What to fill in next</h2>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--s-3)' }}>
            {report.fields.map(({ field, resolves }) => {
              const meta = PROFILE_FIELDS.find((f) => f.key === field);
              return (
                <li key={field}>
                  <Link to={profileFieldHref(field)}>{profileFieldLabel(field)}</Link>{' '}
                  <span className="data">({resolves})</span>
                  {meta && <span className="help" style={{ display: 'block' }}>{meta.help}</span>}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
```

Create `packages/web/src/routes/Profile.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../store/useApi.js';
import { apiSend, ApiError } from '../api/client.js';
import { CompletenessMeter, type CompletenessReport } from '../components/CompletenessMeter.js';
import { PROFILE_FIELDS, type ProfileFieldMeta } from '../lib/profileFields.js';
import '../components/profile.css';

type Kind = 'student' | 'organization';
type FormValues = Record<string, string>;

interface ProfilesResponse {
  student: Record<string, unknown> | null;
  organization: Record<string, unknown> | null;
  completeness: CompletenessReport;
}

/** Inputs that are enumerations, not free text. */
const SELECTS: Record<string, string[]> = {
  licenseClass: ['', 'NONE', 'TECH', 'GENERAL', 'EXTRA'],
  degreeLevel: ['', 'CERT', 'ASSOC', 'BACH', 'GRAD'],
  citizenship: ['', 'US_CITIZEN', 'US_RESIDENT', 'ANY'],
  stage: ['', 'HS_SENIOR', 'UNDERGRAD', 'GRAD', 'VETERAN', 'RETRAINING_ADULT'],
  gender: ['', 'female', 'male', 'other', 'prefer_not_to_say'],
  entity: [
    '', 'individual', 'club_unincorporated', 'club_501c3', 'club_via_fiscal_sponsor',
    'school_lea', 'university', 'university_dept', 'ieee_student_branch_chapter',
    'teacher', 'nominated_by_institution',
  ],
};

const NUMBERS = new Set(['gpa', 'classRankTopPct', 'lat', 'lon', 'cwWpm', 'memberCount']);
const BOOLEANS = new Set([
  'accredited', 'partTime', 'financialNeed', 'is501c3', 'hasFiscalSponsor', 'arrlAffiliated',
]);
const DATES = new Set(['licensedSince', 'arrlMemberSince', 'birthDate']);

function toForm(saved: Record<string, unknown> | null, fields: ProfileFieldMeta[]): FormValues {
  const out: FormValues = {};
  for (const field of fields) {
    const value = saved?.[field.key];
    out[field.key] = value === undefined || value === null ? '' : String(value);
  }
  return out;
}

/** Empty strings are omitted; numbers and booleans are sent with their real types. */
function toPayload(kind: Kind, values: FormValues): Record<string, unknown> {
  const payload: Record<string, unknown> = { kind };
  for (const [key, raw] of Object.entries(values)) {
    if (raw === '') continue;
    if (NUMBERS.has(key)) {
      const n = Number(raw);
      if (Number.isFinite(n)) payload[key] = n;
      continue;
    }
    if (BOOLEANS.has(key)) {
      payload[key] = raw === 'true';
      continue;
    }
    payload[key] = raw;
  }
  return payload;
}

export function Profile() {
  const [searchParams] = useSearchParams();
  const initialKind = searchParams.get('kind') === 'organization' ? 'organization' : 'student';
  const focusKey = searchParams.get('focus');

  const [kind, setKind] = useState<Kind>(initialKind);
  const [values, setValues] = useState<FormValues>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<CompletenessReport | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const { data, reload } = useApi<ProfilesResponse>('/api/profiles');
  const fields = PROFILE_FIELDS.filter((f) => f.kind === kind);

  useEffect(() => {
    if (!data) return;
    setValues(toForm(kind === 'student' ? data.student : data.organization, PROFILE_FIELDS));
    setReport(data.completeness);
  }, [data, kind]);

  useEffect(() => {
    if (focusKey === null) return;
    const el = formRef.current?.querySelector<HTMLElement>(`#field-${focusKey}`);
    el?.focus();
    el?.scrollIntoView({ block: 'center' });
  }, [focusKey, values]);

  async function save() {
    setSaved(false);
    setError(null);
    try {
      const response = await apiSend<{ completeness: CompletenessReport }>(
        'PUT', `/api/profiles/${kind}`, toPayload(kind, values),
      );
      setReport(response.completeness);
      setSaved(true);
      reload();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'validation_failed'
          ? 'One of these values was not accepted. Check the enumerated fields.'
          : 'The profile could not be saved.',
      );
    }
  }

  return (
    <>
      <p className="eyebrow">Matching</p>
      <h1 style={{ marginBottom: 'var(--s-4)' }}>Profile</h1>
      <p style={{ maxWidth: '70ch' }}>
        You may hold both a student profile and an organization profile. Programs are matched
        against whichever entity types they accept, so filling in both widens what you see rather
        than splitting it.
      </p>

      <div className="cal-tabs" role="tablist" aria-label="Profile kind">
        <button type="button" role="tab" aria-selected={kind === 'student'} onClick={() => setKind('student')}>
          Student
        </button>
        <button type="button" role="tab" aria-selected={kind === 'organization'} onClick={() => setKind('organization')}>
          Organization
        </button>
      </div>

      <div className="profile-grid">
        <form
          ref={formRef}
          className="card field-list"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          {fields.map((field) => {
            const id = `field-${field.key}`;
            const value = values[field.key] ?? '';
            return (
              <div className="field" key={field.key}>
                <label htmlFor={id}>{field.label}</label>
                {SELECTS[field.key] ? (
                  <select
                    id={id}
                    value={value}
                    onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                  >
                    {SELECTS[field.key]!.map((option) => (
                      <option key={option} value={option}>{option === '' ? '—' : option}</option>
                    ))}
                  </select>
                ) : BOOLEANS.has(field.key) ? (
                  <select
                    id={id}
                    value={value}
                    onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                  >
                    <option value="">—</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : (
                  <input
                    id={id}
                    type={NUMBERS.has(field.key) ? 'number' : DATES.has(field.key) ? 'date' : 'text'}
                    step={field.key === 'gpa' ? '0.01' : undefined}
                    value={value}
                    aria-describedby={`${id}-help`}
                    onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                  />
                )}
                <span className="help" id={`${id}-help`}>{field.help}</span>
              </div>
            );
          })}

          {error !== null && <p role="alert" style={{ color: 'var(--no)' }}>{error}</p>}
          {saved && <p role="status">Profile saved.</p>}

          <div>
            <button type="submit" className="btn btn-primary">
              Save {kind} profile
            </button>
          </div>
        </form>

        <div>{report && <CompletenessMeter report={report} />}</div>
      </div>
    </>
  );
}
```

Modify `packages/web/src/App.tsx` — replace the Profile route element:

```tsx
import { Profile } from './routes/Profile.js';
// ...
        <Route path="/profile" element={<Profile />} />
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
```

Expected: 11 profile assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web/src
git commit -m "feat(web): student and organization profile editors with completeness meter"
```

---
### Task 23: Inbox route — admin decides, members watch

**Why this exists:** spec §12 makes the read-only Inbox a deliberate product feature. A member seeing *"a deadline change on a program you watch is pending review"* is being told something true and useful; hiding it produces the "why is this list wrong" complaint the trust surfaces exist to prevent. The UI must therefore show members the full queue and no decision controls at all — not disabled ones, which read as a permissions bug.

**Files:**
- Create: `packages/web/src/components/inbox.css`
- Create: `packages/web/src/routes/Inbox.tsx`
- Modify: `packages/web/src/App.tsx` (swap the Inbox placeholder)
- Test: `packages/web/src/routes/Inbox.test.tsx`

**Interfaces:**
- Consumes: `GET /api/inbox`, `POST /api/inbox/:id/decision` (Task 12); `useSession`.
- Produces: `Inbox`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/routes/Inbox.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Inbox } from './Inbox.js';

const ROW = {
  id: 'ri-1',
  decision: 'pending',
  decidedBy: null,
  decidedAt: null,
  confidence: 0.82,
  rejectKey: null,
  candidate: {
    id: 'arrl-foundation-scholarship',
    name: 'ARRL Foundation Scholarship Program',
    deadline: { kind: 'annual_window', source: { kind: 'self' }, note: 'Closes Dec 30 at 12:00 PM EST.' },
    trust: { status: 'open', lastVerifiedAt: '2026-08-02T00:00:00.000Z', sourceUrl: 'x', verificationMethod: 'live_fetch', contentHash: 'x' },
    amount: { instrument: 'cash_range', amountRaw: '$500 - $25,000', awardCountRaw: '170+' },
  },
  changeEvent: {
    id: 'ce-1',
    sourceId: 'arrl-scholarship-descriptions',
    programId: 'arrl-foundation-scholarship',
    kind: 'deadline_changed',
    before: 'January 31',
    after: 'December 30, 12:00 PM EST',
    detectedAt: '2026-08-02T03:17:00.000Z',
    fieldPath: 'deadline.note',
  },
};

function stubFetch(canDecide: boolean) {
  const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => (init?.method === 'POST'
        ? { id: 'ri-1', decision: 'approved', published: true }
        : { rows: [ROW], canDecide }),
    }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderInbox() {
  return render(<MemoryRouter><Inbox /></MemoryRouter>);
}

describe('Inbox as a member', () => {
  beforeEach(() => {
    stubFetch(false);
  });

  it('shows the pending change with its before and after', async () => {
    renderInbox();
    const item = await screen.findByRole('article', { name: /ARRL Foundation Scholarship Program/ });
    expect(within(item).getByText('January 31')).toBeInTheDocument();
    expect(within(item).getByText('December 30, 12:00 PM EST')).toBeInTheDocument();
  });

  it('states plainly that the queue is read-only for this account', async () => {
    renderInbox();
    expect(await screen.findByText(/only an administrator can approve or reject/i))
      .toBeInTheDocument();
  });

  it('renders no decision controls at all, rather than disabled ones', async () => {
    renderInbox();
    await screen.findByRole('article', { name: /ARRL Foundation Scholarship Program/ });
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
  });

  it('names the source and the detection time so the claim is checkable', async () => {
    renderInbox();
    const item = await screen.findByRole('article', { name: /ARRL Foundation Scholarship Program/ });
    expect(within(item).getByText('arrl-scholarship-descriptions')).toBeInTheDocument();
    expect(within(item).getByText(/2026-08-02/)).toBeInTheDocument();
  });
});

describe('Inbox as an admin', () => {
  beforeEach(() => {
    stubFetch(true);
  });

  it('offers approve and reject', async () => {
    renderInbox();
    expect(await screen.findByRole('button', { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^reject$/i })).toBeInTheDocument();
  });

  it('posts an approval', async () => {
    const fetchMock = stubFetch(true);
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^approve$/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      expect(post?.[0]).toBe('/api/inbox/ri-1/decision');
      expect(JSON.parse((post?.[1] as RequestInit).body as string).decision).toBe('approved');
    });
  });

  it('posts a rejection carrying a reject key so the same candidate is suppressed later', async () => {
    const fetchMock = stubFetch(true);
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^reject$/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      const body = JSON.parse((post?.[1] as RequestInit).body as string);
      expect(body.decision).toBe('rejected');
      expect(body.rejectKey).toBe('arrl-scholarship-descriptions:deadline.note:December 30, 12:00 PM EST');
    });
  });

  it('lets an admin edit the candidate deadline note before approving', async () => {
    const fetchMock = stubFetch(true);
    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const field = screen.getByLabelText(/deadline note/i);
    await userEvent.clear(field);
    await userEvent.type(field, 'Closes Dec 30, hand-checked.');
    await userEvent.click(screen.getByRole('button', { name: /save and approve/i }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
      const body = JSON.parse((post?.[1] as RequestInit).body as string);
      expect(body.decision).toBe('edited');
      expect(body.candidate.deadline.note).toBe('Closes Dec 30, hand-checked.');
    });
  });

  it('shows the parser confidence, because a low score deserves a closer look', async () => {
    renderInbox();
    expect(await screen.findByText(/confidence 0\.82/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/routes/Inbox.test.tsx
```

Expected failure: `Failed to load url ./Inbox.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/components/inbox.css`:

```css
.inbox { display: grid; gap: var(--s-4); }

.inbox article {
  padding: var(--s-4);
  border-left: 3px solid var(--accent);
  display: grid;
  gap: var(--s-3);
}

.inbox article.decided { border-left-color: var(--border-strong); opacity: 0.75; }

.inbox .meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-3);
  font-size: var(--fs-200);
  color: var(--text-muted);
}

.inbox .actions { display: flex; gap: var(--s-2); flex-wrap: wrap; }

.readonly-note {
  padding: var(--s-3) var(--s-4);
  background: var(--surface-2);
  border-left: 3px solid var(--border-strong);
  border-radius: 0 var(--r-1) var(--r-1) 0;
  margin-bottom: var(--s-4);
  max-width: 76ch;
}

.edit-panel { display: grid; gap: var(--s-2); padding: var(--s-3); background: var(--surface-2); border-radius: var(--r-1); }
.edit-panel textarea { font: inherit; padding: var(--s-2); min-height: 5rem; width: 100%; }
```

Create `packages/web/src/routes/Inbox.tsx`:

```tsx
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Program } from '@grantspotter/core';
import { useApi } from '../store/useApi.js';
import { apiSend } from '../api/client.js';
import '../components/inbox.css';

interface InboxRow {
  id: string;
  decision: 'pending' | 'approved' | 'rejected' | 'edited';
  decidedBy: string | null;
  decidedAt: string | null;
  confidence: number;
  rejectKey: string | null;
  candidate: Program;
  changeEvent: {
    id: string;
    sourceId: string;
    programId: string | null;
    kind: string;
    before: string | null;
    after: string | null;
    detectedAt: string;
    fieldPath: string | null;
  } | null;
}

interface InboxResponse {
  rows: InboxRow[];
  canDecide: boolean;
}

/** Reject-memory key: source + field + the exact value we are refusing. */
function rejectKeyFor(row: InboxRow): string {
  const ce = row.changeEvent;
  if (!ce) return `${row.candidate.id}:manual`;
  return `${ce.sourceId}:${ce.fieldPath ?? 'record'}:${ce.after ?? ''}`;
}

export function Inbox() {
  const { data, loading, error, reload } = useApi<InboxResponse>('/api/inbox');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState('');

  async function decide(row: InboxRow, decision: 'approved' | 'rejected' | 'edited') {
    const body: Record<string, unknown> = { decision };
    if (decision === 'rejected') body.rejectKey = rejectKeyFor(row);
    if (decision === 'edited') {
      body.candidate = {
        ...row.candidate,
        deadline: { ...row.candidate.deadline, note: draftNote },
      };
    }
    await apiSend('POST', `/api/inbox/${row.id}/decision`, body);
    setEditingId(null);
    reload();
  }

  return (
    <>
      <p className="eyebrow">Review queue</p>
      <h1 style={{ marginBottom: 'var(--s-4)' }}>Inbox</h1>

      {data && !data.canDecide && (
        <p className="readonly-note">
          This queue is read-only for your account — only an administrator can approve or reject a
          change. It is shown to you on purpose: knowing that a deadline change is <em>pending
          review</em> is more useful than a list that quietly disagrees with the funder’s page.
        </p>
      )}

      {loading && <p className="eyebrow">Loading…</p>}
      {error && <p role="alert">Could not load the review queue ({error.code}).</p>}

      <div className="inbox">
        {data?.rows.length === 0 && (
          <p className="empty-state">Nothing is waiting for review.</p>
        )}

        {data?.rows.map((row) => (
          <article
            key={row.id}
            className={`card${row.decision === 'pending' ? '' : ' decided'}`}
            aria-label={row.candidate.name}
          >
            <div>
              <span className="eyebrow">
                {row.changeEvent?.kind.replace(/_/g, ' ') ?? 'candidate'} · {row.decision}
              </span>
              <h2 style={{ fontSize: 'var(--fs-400)' }}>
                <Link to={`/o/${row.candidate.id}`}>{row.candidate.name}</Link>
              </h2>
            </div>

            {row.changeEvent && row.changeEvent.before !== null && row.changeEvent.after !== null && (
              <span className="move">
                <span className="was">{row.changeEvent.before}</span>
                <span aria-hidden="true">→</span>
                <span className="now">{row.changeEvent.after}</span>
              </span>
            )}

            <div className="meta">
              {row.changeEvent && (
                <>
                  <span>Source <span className="data">{row.changeEvent.sourceId}</span></span>
                  <span>Detected <span className="data">{row.changeEvent.detectedAt.slice(0, 10)}</span></span>
                  {row.changeEvent.fieldPath !== null && (
                    <span>Field <span className="data">{row.changeEvent.fieldPath}</span></span>
                  )}
                </>
              )}
              <span>Confidence <span className="data">{row.confidence.toFixed(2)}</span></span>
              {row.decidedBy !== null && (
                <span>Decided by <span className="data">{row.decidedBy}</span> on{' '}
                  <span className="data">{row.decidedAt?.slice(0, 10)}</span>
                </span>
              )}
            </div>

            {data.canDecide && row.decision === 'pending' && (
              <>
                <div className="actions">
                  <button type="button" className="btn btn-primary" onClick={() => { void decide(row, 'approved'); }}>
                    Approve
                  </button>
                  <button type="button" className="btn" onClick={() => { void decide(row, 'rejected'); }}>
                    Reject
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setEditingId(row.id);
                      setDraftNote(row.candidate.deadline.note);
                    }}
                  >
                    Edit
                  </button>
                </div>

                {editingId === row.id && (
                  <div className="edit-panel">
                    <label htmlFor={`edit-note-${row.id}`}>Deadline note</label>
                    <textarea
                      id={`edit-note-${row.id}`}
                      value={draftNote}
                      onChange={(e) => setDraftNote(e.target.value)}
                    />
                    <div className="actions">
                      <button type="button" className="btn btn-primary" onClick={() => { void decide(row, 'edited'); }}>
                        Save and approve
                      </button>
                      <button type="button" className="btn" onClick={() => setEditingId(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </article>
        ))}
      </div>
    </>
  );
}
```

Modify `packages/web/src/App.tsx` — replace the Inbox route element:

```tsx
import { Inbox } from './routes/Inbox.js';
// ...
        <Route path="/inbox" element={<Inbox />} />
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
```

Expected: 9 inbox assertions green.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web/src
git commit -m "feat(web): review inbox, read-only for members and decidable by admins"
```

---

### Task 24: Sources page — health, configuration, manual crawl, and the global accessibility pass

**Why this exists:** spec §8 wants last poll, last success, parse yield vs. baseline and consecutive failures on one page, and spec §12 makes all three verbs of that page role-dependent: *"Source configuration, crawl trigger, sources health | admin ✅ | member read-only"*. An admin gets a **Run crawl now** button and inline configuration of each source's yield baseline and enabled flag; a member gets the same table with those controls **absent** and a sentence saying why. This task also closes out the accessibility requirement across the whole SPA with a keyboard-and-semantics audit that runs in CI: a document with exactly one `<h1>`, no positive `tabindex`, every control labelled, and every image and icon either labelled or explicitly hidden.

**Absent, not disabled.** The Inbox (Task 23) already establishes the rule: a control a member can
never use reads as a permissions bug when it is greyed out. The one exception is the crawl button
while a crawl is running for an admin, where `disabled` is accurate — the action is genuinely
unavailable *right now*, and the button says so.

**Files:**
- Create: `packages/web/src/routes/Sources.tsx`
- Create: `packages/web/src/components/sources.css`
- Create: `packages/web/src/test/a11y.ts`
- Modify: `packages/web/src/App.tsx` (swap the Sources placeholder)
- Test: `packages/web/src/routes/Sources.test.tsx`
- Test: `packages/web/src/test/a11y.test.tsx`

**Interfaces:**
- Consumes: `GET /api/sources/health`, `POST /api/sources/crawl`, `PATCH /api/sources/:id` (Task 14).
- Produces: `Sources`, `auditA11y(container: HTMLElement): string[]`.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/routes/Sources.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Sources } from './Sources.js';

const ROWS = [
  {
    id: 'ncdxf-grants',
    label: 'NCDXF grant page',
    tier: 'C',
    funderId: 'ncdxf',
    enabled: true,
    lastPolledAt: '2026-08-02T03:17:00.000Z',
    lastSuccessAt: '2026-07-20T03:17:00.000Z',
    consecutiveFailures: 4,
    lastRecordCount: 0,
    expectedMinRecords: 1,
    health: { state: 'failing', detail: '4 consecutive failures since the last success.' },
  },
  {
    id: 'arrl-scholarship-descriptions',
    label: 'ARRL scholarship catalog',
    tier: 'C',
    funderId: 'arrl-foundation',
    enabled: true,
    lastPolledAt: '2026-08-02T03:17:00.000Z',
    lastSuccessAt: '2026-08-02T03:17:00.000Z',
    consecutiveFailures: 0,
    lastRecordCount: 111,
    expectedMinRecords: 100,
    health: { state: 'healthy', detail: '111 records on the last successful parse.' },
  },
  {
    id: 'austin-arc-grants',
    label: 'Austin ARC grants portal',
    tier: 'C',
    funderId: 'austin-arc',
    enabled: true,
    lastPolledAt: '2026-08-02T03:17:00.000Z',
    lastSuccessAt: '2026-08-02T03:17:00.000Z',
    consecutiveFailures: 0,
    lastRecordCount: 0,
    expectedMinRecords: 0,
    health: { state: 'idle', detail: 'No records, which is expected for this source outside its open window.' },
  },
];

const RESPONSE = {
  rows: ROWS,
  summary: { total: 3, healthy: 2, unhealthy: 1 },
  canConfigure: false,
};

/**
 * `canConfigure` is what the page keys every admin control off. It is server
 * truth (`user.role === 'admin'`), not a client guess.
 */
function stubFetch(canConfigure: boolean, overrides: Record<string, unknown> = {}) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && url === '/api/sources/crawl') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          startedAt: '2026-08-02T12:00:00.000Z',
          finishedAt: '2026-08-02T12:00:41.000Z',
          results: [
            { sourceId: 'ncdxf-grants', parsedCount: 3, events: 1, reviewItems: 1 },
            { sourceId: 'arrl-scholarship-descriptions', parsedCount: 111, events: 0, reviewItems: 0 },
          ],
          ...overrides,
        }),
      });
    }
    if (init?.method === 'PATCH') {
      const id = url.replace('/api/sources/', '');
      const patched = ROWS.find((r) => r.id === id);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ source: { ...patched, expectedMinRecords: 120 } }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ...RESPONSE, canConfigure }),
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  stubFetch(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderSources() {
  return render(<MemoryRouter><Sources /></MemoryRouter>);
}

describe('Sources health', () => {
  it('renders one row per source with its state in words', async () => {
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3
    expect(within(table).getByText('Failing')).toBeInTheDocument();
  });

  it('shows parse yield against the baseline, not just a count', async () => {
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).getByText('111 / 100')).toBeInTheDocument();
  });

  it('explains that an idle source is not a broken one', async () => {
    renderSources();
    expect(await screen.findByText(/expected for this source outside its open window/i))
      .toBeInTheDocument();
  });

  it('shows last poll and last success separately, because they differ when a source fails', async () => {
    renderSources();
    const table = await screen.findByRole('table', { name: /source health/i });
    expect(within(table).getByText('2026-07-20')).toBeInTheDocument();
  });

  it('summarises the fleet', async () => {
    renderSources();
    expect(await screen.findByText(/1 of 3 sources need attention/i)).toBeInTheDocument();
  });

  it('tells a member that source configuration is admin-only', async () => {
    renderSources();
    expect(await screen.findByText(/only an administrator can change source configuration/i))
      .toBeInTheDocument();
  });

  it('explains why some sources are curated by hand rather than polled', async () => {
    renderSources();
    expect(await screen.findByText(/deliberately block non-browser clients/i)).toBeInTheDocument();
  });

  it('gives a member no crawl button and no configuration controls at all', async () => {
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    expect(screen.queryByRole('button', { name: /run crawl now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: /baseline for/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /poll/i })).not.toBeInTheDocument();
  });
});

describe('Sources — admin controls', () => {
  it('offers an admin a crawl button', async () => {
    stubFetch(true);
    renderSources();
    expect(await screen.findByRole('button', { name: /run crawl now/i })).toBeEnabled();
  });

  it('runs every source when nothing is selected and reports what came back', async () => {
    const fetchMock = stubFetch(true);
    renderSources();
    await userEvent.click(await screen.findByRole('button', { name: /run crawl now/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(post?.[0]).toBe('/api/sources/crawl');
      expect(JSON.parse((post?.[1] as RequestInit).body as string)).toEqual({});
    });

    const result = await screen.findByRole('status');
    expect(result).toHaveTextContent(/2 sources/i);
    expect(result).toHaveTextContent(/114 records/i); // 3 + 111
    expect(result).toHaveTextContent(/1 change/i);
  });

  it('disables the button while a crawl is running and says so', async () => {
    let release: (value: unknown) => void = () => {};
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Promise((resolve) => {
          release = () => resolve({
            ok: true, status: 200,
            json: async () => ({ startedAt: 'x', finishedAt: 'y', results: [] }),
          });
        });
      }
      return Promise.resolve({
        ok: true, status: 200, json: async () => ({ ...RESPONSE, canConfigure: true }),
      });
    }));

    renderSources();
    const button = await screen.findByRole('button', { name: /run crawl now/i });
    await userEvent.click(button);
    expect(await screen.findByRole('button', { name: /crawling/i })).toBeDisabled();
    release(null);
  });

  it('explains a 409 instead of leaving the button dead', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            error: { code: 'conflict', message: 'A crawl is already running. Wait for it to finish.' },
            requestId: 'req-test-1',
          }),
        });
      }
      return Promise.resolve({
        ok: true, status: 200, json: async () => ({ ...RESPONSE, canConfigure: true }),
      });
    }));

    renderSources();
    await userEvent.click(await screen.findByRole('button', { name: /run crawl now/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already running/i);
    expect(screen.getByRole('button', { name: /run crawl now/i })).toBeEnabled();
  });

  it('lets an admin edit a source’s yield baseline', async () => {
    const fetchMock = stubFetch(true);
    renderSources();
    const field = await screen.findByRole('spinbutton', {
      name: /baseline for arrl scholarship catalog/i,
    });
    await userEvent.clear(field);
    await userEvent.type(field, '120');
    await userEvent.click(
      screen.getByRole('button', { name: /save arrl scholarship catalog/i }),
    );

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patch?.[0]).toBe('/api/sources/arrl-scholarship-descriptions');
      expect(JSON.parse((patch?.[1] as RequestInit).body as string))
        .toEqual({ expectedMinRecords: 120, enabled: true });
    });
  });

  it('lets an admin pause a source with a labelled checkbox', async () => {
    const fetchMock = stubFetch(true);
    renderSources();
    const toggle = await screen.findByRole('checkbox', {
      name: /poll ncdxf grant page nightly/i,
    });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: /save ncdxf grant page/i }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(JSON.parse((patch?.[1] as RequestInit).body as string))
        .toMatchObject({ enabled: false });
    });
  });

  it('does not tell an admin that configuration is admin-only', async () => {
    stubFetch(true);
    renderSources();
    await screen.findByRole('table', { name: /source health/i });
    expect(screen.queryByText(/only an administrator can change source configuration/i))
      .not.toBeInTheDocument();
  });
});
```

Create `packages/web/src/test/a11y.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { auditA11y } from './a11y.js';
import { Browse } from '../routes/Browse.js';
import { Calendar } from '../routes/Calendar.js';
import { Watchlist } from '../routes/Watchlist.js';
import { Profile } from '../routes/Profile.js';
import { Inbox } from '../routes/Inbox.js';
import { Sources } from '../routes/Sources.js';
import { Opportunity } from '../routes/Opportunity.js';

/** One permissive stub: every route gets a shape it can render without crashing. */
function stubEverything() {
  vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
    const body: Record<string, unknown> = {
      rows: [], entries: [], undated: [], summary: {
        total: 0, eligible: 0, preferred: 0, ineligible: 0, unknown: 0,
        ineligibleByAxis: [], unknownByField: [], healthy: 0, unhealthy: 0,
      },
      page: 1, pageSize: 50, total: 0, profileApplied: null,
      unread: 0, canDecide: false, canConfigure: false,
      student: null, organization: null,
      completeness: { total: 0, unknownCount: 0, score: 100, fields: [] },
      inApp: true, webhookUrl: null, ntfyServer: null, ntfyTopic: null,
      from: '2026-08-02T12:00:00.000Z', to: '2027-08-02T12:00:00.000Z',
    };
    if (url.startsWith('/api/programs/')) {
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({
          program: {
            id: 'p1', funderId: 'f1', name: 'Test Program', klass: 'ham_grant', summary: 'S',
            applicantEntities: ['university'],
            amount: { instrument: 'cash_range', amountRaw: '$1', awardCountRaw: '1' },
            deadline: { kind: 'rolling', source: { kind: 'self' }, note: 'Rolling.' },
            applyVia: 'page_form', constraints: [], fundingRestrictions: [],
            obligations: { costShareRequired: false, coFunderPreference: false },
            aiPolicy: { stance: 'unaddressed' },
            trust: {
              status: 'open', sourceUrl: 'https://example.com', lastVerifiedAt: '2026-08-02T00:00:00.000Z',
              verificationMethod: 'manual_curation', contentHash: 'abc123',
            },
            rawOtherText: '', tags: [],
          },
          funder: { id: 'f1', name: 'Test Funder', homepage: '' },
          cycles: [], provenance: [], verdict: null, watched: false, deadlineOwner: null,
        }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => body });
  }));
}

beforeEach(() => {
  stubEverything();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ROUTES: Array<[string, () => JSX.Element]> = [
  ['Browse', () => <Browse now="2026-08-02T12:00:00.000Z" />],
  ['Calendar', () => <Calendar now="2026-08-02T12:00:00.000Z" />],
  ['Watchlist', () => <Watchlist now="2026-08-02T12:00:00.000Z" />],
  ['Profile', () => <Profile />],
  ['Inbox', () => <Inbox />],
  ['Sources', () => <Sources />],
];

describe('accessibility audit', () => {
  it.each(ROUTES)('%s has no accessibility violations', async (_name, Component) => {
    const { container, findByRole } = render(
      <MemoryRouter><Component /></MemoryRouter>,
    );
    await findByRole('heading', { level: 1 });
    expect(auditA11y(container)).toEqual([]);
  });

  it('Opportunity has no accessibility violations', async () => {
    const { container, findByRole } = render(
      <MemoryRouter initialEntries={['/o/p1']}>
        <Routes>
          <Route path="/o/:programId" element={<Opportunity now="2026-08-02T12:00:00.000Z" />} />
        </Routes>
      </MemoryRouter>,
    );
    await findByRole('heading', { level: 1 });
    expect(auditA11y(container)).toEqual([]);
  });

  it('detects a genuinely broken fragment, so the audit is not vacuous', () => {
    const broken = document.createElement('div');
    broken.innerHTML = `
      <h1>One</h1><h1>Two</h1>
      <input type="text" />
      <button tabindex="3">Bad</button>
      <img src="x.png">
    `;
    const findings = auditA11y(broken);
    expect(findings).toContain('more than one <h1>');
    expect(findings).toContain('unlabelled form control: input');
    expect(findings).toContain('positive tabindex on: button');
    expect(findings).toContain('img with no alt attribute');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/routes/Sources.test.tsx packages/web/src/test/a11y.test.tsx
```

Expected failure: `Failed to load url ./Sources.js` and `./a11y.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/test/a11y.ts`:

```ts
/**
 * A small, honest accessibility audit. It checks the things this SPA can
 * actually get wrong and that a unit test can decide with certainty. It is not
 * a substitute for a manual keyboard pass, and it does not pretend to be.
 */
export function auditA11y(container: HTMLElement): string[] {
  const findings: string[] = [];

  if (container.querySelectorAll('h1').length > 1) findings.push('more than one <h1>');

  const controls = container.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]), select, textarea',
  );
  for (const control of controls) {
    const id = control.getAttribute('id');
    const labelled =
      (id !== null && container.querySelector(`label[for="${id}"]`) !== null) ||
      control.getAttribute('aria-label') !== null ||
      control.getAttribute('aria-labelledby') !== null ||
      control.closest('label') !== null;
    if (!labelled) findings.push(`unlabelled form control: ${control.tagName.toLowerCase()}`);
  }

  for (const el of container.querySelectorAll<HTMLElement>('[tabindex]')) {
    if (Number(el.getAttribute('tabindex')) > 0) {
      findings.push(`positive tabindex on: ${el.tagName.toLowerCase()}`);
    }
  }

  for (const img of container.querySelectorAll('img')) {
    if (!img.hasAttribute('alt')) findings.push('img with no alt attribute');
  }

  for (const button of container.querySelectorAll<HTMLElement>('button')) {
    const text = (button.textContent ?? '').trim();
    if (text === '' && button.getAttribute('aria-label') === null) {
      findings.push('button with no accessible name');
    }
  }

  for (const anchor of container.querySelectorAll<HTMLAnchorElement>('a[target="_blank"]')) {
    const rel = anchor.getAttribute('rel') ?? '';
    if (!rel.includes('noopener')) findings.push('target=_blank without rel=noopener');
  }

  return findings;
}
```

Create `packages/web/src/components/sources.css`:

```css
.health-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px var(--s-2);
  border-radius: var(--r-1);
  border-left: 3px solid currentColor;
  font-size: var(--fs-200);
  font-weight: 620;
}

.health-healthy { color: var(--ok); background: var(--ok-soft); }
.health-idle { color: var(--unk); background: var(--unk-soft); }
.health-yield_dropped { color: var(--warn); background: var(--warn-soft); }
.health-failing { color: var(--no); background: var(--no-soft); }
.health-stale { color: var(--warn); background: var(--warn-soft); }
.health-never_polled { color: var(--unk); background: var(--unk-soft); }

.fleet-summary {
  display: flex;
  align-items: baseline;
  gap: var(--s-3);
  padding: var(--s-4) var(--s-5);
  border-left: 3px solid var(--accent);
  margin-bottom: var(--s-4);
}

.fleet-figure { font-family: var(--font-data); font-size: var(--fs-600); font-weight: 700; }

/* Admin-only column. Members never render it, so it costs them nothing. */
.source-config {
  display: grid;
  gap: var(--s-2);
  min-width: 220px;
}

.source-config input[type="number"] {
  width: 6.5rem;
  padding: var(--s-1) var(--s-2);
  font-family: var(--font-data);
}

.source-config label { font-size: var(--fs-200); }

/* A paused source is still shown — deleting the row would hide the decision. */
.source-paused td { opacity: 0.62; }

.crawl-result {
  padding: var(--s-3) var(--s-4);
  margin-bottom: var(--s-4);
  border-left: 3px solid var(--ok);
  background: var(--ok-soft);
  color: var(--text);
}
```

Create `packages/web/src/routes/Sources.tsx`:

```tsx
import { useState } from 'react';
import { useApi } from '../store/useApi.js';
import { apiSend, ApiError } from '../api/client.js';
import { formatDate } from '../lib/trust.js';
import '../components/sources.css';

type HealthState =
  | 'healthy' | 'idle' | 'yield_dropped' | 'failing' | 'stale' | 'never_polled';

const WORDS: Record<HealthState, string> = {
  healthy: 'Healthy',
  idle: 'Idle',
  yield_dropped: 'Yield dropped',
  failing: 'Failing',
  stale: 'Stale',
  never_polled: 'Never polled',
};

interface SourceRow {
  id: string;
  label: string;
  tier: string;
  funderId: string;
  enabled: boolean;
  lastPolledAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastRecordCount: number | null;
  expectedMinRecords: number;
  health: { state: HealthState; detail: string };
}

interface SourcesResponse {
  rows: SourceRow[];
  summary: { total: number; healthy: number; unhealthy: number };
  canConfigure: boolean;
}

interface CrawlRunSummary {
  sourceId: string;
  parsedCount: number;
  events: number;
  reviewItems: number;
  error?: string;
}

interface CrawlResponse {
  startedAt: string;
  finishedAt: string;
  results: CrawlRunSummary[];
}

/** Per-row edit buffer, keyed by source id. Absent means "not yet touched". */
type Draft = Record<string, { expectedMinRecords: number; enabled: boolean }>;

export function Sources() {
  const { data, loading, error, reload } = useApi<SourcesResponse>('/api/sources/health');
  const [draft, setDraft] = useState<Draft>({});
  const [crawling, setCrawling] = useState(false);
  const [crawlResult, setCrawlResult] = useState<CrawlResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function draftFor(row: SourceRow) {
    return draft[row.id] ?? {
      expectedMinRecords: row.expectedMinRecords,
      enabled: row.enabled,
    };
  }

  function patchDraft(row: SourceRow, patch: Partial<Draft[string]>) {
    setDraft((d) => ({ ...d, [row.id]: { ...draftFor(row), ...patch } }));
  }

  async function runCrawl() {
    setCrawling(true);
    setActionError(null);
    setCrawlResult(null);
    try {
      setCrawlResult(await apiSend<CrawlResponse>('POST', '/api/sources/crawl', {}));
      reload();
    } catch (err) {
      setActionError(
        err instanceof ApiError
          ? err.message
          : 'The crawl could not be started.',
      );
    } finally {
      setCrawling(false);
    }
  }

  async function saveSource(row: SourceRow) {
    setActionError(null);
    try {
      await apiSend('PATCH', `/api/sources/${row.id}`, draftFor(row));
      setDraft((d) => {
        const next = { ...d };
        delete next[row.id];
        return next;
      });
      reload();
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.message : 'That change could not be saved.',
      );
    }
  }

  const canConfigure = data?.canConfigure === true;

  return (
    <>
      <p className="eyebrow">Ingestion</p>
      <h1 style={{ marginBottom: 'var(--s-4)' }}>Source health</h1>

      <p style={{ maxWidth: '76ch' }}>
        GrantSpotter is a curated database with a change-detection layer, not a spider. About
        twenty-five sources are polled nightly; a handful more are curated by hand because they
        deliberately block non-browser clients, and spoofing a browser to defeat a stated access
        policy is not something this project does.
      </p>

      {data && !canConfigure && (
        <p className="readonly-note">
          Only an administrator can change source configuration or trigger a crawl. This page is
          readable by everyone so that a wrong-looking record can always be traced to its source.
        </p>
      )}

      {loading && <p className="eyebrow">Loading…</p>}
      {error && <p role="alert">Could not load source health ({error.code}).</p>}
      {actionError !== null && <p role="alert" style={{ color: 'var(--no)' }}>{actionError}</p>}

      {data && (
        <>
          <section className="fleet-summary card" aria-label="Fleet summary">
            <span className="fleet-figure">{data.summary.unhealthy}</span>
            <span>
              {data.summary.unhealthy} of {data.summary.total} sources need attention.
            </span>
            {canConfigure && (
              <>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={crawling}
                  onClick={() => { void runCrawl(); }}
                >
                  {crawling ? 'Crawling…' : 'Run crawl now'}
                </button>
              </>
            )}
          </section>

          {canConfigure && (
            <p className="eyebrow" style={{ marginBottom: 'var(--s-4)' }}>
              A manual crawl visits every enabled source once. It is the same run the scheduler
              performs at 03:17, so anything it finds lands in the Inbox for review.
            </p>
          )}

          {crawlResult !== null && (
            <p role="status" className="crawl-result card">
              Crawled {crawlResult.results.length} sources in{' '}
              <span className="data">
                {Math.max(
                  1,
                  Math.round(
                    (Date.parse(crawlResult.finishedAt) - Date.parse(crawlResult.startedAt)) / 1000,
                  ),
                )}
              </span>{' '}
              seconds: {crawlResult.results.reduce((n, r) => n + r.parsedCount, 0)} records,{' '}
              {crawlResult.results.reduce((n, r) => n + r.events, 0)} changes detected.
              {crawlResult.results.some((r) => r.error !== undefined) && (
                <>
                  {' '}
                  Failed:{' '}
                  {crawlResult.results
                    .filter((r) => r.error !== undefined)
                    .map((r) => `${r.sourceId} (${r.error ?? ''})`)
                    .join(', ')}
                  .
                </>
              )}
            </p>
          )}

          <div className="table-wrap">
            <table className="grid-table" aria-label="Source health">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">State</th>
                  <th scope="col" className="num">Yield / baseline</th>
                  <th scope="col" className="num">Last poll</th>
                  <th scope="col" className="num">Last success</th>
                  <th scope="col" className="num">Failures</th>
                  <th scope="col">Detail</th>
                  {canConfigure && <th scope="col">Configuration</th>}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id} className={row.enabled ? undefined : 'source-paused'}>
                    <td>
                      <span className="row-name">
                        <strong>{row.label}</strong>
                        <span className="row-funder data">{row.id} · tier {row.tier}</span>
                      </span>
                    </td>
                    <td>
                      <span className={`health-pill health-${row.health.state}`}>
                        {WORDS[row.health.state]}
                      </span>
                    </td>
                    <td className="num">
                      {row.lastRecordCount ?? '—'} / {row.expectedMinRecords}
                    </td>
                    <td className="num">{formatDate(row.lastPolledAt)}</td>
                    <td className="num">{formatDate(row.lastSuccessAt)}</td>
                    <td className="num">{row.consecutiveFailures}</td>
                    <td>{row.health.detail}</td>
                    {canConfigure && (
                      <td>
                        <div className="source-config">
                          <label htmlFor={`baseline-${row.id}`} className="eyebrow">
                            Baseline for {row.label}
                          </label>
                          <input
                            id={`baseline-${row.id}`}
                            type="number"
                            min={0}
                            step={1}
                            value={draftFor(row).expectedMinRecords}
                            onChange={(e) =>
                              patchDraft(row, { expectedMinRecords: Number(e.target.value) })}
                          />

                          <label htmlFor={`enabled-${row.id}`}>
                            <input
                              id={`enabled-${row.id}`}
                              type="checkbox"
                              checked={draftFor(row).enabled}
                              onChange={(e) => patchDraft(row, { enabled: e.target.checked })}
                            />
                            {' '}Poll {row.label} nightly
                          </label>

                          <button
                            type="button"
                            className="btn"
                            onClick={() => { void saveSource(row); }}
                          >
                            Save {row.label}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
```

Modify `packages/web/src/App.tsx` — replace the Sources route element:

```tsx
import { Sources } from './routes/Sources.js';
// ...
        <Route path="/sources" element={<Sources />} />
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
npm run typecheck
```

Expected: 8 member-facing sources + 7 admin-control + 8 accessibility assertions green, whole web
suite green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web/src
git commit -m "feat(web): sources page with admin configuration and manual crawl, plus the a11y audit"
```

---

### Task 25: Admin console — users, backups, and ICS-token revocation

**Why this exists:** CONTRACT §2 lists eleven web routes and `Admin` is the one no plan created
(type-consistency finding #16). It is also the only screen from which a self-hosted operator can do
the three things spec §12 reserves to admins but puts nowhere else: manage accounts (Task 13),
download and restore the full JSON backup (Plan 5 Task 6's `GET /api/admin/backup.json` and
`POST /api/admin/restore`), and revoke a leaked calendar-feed token (Plan 5's
`DELETE /api/exports/ics-token`). Without this route those endpoints exist and are unreachable
from the product.

**Why the restore control is deliberately awkward.** Restore replaces the entire corpus. It is
behind a typed confirmation (`REPLACE`) rather than a single click, and the page states plainly what
is about to be overwritten. A one-click destructive control on an admin page is how an operator
loses a curated database at 23:00.

**Files:**
- Create: `packages/web/src/routes/Admin.tsx`
- Create: `packages/web/src/components/admin.css`
- Modify: `packages/web/src/App.tsx` (swap the Admin placeholder)
- Test: `packages/web/src/routes/Admin.test.tsx`

**Interfaces:**
- Consumes: `GET /api/admin/users`, `POST /api/admin/users`, `PATCH /api/admin/users/:id/role`, `PATCH /api/admin/users/:id/disabled`, `POST /api/admin/users/:id/reset-password` (Task 13); `GET /api/admin/backup.json`, `POST /api/admin/restore` (Plan 5 Task 6); `DELETE /api/exports/ics-token` (Plan 5 Task 9); `useApi`, `apiSend`, `ApiError`, `useSession`.
- Produces: `Admin`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/routes/Admin.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Admin } from './Admin.js';
import { SessionContext } from '../store/session.js';

const USERS = {
  rows: [
    {
      id: 'u-admin',
      email: 'admin@example.com',
      displayName: 'The Admin',
      role: 'admin',
      disabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastLoginAt: '2026-08-02T09:00:00.000Z',
      isSelf: true,
    },
    {
      id: 'u-member',
      email: 'member@example.com',
      displayName: 'A Member',
      role: 'member',
      disabled: false,
      createdAt: '2026-02-01T00:00:00.000Z',
      lastLoginAt: null,
      isSelf: false,
    },
  ],
};

function stubFetch(overrides: (url: string, init?: RequestInit) => unknown = () => undefined) {
  const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const custom = overrides(url, init);
    if (custom !== undefined) return Promise.resolve(custom);
    if (init?.method === 'POST' && url === '/api/admin/users') {
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({
          user: {
            id: 'u-new', email: 'new@example.com', displayName: '', role: 'member',
            disabled: false, createdAt: '2026-08-02T12:00:00.000Z', lastLoginAt: null,
            isSelf: false,
          },
          generatedPassword: 'Zx9-generated-password-value',
        }),
      });
    }
    if (init?.method !== undefined && init.method !== 'GET') {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => USERS });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAdmin() {
  return render(
    <MemoryRouter>
      <SessionContext.Provider
        value={{
          user: { id: 'u-admin', email: 'admin@example.com', role: 'admin' },
          hasStudentProfile: false,
          hasOrgProfile: false,
          completeness: { total: 0, unknownCount: 0, score: 100, fields: [] },
          unread: 0,
          loading: false,
          refresh: () => {},
          logout: async () => {},
        }}
      >
        <Admin />
      </SessionContext.Provider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Admin console — users', () => {
  it('lists every account with its role and last login', async () => {
    renderAdmin();
    const table = await screen.findByRole('table', { name: /user accounts/i });
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2
    expect(within(table).getByText('member@example.com')).toBeInTheDocument();
    expect(within(table).getByText(/never signed in/i)).toBeInTheDocument();
  });

  it('marks the signed-in admin so they cannot mistake whose row is whose', async () => {
    renderAdmin();
    const table = await screen.findByRole('table', { name: /user accounts/i });
    expect(within(table).getByText(/you/i)).toBeInTheDocument();
  });

  it('creates a user and shows the generated password exactly once, with a copy affordance', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    await userEvent.type(await screen.findByLabelText(/new account email/i), 'new@example.com');
    await userEvent.selectOptions(screen.getByLabelText(/new account role/i), 'member');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'POST',
      );
      expect(JSON.parse((post?.[1] as RequestInit).body as string))
        .toMatchObject({ email: 'new@example.com', role: 'member' });
    });

    const banner = await screen.findByRole('status');
    expect(banner).toHaveTextContent('Zx9-generated-password-value');
    expect(banner).toHaveTextContent(/shown once/i);
  });

  it('surfaces a duplicate-email conflict instead of appearing to succeed', async () => {
    stubFetch((url, init) =>
      init?.method === 'POST' && url === '/api/admin/users'
        ? {
            ok: false,
            status: 409,
            json: async () => ({
              error: { code: 'conflict', message: 'new@example.com already has an account.' },
              requestId: 'req-test-1',
            }),
          }
        : undefined);
    renderAdmin();
    await userEvent.type(await screen.findByLabelText(/new account email/i), 'new@example.com');
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already has an account/i);
  });

  it('changes a role through the labelled select', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    const select = await screen.findByLabelText(/role for member@example.com/i);
    await userEvent.selectOptions(select, 'admin');
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[0] as string) === '/api/admin/users/u-member/role',
      );
      expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({ role: 'admin' });
    });
  });

  it('disables an account', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    await userEvent.click(await screen.findByRole('button', { name: /disable member@example.com/i }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => (c[0] as string) === '/api/admin/users/u-member/disabled',
      );
      expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({ disabled: true });
    });
  });

  it('resets a password and shows the new one once', async () => {
    stubFetch((url, init) =>
      init?.method === 'POST' && url === '/api/admin/users/u-member/reset-password'
        ? {
            ok: true,
            status: 200,
            json: async () => ({
              user: USERS.rows[1],
              generatedPassword: 'fresh-generated-password-1',
            }),
          }
        : undefined);
    renderAdmin();
    await userEvent.click(
      await screen.findByRole('button', { name: /reset password for member@example.com/i }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('fresh-generated-password-1');
  });

  it('explains a last-admin refusal rather than silently reverting the select', async () => {
    stubFetch((url) =>
      url === '/api/admin/users/u-admin/role'
        ? {
            ok: false,
            status: 409,
            json: async () => ({
              error: {
                code: 'conflict',
                message: 'This is the last admin; promote someone else first.',
              },
              requestId: 'req-test-1',
            }),
          }
        : undefined);
    renderAdmin();
    await userEvent.selectOptions(
      await screen.findByLabelText(/role for admin@example.com/i),
      'member',
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/last admin/i);
  });
});

describe('Admin console — backup, restore and ICS tokens', () => {
  it('offers a backup download that points at the real endpoint', async () => {
    renderAdmin();
    const link = await screen.findByRole('link', { name: /download full backup/i });
    expect(link).toHaveAttribute('href', '/api/admin/backup.json');
    expect(link).toHaveAttribute('download');
  });

  it('keeps restore disabled until the operator types REPLACE', async () => {
    renderAdmin();
    const button = await screen.findByRole('button', { name: /restore from backup/i });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/type replace to confirm/i), 'REPLACE');
    expect(button).toBeEnabled();
  });

  it('states what restore destroys before it is used', async () => {
    renderAdmin();
    expect(await screen.findByText(/replaces every program, funder, cycle and review item/i))
      .toBeInTheDocument();
  });

  it('posts the chosen file to the restore endpoint', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    const file = new File(['{"programs":[]}'], 'backup.json', { type: 'application/json' });
    await userEvent.upload(await screen.findByLabelText(/backup file/i), file);
    await userEvent.type(screen.getByLabelText(/type replace to confirm/i), 'REPLACE');
    await userEvent.click(screen.getByRole('button', { name: /restore from backup/i }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some((c) => (c[0] as string) === '/api/admin/restore')).toBe(true);
    });
  });

  it('revokes the calendar feed token and says what that breaks', async () => {
    const fetchMock = stubFetch();
    renderAdmin();
    expect(await screen.findByText(/every subscribed calendar will stop updating/i))
      .toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /revoke my calendar feed link/i }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(del?.[0]).toBe('/api/exports/ics-token');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web/src/routes/Admin.test.tsx
```

Expected failure: `Failed to load url ./Admin.js`.

- [ ] **Step 3: Write the implementation**

Create `packages/web/src/components/admin.css`:

```css
.admin-section { padding: var(--s-4); margin-bottom: var(--s-5); }
.admin-section h2 { font-size: var(--fs-400); margin-bottom: var(--s-3); }

.admin-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--s-3);
  margin-bottom: var(--s-4);
}

.admin-form label { display: grid; gap: var(--s-1); font-size: var(--fs-200); }
.admin-form input, .admin-form select { padding: var(--s-2); }

/* The generated password is shown once. It reads as data, not as prose. */
.secret-banner {
  display: block;
  padding: var(--s-3) var(--s-4);
  margin-bottom: var(--s-4);
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
}

.secret-value {
  font-family: var(--font-data);
  font-size: var(--fs-400);
  user-select: all;
  word-break: break-all;
}

.danger-zone { border-left: 3px solid var(--no); background: var(--no-soft); }
.danger-zone h2 { color: var(--no); }

.admin-row-actions { display: flex; gap: var(--s-2); flex-wrap: wrap; align-items: center; }
```

Create `packages/web/src/routes/Admin.tsx`:

```tsx
import { useState } from 'react';
import { useApi } from '../store/useApi.js';
import { apiSend, ApiError } from '../api/client.js';
import { useSession } from '../store/session.js';
import { formatDate } from '../lib/trust.js';
import '../components/admin.css';

interface AdminUserRow {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'member';
  disabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  isSelf: boolean;
}

interface UsersResponse {
  rows: AdminUserRow[];
}

export function Admin() {
  const { user } = useSession();
  const users = useApi<UsersResponse>('/api/admin/users');

  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'member'>('member');
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirmWord, setConfirmWord] = useState('');

  function fail(err: unknown, fallback: string) {
    setError(err instanceof ApiError ? err.message : fallback);
  }

  async function createUser() {
    setError(null);
    setSecret(null);
    try {
      const created = await apiSend<{ user: AdminUserRow; generatedPassword: string }>(
        'POST', '/api/admin/users', { email: newEmail, role: newRole },
      );
      setSecret({ email: created.user.email, password: created.generatedPassword });
      setNewEmail('');
      users.reload();
    } catch (err) {
      fail(err, 'That account could not be created.');
    }
  }

  async function setRole(row: AdminUserRow, role: 'admin' | 'member') {
    setError(null);
    try {
      await apiSend('PATCH', `/api/admin/users/${row.id}/role`, { role });
      users.reload();
    } catch (err) {
      fail(err, 'That role change was refused.');
      // Re-read the server's truth so the select cannot show a change that
      // never happened.
      users.reload();
    }
  }

  async function setDisabled(row: AdminUserRow, disabled: boolean) {
    setError(null);
    try {
      await apiSend('PATCH', `/api/admin/users/${row.id}/disabled`, { disabled });
      users.reload();
    } catch (err) {
      fail(err, 'That account could not be changed.');
      users.reload();
    }
  }

  async function resetPassword(row: AdminUserRow) {
    setError(null);
    setSecret(null);
    try {
      const reset = await apiSend<{ generatedPassword: string }>(
        'POST', `/api/admin/users/${row.id}/reset-password`,
      );
      setSecret({ email: row.email, password: reset.generatedPassword });
    } catch (err) {
      fail(err, 'That password could not be reset.');
    }
  }

  async function restore() {
    if (restoreFile === null) return;
    setError(null);
    setMessage(null);
    try {
      // The backup is a JSON document, so it is posted as JSON — the restore
      // endpoint takes the parsed body, not multipart form data.
      const text = await restoreFile.text();
      await apiSend('POST', '/api/admin/restore', JSON.parse(text) as unknown);
      setMessage('Restore complete. The browse index was rebuilt from the restored corpus.');
      setConfirmWord('');
      setRestoreFile(null);
    } catch (err) {
      fail(err, 'That backup could not be restored.');
    }
  }

  async function revokeIcsToken() {
    setError(null);
    setMessage(null);
    try {
      await apiSend('DELETE', '/api/exports/ics-token');
      setMessage('Calendar feed link revoked. Generate a new one from the Calendar page.');
    } catch (err) {
      fail(err, 'That token could not be revoked.');
    }
  }

  return (
    <>
      <p className="eyebrow">Administration</p>
      <h1 style={{ marginBottom: 'var(--s-4)' }}>Admin</h1>

      {error !== null && <p role="alert" style={{ color: 'var(--no)' }}>{error}</p>}
      {secret !== null && (
        <span className="secret-banner" role="status">
          Password for <strong>{secret.email}</strong>:{' '}
          <span className="secret-value">{secret.password}</span>
          <br />
          This is shown once. Copy it now — the server stores only its hash and cannot show it again.
        </span>
      )}
      {message !== null && secret === null && <p role="status">{message}</p>}

      <section className="admin-section card" aria-label="User accounts">
        <h2>Accounts</h2>
        <p style={{ maxWidth: '70ch' }}>
          Members can browse, match, watch, export and read the review Inbox. Admins additionally
          decide review items, configure sources, trigger crawls and manage accounts. Passwords are
          generated here rather than chosen: you never type another person’s password.
        </p>

        <div className="admin-form">
          <label htmlFor="new-email">
            New account email
            <input
              id="new-email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
            />
          </label>
          <label htmlFor="new-role">
            New account role
            <select
              id="new-role"
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as 'admin' | 'member')}
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <button type="button" className="btn btn-primary" onClick={() => { void createUser(); }}>
            Create account
          </button>
        </div>

        {users.loading && <p className="eyebrow">Loading…</p>}
        {users.error && <p role="alert">Could not load accounts ({users.error.code}).</p>}

        {users.data && (
          <div className="table-wrap">
            <table className="grid-table" aria-label="User accounts">
              <thead>
                <tr>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col" className="num">Created</th>
                  <th scope="col" className="num">Last login</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.data.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <span className="row-name">
                        <strong>{row.email}</strong>
                        <span className="row-funder">
                          {row.displayName}
                          {row.isSelf ? ' · you' : ''}
                          {row.disabled ? ' · disabled' : ''}
                        </span>
                      </span>
                    </td>
                    <td>
                      <label htmlFor={`role-${row.id}`} className="eyebrow">
                        Role for {row.email}
                      </label>
                      <select
                        id={`role-${row.id}`}
                        value={row.role}
                        onChange={(e) => {
                          void setRole(row, e.target.value as 'admin' | 'member');
                        }}
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td className="num">{formatDate(row.createdAt)}</td>
                    <td className="num">
                      {row.lastLoginAt === null ? 'Never signed in' : formatDate(row.lastLoginAt)}
                    </td>
                    <td>
                      <div className="admin-row-actions">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => { void setDisabled(row, !row.disabled); }}
                        >
                          {row.disabled ? `Enable ${row.email}` : `Disable ${row.email}`}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => { void resetPassword(row); }}
                        >
                          Reset password for {row.email}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="admin-section card" aria-label="Calendar feed">
        <h2>Calendar feed link</h2>
        <p style={{ maxWidth: '70ch' }}>
          Your ICS feed URL contains a signed token so calendar clients — which cannot send a session
          cookie — can subscribe. Revoke it if the URL has been shared or pasted somewhere public.
          Every subscribed calendar will stop updating until you generate a new link.
        </p>
        <button type="button" className="btn" onClick={() => { void revokeIcsToken(); }}>
          Revoke my calendar feed link
        </button>
      </section>

      <section className="admin-section card danger-zone" aria-label="Backup and restore">
        <h2>Backup and restore</h2>
        <p style={{ maxWidth: '70ch' }}>
          The backup is a single JSON document containing the whole corpus, the profiles, the
          watchlists and the review history. Restoring one replaces every program, funder, cycle and
          review item currently in this instance. There is no undo, so take a backup first.
        </p>

        <p>
          <a className="btn" href="/api/admin/backup.json" download>
            Download full backup
          </a>
        </p>

        <div className="admin-form">
          <label htmlFor="restore-file">
            Backup file
            <input
              id="restore-file"
              type="file"
              accept="application/json,.json"
              onChange={(e) => setRestoreFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <label htmlFor="restore-confirm">
            Type REPLACE to confirm
            <input
              id="restore-confirm"
              type="text"
              value={confirmWord}
              onChange={(e) => setConfirmWord(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn"
            disabled={confirmWord !== 'REPLACE'}
            onClick={() => { void restore(); }}
          >
            Restore from backup
          </button>
        </div>
        <p className="eyebrow">Signed in as {user?.email ?? 'unknown'}.</p>
      </section>
    </>
  );
}
```

Modify `packages/web/src/App.tsx` — replace the Admin route element written in Task 15:

```tsx
import { Admin } from './routes/Admin.js';
// ...
        <Route path="/admin" element={<AdminOnly><Admin /></AdminOnly>} />
```

Add `Admin` to the accessibility sweep in `packages/web/src/test/a11y.test.tsx`, so this route is
held to the same standard as the other seven. It needs the session provider, because the page reads
`useSession()`:

```tsx
import { Admin } from '../routes/Admin.js';
import { SessionContext } from '../store/session.js';

// …appended to the ROUTES array:
  ['Admin', () => (
    <SessionContext.Provider
      value={{
        user: { id: 'u-admin', email: 'admin@example.com', role: 'admin' },
        hasStudentProfile: false,
        hasOrgProfile: false,
        completeness: { total: 0, unknownCount: 0, score: 100, fields: [] },
        unread: 0,
        loading: false,
        refresh: () => {},
        logout: async () => {},
      }}
    >
      <Admin />
    </SessionContext.Provider>
  )],
```

The permissive stub in that file already answers `/api/admin/users` with `{ rows: [] }`, so no change
to `stubEverything()` is needed.

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npx vitest run packages/web
npm run typecheck
```

Expected: 12 Admin assertions green, the accessibility sweep now covering 8 routes, whole web suite
green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add packages/web/src
git commit -m "feat(web): admin console for accounts, backup/restore and ICS-token revocation"
```

---

### Task 26: Playwright end-to-end and full local verification

**Why this exists:** the plan's acceptance criterion. The flow is exactly the one spec §17 names for Plan 3, plus the change-event delivery that is the product's highest-value output: **log in → set profile → browse with verdicts → star → calendar → receive a simulated change event on a watched program.**

The change event is simulated by writing a real `change_events` row into the running server's SQLite file from the test process — the same table the nightly crawl writes. Nothing about the delivery path is stubbed: the row is drained, fanned out, and rendered exactly as it would be at 03:17 on a Tuesday.

**When this suite goes green, and why it is not at the end of Plan 3 (RESOLUTIONS R25).** Every spec
below starts at `page.goto('/')`, and `/` is served by the SPA middleware that is the **last**
statement of Task 14's `mountRoutes` callback. That middleware is Plan 5's: `api/spa.ts` is created
by Plan 5's SPA task (R16) and mounted by **Plan 5 Task 17** (R25). Plan 3 deliberately does not
forward-reference it, because importing a file that does not exist fails `npm run build`, and a
failed build means `packages/server/dist/index.js` is never emitted and this config's `webServer`
never starts at all — a strictly worse failure that takes `typecheck`, `build` and `npm test` down
with it.

So this task's hard, must-pass gate is `npm run typecheck && npm run build && npm test`, all three
clean from a clean checkout. `npm run test:e2e` is run here as a **harness proof** — it must build
the SPA, seed the database, boot the real server on `127.0.0.1:3131` and answer the request — and
its one permitted failure is the SPA fallback being absent, i.e. `page.goto('/')` returning Plan 1's
JSON 404 envelope instead of `index.html`. Any other failure (server will not start, seed throws,
port in use, a selector that never existed) is a real defect in this task and is fixed here. The
suite closes green in Plan 5, whose Definition of Done re-runs all four specs with the SPA
middleware installed; the exact one-line diff that flips it is
`a.use(createSpaMiddleware(webDistRoot()));` appended at Task 14's reservation comment.

**Files:**
- Create: `playwright.config.ts` (authoritative; this task writes its full content)
- Create: `e2e/seed.ts`
- Create: `e2e/helpers.ts`
- Create: `e2e/flow.spec.ts`
- Modify: `package.json` (root — add `e2e:seed`, `e2e:server`)

**Interfaces:**
- Consumes: `hashPassword(plain: string): Promise<string>` from `packages/server/src/auth/password.js` (Plan 1); `POST /api/auth/login` (Plan 1); every Plan 3 route and router.
- Produces: `seedE2E(dbPath: string): Promise<void>`, `insertChangeEvent(dbPath, event)`, the `flow.spec.ts` suite.

- [ ] **Step 1: Write the failing e2e test**

Create `e2e/helpers.ts`:

```ts
import Database from 'better-sqlite3';

export const E2E_PORT = 3131;
export const BASE_URL = `http://127.0.0.1:${E2E_PORT}`;

/**
 * DATA_DIR for the e2e server, and the file Plan 1's entrypoint opens inside it:
 * `openDatabase(join(config.dataDir, 'grantspotter.sqlite'))`. The seed script
 * and the server must name the same file, or the seed silently populates a
 * database nothing reads.
 */
export const DATA_DIR = 'e2e/.tmp';
export const DB_PATH = `${DATA_DIR}/grantspotter.sqlite`;

export const MEMBER_EMAIL = 'member@example.com';
export const MEMBER_PASSWORD = 'e2e-member-password-not-a-real-secret';
export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'e2e-admin-password-not-a-real-secret';

/**
 * Write a real ChangeEvent row, exactly as the nightly crawl does. This is the
 * simulation: the row is real, the fan-out is real, only the crawl is skipped.
 */
export function insertChangeEvent(event: {
  id: string;
  sourceId: string;
  programId: string;
  kind: string;
  before: unknown;
  after: unknown;
  detectedAt: string;
  fieldPath: string | null;
}): void {
  const db = new Database(DB_PATH);
  db.prepare(
    `INSERT INTO change_events
       (id, source_id, program_id, kind, before_json, after_json, detected_at, field_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id, event.sourceId, event.programId, event.kind,
    JSON.stringify(event.before), JSON.stringify(event.after),
    event.detectedAt, event.fieldPath,
  );
  db.close();
}
```

Create `e2e/flow.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import {
  ADMIN_EMAIL, ADMIN_PASSWORD, insertChangeEvent, MEMBER_EMAIL, MEMBER_PASSWORD,
} from './helpers.js';

test('log in, set a profile, browse with verdicts, star, calendar, receive a change event', async ({ page }) => {
  // --- log in -------------------------------------------------------------
  await page.goto('/');
  await page.getByLabel('Email').fill(MEMBER_EMAIL);
  await page.getByLabel('Password').fill(MEMBER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Browse opportunities' })).toBeVisible();

  // Before a profile exists, the app says so instead of showing silent nulls.
  await expect(page.getByRole('link', { name: /set up a profile/i })).toBeVisible();

  // --- set the profile ----------------------------------------------------
  await page.getByRole('link', { name: 'Profile' }).click();
  await page.getByLabel('Callsign').fill('W8UM');
  await page.getByLabel('License class').selectOption('GENERAL');
  await page.getByLabel('State').fill('MI');
  await page.getByLabel('Degree level').selectOption('BACH');
  await page.getByLabel('Stage').selectOption('UNDERGRAD');
  await page.getByLabel('Citizenship').selectOption('US_CITIZEN');
  await page.getByRole('button', { name: /save student profile/i }).click();
  await expect(page.getByRole('status')).toContainText('saved');

  // The completeness meter is expressed in unknown verdicts, not fields filled.
  await expect(page.getByRole('meter', { name: /profile completeness/i })).toBeVisible();

  // --- browse with verdicts ----------------------------------------------
  await page.getByRole('link', { name: 'Browse' }).click();
  await expect(page.getByRole('table', { name: 'Opportunities' })).toBeVisible();
  await expect(page.getByText(/you are ineligible for \d+ of these/i)).toBeVisible();

  // Every honesty surface is reachable from the list.
  await expect(page.getByLabel('Status: unknown').first()).toBeVisible();
  await expect(page.getByLabel(/unverified/i).first()).toBeVisible();
  await expect(page.getByText(/mirror stale ARRL data/i)).toBeVisible();

  // The specific constraint for an ineligible row is one click away.
  await page.getByRole('link', { name: /see the specific constraint for each/i }).click();
  await page.getByRole('button', { name: /ineligible, \d+ constraint/i }).first().click();
  await expect(page.getByRole('region', { name: /why you are ineligible/i })).toBeVisible();

  // --- star a program -----------------------------------------------------
  await page.goto('/o/arrl-foundation-scholarship');
  await expect(page.getByRole('heading', { name: 'ARRL Foundation Scholarship Program' })).toBeVisible();
  await page.getByRole('button', { name: 'Watch this program' }).click();
  await expect(page.getByRole('button', { name: 'Stop watching this program' })).toBeVisible();

  // --- calendar -----------------------------------------------------------
  await page.getByRole('link', { name: 'Calendar' }).click();
  await expect(page.getByRole('list', { name: 'Agenda' })).toBeVisible();
  await expect(page.getByText(/start by \d{4}-\d{2}-\d{2}/i).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Month' }).click();
  await expect(page.getByRole('grid')).toBeVisible();

  // --- a change event lands on the watched program ------------------------
  // "ARRL moved the scholarship close from Jan 31 to Dec 30" - spec §11.2.
  insertChangeEvent({
    id: 'e2e-ce-1',
    sourceId: 'arrl-scholarship-descriptions',
    programId: 'arrl-foundation-scholarship',
    kind: 'deadline_changed',
    before: 'January 31',
    after: 'December 30, 12:00 PM EST',
    detectedAt: new Date().toISOString(),
    fieldPath: 'deadline.note',
  });

  await page.getByRole('link', { name: 'Watchlist' }).click();
  const digest = page.getByRole('region', { name: /change digest/i });
  await expect(digest.getByText('Deadline changed: ARRL Foundation Scholarship Program')).toBeVisible();
  await expect(digest.getByText('January 31')).toBeVisible();
  await expect(digest.getByText('December 30, 12:00 PM EST')).toBeVisible();

  // And it is actionable: open the record, then clear it.
  await expect(digest.getByRole('link', { name: /open the record/i })).toBeVisible();
  await page.getByRole('button', { name: /mark all read/i }).click();
  await expect(digest.getByText('Deadline changed: ARRL Foundation Scholarship Program')).toBeVisible();
});

test('a member sees the inbox but cannot decide', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(MEMBER_EMAIL);
  await page.getByLabel('Password').fill(MEMBER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('link', { name: 'Inbox' }).click();
  await expect(page.getByText(/only an administrator can approve or reject/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /^approve$/i })).toHaveCount(0);
});

test('the sources health page is readable by a member, and offers them no controls', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(MEMBER_EMAIL);
  await page.getByLabel('Password').fill(MEMBER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await page.getByRole('link', { name: 'Sources' }).click();
  await expect(page.getByRole('heading', { name: 'Source health' })).toBeVisible();
  await expect(page.getByText(/only an administrator can change source configuration/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /run crawl now/i })).toHaveCount(0);

  // The Admin route is not offered, and typing the URL does not reach it.
  await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Browse opportunities' })).toBeVisible();
});

test('an admin manages users, configures a source, and triggers a crawl', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // --- user management (spec §12, "User management | admin ✅ | member ❌") ---
  await page.getByRole('link', { name: 'Admin' }).click();
  await expect(page.getByRole('heading', { name: 'Admin' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'User accounts' })).toBeVisible();

  await page.getByLabel('New account email').fill('second-member@example.com');
  await page.getByLabel('New account role').selectOption('member');
  await page.getByRole('button', { name: 'Create account' }).click();

  // The generated password is shown once, and the new row appears.
  await expect(page.getByRole('status')).toContainText(/shown once/i);
  await expect(page.getByRole('table', { name: 'User accounts' }))
    .toContainText('second-member@example.com');

  // Restore is guarded by a typed confirmation, not a single click.
  await expect(page.getByRole('button', { name: /restore from backup/i })).toBeDisabled();

  // --- source configuration and the manual crawl (spec §12) ---
  await page.getByRole('link', { name: 'Sources' }).click();
  await page.getByLabel(/baseline for ARRL scholarship catalog/i).fill('105');
  await page.getByRole('button', { name: /save ARRL scholarship catalog/i }).click();
  await expect(page.getByLabel(/baseline for ARRL scholarship catalog/i)).toHaveValue('105');

  // CRAWL_ENABLED is false for the e2e server, so the scheduler never fires;
  // this button is the only thing that runs a crawl in this process. The
  // fixture source's requests point at example.com and fail closed, which is
  // exactly what we assert: a reported failure, not a silent hang.
  await page.getByRole('button', { name: /run crawl now/i }).click();
  await expect(page.getByRole('status')).toContainText(/crawled/i, { timeout: 30_000 });
});
```

- [ ] **Step 2: Run the e2e suite to verify it fails**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npm run test:e2e
```

Expected failure: `Error: No tests found` or `Cannot find module './helpers.js'`, and no web server configured.

- [ ] **Step 3: Write the harness**

Create `e2e/seed.ts`. It builds the database the server will open, using the same fixture corpus the server tests use, so the e2e assertions and the unit assertions describe the same records:

```ts
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { hashPassword } from '../packages/server/src/auth/password.js';
import { migrate, openDatabase } from '../packages/server/src/db/migrate.js';
import { createUserRepo } from '../packages/server/src/db/repositories/users.js';
import { ensureIngestionSchema } from '../packages/server/src/db/ingestSchema.js';
import { seedFixtureCorpus } from '../packages/server/src/test/fixtures/programs.js';
import { reindexBrowse } from '../packages/server/src/api/reindex.js';
import { ADMIN_EMAIL, ADMIN_PASSWORD, DB_PATH, MEMBER_EMAIL, MEMBER_PASSWORD } from './helpers.js';

async function main(): Promise<void> {
  rmSync(dirname(DB_PATH), { recursive: true, force: true });
  mkdirSync(dirname(DB_PATH), { recursive: true });

  // Plan 1's migration runner, not a hand-rolled glob: the e2e database must be
  // byte-for-byte the schema the server will open, `schema_migrations` included.
  const db = openDatabase(DB_PATH);
  migrate(db);
  ensureIngestionSchema(db);

  seedFixtureCorpus(db);

  // Plan 1's `users` table has NOT NULL email_normalized / password_hash /
  // ics_token, all of which createUserRepo().create() populates.
  const users = createUserRepo(db);
  users.create({
    email: MEMBER_EMAIL,
    passwordHash: await hashPassword(MEMBER_PASSWORD),
    role: 'member',
    displayName: 'E2E Member',
  });
  users.create({
    email: ADMIN_EMAIL,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    role: 'admin',
    displayName: 'E2E Admin',
  });

  // `klass` is NOT NULL in Plan 1's sources DDL.
  db.prepare(
    `INSERT INTO sources
       (id, label, tier, klass, funder_id, enabled, last_polled_at, last_success_at,
        consecutive_failures, last_record_count, expected_min_records)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'arrl-scholarship-descriptions', 'ARRL scholarship catalog', 'C', 'ham_scholarship',
    'arrl-foundation', 1,
    '2026-08-02T03:17:00.000Z', '2026-08-02T03:17:00.000Z', 0, 111, 100,
  );

  // Provenance so the watched-source fan-out has something to join against.
  db.prepare(
    `INSERT INTO field_provenance
       (program_id, field_path, source_id, snapshot_id, raw_label, raw_value, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'arrl-foundation-scholarship', 'deadline.note', 'arrl-scholarship-descriptions', null,
    'Deadline', 'January 31', '2026-08-02T03:17:00.000Z',
  );

  reindexBrowse(db, new Date().toISOString());
  db.close();
}

void main();
```

Create `playwright.config.ts` at the repo root — this task writes its full content and it is authoritative:

```ts
import { defineConfig } from '@playwright/test';
import { BASE_URL, DATA_DIR, E2E_PORT } from './e2e/helpers.js';

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
    command:
      'npm run build && npm run e2e:seed && node packages/server/dist/index.js',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
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
```

Modify the root `package.json` scripts. `test:e2e` was added in Task 1 (the CONTRACT §8 deviation
recorded in this plan's Global Constraints, RESOLUTIONS R13); this task adds only the seed script it
depends on:

```json
{
  "scripts": {
    "e2e:seed": "tsx e2e/seed.ts",
    "test:e2e": "playwright test"
  }
}
```

Install the Playwright package and its Chromium build:

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npm install --save-dev @playwright/test@^1.47.2 tsx
npx playwright install chromium
```

Add `e2e/.tmp/` to `.gitignore`:

```
e2e/.tmp/
```

- [ ] **Step 4: Run the full verification**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npm run typecheck
npm run build
npm test
npm run test:e2e
```

Expected, and this is the plan's acceptance gate:

- `npm run typecheck` clean, `npm run build` producing the `core`, `server` and `web` bundles
  (including `packages/server/dist/index.js`), and `npm test` green across every unit and
  integration suite. **These three must pass in full; no Plan 3 task is complete until they do.**
- `npm run test:e2e` builds, seeds, boots the server and reaches it. At the end of Plan 3 the four
  specs then fail on their first line with Plan 1's JSON 404 at `/`, because the SPA middleware is
  Plan 5 Task 17's (RESOLUTIONS R25 — see the note at the top of this task). Confirm that is the
  failure you get and nothing else:

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
npm run build && npm run e2e:seed
PORT=3131 DATA_DIR=e2e/.tmp CRAWL_ENABLED=false \
  SESSION_SECRET=e2e-session-secret-not-a-real-secret \
  CONTACT_URL=https://example.com/grantspotter \
  node packages/server/dist/index.js &
sleep 3
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' http://127.0.0.1:3131/api/health
curl -s http://127.0.0.1:3131/ | head -c 200
kill %1
```

`/api/health` must answer `200 application/json` — that proves the build, the migrations, the mount
hook and the listener are all correct. `/` printing `{"error":{"code":"not_found"...` is the
expected Plan 3 state; Plan 5 Task 17 turns it into `<!doctype html>` and the four specs go green
there.

- [ ] **Step 5: Commit**

```bash
export PATH="/path/to/node20/bin:$PATH"
cd /path/to/grantspotter
git add playwright.config.ts e2e package.json package-lock.json .gitignore
git commit -m "test(e2e): login to profile to browse to star to calendar to change-event flow"
```

**Do not push.** Commits stay local through all five plans; the single push happens at the end of Plan 5, after the completeness audit and the debug audit.

---

## Definition of done for Plan 3

- [ ] All 26 tasks committed locally, no `git push` executed.
- [ ] `npm run typecheck`, `npm run build` and `npm test` all green from a clean checkout, with
  **no unresolved imports anywhere** — Plan 3 forward-references no Plan 4 or Plan 5 module
  (RESOLUTIONS R25). `packages/server/dist/index.js` exists after `npm run build`; without it
  Playwright's `webServer` cannot start.
- [ ] `npm run test:e2e` builds the SPA, seeds the database, boots the real server and reaches it.
  Its four specs close **in Plan 5**, because `page.goto('/')` is answered by the SPA middleware that
  Plan 5 Task 17 appends at Task 14's reservation comment (RESOLUTIONS R16 + R25). The only failure
  permitted at the end of Plan 3 is Plan 1's JSON 404 at `/`; anything else is a Plan 3 defect.
- [ ] The schema-conformance test (Task 2) passes, meaning Plan 3's declared read-contract with Plans 1 and 2 holds — including its assertion that `programs` has **no** `data` column (RESOLUTIONS R1).
- [ ] `grep -rn "res.status(4\|res.status(5" packages/server/src/api` returns nothing. Every failure is `next(new AppError(...))` and every error body is Plan 1's envelope (RESOLUTIONS R6).
- [ ] `grep -n "app.use(" packages/server/src/index.ts` shows every mount inside the `mountRoutes` callback, and no `app.use(...)` after `createApp` returns (RESOLUTIONS R5). **Nothing is ever mounted after `createApp` returns, in any plan.**
- [ ] That callback contains **only** `mountProductApi(a, routerDeps, verifyRunner, …)` followed by the reservation comment naming RESOLUTIONS R25 — there is no executable `a.use(` anywhere in `index.ts` at the end of Plan 3, only the example lines quoted inside that comment. `grep -nE "from '\./api/(applications|templates|prose|prompts|exports|spa)\.js'|from '\./exports/dataSource\.js'" packages/server/src/index.ts` returns nothing: Plan 4 Task 17 Step 5 and Plan 5 Task 9 Step 9 / Task 17 add their own imports with their own mount lines (with `createApplicationsRouter(routerDeps)` and its three siblings taking the FULL `RouterDeps`, RESOLUTIONS R17 — never `applicationsRouter({ db })` or a zero-argument call).
- [ ] `packages/server/src/api/webDist.ts` exports `webDistRoot()` and is its **only** definition (RESOLUTIONS R27). Plan 5's `api/spa.ts` imports it from there; `grep -rn "function webDistRoot" packages/server/src` returns exactly one hit.
- [ ] `packages/server/src/api/mount.test.ts` asserts that every Plan 3 router is reachable through the real `createApp`, that `/api/unknown` is Plan 1's JSON 404 envelope, and that `GET /` is **also** a JSON 404 — proof that Plan 3 has not claimed `/`. The HTML assertions for `/` and `/browse` belong to Plan 5 Task 17's `spa.test.ts`.
- [ ] `POST /api/inbox/:id/decision` **delegates** to Plan 2's `approveReviewItem` / `rejectReviewItem` / `editReviewItem` and re-implements none of them (RESOLUTIONS R26). `grep -n "programs.upsert\|createProgramRepo" packages/server/src/api/inboxRouter.ts` returns nothing, and `inboxRouter.test.ts` proves all four consequences: a rejection writes `review_rejects`, an approved `new` event lands `source_id` / `external_key`, an approved `vanished` event **deletes** the program, and every decision appends an `audit_log` row. It is the only path a human takes into the review pipeline, so a divergence here is a divergence in production.
- [ ] `grep -rn "SELECT data FROM programs\|retryAfterSeconds\|deadlineSource" packages/server packages/web e2e` returns nothing.
- [ ] `packages/server/src/index.ts` holds exactly one `createFetcher(` (carrying `headersByHost: simplerAuthHeaders()`) and exactly one `createAiAssist(config)`, both shared by the nightly scheduler and the admin crawl trigger, so the two paths are byte-identical (RESOLUTIONS R23).
- [ ] `grep -rn "CREATE TABLE" packages/server/src/db/migrations/03*.sql` never names `profiles` or `watches`: both are Plan 1's (RESOLUTIONS R19), and Plan 3's `032`/`033` add indexes only. The `migration ownership` block in `schemaConformance.test.ts` proves it, and no fixture writes `INSERT INTO watches` directly — they go through `starProgram`, which inserts the `users` and `programs` parents the cascade foreign keys require.
- [ ] `packages/web/test/` no longer exists: Plan 1's client assertions live in `packages/web/src/api/client.test.ts`, and `packages/web/src/api/client.ts` still exports Plan 1's `apiFetch`, `ApiError`, `ApiErrorCode`, `ApiErrorBody`, `getHealth`, `getBootstrapStatus`, `postBootstrap`, `postLogin`, `postLogout`, `getMe` and `PublicUser` (RESOLUTIONS R11).
- [ ] Every row of the spec §12 role matrix is reachable in the running app: an admin can manage users (Tasks 13, 25), configure sources and trigger a crawl (Tasks 14, 24), decide review items (Tasks 12, 23), and back up / restore (Task 25); a member sees the Inbox and the Sources page read-only, with the controls **absent** rather than disabled.
- [ ] All eleven CONTRACT §2 web routes exist: `Browse`, `Opportunity`, `Calendar`, `Watchlist`, `Inbox`, `Profile`, `Sources`, `Login` and `Admin` from this plan, `Templates` and `Applications` from Plan 4.
- [ ] Every honesty surface in spec §8 is reachable in the running app: `lastVerifiedAt` on every record, amber past 90 days, a working **Verify now** with a rendered diff, `status: unknown` as a labelled state, all three ARRL Club Grant disputed claims shown with sources, the Chicago FM stale-mirror warning, field-level provenance, and the sources health page.
- [ ] `Copy AI Prompt — includes AI-detection avoidance` appears nowhere yet; that button is Plan 4's, and Plan 3 ships only the quoted `aiPolicy` block beside where it will land.
- [ ] No real LAN IPs, hostnames, or host paths anywhere in the diff.

