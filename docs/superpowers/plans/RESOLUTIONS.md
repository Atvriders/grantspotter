# GrantSpotter — Audit Resolutions (2026-08-02)

Two audits (spec-coverage, cross-plan type-consistency) produced 37 findings: 9 blockers,
8 major, 20 minor. This file records the **canonical decision** for every conflict that spans
more than one plan file. Fix agents own disjoint files and follow these decisions verbatim.

Raw findings were written to two scratch files, `coverageAudit.json` and `typeAudit.json`, in the
session scratchpad. They are not committed: they are machine-local temporary output, and the
decisions they produced are recorded below, which is the part worth keeping.

---

## R1 — `programs` table: Plan 1's normalized DDL wins

CONTRACT §6 names `programs.amount` and `programs.obligations` as columns, so Plan 1's
`001-init.sql` normalized shape is authoritative. Three shapes existed; two die.

- **Plan 1** keeps its normalized DDL and **adds two columns**: `source_id TEXT` and
  `external_key TEXT`, plus `CREATE UNIQUE INDEX programs_source_key ON programs(source_id, external_key) WHERE source_id IS NOT NULL;`
  These exist for R9 (crawler↔seed id reconciliation).
- **Plan 2** deletes `packages/server/src/db/programDoc.ts`, deletes the `programs` entries from
  `TABLES`/`REQUIRED_COLUMNS` in `ingestSchema.ts`, and delegates `upsertProgram` /
  `listProgramsBySource` / `deleteProgram` to `createProgramRepo(db).upsert/.list/.remove`.
- **Plan 3** replaces every `SELECT data FROM programs` with `createProgramRepo(deps.db).get(id)`
  / `.list(filter)`. There is no `data` column and never was; the Plan 3 read-contract table row
  for `programs` is rewritten to Plan 1's real column list.

## R2 — `review_items.candidate_json`

Two plans already agree on `candidate_json`, so Plan 1 changes. In Plan 1 Task 12 `001-init.sql`:
`candidate TEXT NOT NULL` → `candidate_json TEXT NOT NULL`, and
`created_at TEXT NOT NULL` → `created_at TEXT NOT NULL DEFAULT ''`.
Plan 1 updates its own repository and test references.

## R3 — `snapshots` adopts Plan 2's shape

Plan 1 Task 12 `001-init.sql` replaces its `snapshots` DDL with:

```sql
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
```

Plan 2 deletes its duplicate `snapshots` entry from `TABLES`/`REQUIRED_COLUMNS`.

## R4 — `source_health` is deleted; `sources` carries health

Plan 1's `sources` table already has every needed column. Plan 2 drops the `source_health`
table entirely and rewrites `recordPollStart` / `recordPollSuccess` / `recordPollFailure` /
`listSourceHealth` against `sources`. Canonical column names (Plan 1 + Plan 3 already agree):
`last_polled_at` (**not** `last_poll_at`), `last_success_at`, `last_record_count`
(**not** `parse_yield`), `consecutive_failures`, `last_error`, `expected_min_records`.
Plan 2's plan-local `SourceHealthRow` renames `lastPollAt`→`lastPolledAt`,
`parseYield`→`lastRecordCount`.

## R5 — Route mounting: `AppDeps.mountRoutes`

**This is the blocker that would have made ~20 routers silently unreachable.** Express matches in
registration order, and Plan 1's `createApp` seals the app with `notFoundHandler()` before
returning.

- **Plan 1** extends `AppDeps` with `mountRoutes?: (app: Express) => void;` and calls
  `deps.mountRoutes?.(app);` on the line **immediately above** `app.use(notFoundHandler());`.
- **Plans 3, 4, 5** mount exclusively through that hook, from a single call site in
  `packages/server/src/index.ts`. **No plan may call `app.use(...)` after `createApp` returns.**
  Plan 3 owns the `index.ts` composition and includes Plan 4's and Plan 5's routers in the
  hook body; Plans 4 and 5 state that their routers are mounted there rather than mounting
  them themselves.

## R6 — One error envelope

Plan 1's is the only one: `{ error: { code, message, details? }, requestId }`, codes exactly
`bad_request | validation_failed | unauthorized | forbidden | not_found | conflict |
rate_limited | payload_too_large | internal`, and **422** for zod failures (not 400).

