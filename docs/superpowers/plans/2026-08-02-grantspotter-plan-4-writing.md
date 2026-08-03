# GrantSpotter Plan 4: Application Writing Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the writing desk — 13 funder-agnostic component templates, 9 funder overlays written against each funder's actually-published criteria, deterministic slot filling that never fabricates, an AI prompt composer grounded in the Kobak et al. excess-vocabulary finding, a pure offline generic-prose analyzer, a fact checklist that gates export, and the Applications UI that ties them together.

**Architecture:** Templates and prompt fragments are versioned markdown **data** under `content/`, never code. `packages/server/src/templates/` loads and fills them; `packages/server/src/prompts/` composes the AI prompt from a `Program` plus fragments; `packages/server/src/prose/` is a pure, zero-I/O, zero-API-key analyzer that reports *why* a passage reads generic and *where*. Four thin Express routers expose all of it, and the React SPA adds a Templates picker and an Applications draft editor with a prose panel, a fact checklist, and one copy-prompt button.

**Tech Stack:** TypeScript strict (`module: NodeNext`, `target: ES2022`), Node v20.11.0, Express, better-sqlite3, zod, React 18 + Vite, Vitest, Playwright, `@testing-library/react` + jsdom for component tests.

**Prerequisite:** Plans 1, 2 and 3 complete. This plan consumes the frozen `@grantspotter/core` types, Plan 1's `AppError`/`errorHandler` from `packages/server/src/api/errors.ts`, Plan 1's `db/migrations` runner, Plan 3's `RouterDeps` from `packages/server/src/api/deps.ts`, and Plan 3's `App.tsx` router, `AppShell.tsx` nav and `Opportunity.tsx` detail screen. It touches no other Plan 1–3 code.

## Global Constraints

- Node **v20.11.0**, npm **10.2.4**. Every command in this plan begins with `export PATH="/home/kasm-user/.local/node/bin:$PATH"`.
- Repo root is `/home/kasm-user/grantspotter`. All paths in this plan are repo-relative unless shown absolute.
- TypeScript **strict**. `"module": "NodeNext"` means every relative import in server code carries an explicit `.js` extension even though the source is `.ts`.
- `packages/core` stays **pure** and is **not modified by this plan**. Import direction is one-way: `server → core`, `web → core`. `packages/web` never imports server code — DTO shapes are re-declared web-side and that duplication is deliberate.
- `packages/server/src/prose/` is **PURE: zero I/O, zero network, no API key, no `node:` imports.** It is unit-tested against passages written into this plan.
- The AI prompt button copy is exactly `Copy AI Prompt — includes AI-detection avoidance` (em dash U+2014). An e2e test asserts the exact string.
- Unknown template slots render as an explicit `[TODO: …]` marker and **never** as plausible filler. An empty string, a whitespace-only string, `null`, `undefined`, an empty array, and any object all count as unknown.
- The composed prompt forbids the model from generating any citation, statistic, or URL the user did not supply. This is the single highest-consequence rule in the product.
- Classifier-gaming tricks — synonym swapping, injected typos, invisible/homoglyph characters — are **deliberately excluded**, and `content/prompts/why-these-rules.md` says so in the shipped text.
- `SESSION_SECRET` and `CONTACT_URL` have **no defaults**; the server refuses to start without them. This plan adds **no new environment variables**. `content/` is located at runtime by walking up from the module URL until `content/templates/components` exists.
- **Every router in this plan is a factory taking Plan 3's `RouterDeps`** (`{ db, now, requireAuth, requireAdmin, currentUser }`, `packages/server/src/api/deps.ts`): `createApplicationsRouter(deps)`, `createTemplatesRouter(deps)`, `createProseRouter(deps)`, `createPromptsRouter(deps)`. No router in this plan imports Plan 1's auth module directly, none reads `req.user`, and there is no `packages/server/src/api/authedRequest.ts` — the user comes from `deps.currentUser(req).id` and authentication from `deps.requireAuth` applied per route.
- **This plan never mounts outside the one hook.** RESOLUTIONS R5: `createApp` seals the app with `notFoundHandler()`, so `app.use(...)` after `createApp` returns is dead code. There is exactly one composition site in the repository — the `mountRoutes` callback passed to `createApp` from `packages/server/src/index.ts`, created by **Plan 3 Task 14**. RESOLUTIONS **R25**: that callback is filled **incrementally**, one plan at a time, so that no plan forward-references a module another plan has not written yet. Plan 3 puts its own routers in it and leaves a comment reserving the final position for Plan 5's SPA middleware; **this plan's Task 17 Step 5 adds exactly four lines inside that existing callback**, above the reserved comment; Plan 5 adds its export routers and, always last, `a.use(createSpaMiddleware(webDistRoot()));`. Beyond those four lines, no task in this plan modifies `packages/server/src/index.ts`, and no task modifies `packages/server/src/app.ts`, `packages/server/src/api/mount.ts` or any file named `packages/server/src/api/index.ts`. No task calls `app.use('/api/applications' | '/api/templates' | '/api/prose' | '/api/prompts', …)` anywhere except inside that callback and inside a test's own throwaway express app.
- **This plan does not serve the SPA, and must not start.** `packages/server/src/api/spa.ts` is **Plan 5's file** — created by Plan 5's SPA task (RESOLUTIONS R16), mounted by **Plan 5 Task 17** as the last statement of the same `mountRoutes` callback (R25), importing `webDistRoot()` from Plan 3's `packages/server/src/api/webDist.ts` (R27). **No task in this plan creates, imports or stubs `api/spa.ts`, and no task adds `express.static`, `sendFile`, or a history fallback anywhere.** Until Plan 5 lands, `GET /` and every other non-`/api` path return Plan 1's JSON 404 envelope, so the whole Playwright suite — Plan 3's four specs and this plan's six — cannot go green here. That is expected and it is why Task 20 runs `npm run test:e2e` as a **harness proof** rather than as a must-pass gate. Creating `api/spa.ts` early to turn the suite green is exactly the two-plans-create-one-file defect that R19 and R24 exist to eliminate: Plan 5 would then be writing a file that already exists, and whichever version loses does so silently.
- **One error envelope, Plan 1's.** RESOLUTIONS R6: every failure is `next(new AppError(code, message, details?))` with `AppError` imported from `packages/server/src/api/errors.js`; Plan 1's `errorHandler` renders `{ error: { code, message, details? }, requestId }`. Codes are exactly `bad_request | validation_failed | unauthorized | forbidden | not_found | conflict | rate_limited | payload_too_large | internal`, and a **zod parse failure is 422 `validation_failed`, never 400**. No route in this plan calls `res.status(4xx).json({ error: '…' })`.
- No real LAN IPs, hostnames, or host paths in code, fixtures, templates, or seed data. RFC 5737 ranges (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) and placeholders only. Every callsign used in example prose (W8UM, K5UTD, KD9XYZ, W9ABC, KE8QRS, WA5BU) is either a real published collegiate club callsign cited in the research or an obviously-illustrative example — no private individual's details appear.
- **Commits stay local. No task in this plan runs `git push`.** Pushing happens once, at the end of Plan 5, after the completeness audit and the debug audit.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`.
- Tests live beside their source as `*.test.ts` / `*.test.tsx` and are run with `npx vitest run <path>`.

### Domain facts an engineer new to this project needs

- **Amateur radio callsign**: a government-issued station identifier such as `W8UM` (University of Michigan) or `K5UTD` (UT Dallas). Format is roughly one or two letters, a digit, then one to three letters. Callsigns are the single most useful proper noun in this domain — they are unique, checkable, and free.
- **ARRL** is the US national amateur radio association; **the ARRL Foundation** is its grantmaking arm. **ARDC** (Amateur Radio Digital Communications) is a large private foundation that funds ARRL's club grants, scholarships and Teachers Institute — so the two biggest funders in this space are one funder with a splint.
- **An ARRL Section** is a geographic subdivision of an ARRL Division; both are used as eligibility geography and neither maps cleanly to states. Plan 1 ships the lookup table; this plan never resolves geography itself.
- **`arrl.org` has no ETag and no Last-Modified**, serves `Cache-Control: nocache`, and every `<lastmod>` in its sitemap is frozen at 2010. That is why the ARRL Club Grant overlay in this plan tells the user the cycle is disputed rather than printing a date.
- **`farweb.org` is hard-blocklisted** in Plan 2's fetcher: the Foundation for Amateur Radio's domain was taken over between 2025-10-17 and 2026-02-10 and now 301s to an Indonesian gambling site, while QCWA and ARRL pages still tell applicants to "apply at the FAR website". No template, overlay, prompt fragment, or seed link in this plan may contain that domain.
- **Grant reviewers read dozens of applications.** Every rule in the style ruleset exists because a specific, cited funder said something about it, or because Kobak et al. measured it.

### Contract symbols this plan implements (frozen — do not rename)

```ts
// prose/index.ts
export interface ParagraphReport {
  index: number; text: string;
  styleWordHits: string[]; properNounCount: number; figureCount: number;
  tricolonCount: number; trailingParticipialCount: number;
  stockTransitionHits: string[]; verdict: 'specific' | 'thin' | 'generic';
}
export interface ProseReport {
  paragraphs: ParagraphReport[];
  sentenceLengthVariance: number;
  documentTricolonCount: number;
  stockOpenerHits: string[]; stockCloserHits: string[];
  paragraphsWithNoProperNounOrFigure: number[];
}
export function analyzeProse(text: string): ProseReport;

// prompts/compose.ts
export interface PromptContext { program: Program; profile?: Profile; templateId?: string; includeDisclosure: boolean }
export function composePrompt(ctx: PromptContext): string;

// templates/fill.ts
export interface FilledTemplate { markdown: string; unresolvedSlots: string[] }
export function fillTemplate(templateMarkdown: string, ctx: Record<string, unknown>): FilledTemplate;
```

Everything else this plan introduces is **plan-local**: it lives inside `packages/server/src/templates/`, `packages/server/src/prompts/`, `packages/server/src/prose/`, `packages/server/src/api/`, `packages/web/src/`, `content/`, or `data/reference/`, and is named here for the first time.

### Canonical program ids used by the funder overlays

Plan 5 seeds the corpus. The overlays in this plan bind to programs by these ids, which Plan 5 must adopt verbatim:

`ardc-grants` · `arrl-amateur-radio-grants` · `arrl-club-grant` · `arrl-foundation-scholarships` · `ariss-iss-contact` · `ieee-mtts-chapter-support` · `yaesu-dr2x-repeater` · `nasa-space-grant`

**These ids are authoritative (RESOLUTIONS R9).** Five of them differed from Plan 5's first draft of the seed corpus, and the resolution renames the *seed*, never these overlays: `arrl-foundation-scholarship-program` → `arrl-foundation-scholarships`, `ariss-usa-iss-contact` → `ariss-iss-contact`, `ieee-mtt-s-chapter-support` → `ieee-mtts-chapter-support`, `yaesu-dr-2x-program` → `yaesu-dr2x-repeater`, `nasa-space-grant-consortia` → `nasa-space-grant`. Plan 5's seed and Plan 2's `DEADLINE_INHERITANCE` adopt this list verbatim. **Do not change an id in this plan to accommodate a seed record.**

Why a mismatch is dangerous rather than merely wrong: `selectTemplates` (Task 1) filters overlays with

```ts
(q.programId !== undefined && t.programIds.includes(q.programId)) ||
(q.funderId !== undefined && t.funderId === q.funderId)
```

so an id that differs by one character produces **no error, no warning and zero overlays** — `GET /api/templates?programId=…` simply returns an empty `overlays` array and the writing desk silently loses the funder-specific guidance that is the entire point of the screen. Task 20's verification step greps the shipped overlay frontmatter against this list for exactly that reason.

The Campus SGA playbook binds to no program id: it is always available (`alwaysAvailable: true`) because a student government exists on every campus and none of them are in the corpus.

### Four boundary reconciliations with Plans 1, 3 and 5

1. **`applications` and `template_instances` tables — Plan 1 owns these two tables (RESOLUTIONS R24).** CONTRACT §6 lists both, and Plan 1 Task 12's `packages/server/src/db/migrations/001-init.sql` is their **sole** owner. It adopts this plan's column list verbatim — `applications(id, user_id, program_id TEXT NULL, title, body_markdown, answers_json, fact_confirmations_json, include_disclosure, facts_confirmed_at, created_at, updated_at)` and `template_instances(id, application_id REFERENCES applications(id) ON DELETE CASCADE, template_id, position, filled_markdown, unresolved_slots_json, created_at)` — together with the indexes `idx_applications_user` and `idx_template_instances_application`, each declared exactly once, there. **This plan ships no migration for them and never edits Plan 1's migration.** Earlier drafts of this plan shipped `040-application-writing.sql` with a second `CREATE TABLE IF NOT EXISTS` for each; migrations run in filename order, so 040 was a silent no-op against Plan 1's shape and every insert died on `table applications has no column named answers_json`. The mitigation those drafts printed — "delete the two `CREATE TABLE` statements from Plan 1's migration" — was worse than the bug, because Plan 1's `CREATE INDEX idx_applications_user ON applications(user_id)` would then point at a table that no longer exists and migration 001 fails with `no such table: applications`, so nothing boots at all. Task 16 ships `assertApplicationSchema(db)` instead: an **assert-never-create** guard, modelled on Plan 2's `ensureIngestionSchema`, that checks both tables' columns with `PRAGMA table_info` and throws an error naming `001-init.sql` as the owner.
2. **Authentication comes from Plan 3's `RouterDeps`, not from Plan 1's module names.** This plan's routers never import `packages/server/src/auth/middleware.js` and never touch `req.user`. They take `deps: RouterDeps` (`packages/server/src/api/deps.ts`, Plan 3 Task 4), guard mutating routes with `deps.requireAuth`, and read the caller with `deps.currentUser(req).id`. Tests construct fakes for both. If Plan 1 renames its middleware, the only file that changes is Plan 3's `packages/server/src/index.ts`, where `RouterDeps` is built once.
3. **There is one mount hook and it is filled incrementally (R5 + R25).** This plan exports `createApplicationsRouter`, `createTemplatesRouter`, `createProseRouter` and `createPromptsRouter`. Plan 3 Task 14 creates the `mountRoutes` callback in `packages/server/src/index.ts` containing Plan 3's own routers and a comment reserving the last position; **Task 17 Step 5 of this plan adds the four `a.use('/api/…', create*Router(routerDeps));` lines inside that callback**, above the reserved comment. Plan 5 appends its export routers and then the SPA middleware, which is always the final statement. See the Global Constraints above — the app is sealed by `notFoundHandler()`, so an `app.use` *after* `createApp` returns is silently unreachable.
4. **`assertExportReady` is this plan's gate and Plan 5's obligation.** `assertExportReady(db, applicationId, userId)` ships in `packages/server/src/db/repositories/applications.ts` (Task 16). Spec §10.4 requires it at the top of **every** export path that emits a draft — DOCX, Markdown, ZIP, PDF. It throws `AppError('conflict', …)`, which Plan 1's `errorHandler` renders as HTTP **409**. See "What Plan 5 inherits from this plan" at the end of this file for the full contract.

---

### Task 1: Frontmatter parser and template loader

Templates are markdown files with a YAML-ish frontmatter block. Rather than take a dependency on `gray-matter`, this task ships a deliberately small parser that accepts exactly the shapes our templates use and **throws on anything else** — a malformed template must fail at load, not render as a blank section in a grant application.

A load-time decision that removes a whole class of maintenance error: **frontmatter never lists slots.** The loader derives `TemplateDoc.slots` by scanning the body for `{{ … }}`, so there is exactly one source of truth for which slots a template uses.

**Files:**
- Create: `packages/server/src/templates/frontmatter.ts`
- Create: `packages/server/src/templates/frontmatter.test.ts`
- Create: `packages/server/src/templates/load.ts`
- Create: `packages/server/src/templates/load.test.ts`
- Create: `content/templates/components/.gitkeep`
- Create: `content/templates/funders/.gitkeep`

**Interfaces:**
- Consumes: `OpportunityClass` from `@grantspotter/core`.
- Produces: `parseFrontmatter(raw: string): ParsedFrontmatter`, `FrontmatterError`, `TemplateDoc`, `TemplateSource`, `contentRoot(): string`, `templatesRoot(): string`, `loadTemplateFile(absPath: string): TemplateDoc`, `loadTemplates(root?: string): TemplateDoc[]`, `getTemplate(id: string, root?: string): TemplateDoc`, `selectTemplates(all: TemplateDoc[], q: TemplateQuery): TemplateSelection`.

- [ ] **Step 1: Write the failing test for the frontmatter parser**

Create `packages/server/src/templates/frontmatter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FrontmatterError, parseFrontmatter } from './frontmatter.js';

const DOC = `---
id: funder-ardc
title: ARDC Grants Program
layer: funder
order: 10
alwaysAvailable: false
appliesTo: [ham_grant, adjacent_stem]
lengthTarget: 900-1400 words
programIds: [ardc-grants]
sources:
  - label: ARDC grant application instructions
    url: https://www.ardc.net/apply/grant-application-instructions/
  - label: ARDC apply page
    url: https://www.ardc.net/apply/
---

# Body starts here

Indirect costs are capped at 20 percent.
`;

describe('parseFrontmatter', () => {
  it('parses scalars, numbers, booleans, flow arrays and arrays of maps', () => {
    const { data } = parseFrontmatter(DOC);
    expect(data.id).toBe('funder-ardc');
    expect(data.title).toBe('ARDC Grants Program');
    expect(data.order).toBe(10);
    expect(data.alwaysAvailable).toBe(false);
    expect(data.appliesTo).toEqual(['ham_grant', 'adjacent_stem']);
    expect(data.lengthTarget).toBe('900-1400 words');
    expect(data.programIds).toEqual(['ardc-grants']);
    expect(data.sources).toEqual([
      { label: 'ARDC grant application instructions', url: 'https://www.ardc.net/apply/grant-application-instructions/' },
      { label: 'ARDC apply page', url: 'https://www.ardc.net/apply/' },
    ]);
  });

  it('keeps the body verbatim and strips exactly one leading newline', () => {
    const { body } = parseFrontmatter(DOC);
    expect(body.startsWith('\n# Body starts here')).toBe(true);
    expect(body).toContain('Indirect costs are capped at 20 percent.');
  });

  it('does not split a value on a colon inside a URL', () => {
    const { data } = parseFrontmatter('---\nurl: https://example.org/a:b\n---\nbody\n');
    expect(data.url).toBe('https://example.org/a:b');
  });

  it('throws when the document does not open with a frontmatter block', () => {
    expect(() => parseFrontmatter('# no frontmatter\n')).toThrow(FrontmatterError);
  });

  it('throws when the frontmatter block is unterminated', () => {
    expect(() => parseFrontmatter('---\nid: x\n')).toThrow(/unterminated/);
  });

  it('throws when a list mixes scalars and maps', () => {
    const bad = '---\nsources:\n  - plain\n  - label: x\n---\nbody\n';
    expect(() => parseFrontmatter(bad)).toThrow(/mixes scalars and maps/);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/frontmatter.test.ts
```

Expected failure: `Error: Failed to resolve import "./frontmatter.js" from "packages/server/src/templates/frontmatter.test.ts". Does the file exist?`

- [ ] **Step 3: Write the frontmatter parser**

Create `packages/server/src/templates/frontmatter.ts`:

```ts
/**
 * A deliberately small frontmatter parser.
 *
 * It accepts exactly the four shapes our templates use:
 *   key: scalar                      (string, number, boolean, quoted string)
 *   key: [a, b, c]                   (flow array of scalars)
 *   key:\n  - a\n  - b               (block array of scalars)
 *   key:\n  - label: x\n    url: y   (block array of single-level maps)
 *
 * Anything else throws. A malformed template must fail at load time, not render
 * as a blank section in somebody's grant application.
 *
 * Known restriction: a scalar list item may not contain a colon followed by a
 * space, because that is how a map item is recognised. No template needs one.
 */

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

export type FrontmatterValue =
  | string
  | number
  | boolean
  | string[]
  | Array<Record<string, string>>;

export interface ParsedFrontmatter {
  data: Record<string, FrontmatterValue>;
  body: string;
}

const DELIM = '---';
const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;

function parseScalar(raw: string): string | number | boolean {
  const t = raw.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t;
}

export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith(DELIM + '\n')) {
    throw new FrontmatterError('template must begin with a "---" frontmatter block');
  }
  const end = text.indexOf('\n' + DELIM, DELIM.length);
  if (end === -1) throw new FrontmatterError('unterminated frontmatter block');

  const head = text.slice(DELIM.length + 1, end);
  const rest = text.slice(end + 1 + DELIM.length);
  const body = rest.startsWith('\n') ? rest.slice(1) : rest;

  const data: Record<string, FrontmatterValue> = {};
  const lines = head.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) {
      throw new FrontmatterError(`unexpected indentation at frontmatter line ${i + 1}`);
    }
    const colon = line.indexOf(':');
    if (colon === -1) throw new FrontmatterError(`missing ":" at frontmatter line ${i + 1}`);

    const key = line.slice(0, colon).trim();
    if (!KEY_RE.test(key)) throw new FrontmatterError(`invalid frontmatter key "${key}"`);

    const inline = line.slice(colon + 1).trim();

    if (inline.startsWith('[') && inline.endsWith(']')) {
      const inner = inline.slice(1, -1).trim();
      data[key] = inner === '' ? [] : inner.split(',').map((s) => String(parseScalar(s)));
      i++;
      continue;
    }
    if (inline !== '') {
      data[key] = parseScalar(inline);
      i++;
      continue;
    }

    i++;
    const items: string[] = [];
    const maps: Array<Record<string, string>> = [];
    while (i < lines.length && /^\s+\S/.test(lines[i] ?? '')) {
      const item = lines[i] ?? '';
      const dash = /^\s+-\s+(.*)$/.exec(item);
      if (dash) {
        const value = dash[1] ?? '';
        const inner = /^([A-Za-z][A-Za-z0-9_.-]*):\s+(.*)$/.exec(value);
        if (inner) maps.push({ [inner[1] as string]: String(parseScalar(inner[2] as string)) });
        else items.push(String(parseScalar(value)));
      } else {
        const cont = /^\s+([A-Za-z][A-Za-z0-9_.-]*):\s+(.*)$/.exec(item);
        if (!cont || maps.length === 0) {
          throw new FrontmatterError(`unparsable list item at frontmatter line ${i + 1}`);
        }
        (maps[maps.length - 1] as Record<string, string>)[cont[1] as string] = String(parseScalar(cont[2] as string));
      }
      i++;
    }
    if (maps.length > 0 && items.length > 0) {
      throw new FrontmatterError(`list "${key}" mixes scalars and maps`);
    }
    data[key] = maps.length > 0 ? maps : items;
  }

  return { data, body };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/frontmatter.test.ts
```

All six assertions pass.

- [ ] **Step 5: Write the failing test for the loader**

Create `packages/server/src/templates/load.test.ts`:

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTemplate, loadTemplateFile, loadTemplates, selectTemplates } from './load.js';

let root: string;

const COMPONENT = `---
id: need-statement
title: Need statement
layer: component
order: 10
appliesTo: [ham_grant, adjacent_stem]
lengthTarget: 200-300 words
---

{{club.name}} ({{club.callsign}}) needs {{project.equipment}}.
Again: {{club.name}}.
`;

const OVERLAY = `---
id: funder-ardc
title: ARDC overlay
layer: funder
order: 10
appliesTo: [ham_grant]
funderId: ardc
programIds: [ardc-grants]
requires: [need-statement]
sources:
  - label: ARDC apply page
    url: https://www.ardc.net/apply/
---

Indirect costs are capped at 20 percent.
`;

const PLAYBOOK = `---
id: funder-campus-sga
title: Campus SGA playbook
layer: funder
order: 90
appliesTo: []
alwaysAvailable: true
programIds: []
sources:
  - label: FSU SGA RSO funding rules
    url: https://sga.fsu.edu/accounting/funding-your-rso
---

Capital equipment is frequently barred.
`;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-templates-'));
  fs.mkdirSync(path.join(root, 'components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'funders'), { recursive: true });
  fs.writeFileSync(path.join(root, 'components', 'need-statement.md'), COMPONENT);
  fs.writeFileSync(path.join(root, 'funders', 'funder-ardc.md'), OVERLAY);
  fs.writeFileSync(path.join(root, 'funders', 'funder-campus-sga.md'), PLAYBOOK);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('loadTemplateFile', () => {
  it('derives slots from the body, deduped and in first-appearance order', () => {
    const doc = loadTemplateFile(path.join(root, 'components', 'need-statement.md'));
    expect(doc.slots).toEqual(['club.name', 'club.callsign', 'project.equipment']);
  });

  it('carries layer, order, appliesTo, lengthTarget and the raw body', () => {
    const doc = loadTemplateFile(path.join(root, 'components', 'need-statement.md'));
    expect(doc.layer).toBe('component');
    expect(doc.order).toBe(10);
    expect(doc.appliesTo).toEqual(['ham_grant', 'adjacent_stem']);
    expect(doc.lengthTarget).toBe('200-300 words');
    expect(doc.body).toContain('{{club.name}}');
    expect(doc.sources).toEqual([]);
  });

  it('carries funder overlay fields', () => {
    const doc = loadTemplateFile(path.join(root, 'funders', 'funder-ardc.md'));
    expect(doc.funderId).toBe('ardc');
    expect(doc.programIds).toEqual(['ardc-grants']);
    expect(doc.requires).toEqual(['need-statement']);
    expect(doc.sources[0]?.url).toBe('https://www.ardc.net/apply/');
    expect(doc.alwaysAvailable).toBe(false);
  });

  it('rejects a file whose id does not match its filename', () => {
    const bad = path.join(root, 'components', 'mismatched.md');
    fs.writeFileSync(bad, COMPONENT);
    expect(() => loadTemplateFile(bad)).toThrow(/id "need-statement" does not match filename "mismatched"/);
    fs.rmSync(bad);
  });
});

describe('loadTemplates and selectTemplates', () => {
  it('loads every file under components/ and funders/', () => {
    const all = loadTemplates(root);
    expect(all.map((t) => t.id).sort()).toEqual(['funder-ardc', 'funder-campus-sga', 'need-statement']);
  });

  it('getTemplate throws a named error for an unknown id', () => {
    expect(() => getTemplate('does-not-exist', root)).toThrow(/unknown template "does-not-exist"/);
  });

  it('selects the overlay for a program, the components for its class, and always-available playbooks', () => {
    const sel = selectTemplates(loadTemplates(root), { klass: 'ham_grant', programId: 'ardc-grants' });
    expect(sel.overlays.map((t) => t.id)).toEqual(['funder-ardc']);
    expect(sel.components.map((t) => t.id)).toEqual(['need-statement']);
    expect(sel.playbooks.map((t) => t.id)).toEqual(['funder-campus-sga']);
  });

  it('returns no overlay for an unrelated program but still returns playbooks', () => {
    const sel = selectTemplates(loadTemplates(root), { klass: 'ham_scholarship', programId: 'yaesu-dr2x-repeater' });
    expect(sel.overlays).toEqual([]);
    expect(sel.components).toEqual([]);
    expect(sel.playbooks.map((t) => t.id)).toEqual(['funder-campus-sga']);
  });
});
```

- [ ] **Step 6: Run the loader test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/load.test.ts
```

Expected failure: `Error: Failed to resolve import "./load.js"`.

- [ ] **Step 7: Write the loader**

Create `packages/server/src/templates/load.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpportunityClass } from '@grantspotter/core';
import { parseFrontmatter, type FrontmatterValue } from './frontmatter.js';

export interface TemplateSource {
  label: string;
  url: string;
}

export interface TemplateDoc {
  id: string;
  title: string;
  layer: 'component' | 'funder';
  order: number;
  appliesTo: OpportunityClass[];
  lengthTarget?: string;
  funderId?: string;
  programIds: string[];
  requires: string[];
  alwaysAvailable: boolean;
  sources: TemplateSource[];
  /** Derived from the body. Frontmatter never lists slots — one source of truth. */
  slots: string[];
  body: string;
  path: string;
}

export interface TemplateQuery {
  klass?: OpportunityClass;
  programId?: string;
  funderId?: string;
}

export interface TemplateSelection {
  overlays: TemplateDoc[];
  components: TemplateDoc[];
  playbooks: TemplateDoc[];
}

const SLOT_SCAN = () => /\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\}\}/g;

/** Walks up from this module until it finds the repo's `content/` directory. */
export function contentRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, 'content');
    if (fs.existsSync(path.join(candidate, 'templates', 'components'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'content/ not found: expected a directory containing templates/components above ' +
      path.dirname(fileURLToPath(import.meta.url)),
  );
}

export function templatesRoot(): string {
  return path.join(contentRoot(), 'templates');
}

function str(v: FrontmatterValue | undefined, key: string, file: string): string {
  if (typeof v !== 'string') throw new Error(`${file}: frontmatter "${key}" must be a string`);
  return v;
}

function strArray(v: FrontmatterValue | undefined): string[] {
  if (v === undefined) return [];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return [];
}

function sourceArray(v: FrontmatterValue | undefined, file: string): TemplateSource[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${file}: frontmatter "sources" must be a list`);
  return v.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`${file}: every "sources" entry needs a label and a url`);
    }
    const rec = entry as Record<string, string>;
    if (!rec.label || !rec.url) throw new Error(`${file}: every "sources" entry needs a label and a url`);
    return { label: rec.label, url: rec.url };
  });
}

export function deriveSlots(body: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of body.matchAll(SLOT_SCAN())) {
    const p = m[1] as string;
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export function loadTemplateFile(absPath: string): TemplateDoc {
  const raw = fs.readFileSync(absPath, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const file = path.basename(absPath);
  const id = str(data.id, 'id', file);
  const base = file.replace(/\.md$/, '');
  if (id !== base) {
    throw new Error(`${file}: frontmatter id "${id}" does not match filename "${base}"`);
  }
  const layer = str(data.layer, 'layer', file);
  if (layer !== 'component' && layer !== 'funder') {
    throw new Error(`${file}: frontmatter "layer" must be "component" or "funder"`);
  }
  if (typeof data.order !== 'number') throw new Error(`${file}: frontmatter "order" must be a number`);

  return {
    id,
    title: str(data.title, 'title', file),
    layer,
    order: data.order,
    appliesTo: strArray(data.appliesTo) as OpportunityClass[],
    lengthTarget: typeof data.lengthTarget === 'string' ? data.lengthTarget : undefined,
    funderId: typeof data.funderId === 'string' ? data.funderId : undefined,
    programIds: strArray(data.programIds),
    requires: strArray(data.requires),
    alwaysAvailable: data.alwaysAvailable === true,
    sources: sourceArray(data.sources, file),
    slots: deriveSlots(body),
    body,
    path: absPath,
  };
}

export function loadTemplates(root: string = templatesRoot()): TemplateDoc[] {
  const docs: TemplateDoc[] = [];
  for (const sub of ['components', 'funders']) {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!entry.endsWith('.md')) continue;
      docs.push(loadTemplateFile(path.join(dir, entry)));
    }
  }
  const seen = new Set<string>();
  for (const d of docs) {
    if (seen.has(d.id)) throw new Error(`duplicate template id "${d.id}"`);
    seen.add(d.id);
  }
  return docs;
}

export function getTemplate(id: string, root?: string): TemplateDoc {
  const found = loadTemplates(root).find((t) => t.id === id);
  if (!found) throw new Error(`unknown template "${id}"`);
  return found;
}

export function selectTemplates(all: TemplateDoc[], q: TemplateQuery): TemplateSelection {
  const byOrder = (a: TemplateDoc, b: TemplateDoc) => a.order - b.order || a.id.localeCompare(b.id);

  const overlays = all
    .filter((t) => t.layer === 'funder' && !t.alwaysAvailable)
    .filter(
      (t) =>
        (q.programId !== undefined && t.programIds.includes(q.programId)) ||
        (q.funderId !== undefined && t.funderId === q.funderId),
    )
    .sort(byOrder);

  const playbooks = all.filter((t) => t.layer === 'funder' && t.alwaysAvailable).sort(byOrder);

  const components = all
    .filter((t) => t.layer === 'component')
    .filter((t) => q.klass === undefined || t.appliesTo.length === 0 || t.appliesTo.includes(q.klass))
    .sort(byOrder);

  return { overlays, components, playbooks };
}
```

- [ ] **Step 8: Create the content directories and run both tests**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  mkdir -p content/templates/components content/templates/funders content/prompts && \
  touch content/templates/components/.gitkeep content/templates/funders/.gitkeep && \
  npx vitest run packages/server/src/templates/frontmatter.test.ts packages/server/src/templates/load.test.ts
```

Both files pass.

- [ ] **Step 9: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add packages/server/src/templates content/templates && \
  git commit -m "feat(templates): frontmatter parser and template loader with derived slots"
```

---

### Task 2: Slot vocabulary and profile-to-context builder

Every slot a template may use is declared once, with a human hint. The hint is what appears inside the `[TODO: …]` marker, so a writer who sees `[TODO: club.callsign — your club's FCC callsign, e.g. W8UM]` knows exactly what to supply. Slots whose `source` is `profile` or `program` are filled automatically; slots whose `source` is `user` become the fields of the Applications slot form.

**Files:**
- Create: `packages/server/src/templates/slots.ts`
- Create: `packages/server/src/templates/slots.test.ts`

**Interfaces:**
- Consumes: `Funder`, `OrgProfile`, `Profile`, `Program`, `StudentProfile` from `@grantspotter/core`.
- Produces: `SlotDef`, `SLOT_VOCABULARY`, `slotDef(path)`, `isKnownSlot(path)`, `userAnswerSlots()`, `SlotContextInput`, `buildSlotContext(input)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/templates/slots.test.ts`:

```ts
import type { Funder, OrgProfile, Program, StudentProfile } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { SLOT_VOCABULARY, buildSlotContext, isKnownSlot, slotDef, userAnswerSlots } from './slots.js';

const ORG: OrgProfile = {
  kind: 'organization',
  entity: 'club_unincorporated',
  orgName: 'Example Collegiate Amateur Radio Club',
  callsign: 'W8UM',
  state: 'MI',
  memberCount: 34,
  institutionName: 'Example State University',
  arrlAffiliated: true,
};

const STUDENT: StudentProfile = {
  kind: 'student',
  callsign: 'KD9XYZ',
  licenseClass: 'GENERAL',
  licensedSince: '2023-04-11',
  institution: 'Example State University',
  degreeLevel: 'BACH',
  fieldOfStudy: 'Electrical Engineering',
  gpa: 3.4,
  state: 'MI',
};

const PROGRAM = {
  id: 'ardc-grants',
  funderId: 'ardc',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  summary: 'Grants for amateur radio and digital communication.',
  applicantEntities: ['club_via_fiscal_sponsor', 'university'],
  amount: { instrument: 'cash_range', amountRaw: '$1,285-$258,000', awardCountRaw: 'Multiple per year' },
  deadline: { kind: 'n_fixed_dates', source: { kind: 'self' }, note: 'Feb 1, Apr 1, Jul 1, Sep 1' },
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
    verificationMethod: 'live_fetch',
    contentHash: 'abc',
  },
  rawOtherText: '',
  tags: [],
} as unknown as Program;

const FUNDER: Funder = {
  id: 'ardc',
  name: 'Amateur Radio Digital Communications',
  homepage: 'https://www.ardc.net/',
};

describe('SLOT_VOCABULARY', () => {
  it('has unique dotted paths and a non-empty hint for every slot', () => {
    const paths = SLOT_VOCABULARY.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const s of SLOT_VOCABULARY) {
      expect(s.path).toMatch(/^[a-z]+\.[A-Za-z][A-Za-z0-9]*$/);
      expect(s.hint.length).toBeGreaterThan(5);
      expect(s.label.length).toBeGreaterThan(2);
    }
  });

  it('exposes lookup helpers', () => {
    expect(isKnownSlot('club.callsign')).toBe(true);
    expect(isKnownSlot('club.notAThing')).toBe(false);
    expect(slotDef('club.callsign')?.source).toBe('profile');
    expect(userAnswerSlots().every((s) => s.source === 'user')).toBe(true);
    expect(userAnswerSlots().length).toBeGreaterThan(20);
  });
});

describe('buildSlotContext', () => {
  it('maps an organization profile onto club.* slots', () => {
    const ctx = buildSlotContext({ profile: ORG });
    expect(ctx['club.name']).toBe('Example Collegiate Amateur Radio Club');
    expect(ctx['club.callsign']).toBe('W8UM');
    expect(ctx['club.memberCount']).toBe(34);
    expect(ctx['club.institution']).toBe('Example State University');
    expect(ctx['club.arrlAffiliated']).toBe('an ARRL-affiliated club');
    expect(ctx['club.ein']).toBeUndefined();
  });

  it('maps a student profile onto student.* slots', () => {
    const ctx = buildSlotContext({ profile: STUDENT });
    expect(ctx['student.callsign']).toBe('KD9XYZ');
    expect(ctx['student.licenseClass']).toBe('GENERAL');
    expect(ctx['student.gpa']).toBe(3.4);
    expect(ctx['club.name']).toBeUndefined();
  });

  it('maps program and funder facts onto funder.* slots', () => {
    const ctx = buildSlotContext({ program: PROGRAM, funder: FUNDER });
    expect(ctx['funder.programName']).toBe('ARDC Grants Program');
    expect(ctx['funder.name']).toBe('Amateur Radio Digital Communications');
    expect(ctx['funder.amountRaw']).toBe('$1,285-$258,000');
    expect(ctx['funder.deadlineNote']).toBe('Feb 1, Apr 1, Jul 1, Sep 1');
    expect(ctx['funder.applyUrl']).toBe('https://www.ardc.net/apply/');
  });

  it('lets answers override, ignores unknown answer keys, and ignores blank answers', () => {
    const ctx = buildSlotContext({
      profile: ORG,
      answers: { 'club.city': 'Ann Arbor', 'club.callsign': '', 'made.upKey': 'W1AW' },
    });
    expect(ctx['club.city']).toBe('Ann Arbor');
    expect(ctx['club.callsign']).toBe('W8UM');
    expect(ctx['made.upKey']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/slots.test.ts
```

Expected failure: `Error: Failed to resolve import "./slots.js"`.

- [ ] **Step 3: Write the slot vocabulary**

Create `packages/server/src/templates/slots.ts`:

```ts
import type { Funder, OrgProfile, Profile, Program, StudentProfile } from '@grantspotter/core';

export interface SlotDef {
  path: string;
  label: string;
  /** Appears inside the [TODO: …] marker, so it must tell the writer what to supply. */
  hint: string;
  source: 'profile' | 'program' | 'user';
}

export const SLOT_VOCABULARY: readonly SlotDef[] = [
  // ---- club / organization ----
  { path: 'club.name', label: 'Club or organization name', hint: 'the full legal or published name of the applying club', source: 'profile' },
  { path: 'club.callsign', label: 'Club callsign', hint: "your club's FCC callsign, e.g. W8UM", source: 'profile' },
  { path: 'club.city', label: 'City', hint: 'the city the club operates from, e.g. Ann Arbor', source: 'user' },
  { path: 'club.state', label: 'State', hint: 'two-letter state code, e.g. MI', source: 'profile' },
  { path: 'club.memberCount', label: 'Member count', hint: 'a headcount you can defend if asked, e.g. 34', source: 'profile' },
  { path: 'club.foundedYear', label: 'Year founded', hint: 'the year the club was founded, e.g. 1909', source: 'user' },
  { path: 'club.institution', label: 'Host institution', hint: 'the school or university that hosts the club', source: 'profile' },
  { path: 'club.arrlAffiliated', label: 'ARRL affiliation', hint: 'whether the club is an ARRL-affiliated club', source: 'profile' },
  { path: 'club.ein', label: 'EIN', hint: 'the nine-digit federal EIN, or leave blank if the club has none', source: 'profile' },
  { path: 'club.fiscalSponsor', label: 'Fiscal sponsor', hint: 'the 501(c)(3) that would receive the funds on your behalf', source: 'user' },

  // ---- individual applicant ----
  { path: 'student.name', label: 'Applicant name', hint: 'the name that appears on your application', source: 'user' },
  { path: 'student.callsign', label: 'Applicant callsign', hint: 'your own callsign, e.g. KD9XYZ', source: 'profile' },
  { path: 'student.licenseClass', label: 'License class', hint: 'NONE, TECH, GENERAL or EXTRA', source: 'profile' },
  { path: 'student.licensedSince', label: 'First licensed', hint: 'the date you were first licensed, e.g. 2023-04-11', source: 'profile' },
  { path: 'student.institution', label: 'School', hint: 'the accredited institution you attend or will attend', source: 'profile' },
  { path: 'student.degreeLevel', label: 'Degree level', hint: 'CERT, ASSOC, BACH or GRAD', source: 'profile' },
  { path: 'student.fieldOfStudy', label: 'Field of study', hint: 'your declared major or intended major', source: 'profile' },
  { path: 'student.gradYear', label: 'Expected graduation year', hint: 'the year you expect to graduate, e.g. 2029', source: 'user' },
  { path: 'student.gpa', label: 'GPA', hint: 'your current GPA on a 4.0 scale', source: 'profile' },
  { path: 'student.state', label: 'State of residence', hint: 'two-letter state code for where you live', source: 'profile' },

  // ---- named people ----
  { path: 'team.leadName', label: 'Project lead', hint: 'the person accountable for delivering the work', source: 'user' },
  { path: 'team.leadCallsign', label: 'Project lead callsign', hint: "the project lead's callsign, if they hold one", source: 'user' },
  { path: 'team.leadRole', label: 'Project lead role', hint: 'their role, e.g. club president or trustee', source: 'user' },
  { path: 'team.instructorName', label: 'Instructor or faculty advisor', hint: 'the person who teaches or supervises, with their role', source: 'user' },

  // ---- the project ----
  { path: 'project.title', label: 'Project title', hint: 'a plain title a reviewer can repeat back, under 12 words', source: 'user' },
  { path: 'project.problem', label: 'What breaks today', hint: 'the specific failure, naming the object and when it started', source: 'user' },
  { path: 'project.summary', label: 'One-paragraph summary', hint: 'what you will do, for whom, by when, in three sentences', source: 'user' },
  { path: 'project.requestAmount', label: 'Amount requested', hint: 'the dollar amount you are asking this funder for', source: 'user' },
  { path: 'project.budgetTotal', label: 'Total project cost', hint: 'the total cost including money from every source', source: 'user' },
  { path: 'project.startDate', label: 'Start date', hint: 'the date work begins, e.g. 2027-01-15', source: 'user' },
  { path: 'project.endDate', label: 'End date', hint: 'the date work finishes, e.g. 2027-06-30', source: 'user' },
  { path: 'project.beneficiaryCount', label: 'People served', hint: 'how many people this reaches, counted not estimated', source: 'user' },
  { path: 'project.deliverable', label: 'Primary deliverable', hint: 'the one thing that exists afterwards that does not exist now', source: 'user' },
  { path: 'project.equipment', label: 'Equipment', hint: 'model numbers and quantities, e.g. one Icom IC-7300', source: 'user' },
  { path: 'project.openLicense', label: 'Open license', hint: 'GPL-3.0, MIT, BSD-3-Clause, CERN-OHL-S-2.0 or CC-BY-4.0', source: 'user' },
  { path: 'project.indirectPct', label: 'Indirect cost percentage', hint: 'the indirect rate you are charging, as a number', source: 'user' },
  { path: 'project.coFunder', label: 'Co-funder', hint: 'the other organization putting money or goods in', source: 'user' },
  { path: 'project.coFunderAmount', label: 'Co-funder amount', hint: 'what the co-funder is contributing, in dollars', source: 'user' },
  { path: 'project.venue', label: 'Where the work happens', hint: 'the building and room, e.g. Room 214, Engineering Building', source: 'user' },
  { path: 'project.schedule', label: 'Schedule', hint: 'the recurring dates and times, e.g. Saturdays 10:00-12:00', source: 'user' },

  // ---- the funder, derived from the opportunity record ----
  { path: 'funder.name', label: 'Funder name', hint: 'the funding organization, from the opportunity record', source: 'program' },
  { path: 'funder.programName', label: 'Program name', hint: 'the specific program, from the opportunity record', source: 'program' },
  { path: 'funder.applyUrl', label: 'Application URL', hint: 'the published application link', source: 'program' },
  { path: 'funder.amountRaw', label: 'Published award amount', hint: 'the amount exactly as the funder published it', source: 'program' },
  { path: 'funder.deadlineNote', label: 'Published deadline note', hint: 'the deadline exactly as the funder published it', source: 'program' },

  // ---- IEEE chapter facts ----
  { path: 'chapter.memberCount', label: 'Chapter member count', hint: 'IEEE MTT-S requires at least 5 chapter members', source: 'user' },
  { path: 'chapter.meetingCount', label: 'Meetings reported', hint: 'meetings reported in vTools this year; at least 2 are required', source: 'user' },
  { path: 'chapter.officerRosterUrl', label: 'vTools officer roster', hint: 'the vTools URL showing your current officer roster', source: 'user' },

  // ---- NASA Space Grant ----
  { path: 'consortium.name', label: 'Space Grant consortium', hint: 'your state consortium, e.g. Michigan Space Grant Consortium', source: 'user' },
  { path: 'consortium.url', label: 'Consortium website', hint: "the consortium's own site, where its deadlines live", source: 'user' },

  // ---- Yaesu repeater ----
  { path: 'repeater.site', label: 'Repeater site', hint: 'the building or tower the repeater will live on', source: 'user' },
  { path: 'repeater.frequency', label: 'Repeater pair', hint: 'the coordinated output and input frequencies', source: 'user' },
  { path: 'repeater.coordinator', label: 'Frequency coordinator', hint: 'the coordinating body that issued the pair', source: 'user' },

  // ---- campus student government ----
  { path: 'sga.fundingBody', label: 'Funding body', hint: 'the exact committee or account, e.g. RSO Allocation', source: 'user' },
  { path: 'sga.eventDate', label: 'Event date', hint: 'the date of the event you are funding', source: 'user' },
  { path: 'sga.attendanceEstimate', label: 'Expected attendance', hint: 'how many students you expect, and how you got that number', source: 'user' },

  // ---- reporting ----
  { path: 'report.periodStart', label: 'Report period start', hint: 'the first date this report covers', source: 'user' },
  { path: 'report.periodEnd', label: 'Report period end', hint: 'the last date this report covers', source: 'user' },
  { path: 'report.grantId', label: 'Grant reference', hint: "the funder's grant or award number", source: 'user' },
  { path: 'report.spendToDate', label: 'Spent to date', hint: 'dollars spent so far against the awarded budget', source: 'user' },
  { path: 'report.outcomeSummary', label: 'Outcome summary', hint: 'what actually happened, with the counts you promised', source: 'user' },

  // ---- correspondence ----
  { path: 'recommender.name', label: 'Recommender name', hint: 'the person you are asking for a letter', source: 'user' },
  { path: 'recommender.role', label: 'Recommender role', hint: 'their title and how they know your work', source: 'user' },
  { path: 'recommender.deadline', label: 'Letter deadline', hint: 'the date their letter must reach the funder', source: 'user' },
  { path: 'donor.contactName', label: 'Funder contact', hint: 'the named person at the funder you are writing to', source: 'user' },
] as const;

const BY_PATH = new Map<string, SlotDef>(SLOT_VOCABULARY.map((s) => [s.path, s]));

export function slotDef(path: string): SlotDef | undefined {
  return BY_PATH.get(path);
}

export function isKnownSlot(path: string): boolean {
  return BY_PATH.has(path);
}

export function userAnswerSlots(): SlotDef[] {
  return SLOT_VOCABULARY.filter((s) => s.source === 'user');
}

export interface SlotContextInput {
  profile?: Profile;
  program?: Program;
  funder?: Funder;
  /** Free-text answers keyed by full dotted slot path. Unknown keys are ignored. */
  answers?: Record<string, string>;
}

export function buildSlotContext(input: SlotContextInput): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  const set = (path: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (typeof value === 'string' && value.trim() === '') return;
    ctx[path] = value;
  };

  const { profile, program, funder, answers } = input;

  if (profile?.kind === 'organization') {
    const p: OrgProfile = profile;
    set('club.name', p.orgName);
    set('club.callsign', p.callsign);
    set('club.state', p.state);
    set('club.memberCount', p.memberCount);
    set('club.institution', p.institutionName);
    set('club.ein', p.ein);
    if (typeof p.arrlAffiliated === 'boolean') {
      set('club.arrlAffiliated', p.arrlAffiliated ? 'an ARRL-affiliated club' : 'not an ARRL-affiliated club');
    }
  }

  if (profile?.kind === 'student') {
    const p: StudentProfile = profile;
    set('student.callsign', p.callsign);
    set('student.licenseClass', p.licenseClass);
    set('student.licensedSince', p.licensedSince);
    set('student.institution', p.institution);
    set('student.degreeLevel', p.degreeLevel);
    set('student.fieldOfStudy', p.fieldOfStudy);
    set('student.gpa', p.gpa);
    set('student.state', p.state);
  }

  if (program) {
    set('funder.programName', program.name);
    set('funder.applyUrl', program.applyUrl);
    set('funder.amountRaw', program.amount.amountRaw);
    set('funder.deadlineNote', program.deadline.note);
  }

  if (funder) set('funder.name', funder.name);

  for (const [key, value] of Object.entries(answers ?? {})) {
    if (!isKnownSlot(key)) continue;
    set(key, value);
  }

  return ctx;
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/slots.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add packages/server/src/templates/slots.ts packages/server/src/templates/slots.test.ts && \
  git commit -m "feat(templates): slot vocabulary and profile-to-context builder"
```

---

### Task 3: fillTemplate — explicit gaps, never plausible filler

This is the contract function. The behaviour that matters most is negative: when a value is missing, the output must contain a marker a human cannot miss, and must not contain anything that could be mistaken for a real fact. Fabricated specifics are exactly the misconduct pattern NIH and ORI enumerate (fabricated data, non-existent references), so "leave a visible hole" is a correctness requirement, not a nicety.

**Files:**
- Create: `packages/server/src/templates/fill.ts`
- Create: `packages/server/src/templates/fill.test.ts`

**Interfaces:**
- Consumes: `slotDef(path)` from `./slots.js`.
- Produces: `FilledTemplate`, `fillTemplate(templateMarkdown, ctx)`, `todoFor(path)`, `renderSlotValue(value)`, `extractSlots(markdown)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/templates/fill.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractSlots, fillTemplate, renderSlotValue, todoFor } from './fill.js';

describe('fillTemplate', () => {
  it('substitutes known values and tolerates whitespace inside the braces', () => {
    const out = fillTemplate('{{club.name}} ({{ club.callsign }}) meets weekly.', {
      'club.name': 'Example Collegiate Amateur Radio Club',
      'club.callsign': 'W8UM',
    });
    expect(out.markdown).toBe('Example Collegiate Amateur Radio Club (W8UM) meets weekly.');
    expect(out.unresolvedSlots).toEqual([]);
  });

  it('resolves nested context objects as well as flat dotted keys', () => {
    const out = fillTemplate('{{club.callsign}}', { club: { callsign: 'K5UTD' } });
    expect(out.markdown).toBe('K5UTD');
  });

  it('renders an explicit TODO with the slot hint when a value is missing', () => {
    const out = fillTemplate('Our club {{club.callsign}} will teach.', {});
    expect(out.markdown).toBe("Our club [TODO: club.callsign — your club's FCC callsign, e.g. W8UM] will teach.");
    expect(out.unresolvedSlots).toEqual(['club.callsign']);
  });

  it('NEVER emits plausible filler for a missing callsign', () => {
    const out = fillTemplate('{{club.callsign}} and {{student.callsign}}', {});
    // No token in the output may look like a real callsign.
    expect(out.markdown).not.toMatch(/\b[A-Z]{1,2}\d{1,2}[A-Z]{1,4}\b/);
    expect(out.markdown).toContain('[TODO: club.callsign');
    expect(out.markdown).toContain('[TODO: student.callsign');
  });

  it('treats empty strings, whitespace, null, undefined, empty arrays and objects as missing', () => {
    const ctx = {
      'club.name': '',
      'club.city': '   ',
      'club.state': null,
      'club.ein': undefined,
      'project.equipment': [],
      'project.summary': { nested: 'value' },
    };
    const tpl = '{{club.name}}|{{club.city}}|{{club.state}}|{{club.ein}}|{{project.equipment}}|{{project.summary}}';
    const out = fillTemplate(tpl, ctx);
    expect(out.unresolvedSlots).toEqual([
      'club.name',
      'club.city',
      'club.state',
      'club.ein',
      'project.equipment',
      'project.summary',
    ]);
    expect(out.markdown.split('|').every((part) => part.startsWith('[TODO: '))).toBe(true);
  });

  it('reports each unresolved slot once, in first-appearance order', () => {
    const out = fillTemplate('{{club.name}} {{club.callsign}} {{club.name}}', {});
    expect(out.unresolvedSlots).toEqual(['club.name', 'club.callsign']);
  });

  it('renders numbers verbatim, booleans as yes/no, and arrays comma-joined', () => {
    expect(renderSlotValue(34)).toBe('34');
    expect(renderSlotValue(3.4)).toBe('3.4');
    expect(renderSlotValue(true)).toBe('yes');
    expect(renderSlotValue(false)).toBe('no');
    expect(renderSlotValue(['one Icom IC-7300', 'two Comet GP-3 antennas'])).toBe('one Icom IC-7300, two Comet GP-3 antennas');
    expect(renderSlotValue(Number.NaN)).toBeUndefined();
  });

  it('does not re-expand slot syntax that arrives inside a substituted value', () => {
    const out = fillTemplate('{{project.title}}', { 'project.title': '{{club.callsign}} station rebuild' });
    expect(out.markdown).toBe('{{club.callsign}} station rebuild');
    expect(out.unresolvedSlots).toEqual([]);
  });

  it('falls back to a bare TODO for a slot outside the vocabulary', () => {
    expect(todoFor('made.upSlot')).toBe('[TODO: made.upSlot]');
  });

  it('extractSlots lists every distinct slot in first-appearance order', () => {
    expect(extractSlots('{{b.one}} {{a.two}} {{b.one}}')).toEqual(['b.one', 'a.two']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/fill.test.ts
```

Expected failure: `Error: Failed to resolve import "./fill.js"`.

- [ ] **Step 3: Write fill.ts**

Create `packages/server/src/templates/fill.ts`:

```ts
import { slotDef } from './slots.js';

export interface FilledTemplate {
  markdown: string;
  unresolvedSlots: string[];
}

/** Fresh regex per call: a shared /g regex carries lastIndex between callers. */
const slotRe = (): RegExp => /\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\}\}/g;

export function extractSlots(markdown: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of markdown.matchAll(slotRe())) {
    const path = m[1] as string;
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(ctx, path)) return ctx[path];
  let cur: unknown = ctx;
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Returns the rendered text, or undefined when the value counts as missing.
 * Objects never render: a template slot is a fact, and a fact is a scalar.
 */
export function renderSlotValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? undefined : t;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    const parts = value.map(renderSlotValue).filter((s): s is string => s !== undefined);
    return parts.length === 0 ? undefined : parts.join(', ');
  }
  return undefined;
}

/**
 * The marker for a missing fact. It is deliberately loud and deliberately empty
 * of content: a fabricated specific is worse than a visible gap, because the
 * funder holds the human applicant accountable for every number in the document.
 */
export function todoFor(path: string): string {
  const def = slotDef(path);
  return def ? `[TODO: ${path} — ${def.hint}]` : `[TODO: ${path}]`;
}

export function fillTemplate(templateMarkdown: string, ctx: Record<string, unknown>): FilledTemplate {
  const unresolvedSlots: string[] = [];
  const seen = new Set<string>();

  const markdown = templateMarkdown.replace(slotRe(), (_full: string, path: string) => {
    const rendered = renderSlotValue(resolvePath(ctx, path));
    if (rendered !== undefined) return rendered;
    if (!seen.has(path)) {
      seen.add(path);
      unresolvedSlots.push(path);
    }
    return todoFor(path);
  });

  return { markdown, unresolvedSlots };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/fill.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add packages/server/src/templates/fill.ts packages/server/src/templates/fill.test.ts && \
  git commit -m "feat(templates): fillTemplate renders explicit TODO markers, never plausible filler"
```

---

### Task 4: Component templates 1–4 — need statement, project description, measurable outcomes, activities & timeline

These four are the spine of every organizational application. They are shipped **prose**, not stubs: a club officer opens one and has a structure, the questions to answer first, a skeleton with slots, and a named failure mode.

Two conventions used by every template in this plan:
- Instruction lines to the writer are markdown blockquotes (`> `). They are meant to be deleted as the writer replaces them.
- Nothing in `content/templates/` may contain a banned stock transition or a banned stock opener/closer. The guidance may not violate its own rule. A test enforces this across every template file, so it also protects Tasks 5–11.

**Files:**
- Create: `content/templates/components/need-statement.md`
- Create: `content/templates/components/project-description.md`
- Create: `content/templates/components/measurable-outcomes.md`
- Create: `content/templates/components/activities-timeline.md`
- Create: `packages/server/src/templates/content.test.ts`

**Interfaces:**
- Consumes: `loadTemplates(root?)`, `TemplateDoc` from `./load.js`; `isKnownSlot(path)` from `./slots.js`.
- Produces: four `TemplateDoc`s with ids `need-statement`, `project-description`, `measurable-outcomes`, `activities-timeline`; and `content.test.ts`, the corpus-wide invariant suite that Tasks 5–11 extend.

- [ ] **Step 1: Write the failing corpus test**

Create `packages/server/src/templates/content.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadTemplates } from './load.js';
import { isKnownSlot } from './slots.js';

const all = loadTemplates();
const components = all.filter((t) => t.layer === 'component');

/**
 * The shipped guidance may not violate the rules it teaches. These are the four
 * transitions the style ruleset bans outright and the stock openers/closers it
 * bans; if one appears in a template body, the template is the bug.
 */
const BANNED_IN_TEMPLATES = [
  /\bFurthermore\b/,
  /\bMoreover\b/,
  /\bAdditionally\b/,
  /\bIt is important to note that\b/i,
  /In today's rapidly evolving landscape/i,
  /for years to come/i,
];

describe('template corpus invariants', () => {
  it('loads without a parse error and every id is unique', () => {
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all.map((t) => t.id)).size).toBe(all.length);
  });

  it('uses only slots that exist in the vocabulary', () => {
    const offenders: string[] = [];
    for (const t of all) {
      for (const slot of t.slots) if (!isKnownSlot(slot)) offenders.push(`${t.id}:${slot}`);
    }
    expect(offenders).toEqual([]);
  });

  it('never contains a banned transition, opener or closer', () => {
    const offenders: string[] = [];
    for (const t of all) {
      for (const re of BANNED_IN_TEMPLATES) if (re.test(t.body)) offenders.push(`${t.id} matched ${re}`);
    }
    expect(offenders).toEqual([]);
  });

  it('gives every template a title, a positive order and a non-trivial body', () => {
    for (const t of all) {
      expect(t.title.length).toBeGreaterThan(3);
      expect(t.order).toBeGreaterThan(0);
      expect(t.body.trim().length).toBeGreaterThan(400);
    }
  });
});

describe('component layer', () => {
  it('ships the first four spine components with a length target', () => {
    const ids = components.map((t) => t.id);
    for (const id of ['need-statement', 'project-description', 'measurable-outcomes', 'activities-timeline']) {
      expect(ids).toContain(id);
    }
    for (const t of components) expect(t.lengthTarget).toBeTruthy();
  });

  it('gives the need statement the club identity slots and a stated failure mode', () => {
    const need = components.find((t) => t.id === 'need-statement');
    expect(need?.slots).toContain('club.name');
    expect(need?.slots).toContain('club.callsign');
    expect(need?.body).toMatch(/Common failure/);
  });

  it('requires a named human or organization as the subject in activities', () => {
    const act = components.find((t) => t.id === 'activities-timeline');
    expect(act?.body).toMatch(/named (human|person)/i);
    expect(act?.slots).toContain('team.leadName');
  });

  it('makes every outcome countable and dated', () => {
    const out = components.find((t) => t.id === 'measurable-outcomes');
    expect(out?.body).toMatch(/count/i);
    expect(out?.body).toMatch(/by when/i);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

Expected failure: `AssertionError: expected 0 to be greater than 0` from the first `it` (no templates exist yet), followed by `expected undefined to contain 'club.name'` in the component-layer block.

- [ ] **Step 3: Write the four component templates**

Create `content/templates/components/need-statement.md`:

```markdown
---
id: need-statement
title: Need statement
layer: component
order: 10
appliesTo: [ham_grant, adjacent_stem, equipment_in_kind]
lengthTarget: 200-300 words
---

## What this section has to do

Name a thing that is broken or missing today, for specific people, at a specific place, and show what it costs to leave it broken. A reviewer reading forty applications funds the ones that name a room, a piece of equipment, a headcount, and a date.

## Answer these before you write

1. What exactly does not work today? Name the equipment, the room, the frequency, the software version.
2. Who is affected, and how many of them are there? Count them; do not estimate.
3. When did it stop working, or when did the gap open?
4. What have you already tried, and what did that cost you?
5. What happens over the next twelve months if nothing changes?

## Skeleton

{{club.name}} ({{club.callsign}}) is {{club.arrlAffiliated}} operating from {{project.venue}} at {{club.institution}} in {{club.city}}, {{club.state}}, with {{club.memberCount}} members.

> Sentence 1 — the concrete failure. Name the object and the date it began.

{{project.problem}}

> Sentence 2 — the count. How many people run into this, and how often.

{{project.beneficiaryCount}} people are affected.

> Sentence 3 — what you already tried, with a number attached.

> Sentence 4 — the consequence, dated and countable. What is measurably worse in a year.

## Common failure

"There is a growing need for STEM engagement among today's students" is not a need statement. It describes a category, not your club. Delete every sentence that would still be true if a different club in a different state had written it. Whatever survives is your need statement.
```

Create `content/templates/components/project-description.md`:

```markdown
---
id: project-description
title: Project description
layer: component
order: 20
appliesTo: [ham_grant, adjacent_stem, equipment_in_kind]
lengthTarget: 400-700 words
---

## What this section has to do

Describe the work concretely enough that a reviewer could carry it out without asking you a question. This is where a proposal is won or lost, and it is the section most often filled with tone instead of content.

## Answer these before you write

1. What is the one thing that will exist afterwards that does not exist now?
2. Who does each part of the work, by name and role?
3. Where does it physically happen?
4. What gets bought, built, installed, or taught, and in what order?
5. What is explicitly out of scope?

## Skeleton

**Title.** {{project.title}}

**Summary.** {{project.summary}}

**Deliverable.** By {{project.endDate}}, {{club.name}} will have {{project.deliverable}}.

**Where.** The work happens at {{project.venue}}.

**Who.** {{team.leadName}} ({{team.leadCallsign}}), {{team.leadRole}}, is accountable for delivery. {{team.instructorName}} supervises the instructional portion.

**What we buy or build.** {{project.equipment}}

> Write three to five paragraphs of narrative here. Every sentence takes a named person or a named organization as its subject. Delete every adjective and adverb from a finished paragraph; if the paragraph still says what will happen, keep it. If it collapses, the paragraph was tone, and it needs rewriting around its nouns and numbers.

**Out of scope.**

> Name two or three things a reviewer might otherwise assume you are promising, and say plainly that you are not.

## Common failure

A description that could be pasted into another club's application. The fix is proper nouns: callsigns, building names, model numbers, dates, and the names of the people doing the work.
```

Create `content/templates/components/measurable-outcomes.md`:

```markdown
---
id: measurable-outcomes
title: Measurable outcomes
layer: component
order: 30
appliesTo: [ham_grant, adjacent_stem, equipment_in_kind]
lengthTarget: 150-300 words
---

## What this section has to do

State what will be true afterwards in a form somebody else could check. An outcome has four parts: a count, a thing being counted, a date by when, and the method used to observe it. Anything missing one of the four is an aspiration, not an outcome.

## Answer these before you write

1. What will you count?
2. How many, exactly? What is the number today, for comparison?
3. By when — a date, not "within the grant period"?
4. Who observes it, and where is it written down?

## Skeleton

| # | Outcome | Baseline today | Target | By when | How it is observed |
|---|---|---|---|---|---|
| 1 | > e.g. licensed operators among club members | > e.g. 11 | > e.g. 24 | {{project.endDate}} | > e.g. FCC ULS lookup, recorded in the club roster |
| 2 | | | | | |
| 3 | | | | | |

> Three strong outcomes beat eight weak ones. If you cannot name the observation method, the outcome is not measurable and belongs in the project description instead.

{{project.beneficiaryCount}} people are reached by this work in total.

## Common failure

"Increased awareness", "enhanced engagement", and "improved capacity" are not outcomes; nobody can check them. Replace each with the count you would look at to decide whether awareness actually increased.
```

Create `content/templates/components/activities-timeline.md`:

```markdown
---
id: activities-timeline
title: Activities and timeline
layer: component
order: 40
appliesTo: [ham_grant, adjacent_stem, equipment_in_kind]
lengthTarget: 250-500 words
---

## What this section has to do

Show the work as a sequence of dated actions with a named human or named organization performing each one. This is the section where generic prose is most obvious and most costly, because a reviewer reads it to decide whether you have actually thought the project through.

## The rule for this section

Every sentence takes a named human or a named organization as its grammatical subject.

Write: "Three of our members — {{team.leadName}} and two licensed volunteers — will teach a four-session licensing class in {{project.venue}} on {{project.schedule}}."

Do not write: "The implementation of an educational outreach initiative will be undertaken."

## Skeleton

| Phase | Dates | Who (by name) | What happens | Done when |
|---|---|---|---|---|
| 1 | {{project.startDate}} → | {{team.leadName}} | > order and receive equipment | > equipment on site, serial numbers recorded |
| 2 | | {{team.instructorName}} | > run the sessions on {{project.schedule}} | > attendance sheets filed |
| 3 | | | | |
| 4 | → {{project.endDate}} | | > report to {{funder.name}} | > report submitted |

> Narrative under the table, one short paragraph per phase. Name the person. Give the date. Give the count.

## Common failure

Passive voice hiding the absence of a person: "materials will be procured", "sessions will be conducted", "outreach will be performed". If you cannot name who does it, you have not planned it. Where you genuinely do not know yet, write the role and the date you will fill it, and say so.
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

All assertions pass: four components load, every slot is in the vocabulary, no banned phrase appears.

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add content/templates/components packages/server/src/templates/content.test.ts && \
  git commit -m "feat(templates): need statement, project description, outcomes and timeline components"
```

---

### Task 5: Component templates 5–8 — budget & justification, sustainability, evaluation plan, organizational capacity

**Files:**
- Create: `content/templates/components/budget-justification.md`
- Create: `content/templates/components/sustainability.md`
- Create: `content/templates/components/evaluation-plan.md`
- Create: `content/templates/components/organizational-capacity.md`
- Modify: `packages/server/src/templates/content.test.ts` (add one `describe` block)

**Interfaces:**
- Consumes: `loadTemplates()` from `./load.js`.
- Produces: `TemplateDoc`s with ids `budget-justification`, `sustainability`, `evaluation-plan`, `organizational-capacity`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/templates/content.test.ts`:

```ts
describe('component layer — budget, sustainability, evaluation, capacity', () => {
  const byId = (id: string) => all.find((t) => t.id === id);

  it('ships all four', () => {
    for (const id of ['budget-justification', 'sustainability', 'evaluation-plan', 'organizational-capacity']) {
      expect(byId(id)).toBeDefined();
    }
  });

  it('makes the budget a line-item table with unit prices and a justification column', () => {
    const b = byId('budget-justification');
    expect(b?.body).toMatch(/unit (price|cost)/i);
    expect(b?.body).toMatch(/\| *Why this line \|/);
    expect(b?.slots).toContain('project.requestAmount');
    expect(b?.slots).toContain('project.budgetTotal');
    expect(b?.slots).toContain('project.indirectPct');
  });

  it('asks sustainability who pays and who maintains after the grant', () => {
    const s = byId('sustainability');
    expect(s?.body).toMatch(/who (pays|maintains)/i);
    expect(s?.body).toMatch(/after the grant/i);
  });

  it('separates the evaluation plan from the outcomes table', () => {
    const e = byId('evaluation-plan');
    expect(e?.body).toMatch(/measurable-outcomes/);
  });

  it('makes organizational capacity cite evidence the club has done this before', () => {
    const c = byId('organizational-capacity');
    expect(c?.slots).toContain('club.foundedYear');
    expect(c?.body).toMatch(/evidence/i);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

Expected failure: `AssertionError: expected undefined to be defined` in "ships all four".

- [ ] **Step 3: Write the four templates**

Create `content/templates/components/budget-justification.md`:

```markdown
---
id: budget-justification
title: Budget and justification
layer: component
order: 50
appliesTo: [ham_grant, adjacent_stem, equipment_in_kind]
lengthTarget: 200-400 words plus the table
---

## What this section has to do

Show every dollar as a line with a unit price, a quantity, a source, and a reason. A budget with round numbers and no unit prices reads as a guess, and a reviewer who thinks you guessed will assume you will overspend.

## Answer these before you write

1. What is the catalog or vendor price of each item today, and where did you get that figure?
2. What quantity, and why that quantity?
3. What is already paid for by somebody else?
4. Does this funder cap indirect costs, and at what percentage?
5. Does this funder refuse any of these categories outright?

## Line-item budget

| Item | Unit price | Qty | Line total | Source of price | Why this line |
|---|---|---|---|---|---|
| > e.g. Icom IC-7300 HF transceiver | > e.g. $1,099 | 1 | > e.g. $1,099 | > vendor and date of quote | > what it makes possible that is impossible now |
| | | | | | |
| | | | | | |
| **Subtotal, direct costs** | | | | | |
| Indirect at {{project.indirectPct}}% | | | | | |
| **Total project cost** | | | **{{project.budgetTotal}}** | | |
| Requested from {{funder.name}} | | | **{{project.requestAmount}}** | | |
| Contributed by {{project.coFunder}} | | | {{project.coFunderAmount}} | | |

## Justification narrative

> One short paragraph per non-obvious line. Explain the quantity, not the item. "Two antennas" needs a reason; "an antenna" usually does not.

## Common failure

Round numbers. A budget of "$3,000 for equipment" tells a reviewer you have not priced anything. Quote real prices, cite where they came from, and let the total be an ugly number such as $2,847.
```

Create `content/templates/components/sustainability.md`:

```markdown
---
id: sustainability
title: Sustainability
layer: component
order: 60
appliesTo: [ham_grant, adjacent_stem, equipment_in_kind]
lengthTarget: 150-250 words
---

## What this section has to do

Answer two questions plainly: who pays for this after the grant ends, and who maintains it. Student organizations turn over completely every four years, and experienced reviewers know it. Saying so and showing your plan is stronger than pretending otherwise.

## Answer these before you write

1. What are the recurring costs after {{project.endDate}} — power, site rent, licence fees, consumables, insurance?
2. Which budget line absorbs them, and who controls that budget?
3. Who physically maintains the equipment, and who trains their replacement?
4. What happens to the equipment if the club goes dormant?

## Skeleton

**Recurring costs after the grant.**

> List them with amounts. Write "none" if there genuinely are none, and say why.

**Who pays.**

> Name the account, department, or dues structure. "{{club.name}} dues, currently collected from {{club.memberCount}} members" is a real answer.

**Who maintains it.**

> Name the role, and describe the handover. A club with a written station-manager handover beats a club with an enthusiastic volunteer.

**Custody if the club goes dormant.**

> Name the department, the institution, or the trustee who holds the equipment. Funders ask this because it happens.

## Common failure

Answering with intent instead of a mechanism. "The club is committed to maintaining this equipment" is intent. "The equipment is inventoried by the {{club.institution}} department and the station manager role appears in our bylaws" is a mechanism.
```

Create `content/templates/components/evaluation-plan.md`:

```markdown
---
id: evaluation-plan
title: Evaluation plan
layer: component
order: 70
appliesTo: [ham_grant, adjacent_stem]
lengthTarget: 150-300 words
---

## What this section has to do

Describe how you will know whether the outcomes happened. The outcomes table in the measurable-outcomes component says what you will count; this section says who collects the data, when, with what instrument, and what you do if the number comes in low.

## Answer these before you write

1. For each outcome, what is the instrument — a sign-in sheet, an FCC ULS lookup, a logbook export, a pre/post quiz, a photograph?
2. Who collects it and on what date?
3. Where is it stored, and who can see it?
4. What is your response if the number comes in at half of target?

## Skeleton

| Outcome | Instrument | Collected by | Collection dates | Stored where |
|---|---|---|---|---|
| > outcome 1 | | {{team.leadName}} | | |
| > outcome 2 | | | | |

**Mid-point check.**

> Name a date roughly halfway between {{project.startDate}} and {{project.endDate}} on which you look at the numbers.

**If a number comes in low.**

> Say what you would change. A plan that admits a failure mode and names the response is more credible than one that assumes success.

## Common failure

Confusing activity with evaluation. "We will hold four sessions" is an activity. "We will count licensed operators against the FCC ULS on {{project.endDate}}" is evaluation.
```

Create `content/templates/components/organizational-capacity.md`:

```markdown
---
id: organizational-capacity
title: Organizational capacity
layer: component
order: 80
appliesTo: [ham_grant, adjacent_stem, equipment_in_kind]
lengthTarget: 200-350 words
---

## What this section has to do

Give evidence that this club can finish what it starts. Evidence means things that already happened, with dates and counts — not adjectives about the club's character.

## Answer these before you write

1. What has the club completed in the last three years, with dates and counts?
2. Who holds each officer role now, and since when?
3. What equipment, space, and licences does the club already control?
4. Has the club handled restricted money before — a departmental account, a prior grant, a student government allocation?
5. Who signs, and who keeps the books?

## Skeleton

{{club.name}} ({{club.callsign}}) has operated since {{club.foundedYear}} at {{club.institution}} and currently has {{club.memberCount}} members. The club is {{club.arrlAffiliated}}.

**Track record.**

> Three to five completed items, each with a date and a number. Field Day scores, licensing class pass counts, public-service event hours, a repeater kept on the air, a satellite contact.

**People.**

> {{team.leadName}} ({{team.leadCallsign}}), {{team.leadRole}}, plus the officers relevant to this work and how long each has served.

**What we already have.**

> Space, antennas, radios, test equipment, an existing club account. Name the models.

**Financial handling.**

> Name the account and who reconciles it. If funds must pass through {{club.fiscalSponsor}} or {{club.institution}}, say so here and name the contact.

## Common failure

Describing the hobby instead of the club. A reviewer already knows amateur radio is educational. What they do not know is whether your officers finish projects.
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add content/templates/components packages/server/src/templates/content.test.ts && \
  git commit -m "feat(templates): budget, sustainability, evaluation and capacity components"
```

---

### Task 6: Component templates 9–13 — letter of inquiry, scholarship essay, recommendation request, thank-you, interim/final report

These five cover the non-narrative documents. The scholarship essay is the only component addressed to an individual applicant rather than a club, and the recommendation-request email exists because several catalog entries require a sponsor letter from a specific kind of person — the ARDC scholarship needs three references, QCWA requires an active QCWA member as sponsor, and the Goldwater entry requires a sitting club officer.

**Files:**
- Create: `content/templates/components/letter-of-inquiry.md`
- Create: `content/templates/components/scholarship-personal-essay.md`
- Create: `content/templates/components/recommendation-request-email.md`
- Create: `content/templates/components/thank-you-letter.md`
- Create: `content/templates/components/interim-final-report.md`
- Modify: `packages/server/src/templates/content.test.ts` (add one `describe` block)

**Interfaces:**
- Consumes: `loadTemplates()` from `./load.js`.
- Produces: `TemplateDoc`s with ids `letter-of-inquiry`, `scholarship-personal-essay`, `recommendation-request-email`, `thank-you-letter`, `interim-final-report`. After this task the component layer is complete at 13 templates.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/templates/content.test.ts`:

```ts
describe('component layer — correspondence and reporting', () => {
  const byId = (id: string) => all.find((t) => t.id === id);

  it('completes the component layer at exactly 13 templates', () => {
    expect(components.length).toBe(13);
  });

  it('ships the five correspondence and reporting components', () => {
    for (const id of [
      'letter-of-inquiry',
      'scholarship-personal-essay',
      'recommendation-request-email',
      'thank-you-letter',
      'interim-final-report',
    ]) {
      expect(byId(id)).toBeDefined();
    }
  });

  it('addresses the scholarship essay to the individual applicant, not a club', () => {
    const essay = byId('scholarship-personal-essay');
    expect(essay?.appliesTo).toEqual(['ham_scholarship']);
    expect(essay?.slots.some((s) => s.startsWith('student.'))).toBe(true);
    expect(essay?.slots.some((s) => s.startsWith('club.'))).toBe(false);
  });

  it('tells the recommendation request to supply the recommender with facts and a deadline', () => {
    const rec = byId('recommendation-request-email');
    expect(rec?.slots).toContain('recommender.name');
    expect(rec?.slots).toContain('recommender.deadline');
    expect(rec?.body).toMatch(/sponsor|reference|letter/i);
  });

  it('makes the report compare promised numbers against actual numbers', () => {
    const rep = byId('interim-final-report');
    expect(rep?.slots).toContain('report.spendToDate');
    expect(rep?.slots).toContain('report.outcomeSummary');
    expect(rep?.body).toMatch(/promised/i);
    expect(rep?.appliesTo).toEqual(['ham_grant', 'ham_scholarship', 'adjacent_stem', 'equipment_in_kind']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

Expected failure: `AssertionError: expected 8 to be 13`.

- [ ] **Step 3: Write the five templates**

Create `content/templates/components/letter-of-inquiry.md`:

```markdown
---
id: letter-of-inquiry
title: Letter of inquiry
layer: component
order: 90
appliesTo: [ham_grant, adjacent_stem]
lengthTarget: 300-500 words, one page
---

## What this section has to do

Ask a funder, before you write a full proposal, whether the project is worth their time. One page. A letter of inquiry that runs to three pages has already answered its own question.

## Structure

**Paragraph 1 — who and how much.** {{club.name}} ({{club.callsign}}) requests {{project.requestAmount}} from {{funder.name}} for {{project.title}}.

**Paragraph 2 — the problem, in two sentences.** {{project.problem}}

**Paragraph 3 — what you will do and by when.** {{project.summary}} The work runs from {{project.startDate}} to {{project.endDate}} at {{project.venue}}.

**Paragraph 4 — what will be true afterwards.** Name one countable outcome, with the number and the date.

**Paragraph 5 — why this funder.** One specific sentence tying the project to something this funder has actually published or funded. If you cannot write it without flattery, delete the paragraph.

**Close.** Name the next step and give a date: "{{team.leadName}} can send a full proposal by {{project.endDate}} if that would be useful."

## Common failure

Restating the funder's mission back at them. They wrote it; they know it. Spend the space on your own numbers instead.
```

Create `content/templates/components/scholarship-personal-essay.md`:

```markdown
---
id: scholarship-personal-essay
title: Scholarship personal essay
layer: component
order: 100
appliesTo: [ham_scholarship]
lengthTarget: 400-600 words
---

## What this section has to do

Make a selection committee remember one specific person. Scholarship committees read hundreds of essays that could have been written by anyone with a licence. The ones they remember contain a scene, a number, and a plan.

## Answer these before you write

1. What is the single most specific thing you have done with a radio? Give the date, the band or mode, the equipment, and what happened.
2. What did you build, fix, or break, and what did you learn from it?
3. Who taught you, by name, and what did they say?
4. What do you intend to do with {{student.fieldOfStudy}} after {{student.gradYear}}, stated concretely enough that somebody could check in five years?
5. What does this award change, materially?

## Structure

**Opening — a scene, not a thesis.** Start inside a specific moment: a date, a place, a piece of equipment, a person. Do not open with a definition of amateur radio; the committee holds licences.

**Middle — the through-line.** {{student.name}} ({{student.callsign}}) has held a {{student.licenseClass}} licence since {{student.licensedSince}} and studies {{student.fieldOfStudy}} at {{student.institution}}. Connect the scene to the field of study with events, not adjectives.

**Middle — evidence.** Two or three things you have actually completed, each with a date and a count.

**Close — the plan and the ask.** What you intend to do after {{student.gradYear}}, and what this award makes possible that is otherwise not.

## Common failure

The essay that says amateur radio taught the writer discipline, teamwork, and problem-solving. Three abstractions, no scene, and interchangeable with every other essay in the stack. Replace all three with one story that contains a date and a piece of equipment.
```

Create `content/templates/components/recommendation-request-email.md`:

```markdown
---
id: recommendation-request-email
title: Recommendation request email
layer: component
order: 110
appliesTo: [ham_scholarship, ham_grant]
lengthTarget: 150-250 words
---

## What this section has to do

Make it easy for somebody to say yes and then write a strong letter quickly. Several programs require a specific kind of recommender: the ARDC scholarship requires three references, the QCWA Memorial Scholarship requires sponsorship by an active QCWA member, and at least one catalog entry requires a letter from a sitting officer of an ARRL-affiliated club. Check which kind of person you need before you send this.

## Skeleton

Subject: Reference letter for {{funder.programName}} — due {{recommender.deadline}}

Dear {{recommender.name}},

> One sentence: what you are applying for, and the amount or award if it is published.

I am applying for {{funder.programName}} and the application is due {{recommender.deadline}}. Would you be willing to write a letter of reference?

> One short paragraph reminding them of specific shared work: the dates, the project, what you did. Never assume they remember. This paragraph is what makes the letter specific instead of generic.

To make this quick, I have attached:

- the program's published criteria ({{funder.applyUrl}})
- a one-page summary of what I have done, with dates and counts
- the exact submission instructions and the deadline

> If they need to submit through a portal rather than send you the letter, say that here and give the link.

Thank you either way — a "no" now is more useful to me than a late yes.

{{student.name}} ({{student.callsign}})
{{recommender.role}}

## Common failure

Asking with three days' notice and no supporting facts. A recommender who has to reconstruct your accomplishments from memory writes a warm, vague letter. A recommender handed dates and numbers writes a specific one.
```

Create `content/templates/components/thank-you-letter.md`:

```markdown
---
id: thank-you-letter
title: Thank-you letter
layer: component
order: 120
appliesTo: [ham_grant, ham_scholarship, adjacent_stem, equipment_in_kind]
lengthTarget: 120-200 words
---

## What this section has to do

Close the loop with a fact. Most thank-you letters are warmth with no information, and they are forgotten. A letter that reports one number is remembered at the next funding cycle.

## Skeleton

Dear {{donor.contactName}},

> Sentence 1 — thanks, naming the specific award and amount.

Thank you for the {{funder.programName}} award of {{project.requestAmount}} to {{club.name}} ({{club.callsign}}).

> Sentence 2 — one concrete thing that has already happened because of it, with a number and a date. If nothing has happened yet, name the date it will.

> Sentence 3 — what happens next, with a date.

> Sentence 4 — an offer that costs them nothing: a photograph, a short report, an invitation to a demonstration.

{{team.leadName}} ({{team.leadCallsign}}), {{team.leadRole}}
{{club.name}}

## Common failure

Sending it months late, or sending warmth with no fact in it. Send it within two weeks, and put one number in it.
```

Create `content/templates/components/interim-final-report.md`:

```markdown
---
id: interim-final-report
title: Interim and final report
layer: component
order: 130
appliesTo: [ham_grant, ham_scholarship, adjacent_stem, equipment_in_kind]
lengthTarget: 400-800 words
---

## What this section has to do

Report what you promised against what happened, in that order, using the same numbers you used in the application. Some awards carry an explicit reporting obligation — the YASME Foundation requires a year-end activity report, and equipment programs commonly require proof of continued operation.

## Answer these before you write

1. Which numbers did you promise? Copy them from your outcomes table verbatim.
2. What are the actual numbers today?
3. Where a number came in low, what happened, and what did you do about it?
4. What did the money actually buy, against the budget lines you submitted?
5. What obligation remains open — an on-air period, an open-source release, a follow-up report?

## Skeleton

**Report period.** {{report.periodStart}} to {{report.periodEnd}}
**Grant reference.** {{report.grantId}}
**Awarded.** {{project.requestAmount}} · **Spent to date.** {{report.spendToDate}}

**Promised against actual.**

| Outcome as promised | Target | Actual | Notes |
|---|---|---|---|
| | | | |
| | | | |

**What happened.**

{{report.outcomeSummary}}

**Where we missed, and why.**

> Report shortfalls plainly and say what you changed. Funders talk to each other; a candid report is an asset at the next cycle, and a silently missing number is the thing that ends a relationship.

**Money.**

> Budget line, awarded, spent, variance. Explain any variance over ten percent.

**Open obligations.**

> Anything still owed: an on-air period still running, source code or documentation still to be published under {{project.openLicense}}, a further report due.

## Common failure

Reporting activity instead of outcomes, because activity is easier to describe. If the application promised twenty-four licensed operators, the report opens with the number of licensed operators.
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

`components.length` is now 13.

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add content/templates/components packages/server/src/templates/content.test.ts && \
  git commit -m "feat(templates): letter of inquiry, scholarship essay, recommendation, thank-you and report components"
```

---

### Task 7: Funder overlays — ARDC and ARRL Amateur Radio Grants

An overlay is a funder-specific layer that sits on top of the components: it names what this funder actually requires, what they refuse, what they oblige you to do afterwards, and where each of those claims came from. Every overlay carries a `sources:` list of real published URLs, and a test asserts it — an overlay with no citation is an opinion, and this app does not ship opinions about deadlines.

**ARDC** (Amateur Radio Digital Communications) is the largest funder in this space, roughly $3.4–3.8M a year at about a 30% approval rate. Two of its requirements are the ones applicants most often miss:

1. **All output must be open-source or open-access** — GPL, MIT, BSD, CERN-OHL for hardware, Creative Commons for documentation. This is a condition of the grant, not a preference. A proposal that plans to keep its firmware private is not fixable at the review stage.
2. **Indirect costs are capped at 20%.** A university budget built on a negotiated 55% F&A rate fails arithmetic before anyone reads the narrative.

ARDC also publishes a **brevity mandate**, and its AI stance is permission plus a diagnosis: *"If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy. If the proposal is extremely long and hard to understand, we can't evaluate or support it."* The concern is bloat, not ethics.

**ARRL Amateur Radio Grants** is a separate, smaller program with three fixed windows a year, three hard exclusions, and a stated preference for not being the sole funder.

**Files:**
- Create: `content/templates/funders/funder-ardc.md`
- Create: `content/templates/funders/funder-arrl-amateur-radio-grants.md`
- Modify: `packages/server/src/templates/content.test.ts` (add the funder-layer invariants plus one `describe`)

**Interfaces:**
- Consumes: `loadTemplates()`, `selectTemplates()` from `./load.js`.
- Produces: overlays `funder-ardc` (binds `ardc-grants`) and `funder-arrl-amateur-radio-grants` (binds `arrl-amateur-radio-grants`).

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/templates/content.test.ts`:

```ts
describe('funder layer — invariants', () => {
  const overlays = all.filter((t) => t.layer === 'funder');

  it('cites at least one live https source for every overlay', () => {
    expect(overlays.length).toBeGreaterThan(0);
    for (const t of overlays) {
      expect(t.sources.length, `${t.id} has no sources`).toBeGreaterThan(0);
      for (const s of t.sources) {
        expect(s.url, `${t.id} source "${s.label}"`).toMatch(/^https?:\/\//);
        expect(s.label.length).toBeGreaterThan(3);
      }
    }
  });

  it('never links to the compromised farweb.org domain', () => {
    for (const t of all) {
      expect(t.body, `${t.id}`).not.toMatch(/farweb\.org/i);
      for (const s of t.sources) expect(s.url).not.toMatch(/farweb\.org/i);
    }
  });

  it('binds each overlay to a program id unless it is an always-available playbook', () => {
    for (const t of overlays) {
      if (t.alwaysAvailable) expect(t.programIds).toEqual([]);
      else expect(t.programIds.length, `${t.id}`).toBeGreaterThan(0);
    }
  });

  it('lists the components each overlay expects', () => {
    const componentIds = new Set(components.map((c) => c.id));
    for (const t of overlays) {
      for (const req of t.requires) expect(componentIds.has(req), `${t.id} requires ${req}`).toBe(true);
    }
  });
});

describe('funder layer — ARDC and ARRL Amateur Radio Grants', () => {
  const byId = (id: string) => all.find((t) => t.id === id);

  it('surfaces ARDC open-source obligation and the 20 percent indirect cap', () => {
    const ardc = byId('funder-ardc');
    expect(ardc).toBeDefined();
    expect(ardc?.body).toMatch(/open[- ]source/i);
    expect(ardc?.body).toMatch(/open[- ]access/i);
    expect(ardc?.body).toMatch(/CERN-OHL/);
    expect(ardc?.body).toMatch(/20%/);
    expect(ardc?.slots).toContain('project.openLicense');
    expect(ardc?.slots).toContain('project.indirectPct');
  });

  it('surfaces the ARDC brevity mandate and the four fixed cycles', () => {
    const ardc = byId('funder-ardc');
    expect(ardc?.body).toMatch(/brief|brevity/i);
    expect(ardc?.body).toMatch(/February 1.*April 1.*July 1.*September 1/s);
    expect(ardc?.body).toMatch(/fiscal sponsor/i);
    expect(ardc?.programIds).toEqual(['ardc-grants']);
  });

  it('surfaces the three ARRL exclusions, the co-funding preference and the amount ceiling', () => {
    const arrl = byId('funder-arrl-amateur-radio-grants');
    expect(arrl?.body).toMatch(/emergency communication|emcomm/i);
    expect(arrl?.body).toMatch(/ongoing operating expenses/i);
    expect(arrl?.body).toMatch(/organizations only|never to individuals/i);
    expect(arrl?.body).toMatch(/\$3,000/);
    expect(arrl?.body).toMatch(/\$5,000/);
    expect(arrl?.body).toMatch(/Year of the Club/);
    expect(arrl?.body).toMatch(/February 1.{0,4}28|Jun(e)? 1.{0,4}30|October 1.{0,4}31/);
    expect(arrl?.programIds).toEqual(['arrl-amateur-radio-grants']);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

Expected failure: `AssertionError: expected 0 to be greater than 0` in "cites at least one live https source for every overlay", then `expected undefined to be defined` for `funder-ardc`.

- [ ] **Step 3: Write the two overlays**

Create `content/templates/funders/funder-ardc.md`:

```markdown
---
id: funder-ardc
title: ARDC Grants Program — funder overlay
layer: funder
order: 10
appliesTo: [ham_grant, adjacent_stem]
funderId: ardc
programIds: [ardc-grants]
requires: [need-statement, project-description, measurable-outcomes, activities-timeline, budget-justification, sustainability, organizational-capacity]
lengthTarget: keep the whole application short; ARDC says so explicitly
sources:
  - label: ARDC grant application instructions
    url: https://www.ardc.net/apply/grant-application-instructions/
  - label: ARDC apply page
    url: https://www.ardc.net/apply/
---

## The two requirements applicants miss

**1. Every output must be open-source or open-access.** Software, hardware designs, documentation, curriculum, and data produced with ARDC money must be published under an open licence: GPL, MIT, or BSD for software; CERN-OHL for hardware; a Creative Commons licence for documentation and curriculum. This is a condition of the grant. A project that plans to keep its firmware, board files, or course materials private is ineligible, and no amount of narrative quality fixes it at review time.

Name the licence explicitly in the proposal:

> All software, board files, and documentation produced under this grant will be published under {{project.openLicense}} at a public repository within 30 days of {{project.endDate}}.

**2. Indirect costs are capped at 20%.** If your institution has a negotiated indirect rate above 20%, resolve that before you submit — either the institution accepts the capped rate in writing, or the project is restructured. Show the arithmetic in the budget:

> Indirect costs are charged at {{project.indirectPct}}% of direct costs, within the 20% cap stated in ARDC's application instructions.

## Who may apply

US 501(c)(3) organizations, government entities, and **schools and universities**. International nonprofits and universities are eligible. For-profit companies are not.

Clubs and individuals apply **through a fiscal sponsor** — a 501(c)(3) that receives and administers the funds. Name the sponsor early:

> Funds would be received and administered by {{club.fiscalSponsor}} on behalf of {{club.name}} ({{club.callsign}}).

## Cycles and timing

Four fixed deadlines a year: **February 1, April 1, July 1, September 1.** An application arriving after September 1 goes to the following February 1. Evaluation takes 60 to 120 days, so plan the project start well behind the deadline — a project that must begin six weeks after the deadline is not fundable on this calendar.

## Amount

There is no published cap. The 2026 award page shows a range from roughly $1,285 to $258,000; verified collegiate awards run about $2,000 to $77,000. ARDC distributes roughly $3.4M to $3.8M a year at approximately a 30% approval rate. Ask for what the line items add up to, not for a round number that sounds modest.

## Brevity — ARDC's stated concern

ARDC asks applicants to be thorough and brief, and to avoid unnecessary jargon. Their published guidance on AI use is permission with a diagnosis attached: a proposal that is extremely long and hard to understand cannot be evaluated or supported. Treat word count as a review criterion. Run the brevity pass before you submit, and cut every sentence that would still be true if another club had written it.

## Overlay checklist

- [ ] Open licence named, with the repository and the publication date
- [ ] Indirect at or below 20%, shown as arithmetic
- [ ] Fiscal sponsor named, if the applicant is a club or an individual
- [ ] Submitted against one of the four fixed dates, with 60–120 days of evaluation time before the work must start
- [ ] Jargon removed; brevity pass run
- [ ] Every figure in the budget traceable to a quote or catalog price
```

Create `content/templates/funders/funder-arrl-amateur-radio-grants.md`:

```markdown
---
id: funder-arrl-amateur-radio-grants
title: ARRL Amateur Radio Grants — funder overlay
layer: funder
order: 20
appliesTo: [ham_grant, equipment_in_kind]
funderId: arrl-foundation
programIds: [arrl-amateur-radio-grants]
requires: [need-statement, project-description, measurable-outcomes, activities-timeline, budget-justification, sustainability, organizational-capacity]
lengthTarget: 800-1200 words total
sources:
  - label: ARRL Amateur Radio Grants program page
    url: http://www.arrl.org/amateur-radio-grants
---

## What this program refuses

Three exclusions decide most applications before the narrative is read:

1. **Emergency communications equipment.** Radios, antennas, or infrastructure justified primarily as emcomm are out of scope for this program. A project framed around ARES, RACES, SKYWARN, or disaster response is applying to the wrong program.
2. **Ongoing operating expenses.** Repeater site rent, insurance premiums, internet service, recurring licence fees, and consumables are not fundable. Fund a thing, not a subscription.
3. **Individuals.** Awards go to **US organizations only** — clubs, schools, and youth programs — and never to individuals.

If your project is genuinely about emergency preparedness, rewrite it around what it teaches and who it licenses, or apply elsewhere. Do not disguise it; reviewers in this space know the vocabulary.

## Amount

Awards generally do not exceed **$3,000**. For 2026, designated the **Year of the Club**, the ceiling rises to **$5,000**. Ask for a number your line items justify. A request at the ceiling with a four-line budget reads worse than a request for $2,310 with eleven priced lines.

> {{club.name}} ({{club.callsign}}) requests {{project.requestAmount}} toward a total project cost of {{project.budgetTotal}}.

## Co-funding is a stated preference

The ARRL Foundation prefers not to be a project's sole funder. Name the other money in the first paragraph of the budget justification, and quantify it — cash, donated equipment, matched departmental funds, or student government allocation all count.

> {{project.coFunder}} is contributing {{project.coFunderAmount}} toward this project.

If there genuinely is no co-funder, say what the club itself is putting in: dues, volunteer hours with an hourly value, or existing equipment.

## Windows

Three fixed windows a year: **February 1–28**, **June 1–30**, and **October 1–31**. Applications are accepted only inside a window. Note that this is a different program from the ARRL Club Grant Program, which has its own separate and currently unconfirmed cycle — do not assume the two share dates.

## What reviewers respond to here

This is a small-grant program serving clubs and schools. The strongest applications are narrow: one purchase, one class, one antenna, one measurable result. A $2,500 project with three named people and a date beats a $5,000 project with a vision.

## Overlay checklist

- [ ] Nothing in the request is emergency-communications equipment
- [ ] Nothing in the request is a recurring cost
- [ ] The applicant is a US organization, not an individual
- [ ] Request is at or under $3,000, or under $5,000 for 2026
- [ ] Co-funding named and quantified
- [ ] Submitted inside one of the three windows
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add content/templates/funders packages/server/src/templates/content.test.ts && \
  git commit -m "feat(templates): ARDC and ARRL Amateur Radio Grants funder overlays"
```

---

### Task 8: Funder overlays — ARRL Club Grant and ARRL Foundation Scholarship

Two overlays with unusual honesty requirements.

**The ARRL Club Grant Program cycle is disputed.** Three researchers reached three different conclusions — dormant, a spring window, and Feb/Jun/Oct — and the third is probably a conflation with the separate Amateur Radio Grants program. The page shows only 2024 results, carries no open cycle and no application link, and the application portal is a JavaScript single-page app that returns zero server-side text, so open/closed status cannot be determined programmatically. The overlay therefore states all three readings with their sources and tells the user what signal to watch, rather than printing a date the app cannot stand behind. This is the same discipline as the `disputed` field on the record itself.

**The ARRL Foundation Scholarship is one application across a catalog of 111 entries.** Applicants routinely believe they must apply to each scholarship separately. They do not: a single application is matched against the whole catalog, which yielded 135 awards and more than $715,000 in 2024. The cycle opens around October 30 and closes around December 30 at 12:00 PM Eastern — and it **moved from January 31**, so no date should be treated as permanent.

**Files:**
- Create: `content/templates/funders/funder-arrl-club-grant.md`
- Create: `content/templates/funders/funder-arrl-foundation-scholarships.md`
- Modify: `packages/server/src/templates/content.test.ts` (add one `describe`)

**Interfaces:**
- Consumes: `loadTemplates()` from `./load.js`.
- Produces: overlays `funder-arrl-club-grant` (binds `arrl-club-grant`) and `funder-arrl-foundation-scholarships` (binds `arrl-foundation-scholarships`).

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/templates/content.test.ts`:

```ts
describe('funder layer — ARRL Club Grant and ARRL Foundation Scholarship', () => {
  const byId = (id: string) => all.find((t) => t.id === id);

  it('states the Club Grant cycle as disputed rather than printing a date', () => {
    const cg = byId('funder-arrl-club-grant');
    expect(cg).toBeDefined();
    expect(cg?.body).toMatch(/disputed/i);
    expect(cg?.body).toMatch(/three different/i);
    expect(cg?.body).toMatch(/news RSS|news feed/i);
    // It must not present a single confident deadline sentence.
    expect(cg?.body).not.toMatch(/The deadline is [A-Z][a-z]+ \d/);
  });

  it('gives the Club Grant range and the 2024 outcome numbers', () => {
    const cg = byId('funder-arrl-club-grant');
    expect(cg?.body).toMatch(/\$1,000/);
    expect(cg?.body).toMatch(/\$25,000/);
    expect(cg?.body).toMatch(/\$500,502/);
    expect(cg?.body).toMatch(/37 of 110/);
    expect(cg?.body).toMatch(/ARRL-affiliated/i);
    expect(cg?.programIds).toEqual(['arrl-club-grant']);
  });

  it('tells scholarship applicants it is a single application across the catalog', () => {
    const sch = byId('funder-arrl-foundation-scholarships');
    expect(sch?.body).toMatch(/one application|single application/i);
    expect(sch?.body).toMatch(/111/);
    expect(sch?.body).toMatch(/October 30/);
    expect(sch?.body).toMatch(/December 30/);
    expect(sch?.body).toMatch(/January 31/);
    expect(sch?.appliesTo).toEqual(['ham_scholarship']);
    expect(sch?.requires).toContain('scholarship-personal-essay');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

Expected failure: `AssertionError: expected undefined to be defined` for `funder-arrl-club-grant`.

- [ ] **Step 3: Write the two overlays**

Create `content/templates/funders/funder-arrl-club-grant.md`:

```markdown
---
id: funder-arrl-club-grant
title: ARRL Club Grant Program — funder overlay
layer: funder
order: 30
appliesTo: [ham_grant]
funderId: arrl-foundation
programIds: [arrl-club-grant]
requires: [need-statement, project-description, measurable-outcomes, activities-timeline, budget-justification, sustainability, evaluation-plan, organizational-capacity]
lengthTarget: 1200-2000 words total
sources:
  - label: ARRL Club Grant Program page
    url: https://www.arrl.org/club-grant-program
  - label: ARRL news feed, the only reliable signal for this cycle
    url: http://www.arrl.org/news/rss
---

## Read this first: the cycle is disputed

GrantSpotter does not know when this program's next window opens, and it will not guess.

The program page shows 2024 results, no open cycle, and no application link. The application portal is a JavaScript application that serves no text to a non-browser client, so open and closed states cannot be read programmatically. Research on 2026-08-02 produced **three different conclusions** from three passes:

- the program is currently dormant between cycles;
- the program runs an autumn window, on the pattern of the observed 2022 cycle that opened September 7 and closed November 4;
- the program runs February, June and October windows — which is probably a conflation with the separate **ARRL Amateur Radio Grants** program, a different program with a different application.

Treat all three as unresolved. The reliable signal is the **ARRL news feed**, which carries grant and deadline announcements roughly 10 to 20 times a year. Star this program in GrantSpotter so a change event reaches you, and check the program page directly before you commit effort.

## What is known and stable

- Awards run **$1,000 to $25,000** — the largest club-scale grants in US amateur radio.
- In 2024 the program distributed **$500,502 to 37 of 110 applicants**, against roughly $1.6M requested. Roughly one application in three was funded, and the average award was about $13,500.
- Applicants must be **ARRL-affiliated clubs**. Collegiate clubs are squarely in scope: 2024 recipients included clubs at Kansas State, Missouri S&T, Oklahoma State, Baylor (WA5BU), and City Tech.
- The program is underwritten by ARDC. That does not change the criteria, and it does not mean an ARDC-style open-source obligation applies here — but it does mean both programs are exposed to the same funder.

## What a $25,000 ask has to carry

At this size the application is a real proposal, not a form. The overlay expects every component, including the evaluation plan, and it expects the numbers to survive a second reader.

> {{club.name}} ({{club.callsign}}) is {{club.arrlAffiliated}} at {{club.institution}} with {{club.memberCount}} members, and requests {{project.requestAmount}} of a {{project.budgetTotal}} project.

## Overlay checklist

- [ ] Club affiliation with ARRL confirmed and dated
- [ ] Request sits inside $1,000–$25,000 and is justified line by line
- [ ] Evaluation plan present, with instruments and collection dates
- [ ] Sustainability answers who pays and who maintains after {{project.endDate}}
- [ ] Cycle confirmed **on the program page**, not from this app and not from a search-engine snippet
- [ ] Program starred in GrantSpotter so a cycle announcement reaches you
```

Create `content/templates/funders/funder-arrl-foundation-scholarships.md`:

```markdown
---
id: funder-arrl-foundation-scholarships
title: ARRL Foundation Scholarships — funder overlay
layer: funder
order: 40
appliesTo: [ham_scholarship]
funderId: arrl-foundation
programIds: [arrl-foundation-scholarships]
requires: [scholarship-personal-essay, recommendation-request-email, thank-you-letter]
lengthTarget: essay 400-600 words; the rest is a form
sources:
  - label: ARRL scholarship descriptions catalog
    url: http://www.arrl.org/scholarship-descriptions
  - label: ARRL scholarship program overview
    url: http://www.arrl.org/scholarship-program
  - label: QCWA Memorial Scholarship Fund, which rides this cycle
    url: https://www.qcwa.org/scholarship-program.htm
---

## One application, the whole catalog

The most common mistake is applying scholarship by scholarship. The ARRL Foundation runs **one application** and matches it against a catalog of **111 entries** yielding more than 170 awards. In 2024 the Foundation made 135 awards totalling more than $715,000. You fill in one form and answer its eligibility questions honestly; the Foundation decides which entries you match.

The practical consequence: **answer every optional eligibility field.** A blank field cannot match. Your ARRL Section, your call district, your county, your class rank, your intended field of study, whether you are a veteran, whether a parent or grandparent holds a licence — each of these is the sole qualifier for at least one entry in the catalog. Several entries are keyed to a radius around a specific town; one is keyed to a preference cascade that starts with residents of a single state and falls back if no qualified applicant is found. Leaving a field blank silently removes you from those.

## Dates, and why not to trust a remembered one

The cycle opens around **October 30** and closes around **December 30 at 12:00 PM Eastern**. That close date **moved from January 31**, and third-party sites still publish the old one. Confirm against the ARRL page every year. GrantSpotter shows this program's `lastVerifiedAt` next to the date for exactly this reason.

## Programs that ride this cycle

Some funders have no application of their own and are awarded through this catalog: ARDC's 45-award block, YASME, DARA, the Six Meter Club of Chicago, and QCWA. **QCWA has an extra step** — it requires sponsorship by an active QCWA member, requests open from October 31, and the sponsored material must reach ARRL before the first week of January. Start that conversation in October, not December.

> A note on the Foundation for Amateur Radio: several club pages and older scholarship guides still direct applicants to "the FAR website" for these awards. That organization's former domain is no longer under its control and must not be visited. FAR's historical portfolio appears to have been absorbed into the ARRL Foundation catalog, which is where you should apply.

## The essay

{{student.name}} ({{student.callsign}}), {{student.licenseClass}} since {{student.licensedSince}}, studying {{student.fieldOfStudy}} at {{student.institution}}, graduating {{student.gradYear}}.

Use the scholarship personal essay component. Selection committees in this catalog read for demonstrated amateur radio activity, not for enthusiasm about amateur radio. A named Field Day, a licensing class you taught, a repeater you helped maintain, a satellite contact with a date — these are the sentences that get remembered.

## The ARRL Foundation has published no AI policy

Both the Club Grant page and the Grant Application Form PDF were read in full during research and contain zero mentions of AI, ChatGPT, or language models. GrantSpotter reports this as **unaddressed** rather than guessing at a stance in either direction. The funders in this space that do publish a policy — NSF, the Spencer Foundation, Wenner-Gren — all welcome a disclosure sentence, and none of them penalize one, which is why GrantSpotter offers the disclosure sentence by default here too. Including it is your call.

## Overlay checklist

- [ ] Every optional eligibility field answered, including Section, county, and class rank
- [ ] Licence class and date licensed match FCC records
- [ ] Recommenders asked in October, with the deadline stated
- [ ] QCWA sponsor secured separately, if applying for that award
- [ ] Close date confirmed on the ARRL page this cycle, not remembered from last year
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add content/templates/funders packages/server/src/templates/content.test.ts && \
  git commit -m "feat(templates): ARRL Club Grant and ARRL Foundation Scholarship overlays"
```

---

### Task 9: Funder overlays — ARISS, IEEE MTT-S Chapter Support, Yaesu DR-2X

Three overlays for programs that are not cash grants.

- **ARISS-USA** schedules a live amateur radio contact between a school group and an ISS crew member. There is no money; the award is the contact plus technical mentoring. The proposal is judged on the education plan around the contact, not on the radio. The audience is stated as "US schools and educational organizations" — colleges and universities are **not explicitly named**, so a collegiate club should lead with the K-12 audience it will reach. Windows are quarterly and rewritten at a stable URL; the window verified on 2026-08-02 opened July 1 and closes September 30 for contacts in January–June 2027.
- **IEEE MTT-S Chapter Support** is the most RF-relevant IEEE money for a student group: $1,000 a year for a single-society Student Branch Chapter, $500 for a joint chapter, with an October 1 deadline. Three administrative preconditions decide eligibility before the request is read: at least 5 chapter members, a current officer roster in IEEE vTools, and at least 2 meetings reported.
- **Yaesu's System Fusion DR-2X repeater program is a discounted purchase, not a grant.** $1,450 for the DR-2X, $1,860 with the LAN-01A network module. The club pays. The obligation attached is real: the repeater must be on the air for 12 months. Windows are ad-hoc, two to four a year, and the dates live only inside the title line of a dated fillable PDF.

**Files:**
- Create: `content/templates/funders/funder-ariss.md`
- Create: `content/templates/funders/funder-ieee-mtts.md`
- Create: `content/templates/funders/funder-yaesu-dr2x.md`
- Modify: `packages/server/src/templates/content.test.ts` (add one `describe`)

**Interfaces:**
- Consumes: `loadTemplates()` from `./load.js`.
- Produces: overlays `funder-ariss` (binds `ariss-iss-contact`), `funder-ieee-mtts` (binds `ieee-mtts-chapter-support`), `funder-yaesu-dr2x` (binds `yaesu-dr2x-repeater`).

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/templates/content.test.ts`:

```ts
describe('funder layer — ARISS, IEEE MTT-S, Yaesu DR-2X', () => {
  const byId = (id: string) => all.find((t) => t.id === id);

  it('tells ARISS applicants the award is a contact and mentoring, not cash', () => {
    const a = byId('funder-ariss');
    expect(a).toBeDefined();
    expect(a?.body).toMatch(/no cash|not cash|no money/i);
    expect(a?.body).toMatch(/education plan/i);
    expect(a?.body).toMatch(/not explicitly named/i);
    expect(a?.programIds).toEqual(['ariss-iss-contact']);
  });

  it('states the three IEEE MTT-S administrative preconditions and the October 1 date', () => {
    const i = byId('funder-ieee-mtts');
    expect(i?.body).toMatch(/at least (five|5) .*members/i);
    expect(i?.body).toMatch(/vTools/);
    expect(i?.body).toMatch(/two|2 .*meetings/i);
    expect(i?.body).toMatch(/October 1/);
    expect(i?.body).toMatch(/\$1,000/);
    expect(i?.slots).toContain('chapter.memberCount');
    expect(i?.slots).toContain('chapter.meetingCount');
    expect(i?.slots).toContain('chapter.officerRosterUrl');
  });

  it('states plainly that Yaesu is a discounted purchase with a 12-month on-air obligation', () => {
    const y = byId('funder-yaesu-dr2x');
    expect(y?.body).toMatch(/discounted purchase/i);
    expect(y?.body).toMatch(/not a grant/i);
    expect(y?.body).toMatch(/\$1,450/);
    expect(y?.body).toMatch(/\$1,860/);
    expect(y?.body).toMatch(/12 months/);
    expect(y?.slots).toContain('repeater.site');
    expect(y?.slots).toContain('repeater.coordinator');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

Expected failure: `AssertionError: expected undefined to be defined` for `funder-ariss`.

- [ ] **Step 3: Write the three overlays**

Create `content/templates/funders/funder-ariss.md`:

```markdown
---
id: funder-ariss
title: ARISS ISS contact proposal — funder overlay
layer: funder
order: 50
appliesTo: [equipment_in_kind, adjacent_stem]
funderId: ariss-usa
programIds: [ariss-iss-contact]
requires: [need-statement, project-description, measurable-outcomes, activities-timeline, organizational-capacity, thank-you-letter]
lengthTarget: follow the ARISS proposal form; the education plan is the long part
sources:
  - label: ARISS-USA proposal overview and current window
    url: https://ariss-usa.org/proposal-overview/
---

## What is actually awarded

**No cash.** ARISS schedules a live amateur radio contact between your group and a crew member aboard the International Space Station, and provides technical mentoring to get your ground station ready. You supply, borrow, or are helped to arrange the equipment. Budget accordingly: this is a programme that costs you money and returns an experience no other programme can.

## Who ARISS says may apply

"US schools and educational organizations." Colleges and universities are **not explicitly named** in that phrase, and K-12 groups dominate the awarded contacts. A collegiate club is not thereby excluded, but the proposal should lead with the K-12 or public audience the contact reaches, with real numbers:

> The contact will be held at {{project.venue}} for {{project.beneficiaryCount}} students from named partner schools, with {{team.instructorName}} coordinating the classroom programme.

Name the partner schools. A collegiate club proposing a contact for its own members is a much weaker application than the same club proposing a contact for 300 middle-school students it has already scheduled.

## The education plan is the proposal

Reviewers assess the learning programme built around the contact, not the radio. The contact is roughly ten minutes long. The programme around it should run for months.

Cover:

- The curriculum in the weeks before the contact: what is taught, by whom, to how many, on which dates.
- Student preparation: who writes the questions, how they are selected, who practises the microphone discipline.
- Community engagement: press, livestream, public audience, partner organizations.
- What happens afterwards, including whether any student continues toward a licence.
- Technical readiness: ground station, antennas, mentor relationship, and the fallback plan.

## Timing

Windows are quarterly and are rewritten at the same URL. The window verified on 2026-08-02 opened **July 1** and closed **September 30** for contacts scheduled January–June 2027. Read the current window on the page before planning; GrantSpotter shows when it last verified that sentence.

Contacts are scheduled months after selection, so the education programme must be planned against a date you will not control precisely. Build the curriculum to work if the contact slips by a month.

## Overlay checklist

- [ ] Audience is stated as students reached, with a number and named partner institutions
- [ ] Education plan spans weeks before and after, with dates and instructors
- [ ] Community engagement described concretely
- [ ] Ground station readiness and mentor relationship described
- [ ] Fallback plan if the contact slips
- [ ] Current window read from the ARISS page today
```

Create `content/templates/funders/funder-ieee-mtts.md`:

```markdown
---
id: funder-ieee-mtts
title: IEEE MTT-S Chapter Support — funder overlay
layer: funder
order: 60
appliesTo: [adjacent_stem, ham_grant]
funderId: ieee-mtts
programIds: [ieee-mtts-chapter-support]
requires: [project-description, measurable-outcomes, activities-timeline, budget-justification]
lengthTarget: short; this is a Jotform application, not a proposal
sources:
  - label: IEEE MTT-S chapter support page
    url: https://mtt.org/chapter-support/
---

## Three administrative preconditions decide eligibility first

Before anyone reads what you want the money for, the chapter must satisfy all three. Fix these in September, not on September 30.

1. **At least five chapter members.** {{chapter.memberCount}} members are currently on the roll.
2. **A current officer roster in IEEE vTools.** An out-of-date roster is the single most common disqualifier, because it is invisible until somebody checks. Roster: {{chapter.officerRosterUrl}}
3. **At least two meetings reported.** Reporting is separate from holding the meeting — a meeting that happened but was never reported in vTools does not count. Reported so far: {{chapter.meetingCount}}.

## What is available

- **$1,000 per year** for a single-society MTT-S Student Branch Chapter.
- **$500 per year** for a joint chapter shared with another society.
- Separately: ten undergraduate scholarships of $1,500 and three fellowships of $6,000.

The deadline is **October 1**, stated inline on the chapter support page, and the application is a Jotform.

## What to ask for

Chapter support money funds chapter activity: speakers, demonstrations, competition entry, meeting costs, and modest equipment tied to a technical programme. Tie every line to a dated event with an expected attendance.

> {{club.name}} requests {{project.requestAmount}} for {{project.title}}, running {{project.startDate}} to {{project.endDate}} at {{project.venue}}, reaching {{project.beneficiaryCount}} students.

An RF-adjacent amateur radio programme is a natural fit here — antenna measurement, spectrum demonstrations, software-defined radio workshops, a fox hunt with direction-finding hardware. Describe it in the society's own vocabulary: microwave theory and techniques, RF measurement, propagation.

## Overlay checklist

- [ ] Five or more chapter members on the roll
- [ ] vTools officer roster current, checked today
- [ ] Two or more meetings reported in vTools this year
- [ ] Every budget line tied to a dated event with expected attendance
- [ ] Submitted by October 1
```

Create `content/templates/funders/funder-yaesu-dr2x.md`:

```markdown
---
id: funder-yaesu-dr2x
title: Yaesu System Fusion DR-2X repeater programme — funder overlay
layer: funder
order: 70
appliesTo: [equipment_in_kind]
funderId: yaesu-usa
programIds: [yaesu-dr2x-repeater]
requires: [project-description, activities-timeline, budget-justification, sustainability]
lengthTarget: the application is a fillable PDF; keep supporting text under 400 words
sources:
  - label: Yaesu System Fusion programme landing page
    url: https://systemfusion.yaesu.com/
---

## This is a discounted purchase, not a grant

Nothing is given away. Your club pays **$1,450** for a DR-2X repeater, or **$1,860** for the DR-2X with the LAN-01A network module — a price below retail, offered to clubs, groups, organizations, and individuals in North America. Plan the money as a purchase, and plan the sustainability section around a repeater you now own and must keep running.

## The obligation

The repeater **must be on the air for 12 months**. Treat this as a commitment the club signs, not a formality: it requires a site, power, an antenna system, a coordinated frequency pair, and somebody responsible for it a year from now — a genuinely hard problem for a student organization whose officers turn over annually.

> The repeater will be installed at {{repeater.site}} on the pair {{repeater.frequency}}, coordinated by {{repeater.coordinator}}, and {{club.name}} ({{club.callsign}}) will keep it in service through {{project.endDate}}.

Before applying, have all four of these:

- [ ] A site with written permission and power
- [ ] A coordinated frequency pair from {{repeater.coordinator}}
- [ ] An antenna, feedline, and duplexer plan with prices
- [ ] A named person responsible for the repeater, plus the successor arrangement in the club's bylaws or a written handover

## Windows

Windows are ad-hoc, roughly two to four a year. The window verified on 2026-08-02 ran **June 3 to August 31, 2026**. The dates exist only inside the title line of a dated fillable PDF linked from the landing page, so they are easy to miss and easy to misread. Read the current PDF before assuming a window is open, and star this programme in GrantSpotter so a change event reaches you.

## Overlay checklist

- [ ] Site permission in writing
- [ ] Frequency pair coordinated
- [ ] Full installed cost budgeted, not just the repeater price
- [ ] 12-month on-air commitment has a named owner and a successor
- [ ] Current window read from today's PDF
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add content/templates/funders packages/server/src/templates/content.test.ts && \
  git commit -m "feat(templates): ARISS, IEEE MTT-S and Yaesu DR-2X funder overlays"
```

---

### Task 10: The Campus SGA playbook — the capital-equipment trap

Per the research, this overlay may be worth more than the entire opportunity index. Campus student-government money and NASA Space Grant are where a typical collegiate club's money actually comes from, and neither is aggregatable — roughly 4,000 campuses running heterogeneous Qualtrics, CampusGroups, Presence, and Engage forms. GrantSpotter ships this one as a **guided workflow**, not a feed.

The trap, exposed by Florida State University's published RSO funding rules and typical of student-activity-fee (A&S) rules generally: **capital equipment is frequently barred.** A club that asks student government for a transceiver is usually refused on a category rule before anyone considers the merits. The same club asking to fund a licensing class — instructor honorarium, room, printed manuals, exam session fees, refreshments — is asking for *programming*, which is exactly what the fee exists to fund.

So the playbook's job is to teach the reframe: **fund the programme from student government, and fund the capital from somewhere else.**

FSU's published figures, used as the representative example and labelled as such: programming up to $3,000 (up to $5,000 for extraordinary requests); travel $250 per student and $5,000 per organization; a Development Fund capped at $300 per fiscal year; rolling event and travel requests requiring at least six weeks' lead with a maximum of three per fiscal year, alongside an annual A&S budget cycle.

**Files:**
- Create: `content/templates/funders/funder-campus-sga.md`
- Modify: `packages/server/src/templates/content.test.ts` (add one `describe`)

**Interfaces:**
- Consumes: `loadTemplates()` from `./load.js`.
- Produces: playbook overlay `funder-campus-sga` with `alwaysAvailable: true` and `programIds: []`.

- [ ] **Step 1: Write the failing test**

Append to `packages/server/src/templates/content.test.ts`:

```ts
describe('funder layer — campus SGA playbook', () => {
  const sga = all.find((t) => t.id === 'funder-campus-sga');

  it('is always available and bound to no program id', () => {
    expect(sga).toBeDefined();
    expect(sga?.alwaysAvailable).toBe(true);
    expect(sga?.programIds).toEqual([]);
  });

  it('leads with the capital-equipment trap and the reframe', () => {
    expect(sga?.body).toMatch(/capital equipment/i);
    expect(sga?.body).toMatch(/barred|prohibited|not fundable/i);
    expect(sga?.body).toMatch(/programming/i);
    expect(sga?.body).toMatch(/funded externally|fund the capital/i);
  });

  it('gives at least four concrete reframes a club can copy', () => {
    const reframes = (sga?.body.match(/^\| /gm) ?? []).length;
    expect(reframes).toBeGreaterThanOrEqual(6);
    expect(sga?.body).toMatch(/licensing class/i);
    expect(sga?.body).toMatch(/Field Day/);
    expect(sga?.body).toMatch(/travel/i);
  });

  it('labels the FSU figures as one representative campus, never as universal', () => {
    expect(sga?.body).toMatch(/Florida State|FSU/);
    expect(sga?.body).toMatch(/representative|one campus|your campus will differ/i);
    expect(sga?.body).toMatch(/\$3,000/);
    expect(sga?.body).toMatch(/six weeks/i);
  });

  it('names the external routes for capital', () => {
    expect(sga?.body).toMatch(/department|dean|alumni/i);
    expect(sga?.slots).toContain('sga.fundingBody');
    expect(sga?.slots).toContain('sga.attendanceEstimate');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

Expected failure: `AssertionError: expected undefined to be defined`.

- [ ] **Step 3: Write the playbook**

Create `content/templates/funders/funder-campus-sga.md`:

```markdown
---
id: funder-campus-sga
title: Campus student government playbook
layer: funder
order: 80
appliesTo: []
alwaysAvailable: true
funderId: campus-sga
programIds: []
requires: [need-statement, project-description, budget-justification, activities-timeline]
lengthTarget: most SGA forms cap the narrative at 200-500 words
sources:
  - label: Florida State University SGA, funding your RSO (used here as one representative campus)
    url: https://sga.fsu.edu/accounting/funding-your-rso
---

## Why this playbook exists

Student government is the most reliably available money a collegiate club can reach, and it is the only funder in this app that is not in the index — there are roughly 4,000 campuses running their own forms on their own software with their own rules. GrantSpotter cannot list yours. What it can do is tell you the rule that decides most amateur radio requests before anyone reads them.

## The trap: capital equipment is frequently barred

Student activity fee money — often called A&S funds — is usually restricted to **programming**: events, activities, and services that reach students. Most such rules explicitly exclude **capital equipment**, meaning durable goods the organization keeps. A transceiver is durable goods.

The consequence is blunt. A ham club that asks student government for a radio is usually refused on a category rule, not on merit, and the officers conclude that student government does not fund ham radio. That conclusion is wrong. Student government funds what ham clubs *do*; it does not buy what ham clubs *own*.

**The reframe: fund the programme from student government, and fund the capital from somewhere else.**

## Reframes you can copy

| Instead of asking for | Ask for | Why it clears the rule |
|---|---|---|
| A transceiver for the club station | A licensing class: instructor honorarium, room booking, printed study manuals, VE exam session fees, refreshments | Every line is programming that reaches a countable number of students |
| An antenna and feedline | A Field Day or public demonstration event: site fee, generator rental, safety equipment, food, printed materials | It is a dated public event with attendance |
| A software-defined radio for the shack | A workshop series: consumable kits students take home, instructor time, room | Consumables that students keep are often treated differently from club-retained equipment |
| A tower or repeater | Travel to a hamfest, conference, or contest: registration, transport, lodging under the per-student cap | Travel is usually its own category with its own cap |
| "General operating support" | A named event on a named date with an attendance estimate | Operating support is almost never fundable; events almost always are |
| Equipment the club keeps | Equipment purchased **by the department** and loaned to the club | The asset sits on the department's inventory, which is where capital belongs |

## The capital still has to come from somewhere

Run these in parallel with the SGA request, and say in the SGA request that you are doing so:

- **Your academic department or college.** ECE, physics, and engineering departments buy lab equipment routinely and can hold the asset on their inventory. This is the single most common way a collegiate station actually gets a radio.
- **The dean's office or a student success fund**, which often has discretionary money outside the activity fee rules.
- **Alumni.** A club with a callsign has alumni who hold licences. The development office can usually find them.
- **The grant programmes in this app** — ARRL Amateur Radio Grants and the ARRL Club Grant Program both fund equipment that student government cannot.
- **Manufacturer relationships.** Icom, DX Engineering, and Kenwood have given real equipment to collegiate clubs, but there is no application, no page, and no deadline — it is relationship-driven, and it starts with a named person at the company and a faculty advisor's introduction.

## One representative campus, for calibration

These are Florida State University's published figures as of the 2026-08-02 research pass. **Your campus will differ** — treat these as an indication of scale, never as your rules:

- Programming requests up to **$3,000**, or up to **$5,000** for an extraordinary request
- Travel at **$250 per student** and **$5,000 per organization**
- A Development Fund capped at **$300 per fiscal year**
- Rolling event and travel requests requiring at least **six weeks** of lead time, with a maximum of three per fiscal year
- A separate **annual A&S budget cycle** for the following year's baseline

The six-week lead time is the number that most often catches clubs. A Field Day request submitted in May for a June event is dead on arrival regardless of quality.

## Find your own rules in ten minutes

1. Search your student government site for "RSO funding", "A&S funds", "allocation request", or "student organization budget".
2. Find the document that lists **unallowable expenses**. That is the real ruleset. Read it before you write anything.
3. Note the lead time, the per-request cap, the per-year cap, and the number of requests allowed per year.
4. Note who sits on the committee and when it meets. Attending the meeting in person changes outcomes more than the form does.
5. Find last year's funded requests if they are published, and match your language to the ones that were approved.

## Draft skeleton

**Request to {{sga.fundingBody}}**

{{club.name}} ({{club.callsign}}) requests {{project.requestAmount}} for {{project.title}}, a {{project.deliverable}} open to all students, held at {{project.venue}} on {{sga.eventDate}}.

**Who attends.** {{sga.attendanceEstimate}}

> Say how you got that number. Last year's attendance, current membership, or the capacity of the room are all defensible; a guess is not.

**What the money buys.**

> Line items only, each one clearly programming rather than equipment the club keeps. Unit prices and a source for each.

**Who does the work.** {{team.leadName}}, {{team.leadRole}}, with {{club.memberCount}} club members volunteering.

**How students hear about it.**

> Committees fund events students will actually attend. Name the channels and the dates you will post.

## Overlay checklist

- [ ] Read your campus's unallowable-expense list before writing
- [ ] Nothing in the request is durable equipment the club retains
- [ ] Submitted with more lead time than the published minimum
- [ ] Attendance estimate has a stated basis
- [ ] A parallel route identified for any capital you still need
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add content/templates/funders/funder-campus-sga.md packages/server/src/templates/content.test.ts && \
  git commit -m "feat(templates): campus SGA playbook with the capital-equipment reframe"
```

---

### Task 11: NASA State Space Grant overlay and the 52-consortium picker

NASA's National Space Grant College and Fellowship Program runs through **52 independent consortia** — one per state, plus the District of Columbia and Puerto Rico. There is **no national deadline** and no national application: each consortium runs its own calendar, its own award types, and its own website. Consortium-level student awards typically run $1,000 to $10,000, and this is the most common real route to a campus ground station or cubesat.

Because there is no national feed, this ships as a **state-keyed picker**: the user's state selects one of 52 curated records, and the overlay tells them what to do next.

**An honesty decision that shapes the data file.** These 52 lead institutions and URLs were assembled offline and have **not** been verified by a live fetch. Presenting them as verified would be exactly the fabrication this app exists to prevent. So every record ships with `verified: false` and a `directoryUrl` pointing at NASA's own consortium directors directory, the UI renders the amber unverified treatment from spec §8, and a test asserts that no record can claim verification. Plan 2's `verify-sources` can promote them later.

**Files:**
- Create: `data/reference/space-grant-consortia.json`
- Create: `packages/server/src/templates/consortia.ts`
- Create: `packages/server/src/templates/consortia.test.ts`
- Create: `content/templates/funders/funder-nasa-space-grant.md`
- Modify: `packages/server/src/templates/content.test.ts` (add one `describe`)

**Interfaces:**
- Consumes: `contentRoot()` from `./load.js` (to locate the repo root), `loadTemplates()`.
- Produces: `SpaceGrantConsortium`, `loadConsortia(root?)`, `pickConsortium(state, root?)`, overlay `funder-nasa-space-grant` (binds `nasa-space-grant`).

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/templates/consortia.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConsortia, pickConsortium } from './consortia.js';

const all = loadConsortia();

describe('space grant consortia reference data', () => {
  it('covers all 50 states plus DC and Puerto Rico', () => {
    expect(all.length).toBe(52);
    const codes = new Set(all.map((c) => c.state));
    expect(codes.size).toBe(52);
    for (const code of ['AL', 'AK', 'CA', 'DC', 'MI', 'PR', 'TX', 'WY']) expect(codes.has(code)).toBe(true);
  });

  it('never claims verification it does not have', () => {
    for (const c of all) {
      expect(c.verified, `${c.state} must not claim verification`).toBe(false);
      expect(c.directoryUrl).toMatch(/^https:\/\/(www\.)?nasa\.gov\//);
      expect(c.name).toMatch(/Space Grant/);
      expect(c.note.length).toBeGreaterThan(10);
    }
  });

  it('has no placeholder or private host anywhere in the file', () => {
    const blob = JSON.stringify(all);
    expect(blob).not.toMatch(/192\.168\.|10\.\d+\.|localhost/);
  });
});

describe('pickConsortium', () => {
  it('resolves a two-letter state code case-insensitively', () => {
    expect(pickConsortium('mi')?.name).toMatch(/Michigan Space Grant/);
    expect(pickConsortium('MI')?.state).toBe('MI');
  });

  it('returns undefined for an unknown code rather than guessing', () => {
    expect(pickConsortium('ZZ')).toBeUndefined();
    expect(pickConsortium('')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/consortia.test.ts
```

Expected failure: `Error: Failed to resolve import "./consortia.js"`.

- [ ] **Step 3: Write the reference data file**

Create `data/reference/space-grant-consortia.json`. Every record carries `verified: false` deliberately — the note explains why.

```json
{
  "_meta": {
    "description": "NASA National Space Grant College and Fellowship Program: 52 consortia (50 states + DC + Puerto Rico). There is no national deadline; each consortium runs its own calendar.",
    "assembledAt": "2026-08-02",
    "verificationMethod": "manual_curation",
    "warning": "Lead institutions and consortium URLs were assembled offline and are NOT live-verified. Every record carries verified:false and the UI must render the unverified treatment with a link to NASA's consortium directors directory. Do not flip verified to true without a live fetch recorded by verify-sources.",
    "directoryUrl": "https://www.nasa.gov/stem/spacegrant/about/consortium-directors/"
  },
  "consortia": [
    { "state": "AL", "name": "Alabama Space Grant Consortium", "leadInstitution": "The University of Alabama in Huntsville" },
    { "state": "AK", "name": "Alaska Space Grant Program", "leadInstitution": "University of Alaska Fairbanks" },
    { "state": "AZ", "name": "Arizona Space Grant Consortium", "leadInstitution": "University of Arizona" },
    { "state": "AR", "name": "Arkansas Space Grant Consortium", "leadInstitution": "University of Arkansas at Little Rock" },
    { "state": "CA", "name": "California Space Grant Consortium", "leadInstitution": "University of California San Diego" },
    { "state": "CO", "name": "Colorado Space Grant Consortium", "leadInstitution": "University of Colorado Boulder" },
    { "state": "CT", "name": "Connecticut Space Grant Consortium", "leadInstitution": "University of Hartford" },
    { "state": "DE", "name": "Delaware Space Grant Consortium", "leadInstitution": "University of Delaware" },
    { "state": "DC", "name": "District of Columbia Space Grant Consortium", "leadInstitution": "American University" },
    { "state": "FL", "name": "Florida Space Grant Consortium", "leadInstitution": "University of Central Florida" },
    { "state": "GA", "name": "Georgia Space Grant Consortium", "leadInstitution": "Georgia Institute of Technology" },
    { "state": "HI", "name": "Hawaii Space Grant Consortium", "leadInstitution": "University of Hawaii at Manoa" },
    { "state": "ID", "name": "Idaho Space Grant Consortium", "leadInstitution": "University of Idaho" },
    { "state": "IL", "name": "Illinois Space Grant Consortium", "leadInstitution": "University of Illinois Urbana-Champaign" },
    { "state": "IN", "name": "Indiana Space Grant Consortium", "leadInstitution": "Purdue University" },
    { "state": "IA", "name": "Iowa Space Grant Consortium", "leadInstitution": "Iowa State University" },
    { "state": "KS", "name": "Kansas Space Grant Consortium", "leadInstitution": "Wichita State University" },
    { "state": "KY", "name": "Kentucky Space Grant Consortium", "leadInstitution": "University of Kentucky" },
    { "state": "LA", "name": "Louisiana Space Grant Consortium", "leadInstitution": "Louisiana State University" },
    { "state": "ME", "name": "Maine Space Grant Consortium", "leadInstitution": "Maine Space Grant Consortium" },
    { "state": "MD", "name": "Maryland Space Grant Consortium", "leadInstitution": "Johns Hopkins University" },
    { "state": "MA", "name": "Massachusetts Space Grant Consortium", "leadInstitution": "Massachusetts Institute of Technology" },
    { "state": "MI", "name": "Michigan Space Grant Consortium", "leadInstitution": "University of Michigan" },
    { "state": "MN", "name": "Minnesota Space Grant Consortium", "leadInstitution": "University of Minnesota" },
    { "state": "MS", "name": "Mississippi Space Grant Consortium", "leadInstitution": "University of Mississippi" },
    { "state": "MO", "name": "Missouri Space Grant Consortium", "leadInstitution": "Missouri University of Science and Technology" },
    { "state": "MT", "name": "Montana Space Grant Consortium", "leadInstitution": "Montana State University" },
    { "state": "NE", "name": "Nebraska Space Grant Consortium", "leadInstitution": "University of Nebraska Omaha" },
    { "state": "NV", "name": "Nevada Space Grant Consortium", "leadInstitution": "Nevada System of Higher Education" },
    { "state": "NH", "name": "New Hampshire Space Grant Consortium", "leadInstitution": "University of New Hampshire" },
    { "state": "NJ", "name": "New Jersey Space Grant Consortium", "leadInstitution": "Rutgers, The State University of New Jersey" },
    { "state": "NM", "name": "New Mexico Space Grant Consortium", "leadInstitution": "New Mexico State University" },
    { "state": "NY", "name": "New York Space Grant Consortium", "leadInstitution": "Cornell University" },
    { "state": "NC", "name": "North Carolina Space Grant Consortium", "leadInstitution": "North Carolina State University" },
    { "state": "ND", "name": "North Dakota Space Grant Consortium", "leadInstitution": "University of North Dakota" },
    { "state": "OH", "name": "Ohio Space Grant Consortium", "leadInstitution": "Ohio Aerospace Institute" },
    { "state": "OK", "name": "Oklahoma Space Grant Consortium", "leadInstitution": "University of Oklahoma" },
    { "state": "OR", "name": "Oregon Space Grant Consortium", "leadInstitution": "Oregon State University" },
    { "state": "PA", "name": "Pennsylvania Space Grant Consortium", "leadInstitution": "The Pennsylvania State University" },
    { "state": "PR", "name": "Puerto Rico Space Grant Consortium", "leadInstitution": "University of Puerto Rico" },
    { "state": "RI", "name": "Rhode Island Space Grant Consortium", "leadInstitution": "Brown University" },
    { "state": "SC", "name": "South Carolina Space Grant Consortium", "leadInstitution": "College of Charleston" },
    { "state": "SD", "name": "South Dakota Space Grant Consortium", "leadInstitution": "South Dakota School of Mines and Technology" },
    { "state": "TN", "name": "Tennessee Space Grant Consortium", "leadInstitution": "Vanderbilt University" },
    { "state": "TX", "name": "Texas Space Grant Consortium", "leadInstitution": "Texas A&M University" },
    { "state": "UT", "name": "Utah Space Grant Consortium", "leadInstitution": "Utah State University" },
    { "state": "VT", "name": "Vermont Space Grant Consortium", "leadInstitution": "University of Vermont" },
    { "state": "VA", "name": "Virginia Space Grant Consortium", "leadInstitution": "Virginia Space Grant Consortium" },
    { "state": "WA", "name": "Washington NASA Space Grant Consortium", "leadInstitution": "University of Washington" },
    { "state": "WV", "name": "West Virginia Space Grant Consortium", "leadInstitution": "West Virginia University" },
    { "state": "WI", "name": "Wisconsin Space Grant Consortium", "leadInstitution": "Carthage College" },
    { "state": "WY", "name": "Wyoming Space Grant Consortium", "leadInstitution": "University of Wyoming" }
  ]
}
```

- [ ] **Step 4: Write the consortium loader**

Create `packages/server/src/templates/consortia.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { contentRoot } from './load.js';

export interface SpaceGrantConsortium {
  state: string;
  name: string;
  leadInstitution: string;
  /**
   * Always false in the shipped file. The lead institutions and URLs were
   * assembled offline and have not been confirmed by a live fetch, so the UI
   * renders them with the unverified treatment and a link to NASA's directory.
   * Only verify-sources may ever promote a record.
   */
  verified: boolean;
  directoryUrl: string;
  note: string;
}

interface ConsortiaFile {
  _meta: { directoryUrl: string; warning: string; assembledAt: string };
  consortia: Array<{ state: string; name: string; leadInstitution: string }>;
}

export function referenceRoot(): string {
  return path.join(path.dirname(contentRoot()), 'data', 'reference');
}

let cache: SpaceGrantConsortium[] | undefined;

export function loadConsortia(root: string = referenceRoot()): SpaceGrantConsortium[] {
  if (cache && root === referenceRoot()) return cache;
  const file = path.join(root, 'space-grant-consortia.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as ConsortiaFile;
  const note =
    'Lead institution and consortium website were curated offline on ' +
    parsed._meta.assembledAt +
    ' and have not been confirmed by a live fetch. Confirm against NASA’s consortium directors directory before relying on them.';
  const out = parsed.consortia.map((c) => ({
    state: c.state.toUpperCase(),
    name: c.name,
    leadInstitution: c.leadInstitution,
    verified: false,
    directoryUrl: parsed._meta.directoryUrl,
    note,
  }));
  if (root === referenceRoot()) cache = out;
  return out;
}

export function pickConsortium(state: string, root?: string): SpaceGrantConsortium | undefined {
  const code = state.trim().toUpperCase();
  if (code.length !== 2) return undefined;
  return loadConsortia(root).find((c) => c.state === code);
}
```

- [ ] **Step 5: Run the consortium test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/consortia.test.ts
```

- [ ] **Step 6: Write the failing overlay test**

Append to `packages/server/src/templates/content.test.ts`:

```ts
describe('funder layer — NASA State Space Grant', () => {
  const sg = all.find((t) => t.id === 'funder-nasa-space-grant');

  it('exists and binds to the space grant program', () => {
    expect(sg).toBeDefined();
    expect(sg?.programIds).toEqual(['nasa-space-grant']);
  });

  it('states that there is no national deadline and 52 independent calendars', () => {
    expect(sg?.body).toMatch(/52/);
    expect(sg?.body).toMatch(/no national deadline/i);
    expect(sg?.slots).toContain('consortium.name');
    expect(sg?.slots).toContain('consortium.url');
  });

  it('warns that the shipped consortium list is unverified', () => {
    expect(sg?.body).toMatch(/unverified|not been (live-)?verified/i);
    expect(sg?.sources.some((s) => /nasa\.gov/.test(s.url))).toBe(true);
  });
});
```

- [ ] **Step 7: Run it, watch it fail, then write the overlay**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/templates/content.test.ts
```

Expected failure: `AssertionError: expected undefined to be defined`.

Create `content/templates/funders/funder-nasa-space-grant.md`:

```markdown
---
id: funder-nasa-space-grant
title: NASA State Space Grant — funder overlay and consortium picker
layer: funder
order: 85
appliesTo: [adjacent_stem, ham_grant]
funderId: nasa-space-grant
programIds: [nasa-space-grant]
requires: [need-statement, project-description, measurable-outcomes, activities-timeline, budget-justification, evaluation-plan]
lengthTarget: follow your consortium's form; most cap the narrative at 2-5 pages
sources:
  - label: NASA Space Grant consortium directors directory
    url: https://www.nasa.gov/stem/spacegrant/about/consortium-directors/
---

## There is no national deadline

NASA's National Space Grant College and Fellowship Program runs through **52 independent consortia** — one for each state, plus the District of Columbia and Puerto Rico. Each has its own calendar, its own award types, its own forms, and its own website. There is no national application and **no national deadline**, which is why this program cannot be a feed and is instead a picker.

Consortium-level student awards typically run **$1,000 to $10,000**. For a collegiate amateur radio group, this is the most common real route to a ground station, a balloon payload, or a cubesat: the science framing is already native to the hobby, and the consortia are explicitly looking for student projects.

## Your consortium

{{consortium.name}} — {{consortium.url}}

> GrantSpotter fills these from your profile state. **The shipped consortium list is unverified**: lead institutions and websites were curated offline and have not been confirmed by a live fetch, so they appear with an amber unverified badge and a link to NASA's own consortium directors directory. Confirm the name and the URL there before you rely on either.

## What to do, in order

1. Open your consortium's website from the NASA directory and find its **student opportunities** or **research infrastructure** page.
2. Note every award type it runs and its deadline. Consortia commonly offer several: undergraduate scholarships, graduate fellowships, research seed grants, hardware or "student launch" grants, and K-12 outreach money.
3. Identify whether the consortium requires an **affiliate institution**. Many disburse only through member campuses. If your school is not affiliated, find the nearest affiliate and ask about a partnership.
4. Find the **campus Space Grant representative** at your institution. Nearly every affiliate has one, they are usually a faculty member, and they generally know how the money moves. This conversation is worth more than the application text.
5. Check the **matching requirement.** Space Grant is a matching program at the consortium level, and some consortia pass that requirement down to sub-awards. Ask before you build the budget.

## How to frame an amateur radio project here

Consortia fund aerospace-relevant student work. Amateur radio maps onto that directly, and the mapping is honest rather than cosmetic — say it in their vocabulary:

- A satellite ground station is **telemetry, tracking, and command**, and it supports cubesat operations.
- A high-altitude balloon payload with an APRS tracker is **atmospheric science plus telemetry**.
- Ionospheric propagation experiments are **space weather**, which is squarely in the program's remit.
- Every one of these is **student workforce development**, which is the program's actual statutory purpose.

> {{club.name}} ({{club.callsign}}) at {{club.institution}} requests {{project.requestAmount}} from {{consortium.name}} for {{project.title}}, running {{project.startDate}} to {{project.endDate}} and involving {{project.beneficiaryCount}} students.

State the student involvement in headcounts and hours. Consortia report to NASA on students touched, and an application that hands them that number in the form they need is easier to fund.

## Overlay checklist

- [ ] Consortium name and URL confirmed against the NASA directory
- [ ] Campus Space Grant representative identified and contacted
- [ ] Award type chosen deliberately, with its own deadline noted
- [ ] Matching requirement confirmed before the budget is built
- [ ] Project framed in the consortium's vocabulary, with student headcount and hours
```

- [ ] **Step 8: Run both tests and commit**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  npx vitest run packages/server/src/templates/ && \
  git add content/templates/funders/funder-nasa-space-grant.md data/reference/space-grant-consortia.json packages/server/src/templates && \
  git commit -m "feat(templates): NASA Space Grant overlay with an unverified-by-design 52-consortium picker"
```

---

### Task 12: Prose analyzer foundations — sentences, tokens, the style lexicon, proper nouns and figures

The analyzer's job is to explain *why* a passage reads generic and *where*, without a score and without an API key.

**The grounding, which decides the whole design.** Kobak et al., *Science Advances* 2025 (DOI 10.1126/sciadv.adt3813) measured word frequencies across more than 15 million PubMed abstracts and found 379 "excess vocabulary" words in 2024. The finding that matters is not the word list — it is the grammar of the shift. 2024's excess vocabulary was **66% verbs and 14% adjectives**, almost entirely style words. The Covid-era excess vocabulary of 2020–2022 was **79% nouns**, almost entirely content words.

> A real event changes the **nouns** in a document. A language model changes the **verbs and the adjectives.**

So the signal is **style-word density without referential counterweight** — style words with no proper nouns, no figures, and no dates near them. `potential`, `findings` and `comprehensive` are ordinary English and appear in excellent proposals; the module therefore **reports density, never bans a word**.

This task builds the measurement primitives. Task 13 assembles them into `analyzeProse`.

Two heuristics worth stating explicitly, because they are the ones a reviewer will question:
- **Sentence-initial capitalized words do not count as proper nouns** unless they are all-caps, match a callsign or model-number pattern, or the same token appears capitalized mid-sentence somewhere in the document. This avoids counting "Members" and "Three" as proper nouns without needing a dictionary.
- **Number words count as figures.** "Three of our members" is a claim of scale with a figure in it, and the analyzer should say so.

**Files:**
- Create: `packages/server/src/prose/lexicon.ts`
- Create: `packages/server/src/prose/features.ts`
- Create: `packages/server/src/prose/features.test.ts`

**Interfaces:**
- Consumes: nothing. `prose/` is pure — no imports outside itself.
- Produces: `STYLE_WORDS`, `BANNED_TRANSITIONS`, `WATCH_TRANSITIONS`, `STOCK_OPENERS`, `STOCK_CLOSERS`, `NUMBER_WORDS`, `PARTICIPLE_ALLOWLIST`, `ABBREVIATIONS`; and `splitParagraphs`, `splitSentences`, `tokenize`, `isFigureToken`, `styleWordHits`, `buildDocIndex`, `countProperNouns`, `countFigures`, `variance`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/prose/features.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildDocIndex,
  countFigures,
  countProperNouns,
  isFigureToken,
  splitParagraphs,
  splitSentences,
  styleWordHits,
  tokenize,
  variance,
} from './features.js';

describe('splitParagraphs', () => {
  it('splits on blank lines and drops empties', () => {
    expect(splitParagraphs('one\n\ntwo\n\n\n  \n\nthree')).toEqual(['one', 'two', 'three']);
  });
});

describe('splitSentences', () => {
  it('splits on terminal punctuation followed by whitespace', () => {
    expect(splitSentences('We met. They left! Did they? Yes.')).toEqual([
      'We met.',
      'They left!',
      'Did they?',
      'Yes.',
    ]);
  });

  it('does not split on a decimal point', () => {
    expect(splitSentences('Our GPA floor is 3.5 for that award.')).toHaveLength(1);
  });

  it('does not split on a known abbreviation or an initial', () => {
    expect(splitSentences('Dr. Ruiz teaches it. She is a General.')).toEqual([
      'Dr. Ruiz teaches it.',
      'She is a General.',
    ]);
    expect(splitSentences('J. Hall signed the form.')).toHaveLength(1);
  });
});

describe('tokenize', () => {
  it('keeps model numbers, callsigns and money together and strips trailing punctuation', () => {
    expect(tokenize('We bought an IC-7300, a GP-3, and paid $1,450. W8UM logged it.')).toEqual([
      'We', 'bought', 'an', 'IC-7300', 'a', 'GP-3', 'and', 'paid', '$1,450', 'W8UM', 'logged', 'it',
    ]);
  });
});

describe('isFigureToken', () => {
  it('accepts bare numbers, money, percentages and number words', () => {
    for (const t of ['24', '2027', '3.5', '$1,450', '20%', 'three', 'Twelve']) {
      expect(isFigureToken(t), t).toBe(true);
    }
  });

  it('rejects callsigns and model numbers', () => {
    for (const t of ['W8UM', 'IC-7300', 'GP-3', 'KD9XYZ']) expect(isFigureToken(t), t).toBe(false);
  });
});

describe('styleWordHits', () => {
  it('matches inflected forms without banning ordinary words outright', () => {
    const hits = styleWordHits(tokenize('This delves into the transformative potential of showcasing insights.'));
    expect(hits).toContain('delves');
    expect(hits).toContain('transformative');
    expect(hits).toContain('potential');
    expect(hits).toContain('showcasing');
    expect(hits).toContain('insights');
  });

  it('finds nothing in a concrete sentence', () => {
    expect(styleWordHits(tokenize('Dana Ruiz will teach four sessions in Room 214 on March 7.'))).toEqual([]);
  });
});

describe('countProperNouns', () => {
  const doc = (text: string) => buildDocIndex(text);

  it('counts mid-sentence capitals, all-caps tokens, callsigns and model numbers', () => {
    const text = 'The club bought an Icom IC-7300 for W8UM at Example State University.';
    expect(countProperNouns(text, doc(text))).toBe(6); // Icom, IC-7300, W8UM, Example, State, University
  });

  it('does not count an ordinary sentence-initial word', () => {
    const text = 'Members who want to operate often leave without a contact.';
    expect(countProperNouns(text, doc(text))).toBe(0);
  });

  it('counts a sentence-initial word that appears capitalized mid-sentence elsewhere', () => {
    const text = 'The class was taught by Dana Ruiz. Dana teaches every spring.';
    expect(countProperNouns(text, doc(text))).toBe(3); // Dana, Ruiz, Dana
  });
});

describe('countFigures and variance', () => {
  it('counts every figure token in a paragraph', () => {
    expect(countFigures(tokenize('24 students met on March 7, 2027 and paid $15 each.'))).toBe(4);
  });

  it('computes population variance', () => {
    expect(variance([])).toBe(0);
    expect(variance([10, 10, 10])).toBe(0);
    expect(variance([5, 15])).toBe(25);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/prose/features.test.ts
```

Expected failure: `Error: Failed to resolve import "./features.js"`.

- [ ] **Step 3: Write the lexicon**

Create `packages/server/src/prose/lexicon.ts`:

```ts
/**
 * Lexicons for the offline generic-prose analyzer.
 *
 * IMPORTANT: STYLE_WORDS is NOT a blacklist and the analyzer never bans a word.
 * These are ordinary English words that appear in excellent proposals. They are
 * drawn from the excess-vocabulary finding in Kobak et al., Science Advances
 * 2025 (DOI 10.1126/sciadv.adt3813), whose load-bearing result is grammatical:
 * 2024's excess vocabulary was 66% verbs and 14% adjectives — style words —
 * against 79% nouns in the Covid-era baseline — content words. A real event
 * changes the nouns; a language model changes the verbs and adjectives.
 *
 * The analyzer therefore reports STYLE-WORD DENSITY RELATIVE TO PROPER NOUNS
 * AND FIGURES. A paragraph full of these words next to callsigns, dates and
 * dollar amounts is fine. The same words with nothing referential nearby are
 * the signal.
 *
 * Matching is by stem, so only base forms are listed; features.ts derives
 * plural, past, gerund and adverbial forms.
 */

/** Verbs — the largest class in the 2024 finding. */
const STYLE_VERBS = [
  'delve', 'underscore', 'showcase', 'leverage', 'foster', 'facilitate', 'harness',
  'streamline', 'unveil', 'spearhead', 'cultivate', 'augment', 'amplify', 'elucidate',
  'encompass', 'garner', 'bolster', 'empower', 'enhance', 'enable', 'align', 'drive',
  'unlock', 'navigate', 'illuminate', 'exemplify', 'highlight', 'emphasize', 'reinforce',
  'exhibit', 'reflect', 'demonstrate', 'ensure', 'strive', 'embark', 'transform',
];

/** Adjectives and their adverbial forms — the second class in the finding. */
const STYLE_ADJECTIVES = [
  'transformative', 'comprehensive', 'robust', 'seamless', 'meticulous', 'noteworthy',
  'commendable', 'holistic', 'nuanced', 'invaluable', 'unwavering', 'vibrant', 'dynamic',
  'innovative', 'strategic', 'impactful', 'meaningful', 'crucial', 'vital', 'pivotal',
  'intricate', 'groundbreaking', 'cutting-edge', 'state-of-the-art', 'profound',
  'remarkable', 'exceptional', 'compelling', 'significant', 'substantial', 'multifaceted',
  'unprecedented', 'unparalleled', 'diverse', 'inclusive', 'sustainable', 'scalable',
];

/** Abstract nouns that do reference work in name only. */
const STYLE_NOUNS = [
  'potential', 'insight', 'finding', 'realm', 'landscape', 'tapestry', 'paradigm',
  'endeavor', 'endeavour', 'myriad', 'plethora', 'framework', 'initiative', 'synergy',
  'ecosystem', 'journey', 'commitment', 'dedication', 'passion', 'excellence',
  'engagement', 'awareness', 'capacity', 'resilience', 'innovation', 'opportunity',
  'impact', 'outcome', 'stakeholder', 'utilization', 'implementation', 'optimization',
];

/** Hedges and intensifiers flagged in the same study. */
const STYLE_ADVERBS = [
  'notably', 'particularly', 'significantly', 'substantially', 'crucially', 'importantly',
  'effectively', 'seamlessly', 'holistically', 'ultimately', 'fundamentally', 'increasingly',
];

export const STYLE_WORDS: ReadonlySet<string> = new Set([
  ...STYLE_VERBS,
  ...STYLE_ADJECTIVES,
  ...STYLE_NOUNS,
  ...STYLE_ADVERBS,
]);

/** Banned outright by the style ruleset. None of these carries information. */
export const BANNED_TRANSITIONS: readonly string[] = [
  'Furthermore',
  'Moreover',
  'Additionally',
  'It is important to note that',
];

/** Reported but not banned: common, and sometimes legitimate. */
export const WATCH_TRANSITIONS: readonly string[] = [
  'In addition',
  'It is worth noting',
  'Notably',
  'Importantly',
  'In conclusion',
  'Overall',
  'Ultimately',
  'That being said',
];

export const STOCK_OPENERS: readonly string[] = [
  "In today's rapidly evolving landscape",
  "In today's fast-paced world",
  'In an era of',
  'In the ever-evolving world of',
  'Since the dawn of',
  'It is no secret that',
  'In recent years, there has been a growing',
  'Now more than ever',
];

export const STOCK_CLOSERS: readonly string[] = [
  'ensuring long-term impact for years to come',
  'for years to come',
  'we look forward to partnering with you',
  'a lasting impact',
  'make a difference in the lives of',
  'In conclusion',
];

/** Counted as figures: a claim of scale with a number word in it is still a figure. */
export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'dozen', 'hundred', 'thousand', 'million',
]);

/** Participles after a comma that are prepositional rather than the stylistic tail. */
export const PARTICIPLE_ALLOWLIST: ReadonlySet<string> = new Set([
  'including', 'regarding', 'concerning', 'following', 'featuring', 'pending',
  'during', 'notwithstanding', 'excluding', 'depending', 'starting', 'beginning',
  'ranging', 'using', 'covering', 'spanning', 'according',
]);

/** Lowercased, without the trailing period, for the sentence splitter. */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'ave', 'inc', 'co', 'vs', 'etc', 'no',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'approx', 'fig', 'dept', 'e.g', 'i.e', 'u.s',
]);
```

- [ ] **Step 4: Write the feature extractors**

Create `packages/server/src/prose/features.ts`:

```ts
import { ABBREVIATIONS, NUMBER_WORDS, STYLE_WORDS } from './lexicon.js';

const CALLSIGN_RE = /^[A-Z]{1,2}\d{1,2}[A-Z]{1,4}$/;
const MODEL_RE = /^[A-Z]{1,4}-?\d{2,5}[A-Z]?$/;
const FIGURE_RE = /^\$?\d[\d,]*(?:\.\d+)?%?$/;

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Sentence splitter. Deliberately conservative: it will under-split rather than
 * split inside "3.5", "Dr. Ruiz" or "J. Hall", because an over-split sentence
 * corrupts both the length-variance figure and the sentence-initial rule that
 * proper-noun counting depends on.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    let j = i + 1;
    while (j < text.length && '.!?"\')]'.includes(text[j] as string)) j++;
    if (j < text.length && !/\s/.test(text[j] as string)) continue; // e.g. "3.5"

    if (ch === '.') {
      const before = text.slice(start, i);
      const lastWord = (/([A-Za-z.]+)$/.exec(before)?.[1] ?? '').toLowerCase();
      if (ABBREVIATIONS.has(lastWord) || /^[a-z]$/.test(lastWord)) continue;
    }

    const sentence = text.slice(start, j).trim();
    if (sentence) out.push(sentence);
    start = j;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function tokenize(text: string): string[] {
  const raw = text.match(/[A-Za-z0-9$][A-Za-z0-9'’$%.,\-]*/g) ?? [];
  return raw.map((t) => t.replace(/[.,;:'’\-]+$/, '')).filter((t) => t.length > 0);
}

export function isFigureToken(token: string): boolean {
  return FIGURE_RE.test(token) || NUMBER_WORDS.has(token.toLowerCase());
}

/** Base forms this token could inflect from, so the lexicon lists base forms only. */
function stemCandidates(token: string): string[] {
  const t = token.toLowerCase().replace(/[^a-z-]/g, '');
  const out = [t];
  const strip = (suffix: string): void => {
    if (t.length <= suffix.length + 2 || !t.endsWith(suffix)) return;
    const base = t.slice(0, t.length - suffix.length);
    out.push(base, base + 'e');
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) out.push(base.slice(0, -1));
  };
  strip('s');
  strip('es');
  strip('ed');
  strip('ing');
  strip('ly');
  return out;
}

/** Returns the ORIGINAL tokens that hit the style lexicon, in order. */
export function styleWordHits(tokens: string[]): string[] {
  const hits: string[] = [];
  for (const token of tokens) {
    if (stemCandidates(token).some((c) => STYLE_WORDS.has(c))) hits.push(token);
  }
  return hits;
}

export interface DocIndex {
  /** Tokens observed capitalized in a non-initial position anywhere in the document. */
  midSentenceCapitalized: Set<string>;
}

export function buildDocIndex(text: string): DocIndex {
  const midSentenceCapitalized = new Set<string>();
  for (const para of splitParagraphs(text)) {
    for (const sentence of splitSentences(para)) {
      const tokens = tokenize(sentence);
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i] as string;
        if (/^[A-Z]/.test(t) && !isFigureToken(t) && t !== 'I') midSentenceCapitalized.add(t);
      }
    }
  }
  return { midSentenceCapitalized };
}

function isStrongProperNoun(token: string): boolean {
  if (CALLSIGN_RE.test(token)) return true;
  if (MODEL_RE.test(token)) return true;
  return token.length >= 2 && /^[A-Z][A-Z0-9-]*$/.test(token);
}

/**
 * A sentence-initial capital is not evidence of a proper noun — every sentence
 * starts with one. It counts only when it is all-caps, a callsign, a model
 * number, or a token seen capitalized mid-sentence elsewhere in the document.
 * That keeps "Members who want to operate…" from scoring as a named actor.
 */
export function countProperNouns(paragraph: string, doc: DocIndex): number {
  let n = 0;
  for (const sentence of splitSentences(paragraph)) {
    const tokens = tokenize(sentence);
    tokens.forEach((token, i) => {
      if (!/^[A-Z]/.test(token)) return;
      if (isFigureToken(token) || token === 'I') return;
      if (i === 0) {
        if (isStrongProperNoun(token) || doc.midSentenceCapitalized.has(token)) n++;
        return;
      }
      n++;
    });
  }
  return n;
}

export function countFigures(tokens: string[]): number {
  return tokens.filter(isFigureToken).length;
}

/** Population variance. Zero for an empty list. */
export function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/prose/features.test.ts
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add packages/server/src/prose && \
  git commit -m "feat(prose): sentence, token, style-lexicon and referent-density primitives"
```

---

### Task 13: analyzeProse — the contract function, tested on known-generic and known-specific passages

This assembles the primitives into the frozen `ProseReport` shape. It **reports, it does not score**: there is no single number, and no paragraph is ever labelled "AI-written". Each paragraph gets a three-way verdict driven by two densities per 100 tokens:

- `referentDensity = (properNounCount + figureCount) / words × 100`
- `styleDensity = styleWordHits.length / words × 100`

Rules, evaluated in order:
1. **generic** when `referentDensity < 1.5`, or when `styleDensity ≥ 4` and `referentDensity < styleDensity` — style words with no referential counterweight, which is exactly the Kobak signal.
2. **specific** when `referentDensity ≥ 5`, `styleDensity ≤ referentDensity`, and no banned transition appears.
3. **thin** otherwise.

The three passages in the test are the module's specification. They are written into this plan so the thresholds are checkable by hand.

**Files:**
- Create: `packages/server/src/prose/index.ts`
- Create: `packages/server/src/prose/index.test.ts`

**Interfaces:**
- Consumes: everything from `./features.js` and `./lexicon.js`.
- Produces: `analyzeProse(text): ProseReport` (contract), plus plan-local `paragraphDensities(p): ParagraphDensity` and `ParagraphDensity`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/prose/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { analyzeProse, paragraphDensities } from './index.js';

/** Style words everywhere, no proper noun, no figure, no date. */
const GENERIC = [
  "In today's rapidly evolving landscape, our organization delves into the transformative",
  'potential of amateur radio to empower the next generation. Furthermore, this comprehensive',
  'initiative underscores our unwavering commitment to educate, empower, and inspire learners',
  'across a myriad of disciplines, ensuring that participants gain invaluable insights. Moreover,',
  'the implementation of a robust outreach framework will foster meaningful engagement, allowing',
  'us to leverage cutting-edge methodologies while enhancing community resilience, thereby',
  'ensuring long-term impact for years to come.',
].join(' ');

/** Names, callsigns, rooms, model numbers, counts and dates. */
const SPECIFIC = [
  'Three of our members — Dana Ruiz KD9XYZ, Marcus Hall W9ABC, and Priya Nair KE8QRS — will teach',
  'a four-session licensing class in Room 214 of the Engineering Building on the Saturdays of',
  'March 7, 14, 21, and 28, 2027. Dana Ruiz has taught the same syllabus twice for the Ann Arbor',
  'Amateur Radio Club and holds a General class license. The class seats 24 students; the Fall',
  '2026 session filled all 24 seats and 19 of those students passed the Technician exam. We will',
  'buy one Icom IC-7300 transceiver and two Comet GP-3 antennas so the class can run on-air',
  'demonstrations from the roof of the Engineering Building.',
].join(' ');

/** True, readable, and almost entirely unreferenced — the common real-world case. */
const THIN = [
  'Our club, K5UTD, has struggled to keep its station usable since the spring of 2024. Members',
  'who want to operate often find that the antenna is disconnected or that a cable has failed,',
  'and they leave without making a contact. We believe a working station would change how',
  'students see the hobby, and we think more of them would stay involved after their first',
  'semester. The request in this application would let us repair what we have rather than',
  'replace it, which is the cheaper path and the one our officers prefer.',
].join(' ');

describe('analyzeProse — known-generic passage', () => {
  const report = analyzeProse(GENERIC);
  const p = report.paragraphs[0]!;

  it('finds no proper noun and no figure at all', () => {
    expect(p.properNounCount).toBe(0);
    expect(p.figureCount).toBe(0);
    expect(report.paragraphsWithNoProperNounOrFigure).toEqual([0]);
  });

  it('calls it generic', () => {
    expect(p.verdict).toBe('generic');
  });

  it('locates the banned transitions', () => {
    expect(p.stockTransitionHits).toContain('Furthermore');
    expect(p.stockTransitionHits).toContain('Moreover');
  });

  it('locates the stock opener and the stock closer', () => {
    expect(report.stockOpenerHits.some((h) => /rapidly evolving landscape/i.test(h))).toBe(true);
    expect(report.stockCloserHits.some((h) => /for years to come/i.test(h))).toBe(true);
  });

  it('counts the tricolon and the trailing participials', () => {
    expect(p.tricolonCount).toBeGreaterThanOrEqual(1);
    expect(report.documentTricolonCount).toBeGreaterThanOrEqual(1);
    expect(p.trailingParticipialCount).toBeGreaterThanOrEqual(3);
  });

  it('reports a high style-word density with no referential counterweight', () => {
    const d = paragraphDensities(p);
    expect(p.styleWordHits.length).toBeGreaterThanOrEqual(8);
    expect(d.referentDensity).toBe(0);
    expect(d.styleDensity).toBeGreaterThan(4);
  });
});

describe('analyzeProse — known-specific passage', () => {
  const report = analyzeProse(SPECIFIC);
  const p = report.paragraphs[0]!;

  it('calls it specific', () => {
    expect(p.verdict).toBe('specific');
  });

  it('finds many proper nouns and many figures', () => {
    expect(p.properNounCount).toBeGreaterThanOrEqual(20);
    expect(p.figureCount).toBeGreaterThanOrEqual(10);
    expect(report.paragraphsWithNoProperNounOrFigure).toEqual([]);
  });

  it('finds no banned transition, no stock opener and no stock closer', () => {
    expect(p.stockTransitionHits).toEqual([]);
    expect(report.stockOpenerHits).toEqual([]);
    expect(report.stockCloserHits).toEqual([]);
  });

  it('does not mistake a list of dates or names for a tricolon', () => {
    expect(p.tricolonCount).toBe(0);
  });

  it('reports referential density well above style density', () => {
    const d = paragraphDensities(p);
    expect(d.referentDensity).toBeGreaterThan(20);
    expect(d.styleDensity).toBeLessThan(d.referentDensity);
  });
});

describe('analyzeProse — known-thin passage', () => {
  const report = analyzeProse(THIN);
  const p = report.paragraphs[0]!;

  it('calls it thin: true and readable, but barely referenced', () => {
    expect(p.verdict).toBe('thin');
  });

  it('finds at least one proper noun and one figure, but few', () => {
    expect(p.properNounCount).toBeGreaterThanOrEqual(1);
    expect(p.figureCount).toBeGreaterThanOrEqual(1);
    expect(p.styleWordHits.length).toBeLessThanOrEqual(3);
  });
});

describe('analyzeProse — document level', () => {
  it('indexes paragraphs and reports sentence-length variance across the document', () => {
    const report = analyzeProse(`${SPECIFIC}\n\n${THIN}\n\n${GENERIC}`);
    expect(report.paragraphs.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(report.paragraphs[0]?.verdict).toBe('specific');
    expect(report.paragraphs[2]?.verdict).toBe('generic');
    expect(report.paragraphsWithNoProperNounOrFigure).toEqual([2]);
    expect(report.sentenceLengthVariance).toBeGreaterThan(0);
  });

  it('handles empty input without throwing', () => {
    const report = analyzeProse('   \n\n  ');
    expect(report.paragraphs).toEqual([]);
    expect(report.sentenceLengthVariance).toBe(0);
    expect(report.documentTricolonCount).toBe(0);
  });

  it('is pure: the same input yields a deeply equal report every time', () => {
    expect(analyzeProse(THIN)).toEqual(analyzeProse(THIN));
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/prose/index.test.ts
```

Expected failure: `Error: Failed to resolve import "./index.js"`.

- [ ] **Step 3: Write analyzeProse**

Create `packages/server/src/prose/index.ts`:

```ts
import {
  buildDocIndex,
  countFigures,
  countProperNouns,
  splitParagraphs,
  splitSentences,
  styleWordHits,
  tokenize,
  variance,
} from './features.js';
import {
  BANNED_TRANSITIONS,
  PARTICIPLE_ALLOWLIST,
  STOCK_CLOSERS,
  STOCK_OPENERS,
  WATCH_TRANSITIONS,
} from './lexicon.js';

export interface ParagraphReport {
  index: number;
  text: string;
  styleWordHits: string[];
  properNounCount: number;
  figureCount: number;
  tricolonCount: number;
  trailingParticipialCount: number;
  stockTransitionHits: string[];
  verdict: 'specific' | 'thin' | 'generic';
}

export interface ProseReport {
  paragraphs: ParagraphReport[];
  sentenceLengthVariance: number;
  documentTricolonCount: number;
  stockOpenerHits: string[];
  stockCloserHits: string[];
  paragraphsWithNoProperNounOrFigure: number[];
}

/** Plan-local: the two densities the UI renders beside each paragraph. */
export interface ParagraphDensity {
  words: number;
  styleDensity: number;
  referentDensity: number;
}

const GENERIC_REFERENT_DENSITY = 1.5;
const SPECIFIC_REFERENT_DENSITY = 5;
const STYLE_DENSITY_ALARM = 4;
const EDGE_WINDOW = 120;

/** Curly apostrophes and dashes normalised so phrase matching is stable. */
function normalize(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function phraseHits(text: string, phrases: readonly string[]): Array<{ text: string; start: number; end: number }> {
  const hay = normalize(text);
  const out: Array<{ text: string; start: number; end: number }> = [];
  for (const phrase of phrases) {
    const re = new RegExp(`\\b${escapeRe(normalize(phrase))}`, 'gi');
    for (const m of hay.matchAll(re)) {
      const start = m.index ?? 0;
      out.push({ text: m[0] as string, start, end: start + (m[0] as string).length });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** "educate, empower, and inspire". Items must be lowercase, so "Ann Arbor, Michigan, and Ohio" is not a tricolon. */
function countTricolons(text: string): number {
  const re = /\b([a-z][a-z-]+)\s*,\s*([a-z][a-z-]+)\s*,\s*(?:and|or)\s+([a-z][a-z-]+)\b/g;
  return [...normalize(text).matchAll(re)].length;
}

/** ", ensuring that…" / ", allowing us to…" / ", thereby fostering…" */
function countTrailingParticipials(text: string): number {
  const re = /,\s+(?:thereby\s+|thus\s+|further\s+|hereby\s+)?([a-z]+ing)\b/g;
  let n = 0;
  for (const m of normalize(text).matchAll(re)) {
    if (!PARTICIPLE_ALLOWLIST.has(m[1] as string)) n++;
  }
  return n;
}

export function paragraphDensities(p: ParagraphReport): ParagraphDensity {
  const words = Math.max(tokenize(p.text).length, 1);
  return {
    words,
    styleDensity: (p.styleWordHits.length / words) * 100,
    referentDensity: ((p.properNounCount + p.figureCount) / words) * 100,
  };
}

function verdictFor(p: Omit<ParagraphReport, 'verdict'>, bannedHits: number): ParagraphReport['verdict'] {
  const d = paragraphDensities({ ...p, verdict: 'thin' });
  if (d.referentDensity < GENERIC_REFERENT_DENSITY) return 'generic';
  if (d.styleDensity >= STYLE_DENSITY_ALARM && d.referentDensity < d.styleDensity) return 'generic';
  if (d.referentDensity >= SPECIFIC_REFERENT_DENSITY && d.styleDensity <= d.referentDensity && bannedHits === 0) {
    return 'specific';
  }
  return 'thin';
}

/**
 * Reports why a passage reads generic and where. It never emits a score and it
 * never claims a passage was machine-written: the measurable signal is
 * style-word density without referential counterweight, which a human writing
 * in a hurry produces just as readily as a model does.
 */
export function analyzeProse(text: string): ProseReport {
  const paragraphs = splitParagraphs(text);
  const doc = buildDocIndex(text);

  const stockOpenerHits: string[] = [];
  const stockCloserHits: string[] = [];
  const paragraphsWithNoProperNounOrFigure: number[] = [];
  const allSentenceLengths: number[] = [];

  const reports: ParagraphReport[] = paragraphs.map((paragraph, index) => {
    const tokens = tokenize(paragraph);
    const sentences = splitSentences(paragraph);
    for (const s of sentences) allSentenceLengths.push(tokenize(s).length);

    const banned = phraseHits(paragraph, BANNED_TRANSITIONS);
    const watched = phraseHits(paragraph, WATCH_TRANSITIONS);
    const stockTransitionHits = [...banned, ...watched].sort((a, b) => a.start - b.start).map((h) => h.text);

    for (const hit of phraseHits(paragraph, STOCK_OPENERS)) {
      if (hit.start < EDGE_WINDOW) stockOpenerHits.push(hit.text);
    }
    for (const hit of phraseHits(paragraph, STOCK_CLOSERS)) {
      if (hit.end > paragraph.length - EDGE_WINDOW) stockCloserHits.push(hit.text);
    }

    const properNounCount = countProperNouns(paragraph, doc);
    const figureCount = countFigures(tokens);
    if (properNounCount === 0 && figureCount === 0) paragraphsWithNoProperNounOrFigure.push(index);

    const partial = {
      index,
      text: paragraph,
      styleWordHits: styleWordHits(tokens),
      properNounCount,
      figureCount,
      tricolonCount: countTricolons(paragraph),
      trailingParticipialCount: countTrailingParticipials(paragraph),
      stockTransitionHits,
    };

    return { ...partial, verdict: verdictFor(partial, banned.length) };
  });

  return {
    paragraphs: reports,
    sentenceLengthVariance: variance(allSentenceLengths),
    documentTricolonCount: reports.reduce((sum, p) => sum + p.tricolonCount, 0),
    stockOpenerHits,
    stockCloserHits,
    paragraphsWithNoProperNounOrFigure,
  };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/prose/index.test.ts
```

If a verdict assertion fails, do **not** move a threshold to make the test green — re-count the paragraph by hand first with `paragraphDensities`, because the thresholds are the specification and the passages were written against them.

- [ ] **Step 5: Assert the module is genuinely pure and commit**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  ! grep -rE "from 'node:|require\(|process\.env|fetch\(" packages/server/src/prose/index.ts packages/server/src/prose/features.ts packages/server/src/prose/lexicon.ts && \
  echo "prose/ is pure" && \
  git add packages/server/src/prose && \
  git commit -m "feat(prose): analyzeProse reports style-word density without referential counterweight"
```

---

### Task 14: Fact checklist — every assertion surfaced for human confirmation before export

Every funder policy reviewed in the research makes the **human applicant**, never the tool, accountable for every number, claim, and citation. NIH and ORI enumerate the misconduct patterns explicitly, and non-existent AI-generated references are named among them. So a draft cannot be exported until every detected factual assertion has been explicitly confirmed by a person.

The extractor runs matchers in priority order and drops any match overlapping an already-accepted span, so a DOI is a citation rather than a URL, and `$1,450` is money rather than a bare figure.

**Files:**
- Create: `packages/server/src/prose/facts.ts`
- Create: `packages/server/src/prose/facts.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `FactKind`, `FactAssertion`, `FactChecklistItem`, `FactConfirmation`, `extractFactAssertions(text)`, `buildFactChecklist(text, confirmations?)`, `unconfirmedCount(items)`, `ExportReadiness`, `exportReadiness(text, confirmations?)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/prose/facts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildFactChecklist, exportReadiness, extractFactAssertions, unconfirmedCount } from './facts.js';

const DRAFT = [
  'Dana Ruiz will teach four sessions starting March 7, 2027 at a cost of $1,450.',
  'Attendance rose 32% after W8UM ran the same class in 2026.',
  'See Kobak et al., 2025 and https://www.ardc.net/apply/ for the criteria.',
  'The DOI is doi:10.1126/sciadv.adt3813.',
].join(' ');

describe('extractFactAssertions', () => {
  const facts = extractFactAssertions(DRAFT);
  const kinds = (k: string) => facts.filter((f) => f.kind === k).map((f) => f.text);

  it('finds money, percentages, dates, callsigns, names, urls and citations', () => {
    expect(kinds('money')).toContain('$1,450');
    expect(kinds('percent')).toContain('32%');
    expect(kinds('date').some((t) => t.includes('March 7, 2027'))).toBe(true);
    expect(kinds('callsign')).toContain('W8UM');
    expect(kinds('name')).toContain('Dana Ruiz');
    expect(kinds('url')).toContain('https://www.ardc.net/apply/');
    expect(kinds('citation').some((t) => t.includes('Kobak et al., 2025'))).toBe(true);
    expect(kinds('citation').some((t) => t.includes('10.1126/sciadv.adt3813'))).toBe(true);
  });

  it('classifies a DOI as a citation rather than as a url or a figure', () => {
    const doi = facts.find((f) => f.text.includes('10.1126'));
    expect(doi?.kind).toBe('citation');
    expect(facts.filter((f) => f.text === '10.1126')).toEqual([]);
  });

  it('does not double-count a number that is already inside money, a percentage or a date', () => {
    expect(facts.filter((f) => f.kind === 'figure').map((f) => f.text)).not.toContain('1,450');
    expect(facts.filter((f) => f.kind === 'figure').map((f) => f.text)).not.toContain('32');
  });

  it('returns non-overlapping spans sorted by position, each with context', () => {
    for (let i = 1; i < facts.length; i++) {
      expect(facts[i]!.start).toBeGreaterThanOrEqual(facts[i - 1]!.end);
    }
    for (const f of facts) {
      expect(DRAFT.slice(f.start, f.end)).toBe(f.text);
      expect(f.context).toContain(f.text);
      expect(f.context).not.toContain('\n');
      expect(f.id).toMatch(/^[a-z]+:\d+$/);
    }
  });

  it('finds nothing in a passage with no assertions', () => {
    expect(extractFactAssertions('We would like to improve the station.')).toEqual([]);
  });
});

describe('buildFactChecklist and exportReadiness', () => {
  it('starts every item unconfirmed', () => {
    const items = buildFactChecklist(DRAFT);
    expect(items.length).toBeGreaterThan(5);
    expect(items.every((i) => i.confirmed === false)).toBe(true);
    expect(items.every((i) => i.note === '')).toBe(true);
    expect(unconfirmedCount(items)).toBe(items.length);
  });

  it('applies stored confirmations by stable id', () => {
    const first = buildFactChecklist(DRAFT)[0]!;
    const items = buildFactChecklist(DRAFT, { [first.id]: { confirmed: true, note: 'checked the invoice' } });
    expect(items[0]?.confirmed).toBe(true);
    expect(items[0]?.note).toBe('checked the invoice');
    expect(unconfirmedCount(items)).toBe(items.length - 1);
  });

  it('blocks export until every assertion is confirmed', () => {
    const before = exportReadiness(DRAFT);
    expect(before.ready).toBe(false);
    expect(before.unconfirmed).toBe(before.items.length);

    const all: Record<string, { confirmed: boolean; note: string }> = {};
    for (const item of before.items) all[item.id] = { confirmed: true, note: '' };
    const after = exportReadiness(DRAFT, all);
    expect(after.ready).toBe(true);
    expect(after.unconfirmed).toBe(0);
  });

  it('treats a draft with no assertions as ready', () => {
    expect(exportReadiness('We would like to improve the station.').ready).toBe(true);
  });

  it('flags any remaining TODO marker as blocking', () => {
    const readiness = exportReadiness('The club [TODO: club.callsign — your club’s FCC callsign, e.g. W8UM] applies.');
    expect(readiness.ready).toBe(false);
    expect(readiness.openTodos).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/prose/facts.test.ts
```

Expected failure: `Error: Failed to resolve import "./facts.js"`.

- [ ] **Step 3: Write the extractor**

Create `packages/server/src/prose/facts.ts`:

```ts
/**
 * Fact checklist.
 *
 * Every funder policy reviewed makes the human applicant — never the tool —
 * accountable for every number, claim and citation, and NIH/ORI name
 * non-existent AI-generated references among the misconduct patterns. So a
 * draft cannot be exported until a person has explicitly confirmed every
 * assertion this module detects.
 *
 * Pure: no I/O, no network.
 */

export type FactKind = 'citation' | 'url' | 'money' | 'percent' | 'date' | 'callsign' | 'name' | 'figure';

export interface FactAssertion {
  /** Stable across re-extractions of identical text: `${kind}:${start}`. */
  id: string;
  kind: FactKind;
  text: string;
  start: number;
  end: number;
  /** Roughly ±60 characters, whitespace collapsed to a single line. */
  context: string;
}

export interface FactConfirmation {
  confirmed: boolean;
  note: string;
}

export interface FactChecklistItem extends FactAssertion, FactConfirmation {}

export interface ExportReadiness {
  ready: boolean;
  unconfirmed: number;
  openTodos: number;
  items: FactChecklistItem[];
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';

/** Order is priority: an earlier matcher wins any overlapping span. */
const MATCHERS: Array<{ kind: FactKind; re: RegExp }> = [
  { kind: 'citation', re: /\b(?:doi:\s*|https?:\/\/doi\.org\/)10\.\d{4,9}\/[^\s,;)]+/gi },
  { kind: 'citation', re: /\b[A-Z][A-Za-z'-]+\s+et al\.,?\s*\(?\d{4}\)?/g },
  { kind: 'citation', re: /\([A-Z][A-Za-z'-]+(?:\s+(?:and|&)\s+[A-Z][A-Za-z'-]+)?,\s*\d{4}\)/g },
  { kind: 'url', re: /\bhttps?:\/\/[^\s<>"')\]]+/gi },
  { kind: 'url', re: /\bwww\.[A-Za-z0-9-]+\.[A-Za-z]{2,}(?:\/[^\s<>"')\]]*)?/gi },
  { kind: 'money', re: /\$\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:million|billion|k|K))?/g },
  { kind: 'percent', re: /\b\d[\d,]*(?:\.\d+)?\s?%/g },
  { kind: 'date', re: new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?`, 'g') },
  { kind: 'date', re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { kind: 'date', re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
  { kind: 'date', re: /\b(?:19|20)\d{2}\b/g },
  { kind: 'callsign', re: /\b[A-Z]{1,2}\d{1,2}[A-Z]{1,4}\b/g },
  { kind: 'name', re: /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g },
  { kind: 'figure', re: /(?<![\w$.,])\d[\d,]*(?:\.\d+)?(?![\w%])/g },
];

function contextAround(text: string, start: number, end: number): string {
  const from = Math.max(0, start - 60);
  const to = Math.min(text.length, end + 60);
  return text.slice(from, to).replace(/\s+/g, ' ').trim();
}

export function extractFactAssertions(text: string): FactAssertion[] {
  const taken: Array<{ start: number; end: number }> = [];
  const out: FactAssertion[] = [];

  const overlaps = (start: number, end: number): boolean =>
    taken.some((t) => start < t.end && end > t.start);

  for (const matcher of MATCHERS) {
    for (const m of text.matchAll(matcher.re)) {
      const matched = m[0] as string;
      const start = m.index ?? 0;
      const end = start + matched.length;
      if (overlaps(start, end)) continue;
      taken.push({ start, end });
      out.push({
        id: `${matcher.kind}:${start}`,
        kind: matcher.kind,
        text: matched,
        start,
        end,
        context: contextAround(text, start, end),
      });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}

export function buildFactChecklist(
  text: string,
  confirmations: Record<string, FactConfirmation> = {},
): FactChecklistItem[] {
  return extractFactAssertions(text).map((fact) => {
    const stored = confirmations[fact.id];
    return { ...fact, confirmed: stored?.confirmed === true, note: stored?.note ?? '' };
  });
}

export function unconfirmedCount(items: FactChecklistItem[]): number {
  return items.filter((i) => !i.confirmed).length;
}

/** A leftover [TODO: …] marker blocks export just as an unconfirmed fact does. */
export function exportReadiness(
  text: string,
  confirmations: Record<string, FactConfirmation> = {},
): ExportReadiness {
  const items = buildFactChecklist(text, confirmations);
  const unconfirmed = unconfirmedCount(items);
  const openTodos = [...text.matchAll(/\[TODO:[^\]]*\]/g)].length;
  return { ready: unconfirmed === 0 && openTodos === 0, unconfirmed, openTodos, items };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/prose/facts.test.ts
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add packages/server/src/prose/facts.ts packages/server/src/prose/facts.test.ts && \
  git commit -m "feat(prose): fact checklist extractor and export readiness gate"
```

---

### Task 15: Prompt fragments, the disclosure sentence, and composePrompt

The composed prompt is the product's most visible artefact. It assembles, in order: what this funder actually requires; the funder's **quoted** AI policy with its source URL; the applicant's profile facts; an interview-first instruction; the style ruleset; a brevity pass; the never-invent rule; the optional disclosure sentence; and a closing fact-checklist instruction.

**On disclosure.** No funder found prohibits applicants from using AI. NSF *encourages* indicating the extent of use; the Spencer Foundation makes disclosure *mandatory*; Wenner-Gren places responsibility for originality and accuracy entirely on the applicant. **The ARRL Foundation's stance is genuinely unaddressed** — both the Club Grant page and the Grant Application Form PDF were read in full and contain zero mentions of AI — and the generator says exactly that rather than guessing. Disclosure defaults to on because it costs nothing and three of the funders that have published a position welcome it.

**Files:**
- Create: `content/prompts/why-these-rules.md`
- Create: `content/prompts/style-negative.md`
- Create: `content/prompts/style-positive.md`
- Create: `content/prompts/interview.md`
- Create: `content/prompts/never-invent.md`
- Create: `content/prompts/brevity.md`
- Create: `packages/server/src/prompts/fragments.ts`
- Create: `packages/server/src/prompts/disclosure.ts`
- Create: `packages/server/src/prompts/compose.ts`
- Create: `packages/server/src/prompts/compose.test.ts`

**Interfaces:**
- Consumes: `contentRoot()` from `../templates/load.js`; `getTemplate(id)` from `../templates/load.js`; `Program`, `Profile`, `AiStance` from `@grantspotter/core`.
- Produces: `loadFragment(id)`, `FRAGMENT_IDS`, `DisclosureInput`, `disclosureSentence(input)`, `disclosureNote(stance)`, `DISCLOSURE_DEFAULT_ON`, `PromptContext`, `composePrompt(ctx)`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/prompts/compose.test.ts`:

```ts
import type { Profile, Program } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { composePrompt } from './compose.js';
import { DISCLOSURE_DEFAULT_ON, disclosureNote, disclosureSentence } from './disclosure.js';
import { FRAGMENT_IDS, loadFragment } from './fragments.js';

const ARDC = {
  id: 'ardc-grants',
  funderId: 'ardc',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  summary: 'Grants supporting amateur radio and digital communication.',
  applicantEntities: ['club_via_fiscal_sponsor', 'university', 'school_lea'],
  amount: { instrument: 'cash_range', amountRaw: '$1,285-$258,000', awardCountRaw: 'Multiple per year' },
  deadline: { kind: 'n_fixed_dates', source: { kind: 'self' }, note: 'February 1, April 1, July 1, September 1' },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.ardc.net/apply/',
  constraints: [
    {
      id: 'ardc-open-source',
      hard: true,
      fallbackRank: 0,
      rawText: 'All output must be open-source or open-access.',
      spec: { axis: 'other', note: 'open licence required' },
    },
  ],
  fundingRestrictions: ['For-profit companies are not eligible.'],
  obligations: {
    licenseObligation: 'All output must be published open-source or open-access (GPL, MIT, BSD, CERN-OHL, CC).',
    indirectCostCapPct: 20,
    costShareRequired: false,
    coFunderPreference: false,
  },
  aiPolicy: {
    stance: 'permitted',
    quote:
      "If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy. If the proposal is extremely long and hard to understand, we can't evaluate or support it.",
    url: 'https://www.ardc.net/apply/grant-application-instructions/',
  },
  trust: {
    status: 'open',
    sourceUrl: 'https://www.ardc.net/apply/',
    lastVerifiedAt: '2026-08-02',
    verificationMethod: 'live_fetch',
    contentHash: 'seed',
  },
  rawOtherText: 'Clubs and individuals apply through a fiscal sponsor.',
  tags: ['ardc'],
} as unknown as Program;

const UNADDRESSED = {
  ...ARDC,
  id: 'arrl-club-grant',
  name: 'ARRL Club Grant Program',
  aiPolicy: { stance: 'unaddressed' },
} as unknown as Program;

const PROFILE: Profile = {
  kind: 'organization',
  entity: 'club_unincorporated',
  orgName: 'Example Collegiate Amateur Radio Club',
  callsign: 'W8UM',
  state: 'MI',
  memberCount: 34,
  institutionName: 'Example State University',
  arrlAffiliated: true,
};

describe('prompt fragments', () => {
  it('loads every declared fragment with real content', () => {
    for (const id of FRAGMENT_IDS) {
      const body = loadFragment(id);
      expect(body.length, id).toBeGreaterThan(300);
    }
  });

  it('states the Kobak grounding and why classifier-gaming is excluded', () => {
    const why = loadFragment('why-these-rules');
    expect(why).toContain('10.1126/sciadv.adt3813');
    expect(why).toMatch(/66% verbs/);
    expect(why).toMatch(/79% nouns/);
    expect(why).toMatch(/not a banned-word list|not a blacklist/i);
    expect(why).toMatch(/synonym/i);
    expect(why).toMatch(/typos/i);
    expect(why).toMatch(/invisible|homoglyph/i);
  });

  it('bans the four transitions and caps participials and tricolons', () => {
    const neg = loadFragment('style-negative');
    for (const t of ['Furthermore', 'Moreover', 'Additionally', 'It is important to note that']) {
      expect(neg).toContain(t);
    }
    expect(neg).toMatch(/at most one trailing participial/i);
    expect(neg).toMatch(/at most one three-item list|tricolon/i);
    expect(neg).toMatch(/vary sentence length/i);
  });

  it('requires named subjects, proper nouns, figures and the adjective-deletion test', () => {
    const pos = loadFragment('style-positive');
    expect(pos).toMatch(/named human or a named organization/i);
    expect(pos).toMatch(/W8UM|K5UTD/);
    expect(pos).toMatch(/IC-7300|DR-2X/);
    expect(pos).toMatch(/adjective-deletion/i);
  });

  it('makes the model interview before drafting and turn gaps into TODO markers', () => {
    const iv = loadFragment('interview');
    expect(iv).toMatch(/do not (produce|write) any .*prose until/i);
    expect(iv).toMatch(/\[TODO:/);
    expect(iv).toMatch(/line by line/i);
  });

  it('forbids inventing a citation, statistic or URL', () => {
    const ni = loadFragment('never-invent');
    expect(ni).toMatch(/citation/i);
    expect(ni).toMatch(/statistic|figure/i);
    expect(ni).toMatch(/URL/);
    expect(ni).toMatch(/Facts to verify/);
  });
});

describe('disclosureSentence', () => {
  it('defaults to on', () => {
    expect(DISCLOSURE_DEFAULT_ON).toBe(true);
  });

  it('produces an editable one-sentence disclosure naming the tool and the responsible human', () => {
    const s = disclosureSentence({ stance: 'permitted', funderName: 'ARDC', toolName: 'Claude', authorName: 'Dana Ruiz' });
    expect(s).toMatch(/Claude/);
    expect(s).toMatch(/Dana Ruiz/);
    expect(s).toMatch(/reviewed|verified/);
    expect(s.split('. ').length).toBeLessThanOrEqual(2);
  });

  it('falls back to "the applicant" when no author is given', () => {
    expect(disclosureSentence({ stance: 'permitted', funderName: 'ARDC' })).toMatch(/the applicant/);
  });

  it('says disclosure is mandatory when the funder requires it', () => {
    expect(disclosureNote('permitted_with_disclosure')).toMatch(/mandatory|required/i);
  });

  it('says plainly that an unaddressed funder has published nothing, and does not guess', () => {
    const note = disclosureNote('unaddressed');
    expect(note).toMatch(/has not published/i);
    expect(note).toMatch(/does not guess|no position/i);
    expect(note).not.toMatch(/probably|likely|we assume/i);
  });
});

describe('composePrompt', () => {
  const prompt = composePrompt({ program: ARDC, profile: PROFILE, includeDisclosure: true });

  it("names the funder's real obligations, restrictions and constraint text", () => {
    expect(prompt).toContain('ARDC Grants Program');
    expect(prompt).toContain('All output must be published open-source or open-access');
    expect(prompt).toContain('20%');
    expect(prompt).toContain('For-profit companies are not eligible.');
    expect(prompt).toContain('All output must be open-source or open-access.');
    expect(prompt).toContain('Clubs and individuals apply through a fiscal sponsor.');
    expect(prompt).toContain('February 1, April 1, July 1, September 1');
  });

  it("quotes the funder's AI policy with its source URL", () => {
    expect(prompt).toContain('thoroughly edit for clarity, brevity, and accuracy');
    expect(prompt).toContain('https://www.ardc.net/apply/grant-application-instructions/');
  });

  it('carries the profile facts it actually has and invents none it does not', () => {
    expect(prompt).toContain('Example Collegiate Amateur Radio Club');
    expect(prompt).toContain('W8UM');
    expect(prompt).toContain('34');
    expect(prompt).not.toMatch(/\bEIN\b.*\d{2}-\d{7}/);
  });

  it('includes every rule fragment', () => {
    expect(prompt).toContain('Furthermore');
    expect(prompt).toMatch(/named human or a named organization/i);
    expect(prompt).toMatch(/Interview me before you draft/i);
    expect(prompt).toMatch(/Brevity pass/i);
    expect(prompt).toMatch(/Never invent evidence/i);
    expect(prompt).toContain('10.1126/sciadv.adt3813');
  });

  it('includes the disclosure sentence when asked and omits it when not', () => {
    expect(prompt).toMatch(/AI-use disclosure/i);
    const without = composePrompt({ program: ARDC, profile: PROFILE, includeDisclosure: false });
    expect(without).not.toMatch(/AI-use disclosure/i);
  });

  it('reports an unaddressed AI policy honestly instead of guessing', () => {
    const p = composePrompt({ program: UNADDRESSED, includeDisclosure: true });
    expect(p).toMatch(/has not published .*polic/i);
    expect(p).not.toMatch(/permits|allows|encourages/i);
  });

  it('appends the chosen template body when a templateId is given', () => {
    const p = composePrompt({ program: ARDC, profile: PROFILE, templateId: 'need-statement', includeDisclosure: false });
    expect(p).toMatch(/Need statement/);
    expect(p).toMatch(/Common failure/);
  });

  it('is deterministic', () => {
    expect(composePrompt({ program: ARDC, profile: PROFILE, includeDisclosure: true })).toBe(prompt);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/prompts/compose.test.ts
```

Expected failure: `Error: Failed to resolve import "./compose.js"`.

- [ ] **Step 3: Write the six prompt fragments**

Create `content/prompts/why-these-rules.md`:

```markdown
## Why these rules

Kobak et al., *Science Advances*, 2025 (DOI 10.1126/sciadv.adt3813) measured word-frequency changes across more than 15 million PubMed abstracts and found 379 "excess vocabulary" words in 2024. The useful finding is not the word list. It is the grammar of the shift: 2024's excess vocabulary was 66% verbs and 14% adjectives — style words — while the Covid-era excess vocabulary of 2020 to 2022 was 79% nouns — content words.

A real event changes the nouns in a document. A language model changes the verbs and the adjectives.

So the rules below are **not a banned-word list**. Words such as "potential", "findings" and "comprehensive" are ordinary English and appear in excellent proposals. What marks a passage as generic is style-word density with no referential counterweight: adjectives and abstract verbs with no proper nouns, no figures and no dates anywhere near them.

Four things are deliberately excluded from this brief: synonym swapping, deliberately injected typos, invisible or homoglyph characters, and every other trick aimed at defeating an AI-detection classifier. They are excluded for two reasons. They degrade the prose, and a human reviewer notices bad writing long before a classifier notices a machine. This brief achieves its goal by making the writing genuinely specific, which is also the property that gets an application funded.
```

Create `content/prompts/style-negative.md`:

```markdown
## Do not write like this

These rules are absolute. Breaking one is a failed draft, not a style disagreement.

1. Never use these transitions: "Furthermore", "Moreover", "Additionally", "It is important to note that". Where two sentences need a connective, the connective is usually a fact — name the date, the person, or the number that links them.
2. Never open with a scene-setting abstraction. Banned openers include "In today's rapidly evolving landscape", "In an era of", "Since the dawn of", "It is no secret that", "Now more than ever". Open with a name, a date, a place, or a number.
3. Never close with a promise of impact. Banned closers include "ensuring long-term impact for years to come", "for years to come", "we look forward to partnering with you", "a lasting impact". Close with the next concrete step and its date.
4. At most one trailing participial clause per paragraph — the ", ensuring that…", ", allowing us to…", ", thereby fostering…" tail. Rewrite the second one as its own sentence with a subject.
5. At most one three-item list per document, of the "educate, empower, and inspire" kind. Keep the two items you can evidence and delete the third.
6. Vary sentence length on purpose. If four consecutive sentences fall within three words of each other, rewrite one to under ten words and one to over thirty.
7. No passive constructions that hide the actor: "materials will be procured", "sessions will be conducted", "outreach will be performed". Name who does it.
```

Create `content/prompts/style-positive.md`:

```markdown
## Write like this

1. In the activities, methods and timeline sections, every sentence takes a named human or a named organization as its grammatical subject. Write "Three of our members — Dana Ruiz KD9XYZ, Marcus Hall W9ABC and Priya Nair KE8QRS — will teach a four-session licensing class in Room 214", not "The implementation of an educational outreach initiative will be undertaken."
2. Use proper nouns a reviewer could look up: callsigns such as W8UM and K5UTD, club names, institution names, building and room names, city and state, equipment model numbers such as IC-7300, DR-2X and GP-3, and named people with their roles.
3. Every claim of scale carries a figure: headcounts, dollar line items, dates, distances, frequencies, hours. "More students" is not a claim. "19 of 24 students" is.
4. Apply the adjective-deletion test to every paragraph. Delete each adjective and adverb. If the paragraph still says what will happen, keep it. If it collapses, the paragraph was tone rather than content, and it needs rewriting around its nouns and its numbers.
5. Prefer the shorter word and the shorter sentence. A reviewer reading forty applications rewards clarity and nothing else.
6. Where a paragraph contains no proper noun and no figure at all, treat that paragraph as unfinished.
```

Create `content/prompts/interview.md`:

```markdown
## Interview me before you draft

Do not produce any application prose until I have answered these questions. Ask them once, numbered, in a single message, and then wait for my reply.

1. Who specifically does the work? Give me names, callsigns where they exist, and each person's role and relevant experience.
2. What specifically breaks today, or is missing? Name the object, the room, and the date it started.
3. Who is affected, and how many of them are there? Give me a number I can defend if a reviewer asks.
4. What changes if this is funded, stated as something countable and observed by a specific date?
5. What does the money buy, line by line, with unit prices and a vendor or catalogue number for each?
6. What have we already tried, and what did that cost?
7. Who else is contributing money, equipment, space or time, and how much?
8. What happens to the work after the grant period ends, and who maintains it?

If I leave a question unanswered, write `[TODO: <the exact question>]` in the draft at the point where the answer belongs, and continue. Never invent a plausible answer. A fabricated specific is worse than a visible gap, because the funder's own policies make me — the applicant — accountable for every number in this document.
```

Create `content/prompts/never-invent.md`:

```markdown
## Never invent evidence

Do not generate any citation, statistic, dollar figure, date, headcount, quotation or URL that I did not give you. This is the highest-consequence rule in this brief.

- If a sentence needs a number I have not supplied, write `[TODO: figure needed — <what the number is>]`.
- If a claim would be stronger with a source, write `[TODO: citation needed — <what claim it supports>]` and leave it to me.
- Do not produce a reference list. Do not produce a DOI. Do not produce a URL. Do not name a study, a report or an author I did not name first.

At the end of the draft, under the heading **Facts to verify**, list every factual assertion the draft contains — every figure, date, proper name, citation and URL — one per line. I will confirm each one before this document leaves my hands.
```

Create `content/prompts/brevity.md`:

```markdown
## Brevity pass

When the draft is complete, run a second, separate editing pass whose only goal is length. Report the original word count, the new word count, and what you cut.

Cut in this order:

1. Sentences that would still be true if a different organization in a different state had written them.
2. Adjectives and adverbs whose removal does not change the meaning.
3. Restatements of the funder's own mission back at them.
4. Any sentence whose only job is transition.
5. Prepositional pile-ups: "in order to" becomes "to", "due to the fact that" becomes "because", "at this point in time" becomes "now", "is able to" becomes "can".

Do not cut names, numbers, dates, model numbers or budget line items. Those are the parts that make an application fundable.
```

- [ ] **Step 4: Write the fragment loader, the disclosure generator and composePrompt**

Create `packages/server/src/prompts/fragments.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { contentRoot } from '../templates/load.js';

export const FRAGMENT_IDS = [
  'why-these-rules',
  'style-negative',
  'style-positive',
  'interview',
  'never-invent',
  'brevity',
] as const;

export type FragmentId = (typeof FRAGMENT_IDS)[number];

const cache = new Map<string, string>();

export function loadFragment(id: FragmentId | string): string {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const file = path.join(contentRoot(), 'prompts', `${id}.md`);
  if (!fs.existsSync(file)) throw new Error(`unknown prompt fragment "${id}"`);
  const body = fs.readFileSync(file, 'utf8').trim();
  cache.set(id, body);
  return body;
}
```

Create `packages/server/src/prompts/disclosure.ts`:

```ts
import type { AiStance } from '@grantspotter/core';

/**
 * A one-sentence AI-use disclosure costs nothing and is affirmatively welcomed
 * by NSF, the Spencer Foundation and Wenner-Gren. It is therefore ON by default
 * and always editable.
 */
export const DISCLOSURE_DEFAULT_ON = true;

export interface DisclosureInput {
  stance: AiStance;
  funderName: string;
  toolName?: string;
  authorName?: string;
  usage?: 'drafting' | 'editing' | 'both';
}

export function disclosureSentence(input: DisclosureInput): string {
  const tool = input.toolName?.trim() || 'a generative AI assistant';
  const author = input.authorName?.trim() || 'the applicant';
  const verb =
    input.usage === 'editing'
      ? 'edited with the assistance of'
      : input.usage === 'drafting'
        ? 'drafted with the assistance of'
        : 'drafted and edited with the assistance of';
  return (
    `Portions of this application were ${verb} ${tool}; ` +
    `${author} reviewed and verified every factual statement, figure, date and citation in it, ` +
    `and takes full responsibility for its content.`
  );
}

export function disclosureNote(stance: AiStance): string {
  switch (stance) {
    case 'permitted_with_disclosure':
      return 'This funder requires disclosure. It is mandatory, not optional, and it usually must include a brief summary of how and where AI was used.';
    case 'permitted':
      return 'This funder permits AI assistance and holds the applicant responsible for accuracy and originality. A short disclosure sentence is welcome and costs nothing.';
    case 'discouraged':
      return 'This funder discourages AI assistance. Disclose it, keep the use to editing rather than drafting, and expect the originality of the ideas to be scrutinised.';
    case 'prohibited':
      return 'This funder prohibits AI assistance for applicants. Do not use a model to draft this application.';
    case 'unaddressed':
    default:
      return (
        'This funder has not published any policy on applicants using AI. GrantSpotter does not guess a position it has ' +
        'no evidence for, so no stance is shown. Every funder in this corpus that has published a position welcomes ' +
        'disclosure and none penalises it, which is why the disclosure sentence is offered here by default. Including it is your call.'
      );
  }
}
```

Create `packages/server/src/prompts/compose.ts`:

```ts
import type { Profile, Program } from '@grantspotter/core';
import { getTemplate } from '../templates/load.js';
import { disclosureNote, disclosureSentence } from './disclosure.js';
import { loadFragment } from './fragments.js';

export interface PromptContext {
  program: Program;
  profile?: Profile;
  templateId?: string;
  includeDisclosure: boolean;
}

function profileFacts(profile: Profile): string[] {
  const lines: string[] = [];
  const add = (label: string, value: unknown): void => {
    if (value === undefined || value === null || value === '') return;
    lines.push(`- ${label}: ${String(value)}`);
  };
  if (profile.kind === 'organization') {
    add('Organization', profile.orgName);
    add('Callsign', profile.callsign);
    add('Entity type', profile.entity);
    add('State', profile.state);
    add('Host institution', profile.institutionName);
    add('Members', profile.memberCount);
    if (typeof profile.is501c3 === 'boolean') add('501(c)(3)', profile.is501c3 ? 'yes' : 'no');
    if (typeof profile.hasFiscalSponsor === 'boolean') add('Has a fiscal sponsor', profile.hasFiscalSponsor ? 'yes' : 'no');
    if (typeof profile.arrlAffiliated === 'boolean') add('ARRL affiliated', profile.arrlAffiliated ? 'yes' : 'no');
  } else {
    add('Callsign', profile.callsign);
    add('License class', profile.licenseClass);
    add('Licensed since', profile.licensedSince);
    add('Institution', profile.institution);
    add('Degree level', profile.degreeLevel);
    add('Field of study', profile.fieldOfStudy);
    add('State', profile.state);
    add('GPA', profile.gpa);
    add('Stage', profile.stage);
  }
  return lines;
}

/**
 * Assembles the copy-and-run prompt. Everything factual in it comes from the
 * opportunity record or the user's own profile; the module never adds a fact of
 * its own, and the rule fragments forbid the model from adding one either.
 */
export function composePrompt(ctx: PromptContext): string {
  const { program, profile, templateId, includeDisclosure } = ctx;
  const out: string[] = [];

  out.push(`# Application drafting brief — ${program.name}`);
  out.push('');
  out.push(
    'You are helping me write part of a real grant application. Follow every rule in this brief. Where a rule and your defaults conflict, the rule wins.',
  );
  out.push('');

  out.push('## What this funder actually requires');
  out.push(`- Program: ${program.name}`);
  out.push(`- Opportunity class: ${program.klass}`);
  out.push(`- Who may apply: ${program.applicantEntities.join(', ')}`);
  out.push(`- Published award amount: ${program.amount.amountRaw || 'not published'}`);
  out.push(`- Number of awards: ${program.amount.awardCountRaw || 'not published'}`);
  out.push(`- Deadline pattern: ${program.deadline.kind}${program.deadline.note ? ` — ${program.deadline.note}` : ''}`);
  out.push(`- How to apply: ${program.applyVia}${program.applyUrl ? ` — ${program.applyUrl}` : ''}`);
  out.push(`- Status: ${program.trust.status}`);
  out.push(`- These facts came from ${program.trust.sourceUrl}, last verified ${program.trust.lastVerifiedAt}.`);
  out.push('');

  if (program.fundingRestrictions.length > 0) {
    out.push('### This funder will not fund');
    for (const r of program.fundingRestrictions) out.push(`- ${r}`);
    out.push('');
  }

  const ob = program.obligations;
  const obligations: string[] = [];
  if (ob.licenseObligation) obligations.push(ob.licenseObligation);
  if (typeof ob.indirectCostCapPct === 'number') obligations.push(`Indirect costs are capped at ${ob.indirectCostCapPct}%.`);
  if (ob.costShareRequired) obligations.push('Cost share is required.');
  if (ob.coFunderPreference) obligations.push('This funder prefers not to be the sole funder; name and quantify co-funding.');
  if (ob.sustainmentObligation) obligations.push(ob.sustainmentObligation);
  if (ob.reportingObligation) obligations.push(ob.reportingObligation);
  if (obligations.length > 0) {
    out.push('### Obligations attached to the award');
    for (const o of obligations) out.push(`- ${o}`);
    out.push('');
  }

  if (program.constraints.length > 0) {
    out.push('### Eligibility text, verbatim from the funder');
    for (const c of program.constraints) {
      out.push(`- ${c.hard ? 'Requirement' : 'Preference'}: ${c.rawText}`);
    }
    out.push('');
  }

  if (program.rawOtherText.trim() !== '') {
    out.push('### Other published requirements, verbatim');
    out.push(program.rawOtherText.trim());
    out.push('');
  }

  if (program.trust.disputed) {
    out.push('### Contested facts');
    out.push(program.trust.disputed.note);
    for (const claim of program.trust.disputed.claims) out.push(`- ${claim.claim} (${claim.sourceUrl})`);
    out.push('');
  }

  out.push("## This funder's stated position on applicants using AI");
  if (program.aiPolicy.stance === 'unaddressed') {
    out.push(`${program.name} has not published a policy on applicants using AI.`);
    out.push(disclosureNote('unaddressed'));
  } else {
    out.push(disclosureNote(program.aiPolicy.stance));
    if (program.aiPolicy.quote) out.push('', `> ${program.aiPolicy.quote}`);
    if (program.aiPolicy.url) out.push('', `Source: ${program.aiPolicy.url}`);
  }
  out.push('');

  if (profile) {
    const facts = profileFacts(profile);
    if (facts.length > 0) {
      out.push('## Facts about me that you may use');
      out.push('These are the only facts you have. Do not add to them.');
      out.push('');
      out.push(...facts);
      out.push('');
    }
  }

  if (templateId) {
    const template = getTemplate(templateId);
    out.push(`## The section I need: ${template.title}`);
    if (template.lengthTarget) out.push(`Target length: ${template.lengthTarget}`);
    out.push('');
    out.push(template.body.trim());
    out.push('');
  }

  out.push(loadFragment('interview'));
  out.push('');
  out.push(loadFragment('style-negative'));
  out.push('');
  out.push(loadFragment('style-positive'));
  out.push('');
  out.push(loadFragment('why-these-rules'));
  out.push('');
  out.push(loadFragment('never-invent'));
  out.push('');
  out.push(loadFragment('brevity'));
  out.push('');

  if (includeDisclosure) {
    out.push('## AI-use disclosure');
    out.push('Include this sentence, edited to match how I actually used you, at the end of the document:');
    out.push('');
    out.push(`> ${disclosureSentence({ stance: program.aiPolicy.stance, funderName: program.name })}`);
    out.push('');
  }

  out.push('## Before you hand the draft back');
  out.push(
    'End with the "Facts to verify" list. I will confirm every entry in it by hand before this document is exported or submitted; the funder holds me accountable for each one, not you.',
  );

  return out.join('\n');
}
```

- [ ] **Step 5: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/prompts/compose.test.ts
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add content/prompts packages/server/src/prompts && \
  git commit -m "feat(prompts): style ruleset fragments, disclosure generator and composePrompt"
```

---

### Task 16: Application drafts — migration, repository and the applications router

Drafts are per-user rows. The router is a factory taking Plan 3's `RouterDeps`, exactly like Plan 3's eleven routers: the database, the clock and the auth behaviour are all injected, so the router is constructed with fakes in tests and wired once — by Plan 3 — in the server entrypoint.

**Plan 1 owns these two tables (RESOLUTIONS R24).** `applications` and `template_instances` are created — once, with the column list this task's repository expects — by Plan 1 Task 12's `packages/server/src/db/migrations/001-init.sql`, along with the indexes `idx_applications_user` and `idx_template_instances_application`. **This task writes no migration, creates no table, creates no index, and does not edit Plan 1's migration.** What it ships instead is `assertApplicationSchema(db)`, an **assert-never-create** guard in the shape of Plan 2's `ensureIngestionSchema`: it reads `PRAGMA table_info` for both tables and throws an error naming `001-init.sql` as the owner if a column is missing. Two `CREATE TABLE IF NOT EXISTS` statements for the same table name in two migrations is not a belt-and-braces safety net — SQLite matches `IF NOT EXISTS` on the **name**, so the later one silently never runs and its column list silently never exists.

**Every failure in this router is `next(new AppError(...))`** (R6). There is no `res.status(400).json({ error: '…' })` anywhere below, and a zod failure is 422 `validation_failed`.

**Files:**
- Create: `packages/server/src/db/repositories/applications.ts`
- Create: `packages/server/src/api/applications.ts`
- Create: `packages/server/src/api/applications.test.ts`
- Modify: `packages/server/package.json` (add `zod` to dependencies)
- Create: **nothing** under `packages/server/src/db/migrations/`. There is no `040-application-writing.sql` in this plan.

**Interfaces:**
- Consumes: `exportReadiness`, `FactConfirmation` from `../prose/facts.js`; `isKnownSlot` from `../templates/slots.js`; `RouterDeps` from `./deps.js` (Plan 3 Task 4); `AppError` from `./errors.js` (Plan 1); `openTestDb` from `../test/testDb.js` and `seedFixtureCorpus`, `seedTestUser` from `../test/fixtures/programs.js` (test-only, from **Plan 3 Task 2** — the browse-projection task, which also produces the shared test harness; `RouterDeps` is the separate **Task 4**).
- Produces: `ApplicationRow`, `assertApplicationSchema(db)`, `createApplication`, `listApplications`, `getApplication`, `updateApplication`, `setFactConfirmations`, `deleteApplication`, `assertExportReady(db, applicationId, userId)` (called by Plan 5's export endpoints — see the handoff section at the end of this plan), `createApplicationsRouter(deps: RouterDeps): Router`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/applications.test.ts`:

```ts
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertApplicationSchema, assertExportReady } from '../db/repositories/applications.js';
import { seedFixtureCorpus, seedTestUser } from '../test/fixtures/programs.js';
import { openTestDb } from '../test/testDb.js';
import { createApplicationsRouter } from './applications.js';
import type { RouterDeps, SessionUser } from './deps.js';
import { AppError, errorHandler, notFoundHandler } from './errors.js';

let db: Database.Database;
let base: string;
let close: () => Promise<void>;

/** The signed-in caller for this suite. Swapped by the cross-user test. */
let caller: SessionUser = { id: 'user-1', email: 'one@example.org', role: 'member' };

async function start(): Promise<void> {
  // RESOLUTIONS R24: `applications` and `template_instances` come from Plan 1's
  // 001-init.sql, applied by Plan 1's migration runner behind Plan 3's
  // openTestDb(). This suite does NOT exec a migration file of its own — there
  // is no 040-application-writing.sql, and a hand-rolled CREATE TABLE here
  // would let a schema drift between test and production go unnoticed.
  db = openTestDb();

  // `applications.user_id` and `applications.program_id` are REFERENCES with
  // PRAGMA foreign_keys = ON, so both parents have to exist before an insert.
  seedFixtureCorpus(db);          // supplies the real `ardc-grants` row
  seedTestUser(db, 'user-1');
  seedTestUser(db, 'user-2');

  caller = { id: 'user-1', email: 'one@example.org', role: 'member' };

  // Fakes for Plan 3's RouterDeps, so this suite tests the router alone and
  // never imports Plan 1's auth module.
  const deps: RouterDeps = {
    db,
    now: () => '2026-08-02T00:00:00.000Z',
    requireAuth: (_req, _res, next) => next(),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => caller,
  };

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/applications', createApplicationsRouter(deps));
  app.use(notFoundHandler());
  app.use(errorHandler({ logger: () => undefined }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        db.close();
        resolve();
      });
    });
}

const json = async (pathname: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const res = await fetch(base + pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
};

beforeEach(start);
afterEach(async () => close());

describe('applications router', () => {
  it('creates, lists, reads and updates a draft', async () => {
    const created = await json('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ title: 'ARDC station rebuild', programId: 'ardc-grants' }),
    });
    expect(created.status).toBe(201);
    expect(created.body.id).toBeTruthy();
    expect(created.body.title).toBe('ARDC station rebuild');
    expect(created.body.includeDisclosure).toBe(true);

    const listed = await json('/api/applications');
    expect(listed.body.applications).toHaveLength(1);

    const patched = await json(`/api/applications/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: 'W8UM will buy one IC-7300 for $1,099.', answers: { 'club.city': 'Ann Arbor' } }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.bodyMarkdown).toContain('IC-7300');
    expect(patched.body.answers['club.city']).toBe('Ann Arbor');

    const read = await json(`/api/applications/${created.body.id}`);
    expect(read.body.bodyMarkdown).toContain('$1,099');
  });

  it('rejects an unknown slot key in answers with the shared error envelope', async () => {
    const created = await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    const bad = await json(`/api/applications/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ answers: { 'made.upKey': 'W1AW' } }),
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.message).toMatch(/unknown slot/i);
    expect(bad.body.error.details).toEqual({ slot: 'made.upKey' });
    expect(typeof bad.body.requestId).toBe('string');
  });

  it('returns 422 validation_failed for a body zod rejects, never 400', async () => {
    const bad = await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: '' }) });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(Array.isArray(bad.body.error.details)).toBe(true);

    const created = await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    const badPatch = await json(`/api/applications/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ includeDisclosure: 'yes-please' }),
    });
    expect(badPatch.status).toBe(422);
    expect(badPatch.body.error.code).toBe('validation_failed');
  });

  it('returns 404 not_found in the envelope for a draft that does not exist', async () => {
    const missing = await json('/api/applications/does-not-exist');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
    expect(missing.body.error.message).toMatch(/no draft/i);
  });

  it('surfaces the fact checklist and blocks export until every item is confirmed', async () => {
    const created = await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    const id = created.body.id;
    await json(`/api/applications/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: 'W8UM spent $1,099 on March 7, 2027.' }),
    });

    const before = await json(`/api/applications/${id}/export-readiness`);
    expect(before.body.ready).toBe(false);
    expect(before.body.items.length).toBeGreaterThanOrEqual(3);

    const confirmations: Record<string, { confirmed: boolean; note: string }> = {};
    for (const item of before.body.items) confirmations[item.id] = { confirmed: true, note: '' };
    const put = await json(`/api/applications/${id}/facts`, {
      method: 'PUT',
      body: JSON.stringify({ confirmations }),
    });
    expect(put.status).toBe(200);
    expect(put.body.ready).toBe(true);

    const after = await json(`/api/applications/${id}/export-readiness`);
    expect(after.body.ready).toBe(true);
    expect(after.body.unconfirmed).toBe(0);
  });

  it('blocks export while a TODO marker remains', async () => {
    const created = await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    await json(`/api/applications/${created.body.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ bodyMarkdown: 'Our club [TODO: club.callsign — callsign] applies.' }),
    });
    const readiness = await json(`/api/applications/${created.body.id}/export-readiness`);
    expect(readiness.body.ready).toBe(false);
    expect(readiness.body.openTodos).toBe(1);
  });

  it('never returns another user’s draft', async () => {
    const created = await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: 'mine' }) });
    db.prepare('UPDATE applications SET user_id = ? WHERE id = ?').run('user-2', created.body.id);
    const read = await json(`/api/applications/${created.body.id}`);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe('not_found');
    const listed = await json('/api/applications');
    expect(listed.body.applications).toEqual([]);
  });

  it('identifies the caller through deps.currentUser, not req.user', async () => {
    await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: 'user one draft' }) });
    caller = { id: 'user-2', email: 'two@example.org', role: 'member' };
    expect((await json('/api/applications')).body.applications).toEqual([]);
    caller = { id: 'user-1', email: 'one@example.org', role: 'member' };
    expect((await json('/api/applications')).body.applications).toHaveLength(1);
  });

  it('deletes a draft and its template instances', async () => {
    const created = await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    db.prepare(
      'INSERT INTO template_instances (id, application_id, template_id, position, filled_markdown, unresolved_slots_json, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run('ti-1', created.body.id, 'need-statement', 0, 'text', '[]', '2026-08-02T00:00:00.000Z');

    const del = await fetch(`${base}/api/applications/${created.body.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(db.prepare('SELECT COUNT(*) AS n FROM template_instances').get()).toEqual({ n: 0 });
  });
});

/**
 * The spec §10.4 export gate. Plan 5's export endpoints call this and let the
 * throw propagate to Plan 1's errorHandler, which renders conflict as HTTP 409.
 * These assertions are the contract Plan 5 codes against.
 */
describe('assertExportReady', () => {
  const draftWith = async (bodyMarkdown: string): Promise<string> => {
    const created = await json('/api/applications', { method: 'POST', body: JSON.stringify({ title: 'gate' }) });
    await json(`/api/applications/${created.body.id}`, { method: 'PATCH', body: JSON.stringify({ bodyMarkdown }) });
    return created.body.id as string;
  };

  it('throws conflict (409) while any factual assertion is unconfirmed', async () => {
    const id = await draftWith('W8UM spent $1,099 on March 7, 2027.');
    const err = (() => {
      try {
        assertExportReady(db, id, 'user-1');
        return undefined;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(err).toBeInstanceOf(AppError);
    expect(err?.code).toBe('conflict');
    expect(err?.status).toBe(409);
    expect(err?.message).toMatch(/unconfirmed/i);
  });

  it('throws conflict (409) while a [TODO: …] marker remains, even with every fact confirmed', async () => {
    const id = await draftWith('Our club [TODO: club.callsign — callsign] applies.');
    const readiness = await json(`/api/applications/${id}/export-readiness`);
    const confirmations: Record<string, { confirmed: boolean; note: string }> = {};
    for (const item of readiness.body.items) confirmations[item.id] = { confirmed: true, note: '' };
    await json(`/api/applications/${id}/facts`, { method: 'PUT', body: JSON.stringify({ confirmations }) });
    expect(() => assertExportReady(db, id, 'user-1')).toThrow(/TODO/);
  });

  it('throws not_found (404) for another user’s draft, so export cannot read across users', async () => {
    const id = await draftWith('Nothing to confirm here.');
    try {
      assertExportReady(db, id, 'user-2');
      throw new Error('expected assertExportReady to throw');
    } catch (e) {
      expect((e as AppError).code).toBe('not_found');
      expect((e as AppError).status).toBe(404);
    }
  });

  it('returns silently once every fact is confirmed and no TODO marker is left', async () => {
    const id = await draftWith('W8UM spent $1,099 on March 7, 2027.');
    const readiness = await json(`/api/applications/${id}/export-readiness`);
    const confirmations: Record<string, { confirmed: boolean; note: string }> = {};
    for (const item of readiness.body.items) confirmations[item.id] = { confirmed: true, note: 'checked the invoice' };
    await json(`/api/applications/${id}/facts`, { method: 'PUT', body: JSON.stringify({ confirmations }) });
    expect(() => assertExportReady(db, id, 'user-1')).not.toThrow();
  });
});

/**
 * RESOLUTIONS R24. The guard ASSERTS Plan 1's shape and CREATES NOTHING. These
 * three assertions are what stops the defect coming back: a second
 * `CREATE TABLE IF NOT EXISTS applications` in a later migration is a silent
 * no-op against a migrated database, so the only safe posture for this plan is
 * to fail loudly and name the file that owns the shape.
 */
describe('assertApplicationSchema (assert, never create)', () => {
  it('passes against a database migrated by Plan 1', () => {
    expect(() => assertApplicationSchema(db)).not.toThrow();
  });

  it('names 001-init.sql when the applications table is absent', () => {
    const bare = new Database(':memory:');
    try {
      expect(() => assertApplicationSchema(bare)).toThrow(/001-init\.sql/);
    } finally {
      bare.close();
    }
  });

  it('names the missing column when an earlier migration created a conflicting shape', () => {
    const partial = new Database(':memory:');
    partial.exec('CREATE TABLE applications (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL)');
    partial.exec('CREATE TABLE template_instances (id TEXT PRIMARY KEY, application_id TEXT NOT NULL)');
    try {
      expect(() => assertApplicationSchema(partial)).toThrow(/answers_json/);
    } finally {
      partial.close();
    }
  });

  it('creates nothing: an empty database still has neither table afterwards', () => {
    const bare = new Database(':memory:');
    try {
      expect(() => assertApplicationSchema(bare)).toThrow();
      const tables = bare
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('applications', 'template_instances')",
        )
        .all();
      expect(tables).toEqual([]);
    } finally {
      bare.close();
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/api/applications.test.ts
```

Expected failure: `Error: Failed to resolve import "./applications.js"`.

- [ ] **Step 3: Write no migration — confirm Plan 1 already owns both tables**

**RESOLUTIONS R24. Do not create `packages/server/src/db/migrations/040-application-writing.sql`, and do not edit `001-init.sql`.** Plan 1 Task 12 declares both tables with exactly the column list the repository below expects. Run this gate instead — it proves the shape is there before a line of repository code is written, and it fails if an earlier draft of this plan left a second migration behind:

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  INIT=packages/server/src/db/migrations/001-init.sql && \
  echo "-- Plan 1 declares both tables --" && \
  grep -q "CREATE TABLE applications" "$INIT" && \
  grep -q "CREATE TABLE template_instances" "$INIT" && \
  echo "-- with this plan's columns (R24) --" && \
  for c in program_id answers_json fact_confirmations_json include_disclosure facts_confirmed_at \
           position filled_markdown unresolved_slots_json; do
    grep -q "$c" "$INIT" || { echo "MISSING COLUMN in 001-init.sql: $c"; exit 1; }
  done && \
  echo "-- no other migration names these tables or their indexes --" && \
  [ "$(grep -rn 'CREATE TABLE.*applications\|CREATE TABLE.*template_instances\|idx_applications_user\|idx_template_instances_application' \
        packages/server/src/db/migrations | grep -cv '001-init\.sql')" = "0" ] && \
  echo "-- so this plan ships no migration of its own --" && \
  [ ! -e packages/server/src/db/migrations/040-application-writing.sql ] && \
  echo "SCHEMA OWNERSHIP IS CORRECT"
```

If a `040-application-writing.sql` exists from an earlier attempt, delete it — `git rm -f packages/server/src/db/migrations/040-application-writing.sql` — and rerun. If `001-init.sql` is missing a column, the fix belongs in **Plan 1 Task 12**, never here, and never by re-adding a `CREATE TABLE` of your own: `CREATE TABLE IF NOT EXISTS` matches on the table **name**, so a second declaration is a silent no-op and every insert then dies on `table applications has no column named answers_json`. Deleting Plan 1's `CREATE TABLE` is equally wrong — its `CREATE INDEX idx_applications_user ON applications(...)` would then reference a table that does not exist and migration 001 aborts with `no such table: applications`, so the server never boots.

- [ ] **Step 4: Write the repository**

There is **no** `packages/server/src/api/authedRequest.ts`. Identity arrives through `deps.currentUser(req).id` from Plan 3's `RouterDeps`; if a previous draft of this plan created that shim, delete the file.

Create `packages/server/src/db/repositories/applications.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { AppError } from '../../api/errors.js';
import { type FactConfirmation, exportReadiness } from '../../prose/facts.js';

export interface ApplicationRow {
  id: string;
  userId: string;
  programId?: string;
  title: string;
  bodyMarkdown: string;
  answers: Record<string, string>;
  factConfirmations: Record<string, FactConfirmation>;
  includeDisclosure: boolean;
  factsConfirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface RawRow {
  id: string;
  user_id: string;
  program_id: string | null;
  title: string;
  body_markdown: string;
  answers_json: string;
  fact_confirmations_json: string;
  include_disclosure: number;
  facts_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

const OWNER = 'packages/server/src/db/migrations/001-init.sql';

/**
 * RESOLUTIONS R24: Plan 1's 001-init.sql owns both tables. This map is asserted,
 * never created. Modelled on Plan 2's `ensureIngestionSchema`, for the same
 * reason: `CREATE TABLE IF NOT EXISTS` matches on the table NAME, so a second
 * declaration in a later migration is a silent no-op and the columns it lists
 * never come into existence.
 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  applications: [
    'id', 'user_id', 'program_id', 'title', 'body_markdown', 'answers_json',
    'fact_confirmations_json', 'include_disclosure', 'facts_confirmed_at',
    'created_at', 'updated_at',
  ],
  template_instances: [
    'id', 'application_id', 'template_id', 'position', 'filled_markdown',
    'unresolved_slots_json', 'created_at',
  ],
};

/**
 * Assert-never-create. Called once when the applications router is constructed,
 * so a schema drift is a startup error with a filename in it rather than a
 * `SQLITE_ERROR: table applications has no column named answers_json` on the
 * first PATCH a user makes.
 */
export function assertApplicationSchema(db: Database): void {
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.length === 0) {
      throw new Error(
        `Missing table "${table}". ${OWNER} owns it — run migrate(db) before ` +
          'constructing the applications router. This module never creates it.',
      );
    }
    const have = new Set(columns.map((c) => c.name));
    const missing = required.filter((c) => !have.has(c));
    if (missing.length > 0) {
      throw new Error(
        `Table "${table}" is missing columns [${missing.join(', ')}]. ${OWNER} owns this shape ` +
          '(RESOLUTIONS R24). Fix it there. Do NOT add a second CREATE TABLE in another ' +
          'migration — SQLite matches CREATE TABLE IF NOT EXISTS on the name, so the second ' +
          'definition silently never runs — and do NOT delete Plan 1\'s CREATE TABLE, because ' +
          'its CREATE INDEX statements would then reference a table that does not exist and ' +
          'migration 001 would abort.',
      );
    }
  }
}

function hydrate(row: RawRow): ApplicationRow {
  return {
    id: row.id,
    userId: row.user_id,
    programId: row.program_id ?? undefined,
    title: row.title,
    bodyMarkdown: row.body_markdown,
    answers: JSON.parse(row.answers_json) as Record<string, string>,
    factConfirmations: JSON.parse(row.fact_confirmations_json) as Record<string, FactConfirmation>,
    includeDisclosure: row.include_disclosure === 1,
    factsConfirmedAt: row.facts_confirmed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createApplication(
  db: Database,
  input: { userId: string; title: string; programId?: string },
): ApplicationRow {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO applications (id, user_id, program_id, title, body_markdown, answers_json,
       fact_confirmations_json, include_disclosure, facts_confirmed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', '{}', '{}', 1, NULL, ?, ?)`,
  ).run(id, input.userId, input.programId ?? null, input.title, now, now);
  return getApplication(db, id, input.userId) as ApplicationRow;
}

export function listApplications(db: Database, userId: string): ApplicationRow[] {
  const rows = db
    .prepare('SELECT * FROM applications WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId) as RawRow[];
  return rows.map(hydrate);
}

export function getApplication(db: Database, id: string, userId: string): ApplicationRow | undefined {
  const row = db.prepare('SELECT * FROM applications WHERE id = ? AND user_id = ?').get(id, userId) as
    | RawRow
    | undefined;
  return row ? hydrate(row) : undefined;
}

export function updateApplication(
  db: Database,
  id: string,
  userId: string,
  patch: { title?: string; bodyMarkdown?: string; answers?: Record<string, string>; includeDisclosure?: boolean },
): ApplicationRow | undefined {
  const existing = getApplication(db, id, userId);
  if (!existing) return undefined;
  const next = {
    title: patch.title ?? existing.title,
    bodyMarkdown: patch.bodyMarkdown ?? existing.bodyMarkdown,
    answers: patch.answers ? { ...existing.answers, ...patch.answers } : existing.answers,
    includeDisclosure: patch.includeDisclosure ?? existing.includeDisclosure,
  };
  db.prepare(
    `UPDATE applications
     SET title = ?, body_markdown = ?, answers_json = ?, include_disclosure = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
  ).run(
    next.title,
    next.bodyMarkdown,
    JSON.stringify(next.answers),
    next.includeDisclosure ? 1 : 0,
    new Date().toISOString(),
    id,
    userId,
  );
  return getApplication(db, id, userId);
}

export function setFactConfirmations(
  db: Database,
  id: string,
  userId: string,
  confirmations: Record<string, FactConfirmation>,
): ApplicationRow | undefined {
  const existing = getApplication(db, id, userId);
  if (!existing) return undefined;
  const merged = { ...existing.factConfirmations, ...confirmations };
  const readiness = exportReadiness(existing.bodyMarkdown, merged);
  db.prepare(
    'UPDATE applications SET fact_confirmations_json = ?, facts_confirmed_at = ?, updated_at = ? WHERE id = ? AND user_id = ?',
  ).run(
    JSON.stringify(merged),
    readiness.ready ? new Date().toISOString() : null,
    new Date().toISOString(),
    id,
    userId,
  );
  return getApplication(db, id, userId);
}

export function deleteApplication(db: Database, id: string, userId: string): boolean {
  db.prepare('DELETE FROM template_instances WHERE application_id IN (SELECT id FROM applications WHERE id = ? AND user_id = ?)').run(id, userId);
  const info = db.prepare('DELETE FROM applications WHERE id = ? AND user_id = ?').run(id, userId);
  return info.changes > 0;
}

/**
 * THE SPEC §10.4 EXPORT GATE. Called by Plan 5's export endpoints — DOCX,
 * Markdown, ZIP and PDF alike — before a single byte of the draft is rendered.
 *
 * Every funder policy reviewed makes the human, not the tool, accountable for
 * the content, so this throws while EITHER of these is true:
 *   1. any extracted factual assertion is still unconfirmed
 *      (exportReadiness().unconfirmed > 0), or
 *   2. any `[TODO: …]` marker remains in the draft body
 *      (exportReadiness().openTodos > 0).
 *
 * It throws AppError('conflict', …) — HTTP **409** through Plan 1's
 * errorHandler — for an ungated draft, and AppError('not_found', …) — HTTP 404
 * — when the id does not belong to userId, so an export can never read across
 * users. It returns void and mutates nothing.
 *
 * An export path that does not call this is a spec §10.4 violation: a direct
 * POST would then emit a draft carrying unverified figures and literal
 * "[TODO: …]" text into a funder's inbox.
 */
export function assertExportReady(db: Database, applicationId: string, userId: string): void {
  const app = getApplication(db, applicationId, userId);
  if (!app) throw new AppError('not_found', 'No draft with that id belongs to you.');
  const readiness = exportReadiness(app.bodyMarkdown, app.factConfirmations);
  if (!readiness.ready) {
    throw new AppError(
      'conflict',
      `This draft is not ready to export: ${readiness.unconfirmed} unconfirmed factual assertion(s) and ` +
        `${readiness.openTodos} unresolved [TODO: …] marker(s) must be handled first.`,
      { unconfirmed: readiness.unconfirmed, openTodos: readiness.openTodos },
    );
  }
}
```

- [ ] **Step 5: Write the router**

Add `zod` to the server workspace:

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npm install -w @grantspotter/server zod
```

Create `packages/server/src/api/applications.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import {
  assertApplicationSchema,
  createApplication,
  deleteApplication,
  getApplication,
  listApplications,
  setFactConfirmations,
  updateApplication,
} from '../db/repositories/applications.js';
import { buildFactChecklist, exportReadiness } from '../prose/facts.js';
import { isKnownSlot } from '../templates/slots.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';

const createBody = z.object({
  title: z.string().trim().min(1).max(200),
  programId: z.string().trim().max(120).optional(),
});

const patchBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  bodyMarkdown: z.string().max(400_000).optional(),
  answers: z.record(z.string(), z.string().max(4000)).optional(),
  includeDisclosure: z.boolean().optional(),
});

const factsBody = z.object({
  confirmations: z.record(
    z.string(),
    z.object({ confirmed: z.boolean(), note: z.string().max(2000).default('') }),
  ),
});

const NOT_FOUND = 'No draft with that id belongs to you.';

/**
 * Every route here reads or writes one user's own prose, so every route —
 * including the reads — is behind deps.requireAuth. The caller is
 * deps.currentUser(req).id and never req.user: this router does not know how
 * Plan 1 names its middleware.
 */
export function createApplicationsRouter(deps: RouterDeps): Router {
  const { db } = deps;
  assertApplicationSchema(db);
  const router = Router();
  router.use(deps.requireAuth);

  router.get('/', (req, res) => {
    res.json({ applications: listApplications(db, deps.currentUser(req).id) });
  });

  router.post('/', (req, res, next) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError('validation_failed', 'That application draft is not valid.', parsed.error.issues));
      return;
    }
    res.status(201).json(createApplication(db, { userId: deps.currentUser(req).id, ...parsed.data }));
  });

  router.get('/:id', (req, res, next) => {
    const app = getApplication(db, req.params.id as string, deps.currentUser(req).id);
    if (!app) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.json(app);
  });

  router.patch('/:id', (req, res, next) => {
    const parsed = patchBody.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError('validation_failed', 'That patch is not valid.', parsed.error.issues));
      return;
    }
    for (const key of Object.keys(parsed.data.answers ?? {})) {
      if (!isKnownSlot(key)) {
        next(new AppError('validation_failed', `unknown slot "${key}"`, { slot: key }));
        return;
      }
    }
    const updated = updateApplication(db, req.params.id as string, deps.currentUser(req).id, parsed.data);
    if (!updated) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.json(updated);
  });

  router.get('/:id/facts', (req, res, next) => {
    const app = getApplication(db, req.params.id as string, deps.currentUser(req).id);
    if (!app) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.json({ items: buildFactChecklist(app.bodyMarkdown, app.factConfirmations) });
  });

  router.put('/:id/facts', (req, res, next) => {
    const parsed = factsBody.safeParse(req.body);
    if (!parsed.success) {
      next(new AppError('validation_failed', 'Those fact confirmations are not valid.', parsed.error.issues));
      return;
    }
    const updated = setFactConfirmations(
      db,
      req.params.id as string,
      deps.currentUser(req).id,
      parsed.data.confirmations,
    );
    if (!updated) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.json(exportReadiness(updated.bodyMarkdown, updated.factConfirmations));
  });

  router.get('/:id/export-readiness', (req, res, next) => {
    const app = getApplication(db, req.params.id as string, deps.currentUser(req).id);
    if (!app) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.json(exportReadiness(app.bodyMarkdown, app.factConfirmations));
  });

  router.delete('/:id', (req, res, next) => {
    const removed = deleteApplication(db, req.params.id as string, deps.currentUser(req).id);
    if (!removed) {
      next(new AppError('not_found', NOT_FOUND));
      return;
    }
    res.status(204).end();
  });

  return router;
}
```

**This router is not mounted in this file.** It is mounted at `/api/applications` by the single `mountRoutes` callback in `packages/server/src/index.ts` (R5), and **Task 17 Step 5 of this plan is the step that adds that line** (R25). Nothing here calls `app.use`.

- [ ] **Step 6: Run the test and watch it pass**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/api/applications.test.ts
```

- [ ] **Step 7: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add packages/server/src/db packages/server/src/api packages/server/package.json package-lock.json && \
  git commit -m "feat(api): application drafts with a fact-checklist export gate"
```

---

### Task 17: Templates, prose and prompts routers

Three stateless routers. None of them reads or writes a table, which is deliberate: the SPA already holds the `Program` and the `Profile` it is working with, so passing them in the request body removes any dependency on Plan 1's repositories and keeps these endpoints trivially testable. They still take `RouterDeps` — the convention is uniform across Plans 3 and 4, and they need `deps.requireAuth`.

**What is public and what is not.** `GET /api/templates`, `GET /api/templates/slots`, `GET /api/templates/consortium/:state` and `GET /api/templates/:id` are readable without a session: the template library is published guidance, not user data. Everything that carries a user's own text or profile — `POST /api/templates/:id/fill`, both prose endpoints and both prompts endpoints — is behind `deps.requireAuth`, applied inside the router rather than at the mount site, because the mount site belongs to Plan 3 and mounts every router the same way.

Route order matters in one place: `/slots` must be registered before `/:id`, or Express matches `slots` as a template id.

**Files:**
- Create: `packages/server/src/api/writingSchemas.ts`
- Create: `packages/server/src/api/templates.ts`
- Create: `packages/server/src/api/prose.ts`
- Create: `packages/server/src/api/prompts.ts`
- Create: `packages/server/src/api/writingRouters.test.ts`
- Modify: `packages/server/src/index.ts` — **four added lines only**, inside the `mountRoutes` callback Plan 3 Task 14 created. See Step 5.

**Interfaces:**
- Consumes: `loadTemplates`, `selectTemplates`, `getTemplate` from `../templates/load.js`; `buildSlotContext`, `SLOT_VOCABULARY`, `userAnswerSlots` from `../templates/slots.js`; `fillTemplate` from `../templates/fill.js`; `pickConsortium` from `../templates/consortia.js`; `analyzeProse`, `paragraphDensities` from `../prose/index.js`; `buildFactChecklist` from `../prose/facts.js`; `composePrompt` from `../prompts/compose.js`; `disclosureSentence`, `disclosureNote`, `DISCLOSURE_DEFAULT_ON` from `../prompts/disclosure.js`; `RouterDeps` from `./deps.js` (Plan 3 Task 4); `AppError` from `./errors.js` (Plan 1).
- Produces: `createTemplatesRouter(deps: RouterDeps): Router`, `createProseRouter(deps: RouterDeps): Router`, `createPromptsRouter(deps: RouterDeps): Router`, `COPY_PROMPT_LABEL`, `COPY_PROMPT_SUBTITLE`, `programInput`, `profileInput`, `funderInput`, `answersInput`, `textInput`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/api/writingRouters.test.ts`:

```ts
import Database from 'better-sqlite3';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RouterDeps } from './deps.js';
import { AppError, errorHandler, notFoundHandler } from './errors.js';
import { createPromptsRouter } from './prompts.js';
import { createProseRouter } from './prose.js';
import { createTemplatesRouter } from './templates.js';

let base: string;
let stop: () => Promise<void>;
let db: Database.Database;
/** Flipped by the auth test to prove deps.requireAuth is really applied. */
let signedIn = true;

const PROGRAM = {
  id: 'ardc-grants',
  funderId: 'ardc',
  name: 'ARDC Grants Program',
  klass: 'ham_grant',
  summary: 'Grants for amateur radio.',
  applicantEntities: ['university'],
  amount: { instrument: 'cash_range', amountRaw: '$1,285-$258,000', awardCountRaw: 'Multiple per year' },
  deadline: { kind: 'n_fixed_dates', source: { kind: 'self' }, note: 'February 1, April 1, July 1, September 1' },
  applyVia: 'external_spa_portal',
  applyUrl: 'https://www.ardc.net/apply/',
  constraints: [],
  fundingRestrictions: ['For-profit companies are not eligible.'],
  obligations: { indirectCostCapPct: 20, costShareRequired: false, coFunderPreference: false },
  aiPolicy: { stance: 'permitted', quote: 'edit for clarity, brevity, and accuracy', url: 'https://www.ardc.net/apply/grant-application-instructions/' },
  trust: { status: 'open', sourceUrl: 'https://www.ardc.net/apply/', lastVerifiedAt: '2026-08-02', verificationMethod: 'live_fetch', contentHash: 'x' },
  rawOtherText: '',
  tags: [],
};

const PROFILE = {
  kind: 'organization',
  entity: 'club_unincorporated',
  orgName: 'Example Collegiate Amateur Radio Club',
  callsign: 'W8UM',
  state: 'MI',
  memberCount: 34,
};

beforeAll(async () => {
  db = new Database(':memory:');

  // Fakes for Plan 3's RouterDeps. requireAuth is a real gate here so the
  // "requires a session" assertions below cannot pass by accident.
  const deps: RouterDeps = {
    db,
    now: () => '2026-08-02T00:00:00.000Z',
    requireAuth: (_req, _res, next) =>
      signedIn ? next() : next(new AppError('unauthorized', 'Sign in to continue.')),
    requireAdmin: (_req, _res, next) => next(),
    currentUser: () => ({ id: 'user-1', email: 'one@example.org', role: 'member' }),
  };

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/templates', createTemplatesRouter(deps));
  app.use('/api/prose', createProseRouter(deps));
  app.use('/api/prompts', createPromptsRouter(deps));
  app.use(notFoundHandler());
  app.use(errorHandler({ logger: () => undefined }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stop = () =>
    new Promise<void>((resolve) =>
      server.close(() => {
        db.close();
        resolve();
      }),
    );
});

afterAll(async () => stop());

const post = async (p: string, body: unknown) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const get = async (p: string) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
};

describe('templates router', () => {
  it('lists components, overlays and playbooks for a program', async () => {
    const { body } = await get('/api/templates?klass=ham_grant&programId=ardc-grants');
    expect(body.components.length).toBeGreaterThanOrEqual(8);
    expect(body.overlays.map((t: { id: string }) => t.id)).toContain('funder-ardc');
    expect(body.playbooks.map((t: { id: string }) => t.id)).toContain('funder-campus-sga');
    expect(body.components[0].body).toBeUndefined(); // summaries only
  });

  it('serves the slot vocabulary before it tries to match an id', async () => {
    const { status, body } = await get('/api/templates/slots');
    expect(status).toBe(200);
    expect(body.all.length).toBeGreaterThan(50);
    expect(body.userAnswerable.every((s: { source: string }) => s.source === 'user')).toBe(true);
  });

  it('serves one template with its body', async () => {
    const { body } = await get('/api/templates/need-statement');
    expect(body.id).toBe('need-statement');
    expect(body.body).toContain('{{club.callsign}}');
    expect(body.slots).toContain('club.name');
  });

  it('404s an unknown template rather than throwing, in the shared envelope', async () => {
    const { status, body } = await get('/api/templates/nope');
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
    expect(body.error.message).toMatch(/unknown template "nope"/);
    expect(typeof body.requestId).toBe('string');
  });

  it('fills a template from a profile and marks the rest as TODO', async () => {
    const { body } = await post('/api/templates/need-statement/fill', {
      profile: PROFILE,
      program: PROGRAM,
      answers: { 'club.city': 'Ann Arbor' },
    });
    expect(body.markdown).toContain('Example Collegiate Amateur Radio Club');
    expect(body.markdown).toContain('W8UM');
    expect(body.markdown).toContain('Ann Arbor');
    expect(body.markdown).toContain('[TODO: project.problem');
    expect(body.unresolvedSlots).toContain('project.problem');
  });

  it('resolves a Space Grant consortium by state and never claims it is verified', async () => {
    const { body } = await get('/api/templates/consortium/MI');
    expect(body.consortium.name).toMatch(/Michigan Space Grant/);
    expect(body.consortium.verified).toBe(false);
    const missing = await get('/api/templates/consortium/ZZ');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('keeps the library public but puts fill behind deps.requireAuth', async () => {
    signedIn = false;
    try {
      expect((await get('/api/templates?klass=ham_grant')).status).toBe(200);
      expect((await get('/api/templates/slots')).status).toBe(200);
      const blocked = await post('/api/templates/need-statement/fill', { profile: PROFILE, program: PROGRAM });
      expect(blocked.status).toBe(401);
      expect(blocked.body.error.code).toBe('unauthorized');
    } finally {
      signedIn = true;
    }
  });
});

describe('prose router', () => {
  it('returns the report plus per-paragraph densities', async () => {
    const { body } = await post('/api/prose/analyze', {
      text: 'Furthermore, this comprehensive initiative underscores our unwavering commitment.',
    });
    expect(body.report.paragraphs[0].verdict).toBe('generic');
    expect(body.report.paragraphs[0].stockTransitionHits).toContain('Furthermore');
    expect(body.densities[0].referentDensity).toBe(0);
    expect(body.densities[0].styleDensity).toBeGreaterThan(0);
  });

  it('returns a fact checklist with every item unconfirmed', async () => {
    const { body } = await post('/api/prose/facts', { text: 'W8UM spent $1,099 on March 7, 2027.' });
    expect(body.items.length).toBeGreaterThanOrEqual(3);
    expect(body.items.every((i: { confirmed: boolean }) => i.confirmed === false)).toBe(true);
  });

  it('rejects a missing or oversized body with 422 validation_failed, never 400', async () => {
    const bad = await post('/api/prose/analyze', {});
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(bad.body.error.message).toMatch(/"text"/);
  });

  it('requires a session for both prose endpoints', async () => {
    signedIn = false;
    try {
      expect((await post('/api/prose/analyze', { text: 'Anything at all.' })).status).toBe(401);
      expect((await post('/api/prose/facts', { text: 'Anything at all.' })).status).toBe(401);
    } finally {
      signedIn = true;
    }
  });
});

describe('prompts router', () => {
  it('composes a prompt and returns the exact button copy', async () => {
    const { body } = await post('/api/prompts/compose', {
      program: PROGRAM,
      profile: PROFILE,
      includeDisclosure: true,
    });
    expect(body.label).toBe('Copy AI Prompt — includes AI-detection avoidance');
    expect(body.subtitle).toMatch(/interview/i);
    expect(body.prompt).toContain('ARDC Grants Program');
    expect(body.prompt).toContain('For-profit companies are not eligible.');
    expect(body.prompt).toContain('10.1126/sciadv.adt3813');
    expect(body.prompt).toMatch(/AI-use disclosure/);
  });

  it('returns the editable disclosure sentence and its policy note', async () => {
    const { body } = await post('/api/prompts/disclosure', {
      stance: 'unaddressed',
      funderName: 'ARRL Foundation',
      toolName: 'Claude',
      authorName: 'Dana Ruiz',
    });
    expect(body.defaultOn).toBe(true);
    expect(body.sentence).toContain('Dana Ruiz');
    expect(body.note).toMatch(/has not published/i);
  });

  it('rejects a body that is not a program with 422 validation_failed', async () => {
    const bad = await post('/api/prompts/compose', { program: { id: 'x' }, includeDisclosure: false });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('validation_failed');
    expect(Array.isArray(bad.body.error.details)).toBe(true);
  });

  it('requires a session for both prompts endpoints', async () => {
    signedIn = false;
    try {
      expect(
        (await post('/api/prompts/compose', { program: PROGRAM, includeDisclosure: true })).status,
      ).toBe(401);
      expect(
        (await post('/api/prompts/disclosure', { stance: 'unaddressed', funderName: 'ARDC' })).status,
      ).toBe(401);
    } finally {
      signedIn = true;
    }
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/server/src/api/writingRouters.test.ts
```

Expected failure: `Error: Failed to resolve import "./prompts.js"`.

- [ ] **Step 3: Write the request schemas**

Create `packages/server/src/api/writingSchemas.ts`:

```ts
import { z } from 'zod';

/**
 * Plan-local. These validate ONLY the fields the writing tools consume, and
 * pass everything else through untouched, so they never drift from the frozen
 * core types in packages/core/src/types.ts.
 */

export const funderInput = z
  .object({ id: z.string(), name: z.string(), homepage: z.string() })
  .passthrough();

export const profileInput = z
  .object({ kind: z.enum(['student', 'organization']) })
  .passthrough();

export const programInput = z
  .object({
    id: z.string(),
    funderId: z.string(),
    name: z.string(),
    klass: z.enum(['ham_grant', 'ham_scholarship', 'adjacent_stem', 'equipment_in_kind']),
    applicantEntities: z.array(z.string()),
    amount: z.object({ amountRaw: z.string(), awardCountRaw: z.string() }).passthrough(),
    deadline: z.object({ kind: z.string(), note: z.string() }).passthrough(),
    applyVia: z.string(),
    applyUrl: z.string().optional(),
    constraints: z.array(z.object({ hard: z.boolean(), rawText: z.string() }).passthrough()),
    fundingRestrictions: z.array(z.string()),
    obligations: z.object({}).passthrough(),
    aiPolicy: z.object({ stance: z.string() }).passthrough(),
    trust: z
      .object({ status: z.string(), sourceUrl: z.string(), lastVerifiedAt: z.string() })
      .passthrough(),
    rawOtherText: z.string(),
  })
  .passthrough();

export const answersInput = z.record(z.string(), z.string().max(4000));
export const textInput = z.object({ text: z.string().min(1).max(400_000) });
```

- [ ] **Step 4: Write the three routers**

Create `packages/server/src/api/templates.ts`:

```ts
import { Router } from 'express';
import type { Funder, OpportunityClass, Profile, Program } from '@grantspotter/core';
import { z } from 'zod';
import { pickConsortium } from '../templates/consortia.js';
import { fillTemplate } from '../templates/fill.js';
import { type TemplateDoc, getTemplate, loadTemplates, selectTemplates } from '../templates/load.js';
import { SLOT_VOCABULARY, buildSlotContext, userAnswerSlots } from '../templates/slots.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { answersInput, funderInput, profileInput, programInput } from './writingSchemas.js';

const summarize = (t: TemplateDoc) => ({
  id: t.id,
  title: t.title,
  layer: t.layer,
  order: t.order,
  appliesTo: t.appliesTo,
  lengthTarget: t.lengthTarget,
  requires: t.requires,
  programIds: t.programIds,
  alwaysAvailable: t.alwaysAvailable,
  sources: t.sources,
  slots: t.slots,
});

const fillBody = z.object({
  profile: profileInput.optional(),
  program: programInput.optional(),
  funder: funderInput.optional(),
  answers: answersInput.optional(),
});

/**
 * The four GETs are public: the template library is published guidance, not
 * user data. POST /:id/fill carries the caller's own profile and answers, so it
 * is behind deps.requireAuth.
 */
export function createTemplatesRouter(deps: RouterDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    const klass = typeof req.query.klass === 'string' ? (req.query.klass as OpportunityClass) : undefined;
    const programId = typeof req.query.programId === 'string' ? req.query.programId : undefined;
    const funderId = typeof req.query.funderId === 'string' ? req.query.funderId : undefined;
    const selection = selectTemplates(loadTemplates(), { klass, programId, funderId });
    res.json({
      components: selection.components.map(summarize),
      overlays: selection.overlays.map(summarize),
      playbooks: selection.playbooks.map(summarize),
    });
  });

  // Registered before /:id, or Express matches "slots" as a template id.
  router.get('/slots', (_req, res) => {
    res.json({ all: SLOT_VOCABULARY, userAnswerable: userAnswerSlots() });
  });

  router.get('/consortium/:state', (req, res, next) => {
    const consortium = pickConsortium(req.params.state as string);
    if (!consortium) {
      next(new AppError('not_found', 'No Space Grant consortium for that state code.'));
      return;
    }
    res.json({ consortium });
  });

  router.get('/:id', (req, res, next) => {
    let t: TemplateDoc;
    try {
      t = getTemplate(req.params.id as string);
    } catch {
      next(new AppError('not_found', `unknown template "${req.params.id}"`));
      return;
    }
    res.json({ ...summarize(t), body: t.body });
  });

  router.post('/:id/fill', deps.requireAuth, (req, res, next) => {
    const parsed = fillBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError('validation_failed', 'That fill request is not valid.', parsed.error.issues));
      return;
    }
    let template: TemplateDoc;
    try {
      template = getTemplate(req.params.id as string);
    } catch {
      next(new AppError('not_found', `unknown template "${req.params.id}"`));
      return;
    }
    const ctx = buildSlotContext({
      profile: parsed.data.profile as Profile | undefined,
      program: parsed.data.program as Program | undefined,
      funder: parsed.data.funder as Funder | undefined,
      answers: parsed.data.answers,
    });
    res.json({ templateId: template.id, title: template.title, ...fillTemplate(template.body, ctx) });
  });

  return router;
}
```

Create `packages/server/src/api/prose.ts`:

```ts
import { Router } from 'express';
import { buildFactChecklist } from '../prose/facts.js';
import { analyzeProse, paragraphDensities } from '../prose/index.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { textInput } from './writingSchemas.js';

const TEXT_REQUIRED = 'A non-empty "text" field is required.';

/** Both endpoints carry the caller's own draft prose, so both require a session. */
export function createProseRouter(deps: RouterDeps): Router {
  const router = Router();
  router.use(deps.requireAuth);

  router.post('/analyze', (req, res, next) => {
    const parsed = textInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError('validation_failed', TEXT_REQUIRED, parsed.error.issues));
      return;
    }
    const report = analyzeProse(parsed.data.text);
    res.json({
      report,
      densities: report.paragraphs.map((p) => ({ index: p.index, ...paragraphDensities(p) })),
    });
  });

  router.post('/facts', (req, res, next) => {
    const parsed = textInput.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError('validation_failed', TEXT_REQUIRED, parsed.error.issues));
      return;
    }
    res.json({ items: buildFactChecklist(parsed.data.text) });
  });

  return router;
}
```

Create `packages/server/src/api/prompts.ts`:

```ts
import type { AiStance, Profile, Program } from '@grantspotter/core';
import { Router } from 'express';
import { z } from 'zod';
import { composePrompt } from '../prompts/compose.js';
import { DISCLOSURE_DEFAULT_ON, disclosureNote, disclosureSentence } from '../prompts/disclosure.js';
import type { RouterDeps } from './deps.js';
import { AppError } from './errors.js';
import { profileInput, programInput } from './writingSchemas.js';

/** The exact copy required by the contract. Asserted by an e2e test. */
export const COPY_PROMPT_LABEL = 'Copy AI Prompt — includes AI-detection avoidance';
export const COPY_PROMPT_SUBTITLE =
  'Includes: this funder’s published criteria, restrictions and obligations · their AI policy, quoted, with the source URL · your profile facts · an interview-first rule so the model asks before it drafts · the specificity ruleset (named subjects, proper nouns, figures, dates) · banned stock transitions, openers and closers · a brevity pass · a never-invent-a-citation rule';

const composeBody = z.object({
  program: programInput,
  profile: profileInput.optional(),
  templateId: z.string().max(120).optional(),
  includeDisclosure: z.boolean(),
});

const disclosureBody = z.object({
  stance: z.enum(['permitted', 'permitted_with_disclosure', 'discouraged', 'prohibited', 'unaddressed']),
  funderName: z.string().max(200),
  toolName: z.string().max(120).optional(),
  authorName: z.string().max(200).optional(),
  usage: z.enum(['drafting', 'editing', 'both']).optional(),
});

/** Both endpoints echo the caller's own profile back into the prompt, so both require a session. */
export function createPromptsRouter(deps: RouterDeps): Router {
  const router = Router();
  router.use(deps.requireAuth);

  router.post('/compose', (req, res, next) => {
    const parsed = composeBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError('validation_failed', 'That prompt request is not valid.', parsed.error.issues));
      return;
    }
    let prompt: string;
    try {
      prompt = composePrompt({
        program: parsed.data.program as unknown as Program,
        profile: parsed.data.profile as Profile | undefined,
        templateId: parsed.data.templateId,
        includeDisclosure: parsed.data.includeDisclosure,
      });
    } catch (err) {
      // composePrompt throws only on a program it cannot ground the prompt in
      // (for example a missing aiPolicy quote), which is a bad request body.
      next(new AppError('validation_failed', (err as Error).message));
      return;
    }
    res.json({ prompt, label: COPY_PROMPT_LABEL, subtitle: COPY_PROMPT_SUBTITLE });
  });

  router.post('/disclosure', (req, res, next) => {
    const parsed = disclosureBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError('validation_failed', 'That disclosure request is not valid.', parsed.error.issues));
      return;
    }
    res.json({
      sentence: disclosureSentence(parsed.data),
      note: disclosureNote(parsed.data.stance as AiStance),
      defaultOn: DISCLOSURE_DEFAULT_ON,
    });
  });

  return router;
}
```

- [ ] **Step 5: Add this plan's four lines to the one mount hook**

**RESOLUTIONS R25: the hook is filled incrementally, and this is this plan's turn.** There is exactly one composition site in the repository — the `mountRoutes` callback passed to `createApp` from `packages/server/src/index.ts`, which Plan 1 invokes on the line immediately above `app.use(notFoundHandler())`. **Plan 3 Task 14** creates that callback containing Plan 3's own routers plus a comment reserving the final position for Plan 5's SPA middleware; it does **not** name this plan's routers, because forward-referencing four modules that do not exist yet would break Plan 3's own `npm run build` and take the whole Playwright suite down with it. This step adds them.

Open `packages/server/src/index.ts` and add these four lines **inside the existing `mountRoutes` callback**, after Plan 3's `mountProductApi(...)` call and **above** the reserved-last-position comment (the one that says the SPA middleware must be the last statement). Add nothing else to that file:

```ts
    // --- Plan 4: applications, templates, prose analysis, prompt composition
    //     (RESOLUTIONS R17 + R25). All four take the FULL RouterDeps. They are
    //     NOT `applicationsRouter({ db })` or `templatesRouter()`: those symbols
    //     do not exist, and a factory called without `currentUser`/`requireAuth`
    //     throws on the first request rather than at startup. ---
    a.use('/api/applications', createApplicationsRouter(routerDeps));
    a.use('/api/templates', createTemplatesRouter(routerDeps));
    a.use('/api/prose', createProseRouter(routerDeps));
    a.use('/api/prompts', createPromptsRouter(routerDeps));
```

and the matching imports at the top of the same file:

```ts
import { createApplicationsRouter } from './api/applications.js';
import { createPromptsRouter } from './api/prompts.js';
import { createProseRouter } from './api/prose.js';
import { createTemplatesRouter } from './api/templates.js';
```

`a` is the callback's own parameter name and `routerDeps` is the `RouterDeps` Plan 3 builds once, just above `createApp`. **Use whatever names that file already uses** — do not rename them, do not rebuild a second `RouterDeps`, and do not move the call out of the callback. Everything below the reserved comment stays below it: the SPA middleware must remain the last statement or `/api/*` gets shadowed by the history fallback.

Three things must **not** happen here: no `app.use(...)` after `createApp` returns (the app is sealed by `notFoundHandler()`, so the mount would be silently unreachable and every writing endpoint would 404 with `not_found`); no new file named `packages/server/src/api/index.ts`; and no mount inside this plan's own router modules.

Now verify:

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  echo "-- the app is composed through the mountRoutes hook --" && \
  grep -q "mountRoutes" packages/server/src/index.ts && \
  echo "-- the callback calls router factories, whatever the deps variable is named --" && \
  grep -qE "create.*Router\(" packages/server/src/index.ts && \
  echo "-- all four writing routers are mounted in production code --" && \
  for r in createTemplatesRouter createProseRouter createPromptsRouter createApplicationsRouter; do
    [ -n "$(grep -rl "$r(" packages/server/src --include='*.ts' \
              | grep -v '\.test\.ts' \
              | grep -v "src/api/\(templates\|prose\|prompts\|applications\)\.ts")" ] \
      || { echo "MISSING MOUNT: $r"; exit 1; }
  done && \
  echo "-- exactly four EXECUTABLE calls, each with a deps VALUE, never () and never ({ db }) --" && \
  [ "$(grep -vE '^[[:space:]]*//' packages/server/src/index.ts \
        | grep -cE 'create(Applications|Templates|Prose|Prompts)Router\(')" = "4" ] && \
  ! grep -nE "create(Applications|Templates|Prose|Prompts)Router\( *(\)|\{)" packages/server/src/index.ts && \
  echo "-- no router module mounts itself; index.ts is the only production site --" && \
  [ -z "$(grep -rn "use('/api/\(templates\|prose\|prompts\|applications\)'" \
            packages/server/src --include='*.ts' \
            | grep -v '\.test\.ts' | grep -v 'src/index\.ts')" ] && \
  echo "-- and nothing is mounted after createApp returns --" && \
  ! grep -n "^app\.use(" packages/server/src/index.ts && \
  echo "-- if Plan 5's SPA middleware has landed, it is still the last statement --" && \
  awk '!/^[[:space:]]*\/\// { if (/createSpaMiddleware/) spa = NR; if (/createPromptsRouter/) prompts = NR }
       END { if (spa != 0 && spa < prompts) { print "SPA MIDDLEWARE IS NOT LAST: line " spa; exit 1 } }' \
      packages/server/src/index.ts && \
  echo "MOUNTING IS CORRECT"
```

What each gate is for:

- **`create.*Router(`** — the loosened form, and it is loosened deliberately (R25). The earlier version of this step grepped for the literal `createTemplatesRouter(deps)`; Plan 3 names its variable `routerDeps`, so that gate false-failed on perfectly correct code and invited an executor to "fix" it by renaming Plan 3's variable.
- **The `MISSING MOUNT` loop** — asserts each factory is *called* from some file other than the one that defines it, which after this step is `packages/server/src/index.ts`. `[ -n "$(…)" ]` rather than `grep -qv`: `-q` combined with `-v` is not portable across grep implementations and silently reports "no match" on some of them.
- **The `= "4"` count and the `Router( *(\)|\{)` check** — catch the R17 regression directly: `createTemplatesRouter()` or `createApplicationsRouter({ db })` typechecks nowhere but, if it did, would throw on `deps.currentUser` at the first request rather than at startup. **The count is taken over executable lines only** — `grep -vE '^[[:space:]]*//'` first — because Plan 3's reservation comment already *quotes* all four factory calls (`//     a.use('/api/applications', createApplicationsRouter(routerDeps));` and its three siblings). Counting the raw file gives **8** after you add the four real lines, the `&&` chain aborts on correct code, and the obvious "fix" is to delete Plan 3's reservation comment — which is the block Plan 5 Task 9 Step 9 and Plan 5 Task 17 append at, and the only thing keeping the SPA middleware last. Leave the comment alone; filter it out of the count instead.
- **The stray-mount check** — those `use('/api/…')` lines may appear only in test files (which build throwaway express apps) and in `index.ts`. A router module that mounts itself is dead code.
- **`^app.use(`** — an unindented, top-level `app.use(` in `index.ts` is exactly the shape of a mount added *after* `createApp` returns, which R5 forbids because the app is already sealed by `notFoundHandler()`.
- **The `createSpaMiddleware` ordering check** — also executable-lines-only, and for the same reason: Plan 3's reservation comment quotes `//     a.use(createSpaMiddleware(webDistRoot()));` *above* the position where this plan's four lines land, so a line-number comparison over the raw file reports "SPA is not last" against a perfectly correct file. The `awk` form ignores comment lines, so `spa` stays unset for the whole of Plan 4 (nothing to compare, gate passes) and only starts enforcing once Plan 5 Task 17 adds the real statement (R16/R25). If the real SPA middleware ever sits above these four lines, its history fallback answers `POST /api/prompts/compose` with `index.html`.

If a `MISSING MOUNT` line prints after you have edited the file, you edited the wrong callback — the mount site is **Plan 3's Task 14**, `packages/server/src/index.ts`, inside the `mountRoutes` callback passed to `createApp`. Never after `createApp` returns, and never from a router module in this plan.

- [ ] **Step 6: Run the test and the typecheck, then commit**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  npx vitest run packages/server/src/api/ && npm run typecheck && npm run build && \
  git add packages/server/src/api packages/server/src/index.ts && \
  git commit -m "feat(api): templates, prose and prompts routers, mounted through mountRoutes"
```

---

### Task 18: Web — writing API client, Templates route and template picker

The SPA re-declares the DTO shapes it consumes. That duplication is intentional and required by the contract's one-way import rule: `web → core` only, never `web → server`.

**This task also makes the writing desk reachable.** Routes that exist but that nothing links to are dead: Plan 3's `AppShell` rail arrives with seven `NAV` entries — Browse, Calendar, Watchlist, Inbox, Sources, Profile, and an `adminOnly` Admin entry — and nothing else, so without Step 6 a user has no way to reach the templates, the prose check, the fact checklist or the copy-prompt button at all. Step 6 adds two rail entries **and** the deep link from an opportunity to a draft for that program, and Task 20's e2e reaches both screens by clicking those links rather than by `page.goto`, so a regression that drops them fails the suite.

**Files:**
- Create: `packages/web/src/api/writing.ts`
- Create: `packages/web/src/components/TemplatePicker.tsx`
- Create: `packages/web/src/routes/Templates.tsx`
- Create: `packages/web/src/routes/Templates.test.tsx`
- Modify: `packages/web/src/App.tsx` (Plan 3's file — add two routes)
- Modify: `packages/web/src/components/AppShell.tsx` (Plan 3's file — **insert** two `NAV` entries; never retype the array, RESOLUTIONS R18)
- Modify: `packages/web/src/routes/Opportunity.tsx` (Plan 3's file — add the "Start an application for this program" deep link)

**Interfaces:**
- Consumes: the endpoints from Task 17.
- Produces: `TemplateSummaryDTO`, `TemplateDetailDTO`, `SlotDefDTO`, `FilledTemplateDTO`, `ProseReportDTO`, `DensityDTO`, `FactItemDTO`, `ExportReadinessDTO`, `ApplicationDTO`, `WritingApiError`, and the client functions `listTemplates`, `fetchTemplate`, `fillTemplateRemote`, `fetchSlots`, `fetchConsortium`, `analyzeDraft`, `extractFacts`, `composePromptRemote`, `fetchDisclosure`, `listApplications`, `createApplication`, `fetchApplication`, `patchApplication`, `putFactConfirmations`, `fetchExportReadiness`, `fetchProgramForDraft`, `fetchActiveProfile`; components `TemplatePicker`, `TemplatesRoute`, `TemplatesScreen`.

- [ ] **Step 1: Install the component-test toolchain**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  npm install -w @grantspotter/web -D @testing-library/react jsdom
```

If Plan 3 already added them, npm reports "up to date" and this is a no-op.

- [ ] **Step 2: Write the failing test**

Create `packages/web/src/routes/Templates.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TemplatesRoute, TemplatesScreen } from './Templates.js';

const LIST = {
  components: [
    { id: 'need-statement', title: 'Need statement', layer: 'component', order: 10, appliesTo: ['ham_grant'], lengthTarget: '200-300 words', requires: [], programIds: [], alwaysAvailable: false, sources: [], slots: ['club.name'] },
    { id: 'budget-justification', title: 'Budget and justification', layer: 'component', order: 50, appliesTo: ['ham_grant'], lengthTarget: '200-400 words', requires: [], programIds: [], alwaysAvailable: false, sources: [], slots: [] },
  ],
  overlays: [
    { id: 'funder-ardc', title: 'ARDC Grants Program — funder overlay', layer: 'funder', order: 10, appliesTo: ['ham_grant'], requires: ['need-statement'], programIds: ['ardc-grants'], alwaysAvailable: false, sources: [{ label: 'ARDC apply page', url: 'https://www.ardc.net/apply/' }], slots: [] },
  ],
  playbooks: [
    { id: 'funder-campus-sga', title: 'Campus student government playbook', layer: 'funder', order: 80, appliesTo: [], requires: [], programIds: [], alwaysAvailable: true, sources: [{ label: 'FSU SGA', url: 'https://sga.fsu.edu/accounting/funding-your-rso' }], slots: [] },
  ],
};

const DETAIL = { ...LIST.components[0], body: '## What this section has to do\n\n{{club.name}} needs it.' };

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const url = String(input);
    const payload = url.includes('/api/templates/need-statement') ? DETAIL : LIST;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TemplatesRoute', () => {
  it('renders components, funder overlays and always-available playbooks in separate groups', async () => {
    stubFetch();
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    await waitFor(() => expect(screen.getByText('Need statement')).toBeTruthy());
    expect(screen.getByText('ARDC Grants Program — funder overlay')).toBeTruthy();
    expect(screen.getByText('Campus student government playbook')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /funder overlays/i })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /always available/i })).toBeTruthy();
  });

  it('shows the cited source link for every funder overlay', async () => {
    stubFetch();
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    const link = await screen.findByRole('link', { name: 'ARDC apply page' });
    expect(link.getAttribute('href')).toBe('https://www.ardc.net/apply/');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('loads a template body when one is selected', async () => {
    stubFetch();
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    const button = await screen.findByRole('button', { name: /Need statement/ });
    button.click();
    await waitFor(() => expect(screen.getByText(/What this section has to do/)).toBeTruthy());
  });

  it('reports a failure instead of rendering an empty library', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    render(<TemplatesRoute programId="ardc-grants" klass="ham_grant" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/could not load/i));
  });
});

describe('TemplatesScreen', () => {
  it('carries programId and klass from the query string into the request', async () => {
    stubFetch();
    render(
      <MemoryRouter initialEntries={['/templates?programId=ardc-grants&klass=ham_grant']}>
        <TemplatesScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Need statement')).toBeTruthy());
    const called = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.startsWith('/api/templates?'));
    expect(called).toContain('programId=ardc-grants');
    expect(called).toContain('klass=ham_grant');
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/web/src/routes/Templates.test.tsx
```

Expected failure: `Error: Failed to resolve import "./Templates.js"`.

- [ ] **Step 4: Write the API client**

Create `packages/web/src/api/writing.ts`:

```ts
/**
 * DTOs are re-declared here rather than imported from the server: the contract
 * allows web → core only. Any drift is caught by the e2e suite, which drives
 * the real endpoints.
 */

export interface TemplateSourceDTO { label: string; url: string }

export interface TemplateSummaryDTO {
  id: string;
  title: string;
  layer: 'component' | 'funder';
  order: number;
  appliesTo: string[];
  lengthTarget?: string;
  requires: string[];
  programIds: string[];
  alwaysAvailable: boolean;
  sources: TemplateSourceDTO[];
  slots: string[];
}

export interface TemplateDetailDTO extends TemplateSummaryDTO { body: string }

export interface TemplateListDTO {
  components: TemplateSummaryDTO[];
  overlays: TemplateSummaryDTO[];
  playbooks: TemplateSummaryDTO[];
}

export interface SlotDefDTO { path: string; label: string; hint: string; source: 'profile' | 'program' | 'user' }
export interface FilledTemplateDTO { templateId: string; title: string; markdown: string; unresolvedSlots: string[] }

export interface ParagraphReportDTO {
  index: number;
  text: string;
  styleWordHits: string[];
  properNounCount: number;
  figureCount: number;
  tricolonCount: number;
  trailingParticipialCount: number;
  stockTransitionHits: string[];
  verdict: 'specific' | 'thin' | 'generic';
}

export interface ProseReportDTO {
  paragraphs: ParagraphReportDTO[];
  sentenceLengthVariance: number;
  documentTricolonCount: number;
  stockOpenerHits: string[];
  stockCloserHits: string[];
  paragraphsWithNoProperNounOrFigure: number[];
}

export interface DensityDTO { index: number; words: number; styleDensity: number; referentDensity: number }

export interface FactItemDTO {
  id: string;
  kind: string;
  text: string;
  start: number;
  end: number;
  context: string;
  confirmed: boolean;
  note: string;
}

export interface ExportReadinessDTO {
  ready: boolean;
  unconfirmed: number;
  openTodos: number;
  items: FactItemDTO[];
}

export interface ApplicationDTO {
  id: string;
  userId: string;
  programId?: string;
  title: string;
  bodyMarkdown: string;
  answers: Record<string, string>;
  factConfirmations: Record<string, { confirmed: boolean; note: string }>;
  includeDisclosure: boolean;
  factsConfirmedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConsortiumDTO {
  state: string;
  name: string;
  leadInstitution: string;
  verified: boolean;
  directoryUrl: string;
  note: string;
}

/**
 * The server speaks exactly one error envelope (RESOLUTIONS R6):
 *   { error: { code, message, details? }, requestId }
 * Reading `.error` as a string would render "[object Object]" in the UI, so it
 * is parsed structurally here. This module keeps its own `request` rather than
 * reusing Plan 3's `apiSend`, which covers only POST/PUT/DELETE — the drafts
 * API needs PATCH.
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

export class WritingApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly status: number,
    readonly requestId: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'WritingApiError';
  }
}

interface ApiErrorBody {
  error?: { code?: ApiErrorCode; message?: string; details?: unknown };
  requestId?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    throw new WritingApiError(
      body?.error?.code ?? 'internal',
      body?.error?.message ?? res.statusText ?? 'request failed',
      res.status,
      body?.requestId ?? '',
      body?.error?.details,
    );
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) search.set(k, v);
  const s = search.toString();
  return s ? `?${s}` : '';
};

export const listTemplates = (q: { klass?: string; programId?: string; funderId?: string }): Promise<TemplateListDTO> =>
  request(`/api/templates${qs(q)}`);

export const fetchTemplate = (id: string): Promise<TemplateDetailDTO> =>
  request(`/api/templates/${encodeURIComponent(id)}`);

export const fetchSlots = (): Promise<{ all: SlotDefDTO[]; userAnswerable: SlotDefDTO[] }> =>
  request('/api/templates/slots');

export const fetchConsortium = (state: string): Promise<{ consortium: ConsortiumDTO }> =>
  request(`/api/templates/consortium/${encodeURIComponent(state)}`);

export const fillTemplateRemote = (
  id: string,
  body: { profile?: unknown; program?: unknown; funder?: unknown; answers?: Record<string, string> },
): Promise<FilledTemplateDTO> =>
  request(`/api/templates/${encodeURIComponent(id)}/fill`, { method: 'POST', body: JSON.stringify(body) });

export const analyzeDraft = (text: string): Promise<{ report: ProseReportDTO; densities: DensityDTO[] }> =>
  request('/api/prose/analyze', { method: 'POST', body: JSON.stringify({ text }) });

export const extractFacts = (text: string): Promise<{ items: FactItemDTO[] }> =>
  request('/api/prose/facts', { method: 'POST', body: JSON.stringify({ text }) });

export const composePromptRemote = (body: {
  program: unknown;
  profile?: unknown;
  templateId?: string;
  includeDisclosure: boolean;
}): Promise<{ prompt: string; label: string; subtitle: string }> =>
  request('/api/prompts/compose', { method: 'POST', body: JSON.stringify(body) });

export const fetchDisclosure = (body: {
  stance: string;
  funderName: string;
  toolName?: string;
  authorName?: string;
}): Promise<{ sentence: string; note: string; defaultOn: boolean }> =>
  request('/api/prompts/disclosure', { method: 'POST', body: JSON.stringify(body) });

export const listApplications = (): Promise<{ applications: ApplicationDTO[] }> => request('/api/applications');

export const createApplication = (body: { title: string; programId?: string }): Promise<ApplicationDTO> =>
  request('/api/applications', { method: 'POST', body: JSON.stringify(body) });

export const fetchApplication = (id: string): Promise<ApplicationDTO> =>
  request(`/api/applications/${encodeURIComponent(id)}`);

export const patchApplication = (
  id: string,
  patch: { title?: string; bodyMarkdown?: string; answers?: Record<string, string>; includeDisclosure?: boolean },
): Promise<ApplicationDTO> =>
  request(`/api/applications/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const putFactConfirmations = (
  id: string,
  confirmations: Record<string, { confirmed: boolean; note: string }>,
): Promise<ExportReadinessDTO> =>
  request(`/api/applications/${encodeURIComponent(id)}/facts`, {
    method: 'PUT',
    body: JSON.stringify({ confirmations }),
  });

export const fetchExportReadiness = (id: string): Promise<ExportReadinessDTO> =>
  request(`/api/applications/${encodeURIComponent(id)}/export-readiness`);

/**
 * Two reads from Plan 3's endpoints, used only by the deep link
 * (/applications?programId=…): the draft editor needs the whole Program to
 * compose a grounded prompt, and the profile to fill slots.
 */
export const fetchProgramForDraft = (programId: string): Promise<{ program: unknown; funder: unknown }> =>
  request(`/api/programs/${encodeURIComponent(programId)}`);

export const fetchActiveProfile = async (): Promise<unknown> => {
  const body = await request<{ student: unknown | null; organization: unknown | null }>('/api/profiles');
  return body.student ?? body.organization ?? undefined;
};
```

- [ ] **Step 5: Write the picker and the route**

Create `packages/web/src/components/TemplatePicker.tsx`:

```tsx
import type { TemplateSummaryDTO } from '../api/writing.js';

interface Props {
  heading: string;
  templates: TemplateSummaryDTO[];
  selectedId?: string;
  onSelect: (id: string) => void;
  emptyMessage: string;
}

export function TemplatePicker({ heading, templates, selectedId, onSelect, emptyMessage }: Props): JSX.Element {
  return (
    <section className="template-group">
      <h3>{heading}</h3>
      {templates.length === 0 ? (
        <p className="muted">{emptyMessage}</p>
      ) : (
        <ul className="template-list">
          {templates.map((t) => (
            <li key={t.id} className={t.id === selectedId ? 'selected' : undefined}>
              <button type="button" onClick={() => onSelect(t.id)}>
                {t.title}
                {t.lengthTarget ? <span className="length-target"> · {t.lengthTarget}</span> : null}
              </button>
              {t.sources.length > 0 ? (
                <ul className="template-sources">
                  {t.sources.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer">
                        {s.label}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
```

Create `packages/web/src/routes/Templates.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { TemplatePicker } from '../components/TemplatePicker.js';
import { type TemplateDetailDTO, type TemplateListDTO, fetchTemplate, listTemplates } from '../api/writing.js';

interface Props {
  programId?: string;
  klass?: string;
}

export function TemplatesRoute({ programId, klass }: Props): JSX.Element {
  const [library, setLibrary] = useState<TemplateListDTO | undefined>();
  const [selected, setSelected] = useState<TemplateDetailDTO | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    listTemplates({ programId, klass })
      .then((data) => {
        if (!cancelled) setLibrary(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(`Could not load the template library: ${err.message}`);
      });
    return () => {
      cancelled = true;
    };
  }, [programId, klass]);

  const select = (id: string): void => {
    fetchTemplate(id)
      .then(setSelected)
      .catch((err: Error) => setError(`Could not load that template: ${err.message}`));
  };

  return (
    <div className="templates-route">
      <h2>Templates</h2>
      {error ? <p role="alert">{error}</p> : null}
      {library ? (
        <div className="templates-layout">
          <div className="templates-index">
            <TemplatePicker
              heading="Sections"
              templates={library.components}
              selectedId={selected?.id}
              onSelect={select}
              emptyMessage="No component templates apply to this opportunity class."
            />
            <TemplatePicker
              heading="Funder overlays"
              templates={library.overlays}
              selectedId={selected?.id}
              onSelect={select}
              emptyMessage="No overlay has been written for this funder yet."
            />
            <TemplatePicker
              heading="Always available"
              templates={library.playbooks}
              selectedId={selected?.id}
              onSelect={select}
              emptyMessage="No playbooks."
            />
          </div>
          <div className="template-preview">
            {selected ? (
              <>
                <h3>{selected.title}</h3>
                <pre>{selected.body}</pre>
              </>
            ) : (
              <p className="muted">Pick a template to read it.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The route-bound wrapper. `TemplatesRoute` stays prop-driven so component
 * tests can render it without a router; this reads the same two values from the
 * query string, which is what the opportunity deep link and the rail link set.
 */
export function TemplatesScreen(): JSX.Element {
  const [params] = useSearchParams();
  return (
    <TemplatesRoute
      programId={params.get('programId') ?? undefined}
      klass={params.get('klass') ?? undefined}
    />
  );
}
```

- [ ] **Step 6: Register the routes, put them in the nav, and link them from an opportunity**

Three edits to Plan 3's files. All three are load-bearing: without the second, the writing desk is unreachable by navigation; without the third, a user who has found a program has no path into a draft for it.

**6a.** In `packages/web/src/App.tsx`, add the imports and two `<Route>` entries alongside the existing ones:

```tsx
import { ApplicationsScreen } from './routes/Applications.js';
import { TemplatesScreen } from './routes/Templates.js';

// …among the existing routes:
<Route path="/templates" element={<TemplatesScreen />} />
<Route path="/applications" element={<ApplicationsScreen />} />
```

The `*Screen` wrappers are the query-string-aware versions; `TemplatesRoute` and `ApplicationsRoute` stay prop-driven for component tests. `ApplicationsScreen` arrives in Task 19; add both entries now and the typecheck at the end of Task 19 will confirm them.

**6b.** In `packages/web/src/components/AppShell.tsx`, **insert exactly these two lines** into the existing `const NAV: NavItem[] = [ … ]` array, immediately after the Watchlist entry:

```tsx
  { to: '/templates', label: 'Templates', end: false },
  { to: '/applications', label: 'Applications', end: false },
```

**The `NAV` array is append-only. Do not retype it (RESOLUTIONS R18).** This is an insert of two lines into Plan 3's array, not a replacement of the array. Three specific things a retype gets wrong:

- **Do not drop the `: NavItem[]` annotation.** `AppShell` renders `NAV.filter((item) => item.adminOnly !== true || user?.role === 'admin')`. Without the annotation TypeScript infers the element type from the literal, no member has `adminOnly`, and `npm run typecheck` fails in *this* plan with `TS2339: Property 'adminOnly' does not exist on type '{ to: string; label: string; end: boolean; }'`. That one at least fails loudly; the next two do not.
- **Do not touch or omit `{ to: '/admin', label: 'Admin', end: false, adminOnly: true }`.** It is the only link to Plan 3's admin console (Plan 3 Task 25) — user management, backups, ICS-token revocation. Dropping it removes admin navigation entirely, and nothing in this plan tests for it, so the loss is silent.
- **Do not reorder the remaining entries.** Plan 5 inserts an Exports entry into this same array, positioned after Calendar relative to whatever is here when it runs (R18). The rail is a shared, accumulating structure across three plans; every plan inserts and none rewrites.

After the insert the array has **nine** entries and the rail reads Browse · Calendar · Watchlist · Templates · Applications · Inbox · Sources · Profile, plus Admin for admins only. Verify before moving on:

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  SHELL_TSX=packages/web/src/components/AppShell.tsx && \
  echo "-- the array is still typed --" && \
  grep -q "const NAV: NavItem\[\] = \[" "$SHELL_TSX" && \
  echo "-- Plan 3's admin entry survived --" && \
  grep -q "adminOnly: true" "$SHELL_TSX" && \
  grep -q "to: '/admin'" "$SHELL_TSX" && \
  echo "-- this plan's two entries are present --" && \
  grep -q "to: '/templates'" "$SHELL_TSX" && \
  grep -q "to: '/applications'" "$SHELL_TSX" && \
  echo "-- nine entries, no more and no fewer --" && \
  [ "$(sed -n "/const NAV: NavItem\[\] = \[/,/^\];/p" "$SHELL_TSX" | grep -c "^  { to: ")" = "9" ] && \
  echo "NAV IS CORRECT"
```

A count other than 9 means the array was retyped rather than inserted into. Re-read Plan 3 Task 15's `AppShell.tsx`, restore its seven entries verbatim, and add only the two lines above.

Add the two matching assertions to Plan 3's `packages/web/src/components/AppShell.test.tsx`, inside its existing `describe('AppShell')` block, beside the links it already checks — and leave its admin-visibility assertions alone:

```tsx
expect(within(nav).getByRole('link', { name: /templates/i })).toBeInTheDocument();
expect(within(nav).getByRole('link', { name: /applications/i })).toBeInTheDocument();
```

**6c.** In `packages/web/src/routes/Opportunity.tsx` (Plan 3 Task 19), add the deep link to the existing `detail-actions` block, immediately after the watch button:

```tsx
<Link
  className="btn"
  to={`/applications?programId=${encodeURIComponent(program.id)}&klass=${encodeURIComponent(program.klass)}&funderId=${encodeURIComponent(program.funderId)}`}
>
  Start an application for this program
</Link>
```

`Link` is already imported in that file. The three query parameters are what pre-select this funder's overlay: `ApplicationsScreen` (Task 19) passes `programId` and `funderId` straight into `GET /api/templates`, whose `selectTemplates` returns the overlay whose frontmatter `programIds` contains that id — for `ardc-grants`, `funder-ardc`. That is exactly the binding described under "Canonical program ids" above, which is why an id typo in the seed corpus shows up here as an empty "Funder overlays" group rather than as an error.

- [ ] **Step 7: Run the test and commit**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  npx vitest run packages/web/src/routes/Templates.test.tsx && \
  git add packages/web/src package.json package-lock.json && \
  git commit -m "feat(web): writing API client, template picker and Templates route"
```

---

### Task 19: Web — Applications route, draft editor, prose panel, fact checklist and the copy-prompt button

The one screen the whole plan exists to produce. Five rules it must obey visibly:

- The copy button reads exactly `Copy AI Prompt — includes AI-detection avoidance`, with a subtitle enumerating what is in the prompt.
- The prose panel **reports and never scores**: per paragraph it shows the two densities, the located stock-transition hits, the tricolon and trailing-participial counts, and it marks paragraphs with no proper noun and no figure at all.
- The fact checklist blocks export until every assertion is confirmed and every `[TODO: …]` marker is gone.
- Filling a template from the profile leaves visible `[TODO: …]` markers and never invents a value.
- Arriving from an opportunity's "Start an application for this program" link **pre-selects that funder's overlay** and loads the program, so the copy-prompt button is grounded in the funder's own published criteria from the first click.

**Files:**
- Create: `packages/web/src/components/CopyPromptButton.tsx`
- Create: `packages/web/src/components/ProseCheckPanel.tsx`
- Create: `packages/web/src/components/FactChecklist.tsx`
- Create: `packages/web/src/components/SlotForm.tsx`
- Create: `packages/web/src/routes/Applications.tsx`
- Create: `packages/web/src/routes/Applications.test.tsx`

**Interfaces:**
- Consumes: everything exported from `../api/writing.js`.
- Produces: `COPY_PROMPT_LABEL`, `COPY_PROMPT_SUBTITLE`, `CopyPromptButton`, `ProseCheckPanel`, `FactChecklist`, `SlotForm`, `ApplicationsRoute`, `ApplicationsScreen`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/src/routes/Applications.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COPY_PROMPT_LABEL, COPY_PROMPT_SUBTITLE, CopyPromptButton } from '../components/CopyPromptButton.js';
import { FactChecklist } from '../components/FactChecklist.js';
import { ProseCheckPanel } from '../components/ProseCheckPanel.js';
import type { DensityDTO, FactItemDTO, ProseReportDTO } from '../api/writing.js';
import { ApplicationsScreen } from './Applications.js';

const REPORT: ProseReportDTO = {
  paragraphs: [
    {
      index: 0,
      text: 'Furthermore, this comprehensive initiative underscores our unwavering commitment.',
      styleWordHits: ['comprehensive', 'underscores', 'unwavering', 'commitment'],
      properNounCount: 0,
      figureCount: 0,
      tricolonCount: 1,
      trailingParticipialCount: 2,
      stockTransitionHits: ['Furthermore'],
      verdict: 'generic',
    },
    {
      index: 1,
      text: 'Dana Ruiz KD9XYZ will teach four sessions in Room 214 on March 7, 2027.',
      styleWordHits: [],
      properNounCount: 7,
      figureCount: 5,
      tricolonCount: 0,
      trailingParticipialCount: 0,
      stockTransitionHits: [],
      verdict: 'specific',
    },
  ],
  sentenceLengthVariance: 12.5,
  documentTricolonCount: 1,
  stockOpenerHits: ["In today's rapidly evolving landscape"],
  stockCloserHits: ['for years to come'],
  paragraphsWithNoProperNounOrFigure: [0],
};

const DENSITIES: DensityDTO[] = [
  { index: 0, words: 10, styleDensity: 40, referentDensity: 0 },
  { index: 1, words: 14, styleDensity: 0, referentDensity: 85.7 },
];

const FACTS: FactItemDTO[] = [
  { id: 'money:12', kind: 'money', text: '$1,099', start: 12, end: 18, context: 'we spent $1,099 on it', confirmed: false, note: '' },
  { id: 'callsign:0', kind: 'callsign', text: 'W8UM', start: 0, end: 4, context: 'W8UM spent $1,099', confirmed: true, note: 'checked FCC ULS' },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CopyPromptButton', () => {
  it('uses the exact required copy and enumerates what the prompt contains', () => {
    expect(COPY_PROMPT_LABEL).toBe('Copy AI Prompt — includes AI-detection avoidance');
    render(<CopyPromptButton getPrompt={async () => 'PROMPT'} />);
    expect(screen.getByRole('button', { name: COPY_PROMPT_LABEL })).toBeTruthy();
    expect(screen.getByText(COPY_PROMPT_SUBTITLE)).toBeTruthy();
    for (const phrase of ['AI policy', 'interview', 'brevity', 'never-invent']) {
      expect(COPY_PROMPT_SUBTITLE.toLowerCase()).toContain(phrase.toLowerCase());
    }
  });

  it('writes the composed prompt to the clipboard and confirms', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    render(<CopyPromptButton getPrompt={async () => 'THE PROMPT'} />);
    fireEvent.click(screen.getByRole('button', { name: COPY_PROMPT_LABEL }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('THE PROMPT'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/copied/i));
  });

  it('surfaces a failure rather than silently doing nothing', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    render(<CopyPromptButton getPrompt={async () => { throw new Error('boom'); }} />);
    fireEvent.click(screen.getByRole('button', { name: COPY_PROMPT_LABEL }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/boom/));
  });
});

describe('ProseCheckPanel', () => {
  it('reports densities per paragraph and never shows a single score', () => {
    render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    expect(screen.getByText(/style words per 100/i)).toBeTruthy();
    expect(screen.getByText(/proper nouns \+ figures per 100/i)).toBeTruthy();
    expect(screen.queryByText(/score/i)).toBeNull();
    expect(screen.queryByText(/AI-written|AI-generated/i)).toBeNull();
  });

  it('locates stock transitions, openers and closers', () => {
    render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    expect(screen.getByText('Furthermore')).toBeTruthy();
    expect(screen.getByText("In today's rapidly evolving landscape")).toBeTruthy();
    expect(screen.getByText('for years to come')).toBeTruthy();
  });

  it('flags the paragraph with no proper noun and no figure', () => {
    render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    expect(screen.getByText(/paragraph 1 has no proper noun and no figure/i)).toBeTruthy();
  });

  it('shows the document-level tricolon count and sentence-length variance', () => {
    render(<ProseCheckPanel report={REPORT} densities={DENSITIES} />);
    expect(screen.getByText(/tricolons: 1/i)).toBeTruthy();
    expect(screen.getByText(/sentence-length variance: 12.5/i)).toBeTruthy();
  });
});

describe('FactChecklist', () => {
  it('lists every assertion with its context and confirmation state', () => {
    render(<FactChecklist items={FACTS} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText('$1,099')).toBeTruthy();
    expect(screen.getByText('W8UM')).toBeTruthy();
    expect(screen.getByText(/we spent \$1,099 on it/)).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes[0]?.checked).toBe(false);
    expect(boxes[1]?.checked).toBe(true);
  });

  it('blocks export while an assertion is unconfirmed', () => {
    render(<FactChecklist items={FACTS} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText(/1 assertion still needs confirmation/i)).toBeTruthy();
  });

  it('blocks export while a TODO marker remains', () => {
    render(<FactChecklist items={[]} openTodos={2} onChange={() => undefined} />);
    expect(screen.getByText(/2 unresolved \[TODO:/i)).toBeTruthy();
  });

  it('says export is clear only when nothing is outstanding', () => {
    render(<FactChecklist items={[{ ...FACTS[1]! }]} openTodos={0} onChange={() => undefined} />);
    expect(screen.getByText(/ready to export/i)).toBeTruthy();
  });

  it('reports a confirmation change to its owner', () => {
    const onChange = vi.fn();
    render(<FactChecklist items={FACTS} openTodos={0} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole('checkbox')[0]!);
    expect(onChange).toHaveBeenCalledWith('money:12', { confirmed: true, note: '' });
  });
});

const OVERLAY_LIBRARY = {
  components: [
    { id: 'need-statement', title: 'Need statement', layer: 'component', order: 10, appliesTo: ['ham_grant'], requires: [], programIds: [], alwaysAvailable: false, sources: [], slots: [] },
  ],
  overlays: [
    { id: 'funder-ardc', title: 'ARDC Grants Program — funder overlay', layer: 'funder', order: 10, appliesTo: ['ham_grant'], requires: [], programIds: ['ardc-grants'], alwaysAvailable: false, sources: [], slots: [] },
  ],
  playbooks: [],
};

function stubDeepLinkFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      const json = (payload: unknown) =>
        new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.startsWith('/api/templates/slots')) return json({ all: [], userAnswerable: [] });
      if (url.startsWith('/api/templates')) return json(OVERLAY_LIBRARY);
      if (url.startsWith('/api/applications')) return json({ applications: [] });
      if (url.startsWith('/api/programs/')) return json({ program: { id: 'ardc-grants' }, funder: { id: 'ardc' } });
      if (url.startsWith('/api/profiles')) return json({ student: null, organization: { kind: 'organization' } });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

describe('ApplicationsScreen deep link', () => {
  it('asks for the templates of the program named in the query string', async () => {
    stubDeepLinkFetch();
    render(
      <MemoryRouter initialEntries={['/applications?programId=ardc-grants&funderId=ardc&klass=ham_grant']}>
        <ApplicationsScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/Drafting for/)).toBeTruthy());
    const called = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.startsWith('/api/templates?'));
    expect(called).toContain('programId=ardc-grants');
    expect(called).toContain('funderId=ardc');
  });

  it('pre-selects this funder’s overlay and offers to insert it', async () => {
    stubDeepLinkFetch();
    render(
      <MemoryRouter initialEntries={['/applications?programId=ardc-grants&funderId=ardc&klass=ham_grant']}>
        <ApplicationsScreen />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Insert ARDC Grants Program — funder overlay/ })).toBeTruthy(),
    );
    const selected = document.querySelector('.template-list li.selected');
    expect(selected?.textContent).toContain('ARDC Grants Program — funder overlay');
  });

  it('says so plainly when no overlay is bound to the program id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        const payload = url.startsWith('/api/templates/slots')
          ? { all: [], userAnswerable: [] }
          : url.startsWith('/api/templates')
            ? { ...OVERLAY_LIBRARY, overlays: [] }
            : url.startsWith('/api/applications')
              ? { applications: [] }
              : {};
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    render(
      <MemoryRouter initialEntries={['/applications?programId=typo-in-the-seed&klass=ham_grant']}>
        <ApplicationsScreen />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText(/No funder overlay has been written/)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && npx vitest run packages/web/src/routes/Applications.test.tsx
```

Expected failure: `Error: Failed to resolve import "../components/CopyPromptButton.js"`.

- [ ] **Step 3: Write the three panel components**

Create `packages/web/src/components/CopyPromptButton.tsx`:

```tsx
import { useState } from 'react';

/** Contract copy. The em dash is U+2014 and the string is asserted by an e2e test. */
export const COPY_PROMPT_LABEL = 'Copy AI Prompt — includes AI-detection avoidance';

export const COPY_PROMPT_SUBTITLE =
  'Includes: this funder’s published criteria, restrictions and obligations · their AI policy, quoted, with the source URL · your profile facts · an interview-first rule so the model asks before it drafts · the specificity ruleset (named subjects, proper nouns, figures, dates) · banned stock transitions, openers and closers · a brevity pass · a never-invent-a-citation rule';

interface Props {
  getPrompt: () => Promise<string>;
  disabled?: boolean;
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(area);
  if (!ok) throw new Error('the browser refused the copy request');
}

export function CopyPromptButton({ getPrompt, disabled }: Props): JSX.Element {
  const [status, setStatus] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const onClick = async (): Promise<void> => {
    setError(undefined);
    setStatus(undefined);
    try {
      const prompt = await getPrompt();
      await copyToClipboard(prompt);
      setStatus(`Copied ${prompt.length.toLocaleString()} characters. Paste it into your assistant.`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="copy-prompt">
      <button type="button" onClick={() => void onClick()} disabled={disabled}>
        {COPY_PROMPT_LABEL}
      </button>
      <p className="copy-prompt-subtitle">{COPY_PROMPT_SUBTITLE}</p>
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert">Could not copy the prompt: {error}</p> : null}
    </div>
  );
}
```

Create `packages/web/src/components/ProseCheckPanel.tsx`:

```tsx
import type { DensityDTO, ProseReportDTO } from '../api/writing.js';

interface Props {
  report: ProseReportDTO;
  densities: DensityDTO[];
}

const round = (n: number): string => (Math.round(n * 10) / 10).toFixed(1);

/**
 * Reports why a passage reads generic and where. There is deliberately no
 * score and no claim that anything was machine-written: the measurable signal
 * is style-word density with no proper nouns or figures near it, which a human
 * writing in a hurry produces just as readily as a model does.
 */
export function ProseCheckPanel({ report, densities }: Props): JSX.Element {
  const densityFor = (index: number): DensityDTO | undefined => densities.find((d) => d.index === index);

  return (
    <section className="prose-check">
      <h3>Prose check</h3>
      <p className="muted">
        This reports where a passage is thin on specifics. It does not produce a score and it does not claim anything was
        written by a machine.
      </p>

      <ul className="prose-document-stats">
        <li>Tricolons: {report.documentTricolonCount}</li>
        <li>Sentence-length variance: {round(report.sentenceLengthVariance)}</li>
      </ul>

      {report.stockOpenerHits.length > 0 ? (
        <div className="prose-hits">
          <h4>Stock openers</h4>
          <ul>{report.stockOpenerHits.map((h, i) => <li key={`${h}-${i}`}>{h}</li>)}</ul>
        </div>
      ) : null}

      {report.stockCloserHits.length > 0 ? (
        <div className="prose-hits">
          <h4>Stock closers</h4>
          <ul>{report.stockCloserHits.map((h, i) => <li key={`${h}-${i}`}>{h}</li>)}</ul>
        </div>
      ) : null}

      {report.paragraphsWithNoProperNounOrFigure.map((index) => (
        <p key={index} className="prose-warning">
          Paragraph {index + 1} has no proper noun and no figure in it.
        </p>
      ))}

      <ol className="prose-paragraphs">
        {report.paragraphs.map((p) => {
          const d = densityFor(p.index);
          return (
            <li key={p.index} className={`verdict-${p.verdict}`}>
              <h4>
                Paragraph {p.index + 1} — {p.verdict}
              </h4>
              <dl>
                <dt>Style words per 100 words</dt>
                <dd>{d ? round(d.styleDensity) : '—'}</dd>
                <dt>Proper nouns + figures per 100 words</dt>
                <dd>{d ? round(d.referentDensity) : '—'}</dd>
                <dt>Tricolons</dt>
                <dd>{p.tricolonCount}</dd>
                <dt>Trailing participial clauses</dt>
                <dd>{p.trailingParticipialCount}</dd>
              </dl>
              {p.stockTransitionHits.length > 0 ? (
                <p>
                  Stock transitions:{' '}
                  {p.stockTransitionHits.map((h, i) => (
                    <span key={`${h}-${i}`} className="hit">
                      {h}
                    </span>
                  ))}
                </p>
              ) : null}
              {p.styleWordHits.length > 0 ? <p className="muted">Style words: {p.styleWordHits.join(', ')}</p> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
```

Create `packages/web/src/components/FactChecklist.tsx`:

```tsx
import type { FactItemDTO } from '../api/writing.js';

interface Props {
  items: FactItemDTO[];
  openTodos: number;
  onChange: (id: string, next: { confirmed: boolean; note: string }) => void;
}

/**
 * Every funder policy reviewed makes the human applicant — never the tool —
 * accountable for each number, claim and citation, so nothing leaves this app
 * until a person has confirmed every assertion and cleared every TODO marker.
 */
export function FactChecklist({ items, openTodos, onChange }: Props): JSX.Element {
  const unconfirmed = items.filter((i) => !i.confirmed).length;
  const clear = unconfirmed === 0 && openTodos === 0;

  return (
    <section className="fact-checklist">
      <h3>Fact checklist</h3>
      <p className="muted">
        Confirm every figure, date, name, citation and URL before exporting. The funder holds you responsible for each
        one.
      </p>

      {clear ? (
        <p className="ready">Every assertion is confirmed — ready to export.</p>
      ) : (
        <ul className="blockers">
          {unconfirmed > 0 ? (
            <li>
              {unconfirmed} assertion{unconfirmed === 1 ? '' : 's'} still need
              {unconfirmed === 1 ? 's' : ''} confirmation.
            </li>
          ) : null}
          {openTodos > 0 ? (
            <li>
              {openTodos} unresolved [TODO: …] marker{openTodos === 1 ? '' : 's'} remain
              {openTodos === 1 ? 's' : ''} in the draft.
            </li>
          ) : null}
        </ul>
      )}

      <ul className="fact-items">
        {items.map((item) => (
          <li key={item.id}>
            <label>
              <input
                type="checkbox"
                checked={item.confirmed}
                onChange={(e) => onChange(item.id, { confirmed: e.target.checked, note: item.note })}
              />
              <span className="fact-kind">{item.kind}</span>
              <span className="fact-text">{item.text}</span>
            </label>
            <p className="fact-context">{item.context}</p>
            <input
              type="text"
              aria-label={`Note for ${item.text}`}
              placeholder="How did you verify this?"
              value={item.note}
              onChange={(e) => onChange(item.id, { confirmed: item.confirmed, note: e.target.value })}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 4: Write the slot form and the Applications route**

Create `packages/web/src/components/SlotForm.tsx`:

```tsx
import type { SlotDefDTO } from '../api/writing.js';

interface Props {
  slots: SlotDefDTO[];
  answers: Record<string, string>;
  onChange: (path: string, value: string) => void;
}

/** Only user-answerable slots appear here; profile and program slots fill themselves. */
export function SlotForm({ slots, answers, onChange }: Props): JSX.Element {
  return (
    <section className="slot-form">
      <h3>Facts this draft needs</h3>
      <p className="muted">
        Anything left blank appears in the draft as an explicit [TODO: …] marker. Nothing is ever guessed for you.
      </p>
      <ul>
        {slots.map((slot) => (
          <li key={slot.path}>
            <label htmlFor={`slot-${slot.path}`}>{slot.label}</label>
            <input
              id={`slot-${slot.path}`}
              type="text"
              value={answers[slot.path] ?? ''}
              placeholder={slot.hint}
              onChange={(e) => onChange(slot.path, e.target.value)}
            />
            <p className="slot-hint">{slot.hint}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

Create `packages/web/src/routes/Applications.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  type ApplicationDTO,
  type DensityDTO,
  type ExportReadinessDTO,
  type ProseReportDTO,
  type SlotDefDTO,
  type TemplateListDTO,
  analyzeDraft,
  composePromptRemote,
  createApplication,
  fetchActiveProfile,
  fetchApplication,
  fetchExportReadiness,
  fetchProgramForDraft,
  fetchSlots,
  fillTemplateRemote,
  listApplications,
  listTemplates,
  patchApplication,
  putFactConfirmations,
} from '../api/writing.js';
import { CopyPromptButton } from '../components/CopyPromptButton.js';
import { FactChecklist } from '../components/FactChecklist.js';
import { ProseCheckPanel } from '../components/ProseCheckPanel.js';
import { SlotForm } from '../components/SlotForm.js';
import { TemplatePicker } from '../components/TemplatePicker.js';

interface Props {
  /** Supplied by the opportunity screen when a draft is started from a program. */
  program?: unknown;
  profile?: unknown;
  programId?: string;
  funderId?: string;
  klass?: string;
}

export function ApplicationsRoute({ program, profile, programId, funderId, klass }: Props): JSX.Element {
  const [applications, setApplications] = useState<ApplicationDTO[]>([]);
  const [current, setCurrent] = useState<ApplicationDTO | undefined>();
  const [library, setLibrary] = useState<TemplateListDTO | undefined>();
  const [slots, setSlots] = useState<SlotDefDTO[]>([]);
  const [report, setReport] = useState<ProseReportDTO | undefined>();
  const [densities, setDensities] = useState<DensityDTO[]>([]);
  const [readiness, setReadiness] = useState<ExportReadinessDTO | undefined>();
  const [error, setError] = useState<string | undefined>();

  const fail = useCallback((err: unknown) => setError((err as Error).message), []);

  useEffect(() => {
    listApplications().then((d) => setApplications(d.applications)).catch(fail);
    listTemplates({ programId, funderId, klass }).then(setLibrary).catch(fail);
    fetchSlots().then((d) => setSlots(d.userAnswerable)).catch(fail);
  }, [programId, funderId, klass, fail]);

  /**
   * The overlay this program binds to, pre-selected when the user arrived from
   * "Start an application for this program". selectTemplates already filtered
   * on programIds, so the first overlay is this funder's; an empty list means
   * no overlay has been written for it (or a seed id drifted from the canonical
   * list — see "Canonical program ids").
   */
  const suggestedOverlay = library?.overlays[0];

  const refreshReadiness = useCallback(
    (id: string) => {
      fetchExportReadiness(id).then(setReadiness).catch(fail);
    },
    [fail],
  );

  const open = (id: string): void => {
    fetchApplication(id)
      .then((app) => {
        setCurrent(app);
        refreshReadiness(app.id);
      })
      .catch(fail);
  };

  const start = (): void => {
    createApplication({ title: 'Untitled draft', programId })
      .then((app) => {
        setApplications((prev) => [app, ...prev]);
        setCurrent(app);
        setReadiness(undefined);
      })
      .catch(fail);
  };

  const save = (patch: Parameters<typeof patchApplication>[1]): void => {
    if (!current) return;
    patchApplication(current.id, patch)
      .then((app) => {
        setCurrent(app);
        setApplications((prev) => prev.map((a) => (a.id === app.id ? app : a)));
        refreshReadiness(app.id);
      })
      .catch(fail);
  };

  const insertTemplate = (templateId: string): void => {
    if (!current) return;
    fillTemplateRemote(templateId, { profile, program, answers: current.answers })
      .then((filled) => {
        const next = `${current.bodyMarkdown}${current.bodyMarkdown ? '\n\n' : ''}${filled.markdown}`;
        save({ bodyMarkdown: next });
      })
      .catch(fail);
  };

  const runProseCheck = (): void => {
    if (!current?.bodyMarkdown.trim()) return;
    analyzeDraft(current.bodyMarkdown)
      .then((d) => {
        setReport(d.report);
        setDensities(d.densities);
      })
      .catch(fail);
  };

  const confirmFact = (id: string, next: { confirmed: boolean; note: string }): void => {
    if (!current) return;
    putFactConfirmations(current.id, { [id]: next })
      .then(setReadiness)
      .catch(fail);
  };

  const getPrompt = useMemo(
    () => async (): Promise<string> => {
      if (!program) throw new Error('open this draft from an opportunity so the funder’s criteria can be included');
      const composed = await composePromptRemote({
        program,
        profile,
        includeDisclosure: current?.includeDisclosure ?? true,
      });
      return composed.prompt;
    },
    [program, profile, current?.includeDisclosure],
  );

  return (
    <div className="applications-route">
      <h2>Applications</h2>
      {error ? <p role="alert">{error}</p> : null}

      {programId ? (
        <p className="deep-link-context">
          Drafting for <strong>{programId}</strong>.{' '}
          {suggestedOverlay ? (
            <>
              This funder’s overlay, <strong>{suggestedOverlay.title}</strong>, is selected.{' '}
              <button type="button" onClick={() => insertTemplate(suggestedOverlay.id)} disabled={!current}>
                Insert {suggestedOverlay.title}
              </button>
            </>
          ) : (
            'No funder overlay has been written for this program yet, so only the component sections apply.'
          )}
        </p>
      ) : null}

      <div className="applications-layout">
        <aside>
          <button type="button" onClick={start}>
            New draft
          </button>
          <ul className="draft-list">
            {applications.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => open(a.id)}>
                  {a.title}
                </button>
              </li>
            ))}
          </ul>
          {library ? (
            <>
              <TemplatePicker
                heading="Insert a section"
                templates={library.components}
                onSelect={insertTemplate}
                emptyMessage="No component templates apply here."
              />
              <TemplatePicker
                heading="Funder overlays"
                templates={library.overlays}
                selectedId={suggestedOverlay?.id}
                onSelect={insertTemplate}
                emptyMessage="No overlay has been written for this funder yet."
              />
              <TemplatePicker
                heading="Always available"
                templates={library.playbooks}
                onSelect={insertTemplate}
                emptyMessage="No playbooks."
              />
            </>
          ) : null}
        </aside>

        <main>
          {current ? (
            <>
              <label htmlFor="draft-title">Title</label>
              <input
                id="draft-title"
                type="text"
                value={current.title}
                onChange={(e) => setCurrent({ ...current, title: e.target.value })}
                onBlur={() => save({ title: current.title })}
              />

              <label htmlFor="draft-body">Draft</label>
              <textarea
                id="draft-body"
                rows={24}
                value={current.bodyMarkdown}
                onChange={(e) => setCurrent({ ...current, bodyMarkdown: e.target.value })}
                onBlur={() => save({ bodyMarkdown: current.bodyMarkdown })}
              />

              <label className="disclosure-toggle">
                <input
                  type="checkbox"
                  checked={current.includeDisclosure}
                  onChange={(e) => save({ includeDisclosure: e.target.checked })}
                />
                Include an AI-use disclosure sentence
              </label>

              <CopyPromptButton getPrompt={getPrompt} />

              <button type="button" onClick={runProseCheck}>
                Run prose check
              </button>

              <SlotForm
                slots={slots}
                answers={current.answers}
                onChange={(path, value) => setCurrent({ ...current, answers: { ...current.answers, [path]: value } })}
              />
              <button type="button" onClick={() => save({ answers: current.answers })}>
                Save facts
              </button>

              {report ? <ProseCheckPanel report={report} densities={densities} /> : null}

              {readiness ? (
                <FactChecklist items={readiness.items} openTodos={readiness.openTodos} onChange={confirmFact} />
              ) : null}
            </>
          ) : (
            <p className="muted">Start a new draft or open an existing one.</p>
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * The route-bound wrapper, and the other half of the deep link. The rail link
 * lands here with no query string and everything is simply unfiltered; the
 * opportunity link lands here with ?programId&funderId&klass, so this fetches
 * the Program (the prompt cannot be grounded without it) and the caller's
 * profile (slots cannot fill without it) before handing both to the editor.
 */
export function ApplicationsScreen(): JSX.Element {
  const [params] = useSearchParams();
  const programId = params.get('programId') ?? undefined;
  const funderId = params.get('funderId') ?? undefined;
  const klass = params.get('klass') ?? undefined;

  const [program, setProgram] = useState<unknown>();
  const [profile, setProfile] = useState<unknown>();

  useEffect(() => {
    let cancelled = false;
    fetchActiveProfile()
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => undefined);
    if (programId === undefined) {
      setProgram(undefined);
      return () => {
        cancelled = true;
      };
    }
    fetchProgramForDraft(programId)
      .then((d) => {
        if (!cancelled) setProgram(d.program);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [programId]);

  return (
    <ApplicationsRoute
      program={program}
      profile={profile}
      programId={programId}
      funderId={funderId}
      klass={klass}
    />
  );
}
```

A failed profile or program read is swallowed on purpose: neither is required to open the editor, and `CopyPromptButton` already surfaces "open this draft from an opportunity so the funder's criteria can be included" when `program` is absent. Every *editor* failure still reaches the `role="alert"` banner through `fail`.

`TemplatePicker`'s `selectedId` is optional (`selectedId?: string`) and is passed only to the overlay group here, which is what makes the pre-selected overlay visibly selected.

- [ ] **Step 5: Run the tests, typecheck and build**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  npx vitest run packages/web/src && npm run typecheck && npm run build
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter && \
  git add packages/web/src && \
  git commit -m "feat(web): applications draft editor with prose panel, fact checklist and copy-prompt button"
```

---

### Task 20: End-to-end flow and full plan verification

The last task proves the pieces work together against the real server, then runs the whole suite. It closes Plan 4's done-criteria from spec §17: the prose analyzer is unit-tested on known-generic versus known-specific passages, and every overlay traces to a cited funder requirement.

**Navigation is load-bearing here.** The first two tests reach the writing desk by clicking the rail links added in Task 18 Step 6b, not by `page.goto`. A `page.goto('/templates')` would pass against a build in which nothing links to `/templates` — which is exactly the state this plan shipped in before the audit, with the entire writing desk reachable only by typing a URL.

**When this suite goes green, and why it is not at the end of Plan 4 (RESOLUTIONS R16 + R25).** Every
spec below starts at `page.goto('/')`, and `/` is served by the SPA middleware that is the **last**
statement of Plan 3 Task 14's `mountRoutes` callback. That middleware is Plan 5's:
`packages/server/src/api/spa.ts` is created by Plan 5's SPA task (R16) and mounted by **Plan 5
Task 17** (R25). Until it lands, Plan 1's `notFoundHandler` answers `/` with a JSON 404 envelope and
every Playwright spec — Plan 3's four and this task's six — fails on its first locator. This plan
deliberately does not forward-reference `api/spa.ts`: importing a file that does not exist fails
`npm run build`, and a failed build means `packages/server/dist/index.js` is never emitted, so
Playwright's `webServer` cannot start at all and `typecheck`, `build` and `npm test` go down with it.

So this task's hard, must-pass gate is `npm run typecheck && npm run build && npm test`, all three
clean. `npm run test:e2e` is run here as a **harness proof** — it must build the SPA, seed the
database, boot the real server on `127.0.0.1:3131` and answer the request — and its one permitted
failure is the SPA fallback being absent, i.e. `page.goto('/')` returning Plan 1's JSON 404 envelope
instead of `index.html`. Any other failure (server will not start, seed throws, port in use, a
selector that never existed, a `404 not_found` from `/api/applications` or `/api/templates`) is a
**Plan 4 defect and is fixed here**. The suite closes green in Plan 5, whose Definition of Done
re-runs every spec with the SPA middleware installed; the exact one-line diff that flips it is
`a.use(createSpaMiddleware(webDistRoot()));` appended at Plan 3 Task 14's reservation comment.

**Do not create `packages/server/src/api/spa.ts` in this plan** — see the Global Constraints. It is
on Plan 5's Creates list, and creating it here to make this suite go green reintroduces the
two-plans-create-one-file defect the whole audit chain has been eliminating.

**Files:**
- Create: `e2e/writing.spec.ts`
- Modify: none

**Interfaces:**
- Consumes: the running app (Plan 1's server, Plan 3's shell, Tasks 16–19's routes).
- Produces: nothing importable — this is the verification gate.

- [ ] **Step 1: Write the failing e2e spec**

Create `e2e/writing.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers.js';

/**
 * Sign in exactly the way Plan 3's `e2e/flow.spec.ts` does, against the account
 * Plan 3 Task 26's `e2e/seed.ts` creates — `e2e/helpers.ts` is the single home
 * of those credentials, so this spec cannot drift from the seed.
 *
 * There is no `/login` route. Plan 3 Task 15's `App.tsx` ends with
 * `if (!user) return <Login onAuthenticated={refresh} />;`, so the sign-in form
 * replaces the whole shell for an anonymous visitor at `/` and the URL never
 * changes. Waiting on a URL change would hang forever; wait on the Browse
 * heading instead, which is what the shell renders once the session exists.
 */
async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Browse opportunities' })).toBeVisible();
}

test.describe('writing tools', () => {
  test('the writing desk is reachable from the primary navigation', async ({ page }) => {
    await login(page);
    const nav = page.getByRole('navigation', { name: /primary/i });
    await expect(nav.getByRole('link', { name: 'Templates' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Applications' })).toBeVisible();

    await nav.getByRole('link', { name: 'Applications' }).click();
    await expect(page).toHaveURL(/\/applications$/);
    await expect(page.getByRole('button', { name: 'New draft' })).toBeVisible();
  });

  test('an opportunity deep-links into a draft with the funder overlay pre-selected', async ({ page }) => {
    await login(page);
    await page.goto('/o/ardc-grants');

    const start = page.getByRole('link', { name: 'Start an application for this program' });
    await expect(start).toBeVisible();
    await start.click();

    await expect(page).toHaveURL(/\/applications\?programId=ardc-grants/);
    await expect(page.getByText(/Drafting for/)).toBeVisible();
    // The overlay bound to ardc-grants, pre-selected — proof that Plan 5's seed
    // id and this plan's overlay frontmatter agree (RESOLUTIONS R9).
    await expect(page.getByRole('button', { name: /Insert ARDC Grants Program/ })).toBeVisible();
  });

  test('the template library shows components, overlays and the SGA playbook with citations', async ({ page }) => {
    await login(page);
    await page.getByRole('navigation', { name: /primary/i }).getByRole('link', { name: 'Templates' }).click();
    await expect(page).toHaveURL(/\/templates$/);

    await expect(page.getByRole('heading', { name: /^Sections$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Need statement/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Campus student government playbook/ })).toBeVisible();

    await page.getByRole('button', { name: /Campus student government playbook/ }).click();
    await expect(page.getByText(/capital equipment/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /FSU SGA/i })).toHaveAttribute('href', /sga\.fsu\.edu/);
  });

  test('a draft fills from a template, leaves visible TODO markers, and gates export on the fact checklist', async ({ page }) => {
    await login(page);
    await page.getByRole('navigation', { name: /primary/i }).getByRole('link', { name: 'Applications' }).click();

    await page.getByRole('button', { name: 'New draft' }).click();
    await page.getByRole('button', { name: /Need statement/ }).click();

    const body = page.getByLabel('Draft');
    await expect(body).toContainText('[TODO:');
    await expect(body).not.toContainText('lorem');

    await body.fill('W8UM spent $1,099 on one Icom IC-7300 on March 7, 2027.');
    await body.blur();

    await expect(page.getByText(/assertion.*needs? confirmation/i)).toBeVisible();
    const boxes = page.getByRole('checkbox');
    const count = await boxes.count();
    for (let i = 0; i < count; i++) {
      const box = boxes.nth(i);
      const label = (await box.getAttribute('aria-label')) ?? '';
      if (label.startsWith('Note for')) continue;
      if (!(await box.isChecked())) await box.check();
    }
    await expect(page.getByText(/ready to export/i)).toBeVisible();
  });

  test('the prose check reports where a passage is generic, without a score', async ({ page }) => {
    await login(page);
    // Deliberately a direct URL: /applications must also survive a bookmark or
    // a page reload, not only a click from the rail.
    await page.goto('/applications');
    await page.getByRole('button', { name: 'New draft' }).click();

    const body = page.getByLabel('Draft');
    await body.fill(
      "In today's rapidly evolving landscape, our organization delves into the transformative potential of amateur radio. Furthermore, this comprehensive initiative underscores our unwavering commitment to educate, empower, and inspire learners, ensuring long-term impact for years to come.",
    );
    await body.blur();
    await page.getByRole('button', { name: 'Run prose check' }).click();

    await expect(page.getByText(/paragraph 1 has no proper noun and no figure/i)).toBeVisible();
    await expect(page.getByText('Furthermore')).toBeVisible();
    await expect(page.getByText("In today's rapidly evolving landscape")).toBeVisible();
    await expect(page.getByText(/style words per 100 words/i)).toBeVisible();
    await expect(page.getByText(/AI-written|AI-generated/i)).toHaveCount(0);
  });

  test('the copy-prompt button carries the exact required copy', async ({ page }) => {
    await login(page);
    await page.getByRole('navigation', { name: /primary/i }).getByRole('link', { name: 'Applications' }).click();
    await page.getByRole('button', { name: 'New draft' }).click();

    const button = page.getByRole('button', { name: 'Copy AI Prompt — includes AI-detection avoidance' });
    await expect(button).toBeVisible();
    await expect(page.getByText(/Includes: this funder/)).toBeVisible();
    await expect(page.getByText(/never-invent-a-citation/)).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the e2e spec and watch it fail for the right reason**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  npx playwright test e2e/writing.spec.ts; echo "playwright exit=$?"
```

`playwright.config.ts` (Plan 3 Task 26) owns the `webServer` block and the env it boots the server
with, so no `SESSION_SECRET` / `CONTACT_URL` is passed on this command line — setting them here would
diverge from the config that actually runs the server.

At this point in the plan **every spec fails on its first line**, because `page.goto('/')` gets Plan
1's JSON 404 envelope rather than `index.html` — the SPA middleware is Plan 5 Task 17's (R16 + R25,
see the note at the top of this task). That is the expected failure. It usually surfaces as
`TimeoutError: locator.fill: Timeout … getByLabel('Email')`, because the page that loaded was JSON.
Confirm the shape of it before writing any code:

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter
npm run build && npm run e2e:seed
PORT=3131 DATA_DIR=e2e/.tmp CRAWL_ENABLED=false \
  SESSION_SECRET=e2e-session-secret-not-a-real-secret \
  CONTACT_URL=https://example.com/grantspotter \
  node packages/server/dist/index.js &
sleep 3
curl -s http://127.0.0.1:3131/ | head -c 120; echo
kill %1
```

Those are the same four env vars `playwright.config.ts`'s `webServer` block sets, and the same
`DATA_DIR` `e2e/seed.ts` writes into — this is that server, started by hand. Keep the backgrounded
`node …` on its own line: folding it into an `&&` chain backgrounds the *whole chain*, so `sleep 3`
starts before `npm run build` has finished and the `curl` hits nothing.

`{"error":{"code":"not_found"…` is correct for the whole of Plan 4. Anything else — a connection
refused, a crash on boot, a seed that throws — is a real defect and belongs in Step 3.

- [ ] **Step 3: Fix whatever the e2e run exposes**

Work through failures one at a time. Exactly one failure is permitted to survive this task; the rest
are wiring defects in this plan and are fixed here:

1. **Permitted, and only this one:** `page.goto('/')` returning Plan 1's JSON 404 instead of the SPA.
   That is Plan 5's `a.use(createSpaMiddleware(webDistRoot()));`, the last statement of the same
   `mountRoutes` callback (R16 + R25). **Do not create `packages/server/src/api/spa.ts`, do not add
   `express.static` or a history fallback, and do not stub `/` in any router** — that file is Plan
   5's to create and creating it here is the double-create defect described at the top of this task.
2. `ApplicationsRoute` reached from the rail renders without a `program`, so `CopyPromptButton`
   throws when clicked. That is correct behaviour — the button is present and its copy is asserted,
   but composing requires a program, which is what the deep link supplies. Leave it.
3. The routes must be registered in `App.tsx` per Task 18 Step 6a. If Playwright reports a blank page
   at `/applications`, that registration is missing.
4. `getByRole('link', { name: 'Templates' })` timing out means the `NAV` entries from Task 18 Step 6b
   were not added, or were added to a different array than the one `AppShell` renders.
5. A `404 not_found` from `/api/applications` or `/api/templates` means the four lines Task 17 Step 5
   adds are not in the `mountRoutes` callback in `packages/server/src/index.ts` — re-run that step's
   gate and add them there. Do **not** "fix" it by calling `app.use` after `createApp` returns or
   from a router module; the app is sealed by `notFoundHandler()` and the call would do nothing.
6. A login timeout after the SPA lands means the credentials drifted from `e2e/seed.ts`. Import them
   from `e2e/helpers.ts` (Plan 3 Task 26) rather than hard-coding a second copy.

- [ ] **Step 4: Run the full verification**

The hard gate. All three must be green before the commit, from a clean checkout, with **no unresolved
imports anywhere** — this plan forward-references no Plan 5 module (R25):

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  npm run typecheck && npm run build && npm test
```

Then the harness proof. `npm run test:e2e` is **not** a must-pass gate at the end of Plan 4, for the
reason set out at the top of this task, so it is run on its own line and its exit status is read
rather than chained:

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter
npm run test:e2e; echo "test:e2e exit=$?"
```

No env vars on that line: `playwright.config.ts`'s `webServer` block already runs
`npm run build && npm run e2e:seed && node packages/server/dist/index.js` with `PORT`, `DATA_DIR`,
`SESSION_SECRET`, `CONTACT_URL` and `CRAWL_ENABLED` of its own.

Exactly one failure mode is permitted: the specs fail at their first navigation because `/` returns
Plan 1's JSON 404 envelope instead of `index.html`. Prove that everything underneath it is healthy —
the build, the migrations, the seed, the mount hook, this plan's own four routes:

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter
npm run build && npm run e2e:seed
PORT=3131 DATA_DIR=e2e/.tmp CRAWL_ENABLED=false \
  SESSION_SECRET=e2e-session-secret-not-a-real-secret \
  CONTACT_URL=https://example.com/grantspotter \
  node packages/server/dist/index.js &
sleep 3
curl -s -o /dev/null -w '/api/health     %{http_code} %{content_type}\n' http://127.0.0.1:3131/api/health
curl -s -o /dev/null -w '/api/templates  %{http_code} %{content_type}\n' 'http://127.0.0.1:3131/api/templates?klass=ham_grant'
curl -s http://127.0.0.1:3131/ | head -c 120; echo
kill %1
```

- `/api/health` answering `200 application/json` proves the build, the migrations, the mount hook and
  the listener are all correct.
- `/api/templates?klass=ham_grant` answering `200 application/json` proves **this plan's** four lines
  really landed in the `mountRoutes` callback (Task 17 Step 5). A `404` with
  `{"error":{"code":"not_found"…}}` here is a Plan 4 defect — go back and re-run that step's gate.
- `/` printing `{"error":{"code":"not_found"…}` is the expected end-of-Plan-4 state. Plan 5 Task 17
  turns it into `<!doctype html>` and every spec — Plan 3's four and this task's six — goes green
  there. **Do not turn it green here.**

There is no Docker on this host, so local verification stops here; the image is Plan 5's problem and GitHub Actions builds it.

- [ ] **Step 5: Confirm Plan 4's stated done-criteria and the no-leak rules**

```bash
cd /home/kasm-user/grantspotter && export PATH="/home/kasm-user/.local/node/bin:$PATH" && \
  echo "-- every funder overlay cites a source --" && \
  [ -z "$(grep -L '^sources:' content/templates/funders/*.md)" ] && \
  echo "-- no private hosts, no compromised domain --" && \
  ! grep -rniE "192\.168\.|10\.[0-9]+\.[0-9]+\.|farweb\.org|kasm-user" content/ data/reference/ packages/server/src/prose packages/server/src/prompts packages/server/src/templates && \
  echo "-- prose/ is pure --" && \
  ! grep -rE "from 'node:|process\.env|fetch\(" packages/server/src/prose/*.ts && \
  echo "-- contract copy string is exact --" && \
  grep -q "Copy AI Prompt — includes AI-detection avoidance" packages/web/src/components/CopyPromptButton.tsx && \
  echo "-- every overlay programId is on the canonical list --" && \
  ! grep -h "^programIds:" content/templates/funders/*.md \
    | tr -d '[]' | sed 's/^programIds: *//' | tr ',' '\n' | tr -d ' ' | grep -v '^$' \
    | grep -vxE 'ardc-grants|arrl-amateur-radio-grants|arrl-club-grant|arrl-foundation-scholarships|ariss-iss-contact|ieee-mtts-chapter-support|yaesu-dr2x-repeater|nasa-space-grant' && \
  echo "-- one error envelope: no ad-hoc error responses --" && \
  ! grep -rnE "res\.status\([45][0-9]{2}\)\.json\(\s*\{\s*error" \
      packages/server/src/api/applications.ts packages/server/src/api/templates.ts \
      packages/server/src/api/prose.ts packages/server/src/api/prompts.ts && \
  echo "-- the four routers mount ONLY inside index.ts's mountRoutes callback --" && \
  [ -z "$(grep -rn "use('/api/\(templates\|prose\|prompts\|applications\)'" \
            packages/server/src --include='*.ts' \
            | grep -v '\.test\.ts' | grep -v 'src/index\.ts')" ] && \
  ! grep -n "^app\.use(" packages/server/src/index.ts && \
  for r in createApplicationsRouter createTemplatesRouter createProseRouter createPromptsRouter; do
    grep -vE '^[[:space:]]*//' packages/server/src/index.ts | grep -q "$r(" \
      || { echo "NOT MOUNTED (present only inside a comment): $r"; exit 1; }
  done && \
  echo "-- this plan created no SPA middleware; that is Plan 5's (R16 + R27) --" && \
  [ ! -e packages/server/src/api/spa.ts ] && \
  ! grep -rn "express\.static\|sendFile\|historyApiFallback" packages/server/src --include='*.ts' && \
  echo "-- Plan 1 owns applications/template_instances; this plan added no migration (R24) --" && \
  [ ! -e packages/server/src/db/migrations/040-application-writing.sql ] && \
  grep -q "CREATE TABLE applications" packages/server/src/db/migrations/001-init.sql && \
  grep -q "CREATE TABLE template_instances" packages/server/src/db/migrations/001-init.sql && \
  [ "$(grep -rn 'CREATE TABLE.*applications\|CREATE TABLE.*template_instances\|idx_applications_user\|idx_template_instances_application' \
        packages/server/src/db/migrations | grep -cv '001-init\.sql')" = "0" ] && \
  echo "-- the writing desk is in the navigation, and Plan 3's rail survived (R18) --" && \
  grep -q "const NAV: NavItem\[\] = \[" packages/web/src/components/AppShell.tsx && \
  grep -q "adminOnly: true" packages/web/src/components/AppShell.tsx && \
  grep -q "to: '/templates'" packages/web/src/components/AppShell.tsx && \
  grep -q "to: '/applications'" packages/web/src/components/AppShell.tsx && \
  [ "$(sed -n "/const NAV: NavItem\[\] = \[/,/^\];/p" packages/web/src/components/AppShell.tsx | grep -c "^  { to: ")" = "9" ] && \
  grep -q "Start an application for this program" packages/web/src/routes/Opportunity.tsx && \
  echo "-- the export gate exists and is documented --" && \
  grep -q "export function assertExportReady" packages/server/src/db/repositories/applications.ts && \
  echo "ALL PLAN 4 GATES PASS"
```

The first `grep -L` must print nothing: it lists overlay files with no `sources:` block, and there must be none. The canonical-id gate prints any overlay `programIds` entry that is not on the R9 list — a single character of drift there is the silent-empty-overlays failure described at the top of this plan, and it is the one defect this suite cannot otherwise see. The mount loop filters comment lines out of `index.ts` before matching, because Plan 3's reservation comment already **quotes** all four factory calls (R25) — a bare `grep -q "createPromptsRouter("` passes against a file in which this plan added nothing at all, which is a gate that cannot fail rather than a gate that cannot pass, and just as useless. The R16 gate is the counterpart to the harness-proof note at the top of this task: `api/spa.ts` must still not exist and no `express.static` / `sendFile` / history fallback may have appeared anywhere, because the temptation at the end of this plan is to add one so the Playwright suite goes green. The R24 gate proves this plan added no second `CREATE TABLE`: a `040-application-writing.sql` on disk, or a second `idx_applications_user`, is the silent-no-op defect coming back. The R18 gate proves the nav rail was *inserted into* rather than retyped — nine entries, still typed `NavItem[]`, Plan 3's `adminOnly: true` Admin entry intact.

- [ ] **Step 6: Commit — and do not push**

```bash
cd /home/kasm-user/grantspotter && \
  git add e2e/writing.spec.ts && \
  git commit -m "test(e2e): template library, slot filling, prose check and copy-prompt flow"
```

**Commits stay local.** Plan 5 pushes once, at the very end, after the completeness audit and the debug audit. No task in this plan runs `git push`.

---

## What Plan 5 inherits from this plan

### The export gate — `assertExportReady` (spec §10.4)

```ts
// packages/server/src/db/repositories/applications.ts
export function assertExportReady(db: Database, applicationId: string, userId: string): void;
```

- **Where it must be called:** at the top of **every** export path that emits a draft — `/exports/draft.docx`, `/exports/packet.zip`, and any Markdown or PDF draft export — before a single byte is rendered. **An export path that does not call it is a spec §10.4 violation**, because a direct `POST` then ships unverified figures and literal `[TODO: …]` text to a funder. Gating only the browser button gates nothing.
- **What it needs:** an `applicationId`, not a body of markdown. An export handler whose body is `{ markdown }` cannot call this and must be changed to `{ applicationId, … }`, loading `markdown`, `title`, `factConfirmations` and the disclosure flag from the stored row via `getApplication(db, applicationId, userId)`.
- **Exactly when it throws:**
  1. `AppError('not_found', …)` → HTTP **404** when no application with that id belongs to `userId`. This is also the cross-user guard: an export can never read another user's draft.
  2. `AppError('conflict', …)` → HTTP **409** when `exportReadiness(...)` reports `unconfirmed > 0` — i.e. **any** extracted factual assertion (money, percent, date, callsign, name, url, citation, figure) is not yet confirmed by a person.
  3. `AppError('conflict', …)` → HTTP **409** when `openTodos > 0` — i.e. **any** `[TODO: …]` marker remains anywhere in the draft body, even if every fact is confirmed.
  It returns `void` and mutates nothing on success.
- **How Plan 5 maps it:** it does not need to. `AppError` carries its own status through Plan 1's `errorHandler` (`conflict` → 409, `not_found` → 404), so the handler either lets it propagate or calls `next(err)`. It must **not** be caught and re-thrown as a generic 500, and must not be downgraded to a warning.
- **Plan 5 owes two tests:** an application with one unconfirmed assertion returns **409** from both `/exports/draft.docx` and `/exports/packet.zip`; a fully confirmed application with no `[TODO: …]` marker returns the document.
- The behaviour is pinned by this plan's own `describe('assertExportReady')` block in `packages/server/src/api/applications.test.ts` (Task 16).

### Everything else

- The four writing routers — `createApplicationsRouter(routerDeps)`, `createTemplatesRouter(routerDeps)`, `createProseRouter(routerDeps)`, `createPromptsRouter(routerDeps)` — all take Plan 3's `RouterDeps`, and this plan's Task 17 Step 5 has already added their four `a.use(...)` lines to the one `mountRoutes` callback in `packages/server/src/index.ts` (R5 + R25). Plan 5 **appends** to that same callback — `a.use('/api', createExportsRouter(exportDeps))`, `a.use('/', createCalendarFeedRouter(exportDeps))`, and then `a.use(createSpaMiddleware(webDistRoot()));` as the final statement — and never calls `app.use` after `createApp` returns.
- The `applications` and `template_instances` tables, created by **Plan 1's `001-init.sql`** (RESOLUTIONS R24). This plan ships no migration for them; it ships `assertApplicationSchema(db)`, an assert-never-create guard. Plan 5's `APPLICATIONS_DDL` test fixture already matches that column list and does not change. **Do not add a second `CREATE TABLE IF NOT EXISTS applications` anywhere** — SQLite matches on the name, so it silently never runs, and every write then dies on `table applications has no column named answers_json`.
- **A red Playwright suite, and the one line that turns it green.** Plan 4's hard gate is `npm run typecheck && npm run build && npm test`, all three clean; `npm run test:e2e` is a harness proof only (RESOLUTIONS R16 + R25). At the end of this plan there are **ten** e2e specs — Plan 3's four in `e2e/flow.spec.ts` and this plan's six in `e2e/writing.spec.ts` — and every one of them fails at `page.goto('/')` with Plan 1's JSON 404 envelope, because nothing serves `index.html` yet. Plan 4 creates no `packages/server/src/api/spa.ts`, adds no `express.static` and no history fallback; `[ ! -e packages/server/src/api/spa.ts ]` is one of Task 20's gates. **Plan 5 Task 17 owns that file and its mount line, and Plan 5's Definition of Done is the first place all ten specs are expected to pass.** `e2e/writing.spec.ts` signs in through `ADMIN_EMAIL` / `ADMIN_PASSWORD` imported from Plan 3's `e2e/helpers.ts`, so it stays bound to `e2e/seed.ts`; if Plan 5 re-seeds the e2e database it must keep those two accounts.
- Canonical program ids the funder overlays bind to: `ardc-grants`, `arrl-amateur-radio-grants`, `arrl-club-grant`, `arrl-foundation-scholarships`, `ariss-iss-contact`, `ieee-mtts-chapter-support`, `yaesu-dr2x-repeater`, `nasa-space-grant`. **Plan 5's seed corpus adopts these verbatim (RESOLUTIONS R9) — five seed ids were renamed to match, not the other way round.** `selectTemplates` filters overlays with `t.programIds.includes(q.programId)`, so a mismatch produces no error and no warning: `GET /api/templates?programId=…` simply returns an empty `overlays` array and the funder-specific guidance disappears from the writing desk.
- **The Dockerfile must `COPY content/ ./content/` and `COPY data/reference/ ./data/reference/`.** The template loader and the consortium picker read these at runtime by walking up from the module's own directory. An image without them starts and then throws `content/ not found` on the first template request.
- `data/reference/space-grant-consortia.json` ships with `verified: false` on all 52 records by design. `verify-sources` may promote them; nothing else may.



