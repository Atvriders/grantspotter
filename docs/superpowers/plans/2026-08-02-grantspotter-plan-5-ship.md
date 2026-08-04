# GrantSpotter Plan 5: Exports, Seed Corpus, and Deploy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every export format (CSV, XLSX, subscribable ICS, DOCX, Markdown, ZIP packet, JSON backup, print-to-PDF) **and the UI that reaches every one of them**, the ~150-record curated seed corpus including the verified negatives, the FAR safety warning and each record's crawler identity, **the middleware that actually serves the built SPA out of the single-process image**, the container image and CI, the full spec §14 end-to-end flow, and then run the completeness and debug audits and perform the single push that ends the project.

**Architecture:** Export modules under `packages/server/src/exports/` are pure functions from domain data (`Program[]`, `Cycle[]`, `Verdict`) to bytes or text — they never touch the database, so they unit-test with hand-built records and zero I/O. A single injected `ExportDataSource` port (plan-local) is the only thing in this plan that knows how rows are read from SQLite, so every route tests against a fake. The seed corpus is JSON validated by `core/schema.ts` at load time, with the 111 ARRL catalog entries generated offline from the committed Plan 2 fixture rather than hand-typed.

**Tech Stack:** TypeScript strict (NodeNext, ES2022) · Node v20.11.0 · Express · better-sqlite3 · Vitest · `exceljs` · `docx` · `fflate` · Docker buildx multi-arch via GitHub Actions → GHCR.

**Prerequisite:** Plans 1, 2, 3 and 4 complete. Specifically this plan consumes, from the frozen CONTRACT: `Program`, `Funder`, `Cycle`, `Constraint`, `Profile`, `Verdict`, `AmountSpec`, `TrustFields`, `Obligations`, `AiPolicy` (types); `matchAll`, `matchProgram`, `expandCycles`, `hashProgram`, `parseAmount` (core functions); the lower-camel zod schemas `programSchema` and `funderSchema` (RESOLUTIONS R7); the factory repositories `createProgramRepo(db)`, `createFunderRepo(db)`, `createProfileRepo(db)` (RESOLUTIONS R8); `AppError` + `errorHandler()` from Plan 1's `api/errors.ts` (RESOLUTIONS R6); `AppDeps.mountRoutes` from Plan 1's `createApp` (RESOLUTIONS R5); `RECURRENCE_PREFIX` / `parseRecurrence` semantics from Plan 1 Task 5 (RESOLUTIONS R12); `assertNotBlocked`, `BLOCKED_HOSTS` (Plan 2 fetcher); `SourceModule`, `FetchedPayload`, `RawOpportunity` and the source-module `(sourceId, externalKey)` pairs (Plan 2 ingestion); `watchedProgramIds(db, userId)` from Plan 3's `api/watchRouter.ts`; `assertExportReady(db, applicationId, userId)` and `getApplication(db, id, userId)` from Plan 4's `db/repositories/applications.ts`; `fillTemplate` → `FilledTemplate { markdown, unresolvedSlots }` (Plan 4).

---

## Global Constraints

- Node **v20.11.0**, npm **10.2.4**. Every shell command in this plan assumes `export PATH="/path/to/node20/bin:$PATH"` has been run in the shell first. Run it once per shell session.
- Repo root is `/path/to/grantspotter`. All paths in this plan are relative to that root unless written absolute.
- TypeScript **strict**, `"module": "NodeNext"`, `"target": "ES2022"`. Relative imports inside `packages/server` therefore carry a `.js` extension (`./csv.js`), even though the source file is `.ts`.
- `packages/core` stays **pure**: no I/O, no `node:` imports, no dependency but `zod`. Nothing in this plan adds code to `packages/core`.
- `SESSION_SECRET` has **no default**. The server refuses to start without it. `CONTACT_URL` likewise. Never add a fallback value anywhere, including `.env.example`.
- The fetcher blocklist is enforced in code, not config: `farweb.org`, `candid.org`, `fconline.foundationcenter.org`, `grantwatch.com`, `grantstation.com`, `instrumentl.com`. **No seed record may contain a URL on a blocked host** — Task 14 ships the test that proves it.
- The AI prompt button copy is exactly `Copy AI Prompt — includes AI-detection avoidance` (Plan 4 owns the button; this plan does not restate it in new UI).
- **No real LAN IPs, hostnames, or host paths** in code, fixtures, seed data, compose files, or the README. Use `127.0.0.1` for loopback and RFC 5737 ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) for examples.
- **Commits stay local.** Every task ends with `git add` + `git commit`. **No task runs `git push`** except Task 23, and Task 23 only pushes after the full verification and both audits pass. Task 23 is the only `git push` in any of the five plans.
- Seed data is **structured facts plus short excerpts only** — never a full-text dump of a funder's page. Facts are not copyrightable; long verbatim descriptions are a different matter.
- Every seed record carries `lastVerifiedAt: "2026-08-02"` and `verificationMethod: "seed_import"` unless this plan says otherwise for a specific record.
- **No headless Chromium in the image.** PDF output is the browser's own "Print / Save as PDF" against a designed `@media print` stylesheet. Bundling Chromium adds roughly 400 MB to the image and its arm64 build is a recurring source of QEMU-emulation build failures; a print stylesheet costs 200 lines and produces a better-looking page.

### Deviation from CONTRACT §8, recorded deliberately

CONTRACT §8 fixes six root npm scripts (`typecheck`, `build`, `test`, `test:e2e`, `verify-sources`, `dev`).
Task 15 adds a seventh, **`npm run seed:arrl`** → `tsx scripts/generate-arrl-seed.ts`. It is a
developer-only regeneration step that reads a committed fixture, touches no network, and is never
part of `build`, `test`, `dev` or CI. It is recorded here for the same reason Plan 1 recorded its
`typecheck` divergence: a script outside the contract must be visible, not discovered.

### Plan-local table, recorded deliberately (RESOLUTIONS R14)

This plan creates exactly one table outside the CONTRACT §6 list as it originally stood:
**`ics_tokens`** (`user_id`, `token_hash`, `created_at`, `revoked_at`), created by
`090-ics-tokens.sql` in Task 9. CONTRACT §6 has since been amended to name it. No other plan
reads or writes it; `exports/json.ts` includes it in the backup table list so a restore keeps
subscribed calendars working.

### Route mounting: this plan fills the last three slots of one shared hook (RESOLUTIONS R5, R25)

Plan 1's `createApp` seals the app with `notFoundHandler()` before returning, so `app.use(...)`
after `createApp` returns is dead code that can never match. There is exactly one mount seam in the
whole application — the `AppDeps.mountRoutes` callback inside `packages/server/src/index.ts` — and
it is **filled incrementally, in plan order** (RESOLUTIONS R25). No plan writes that file in its
final form, and no plan forward-references a module another plan has not created yet:

| Plan | Adds to the `mountRoutes` callback |
|---|---|
| 3 (Task 14) | `mountProductApi(a, routerDeps, verifyRunner, crawl)` — Plan 3's routers only, then a comment reserving the final position |
| 4 (Task 17 Step 5) | the four `a.use('/api/…', create*Router(routerDeps))` lines |
| **5 (Task 9 Step 9)** | `a.use('/api', createExportsRouter(exportDeps));` and `a.use('/', createCalendarFeedRouter(exportDeps));` |
| **5 (Task 17 Step 5)** | `a.use(createSpaMiddleware(webDistRoot()));` — **the last statement, always** |

So this plan writes exactly three `a.use(...)` lines. All three go **inside that callback**, never
on the returned app, and no task in this plan edits `packages/server/src/api/index.ts`. The two
export mounts are inserted above the comment Plan 3 left reserving the final position; the SPA
middleware takes that final position, so real files and the history fallback can never shadow an
`/api` route (RESOLUTIONS R16).

Task 9 exports the `ExportDeps` interface, and Task 9 Step 9 builds the `exportDeps` **value inline
in `index.ts`**. There is no `createExportDeps` factory anywhere in this plan (RESOLUTIONS R22). The
user id in that object is **`req.auth?.id`** — Plan 1's `attachUser` populates `req.auth`, there is
no express-session in this stack, and no express-session `session` property may appear anywhere in
`packages/server/src`. Plan 1's `attachUser` *also* sets **`req.sessionKey`**, which its logout
route reads back to revoke the session row: that is a different, legitimate property and is
explicitly not what this rule forbids, which is why Task 9 Step 9's gate anchors its pattern
(`req\.session\b`) instead of matching the bare prefix.

`webDistRoot()` is **Plan 3's**, exported from `packages/server/src/api/webDist.ts` (RESOLUTIONS
R27). This plan imports it and never defines a second copy; `api/spa.ts` exports only
`createSpaMiddleware`.

### Domain facts an engineer needs before touching the seed data

You do not need to know amateur radio to execute this plan, but the seed records will make no sense without these:

- **Callsign** — a licensed operator's unique identifier (`W8UM`, `K5UTD`). Clubs have them too. They appear in seed records as facts, not as user data.
- **License classes** in the US are `TECH` (Technician, entry level), `GENERAL`, `EXTRA` (highest). `NONE` means the program does not require a license. Many scholarships require a license; a few require it to have been held for a minimum number of months.
- **ARRL** is the American Radio Relay League, the US national association. The **ARRL Foundation** is its charitable arm and administers a catalog of 111 scholarship entries that award 170+ individual scholarships — the single densest source in this space. All 111 share **one** application and **one** deadline, which is why `deadline.source: { kind: 'inherited', fromProgramId: … }` exists (the type is `DeadlineSource`; the field path is `Program.deadline.source`).
- **ARRL Division / Section** are ARRL's own geographic subdivisions of the US. They do not map onto states one-to-one, which is why `data/reference/arrl-sections.json` (Plan 1) exists. A scholarship that says "ARRL Central Division" means Illinois, Indiana and Wisconsin.
- **ARDC** (Amateur Radio Digital Communications) is a foundation that gives roughly $3.4–3.8M/year. It is the largest funder in the space and it *also funds ARRL's* club grants and scholarships — one leg with a splint, not two legs.
- **arrl.org has no ETag and no Last-Modified**, serves `Cache-Control: nocache`, and every `<lastmod>` in its sitemap is frozen at 2010. That is why change detection hashes parsed entries, and why `lastVerifiedAt` is a visible UI state.
- **farweb.org** was the Foundation for Amateur Radio. The domain is compromised: it 301s to `batualam.org`, an Indonesian gambling site (`<title>TARGET88…</title>`), with the takeover pinned by Wayback between 2025-10-17 and 2026-02-10. QCWA, ARRL and club pages still tell applicants to "apply at the FAR website". This is why the domain is blocklisted in the fetcher *and* why the seed ships an explicit warning record: a student searching "FAR" must be told what happened, not sent there.

---

### Task 1: Exports package scaffolding, the export filter, and CSV

**Files:**
- Create: `packages/server/src/exports/filter.ts`
- Create: `packages/server/src/exports/csv.ts`
- Test: `packages/server/src/exports/csv.test.ts`
- Test: `packages/server/src/exports/filter.test.ts`
- Create: `packages/server/src/exports/testFixtures.ts`
- Modify: `packages/server/package.json` (add `exceljs`, `docx`, `fflate` dependencies — all three are used by Tasks 2, 4 and 5; installing them once here keeps the lockfile churn in one commit)

**Interfaces:**
- Consumes: `Program`, `Funder`, `AmountSpec`, `Constraint` from `@grantspotter/core` (CONTRACT §3).
- Produces:
  - `export interface ExportFilter { q?: string; klass?: OpportunityClass[]; status?: ProgramStatus[]; applicantEntities?: ApplicantEntity[]; instrument?: Instrument[]; tags?: string[]; closesAfter?: string; closesBefore?: string }` — **plan-local**, defined in this plan's package. Plan 3 owns the browse-UI filter shape; this one is deliberately separate and named `ExportFilter` so the two never collide.
  - `export function applyExportFilter(programs: Program[], filter: ExportFilter, cyclesByProgramId: Map<string, Cycle[]>): Program[]`
  - `export function parseExportFilter(query: Record<string, unknown>): ExportFilter`
  - `export function toCsv(rows: Array<Record<string, string>>, columns: string[]): string`
  - `export function programsToCsv(programs: Program[], funders: Funder[], cyclesByProgramId: Map<string, Cycle[]>): string`
  - `export const PROGRAM_CSV_COLUMNS: readonly string[]`
  - `export function makeProgram(overrides?: Partial<Program>): Program` and `export function makeFunder(overrides?: Partial<Funder>): Funder` from `testFixtures.ts` — used by every later task in this plan.

- [ ] **Step 1: Install the three export libraries**

```bash
cd /path/to/grantspotter
npm install --workspace @grantspotter/server exceljs@^4.4.0 docx@^9.5.0 fflate@^0.8.2
```

All three ship their own TypeScript types; do not install `@types/*` for them. `fflate` is chosen over `archiver`/`jszip` because its `zipSync`/`unzipSync` are synchronous and deterministic, which makes ZIP tests trivial and lets Task 4 verify a `.docx` by unzipping it.

- [ ] **Step 2: Write the shared test fixture builders**

These are test helpers, not test cases, so they get written before the first failing test. Create `packages/server/src/exports/testFixtures.ts`:

```ts
import type { Program, Funder, Cycle } from '@grantspotter/core';

export function makeFunder(overrides: Partial<Funder> = {}): Funder {
  return {
    id: 'ardc',
    name: 'Amateur Radio Digital Communications',
    homepage: 'https://www.ardc.net/',
    ...overrides,
  };
}

export function makeProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: 'ardc-grants',
    funderId: 'ardc',
    name: 'ARDC Grants Program',
    klass: 'ham_grant',
    summary: 'Grants for amateur radio, digital communication and related education.',
    applicantEntities: ['club_via_fiscal_sponsor', 'school_lea', 'university'],
    amount: {
      instrument: 'cash_range',
      amountMin: 1285,
      amountMax: 258000,
      amountRaw: '$1,285-$258,000 observed in 2026',
      awardCountRaw: 'Multiple per year',
    },
    deadline: {
      kind: 'n_fixed_dates',
      source: { kind: 'self' },
      note: 'February 1, April 1, July 1, September 1.',
    },
    applyVia: 'external_spa_portal',
    applyUrl: 'https://www.ardc.net/apply/',
    constraints: [],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'permitted' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.ardc.net/apply/',
      lastVerifiedAt: '2026-08-02',
      verificationMethod: 'seed_import',
      contentHash: '',
    },
    rawOtherText: '',
    tags: ['ham', 'grant'],
    ...overrides,
  };
}

export function makeCycle(overrides: Partial<Cycle> = {}): Cycle {
  return {
    id: 'ardc-grants-2027-02',
    programId: 'ardc-grants',
    closesAt: '2027-02-01',
    timezone: 'America/Los_Angeles',
    label: 'Feb 2027 deadline',
    isEstimated: false,
    ...overrides,
  };
}
```

- [ ] **Step 3: Write the failing CSV test**

Create `packages/server/src/exports/csv.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toCsv, programsToCsv, PROGRAM_CSV_COLUMNS } from './csv.js';
import { makeProgram, makeFunder, makeCycle } from './testFixtures.js';

describe('toCsv', () => {
  it('emits a CRLF-terminated header row and quotes only what needs quoting', () => {
    const out = toCsv([{ a: 'one', b: 'two' }], ['a', 'b']);
    expect(out).toBe('a,b\r\none,two\r\n');
  });

  it('quotes fields containing a comma, a quote or a newline, doubling inner quotes', () => {
    const out = toCsv([{ a: 'x,y', b: 'he said "hi"', c: 'line1\nline2' }], ['a', 'b', 'c']);
    expect(out).toBe('a,b,c\r\n"x,y","he said ""hi""","line1\nline2"\r\n');
  });

  it('defuses spreadsheet formula injection by prefixing a single quote', () => {
    const out = toCsv([{ a: '=SUM(A1:A9)' }, { a: '+1' }, { a: '-1' }, { a: '@x' }], ['a']);
    expect(out).toBe("a\r\n'=SUM(A1:A9)\r\n'+1\r\n'-1\r\n'@x\r\n");
  });

  it('renders a missing key as an empty field rather than "undefined"', () => {
    const out = toCsv([{ a: 'one' }], ['a', 'b']);
    expect(out).toBe('a,b\r\none,\r\n');
  });
});

describe('programsToCsv', () => {
  it('writes one row per program with the funder name resolved and the next close date', () => {
    const programs = [makeProgram()];
    const funders = [makeFunder()];
    const cycles = new Map([['ardc-grants', [makeCycle()]]]);
    const out = programsToCsv(programs, funders, cycles);
    const lines = out.split('\r\n');
    expect(lines[0]).toBe(PROGRAM_CSV_COLUMNS.join(','));
    expect(lines[1]).toContain('ardc-grants');
    expect(lines[1]).toContain('Amateur Radio Digital Communications');
    expect(lines[1]).toContain('2027-02-01');
    expect(lines[1]).toContain('2026-08-02');
  });

  it('renders an unknown funder id as an empty funder name instead of throwing', () => {
    const out = programsToCsv([makeProgram({ funderId: 'nope' })], [], new Map());
    expect(out.split('\r\n')[1]).toContain('ardc-grants');
  });

  it('flattens list fields with a semicolon so the cell stays one field', () => {
    const out = programsToCsv([makeProgram()], [makeFunder()], new Map());
    expect(out).toContain('club_via_fiscal_sponsor; school_lea; university');
  });
});
```

- [ ] **Step 4: Run the test and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/csv.test.ts
```

Expected failure: `Failed to resolve import "./csv.js"` / `Cannot find module './csv.js'`.

- [ ] **Step 5: Implement `csv.ts`**

Create `packages/server/src/exports/csv.ts`:

```ts
import type { Program, Funder, Cycle } from '@grantspotter/core';

/** Excel and LibreOffice execute a leading =, +, -, @, TAB or CR as a formula. Neutralise it. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

export function escapeCsvField(value: string): string {
  const safe = FORMULA_LEAD.test(value) ? `'${value}` : value;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function toCsv(rows: Array<Record<string, string>>, columns: string[]): string {
  const out: string[] = [columns.map(escapeCsvField).join(',')];
  for (const row of rows) {
    out.push(columns.map((c) => escapeCsvField(row[c] ?? '')).join(','));
  }
  return out.join('\r\n') + '\r\n';
}

export const PROGRAM_CSV_COLUMNS = [
  'id', 'funder', 'name', 'class', 'status', 'applicantEntities', 'instrument',
  'amountMin', 'amountMax', 'amountRaw', 'awardCount', 'deadlineKind', 'nextOpens',
  'nextCloses', 'deadlineNote', 'applyVia', 'applyUrl', 'restrictions',
  'sourceUrl', 'lastVerifiedAt', 'verificationMethod', 'disputed', 'tags',
] as const;

function nextCycle(cycles: Cycle[] | undefined): Cycle | undefined {
  if (!cycles || cycles.length === 0) return undefined;
  return [...cycles].sort((a, b) => (a.closesAt ?? a.opensAt ?? '').localeCompare(b.closesAt ?? b.opensAt ?? ''))[0];
}

export function programToCsvRow(
  program: Program,
  funderName: string,
  cycles: Cycle[] | undefined,
): Record<string, string> {
  const next = nextCycle(cycles);
  return {
    id: program.id,
    funder: funderName,
    name: program.name,
    class: program.klass,
    status: program.trust.status,
    applicantEntities: program.applicantEntities.join('; '),
    instrument: program.amount.instrument,
    amountMin: program.amount.amountMin === undefined ? '' : String(program.amount.amountMin),
    amountMax: program.amount.amountMax === undefined ? '' : String(program.amount.amountMax),
    amountRaw: program.amount.amountRaw,
    awardCount: program.amount.awardCountRaw,
    deadlineKind: program.deadline.kind,
    nextOpens: next?.opensAt ?? '',
    nextCloses: next?.closesAt ?? '',
    deadlineNote: program.deadline.note,
    applyVia: program.applyVia,
    applyUrl: program.applyUrl ?? '',
    restrictions: program.fundingRestrictions.join('; '),
    sourceUrl: program.trust.sourceUrl,
    lastVerifiedAt: program.trust.lastVerifiedAt,
    verificationMethod: program.trust.verificationMethod,
    disputed: program.trust.disputed ? 'yes' : '',
    tags: program.tags.join('; '),
  };
}

export function programsToCsv(
  programs: Program[],
  funders: Funder[],
  cyclesByProgramId: Map<string, Cycle[]>,
): string {
  const funderNames = new Map(funders.map((f) => [f.id, f.name]));
  const rows = programs.map((p) =>
    programToCsvRow(p, funderNames.get(p.funderId) ?? '', cyclesByProgramId.get(p.id)),
  );
  return toCsv(rows, [...PROGRAM_CSV_COLUMNS]);
}
```

- [ ] **Step 6: Run the CSV test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/csv.test.ts
```

Expected: 7 passing tests.

- [ ] **Step 7: Write the failing filter test**

Create `packages/server/src/exports/filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { applyExportFilter, parseExportFilter } from './filter.js';
import { makeProgram, makeCycle } from './testFixtures.js';

const ardc = makeProgram();
const arrl = makeProgram({
  id: 'arrl-club-grant',
  funderId: 'arrl-foundation',
  name: 'ARRL Club Grant Program',
  klass: 'ham_grant',
  applicantEntities: ['club_501c3'],
  tags: ['ham', 'club'],
  trust: { ...ardc.trust, status: 'unknown', sourceUrl: 'https://www.arrl.org/club-grant-program' },
});
const scholarship = makeProgram({
  id: 'arrl-cat-example',
  name: 'Example Memorial Scholarship',
  klass: 'ham_scholarship',
  applicantEntities: ['individual'],
  tags: ['ham', 'scholarship'],
});

describe('applyExportFilter', () => {
  const all = [ardc, arrl, scholarship];
  const cycles = new Map([['ardc-grants', [makeCycle()]]]);

  it('returns everything for an empty filter', () => {
    expect(applyExportFilter(all, {}, cycles)).toHaveLength(3);
  });

  it('matches q case-insensitively across name, summary and tags', () => {
    expect(applyExportFilter(all, { q: 'CLUB' }, cycles).map((p) => p.id)).toEqual(['arrl-club-grant']);
  });

  it('filters by class', () => {
    expect(applyExportFilter(all, { klass: ['ham_scholarship'] }, cycles).map((p) => p.id))
      .toEqual(['arrl-cat-example']);
  });

  it('filters by status', () => {
    expect(applyExportFilter(all, { status: ['unknown'] }, cycles).map((p) => p.id))
      .toEqual(['arrl-club-grant']);
  });

  it('filters by applicant entity with OR semantics inside the axis', () => {
    expect(applyExportFilter(all, { applicantEntities: ['individual', 'club_501c3'] }, cycles).map((p) => p.id))
      .toEqual(['arrl-club-grant', 'arrl-cat-example']);
  });

  it('ANDs across axes', () => {
    expect(applyExportFilter(all, { klass: ['ham_grant'], status: ['unknown'] }, cycles).map((p) => p.id))
      .toEqual(['arrl-club-grant']);
  });

  it('drops programs with no cycle in the requested date window', () => {
    const out = applyExportFilter(all, { closesBefore: '2027-03-01' }, cycles);
    expect(out.map((p) => p.id)).toEqual(['ardc-grants']);
  });
});

describe('parseExportFilter', () => {
  it('splits repeated comma-separated query params and ignores unknown keys', () => {
    const f = parseExportFilter({ q: 'ardc', klass: 'ham_grant,ham_scholarship', bogus: 'x' });
    expect(f).toEqual({ q: 'ardc', klass: ['ham_grant', 'ham_scholarship'] });
  });

  it('accepts array-valued params from express', () => {
    expect(parseExportFilter({ tags: ['ham', 'club'] })).toEqual({ tags: ['ham', 'club'] });
  });

  it('drops values that are not valid enum members', () => {
    expect(parseExportFilter({ klass: 'ham_grant,not_a_class' })).toEqual({ klass: ['ham_grant'] });
  });
});
```

- [ ] **Step 8: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/filter.test.ts
```

Expected failure: `Cannot find module './filter.js'`.

- [ ] **Step 9: Implement `filter.ts`**

Create `packages/server/src/exports/filter.ts`:

```ts
import type {
  Program, Cycle, OpportunityClass, ProgramStatus, ApplicantEntity, Instrument,
} from '@grantspotter/core';

/**
 * PLAN-LOCAL TYPE. The CONTRACT does not define an export filter shape.
 * Plan 3 owns the browse-UI filter; this one is deliberately separate.
 */
export interface ExportFilter {
  q?: string;
  klass?: OpportunityClass[];
  status?: ProgramStatus[];
  applicantEntities?: ApplicantEntity[];
  instrument?: Instrument[];
  tags?: string[];
  closesAfter?: string;   // ISO date, inclusive
  closesBefore?: string;  // ISO date, inclusive
}

const KLASSES: OpportunityClass[] = ['ham_grant', 'ham_scholarship', 'adjacent_stem', 'equipment_in_kind'];
const STATUSES: ProgramStatus[] = ['open', 'closed', 'dormant', 'discontinued', 'contact_only', 'no_application', 'unknown'];
const ENTITIES: ApplicantEntity[] = [
  'individual', 'club_unincorporated', 'club_501c3', 'club_via_fiscal_sponsor',
  'school_lea', 'university', 'university_dept', 'ieee_student_branch_chapter',
  'teacher', 'nominated_by_institution',
];
const INSTRUMENTS: Instrument[] = [
  'cash_range', 'cash_fixed', 'cash_tiered_blocks', 'in_kind_equipment', 'in_kind_service',
  'discounted_purchase', 'per_member_rebate', 'tuition_coverage', 'unknown',
];

function values(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).filter((s) => s.length > 0);
  if (typeof raw === 'string') return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return [];
}

function enumValues<T extends string>(raw: unknown, allowed: T[]): T[] | undefined {
  const picked = values(raw).filter((v): v is T => (allowed as string[]).includes(v));
  return picked.length > 0 ? picked : undefined;
}

export function parseExportFilter(query: Record<string, unknown>): ExportFilter {
  const filter: ExportFilter = {};
  if (typeof query.q === 'string' && query.q.trim().length > 0) filter.q = query.q.trim();
  const klass = enumValues(query.klass, KLASSES);
  if (klass) filter.klass = klass;
  const status = enumValues(query.status, STATUSES);
  if (status) filter.status = status;
  const entities = enumValues(query.applicantEntities, ENTITIES);
  if (entities) filter.applicantEntities = entities;
  const instrument = enumValues(query.instrument, INSTRUMENTS);
  if (instrument) filter.instrument = instrument;
  const tags = values(query.tags);
  if (tags.length > 0) filter.tags = tags;
  if (typeof query.closesAfter === 'string' && query.closesAfter.length > 0) filter.closesAfter = query.closesAfter;
  if (typeof query.closesBefore === 'string' && query.closesBefore.length > 0) filter.closesBefore = query.closesBefore;
  return filter;
}

function matchesText(program: Program, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    program.name.toLowerCase().includes(needle) ||
    program.summary.toLowerCase().includes(needle) ||
    program.id.toLowerCase().includes(needle) ||
    program.tags.some((t) => t.toLowerCase().includes(needle))
  );
}

function inWindow(cycles: Cycle[] | undefined, after?: string, before?: string): boolean {
  if (!after && !before) return true;
  if (!cycles || cycles.length === 0) return false;
  return cycles.some((c) => {
    const date = c.closesAt ?? c.opensAt;
    if (!date) return false;
    const day = date.slice(0, 10);
    if (after && day < after) return false;
    if (before && day > before) return false;
    return true;
  });
}

export function applyExportFilter(
  programs: Program[],
  filter: ExportFilter,
  cyclesByProgramId: Map<string, Cycle[]>,
): Program[] {
  return programs.filter((p) => {
    if (filter.q && !matchesText(p, filter.q)) return false;
    if (filter.klass && !filter.klass.includes(p.klass)) return false;
    if (filter.status && !filter.status.includes(p.trust.status)) return false;
    if (filter.applicantEntities && !p.applicantEntities.some((e) => filter.applicantEntities!.includes(e))) return false;
    if (filter.instrument && !filter.instrument.includes(p.amount.instrument)) return false;
    if (filter.tags && !p.tags.some((t) => filter.tags!.includes(t))) return false;
    if (!inWindow(cyclesByProgramId.get(p.id), filter.closesAfter, filter.closesBefore)) return false;
    return true;
  });
}
```

- [ ] **Step 10: Run both test files and watch them pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/
```

Expected: 17 passing tests across `csv.test.ts` and `filter.test.ts`.

- [ ] **Step 11: Commit**

```bash
cd /path/to/grantspotter
git add packages/server/src/exports packages/server/package.json package-lock.json
git commit -m "feat(exports): CSV writer with RFC 4180 quoting, formula-injection guard, and export filter"
```

---

### Task 2: XLSX export

**Files:**
- Create: `packages/server/src/exports/xlsx.ts`
- Test: `packages/server/src/exports/xlsx.test.ts`

**Interfaces:**
- Consumes: `programToCsvRow`, `PROGRAM_CSV_COLUMNS` from `./csv.js`; `makeProgram`, `makeFunder`, `makeCycle` from `./testFixtures.js`.
- Produces: `export async function programsToXlsx(programs: Program[], funders: Funder[], cyclesByProgramId: Map<string, Cycle[]>): Promise<Buffer>`

Domain note: the XLSX gets a second worksheet named `Provenance`. Every user-facing date in this app renders with its `lastVerifiedAt` provenance (CONTRACT §9); a spreadsheet that a club officer forwards to a faculty advisor has to carry that provenance with it or the honesty surface stops at the browser.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/exports/xlsx.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { programsToXlsx } from './xlsx.js';
import { makeProgram, makeFunder, makeCycle } from './testFixtures.js';

async function readBack(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe('programsToXlsx', () => {
  it('produces a real xlsx (a ZIP container) with Opportunities and Provenance sheets', async () => {
    const buf = await programsToXlsx([makeProgram()], [makeFunder()], new Map([['ardc-grants', [makeCycle()]]]));
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    const wb = await readBack(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Opportunities', 'Provenance']);
  });

  it('writes a header row, freezes it, and writes one data row per program', async () => {
    const buf = await programsToXlsx([makeProgram()], [makeFunder()], new Map());
    const wb = await readBack(buf);
    const sheet = wb.getWorksheet('Opportunities')!;
    expect(sheet.getCell('A1').value).toBe('id');
    expect(sheet.getCell('B1').value).toBe('funder');
    expect(sheet.getCell('A2').value).toBe('ardc-grants');
    expect(sheet.getCell('B2').value).toBe('Amateur Radio Digital Communications');
    expect(sheet.views[0]?.state).toBe('frozen');
    expect(sheet.views[0]?.ySplit).toBe(1);
  });

  it('writes numeric amounts as numbers, not strings, so they sum in the sheet', async () => {
    const buf = await programsToXlsx([makeProgram()], [makeFunder()], new Map());
    const wb = await readBack(buf);
    const sheet = wb.getWorksheet('Opportunities')!;
    const minCol = ['id', 'funder', 'name', 'class', 'status', 'applicantEntities', 'instrument', 'amountMin'].length;
    expect(sheet.getRow(2).getCell(minCol).value).toBe(1285);
  });

  it('carries lastVerifiedAt and the source URL onto the Provenance sheet', async () => {
    const buf = await programsToXlsx([makeProgram()], [makeFunder()], new Map());
    const wb = await readBack(buf);
    const sheet = wb.getWorksheet('Provenance')!;
    expect(sheet.getCell('A1').value).toBe('id');
    expect(sheet.getRow(2).values).toContain('2026-08-02');
    expect(JSON.stringify(sheet.getRow(2).values)).toContain('https://www.ardc.net/apply/');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/xlsx.test.ts
```

Expected failure: `Cannot find module './xlsx.js'`.

- [ ] **Step 3: Implement `xlsx.ts`**

Create `packages/server/src/exports/xlsx.ts`:

```ts
import ExcelJS from 'exceljs';
import type { Program, Funder, Cycle } from '@grantspotter/core';
import { PROGRAM_CSV_COLUMNS, programToCsvRow } from './csv.js';

const NUMERIC_COLUMNS = new Set(['amountMin', 'amountMax']);

const PROVENANCE_COLUMNS = [
  'id', 'name', 'status', 'sourceUrl', 'applyUrl', 'lastVerifiedAt',
  'verificationMethod', 'contentHash', 'disputedClaims', 'staleMirrorWarning',
] as const;

export async function programsToXlsx(
  programs: Program[],
  funders: Funder[],
  cyclesByProgramId: Map<string, Cycle[]>,
): Promise<Buffer> {
  const funderNames = new Map(funders.map((f) => [f.id, f.name]));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GrantSpotter';
  wb.created = new Date(0);

  const main = wb.addWorksheet('Opportunities');
  main.columns = PROGRAM_CSV_COLUMNS.map((key) => ({
    header: key,
    key,
    width: key === 'name' || key === 'deadlineNote' ? 42 : 18,
  }));
  main.getRow(1).font = { bold: true };
  main.views = [{ state: 'frozen', ySplit: 1 }];
  main.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: PROGRAM_CSV_COLUMNS.length } };

  for (const program of programs) {
    const row = programToCsvRow(program, funderNames.get(program.funderId) ?? '', cyclesByProgramId.get(program.id));
    const values: Record<string, string | number> = {};
    for (const key of PROGRAM_CSV_COLUMNS) {
      const raw = row[key] ?? '';
      values[key] = NUMERIC_COLUMNS.has(key) && raw !== '' ? Number(raw) : raw;
    }
    main.addRow(values);
  }

  const prov = wb.addWorksheet('Provenance');
  prov.columns = PROVENANCE_COLUMNS.map((key) => ({ header: key, key, width: key === 'contentHash' ? 68 : 30 }));
  prov.getRow(1).font = { bold: true };
  prov.views = [{ state: 'frozen', ySplit: 1 }];
  for (const program of programs) {
    prov.addRow({
      id: program.id,
      name: program.name,
      status: program.trust.status,
      sourceUrl: program.trust.sourceUrl,
      applyUrl: program.applyUrl ?? '',
      lastVerifiedAt: program.trust.lastVerifiedAt,
      verificationMethod: program.trust.verificationMethod,
      contentHash: program.trust.contentHash,
      disputedClaims: (program.trust.disputed?.claims ?? []).map((c) => `${c.claim} <${c.sourceUrl}>`).join(' | '),
      staleMirrorWarning: program.trust.staleMirrorWarning ?? '',
    });
  }

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/xlsx.test.ts
```

Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
cd /path/to/grantspotter
git add packages/server/src/exports
git commit -m "feat(exports): XLSX workbook with Opportunities and Provenance sheets"
```

---

### Task 3: ICS generation — VEVENT, VTIMEZONE, windows vs single dates

**Files:**
- Create: `packages/server/src/exports/ics.ts`
- Create: `packages/server/src/exports/icsTimezones.ts`
- Test: `packages/server/src/exports/ics.test.ts`

**Interfaces:**
- Consumes: `Program`, `Cycle` from `@grantspotter/core`.
- Produces:
  - `export function foldIcsLine(line: string): string`
  - `export function escapeIcsText(value: string): string`
  - `export function cycleToVevent(cycle: Cycle, program: Program, nowISO: string): string[]`
  - `export interface IcsCalendarInput { calendarName: string; cycles: Cycle[]; programsById: Map<string, Program>; nowISO: string; alarmDaysBefore?: number }` — **plan-local**
  - `export function buildIcsCalendar(input: IcsCalendarInput): string`
  - `export const VTIMEZONE_BLOCKS: Record<string, string>` (from `icsTimezones.ts`)

Domain notes an engineer needs here:

1. **RFC 5545 line folding.** Lines longer than 75 octets must be folded: break, then start the next line with a single space. Calendar clients that do not see folded lines silently truncate. Fold on octets, not characters — a multi-byte UTF-8 character must not be split.
2. **`DTEND` is exclusive for `VALUE=DATE` events.** A window that closes on 2026-08-31 has `DTEND;VALUE=DATE:20260901`. Getting this wrong makes every window render one day short, which for a grant deadline is exactly the failure this app exists to prevent.
3. **`VTIMEZONE` is required** whenever a `DTSTART` carries a `TZID`. We ship static blocks for the seven US zones the corpus uses. The US DST rule has been stable since 2007: DST starts the second Sunday in March at 02:00 local, ends the first Sunday in November at 02:00 local. Arizona and Hawaii do not observe it.
4. **`isEstimated`** means the cycle was projected from a recurrence rule, not observed on the funder's page. Those events must say so in the `SUMMARY` — an estimated date presented as fact is the primary product failure mode (spec §8).

- [ ] **Step 1: Write the timezone data module**

This is data, not logic, so it precedes the failing test. Create `packages/server/src/exports/icsTimezones.ts`:

```ts
/**
 * Static VTIMEZONE blocks for the IANA zones the seed corpus uses.
 * US DST rules have been stable since 2007: start 2nd Sunday in March 02:00,
 * end 1st Sunday in November 02:00. Arizona and Hawaii do not observe DST.
 * Lines are \n-joined here; buildIcsCalendar re-joins the whole document with CRLF.
 */
function usZone(tzid: string, stdOffset: string, dstOffset: string, stdName: string, dstName: string): string {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:DAYLIGHT',
    `TZOFFSETFROM:${stdOffset}`,
    `TZOFFSETTO:${dstOffset}`,
    `TZNAME:${dstName}`,
    'DTSTART:20070311T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
    'END:DAYLIGHT',
    'BEGIN:STANDARD',
    `TZOFFSETFROM:${dstOffset}`,
    `TZOFFSETTO:${stdOffset}`,
    `TZNAME:${stdName}`,
    'DTSTART:20071104T020000',
    'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
    'END:STANDARD',
    'END:VTIMEZONE',
  ].join('\n');
}

function fixedZone(tzid: string, offset: string, name: string): string {
  return [
    'BEGIN:VTIMEZONE',
    `TZID:${tzid}`,
    'BEGIN:STANDARD',
    `TZOFFSETFROM:${offset}`,
    `TZOFFSETTO:${offset}`,
    `TZNAME:${name}`,
    'DTSTART:19700101T000000',
    'END:STANDARD',
    'END:VTIMEZONE',
  ].join('\n');
}

export const VTIMEZONE_BLOCKS: Record<string, string> = {
  'America/New_York': usZone('America/New_York', '-0500', '-0400', 'EST', 'EDT'),
  'America/Chicago': usZone('America/Chicago', '-0600', '-0500', 'CST', 'CDT'),
  'America/Denver': usZone('America/Denver', '-0700', '-0600', 'MST', 'MDT'),
  'America/Los_Angeles': usZone('America/Los_Angeles', '-0800', '-0700', 'PST', 'PDT'),
  'America/Anchorage': usZone('America/Anchorage', '-0900', '-0800', 'AKST', 'AKDT'),
  'America/Phoenix': fixedZone('America/Phoenix', '-0700', 'MST'),
  'Pacific/Honolulu': fixedZone('Pacific/Honolulu', '-1000', 'HST'),
  UTC: fixedZone('UTC', '+0000', 'UTC'),
};
```

- [ ] **Step 2: Write the failing ICS test**

Create `packages/server/src/exports/ics.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildIcsCalendar, cycleToVevent, escapeIcsText, foldIcsLine } from './ics.js';
import { makeProgram, makeCycle } from './testFixtures.js';

const NOW = '2026-08-02T12:00:00.000Z';

describe('foldIcsLine', () => {
  it('leaves a short line alone', () => {
    expect(foldIcsLine('SUMMARY:hi')).toBe('SUMMARY:hi');
  });

  it('folds a long line at 75 octets with a leading space on continuations', () => {
    const folded = foldIcsLine('DESCRIPTION:' + 'a'.repeat(200));
    const lines = folded.split('\r\n');
    expect(lines[0].length).toBe(75);
    expect(lines.slice(1).every((l) => l.startsWith(' '))).toBe(true);
    const unfolded = lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('');
    expect(unfolded).toBe('DESCRIPTION:' + 'a'.repeat(200));
  });

  it('never splits a multi-byte character across a fold', () => {
    const folded = foldIcsLine('SUMMARY:' + '€'.repeat(60));
    for (const line of folded.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(76);
      expect(line.includes('�')).toBe(false);
    }
  });
});

describe('escapeIcsText', () => {
  it('escapes backslash, semicolon, comma and newline', () => {
    expect(escapeIcsText('a\\b;c,d\ne')).toBe('a\\\\b\\;c\\,d\\ne');
  });
});

describe('cycleToVevent', () => {
  it('renders a date-only close as a one-day all-day event with an exclusive DTEND', () => {
    const lines = cycleToVevent(makeCycle({ closesAt: '2027-02-01' }), makeProgram(), NOW);
    expect(lines).toContain('DTSTART;VALUE=DATE:20270201');
    expect(lines).toContain('DTEND;VALUE=DATE:20270202');
  });

  it('renders a window as one all-day event spanning opens..closes with an exclusive DTEND', () => {
    const cycle = makeCycle({ id: 'arrl-arg-2027-02', opensAt: '2027-02-01', closesAt: '2027-02-28' });
    const lines = cycleToVevent(cycle, makeProgram({ name: 'ARRL Amateur Radio Grants' }), NOW);
    expect(lines).toContain('DTSTART;VALUE=DATE:20270201');
    expect(lines).toContain('DTEND;VALUE=DATE:20270301');
    expect(lines.some((l) => l.startsWith('SUMMARY:') && l.includes('window'))).toBe(true);
  });

  it('renders a timed close with a TZID and a one-hour DTEND', () => {
    const cycle = makeCycle({
      id: 'arrl-schol-2026',
      closesAt: '2026-12-30T12:00:00',
      timezone: 'America/New_York',
    });
    const lines = cycleToVevent(cycle, makeProgram(), NOW);
    expect(lines).toContain('DTSTART;TZID=America/New_York:20261230T120000');
    expect(lines).toContain('DTEND;TZID=America/New_York:20261230T130000');
  });

  it('marks estimated cycles in the SUMMARY and with an X- property', () => {
    const lines = cycleToVevent(makeCycle({ isEstimated: true }), makeProgram(), NOW);
    expect(lines.some((l) => l.startsWith('SUMMARY:(estimated)'))).toBe(true);
    expect(lines).toContain('X-GRANTSPOTTER-ESTIMATED:TRUE');
  });

  it('uses a stable UID derived from the cycle id and a DTSTAMP from nowISO', () => {
    const lines = cycleToVevent(makeCycle(), makeProgram(), NOW);
    expect(lines).toContain('UID:ardc-grants-2027-02@grantspotter');
    expect(lines).toContain('DTSTAMP:20260802T120000Z');
  });

  it('puts the amount, status, apply URL and lastVerifiedAt provenance in the DESCRIPTION', () => {
    const lines = cycleToVevent(makeCycle(), makeProgram(), NOW);
    const description = lines.find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(description).toContain('$1\\,285-$258\\,000');
    expect(description).toContain('https://www.ardc.net/apply/');
    expect(description).toContain('last verified 2026-08-02');
  });
});

describe('buildIcsCalendar', () => {
  const program = makeProgram();
  const programsById = new Map([[program.id, program]]);

  it('wraps events in a VCALENDAR with PRODID, VERSION and a refresh interval', () => {
    const ics = buildIcsCalendar({
      calendarName: 'GrantSpotter deadlines',
      cycles: [makeCycle()],
      programsById,
      nowISO: NOW,
    });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect(ics).toContain('PRODID:-//GrantSpotter//GrantSpotter//EN');
    expect(ics).toContain('X-WR-CALNAME:GrantSpotter deadlines');
    expect(ics).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT12H');
  });

  it('emits a VTIMEZONE only for zones actually used by a timed event', () => {
    const ics = buildIcsCalendar({
      calendarName: 'x',
      cycles: [makeCycle({ closesAt: '2026-12-30T12:00:00', timezone: 'America/New_York' })],
      programsById,
      nowISO: NOW,
    });
    expect(ics).toContain('BEGIN:VTIMEZONE');
    expect(ics).toContain('TZID:America/New_York');
    expect(ics).not.toContain('TZID:America/Chicago');
  });

  it('emits no VTIMEZONE when every event is all-day', () => {
    const ics = buildIcsCalendar({ calendarName: 'x', cycles: [makeCycle()], programsById, nowISO: NOW });
    expect(ics).not.toContain('BEGIN:VTIMEZONE');
  });

  it('adds a 14-day VALARM by default and honours an override', () => {
    const ics = buildIcsCalendar({ calendarName: 'x', cycles: [makeCycle()], programsById, nowISO: NOW });
    expect(ics).toContain('TRIGGER:-P14D');
    const ics60 = buildIcsCalendar({
      calendarName: 'x', cycles: [makeCycle()], programsById, nowISO: NOW, alarmDaysBefore: 60,
    });
    expect(ics60).toContain('TRIGGER:-P60D');
  });

  it('skips cycles whose program is missing rather than throwing', () => {
    const ics = buildIcsCalendar({
      calendarName: 'x',
      cycles: [makeCycle({ programId: 'ghost' })],
      programsById,
      nowISO: NOW,
    });
    expect(ics).not.toContain('BEGIN:VEVENT');
  });

  it('uses CRLF everywhere, as RFC 5545 requires', () => {
    const ics = buildIcsCalendar({ calendarName: 'x', cycles: [makeCycle()], programsById, nowISO: NOW });
    expect(ics.split('\n').every((l) => l === '' || l.endsWith('\r'))).toBe(true);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/ics.test.ts
```

Expected failure: `Cannot find module './ics.js'`.

- [ ] **Step 4: Implement `ics.ts`**

Create `packages/server/src/exports/ics.ts`:

```ts
import type { Cycle, Program } from '@grantspotter/core';
import { VTIMEZONE_BLOCKS } from './icsTimezones.js';

const MAX_OCTETS = 75;

export function foldIcsLine(line: string): string {
  if (Buffer.byteLength(line, 'utf8') <= MAX_OCTETS) return line;
  const out: string[] = [];
  let current = '';
  let budget = MAX_OCTETS;
  for (const char of line) {
    const size = Buffer.byteLength(char, 'utf8');
    if (Buffer.byteLength(current, 'utf8') + size > budget) {
      out.push(current);
      current = ' ' + char;      // continuation lines start with one space
      budget = MAX_OCTETS;
    } else {
      current += char;
    }
  }
  if (current.length > 0) out.push(current);
  return out.join('\r\n');
}

export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function isDateOnly(iso: string): boolean {
  return !iso.includes('T');
}

function toIcsDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '');
}

function toIcsLocalDateTime(iso: string): string {
  const [datePart, timePartRaw = '00:00:00'] = iso.split('T');
  const timePart = timePartRaw.replace(/[Zz].*$/, '').split('.')[0];
  const [h = '00', m = '00', s = '00'] = timePart.split(':');
  return `${datePart.replace(/-/g, '')}T${h}${m}${s}`;
}

function toIcsUtcStamp(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** Date-string arithmetic in UTC so a local timezone can never shift the day. */
function addDays(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.slice(0, 10).split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const out = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}`;
}

function addHourLocal(iso: string): string {
  const [datePart, timePartRaw] = iso.split('T');
  const [h = '00', m = '00', s = '00'] = (timePartRaw ?? '00:00:00').replace(/[Zz].*$/, '').split('.')[0].split(':');
  const [y, mo, d] = datePart.split('-').map(Number);
  const t = Date.UTC(y, mo - 1, d, Number(h), Number(m), Number(s)) + 3_600_000;
  const out = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${out.getUTCFullYear()}-${pad(out.getUTCMonth() + 1)}-${pad(out.getUTCDate())}` +
    `T${pad(out.getUTCHours())}:${pad(out.getUTCMinutes())}:${pad(out.getUTCSeconds())}`
  );
}

export function cycleUsesTimezone(cycle: Cycle): boolean {
  const anchor = cycle.closesAt ?? cycle.opensAt;
  return anchor !== undefined && !isDateOnly(anchor);
}

export function cycleToVevent(cycle: Cycle, program: Program, nowISO: string, alarmDaysBefore = 14): string[] {
  const opens = cycle.opensAt;
  const closes = cycle.closesAt;
  const anchor = closes ?? opens;
  if (!anchor) return [];

  const lines: string[] = ['BEGIN:VEVENT'];
  lines.push(`UID:${cycle.id}@grantspotter`);
  lines.push(`DTSTAMP:${toIcsUtcStamp(nowISO)}`);

  const isWindow = Boolean(opens && closes && opens.slice(0, 10) !== closes.slice(0, 10));
  if (isDateOnly(anchor)) {
    const start = isWindow ? opens!.slice(0, 10) : anchor.slice(0, 10);
    const endExclusive = addDays((closes ?? anchor).slice(0, 10), 1);
    lines.push(`DTSTART;VALUE=DATE:${toIcsDate(start)}`);
    lines.push(`DTEND;VALUE=DATE:${toIcsDate(endExclusive)}`);
  } else {
    const tzid = cycle.timezone;
    lines.push(`DTSTART;TZID=${tzid}:${toIcsLocalDateTime(anchor)}`);
    lines.push(`DTEND;TZID=${tzid}:${toIcsLocalDateTime(addHourLocal(anchor))}`);
  }

  const kindWord = isWindow ? 'window' : 'deadline';
  const prefix = cycle.isEstimated ? '(estimated) ' : '';
  lines.push(`SUMMARY:${escapeIcsText(`${prefix}${program.name} ${kindWord} — ${cycle.label}`)}`);

  const descriptionParts = [
    program.summary,
    `Award: ${program.amount.amountRaw} (${program.amount.awardCountRaw})`,
    `Status: ${program.trust.status}`,
    program.applyUrl ? `Apply: ${program.applyUrl}` : `Source: ${program.trust.sourceUrl}`,
    `GrantSpotter: last verified ${program.trust.lastVerifiedAt} via ${program.trust.verificationMethod}.`,
    cycle.isEstimated
      ? 'This date is ESTIMATED from a recurrence rule, not observed on the funder page. Verify before relying on it.'
      : '',
    program.trust.disputed ? `DISPUTED: ${program.trust.disputed.note}` : '',
  ].filter((p) => p.length > 0);
  lines.push(`DESCRIPTION:${escapeIcsText(descriptionParts.join('\n'))}`);

  lines.push(`URL:${program.applyUrl ?? program.trust.sourceUrl}`);
  lines.push(`CATEGORIES:${escapeIcsText(program.klass)}`);
  lines.push('TRANSP:TRANSPARENT');
  if (cycle.isEstimated) lines.push('X-GRANTSPOTTER-ESTIMATED:TRUE');
  lines.push(`X-GRANTSPOTTER-PROGRAM-ID:${program.id}`);

  lines.push('BEGIN:VALARM');
  lines.push('ACTION:DISPLAY');
  lines.push(`TRIGGER:-P${alarmDaysBefore}D`);
  lines.push(`DESCRIPTION:${escapeIcsText(`Start work on ${program.name}`)}`);
  lines.push('END:VALARM');

  lines.push('END:VEVENT');
  return lines;
}

export interface IcsCalendarInput {
  calendarName: string;
  cycles: Cycle[];
  programsById: Map<string, Program>;
  nowISO: string;
  alarmDaysBefore?: number;
}

export function buildIcsCalendar(input: IcsCalendarInput): string {
  const { calendarName, cycles, programsById, nowISO, alarmDaysBefore = 14 } = input;
  const events: string[] = [];
  const zones = new Set<string>();

  for (const cycle of cycles) {
    const program = programsById.get(cycle.programId);
    if (!program) continue;
    const vevent = cycleToVevent(cycle, program, nowISO, alarmDaysBefore);
    if (vevent.length === 0) continue;
    if (cycleUsesTimezone(cycle)) zones.add(cycle.timezone);
    events.push(...vevent);
  }

  const head = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GrantSpotter//GrantSpotter//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    'X-WR-TIMEZONE:America/New_York',
    'REFRESH-INTERVAL;VALUE=DURATION:PT12H',
    'X-PUBLISHED-TTL:PT12H',
  ];

  const tzBlocks: string[] = [];
  for (const zone of [...zones].sort()) {
    const block = VTIMEZONE_BLOCKS[zone];
    if (block) tzBlocks.push(...block.split('\n'));
  }

  const all = [...head, ...tzBlocks, ...events, 'END:VCALENDAR'];
  return all.map(foldIcsLine).join('\r\n') + '\r\n';
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/ics.test.ts
```

Expected: 17 passing tests.

- [ ] **Step 6: Commit**

```bash
cd /path/to/grantspotter
git add packages/server/src/exports
git commit -m "feat(exports): RFC 5545 ICS generation with VTIMEZONE, exclusive DTEND, and estimated-cycle marking"
```

---

### Task 4: DOCX export of an application draft

**Files:**
- Create: `packages/server/src/exports/draft.ts`
- Create: `packages/server/src/exports/docx.ts`
- Test: `packages/server/src/exports/docx.test.ts`

**Interfaces:**
- Consumes: `FilledTemplate { markdown: string; unresolvedSlots: string[] }` from Plan 4's `templates/fill.ts` (CONTRACT §5). This task only consumes the *shape* — it takes a plain markdown string, so it does not import Plan 4 code and does not break if Plan 4's module path moves.
- Produces (all **plan-local** types, declared in `draft.ts` because the CONTRACT does not define a draft document shape):
  - `export type DraftBlock = { kind: 'p'; text: string } | { kind: 'bullet'; items: string[] } | { kind: 'todo'; text: string }`
  - `export interface DraftSection { heading: string; blocks: DraftBlock[] }`
  - `export interface DraftDocument { title: string; subtitle?: string; sections: DraftSection[]; factChecklist: string[]; disclosure?: string; provenanceNote: string }`
  - `export function markdownToDraft(markdown: string, meta: { title: string; subtitle?: string; factChecklist?: string[]; disclosure?: string; provenanceNote: string }): DraftDocument`
  - `export async function draftToDocx(draft: DraftDocument): Promise<Buffer>`
  - `export function draftToMarkdown(draft: DraftDocument): string`

Domain note: `[TODO: …]` markers are load-bearing. Spec §10.1 requires that unknown template slots render as explicit TODOs and **never** as plausible filler, because fabricated specifics are exactly the misconduct pattern NIH/ORI enumerate. In the DOCX they must be visually impossible to miss: bold, red, and highlighted.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/exports/docx.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { markdownToDraft, draftToMarkdown } from './draft.js';
import { draftToDocx } from './docx.js';

const MD = [
  '# Need statement',
  '',
  'The W8UM club station has run on a 1998 transceiver since 2019.',
  '',
  '- Replace the transceiver',
  '- Train 12 new operators',
  '',
  '[TODO: how many members hold a General class licence?]',
  '',
  '# Budget',
  '',
  'One IC-7610 at $2,899.',
].join('\n');

const META = {
  title: 'ARDC Grants Program — draft',
  subtitle: 'University of Michigan Amateur Radio Club (W8UM)',
  factChecklist: ['$2,899 unit price', '12 new operators', '1998 transceiver'],
  disclosure: 'Portions of this application were drafted with the assistance of a large language model; all facts were verified by the applicant.',
  provenanceNote: 'Generated by GrantSpotter on 2026-08-02. Every figure above is the applicant’s responsibility.',
};

describe('markdownToDraft', () => {
  it('splits on level-1 headings and keeps paragraph order', () => {
    const draft = markdownToDraft(MD, META);
    expect(draft.sections.map((s) => s.heading)).toEqual(['Need statement', 'Budget']);
    expect(draft.sections[0].blocks[0]).toEqual({
      kind: 'p',
      text: 'The W8UM club station has run on a 1998 transceiver since 2019.',
    });
  });

  it('groups consecutive dash bullets into one bullet block', () => {
    const draft = markdownToDraft(MD, META);
    expect(draft.sections[0].blocks[1]).toEqual({
      kind: 'bullet',
      items: ['Replace the transceiver', 'Train 12 new operators'],
    });
  });

  it('classifies a [TODO: ...] line as a todo block, not a paragraph', () => {
    const draft = markdownToDraft(MD, META);
    expect(draft.sections[0].blocks[2]).toEqual({
      kind: 'todo',
      text: '[TODO: how many members hold a General class licence?]',
    });
  });

  it('puts content before the first heading into an untitled leading section', () => {
    const draft = markdownToDraft('Intro line.\n\n# Body\n\ntext', META);
    expect(draft.sections[0].heading).toBe('');
    expect(draft.sections[0].blocks[0]).toEqual({ kind: 'p', text: 'Intro line.' });
  });
});

describe('draftToMarkdown', () => {
  it('round-trips headings, bullets and todos', () => {
    const md = draftToMarkdown(markdownToDraft(MD, META));
    expect(md).toContain('# Need statement');
    expect(md).toContain('- Train 12 new operators');
    expect(md).toContain('[TODO: how many members hold a General class licence?]');
    expect(md).toContain('## Fact checklist');
    expect(md).toContain('$2,899 unit price');
  });
});

describe('draftToDocx', () => {
  it('produces a ZIP container holding word/document.xml', async () => {
    const buf = await draftToDocx(markdownToDraft(MD, META));
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    const entries = unzipSync(new Uint8Array(buf));
    expect(Object.keys(entries)).toContain('word/document.xml');
  });

  it('carries the title, headings, bullet text, TODO marker, fact checklist and disclosure', async () => {
    const buf = await draftToDocx(markdownToDraft(MD, META));
    const xml = strFromU8(unzipSync(new Uint8Array(buf))['word/document.xml']);
    expect(xml).toContain('ARDC Grants Program');
    expect(xml).toContain('Need statement');
    expect(xml).toContain('Train 12 new operators');
    expect(xml).toContain('how many members hold a General class licence');
    expect(xml).toContain('Fact checklist');
    expect(xml).toContain('large language model');
    expect(xml).toContain('Generated by GrantSpotter on 2026-08-02');
  });

  it('renders TODO text with a highlight so it cannot be shipped unnoticed', async () => {
    const buf = await draftToDocx(markdownToDraft(MD, META));
    const xml = strFromU8(unzipSync(new Uint8Array(buf))['word/document.xml']);
    expect(xml).toMatch(/<w:highlight w:val="yellow"\/>/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/docx.test.ts
```

Expected failure: `Cannot find module './draft.js'`.

- [ ] **Step 3: Implement `draft.ts`**

Create `packages/server/src/exports/draft.ts`:

```ts
/**
 * PLAN-LOCAL TYPES. The CONTRACT defines no application-draft shape; these live in
 * the exports package and are consumed only by docx.ts and zip.ts.
 */
export type DraftBlock =
  | { kind: 'p'; text: string }
  | { kind: 'bullet'; items: string[] }
  | { kind: 'todo'; text: string };

export interface DraftSection {
  heading: string;
  blocks: DraftBlock[];
}

export interface DraftDocument {
  title: string;
  subtitle?: string;
  sections: DraftSection[];
  factChecklist: string[];
  disclosure?: string;
  provenanceNote: string;
}

export interface DraftMeta {
  title: string;
  subtitle?: string;
  factChecklist?: string[];
  disclosure?: string;
  provenanceNote: string;
}

const TODO_LINE = /^\s*\[TODO:.*\]\s*$/;
const BULLET_LINE = /^\s*[-*]\s+(.*)$/;
const H1_LINE = /^#\s+(.*)$/;
const H2_LINE = /^##\s+(.*)$/;

export function markdownToDraft(markdown: string, meta: DraftMeta): DraftDocument {
  const sections: DraftSection[] = [];
  let current: DraftSection = { heading: '', blocks: [] };
  let paragraph: string[] = [];
  let bullets: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      current.blocks.push({ kind: 'p', text: paragraph.join(' ').trim() });
      paragraph = [];
    }
  };
  const flushBullets = (): void => {
    if (bullets.length > 0) {
      current.blocks.push({ kind: 'bullet', items: bullets });
      bullets = [];
    }
  };
  const flushSection = (): void => {
    flushParagraph();
    flushBullets();
    if (current.heading !== '' || current.blocks.length > 0) sections.push(current);
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    const h1 = H1_LINE.exec(line);
    const h2 = H2_LINE.exec(line);
    if (h1 && !h2) {
      flushSection();
      current = { heading: h1[1].trim(), blocks: [] };
      continue;
    }
    if (h2) {
      flushParagraph();
      flushBullets();
      current.blocks.push({ kind: 'p', text: h2[1].trim() });
      continue;
    }
    if (line.trim() === '') {
      flushParagraph();
      flushBullets();
      continue;
    }
    if (TODO_LINE.test(line)) {
      flushParagraph();
      flushBullets();
      current.blocks.push({ kind: 'todo', text: line.trim() });
      continue;
    }
    const bullet = BULLET_LINE.exec(line);
    if (bullet) {
      flushParagraph();
      bullets.push(bullet[1].trim());
      continue;
    }
    flushBullets();
    paragraph.push(line.trim());
  }
  flushSection();

  return {
    title: meta.title,
    subtitle: meta.subtitle,
    sections,
    factChecklist: meta.factChecklist ?? [],
    disclosure: meta.disclosure,
    provenanceNote: meta.provenanceNote,
  };
}

export function draftToMarkdown(draft: DraftDocument): string {
  const out: string[] = [`# ${draft.title}`, ''];
  if (draft.subtitle) out.push(draft.subtitle, '');
  for (const section of draft.sections) {
    if (section.heading) out.push(`# ${section.heading}`, '');
    for (const block of section.blocks) {
      if (block.kind === 'p') out.push(block.text, '');
      else if (block.kind === 'todo') out.push(block.text, '');
      else out.push(...block.items.map((i) => `- ${i}`), '');
    }
  }
  if (draft.factChecklist.length > 0) {
    out.push('## Fact checklist', '');
    out.push('Every item below is the applicant’s responsibility to verify before submission.', '');
    out.push(...draft.factChecklist.map((f) => `- [ ] ${f}`), '');
  }
  if (draft.disclosure) out.push('## AI-use disclosure', '', draft.disclosure, '');
  out.push('---', '', draft.provenanceNote, '');
  return out.join('\n');
}
```

- [ ] **Step 4: Implement `docx.ts`**

Create `packages/server/src/exports/docx.ts`:

```ts
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import type { DraftDocument } from './draft.js';

function todoParagraph(text: string): Paragraph {
  return new Paragraph({
    children: [
      new TextRun({ text, bold: true, color: 'B00020', highlight: 'yellow' }),
    ],
  });
}

export async function draftToDocx(draft: DraftDocument): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({ text: draft.title, heading: HeadingLevel.TITLE }),
  ];
  if (draft.subtitle) {
    children.push(new Paragraph({ children: [new TextRun({ text: draft.subtitle, italics: true })] }));
  }

  for (const section of draft.sections) {
    if (section.heading) {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    }
    for (const block of section.blocks) {
      if (block.kind === 'p') {
        children.push(new Paragraph({ children: [new TextRun(block.text)] }));
      } else if (block.kind === 'todo') {
        children.push(todoParagraph(block.text));
      } else {
        for (const item of block.items) {
          children.push(new Paragraph({ text: item, bullet: { level: 0 } }));
        }
      }
    }
  }

  if (draft.factChecklist.length > 0) {
    children.push(new Paragraph({ text: 'Fact checklist', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({
      children: [new TextRun({
        text: 'Every funder policy reviewed makes the human applicant, never the tool, accountable for each number, claim and citation below. Confirm every one before submitting.',
        italics: true,
      })],
    }));
    for (const fact of draft.factChecklist) {
      children.push(new Paragraph({ text: `☐ ${fact}`, bullet: { level: 0 } }));
    }
  }

  if (draft.disclosure) {
    children.push(new Paragraph({ text: 'AI-use disclosure', heading: HeadingLevel.HEADING_1 }));
    children.push(new Paragraph({ children: [new TextRun(draft.disclosure)] }));
  }

  children.push(new Paragraph({
    alignment: AlignmentType.LEFT,
    children: [new TextRun({ text: draft.provenanceNote, size: 18, color: '555555' })],
  }));

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/docx.test.ts
```

Expected: 8 passing tests. If the `docx` named imports fail to resolve at runtime under NodeNext ESM, switch the import line to `import * as docxLib from 'docx';` plus `const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = docxLib;` — the namespace form resolves under both CJS and ESM.

- [ ] **Step 6: Commit**

```bash
cd /path/to/grantspotter
git add packages/server/src/exports
git commit -m "feat(exports): DOCX application draft via the docx library, with highlighted TODO markers"
```

---

### Task 5: Application packet ZIP — draft, budget worksheet, requirements checklist, source links

**Files:**
- Create: `packages/server/src/exports/packet.ts`
- Create: `packages/server/src/exports/zip.ts`
- Test: `packages/server/src/exports/zip.test.ts`

**Interfaces:**
- Consumes: `DraftDocument`, `draftToMarkdown` from `./draft.js`; `draftToDocx` from `./docx.js`; `toCsv` from `./csv.js`; `Program`, `Funder` from `@grantspotter/core`.
- Produces:
  - `export interface BudgetLine { item: string; category: string; quantity: number; unitCost: number; justification: string; quoteSource: string }` — **plan-local**
  - `export function budgetWorksheetCsv(lines: BudgetLine[], program: Program): string`
  - `export function requirementsChecklistMarkdown(program: Program, funder: Funder | undefined): string`
  - `export function sourceLinksMarkdown(program: Program, funder: Funder | undefined): string`
  - `export interface PacketInput { program: Program; funder?: Funder; draft: DraftDocument; budgetLines: BudgetLine[]; generatedAtISO: string }` — **plan-local**
  - `export async function buildApplicationPacket(input: PacketInput): Promise<Uint8Array>`

Domain notes:
- **ARDC caps indirect costs at 20%** and requires that all funded output be open-source/open-access. Those two are the requirements applicants most often miss, so the budget worksheet computes the indirect cap explicitly whenever `obligations.indirectCostCapPct` is set.
- **ARRL's grants exclude emergency-communications equipment and ongoing operating expenses**, and ARRL prefers not to be the sole funder. Those live in `fundingRestrictions[]` and `obligations.coFunderPreference` and must appear in the checklist.
- Constraints marked `hard: false` **rank, they never exclude** — the checklist must present them as "preference", not as a requirement, or the packet will scare off an eligible applicant.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/exports/zip.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { buildApplicationPacket, budgetWorksheetCsv, requirementsChecklistMarkdown, sourceLinksMarkdown } from './zip.js';
import type { BudgetLine } from './packet.js';
import { markdownToDraft } from './draft.js';
import { makeProgram, makeFunder } from './testFixtures.js';

const LINES: BudgetLine[] = [
  { item: 'IC-7610 transceiver', category: 'Equipment', quantity: 1, unitCost: 2899, justification: 'Replaces a 1998 radio', quoteSource: 'https://www.example.org/quote-2026-07' },
  { item: 'Coaxial cable, 200 ft', category: 'Materials', quantity: 2, unitCost: 145.5, justification: 'Feedline replacement', quoteSource: 'https://www.example.org/quote-2026-07' },
];

const PROGRAM = makeProgram({
  fundingRestrictions: ['No emergency-communications equipment', 'No ongoing operating expenses'],
  obligations: {
    costShareRequired: false,
    coFunderPreference: true,
    indirectCostCapPct: 20,
    licenseObligation: 'All output must be open-source or open-access (GPL, MIT, BSD, CERN-OHL or CC).',
  },
  constraints: [
    { id: 'c-hard-entity', hard: true, fallbackRank: 0, rawText: 'Applicant must be a US 501(c)(3), government body, school or university.', spec: { axis: 'other', note: 'US 501(c)(3), government, school or university' } },
    { id: 'c-soft-gpa', hard: false, fallbackRank: 0, rawText: 'Preference is given to applicants with a GPA over 3.5.', spec: { axis: 'gpa', min: 3.5 } },
  ],
});

describe('budgetWorksheetCsv', () => {
  it('computes line totals and a grand total', () => {
    const csv = budgetWorksheetCsv(LINES, PROGRAM);
    expect(csv).toContain('IC-7610 transceiver');
    expect(csv).toContain('2899');
    expect(csv).toContain('291'); // 2 x 145.50
    expect(csv).toContain('TOTAL');
    expect(csv).toContain('3190');
  });

  it('adds an indirect-cost cap row when the funder caps indirect costs', () => {
    const csv = budgetWorksheetCsv(LINES, PROGRAM);
    expect(csv).toContain('Indirect cost cap (20%)');
    expect(csv).toContain('638'); // 20% of 3190
  });

  it('omits the indirect row when the funder sets no cap', () => {
    const csv = budgetWorksheetCsv(LINES, makeProgram());
    expect(csv).not.toContain('Indirect cost cap');
  });
});

describe('requirementsChecklistMarkdown', () => {
  const md = requirementsChecklistMarkdown(PROGRAM, makeFunder());

  it('separates hard requirements from preferences and never calls a preference a requirement', () => {
    const hardIdx = md.indexOf('## Requirements (must be true)');
    const softIdx = md.indexOf('## Preferences (these rank you, they never exclude you)');
    expect(hardIdx).toBeGreaterThan(-1);
    expect(softIdx).toBeGreaterThan(hardIdx);
    expect(md.slice(hardIdx, softIdx)).toContain('US 501(c)(3)');
    expect(md.slice(softIdx)).toContain('GPA over 3.5');
  });

  it('lists funding restrictions and obligations as checkboxes', () => {
    expect(md).toContain('- [ ] No emergency-communications equipment');
    expect(md).toContain('- [ ] No ongoing operating expenses');
    expect(md).toContain('open-source or open-access');
    expect(md).toContain('Indirect costs capped at 20%');
    expect(md).toContain('prefers not to be the sole funder');
  });

  it('states how to apply and the last-verified provenance', () => {
    expect(md).toContain('external_spa_portal');
    expect(md).toContain('https://www.ardc.net/apply/');
    expect(md).toContain('last verified 2026-08-02');
  });
});

describe('sourceLinksMarkdown', () => {
  it('links the funder homepage, the source URL and the apply URL', () => {
    const md = sourceLinksMarkdown(PROGRAM, makeFunder());
    expect(md).toContain('https://www.ardc.net/');
    expect(md).toContain('https://www.ardc.net/apply/');
  });

  it('renders a disputed block when the record carries one', () => {
    const disputed = makeProgram({
      trust: {
        ...PROGRAM.trust,
        disputed: {
          note: 'Three researchers reached three different conclusions about this cycle.',
          claims: [
            { claim: 'Dormant; no open cycle published', sourceUrl: 'https://www.arrl.org/club-grant-program' },
            { claim: 'Autumn window, historically Sep 7 to Nov 4', sourceUrl: 'https://www.arrl.org/news' },
          ],
        },
      },
    });
    const md = sourceLinksMarkdown(disputed, undefined);
    expect(md).toContain('## Disputed');
    expect(md).toContain('Three researchers');
    expect(md).toContain('Autumn window');
  });
});

describe('buildApplicationPacket', () => {
  it('contains exactly the six packet entries', async () => {
    const draft = markdownToDraft('# Need statement\n\nText.', {
      title: 'Draft', provenanceNote: 'Generated by GrantSpotter on 2026-08-02.',
    });
    const zip = await buildApplicationPacket({
      program: PROGRAM, funder: makeFunder(), draft, budgetLines: LINES, generatedAtISO: '2026-08-02T12:00:00.000Z',
    });
    const entries = unzipSync(zip);
    expect(Object.keys(entries).sort()).toEqual([
      'README.txt', 'budget-worksheet.csv', 'draft.docx', 'draft.md',
      'requirements-checklist.md', 'source-links.md',
    ]);
    expect(strFromU8(entries['README.txt'])).toContain('ARDC Grants Program');
    expect(strFromU8(entries['draft.md'])).toContain('# Need statement');
    expect(entries['draft.docx'].subarray(0, 2)).toEqual(new Uint8Array([0x50, 0x4b]));
  });

  it('is byte-identical across two runs with the same input', async () => {
    const draft = markdownToDraft('# A\n\nB', { title: 'Draft', provenanceNote: 'note' });
    const input = { program: PROGRAM, funder: makeFunder(), draft, budgetLines: LINES, generatedAtISO: '2026-08-02T12:00:00.000Z' };
    const a = await buildApplicationPacket(input);
    const b = await buildApplicationPacket(input);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/zip.test.ts
```

Expected failure: `Cannot find module './zip.js'`.

- [ ] **Step 3: Implement `packet.ts` (the plan-local input types)**

Create `packages/server/src/exports/packet.ts`:

```ts
import type { Program, Funder } from '@grantspotter/core';
import type { DraftDocument } from './draft.js';

/** PLAN-LOCAL. The CONTRACT defines no budget shape. */
export interface BudgetLine {
  item: string;
  category: string;
  quantity: number;
  unitCost: number;
  justification: string;
  quoteSource: string;
}

/** PLAN-LOCAL. */
export interface PacketInput {
  program: Program;
  funder?: Funder;
  draft: DraftDocument;
  budgetLines: BudgetLine[];
  generatedAtISO: string;
}
```

- [ ] **Step 4: Implement `zip.ts`**

Create `packages/server/src/exports/zip.ts`:

```ts
import { zipSync, strToU8 } from 'fflate';
import type { Program, Funder } from '@grantspotter/core';
import { toCsv } from './csv.js';
import { draftToMarkdown } from './draft.js';
import { draftToDocx } from './docx.js';
import type { BudgetLine, PacketInput } from './packet.js';

export type { BudgetLine, PacketInput } from './packet.js';

const BUDGET_COLUMNS = ['item', 'category', 'quantity', 'unitCost', 'lineTotal', 'justification', 'quoteSource'];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function budgetWorksheetCsv(lines: BudgetLine[], program: Program): string {
  const rows: Array<Record<string, string>> = lines.map((l) => ({
    item: l.item,
    category: l.category,
    quantity: String(l.quantity),
    unitCost: String(round2(l.unitCost)),
    lineTotal: String(round2(l.quantity * l.unitCost)),
    justification: l.justification,
    quoteSource: l.quoteSource,
  }));
  const total = round2(lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0));
  rows.push({ item: 'TOTAL', category: '', quantity: '', unitCost: '', lineTotal: String(total), justification: '', quoteSource: '' });

  const cap = program.obligations.indirectCostCapPct;
  if (cap !== undefined) {
    rows.push({
      item: `Indirect cost cap (${cap}%)`,
      category: 'Indirect',
      quantity: '',
      unitCost: '',
      lineTotal: String(round2((total * cap) / 100)),
      justification: `${program.name} caps indirect costs at ${cap}% of direct costs. Anything above this line is not reimbursable.`,
      quoteSource: program.trust.sourceUrl,
    });
  }
  return toCsv(rows, BUDGET_COLUMNS);
}

export function requirementsChecklistMarkdown(program: Program, funder: Funder | undefined): string {
  const hard = program.constraints.filter((c) => c.hard);
  const soft = [...program.constraints.filter((c) => !c.hard)].sort((a, b) => a.fallbackRank - b.fallbackRank);
  const out: string[] = [
    `# Requirements checklist — ${program.name}`,
    '',
    funder ? `Funder: ${funder.name}` : '',
    `Status: ${program.trust.status}. Source: ${program.trust.sourceUrl} (last verified ${program.trust.lastVerifiedAt}, ${program.trust.verificationMethod}).`,
    '',
    '## Requirements (must be true)',
    '',
  ];
  out.push(...(hard.length > 0
    ? hard.map((c) => `- [ ] ${c.rawText}`)
    : ['- [ ] No hard eligibility requirement was recorded for this program. Read the source page before applying.']));
  out.push('', '## Preferences (these rank you, they never exclude you)', '');
  out.push(...(soft.length > 0
    ? soft.map((c) => `- [ ] (rank ${c.fallbackRank}) ${c.rawText}`)
    : ['- No preferences recorded.']));

  out.push('', '## Funding restrictions', '');
  out.push(...(program.fundingRestrictions.length > 0
    ? program.fundingRestrictions.map((r) => `- [ ] ${r}`)
    : ['- None recorded.']));

  out.push('', '## Obligations if funded', '');
  const ob = program.obligations;
  if (ob.licenseObligation) out.push(`- [ ] ${ob.licenseObligation}`);
  if (ob.indirectCostCapPct !== undefined) out.push(`- [ ] Indirect costs capped at ${ob.indirectCostCapPct}% of direct costs.`);
  if (ob.costShareRequired) out.push('- [ ] Cost share or matching funds are required.');
  if (ob.coFunderPreference) out.push('- [ ] This funder prefers not to be the sole funder. Name your other funding sources.');
  if (ob.sustainmentObligation) out.push(`- [ ] ${ob.sustainmentObligation}`);
  if (ob.reportingObligation) out.push(`- [ ] ${ob.reportingObligation}`);
  if (!ob.licenseObligation && ob.indirectCostCapPct === undefined && !ob.costShareRequired &&
      !ob.coFunderPreference && !ob.sustainmentObligation && !ob.reportingObligation) {
    out.push('- None recorded.');
  }

  out.push('', '## How to apply', '');
  out.push(`- Method: ${program.applyVia}`);
  if (program.applyUrl) out.push(`- Apply at: ${program.applyUrl}`);
  if (program.applyContact) out.push(`- Contact: ${program.applyContact}`);
  out.push(`- Deadline pattern: ${program.deadline.kind}. ${program.deadline.note}`);
  if (program.rawOtherText.trim().length > 0) {
    out.push('', '## Long-tail requirements, verbatim from the source', '', '> ' + program.rawOtherText.replace(/\n/g, '\n> '));
  }
  out.push('', `_GrantSpotter records facts, not promises. Confirm every line above against ${program.trust.sourceUrl} before you submit._`, '');
  return out.filter((l) => l !== undefined).join('\n');
}

export function sourceLinksMarkdown(program: Program, funder: Funder | undefined): string {
  const out: string[] = [`# Sources — ${program.name}`, ''];
  if (funder) out.push(`- Funder: [${funder.name}](${funder.homepage})`);
  out.push(`- Program source: ${program.trust.sourceUrl}`);
  if (program.applyUrl) out.push(`- Application: ${program.applyUrl}`);
  if (program.aiPolicy.url) out.push(`- AI policy: ${program.aiPolicy.url}`);
  out.push(`- Last verified: ${program.trust.lastVerifiedAt} (${program.trust.verificationMethod})`);
  out.push(`- Content hash at verification: ${program.trust.contentHash || 'not computed'}`);
  if (program.aiPolicy.quote) {
    out.push('', '## Funder AI policy, verbatim', '', `> ${program.aiPolicy.quote}`, '', `Stance recorded as: ${program.aiPolicy.stance}.`);
  }
  if (program.trust.staleMirrorWarning) {
    out.push('', '## Stale-mirror warning', '', program.trust.staleMirrorWarning);
  }
  if (program.trust.disputed) {
    out.push('', '## Disputed', '', program.trust.disputed.note, '');
    out.push(...program.trust.disputed.claims.map((c) => `- ${c.claim} — ${c.sourceUrl}`));
  }
  out.push('');
  return out.join('\n');
}

function readmeText(input: PacketInput): string {
  const { program, funder, generatedAtISO } = input;
  return [
    `GrantSpotter application packet`,
    `Program: ${program.name}`,
    funder ? `Funder: ${funder.name}` : '',
    `Generated: ${generatedAtISO}`,
    '',
    'Contents',
    '  draft.md                  the application draft in markdown',
    '  draft.docx                the same draft as a Word document',
    '  budget-worksheet.csv      line items, totals and any indirect-cost cap',
    '  requirements-checklist.md hard requirements, preferences, restrictions, obligations',
    '  source-links.md           every source URL, the AI policy and any disputed reading',
    '',
    'GrantSpotter did not write your application and does not vouch for any figure in it.',
    `Every fact in this packet traces back to ${program.trust.sourceUrl}, last verified ${program.trust.lastVerifiedAt}.`,
    'Verify each one before you submit.',
    '',
  ].filter((l) => l !== '').join('\n');
}

export async function buildApplicationPacket(input: PacketInput): Promise<Uint8Array> {
  const docx = await draftToDocx(input.draft);
  const files: Record<string, Uint8Array> = {
    'README.txt': strToU8(readmeText(input)),
    'draft.md': strToU8(draftToMarkdown(input.draft)),
    'draft.docx': new Uint8Array(docx),
    'budget-worksheet.csv': strToU8(budgetWorksheetCsv(input.budgetLines, input.program)),
    'requirements-checklist.md': strToU8(requirementsChecklistMarkdown(input.program, input.funder)),
    'source-links.md': strToU8(sourceLinksMarkdown(input.program, input.funder)),
  };
  // mtime 0 keeps the archive byte-stable for the same input, which makes the packet diffable.
  return zipSync(files, { level: 6, mtime: 0 });
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/zip.test.ts
```

Expected: 9 passing tests. If the byte-stability test fails, confirm `mtime: 0` is passed to `zipSync` and that `draftToDocx` is not embedding a wall-clock timestamp (the `docx` library writes a fixed `created` date unless one is supplied).

- [ ] **Step 6: Commit**

```bash
cd /path/to/grantspotter
git add packages/server/src/exports
git commit -m "feat(exports): application packet ZIP with budget worksheet, requirements checklist and source links"
```

---

### Task 6: Full JSON backup and restore (admin only)

**Files:**
- Create: `packages/server/src/exports/json.ts`
- Test: `packages/server/src/exports/json.test.ts`

**Interfaces:**
- Consumes: `better-sqlite3` (already a Plan 1 dependency).
- Produces:
  - `export const BACKUP_FORMAT_VERSION = 1`
  - `export const BACKUP_TABLES: readonly string[]` — the CONTRACT §6 table list minus `sessions`
  - `export interface BackupFile { app: 'grantspotter'; formatVersion: number; exportedAt: string; tables: Record<string, Array<Record<string, unknown>>> }` — **plan-local**
  - `export function exportBackup(db: Database, nowISO: string): BackupFile`
  - `export function restoreBackup(db: Database, raw: unknown): { tablesRestored: string[]; rowsRestored: number }`

Design note worth stating out loud: this module is **schema-agnostic by design**. It reads the table list from CONTRACT §6, intersects it with `sqlite_master`, and dumps `SELECT *`, discovering columns with `PRAGMA table_info`. That means Plan 1 can add or rename a column without touching this file, and a backup taken today restores into tomorrow's schema for every column the two have in common. `sessions` is excluded deliberately: restoring live session rows would resurrect logged-in sessions from a backup, which is a security hazard and has no user value.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/exports/json.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { exportBackup, restoreBackup, BACKUP_FORMAT_VERSION } from './json.js';

function makeDb(): Db {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE funders (id TEXT PRIMARY KEY, name TEXT NOT NULL, homepage TEXT);
    CREATE TABLE programs (id TEXT PRIMARY KEY, funder_id TEXT NOT NULL, name TEXT, amount TEXT, blob_col BLOB);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT);
    CREATE TABLE not_in_contract (id TEXT PRIMARY KEY);
  `);
  db.prepare('INSERT INTO funders VALUES (?,?,?)').run('ardc', 'Amateur Radio Digital Communications', 'https://www.ardc.net/');
  db.prepare('INSERT INTO programs VALUES (?,?,?,?,?)').run(
    'ardc-grants', 'ardc', 'ARDC Grants Program', '{"instrument":"cash_range"}', Buffer.from([1, 2, 3]),
  );
  db.prepare('INSERT INTO sessions VALUES (?,?)').run('sess-1', 'user-1');
  db.prepare('INSERT INTO not_in_contract VALUES (?)').run('x');
  return db;
}

describe('exportBackup', () => {
  let db: Db;
  beforeEach(() => { db = makeDb(); });

  it('stamps the app name, format version and export time', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    expect(backup.app).toBe('grantspotter');
    expect(backup.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(backup.exportedAt).toBe('2026-08-02T12:00:00.000Z');
  });

  it('dumps every contract table that exists and skips ones that do not', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    expect(Object.keys(backup.tables).sort()).toEqual(['funders', 'programs']);
    expect(backup.tables.funders).toHaveLength(1);
    expect(backup.tables.funders[0]).toMatchObject({ id: 'ardc' });
  });

  it('never exports sessions, and never exports a table outside the contract list', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    expect(backup.tables.sessions).toBeUndefined();
    expect(backup.tables.not_in_contract).toBeUndefined();
  });

  it('encodes BLOB columns as base64 envelopes so JSON round-trips them', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    expect(backup.tables.programs[0].blob_col).toEqual({ $b64: 'AQID' });
  });

  it('survives a JSON round trip', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    expect(() => JSON.parse(JSON.stringify(backup))).not.toThrow();
  });
});

describe('restoreBackup', () => {
  let db: Db;
  beforeEach(() => { db = makeDb(); });

  it('replaces existing rows and reports what it restored', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    backup.tables.funders = [{ id: 'arrl-foundation', name: 'ARRL Foundation', homepage: 'https://www.arrl.org/arrl-foundation' }];
    const result = restoreBackup(db, JSON.parse(JSON.stringify(backup)));
    expect(result.tablesRestored).toEqual(['funders', 'programs']);
    expect(result.rowsRestored).toBe(2);
    const rows = db.prepare('SELECT id FROM funders').all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['arrl-foundation']);
  });

  it('decodes base64 envelopes back into buffers', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    restoreBackup(db, JSON.parse(JSON.stringify(backup)));
    const row = db.prepare('SELECT blob_col FROM programs').get() as { blob_col: Buffer };
    expect(Buffer.from(row.blob_col).equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it('ignores columns in the file that no longer exist in the schema', () => {
    const backup = exportBackup(db, '2026-08-02T12:00:00.000Z');
    backup.tables.funders[0].removed_column = 'gone';
    expect(() => restoreBackup(db, JSON.parse(JSON.stringify(backup)))).not.toThrow();
  });

  it('rejects a file with the wrong app marker or an unknown format version', () => {
    expect(() => restoreBackup(db, { app: 'other', formatVersion: 1, exportedAt: '', tables: {} }))
      .toThrow(/not a GrantSpotter backup/);
    expect(() => restoreBackup(db, { app: 'grantspotter', formatVersion: 99, exportedAt: '', tables: {} }))
      .toThrow(/format version 99/);
  });

  it('refuses a file naming a table outside the contract list', () => {
    expect(() => restoreBackup(db, {
      app: 'grantspotter', formatVersion: 1, exportedAt: '', tables: { evil: [{ id: 'x' }] },
    })).toThrow(/unknown table "evil"/);
  });

  it('leaves the database untouched when one table fails mid-restore', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM funders').get() as { n: number };
    expect(() => restoreBackup(db, {
      app: 'grantspotter', formatVersion: 1, exportedAt: '',
      tables: { funders: [{ id: 'ok', name: 'ok', homepage: 'x' }], programs: [{ id: null, funder_id: null }] },
    })).toThrow();
    const after = db.prepare('SELECT COUNT(*) AS n FROM funders').get() as { n: number };
    expect(after.n).toBe(before.n);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/json.test.ts
```

Expected failure: `Cannot find module './json.js'`.

- [ ] **Step 3: Implement `json.ts`**

Create `packages/server/src/exports/json.ts`:

```ts
import type { Database } from 'better-sqlite3';

export const BACKUP_FORMAT_VERSION = 1;

/**
 * CONTRACT §6 table list, minus `sessions`. Restoring live sessions from a backup
 * would resurrect logged-in browsers; it has no user value and is a security hazard.
 */
export const BACKUP_TABLES = [
  'funders', 'programs', 'constraints', 'cycles', 'sources', 'snapshots',
  'change_events', 'review_items', 'users', 'profiles', 'watches',
  'applications', 'template_instances', 'audit_log', 'ics_tokens',
] as const;

/** PLAN-LOCAL. */
export interface BackupFile {
  app: 'grantspotter';
  formatVersion: number;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}

interface B64Envelope { $b64: string }

function isB64Envelope(v: unknown): v is B64Envelope {
  return typeof v === 'object' && v !== null && typeof (v as B64Envelope).$b64 === 'string';
}

function existingTables(db: Database): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function columnsOf(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function encodeValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return { $b64: value.toString('base64') };
  if (value instanceof Uint8Array) return { $b64: Buffer.from(value).toString('base64') };
  return value;
}

function decodeValue(value: unknown): unknown {
  if (isB64Envelope(value)) return Buffer.from(value.$b64, 'base64');
  if (value === undefined) return null;
  return value;
}

export function exportBackup(db: Database, nowISO: string): BackupFile {
  const present = existingTables(db);
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of BACKUP_TABLES) {
    if (!present.has(table)) continue;
    const rows = db.prepare(`SELECT * FROM ${JSON.stringify(table)}`).all() as Array<Record<string, unknown>>;
    tables[table] = rows.map((row) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) out[k] = encodeValue(v);
      return out;
    });
  }
  return { app: 'grantspotter', formatVersion: BACKUP_FORMAT_VERSION, exportedAt: nowISO, tables };
}

export function restoreBackup(db: Database, raw: unknown): { tablesRestored: string[]; rowsRestored: number } {
  const file = raw as Partial<BackupFile>;
  if (!file || file.app !== 'grantspotter') throw new Error('This file is not a GrantSpotter backup.');
  if (file.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new Error(`Cannot restore format version ${String(file.formatVersion)}; this build reads version ${BACKUP_FORMAT_VERSION}.`);
  }
  const tables = file.tables ?? {};
  const allowed = new Set<string>(BACKUP_TABLES);
  for (const name of Object.keys(tables)) {
    if (!allowed.has(name)) throw new Error(`Backup names unknown table "${name}"; refusing to restore.`);
  }

  const present = existingTables(db);
  const targets = Object.keys(tables).filter((t) => present.has(t));
  let rowsRestored = 0;

  const run = db.transaction(() => {
    db.pragma('foreign_keys = OFF');
    for (const table of [...targets].reverse()) {
      db.prepare(`DELETE FROM ${JSON.stringify(table)}`).run();
    }
    for (const table of targets) {
      const schemaColumns = new Set(columnsOf(db, table));
      for (const row of tables[table]) {
        const columns = Object.keys(row).filter((c) => schemaColumns.has(c));
        if (columns.length === 0) continue;
        const sql =
          `INSERT INTO ${JSON.stringify(table)} (${columns.map((c) => JSON.stringify(c)).join(',')}) ` +
          `VALUES (${columns.map(() => '?').join(',')})`;
        db.prepare(sql).run(...columns.map((c) => decodeValue(row[c])));
        rowsRestored += 1;
      }
    }
    db.pragma('foreign_keys = ON');
  });

  run();
  return { tablesRestored: targets, rowsRestored };
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/json.test.ts
```

Expected: 12 passing tests.

- [ ] **Step 5: Commit**

```bash
cd /path/to/grantspotter
git add packages/server/src/exports
git commit -m "feat(exports): schema-agnostic JSON backup and restore, sessions excluded"
```

---

### Task 7: Eligibility report — CSV plus a printable HTML page

**Files:**
- Create: `packages/server/src/exports/eligibility.ts`
- Create: `packages/server/src/exports/printCss.ts`
- Create: `packages/server/src/exports/html.ts`
- Test: `packages/server/src/exports/eligibility.test.ts`

**Interfaces:**
- Consumes: `matchAll(profile: Profile, programs: Program[]): Map<string, Verdict>` and `Verdict` from `@grantspotter/core` (CONTRACT §4).
- Produces:
  - `export interface EligibilityRow { programId: string; programName: string; funderName: string; klass: OpportunityClass; verdict: Verdict['kind']; rank: string; reasonAxes: string; reasons: string; missingFields: string; nextCloses: string; amountRaw: string; applyUrl: string; sourceUrl: string; lastVerifiedAt: string }` — **plan-local**
  - `export interface EligibilityReport { generatedAt: string; profileKind: 'student' | 'organization'; counts: { eligible: number; eligible_preferred: number; ineligible: number; unknown: number }; rows: EligibilityRow[] }` — **plan-local**
  - `export function buildEligibilityReport(profile: Profile, programs: Program[], funders: Funder[], cyclesByProgramId: Map<string, Cycle[]>, nowISO: string): EligibilityReport`
  - `export function eligibilityReportToCsv(report: EligibilityReport): string`
  - `export function renderEligibilityReportHtml(report: EligibilityReport): string` (in `html.ts`)
  - `export function escapeHtml(value: string): string` (in `html.ts`)
  - `export const PRINT_CSS: string` (in `printCss.ts`)

Domain notes:
- The matcher's four verdicts (CONTRACT §3) are `eligible`, `eligible_preferred` (with a `rank` and the ids of constraints met), `ineligible` (with the exact `Constraint[]` that excluded you), and `unknown` (with the profile fields that would resolve it). Spec §5 is explicit: *"You are ineligible for 41 of these, and here is the specific constraint for each" is the feature that makes this a professional tool rather than a list.* The report exists to render that sentence.
- `unknown` is never rendered as `ineligible`. Missing profile data yields `unknown` and the report lists the one field that would resolve it.
- This HTML page is **server-rendered and standalone**: it inlines `PRINT_CSS` and depends on no SPA route. That is what makes "PDF" work with no headless browser — the user hits Cmd/Ctrl-P and saves.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/exports/eligibility.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Profile, Verdict } from '@grantspotter/core';
import { buildEligibilityReport, eligibilityReportToCsv } from './eligibility.js';
import { renderEligibilityReportHtml, escapeHtml } from './html.js';
import { makeProgram, makeFunder, makeCycle } from './testFixtures.js';

vi.mock('@grantspotter/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@grantspotter/core')>();
  return {
    ...actual,
    matchAll: (_profile: Profile, programs: Array<{ id: string }>): Map<string, Verdict> => {
      const verdicts: Record<string, Verdict> = {
        'p-eligible': { kind: 'eligible' },
        'p-preferred': { kind: 'eligible_preferred', rank: 0, met: ['c-geo'] },
        'p-ineligible': {
          kind: 'ineligible',
          reasons: [{
            id: 'c-license', hard: true, fallbackRank: 0,
            rawText: 'Applicant must hold a General class licence or higher.',
            spec: { axis: 'license', licenseMin: 'GENERAL' },
          }],
        },
        'p-unknown': { kind: 'unknown', missingProfileFields: ['gpa'] },
      };
      return new Map(programs.map((p) => [p.id, verdicts[p.id] ?? { kind: 'eligible' }]));
    },
  };
});

const PROFILE: Profile = { kind: 'student', callsign: 'W8UM', licenseClass: 'TECH' };
const PROGRAMS = [
  makeProgram({ id: 'p-eligible', name: 'Eligible Program' }),
  makeProgram({ id: 'p-preferred', name: 'Preferred Program' }),
  makeProgram({ id: 'p-ineligible', name: 'Ineligible Program' }),
  makeProgram({ id: 'p-unknown', name: 'Unknown Program' }),
];
const FUNDERS = [makeFunder()];
const CYCLES = new Map([['p-eligible', [makeCycle({ programId: 'p-eligible' })]]]);
const NOW = '2026-08-02T12:00:00.000Z';

describe('buildEligibilityReport', () => {
  it('counts each verdict kind', () => {
    const report = buildEligibilityReport(PROFILE, PROGRAMS, FUNDERS, CYCLES, NOW);
    expect(report.counts).toEqual({ eligible: 1, eligible_preferred: 1, ineligible: 1, unknown: 1 });
    expect(report.profileKind).toBe('student');
    expect(report.generatedAt).toBe(NOW);
  });

  it('records the specific constraint text that excluded an ineligible program', () => {
    const report = buildEligibilityReport(PROFILE, PROGRAMS, FUNDERS, CYCLES, NOW);
    const row = report.rows.find((r) => r.programId === 'p-ineligible')!;
    expect(row.verdict).toBe('ineligible');
    expect(row.reasons).toContain('General class licence');
    expect(row.reasonAxes).toBe('license');
  });

  it('records which profile field would resolve an unknown, and never calls it ineligible', () => {
    const report = buildEligibilityReport(PROFILE, PROGRAMS, FUNDERS, CYCLES, NOW);
    const row = report.rows.find((r) => r.programId === 'p-unknown')!;
    expect(row.verdict).toBe('unknown');
    expect(row.missingFields).toBe('gpa');
    expect(row.reasons).toBe('');
  });

  it('orders rows eligible, preferred, unknown, ineligible', () => {
    const report = buildEligibilityReport(PROFILE, PROGRAMS, FUNDERS, CYCLES, NOW);
    expect(report.rows.map((r) => r.verdict))
      .toEqual(['eligible', 'eligible_preferred', 'unknown', 'ineligible']);
  });

  it('resolves the funder name and the next close date', () => {
    const report = buildEligibilityReport(PROFILE, PROGRAMS, FUNDERS, CYCLES, NOW);
    const row = report.rows[0];
    expect(row.funderName).toBe('Amateur Radio Digital Communications');
    expect(row.nextCloses).toBe('2027-02-01');
  });
});

describe('eligibilityReportToCsv', () => {
  it('writes a header and one row per program', () => {
    const csv = eligibilityReportToCsv(buildEligibilityReport(PROFILE, PROGRAMS, FUNDERS, CYCLES, NOW));
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('verdict');
    expect(lines[0]).toContain('reasons');
  });
});

describe('escapeHtml', () => {
  it('escapes the five XML entities', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

describe('renderEligibilityReportHtml', () => {
  const html = renderEligibilityReportHtml(buildEligibilityReport(PROFILE, PROGRAMS, FUNDERS, CYCLES, NOW));

  it('is a standalone document with the print stylesheet inlined', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('@media print');
    expect(html).toContain('<style>');
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  it('carries a Print / Save as PDF button that is hidden when printing', () => {
    expect(html).toContain('Print / Save as PDF');
    expect(html).toContain('class="no-print"');
  });

  it('shows the counts and the per-program reason', () => {
    expect(html).toContain('Eligible');
    expect(html).toContain('General class licence');
    expect(html).toContain('gpa');
  });

  it('escapes program names so a hostile record cannot inject markup', () => {
    const evil = buildEligibilityReport(
      PROFILE,
      [makeProgram({ id: 'p-eligible', name: '<script>alert(1)</script>' })],
      FUNDERS, CYCLES, NOW,
    );
    const out = renderEligibilityReportHtml(evil);
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/eligibility.test.ts
```

Expected failure: `Cannot find module './eligibility.js'`.

- [ ] **Step 3: Implement `printCss.ts`**

Create `packages/server/src/exports/printCss.ts`:

```ts
/**
 * Print stylesheet for server-rendered standalone reports (eligibility report,
 * opportunity brief). The SPA has its own copy at packages/web/src/styles/print.css;
 * the two are deliberately separate files because a TS module cannot be imported
 * by Vite's CSS pipeline. Task 8 ships a test that keeps the required rules in sync.
 */
export const PRINT_CSS = `
:root { --ink: #16191d; --muted: #5b636e; --rule: #d8dce2; --accent: #1d4ed8; --warn: #b45309; --bad: #b00020; }
* { box-sizing: border-box; }
body { margin: 0; padding: 2rem 1.5rem 4rem; color: var(--ink); background: #fff;
  font: 15px/1.55 "Iowan Old Style", "Charter", Georgia, "Times New Roman", serif; }
header.report-head { border-bottom: 2px solid var(--ink); padding-bottom: .75rem; margin-bottom: 1.25rem; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -0.01em; }
.subtitle, .provenance { color: var(--muted); font-size: .85rem; margin: 0; }
.counts { display: flex; flex-wrap: wrap; gap: .75rem; margin: 1rem 0 1.5rem; padding: 0; list-style: none; }
.counts li { border: 1px solid var(--rule); border-radius: 6px; padding: .5rem .75rem; min-width: 7.5rem; }
.counts .n { display: block; font-size: 1.4rem; font-weight: 700; }
.counts .k { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; }
table { width: 100%; border-collapse: collapse; font-size: .82rem; }
th, td { text-align: left; vertical-align: top; padding: .4rem .5rem; border-bottom: 1px solid var(--rule); }
th { font-size: .7rem; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
td.reason { color: var(--bad); }
td.missing { color: var(--warn); }
.verdict { font-weight: 700; white-space: nowrap; }
.verdict-eligible { color: #15803d; }
.verdict-eligible_preferred { color: var(--accent); }
.verdict-unknown { color: var(--warn); }
.verdict-ineligible { color: var(--bad); }
.stale { color: var(--warn); font-weight: 700; }
button.print-button { font: inherit; padding: .5rem .9rem; border: 1px solid var(--ink); border-radius: 6px;
  background: var(--ink); color: #fff; cursor: pointer; }
footer.report-foot { margin-top: 2rem; padding-top: .75rem; border-top: 1px solid var(--rule);
  color: var(--muted); font-size: .78rem; }
@media print {
  @page { size: letter; margin: 14mm 12mm 16mm; }
  body { padding: 0; font-size: 10.5pt; }
  .no-print { display: none !important; }
  thead { display: table-header-group; }
  tr, .avoid-break { break-inside: avoid; page-break-inside: avoid; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 8.5pt; color: #333; word-break: break-all; }
  .counts li { border-color: #999; }
}
`;
```

- [ ] **Step 4: Implement `eligibility.ts`**

Create `packages/server/src/exports/eligibility.ts`:

```ts
import { matchAll } from '@grantspotter/core';
import type { Program, Funder, Cycle, Profile, Verdict, OpportunityClass } from '@grantspotter/core';
import { toCsv } from './csv.js';

/** PLAN-LOCAL. */
export interface EligibilityRow {
  programId: string;
  programName: string;
  funderName: string;
  klass: OpportunityClass;
  verdict: Verdict['kind'];
  rank: string;
  reasonAxes: string;
  reasons: string;
  missingFields: string;
  nextCloses: string;
  amountRaw: string;
  applyUrl: string;
  sourceUrl: string;
  lastVerifiedAt: string;
}

/** PLAN-LOCAL. */
export interface EligibilityReport {
  generatedAt: string;
  profileKind: 'student' | 'organization';
  counts: { eligible: number; eligible_preferred: number; ineligible: number; unknown: number };
  rows: EligibilityRow[];
}

export const ELIGIBILITY_CSV_COLUMNS = [
  'programId', 'programName', 'funderName', 'klass', 'verdict', 'rank',
  'reasonAxes', 'reasons', 'missingFields', 'nextCloses', 'amountRaw',
  'applyUrl', 'sourceUrl', 'lastVerifiedAt',
] as const;

const VERDICT_ORDER: Record<Verdict['kind'], number> = {
  eligible: 0,
  eligible_preferred: 1,
  unknown: 2,
  ineligible: 3,
};

function nextClose(cycles: Cycle[] | undefined): string {
  if (!cycles || cycles.length === 0) return '';
  const dated = cycles.map((c) => c.closesAt ?? c.opensAt ?? '').filter((d) => d.length > 0).sort();
  return dated[0]?.slice(0, 10) ?? '';
}

export function buildEligibilityReport(
  profile: Profile,
  programs: Program[],
  funders: Funder[],
  cyclesByProgramId: Map<string, Cycle[]>,
  nowISO: string,
): EligibilityReport {
  const funderNames = new Map(funders.map((f) => [f.id, f.name]));
  const verdicts = matchAll(profile, programs);
  const counts = { eligible: 0, eligible_preferred: 0, ineligible: 0, unknown: 0 };

  const rows: EligibilityRow[] = programs.map((program) => {
    const verdict = verdicts.get(program.id) ?? ({ kind: 'unknown', missingProfileFields: [] } as Verdict);
    counts[verdict.kind] += 1;
    return {
      programId: program.id,
      programName: program.name,
      funderName: funderNames.get(program.funderId) ?? '',
      klass: program.klass,
      verdict: verdict.kind,
      rank: verdict.kind === 'eligible_preferred' ? String(verdict.rank) : '',
      reasonAxes: verdict.kind === 'ineligible' ? verdict.reasons.map((c) => c.spec.axis).join('; ') : '',
      reasons: verdict.kind === 'ineligible' ? verdict.reasons.map((c) => c.rawText).join(' | ') : '',
      missingFields: verdict.kind === 'unknown' ? verdict.missingProfileFields.join('; ') : '',
      nextCloses: nextClose(cyclesByProgramId.get(program.id)),
      amountRaw: program.amount.amountRaw,
      applyUrl: program.applyUrl ?? '',
      sourceUrl: program.trust.sourceUrl,
      lastVerifiedAt: program.trust.lastVerifiedAt,
    };
  });

  rows.sort((a, b) => {
    const byVerdict = VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict];
    return byVerdict !== 0 ? byVerdict : a.programName.localeCompare(b.programName);
  });

  return { generatedAt: nowISO, profileKind: profile.kind, counts, rows };
}

export function eligibilityReportToCsv(report: EligibilityReport): string {
  const rows = report.rows.map((r) => ({ ...r })) as unknown as Array<Record<string, string>>;
  return toCsv(rows, [...ELIGIBILITY_CSV_COLUMNS]);
}
```

- [ ] **Step 5: Implement `html.ts`**

Create `packages/server/src/exports/html.ts`:

```ts
import type { EligibilityReport } from './eligibility.js';
import { PRINT_CSS } from './printCss.js';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

function stale(lastVerifiedAt: string, nowISO: string): boolean {
  const then = Date.parse(lastVerifiedAt);
  const now = Date.parse(nowISO);
  if (Number.isNaN(then) || Number.isNaN(now)) return false;
  return now - then > NINETY_DAYS_MS;
}

function link(url: string): string {
  if (!url) return '';
  return `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
}

export function renderEligibilityReportHtml(report: EligibilityReport): string {
  const rows = report.rows.map((r) => {
    const verified = stale(r.lastVerifiedAt, report.generatedAt)
      ? `<span class="stale">${escapeHtml(r.lastVerifiedAt)} — unverified</span>`
      : escapeHtml(r.lastVerifiedAt);
    return `      <tr>
        <td class="verdict verdict-${escapeHtml(r.verdict)}">${escapeHtml(r.verdict.replace('_', ' '))}${r.rank ? ` (rank ${escapeHtml(r.rank)})` : ''}</td>
        <td>${escapeHtml(r.programName)}<br><span class="subtitle">${escapeHtml(r.funderName)}</span></td>
        <td>${escapeHtml(r.amountRaw)}</td>
        <td>${escapeHtml(r.nextCloses)}</td>
        <td class="reason">${escapeHtml(r.reasons)}</td>
        <td class="missing">${escapeHtml(r.missingFields)}</td>
        <td>${link(r.applyUrl || r.sourceUrl)}<br><span class="subtitle">${verified}</span></td>
      </tr>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GrantSpotter eligibility report</title>
<style>${PRINT_CSS}</style>
</head>
<body>
<header class="report-head">
  <h1>Eligibility report</h1>
  <p class="subtitle">Matched against your ${escapeHtml(report.profileKind)} profile.</p>
  <p class="provenance">Generated ${escapeHtml(report.generatedAt)} by GrantSpotter. Every verdict below is computed from the constraint text quoted with it; nothing here is an assurance from the funder.</p>
</header>
<p class="no-print"><button class="print-button" type="button" onclick="window.print()">Print / Save as PDF</button></p>
<ul class="counts">
  <li><span class="n">${report.counts.eligible}</span><span class="k">Eligible</span></li>
  <li><span class="n">${report.counts.eligible_preferred}</span><span class="k">Eligible, preferred</span></li>
  <li><span class="n">${report.counts.unknown}</span><span class="k">Unknown</span></li>
  <li><span class="n">${report.counts.ineligible}</span><span class="k">Ineligible</span></li>
</ul>
<table>
  <thead>
    <tr><th>Verdict</th><th>Program</th><th>Award</th><th>Next close</th><th>Why not</th><th>Missing from your profile</th><th>Where / last verified</th></tr>
  </thead>
  <tbody>
${rows}
  </tbody>
</table>
<footer class="report-foot">
  <p>An <em>unknown</em> verdict is not a rejection. It means your profile is missing one field the funder's rule depends on; fill that field in and the verdict resolves.</p>
  <p>A <em>preferred</em> verdict means a soft preference matched. Soft preferences rank applicants, they never exclude them.</p>
  <p>GrantSpotter is a curated database with a change-detection layer, not a live feed from these funders. Confirm every deadline against the source URL before you rely on it.</p>
</footer>
</body>
</html>
`;
}
```

- [ ] **Step 6: Run the test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/eligibility.test.ts
```

Expected: 11 passing tests.

- [ ] **Step 7: Commit**

```bash
cd /path/to/grantspotter
git add packages/server/src/exports
git commit -m "feat(exports): eligibility report as CSV and a standalone printable HTML page"
```

---

### Task 8: Web print stylesheet and the Print / Save as PDF button

**Files:**
- Create: `packages/web/src/styles/print.css`
- Create: `packages/web/src/components/PrintButton.tsx`
- Test: `packages/web/src/components/PrintButton.test.tsx`
- Test: `packages/web/src/styles/print.test.ts`
- Modify: `packages/web/src/main.tsx` (add one `import './styles/print.css';` line next to the existing style imports)
- Modify: `packages/web/src/routes/Opportunity.tsx` (Plan 3 Task 19 — render `<PrintButton label="Print brief" />` in the existing `.detail-actions` row and wrap the brief body in `<article className="opportunity-brief">`)
- Modify: `packages/web/src/routes/Opportunity.test.tsx` (Plan 3 Task 19 — assert the print control is present)

**Interfaces:**
- Produces:
  - `export function triggerPrint(target: { print: () => void }): void`
  - `export function PrintButton(props: { label?: string; className?: string }): JSX.Element`
  - `packages/web/src/styles/print.css`

Notes:
- **Why there is no headless Chromium in this image.** A server-side PDF renderer means bundling Chromium: roughly 400 MB added to a ~200 MB image, a second process to supervise, and an arm64 build that regularly fails under QEMU emulation in CI. The browser the user already has renders this stylesheet perfectly and gives them the OS print dialog for free. This is written down in the README (Task 21) because it is the kind of decision a future maintainer will otherwise "fix".
- **The stylesheet must name the classes Plan 3 actually ships.** Plan 3's `AppShell` renders `.shell`, `.shell-rail`, `.shell-topbar`, `.shell-main` and `.skip-link`; its trust surfaces are `.trust`, `.trust-unverified`, `.disputed`, `.stale-mirror`, `.row-warning` and `.estimated-mark`. A print rule written against a class nobody renders is a dead selector that no test would notice, so Step 1's test asserts every class named in `print.css` also appears in some `.tsx` or `.css` file under `packages/web/src` — the assertion that actually fails when the two drift.
- **The print path has to be reachable.** Spec §11.3 promises "Opportunity brief | PDF | via a designed `@media print` stylesheet + Print / Save as PDF". The eligibility report already carries its own button (Task 7 renders it server-side into `html.ts`); the opportunity brief gets its button here, in Step 6.
- The component test uses `react-dom/server`'s `renderToStaticMarkup` rather than jsdom + Testing Library, so it needs no DOM environment and no extra dependency. `triggerPrint` is exported separately precisely so the click behaviour is testable without a DOM.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/components/PrintButton.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintButton, triggerPrint } from './PrintButton.js';

describe('triggerPrint', () => {
  it('calls print on the window it is given', () => {
    const target = { print: vi.fn() };
    triggerPrint(target);
    expect(target.print).toHaveBeenCalledTimes(1);
  });
});

describe('PrintButton', () => {
  it('renders the default label', () => {
    expect(renderToStaticMarkup(<PrintButton />)).toContain('Print / Save as PDF');
  });

  it('is marked no-print so it never appears on the printed page', () => {
    expect(renderToStaticMarkup(<PrintButton />)).toContain('no-print');
  });

  it('accepts a custom label and extra classes', () => {
    const html = renderToStaticMarkup(<PrintButton label="Print brief" className="wide" />);
    expect(html).toContain('Print brief');
    expect(html).toContain('wide');
    expect(html).toContain('no-print');
  });

  it('renders a real button element with an explicit type', () => {
    expect(renderToStaticMarkup(<PrintButton />)).toContain('type="button"');
  });
});
```

Create `packages/web/src/styles/print.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PRINT_CSS_PATH = fileURLToPath(new URL('./print.css', import.meta.url));
const WEB_SRC = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(PRINT_CSS_PATH, 'utf8');

/** Every class selector print.css mentions, deduplicated. */
function classesIn(source: string): string[] {
  const matches = source.match(/\.[A-Za-z_][A-Za-z0-9_-]*/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (path === PRINT_CSS_PATH) continue;
    if (['.tsx', '.ts', '.css'].includes(extname(path)) && !path.endsWith('.test.ts') && !path.endsWith('.test.tsx')) {
      out.push(path);
    }
  }
  return out;
}

const markup = sourceFiles(WEB_SRC).map((f) => readFileSync(f, 'utf8')).join('\n');

describe('print.css', () => {
  it('has an @media print block and a @page rule with margins', () => {
    expect(css).toContain('@media print');
    expect(css).toMatch(/@page\s*\{[^}]*margin/);
  });

  it('hides the app chrome Plan 3 actually renders', () => {
    for (const selector of ['.no-print', 'nav', '.shell-rail', '.shell-topbar', '.skip-link']) {
      expect(css).toContain(selector);
    }
    expect(css).toContain('display: none !important');
  });

  it('flattens the shell grid so the page uses the full print width', () => {
    expect(css).toMatch(/\.shell,[\s\S]{0,120}display:\s*block/);
    expect(css).toContain('grid-template-areas: none');
    expect(css).toContain('.shell-main');
  });

  it('repeats table headers across pages and avoids splitting rows', () => {
    expect(css).toContain('display: table-header-group');
    expect(css).toContain('break-inside: avoid');
  });

  it('expands link URLs so a printed page is still navigable', () => {
    expect(css).toContain('content: " (" attr(href) ")"');
  });

  it('keeps the trust surfaces visible in print, under their real class names', () => {
    for (const selector of ['.trust', '.trust-unverified', '.disputed', '.stale-mirror', '.row-warning', '.estimated-mark']) {
      expect(css).toContain(selector);
    }
  });

  /**
   * The drift guard. print.css previously styled `.app-sidebar`, `.trust-badge` and
   * `.stale-mirror-warning` — none of which any component renders — so every rule was a
   * dead selector and a string-matching test still passed. This asserts each class is
   * really in the markup.
   */
  it('names no class that no component or stylesheet ships', () => {
    const orphans = classesIn(css).filter((name) => !markup.includes(name));
    expect(orphans).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/web/src/components/PrintButton.test.tsx packages/web/src/styles/print.test.ts
```

Expected failure: `Cannot find module './PrintButton.js'` and `ENOENT ... print.css`.

- [ ] **Step 3: Write `print.css`**

Create `packages/web/src/styles/print.css`:

```css
/* GrantSpotter print stylesheet.
   PDF output is the browser's own "Save as PDF" against this sheet. There is no
   headless Chromium in the container image: it would add roughly 400 MB and its
   arm64 build under QEMU emulation is a recurring CI failure.

   Every class named below is rendered by a real component: AppShell ships
   .shell / .shell-rail / .shell-topbar / .shell-main / .skip-link, Browse ships
   .filter-panel / .row-warning / .estimated-mark, Opportunity ships .card /
   .panel / .trust / .trust-unverified / .disputed / .stale-mirror /
   .detail-actions / .opportunity-brief, and PrintButton ships
   .print-button / .no-print. print.test.ts fails the build if that stops being
   true. */

@media print {
  @page {
    size: letter;
    margin: 14mm 12mm 16mm;
  }

  html, body {
    background: #fff !important;
    color: #16191d !important;
    font-size: 10.5pt;
    line-height: 1.45;
  }

  .no-print,
  nav,
  .shell-rail,
  .shell-topbar,
  .skip-link,
  button,
  input,
  select,
  .filter-panel {
    display: none !important;
  }

  /* The actions row keeps its "Apply at the funder" anchor — the URL expands via the
     a[href]::after rule below — while the buttons inside it are hidden by the rule above. */
  .detail-actions {
    display: block;
    margin: 4pt 0;
  }

  /* AppShell is a CSS grid on screen. Printing it as a grid keeps the main
     region at its on-screen column width and wastes half the page. */
  .shell,
  .shell-main {
    display: block !important;
    grid-template-areas: none;
    grid-template-columns: none;
    width: auto !important;
    max-width: none !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow: visible !important;
  }

  h1, h2, h3 {
    break-after: avoid;
    page-break-after: avoid;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 9.5pt;
  }

  thead {
    display: table-header-group;
  }

  tr,
  .card,
  .panel,
  .opportunity-brief {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  th, td {
    border-bottom: 1px solid #c9ced6;
    padding: 3pt 4pt;
    text-align: left;
    vertical-align: top;
  }

  a {
    color: #16191d !important;
    text-decoration: none;
  }

  a[href^="http"]::after {
    content: " (" attr(href) ")";
    font-size: 8pt;
    color: #444;
    word-break: break-all;
  }

  /* Trust surfaces are the point of this app; they must survive printing. */
  .trust,
  .trust-unverified,
  .disputed,
  .stale-mirror,
  .row-warning,
  .estimated-mark {
    display: block !important;
    border: 1px solid #7a7f88;
    padding: 3pt 5pt;
    margin: 4pt 0;
    font-size: 9pt;
    color: #16191d !important;
    background: #fff !important;
  }

  .trust-unverified,
  .estimated-mark,
  .stale-mirror {
    font-weight: 700;
  }
}
```

- [ ] **Step 4: Write `PrintButton.tsx`**

Create `packages/web/src/components/PrintButton.tsx`:

```tsx
export function triggerPrint(target: { print: () => void }): void {
  target.print();
}

export interface PrintButtonProps {
  label?: string;
  className?: string;
}

export function PrintButton({ label = 'Print / Save as PDF', className = '' }: PrintButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`print-button no-print ${className}`.trim()}
      onClick={() => triggerPrint(window)}
    >
      {label}
    </button>
  );
}
```

- [ ] **Step 5: Import the stylesheet in the app entrypoint**

Open `packages/web/src/main.tsx` and add the print stylesheet import alongside the existing style import(s), so Vite bundles it:

```tsx
import './styles/print.css';
```

- [ ] **Step 6: Render the print control on the opportunity brief**

Without this step the whole print path is unreachable: nothing renders `<PrintButton />` and the
stylesheet only ever applies if the user finds Ctrl-P themselves. Open
`packages/web/src/routes/Opportunity.tsx` (Plan 3 Task 19) and make two changes.

Add the import beside the existing component imports:

```tsx
import { PrintButton } from '../components/PrintButton.js';
```

Then add the button to the existing actions row and wrap the brief body so the
`break-inside: avoid` rule has something to hold on to. The `detail-actions` block becomes:

```tsx
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
        <PrintButton label="Print brief" className="btn" />
      </div>
```

and the `<div className="detail-grid">` that follows it becomes
`<article className="opportunity-brief"><div className="detail-grid">…</div></article>` — the
closing `</div>` of `detail-grid` gains a matching `</article>`.

Add the assertion to `packages/web/src/routes/Opportunity.test.tsx`, inside the existing
`describe` for the detail screen:

```tsx
  it('offers a print / save-as-PDF control for the brief', async () => {
    renderOpportunity();
    expect(await screen.findByRole('button', { name: 'Print brief' })).toBeInTheDocument();
  });
```

If Plan 3's test file names its render helper something other than `renderOpportunity`, use that
name — the assertion is the point, not the helper.

- [ ] **Step 7: Run the tests and watch them pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/web/src/components/PrintButton.test.tsx packages/web/src/styles/print.test.ts packages/web/src/routes/Opportunity.test.tsx
```

Expected: 11 passing tests here (4 `PrintButton`, 7 `print.css`) plus Plan 3's Opportunity suite
with one more assertion in it. If the `.tsx` test fails to resolve JSX, confirm the web workspace's vitest config sets `esbuild: { jsx: 'automatic' }` or that `tsconfig` has `"jsx": "react-jsx"` — Plan 3 configures this for its own component tests. If the orphan-class assertion fails, it is telling you a selector in `print.css` names a class no component renders: delete the rule or fix the class name, never loosen the test.

- [ ] **Step 8: Commit**

```bash
cd /path/to/grantspotter
git add packages/web/src/styles packages/web/src/components/PrintButton.tsx packages/web/src/components/PrintButton.test.tsx packages/web/src/main.tsx packages/web/src/routes/Opportunity.tsx packages/web/src/routes/Opportunity.test.tsx
git commit -m "feat(web): print stylesheet against real class names, plus a reachable Print / Save as PDF control"
```

---

### Task 9: Export routes, the subscribable ICS feed, and the one integration seam

**Files:**
- Create: `packages/server/src/db/migrations/090-ics-tokens.sql`
- Create: `packages/server/src/exports/token.ts`
- Create: `packages/server/src/exports/dataSource.ts`
- Create: `packages/server/src/api/exports.ts`
- Test: `packages/server/src/api/exports.test.ts`
- Test: `packages/server/src/exports/token.test.ts`
- Modify: `packages/server/src/index.ts` — Step 9 inserts the two mount lines for the routers this
  task exports into Plan 3 Task 14's `AppDeps.mountRoutes` callback, the single mount seam in the
  application (RESOLUTIONS R5, R25). The hook is filled incrementally: Plan 3 mounted its own
  routers and left a comment reserving the final position, Plan 4 added its four, and these two go
  in above that reserved comment. The `exportDeps` value is built **inline there**; this task adds
  no `createExportDeps` factory (RESOLUTIONS R22).

**Interfaces:**
- Consumes: everything produced by Tasks 1–7; `expandCycles(program, allPrograms, fromISO, toISO): Cycle[]` from `@grantspotter/core`; `Program`, `Funder`, `Profile` types; `createProgramRepo` / `createFunderRepo` / `createProfileRepo` (Plan 1, factory-shaped — RESOLUTIONS R8); `watchedProgramIds(db, userId): string[]` from Plan 3's `api/watchRouter.ts`; `assertExportReady(db, id, userId)` and `getApplication(db, id, userId)` from Plan 4's `db/repositories/applications.ts`; `AppError` from Plan 1's `api/errors.ts`.
- Produces:
  - `export interface ExportDataSource { … }` — **plan-local port**, defined in `dataSource.ts`
  - `export function createSqliteExportDataSource(db: Database): ExportDataSource`
  - `export interface ExportDeps { data: ExportDataSource; requireAuth: RequestHandler; requireAdmin: RequestHandler; now(): string; userIdOf(req: Request): string | undefined; publicBaseUrl(req: Request): string }` — **plan-local**
  - `export function createExportsRouter(deps: ExportDeps): Router`
  - `export function createCalendarFeedRouter(deps: ExportDeps): Router`
  - `export function newIcsToken(): string` and `export function hashIcsToken(token: string): string`

**Routes produced** (Task 10's UI and Task 22's e2e flow call these):

| Method | Path | Auth | Returns |
|---|---|---|---|
| GET | `/api/exports/opportunities.csv` | session | `text/csv` |
| GET | `/api/exports/opportunities.xlsx` | session | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| GET | `/api/exports/eligibility.csv` | session | `text/csv` |
| GET | `/api/exports/eligibility.html` | session | `text/html` (printable) |
| GET | `/api/exports/deadlines.ics` | session | `text/calendar` one-off download |
| GET | `/api/exports/ics-token` | session | `{ url }` or 404 |
| POST | `/api/exports/ics-token` | session | `{ url, token }` — creating again rotates |
| DELETE | `/api/exports/ics-token` | session | 204, old URL stops working |
| POST | `/api/exports/draft.docx` | session | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| POST | `/api/exports/draft.md` | session | `text/markdown` |
| POST | `/api/exports/packet.zip` | session | `application/zip` |
| GET | `/api/admin/backup.json` | **admin** | `application/json` |
| POST | `/api/admin/restore` | **admin** | `{ tablesRestored, rowsRestored }` |
| GET | `/calendar/:token` | token only | `text/calendar` — the subscribable feed |

Design notes:

1. **The subscribable feed is the useful one.** A one-off `.ics` download is a snapshot that rots the moment ARRL moves a date; a token URL that a phone re-fetches every twelve hours is the thing that actually stops a club officer from missing a deadline. `/calendar/:token` therefore takes no session — a calendar client cannot log in — and is mounted at the app root rather than under `/api`.
2. **The token is stored hashed.** The database stores SHA-256 of the token, never the token, so a leaked database dump does not hand out everyone's calendar. The plaintext is returned exactly once, at creation.
3. **The route path has no regex.** Express 5 (path-to-regexp v8) dropped inline regex in route params, so the route is `/calendar/:token` and the handler strips a trailing `.ics` itself. This works identically on Express 4.
4. **This task contains the only integration seam in Plan 5.** `createSqliteExportDataSource` is the single file that names Plan 1/Plan 3 repository factories. Every other file in this plan, and every test in it, works against the `ExportDataSource` interface.
5. **The three draft exports are gated by Plan 4's fact checklist.** `draft.docx`, `draft.md` and `packet.zip` take an `applicationId` and load the markdown, title, fact confirmations and disclosure flag from the `applications` row — never from the request body. `assertExportReady(db, applicationId, userId)` runs first and throws while any factual assertion is unconfirmed or any `[TODO: …]` marker is unresolved; the handler maps that to **409**. Taking `markdown` from the body would let a direct `POST` export an unconfirmed draft and would reduce the whole checklist to a browser-side suggestion, which is exactly what spec §10.4 forbids.
6. **One error envelope.** Every failure path is `next(new AppError(code, message))` with `AppError` imported from `../api/errors.js`; Plan 1's `errorHandler()` turns it into `{ error: { code, message, details? }, requestId }` with the status from `ERROR_STATUS`. No handler in this file calls `res.status(...).json({ error: '…' })`.

- [ ] **Step 1: Write the migration**

Create `packages/server/src/db/migrations/090-ics-tokens.sql`:

```sql
-- Per-user subscribable calendar tokens.
-- Numbered 090 deliberately: Plans 1-4 number their migrations from 001 upward and
-- do not reach 090, so this file always applies last regardless of what they added.
-- No FOREIGN KEY on user_id: that would couple this migration to the exact column
-- type Plan 1 chose for users.id. Rows are cleaned up by the delete route.
CREATE TABLE IF NOT EXISTS ics_tokens (
  user_id    TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ics_tokens_hash ON ics_tokens (token_hash);
```

- [ ] **Step 2: Write the failing token test**

Create `packages/server/src/exports/token.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { newIcsToken, hashIcsToken } from './token.js';

describe('newIcsToken', () => {
  it('returns a URL-safe token of at least 32 characters', () => {
    const token = newIcsToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats across 100 calls', () => {
    const seen = new Set(Array.from({ length: 100 }, () => newIcsToken()));
    expect(seen.size).toBe(100);
  });
});

describe('hashIcsToken', () => {
  it('is a stable 64-character hex digest', () => {
    expect(hashIcsToken('abc')).toBe(hashIcsToken('abc'));
    expect(hashIcsToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different tokens', () => {
    expect(hashIcsToken('abc')).not.toBe(hashIcsToken('abd'));
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then implement `token.ts`**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/exports/token.test.ts
```

Expected failure: `Cannot find module './token.js'`. Now create `packages/server/src/exports/token.ts`:


```ts
import { createHash, randomBytes } from 'node:crypto';

/** 32 random bytes, base64url encoded: 43 URL-safe characters, no padding. */
export function newIcsToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only the hash is persisted, so a database dump does not leak anyone's feed URL. */
export function hashIcsToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
```

Re-run the command above; expected: 4 passing tests.

- [ ] **Step 4: Write the data source port and its SQLite implementation**

Create `packages/server/src/exports/dataSource.ts`:

```ts
import type { Database } from 'better-sqlite3';
import type { Program, Funder, Cycle, Profile } from '@grantspotter/core';
import { expandCycles } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import { createFunderRepo } from '../db/repositories/funders.js';
import { createProfileRepo } from '../db/repositories/profiles.js';
import { watchedProgramIds } from '../api/watchRouter.js';

/**
 * PLAN-LOCAL PORT. Everything else in Plan 5 depends on this interface, never on the
 * database. That is what lets every route test run against a fake.
 */
export interface ExportDataSource {
  listPrograms(): Program[];
  listFunders(): Funder[];
  listCycles(fromISO: string, toISO: string): Cycle[];
  getProfile(userId: string): Profile | undefined;
  listWatchedProgramIds(userId: string): string[];
  getUserIdForTokenHash(hash: string): string | undefined;
  upsertToken(userId: string, hash: string, nowISO: string): void;
  revokeToken(userId: string, nowISO: string): void;
  getTokenHash(userId: string): string | undefined;
  rawDb(): Database;
}

/**
 * THE ONLY INTEGRATION SEAM IN PLAN 5.
 *
 * Repositories are factories (RESOLUTIONS R8): `createProgramRepo(db)` exposes
 * `.list(filter?)` / `.get(id)` / `.upsert(program)`, `createFunderRepo(db)` exposes
 * `.list()` / `.upsert(funder)`, and `createProfileRepo(db)` exposes `.get(userId, kind)` /
 * `.listForUser(userId)`. There are no free `listPrograms` / `listFunders` /
 * `getProfileForUser` functions, and there is no `db/repositories/watches.ts` — watch
 * queries live in Plan 3's `api/watchRouter.ts` as `watchedProgramIds(db, userId)`.
 * Everything else in Plan 5, and every test in it, sees only `ExportDataSource`.
 */
export function createSqliteExportDataSource(db: Database): ExportDataSource {
  const programs = createProgramRepo(db);
  const funders = createFunderRepo(db);
  const profiles = createProfileRepo(db);

  return {
    listPrograms: () => programs.list(),
    listFunders: () => funders.list(),
    listCycles(fromISO: string, toISO: string): Cycle[] {
      const all = programs.list();
      return all.flatMap((p) => expandCycles(p, all, fromISO, toISO));
    },
    // A user may hold both a student and an organisation profile; the export report
    // matches against the first one they saved, which is what Plan 3's browse does too.
    getProfile: (userId: string) => profiles.listForUser(userId)[0],
    listWatchedProgramIds: (userId: string) => watchedProgramIds(db, userId),
    getUserIdForTokenHash(hash: string): string | undefined {
      const row = db
        .prepare('SELECT user_id FROM ics_tokens WHERE token_hash = ? AND revoked_at IS NULL')
        .get(hash) as { user_id: string } | undefined;
      return row?.user_id;
    },
    upsertToken(userId: string, hash: string, nowISO: string): void {
      db.prepare(
        `INSERT INTO ics_tokens (user_id, token_hash, created_at, revoked_at)
         VALUES (?, ?, ?, NULL)
         ON CONFLICT(user_id) DO UPDATE SET token_hash = excluded.token_hash,
                                            created_at = excluded.created_at,
                                            revoked_at = NULL`,
      ).run(userId, hash, nowISO);
    },
    revokeToken(userId: string, nowISO: string): void {
      db.prepare('UPDATE ics_tokens SET revoked_at = ? WHERE user_id = ?').run(nowISO, userId);
    },
    getTokenHash(userId: string): string | undefined {
      const row = db
        .prepare('SELECT token_hash FROM ics_tokens WHERE user_id = ? AND revoked_at IS NULL')
        .get(userId) as { token_hash: string } | undefined;
      return row?.token_hash;
    },
    rawDb: () => db,
  };
}
```

- [ ] **Step 5: Write the failing route test**

Create `packages/server/src/api/exports.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import Database from 'better-sqlite3';
import type { Program, Funder, Cycle, Profile } from '@grantspotter/core';
import { createExportsRouter, createCalendarFeedRouter } from './exports.js';
import { AppError, errorHandler, requestIdMiddleware } from './errors.js';
import type { ExportDataSource } from '../exports/dataSource.js';
import { makeProgram, makeFunder, makeCycle } from '../exports/testFixtures.js';
import { hashIcsToken } from '../exports/token.js';

/**
 * The `applications` schema verbatim, so assertExportReady runs for real here.
 * Plan 1's 001-init.sql owns this table and its column list (RESOLUTIONS R24).
 * Plan 4 ships no migration for these tables; it asserts this shape with
 * `assertApplicationSchema(db)` in `db/repositories/applications.ts`.
 * If a column below drifts from 001-init.sql, this fixture is the thing that is
 * wrong — fix it here, never by re-creating the table in a later migration.
 *
 * The column names, order and nullability are 001-init.sql's; the REFERENCES
 * clauses are deliberately dropped, because this in-memory database has no
 * `users` or `programs` table to point at and assertExportReady never joins one.
 */
const APPLICATIONS_DDL = `
  CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    program_id TEXT,
    title TEXT NOT NULL,
    body_markdown TEXT NOT NULL,
    answers_json TEXT NOT NULL,
    fact_confirmations_json TEXT NOT NULL,
    include_disclosure INTEGER NOT NULL,
    facts_confirmed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;

/** No money, no dates, no two-word proper noun: extractFactAssertions finds nothing to confirm. */
const READY_MARKDOWN = '# Need statement\n\nOur club station needs a replacement transceiver.';
/** One unconfirmed money assertion, so assertExportReady throws. */
const UNCONFIRMED_MARKDOWN = '# Budget\n\nOne transceiver at $2,899.';

const PROGRAMS: Program[] = [
  makeProgram(),
  makeProgram({ id: 'arrl-club-grant', name: 'ARRL Club Grant Program', klass: 'ham_grant', tags: ['ham', 'club'] }),
];
const FUNDERS: Funder[] = [makeFunder()];
const CYCLES: Cycle[] = [makeCycle()];
const PROFILE: Profile = { kind: 'student', callsign: 'W8UM', licenseClass: 'GENERAL' };

function fakeDataSource(): ExportDataSource {
  const tokens = new Map<string, { hash: string; revoked: boolean }>();
  const db = new Database(':memory:');
  db.exec('CREATE TABLE funders (id TEXT PRIMARY KEY, name TEXT, homepage TEXT)');
  db.exec(APPLICATIONS_DDL);
  db.prepare('INSERT INTO funders VALUES (?,?,?)').run('ardc', 'ARDC', 'https://www.ardc.net/');
  const insertApp = db.prepare(
    `INSERT INTO applications (id, user_id, program_id, title, body_markdown, answers_json,
       fact_confirmations_json, include_disclosure, facts_confirmed_at, created_at, updated_at)
     VALUES (?, 'user-1', 'ardc-grants', ?, ?, '{}', '{}', 1, ?, '2026-08-02T12:00:00.000Z', '2026-08-02T12:00:00.000Z')`,
  );
  insertApp.run('app-ready', 'ARDC Grants Program — draft', READY_MARKDOWN, '2026-08-02T12:00:00.000Z');
  insertApp.run('app-unconfirmed', 'Unconfirmed draft', UNCONFIRMED_MARKDOWN, null);
  return {
    listPrograms: () => PROGRAMS,
    listFunders: () => FUNDERS,
    listCycles: () => CYCLES,
    getProfile: () => PROFILE,
    listWatchedProgramIds: () => ['ardc-grants'],
    getUserIdForTokenHash: (hash) => {
      for (const [userId, rec] of tokens) if (rec.hash === hash && !rec.revoked) return userId;
      return undefined;
    },
    upsertToken: (userId, hash) => { tokens.set(userId, { hash, revoked: false }); },
    revokeToken: (userId) => { const r = tokens.get(userId); if (r) r.revoked = true; },
    getTokenHash: (userId) => { const r = tokens.get(userId); return r && !r.revoked ? r.hash : undefined; },
    rawDb: () => db,
  };
}

let server: Server;
let base: string;
let data: ExportDataSource;
let role: 'member' | 'admin' = 'member';

beforeAll(async () => {
  data = fakeDataSource();
  const app = express();
  app.use(requestIdMiddleware());
  app.use(express.json({ limit: '2mb' }));
  const deps = {
    data,
    requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
    requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(role === 'admin' ? undefined : new AppError('forbidden', 'Administrator role required.')),
    now: () => '2026-08-02T12:00:00.000Z',
    userIdOf: () => 'user-1',
    publicBaseUrl: () => 'http://127.0.0.1:3030',
  };
  // The real app mounts these from the mountRoutes callback in packages/server/src/index.ts,
  // which Step 9 of this task edits. This test mounts them on a bare express app plus Plan 1's
  // error handler, which is what turns an AppError into the one JSON envelope — without
  // errorHandler every next(err) would surface as a 500. Because this suite does its own
  // mounting it can never detect a missing mount line; Step 10 is the check that can.
  app.use('/api', createExportsRouter(deps));
  app.use('/', createCalendarFeedRouter(deps));
  app.use(errorHandler());
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('opportunity exports', () => {
  it('serves CSV with a download filename', async () => {
    const res = await fetch(`${base}/api/exports/opportunities.csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('grantspotter-opportunities');
    const body = await res.text();
    expect(body.split('\r\n')).toHaveLength(4); // header + 2 rows + trailing empty
  });

  it('applies the query filter to the CSV', async () => {
    const body = await (await fetch(`${base}/api/exports/opportunities.csv?q=club`)).text();
    expect(body).toContain('arrl-club-grant');
    expect(body).not.toContain('ARDC Grants Program');
  });

  it('serves an xlsx workbook', async () => {
    const res = await fetch(`${base}/api/exports/opportunities.xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
  });
});

describe('eligibility exports', () => {
  it('serves the CSV report', async () => {
    const res = await fetch(`${base}/api/exports/eligibility.csv`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('verdict');
  });

  it('serves the printable HTML report', async () => {
    const res = await fetch(`${base}/api/exports/eligibility.html`);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Print / Save as PDF');
  });
});

describe('ICS', () => {
  it('serves a one-off calendar download', async () => {
    const res = await fetch(`${base}/api/exports/deadlines.ics`);
    expect(res.headers.get('content-type')).toContain('text/calendar');
    const body = await res.text();
    expect(body.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(body).toContain('BEGIN:VEVENT');
  });

  it('limits the feed to watched programs when watched=1', async () => {
    const body = await (await fetch(`${base}/api/exports/deadlines.ics?watched=1`)).text();
    expect(body).toContain('X-GRANTSPOTTER-PROGRAM-ID:ardc-grants');
  });

  it('404s the token endpoint before a token exists', async () => {
    expect((await fetch(`${base}/api/exports/ics-token`)).status).toBe(404);
  });

  it('creates a token, returns a usable subscribe URL exactly once, and serves the feed', async () => {
    const created = await (await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })).json() as
      { url: string; token: string };
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(created.url).toBe(`http://127.0.0.1:3030/calendar/${created.token}.ics`);
    expect(data.getUserIdForTokenHash(hashIcsToken(created.token))).toBe('user-1');

    const feed = await fetch(`${base}/calendar/${created.token}.ics`);
    expect(feed.status).toBe(200);
    expect(feed.headers.get('content-type')).toContain('text/calendar');
    expect(await feed.text()).toContain('BEGIN:VEVENT');

    const shown = await (await fetch(`${base}/api/exports/ics-token`)).json() as Record<string, unknown>;
    expect(shown.token).toBeUndefined();
  });

  it('serves the feed with or without the .ics suffix', async () => {
    const created = await (await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })).json() as { token: string };
    expect((await fetch(`${base}/calendar/${created.token}`)).status).toBe(200);
  });

  it('rotates on a second POST, invalidating the previous URL', async () => {
    const first = await (await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })).json() as { token: string };
    const second = await (await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })).json() as { token: string };
    expect(second.token).not.toBe(first.token);
    expect((await fetch(`${base}/calendar/${first.token}.ics`)).status).toBe(404);
    expect((await fetch(`${base}/calendar/${second.token}.ics`)).status).toBe(200);
  });

  it('404s an unknown or revoked token without saying which', async () => {
    const created = await (await fetch(`${base}/api/exports/ics-token`, { method: 'POST' })).json() as { token: string };
    await fetch(`${base}/api/exports/ics-token`, { method: 'DELETE' });
    expect((await fetch(`${base}/calendar/${created.token}.ics`)).status).toBe(404);
    expect((await fetch(`${base}/calendar/definitely-not-a-token`)).status).toBe(404);
  });
});

describe('draft and packet', () => {
  const body = {
    applicationId: 'app-ready',
    programId: 'ardc-grants',
    budgetLines: [{ item: 'IC-7610', category: 'Equipment', quantity: 1, unitCost: 2899, justification: 'Replacement', quoteSource: 'https://www.example.org/q' }],
  };

  const post = (path: string, payload: unknown): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });

  it('returns a docx built from the stored application, not from the request body', async () => {
    const res = await post('/api/exports/draft.docx', body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('wordprocessingml');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString('latin1')).toBe('PK');
  });

  it('returns the same draft as markdown', async () => {
    const res = await post('/api/exports/draft.md', body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-disposition')).toContain('grantspotter-draft-app-ready.md');
    const text = await res.text();
    expect(text).toContain('# Need statement');
    expect(text).toContain('Our club station needs a replacement transceiver.');
  });

  it('returns a zip packet', async () => {
    const res = await post('/api/exports/packet.zip', body);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
  });

  it('409s every draft export while a factual assertion is unconfirmed', async () => {
    for (const path of ['/api/exports/draft.docx', '/api/exports/draft.md', '/api/exports/packet.zip']) {
      const res = await post(path, { ...body, applicationId: 'app-unconfirmed' });
      expect(res.status, path).toBe(409);
      const envelope = await res.json() as { error: { code: string; message: string } };
      expect(envelope.error.code).toBe('conflict');
      expect(envelope.error.message).toMatch(/unconfirmed factual assertion/i);
    }
  });

  it('404s an applicationId that is not this user\'s', async () => {
    const res = await post('/api/exports/draft.docx', { ...body, applicationId: 'someone-elses' });
    expect(res.status).toBe(404);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('not_found');
  });

  it('422s a body with no applicationId', async () => {
    const res = await post('/api/exports/packet.zip', { programId: 'ardc-grants' });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('validation_failed');
  });

  it('400s on an unknown programId, in the one error envelope', async () => {
    const res = await post('/api/exports/packet.zip', { ...body, programId: 'ghost' });
    expect(res.status).toBe(400);
    const envelope = await res.json() as { error: { code: string; message: string }; requestId: string };
    expect(envelope.error.code).toBe('bad_request');
    expect(envelope.requestId).toBeTypeOf('string');
  });
});

describe('admin backup and restore', () => {
  it('refuses a member with a forbidden envelope', async () => {
    role = 'member';
    const res = await fetch(`${base}/api/admin/backup.json`);
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('forbidden');
    expect((await fetch(`${base}/api/admin/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status).toBe(403);
  });

  it('serves a backup to an admin and restores it back', async () => {
    role = 'admin';
    const res = await fetch(`${base}/api/admin/backup.json`);
    expect(res.status).toBe(200);
    const backup = await res.json() as { app: string; tables: Record<string, unknown[]> };
    expect(backup.app).toBe('grantspotter');
    expect(backup.tables.funders).toHaveLength(1);

    const restored = await fetch(`${base}/api/admin/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(backup),
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ rowsRestored: 1 });
    role = 'member';
  });

  it('400s a malformed restore payload and says why', async () => {
    role = 'admin';
    const res = await fetch(`${base}/api/admin/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: 'other' }),
    });
    expect(res.status).toBe(400);
    const envelope = await res.json() as { error: { code: string; message: string } };
    expect(envelope.error.code).toBe('bad_request');
    expect(envelope.error.message).toMatch(/not a GrantSpotter backup/);
    role = 'member';
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/api/exports.test.ts
```

Expected failure: `Cannot find module './exports.js'`.

- [ ] **Step 7: Implement `packages/server/src/api/exports.ts`**

```ts
import { Router } from 'express';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import type { Program } from '@grantspotter/core';
import { AppError } from './errors.js';
import { asyncHandler } from './asyncHandler.js';
import { assertExportReady, getApplication } from '../db/repositories/applications.js';
import type { ApplicationRow } from '../db/repositories/applications.js';
import type { ExportDataSource } from '../exports/dataSource.js';
import { applyExportFilter, parseExportFilter } from '../exports/filter.js';
import { programsToCsv } from '../exports/csv.js';
import { programsToXlsx } from '../exports/xlsx.js';
import { buildIcsCalendar } from '../exports/ics.js';
import { buildEligibilityReport, eligibilityReportToCsv } from '../exports/eligibility.js';
import { renderEligibilityReportHtml } from '../exports/html.js';
import { markdownToDraft, draftToMarkdown } from '../exports/draft.js';
import { draftToDocx } from '../exports/docx.js';
import { buildApplicationPacket } from '../exports/zip.js';
import type { BudgetLine } from '../exports/packet.js';
import { exportBackup, restoreBackup } from '../exports/json.js';
import { hashIcsToken, newIcsToken } from '../exports/token.js';

/** PLAN-LOCAL. */
export interface ExportDeps {
  data: ExportDataSource;
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  now(): string;
  userIdOf(req: Request): string | undefined;
  publicBaseUrl(req: Request): string;
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function windowAround(nowISO: string): { from: string; to: string } {
  const now = Date.parse(nowISO);
  return {
    from: new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    to: new Date(now + ONE_YEAR_MS * 2).toISOString().slice(0, 10),
  };
}

function cyclesByProgram(deps: ExportDeps, nowISO: string): Map<string, ReturnType<ExportDataSource['listCycles']>> {
  const { from, to } = windowAround(nowISO);
  const map = new Map<string, ReturnType<ExportDataSource['listCycles']>>();
  for (const cycle of deps.data.listCycles(from, to)) {
    const list = map.get(cycle.programId) ?? [];
    list.push(cycle);
    map.set(cycle.programId, list);
  }
  return map;
}

function attach(res: Response, filename: string, contentType: string): void {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
}

function stamp(nowISO: string): string {
  return nowISO.slice(0, 10);
}

const budgetLineSchema = z.object({
  item: z.string(),
  category: z.string(),
  quantity: z.number(),
  unitCost: z.number(),
  justification: z.string(),
  quoteSource: z.string(),
});

/**
 * PLAN-LOCAL. `applicationId` is required and the draft text is read from that row, never
 * from the request body: spec §10.4's fact checklist has to gate the export itself, not the
 * browser button in front of it. `subtitle` is the only cosmetic field the caller may set.
 */
const draftBodySchema = z.object({
  applicationId: z.string().min(1),
  programId: z.string().min(1),
  subtitle: z.string().optional(),
  budgetLines: z.array(budgetLineSchema).optional(),
});

type DraftBody = z.infer<typeof draftBodySchema>;

/** Plan 4 throws `Object.assign(new Error(msg), { status })`; map it onto the one envelope. */
function toAppError(error: unknown): AppError {
  const status = (error as { status?: number }).status;
  const message = error instanceof Error ? error.message : 'export failed';
  if (status === 409) return new AppError('conflict', message);
  if (status === 404) return new AppError('not_found', message);
  return new AppError('internal', message);
}

export function createExportsRouter(deps: ExportDeps): Router {
  const router = Router();

  router.get('/exports/opportunities.csv', deps.requireAuth, (req, res) => {
    const now = deps.now();
    const cycles = cyclesByProgram(deps, now);
    const programs = applyExportFilter(deps.data.listPrograms(), parseExportFilter(req.query as Record<string, unknown>), cycles);
    attach(res, `grantspotter-opportunities-${stamp(now)}.csv`, 'text/csv; charset=utf-8');
    res.send(programsToCsv(programs, deps.data.listFunders(), cycles));
  });

  router.get('/exports/opportunities.xlsx', deps.requireAuth, async (req, res) => {
    const now = deps.now();
    const cycles = cyclesByProgram(deps, now);
    const programs = applyExportFilter(deps.data.listPrograms(), parseExportFilter(req.query as Record<string, unknown>), cycles);
    const buffer = await programsToXlsx(programs, deps.data.listFunders(), cycles);
    attach(res, `grantspotter-opportunities-${stamp(now)}.xlsx`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  });

  const eligibility = (req: Request): ReturnType<typeof buildEligibilityReport> | undefined => {
    const userId = deps.userIdOf(req);
    if (!userId) return undefined;
    const profile = deps.data.getProfile(userId);
    if (!profile) return undefined;
    const now = deps.now();
    const cycles = cyclesByProgram(deps, now);
    const programs = applyExportFilter(deps.data.listPrograms(), parseExportFilter(req.query as Record<string, unknown>), cycles);
    return buildEligibilityReport(profile, programs, deps.data.listFunders(), cycles, now);
  };

  const NO_PROFILE = 'Set up a profile first; there is nothing to match against.';

  router.get('/exports/eligibility.csv', deps.requireAuth, (req, res, next) => {
    const report = eligibility(req);
    if (!report) { next(new AppError('conflict', NO_PROFILE)); return; }
    attach(res, `grantspotter-eligibility-${stamp(deps.now())}.csv`, 'text/csv; charset=utf-8');
    res.send(eligibilityReportToCsv(report));
  });

  router.get('/exports/eligibility.html', deps.requireAuth, (req, res, next) => {
    const report = eligibility(req);
    if (!report) { next(new AppError('conflict', NO_PROFILE)); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(renderEligibilityReportHtml(report));
  });

  router.get('/exports/deadlines.ics', deps.requireAuth, (req, res) => {
    const now = deps.now();
    const userId = deps.userIdOf(req);
    const watchedOnly = req.query.watched === '1' && userId !== undefined;
    const watched = watchedOnly ? new Set(deps.data.listWatchedProgramIds(userId!)) : undefined;
    const programs = deps.data.listPrograms().filter((p) => !watched || watched.has(p.id));
    const programsById = new Map(programs.map((p) => [p.id, p]));
    const { from, to } = windowAround(now);
    const cycles = deps.data.listCycles(from, to).filter((c) => programsById.has(c.programId));
    attach(res, `grantspotter-deadlines-${stamp(now)}.ics`, 'text/calendar; charset=utf-8');
    res.send(buildIcsCalendar({
      calendarName: watchedOnly ? 'GrantSpotter watchlist' : 'GrantSpotter deadlines',
      cycles, programsById, nowISO: now,
    }));
  });

  router.get('/exports/ics-token', deps.requireAuth, (req, res, next) => {
    const userId = deps.userIdOf(req);
    if (!userId) { next(new AppError('unauthorized', 'Not signed in.')); return; }
    if (!deps.data.getTokenHash(userId)) {
      next(new AppError('not_found', 'No calendar feed has been created for this account yet.'));
      return;
    }
    res.json({ url: `${deps.publicBaseUrl(req)}/calendar/<your token>.ics`, hasToken: true });
  });

  router.post('/exports/ics-token', deps.requireAuth, (req, res, next) => {
    const userId = deps.userIdOf(req);
    if (!userId) { next(new AppError('unauthorized', 'Not signed in.')); return; }
    const token = newIcsToken();
    deps.data.upsertToken(userId, hashIcsToken(token), deps.now());
    // The plaintext token is shown exactly once; only its hash is stored.
    res.json({ url: `${deps.publicBaseUrl(req)}/calendar/${token}.ics`, token });
  });

  router.delete('/exports/ics-token', deps.requireAuth, (req, res) => {
    const userId = deps.userIdOf(req);
    if (userId) deps.data.revokeToken(userId, deps.now());
    res.status(204).end();
  });

  /**
   * THE EXPORT GATE. The draft text, title, fact confirmations and disclosure flag all come
   * from the `applications` row; `assertExportReady` throws 409 while any factual assertion
   * is unconfirmed or any `[TODO: …]` marker survives. A zod failure here surfaces as 422
   * through Plan 1's errorHandler, which understands ZodError natively.
   */
  const readDraft = (
    req: Request,
  ): { application: ApplicationRow; program: Program; draft: ReturnType<typeof markdownToDraft>; lines: BudgetLine[] } => {
    const body: DraftBody = draftBodySchema.parse(req.body ?? {});
    const userId = deps.userIdOf(req);
    if (!userId) throw new AppError('unauthorized', 'Not signed in.');

    const program = deps.data.listPrograms().find((p) => p.id === body.programId);
    if (!program) throw new AppError('bad_request', `Unknown programId "${body.programId}".`);

    const db = deps.data.rawDb();
    const application = getApplication(db, body.applicationId, userId);
    if (!application) throw new AppError('not_found', 'No such application draft.');

    try {
      assertExportReady(db, body.applicationId, userId);
    } catch (error) {
      throw toAppError(error);
    }

    const draft = markdownToDraft(application.bodyMarkdown, {
      title: application.title || program.name,
      subtitle: body.subtitle,
      factChecklist: Object.values(application.factConfirmations)
        .filter((c) => c.note.trim().length > 0)
        .map((c) => c.note.trim()),
      disclosure: application.includeDisclosure
        ? 'Portions of this application were drafted with the assistance of a large language model; every fact was verified by the applicant.'
        : undefined,
      provenanceNote:
        `Generated by GrantSpotter on ${stamp(deps.now())}. Source: ${program.trust.sourceUrl} ` +
        `(last verified ${program.trust.lastVerifiedAt}). Every figure in this document is the applicant's responsibility.`,
    });
    return { application, program, draft, lines: body.budgetLines ?? [] };
  };

  router.post('/exports/draft.docx', deps.requireAuth, asyncHandler(async (req, res) => {
    const parsed = readDraft(req);
    const buffer = await draftToDocx(parsed.draft);
    attach(res, `grantspotter-draft-${parsed.application.id}.docx`,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.send(buffer);
  }));

  // Spec §11.3 lists the application draft as "DOCX, Markdown". Same row, same gate.
  router.post('/exports/draft.md', deps.requireAuth, (req, res) => {
    const parsed = readDraft(req);
    attach(res, `grantspotter-draft-${parsed.application.id}.md`, 'text/markdown; charset=utf-8');
    res.send(draftToMarkdown(parsed.draft));
  });

  router.post('/exports/packet.zip', deps.requireAuth, asyncHandler(async (req, res) => {
    const parsed = readDraft(req);
    const funder = deps.data.listFunders().find((f) => f.id === parsed.program.funderId);
    const zip = await buildApplicationPacket({
      program: parsed.program, funder, draft: parsed.draft,
      budgetLines: parsed.lines, generatedAtISO: deps.now(),
    });
    attach(res, `grantspotter-packet-${parsed.program.id}.zip`, 'application/zip');
    res.send(Buffer.from(zip));
  }));

  router.get('/admin/backup.json', deps.requireAuth, deps.requireAdmin, (_req, res) => {
    const backup = exportBackup(deps.data.rawDb(), deps.now());
    attach(res, `grantspotter-backup-${stamp(deps.now())}.json`, 'application/json; charset=utf-8');
    res.send(JSON.stringify(backup));
  });

  router.post('/admin/restore', deps.requireAuth, deps.requireAdmin, (req, res, next) => {
    try {
      res.json(restoreBackup(deps.data.rawDb(), req.body));
    } catch (error) {
      next(new AppError('bad_request', error instanceof Error ? error.message : 'Restore failed.'));
    }
  });

  return router;
}

export function createCalendarFeedRouter(deps: ExportDeps): Router {
  const router = Router();

  // No inline regex in the path: Express 5's path-to-regexp v8 rejects it.
  // The handler strips a trailing .ics so both /calendar/<t> and /calendar/<t>.ics work.
  router.get('/calendar/:token', (req, res, next) => {
    const raw = String(req.params.token ?? '');
    const token = raw.endsWith('.ics') ? raw.slice(0, -4) : raw;
    const userId = deps.data.getUserIdForTokenHash(hashIcsToken(token));
    // Deliberately the same answer for "never existed" and "revoked": a calendar client is
    // an unauthenticated caller and must not learn which of the two it is.
    if (!userId) { next(new AppError('not_found', 'No calendar feed matches this token.')); return; }

    const now = deps.now();
    const watched = new Set(deps.data.listWatchedProgramIds(userId));
    const all = deps.data.listPrograms();
    const programs = watched.size > 0 ? all.filter((p) => watched.has(p.id)) : all;
    const programsById = new Map(programs.map((p) => [p.id, p]));
    const { from, to } = windowAround(now);
    const cycles = deps.data.listCycles(from, to).filter((c) => programsById.has(c.programId));

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buildIcsCalendar({ calendarName: 'GrantSpotter', cycles, programsById, nowISO: now }));
  });

  return router;
}
```

- [ ] **Step 8: Run the route test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/api/exports.test.ts
```

Expected: 22 passing tests.

- [ ] **Step 9: Mount both routers in the shared hook (RESOLUTIONS R5, R22, R25)**

**Nothing in this task calls `app.use(...)` on the returned app, and nothing in it edits
`packages/server/src/api/index.ts`.** Plan 1's `createApp` seals the app with `notFoundHandler()`,
so the only place a router can be registered is Plan 3 Task 14's `AppDeps.mountRoutes` callback in
`packages/server/src/index.ts`. That callback is filled **incrementally** (RESOLUTIONS R25): Plan 3
mounted its own routers and closed the callback with a comment reserving the final position for the
SPA middleware, Plan 4 Task 17 added its four `create*Router(routerDeps)` lines, and **this step
adds the two export mounts** — above that reserved comment, because Express matches in registration
order and the SPA fallback must stay last.

Open `packages/server/src/index.ts` and make three edits, all of them inside `main()`.

**9a. Add the imports** next to the ones Plan 3 and Plan 4 already put there:

```ts
// Plan 5: export routes (csv/xlsx/ics/docx/md/zip + admin backup/restore) and the
// token-authenticated public ICS feed, which is mounted at the ROOT because a
// subscribing calendar client cannot send a session cookie.
import { createExportsRouter, createCalendarFeedRouter } from './api/exports.js';
import { createSqliteExportDataSource } from './exports/dataSource.js';
```

`Request` is already imported from `express` in that file (Plan 3's `currentUser` needs it). If it
is not, add `import type { Request } from 'express';`.

**9b. Build `exportDeps` inline**, immediately after Plan 3's `routerDeps` const and before
`const app = createApp({ … })`:

```ts
// PLAN-LOCAL dependency bundle, satisfying the ExportDeps interface exported by
// api/exports.ts. Built inline: there is deliberately no createExportDeps factory,
// because a second definition of the same bundle is a second thing to keep in sync
// (RESOLUTIONS R22).
const exportDeps = {
  data: createSqliteExportDataSource(db),
  requireAuth: requireAuth(),
  requireAdmin: requireAdmin(),
  now,
  // req.auth is populated by Plan 1's attachUser middleware through a module
  // augmentation of Express's Request. THERE IS NO express-session IN THIS STACK:
  // an express-session style `session` property does not exist on Request, does
  // not compile, and must appear nowhere (R22). Plan 1's own `sessionKey`
  // property on Request is a different, legitimate thing and is not affected.
  userIdOf: (req: Request) => req.auth?.id,
  publicBaseUrl: (req: Request) => `${req.protocol}://${req.get('host') ?? '127.0.0.1'}`,
};
```

`requireAuth`, `requireAdmin` and `now` are the same values Plan 3 already built for `routerDeps`;
reuse them rather than constructing a second pair.

**9c. Insert the two mount lines** into the `mountRoutes` callback, **above** the reserved-position
comment Plan 3 left at the end of it:

```ts
  mountRoutes: (a) => {
    // … Plan 3's mountProductApi(…) call and Plan 4's four routers stay exactly as they are …

    // --- Plan 5: exports, and the public ICS feed at the root ---
    // '/api' + the router's own '/exports/…' paths give /api/exports/opportunities.csv.
    // The feed router owns '/calendar/:token' and is mounted at '/' on purpose.
    a.use('/api', createExportsRouter(exportDeps));
    a.use('/', createCalendarFeedRouter(exportDeps));

    // --- reserved: the built SPA goes here, LAST. Plan 5 Task 17 adds it. ---
  },
```

Do not move, rewrite or delete the reserved comment *in this task*: Task 17 Step 5 replaces that
whole reservation block — Plan 3's quoted worked example **and** its dashed closing banner — with
`a.use(createSpaMiddleware(webDistRoot()));`, and nothing may be registered after that line. If the
callback ends without that comment, put these two lines at the very end of it and write the comment
in yourself — the position it reserves is what keeps the SPA fallback from shadowing `/api`.

Run all three gates:

```bash
cd /path/to/grantspotter
grep -n "createExportsRouter(exportDeps)\|createCalendarFeedRouter(exportDeps)" packages/server/src/index.ts
grep -n "a\.use(" packages/server/src/index.ts
! grep -rnE "req\.session\b" packages/server/src && echo "no express-session references — correct"
```

Expected: the first grep prints both mount lines; the second shows them after Plan 4's four
`/api/...` mounts and before the reserved comment; the third prints the "no express-session" line.
If a mount line is missing, every route in the table above answers 404 through Plan 1's
`notFoundHandler` and **no test in this task would catch it**, because this task's tests mount the
routers onto their own bare express app.

**The third gate is anchored with `\b` on purpose, and the anchor is load-bearing.** Plan 1's
`attachUser` sets **`req.sessionKey`** in `packages/server/src/auth/middleware.ts`, and Plan 1's
logout route reads it back (`if (req.sessionKey !== undefined) sessions.remove(req.sessionKey);`)
to revoke the session row. That property is legitimate, it is nothing to do with express-session,
and it must not be touched. An unanchored `req\.session` pattern matches `req.sessionKey`, so it
prints FAILURE against a perfectly correct tree — and an executor who "remediates" it deletes the
one thing logout depends on. `\b` requires a non-word character after `session`: `req.sessionKey`
has `K` there and does not match, while a genuine `req.session.userId` / `req.session?.userId` /
`req.session.destroy()` does. For the same reason the comment in **9b** above says "an
express-session style `session` property" rather than spelling the two-token form out — a comment
that quotes the forbidden code is indistinguishable from the forbidden code to `grep`.

- [ ] **Step 10: Prove the mounted routes answer on the real app**

The unit suite mounts the routers itself, so it cannot see a missing mount line. Boot the real
entrypoint once and ask it:

```bash
cd /path/to/grantspotter
npm run build
export GS_TMP="$(mktemp -d)"
SESSION_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")" \
CONTACT_URL="https://www.example.org/grantspotter" DATA_DIR="$GS_TMP" CRAWL_ENABLED=false PORT=3132 \
  node packages/server/dist/index.js > /tmp/gs-mount-check.log 2>&1 &
echo $! > /tmp/gs-mount-check.pid
sleep 3
curl -sS -o /dev/null -w 'export-unauthed %{http_code}\n' http://127.0.0.1:3132/api/exports/opportunities.csv
curl -sS -o /dev/null -w 'calendar-bad-token %{http_code}\n' http://127.0.0.1:3132/calendar/not-a-real-token.ics
kill "$(cat /tmp/gs-mount-check.pid)"; rm -f /tmp/gs-mount-check.pid
```

Expected: `401` or `403` for the export (the route exists and `requireAuth` rejected the caller) and
`404` for the bad token. A **`404` on the export route** means the mount line is missing — the
router was never registered and Plan 1's `notFoundHandler` answered instead. `GET /` is still a
JSON 404 at this point; that is correct until Task 17 lands.

- [ ] **Step 11: Typecheck the whole repo, then commit**

```bash
cd /path/to/grantspotter && npm run typecheck && npx vitest run packages/server/src
```

A typecheck error naming `createProgramRepo`, `createFunderRepo`, `createProfileRepo`,
`watchedProgramIds`, `getApplication` or `assertExportReady` means Plan 1, 3 or 4 exports it from
a different path — fix the import line in `dataSource.ts` or `api/exports.ts` and nothing else.

```bash
cd /path/to/grantspotter
git add packages/server/src/api packages/server/src/exports packages/server/src/db/migrations packages/server/src/index.ts
git commit -m "feat(api): gated export routes plus a hashed-token subscribable ICS feed"
```

---

### Task 10: The Exports surface in the SPA — every endpoint gets a control

**Why this task exists.** Task 9 built thirteen routes and, before this task, nothing in the
running app called any of them: `NAV` has nine entries by the time this task runs (Plan 3's seven
plus Plan 4's Templates and Applications) and **none of them is Exports**, Plan 3's
routes contain no `/api/exports` call, and Plan 4's writing desk has no download button. Spec
§11.3 lists seven export rows and all seven were unreachable from the UI. This task is the one
that makes the feature exist for a user rather than for `curl`.

**Files:**
- Create: `packages/web/src/api/exports.ts`
- Create: `packages/web/src/components/ExportMenu.tsx`
- Create: `packages/web/src/routes/Exports.tsx`
- Create: `packages/web/src/components/exports.css`
- Test: `packages/web/src/api/exports.test.ts`
- Test: `packages/web/src/routes/Exports.test.tsx`
- Modify: `packages/web/src/components/AppShell.tsx` (Plan 3 Task 15 — insert one `NAV` entry; never retype the array)
- Modify: `packages/web/src/App.tsx` (Plan 3 Task 15 — one `<Route>`)
- Modify: `packages/web/src/routes/Browse.tsx` (Plan 3 Task 17 — render `<ExportMenu filters={filters} />`)
- Modify: `packages/web/src/routes/Admin.tsx` (Plan 3 — the admin-only backup / restore panel)
- Modify: `packages/web/src/routes/Applications.tsx` (Plan 4 Task 19 — DOCX / Markdown / ZIP on the open draft)

**Interfaces:**
- Consumes: `UiFilters` and `EMPTY_FILTERS` from Plan 3's `lib/filterState.js`; `apiSend` from Plan 3's `api/client.js`; Plan 3's `routes/Admin.tsx`; Plan 4's `routes/Applications.tsx`.
- Produces (all **plan-local** to `packages/web`):
  - `export function browseFiltersToExportQuery(filters: UiFilters): URLSearchParams`
  - `export function exportHref(path: string, query?: URLSearchParams): string`
  - `export class ExportError extends Error { code: string; status: number }`
  - `export interface IcsTokenStatus { hasToken: boolean }` and `export interface IcsTokenCreated { url: string; token: string }`
  - `export function getIcsToken(): Promise<IcsTokenStatus | null>`, `createIcsToken()`, `revokeIcsToken()`
  - `export interface DraftExportBody { applicationId: string; programId: string; subtitle?: string; budgetLines?: unknown[] }`
  - `export function downloadDraftExport(kind: 'docx' | 'md' | 'zip', body: DraftExportBody): Promise<void>`
  - `export function restoreFromBackup(file: File): Promise<{ tablesRestored: string[]; rowsRestored: number }>`
  - `export function ExportMenu(props: { filters: UiFilters }): JSX.Element`
  - `export function ExportsRoute(): JSX.Element`

Two design facts worth stating before the code:

1. **GET exports are plain anchors, POST exports go through `fetch` + a blob.** A `<a download>`
   lets the browser handle `Content-Disposition` and the session cookie for free, which is why the
   CSV, XLSX, ICS and eligibility links are anchors. The three draft exports are POSTs (they carry
   an `applicationId` and a budget), so those read the response as a blob and click a synthetic
   anchor. Nothing here uses `window.open`, which popup blockers eat.
2. **The browse filter names and the export filter names are not the same.** Plan 3's `UiFilters`
   uses `entity`, `deadlineFrom` and `deadlineTo`; Task 1's `parseExportFilter` reads
   `applicantEntities`, `closesAfter` and `closesBefore`. `browseFiltersToExportQuery` is the
   translation, and it is a pure function precisely so it can be unit-tested without a DOM — a
   silent mismatch here would export the wrong rows and look like it worked.

- [ ] **Step 1: Write the failing client test**

Create `packages/web/src/api/exports.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EMPTY_FILTERS } from '../lib/filterState.js';
import {
  browseFiltersToExportQuery, exportHref, getIcsToken, createIcsToken, revokeIcsToken,
  downloadDraftExport, restoreFromBackup,
} from './exports.js';

describe('browseFiltersToExportQuery', () => {
  it('is empty for empty filters', () => {
    expect(browseFiltersToExportQuery(EMPTY_FILTERS).toString()).toBe('');
  });

  it('renames entity to applicantEntities and the deadline window to closesAfter/closesBefore', () => {
    const query = browseFiltersToExportQuery({
      ...EMPTY_FILTERS,
      entity: ['club_501c3', 'university'],
      deadlineFrom: '2026-09-01',
      deadlineTo: '2027-03-01',
    });
    expect(query.get('applicantEntities')).toBe('club_501c3,university');
    expect(query.get('closesAfter')).toBe('2026-09-01');
    expect(query.get('closesBefore')).toBe('2027-03-01');
    expect(query.get('entity')).toBeNull();
    expect(query.get('deadlineFrom')).toBeNull();
  });

  it('passes q, klass, status and instrument through unchanged', () => {
    const query = browseFiltersToExportQuery({
      ...EMPTY_FILTERS, q: 'club', klass: ['ham_grant'], status: ['open'], instrument: ['cash_range'],
    });
    expect(query.get('q')).toBe('club');
    expect(query.get('klass')).toBe('ham_grant');
    expect(query.get('status')).toBe('open');
    expect(query.get('instrument')).toBe('cash_range');
  });

  it('drops browse-only keys the export endpoint does not understand', () => {
    const query = browseFiltersToExportQuery({ ...EMPTY_FILTERS, verdict: ['ineligible'], page: 4, sort: 'name' });
    expect(query.toString()).toBe('');
  });
});

describe('exportHref', () => {
  it('appends a query only when there is one', () => {
    expect(exportHref('/api/exports/opportunities.csv')).toBe('/api/exports/opportunities.csv');
    expect(exportHref('/api/exports/opportunities.csv', new URLSearchParams({ q: 'ardc' })))
      .toBe('/api/exports/opportunities.csv?q=ardc');
  });
});

describe('the ICS token endpoints', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reads null when no feed exists yet rather than throwing', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'not_found', message: 'none' }, requestId: 'r1' }),
      { status: 404, headers: { 'content-type': 'application/json' } },
    ));
    await expect(getIcsToken()).resolves.toBeNull();
  });

  it('creates a feed and returns the one-time URL', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ url: 'http://127.0.0.1:3030/calendar/abc.ics', token: 'abc' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await expect(createIcsToken()).resolves.toEqual({ url: 'http://127.0.0.1:3030/calendar/abc.ics', token: 'abc' });
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ method: 'POST' });
  });

  it('revokes with a DELETE', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await revokeIcsToken();
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });
});

describe('downloadDraftExport', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts the applicationId and never the draft text', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(new Blob(['x']), {
      status: 200,
      headers: { 'content-type': 'text/markdown', 'content-disposition': 'attachment; filename="d.md"' },
    }));
    await downloadDraftExport('md', { applicationId: 'a-1', programId: 'ardc-grants' });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/exports/draft.md');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ applicationId: 'a-1', programId: 'ardc-grants' });
    expect(String((init as RequestInit).body)).not.toContain('markdown');
  });

  it('surfaces the 409 message so the user is told which fact is unconfirmed', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ error: { code: 'conflict', message: '2 unconfirmed factual assertion(s)' }, requestId: 'r2' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ));
    await expect(downloadDraftExport('docx', { applicationId: 'a-1', programId: 'ardc-grants' }))
      .rejects.toThrow(/unconfirmed factual assertion/);
  });
});

describe('restoreFromBackup', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends the parsed file as JSON and returns the counts', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(
      JSON.stringify({ tablesRestored: ['funders'], rowsRestored: 26 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const file = new File([JSON.stringify({ app: 'grantspotter', formatVersion: 1, exportedAt: '', tables: {} })],
      'backup.json', { type: 'application/json' });
    await expect(restoreFromBackup(file)).resolves.toEqual({ tablesRestored: ['funders'], rowsRestored: 26 });
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/web/src/api/exports.test.ts
```

Expected failure: `Failed to load url ./exports.js`.

- [ ] **Step 3: Write the typed client**

Create `packages/web/src/api/exports.ts`:

```ts
import type { UiFilters } from '../lib/filterState.js';
import { apiSend } from './client.js';

/**
 * PLAN-LOCAL. The binary export calls read blobs, not JSON, so they cannot go through
 * `apiSend`. This carries the server's own message — "3 unconfirmed factual assertion(s)…" —
 * into `error.message`, which is what the UI shows the user. It deliberately does not
 * subclass Plan 3's `ApiError`, whose constructor argument order is still settling between
 * Plan 1's canonical five-argument form and Plan 3's three-argument one.
 */
export class ExportError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = 'ExportError';
  }
}

/**
 * Browse and export use different query vocabularies on purpose: Plan 3 owns the browse
 * filter, Task 1 owns ExportFilter. This is the only translation between them.
 * Browse-only keys (verdict, sort, page, includeRolling, amountMin/Max) are dropped —
 * the export endpoint would ignore them and a stray key hides a real mismatch.
 */
export function browseFiltersToExportQuery(filters: UiFilters): URLSearchParams {
  const query = new URLSearchParams();
  if (filters.q) query.set('q', filters.q);
  if (filters.klass.length > 0) query.set('klass', filters.klass.join(','));
  if (filters.status.length > 0) query.set('status', filters.status.join(','));
  if (filters.instrument.length > 0) query.set('instrument', filters.instrument.join(','));
  if (filters.entity.length > 0) query.set('applicantEntities', filters.entity.join(','));
  if (filters.deadlineFrom) query.set('closesAfter', filters.deadlineFrom);
  if (filters.deadlineTo) query.set('closesBefore', filters.deadlineTo);
  return query;
}

export function exportHref(path: string, query?: URLSearchParams): string {
  const qs = query?.toString() ?? '';
  return qs === '' ? path : `${path}?${qs}`;
}

export interface IcsTokenStatus { hasToken: boolean }
export interface IcsTokenCreated { url: string; token: string }

/** 404 means "no feed yet", which is a state, not an error. */
export async function getIcsToken(): Promise<IcsTokenStatus | null> {
  const response = await fetch('/api/exports/ics-token', {
    method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw await toExportError(response);
  return await response.json() as IcsTokenStatus;
}

export async function createIcsToken(): Promise<IcsTokenCreated> {
  return apiSend<IcsTokenCreated>('POST', '/api/exports/ics-token');
}

export async function revokeIcsToken(): Promise<void> {
  await apiSend<null>('DELETE', '/api/exports/ics-token');
}

export interface DraftExportBody {
  applicationId: string;
  programId: string;
  subtitle?: string;
  budgetLines?: unknown[];
}

const DRAFT_PATHS: Record<'docx' | 'md' | 'zip', string> = {
  docx: '/api/exports/draft.docx',
  md: '/api/exports/draft.md',
  zip: '/api/exports/packet.zip',
};

async function toExportError(response: Response): Promise<ExportError> {
  let code = 'internal';
  let message = 'request failed';
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    /* a non-JSON error body stays generic */
  }
  return new ExportError(message, code, response.status);
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function filenameFrom(response: Response, fallback: string): string {
  const disposition = response.headers.get('content-disposition') ?? '';
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallback;
}

/** The server reads the draft from the applications row; this sends only the id. */
export async function downloadDraftExport(kind: 'docx' | 'md' | 'zip', body: DraftExportBody): Promise<void> {
  const response = await fetch(DRAFT_PATHS[kind], {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: '*/*' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await toExportError(response);
  saveBlob(await response.blob(), filenameFrom(response, `grantspotter-draft.${kind}`));
}

export async function restoreFromBackup(file: File): Promise<{ tablesRestored: string[]; rowsRestored: number }> {
  const parsed = JSON.parse(await file.text()) as unknown;
  return apiSend<{ tablesRestored: string[]; rowsRestored: number }>('POST', '/api/admin/restore', parsed);
}
```

`apiSend` is Plan 3's thin wrapper over Plan 1's `apiFetch` (RESOLUTIONS R11) and throws
`ApiError` on its own; the JSON-shaped calls above use it unchanged. The blob and 404-is-a-state
paths call `fetch` directly and raise `ExportError`, so nothing here depends on which `ApiError`
constructor signature survives R11.

- [ ] **Step 4: Run the client test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/web/src/api/exports.test.ts
```

Expected: 11 passing tests.

- [ ] **Step 5: Write the failing route test**

Create `packages/web/src/routes/Exports.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ExportsRoute } from './Exports.js';
import { ExportMenu } from '../components/ExportMenu.js';
import { EMPTY_FILTERS } from '../lib/filterState.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('ExportMenu', () => {
  it('carries the current browse filters into every download link', () => {
    render(
      <MemoryRouter>
        <ExportMenu filters={{ ...EMPTY_FILTERS, q: 'club', klass: ['ham_grant'], entity: ['club_501c3'] }} />
      </MemoryRouter>,
    );
    const csv = screen.getByRole('link', { name: /csv/i });
    expect(csv).toHaveAttribute('href', expect.stringContaining('/api/exports/opportunities.csv?'));
    expect(csv.getAttribute('href')).toContain('q=club');
    expect(csv.getAttribute('href')).toContain('klass=ham_grant');
    expect(csv.getAttribute('href')).toContain('applicantEntities=club_501c3');
    expect(screen.getByRole('link', { name: /xlsx/i }).getAttribute('href')).toContain('opportunities.xlsx?');
  });

  it('says out loud that the download is the filtered view, not the whole corpus', () => {
    render(<MemoryRouter><ExportMenu filters={EMPTY_FILTERS} /></MemoryRouter>);
    expect(screen.getByText(/exports exactly what the filters above are showing/i)).toBeInTheDocument();
  });
});

describe('ExportsRoute', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('offers the opportunity, eligibility and calendar downloads', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: /opportunities \(csv\)/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /opportunities \(xlsx\)/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /eligibility report \(csv\)/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /printable eligibility report/i })).toBeInTheDocument();
    // Anchored: there are two one-off links, the whole corpus and the watchlist.
    expect(screen.getByRole('link', { name: /^one-off \.ics$/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^one-off \.ics \(watchlist only\)$/i })).toBeInTheDocument();
  });

  it('shows the subscribe URL exactly once, after creating a feed', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404))
      .mockResolvedValueOnce(jsonResponse({ url: 'http://127.0.0.1:3030/calendar/abc.ics', token: 'abc' }));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);

    await userEvent.click(await screen.findByRole('button', { name: /create a calendar feed/i }));
    const field = await screen.findByLabelText(/subscribe url/i);
    expect(field).toHaveValue('http://127.0.0.1:3030/calendar/abc.ics');
    expect(screen.getByText(/shown once/i)).toBeInTheDocument();
  });

  it('reports that a feed already exists without pretending to know the URL', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ hasToken: true }));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/a calendar feed already exists/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rotate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
  });

  it('explains what PDF means here instead of offering a fake PDF button', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: { code: 'not_found', message: 'none' } }, 404));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/Print \/ Save as PDF/)).toBeInTheDocument();
  });

  it('surfaces a 409 from the eligibility export as the profile prompt', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ hasToken: true }));
    render(<MemoryRouter><ExportsRoute /></MemoryRouter>);
    expect(await screen.findByText(/needs a profile/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/web/src/routes/Exports.test.tsx
```

Expected failure: `Failed to load url ./Exports.js`.

- [ ] **Step 7: Write the export menu and the Exports route**

Create `packages/web/src/components/exports.css`:

```css
.exports-stack { display: grid; gap: var(--s-5); max-width: 68ch; }
.export-menu { display: flex; flex-wrap: wrap; gap: var(--s-2); align-items: center; margin: var(--s-4) 0; }
.export-menu .eyebrow { flex-basis: 100%; }
.export-links { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.token-field { width: 100%; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; padding: var(--s-2); }
.export-note { color: var(--muted); font-size: var(--fs-200); max-width: 62ch; }
```

Create `packages/web/src/components/ExportMenu.tsx`:

```tsx
import type { UiFilters } from '../lib/filterState.js';
import { browseFiltersToExportQuery, exportHref } from '../api/exports.js';
import './exports.css';

/** Sits above the browse table: the same rows the user is looking at, as a file. */
export function ExportMenu({ filters }: { filters: UiFilters }): JSX.Element {
  const query = browseFiltersToExportQuery(filters);
  return (
    <div className="export-menu no-print">
      <span className="eyebrow">Export this view</span>
      <div className="export-links">
        <a className="btn" download href={exportHref('/api/exports/opportunities.csv', query)}>CSV</a>
        <a className="btn" download href={exportHref('/api/exports/opportunities.xlsx', query)}>XLSX</a>
        <a className="btn" download href={exportHref('/api/exports/deadlines.ics', query)}>Deadlines (.ics)</a>
      </div>
      <p className="export-note">
        Exports exactly what the filters above are showing, with the funder name, the next close
        date and each record&rsquo;s last-verified provenance. The XLSX carries a second
        Provenance sheet so the source URL travels with the file.
      </p>
    </div>
  );
}
```

Create `packages/web/src/routes/Exports.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  createIcsToken, getIcsToken, revokeIcsToken, exportHref,
  type IcsTokenCreated,
} from '../api/exports.js';
import '../components/exports.css';

export function ExportsRoute(): JSX.Element {
  const [hasToken, setHasToken] = useState<boolean | null>(null);
  const [created, setCreated] = useState<IcsTokenCreated | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getIcsToken()
      .then((status) => setHasToken(status !== null))
      .catch((err: Error) => setError(err.message));
  }, []);

  async function create(): Promise<void> {
    setError(null);
    try {
      const result = await createIcsToken();
      setCreated(result);
      setHasToken(true);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(): Promise<void> {
    setError(null);
    try {
      await revokeIcsToken();
      setCreated(null);
      setHasToken(false);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="exports-stack">
      <div>
        <p className="eyebrow">Exports</p>
        <h1>Take it with you</h1>
      </div>

      {error !== null && <p role="alert" className="row-warning">{error}</p>}

      <section className="panel card" aria-label="Opportunities">
        <h2>Opportunities</h2>
        <p className="export-note">
          These download the whole corpus. To export a narrower slice, set the filters on{' '}
          <Link to="/">Browse</Link> and use the export row there.
        </p>
        <div className="export-links">
          <a className="btn" download href={exportHref('/api/exports/opportunities.csv')}>Opportunities (CSV)</a>
          <a className="btn" download href={exportHref('/api/exports/opportunities.xlsx')}>Opportunities (XLSX)</a>
        </div>
      </section>

      <section className="panel card" aria-label="Eligibility report">
        <h2>Eligibility report</h2>
        <p className="export-note">
          &ldquo;Here is what I am eligible for, and the specific constraint that excludes me from
          the rest.&rdquo; It needs a profile — the report is computed against yours, so{' '}
          <Link to="/profile">set one up</Link> first if you have not.
        </p>
        <div className="export-links">
          <a className="btn" download href={exportHref('/api/exports/eligibility.csv')}>Eligibility report (CSV)</a>
          <a className="btn" target="_blank" rel="noopener noreferrer" href={exportHref('/api/exports/eligibility.html')}>
            Printable eligibility report
          </a>
        </div>
        <p className="export-note">
          The printable report opens in a new tab with its own <strong>Print / Save as PDF</strong>{' '}
          button. There is no server-side PDF renderer and deliberately no headless browser in the
          image; your own browser makes a better-looking file.
        </p>
      </section>

      <section className="panel card" aria-label="Add to calendar">
        <h2>Add to calendar</h2>
        <p className="export-note">
          A one-off <code>.ics</code> is a snapshot: it stops being true the moment a funder moves a
          date. The subscribable feed is the one that keeps working — your phone re-reads it about
          every twelve hours.
        </p>
        <div className="export-links">
          <a className="btn" download href={exportHref('/api/exports/deadlines.ics')}>One-off .ics</a>
          <a className="btn" download href={exportHref('/api/exports/deadlines.ics', new URLSearchParams({ watched: '1' }))}>
            One-off .ics (watchlist only)
          </a>
        </div>

        {hasToken === null && <p className="eyebrow">Checking…</p>}

        {hasToken === false && (
          <p>
            <button type="button" className="btn btn-primary" onClick={() => { void create(); }}>
              Create a calendar feed
            </button>
          </p>
        )}

        {created !== null && (
          <p>
            <label htmlFor="ics-url" className="eyebrow">Subscribe URL</label>
            <input id="ics-url" className="token-field" readOnly value={created.url} />
            <span className="export-note">
              This is shown once and only once: the server stores a SHA-256 hash of the token, never
              the token. Lost it? Rotate, and re-subscribe with the new URL.
            </span>
          </p>
        )}

        {hasToken === true && created === null && (
          <p className="export-note">A calendar feed already exists for this account. Its URL was shown once, at creation.</p>
        )}

        {hasToken === true && (
          <div className="export-links">
            <button type="button" className="btn" onClick={() => { void create(); }}>Rotate the feed URL</button>
            <button type="button" className="btn" onClick={() => { void revoke(); }}>Revoke the feed</button>
          </div>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 8: Put it in the navigation and the router**

**`NAV` is append-only — do not retype the array (RESOLUTIONS R18).** In
`packages/web/src/components/AppShell.tsx` (Plan 3 Task 15), insert **exactly one line** into the
existing `const NAV: NavItem[] = [ … ]`, immediately after the Calendar entry, where a user
looking for "the file version of what I am seeing" will look:

```tsx
  { to: '/exports', label: 'Exports', end: false },
```

By the time this task runs that array holds nine entries: Plan 3 contributes Browse, Calendar,
Watchlist, Inbox, Sources, Profile and **Admin** (`{ to: '/admin', label: 'Admin', end: false,
adminOnly: true }`), and Plan 4 Task 18 contributes **Templates** and **Applications**. Pasting a
replacement array deletes whichever of those the paste was written before — the admin console and
the whole writing desk vanish from the rail — and dropping the `NavItem` type annotation breaks
`AppShell`'s `NAV.filter((item) => item.adminOnly !== true || …)`, because `adminOnly` is no
longer on the inferred element type. Insert the one line; change nothing else about the
declaration.

Verify the insert did not eat anything:

```bash
cd /path/to/grantspotter
grep -c "  { to: '/" packages/web/src/components/AppShell.tsx    # expect 10
grep -n "NAV: NavItem\[\]\|adminOnly: true\|'/templates'\|'/applications'\|'/exports'" \
  packages/web/src/components/AppShell.tsx
```

Expected: the count is 10, and the second grep prints the typed declaration, the Admin entry, the
Templates and Applications entries, and the new Exports entry.

In `packages/web/src/App.tsx` (Plan 3 Task 15), add the import and the route beside Plan 3's:

```tsx
import { ExportsRoute } from './routes/Exports.js';
// …
        <Route path="/exports" element={<ExportsRoute />} />
```

In `packages/web/src/routes/Browse.tsx`, import the menu and render it immediately above the
results, inside the right-hand column and after the census block:

```tsx
import { ExportMenu } from '../components/ExportMenu.js';
// …
          <ExportMenu filters={filters} />
```

- [ ] **Step 9: Add the draft exports to the writing desk**

Open `packages/web/src/routes/Applications.tsx` (Plan 4 Task 19). Import the client and render
three buttons next to the existing prose-check button, inside the `{current ? (…)}` branch:

```tsx
import { downloadDraftExport } from '../api/exports.js';
```

```tsx
              <div className="export-links">
                <button
                  type="button"
                  onClick={() => {
                    void downloadDraftExport('docx', { applicationId: current.id, programId: current.programId ?? '' })
                      .catch((err: Error) => setError(err.message));
                  }}
                >
                  Download DOCX
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void downloadDraftExport('md', { applicationId: current.id, programId: current.programId ?? '' })
                      .catch((err: Error) => setError(err.message));
                  }}
                >
                  Download Markdown
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void downloadDraftExport('zip', { applicationId: current.id, programId: current.programId ?? '' })
                      .catch((err: Error) => setError(err.message));
                  }}
                >
                  Download application packet (ZIP)
                </button>
              </div>
              {readiness && !readiness.ready && (
                <p className="export-note">
                  Exports are blocked until every item in the fact checklist below is confirmed and
                  every <code>[TODO: …]</code> marker is resolved: {readiness.unconfirmed} unconfirmed,{' '}
                  {readiness.openTodos} open. That rule is enforced on the server, not just here.
                </p>
              )}
```

The `catch` writes into Plan 4's existing `error` state, so a 409 from the server renders as the
message the server sent — *"N unconfirmed factual assertion(s) and M unresolved [TODO:] marker(s)
must be handled before export"* — rather than a silent no-op download.

- [ ] **Step 10: Add the admin backup and restore panel**

Open `packages/web/src/routes/Admin.tsx` (Plan 3's admin screen, which owns user management and
is already behind an admin-only route). Add a section at the bottom:

```tsx
import { useState } from 'react';
import { exportHref, restoreFromBackup } from '../api/exports.js';

export function BackupPanel(): JSX.Element {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onRestore(file: File | undefined): Promise<void> {
    if (!file) return;
    setResult(null);
    setError(null);
    try {
      const counts = await restoreFromBackup(file);
      setResult(`Restored ${counts.rowsRestored} rows across ${counts.tablesRestored.length} tables.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section className="panel card" aria-label="Backup and restore">
      <h2>Backup and restore</h2>
      <p className="export-note">
        The backup is every table in the database except <code>sessions</code>, as JSON. Restoring
        <strong> replaces</strong> the contents of every table named in the file, including reviewed
        records and application drafts. Sessions are excluded deliberately: restoring live sessions
        would resurrect logged-in browsers from a backup.
      </p>
      <div className="export-links">
        <a className="btn" download href={exportHref('/api/admin/backup.json')}>Download backup (JSON)</a>
      </div>
      <p>
        <label htmlFor="restore-file" className="eyebrow">Restore from a backup file</label>
        <input
          id="restore-file"
          type="file"
          accept="application/json,.json"
          onChange={(e) => { void onRestore(e.target.files?.[0]); }}
        />
      </p>
      {result !== null && <p role="status">{result}</p>}
      {error !== null && <p role="alert" className="row-warning">{error}</p>}
    </section>
  );
}
```

and render `<BackupPanel />` at the end of Plan 3's `Admin` component. Both routes are already
admin-guarded on the server (`requireAdmin`), so this panel is a convenience, not the access
control.

- [ ] **Step 11: Run the whole web suite, typecheck, and build**

```bash
cd /path/to/grantspotter && npx vitest run packages/web/src && npm run typecheck && npm run build
```

Expected: the new suites green (11 in `api/exports.test.ts`, 7 in `routes/Exports.test.tsx`) and
no regression in Plan 3's or Plan 4's web tests. A failure in Plan 3's `AppShell.test.tsx`
asserting the exact `NAV` length is a real signal — update that assertion to include Exports.

- [ ] **Step 12: Commit**

```bash
cd /path/to/grantspotter
git add packages/web/src
git commit -m "feat(web): Exports route, browse export menu, draft downloads and admin backup/restore"
```

---

### Task 11: Seed loader, validation harness, funders, and the four anchor programs

**Files:**
- Create: `data/seed/funders.json`
- Create: `data/seed/programs.curated.json`
- Create: `packages/server/src/seed/load.ts`
- Test: `packages/server/src/seed/seed.test.ts`

**Interfaces:**
- Consumes: `programSchema`, `funderSchema` (zod, lower-camel per RESOLUTIONS R7, from `core/schema.ts` via the `@grantspotter/core` barrel), `hashProgram`, `matchProgram`, `expandCycles`, `Program`, `Funder` from `@grantspotter/core`; `assertNotBlocked` from Plan 2's `fetcher/blocklist.ts`.
- Produces:
  - `export interface SeedSourceKey { sourceId: string; externalKey: string }` — **plan-local**
  - `export interface SeedCorpus { funders: Funder[]; programs: Program[]; sourceKeys: Map<string, SeedSourceKey> }` — **plan-local**
  - `export function seedDir(): string` — resolves `data/seed` from the compiled server location
  - `export function loadSeedCorpus(dir?: string): SeedCorpus` — reads every `*.json`, validates through zod, fills `trust.contentHash` via `hashProgram`, collects each record's `sourceKey`, throws on the first malformed record
  - `export const SEED_LAST_VERIFIED = '2026-08-02'`

**The `sourceKey` field, and why every seed record carries one (RESOLUTIONS R9).** The seed corpus
owns program identity. Without a stable link back to the source that produced a record, Plan 2's
`normalizeRaw` mints a fresh id from `programIdFor(sourceId, externalKey)` on the very first
nightly crawl and the whole corpus is duplicated — twice on night two. So each seed record carries
`"sourceKey": { "sourceId": …, "externalKey": … }` **copied verbatim from the Plan 2 source module
that re-reads it**, the loader collects those pairs, and Task 16's importer writes them into the
`programs.source_id` / `programs.external_key` columns Plan 1 added. `normalizeRaw` then resolves
the existing id instead of minting one.

`sourceKey` is deliberately *not* part of `Program` — CONTRACT §3 freezes that type and the columns
live beside the record, not inside it. `programSchema` is a plain (non-strict) zod object, so it
strips the extra key on parse; the loader reads it with a separate schema over the same file.

Two records have no `sourceKey`, and that is a decision rather than an omission: the
`austin-arc` module emits a single page-level record and the seed splits Austin ARC into Copeland
and Greenwood, and the `ieee-mtts` module emits only its chapter-support record while the seed also
carries the MTT-S student awards. Duplicating a pair would violate Plan 1's partial unique index on
`(source_id, external_key)`, and inventing a pair no parser ever emits would silently fail to
reconcile while looking correct. Task 16's test asserts both facts.

Why the corpus is a set of JSON files and not TypeScript: seed records are data with provenance, they get re-verified on a schedule, and a maintainer updating a deadline must not have to compile anything. The zod validation in the loader plus the test in this task are what make that safe.

Every record in every batch carries `"contentHash": ""`. The loader computes the real hash with `hashProgram`, which by contract excludes `TrustFields` — so a hash written into the file would be stale the moment anything else changed, and the empty string is the honest placeholder-free representation of "computed at load".

- [ ] **Step 1: Write the failing seed test**

Create `packages/server/src/seed/seed.test.ts`. This file is data-driven: every later seed batch is covered by it automatically, and it is the build gate the spec asks for.

```ts
import { describe, it, expect } from 'vitest';
import type { Profile } from '@grantspotter/core';
import { expandCycles, matchProgram, RECURRENCE_PREFIX } from '@grantspotter/core';
import { assertNotBlocked } from '../fetcher/blocklist.js';
import { loadSeedCorpus, seedDir, SEED_LAST_VERIFIED } from './load.js';

const corpus = loadSeedCorpus(seedDir());
const byId = new Map(corpus.programs.map((p) => [p.id, p]));

const STUDENT: Profile = {
  kind: 'student', callsign: 'W8UM', licenseClass: 'GENERAL', licensedSince: '2021-05-01',
  state: 'MI', fieldOfStudy: 'Electrical Engineering', degreeLevel: 'BACH',
  institution: 'University of Michigan', accredited: true, partTime: false, gpa: 3.4,
  citizenship: 'US_CITIZEN', birthDate: '2006-04-02', stage: 'UNDERGRAD',
  activityKinds: ['club_member', 'field_day'], financialNeed: true, gender: 'female',
};
const ORG: Profile = {
  kind: 'organization', entity: 'club_501c3', orgName: 'Example University Radio Club',
  callsign: 'W1EXA', state: 'MA', is501c3: true, hasFiscalSponsor: false,
  arrlAffiliated: true, memberCount: 24, institutionName: 'Example University',
};
const EMPTY_STUDENT: Profile = { kind: 'student' };

describe('seed corpus', () => {
  it('loads at least one funder and one program', () => {
    expect(corpus.funders.length).toBeGreaterThan(0);
    expect(corpus.programs.length).toBeGreaterThan(0);
  });

  it('has unique funder ids and unique program ids', () => {
    expect(new Set(corpus.funders.map((f) => f.id)).size).toBe(corpus.funders.length);
    expect(new Set(corpus.programs.map((p) => p.id)).size).toBe(corpus.programs.length);
  });

  it('resolves every program funderId to a real funder', () => {
    const ids = new Set(corpus.funders.map((f) => f.id));
    const orphans = corpus.programs.filter((p) => !ids.has(p.funderId)).map((p) => p.id);
    expect(orphans).toEqual([]);
  });

  it('computes a content hash for every record', () => {
    for (const program of corpus.programs) {
      expect(program.trust.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('stamps every record with the research date and seed_import provenance', () => {
    for (const program of corpus.programs) {
      expect(program.trust.lastVerifiedAt).toBe(SEED_LAST_VERIFIED);
      expect(['seed_import', 'manual_curation']).toContain(program.trust.verificationMethod);
    }
  });

  it('never contains a URL on a blocklisted host', () => {
    for (const funder of corpus.funders) assertNotBlocked(funder.homepage);
    for (const program of corpus.programs) {
      assertNotBlocked(program.trust.sourceUrl);
      if (program.applyUrl) assertNotBlocked(program.applyUrl);
      if (program.aiPolicy.url) assertNotBlocked(program.aiPolicy.url);
      for (const claim of program.trust.disputed?.claims ?? []) assertNotBlocked(claim.sourceUrl);
    }
  });

  it('never contains a private LAN address or a host filesystem path', () => {
    const json = JSON.stringify(corpus);
    expect(json).not.toMatch(/\b(?:10|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(json).not.toMatch(/\b192\.168\.\d{1,3}\.\d{1,3}\b/);
    expect(json).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
  });

  it('keeps every summary a short excerpt, not a page dump', () => {
    for (const program of corpus.programs) {
      expect(program.summary.length).toBeGreaterThan(0);
      expect(program.summary.length).toBeLessThanOrEqual(600);
    }
  });

  it('runs every record through the matcher without throwing, for three profile shapes', () => {
    for (const profile of [STUDENT, ORG, EMPTY_STUDENT]) {
      for (const program of corpus.programs) {
        const verdict = matchProgram(profile, program);
        expect(['eligible', 'eligible_preferred', 'ineligible', 'unknown']).toContain(verdict.kind);
      }
    }
  });

  it('never returns ineligible purely because a profile field is missing', () => {
    for (const program of corpus.programs) {
      const verdict = matchProgram(EMPTY_STUDENT, program);
      if (verdict.kind === 'ineligible') {
        // An empty profile may only be excluded by a constraint that is genuinely
        // unsatisfiable for a student, never by absent data.
        expect(verdict.reasons.length).toBeGreaterThan(0);
        for (const reason of verdict.reasons) expect(reason.hard).toBe(true);
      }
    }
  });

  it('keeps soft constraints out of the exclusion path by construction', () => {
    for (const program of corpus.programs) {
      for (const constraint of program.constraints) {
        expect(typeof constraint.hard).toBe('boolean');
        expect(Number.isInteger(constraint.fallbackRank)).toBe(true);
        expect(constraint.rawText.length).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * RESOLUTIONS R12 / CONTRACT §10.1. CONTRACT §3 freezes DeadlineSpec as {kind, source, note},
 * so recurrence parameters travel inside `note` in Plan 1's RECUR micro-format. If the seed
 * omits it, expandCycles returns nothing, the calendar is silently empty for the three most
 * important programs in the corpus, and no other test notices.
 */
describe('the RECUR micro-format is actually emitted', () => {
  const FROM = '2026-08-02T00:00:00.000Z';
  const TO = '2028-08-02T00:00:00.000Z';
  const PROJECTABLE = ['ardc-grants', 'arrl-amateur-radio-grants', 'arrl-foundation-scholarships'];

  it('carries a RECUR directive on all three projectable anchors', () => {
    for (const id of PROJECTABLE) {
      const program = byId.get(id);
      expect(program, `missing seed record ${id}`).toBeDefined();
      expect(program!.deadline.note.startsWith(RECURRENCE_PREFIX), id).toBe(true);
    }
  });

  it('expands each of them into at least one cycle', () => {
    for (const id of PROJECTABLE) {
      const cycles = expandCycles(byId.get(id)!, corpus.programs, FROM, TO);
      expect(cycles.length, `${id} produced no cycles`).toBeGreaterThan(0);
      for (const cycle of cycles) expect(cycle.isEstimated).toBe(true);
    }
  });

  it('gives ARDC its four fixed dates a year and ARRL Amateur Radio Grants its three windows', () => {
    // Plan 1 labels a projected fixed date "Feb 1, 2027 deadline" and stores closesAt as the
    // UTC instant of local end-of-day, so the label is what to assert on, not the ISO string.
    const ardc = expandCycles(
      byId.get('ardc-grants')!, corpus.programs,
      '2027-01-01T00:00:00.000Z', '2027-12-31T23:59:59.999Z',
    );
    expect(ardc.map((c) => c.label)).toEqual([
      'Feb 1, 2027 deadline',
      'Apr 1, 2027 deadline',
      'Jul 1, 2027 deadline',
      'Sep 1, 2027 deadline',
    ]);

    const arg = expandCycles(
      byId.get('arrl-amateur-radio-grants')!, corpus.programs,
      '2027-01-01T00:00:00.000Z', '2027-12-31T23:59:59.999Z',
    );
    expect(arg).toHaveLength(3);
    expect(arg.every((c) => c.opensAt !== undefined && c.closesAt !== undefined)).toBe(true);
  });

  it('lets every inherited catalog entry resolve a cycle through its owner', () => {
    const inherited = corpus.programs.filter((p) => p.deadline.source.kind === 'inherited');
    expect(inherited.length).toBeGreaterThan(0);
    const sample = inherited.slice(0, 5);
    for (const program of sample) {
      expect(expandCycles(program, corpus.programs, FROM, TO).length, program.id).toBeGreaterThan(0);
    }
  });
});

describe('crawler identity (sourceKey)', () => {
  it('gives a sourceKey to every record except the two documented exceptions', () => {
    const missing = corpus.programs
      .filter((p) => !corpus.sourceKeys.has(p.id))
      .map((p) => p.id)
      .sort();
    expect(missing).toEqual(['austin-arc-greenwood', 'ieee-mtt-s-student-awards']);
  });

  it('never lets two records claim the same crawler identity', () => {
    const composites = [...corpus.sourceKeys.values()].map((k) => `${k.sourceId}|${k.externalKey}`);
    expect(new Set(composites).size).toBe(composites.length);
  });

  it('names only source ids Plan 2 actually registers', () => {
    const known = new Set([
      'ardc-grants', 'arrl-amateur-radio-grants', 'arrl-club-grant', 'arrl-etp-grants',
      'arrl-scholarship-program', 'arrl-scholarship-descriptions', 'qcwa', 'ylrl', 'austin-arc',
      'sara', 'ncdxf-grants', 'ncdxf-scholarships', 'ariss', 'ieee-mtts',
      'ieee-student-branch-rebate', 'nasa-csli', 'yaesu-dr2x', 'manual-tier-d',
    ]);
    for (const [programId, key] of corpus.sourceKeys) {
      expect(known.has(key.sourceId), `${programId} names unknown source ${key.sourceId}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/seed/seed.test.ts
```

Expected failure: `Cannot find module './load.js'`.

- [ ] **Step 3: Implement the loader**

Create `packages/server/src/seed/load.ts`:

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Funder, Program } from '@grantspotter/core';
import { funderSchema, programSchema, hashProgram } from '@grantspotter/core';

export const SEED_LAST_VERIFIED = '2026-08-02';

/** PLAN-LOCAL. Mirrors Plan 2's (sourceId, externalKey) identity for a raw record. */
export interface SeedSourceKey {
  sourceId: string;
  externalKey: string;
}

/** PLAN-LOCAL. */
export interface SeedCorpus {
  funders: Funder[];
  programs: Program[];
  /** programId → the crawler identity that owns it. Missing for records no source re-reads. */
  sourceKeys: Map<string, SeedSourceKey>;
}

/**
 * Plan 1's packages/core/src/schema.ts exports lower-camel zod schemas mirroring types.ts
 * (RESOLUTIONS R7): `funderSchema`, `programSchema`. These two names are the only place
 * Plan 5 references them.
 */
const fileSchema = z.object({
  funders: z.array(funderSchema).optional(),
  programs: z.array(programSchema).optional(),
});

/**
 * `sourceKey` travels beside the record, not inside it: CONTRACT §3 freezes `Program` and
 * these two values live in the programs.source_id / programs.external_key columns.
 * programSchema strips the key on parse, so it is read here from the same raw JSON.
 */
const sourceKeyFileSchema = z.object({
  programs: z
    .array(
      z.object({
        id: z.string().min(1),
        sourceKey: z
          .object({ sourceId: z.string().min(1), externalKey: z.string().min(1) })
          .optional(),
      }),
    )
    .optional(),
});

export function seedDir(): string {
  // Walk up from this module to the repository root. In the container the layout is
  // identical to the repo, so /app/data/seed resolves the same way.
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, '..', '..', '..', '..', 'data', 'seed');
}

export function loadSeedCorpus(dir: string = seedDir()): SeedCorpus {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const funders: Funder[] = [];
  const programs: Program[] = [];
  const sourceKeys = new Map<string, SeedSourceKey>();
  const seenSourceKeys = new Map<string, string>();

  for (const file of files) {
    const path = join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(`Seed file ${file} is not valid JSON: ${(error as Error).message}`);
    }
    const result = fileSchema.safeParse(parsed);
    if (!result.success) {
      const first = result.error.issues[0];
      throw new Error(`Seed file ${file} failed validation at ${first.path.join('.')}: ${first.message}`);
    }
    const keys = sourceKeyFileSchema.safeParse(parsed);
    if (!keys.success) {
      const first = keys.error.issues[0];
      throw new Error(`Seed file ${file} has a malformed sourceKey at ${first.path.join('.')}: ${first.message}`);
    }
    for (const entry of keys.data.programs ?? []) {
      if (!entry.sourceKey) continue;
      const composite = `${entry.sourceKey.sourceId}|${entry.sourceKey.externalKey}`;
      const owner = seenSourceKeys.get(composite);
      if (owner !== undefined) {
        throw new Error(
          `Programs ${owner} and ${entry.id} share sourceKey ${composite}; ` +
          'programs.source_id/external_key is uniquely indexed, so only one record may own a crawler identity.',
        );
      }
      seenSourceKeys.set(composite, entry.id);
      sourceKeys.set(entry.id, entry.sourceKey);
    }
    funders.push(...(result.data.funders ?? []));
    programs.push(...(result.data.programs ?? []));
  }

  const funderIds = new Set<string>();
  for (const funder of funders) {
    if (funderIds.has(funder.id)) throw new Error(`Duplicate funder id in seed corpus: ${funder.id}`);
    funderIds.add(funder.id);
  }

  const programIds = new Set<string>();
  const hashed = programs.map((program) => {
    if (programIds.has(program.id)) throw new Error(`Duplicate program id in seed corpus: ${program.id}`);
    programIds.add(program.id);
    if (!funderIds.has(program.funderId)) {
      throw new Error(`Program ${program.id} names funder ${program.funderId}, which is not in the seed corpus`);
    }
    return { ...program, trust: { ...program.trust, contentHash: hashProgram(program) } };
  });

  for (const [programId] of sourceKeys) {
    if (!programIds.has(programId)) {
      throw new Error(`sourceKey names program ${programId}, which is not in the seed corpus`);
    }
  }

  return { funders, programs: hashed, sourceKeys };
}
```

- [ ] **Step 4: Write `data/seed/funders.json`**

Twenty-six funders. Two deserve a comment before you type them. **FAR** (Foundation for Amateur Radio) deliberately has no link to its own domain — that domain is compromised (see the Global Constraints) and the record links to the ARRL Foundation instead, which is where FAR's portfolio appears to have gone. **Six Meter Club of Chicago** has no usable homepage: `k9ona.com` returns 403 to every non-browser client and we do not spoof user agents to defeat a deliberate access policy, so the ARRL catalog page is the citable source.

```json
{
  "funders": [
    { "id": "ardc", "name": "Amateur Radio Digital Communications", "homepage": "https://www.ardc.net/", "ein": "45-3751971", "note": "Roughly $3.4-3.8M granted per year, about 30% approval. Also underwrites ARRL's club grants, scholarships and Teachers Institute ($2.1M over three years announced December 2023)." },
    { "id": "arrl", "name": "American Radio Relay League", "homepage": "http://www.arrl.org/", "note": "robots.txt sets Crawl-delay: 5. All grant and scholarship pages are allowed. No ETag, no Last-Modified, sitemap lastmod frozen at 2010." },
    { "id": "arrl-foundation", "name": "ARRL Foundation", "homepage": "http://www.arrl.org/arrl-foundation", "note": "Administers the 111-entry scholarship catalog (170+ awards), the Amateur Radio Grants programme and the Club Grant programme." },
    { "id": "qcwa", "name": "Quarter Century Wireless Association", "homepage": "https://www.qcwa.org/scholarship-program.htm", "note": "Memorial Scholarship Fund: 624+ students and $930,350+ since 1978. Requests open from October 31 and must reach ARRL before the first week of January; intake is ARRL's portal, not QCWA's." },
    { "id": "ylrl", "name": "Young Ladies' Radio League", "homepage": "https://ylrl.net/Scholarships/", "note": "One of only two verified non-ARRL US ham scholarship application paths." },
    { "id": "austin-arc", "name": "Austin Amateur Radio Club", "homepage": "https://austinhams.org/scholarships/", "note": "Self-hosted portal at grants.austinhams.org. It legitimately shows 'No opportunities available' between August 1 and April 30; an empty scrape here is not a failure." },
    { "id": "yasme", "name": "The Yasme Foundation", "homepage": "https://www.yasme.org/news-releases/", "note": "Site 301s /feed/ and /wp-json/ to a 403 page for non-browser clients. Track via ARRL news RSS instead. We do not spoof a browser user agent." },
    { "id": "ncdxf", "name": "Northern California DX Foundation", "homepage": "https://www.ncdxf.org/pages/grant-app.html", "note": "robots.txt and sitemap.xml both return 403. Manual curation only." },
    { "id": "sara", "name": "Society of Amateur Radio Astronomers", "homepage": "https://www.radio-astronomy.org/grants" },
    { "id": "rca", "name": "Radio Club of America", "homepage": "https://www.radioclubofamerica.org/", "note": "ClubExpress site. Only content.aspx query-string URLs resolve and the sitemap 403s. Module ids change without notice." },
    { "id": "ariss-usa", "name": "Amateur Radio on the International Space Station (ARISS-USA)", "homepage": "https://ariss-usa.org/proposal-overview/" },
    { "id": "nasa", "name": "National Aeronautics and Space Administration", "homepage": "https://www.nasa.gov/", "note": "NSPIRES exposes no API, RSS, XML, JSON or CSV. Grants.gov is the only machine-readable route to NASA opportunities." },
    { "id": "ieee-mtt-s", "name": "IEEE Microwave Theory and Technology Society", "homepage": "https://mtt.org/chapter-support/" },
    { "id": "ieee", "name": "Institute of Electrical and Electronics Engineers", "homepage": "https://students.ieee.org/topics/submit-your-student-branch-annual-plan/", "note": "mga.ieee.org returns HTTP 418 to non-browser clients, so rebate amounts are recorded from search snippets and are marked partial." },
    { "id": "yaesu-usa", "name": "Yaesu USA", "homepage": "https://systemfusion.yaesu.com/", "note": "Programme window dates exist only inside the title line of a dated fillable PDF under /wp-content/uploads/{YYYY}/{MM}/." },
    { "id": "dara", "name": "Dayton Amateur Radio Association (Hamvention)", "homepage": "https://hamvention.org/", "note": "Grantmaker only through its ARRL catalog entry. Zero hrefs containing 'scholar' or 'grant' on w8bi.org; daytonhamvention.org did not resolve." },
    { "id": "six-meter-club-chicago", "name": "Six Meter Club of Chicago", "homepage": "http://www.arrl.org/scholarship-descriptions", "note": "k9ona.com returns 403 to non-browser clients; the ARRL catalog entry is the citable source." },
    { "id": "yccc", "name": "Yankee Clipper Contest Club", "homepage": "https://yccc.org/" },
    { "id": "campus-sga", "name": "Campus student government associations", "homepage": "https://sga.fsu.edu/accounting/funding-your-rso", "note": "Roughly 4,000 independent campuses on Qualtrics, CampusGroups, Presence and Engage. Not aggregatable at any scale; shipped as a playbook. The linked FSU page is the representative example the research verified." },
    { "id": "icom-america", "name": "Icom America", "homepage": "https://www.icomamerica.com/" },
    { "id": "dx-engineering", "name": "DX Engineering", "homepage": "https://www.dxengineering.com/" },
    { "id": "kenwood", "name": "Kenwood USA", "homepage": "https://www.kenwood.com/usa/" },
    { "id": "flexradio", "name": "FlexRadio", "homepage": "https://www.flexradio.com/" },
    { "id": "amsat", "name": "Radio Amateur Satellite Corporation (AMSAT)", "homepage": "https://www.amsat.org/" },
    { "id": "chicago-fm-club", "name": "Chicago FM Club", "homepage": "https://chicagofmclub.org/" },
    { "id": "far", "name": "Foundation for Amateur Radio (FAR)", "homepage": "http://www.arrl.org/arrl-foundation", "note": "FAR's own domain is compromised and is deliberately not linked from this record; see the far-domain-compromised program record. FAR's historical portfolio (10-10, QCWA, YASME, K3IVO, CARA) appears absorbed into the ARRL Foundation, which is what this record links to instead." }
  ]
}
```

- [ ] **Step 5: Write `data/seed/programs.curated.json` with the four anchor programs**

These four anchor the corpus. `arrl-foundation-scholarships` matters most: it owns the deadline
that all 111 catalog entries inherit (Task 15 generates them pointing at this exact id), so its
`id` must be typed exactly as written. All five renamed ids in this corpus come from Plan 4's
canonical list (RESOLUTIONS R9) — Plan 4's funder overlays bind to them by string, and an overlay
that names an id the seed does not use simply never appears for its own program.

Three of these four carry a `RECUR:` directive at the head of `deadline.note` (RESOLUTIONS R12).
The grammar is Plan 1 Task 5's: `RECUR <kind> key=value … | free human prose`. `parseRecurrence`
reads everything before the `|`, the UI shows everything after it, and `expandCycles` returns
**nothing at all** for a projectable `DeadlineKind` whose note lacks the directive. ARRL's ETP
grants deliberately do not carry one: its published window text is stale ("of 2025") and
projecting from a stale page is exactly the confident-wrong-date failure this app exists to avoid.

```json
{
  "programs": [
    {
      "id": "ardc-grants",
      "funderId": "ardc",
      "sourceKey": { "sourceId": "ardc-grants", "externalKey": "grants" },
      "name": "ARDC Grants Program",
      "klass": "ham_grant",
      "summary": "Grants in three areas: Support and Growth of Amateur Radio, Education, and Technical Innovation / research and development. No published cap; observed 2026 awards run $1,285 to $258,000, with verified collegiate awards between $2,000 and $77,000.",
      "applicantEntities": ["club_via_fiscal_sponsor", "school_lea", "university", "university_dept"],
      "amount": { "instrument": "cash_range", "amountMin": 1285, "amountMax": 258000, "amountRaw": "No published cap. Observed 2026 range $1,285-$258,000; roughly $3.4-3.8M granted per year at about a 30% approval rate.", "awardCountRaw": "Multiple per year" },
      "deadline": { "kind": "n_fixed_dates", "source": { "kind": "self" }, "note": "RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | Four fixed submission dates each year: February 1, April 1, July 1 and September 1. A proposal arriving after September 1 is considered in the following February 1 cycle. Evaluation takes 60 to 120 days, so start at least two months before the date you are aiming at." },
      "applyVia": "external_spa_portal",
      "applyUrl": "https://www.ardc.net/apply/",
      "constraints": [
        { "id": "ardc-entity", "hard": true, "fallbackRank": 0, "rawText": "US 501(c)(3) organisations, government entities, schools and universities may apply directly. International nonprofits and universities are eligible. Clubs and individuals must apply through a fiscal sponsor. For-profit entities are not eligible.", "spec": { "axis": "other", "note": "Eligible entities: US 501(c)(3), government, school, university, international nonprofit or university; clubs and individuals via fiscal sponsor only; for-profits excluded." } },
        { "id": "ardc-open-source", "hard": true, "fallbackRank": 0, "rawText": "All output produced with ARDC funding must be open-source or open-access, under a licence such as GPL, MIT, BSD, CERN-OHL or Creative Commons.", "spec": { "axis": "other", "note": "Funded output must be released open-source or open-access." } }
      ],
      "fundingRestrictions": ["For-profit entities are not eligible.", "Indirect costs above 20% of direct costs are not reimbursable."],
      "obligations": { "costShareRequired": false, "coFunderPreference": false, "indirectCostCapPct": 20, "licenseObligation": "All output must be open-source or open-access (GPL, MIT, BSD, CERN-OHL or Creative Commons)." },
      "aiPolicy": { "stance": "permitted", "quote": "If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy. If the proposal is extremely long and hard to understand, we can't evaluate or support it.", "url": "https://www.ardc.net/apply/grant-application-instructions/" },
      "trust": { "status": "open", "sourceUrl": "https://www.ardc.net/apply/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "ARDC asks applicants to be thorough but brief and to avoid unnecessary jargon. Two requirements applicants most often miss: every funded output must be open-source or open-access, and indirect costs are capped at 20%.",
      "tags": ["ham", "grant", "ardc", "open-source", "education", "research"]
    },
    {
      "id": "arrl-amateur-radio-grants",
      "funderId": "arrl-foundation",
      "sourceKey": { "sourceId": "arrl-amateur-radio-grants", "externalKey": "amateur-radio-grants" },
      "name": "ARRL Amateur Radio Grants",
      "klass": "ham_grant",
      "summary": "Organisation grants for clubs, schools and youth programmes. Awards generally do not exceed $3,000, raised to $5,000 for 2026 under the League's Year of the Club. US organisations only; the Foundation never funds individuals through this programme.",
      "applicantEntities": ["club_unincorporated", "club_501c3", "school_lea", "university", "university_dept"],
      "amount": { "instrument": "cash_range", "amountMin": 500, "amountMax": 5000, "amountRaw": "Grants generally do not exceed $3,000; up to $5,000 during 2026, the Year of the Club.", "awardCountRaw": "Multiple per year" },
      "deadline": { "kind": "n_fixed_windows", "source": { "kind": "self" }, "note": "RECUR n_fixed_windows tz=America/New_York windows=02-01..02-28,06-01..06-30,10-01..10-31 | Three application windows each year: February 1-28, June 1-30 and October 1-31." },
      "applyVia": "external_spa_portal",
      "applyUrl": "http://www.arrl.org/amateur-radio-grants",
      "constraints": [
        { "id": "arrl-arg-org-only", "hard": true, "fallbackRank": 0, "rawText": "US organisations only. The ARRL Foundation does not make Amateur Radio Grants to individuals.", "spec": { "axis": "other", "note": "US organisations only; individuals are not eligible for this programme." } },
        { "id": "arrl-arg-cofund", "hard": false, "fallbackRank": 0, "rawText": "The Foundation prefers projects that are co-funded and does not generally wish to be the sole funder.", "spec": { "axis": "other", "note": "Co-funded projects are preferred." } }
      ],
      "fundingRestrictions": ["Emergency-communications equipment is not funded.", "Ongoing operating expenses are not funded."],
      "obligations": { "costShareRequired": false, "coFunderPreference": true },
      "aiPolicy": { "stance": "unaddressed", "url": "http://www.arrl.org/amateur-radio-grants" },
      "trust": { "status": "open", "sourceUrl": "http://www.arrl.org/amateur-radio-grants", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "The ARRL Foundation published no AI policy: the Club Grant page and the Grant Application Form PDF were both read in full and contain zero mentions of AI, ChatGPT or large language models. Terms inside the Kaleidoscope application portal are a JavaScript single-page app and could not be checked.",
      "tags": ["ham", "grant", "arrl", "club", "school"]
    },
    {
      "id": "arrl-etp-grants",
      "funderId": "arrl",
      "sourceKey": { "sourceId": "arrl-etp-grants", "externalKey": "etp-grants" },
      "name": "ARRL Teachers Institute / ETP Grants (School Station and Progress)",
      "klass": "equipment_in_kind",
      "summary": "Education and Technology Program grants supplying equipment, software and classroom resources to US K-12 schools and teachers. Two tracks: School Station grants for a new station, Progress grants for an existing one. Aimed at K-12, not at colleges.",
      "applicantEntities": ["school_lea", "teacher"],
      "amount": { "instrument": "in_kind_equipment", "amountRaw": "Equipment, software and classroom resources. The cash value is genuinely unpublished; do not infer one.", "awardCountRaw": "Multiple per year" },
      "deadline": { "kind": "annual_window", "source": { "kind": "self" }, "note": "A single annual window, October 1-31. The published page text still reads 'of 2025' and is stale; the month is stable, the year on the page is not." },
      "applyVia": "jotform_year_keyed",
      "applyUrl": "http://www.arrl.org/etp-grants",
      "constraints": [
        { "id": "etp-k12", "hard": true, "fallbackRank": 0, "rawText": "Open to US K-12 schools and teachers. Not aimed at colleges or universities.", "spec": { "axis": "institution", "degreeLevels": [], "tradeSchoolOK": false, "partTimeOK": true, "accreditationRequired": true } },
        { "id": "etp-arrl-member", "hard": true, "fallbackRank": 0, "rawText": "The applying teacher must be an ARRL member.", "spec": { "axis": "arrl_membership", "required": true, "minYears": 0 } }
      ],
      "fundingRestrictions": ["A signed antenna-approval form from the school is required before equipment ships."],
      "obligations": { "costShareRequired": false, "coFunderPreference": false, "sustainmentObligation": "The school station is expected to be used in instruction, not stored." },
      "aiPolicy": { "stance": "unaddressed", "url": "http://www.arrl.org/etp-grants" },
      "trust": { "status": "open", "sourceUrl": "http://www.arrl.org/etp-grants", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "The application is a Jotform whose form id changes every year, and the attached .xlsx and .pdf files change underneath a year-agnostic URL. Verify the current form id before applying.",
      "tags": ["ham", "equipment", "arrl", "k12", "teacher"]
    },
    {
      "id": "arrl-foundation-scholarships",
      "funderId": "arrl-foundation",
      "sourceKey": { "sourceId": "arrl-scholarship-program", "externalKey": "scholarship-program" },
      "name": "ARRL Foundation Scholarship Program",
      "klass": "ham_scholarship",
      "summary": "One application covers the Foundation's entire scholarship catalog: 111 catalog entries awarding 170-plus individual scholarships from $500 to $25,000. In 2024 the Foundation made 135 awards totalling more than $715,000. Applicants must hold an FCC amateur licence and be enrolled in higher education; some entries also accept foreign licensees.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "cash_range", "amountMin": 500, "amountMax": 25000, "amountRaw": "$500-$25,000 depending on the catalog entry. 2024 actual: 135 awards totalling more than $715,000.", "awardCountRaw": "170+ awards across 111 catalog entries" },
      "deadline": { "kind": "annual_window", "source": { "kind": "self" }, "note": "RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | The single annual window opens around October 30 and closes around December 30 at 12:00 noon EST. This moved from January 31 in an earlier year, so never hardcode it: re-verify each autumn." },
      "applyVia": "external_spa_portal",
      "applyUrl": "http://www.arrl.org/scholarship-program",
      "constraints": [
        { "id": "arrl-schol-license", "hard": true, "fallbackRank": 0, "rawText": "Applicants must hold a valid FCC amateur radio licence. Individual catalog entries may require a higher class.", "spec": { "axis": "license", "licenseMin": "TECH" } },
        { "id": "arrl-schol-enrolled", "hard": true, "fallbackRank": 0, "rawText": "Applicants must be enrolled, or accepted for enrolment, in an accredited post-secondary programme.", "spec": { "axis": "institution", "degreeLevels": ["CERT", "ASSOC", "BACH", "GRAD"], "tradeSchoolOK": true, "partTimeOK": false, "accreditationRequired": true } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed", "url": "http://www.arrl.org/scholarship-program" },
      "trust": { "status": "open", "sourceUrl": "http://www.arrl.org/scholarship-descriptions", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "This record owns the deadline that every entry in the catalog inherits, including scholarships administered by other organisations whose intake runs through ARRL: QCWA, YASME, DARA and the Six Meter Club of Chicago among them. QCWA additionally asks that requests start from October 31 and reach ARRL before the first week of January.",
      "tags": ["ham", "scholarship", "arrl", "catalog-parent"]
    }
  ]
}
```

- [ ] **Step 6: Run the seed test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/seed/seed.test.ts
```

Expected: 18 passing tests. A zod failure here prints the offending file and the exact field path — fix the JSON, not the schema. A failure in the RECUR block means a seed record lost its directive and its calendar entries silently vanished; a failure in the sourceKey block means two records are fighting over one crawler identity.

- [ ] **Step 7: Commit**

```bash
cd /path/to/grantspotter
git add data/seed packages/server/src/seed
git commit -m "feat(seed): corpus loader with zod validation plus funders and the four anchor programs"
```

---

### Task 12: Seed batch 2 — the non-ARRL ham organisations

**Files:**
- Create: `data/seed/programs.ham-orgs.json`
- Test: covered by `packages/server/src/seed/seed.test.ts` (data-driven, no new test file)

**Interfaces:**
- Consumes: the loader and validation harness from Task 11. Nothing new is produced.

Twelve records. Facts, amounts and deadlines below are exactly as verified on 2026-08-02; do not round them or fill gaps. Where a figure is genuinely unpublished the record says so in `amountRaw` and leaves `amountMin`/`amountMax` absent — that is the honest representation and the UI renders it as such.

- [ ] **Step 1: Write the file**

Create `data/seed/programs.ham-orgs.json`:

```json
{
  "programs": [
    {
      "id": "ylrl-ethel-smith-k4lmb",
      "funderId": "ylrl",
      "sourceKey": { "sourceId": "ylrl", "externalKey": "Ethel Smith K4LMB Memorial Scholarship" },
      "name": "YLRL Ethel Smith K4LMB Memorial Scholarship",
      "klass": "ham_scholarship",
      "summary": "Scholarship for licensed female amateur radio operators pursuing higher education. Non-US applicants are eligible; YLRL members are preferred.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "cash_fixed", "amountMin": 2500, "amountMax": 2500, "amountRaw": "$2,500", "awardCountRaw": "1 per year" },
      "deadline": { "kind": "annual_window", "source": { "kind": "self" }, "note": "Annual. The exact date is published on the YLRL apply page and was not captured in the 2026-08-02 pass; verify before relying on it." },
      "applyVia": "page_form",
      "applyUrl": "https://ylrl.net/Scholarships/",
      "constraints": [
        { "id": "ylrl-k4lmb-gender", "hard": true, "fallbackRank": 0, "rawText": "Open to licensed female amateur radio operators.", "spec": { "axis": "gender", "allowed": ["female"] } },
        { "id": "ylrl-k4lmb-license", "hard": true, "fallbackRank": 0, "rawText": "Applicant must hold an amateur radio licence. Non-US licences are accepted.", "spec": { "axis": "license", "licenseMin": "TECH", "foreignLicenseOK": true } },
        { "id": "ylrl-k4lmb-member", "hard": false, "fallbackRank": 0, "rawText": "Preference is given to YLRL members.", "spec": { "axis": "other", "note": "YLRL membership preferred." } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://ylrl.net/Scholarships/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "YLRL is one of only two verified non-ARRL US ham scholarship application paths; its intake does not run through the ARRL catalog.",
      "tags": ["ham", "scholarship", "ylrl", "women"]
    },
    {
      "id": "ylrl-mary-lou-brown-nm7n",
      "funderId": "ylrl",
      "sourceKey": { "sourceId": "ylrl", "externalKey": "Mary Lou Brown NM7N Scholarship" },
      "name": "YLRL Mary Lou Brown NM7N Scholarship",
      "klass": "ham_scholarship",
      "summary": "Scholarship for licensed female amateur radio operators in higher education. Non-US applicants eligible; YLRL member preference.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "cash_fixed", "amountMin": 2500, "amountMax": 2500, "amountRaw": "$2,500", "awardCountRaw": "1 per year" },
      "deadline": { "kind": "annual_window", "source": { "kind": "self" }, "note": "Annual. The exact date is published on the YLRL apply page and was not captured in the 2026-08-02 pass; verify before relying on it." },
      "applyVia": "page_form",
      "applyUrl": "https://ylrl.net/Scholarships/",
      "constraints": [
        { "id": "ylrl-nm7n-gender", "hard": true, "fallbackRank": 0, "rawText": "Open to licensed female amateur radio operators.", "spec": { "axis": "gender", "allowed": ["female"] } },
        { "id": "ylrl-nm7n-license", "hard": true, "fallbackRank": 0, "rawText": "Applicant must hold an amateur radio licence. Non-US licences are accepted.", "spec": { "axis": "license", "licenseMin": "TECH", "foreignLicenseOK": true } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://ylrl.net/Scholarships/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "",
      "tags": ["ham", "scholarship", "ylrl", "women"]
    },
    {
      "id": "ylrl-marte-wessel-k0epe",
      "funderId": "ylrl",
      "sourceKey": { "sourceId": "ylrl", "externalKey": "Marte Wessel K0EPE Scholarship" },
      "name": "YLRL Marte Wessel K0EPE Scholarship",
      "klass": "ham_scholarship",
      "summary": "Scholarship for licensed female amateur radio operators, aimed specifically at part-time students who are working full time.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "cash_fixed", "amountMin": 1500, "amountMax": 1500, "amountRaw": "$1,500", "awardCountRaw": "1 per year" },
      "deadline": { "kind": "annual_window", "source": { "kind": "self" }, "note": "Annual. The exact date is published on the YLRL apply page and was not captured in the 2026-08-02 pass; verify before relying on it." },
      "applyVia": "page_form",
      "applyUrl": "https://ylrl.net/Scholarships/",
      "constraints": [
        { "id": "ylrl-k0epe-gender", "hard": true, "fallbackRank": 0, "rawText": "Open to licensed female amateur radio operators.", "spec": { "axis": "gender", "allowed": ["female"] } },
        { "id": "ylrl-k0epe-parttime", "hard": false, "fallbackRank": 0, "rawText": "Targets part-time students who are working full time.", "spec": { "axis": "institution", "degreeLevels": ["CERT", "ASSOC", "BACH", "GRAD"], "tradeSchoolOK": true, "partTimeOK": true, "accreditationRequired": true } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://ylrl.net/Scholarships/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "",
      "tags": ["ham", "scholarship", "ylrl", "women", "part-time"]
    },
    {
      "id": "austin-arc-copeland",
      "funderId": "austin-arc",
      "sourceKey": { "sourceId": "austin-arc", "externalKey": "austin-arc-scholarships" },
      "name": "Austin ARC Copeland Scholarship",
      "klass": "ham_scholarship",
      "summary": "Club scholarship for students in seven named Central Texas counties. A licence has historically been required. The award amount has not been published since the club rebuilt its site.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "unknown", "amountRaw": "Unpublished since the site rebuild. Do not infer an amount.", "awardCountRaw": "Unpublished" },
      "deadline": { "kind": "annual_window", "source": { "kind": "self" }, "note": "Applications are accepted May 1 through July 31 annually. Search engines still surface a stale 'March 25, 2026' date that contradicts the live page; the live page wins." },
      "applyVia": "self_hosted_portal",
      "applyUrl": "https://austinhams.org/scholarships/",
      "constraints": [
        { "id": "austin-copeland-geo", "hard": true, "fallbackRank": 0, "rawText": "Applicants must reside in one of seven named Central Texas counties.", "spec": { "axis": "geography", "geo": { "type": "county", "values": ["Travis County, TX", "Williamson County, TX", "Hays County, TX", "Bastrop County, TX", "Caldwell County, TX", "Blanco County, TX", "Burnet County, TX"] } } },
        { "id": "austin-copeland-license", "hard": true, "fallbackRank": 0, "rawText": "A licence has historically been required.", "spec": { "axis": "license", "licenseMin": "TECH" } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://austinhams.org/scholarships/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "", "staleMirrorWarning": "Search-engine snippets still show a March 25, 2026 deadline for this scholarship. The live club page says May 1 to July 31. Trust the club page." },
      "rawOtherText": "The club's portal at grants.austinhams.org legitimately displays 'No opportunities available' between August 1 and April 30. That is the closed state, not an error.",
      "tags": ["ham", "scholarship", "texas", "club"]
    },
    {
      "id": "austin-arc-greenwood",
      "funderId": "austin-arc",
      "name": "Austin ARC Greenwood Scholarship",
      "klass": "ham_scholarship",
      "summary": "Second Austin Amateur Radio Club scholarship, same Central Texas county footprint and the same annual window as the Copeland award.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "unknown", "amountRaw": "Unpublished since the site rebuild. Do not infer an amount.", "awardCountRaw": "Unpublished" },
      "deadline": { "kind": "annual_window", "source": { "kind": "self" }, "note": "Applications are accepted May 1 through July 31 annually." },
      "applyVia": "self_hosted_portal",
      "applyUrl": "https://austinhams.org/scholarships/",
      "constraints": [
        { "id": "austin-greenwood-geo", "hard": true, "fallbackRank": 0, "rawText": "Applicants must reside in one of seven named Central Texas counties.", "spec": { "axis": "geography", "geo": { "type": "county", "values": ["Travis County, TX", "Williamson County, TX", "Hays County, TX", "Bastrop County, TX", "Caldwell County, TX", "Blanco County, TX", "Burnet County, TX"] } } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://austinhams.org/scholarships/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "",
      "tags": ["ham", "scholarship", "texas", "club"]
    },
    {
      "id": "yasme-supporting-grants",
      "funderId": "yasme",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "yasme-supporting-grants" },
      "name": "Yasme Foundation Supporting Grants and Excellence Awards",
      "klass": "ham_grant",
      "summary": "Board-selected support for youth programmes, developing-country radio societies, Reverse Beacon Network nodes and other foundations' scholarship funds. Observed awards run $5,000 to $7,500.",
      "applicantEntities": ["club_unincorporated", "club_501c3", "school_lea", "university"],
      "amount": { "instrument": "cash_range", "amountMin": 5000, "amountMax": 7500, "amountRaw": "$5,000-$7,500 observed", "awardCountRaw": "Several per year, announced retrospectively" },
      "deadline": { "kind": "no_application_exists", "source": { "kind": "self" }, "note": "There is no application and no deadline. The board initiates awards and announces them retrospectively, roughly twice a year. The practical route is to be visible: publish your work and let the board find it." },
      "applyVia": "none",
      "constraints": [
        { "id": "yasme-board", "hard": true, "fallbackRank": 0, "rawText": "Awards are board-initiated. There is no application process.", "spec": { "axis": "other", "note": "Board-initiated only; no application exists." } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false, "reportingObligation": "Recipients of the associated YASME scholarship are asked for a year-end activity report." },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "no_application", "sourceUrl": "https://www.yasme.org/news-releases/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "yasme.org returns a 403 page to non-browser clients on /feed/ and /wp-json/, so GrantSpotter does not poll it. Yasme announcements are relayed by the ARRL news RSS feed, which is what the change detector watches instead. We do not spoof a browser user agent to defeat a deliberate access policy.",
      "tags": ["ham", "grant", "yasme", "no-application"]
    },
    {
      "id": "ncdxf-grant-program",
      "funderId": "ncdxf",
      "sourceKey": { "sourceId": "ncdxf-grants", "externalKey": "ncdxf-grant-program" },
      "name": "NCDXF Grant Program",
      "klass": "ham_grant",
      "summary": "Grants to individuals and groups advancing education and science through amateur radio. In practice the recipients are DXpedition teams travelling to the hundred least-accessible entities. Roughly $1.2M has been distributed over about 48 years, in many small awards. This is not a collegiate programme.",
      "applicantEntities": ["individual", "club_unincorporated", "club_501c3"],
      "amount": { "instrument": "unknown", "amountRaw": "Per-award amounts are unpublished. Roughly $1.2M total over about 48 years across many small awards.", "awardCountRaw": "Multiple per year" },
      "deadline": { "kind": "rolling", "source": { "kind": "self" }, "note": "Rolling: applications are accepted at any time. Allow roughly two months of lead time before you need a decision." },
      "applyVia": "email_pdf_packet",
      "applyUrl": "https://www.ncdxf.org/pages/grant-app.html",
      "constraints": [
        { "id": "ncdxf-stake", "hard": true, "fallbackRank": 0, "rawText": "Applicants must have a personal financial stake in the project; NCDXF does not fund the full cost.", "spec": { "axis": "other", "note": "Applicant must contribute financially to the project." } }
      ],
      "fundingRestrictions": ["Commercial transport costs are not funded."],
      "obligations": { "costShareRequired": true, "coFunderPreference": true },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://www.ncdxf.org/pages/grant-app.html", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "The application is a downloadable form plus a budget spreadsheet, emailed to the treasurer. ncdxf.org returns 403 for both robots.txt and sitemap.xml, so this record is curated by hand and re-verified quarterly rather than crawled.",
      "tags": ["ham", "grant", "dxpedition", "manual"]
    },
    {
      "id": "ncdxf-w6een-scholarship",
      "funderId": "ncdxf",
      "sourceKey": { "sourceId": "ncdxf-scholarships", "externalKey": "ncdxf-w6een-scholarship" },
      "name": "NCDXF W6EEN Memorial Scholarship",
      "klass": "ham_scholarship",
      "summary": "Covers tuition at DX University or Contest University for licensed amateurs aged 25 or younger, any licence class. No dollar figure is published because the award is the course itself.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "tuition_coverage", "amountRaw": "Full tuition at DX University or Contest University. No dollar figure is published.", "awardCountRaw": "Unpublished" },
      "deadline": { "kind": "unpublished", "source": { "kind": "self" }, "note": "No deadline is published. Availability tracks the DX University and Contest University course schedules." },
      "applyVia": "email_pdf_packet",
      "applyUrl": "https://www.ncdxf.org/pages/scholarships.html",
      "constraints": [
        { "id": "ncdxf-w6een-age", "hard": true, "fallbackRank": 0, "rawText": "Open to licensed amateurs aged 25 or younger.", "spec": { "axis": "age_stage", "ageMax": 25, "stages": ["HS_SENIOR", "UNDERGRAD", "GRAD"] } },
        { "id": "ncdxf-w6een-license", "hard": true, "fallbackRank": 0, "rawText": "Any licence class is accepted.", "spec": { "axis": "license", "licenseMin": "TECH" } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "unknown", "sourceUrl": "https://www.ncdxf.org/pages/scholarships.html", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "",
      "tags": ["ham", "scholarship", "youth", "training"]
    },
    {
      "id": "ncdxf-youth-grant",
      "funderId": "ncdxf",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "ncdxf-youth-grant" },
      "name": "NCDXF Youth Grant",
      "klass": "ham_grant",
      "summary": "A youth grant listed by NCDXF whose page renders as navigation and a title only: no terms, no amount, no deadline are published anywhere on it. Recorded so a user searching for it learns that, rather than assuming GrantSpotter missed it.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "unknown", "amountRaw": "No amount is published.", "awardCountRaw": "Unpublished" },
      "deadline": { "kind": "unpublished", "source": { "kind": "self" }, "note": "No terms are published on the page. Contact NCDXF directly if you need this one." },
      "applyVia": "contact_person",
      "applyUrl": "https://www.ncdxf.org/pages/scholarships.html",
      "constraints": [],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "unknown", "sourceUrl": "https://www.ncdxf.org/pages/scholarships.html", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "Verified 2026-08-02: the Youth Grant page contains a title and navigation and no programme terms. This is a low-value polling target and is deliberately excluded from the nightly crawl.",
      "tags": ["ham", "grant", "youth", "unpublished"]
    },
    {
      "id": "sara-student-teacher-grants",
      "funderId": "sara",
      "sourceKey": { "sourceId": "sara", "externalKey": "sara-student-teacher-grants" },
      "name": "SARA Student and Teacher Project Grants",
      "klass": "equipment_in_kind",
      "summary": "Small project grants for students from fifth grade through college and for teachers, international applicants included. Typically $200 or less, occasionally more with committee approval, and frequently paid as kits such as Radio JOVE or SuperSID rather than cash.",
      "applicantEntities": ["individual", "teacher", "school_lea", "university"],
      "amount": { "instrument": "in_kind_equipment", "amountMin": 0, "amountMax": 500, "amountRaw": "Typically $200 or less, or more with committee approval; one $500 outlier observed. Often a kit (Radio JOVE, SuperSID) rather than cash.", "awardCountRaw": "Multiple per year" },
      "deadline": { "kind": "rolling", "source": { "kind": "self" }, "note": "Rolling. No deadlines appear anywhere on the grants page." },
      "applyVia": "email_pdf_packet",
      "applyUrl": "https://www.radio-astronomy.org/grants",
      "applyContact": "grants@radio-astronomy.org",
      "constraints": [
        { "id": "sara-stage", "hard": true, "fallbackRank": 0, "rawText": "Open to students from fifth grade through college, and to teachers.", "spec": { "axis": "age_stage", "stages": ["HS_SENIOR", "UNDERGRAD", "GRAD"] } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://www.radio-astronomy.org/grants", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "The application is a downloadable Word or PDF form emailed to grants@radio-astronomy.org. International applicants are explicitly welcome.",
      "tags": ["ham", "equipment", "radio-astronomy", "students", "teachers", "international"]
    },
    {
      "id": "rca-scholarship-program",
      "funderId": "rca",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "rca-scholarship-program" },
      "name": "Radio Club of America Scholarship Program",
      "klass": "ham_scholarship",
      "summary": "Sixteen named funds, including the Rappaport, Carr and Cooper awards, for undergraduate and graduate students on a wireless career track. An amateur licence is NOT required. Only students at roughly nine participating schools are eligible, and the university selects the recipients: students never apply to RCA.",
      "applicantEntities": ["nominated_by_institution"],
      "amount": { "instrument": "unknown", "amountRaw": "Per-award amounts are unpublished. About $15,000 per year is distributed in total.", "awardCountRaw": "Unpublished; awards are distributed each May" },
      "deadline": { "kind": "unpublished", "source": { "kind": "self" }, "note": "No deadline is published. Awards are distributed each May and the timeline is set by the participating university, not by RCA. If your school participates, ask your department." },
      "applyVia": "contact_person",
      "constraints": [
        { "id": "rca-nomination", "hard": true, "fallbackRank": 0, "rawText": "The participating university selects recipients. Students do not apply to the Radio Club of America directly.", "spec": { "axis": "other", "note": "Institution nominates; no student-facing application exists." } },
        { "id": "rca-track", "hard": true, "fallbackRank": 0, "rawText": "Undergraduate or graduate students on a wireless career track. An amateur radio licence is not required.", "spec": { "axis": "field_of_study", "fields": ["Wireless communications", "Electrical Engineering", "Telecommunications"], "excludedFields": [] } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "contact_only", "sourceUrl": "https://www.radioclubofamerica.org/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "RCA runs on ClubExpress. Only content.aspx query-string URLs resolve, pretty URLs 404, and the sitemap returns 403. The module id in the URL changes without notice when RCA renumbers modules, which is why this record is curated by hand rather than crawled.",
      "tags": ["scholarship", "wireless", "nominated", "no-license-required"]
    },
    {
      "id": "rca-youth-activities",
      "funderId": "rca",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "rca-youth-activities" },
      "name": "Radio Club of America Youth Activities Program",
      "klass": "equipment_in_kind",
      "summary": "In-kind support for schools, scout groups and museums: books, equipment and curriculum materials. No cash, no application form, no deadline. A permanent contact-only record.",
      "applicantEntities": ["school_lea", "club_unincorporated", "club_501c3"],
      "amount": { "instrument": "in_kind_equipment", "amountRaw": "In-kind only: books, equipment and curriculum. No cash amount is published.", "awardCountRaw": "Unpublished" },
      "deadline": { "kind": "rolling", "source": { "kind": "self" }, "note": "Rolling, effectively none. Contact the club." },
      "applyVia": "contact_person",
      "constraints": [],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "contact_only", "sourceUrl": "https://www.radioclubofamerica.org/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "Recorded as a permanent contact-only entry. Deliberately excluded from the nightly crawl.",
      "tags": ["equipment", "youth", "schools", "contact-only"]
    }
  ]
}
```

A note on shape while you type these: `DeadlineSpec` has exactly three fields (`kind`, `source`, `note`) and `Obligations` requires `costShareRequired` and `coFunderPreference` on every record even when both are `false`. Recurrence parameters live inside `note` in the `RECUR` micro-format — there is no fourth field and adding one would break the frozen CONTRACT §3 type.

`sourceKey` is the one key in these files that is *not* part of `Program`. Plan 1's `programSchema`
is a plain `z.object`, so zod strips it on parse and the loader reads it separately (Task 11);
nothing else in the record may carry an extra key, because a typo'd field name would then be
silently discarded instead of reported.

- [ ] **Step 2: Run the seed test**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/seed/seed.test.ts
```

Expected: all 11 tests still pass, now over 16 programs. The blocklist, LAN-address, matcher and summary-length assertions all cover the new records automatically.

- [ ] **Step 3: Commit**

```bash
cd /path/to/grantspotter
git add data/seed/programs.ham-orgs.json
git commit -m "feat(seed): twelve non-ARRL ham organisation records (YLRL, Austin ARC, Yasme, NCDXF, SARA, RCA)"
```

---

### Task 13: Seed batch 3 — institutional, in-kind, and the two un-aggregatable workflows

**Files:**
- Create: `data/seed/programs.institutional.json`
- Test: covered by `packages/server/src/seed/seed.test.ts`

**Interfaces:** consumes Task 11's loader. Produces no new code.

Eight records. Two of them — NASA State Space Grant and Campus SGA — are the ones the research names as *where a typical collegiate club's money actually comes from* and *the two you cannot aggregate*. They ship as guided workflow records with the playbook in `rawOtherText`, not as pretend feeds. The FSU finding in the SGA record is the single most valuable line in this batch: student-activity-fee rules frequently bar capital equipment, so a radio has to be framed as programming or funded from outside.

- [ ] **Step 1: Write the file**

Create `data/seed/programs.institutional.json`:

```json
{
  "programs": [
    {
      "id": "ariss-iss-contact",
      "funderId": "ariss-usa",
      "sourceKey": { "sourceId": "ariss", "externalKey": "ariss-iss-contact-proposal" },
      "name": "ARISS-USA ISS Contact Proposals and SPARKI",
      "klass": "equipment_in_kind",
      "summary": "A scheduled amateur radio contact between your students and an ISS crew member, plus technical mentoring to get the ground station ready. No cash changes hands. Written for US schools and educational organisations; colleges and universities are not explicitly named and K-12 dominates the awardee list.",
      "applicantEntities": ["school_lea", "club_501c3", "university"],
      "amount": { "instrument": "in_kind_service", "amountRaw": "No cash. A scheduled ISS crew contact plus technical mentoring.", "awardCountRaw": "Several per proposal window" },
      "deadline": { "kind": "quarterly_rewritten", "source": { "kind": "self" }, "note": "Four proposal windows a year. Verified live on 2026-08-02: the current window opened July 1 and closes September 30, for contacts occurring January through June 2027. The window sentence is rewritten in place at a stable URL, so the URL never changes and the dates always do." },
      "applyVia": "page_form",
      "applyUrl": "https://ariss-usa.org/proposal-overview/",
      "constraints": [
        { "id": "ariss-entity", "hard": true, "fallbackRank": 0, "rawText": "Open to US schools and educational organisations.", "spec": { "axis": "other", "note": "US schools and educational organisations. Colleges and universities are not explicitly named in the eligibility text." } },
        { "id": "ariss-education-plan", "hard": true, "fallbackRank": 0, "rawText": "Proposals must include an education plan that reaches students beyond the radio club itself.", "spec": { "axis": "other", "note": "An education plan with reach beyond the club is required." } }
      ],
      "fundingRestrictions": ["No cash is awarded. Ground-station equipment is the applicant's responsibility, though mentoring is provided."],
      "obligations": { "costShareRequired": false, "coFunderPreference": false, "sustainmentObligation": "The applicant runs the education programme around the contact and provides the ground station." },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://ariss-usa.org/proposal-overview/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "SPARKI is the companion programme. Because the window sentence is rewritten quarterly at a stable URL, this page is one of the better change-detection targets in the corpus: regex the phrase 'Proposal window' and the date sentence that follows it.",
      "tags": ["ham", "in-kind", "iss", "education", "k12"]
    },
    {
      "id": "nasa-csli",
      "funderId": "nasa",
      "sourceKey": { "sourceId": "nasa-csli", "externalKey": "nasa-csli" },
      "name": "NASA CubeSat Launch Initiative (CSLI)",
      "klass": "equipment_in_kind",
      "summary": "Launch and deployment services for CubeSats built by US educational institutions and nonprofits. NASA provides the ride; the team funds and builds its own hardware.",
      "applicantEntities": ["university", "university_dept", "school_lea", "club_501c3"],
      "amount": { "instrument": "in_kind_service", "amountRaw": "No cash. Launch and deployment services only; the team funds its own spacecraft.", "awardCountRaw": "Varies by announcement" },
      "deadline": { "kind": "unpublished", "source": { "kind": "self" }, "note": "Historically an August release with a November due date. As of 2026-08-02 the page says NASA anticipates an update in spring 2026 and no open window is confirmed. Treat any date you find elsewhere as unverified until the announcement page changes." },
      "applyVia": "page_form",
      "applyUrl": "https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/",
      "constraints": [
        { "id": "csli-entity", "hard": true, "fallbackRank": 0, "rawText": "Open to US educational institutions and nonprofit organisations.", "spec": { "axis": "other", "note": "US educational institutions and nonprofits." } },
        { "id": "csli-citizenship", "hard": true, "fallbackRank": 0, "rawText": "The proposing organisation must be US-based.", "spec": { "axis": "geography", "geo": { "type": "any", "values": [] } } }
      ],
      "fundingRestrictions": ["No hardware funding. The launch is the award."],
      "obligations": { "costShareRequired": true, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "unknown", "sourceUrl": "https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "NASA's NSPIRES system exposes no API, RSS, XML, JSON or CSV and is a session-stateful application, so Grants.gov is the only machine-readable route to NASA opportunities. This record is polled by watching the announcement page for a status change.",
      "tags": ["in-kind", "cubesat", "nasa", "university", "status-ambiguous"]
    },
    {
      "id": "nasa-space-grant",
      "funderId": "nasa",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "nasa-space-grant-consortia" },
      "name": "NASA National Space Grant — 52 state consortia",
      "klass": "adjacent_stem",
      "summary": "Fifty-two independent state and territory consortia funding university students, faculty and teams. Per the research this is the most common real route to a campus ground station or a cubesat. Student awards typically run $1,000 to $10,000 but are set consortium by consortium and are not published nationally.",
      "applicantEntities": ["university", "university_dept", "individual"],
      "amount": { "instrument": "cash_range", "amountMin": 1000, "amountMax": 10000, "amountRaw": "Consortium-level student awards typically $1,000-$10,000. Not published nationally; each consortium sets its own.", "awardCountRaw": "Varies by consortium" },
      "deadline": { "kind": "ad_hoc", "source": { "kind": "self" }, "note": "There is no national deadline. Fifty-two consortia keep fifty-two independent calendars. Find your state's consortium and work to its calendar." },
      "applyVia": "contact_person",
      "applyUrl": "https://www.nasa.gov/stem/spacegrant/home/index.html",
      "constraints": [
        { "id": "space-grant-affiliation", "hard": true, "fallbackRank": 0, "rawText": "Applicants apply through their state consortium, usually via an affiliate university.", "spec": { "axis": "other", "note": "Apply through your state consortium, normally via an affiliate institution." } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": true, "coFunderPreference": false, "reportingObligation": "Consortia typically require an end-of-project report; terms vary by state." },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://www.nasa.gov/stem/spacegrant/home/index.html", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "Guided workflow, not a feed. Steps that work: 1) Look up your state's Space Grant consortium in NASA's consortium directory. 2) Find the affiliate institution nearest you; consortium money usually flows through affiliates. 3) Ask the consortium director for the current student-award and mini-grant calendar, which is rarely posted more than a semester ahead. 4) Frame the ask in the consortium's own language: STEM workforce development, student research, K-12 outreach. A campus ground station is fundable as student research infrastructure and is rarely fundable as radio equipment. This structure is why GrantSpotter ships a state-keyed consortium picker rather than pretending 52 heterogeneous university-hosted sites are one feed.",
      "tags": ["adjacent", "nasa", "space-grant", "university", "guided-workflow"]
    },
    {
      "id": "ieee-mtts-chapter-support",
      "funderId": "ieee-mtt-s",
      "sourceKey": { "sourceId": "ieee-mtts", "externalKey": "ieee-mtts-chapter-support" },
      "name": "IEEE MTT-S Chapter Support",
      "klass": "adjacent_stem",
      "summary": "Annual chapter funding for IEEE MTT-S Student Branch Chapters: $1,000 for a single-society chapter and $500 for a joint chapter. The most RF-relevant money inside IEEE.",
      "applicantEntities": ["ieee_student_branch_chapter"],
      "amount": { "instrument": "cash_fixed", "amountMin": 500, "amountMax": 1000, "amountRaw": "$1,000 per year for a single-society chapter; $500 for a joint chapter.", "awardCountRaw": "1 per chapter per year" },
      "deadline": { "kind": "annual_window", "source": { "kind": "self" }, "note": "October 1 annually, stated inline on the chapter-support page." },
      "applyVia": "jotform_year_keyed",
      "applyUrl": "https://mtt.org/chapter-support/",
      "constraints": [
        { "id": "mtts-members", "hard": true, "fallbackRank": 0, "rawText": "The chapter must have at least five members.", "spec": { "axis": "other", "note": "Minimum five chapter members." } },
        { "id": "mtts-vtools", "hard": true, "fallbackRank": 0, "rawText": "The officer roster must be current in IEEE vTools and at least two meetings must have been reported.", "spec": { "axis": "other", "note": "Current vTools officer roster and at least two reported meetings." } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false, "reportingObligation": "Chapter meetings must be reported through IEEE vTools to stay eligible." },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://mtt.org/chapter-support/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "The two-reported-meetings requirement is the one chapters fail. Report meetings in vTools as they happen rather than reconstructing them in September.",
      "tags": ["adjacent", "ieee", "rf", "student-chapter"]
    },
    {
      "id": "ieee-mtt-s-student-awards",
      "funderId": "ieee-mtt-s",
      "name": "IEEE MTT-S Undergraduate Scholarships and Graduate Fellowships",
      "klass": "adjacent_stem",
      "summary": "Ten undergraduate scholarships of $1,500 and three graduate fellowships of $6,000 for students working in microwave theory and technology.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "cash_tiered_blocks", "amountMin": 1500, "amountMax": 6000, "tiers": [{ "count": 10, "amount": 1500 }, { "count": 3, "amount": 6000 }], "amountRaw": "10 undergraduate scholarships at $1,500 and 3 graduate fellowships at $6,000.", "awardCountRaw": "13" },
      "deadline": { "kind": "annual_window", "source": { "kind": "self" }, "note": "Annual, aligned with the society's chapter-support calendar around October 1. Confirm the current date on the MTT-S site before applying." },
      "applyVia": "jotform_year_keyed",
      "applyUrl": "https://mtt.org/chapter-support/",
      "constraints": [
        { "id": "mtts-field", "hard": true, "fallbackRank": 0, "rawText": "Applicants must be working in microwave theory and technology or a directly related RF field.", "spec": { "axis": "field_of_study", "fields": ["Electrical Engineering", "Microwave Engineering", "RF Engineering", "Electromagnetics"], "excludedFields": [] } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://mtt.org/chapter-support/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "An amateur radio licence is not required. This is engineering-society money, and a ham student in an EE programme is a natural fit.",
      "tags": ["adjacent", "ieee", "scholarship", "rf", "no-license-required"]
    },
    {
      "id": "ieee-student-branch-rebate",
      "funderId": "ieee",
      "sourceKey": { "sourceId": "ieee-student-branch-rebate", "externalKey": "ieee-student-branch-rebate" },
      "name": "IEEE Student Branch Annual Rebate",
      "klass": "adjacent_stem",
      "summary": "A per-member rebate paid to IEEE Student Branches that file an annual plan: $50 a year for a branch under 50 members or $100 for 50 or more, plus $2 per member and $1 per chapter member.",
      "applicantEntities": ["ieee_student_branch_chapter"],
      "amount": { "instrument": "per_member_rebate", "amountMin": 50, "amountMax": 100, "amountRaw": "$50/yr under 50 members, $100/yr at 50 or more, plus $2 per member and $1 per chapter member.", "awardCountRaw": "1 per branch per year" },
      "deadline": { "kind": "annual_window", "source": { "kind": "self" }, "note": "The Student Branch Annual Plan is due 15 March each year." },
      "applyVia": "page_form",
      "applyUrl": "https://students.ieee.org/topics/submit-your-student-branch-annual-plan/",
      "constraints": [
        { "id": "ieee-branch", "hard": true, "fallbackRank": 0, "rawText": "The applicant must be a recognised IEEE Student Branch and must file the Annual Plan.", "spec": { "axis": "other", "note": "Recognised IEEE Student Branch with a filed Annual Plan." } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false, "reportingObligation": "The Annual Plan filing is itself the reporting obligation." },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://students.ieee.org/topics/submit-your-student-branch-annual-plan/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "The amounts above come from search snippets, not from a live read: mga.ieee.org returns HTTP 418 to non-browser clients and we do not spoof a user agent to get around it. Confirm the current rebate schedule with your branch counsellor. The deadline itself was read live.",
      "tags": ["adjacent", "ieee", "rebate", "student-branch", "partial-verification"]
    },
    {
      "id": "yaesu-dr2x-repeater",
      "funderId": "yaesu-usa",
      "sourceKey": { "sourceId": "yaesu-dr2x", "externalKey": "yaesu-dr2x-repeater-program" },
      "name": "Yaesu System Fusion DR-2X Repeater Program",
      "klass": "equipment_in_kind",
      "summary": "A discounted purchase programme, not a grant: clubs, groups, organisations and individuals in North America can buy a DR-2X repeater at $1,450, or $1,860 bundled with the LAN-01A network module. The repeater must be on the air within a set period and stay on the air for twelve months.",
      "applicantEntities": ["club_unincorporated", "club_501c3", "university", "school_lea", "individual"],
      "amount": { "instrument": "discounted_purchase", "amountMin": 1450, "amountMax": 1860, "amountRaw": "Discounted purchase: $1,450 for the DR-2X, $1,860 with the LAN-01A. This is a price, not an award.", "awardCountRaw": "Limited per window" },
      "deadline": { "kind": "ad_hoc", "source": { "kind": "self" }, "note": "Irregular windows, roughly two to four a year. Verified live on 2026-08-02: the current window runs June 3 to August 31, 2026." },
      "applyVia": "email_pdf_packet",
      "applyUrl": "https://systemfusion.yaesu.com/",
      "constraints": [
        { "id": "yaesu-geo", "hard": true, "fallbackRank": 0, "rawText": "Open to clubs, groups, organisations or individuals in North America.", "spec": { "axis": "geography", "geo": { "type": "any", "values": [] } } }
      ],
      "fundingRestrictions": ["This is a purchase at a reduced price. No money is granted and the buyer pays."],
      "obligations": { "costShareRequired": true, "coFunderPreference": false, "sustainmentObligation": "The repeater must be placed on the air and kept on the air for twelve months." },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://systemfusion.yaesu.com/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "seed_import", "contentHash": "" },
      "rawOtherText": "The window dates exist only inside the title line of a dated fillable PDF stored under /wp-content/uploads/{YYYY}/{MM}/. The landing page is polled for the link; the dates come from the PDF's title. Expect this record to need manual re-verification each time a new window opens.",
      "tags": ["equipment", "repeater", "yaesu", "discount", "pdf-only"]
    },
    {
      "id": "campus-sga-playbook",
      "funderId": "campus-sga",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "campus-sga-playbook" },
      "name": "Campus Student Government / student activity fee funding",
      "klass": "adjacent_stem",
      "summary": "Your own campus student government is, per the research, one of the two most reliably winnable sources of money for a collegiate radio club, and it is the one no aggregator can index: roughly 4,000 campuses with independent rules on Qualtrics, CampusGroups, Presence and Engage. Shipped as a playbook rather than an opportunity.",
      "applicantEntities": ["club_unincorporated", "university_dept"],
      "amount": { "instrument": "cash_range", "amountMin": 250, "amountMax": 5000, "amountRaw": "Representative figures from the FSU rules read on 2026-08-02: programming up to $3,000 (up to $5,000 in extraordinary cases), travel $250 per student and $5,000 per organisation, development fund up to $300 per fiscal year. Your campus will differ.", "awardCountRaw": "Varies; FSU caps event and travel requests at three per fiscal year" },
      "deadline": { "kind": "ad_hoc", "source": { "kind": "self" }, "note": "Hybrid on most campuses: rolling event and travel requests with a lead-time requirement (six weeks at FSU), plus one annual activity-and-service budget cycle. Ask your student government for both calendars." },
      "applyVia": "self_hosted_portal",
      "applyUrl": "https://sga.fsu.edu/accounting/funding-your-rso",
      "constraints": [
        { "id": "sga-rso", "hard": true, "fallbackRank": 0, "rawText": "The club must be a registered student organisation in good standing at the institution.", "spec": { "axis": "other", "note": "Registered student organisation in good standing." } }
      ],
      "fundingRestrictions": ["Capital equipment is frequently barred by student-activity-fee rules. Radios often cannot be bought with this money directly."],
      "obligations": { "costShareRequired": false, "coFunderPreference": false, "reportingObligation": "Most student governments require receipts and a post-event report." },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "open", "sourceUrl": "https://sga.fsu.edu/accounting/funding-your-rso", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "", "staleMirrorWarning": "The figures in this record are FSU's, read live on 2026-08-02, and are included as a representative example. They are not your campus's rules. Read your own student government's allocation manual before you budget." },
      "rawOtherText": "Playbook. 1) Get the allocation manual, not the web summary; the caps and the barred-category list live in the manual. 2) Check whether capital equipment is barred. It usually is. 3) If it is barred, do not ask for a radio: ask for the programme the radio makes possible. A licence class, a Field Day event, a public-service demonstration, a school visit. Budget the consumables, the room, the food and the printing, and fund the radio itself from ARRL, ARDC or a departmental source. 4) Respect the lead-time rule. Six weeks at FSU, and a late request is simply not heard. 5) Track your request count. FSU allows three event or travel requests per organisation per fiscal year. 6) Go to the annual activity-and-service budget cycle for anything recurring; the rolling process is for one-off events. The research is blunt about this: the framing advice in step 3 may be worth more than the entire opportunity index.",
      "tags": ["adjacent", "campus", "sga", "guided-workflow", "playbook"]
    }
  ]
}
```

- [ ] **Step 2: Run the seed test**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/seed/seed.test.ts
```

Expected: 18 passing tests over 24 programs.

- [ ] **Step 3: Commit**

```bash
cd /path/to/grantspotter
git add data/seed/programs.institutional.json
git commit -m "feat(seed): institutional and in-kind records plus the Space Grant and campus SGA playbooks"
```

---

### Task 14: Seed batch 4 — verified negatives, the FAR safety warning, and the disputed ARRL Club Grant

**Files:**
- Create: `data/seed/programs.negatives.json`
- Test: `packages/server/src/seed/negatives.test.ts`

**Interfaces:** consumes Task 11's loader. Produces no new code.

This is the task that stops the next maintainer from re-doing research that has already been done, and stops a student from being walked into a compromised domain. Read all of it before typing.

**Why negative records exist.** Six things in this space look like funding programmes and are not. Each was checked by live fetch on 2026-08-02 and each is recorded as an explicit record with a terminal `status`, so a search for "AMSAT grant" or "CARI funding" returns the finding rather than nothing. An empty result set reads as "GrantSpotter is incomplete"; a record that says *AMSAT has no grants programme, here is what was checked* reads as "GrantSpotter did the work".

**The FAR record is a safety feature.** The Foundation for Amateur Radio's domain 301s to an Indonesian gambling site and QCWA, ARRL and club pages still tell applicants to apply there. The record must (a) exist, so a search for "FAR" finds it, (b) explain what happened, (c) point at the ARRL Foundation where FAR's portfolio appears to have gone, and (d) contain **no link to the compromised domain in any URL field**. The domain name appears in prose only. `assertNotBlocked` in the Task 11 test enforces (d) mechanically, and this task adds a test that enforces it as a string check too, because a blocklist that matches on host would not catch a link buried in a text field.

**The ARRL Club Grant ships `disputed`.** Three researchers reached three different conclusions about its cycle: dormant with no open cycle; an autumn window (Sep 7 to Nov 4 in 2022, "open until November 4"); and a February/June/October pattern, which the third researcher argues is a conflation with the separate ARRL Amateur Radio Grants windows. The page publishes 2024 results, no open cycle and no application link, and the portal behind it is a JavaScript app that returns no server-side text. The record shows all three readings with their sources instead of picking one. Spec §8 names this as the shipped example of the `disputed` surface.

- [ ] **Step 1: Write the failing negatives test**

Create `packages/server/src/seed/negatives.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadSeedCorpus, seedDir } from './load.js';

const corpus = loadSeedCorpus(seedDir());
const byId = new Map(corpus.programs.map((p) => [p.id, p]));

const REQUIRED_NEGATIVES = [
  'arrl-cari-not-a-funding-program',
  'amsat-no-grants-program',
  'flexradio-no-education-tier',
  'vendor-equipment-relationship-playbook',
  'dara-grantmaker-only-via-arrl',
  'chicago-fm-club-scholarship-discontinued',
  'far-domain-compromised',
];

describe('verified negatives', () => {
  it('ships every negative record the research established', () => {
    for (const id of REQUIRED_NEGATIVES) {
      expect(byId.has(id), `missing negative record ${id}`).toBe(true);
    }
  });

  it('gives every negative a terminal status and no false deadline', () => {
    for (const id of REQUIRED_NEGATIVES) {
      const program = byId.get(id)!;
      expect(['discontinued', 'no_application', 'contact_only', 'unknown']).toContain(program.trust.status);
      expect(['no_application_exists', 'dormant', 'unpublished', 'rolling']).toContain(program.deadline.kind);
    }
  });

  it('makes every negative searchable by the name a user would type', () => {
    const searchable = (needle: string): boolean =>
      corpus.programs.some((p) =>
        `${p.name} ${p.summary} ${p.tags.join(' ')}`.toLowerCase().includes(needle.toLowerCase()));
    for (const needle of ['CARI', 'AMSAT', 'FlexRadio', 'Icom', 'DX Engineering', 'Kenwood', 'Hamvention', 'Chicago FM Club', 'Foundation for Amateur Radio']) {
      expect(searchable(needle), `not searchable: ${needle}`).toBe(true);
    }
  });
});

describe('the FAR safety record', () => {
  const far = byId.get('far-domain-compromised')!;

  it('exists, is discontinued, and has no application path', () => {
    expect(far.trust.status).toBe('discontinued');
    expect(far.applyVia).toBe('none');
    expect(far.applyUrl).toBeUndefined();
  });

  it('explains the compromise, the takeover window and where the portfolio went', () => {
    const text = `${far.summary} ${far.rawOtherText} ${far.trust.staleMirrorWarning ?? ''}`;
    expect(text).toContain('gambling');
    expect(text).toContain('2025-10-17');
    expect(text).toContain('2026-02-10');
    expect(text).toContain('ARRL Foundation');
  });

  it('links nowhere near the compromised domain, in any field of any record', () => {
    const urls: string[] = [];
    for (const funder of corpus.funders) urls.push(funder.homepage);
    for (const program of corpus.programs) {
      urls.push(program.trust.sourceUrl, program.applyUrl ?? '', program.aiPolicy.url ?? '');
      for (const claim of program.trust.disputed?.claims ?? []) urls.push(claim.sourceUrl);
    }
    for (const url of urls) {
      expect(url).not.toContain('farweb');
      expect(url).not.toContain('batualam');
    }
  });

  it('warns that third parties still send applicants to the dead domain', () => {
    expect(far.trust.staleMirrorWarning ?? '').toMatch(/QCWA|ARRL|club pages/);
  });
});

describe('the ARRL Club Grant disputed record', () => {
  const club = byId.get('arrl-club-grant')!;

  it('ships with disputed populated and a status that does not pretend to know', () => {
    expect(club.trust.disputed).toBeDefined();
    expect(club.trust.status).toBe('unknown');
    expect(club.deadline.kind).toBe('dormant');
  });

  it('records all three researcher readings, each with its own source', () => {
    const claims = club.trust.disputed!.claims;
    expect(claims.length).toBe(3);
    for (const claim of claims) {
      expect(claim.claim.length).toBeGreaterThan(10);
      expect(claim.sourceUrl.startsWith('http')).toBe(true);
    }
    const joined = claims.map((c) => c.claim).join(' ');
    expect(joined).toMatch(/dormant/i);
    expect(joined).toMatch(/autumn|November/i);
    expect(joined).toMatch(/February/i);
  });

  it('keeps the real, verified facts about the programme intact', () => {
    expect(club.amount.amountMin).toBe(1000);
    expect(club.amount.amountMax).toBe(25000);
    expect(club.summary).toContain('$500,502');
  });
});

describe('the Chicago FM Club stale-mirror record', () => {
  const chicago = byId.get('chicago-fm-club-scholarship-discontinued')!;

  it('is marked discontinued and says how many aggregators still list it', () => {
    expect(chicago.trust.status).toBe('discontinued');
    expect(chicago.trust.staleMirrorWarning ?? '').toContain('aggregator');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/seed/negatives.test.ts
```

Expected failure: `missing negative record arrl-cari-not-a-funding-program`.

- [ ] **Step 3: Write `data/seed/programs.negatives.json`**

```json
{
  "programs": [
    {
      "id": "arrl-club-grant",
      "funderId": "arrl-foundation",
      "sourceKey": { "sourceId": "arrl-club-grant", "externalKey": "club-grant-program" },
      "name": "ARRL Club Grant Program",
      "klass": "ham_grant",
      "summary": "Grants of $1,000 to $25,000 to ARRL-affiliated clubs, collegiate clubs included. In 2024 the programme distributed $500,502 to 37 of 110 applicants, who between them requested about $1.6M; 2024 recipients include Kansas State, Missouri S&T, Oklahoma State, Baylor WA5BU and City Tech. The cycle is disputed: the page shows only 2024 results, no open cycle and no application link.",
      "applicantEntities": ["club_unincorporated", "club_501c3", "university"],
      "amount": { "instrument": "cash_range", "amountMin": 1000, "amountMax": 25000, "amountRaw": "$1,000-$25,000. 2024 actual: $500,502 across 37 of 110 applicants.", "awardCountRaw": "37 in 2024" },
      "deadline": { "kind": "dormant", "source": { "kind": "self" }, "note": "The cycle could not be resolved on 2026-08-02 and this record deliberately does not guess. The page publishes 2024 results, no open cycle and no application link, and the application portal is a JavaScript app that returns no server-side text, so open or closed status cannot be determined programmatically. The three readings the research produced are recorded in the disputed field below. The only reliable change signal is the ARRL news RSS feed." },
      "applyVia": "external_spa_portal",
      "applyUrl": "https://www.arrl.org/club-grant-program",
      "constraints": [
        { "id": "club-grant-affiliated", "hard": true, "fallbackRank": 0, "rawText": "The applying club must be ARRL-affiliated.", "spec": { "axis": "arrl_membership", "required": true, "minYears": 0 } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": true },
      "aiPolicy": { "stance": "unaddressed", "url": "https://www.arrl.org/club-grant-program" },
      "trust": {
        "status": "unknown",
        "sourceUrl": "https://www.arrl.org/club-grant-program",
        "lastVerifiedAt": "2026-08-02",
        "verificationMethod": "seed_import",
        "contentHash": "",
        "disputed": {
          "note": "Three researchers reached three different conclusions about this programme's cycle on the same day. GrantSpotter shows all three rather than picking one. Do not treat any of them as the answer; watch the ARRL news feed and re-verify.",
          "claims": [
            { "claim": "Dormant: the page shows only 2024 results, no open cycle and no application link, so there may be no current cycle at all.", "sourceUrl": "https://www.arrl.org/club-grant-program" },
            { "claim": "An autumn window: the 2022 cycle ran September 7 to November 4 and was described as 'open until November 4'.", "sourceUrl": "http://www.arrl.org/news" },
            { "claim": "A February, June and October pattern. A third researcher argues this is a conflation with the separate ARRL Amateur Radio Grants windows, which really are February 1-28, June 1-30 and October 1-31.", "sourceUrl": "http://www.arrl.org/amateur-radio-grants" }
          ]
        }
      },
      "rawOtherText": "This programme is funded by ARDC. If you are looking for an ARRL organisation grant with a published, verifiable window right now, the ARRL Amateur Radio Grants programme is the one with dates on the page.",
      "tags": ["ham", "grant", "arrl", "club", "collegiate", "disputed"]
    },
    {
      "id": "arrl-cari-not-a-funding-program",
      "funderId": "arrl",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "negative-arrl-cari" },
      "name": "ARRL Collegiate Amateur Radio Initiative (CARI) — not a funding program",
      "klass": "ham_grant",
      "summary": "CARI is not funding. It is a community programme: Zoom meetups, the Collegiate QSO Party, and networking at Hamvention. Two researchers confirmed this independently on 2026-08-02. The W1YSM Snyder endowment funds CARI activities but has no open application of any kind.",
      "applicantEntities": ["university", "club_unincorporated"],
      "amount": { "instrument": "unknown", "amountRaw": "No money is awarded to applicants. CARI is a community programme.", "awardCountRaw": "None" },
      "deadline": { "kind": "no_application_exists", "source": { "kind": "self" }, "note": "There is no application and no deadline because there is nothing to apply for." },
      "applyVia": "none",
      "constraints": [],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "no_application", "sourceUrl": "http://www.arrl.org/collegiate-amateur-radio", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "Recorded as an explicit negative so a future maintainer does not spend another research pass looking for a CARI grant. If you want ARRL money for a collegiate club, the routes are the Club Grant Program and the Amateur Radio Grants programme.",
      "tags": ["negative", "arrl", "cari", "collegiate", "not-funding"]
    },
    {
      "id": "amsat-no-grants-program",
      "funderId": "amsat",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "negative-amsat" },
      "name": "AMSAT — no grants program exists",
      "klass": "ham_grant",
      "summary": "AMSAT does not make grants. Its university-participation page is a near-empty stub naming a single RIT project. AMSAT is a grant recipient, through ARISS and ARDC, not a grantmaker. Confirmed by two researchers on 2026-08-02.",
      "applicantEntities": ["university", "club_unincorporated"],
      "amount": { "instrument": "unknown", "amountRaw": "No grants are made.", "awardCountRaw": "None" },
      "deadline": { "kind": "no_application_exists", "source": { "kind": "self" }, "note": "No application exists." },
      "applyVia": "none",
      "constraints": [],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "no_application", "sourceUrl": "https://www.amsat.org/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "If your project is satellite-adjacent, the real routes are ARISS-USA for an ISS contact, NASA CSLI for launch services, and your state's NASA Space Grant consortium for cash.",
      "tags": ["negative", "amsat", "satellite", "not-funding"]
    },
    {
      "id": "flexradio-no-education-tier",
      "funderId": "flexradio",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "negative-flexradio" },
      "name": "FlexRadio — no education, student, club or nonprofit purchasing tier",
      "klass": "equipment_in_kind",
      "summary": "FlexRadio's purchasing-programs page was fetched specifically to check for an education discount on 2026-08-02. There is none. The only programmes are the Certified Pre-Owned scheme and trade-ins, both open to anybody.",
      "applicantEntities": ["university", "club_unincorporated", "individual"],
      "amount": { "instrument": "unknown", "amountRaw": "No education, student, club or nonprofit pricing exists.", "awardCountRaw": "None" },
      "deadline": { "kind": "no_application_exists", "source": { "kind": "self" }, "note": "No application exists." },
      "applyVia": "none",
      "constraints": [],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "no_application", "sourceUrl": "https://www.flexradio.com/purchasing-programs/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "For discounted radio hardware the verified route in this corpus is the Yaesu System Fusion DR-2X repeater programme, which is a discounted purchase rather than a grant.",
      "tags": ["negative", "flexradio", "equipment", "no-education-tier"]
    },
    {
      "id": "vendor-equipment-relationship-playbook",
      "funderId": "icom-america",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "negative-icom-dxengineering-kenwood" },
      "name": "Icom America, DX Engineering and Kenwood — real equipment, no application path",
      "klass": "equipment_in_kind",
      "summary": "Genuine collegiate giving happens here: IC-7610 transceivers have gone to Carnegie Mellon's W3VC, Penn State's K3CR and Pitt's W3YI. But there is no application programme, no page and no deadline. It is relationship-driven, and Kenwood has nothing at all. Shipped as a playbook, not an opportunity.",
      "applicantEntities": ["university", "club_unincorporated", "club_501c3"],
      "amount": { "instrument": "in_kind_equipment", "amountRaw": "Equipment donations of real value have been made, but no programme, price list or award schedule is published.", "awardCountRaw": "No published count" },
      "deadline": { "kind": "no_application_exists", "source": { "kind": "self" }, "note": "There is no deadline because there is no application. Approaches are made person to person." },
      "applyVia": "contact_person",
      "constraints": [],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false, "sustainmentObligation": "Donors expect visible use: contest results, public-service events, student training, and their name on it." },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "contact_only", "sourceUrl": "https://www.icomamerica.com/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "" },
      "rawOtherText": "Playbook. 1) Do not send a cold form; there is no form. 2) Build the record first: a contest score, a Field Day writeup, a licence class you taught, students named. 3) Approach at a hamfest or Hamvention, in person, with a one-page ask naming the exact model and what students will do with it. 4) Bring your faculty advisor and your callsign history. 5) Offer what a vendor actually wants: photographs, a results writeup, students at their booth, and the club callsign attached to a story worth repeating. 6) Ask your ARRL Section Manager for an introduction. Documented outcomes: IC-7610s at Carnegie Mellon W3VC, Penn State K3CR and Pitt W3YI. Kenwood: nothing found at all as of 2026-08-02.",
      "tags": ["negative", "equipment", "icom", "dx-engineering", "kenwood", "playbook", "relationship-driven"]
    },
    {
      "id": "dara-grantmaker-only-via-arrl",
      "funderId": "dara",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "negative-dara-hamvention" },
      "name": "DARA / Hamvention — a grantmaker only through its ARRL catalog entry",
      "klass": "ham_scholarship",
      "summary": "The Dayton Amateur Radio Association funds a real $1,500 scholarship, but only as an entry in the ARRL Foundation catalog. Its own sites carry nothing: zero hrefs containing 'scholar' or 'grant' on w8bi.org, no scholarship page on hamvention.org, and daytonhamvention.org did not resolve on 2026-08-02.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "cash_fixed", "amountMin": 1500, "amountMax": 1500, "amountRaw": "$1,500, multiple per year, awarded through the ARRL Foundation catalog.", "awardCountRaw": "Multiple per year" },
      "deadline": { "kind": "unpublished", "source": { "kind": "inherited", "fromProgramId": "arrl-foundation-scholarships" }, "note": "Applications go through the single ARRL Foundation scholarship application; DARA publishes no separate deadline anywhere." },
      "applyVia": "external_spa_portal",
      "applyUrl": "http://www.arrl.org/scholarship-program",
      "constraints": [
        { "id": "dara-institution", "hard": true, "fallbackRank": 0, "rawText": "Any licence class, any region, any field of study; must be enrolled at an accredited four-year institution.", "spec": { "axis": "institution", "degreeLevels": ["BACH"], "tradeSchoolOK": false, "partTimeOK": false, "accreditationRequired": true } }
      ],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "unknown", "sourceUrl": "http://www.arrl.org/scholarship-descriptions", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "", "staleMirrorWarning": "Do not go looking for a DARA or Hamvention scholarship page. There is not one. The ARRL catalog entry is the whole programme." },
      "rawOtherText": "Recorded as a negative about the funder's own web presence, not about the money, which is real. The catalog entry generated from the ARRL fixture is the authoritative record of the award terms.",
      "tags": ["negative", "dara", "hamvention", "scholarship", "arrl-catalog-only"]
    },
    {
      "id": "chicago-fm-club-scholarship-discontinued",
      "funderId": "chicago-fm-club",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "negative-chicago-fm-club" },
      "name": "Chicago FM Club Scholarship — discontinued",
      "klass": "ham_scholarship",
      "summary": "Discontinued. There are zero hits for it in the live ARRL scholarship catalog, and 325 KB of chicagofmclub.org was fetched on 2026-08-02 without a single occurrence of the word 'scholarship'. It is still listed by seven or more third-party aggregators, which is direct evidence that those sites mirror stale ARRL data rather than checking.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "unknown", "amountRaw": "Not awarded. The programme no longer exists.", "awardCountRaw": "None" },
      "deadline": { "kind": "no_application_exists", "source": { "kind": "self" }, "note": "No application exists. Any deadline you find for this scholarship comes from a stale mirror." },
      "applyVia": "none",
      "constraints": [],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": { "status": "discontinued", "sourceUrl": "https://chicagofmclub.org/", "lastVerifiedAt": "2026-08-02", "verificationMethod": "manual_curation", "contentHash": "", "staleMirrorWarning": "Seven or more third-party scholarship aggregators still list this scholarship as open. It is not. Those sites mirror an old copy of the ARRL catalog and do not re-check it; treat every other listing they carry with the same suspicion." },
      "rawOtherText": "This record exists as a worked example of the stale-mirror problem: the aggregators that list it have never re-read the ARRL catalog it came from.",
      "tags": ["negative", "discontinued", "scholarship", "stale-mirror", "illinois"]
    },
    {
      "id": "far-domain-compromised",
      "funderId": "far",
      "sourceKey": { "sourceId": "manual-tier-d", "externalKey": "far-farweb-org-compromised" },
      "name": "Foundation for Amateur Radio (FAR) — domain compromised, do not visit",
      "klass": "ham_scholarship",
      "summary": "The Foundation for Amateur Radio's website is no longer under the foundation's control. The domain now issues a 301 redirect to an Indonesian gambling site. Do not visit it and do not send an application to it. FAR's historical scholarship portfolio, which included the 10-10, QCWA, YASME, K3IVO and CARA funds, appears to have been absorbed into the ARRL Foundation, which is where you should look instead.",
      "applicantEntities": ["individual"],
      "amount": { "instrument": "unknown", "amountRaw": "No award is available through this organisation's former website.", "awardCountRaw": "None" },
      "deadline": { "kind": "no_application_exists", "source": { "kind": "self" }, "note": "There is no application. Any page that tells you to apply at the FAR website is out of date and is sending you to a compromised domain." },
      "applyVia": "none",
      "constraints": [],
      "fundingRestrictions": [],
      "obligations": { "costShareRequired": false, "coFunderPreference": false },
      "aiPolicy": { "stance": "unaddressed" },
      "trust": {
        "status": "discontinued",
        "sourceUrl": "http://www.arrl.org/arrl-foundation",
        "lastVerifiedAt": "2026-08-02",
        "verificationMethod": "manual_curation",
        "contentHash": "",
        "staleMirrorWarning": "QCWA, ARRL and multiple club pages still instruct applicants to 'apply at the FAR website'. Those instructions are stale and they point at a compromised domain. Apply through the ARRL Foundation instead."
      },
      "rawOtherText": "What happened, in full, so nobody has to research it again. The former FAR domain (farweb dot org) issues an HTTP 301 to an Indonesian gambling site whose page title begins TARGET88. The Internet Archive pins the takeover between 2025-10-17 and 2026-02-10. Three researchers confirmed the redirect independently on 2026-08-02. GrantSpotter hard-blocklists that domain in the fetcher itself, not in configuration, so no crawl, no 'Verify now' click and no user-supplied source can reach it. This record carries no link to it in any URL field, deliberately. If you are looking for one of FAR's former scholarships, search the ARRL Foundation catalog: the 10-10, QCWA, YASME, K3IVO and CARA funds all appear there now.",
      "tags": ["negative", "safety", "far", "compromised-domain", "blocklisted", "scholarship"]
    }
  ]
}
```

- [ ] **Step 4: Run both seed test files and watch them pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/seed/
```

Expected: 18 passing tests in `seed.test.ts` (now over 32 programs) and 8 in `negatives.test.ts`.

- [ ] **Step 5: Prove the blocklist really would stop the compromised domain**

This is a two-line sanity check that the fetcher-level defence and the seed-level defence agree. Add it to the bottom of `packages/server/src/seed/negatives.test.ts`:

```ts
import { assertNotBlocked, BLOCKED_HOSTS } from '../fetcher/blocklist.js';

describe('the blocklist backs up the FAR record', () => {
  it('lists the compromised domain and every commercial aggregator', () => {
    for (const host of ['farweb.org', 'candid.org', 'fconline.foundationcenter.org', 'grantwatch.com', 'grantstation.com', 'instrumentl.com']) {
      expect(BLOCKED_HOSTS).toContain(host);
    }
  });

  it('throws for the compromised domain on any scheme, subdomain or path', () => {
    for (const url of ['https://farweb.org/', 'http://www.farweb.org/scholarships', 'https://FARWEB.ORG/apply']) {
      expect(() => assertNotBlocked(url)).toThrow();
    }
  });
});
```

Re-run:

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/seed/negatives.test.ts
```

Expected: 10 passing tests. If `BLOCKED_HOSTS` stores hosts with a leading dot or a scheme, adjust the expectation to match Plan 2's actual representation — do not change Plan 2's blocklist to match this test.

- [ ] **Step 6: Commit**

```bash
cd /path/to/grantspotter
git add data/seed/programs.negatives.json packages/server/src/seed/negatives.test.ts
git commit -m "feat(seed): verified negatives, the FAR compromised-domain warning, and the disputed ARRL Club Grant"
```

---

### Task 15: Generate the 111 ARRL catalog seed records from the committed fixture

**Files:**
- Create: `scripts/generate-arrl-seed.ts`
- Create: `data/seed/programs.arrl-catalog.json` (generated, then committed)
- Test: `packages/server/src/seed/arrlCatalog.test.ts`
- Modify: `package.json` (add `"seed:arrl": "tsx scripts/generate-arrl-seed.ts"` to the root scripts block)

**Interfaces:**
- Consumes: Plan 2's `SourceModule` registry and its committed fixture under `fixtures/<sourceId>/`; `FetchedPayload`, `RawOpportunity` (CONTRACT §3); `parseAmount` (CONTRACT §4); `SeedSourceKey` from Task 11's loader.
- Produces: `data/seed/programs.arrl-catalog.json` and, inside the script, `export type SeedProgram = Program & { sourceKey: SeedSourceKey }` and `export function rawToProgram(raw: RawOpportunity): SeedProgram` — both **plan-local**.

Why this is generated and not typed by hand: the ARRL Foundation catalog is 111 entries, roughly 75% of the whole corpus. Typing them by hand would introduce transcription errors into the single densest source in the space, and the errors would be invisible. Plan 2 already committed the real page as a fixture and already wrote the parser that turns it into `RawOpportunity[]`. This script runs that parser offline, maps its output onto `Program`, and commits the result. Re-running it after a fixture refresh is a one-command, reviewable diff.

Domain facts that shape the mapping:

- The catalog uses a small, regular label vocabulary. Across 111 entries the label frequencies are: Field of Study 111, License Requirement 110, Region 109, Institution 107, Award Amount 101, Number of Awards 100, Other 65, Age 4.
- **The labels are typo'd in the wild**: `R egion`, `License   Requirement` with runs of spaces, `Scholarshp`. The mapper therefore normalises a label by lower-casing it and deleting every non-alphanumeric character before matching, which collapses all three.
- **A naive maximum-dollar regex is wrong.** One catalog entry contains $100,000, which is the size of an *endowment*, not of an award. `parseAmount` (Plan 1) already handles this; the script must use it rather than writing its own regex.
- **`entryCount` is not `awardCount`.** 111 entries yield 170-plus awards; the ARDC entry alone carries 45 and QCWA carries 19. `awardCountRaw` stays a string because the real values include `1 per year`, `Three`, `Multiple per year` and `19`.
- **All 111 entries share one deadline**, owned by `arrl-foundation-scholarships` from Task 11. Every generated record therefore gets `deadline.source = { kind: 'inherited', fromProgramId: 'arrl-foundation-scholarships' }`. That id is Plan 4's canonical one (RESOLUTIONS R9); typing the old `arrl-foundation-scholarship-program` here would leave 111 records inheriting from a program that does not exist, and `expandCycles` would return nothing for every one of them.
- **Every generated record carries a `sourceKey`** of `{ sourceId: raw.sourceId, externalKey: raw.externalKey }` — for this parser, `arrl-scholarship-descriptions` and the entry name. That is the pair the nightly crawl produces, so the crawler resolves the seeded row instead of minting a second id for all 111 entries on night one.
- Several entries are administered by other organisations whose intake runs through ARRL. The script maps those to their own funder ids so the funder page links somewhere useful; everything else belongs to `arrl-foundation`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/seed/arrlCatalog.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { loadSeedCorpus, seedDir } from './load.js';

const corpus = loadSeedCorpus(seedDir());
const catalog = corpus.programs.filter((p) => p.id.startsWith('arrl-cat-'));

describe('generated ARRL catalog seed', () => {
  it('contains at least 100 entries', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(100);
  });

  it('inherits its deadline from the scholarship programme record', () => {
    for (const program of catalog) {
      expect(program.deadline.kind).toBe('inherited');
      expect(program.deadline.source).toEqual({
        kind: 'inherited',
        fromProgramId: 'arrl-foundation-scholarships',
      });
    }
  });

  it('classifies every entry as a ham scholarship for an individual', () => {
    for (const program of catalog) {
      expect(program.klass).toBe('ham_scholarship');
      expect(program.applicantEntities).toEqual(['individual']);
    }
  });

  it('cites the catalog page and the research date on every entry', () => {
    for (const program of catalog) {
      expect(program.trust.sourceUrl).toBe('http://www.arrl.org/scholarship-descriptions');
      expect(program.trust.lastVerifiedAt).toBe('2026-08-02');
    }
  });

  it('preserves at least one verbatim constraint per entry', () => {
    for (const program of catalog) {
      expect(program.constraints.length).toBeGreaterThan(0);
      for (const constraint of program.constraints) {
        expect(constraint.rawText.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('never invents an amount: an entry with no parsed figure keeps amountRaw and omits min and max', () => {
    for (const program of catalog) {
      expect(program.amount.amountRaw.length).toBeGreaterThan(0);
      if (program.amount.amountMin === undefined) {
        expect(program.amount.amountMax).toBeUndefined();
      }
    }
  });

  it('never records the $100,000 endowment figure as an award ceiling', () => {
    for (const program of catalog) {
      expect(program.amount.amountMax ?? 0).toBeLessThan(100000);
    }
  });

  it('keeps awardCountRaw verbatim, including non-numeric values', () => {
    const values = catalog.map((p) => p.amount.awardCountRaw);
    expect(values.some((v) => /per year|Multiple|Three|\d/i.test(v))).toBe(true);
  });

  it('routes the entries administered by other organisations to their own funders', () => {
    const funderIds = new Set(catalog.map((p) => p.funderId));
    expect(funderIds.has('arrl-foundation')).toBe(true);
    for (const id of funderIds) {
      expect(corpus.funders.some((f) => f.id === id)).toBe(true);
    }
  });

  it('does not duplicate a hand-curated record', () => {
    const curated = new Set(corpus.programs.filter((p) => !p.id.startsWith('arrl-cat-')).map((p) => p.name.toLowerCase()));
    for (const program of catalog) {
      expect(curated.has(program.name.toLowerCase())).toBe(false);
    }
  });

  it('carries the crawler identity that stops the nightly crawl duplicating all 111', () => {
    for (const program of catalog) {
      const key = corpus.sourceKeys.get(program.id);
      expect(key, `no sourceKey on ${program.id}`).toBeDefined();
      expect(key!.sourceId).toBe('arrl-scholarship-descriptions');
      expect(key!.externalKey.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/seed/arrlCatalog.test.ts
```

Expected failure: `expected 0 to be greater than or equal to 100`.

- [ ] **Step 3: Write the generator script**

Create `scripts/generate-arrl-seed.ts`:

```ts
/**
 * Generates data/seed/programs.arrl-catalog.json from the committed Plan 2 fixture.
 * Offline: it runs the source module's own parser over saved payloads and never
 * touches the network. Re-run it after refreshing the fixture:
 *   npm run seed:arrl
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAmount } from '@grantspotter/core';
import type {
  Program, Constraint, LicenseClass, DegreeLevel, FetchedPayload, RawOpportunity, SourceModule,
} from '@grantspotter/core';
import * as registryModule from '../packages/server/src/sources/registry.js';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const LAST_VERIFIED = '2026-08-02';
const CATALOG_URL = 'http://www.arrl.org/scholarship-descriptions';
const APPLY_URL = 'http://www.arrl.org/scholarship-program';
const PARENT_PROGRAM_ID = 'arrl-foundation-scholarships';

/** Finds the SourceModule[] the registry exports, whatever it is named. */
function allSourceModules(): SourceModule[] {
  const found: SourceModule[] = [];
  for (const value of Object.values(registryModule as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === 'object' && 'id' in entry && 'parse' in entry) found.push(entry as SourceModule);
      }
    } else if (value && typeof value === 'object' && 'id' in value && 'parse' in value) {
      found.push(value as SourceModule);
    }
  }
  return found;
}

/** The ARRL catalog is the only source in the corpus expecting 100+ records. */
function catalogModule(): SourceModule {
  const candidates = allSourceModules().filter((m) => m.expectedMinRecords >= 100);
  if (candidates.length === 0) {
    throw new Error('No source module expects 100+ records. Plan 2 must ship the ARRL scholarship parser first.');
  }
  return candidates.sort((a, b) => b.expectedMinRecords - a.expectedMinRecords)[0];
}

function loadFixturePayloads(mod: SourceModule): FetchedPayload[] {
  const dir = join(REPO_ROOT, 'fixtures', mod.id);
  if (!existsSync(dir)) throw new Error(`No fixture directory at fixtures/${mod.id}`);
  const staticRequests = Array.isArray(mod.requests) ? mod.requests : [];
  const files = readdirSync(dir).filter((f) => ['.html', '.json', '.xml'].includes(extname(f))).sort();
  if (files.length === 0) throw new Error(`fixtures/${mod.id} contains no .html, .json or .xml payload`);
  return files.map((file, index) => {
    const body = readFileSync(join(dir, file), 'utf8');
    const ext = extname(file);
    return {
      url: staticRequests[index]?.url ?? staticRequests[0]?.url ?? CATALOG_URL,
      status: 200,
      contentType: ext === '.json' ? 'application/json' : ext === '.xml' ? 'application/xml' : 'text/html',
      body,
      fetchedAt: `${LAST_VERIFIED}T00:00:00.000Z`,
    };
  });
}

/** Label lookup that survives 'R egion', 'License   Requirement' and 'Scholarshp'. */
function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const FIELD_ALIASES: Record<string, string[]> = {
  fieldOfStudy: ['fieldofstudy', 'fieldsofstudy', 'majorfieldofstudy'],
  license: ['licenserequirement', 'license', 'licenceclass', 'licenserequirements'],
  region: ['region', 'regions', 'geography'],
  institution: ['institution', 'institutions', 'school'],
  amount: ['awardamount', 'amount', 'awardamounts', 'scholarshpamount'],
  awardCount: ['numberofawards', 'numberofaward', 'awards', 'numberofscholarships'],
  age: ['age', 'agerange'],
  other: ['other', 'othercriteria', 'notes'],
};

function pick(fields: Record<string, string>, alias: keyof typeof FIELD_ALIASES): string {
  const wanted = FIELD_ALIASES[alias];
  for (const [key, value] of Object.entries(fields)) {
    if (wanted.includes(normaliseKey(key))) return value.trim();
  }
  return '';
}

function unmappedFields(fields: Record<string, string>): string {
  const known = new Set(Object.values(FIELD_ALIASES).flat());
  return Object.entries(fields)
    .filter(([key]) => !known.has(normaliseKey(key)))
    .map(([key, value]) => `${key.trim()}: ${value.trim()}`)
    .join('\n');
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

const FUNDER_PATTERNS: Array<[RegExp, string]> = [
  [/\bARDC\b|Amateur Radio Digital Communications/i, 'ardc'],
  [/\bQCWA\b|Quarter Century/i, 'qcwa'],
  [/\bYASME\b/i, 'yasme'],
  [/\bDayton\b|\bDARA\b/i, 'dara'],
  [/Six Meter Club/i, 'six-meter-club-chicago'],
  [/Yankee Clipper|\bYCCC\b/i, 'yccc'],
];

function funderFor(name: string): string {
  for (const [pattern, id] of FUNDER_PATTERNS) if (pattern.test(name)) return id;
  return 'arrl-foundation';
}

function licenseClassFrom(text: string): LicenseClass {
  if (/\bextra\b/i.test(text)) return 'EXTRA';
  if (/\bgeneral\b|\badvanced\b/i.test(text)) return 'GENERAL';
  if (/\btechnician\b|\btech\b/i.test(text)) return 'TECH';
  if (/\bany\b|\ball classes\b|\bany class\b/i.test(text)) return 'TECH';
  if (/\bnone\b|not required/i.test(text)) return 'NONE';
  return 'TECH';
}

function degreeLevelsFrom(text: string): DegreeLevel[] {
  const levels: DegreeLevel[] = [];
  if (/certificate|technical school|trade school|vocational/i.test(text)) levels.push('CERT');
  if (/associate|two-year|2-year|community college/i.test(text)) levels.push('ASSOC');
  if (/bachelor|four-year|4-year|undergraduate|baccalaureate/i.test(text)) levels.push('BACH');
  if (/graduate|master|doctora|post-graduate|postgraduate/i.test(text)) levels.push('GRAD');
  return levels.length > 0 ? levels : ['CERT', 'ASSOC', 'BACH', 'GRAD'];
}

const RADIUS_RE = /within\s+(\d{1,4})\s*miles?\s+of\s+([^.;,]+)/i;
const DIVISION_RE = /ARRL\s+([A-Z][a-zA-Z ]+?)\s+Division/;
const SECTION_RE = /ARRL\s+([A-Z][a-zA-Z ]+?)\s+Section/;
const STATE_ABBREVS = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR'];

function geoConstraint(region: string, id: string): Constraint | undefined {
  if (!region) return undefined;
  const hard = !/preference|preferred/i.test(region);
  const base = { id, hard, fallbackRank: 0, rawText: region };

  const radius = RADIUS_RE.exec(region);
  if (radius) {
    return { ...base, spec: { axis: 'geography', geo: { type: 'radius', values: [], radiusMiles: Number(radius[1]), centerLabel: radius[2].trim() } } };
  }
  const division = DIVISION_RE.exec(region);
  if (division) {
    return { ...base, spec: { axis: 'geography', geo: { type: 'arrl_division', values: [division[1].trim()] } } };
  }
  const section = SECTION_RE.exec(region);
  if (section) {
    return { ...base, spec: { axis: 'geography', geo: { type: 'arrl_section', values: [section[1].trim()] } } };
  }
  const states = STATE_ABBREVS.filter((s) => new RegExp(`\\b${s}\\b`).test(region));
  if (states.length > 0 && !/^any\b/i.test(region)) {
    return { ...base, spec: { axis: 'geography', geo: { type: 'state', values: states } } };
  }
  return { ...base, hard: false, spec: { axis: 'geography', geo: { type: 'any', values: [] } } };
}

/** PLAN-LOCAL. A Program plus the crawler identity that owns it (RESOLUTIONS R9). */
export type SeedProgram = Program & { sourceKey: { sourceId: string; externalKey: string } };

export function rawToProgram(raw: RawOpportunity): SeedProgram {
  const fields = raw.rawFields;
  const fieldOfStudy = pick(fields, 'fieldOfStudy');
  const license = pick(fields, 'license');
  const region = pick(fields, 'region');
  const institution = pick(fields, 'institution');
  const amountRaw = pick(fields, 'amount');
  const awardCountRaw = pick(fields, 'awardCount');
  const age = pick(fields, 'age');
  const other = pick(fields, 'other');

  const id = `arrl-cat-${slug(raw.name)}`;
  const constraints: Constraint[] = [];

  if (license) {
    constraints.push({
      id: `${id}-license`,
      hard: !/preference|preferred/i.test(license),
      fallbackRank: 0,
      rawText: license,
      spec: {
        axis: 'license',
        licenseMin: licenseClassFrom(license),
        foreignLicenseOK: /foreign|outside the United States|non-US|worldwide/i.test(license),
      },
    });
  }

  const geo = geoConstraint(region, `${id}-region`);
  if (geo) constraints.push(geo);

  if (fieldOfStudy) {
    const [allowed, excluded] = fieldOfStudy.split(/\bexcept\b/i);
    constraints.push({
      id: `${id}-field`,
      hard: !/preference|preferred/i.test(fieldOfStudy),
      fallbackRank: 0,
      rawText: fieldOfStudy,
      spec: {
        axis: 'field_of_study',
        fields: allowed.split(/[,;/]| or /).map((f) => f.trim()).filter((f) => f.length > 0),
        excludedFields: (excluded ?? '').split(/[,;/]| or /).map((f) => f.trim()).filter((f) => f.length > 0),
      },
    });
  }

  if (institution) {
    constraints.push({
      id: `${id}-institution`,
      hard: !/preference|preferred/i.test(institution),
      fallbackRank: 0,
      rawText: institution,
      spec: {
        axis: 'institution',
        degreeLevels: degreeLevelsFrom(institution),
        tradeSchoolOK: /trade|technical|vocational|certificate/i.test(institution),
        partTimeOK: /part-time|part time/i.test(institution),
        accreditationRequired: /accredited/i.test(institution),
      },
    });
  }

  if (age) {
    const numbers = (age.match(/\d{1,2}/g) ?? []).map(Number);
    constraints.push({
      id: `${id}-age`,
      hard: true,
      fallbackRank: 0,
      rawText: age,
      spec: {
        axis: 'age_stage',
        ageMin: numbers.length > 1 ? Math.min(...numbers) : undefined,
        ageMax: numbers.length > 0 ? Math.max(...numbers) : undefined,
        stages: [],
      },
    });
  }

  if (other) {
    constraints.push({ id: `${id}-other`, hard: false, fallbackRank: 1, rawText: other, spec: { axis: 'other', note: other.slice(0, 300) } });
  }

  if (constraints.length === 0) {
    constraints.push({
      id: `${id}-catalog`,
      hard: true,
      fallbackRank: 0,
      rawText: 'Applicants must hold an FCC amateur radio licence and be enrolled in an accredited post-secondary programme, per the ARRL Foundation scholarship programme rules.',
      spec: { axis: 'license', licenseMin: 'TECH' },
    });
  }

  const parsed = parseAmount(amountRaw);
  const summaryParts = [
    amountRaw ? `Award: ${amountRaw}.` : '',
    awardCountRaw ? `Awards: ${awardCountRaw}.` : '',
    region ? `Region: ${region}.` : '',
    fieldOfStudy ? `Field of study: ${fieldOfStudy}.` : '',
  ].filter((p) => p.length > 0);
  const summary = `${raw.name} — an entry in the ARRL Foundation scholarship catalog. ${summaryParts.join(' ')}`
    .replace(/\s+/g, ' ')
    .slice(0, 560);

  const rawOther = [other, unmappedFields(fields)].filter((s) => s.trim().length > 0).join('\n');

  return {
    id,
    funderId: funderFor(raw.name),
    // The pair Plan 2's parser emits for this entry. programs.source_id / external_key are
    // written from it by the importer, so the nightly crawl resolves this row by identity.
    sourceKey: { sourceId: raw.sourceId, externalKey: raw.externalKey },
    name: raw.name,
    klass: 'ham_scholarship',
    summary,
    applicantEntities: ['individual'],
    amount: {
      instrument: parsed.tiers && parsed.tiers.length > 0 ? 'cash_tiered_blocks' : 'cash_range',
      amountMin: parsed.amountMin,
      amountMax: parsed.amountMax,
      tiers: parsed.tiers,
      amountRaw: amountRaw || 'Not published in the catalog entry.',
      awardCountRaw: awardCountRaw || 'Not published in the catalog entry.',
    },
    deadline: {
      kind: 'inherited',
      source: { kind: 'inherited', fromProgramId: PARENT_PROGRAM_ID },
      note: 'Inherited from the ARRL Foundation Scholarship Program: one application, one deadline for the whole catalog. The window opens around October 30 and closes around December 30 at 12:00 noon EST.',
    },
    applyVia: 'external_spa_portal',
    applyUrl: APPLY_URL,
    constraints,
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed', url: APPLY_URL },
    trust: {
      status: 'open',
      sourceUrl: CATALOG_URL,
      lastVerifiedAt: LAST_VERIFIED,
      verificationMethod: 'seed_import',
      contentHash: '',
    },
    rawOtherText: rawOther,
    tags: ['ham', 'scholarship', 'arrl', 'catalog'],
  };
}

function main(): void {
  const mod = catalogModule();
  const payloads = loadFixturePayloads(mod);
  const raws = mod.parse(payloads);
  if (raws.length < 100) {
    throw new Error(`Parser ${mod.id} returned ${raws.length} records from the fixture; expected at least 100.`);
  }

  const recognised = raws.filter((r) => Object.keys(r.rawFields).some((k) =>
    Object.values(FIELD_ALIASES).flat().includes(normaliseKey(k))));
  if (recognised.length < raws.length * 0.9) {
    throw new Error(
      `Only ${recognised.length} of ${raws.length} parsed records carry a recognised label. ` +
      'The parser\'s rawFields keys have changed; update FIELD_ALIASES rather than shipping unmapped data.',
    );
  }

  const seen = new Set<string>();
  const programs: SeedProgram[] = [];
  for (const raw of raws) {
    const program = rawToProgram(raw);
    if (seen.has(program.id)) continue;   // the catalog contains a handful of repeated names
    seen.add(program.id);
    programs.push(program);
  }

  const outPath = join(REPO_ROOT, 'data', 'seed', 'programs.arrl-catalog.json');
  writeFileSync(outPath, `${JSON.stringify({ programs }, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${programs.length} catalog records to ${outPath}\n`);
}

main();
```

- [ ] **Step 4: Add the npm script and run the generator**

Add to the root `package.json` scripts block. This is the CONTRACT §8 deviation recorded in this
plan's Global Constraints — a seventh root script, developer-only, never part of `build`, `test`
or CI:

```json
"seed:arrl": "tsx scripts/generate-arrl-seed.ts"
```

Then:

```bash
cd /path/to/grantspotter && npm run seed:arrl
```

Expected: `Wrote 111 catalog records to /path/to/grantspotter/data/seed/programs.arrl-catalog.json` (a count between 100 and 114 is fine; the page carries 114 `li` elements of which 3 are stubs). If it throws about unrecognised labels, open `packages/server/src/sources/` and look at the keys that parser actually puts in `rawFields`, then extend `FIELD_ALIASES` with them — do not weaken the 90% assertion.

- [ ] **Step 5: Run the catalog test and the whole seed suite**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/seed/
```

Expected: 11 passing tests in `arrlCatalog.test.ts`, 18 in `seed.test.ts` (now over roughly 143 programs), 10 in `negatives.test.ts`.

If `never records the $100,000 endowment figure as an award ceiling` fails, that is `parseAmount` picking up the endowment number, which is exactly the trap the spec names. Fix it in Plan 1's `parseAmount` with a test there — not by post-filtering here.

- [ ] **Step 6: Commit the script and the generated corpus together**

```bash
cd /path/to/grantspotter
git add scripts/generate-arrl-seed.ts data/seed/programs.arrl-catalog.json package.json packages/server/src/seed/arrlCatalog.test.ts
git commit -m "feat(seed): generate the 111 ARRL Foundation catalog records from the committed fixture"
```

---

### Task 16: Import the seed corpus into the database on first run

**Files:**
- Create: `packages/server/src/seed/import.ts`
- Test: `packages/server/src/seed/import.test.ts`
- Modify: `packages/server/src/index.ts` (call `importSeedIfEmpty` after migrations, before the scheduler starts)

**Interfaces:**
- Consumes: `loadSeedCorpus` (Task 11); `createProgramRepo(db)` and `createFunderRepo(db)` from Plan 1 (factories — RESOLUTIONS R8); the `programs.source_id` / `programs.external_key` columns Plan 1 added for RESOLUTIONS R9.
- Produces:
  - `export interface SeedImportResult { imported: boolean; funders: number; programs: number; sourceKeys: number; reason: string }` — **plan-local**
  - `export function importSeedIfEmpty(db: Database, options?: { dir?: string; force?: boolean }): SeedImportResult`

Design rule: **the import is idempotent and never overwrites human decisions.** Every seed record enters the normal trust pipeline (spec §13) — it ages, it can go amber, and "Verify now" refetches it. If the operator has already reviewed and edited a record, a container restart must not silently revert it. So the import runs only when the `programs` table is empty, unless explicitly forced.

Second rule, and the one that stops the corpus doubling every night: **the importer writes each
record's crawler identity.** `ProgramRepo.upsert` writes the CONTRACT §3 columns only, so the
importer follows it with an `UPDATE programs SET source_id = ?, external_key = ? WHERE id = ?` for
every entry in `corpus.sourceKeys`. Plan 2's `normalizeRaw` then resolves an existing id with
`ctx.existingIdFor?.(sourceId, externalKey)` before minting one. Without this the first crawl
inserts a second copy of every seeded record and the second crawl inserts a third.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/seed/import.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { migrate } from '../db/migrate.js';
import { importSeedIfEmpty } from './import.js';

let db: Db;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
});

describe('importSeedIfEmpty', () => {
  it('imports the whole corpus into an empty database', () => {
    const result = importSeedIfEmpty(db);
    expect(result.imported).toBe(true);
    expect(result.programs).toBeGreaterThanOrEqual(100);
    expect(result.funders).toBeGreaterThanOrEqual(20);
    const count = db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number };
    expect(count.n).toBe(result.programs);
  });

  it('is a no-op on a database that already holds programs', () => {
    importSeedIfEmpty(db);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n;
    const second = importSeedIfEmpty(db);
    expect(second.imported).toBe(false);
    expect(second.reason).toContain('already');
    const after = (db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('re-imports when forced', () => {
    importSeedIfEmpty(db);
    const forced = importSeedIfEmpty(db, { force: true });
    expect(forced.imported).toBe(true);
    expect(forced.programs).toBeGreaterThanOrEqual(100);
  });

  it('stores the computed content hash, not an empty string', () => {
    importSeedIfEmpty(db);
    const row = db.prepare("SELECT content_hash FROM programs WHERE id = 'ardc-grants'").get() as
      { content_hash: string } | undefined;
    expect(row?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds each seeded record to the crawler identity that owns it', () => {
    const result = importSeedIfEmpty(db);
    expect(result.sourceKeys).toBeGreaterThan(100);

    const scholarships = db
      .prepare("SELECT source_id, external_key FROM programs WHERE id = 'arrl-foundation-scholarships'")
      .get() as { source_id: string; external_key: string };
    expect(scholarships).toEqual({ source_id: 'arrl-scholarship-program', external_key: 'scholarship-program' });

    const catalogEntry = db
      .prepare("SELECT COUNT(*) AS n FROM programs WHERE id LIKE 'arrl-cat-%' AND source_id = 'arrl-scholarship-descriptions'")
      .get() as { n: number };
    expect(catalogEntry.n).toBeGreaterThanOrEqual(100);
  });

  it('leaves source_id null for the two records no source module re-reads', () => {
    importSeedIfEmpty(db);
    const rows = db
      .prepare('SELECT id FROM programs WHERE source_id IS NULL ORDER BY id')
      .all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(['austin-arc-greenwood', 'ieee-mtt-s-student-awards']);
  });

  it('never lets two records claim one crawler identity, which the partial unique index forbids', () => {
    importSeedIfEmpty(db);
    const dupes = db
      .prepare(
        `SELECT source_id, external_key, COUNT(*) AS n FROM programs
         WHERE source_id IS NOT NULL GROUP BY source_id, external_key HAVING n > 1`,
      )
      .all();
    expect(dupes).toEqual([]);
  });

  it('imports inside a single transaction: a failure leaves the table empty', () => {
    const broken = () => importSeedIfEmpty(db, { dir: '/nonexistent-seed-dir' });
    expect(broken).toThrow();
    const count = db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/seed/import.test.ts
```

Expected failure: `Cannot find module './import.js'`.

- [ ] **Step 3: Implement the importer**

Create `packages/server/src/seed/import.ts`:

```ts
import type { Database } from 'better-sqlite3';
import { loadSeedCorpus, seedDir } from './load.js';
import { createProgramRepo } from '../db/repositories/programs.js';
import { createFunderRepo } from '../db/repositories/funders.js';

/** PLAN-LOCAL. */
export interface SeedImportResult {
  imported: boolean;
  funders: number;
  programs: number;
  sourceKeys: number;
  reason: string;
}

/**
 * SEAM. Repositories are factories (RESOLUTIONS R8): createProgramRepo(db).upsert(program),
 * createFunderRepo(db).upsert(funder). This file and exports/dataSource.ts are the only two
 * places Plan 5 names a Plan 1 symbol.
 *
 * The UPDATE afterwards is deliberate: ProgramRepo.upsert writes the CONTRACT §3 columns and
 * does not know about source_id / external_key, which exist purely so the nightly crawler can
 * resolve a seeded row instead of minting a fresh id (RESOLUTIONS R9).
 */
export function importSeedIfEmpty(
  db: Database,
  options: { dir?: string; force?: boolean } = {},
): SeedImportResult {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number };
  if (existing.n > 0 && options.force !== true) {
    return {
      imported: false,
      funders: 0,
      programs: existing.n,
      sourceKeys: 0,
      reason: `The programs table already holds ${existing.n} records; the seed import does not overwrite reviewed data.`,
    };
  }

  const corpus = loadSeedCorpus(options.dir ?? seedDir());
  const funders = createFunderRepo(db);
  const programs = createProgramRepo(db);
  const setSourceKey = db.prepare(
    'UPDATE programs SET source_id = ?, external_key = ? WHERE id = ?',
  );

  const run = db.transaction(() => {
    for (const funder of corpus.funders) funders.upsert(funder);
    for (const program of corpus.programs) programs.upsert(program);
    for (const [programId, key] of corpus.sourceKeys) {
      setSourceKey.run(key.sourceId, key.externalKey, programId);
    }
  });
  run();

  return {
    imported: true,
    funders: corpus.funders.length,
    programs: corpus.programs.length,
    sourceKeys: corpus.sourceKeys.size,
    reason:
      `Imported ${corpus.programs.length} programs from ${corpus.funders.length} funders, ` +
      `${corpus.sourceKeys.size} of them bound to a crawler identity, all verified 2026-08-02.`,
  };
}
```

- [ ] **Step 4: Call it at startup**

Plan 3 wrote `packages/server/src/index.ts` and every plan after it edits that one file
(RESOLUTIONS R5, R25). This task adds exactly two lines to it — the import call, **not** a route
mount, so nothing here goes inside the `mountRoutes` callback — after `migrate(db)` and before
`createApp({ …, mountRoutes })`:

```ts
import { importSeedIfEmpty } from './seed/import.js';

const seedResult = importSeedIfEmpty(db);
console.log(`[seed] ${seedResult.reason}`);
```

Order matters twice over: it must run after migrations, because it writes `source_id` and
`external_key`, and before the crawl scheduler starts, because a crawl against an empty
`programs` table would mint fresh ids for the whole corpus and the seed would then be the
duplicate.

The log line matters too: on a fresh container the operator sees the corpus size at boot, and on a restart they see that their reviewed data was left alone.

- [ ] **Step 5: Run the test and the whole server suite**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src
```

Expected: 9 passing tests in `import.test.ts` and no regressions elsewhere. A typecheck failure naming `createProgramRepo` or `createFunderRepo` means Plan 1 exports them from a different path — adjust the two imports in this file only. A SQL error on `source_id` means Plan 1's `001-init.sql` is missing the two RESOLUTIONS R9 columns; that is Plan 1's fix, not a reason to drop the UPDATE here.

- [ ] **Step 6: Commit**

```bash
cd /path/to/grantspotter
git add packages/server/src/seed packages/server/src/index.ts
git commit -m "feat(seed): idempotent first-run corpus import that never overwrites reviewed data"
```

---

### Task 17: Serve the built SPA — static assets and the history fallback

**Files:**
- Create: `packages/server/src/api/spa.ts`
- Test: `packages/server/src/api/spa.test.ts`
- Modify: `packages/server/src/index.ts` — Step 5 replaces Plan 3 Task 14's whole reservation block
  at the end of the `mountRoutes` callback (its quoted worked example *and* its closing banner)
  with `a.use(createSpaMiddleware(webDistRoot()));`. It is the **last statement of that callback**,
  and nothing is ever registered after it (RESOLUTIONS R5, R16, R25).

**Why this task exists (RESOLUTIONS R16).** Before it, **nothing in any of the five plans served
`packages/web/dist`** — `grep -rn "express.static\|sendFile\|historyApiFallback" docs/superpowers/plans`
returned zero hits. Everything downstream assumes one process answers both the API and the web
app: the next task's Dockerfile COPYs `packages/web/dist` into the runtime image, its
`CMD ["node", "packages/server/dist/index.js"]` starts exactly one process, `docker-compose.yml`
declares one service on one port, Playwright's `baseURL` points at that server, every e2e spec
begins with `page.goto('/')`, and Task 23's debug audit asserts "the SPA responds on `/`". With no
static middleware, `GET /` walks past every router into Plan 1's `notFoundHandler` and answers
`{"error":{"code":"not_found","message":"Not found."},"requestId":"…"}`. The whole web
application would be unreachable, the entire Playwright suite would fail on its first line, and
the published image would serve an API to a product that has a UI.

**Interfaces:**
- Consumes: `express` (`express.static` and the `RequestHandler` type), `node:path`, and
  `webDistRoot()` from Plan 3's `packages/server/src/api/webDist.ts` (RESOLUTIONS R27 — Plan 3
  owns that function and runs first; this task does **not** define a second copy). Nothing from
  `@grantspotter/core`, no database, no config, no repository.
- Produces (**plan-local** to `packages/server`):
  - `export function createSpaMiddleware(webDistDir: string): RequestHandler`

**Where it is mounted: here, and last (RESOLUTIONS R5, R16, R25).** Plan 1's `createApp` seals the
app with `notFoundHandler()`, so the only place this can be registered is the `AppDeps.mountRoutes`
callback in `packages/server/src/index.ts`. That callback is filled incrementally, and **this task
owns its final line**: Plan 3 mounted its routers and left a reservation block holding the last
position, Plan 4 added its four, Task 9 Step 9 added the two export mounts, and Step 5 below
replaces that whole block — worked example and closing banner alike — with

```ts
    // Last in the hook: real files, then the SPA shell for any GET the routers
    // above did not claim. Registered after them so it can never shadow /api.
    a.use(createSpaMiddleware(webDistRoot()));
```

adding `import { createSpaMiddleware } from './api/spa.js';` to the import block. Plan 3 already
imports `webDistRoot` from `./api/webDist.js` for its own `mount.test.ts` wiring; if that import is
not in `index.ts`, add `import { webDistRoot } from './api/webDist.js';` too — but never a second
definition of the function (R27).

**This task also owns the "`GET /` returns the application" assertion.** Plan 3's e2e cannot make
it: until this line lands there is no SPA middleware at all, so `page.goto('/')` gets Plan 1's JSON
404. `spa.test.ts` below is where `/` returning HTML, `/browse` returning the *same* HTML,
`/api/unknown` still returning Plan 1's JSON 404 envelope, and a `POST /` falling through are
pinned; Task 22 re-checks all four against Playwright's own server, and Task 23 step 6c over HTTP
against `node packages/server/dist/index.js`.

Three rules the middleware follows, each of which a test pins:

1. **Assets first, `index: false`.** `serve-static`'s own directory-index handling answers `/` and
   nothing else, so `/browse` would still 404. Turning it off and writing the fallback ourselves
   means `/`, `/browse` and `/o/ardc-grants` take one code path and return one byte-identical
   shell — which is the whole contract a client-side router depends on.
2. **Only a `GET` gets the shell.** A `POST /` is a client bug or a probe, and answering it with a
   200 full of HTML hides the mistake. Non-GET falls through to the JSON 404.
3. **`/api…` and `/calendar/…` belong to the server.** Those prefixes fall through untouched so
   Plan 1's envelope still governs the API (R16). `/calendar/` carries its trailing slash on
   purpose: Task 9's feed router owns `/calendar/:token`, but bare `/calendar` is the SPA's own
   Calendar page and sits in the nav rail — reserving the bare word would answer JSON to anyone
   who bookmarks it or presses reload on it.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/spa.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createSpaMiddleware } from './spa.js';
// webDistRoot is Plan 3's, from api/webDist.ts (RESOLUTIONS R27). It is imported here
// rather than redefined, and the last describe block asserts the contract this
// middleware depends on: that it points at packages/web/dist from src and from dist alike.
import { webDistRoot } from './webDist.js';
import { errorHandler, notFoundHandler, requestIdMiddleware } from './errors.js';

const INDEX_HTML =
  '<!doctype html><html><head><title>GrantSpotter</title></head>' +
  '<body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>';

let server: Server;
let base: string;
let dist: string;

beforeAll(async () => {
  // A stand-in for `npm run build`'s output. The test never needs the real Vite
  // bundle: what is under test is routing, not bundling.
  dist = mkdtempSync(join(tmpdir(), 'gs-spa-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), INDEX_HTML, 'utf8');
  writeFileSync(join(dist, 'assets', 'main.js'), 'export const built = true;\n', 'utf8');

  // Deliberately the same shape as the real app: request id, an API router, the
  // SPA middleware LAST, then Plan 1's notFoundHandler and errorHandler. If the
  // ordering here stops matching the mountRoutes callback in index.ts, this suite
  // is testing a different application from the one that ships.
  const app = express();
  app.use(requestIdMiddleware());
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.use(createSpaMiddleware(dist));
  app.use(notFoundHandler());
  app.use(errorHandler({ logger: () => {} }));
  await new Promise<void>((done) => { server = app.listen(0, '127.0.0.1', done); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

describe('createSpaMiddleware', () => {
  it('serves the built index.html on /', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('serves the same shell for a client-side route, so a deep link and a reload both work', async () => {
    const root = await (await fetch(`${base}/`)).text();
    const deep = await fetch(`${base}/browse`);
    expect(deep.status).toBe(200);
    expect(deep.headers.get('content-type')).toContain('text/html');
    expect(await deep.text()).toBe(root);
  });

  it('serves the shell for a nested client-side route too', async () => {
    const res = await fetch(`${base}/o/arrl-foundation-scholarships`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('serves a real asset as itself, not as the shell', async () => {
    const res = await fetch(`${base}/assets/main.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(await res.text()).toContain('export const built = true;');
  });

  it('leaves /api alone: an unknown API route still gets Plan 1 JSON 404 envelope', async () => {
    const res = await fetch(`${base}/api/unknown`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: { code: string }; requestId: string };
    expect(body.error.code).toBe('not_found');
    expect(typeof body.requestId).toBe('string');
  });

  it('never shadows a real API route', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('reserves the calendar feed path, so a bad token stays JSON and never becomes HTML', async () => {
    const res = await fetch(`${base}/calendar/not-a-real-token.ics`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('still serves the SPA Calendar page, which is /calendar with no token', async () => {
    const res = await fetch(`${base}/calendar`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root"></div>');
  });

  it('does not answer a POST with HTML', async () => {
    const res = await fetch(`${base}/`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.text()).not.toContain('<div id="root"></div>');
  });

  it('never serves a file from outside the dist directory', async () => {
    // /package.json exists at the repository root and must NOT be reachable:
    // the static root is the build output, not the working directory.
    const res = await fetch(`${base}/package.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<div id="root"></div>');
  });
});

describe('webDistRoot (Plan 3 owns it; this is the contract the middleware is handed)', () => {
  it('is an absolute path ending in packages/web/dist', () => {
    const root = webDistRoot();
    expect(isAbsolute(root)).toBe(true);
    expect(root.endsWith(['packages', 'web', 'dist'].join(sep))).toBe(true);
  });

  it('is anchored on the repository root, which is what makes it work from src and from dist', () => {
    // src/api/webDist.ts and dist/api/webDist.js are both exactly four directories
    // below the root, so one piece of arithmetic serves tsx in dev and node in /app.
    const repoRoot = resolve(webDistRoot(), '..', '..', '..');
    expect(existsSync(join(repoRoot, 'package.json'))).toBe(true);
    expect(existsSync(join(repoRoot, 'packages', 'server'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/api/spa.test.ts
```

Expected failure: `Cannot find module './spa.js'`.

- [ ] **Step 3: Implement the middleware**

Create `packages/server/src/api/spa.ts`:

```ts
import { resolve } from 'node:path';
import express, { type RequestHandler } from 'express';

// NOTE: this file exports ONE symbol. `webDistRoot()` lives in ./webDist.ts and
// belongs to Plan 3 (RESOLUTIONS R27) — it resolves packages/web/dist from
// import.meta.url rather than process.cwd(), so it is correct both for
// `tsx packages/server/src/index.ts` in development and for
// `node packages/server/dist/index.js` with cwd=/app in the container. Defining a
// second copy here is how the two drift. The caller passes the directory in.

/**
 * Paths the server owns. A GET whose path starts with one of these never
 * receives the SPA shell: it falls through untouched, so Plan 1's
 * notFoundHandler still answers with the one JSON envelope (RESOLUTIONS R16).
 *
 * '/calendar/' keeps its trailing slash deliberately. Task 9's feed router owns
 * '/calendar/:token', but bare '/calendar' is the SPA's own Calendar page and is
 * in the nav rail; reserving the bare word would answer JSON to anyone who
 * bookmarks it or presses reload on it.
 */
const SERVER_OWNED_PREFIXES = ['/api', '/calendar/'] as const;

function isServerOwned(pathname: string): boolean {
  return SERVER_OWNED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Serve the built SPA: real files first, then the history fallback.
 *
 * Mounted at the root and LAST, from the mountRoutes callback in index.ts, after
 * every /api router and after the /calendar/:token feed (RESOLUTIONS R5, R16,
 * R25). It is the only middleware in the application that answers a path it has
 * never heard of, which is exactly why it must be registered last.
 *
 * `index: false` disables serve-static's directory-index handling: that would
 * answer '/' and leave '/browse' 404ing. Owning the fallback ourselves means
 * every client-side route returns one byte-identical shell.
 */
export function createSpaMiddleware(webDistDir: string): RequestHandler {
  const indexHtml = resolve(webDistDir, 'index.html');
  const assets = express.static(webDistDir, { index: false, fallthrough: true });

  return (req, res, next) => {
    assets(req, res, (staticError?: unknown) => {
      if (staticError !== undefined && staticError !== null) { next(staticError); return; }
      if (req.method !== 'GET') { next(); return; }
      if (isServerOwned(req.path)) { next(); return; }
      // An ENOENT here means the image was built without `npm run build`. Forward
      // it so it surfaces as a loud 500 rather than a blank 200.
      res.sendFile(indexHtml, (sendError?: Error) => {
        if (sendError !== undefined && sendError !== null) next(sendError);
      });
    });
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/api/spa.test.ts
```

Expected: 12 passing tests.

- [ ] **Step 5: Add the mount line — the last statement of the hook (RESOLUTIONS R5, R16, R25)**

Open `packages/server/src/index.ts`. Add the import next to the two Task 9 Step 9 added:

```ts
import { createSpaMiddleware } from './api/spa.js';
```

Plan 3 already imports `webDistRoot` from `./api/webDist.js`; if that line is absent, add
`import { webDistRoot } from './api/webDist.js';` as well — never a second definition of the
function (RESOLUTIONS R27).

Then replace the block Plan 3 left reserving the final position of the `mountRoutes` callback with
the mount, keeping the explanation.

**Replace the whole reservation block, not just its last line.** Plan 3 Task 14 left two things at
the end of that callback: a worked example that *quotes* each later plan's mount line as a comment
(`//     a.use('/api/applications', createApplicationsRouter(routerDeps));` and its siblings, down
to `//     a.use(createSpaMiddleware(webDistRoot()));`), and, below it, a dashed banner reading
"Plans 4 and 5 append their routers below. The SPA middleware (Plan 5 Task 17) MUST remain the last
statement. (RESOLUTIONS R25)". **Both go.** By the time this step runs every one of those quoted
lines exists for real, a few lines above, so the example has become a stale second copy — and a
commented `a.use(createSpaMiddleware(webDistRoot()));` is indistinguishable from a real one to
every `grep` gate in this plan and in Task 23. When this step is done there is **no commented
`a.use(` left anywhere in `packages/server/src/index.ts`**: the only occurrences of `a.use(` in the
file are the real, executable mounts, and the only occurrence of `createSpaMiddleware(webDistRoot())`
is the single statement below.

```ts
  mountRoutes: (a) => {
    // … Plan 3's mountProductApi(…), Plan 4's four routers, and Task 9's two
    //     export mounts stay exactly as they are …

    // --- The built SPA. THIS IS THE LAST STATEMENT IN THIS CALLBACK
    //     (RESOLUTIONS R16, R25). Real files first, then index.html for any GET
    //     the routers above did not claim, so /browse and /o/:id survive a hard
    //     refresh. Registered after every router, so it can never shadow /api or
    //     /calendar/:token; anything registered after IT would be shadowed in
    //     turn. Without this line GET / reaches Plan 1's notFoundHandler and the
    //     browser is handed a JSON 404 instead of the application. ---
    a.use(createSpaMiddleware(webDistRoot()));
  },
```

**Nothing goes after it, in this task or any later one.** No `app.use(...)` on the value `createApp`
returns, and no edit to `packages/server/src/api/index.ts`.

- [ ] **Step 6: Prove the built SPA, the single implementation, and the mount ordering**

```bash
cd /path/to/grantspotter
npm run build && ls packages/web/dist/index.html
grep -rn "express.static" packages/server/src --include='*.ts' | grep -v '\.test\.ts'
grep -c "export function webDistRoot" packages/server/src/api/spa.ts
grep -c "^[^/]*createSpaMiddleware(webDistRoot())" packages/server/src/index.ts
grep -n "a\.use(" packages/server/src/index.ts | tail -n 3
```

Expected: `packages/web/dist/index.html` exists (that is the file `webDistRoot()` points at); the
second grep prints exactly one line, in `packages/server/src/api/spa.ts`; the third prints `0`,
because `webDistRoot` is defined in `api/webDist.ts` and nowhere else (R27); the fourth prints
exactly `1`; and the last grep ends with `a.use(createSpaMiddleware(webDistRoot()));` — preceded by
`a.use('/', createCalendarFeedRouter(exportDeps));`. If the SPA line is **not** last, every route
registered after it is unreachable for GETs, which is the exact failure R16 exists to prevent.

The fourth gate counts **executable** occurrences only. `^[^/]*` anchors the match to a line whose
prefix contains no `/`, so `    a.use(createSpaMiddleware(webDistRoot()));` matches and
`    //     a.use(createSpaMiddleware(webDistRoot()));` — Plan 3's quoted worked example — does
not. A count of `2` therefore means a genuine duplicate mount, not a surviving comment; if the
plain, unanchored grep gives 2 and this one gives 1, the reservation block above was not fully
deleted, which the previous step requires.

Then prove it on the real entrypoint rather than on a hand-built express app:

```bash
cd /path/to/grantspotter
export GS_TMP="$(mktemp -d)"
SESSION_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")" \
CONTACT_URL="https://www.example.org/grantspotter" DATA_DIR="$GS_TMP" CRAWL_ENABLED=false PORT=3133 \
  node packages/server/dist/index.js > /tmp/gs-spa-check.log 2>&1 &
echo $! > /tmp/gs-spa-check.pid
sleep 3
curl -sS -o /dev/null -w 'root          %{http_code} %{content_type}\n' http://127.0.0.1:3133/
curl -sS -o /dev/null -w 'deep-link     %{http_code} %{content_type}\n' http://127.0.0.1:3133/browse
curl -sS -o /dev/null -w 'api-unknown   %{http_code} %{content_type}\n' http://127.0.0.1:3133/api/unknown
curl -sS -o /dev/null -X POST -w 'post-root     %{http_code} %{content_type}\n' http://127.0.0.1:3133/
kill "$(cat /tmp/gs-spa-check.pid)"; rm -f /tmp/gs-spa-check.pid
```

Expected, and these four are the assertions this task owns because no earlier plan can make them:
`/` is `200 text/html`, `/browse` is `200 text/html` (the same shell), `/api/unknown` is
`404 application/json` (Plan 1's envelope still governs the API), and `POST /` is
`404 application/json` — a POST falls through instead of being answered with a page.

- [ ] **Step 7: Run the whole server suite, typecheck, and commit**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src && npm run typecheck
```

Expected: green, with no regression in `api/exports.test.ts` — if an export route suddenly returns
HTML, the middleware was registered before the routers instead of after them.

```bash
cd /path/to/grantspotter
git add packages/server/src/api/spa.ts packages/server/src/api/spa.test.ts packages/server/src/index.ts
git commit -m "feat(server): serve the built SPA with a history fallback that leaves /api alone"
```

---

### Task 18: Multi-stage Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Test: `packages/server/src/deploy/dockerfile.test.ts`

**Interfaces:** produces the container image definition. Nothing imports it.

**There is no Docker on this host.** The image is built and verified by GitHub Actions (Task 19), never locally. That is exactly why this task ships a test: the Dockerfile is checked as text for the properties that matter — pinned base image, multi-stage, non-root, healthcheck, runtime assets present, no browser — so a mistake is caught here rather than in a fifteen-minute emulated arm64 CI build.

Three details that will bite otherwise:

1. **`better-sqlite3` is a native module.** It needs `python3`, `make` and `g++` at install time. Under buildx the arm64 image is compiled inside an emulated arm64 container, so it compiles for the right architecture automatically — but slowly. Budget ten minutes and let the GitHub Actions cache do its job.
2. **The runtime layout must mirror the repository.** `seedDir()` in `packages/server/src/seed/load.ts` walks four directories up from the compiled module, so `packages/server/dist/seed/load.js` resolves `data/seed` relative to `/app`. Copy `data/seed`, `data/reference` and `content` into `/app` or the app boots with an empty corpus and no templates. `webDistRoot()` (Plan 3's `api/webDist.ts`, the directory Task 17's middleware is handed) does the same arithmetic from `packages/server/dist/api/webDist.js`, which is why `packages/web/dist` is COPYed into `/app/packages/web/dist` and why the dockerfile test asserts that COPY exists — the container runs one process and that middleware is the only thing serving the UI.
3. **npm workspaces put the real packages behind symlinks** in the root `node_modules`. Copy `node_modules` *and* each workspace's `package.json` and `dist`, or the `@grantspotter/core` import resolves to nothing.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/deploy/dockerfile.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const dockerfile = readFileSync(resolve(REPO_ROOT, 'Dockerfile'), 'utf8');
const dockerignore = readFileSync(resolve(REPO_ROOT, '.dockerignore'), 'utf8');

describe('Dockerfile', () => {
  it('pins the exact Node version the project is built against', () => {
    expect(dockerfile).toContain('node:20.11.0');
    expect(dockerfile).not.toMatch(/FROM node:(latest|20\s|20-)/);
  });

  it('is multi-stage', () => {
    const stages = dockerfile.match(/^FROM .+ AS \w+/gm) ?? [];
    expect(stages.length).toBeGreaterThanOrEqual(2);
  });

  it('installs the toolchain better-sqlite3 needs to compile', () => {
    expect(dockerfile).toMatch(/python3/);
    expect(dockerfile).toMatch(/\bg\+\+\b/);
    expect(dockerfile).toMatch(/\bmake\b/);
  });

  it('drops to a non-root user before CMD', () => {
    const userIndex = dockerfile.indexOf('USER node');
    const cmdIndex = dockerfile.lastIndexOf('CMD ');
    expect(userIndex).toBeGreaterThan(-1);
    expect(cmdIndex).toBeGreaterThan(userIndex);
  });

  it('declares a healthcheck that needs no extra binary', () => {
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).not.toMatch(/HEALTHCHECK[\s\S]{0,200}(curl|wget)/);
  });

  it('ships the runtime assets the app reads from disk', () => {
    expect(dockerfile).toMatch(/COPY .*content .*\/content/);
    expect(dockerfile).toMatch(/COPY .*data\/seed/);
    expect(dockerfile).toMatch(/COPY .*data\/reference/);
    expect(dockerfile).toMatch(/packages\/web\/dist/);
  });

  it('bundles no browser: PDF is the user\'s own print dialog', () => {
    for (const forbidden of ['chromium', 'chrome', 'puppeteer', 'playwright']) {
      expect(dockerfile.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('sets DATA_DIR and declares the volume', () => {
    expect(dockerfile).toMatch(/ENV[\s\S]{0,200}DATA_DIR=\/data/);
    expect(dockerfile).toContain('VOLUME');
  });

  it('bakes in no secret and no host-specific value', () => {
    expect(dockerfile).not.toMatch(/SESSION_SECRET=\S/);
    expect(dockerfile).not.toMatch(/ANTHROPIC_API_KEY=\S/);
    expect(dockerfile).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
    expect(dockerfile).not.toMatch(/\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it('excludes local state and the build context noise', () => {
    for (const entry of ['node_modules', '.git', 'dist', '.env', 'data/*.sqlite']) {
      expect(dockerignore).toContain(entry);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/deploy/dockerfile.test.ts
```

Expected failure: `ENOENT: no such file or directory, open '/path/to/grantspotter/Dockerfile'`.

- [ ] **Step 3: Write the `Dockerfile`**

```dockerfile
# GrantSpotter — multi-stage, multi-arch (linux/amd64, linux/arm64).
# No browser engine is installed: PDF output is the user's own "Save as PDF"
# against the print stylesheet. A bundled headless browser would add roughly
# 400 MB and its arm64 build under QEMU emulation is a recurring CI failure.
# The dockerfile test asserts that no browser package name appears in this file.

# ---------- build: compile core, server and the SPA ----------
FROM node:20.11.0-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
# better-sqlite3 is a native module and compiles from source on arm64.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/web/package.json ./packages/web/package.json
RUN npm ci
COPY . .
RUN npm run build

# ---------- deps: production-only node_modules ----------
FROM node:20.11.0-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/web/package.json ./packages/web/package.json
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:20.11.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3030 \
    DATA_DIR=/data \
    NPM_CONFIG_UPDATE_NOTIFIER=false

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist
# Read at runtime: the seed corpus, the ARRL section lookup table, and the
# templates and prompt fragments. seedDir() resolves these relative to /app.
COPY content ./content
COPY data/seed ./data/seed
COPY data/reference ./data/reference

RUN mkdir -p /data && chown -R node:node /data /app

USER node
VOLUME ["/data"]
EXPOSE 3030

# A TCP connect, not an HTTP probe: it needs no curl, no wget and no assumption
# about which health route exists. `node -e` runs as CommonJS, so require() is fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "const s=require('node:net').connect({host:'127.0.0.1',port:Number(process.env.PORT||3030)},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(4000,()=>process.exit(1));"

CMD ["node", "packages/server/dist/index.js"]
```

- [ ] **Step 4: Write `.dockerignore`**

```
node_modules
**/node_modules
.git
.github
dist
**/dist
coverage
.env
.env.local
data/*.sqlite
data/*.sqlite-*
data/snapshots
playwright-report
test-results
docs
*.log
.DS_Store
```

`docs` is excluded deliberately: the specs, plans and research are for humans working in the repository, not for the runtime image.

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/deploy/dockerfile.test.ts
```

Expected: 10 passing tests.

- [ ] **Step 6: Commit**

```bash
cd /path/to/grantspotter
git add Dockerfile .dockerignore packages/server/src/deploy
git commit -m "build: multi-stage Dockerfile, non-root, healthcheck, no bundled browser"
```

---

### Task 19: GitHub Actions — verify, then multi-arch buildx to GHCR

**Files:**
- Create: `.github/workflows/build.yml`
- Test: `packages/server/src/deploy/workflow.test.ts`

**Interfaces:** produces the CI pipeline that publishes `ghcr.io/atvriders/grantspotter:latest`.

Facts about this specific setup that are easy to get wrong:

- **The repository and the package must both be public.** The repository is created public in Task 23. A package published from a public repository with the repository linked (which `org.opencontainers.image.source` does) normally comes out public; Task 23 verifies it by attempting an anonymous manifest pull.
- **The fork gotcha:** in a freshly created or forked repository, Actions sometimes does not run the first `push`-triggered workflow. `workflow_dispatch` is included for exactly that case, and Task 23 dispatches it manually if no run appears.
- **arm64 builds are emulated** through QEMU on the amd64 runner. `better-sqlite3` compiling under emulation is the slow part; `cache-from`/`cache-to: type=gha` is what keeps the second build to a couple of minutes.
- **`npm run test:e2e` is not in this workflow.** Playwright needs browsers downloaded, and the e2e suite needs a running server with a bootstrapped account. It is run in Task 22 and again in Task 23 instead. `verify-sources` is also absent, deliberately: it hits the live network and the network is not a build dependency (spec §14).

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/deploy/workflow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const wf = readFileSync(resolve(REPO_ROOT, '.github/workflows/build.yml'), 'utf8');

describe('build workflow', () => {
  it('triggers on a push to master and on manual dispatch', () => {
    expect(wf).toMatch(/branches:\s*\[\s*master\s*\]/);
    expect(wf).toContain('workflow_dispatch:');
  });

  it('grants the token permission to write packages', () => {
    expect(wf).toMatch(/packages:\s*write/);
    expect(wf).toMatch(/contents:\s*read/);
  });

  it('verifies before it publishes', () => {
    expect(wf).toContain('npm run typecheck');
    expect(wf).toContain('npm run build');
    expect(wf).toContain('npm test');
    const verifyJob = wf.indexOf('verify:');
    const imageJob = wf.indexOf('image:');
    expect(verifyJob).toBeGreaterThan(-1);
    expect(imageJob).toBeGreaterThan(verifyJob);
    expect(wf).toMatch(/needs:\s*verify/);
  });

  it('uses the same Node version as the project', () => {
    expect(wf).toContain("node-version: '20.11.0'");
  });

  it('builds both architectures', () => {
    expect(wf).toContain('linux/amd64,linux/arm64');
    expect(wf).toContain('docker/setup-qemu-action');
    expect(wf).toContain('docker/setup-buildx-action');
  });

  it('publishes the latest tag to the right GHCR path', () => {
    expect(wf).toContain('ghcr.io/atvriders/grantspotter:latest');
    expect(wf).toContain('ghcr.io');
    expect(wf).toContain('docker/login-action');
  });

  it('caches layers so the emulated arm64 build is not rebuilt from scratch', () => {
    expect(wf).toContain('cache-from: type=gha');
    expect(wf).toContain('cache-to: type=gha');
  });

  it('links the package to the repository so it inherits public visibility', () => {
    expect(wf).toContain('org.opencontainers.image.source');
  });

  it('does not run the live source check or the e2e suite in CI', () => {
    expect(wf).not.toContain('verify-sources');
    expect(wf).not.toContain('test:e2e');
  });

  it('contains no hardcoded secret', () => {
    expect(wf).not.toMatch(/gh[pous]_[A-Za-z0-9]{20,}/);
    expect(wf).toContain('${{ secrets.GITHUB_TOKEN }}');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/deploy/workflow.test.ts
```

Expected failure: `ENOENT ... .github/workflows/build.yml`.

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/build.yml`:

```yaml
name: build

on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
  # A freshly created repository sometimes will not run its first push-triggered
  # workflow. Manual dispatch is the escape hatch; see the README deploy notes.
  workflow_dispatch:

permissions:
  contents: read
  packages: write

concurrency:
  group: build-${{ github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20.11.0'
          cache: npm

      - name: Install
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Build
        run: npm run build

      - name: Unit and integration tests
        run: npm test

  image:
    needs: verify
    if: github.event_name != 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push multi-arch image
        uses: docker/build-push-action@v6
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: |
            ghcr.io/atvriders/grantspotter:latest
            ghcr.io/atvriders/grantspotter:${{ github.sha }}
          labels: |
            org.opencontainers.image.source=https://github.com/Atvriders/grantspotter
            org.opencontainers.image.description=GrantSpotter — a self-hosted funding desk for collegiate and educational amateur radio
            org.opencontainers.image.licenses=MIT
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/deploy/workflow.test.ts
```

Expected: 10 passing tests.

- [ ] **Step 5: Commit**

```bash
cd /path/to/grantspotter
git add .github/workflows/build.yml packages/server/src/deploy/workflow.test.ts
git commit -m "ci: verify then publish a multi-arch image to ghcr.io/atvriders/grantspotter"
```

---

### Task 20: docker-compose that pulls the published image, and `.env.example`

**Files:**
- Create: `docker-compose.yml`
- Modify: `.env.example` (Plan 1 Task 1 creates it; this task rewrites the comments and adds nothing Plan 1 did not already declare — **no CONTRACT §7 variable may be dropped**)
- Test: `packages/server/src/deploy/compose.test.ts`

**Interfaces:** produces the deployment artefacts. Nothing imports them.

Two things this file must get right:

1. **It pulls; it does not build.** There is no Docker on the development host and the image is produced by CI. A `build:` key here would tempt someone into an unreproducible local image that does not match what CI published.
2. **`HOST_PORT` is a variable because 3030 is already taken.** On this host, port 3030 is claimed by the `fps-game` and `youtube-clicker` compose files. Changing the published port must be a one-line edit in `.env`, never a change to a tracked file.

`SESSION_SECRET` and `CONTACT_URL` are required with **no default**, exactly as `JWT_SECRET` is in ham-net-assistant. A default session secret is a shared secret, which is not a secret. `CONTACT_URL` goes into the crawler's User-Agent so the ~25 small nonprofits being polled can identify who is polling them; shipping a default would make every deployment anonymous and identical.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/deploy/compose.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const compose = readFileSync(resolve(REPO_ROOT, 'docker-compose.yml'), 'utf8');
const envExample = readFileSync(resolve(REPO_ROOT, '.env.example'), 'utf8');

describe('docker-compose.yml', () => {
  it('pulls the published image and never builds locally', () => {
    expect(compose).toContain('image: ghcr.io/atvriders/grantspotter:latest');
    expect(compose).not.toMatch(/^\s*build:/m);
  });

  it('makes the host port a variable defaulting to 3030', () => {
    expect(compose).toContain('${HOST_PORT:-3030}:3030');
  });

  it('persists sqlite and snapshots in a named volume', () => {
    expect(compose).toMatch(/volumes:[\s\S]*grantspotter-data:\/data/);
    expect(compose).toMatch(/^volumes:/m);
  });

  it('passes the required variables through with no defaults', () => {
    expect(compose).toContain('SESSION_SECRET: ${SESSION_SECRET:?');
    expect(compose).toContain('CONTACT_URL: ${CONTACT_URL:?');
  });

  it('runs an init process so SIGTERM stops the container promptly', () => {
    expect(compose).toContain('init: true');
    expect(compose).toContain('restart: unless-stopped');
  });

  it('contains no real host address, hostname or path', () => {
    expect(compose).not.toMatch(/\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(compose).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
    expect(compose).not.toMatch(/\/mnt\/user\//);
  });
});

describe('.env.example', () => {
  it('lists every variable from the contract', () => {
    for (const key of [
      'HOST_PORT', 'PORT', 'SESSION_SECRET', 'CONTACT_URL', 'DATA_DIR',
      'CRAWL_ENABLED', 'CRAWL_CRON', 'ANTHROPIC_API_KEY', 'SIMPLER_GRANTS_API_KEY',
    ]) {
      expect(envExample).toContain(`${key}=`);
    }
  });

  it('ships the two required variables empty, so a copied file fails loudly', () => {
    expect(envExample).toMatch(/^SESSION_SECRET=\s*$/m);
    expect(envExample).toMatch(/^CONTACT_URL=\s*$/m);
  });

  it('carries no real secret and no example address that resolves', () => {
    expect(envExample).not.toMatch(/sk-ant-[A-Za-z0-9-]{10,}/);
    expect(envExample).not.toMatch(/\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it('uses documentation-safe example values only', () => {
    expect(envExample).toMatch(/203\.0\.113\.|example\.org|example\.com/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/deploy/compose.test.ts
```

Expected failure: `ENOENT ... docker-compose.yml`.

- [ ] **Step 3: Write `docker-compose.yml`**

```yaml
# GrantSpotter. Pulls the image published by GitHub Actions; it does not build.
#
#   cp .env.example .env      then fill in SESSION_SECRET and CONTACT_URL
#   docker compose pull
#   docker compose up -d
#
# HOST_PORT is a variable on purpose: 3030 is a popular default and is already
# claimed by other stacks on a typical host. Change it in .env, not here.

services:
  grantspotter:
    image: ghcr.io/atvriders/grantspotter:latest
    container_name: grantspotter
    restart: unless-stopped
    init: true
    ports:
      - "${HOST_PORT:-3030}:3030"
    environment:
      PORT: 3030
      DATA_DIR: /data
      # Required. The container refuses to start without these two.
      SESSION_SECRET: ${SESSION_SECRET:?set SESSION_SECRET in .env; there is no default}
      CONTACT_URL: ${CONTACT_URL:?set CONTACT_URL in .env; it identifies your crawler to the sites it polls}
      CRAWL_ENABLED: ${CRAWL_ENABLED:-true}
      CRAWL_CRON: ${CRAWL_CRON:-17 3 * * *}
      # Optional. Everything works without them.
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      SIMPLER_GRANTS_API_KEY: ${SIMPLER_GRANTS_API_KEY:-}
    volumes:
      - grantspotter-data:/data
    healthcheck:
      test: ["CMD", "node", "-e", "const s=require('node:net').connect({host:'127.0.0.1',port:3030},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(4000,()=>process.exit(1));"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 25s

volumes:
  grantspotter-data:
```

- [ ] **Step 4: Write `.env.example`**

```bash
# GrantSpotter configuration. Copy to .env and fill in the two required values.
#   cp .env.example .env

# Host port published by docker compose. The container always listens on 3030.
# 3030 is commonly already claimed on a busy host; change this, not the compose file.
HOST_PORT=3030

# Port the server listens on inside the container. Leave this alone.
PORT=3030

# REQUIRED. No default exists and the server refuses to start without it.
# Generate one with:  node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
SESSION_SECRET=

# REQUIRED. A URL a site owner can visit to find out who is polling them. It goes
# into the crawler's User-Agent. Use a page you control, for example
# https://www.example.org/grantspotter or a mailto: link.
CONTACT_URL=

# Where the SQLite database, snapshots and the fixture cache live inside the container.
DATA_DIR=/data

# Nightly change detection. Nothing in this corpus changes faster than weekly, so
# nightly is the right cadence; the schedule is jittered in code.
CRAWL_ENABLED=true
CRAWL_CRON=17 3 * * *

# OPTIONAL. With no key everything still works: deterministic parsers, rule-based
# scoring and the copy-prompt flow. If present, the crawler additionally uses it to
# parse messy pages and pre-score review-queue items. It is never on the read path
# and it never drafts a narrative.
ANTHROPIC_API_KEY=

# OPTIONAL. A free Login.gov key for Simpler.Grants.gov. Improves federal ranking
# when supplied and is never a hard dependency.
SIMPLER_GRANTS_API_KEY=
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/deploy/compose.test.ts
```

Expected: 10 passing tests.

- [ ] **Step 6: Commit**

```bash
cd /path/to/grantspotter
git add docker-compose.yml .env.example packages/server/src/deploy/compose.test.ts
git commit -m "build: compose pulling the published image, plus a documented .env.example"
```

---

### Task 21: README — honest about what this is

**Files:**
- Create: `README.md`
- Create: `LICENSE` (MIT; the workflow labels the image `org.opencontainers.image.licenses=MIT`, so the file has to exist)
- Test: `packages/server/src/deploy/readme.test.ts`

**Interfaces:** produces documentation. Nothing imports it.

The README has one job beyond installation instructions: to prevent the two misunderstandings that would make this project dishonest. It is **not a spider** — it is a curated database of roughly 150 records with a change-detection layer, about 75% of them from one ARRL page, and exactly one ham-relevant source (ARDC) exposes a real API. And the AI feature **does not write your application** — it composes a prompt you run in your own assistant, and an optional API key is used only for parse assistance and review pre-scoring, never on the read path.

A test enforces both claims, because a README is the first thing that rots.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/deploy/readme.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..');
const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');

describe('README honesty surfaces', () => {
  it('says plainly that this is a curated database, not a spider', () => {
    expect(readme).toMatch(/curated database with a change-detection layer, not a spider/i);
  });

  it('states the corpus size, the concentration and the single real API', () => {
    expect(readme).toMatch(/~?150 records/);
    expect(readme).toMatch(/75%/);
    expect(readme).toMatch(/ARDC/);
    expect(readme).toMatch(/exactly one/i);
  });

  it('documents the blocklist and why each host is on it', () => {
    for (const host of ['farweb.org', 'candid.org', 'grantwatch.com', 'grantstation.com', 'instrumentl.com']) {
      expect(readme).toContain(host);
    }
    expect(readme).toMatch(/gambling/i);
    expect(readme).toMatch(/ClaudeBot/);
    expect(readme).toMatch(/survives termination/i);
  });

  it('describes the AI feature accurately and says what the server does not do', () => {
    expect(readme).toContain('Copy AI Prompt — includes AI-detection avoidance');
    expect(readme).toMatch(/does not (draft|write)/i);
    expect(readme).toMatch(/never on the read path/i);
    expect(readme).toMatch(/no funder found prohibits applicants from using AI/i);
  });

  it('explains why there is no headless browser', () => {
    expect(readme).toMatch(/headless (Chromium|browser)/i);
    expect(readme).toMatch(/400\s?MB/i);
  });

  it('documents every environment variable and that two have no default', () => {
    for (const key of ['HOST_PORT', 'PORT', 'SESSION_SECRET', 'CONTACT_URL', 'DATA_DIR', 'CRAWL_ENABLED', 'CRAWL_CRON', 'ANTHROPIC_API_KEY', 'SIMPLER_GRANTS_API_KEY']) {
      expect(readme).toContain(key);
    }
    expect(readme).toMatch(/no default/i);
  });

  it('names the verified negatives so a reader does not re-research them', () => {
    for (const thing of ['CARI', 'AMSAT', 'FlexRadio', 'Chicago FM Club', 'Icom']) {
      expect(readme).toContain(thing);
    }
  });

  it('records the disputed ARRL Club Grant cycle', () => {
    expect(readme).toMatch(/Club Grant/);
    expect(readme).toMatch(/disputed/i);
  });

  it('gives the deploy path including the workflow_dispatch gotcha', () => {
    expect(readme).toContain('ghcr.io/atvriders/grantspotter');
    expect(readme).toContain('HOST_PORT');
    expect(readme).toContain('workflow_dispatch');
  });

  it('contains no real LAN address, hostname or host path', () => {
    expect(readme).not.toMatch(/\b(?:192\.168|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(readme).not.toMatch(/\/home\/[a-z0-9_-]+\//i);
    expect(readme).not.toMatch(/\/mnt\/user\//);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/deploy/readme.test.ts
```

Expected failure: `ENOENT ... README.md`.

- [ ] **Step 3: Write `README.md`**

````markdown
# GrantSpotter

A self-hosted funding desk for collegiate and educational amateur radio. It answers four
questions for a club officer, a faculty advisor or a student:

1. What funding exists that I am actually eligible for?
2. When is it due, and when do I have to start?
3. What do I write, and what does this particular funder care about?
4. Has anything changed since I last looked?

## What this is, and what it is not

**GrantSpotter is a curated database with a change-detection layer, not a spider.**

That sentence is the whole design. The addressable corpus for amateur radio funding is
about **~150 records**, roughly **75%** of which come from a single page —
`arrl.org/scholarship-descriptions`, which carries 111 catalog entries awarding 170-plus
scholarships. **Exactly one** ham-relevant source in the entire space exposes a real API
(ARDC's WordPress REST endpoint). The federal APIs are excellent and nearly ham-free:
`"amateur radio"` returns 57 Grants.gov hits and `"cubesat"` returns one.

So GrantSpotter ships roughly 25 hand-curated sources, re-reads them nightly, hashes the
*parsed entries* rather than the raw HTML, and puts every change in front of a human
before it is published. It does not crawl the open web, and it does not pretend that
"auto-discovery" would find anything if it did.

What it is not:

- Not a general grant search engine.
- Not a submission portal. Every funder's intake is their own — Kaleidoscope, Jotform,
  email-a-PDF. GrantSpotter deep-links out and never proxies a submission.
- Not an AI writing service. See below.
- Not a mirror of commercial aggregators. See the blocklist.

## The failure mode this app is designed around

An app that confidently shows a wrong deadline is worse than no app. `arrl.org` serves
`Cache-Control: nocache` with **no ETag and no Last-Modified**, and every `<lastmod>` in
its sitemap is frozen at 2010. Application portals are JavaScript apps that return zero
server-side text, so open/closed status cannot always be determined at all.

The countermeasures are visible in the UI, not buried in the code:

- **`lastVerifiedAt` on every record.** Older than 90 days renders amber, with a one-click
  **Verify now** that refetches and shows the diff.
- **`status: unknown` is a rendered state**, never a blank field.
- **Field-level provenance**: which source, which fetch, and the raw text a value came from.
- **`disputed`**, and it ships populated. Three researchers reached three different
  conclusions about the **ARRL Club Grant** cycle on the same day — dormant, an autumn
  window, or a February/June/October pattern that is probably a conflation with the
  separate Amateur Radio Grants windows. The record shows all three with their sources
  instead of picking one.
- **Stale-mirror warnings** where a third-party aggregator is known to list something that
  no longer exists.

## Verified negatives — things that look like funding and are not

Each of these was checked by live fetch on 2026-08-02 and each ships as an explicit record,
so searching for it returns the finding rather than an empty list:

| Thing | Finding |
|---|---|
| ARRL **CARI** | Not a funding program. Meetups, a QSO party, Hamvention networking. |
| **AMSAT** | No grants program. It is a grant *recipient*, via ARISS and ARDC. |
| **FlexRadio** | No education, student, club or nonprofit purchasing tier exists. |
| **Icom** America, **DX Engineering**, Kenwood | Real equipment does go to collegiate clubs (IC-7610s to CMU W3VC, Penn State K3CR, Pitt W3YI) but there is no application path, no page and no deadline. Relationship-driven only, shipped as a playbook. |
| **DARA / Hamvention** | A grantmaker only through its ARRL catalog entry. Its own sites have no scholarship page. |
| **Chicago FM Club** Scholarship | Discontinued — zero hits in the live ARRL catalog, yet still listed by seven or more third-party aggregators. |

## A safety note about FAR

The Foundation for Amateur Radio's domain is compromised: it 301-redirects to an Indonesian
gambling site, with the takeover pinned by the Internet Archive between 2025-10-17 and
2026-02-10. QCWA, ARRL and club pages still tell applicants to "apply at the FAR website".

`farweb.org` is **hard-blocklisted in the fetcher**, not in configuration, so no crawl, no
"Verify now" and no user-supplied URL can reach it. The seed corpus carries an explicit
warning record so a student searching for "FAR" is told what happened rather than being
sent there. FAR's historical portfolio (10-10, QCWA, YASME, K3IVO, CARA) appears to have
been absorbed into the ARRL Foundation.

## The blocklist, and why each host is on it

Enforced in the fetcher layer. It cannot be disabled by configuration.

| Host | Reason |
|---|---|
| `farweb.org` | Compromised; redirects to a gambling site. |
| `candid.org`, `fconline.foundationcenter.org` | The API licence prohibits republishing and prohibits use for "artificial intelligence, large language models, machine learning, or similar applications" — and that restriction **survives termination**. |
| `grantwatch.com` | "Automated access, including scripts, bots, or data scraping tools, is prohibited"; "We do not offer or authorize any API access". |
| `grantstation.com` | The EULA bans robots and spiders and bans use for training large language models. |
| `instrumentl.com` | The ToS bans crawling, and `robots.txt` explicitly names `anthropic-ai`, `ClaudeBot` and `Claude-Web`, disallowing `/grants`, `/foundations` and `/990-report`. |

We deep-link out to the commercial aggregators where they are genuinely useful to a human.
We never store their text.

Separately, five sites deliberately block non-browser clients — `yasme.org`, `ncdxf.org`,
`radioclubofamerica.org`, `mga.ieee.org` (HTTP 418) and `k9ona.com`. **We do not spoof a
user agent to get around them.** Each is worth one or two records that a human curates in
five minutes and re-verifies quarterly.

## Polite crawling

- Per-host serialisation. Never parallel within a host.
- `robots.txt` honoured, including `Crawl-delay: 5` on arrl.org.
- A descriptive User-Agent naming the app and your `CONTACT_URL`.
- Exponential backoff. No rate limits are published for Grants.gov, NSF or USAspending, but
  absence of documentation is not absence of limits.
- Nightly, jittered. Nothing here changes faster than weekly and most sources change three
  or four times a year.
- An empty scrape is not a failure: `grants.austinhams.org` legitimately shows
  "No opportunities available" between 1 August and 30 April.

## The AI feature, described accurately

**The server does not write your application.** It never drafts a narrative and there is no
"generate my proposal" button.

What exists is a prompt composer. The button reads
**`Copy AI Prompt — includes AI-detection avoidance`**. It assembles a prompt from the
funder's real criteria, restrictions and obligations, the funder's own quoted AI policy
with its source URL, and your profile facts — and you run it in your own assistant.

The style ruleset in that prompt is not a banned-word list. It is grounded in Kobak et al.,
*Science Advances* 2025 (DOI 10.1126/sciadv.adt3813), which found that 2024's excess
vocabulary in 15M PubMed abstracts was 66% verbs and 14% adjectives — style words — where
Covid-era excess vocabulary was 79% nouns, content words. A real event changes the nouns in
your prose; an LLM changes the verbs and adjectives. So the ruleset forces proper nouns,
figures and named human subjects, caps trailing participial clauses and tricolons, and
refuses to generate any citation, statistic or URL you did not supply. Synonym-swapping,
injected typos and invisible characters are deliberately excluded: they degrade prose, and
a reviewer notices bad writing faster than a classifier notices AI.

There is also an **offline generic-prose check** that needs no API key at all: paste a
draft and get a per-paragraph report on style-word density against proper-noun and figure
density, stock transitions, tricolons, trailing participials and sentence-length variance.

On the funders: **no funder found prohibits applicants from using AI.** Policies are far
stricter on reviewers than on applicants. NSF *encourages* disclosure, Spencer *requires*
it, ARDC permits it and asks you to edit for brevity ("If the proposal is extremely long
and hard to understand, we can't evaluate or support it"), and the ARRL Foundation has not
addressed it at all. Each program's `aiPolicy` is shown next to the prompt button with the
quote and the URL, and an editable one-sentence AI-use disclosure is generated by default.

**Server-side AI is optional.** With no `ANTHROPIC_API_KEY`, everything works: deterministic
parsers, rule-based scoring and the copy-prompt flow. If a key is present, the crawler
additionally uses it to parse messy pages and pre-score review-queue items. It is never
required, **never on the read path**, and it never drafts a narrative.

## Exports

| Export | Format |
|---|---|
| Filtered opportunity list | CSV, XLSX (with a Provenance sheet) |
| Deadlines | a subscribable **ICS feed** at a per-user token URL, plus a one-off `.ics` |
| Application draft | DOCX and Markdown |
| Opportunity brief / eligibility report | PDF, via a designed print stylesheet |
| Application packet | ZIP: draft, budget worksheet, requirements checklist, source links |
| Full backup | JSON, admin only, restoreable |
| Eligibility report | CSV and PDF — "here is what I am eligible for, and why not for the rest" |

**PDF is your browser's own "Print / Save as PDF"** against a designed `@media print`
stylesheet. There is deliberately **no headless Chromium in the image**: it would add
roughly 400 MB, needs a second process supervised, and its arm64 build under emulation is a
recurring CI failure. Your browser renders the stylesheet perfectly and gives you the OS
print dialog for free.

Everything in that table has a control in the app: **Exports** in the left rail for the corpus,
the calendar and the eligibility report; an export row on **Browse** for the filtered view you are
actually looking at; DOCX, Markdown and ZIP buttons on an open draft under **Applications**; a
**Print brief** button on any opportunity; and backup/restore under **Admin**.

The ICS *feed* is the useful one. A one-off download is a snapshot that rots the moment a
funder moves a date; a token URL your phone re-reads every twelve hours is what actually
stops you missing a deadline. Create it under Exports, subscribe to the URL, and revoke it
whenever you like. Only a hash of the token is stored.

**The three draft exports are gated.** A draft will not export — from the button or from a direct
`POST` — while any figure, date, name, citation or URL in it is unconfirmed, or while any
`[TODO: …]` marker is unresolved. The server checks it, so the gate is not something a client can
skip. Every funder policy reviewed makes the human applicant, never the tool, accountable for each
number in the document, and this is that rule expressed as code.

## Accounts

Local accounts, argon2id password hashing, httpOnly session cookies. First-run admin
bootstrap prints a one-time token to the container log. No public signup by default.

| Capability | admin | member |
|---|---|---|
| Browse, match, calendar, watchlist, applications, exports | yes | yes |
| Verify now on a single record | yes | yes, rate-limited |
| Review queue: approve / reject / edit | yes | read-only |
| Source configuration, crawl trigger, sources health | yes | read-only |
| User management, JSON backup and restore | yes | no |

Members see the review queue read-only on purpose: knowing that a deadline change is
*pending review* is useful, and hiding it invites the "why is this list wrong" complaint
the trust surfaces exist to prevent.

## Deploying

The image is built by GitHub Actions for `linux/amd64` and `linux/arm64` and published to
`ghcr.io/atvriders/grantspotter:latest`. The repository and the package are public.

```bash
cp .env.example .env
# fill in SESSION_SECRET and CONTACT_URL — neither has a default
docker compose pull
docker compose up -d
```

Then open `http://127.0.0.1:${HOST_PORT}` and read the container log for the one-time admin
bootstrap token.

`HOST_PORT` is a variable because 3030 is a popular default and is frequently already
claimed on a busy host. Change it in `.env`, never in `docker-compose.yml`.

**CI note:** a freshly created or forked repository sometimes will not run its first
push-triggered workflow. The build workflow includes `workflow_dispatch` for exactly that
case — trigger it once by hand from the Actions tab and subsequent pushes behave normally.

### Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `HOST_PORT` | no | `3030` | compose host port only |
| `PORT` | no | `3030` | in-container listen port |
| `SESSION_SECRET` | **yes** | **no default** | the server refuses to start without it |
| `CONTACT_URL` | **yes** | **no default** | goes in the crawler User-Agent |
| `DATA_DIR` | no | `/data` | sqlite, snapshots, fixture cache |
| `CRAWL_ENABLED` | no | `true` | |
| `CRAWL_CRON` | no | `17 3 * * *` | nightly, jittered in code |
| `ANTHROPIC_API_KEY` | no | none | optional parse assist only |
| `SIMPLER_GRANTS_API_KEY` | no | none | optional federal ranking |

`SESSION_SECRET` having no default is deliberate. A shipped default session secret is a
shared secret, which is not a secret.

## Development

```bash
npm ci
npm run dev            # server plus Vite
npm run typecheck
npm run build
npm test               # unit and integration, no network
npm run test:e2e       # Playwright
npm run verify-sources # LIVE, warn-only, never a CI gate
npm run seed:arrl      # regenerate the ARRL catalog seed from the committed fixture
```

Every source parser is tested against committed real payloads under `fixtures/`. All of
them verify with zero network access, and refreshing a fixture is a deliberate, reviewable
act rather than silent drift. `verify-sources` is the only thing that touches the live
network and it never gates a build.

## The two sources of money you cannot aggregate

Campus student government (roughly 4,000 independent campuses) and NASA State Space Grant
(52 independent consortium calendars) are, per the research behind this app, where a typical
collegiate club's money actually comes from — and neither is automatable at any scale. They
ship as **guided workflows**: a state-keyed consortium picker, and an SGA playbook that
includes the trap Florida State's published rules expose — *student-activity-fee rules
frequently bar capital equipment, so a radio has to be framed as programming or funded from
outside*. That framing advice may be worth more than the entire opportunity index.

## Data and licensing

The seed corpus is **structured facts plus short excerpts**: funder, program, amounts,
deadlines, eligibility axes, obligations, source URL, `lastVerifiedAt` and provenance.
Facts are not copyrightable; long verbatim descriptions are a different matter, so there are
no page dumps here. Every record links back to its source and re-verifies through the normal
pipeline.

Code is MIT licensed. See `LICENSE`.
````

- [ ] **Step 4: Write `LICENSE`**

Create `LICENSE` with the standard MIT text, `Copyright (c) 2026 Atvriders`.

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd /path/to/grantspotter && npx vitest run packages/server/src/deploy/readme.test.ts
```

Expected: 10 passing tests.

- [ ] **Step 6: Commit**

```bash
cd /path/to/grantspotter
git add README.md LICENSE packages/server/src/deploy/readme.test.ts
git commit -m "docs: README that is honest about the corpus, the blocklist and the AI feature"
```

---

### Task 22: The spec §14 end-to-end flow, all nine steps

Spec §14 names one journey and it is nine steps long: **log in → set a profile → browse with
matcher verdicts → star a program → calendar → export ICS → open a template → copy an AI prompt →
run the prose check.** Plan 3's `flow.spec.ts` stops after the calendar and a change event; Plan 4's
`writing.spec.ts` covers templates, the prompt and the prose check as separate journeys. Nothing
asserts the whole chain in one session, and the ICS step — the one this plan owns — is asserted
nowhere at all. This task closes that.

**Files:**
- Modify: `e2e/flow.spec.ts` (Plan 3 Task 26 — add two tests: the nine-step journey, and the four
  SPA-routing guarantees Task 17 owns)
- Modify: `playwright.config.ts` (Plan 3 Task 26 — allow clipboard access for the prompt step)

**Interfaces:**
- Consumes: the running app; `MEMBER_EMAIL`, `MEMBER_PASSWORD` from Plan 3's `e2e/helpers.ts`.
- Produces: nothing importable. This is a verification gate.

- [ ] **Step 1: Grant clipboard permission in the Playwright config**

The prompt step asserts what actually landed on the clipboard, which needs a permission Chromium
does not give by default. In `playwright.config.ts`, inside `use`:

```ts
    permissions: ['clipboard-read', 'clipboard-write'],
```

- [ ] **Step 2: Add the nine-step test to `e2e/flow.spec.ts`**

Append it after Plan 3's existing tests. It is deliberately one long test rather than nine short
ones: the point of the assertion is that the steps compose in a single session, which nine
isolated tests would not prove.

```ts
test('spec §14: log in, profile, browse, star, calendar, ICS, template, prompt, prose check', async ({ page }) => {
  // 1 — log in
  await page.goto('/');
  await page.getByLabel('Email').fill(MEMBER_EMAIL);
  await page.getByLabel('Password').fill(MEMBER_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Browse opportunities' })).toBeVisible();

  // 2 — set a profile
  await page.getByRole('link', { name: 'Profile' }).click();
  await page.getByLabel('Callsign').fill('W8UM');
  await page.getByLabel('License class').selectOption('GENERAL');
  await page.getByLabel('State').fill('MI');
  await page.getByLabel('Degree level').selectOption('BACH');
  await page.getByLabel('Stage').selectOption('UNDERGRAD');
  await page.getByLabel('Citizenship').selectOption('US_CITIZEN');
  await page.getByRole('button', { name: /save student profile/i }).click();
  await expect(page.getByRole('status')).toContainText('saved');

  // 3 — browse with verdicts
  await page.getByRole('link', { name: 'Browse' }).click();
  await expect(page.getByRole('table', { name: 'Opportunities' })).toBeVisible();
  await expect(page.getByText(/you are ineligible for \d+ of these/i)).toBeVisible();

  // 4 — star a program
  await page.goto('/o/arrl-foundation-scholarships');
  await page.getByRole('button', { name: 'Watch this program' }).click();
  await expect(page.getByRole('button', { name: 'Stop watching this program' })).toBeVisible();
  // The brief is printable, which is how spec §11.3 delivers "Opportunity brief | PDF".
  await expect(page.getByRole('button', { name: 'Print brief' })).toBeVisible();

  // 5 — calendar
  await page.getByRole('link', { name: 'Calendar' }).click();
  await expect(page.getByRole('list', { name: 'Agenda' })).toBeVisible();

  // 6 — export ICS, through the UI a user actually has
  await page.getByRole('link', { name: 'Exports' }).click();
  await expect(page.getByRole('heading', { name: 'Take it with you' })).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: /one-off \.ics$/i }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^grantspotter-deadlines-\d{4}-\d{2}-\d{2}\.ics$/);
  const icsPath = await download.path();
  const ics = readFileSync(icsPath!, 'utf8');
  expect(ics.startsWith('BEGIN:VCALENDAR')).toBe(true);
  expect(ics).toContain('BEGIN:VEVENT');
  // The subscribable feed is the one that keeps working; prove it is creatable and serves.
  await page.getByRole('button', { name: /create a calendar feed/i }).click();
  const feedUrl = await page.getByLabel(/subscribe url/i).inputValue();
  expect(feedUrl).toMatch(/\/calendar\/[A-Za-z0-9_-]{40,}\.ics$/);
  const feed = await page.request.get(feedUrl);
  expect(feed.status()).toBe(200);
  expect(feed.headers()['content-type']).toContain('text/calendar');
  expect(await feed.text()).toMatch(/^BEGIN:VCALENDAR/);

  // 7 — open a template, from the program so the funder overlay resolves
  await page.goto('/o/ardc-grants');
  await page.getByRole('link', { name: 'Start an application for this program' }).click();
  await expect(page).toHaveURL(/\/applications\?programId=ardc-grants/);
  await page.getByRole('button', { name: 'New draft' }).click();
  await page.getByRole('button', { name: /Need statement/ }).click();
  await expect(page.getByLabel('Draft')).toContainText('[TODO:');

  // 8 — copy an AI prompt, and check what actually reached the clipboard
  await page.getByRole('button', { name: 'Copy AI Prompt — includes AI-detection avoidance' }).click();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toContain('ARDC');
  expect(clipboard.length).toBeGreaterThan(400);

  // 9 — run the prose check
  await page.getByLabel('Draft').fill(
    "In today's rapidly evolving landscape, our organization delves into the transformative " +
    'potential of amateur radio, underscoring our unwavering commitment to educate, empower and inspire.',
  );
  await page.getByLabel('Draft').blur();
  await page.getByRole('button', { name: 'Run prose check' }).click();
  await expect(page.getByRole('heading', { name: 'Prose check' })).toBeVisible();
  await expect(page.getByText(/has no proper noun and no figure in it/i)).toBeVisible();
});
```

and add `readFileSync` to the file's imports:

```ts
import { readFileSync } from 'node:fs';
```

- [ ] **Step 3: Run the e2e suite**

```bash
cd /path/to/grantspotter && npm run test:e2e
```

Expected: green, including Plan 3's and Plan 4's existing specs. If Playwright's browsers are not
installed:

```bash
cd /path/to/grantspotter && npx playwright install chromium
```

Three failures worth naming in advance. `Exports` not found in the rail means Task 10's `NAV` entry
was not added — or that someone retyped the array and deleted entries (RESOLUTIONS R18). A 409 on
the eligibility links means the profile step did not save — that is a real product bug in the
ordering, not a test artefact, because a user who has just saved a profile must be able to export
against it immediately. And if **every** spec dies on its first line with a page whose body is
`{"error":{"code":"not_found"…}}`, the SPA is not being served: `a.use(createSpaMiddleware(webDistRoot()));`
is missing from the `mountRoutes` callback in `packages/server/src/index.ts` — Task 17 Step 5 adds
it, as the last statement — and `page.goto('/')` is getting Plan 1's JSON 404 instead of
`index.html`. That line is Plan 5's to add, not Plan 3's (RESOLUTIONS R25), so it is this plan that
failed, not the one before it.

- [ ] **Step 4: Re-assert the four SPA-routing guarantees against the running e2e server**

Playwright's `webServer` is the real entrypoint, so the same four assertions `spa.test.ts` pins on a
hand-built app are worth one more check against the thing the browser is actually talking to. Append
this test to `e2e/flow.spec.ts`; it uses `request` rather than `page` because two of the four are
about what is *not* HTML:

```ts
// Relative paths resolve against playwright.config.ts's baseURL, which points at the
// same single process the container runs.
test('the single process serves the SPA on / and still answers JSON on /api', async ({ request }) => {
  const root = await request.get('/');
  expect(root.status()).toBe(200);
  expect(root.headers()['content-type']).toContain('text/html');
  const shell = await root.text();
  expect(shell).toContain('<div id="root">');

  // A deep client-side route returns the SAME shell: that is what makes a hard
  // refresh on /browse work, and it is Plan 5 Task 17's line that provides it.
  const deep = await request.get('/browse');
  expect(deep.status()).toBe(200);
  expect(await deep.text()).toBe(shell);

  // The history fallback must not have swallowed the API.
  const unknown = await request.get('/api/unknown');
  expect(unknown.status()).toBe(404);
  expect(unknown.headers()['content-type']).toContain('application/json');
  const envelope = await unknown.json() as { error: { code: string }; requestId: string };
  expect(envelope.error.code).toBe('not_found');
  expect(typeof envelope.requestId).toBe('string');

  // Only a GET gets the shell; a POST falls through to the JSON 404.
  const posted = await request.post('/', { data: {} });
  expect(posted.status()).toBe(404);
  expect(posted.headers()['content-type']).toContain('application/json');
  expect(await posted.text()).not.toContain('<div id="root">');
});
```

```bash
cd /path/to/grantspotter && npm run test:e2e
```

Expected: green. A `text/html` body on `/api/unknown` means the SPA middleware was registered
**before** the routers instead of last.

- [ ] **Step 5: Commit**

```bash
cd /path/to/grantspotter
git add e2e/flow.spec.ts playwright.config.ts
git commit -m "test(e2e): the full spec §14 nine-step flow, including the ICS export"
```

---

### Task 23: FINAL VERIFICATION, the two audits, and the single push

**Files:**
- Modify: none, unless an audit finds a defect. Fixes get their own commits.

**This is the last task in the whole project.** Nothing before it has pushed anything, and
nothing after it exists. Work through it in order and do not skip to step 7.

Auth for the push: the working Atvriders credential is the **gh oauth token in
`~/.config/gh/hosts.yml`** (scopes `repo`, `workflow`). The PAT at `~/.github_token` is
**expired** and returns `Bad credentials` — do not use it.

- [ ] **Step 1: Typecheck**

```bash
cd /path/to/grantspotter && npm run typecheck
```

Expected: exits 0 with no output. Any error is a blocker; fix it and commit the fix before
continuing.

- [ ] **Step 2: Build**

```bash
cd /path/to/grantspotter && npm run build
```

Expected: exits 0, and `packages/core/dist`, `packages/server/dist` and `packages/web/dist`
all exist. Confirm:

```bash
cd /path/to/grantspotter && ls packages/core/dist packages/server/dist packages/web/dist >/dev/null && echo "all three dist trees present"
```

- [ ] **Step 3: Unit and integration tests**

```bash
cd /path/to/grantspotter && npm test
```

Expected: every workspace green, zero failures, zero skipped tests that were meant to run.
Record the total count — it goes in the final report.

- [ ] **Step 4: End-to-end tests**

```bash
cd /path/to/grantspotter && npm run test:e2e
```

Expected: green. All three specs run: Plan 3's `flow.spec.ts` (including the two tests Task 22
added — the nine-step spec §14 journey of log in, set profile, browse with matcher verdicts, star,
calendar, export ICS, open a template, copy an AI prompt, run the prose check; and the SPA-routing
test asserting `/` and `/browse` return the same HTML shell while `/api/unknown` and `POST /` stay
JSON), Plan 4's `writing.spec.ts`, and Plan 3's inbox and sources tests. If Playwright browsers are not installed on this host:

```bash
cd /path/to/grantspotter && npx playwright install chromium
```

- [ ] **Step 5: COMPLETENESS AUDIT — walk every section of the spec**

Open `docs/superpowers/specs/2026-08-02-grantspotter-design.md` and confirm a shipped
implementation exists for each item below. Tick each line only after seeing the code or the
data, not from memory. Write the result into your final report; **list anything missing
rather than quietly fixing it at this stage**, then decide explicitly whether it blocks.

- [ ] §2 Scope — all four opportunity classes present in the corpus (`ham_grant`,
      `ham_scholarship`, `adjacent_stem`, `equipment_in_kind`). Check with:
      `npx tsx -e "import('./packages/server/src/seed/load.js').then(m=>{const c=m.loadSeedCorpus();console.log([...new Set(c.programs.map(p=>p.klass))])})"`
- [ ] §2.1 Verified negatives — all six shipped as records (`negatives.test.ts` proves it).
- [ ] §2.2 FAR — blocklisted in the fetcher *and* a warning record in the seed.
- [ ] §3.1 Module boundaries — `core/` has no `node:` imports and no dependency but zod;
      `sources/*` import no sibling source and no database.
- [ ] §4 Data model — every type in CONTRACT §3 exists in `packages/core/src/types.ts` and
      is mirrored in `schema.ts`.
- [ ] §4.2 The four shape-conflicts — `applicantEntities`, `instrument`, `DeadlineKind`,
      `applyVia` all first-class enums, and the corpus exercises more than one value of each.
- [ ] §4.3 `hard` + `fallbackRank` on every constraint; `DeadlineSource` inheritance
      (`Program.deadline.source = { kind: 'inherited', fromProgramId }`) used by the 111 catalog
      records, all pointing at `arrl-foundation-scholarships`.
- [ ] §5 Matcher — all four verdict kinds reachable; soft constraints never exclude.
- [ ] §6 Change detection — all seven `ChangeKind` values emitted somewhere in `diff/`;
      `parse_yield_dropped` is a real alarm driven by `expectedMinRecords`.
- [ ] §7.2 Blocklist — enforced in the fetcher, not config, and un-bypassable.
- [ ] §7.4 Grants.gov RSS trap — the source registry carries the note saying why the four
      advertised feeds are not used.
- [ ] §8 Honesty surfaces — `lastVerifiedAt` badge, `status: unknown` rendered, field-level
      provenance, `disputed` populated on the Club Grant, sources health page, stale-mirror
      warning.
- [ ] §9 AI policy — `aiPolicy` populated per program; server-side AI optional and absent
      from the read path.
- [ ] §10 Writing tools — component templates, funder overlays, slot filling with `[TODO: …]`
      for unknowns, prompt composer, offline prose analyzer, fact checklist, disclosure
      sentence.
- [ ] §11 Calendar, watchlist, exports — every row of the §11.3 export table shipped **and
      reachable from the running app**: the Exports route in the rail, the export menu on Browse,
      DOCX / Markdown / ZIP on an open draft, the printable eligibility report, the Print brief
      control on an opportunity, and backup/restore on the admin screen. Walk them in the browser;
      an endpoint with no control is a missing feature, not a shipped one.
- [ ] §10.4 The export gate — `POST /api/exports/draft.docx` with an application that still has an
      unconfirmed fact answers **409**, not a document. Check it with curl, not from memory.
- [ ] §12 Accounts — the capability matrix matches the implementation, including members
      seeing the review queue read-only.
- [ ] §13 Seed corpus — roughly 150 records, structured facts, short excerpts, negatives,
      FAR warning, and a validation test that fails the build on a malformed record.
- [ ] §14 Testing — pure-module unit coverage, parser fixtures, API integration tests,
      Playwright e2e, `verify-sources` warn-only.
- [ ] §15 Deployment — Dockerfile, workflow, compose, `.env.example`, no real host details.
- [ ] §15 **The SPA is actually served, and the mount ordering is right** — `packages/server/src/api/spa.ts`
      exists (**Task 17**, which also owns the four routing assertions: `/` is HTML, `/browse` is
      the same HTML, `/api/unknown` is still Plan 1's JSON 404 envelope, `POST /` falls through),
      and the `mountRoutes` callback in `packages/server/src/index.ts` reads, in this order:
      Plan 3's `mountProductApi(…)`, Plan 4's four `create*Router(routerDeps)` lines, **Task 9
      Step 9's** `a.use('/api', createExportsRouter(exportDeps));` and
      `a.use('/', createCalendarFeedRouter(exportDeps));`, and **last of all Task 17 Step 5's**
      `a.use(createSpaMiddleware(webDistRoot()));`. The hook is filled incrementally by four plans
      (RESOLUTIONS R25) and Express matches in registration order, so ordering is the whole
      contract: anything after the SPA line is unreachable for GETs, and without that line the
      container — which runs one process — is an API with no UI and every e2e spec fails on
      `page.goto('/')`. Prove it, do not assume it:

```bash
cd /path/to/grantspotter
grep -rn "express.static" packages/server/src --include='*.ts' | grep -v '\.test\.ts'
grep -n "a\.use(" packages/server/src/index.ts
grep -c "^[^/]*createSpaMiddleware(webDistRoot())" packages/server/src/index.ts
grep -rn "app\.use(" packages/server/src/index.ts | grep -v "a\.use(" \
  || echo "no bare app.use(...) outside the callback — correct"
```

      Expected: one `express.static` line, from `api/spa.ts` and nowhere else; the `a.use(` listing
      in the order above with `createSpaMiddleware` last; a count of exactly `1`; and the "no bare
      `app.use(...)`" line — a mount after `createApp` returns is dead code, because Plan 1 sealed
      the app with `notFoundHandler()` (RESOLUTIONS R5). Step 6c then checks the running server
      actually answers `/` with HTML and `POST /` with JSON.

      Two of those gates have a shape worth understanding before you act on a failure. The count
      gate matches **executable** occurrences only: `^[^/]*` requires a prefix with no `/` in it,
      so the real `    a.use(createSpaMiddleware(webDistRoot()));` matches and a commented
      `    //     a.use(createSpaMiddleware(webDistRoot()));` does not. That distinction matters
      because Plan 3 Task 14's reservation block *quotes* this exact line as its worked example;
      Task 17 Step 5 deletes that whole block, but if it survived, an unanchored count would read
      `2` and this audit would fail on a correct file. A `2` from the anchored gate is a genuine
      duplicate mount — find and delete the second statement. The last gate ends in `|| echo`
      because its passing case prints nothing and a bare failing pipeline would otherwise read as
      an error; `grep -v "a\.use("` does not swallow an offending line, since `app.use(` does not
      contain the substring `a.use(`.

- [ ] **Step 6: DEBUG AUDIT — run the thing and try to break it**

Run each of these and read the output. A warning in the log counts as a finding.

**6a. It must refuse to start with no session secret.**

```bash
cd /path/to/grantspotter
env -u SESSION_SECRET CONTACT_URL="https://www.example.org/grantspotter" DATA_DIR="$(mktemp -d)" \
  node packages/server/dist/index.js; echo "exit=$?"
```

Expected: a clear error naming `SESSION_SECRET` and a non-zero exit. If it starts, that is a
blocker — fix it and commit before continuing.

**6b. It must start with one, and log the seed import and the bootstrap token.**

```bash
cd /path/to/grantspotter
export GS_DATA="$(mktemp -d)"
SESSION_SECRET="$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")" \
CONTACT_URL="https://www.example.org/grantspotter" DATA_DIR="$GS_DATA" CRAWL_ENABLED=false PORT=3131 \
  node packages/server/dist/index.js > /tmp/grantspotter-audit.log 2>&1 &
echo $! > /tmp/grantspotter-audit.pid
```

Wait a few seconds, then read the log with the Read tool and confirm: the seed import line
reports roughly 143 programs, the admin bootstrap token is printed, and there is **no**
stack trace, no unhandled rejection and no deprecation warning.

**This one server has to survive until 6f**, because 6c-1, 6c-2 and 6c-3 all talk to it and 6c-2
mints a session against the database it opened. Each of those is a separate tool call, so start
every one of them with the liveness line below rather than assuming the process is still there —
`000` means the background process did not outlive its tool call, in which case re-run 6b's start
command at the top of the same block as the checks that follow it. A connection refusal misread
as a routing failure is the fastest way to "fix" a working mount.

**6c-1. Exercise the unauthenticated flows over HTTP.**

```bash
cd /path/to/grantspotter
curl -sS -o /dev/null -w 'liveness %{http_code}\n' http://127.0.0.1:3131/api/health || true
curl -sS -o /dev/null -w 'root %{http_code} %{content_type}\n' http://127.0.0.1:3131/
curl -sS http://127.0.0.1:3131/ | head -c 60; echo
curl -sS -o /dev/null -w 'deep-link %{http_code} %{content_type}\n' http://127.0.0.1:3131/watchlist
curl -sS -o /dev/null -w 'browse-same-shell %{http_code} %{content_type}\n' http://127.0.0.1:3131/browse
diff <(curl -sS http://127.0.0.1:3131/) <(curl -sS http://127.0.0.1:3131/browse) \
  && echo "/ and /browse return the same shell" || echo "FAILURE: /browse is not the SPA shell"
curl -sS -o /dev/null -w 'api-unknown %{http_code} %{content_type}\n' http://127.0.0.1:3131/api/unknown
curl -sS -o /dev/null -X POST -w 'post-root %{http_code} %{content_type}\n' http://127.0.0.1:3131/
curl -sS -o /dev/null -w 'calendar-bad-token %{http_code}\n' http://127.0.0.1:3131/calendar/not-a-real-token
curl -sS -o /dev/null -w 'export-unauthed %{http_code}\n' http://127.0.0.1:3131/api/exports/opportunities.csv
```

Expected — `liveness 200` first (anything else means the server from 6b is gone; re-read the note
above before touching any code), then the four guarantees Task 17 owns plus the two mount
checks: `/` is `200 text/html` and the first 60 bytes are the `<!doctype html>` shell (Task 17's
`createSpaMiddleware` doing its job); `/watchlist` and `/browse` are also `200 text/html` and
`/browse` is **byte-identical** to `/` (the history fallback); `/api/unknown` is
`404 application/json`, proving the fallback did **not** swallow the API; `POST /` is
`404 application/json`, proving only a GET gets the shell; an unknown calendar token is `404`; and
an unauthenticated export is `401` or `403`, never `200`.

**A JSON 404 on `/` is a blocker** — Task 17 Step 5's `a.use(createSpaMiddleware(webDistRoot()));`
is missing from the `mountRoutes` callback in `packages/server/src/index.ts`, or was registered
before the routers instead of last. **HTML on `/api/unknown` is the same blocker inverted** — the
SPA line is not last. **A 404 on the export route** means Task 9 Step 9's two mount lines never
landed.

**6c-2. Now become the bootstrap admin and walk every gated export.** Run this as one block —
each step feeds the next through shell variables, and shell variables do not survive between
tool calls:

```bash
cd /path/to/grantspotter
curl -sS -o /dev/null -w 'liveness     %{http_code}\n' http://127.0.0.1:3131/api/health || true
# Plan 1's first-run banner prints the one-time token (48 hex characters) on its own
# line, two lines below "…with this one-time token:". Take it from the log 6b wrote.
GS_TOKEN=$(awk '/one-time token:/{getline; getline; print $1; exit}' /tmp/grantspotter-audit.log)
echo "bootstrap token: ${GS_TOKEN:-MISSING}"
curl -sS -c /tmp/gs-cookies -o /dev/null -w 'bootstrap    %{http_code}\n' \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$GS_TOKEN\",\"email\":\"audit@example.org\",\"password\":\"a-long-enough-password\"}" \
  http://127.0.0.1:3131/api/auth/bootstrap
curl -sS -b /tmp/gs-cookies -o /dev/null -w 'me           %{http_code}\n' http://127.0.0.1:3131/api/auth/me

# The eligibility report is computed against a profile, so save one first
# (Plan 3's PUT /api/profiles/:kind) or it answers 409 conflict, correctly.
curl -sS -b /tmp/gs-cookies -o /dev/null -w 'profile      %{http_code}\n' -X PUT \
  -H 'content-type: application/json' \
  -d '{"kind":"student","callsign":"K5UTD","licenseClass":"EXTRA","state":"TX"}' \
  http://127.0.0.1:3131/api/profiles/student

curl -sS -b /tmp/gs-cookies -D - -o /tmp/gs-opportunities.csv \
  http://127.0.0.1:3131/api/exports/opportunities.csv | grep -i 'content-disposition'
curl -sS -b /tmp/gs-cookies -o /tmp/gs-opportunities.xlsx \
  http://127.0.0.1:3131/api/exports/opportunities.xlsx
head -c 2 /tmp/gs-opportunities.xlsx; echo "  <- expect PK"
curl -sS -b /tmp/gs-cookies http://127.0.0.1:3131/api/exports/deadlines.ics | head -1
curl -sS -b /tmp/gs-cookies http://127.0.0.1:3131/api/exports/eligibility.html \
  | grep -c 'Print / Save as PDF'

# The subscribable feed: mint a token, then fetch the URL it returns with NO cookie,
# exactly the way a phone's calendar client will.
GS_ICS_URL=$(curl -sS -b /tmp/gs-cookies -X POST http://127.0.0.1:3131/api/exports/ics-token \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).url")
echo "ics url: $GS_ICS_URL"
curl -sS -o /dev/null -w 'ics feed     %{http_code} %{content_type}\n' "$GS_ICS_URL"
```

Expected: `bootstrap 201`, `me 200`, `profile 200`, a `Content-Disposition` header naming a
`.csv` filename, `PK` as the first two bytes of the XLSX, `BEGIN:VCALENDAR` as the first line of
the ICS, `1` from the `Print / Save as PDF` count, and the token URL answering
`200 text/calendar` with no cookie at all. A `MISSING` token means 6b never started; a `409` on
bootstrap means this data directory is not fresh — `mktemp -d` a new one and restart 6b.

**6c-3. Prove the export gate is on the server, not just in the browser (spec §10.4).** Create a
draft, put one unconfirmed money figure in it, and POST it straight at the exporter, skipping the
UI entirely — again as one block, because the application id is carried in a shell variable:

```bash
cd /path/to/grantspotter
GS_APP_ID=$(curl -sS -b /tmp/gs-cookies -H 'content-type: application/json' \
  -d '{"title":"Audit draft","programId":"ardc-grants"}' \
  http://127.0.0.1:3131/api/applications \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
echo "application id: ${GS_APP_ID:-MISSING}"
curl -sS -b /tmp/gs-cookies -o /dev/null -w 'patch draft  %{http_code}\n' -X PATCH \
  -H 'content-type: application/json' \
  -d '{"bodyMarkdown":"# Budget\n\nOne transceiver at $2,899."}' \
  "http://127.0.0.1:3131/api/applications/$GS_APP_ID"
curl -sS -b /tmp/gs-cookies -o /dev/null -w 'unconfirmed draft export: %{http_code}\n' \
  -H 'content-type: application/json' \
  -d "{\"applicationId\":\"$GS_APP_ID\",\"programId\":\"ardc-grants\"}" \
  http://127.0.0.1:3131/api/exports/draft.docx
```

Expected: `application id:` printing a uuid (not `MISSING`, not `undefined` — either means the
create returned an error envelope instead of a row), `patch draft  200`, and
**`unconfirmed draft export: 409`**. `$2,899` is one money assertion that nobody has confirmed,
which is exactly what `assertExportReady` refuses to export. A `200` on the last line means the
fact checklist gates only the button and a direct POST walks straight past it — a blocker, and
precisely the finding this plan was corrected for. A `422` means the body schema rejected the
request before the gate ever ran, so the check proved nothing: fix the id first and re-run.

**6d. Prove the blocklist blocks.**

```bash
cd /path/to/grantspotter
npx tsx -e "import('./packages/server/src/fetcher/blocklist.js').then(async (m)=>{ \
  for (const u of ['https://farweb.org/','http://www.farweb.org/apply','https://instrumentl.com/grants','https://grantwatch.com/']) { \
    try { m.assertNotBlocked(u); console.log('NOT BLOCKED (FAILURE):', u); process.exitCode = 1; } \
    catch { console.log('blocked ok:', u); } } })"
```

Expected: four `blocked ok` lines and exit 0. Anything else is a blocker.

**6e. Prove seed validation fails the build on a malformed record.**

```bash
cd /path/to/grantspotter
cp data/seed/programs.negatives.json /tmp/negatives.backup.json
node -e "const f='data/seed/programs.negatives.json';const d=JSON.parse(require('fs').readFileSync(f,'utf8'));d.programs[0].klass='not_a_class';require('fs').writeFileSync(f,JSON.stringify(d,null,2))"
npx vitest run packages/server/src/seed/seed.test.ts; echo "exit=$? (a NON-zero exit here is the correct result)"
cp /tmp/negatives.backup.json data/seed/programs.negatives.json
npx vitest run packages/server/src/seed/seed.test.ts
git diff --stat data/seed
```

Expected: the first run fails naming the bad field, the second run passes, and
`git diff --stat data/seed` prints nothing — the file is byte-identical to what was committed.

**6f. Stop the server and confirm a clean shutdown.**

```bash
kill "$(cat /tmp/grantspotter-audit.pid)"; sleep 2
tail -n 20 /tmp/grantspotter-audit.log
rm -f /tmp/grantspotter-audit.pid /tmp/negatives.backup.json
```

Expected: no error on shutdown, no "unhandled" anything in the last lines.

**6g. Confirm the working tree is clean and nothing secret is staged.**

```bash
cd /path/to/grantspotter
git status --short
git log --oneline | head -25
grep -rniE '(192\.168|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|/home/[a-z0-9_-]+/|/mnt/user/|sk-ant-|gh[pous]_[A-Za-z0-9]{20,})' \
  --include='*.ts' --include='*.tsx' --include='*.json' --include='*.yml' --include='*.md' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=docs . || echo "no host details or secrets found"
```

Expected: `git status --short` prints nothing, and the grep prints the "no host details"
line. A hit inside `docs/` is expected and fine (the plans reference local paths); a hit
anywhere else is a blocker.

- [ ] **Step 7: THE SINGLE PUSH — create the public repository and push master**

Only run this step if steps 1 through 6 are all green.

**7a. Load the working token.** The gh oauth token, not the expired PAT:

```bash
GH_TOKEN=$(grep -m1 'oauth_token:' ~/.config/gh/hosts.yml | sed 's/.*oauth_token:[[:space:]]*//')
curl -sS -H "Authorization: token $GH_TOKEN" https://api.github.com/user | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).login"
```

Expected: it prints the account login. If it prints `undefined` or an error mentioning
`Bad credentials`, stop — you have picked up the expired PAT from `~/.github_token`.

**Shell variables do not survive between tool calls, so every block below re-derives `GH_TOKEN`
on its own first line.** That repetition is deliberate. A block that inherits an empty `GH_TOKEN`
sends `Authorization: token ` and gets a `401` back, which reads exactly like an expired
credential and sends you hunting for the wrong bug on the last step of the project.

**7b. Create the repository, PUBLIC, under Atvriders:**

```bash
GH_TOKEN=$(grep -m1 'oauth_token:' ~/.config/gh/hosts.yml | sed 's/.*oauth_token:[[:space:]]*//')
curl -sS -X POST \
  -H "Authorization: token $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/orgs/Atvriders/repos \
  -d '{"name":"grantspotter","description":"A self-hosted funding desk for collegiate and educational amateur radio: curated corpus, change detection, eligibility matcher.","private":false,"has_issues":true,"has_wiki":false}' \
  | node -pe "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); r.full_name ? r.full_name+' private='+r.private : JSON.stringify(r)"
```

Expected: `Atvriders/grantspotter private=false`. If it reports the name already exists,
confirm the existing repository is public before continuing.

**7c. Push master.** Push with the token inline so it never lands in `.git/config`, then set
a token-free remote:

```bash
cd /path/to/grantspotter
GH_TOKEN=$(grep -m1 'oauth_token:' ~/.config/gh/hosts.yml | sed 's/.*oauth_token:[[:space:]]*//')
git branch --show-current    # expect: master
git push "https://x-access-token:${GH_TOKEN}@github.com/Atvriders/grantspotter.git" master
git remote add origin https://github.com/Atvriders/grantspotter.git
git remote -v
```

Expected: the push succeeds and `git remote -v` shows a URL with **no token in it**.

**7d. Confirm Actions ran and went green:**

```bash
sleep 60
GH_TOKEN=$(grep -m1 'oauth_token:' ~/.config/gh/hosts.yml | sed 's/.*oauth_token:[[:space:]]*//')
curl -sS -H "Authorization: token $GH_TOKEN" \
  "https://api.github.com/repos/Atvriders/grantspotter/actions/runs?per_page=3" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).workflow_runs.map(r=>[r.name,r.status,r.conclusion,r.html_url].join(' | ')).join('\n') || 'NO RUNS YET'"
```

Re-run that command every couple of minutes until `status` is `completed`. The multi-arch
build takes roughly ten to twenty minutes because the arm64 layer compiles `better-sqlite3`
under QEMU emulation.

**If it prints `NO RUNS YET` after five minutes, that is the fork gotcha.** Trigger the
workflow by hand:

```bash
GH_TOKEN=$(grep -m1 'oauth_token:' ~/.config/gh/hosts.yml | sed 's/.*oauth_token:[[:space:]]*//')
curl -sS -X POST -H "Authorization: token $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/Atvriders/grantspotter/actions/workflows/build.yml/dispatches \
  -d '{"ref":"master"}' -w 'dispatch %{http_code}\n'
```

Expected: `dispatch 204`, then a run appears. Wait for `conclusion: success`. If the run
fails, read the failing step's log, fix it locally, commit, and push again — pushing a fix
after a failed CI run is fine; the "one push" rule is about not publishing before the
audits, not about never pushing twice.

**7e. Confirm the GHCR package is public and pullable.** There is no Docker on this host, so
verify through the registry API instead: an anonymous pull token only works for a public
package.

```bash
TOKEN=$(curl -sS "https://ghcr.io/token?scope=repository:atvriders/grantspotter:pull&service=ghcr.io" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
curl -sS -o /dev/null -w 'anonymous manifest fetch: %{http_code}\n' \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
  https://ghcr.io/v2/atvriders/grantspotter/manifests/latest
```

Expected: `200`. A `401` means the package is still private — open
`https://github.com/orgs/Atvriders/packages`, select `grantspotter`, and set its visibility
to public, then re-run the check.

Then confirm both architectures are actually in the manifest list:

```bash
TOKEN=$(curl -sS "https://ghcr.io/token?scope=repository:atvriders/grantspotter:pull&service=ghcr.io" \
  | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).token")
curl -sS -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
  https://ghcr.io/v2/atvriders/grantspotter/manifests/latest \
  | node -pe "const m=JSON.parse(require('fs').readFileSync(0,'utf8')); (m.manifests||[]).map(x=>x.platform.os+'/'+x.platform.architecture).join(', ')"
```

Expected: `linux/amd64, linux/arm64`.

Actually pulling and running the image is the owner's step — there is no Docker here.

- [ ] **Step 8: Write the final report**

Report, in this order:

1. `typecheck`, `build`, `test` (with the total test count) and `test:e2e` results.
2. The completeness audit: every spec section with a shipped/missing verdict, and an
   explicit list of anything missing.
3. The debug audit: each of 6a-6g with what was observed, including any warning in the log.
4. The push: the repository URL, the Actions run URL and its conclusion, the anonymous GHCR
   manifest status code and the platform list.
5. Anything left for the owner: pulling and running the image on their own host, and
   re-verifying the corpus after the next ARRL catalog change.

- [ ] **Step 9: There is no step 9.** The project is done. Do not push again, do not open a
      pull request, and do not start new work.

---

## Appendix: what Plan 5 adds to the repository

| Path | Purpose |
|---|---|
| `packages/server/src/exports/` | csv, xlsx, ics, docx, zip, json, eligibility, html, printCss, filter, draft, packet, token, dataSource |
| `packages/server/src/api/exports.ts` | export routes (gated by `assertExportReady`), the subscribable calendar feed, and the `ExportDeps` interface the inline `exportDeps` value in `index.ts` satisfies |
| `packages/server/src/api/spa.ts` | `createSpaMiddleware(webDistDir)` — serves the built SPA and its history fallback (`webDistRoot()` stays Plan 3's, in `api/webDist.ts`) |
| `packages/server/src/index.ts` (modified) | the first-run seed import (Task 16) and this plan's three lines in the shared `mountRoutes` callback: two export mounts (Task 9 Step 9) and `createSpaMiddleware(webDistRoot())` **last** (Task 17 Step 5) |
| `packages/server/src/db/migrations/090-ics-tokens.sql` | per-user hashed calendar tokens (`ics_tokens`, plan-local) |
| `packages/server/src/seed/` | corpus loader with `sourceKey` collection, validation harness, first-run importer |
| `packages/server/src/deploy/*.test.ts` | text-level gates on the Dockerfile, workflow, compose, env and README |
| `packages/web/src/api/exports.ts`, `routes/Exports.tsx`, `components/ExportMenu.tsx` | the UI that reaches every export endpoint |
| `packages/web/src/styles/print.css`, `components/PrintButton.tsx` | the PDF path, wired into the opportunity brief |
| `e2e/flow.spec.ts` (modified) | the spec §14 nine-step journey, including the ICS export |
| `data/seed/*.json` | 26 funders and roughly 143 programs, all verified 2026-08-02, each bound to its crawler identity via `sourceKey` |
| `scripts/generate-arrl-seed.ts` | regenerates the 111 catalog records from the committed fixture |
| `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example` | deployment |
| `.github/workflows/build.yml` | verify, then multi-arch publish to GHCR |
| `README.md`, `LICENSE` | the honest description and MIT |