All 37 ad-hoc sites in Plans 3, 4, 5 become `next(new AppError(code, message, details?))`,
importing `AppError` from `packages/server/src/api/errors.js`. Ad-hoc codes map as:
`admin_required`→`forbidden`; `unknown_kind`/`kind_mismatch`/`invalid_decision`/
`invalid_candidate`/`invalid_profile`/`invalid patch`/`invalid application`→`validation_failed`;
`program_id_required`/`Unknown programId`→`bad_request`; `not found`→`not_found`;
`Not signed in`→`unauthorized`; `unsafe_url`/`ntfy_needs_server_and_topic`→`validation_failed`.

Plan 3's web client `handle<T>` parses the real envelope:
```ts
const body = (await readBody(response)) as ApiErrorBody | null;
throw new ApiError(
  body?.error?.code ?? 'internal',
  body?.error?.message ?? 'request failed',
  response.status,
  body?.requestId ?? '',
  body?.error?.details,
);
```

## R7 — Zod schema names are lower-camel

`funderSchema`, `programSchema`, `constraintSchema`, `amountSpecSchema`, `deadlineSpecSchema`,
`cycleSchema`, `obligationsSchema`, `aiPolicySchema`, `trustFieldsSchema`, `profileSchema`,
`studentProfileSchema`, `orgProfileSchema`, `geoSpecSchema`. Plan 5's `ProgramSchema` /
`FunderSchema` are wrong and get renamed.

## R8 — Repositories are factories

`createFunderRepo(db)`, `createProgramRepo(db)`, `createConstraintRepo(db)`, `createCycleRepo(db)`,
`createUserRepo(db)`, `createSessionRepo(db)`, `createProfileRepo(db)`. There are no free
functions named `listPrograms`, `listFunders`, `getProfileForUser`, `upsertProgram`,
`upsertFunder`. There is no `db/repositories/watches.ts`; watch queries live in Plan 3's
`api/watchRouter.ts` as `watchedProgramIds(db, userId): string[]`.

## R9 — Program ids: Plan 4's list is canonical; the seed corpus owns identity

Plan 4 declares the canonical program ids and its funder overlays bind to them. Plan 5's seed
renames to match — **not** the other way round:

| Plan 5 seed (wrong) | Canonical (Plan 4) |
|---|---|
| `arrl-foundation-scholarship-program` | `arrl-foundation-scholarships` |
| `ariss-usa-iss-contact` | `ariss-iss-contact` |
| `ieee-mtt-s-chapter-support` | `ieee-mtts-chapter-support` |
| `yaesu-dr-2x-program` | `yaesu-dr2x-repeater` |
| `nasa-space-grant-consortia` | `nasa-space-grant` |

`ardc-grants`, `arrl-amateur-radio-grants`, `arrl-club-grant` already match.
Plan 2 updates `DEADLINE_INHERITANCE` accordingly.

**Reconciliation (the duplicate-every-night bug):** the seed corpus owns program identity.
Each seed record gains `sourceKey: { sourceId, externalKey }`, written into the new
`programs.source_id` / `programs.external_key` columns from R1. Plan 2's `normalizeRaw` resolves
an existing id before minting one:

```ts
const id = ctx.existingIdFor?.(ctx.sourceId, raw.externalKey)
        ?? programIdFor(ctx.sourceId, raw.externalKey);
```

with `existingIdFor?: (sourceId: string, externalKey: string) => string | undefined` added to
Plan 2's plan-local `NormalizeContext` and wired in `runCrawl` to
`SELECT id FROM programs WHERE source_id = ? AND external_key = ?`.

## R10 — `buildUserAgent` has one definition

It lives in `packages/server/src/config.ts` only, widened to accept either form:

```ts
export function buildUserAgent(source: AppConfig | string): string {
  const url = typeof source === 'string' ? source : source.contactUrl;
  if (!url.trim()) throw new Error('CONTACT_URL is required: the crawler User-Agent must name a contact URL.');
  return `GrantSpotter/${SERVER_VERSION} (+${url}; nightly grant-deadline change detector)`;
}
```

Plan 1 widens it and updates its assertion to that exact string. Plan 2 deletes its copy from
`fetcher/index.ts` and imports from `../config.js`.

## R11 — `packages/web` scaffold belongs to Plan 1

Plan 1 Task 18 creates `packages/web/{package.json,tsconfig.json,vite.config.ts,vitest.config.ts,index.html,src/main.tsx,src/App.tsx,src/api/client.ts}`.
Plan 3 **Modifies** all eight — never Creates. Plan 1's pinned versions stand
(`vite 6.4.3`, `@vitejs/plugin-react 4.7.0`, exact non-caret style); Plan 3 adds only
`react-router-dom` and its test deps. Plan 1's `ApiError` signature is canonical:
`(code: ApiErrorCode, message: string, status: number, requestId: string, details?: unknown)`.
Plan 3 defines `apiGet`/`apiSend` as thin wrappers over Plan 1's `apiFetch`, and folds
`packages/web/test/client.test.ts` assertions into `packages/web/src/api/client.test.ts`
before deleting the old file.

## R12 — Deadline recurrence micro-format must actually be emitted

CONTRACT §3 freezes `DeadlineSpec` as `{ kind, source, note }` with no recurrence field, so
Plan 1 Task 5 defines a `RECUR:` micro-format carried inside `DeadlineSpec.note`. **The contract
now blesses this** (see CONTRACT §3 amendment). Neither audit checked it, and it is load-bearing:

> **Plans 2 and 5 MUST emit the `RECUR:` format** for ARDC (Feb 1, Apr 1, Jul 1, Sep 1),
> ARRL Amateur Radio Grants (Feb 1–28, Jun 1–30, Oct 1–31), and ARRL Foundation Scholarships
> (opens ~Oct 30, closes ~Dec 30 12:00 EST), or `expandCycles` returns **no cycles** for them —
> which silently empties the calendar for the three most important programs in the corpus.

Plan 2 emits it in `inferDeadline`; Plan 5 emits it in the seed records. Both add a test
asserting `expandCycles` returns a non-empty result for those three programs.

## R13 — Root npm scripts

Plan 1 deliberately does not create `test:e2e` or `verify-sources` (they would point at files
that do not exist yet). **Plan 2 adds `verify-sources`. Plan 3 adds `test:e2e`.** Both record it
as a CONTRACT §8 deviation in their Global Constraints, as Plan 1 did for `typecheck`.
Plan 2 also records `capture-fixture`; Plan 5 records `seed:arrl`.

## R14 — Plan-local tables must be declared

Plan 2 declares `review_rejects` plan-local (and drops `source_health` per R4).
Plan 5 declares `ics_tokens` plan-local. CONTRACT §6 is amended to list both.

## R15 — Ownership map for the remaining findings

Each fix agent edits **only its own plan file**. Findings whose fix belongs elsewhere are
reassigned here:

| Finding | Owner |
|---|---|
| coverage #2 (user management has no task) | **Plan 3** — add `/api/admin/users` router + `routes/Admin.tsx` (also closes type #16) |
| coverage #3 (sources config / crawl trigger / health roles) | **Plan 3** |
| coverage #7 (Plan 4 and Plan 5 both modify `api/index.ts`) | resolved by **R5**; Plan 3 owns the single mount site |
| type #2, #3 (`review_items`, `snapshots`) | **Plan 1** |
| type #5 (mount hook), #10 (`buildUserAgent` widening) | **Plan 1** |
| type #1 (`programs` shape) | **Plan 1** adds columns; **Plan 2** and **Plan 3** conform |
| type #9, #13 (id drift / reconciliation) | **Plan 5** seeds; **Plan 2** lookup; **Plan 1** columns |
| everything else | the plan named in the finding's `file` field |

---

# Pass 2 — resolutions for problems the fix pass introduced

The re-audit confirmed all 27 original blockers/majors closed with `stillOpen: []`, but found
10 new problems caused by the fixes themselves. Raw list: `${SCRATCH}/reaudit.json`.

## R16 — Nothing serves the SPA (BLOCKER)

`grep -rn "express.static|sendFile|historyApiFallback"` across all five plans returns **zero
hits**. Plan 1 twice delegates the job to Plan 5; Plan 5 never does it. Meanwhile the Dockerfile
COPYs `packages/web/dist` into the runtime image, the container runs one process, compose has one
service, Playwright's `baseURL` points at that server, and every e2e test does `page.goto('/')`.
As written, `GET /` falls through to Plan 1's `notFoundHandler` and returns a JSON 404: **the
entire web application is unreachable and the whole e2e suite fails.**

Canonical fix, split across two plans:

- **Plan 5** adds a task (before its Dockerfile task) creating
  `packages/server/src/api/spa.ts`:

```ts
export function createSpaMiddleware(webDistDir: string): RequestHandler;
```

  Behaviour: `express.static(webDistDir, { index: false })` followed by a history fallback that
  sends `index.html` for any **GET** whose path does not start with `/api` or `/calendar`.
  Everything else falls through untouched so Plan 1's 404 envelope still governs the API.
  Tests: `/` returns HTML; `/browse` returns the same HTML; `/api/unknown` still returns Plan 1's
  JSON 404 envelope; a POST to `/` does not return HTML.

- **Plan 3** adds `a.use(createSpaMiddleware(webDistRoot()));` as the **last statement** of its
  Task 14 `mountRoutes` callback, after `createCalendarFeedRouter`. `webDistRoot()` resolves from
  `import.meta.url` so it works from both `src` and `dist`.

- **Plan 1** updates its comment (the one that says "Plan 5 inserts static SPA serving inside the
  hook too") to name the new Plan 5 task and state that Plan 3 owns the mount line.

## R17 — Plan 4's router symbols in Plan 3's mount hook (BLOCKER)

Plan 3 Task 14 imports `applicationsRouter` / `templatesRouter` / `proseRouter` / `promptsRouter`
and calls them as `({ db })` or `()`. Plan 4 actually exports **`createApplicationsRouter`,
`createTemplatesRouter`, `createProseRouter`, `createPromptsRouter`, each taking the full
`RouterDeps`** (`{db, now, requireAuth, requireAdmin, currentUser}`). Executed literally: four
unresolved imports. "Fixed" by renaming only: every Plan 4 route throws on `deps.currentUser`.

Plan 3 corrects both the imports and the call sites to `create*Router(routerDeps)`. Plan 4's
text is already correct and does not change.

## R18 — The NAV array is append-only

Plan 5 Task 10 Step 8 retypes `NAV` as a full seven-entry array, silently deleting Plan 3's
`{ to: '/admin', … adminOnly: true }` and Plan 4's Templates and Applications entries, and
dropping the `NavItem` type annotation that `AppShell`'s `adminOnly` filter depends on.

**No plan may retype `NAV`.** Plan 5 replaces that block with an insert-one-entry instruction
(`{ to: '/exports', label: 'Exports', end: false },` after Calendar) and corrects its "Plan 3's
NAV has six entries" claim — by the time Plan 5 runs it has nine.

## R19 — `profiles` and `watches` belong to Plan 1

Plan 3 migrations `032-profiles.sql` and `033-watches.sql` `CREATE TABLE IF NOT EXISTS` two
tables Plan 1's `001-init.sql` already created. Migrations run in filename order, so 032/033
silently no-op — and the shapes differ: Plan 1's `watches` has `notify_changes INTEGER NOT NULL
DEFAULT 1` and `ON DELETE CASCADE` foreign keys (with `foreign_keys = ON`), which Plan 3's
version lacks.

Plan 3 deletes both `CREATE TABLE` statements, keeping only the additive indexes, adds
`notify_changes` to its schema-conformance map, corrects its prose claim that it "creates" these
tables, and makes every watch-inserting fixture insert its `programs` row first (otherwise the FK
fires).

## R20 — `sources.enabled` must actually gate the crawler

Plan 3 ships `PATCH /api/sources/:id` writing `enabled` and an admin toggle; Plan 2's `runCrawl`
never reads it. An admin who pauses a source that is 500ing watches the nightly crawl keep
hammering it — which matters when the crawl walks ~25 small-nonprofit sites.

Plan 2 filters disabled sources in `runCrawl` (including when `sourceIds` names one explicitly),
adds `enabled` to `REQUIRED_COLUMNS.sources`, and tests that a disabled source produces no
`last_polled_at` update and no snapshot row.

## R21 — Task cross-references after renumbering

The fix pass inserted tasks into Plan 3 (now 26) and Plan 5 (now 22) and renumbered, but
cross-plan pointers were not updated. These are the pointers an executor follows when a gate
fails, so they must be right:

| In | Currently says | Correct |
|---|---|---|
| Plan 5 (Opportunity.tsx) | Plan 3 Task 18 | **Plan 3 Task 19** |
| Plan 5 (AppShell.tsx / App.tsx) | Plan 3 Task 14 | **Plan 3 Task 15** |
| Plan 5 (Browse.tsx) | Plan 3 Task 16 | **Plan 3 Task 17** |
| Plan 5 (e2e/flow.spec.ts, playwright.config.ts) | Plan 3 Task 24 | **Plan 3 Task 26** |
| Plan 4 (missing-mount pointer) | Plan 3 Task 13 | **Plan 3 Task 14** |
| Plan 4 (api/deps.ts) | Plan 3 Task 2 | **Plan 3 Task 4** |
| Plan 3 (repositories/profiles.ts) | Plan 1 Task 13 | **Plan 1 Task 14** |

Note the mount hook lives in **Plan 3 Task 14** and the AppShell/App.tsx work in **Task 15** —
they are different tasks and the two were being conflated.

## R22 — `createExportDeps` and `req.auth`

Plan 5 Task 9 Step 9 adds `createExportDeps(db, guards, userIdOf)` "for Plan 3's mount hook" and
prints a snippet using `req.session?.userId`. Plan 3 hand-builds `exportDeps` inline using the
correct `req.auth?.id`. There is no express-session in the stack — Plan 1's `attachUser`
populates `req.auth`. Plan 5 deletes `createExportDeps` and replaces its confirmation step with
"confirm Plan 3 Task 14's `mountRoutes` contains `a.use('/api', createExportsRouter(exportDeps))`
and `a.use('/', createCalendarFeedRouter(exportDeps))` with an `exportDeps` satisfying
`ExportDeps`". **`req.auth?.id` is the only correct form; `req.session` appears nowhere.**

## R23 — Two smaller consistency items

- Plan 3's read-contract table still lists **Plan 2** as Owner for `sources`, `snapshots`,
  `change_events`, `review_items`. After R1/R3/R4 Plan 1 owns all four DDLs; Plan 2 only writes
  them. Plan 3 corrects the Owner cells.
- Plan 2's `ensureIngestionSchema` re-declares `idx_snapshots_source` with a different definition
  from Plan 1's. SQLite matches `IF NOT EXISTS` on the **name**, so Plan 2's variant silently
  never exists. Plan 2 drops the duplicate.
- Plan 3 Task 14 builds a second fetcher for `createVerifyRunner` and the manual crawl trigger
  that omits `headersByHost: simplerAuthHeaders()` and `assist: createAiAssist(config)`. An
  admin-triggered crawl would silently behave differently from the identical nightly run. Plan 3
  adds both so the two paths are byte-identical.

---

# Pass 3 — final structural resolutions

The pass-2 gate confirmed 12 items but left R18 and R21 open **in Plan 4** (no Plan 4 agent was
dispatched in pass 2 — a dispatch omission, not a disagreement) and found 4 new problems.

## R24 — `applications` and `template_instances` belong to Plan 1 (BLOCKER)

The same defect R19 fixed for `profiles`/`watches`, repeated. Plan 1's `001-init.sql` creates both
tables; Plan 4's `040-application-writing.sql` re-creates them with a **disjoint column list**
(`program_id` nullable, `answers_json`, `fact_confirmations_json`, `include_disclosure`,
`facts_confirmed_at`, `position`, `filled_markdown`, `unresolved_slots_json`). `IF NOT EXISTS`
makes 040 a silent no-op, so every Plan 4 insert dies on
`table applications has no column named answers_json`. It also re-declares `idx_applications_user`
with a second definition, which SQLite matches by name and never creates.

Plan 4's current mitigation — prose telling the executor to "delete those two CREATE TABLE
statements from Plan 1's migration" — is **worse than the bug**: it would leave Plan 1's
`CREATE INDEX idx_applications_user ON applications(user_id)` in 001 pointing at a table that no
longer exists, so migration 001 fails with `no such table: applications` and nothing boots at all.

Canonical:

- **Plan 1** Task 12's `001-init.sql` is the sole owner and **adopts Plan 4's column list
  verbatim**:
  - `applications(id, user_id, program_id TEXT NULL, title, body_markdown, answers_json,
    fact_confirmations_json, include_disclosure, facts_confirmed_at, created_at, updated_at)`
  - `template_instances(id, application_id REFERENCES applications(id) ON DELETE CASCADE,
    template_id, position, filled_markdown, unresolved_slots_json, created_at)`
  - `idx_applications_user` and `idx_template_instances_application` live here, once.
- **Plan 4** Task 16 deletes both `CREATE TABLE` statements and the duplicate index from
  `040-application-writing.sql`, keeping only `assertApplicationSchema(db)` as an
  **assert-never-create** guard (the shape Plan 2's `ensureIngestionSchema` already models).
  The prose instructing an edit to Plan 1's migration is replaced with "Plan 1 owns these two
  tables."
- Plan 5's `APPLICATIONS_DDL` test fixture already matches this column list and does not change.

## R25 — The mount hook is filled incrementally, not written once (BLOCKER)

Plan 3 Task 14 currently writes `packages/server/src/index.ts` "in its final form", which
forward-references seven modules Plans 4 and 5 create later. That makes Plan 3's own Definition of
Done — `typecheck`, `build`, `test`, `test:e2e` all green from a clean checkout — **unsatisfiable**,
and because `playwright.config.ts`'s `webServer` runs `npm run build && … node packages/server/dist/index.js`,
the build fails, `dist/index.js` is never produced, and all four Playwright specs fail on their
first line.

Canonical: **one hook, filled by each plan in turn.** R5 is preserved — nothing is ever mounted
after `createApp` returns — and no plan forward-references another's module:

| Plan | Adds to the `mountRoutes` callback |
|---|---|
| **3** (Task 14) | Plan 3's routers only, then a comment reserving the final position |
| **4** (Task 17 Step 5) | the four `a.use('/api/…', create*Router(routerDeps))` lines |
| **5** (Task 9 Step 9) | `a.use('/api', createExportsRouter(exportDeps))` and `a.use('/', createCalendarFeedRouter(exportDeps))` |
| **5** (Task 17) | `a.use(createSpaMiddleware(webDistRoot()));` — **last statement, always** |

Plan 4 Task 17 Step 5 changes from "verify the mount" to "add the four lines", and its grep gate
loosens from the literal `createTemplatesRouter(deps)` to `create.*Router(` so it does not
false-fail on Plan 3's `routerDeps` variable name. Plan 3 removes its "unresolved imports for
exactly those seven" caveat and its Definition of Done becomes genuinely achievable.

## R26 — The Inbox decision route must delegate to Plan 2's review pipeline (MAJOR)

Plan 3 Task 12's `POST /api/inbox/:id/decision` re-implements Plan 2 Task 21 instead of calling
it, leaving `approveReviewItem` / `rejectReviewItem` / `editReviewItem` as dead code while
diverging on four behaviours. It is the **only** path a human ever takes, so each divergence is a
real bug:

1. never writes `review_rejects`, so reject memory never suppresses anything — the feature that
   stops the Inbox being abandoned;
2. writes no `audit_log` row, so the provenance trail is empty;
3. calls `programs.upsert(candidate)` with **no sourceKey**, so a newly approved candidate keeps
   `source_id NULL`, `listProgramsBySource` misses it, `diffPrograms` sees an empty `previous`,
   and the record fires `new` every night forever — **the R9 duplicate-every-night bug
   reintroduced through the human path**;
4. upserts the candidate even when the change kind is `vanished`, republishing a program that
   disappeared.

Plan 3's route imports `approveReviewItem`, `rejectReviewItem`, `editReviewItem` from
`../review/index.js` and dispatches on the decision, keeping its own zod validation, `AppError`
envelope, and `reindexBrowse`/`drainChangeEvents` calls after a publish. It adds assertions that a
rejection writes `review_rejects`, an approved `new` event lands `source_id`/`external_key`, an
approved `vanished` event deletes the program, and every decision appends an `audit_log` row.

## R27 — `webDistRoot()` has one home

Defined twice: Plan 3's `packages/server/src/api/webDist.ts` and again inside Plan 5's
`api/spa.ts`. Plan 3 runs first and its `mount.test.ts` already imports from `./webDist.js`, so
**`api/webDist.ts` is the owner**. Plan 5 removes `webDistRoot` from `spa.ts` and from its
Produces list, imports it from `./webDist.js` in `spa.test.ts`, and corrects its instruction to
`import { createSpaMiddleware } from './api/spa.js';`.

## R28 — Plan 4's unapplied pass-2 rows

- **R18**: Plan 4 Task 18 Step 6b still retypes `NAV` as a full eight-entry array, dropping the
  `: NavItem[]` annotation that `AppShell`'s `adminOnly` filter depends on and deleting Plan 3's
  Admin entry. Rewrite it as an insert of exactly two lines after the Watchlist entry, with a
  "do not retype the array" warning and a count grep.
- **R21**: Plan 4's two pointers are wrong — "Plan 3's Task 13" → **Task 14** (Task 13 is
  `/api/admin/users`; the mount site is Task 14), and "Plan 3 Task 2" → **Task 4** at all three
  occurrences (Task 2 is the browse projection; `RouterDeps` comes from Task 4).
