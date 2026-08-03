# GrantSpotter Plan 2: Ingestion

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the only network-egress path in GrantSpotter — a polite, blocklist-enforcing fetcher — plus 27 offline-testable source parsers, normalization to `Program`, change detection, the review inbox, the federal adjacency sweep, and the strictly-optional AI parse assist.

**Architecture:** `fetcher/` is the single egress chokepoint: it serializes per host, honors robots.txt including `Crawl-delay: 5`, and refuses blocklisted hosts before any transport call. `sources/*` modules are pure functions from `FetchedPayload[]` to `RawOpportunity[]`, tested only against committed fixtures. `normalize/` turns raws into `Program`s, `diff/` hashes the *parsed entries* into `ChangeEvent`s, `review/` gates every candidate behind a human, and `crawl/` orchestrates the nightly jittered run and records source health.

**Tech Stack:** TypeScript 5 (strict, NodeNext, ES2022) · Node v20.11.0 · Vitest · cheerio (HTML + XML parsing) · better-sqlite3 (WAL) · `node:crypto` · no runtime HTTP client beyond the platform `fetch`.

**Prerequisite:** Plan 1 complete — `@grantspotter/core` exports every type in CONTRACT §3 and every function in CONTRACT §4; `packages/server` exists with an Express skeleton, auth, `better-sqlite3`, and Vitest wired; `npm run typecheck`, `npm test` and `npm run build` are green.

---

## Global Constraints

Copy these verbatim into your working memory before Task 1. Every one of them is asserted by a test somewhere in this plan.

- Node **v20.11.0**, npm **10.2.4**. `export PATH="/home/kasm-user/.local/node/bin:$PATH"` before every command in this plan.
- TypeScript **strict**, `"module": "NodeNext"`, `"target": "ES2022"`. Relative imports inside `packages/server` carry the `.js` extension (NodeNext ESM), even though the files on disk are `.ts`.
- **`packages/core` stays pure.** Plan 2 adds nothing to it. No `node:` import, no I/O, no dependency but `zod` may enter `core`.
- **The fetcher is the only network egress path.** No `sources/*`, `normalize/*`, `diff/*`, or `review/*` module may call `fetch`, `https`, or read the network. A test in Task 6 greps for this.
- **`sources/*` modules never import each other and never touch the database.** `parse()` is a pure function of its `payloads` argument.
- **The blocklist is enforced inside `fetcher`, not at a call site, and cannot be enabled/disabled by configuration.** `BLOCKED_HOSTS` is frozen, contains no `process.env` read, and blocks subdomains, scheme variants, and redirect targets.
- Blocked hosts (minimum set): `farweb.org`, `candid.org`, `fconline.foundationcenter.org`, `grantwatch.com`, `grantstation.com`, `instrumentl.com`.
- **Descriptive User-Agent containing `CONTACT_URL`.** No UA spoofing, ever — `yasme.org`, `ncdxf.org`, `radioclubofamerica.org`, `mga.ieee.org`, and `k9ona.com` deliberately block non-browser clients and we respect that by hand-curating those records as Tier D.
- **Per-host serialization. Never parallelize within a host.** Minimum interval per host = `max(robots Crawl-delay, 1000 ms)`.
- **Hash the parsed entries, never the raw HTML.** `arrl.org` serves `Cache-Control: nocache` with **no ETag and no Last-Modified**, and every `<lastmod>` in its sitemap is frozen at 2010. Header- and sitemap-based change detection is useless here, and raw-HTML hashing false-positives forever on nav/footer churn.
- **An empty scrape is not a failure.** `grants.austinhams.org` legitimately shows "No opportunities available" between Aug 1 and Apr 30. Sources whose `expectedMinRecords` is `0` never fire `parse_yield_dropped` and never fire `vanished`.
- **Never use the advertised Grants.gov RSS feeds.** All four return HTTP 200 with `text/html` (a ~27 KB SPA shell), not XML. A naive poller finds zero items forever and never errors. Use `POST https://api.grants.gov/v1/api/search2`.
- **Every parser has a committed fixture under `fixtures/<sourceId>/`. Parser tests never touch the network.**
- `SESSION_SECRET` and `CONTACT_URL` have **no defaults** — the server refuses to start without them. `DATA_DIR` defaults to `/data`, `CRAWL_ENABLED` to `true`, `CRAWL_CRON` to `17 3 * * *`.
- **`npm run verify-sources` is LIVE, warn-only, and NEVER a CI gate.** It always exits 0.
- **Recorded CONTRACT §8 deviation (RESOLUTIONS R13/R14).** Plan 1 deliberately creates neither `verify-sources` nor `capture-fixture`, because at that point they would point at files that do not exist. **Plan 2 adds both to the root `package.json` `scripts` block**, exactly as CONTRACT §8 spells them, in the same way Plan 1 recorded its own deviation for `typecheck`:
  ```json
  "verify-sources": "tsx scripts/verify-sources.ts",
  "capture-fixture": "tsx scripts/capture-fixture.ts"
  ```
  `capture-fixture` is developer-only: it is never invoked by `build`, `test`, or CI. `verify-sources` is live and warn-only. Plan 3 adds `test:e2e`; Plan 5 adds `seed:arrl`. Plan 2 adds no other root script and edits no other root-`package.json` key.
- **Plan 2 introduces exactly one table that is not in CONTRACT §6's list: `review_rejects`** (reject memory, Task 21). It is declared plan-local here and in the Contract-boundary section below, and CONTRACT §6 now lists it. There is **no `source_health` table** — RESOLUTIONS R4 deleted it in favour of the health columns Plan 1 already puts on `sources`.
- **No real LAN IPs, hostnames, or host paths** anywhere — in code, fixtures, or seed data. Use `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` and `example.test` placeholders.
- **Commits stay local through this entire plan. No task runs `git push`.** Pushing happens once, at the end of Plan 5, after the audits.
- Conventional-commit prefixes: `feat:`, `fix:`, `test:`, `chore:`.

## Contract boundary and plan-local extensions

The CONTRACT is frozen. Plan 2 uses its exact names. Six additions are made, and each is called out here so no reviewer has to guess:

1. **`FetchOptions` gains optional fields only.** `{ userAgent, contactUrl, timeoutMs? }` keep their exact contract names and meanings. Plan 2 adds `dataDir?`, `transport?`, `now?`, `sleep?`, `rand?`, `maxRetries?`, `maxRedirects?`, `defaultMinIntervalMs?` and `headersByHost?` — all optional, all defaulted, so `createFetcher({ userAgent, contactUrl })` compiles and behaves exactly as the contract specifies. Most exist so every fetcher test runs offline and deterministically; `headersByHost` exists because `FetchRequest` (CONTRACT §3) has no header field and the optional Simpler.Grants.gov key must travel as `X-Auth` (Task 24). It can never override the User-Agent.
2. **Plan 2 adds one directory not enumerated in CONTRACT §2: `packages/server/src/crawl/`** (`runner.ts`, `scheduler.ts`, `health.ts`). CONTRACT §2 says `src/index.ts` is "express + scheduler"; the scheduler *wiring* lives there, the orchestration lives in `crawl/`.
3. **Plan-local types, defined inside `packages/server` and never shared:** `FollowUpSource`, `FollowUpContext`, `SignalSource`, `SinglePageConfig`, `NormalizeContext`, `RobotsRules`, `GrantsGovHit`, `GrantsGovDetail`, `NsfItem`, `NsfAwardItem`, `UsaSpendingAward`, `SimplerGrantsHit`, `ExtractOpportunity`, `SourceHealthRow`, `MissingSchemaError`, `AiAssist`, `AiClient`, `ParseHint`. None of these shadow a CONTRACT name. `ProgramSourceKey`, `ProgramRepo` and `ProgramListFilter` are Plan 1's plan-local types, imported from `db/repositories/programs.js`.
4. **Plan 2 adds one table not in CONTRACT §6: `review_rejects`** (reject memory, Task 21). CONTRACT §6 lists it. `source_health` is **not** created — RESOLUTIONS R4 deleted it in favour of the health columns Plan 1 already puts on `sources` (`last_polled_at`, `last_success_at`, `last_record_count`, `consecutive_failures`, `last_error`, `expected_min_records`).
5. **Plan 2 adds two root `package.json` scripts as a recorded CONTRACT §8 deviation** (RESOLUTIONS R13): `verify-sources` and `capture-fixture`. See Global Constraints above for the exact JSON.
6. **Plan 2 adds one directory not enumerated in CONTRACT §2: `packages/server/src/ai/`** (`assist.ts`), the strictly-optional `ANTHROPIC_API_KEY` parse/pre-score assist of spec §9 (Task 27). It is never on a read path, never required, and produces no narrative prose.

**Plan 2 consumes Plan 1's repositories for the CONTRACT §6 tables** (RESOLUTIONS R1/R8): `programs` is read and written **only** through `createProgramRepo(db)` from `packages/server/src/db/repositories/programs.js`. There is no second `programs` shape, no `doc`/`data` blob column, and no `programDoc.ts`. Plan 1 also owns the `sources`, `snapshots`, `change_events` and `review_items` DDL. What Task 20 still owns is `ensureIngestionSchema(db)`, an idempotent `CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` **assertion** pass that (a) creates the one plan-local table `review_rejects` and (b) fails loudly if a Plan 1 table or column the ingestion path needs is missing. It never `ALTER TABLE`s a Plan 1 table, never redefines one, and never re-declares an **index name** Plan 1 owns — `CREATE … IF NOT EXISTS` matches on the name, so a second definition is a silent no-op (RESOLUTIONS R23).

## Domain briefing (read once — the parsers assume it)

You do not need to know amateur radio to execute this plan, but five facts are load-bearing:

- **ARRL** (American Radio Relay League, `arrl.org`) is the US national amateur-radio association. **The ARRL Foundation** runs a single scholarship application that covers a catalog of **111 named scholarships**. One page, `arrl.org/scholarship-descriptions`, holds roughly **75% of this entire product's corpus**. All 111 share **one** deadline, which is why `DeadlineSource` has an `inherited` form.
- An **ARRL Division** is a multi-state region (e.g. "Roanoke Division" = NC/SC/VA/WV) and an **ARRL Section** is a sub-region, usually a state or part of one (e.g. "Northern Florida"). Scholarship eligibility is written in these units, not in states, which is why `core/geo.ts` ships a Division/Section ↔ state lookup table.
- **ARDC** (Amateur Radio Digital Communications, `ardc.net`) is the only ham funder in existence with a real API — a stock WordPress REST API. It is also the funder that underwrites ARRL's grants, so the two are not independent legs.
- **`farweb.org`** was the Foundation for Amateur Radio. The domain is **compromised**: it 301s to `batualam.org`, an Indonesian gambling site (`<title>TARGET88…</title>`). Wayback pins the takeover between 2025-10-17 and 2026-02-10. QCWA pages, ARRL pages, and club pages **still tell applicants to "apply at the FAR website"**, so an unguarded crawler will walk a student straight into it. This is a safety blocklist entry, not a legal one.
- **`candid.org`, `grantwatch.com`, `grantstation.com`, `instrumentl.com`** are commercial grant aggregators whose terms prohibit automated access; Candid's prohibition on AI/ML use of its data **survives termination**, and Instrumentl's `robots.txt` explicitly names `anthropic-ai`, `ClaudeBot`, and `Claude-Web`. We deep-link out to them for humans and never store a byte of their text.

## The 27 source modules

Every module in this table is registered in `sources/registry.ts` and has a fixture directory. `EMR` = `expectedMinRecords` (drives the `parse_yield_dropped` alarm).

| # | `id` | Tier | URL | EMR | Task |
|---|---|---|---|---|---|
| 1 | `ardc-grants` | A | `https://www.ardc.net/wp-json/wp/v2/pages?slug=grants&…` → runtime child query | 1 | 9 |
| 2 | `ardc-award-tables` | C | `https://www.ardc.net/apply/grants/{YYYY}-grants/` × 2019..now | 40 | 10 |
| 3 | `arrl-scholarship-descriptions` | C | `http://www.arrl.org/scholarship-descriptions` | 100 | 7 |
| 4 | `arrl-amateur-radio-grants` | C | `http://www.arrl.org/amateur-radio-grants` | 1 | 8 |
| 5 | `arrl-club-grant` | C | `https://www.arrl.org/club-grant-program` | 1 | 8 |
| 6 | `arrl-etp-grants` | C | `http://www.arrl.org/etp-grants` | 1 | 8 |
| 7 | `arrl-foundation-special-funds` | C | `http://www.arrl.org/arrl-foundation-special-funds` | 1 | 8 |
| 8 | `arrl-scholarship-program` | C | `http://www.arrl.org/scholarship-program` | 1 | 8 |
| 9 | `arrl-summary-of-scholarship-requirements` | C | `http://www.arrl.org/summary-of-scholarship-requirements` | 0 | 8 |
| 10 | `arrl-news-rss` | B | `http://www.arrl.org/news/rss` | 5 | 11 |
| 11 | `qcwa` | C | `https://www.qcwa.org/scholarship-program.htm` | 1 | 12 |
| 12 | `ylrl` | C | `https://ylrl.net/Scholarships/` | 3 | 12 |
| 13 | `austin-arc` | C | `https://austinhams.org/scholarships/` | **0** | 12 |
| 14 | `sara` | C | `https://www.radio-astronomy.org/grants` | 1 | 12 |
| 15 | `ncdxf-grants` | C | `https://www.ncdxf.org/pages/grant-app.html` | 1 | 13 |
| 16 | `ncdxf-scholarships` | C | `https://www.ncdxf.org/pages/scholarships.html` | 1 | 13 |
| 17 | `ariss` | C | `https://ariss-usa.org/proposal-overview/` | 1 | 13 |
| 18 | `ieee-mtts` | C | `https://mtt.org/chapter-support/` | 1 | 13 |
| 19 | `ieee-student-branch-rebate` | C | `https://students.ieee.org/topics/submit-your-student-branch-annual-plan/` | 1 | 13 |
| 20 | `nasa-csli` | C | `https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/` | 1 | 13 |
| 21 | `yaesu-dr2x` | C | `https://systemfusion.yaesu.com/` | 1 | 14 |
| 22 | `nsf-funding-rss` | B | 3 NSF feeds (see Task 11) | 10 | 11 |
| 23 | `grants-gov-federal` | A | `POST https://api.grants.gov/v1/api/search2` (+ optional `POST api.simpler.grants.gov/v1/opportunities/search`) | 1 | 24 |
| 24 | `manual-tier-d` | D | none (no requests) | 15 | 15 |
| 25 | `nsf-awards` | A | `https://api.nsf.gov/services/v1/awards.json` (`printFields`, `rpp=25`) | 1 | 27 |
| 26 | `usaspending` | A | `POST https://api.usaspending.gov/api/v2/search/spending_by_award/` | 1 | 27 |
| 27 | `grants-gov-extract` | A | `https://prod-grants-gov-chatbot.s3.amazonaws.com/extracts/GrantsDBExtract{YYYYMMDD}v2.zip` | 1 | 28 |

---

### Task 1: Fetcher blocklist

**Files:**
- Create: `packages/server/src/fetcher/blocklist.ts`
- Test: `packages/server/src/fetcher/blocklist.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const BLOCKED_HOSTS: readonly string[]`, `export function assertNotBlocked(url: string): void`, `export class BlockedHostError extends Error { host: string; url: string }`, `export class UnsupportedSchemeError extends Error { scheme: string; url: string }`, `export function normalizeHost(url: string): string`.

**Why this is first:** every later task that touches the network depends on this module existing. `assertNotBlocked` throws; it never returns a boolean, so a caller cannot ignore its result.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/fetcher/blocklist.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_HOSTS,
  BlockedHostError,
  UnsupportedSchemeError,
  assertNotBlocked,
  normalizeHost,
} from './blocklist.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const REQUIRED = [
  'farweb.org',
  'candid.org',
  'fconline.foundationcenter.org',
  'grantwatch.com',
  'grantstation.com',
  'instrumentl.com',
];

describe('BLOCKED_HOSTS', () => {
  it('contains every host the design requires', () => {
    expect(BLOCKED_HOSTS).toEqual(expect.arrayContaining(REQUIRED));
  });

  it('is frozen at runtime', () => {
    expect(Object.isFrozen(BLOCKED_HOSTS)).toBe(true);
    expect(() => (BLOCKED_HOSTS as string[]).push('example.test')).toThrow(TypeError);
  });

  it('is stored lowercase with no scheme, port, or path', () => {
    for (const host of BLOCKED_HOSTS) {
      expect(host).toBe(host.toLowerCase());
      expect(host).not.toMatch(/[:/]/);
    }
  });
});

describe('normalizeHost', () => {
  it('lowercases, strips the port, strips a trailing dot, and drops userinfo', () => {
    expect(normalizeHost('https://FarWeb.ORG:8443/apply?x=1')).toBe('farweb.org');
    expect(normalizeHost('http://farweb.org./')).toBe('farweb.org');
    expect(normalizeHost('https://user:pass@farweb.org/x')).toBe('farweb.org');
  });
});

describe('assertNotBlocked', () => {
  it('allows hosts that are not on the list', () => {
    expect(() => assertNotBlocked('http://www.arrl.org/scholarship-descriptions')).not.toThrow();
    expect(() => assertNotBlocked('https://www.ardc.net/apply/')).not.toThrow();
  });

  it('blocks the exact host', () => {
    expect(() => assertNotBlocked('https://farweb.org/')).toThrow(BlockedHostError);
  });

  it('blocks every subdomain, however deep', () => {
    for (const url of [
      'https://www.farweb.org/',
      'https://apply.farweb.org/scholarships',
      'https://a.b.c.farweb.org/',
      'https://fconline.foundationcenter.org/search',
    ]) {
      expect(() => assertNotBlocked(url)).toThrow(BlockedHostError);
    }
  });

  it('is not fooled by a host that merely ends with the same letters', () => {
    expect(() => assertNotBlocked('https://notfarweb.org/')).not.toThrow();
    expect(() => assertNotBlocked('https://farweb.org.example.test/')).not.toThrow();
  });

  it('blocks every scheme, case, port, trailing-dot and userinfo variation', () => {
    for (const url of [
      'http://farweb.org/',
      'HTTPS://FARWEB.ORG/',
      'https://farweb.org:8443/',
      'https://farweb.org./',
      'https://someone:secret@farweb.org/',
      'https://GrantWatch.com/grants',
      'https://www.instrumentl.com/grants/amateur-radio-digital-communications-grants',
    ]) {
      expect(() => assertNotBlocked(url)).toThrow(BlockedHostError);
    }
  });

  it('rejects non-http(s) schemes outright', () => {
    expect(() => assertNotBlocked('file:///etc/passwd')).toThrow(UnsupportedSchemeError);
    expect(() => assertNotBlocked('data:text/html,<b>x</b>')).toThrow(UnsupportedSchemeError);
    expect(() => assertNotBlocked('ftp://example.test/x')).toThrow(UnsupportedSchemeError);
  });

  it('rejects unparseable input rather than letting it through', () => {
    expect(() => assertNotBlocked('not a url')).toThrow();
  });

  it('names the host and the file in the error message', () => {
    try {
      assertNotBlocked('https://apply.farweb.org/x');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedHostError);
      const e = err as BlockedHostError;
      expect(e.host).toBe('apply.farweb.org');
      expect(e.message).toContain('blocklist.ts');
      expect(e.message).toContain('cannot be enabled by configuration');
    }
  });
});

describe('the blocklist has no configuration escape hatch', () => {
  it('reads no environment variable and exposes no override', async () => {
    const src = await readFile(path.join(HERE, 'blocklist.ts'), 'utf8');
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/\b(allowlist|bypass|override|skipBlocklist|disableBlocklist)\b/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/fetcher/blocklist.test.ts
```

Expected failure: `Failed to resolve import "./blocklist.js" from "packages/server/src/fetcher/blocklist.test.ts". Does the file exist?`

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/fetcher/blocklist.ts`:

```ts
/**
 * Hard domain blocklist. Enforced inside the fetcher (see ./index.ts), never at a call site,
 * and deliberately not configurable: there is no environment variable, no constructor option
 * and no allowlist that can re-enable any host in this file.
 *
 * farweb.org  — SAFETY. The Foundation for Amateur Radio's domain was taken over between
 *   2025-10-17 and 2026-02-10 (per Wayback) and now 301s to batualam.org, an Indonesian
 *   gambling site. QCWA, ARRL and club pages still tell applicants to "apply at the FAR
 *   website", so an unguarded crawler would surface it to a student.
 * batualam.org — the takeover target itself. Listed so a redirect chain that reaches it is
 *   refused by host, not only by the redirect guard.
 * candid.org / fconline.foundationcenter.org — the Candid API License Agreement prohibits
 *   republishing, prohibits "data mining, robots or similar data gathering and extraction
 *   methods", and specifically prohibits use for "artificial intelligence, large language
 *   models, machine learning, or similar applications" — a restriction that SURVIVES
 *   TERMINATION.
 * grantwatch.com — "Automated access, including scripts, bots, or data scraping tools, is
 *   prohibited"; "We do not offer or authorize any API access to our data or platform."
 * grantstation.com — EULA bans robots/spiders and bans use for training large language models.
 * instrumentl.com — ToS bans crawling; robots.txt explicitly names anthropic-ai, ClaudeBot and
 *   Claude-Web and disallows /grants, /foundations, /990-report.
 *
 * We deep-link out to the commercial aggregators where a human would find them useful.
 * We never store their text.
 */
export const BLOCKED_HOSTS: readonly string[] = Object.freeze([
  'farweb.org',
  'batualam.org',
  'candid.org',
  'fconline.foundationcenter.org',
  'grantwatch.com',
  'grantstation.com',
  'instrumentl.com',
]);

export class BlockedHostError extends Error {
  readonly host: string;
  readonly url: string;
  constructor(url: string, host: string) {
    super(
      `Blocked host: ${host} (${url}). This host is listed in ` +
        `packages/server/src/fetcher/blocklist.ts and cannot be enabled by configuration.`,
    );
    this.name = 'BlockedHostError';
    this.host = host;
    this.url = url;
  }
}

export class UnsupportedSchemeError extends Error {
  readonly scheme: string;
  readonly url: string;
  constructor(url: string, scheme: string) {
    super(`Unsupported scheme: ${scheme} (${url}). The fetcher speaks http and https only.`);
    this.name = 'UnsupportedSchemeError';
    this.scheme = scheme;
    this.url = url;
  }
}

/** Lowercased hostname with userinfo, port and any trailing root dot removed. */
export function normalizeHost(url: string): string {
  const parsed = new URL(url);
  return parsed.hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * Throws BlockedHostError for any blocked host or subdomain thereof, and
 * UnsupportedSchemeError for anything that is not http(s). Returns void — there is
 * deliberately no boolean form, so a caller cannot forget to check the result.
 */
export function assertNotBlocked(url: string): void {
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (scheme !== 'http' && scheme !== 'https') {
    throw new UnsupportedSchemeError(url, scheme);
  }
  const host = normalizeHost(url);
  for (const blocked of BLOCKED_HOSTS) {
    if (host === blocked || host.endsWith(`.${blocked}`)) {
      throw new BlockedHostError(url, host);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/fetcher/blocklist.test.ts && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/fetcher/blocklist.ts packages/server/src/fetcher/blocklist.test.ts
git commit -m "feat(fetcher): hard domain blocklist with no configuration escape hatch"
```

---

### Task 2: robots.txt parsing, including arrl.org's `Crawl-delay: 5`

**Files:**
- Create: `packages/server/src/fetcher/robots.ts`
- Test: `packages/server/src/fetcher/robots.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface RobotsRules { allows: string[]; disallows: string[]; crawlDelaySec?: number; status: number; fetchedAt: string }`, `export const ROBOTS_ALLOW_ALL: RobotsRules`, `export function parseRobots(body: string, agentToken: string, status: number, fetchedAt: string): RobotsRules`, `export function robotsFromResponse(status: number, body: string, agentToken: string, fetchedAt: string): RobotsRules`, `export function isPathAllowed(rules: RobotsRules, pathWithQuery: string): boolean`, `export class RobotsDisallowedError extends Error`.

**Domain facts this task encodes:**
- `arrl.org/robots.txt` sets **`Crawl-delay: 5`** and disallows `/files/file/protected`, `/attachments/download`, `/admin`, `/results-database`, `/volunteer-monitor-resources`. **All grant and scholarship paths are allowed.**
- `ncdxf.org/robots.txt` returns **403** with a meta-refresh, and so does its `sitemap.xml`. A robots parser that treats 4xx as "disallow everything" would silently drop NCDXF forever. The convention (and Google's documented behavior) is: **4xx other than 429 means there are no rules — crawl freely. 429 and 5xx mean back off — treat as disallow-all.**
- `ardc.net/robots.txt` blocks only `/wp-admin/`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/fetcher/robots.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { isPathAllowed, parseRobots, robotsFromResponse } from './robots.js';

const NOW = '2026-08-02T00:00:00.000Z';

// Shape of arrl.org/robots.txt as observed 2026-08-02.
const ARRL_ROBOTS = `User-agent: *
Crawl-delay: 5
Disallow: /files/file/protected
Disallow: /attachments/download
Disallow: /admin
Disallow: /results-database
Disallow: /volunteer-monitor-resources

Sitemap: http://www.arrl.org/sitemap.xml
`;

const ARDC_ROBOTS = `User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php

Sitemap: https://www.ardc.net/wp-sitemap.xml
`;

describe('parseRobots', () => {
  it('reads arrl.org Crawl-delay: 5 from the wildcard group', () => {
    const rules = parseRobots(ARRL_ROBOTS, 'GrantSpotter', 200, NOW);
    expect(rules.crawlDelaySec).toBe(5);
  });

  it('allows every ARRL grant and scholarship path', () => {
    const rules = parseRobots(ARRL_ROBOTS, 'GrantSpotter', 200, NOW);
    for (const p of [
      '/scholarship-descriptions',
      '/amateur-radio-grants',
      '/club-grant-program',
      '/etp-grants',
      '/news/rss',
    ]) {
      expect(isPathAllowed(rules, p)).toBe(true);
    }
  });

  it('honours every ARRL disallow, including deeper paths under it', () => {
    const rules = parseRobots(ARRL_ROBOTS, 'GrantSpotter', 200, NOW);
    for (const p of [
      '/admin',
      '/admin/users',
      '/files/file/protected/x.pdf',
      '/attachments/download?id=3',
      '/results-database',
      '/volunteer-monitor-resources',
    ]) {
      expect(isPathAllowed(rules, p)).toBe(false);
    }
  });

  it('lets a longer Allow beat a shorter Disallow', () => {
    const rules = parseRobots(ARDC_ROBOTS, 'GrantSpotter', 200, NOW);
    expect(isPathAllowed(rules, '/wp-admin/')).toBe(false);
    expect(isPathAllowed(rules, '/wp-admin/admin-ajax.php')).toBe(true);
    expect(isPathAllowed(rules, '/apply/grants/2026-grants/')).toBe(true);
    expect(isPathAllowed(rules, '/wp-json/wp/v2/pages?slug=grants')).toBe(true);
  });

  it('prefers a group naming our token over the wildcard group', () => {
    const body = `User-agent: *
Disallow: /

User-agent: GrantSpotter
Crawl-delay: 2
Disallow: /private
`;
    const rules = parseRobots(body, 'GrantSpotter', 200, NOW);
    expect(rules.crawlDelaySec).toBe(2);
    expect(isPathAllowed(rules, '/anything')).toBe(true);
    expect(isPathAllowed(rules, '/private/x')).toBe(false);
  });

  it('supports * wildcards and $ end-anchors in patterns', () => {
    const rules = parseRobots(
      'User-agent: *\nDisallow: /*.pdf$\nDisallow: /a/*/b\n',
      'GrantSpotter',
      200,
      NOW,
    );
    expect(isPathAllowed(rules, '/files/form.pdf')).toBe(false);
    expect(isPathAllowed(rules, '/files/form.pdf?v=2')).toBe(true);
    expect(isPathAllowed(rules, '/a/zzz/b')).toBe(false);
    expect(isPathAllowed(rules, '/a/b')).toBe(true);
  });

  it('ignores comments, blank lines and unknown directives', () => {
    const rules = parseRobots(
      '# hello\nUser-agent: *\nSitemap: https://x.test/s.xml\nDisallow: /q # trailing\n',
      'GrantSpotter',
      200,
      NOW,
    );
    expect(isPathAllowed(rules, '/q')).toBe(false);
    expect(isPathAllowed(rules, '/r')).toBe(true);
  });
});

describe('robotsFromResponse', () => {
  it('treats a 403 as "no rules published" — ncdxf.org 403s its own robots.txt', () => {
    const rules = robotsFromResponse(403, '', 'GrantSpotter', NOW);
    expect(isPathAllowed(rules, '/pages/grant-app.html')).toBe(true);
  });

  it('treats 404 the same way', () => {
    expect(isPathAllowed(robotsFromResponse(404, '', 'GrantSpotter', NOW), '/anything')).toBe(true);
  });

  it('treats 429 and 5xx as back-off: disallow everything until the next poll', () => {
    for (const status of [429, 500, 502, 503]) {
      const rules = robotsFromResponse(status, '', 'GrantSpotter', NOW);
      expect(isPathAllowed(rules, '/anything')).toBe(false);
    }
  });

  it('parses a 200 body normally', () => {
    const rules = robotsFromResponse(200, ARRL_ROBOTS, 'GrantSpotter', NOW);
    expect(rules.crawlDelaySec).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/fetcher/robots.test.ts
```

Expected failure: `Failed to resolve import "./robots.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/fetcher/robots.ts`:

```ts
export interface RobotsRules {
  /** Allow patterns from the winning user-agent group, in file order. */
  allows: string[];
  /** Disallow patterns from the winning user-agent group, in file order. */
  disallows: string[];
  crawlDelaySec?: number;
  status: number;
  fetchedAt: string;
}

export const ROBOTS_ALLOW_ALL: RobotsRules = Object.freeze({
  allows: [],
  disallows: [],
  status: 0,
  fetchedAt: '1970-01-01T00:00:00.000Z',
});

export class RobotsDisallowedError extends Error {
  readonly url: string;
  constructor(url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = 'RobotsDisallowedError';
    this.url = url;
  }
}

interface Group {
  agents: string[];
  allows: string[];
  disallows: string[];
  crawlDelaySec?: number;
}

function stripComment(line: string): string {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

export function parseRobots(
  body: string,
  agentToken: string,
  status: number,
  fetchedAt: string,
): RobotsRules {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line === '') {
      lastLineWasAgent = false;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], allows: [], disallows: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }
    lastLineWasAgent = false;
    if (!current) continue;
    if (field === 'disallow') {
      if (value !== '') current.disallows.push(value);
      continue;
    }
    if (field === 'allow') {
      if (value !== '') current.allows.push(value);
      continue;
    }
    if (field === 'crawl-delay') {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelaySec = n;
    }
  }

  const token = agentToken.toLowerCase();
  const named = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes('*'));
  const winner = named ?? wildcard;

  return {
    allows: winner ? [...winner.allows] : [],
    disallows: winner ? [...winner.disallows] : [],
    crawlDelaySec: winner?.crawlDelaySec,
    status,
    fetchedAt,
  };
}

/**
 * 4xx other than 429 means "no rules are published" — crawl freely. ncdxf.org 403s its own
 * robots.txt, and treating that as disallow-all would silently drop the source forever.
 * 429 and 5xx mean the server is unhappy: back off and treat it as disallow-all until the
 * next nightly poll re-reads it.
 */
export function robotsFromResponse(
  status: number,
  body: string,
  agentToken: string,
  fetchedAt: string,
): RobotsRules {
  if (status === 200) return parseRobots(body, agentToken, status, fetchedAt);
  if (status === 429 || status >= 500) {
    return { allows: [], disallows: ['/'], status, fetchedAt };
  }
  return { allows: [], disallows: [], status, fetchedAt };
}

function patternToRegExp(pattern: string): RegExp {
  let anchored = false;
  let p = pattern;
  if (p.endsWith('$')) {
    anchored = true;
    p = p.slice(0, -1);
  }
  const body = p
    .split('*')
    .map((chunk) => chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function matchLength(patterns: string[], pathWithQuery: string): number {
  let best = -1;
  for (const pattern of patterns) {
    if (patternToRegExp(pattern).test(pathWithQuery)) {
      const len = pattern.replace(/\$$/, '').length;
      if (len > best) best = len;
    }
  }
  return best;
}

/** Longest match wins; on a tie, Allow wins. */
export function isPathAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
  const allow = matchLength(rules.allows, path);
  const disallow = matchLength(rules.disallows, path);
  if (disallow === -1) return true;
  return allow >= disallow;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/fetcher/robots.test.ts && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/fetcher/robots.ts packages/server/src/fetcher/robots.test.ts
git commit -m "feat(fetcher): robots.txt parser honouring Crawl-delay and treating 4xx as allow-all"
```

---

### Task 3: Per-host serial queue

**Files:**
- Create: `packages/server/src/fetcher/hostQueue.ts`
- Test: `packages/server/src/fetcher/hostQueue.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface HostQueueOptions { defaultMinIntervalMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> }`, `export class HostQueue { constructor(opts: HostQueueOptions); setMinInterval(host: string, ms: number): void; minIntervalFor(host: string): number; run<T>(host: string, fn: () => Promise<T>): Promise<T> }`.

**Why:** research §4.4 rule 1 — "Per-host serialization + honor `Crawl-delay: 5` on arrl.org. **Never parallelize within a host.**" Two different hosts may run concurrently; two requests to the same host may not. The clock and sleep are injected so the test is deterministic and takes milliseconds rather than seconds.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/fetcher/hostQueue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { HostQueue } from './hostQueue.js';

/** Deterministic virtual clock: sleep() advances the clock instead of waiting. */
function virtualClock() {
  let t = 0;
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    get slept() {
      return slept;
    },
  };
}

describe('HostQueue', () => {
  it('serialises two requests to the same host — never overlapping', async () => {
    const clock = virtualClock();
    const q = new HostQueue({ defaultMinIntervalMs: 0, now: clock.now, sleep: clock.sleep });
    const events: string[] = [];

    const a = q.run('arrl.org', async () => {
      events.push('a:start');
      await Promise.resolve();
      events.push('a:end');
      return 1;
    });
    const b = q.run('arrl.org', async () => {
      events.push('b:start');
      events.push('b:end');
      return 2;
    });

    expect(await a).toBe(1);
    expect(await b).toBe(2);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('lets different hosts overlap', async () => {
    const clock = virtualClock();
    const q = new HostQueue({ defaultMinIntervalMs: 0, now: clock.now, sleep: clock.sleep });
    const events: string[] = [];
    let releaseA: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseA = res;
    });

    const a = q.run('arrl.org', async () => {
      events.push('a:start');
      await gate;
      events.push('a:end');
    });
    const b = q.run('ardc.net', async () => {
      events.push('b:start');
      events.push('b:end');
    });

    await b;
    releaseA();
    await a;
    expect(events).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });

  it('waits Crawl-delay: 5 between two arrl.org requests', async () => {
    const clock = virtualClock();
    const q = new HostQueue({ defaultMinIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    q.setMinInterval('arrl.org', 5000);
    expect(q.minIntervalFor('arrl.org')).toBe(5000);

    await q.run('arrl.org', async () => 'first');
    await q.run('arrl.org', async () => 'second');

    expect(clock.slept).toEqual([5000]);
  });

  it('never applies a smaller interval than the default', async () => {
    const q = new HostQueue({ defaultMinIntervalMs: 1000 });
    q.setMinInterval('example.test', 10);
    expect(q.minIntervalFor('example.test')).toBe(1000);
  });

  it('does not double-wait when real time already elapsed', async () => {
    const clock = virtualClock();
    const q = new HostQueue({ defaultMinIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await q.run('example.test', async () => 1);
    clock.advance(5000);
    await q.run('example.test', async () => 2);
    expect(clock.slept).toEqual([]);
  });

  it('keeps draining the queue after a task throws', async () => {
    const q = new HostQueue({ defaultMinIntervalMs: 0 });
    const failed = q.run('example.test', async () => {
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');
    await expect(q.run('example.test', async () => 'ok')).resolves.toBe('ok');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/fetcher/hostQueue.test.ts
```

Expected failure: `Failed to resolve import "./hostQueue.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/fetcher/hostQueue.ts`:

```ts
export interface HostQueueOptions {
  /** Floor for every host. A per-host Crawl-delay may raise this, never lower it. */
  defaultMinIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * One serial lane per host. Requests to the same host are chained end-to-end and separated by
 * at least minIntervalFor(host). Requests to different hosts run concurrently.
 */
export class HostQueue {
  private readonly defaultMinIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly intervals = new Map<string, number>();
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(opts: HostQueueOptions) {
    this.defaultMinIntervalMs = opts.defaultMinIntervalMs;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? realSleep;
  }

  setMinInterval(host: string, ms: number): void {
    this.intervals.set(host, ms);
  }

  minIntervalFor(host: string): number {
    return Math.max(this.defaultMinIntervalMs, this.intervals.get(host) ?? 0);
  }

  run<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(host) ?? Promise.resolve();
    const task = previous.then(async () => {
      const waitMs = (this.nextAllowedAt.get(host) ?? 0) - this.now();
      if (waitMs > 0) await this.sleep(waitMs);
      try {
        return await fn();
      } finally {
        this.nextAllowedAt.set(host, this.now() + this.minIntervalFor(host));
      }
    });
    // Swallow rejection on the tail only, so one failure does not poison the lane.
    this.tails.set(
      host,
      task.then(
        () => undefined,
        () => undefined,
      ),
    );
    return task;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/fetcher/hostQueue.test.ts && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/fetcher/hostQueue.ts packages/server/src/fetcher/hostQueue.test.ts
git commit -m "feat(fetcher): per-host serial queue with injectable clock"
```

---

### Task 4: `createFetcher` — the single egress path

**Files:**
- Create: `packages/server/src/fetcher/index.ts`
- Test: `packages/server/src/fetcher/index.test.ts`
- Modify: `packages/server/package.json` (no new runtime dependency; platform `fetch` only)

**Interfaces:**
- Consumes: `assertNotBlocked`, `BlockedHostError` (Task 1); `robotsFromResponse`, `isPathAllowed`, `RobotsDisallowedError` (Task 2); `HostQueue` (Task 3); `FetchRequest`, `FetchedPayload` from `@grantspotter/core`; **`buildUserAgent` from `../config.js`** (Plan 1 Task 11 — RESOLUTIONS R10: there is exactly one definition, widened by Plan 1 to `buildUserAgent(source: AppConfig | string): string`).
- Produces:
  ```ts
  export interface FetchOptions {
    userAgent: string;                 // CONTRACT
    contactUrl: string;                // CONTRACT
    timeoutMs?: number;                // CONTRACT
    // additive, optional, defaulted — see "Contract boundary" above
    dataDir?: string;
    transport?: (url: string, init: RequestInit) => Promise<Response>;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    rand?: () => number;
    maxRetries?: number;
    maxRedirects?: number;
    defaultMinIntervalMs?: number;
    /** Extra headers by exact hostname; added in Task 24 for the optional Simpler.Grants.gov X-Auth key. */
    headersByHost?: Record<string, Record<string, string>>;
  }
  export interface Fetcher { fetch(req: FetchRequest): Promise<FetchedPayload> }
  export function createFetcher(opts: FetchOptions): Fetcher;
  // NOTE: buildUserAgent is NOT exported here. It lives only in packages/server/src/config.ts
  // (Plan 1 Task 11, widened per RESOLUTIONS R10). This module imports it.
  export const AGENT_TOKEN = 'GrantSpotter';   // robots.txt user-agent group token only
  export function backoffMs(attempt: number, rand: () => number, retryAfterSec?: number): number;
  export function snapshotPathFor(dataDir: string, url: string, accept: FetchRequest['accept'], fetchedAt: string): string;
  export class HttpStatusError extends Error { status: number; url: string }
  ```

**Behaviour this task locks in:**
1. `assertNotBlocked` runs **before** the transport is touched, and again on **every redirect hop** (`redirect: 'manual'`). The redirect guard is what stops `farweb.org → batualam.org` and any future takeover chain.
2. robots.txt is fetched once per host per process (cached), through the same blocklist guard, and the resulting `Crawl-delay` raises that host's queue interval.
3. User-Agent is `GrantSpotter/<SERVER_VERSION> (+<CONTACT_URL>; nightly grant-deadline change detector)`, built by the **single** `buildUserAgent` in `packages/server/src/config.ts` (RESOLUTIONS R10). It always contains the contact URL. `fetcher/index.ts` defines no second copy.
4. Exponential backoff with full jitter on 429 and 5xx, honouring `Retry-After` when present. No rate limits are published for Grants.gov, NSF or USAspending — absence of documentation is not absence of limits.
5. Every payload is persisted under `DATA_DIR/snapshots/` when `dataDir` is set.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/fetcher/index.test.ts`:

```ts
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildUserAgent } from '../config.js';
import { BlockedHostError } from './blocklist.js';
import { RobotsDisallowedError } from './robots.js';
import { backoffMs, createFetcher } from './index.js';

const CONTACT = 'https://grantspotter.example.test/about';

function res(body: string, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) },
  });
}

/** Routes by URL; every unmatched URL is a test failure. */
function router(routes: Record<string, () => Response>) {
  const calls: string[] = [];
  const transport = vi.fn(async (url: string) => {
    calls.push(url);
    const make = routes[url];
    if (!make) throw new Error(`unexpected fetch: ${url}`);
    return make();
  });
  return { transport, calls };
}

const baseOpts = {
  userAgent: buildUserAgent(CONTACT),
  contactUrl: CONTACT,
  sleep: async () => {},
  rand: () => 0.5,
  now: () => 0,
  defaultMinIntervalMs: 0,
};

describe('the User-Agent has exactly one definition', () => {
  it('comes from config.ts and embeds the contact URL', () => {
    const ua = buildUserAgent(CONTACT);
    expect(ua).toContain('GrantSpotter');
    expect(ua).toContain(CONTACT);
    expect(ua).toContain('nightly grant-deadline change detector');
  });

  it('is not re-exported by the fetcher — RESOLUTIONS R10', async () => {
    const mod = (await import('./index.js')) as Record<string, unknown>;
    expect(mod.buildUserAgent).toBeUndefined();
  });
});

describe('createFetcher blocklist enforcement', () => {
  it('throws before the transport is called at all', async () => {
    const { transport } = router({});
    const f = createFetcher({ ...baseOpts, transport });
    await expect(
      f.fetch({ url: 'https://farweb.org/scholarships', method: 'GET', accept: 'html' }),
    ).rejects.toBeInstanceOf(BlockedHostError);
    expect(transport).not.toHaveBeenCalled();
  });

  it('throws when an allowed host redirects to a blocked host', async () => {
    const { transport } = router({
      'https://www.qcwa.example.test/robots.txt': () => res('', { status: 404 }),
      'https://www.qcwa.example.test/apply': () =>
        res('', { status: 301, headers: { location: 'https://farweb.org/apply' } }),
    });
    const f = createFetcher({ ...baseOpts, transport });
    await expect(
      f.fetch({ url: 'https://www.qcwa.example.test/apply', method: 'GET', accept: 'html' }),
    ).rejects.toBeInstanceOf(BlockedHostError);
  });

  it('exposes no option that could re-enable a blocked host', () => {
    const keys = Object.keys(baseOpts);
    expect(keys.some((k) => /allow|bypass|override|blocklist/i.test(k))).toBe(false);
  });
});

describe('createFetcher politeness', () => {
  it('sends the descriptive User-Agent on every request including robots.txt', async () => {
    const seen: Array<Record<string, string>> = [];
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      seen.push(Object.fromEntries(new Headers(init.headers).entries()));
      if (url.endsWith('/robots.txt')) return res('User-agent: *\nCrawl-delay: 5\n');
      return res('<html><body>ok</body></html>');
    });
    const f = createFetcher({ ...baseOpts, transport });
    await f.fetch({ url: 'http://www.arrl.org/etp-grants', method: 'GET', accept: 'html' });
    expect(seen).toHaveLength(2);
    for (const headers of seen) {
      expect(headers['user-agent']).toContain('GrantSpotter');
      expect(headers['user-agent']).toContain(CONTACT);
    }
  });

  it('applies the robots Crawl-delay as the per-host minimum interval', async () => {
    const slept: number[] = [];
    let t = 0;
    const transport = vi.fn(async (url: string) =>
      url.endsWith('/robots.txt') ? res('User-agent: *\nCrawl-delay: 5\n') : res('<p>x</p>'),
    );
    const f = createFetcher({
      ...baseOpts,
      transport,
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
    });
    await f.fetch({ url: 'http://www.arrl.org/etp-grants', method: 'GET', accept: 'html' });
    await f.fetch({ url: 'http://www.arrl.org/club-grant-program', method: 'GET', accept: 'html' });
    expect(slept).toContain(5000);
  });

  it('fetches robots.txt once per host', async () => {
    const { transport, calls } = router({
      'http://www.arrl.org/robots.txt': () => res('User-agent: *\n'),
      'http://www.arrl.org/a': () => res('<p>a</p>'),
      'http://www.arrl.org/b': () => res('<p>b</p>'),
    });
    const f = createFetcher({ ...baseOpts, transport });
    await f.fetch({ url: 'http://www.arrl.org/a', method: 'GET', accept: 'html' });
    await f.fetch({ url: 'http://www.arrl.org/b', method: 'GET', accept: 'html' });
    expect(calls.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('refuses a path robots.txt disallows', async () => {
    const { transport } = router({
      'http://www.arrl.org/robots.txt': () => res('User-agent: *\nDisallow: /admin\n'),
    });
    const f = createFetcher({ ...baseOpts, transport });
    await expect(
      f.fetch({ url: 'http://www.arrl.org/admin', method: 'GET', accept: 'html' }),
    ).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  it('treats a 403 robots.txt as no rules — ncdxf.org 403s its own robots.txt', async () => {
    const { transport } = router({
      'https://www.ncdxf.org/robots.txt': () => res('', { status: 403 }),
      'https://www.ncdxf.org/pages/grant-app.html': () => res('<p>grant</p>'),
    });
    const f = createFetcher({ ...baseOpts, transport });
    const payload = await f.fetch({
      url: 'https://www.ncdxf.org/pages/grant-app.html',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.status).toBe(200);
  });
});

describe('createFetcher retries', () => {
  it('backs off and retries on 503, then succeeds', async () => {
    let n = 0;
    const transport = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      n += 1;
      return n < 3 ? res('slow down', { status: 503 }) : res('<p>ok</p>');
    });
    const slept: number[] = [];
    const f = createFetcher({ ...baseOpts, transport, sleep: async (ms) => void slept.push(ms) });
    const payload = await f.fetch({
      url: 'https://api.example.test/x',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.body).toContain('ok');
    expect(slept).toHaveLength(2);
    expect(slept[1]).toBeGreaterThan(slept[0]);
  });

  it('honours Retry-After on a 429', async () => {
    let first = true;
    const transport = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      if (first) {
        first = false;
        return res('', { status: 429, headers: { 'retry-after': '7' } });
      }
      return res('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    });
    const slept: number[] = [];
    const f = createFetcher({ ...baseOpts, transport, sleep: async (ms) => void slept.push(ms) });
    await f.fetch({ url: 'https://api.example.test/y', method: 'GET', accept: 'json' });
    expect(slept).toEqual([7000]);
  });

  it('gives up after maxRetries and surfaces the status', async () => {
    const transport = vi.fn(async (url: string) =>
      url.endsWith('/robots.txt') ? res('', { status: 404 }) : res('nope', { status: 500 }),
    );
    const f = createFetcher({ ...baseOpts, transport, maxRetries: 2 });
    await expect(
      f.fetch({ url: 'https://api.example.test/z', method: 'GET', accept: 'json' }),
    ).rejects.toThrow(/500/);
  });

  it('does not retry a 404 — a missing page is an answer, not a failure', async () => {
    let hits = 0;
    const transport = vi.fn(async (url: string) => {
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      hits += 1;
      return res('missing', { status: 404 });
    });
    const f = createFetcher({ ...baseOpts, transport });
    const payload = await f.fetch({
      url: 'https://example.test/gone',
      method: 'GET',
      accept: 'html',
    });
    expect(payload.status).toBe(404);
    expect(hits).toBe(1);
  });
});

describe('backoffMs', () => {
  it('doubles per attempt, applies jitter and caps at 30s', () => {
    expect(backoffMs(0, () => 1)).toBe(1000);
    expect(backoffMs(1, () => 1)).toBe(2000);
    expect(backoffMs(0, () => 0)).toBe(500);
    expect(backoffMs(10, () => 1)).toBe(30000);
  });

  it('lets Retry-After win outright', () => {
    expect(backoffMs(0, () => 1, 7)).toBe(7000);
  });
});

describe('createFetcher POST and snapshots', () => {
  it('sends a JSON body for POST and returns the parsed payload envelope', async () => {
    let capturedInit: RequestInit | undefined;
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/robots.txt')) return res('', { status: 404 });
      capturedInit = init;
      return res('{"data":{"hitCount":3}}', { headers: { 'content-type': 'application/json' } });
    });
    const f = createFetcher({ ...baseOpts, transport });
    const payload = await f.fetch({
      url: 'https://api.grants.gov/v1/api/search2',
      method: 'POST',
      accept: 'json',
      body: { keyword: 'amateur radio', rows: 10 },
    });
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.body).toBe('{"keyword":"amateur radio","rows":10}');
    expect(new Headers(capturedInit?.headers).get('content-type')).toBe('application/json');
    expect(payload.contentType).toContain('application/json');
    expect(JSON.parse(payload.body).data.hitCount).toBe(3);
    expect(payload.url).toBe('https://api.grants.gov/v1/api/search2');
    expect(payload.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes a snapshot file under DATA_DIR/snapshots when dataDir is set', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'gs-snap-'));
    const { transport } = router({
      'https://example.test/robots.txt': () => res('', { status: 404 }),
      'https://example.test/p': () => res('<html><body>snap</body></html>'),
    });
    const f = createFetcher({ ...baseOpts, transport, dataDir });
    await f.fetch({ url: 'https://example.test/p', method: 'GET', accept: 'html' });
    const hostDir = path.join(dataDir, 'snapshots', 'example.test');
    const buckets = await readdir(hostDir);
    expect(buckets).toHaveLength(1);
    const files = await readdir(path.join(hostDir, buckets[0]));
    expect(files[0]).toMatch(/\.html$/);
    const body = await readFile(path.join(hostDir, buckets[0], files[0]), 'utf8');
    expect(body).toContain('snap');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/fetcher/index.test.ts
```

Expected failure: `Failed to resolve import "./index.js" from "packages/server/src/fetcher/index.test.ts"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/fetcher/index.ts`:

```ts
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { FetchRequest, FetchedPayload } from '@grantspotter/core';
import { assertNotBlocked, normalizeHost } from './blocklist.js';
import { HostQueue } from './hostQueue.js';
import {
  type RobotsRules,
  RobotsDisallowedError,
  isPathAllowed,
  robotsFromResponse,
} from './robots.js';

export const AGENT_TOKEN = 'GrantSpotter';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MIN_INTERVAL_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export interface FetchOptions {
  userAgent: string;
  contactUrl: string;
  timeoutMs?: number;
  /** When set, every payload is persisted under `${dataDir}/snapshots/`. */
  dataDir?: string;
  transport?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rand?: () => number;
  maxRetries?: number;
  maxRedirects?: number;
  defaultMinIntervalMs?: number;
  /**
   * Extra request headers keyed by exact hostname (Task 24). FetchRequest carries no headers and
   * the optional Simpler.Grants.gov key must travel as `X-Auth`. The User-Agent is written after
   * these and is therefore not overridable: no UA spoofing, ever.
   */
  headersByHost?: Record<string, Record<string, string>>;
}

export interface Fetcher {
  fetch(req: FetchRequest): Promise<FetchedPayload>;
}

export class HttpStatusError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(url: string, status: number) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
    this.status = status;
    this.url = url;
  }
}

// RESOLUTIONS R10: `buildUserAgent` is defined ONCE, in packages/server/src/config.ts, widened
// there to `buildUserAgent(source: AppConfig | string): string`. This module must not define a
// second copy — two definitions meant two different User-Agent strings on the wire depending on
// the call path. Callers pass the result in as `FetchOptions.userAgent`.

/** Exponential backoff with full jitter, capped at 30s. Retry-After wins outright. */
export function backoffMs(attempt: number, rand: () => number, retryAfterSec?: number): number {
  if (typeof retryAfterSec === 'number' && Number.isFinite(retryAfterSec) && retryAfterSec >= 0) {
    return Math.min(MAX_BACKOFF_MS, Math.round(retryAfterSec * 1000));
  }
  const ceiling = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return Math.round(ceiling * (0.5 + 0.5 * rand()));
}

const EXT: Record<FetchRequest['accept'], string> = {
  html: 'html',
  json: 'json',
  xml: 'xml',
  binary: 'bin',
};

const ACCEPT_HEADER: Record<FetchRequest['accept'], string> = {
  html: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
  json: 'application/json,*/*;q=0.5',
  xml: 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5',
  binary: '*/*',
};

export function snapshotPathFor(
  dataDir: string,
  url: string,
  accept: FetchRequest['accept'],
  fetchedAt: string,
): string {
  const host = normalizeHost(url);
  const bucket = createHash('sha256').update(url).digest('hex').slice(0, 16);
  const stamp = fetchedAt.replace(/[:.]/g, '-');
  return path.join(dataDir, 'snapshots', host, bucket, `${stamp}.${EXT[accept]}`);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return seconds;
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, Math.round((when - Date.now()) / 1000));
  return undefined;
}

export function createFetcher(opts: FetchOptions): Fetcher {
  const transport = opts.transport ?? ((url, init) => globalThis.fetch(url, init));
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const rand = opts.rand ?? Math.random;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? 3;
  const maxRedirects = opts.maxRedirects ?? 5;
  const queue = new HostQueue({
    defaultMinIntervalMs: opts.defaultMinIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
    now,
    sleep,
  });
  const robotsCache = new Map<string, Promise<RobotsRules>>();

  function headers(accept: FetchRequest['accept'], isJsonBody: boolean): Headers {
    const h = new Headers({
      'user-agent': opts.userAgent,
      accept: ACCEPT_HEADER[accept],
      'accept-language': 'en-US,en;q=0.9',
    });
    if (isJsonBody) h.set('content-type', 'application/json');
    return h;
  }

  async function rawGet(url: string, accept: FetchRequest['accept']): Promise<Response> {
    return transport(url, {
      method: 'GET',
      headers: headers(accept, false),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function robotsFor(origin: string): Promise<RobotsRules> {
    const cached = robotsCache.get(origin);
    if (cached) return cached;
    const promise = (async () => {
      const url = `${origin}/robots.txt`;
      assertNotBlocked(url);
      try {
        const response = await rawGet(url, 'html');
        const body = response.status === 200 ? await response.text() : '';
        return robotsFromResponse(response.status, body, AGENT_TOKEN, new Date(now()).toISOString());
      } catch {
        // A network error reading robots.txt is not a licence to crawl freely, but it is also
        // not a permanent ban: treat it as "no rules for this run" and let backoff handle the
        // real request. ncdxf.org, which 403s robots.txt, is covered by robotsFromResponse.
        return robotsFromResponse(404, '', AGENT_TOKEN, new Date(now()).toISOString());
      }
    })();
    robotsCache.set(origin, promise);
    return promise;
  }

  async function attempt(url: string, req: FetchRequest): Promise<Response> {
    const isPost = req.method === 'POST';
    return transport(url, {
      method: req.method,
      headers: headers(req.accept, isPost && req.body !== undefined),
      body: isPost && req.body !== undefined ? JSON.stringify(req.body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function fetchWithRetries(url: string, req: FetchRequest): Promise<Response> {
    let lastError: unknown;
    for (let i = 0; i <= maxRetries; i += 1) {
      try {
        const response = await attempt(url, req);
        if (response.status === 429 || response.status >= 500) {
          if (i === maxRetries) throw new HttpStatusError(url, response.status);
          await sleep(backoffMs(i, rand, parseRetryAfter(response.headers.get('retry-after'))));
          continue;
        }
        return response;
      } catch (err) {
        if (err instanceof HttpStatusError) throw err;
        lastError = err;
        if (i === maxRetries) break;
        await sleep(backoffMs(i, rand));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`fetch failed for ${url}`);
  }

  async function fetchOne(url: string, req: FetchRequest, hop: number): Promise<FetchedPayload> {
    assertNotBlocked(url);
    const parsed = new URL(url);
    const rules = await robotsFor(parsed.origin);
    if (!isPathAllowed(rules, `${parsed.pathname}${parsed.search}`)) {
      throw new RobotsDisallowedError(url);
    }
    if (rules.crawlDelaySec !== undefined) {
      queue.setMinInterval(parsed.host, Math.round(rules.crawlDelaySec * 1000));
    }

    const response = await queue.run(parsed.host, () => fetchWithRetries(url, req));

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location && hop < maxRedirects) {
        const next = new URL(location, url).toString();
        // Re-assert on every hop. This is what stops farweb.org -> batualam.org and any
        // future takeover chain from reaching a parser.
        assertNotBlocked(next);
        return fetchOne(next, req, hop + 1);
      }
    }

    const fetchedAt = new Date(now()).toISOString();
    const contentType = response.headers.get('content-type') ?? '';
    const body =
      req.accept === 'binary'
        ? Buffer.from(await response.arrayBuffer()).toString('base64')
        : await response.text();

    const payload: FetchedPayload = {
      url,
      status: response.status,
      contentType,
      body,
      fetchedAt,
    };

    if (opts.dataDir) {
      const file = snapshotPathFor(opts.dataDir, url, req.accept, fetchedAt);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, body, 'utf8');
    }
    return payload;
  }

  return {
    fetch(req: FetchRequest): Promise<FetchedPayload> {
      assertNotBlocked(req.url);
      return fetchOne(req.url, req, 0);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/fetcher/ && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/fetcher/index.ts packages/server/src/fetcher/index.test.ts
git commit -m "feat(fetcher): polite blocklist-enforcing fetcher with robots, backoff and snapshots"
```

---

### Task 5: Shared source utilities — flattening, loose labels, dates, ids

**Files:**
- Create: `packages/server/src/sources/util/text.ts`
- Create: `packages/server/src/sources/util/dates.ts`
- Create: `packages/server/src/sources/util/ids.ts`
- Create: `packages/server/src/sources/util/payload.ts`
- Test: `packages/server/src/sources/util/text.test.ts`
- Test: `packages/server/src/sources/util/dates.test.ts`
- Modify: `packages/server/package.json` — add `"cheerio": "^1.0.0"` to `dependencies`

**Interfaces:**
- Consumes: `FetchedPayload` from `@grantspotter/core`.
- Produces:
  ```ts
  // text.ts
  export function normalizeText(s: string): string;
  export function flattenHtml(html: string): string;
  export function escapeRegExp(s: string): string;
  export function looseLabelPattern(label: string): string;
  export function buildLabelRegExp(alternatesByKey: Record<string, string[]>): RegExp;
  export function splitByLabels(flatText: string, alternatesByKey: Record<string, string[]>): Record<string, string>;
  export function firstMatch(text: string, re: RegExp): string | undefined;
  // dates.ts
  export function parseUsDate(input: string, defaultYear?: number): string | undefined;
  export function parseDateRange(input: string, defaultYear?: number): { opensAt?: string; closesAt?: string } | undefined;
  // ids.ts
  export function slugId(s: string): string;
  export function programIdFor(sourceId: string, externalKey: string): string;
  // payload.ts
  export function pickPayload(payloads: FetchedPayload[], urlPart: string): FetchedPayload | undefined;
  export function requirePayload(payloads: FetchedPayload[], urlPart: string): FetchedPayload;
  ```

**Why `looseLabelPattern` exists.** The ARRL scholarship catalog is edited by hand in a CMS and the labels are typo'd in the wild: **`R egion`** (stray space inside the word), **`License   Requirement`** (three spaces), **`Scholarshp`** (dropped `i`). `looseLabelPattern('Region')` produces `R\s*e\s*g\s*i\s*o\s*n`, which matches `Region`, `R egion`, and `Re gion` alike, while a space in the canonical label becomes `\s+` so `License   Requirement` matches too. Typos that drop a letter (`Scholarshp`) are handled by listing them as explicit alternates, not by fuzzing.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/sources/util/text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildLabelRegExp,
  escapeRegExp,
  flattenHtml,
  looseLabelPattern,
  normalizeText,
  splitByLabels,
} from './text.js';

const LABELS = {
  'Field of Study': ['Field of Study', 'Fields of Study'],
  'License Requirement': ['License Requirement', 'License Requirements', 'License'],
  Region: ['Region', 'Regions'],
  'Award Amount': ['Award Amount', 'Amount'],
  'Number of Awards': ['Number of Awards', 'Number of Scholarships', 'Number of Scholarshps'],
  Other: ['Other'],
};

describe('normalizeText', () => {
  it('turns \\xa0 into a plain space and collapses runs', () => {
    expect(normalizeText('a  b')).toBe('a b');
  });

  it('collapses blank lines and trims each line', () => {
    expect(normalizeText('  a  \n\n\n   b  ')).toBe('a\nb');
  });
});

describe('flattenHtml', () => {
  it('puts each block element on its own line', () => {
    expect(flattenHtml('<p>one</p><p>two</p>')).toBe('one\ntwo');
    expect(flattenHtml('<ul><li>a</li><li>b</li></ul>')).toBe('a\nb');
  });

  it('survives invalid HTML with a <ul> opened inside a <p>', () => {
    const html = '<p>Intro<ul><li><strong>Region:</strong> Any</li></ul></p>';
    const flat = flattenHtml(html);
    expect(flat).toContain('Intro');
    expect(flat).toContain('Region: Any');
  });

  it('drops script, style and noscript content', () => {
    expect(flattenHtml('<p>keep</p><script>var drop=1</script><style>.drop{}</style>')).toBe(
      'keep',
    );
  });

  it('turns <br> into a line break', () => {
    expect(flattenHtml('<p>a<br>b</p>')).toBe('a\nb');
  });

  it('decodes entities and normalises &nbsp;', () => {
    expect(flattenHtml('<p>A&nbsp;&amp;&nbsp;B</p>')).toBe('A & B');
  });
});

describe('looseLabelPattern', () => {
  it('tolerates a stray space inside a word: "R egion"', () => {
    const re = new RegExp(looseLabelPattern('Region'), 'i');
    expect(re.test('Region')).toBe(true);
    expect(re.test('R egion')).toBe(true);
  });

  it('tolerates runs of whitespace between words: "License   Requirement"', () => {
    const re = new RegExp(looseLabelPattern('License Requirement'), 'i');
    expect(re.test('License   Requirement')).toBe(true);
  });
});

describe('escapeRegExp', () => {
  it('escapes regex metacharacters', () => {
    expect(new RegExp(escapeRegExp('a.b*c')).test('a.b*c')).toBe(true);
    expect(new RegExp(escapeRegExp('a.b*c')).test('axbxc')).toBe(false);
  });
});

describe('buildLabelRegExp', () => {
  it('prefers the longer alternate so "License Requirement" beats "License"', () => {
    const re = buildLabelRegExp(LABELS);
    const m = re.exec('\nLicense Requirement: General');
    expect(m).not.toBeNull();
    expect(m?.[0]).toContain('License Requirement');
  });
});

describe('splitByLabels', () => {
  it('extracts every field from a flat bullet body', () => {
    const flat = normalizeText(
      [
        'Some preamble sentence about the donor.',
        '• Field of Study: Electrical Engineering',
        '• License Requirement: General or higher',
        '• Region: ARRL Roanoke Division',
        '• Award Amount: $2,000',
        '• Number of Awards: Three',
        '• Other: Preference to a student ham from a ham family.',
      ].join('\n'),
    );
    const fields = splitByLabels(flat, LABELS);
    expect(fields['Field of Study']).toBe('Electrical Engineering');
    expect(fields['License Requirement']).toBe('General or higher');
    expect(fields.Region).toBe('ARRL Roanoke Division');
    expect(fields['Award Amount']).toBe('$2,000');
    expect(fields['Number of Awards']).toBe('Three');
    expect(fields.Other).toBe('Preference to a student ham from a ham family.');
    expect(fields.__preamble).toBe('Some preamble sentence about the donor.');
  });

  it('reads the typo’d labels observed in the wild', () => {
    const flat = normalizeText(
      ['R egion: Any', 'License   Requirement: Technician', 'Number of Scholarshps: 1'].join('\n'),
    );
    const fields = splitByLabels(flat, LABELS);
    expect(fields.Region).toBe('Any');
    expect(fields['License Requirement']).toBe('Technician');
    expect(fields['Number of Awards']).toBe('1');
  });

  it('keeps multi-line values intact', () => {
    const flat = normalizeText(
      ['Other: Applicant must submit', 'a letter from a club officer.', 'Region: Any'].join('\n'),
    );
    expect(splitByLabels(flat, LABELS).Other).toBe(
      'Applicant must submit\na letter from a club officer.',
    );
  });

  it('does not treat a mid-sentence word as a label', () => {
    const flat = 'The other requirement is a Region of any kind.';
    const fields = splitByLabels(flat, LABELS);
    expect(fields.Other).toBeUndefined();
    expect(fields.Region).toBeUndefined();
    expect(fields.__preamble).toBe(flat);
  });

  it('returns an empty object for empty input', () => {
    expect(splitByLabels('', LABELS)).toEqual({});
  });
});
```

Create `packages/server/src/sources/util/dates.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseDateRange, parseUsDate } from './dates.js';

describe('parseUsDate', () => {
  it('parses long and abbreviated month names', () => {
    expect(parseUsDate('December 30, 2026')).toBe('2026-12-30');
    expect(parseUsDate('Dec 30, 2026')).toBe('2026-12-30');
    expect(parseUsDate('Sept. 30, 2026')).toBe('2026-09-30');
    expect(parseUsDate('1 February 2027')).toBe('2027-02-01');
  });

  it('applies a default year when the text omits one', () => {
    expect(parseUsDate('October 31', 2026)).toBe('2026-10-31');
    expect(parseUsDate('October 31')).toBeUndefined();
  });

  it('returns undefined for text with no date', () => {
    expect(parseUsDate('rolling, no deadline')).toBeUndefined();
  });
});

describe('parseDateRange', () => {
  it('parses the Yaesu window form "June 3 - August 31, 2026"', () => {
    expect(parseDateRange('June 3 - August 31, 2026')).toEqual({
      opensAt: '2026-06-03',
      closesAt: '2026-08-31',
    });
  });

  it('parses an en dash and a same-month window', () => {
    expect(parseDateRange('February 1–28, 2027')).toEqual({
      opensAt: '2027-02-01',
      closesAt: '2027-02-28',
    });
  });

  it('parses the ARISS form "opened July 1, 2026 and closes September 30, 2026"', () => {
    expect(parseDateRange('opened July 1, 2026 and closes September 30, 2026')).toEqual({
      opensAt: '2026-07-01',
      closesAt: '2026-09-30',
    });
  });

  it('parses the Austin ARC form "May 1 through July 31"', () => {
    expect(parseDateRange('May 1 through July 31', 2026)).toEqual({
      opensAt: '2026-05-01',
      closesAt: '2026-07-31',
    });
  });

  it('returns undefined when there are not two dates', () => {
    expect(parseDateRange('applications are accepted year round')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/util/
```

Expected failure: `Failed to resolve import "./text.js"` and `Failed to resolve import "./dates.js"`.

- [ ] **Step 3: Write minimal implementation**

Install cheerio:

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npm install cheerio@^1.0.0 --workspace @grantspotter/server
```

Create `packages/server/src/sources/util/text.ts`:

```ts
import * as cheerio from 'cheerio';

const BLOCK_SELECTORS = [
  'p',
  'div',
  'li',
  'tr',
  'table',
  'ul',
  'ol',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'section',
  'article',
  'blockquote',
  'dt',
  'dd',
];

/** Collapse whitespace, kill \xa0, trim every line, drop blank lines. */
export function normalizeText(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * HTML -> line-per-block plain text. cheerio parses with parse5, which repairs the invalid
 * markup this corpus is full of (notably a <ul> opened inside a <p> on arrl.org).
 */
export function flattenHtml(html: string): string {
  const $ = cheerio.load(html);
  $('script, style, noscript').remove();
  $('br').replaceWith('\n');
  for (const selector of BLOCK_SELECTORS) {
    $(selector).each((_, el) => {
      $(el).prepend('\n').append('\n');
    });
  }
  return normalizeText($.root().text());
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A label pattern that tolerates stray whitespace anywhere inside a word and runs of
 * whitespace between words. Handles the typos observed on arrl.org: "R egion" and
 * "License   Requirement". Typos that drop a letter ("Scholarshp") are listed as explicit
 * alternates by the caller instead.
 */
export function looseLabelPattern(label: string): string {
  return label
    .split('')
    .map((ch) => (ch === ' ' ? '\\s+' : escapeRegExp(ch)))
    .join('\\s*');
}

/** Alternates sorted longest-first so "License Requirement" wins over "License". */
function sortedAlternates(alternatesByKey: Record<string, string[]>): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [key, alternates] of Object.entries(alternatesByKey)) {
    for (const alternate of alternates) pairs.push([key, alternate]);
  }
  return pairs.sort((a, b) => b[1].length - a[1].length);
}

/**
 * One global regex matching any label at the start of a line, optionally preceded by a bullet
 * and optionally followed by "(s)" and a colon. Group 1 is the canonical key index.
 */
export function buildLabelRegExp(alternatesByKey: Record<string, string[]>): RegExp {
  const pairs = sortedAlternates(alternatesByKey);
  const body = pairs.map(([, alternate]) => `(${looseLabelPattern(alternate)})`).join('|');
  return new RegExp(`(?:^|\\n)[ \\t]*[\\u2022\\u00b7*\\-\\u2013]?[ \\t]*(?:${body})\\s*:?[ \\t]*`, 'gi');
}

/**
 * Split flattened text into { canonicalLabel: verbatimValue }. Text before the first label is
 * returned under the reserved key `__preamble`. Values keep their internal newlines verbatim.
 */
export function splitByLabels(
  flatText: string,
  alternatesByKey: Record<string, string[]>,
): Record<string, string> {
  if (flatText.trim() === '') return {};
  const pairs = sortedAlternates(alternatesByKey);
  const re = buildLabelRegExp(alternatesByKey);
  const hits: Array<{ key: string; start: number; valueStart: number }> = [];

  for (let m = re.exec(flatText); m !== null; m = re.exec(flatText)) {
    const groupIndex = m.slice(1).findIndex((g) => g !== undefined);
    if (groupIndex === -1) continue;
    hits.push({ key: pairs[groupIndex][0], start: m.index, valueStart: m.index + m[0].length });
  }

  const out: Record<string, string> = {};
  const preamble = (hits.length === 0 ? flatText : flatText.slice(0, hits[0].start)).trim();
  if (preamble !== '') out.__preamble = preamble;

  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].start : flatText.length;
    const value = flatText.slice(hit.valueStart, end).trim();
    // First occurrence wins; a repeated label is appended so nothing is silently dropped.
    out[hit.key] = out[hit.key] === undefined ? value : `${out[hit.key]}\n${value}`;
  });
  return out;
}

export function firstMatch(text: string, re: RegExp): string | undefined {
  const m = re.exec(text);
  if (!m) return undefined;
  return (m[1] ?? m[0]).trim() || undefined;
}
```

Create `packages/server/src/sources/util/dates.ts`:

```ts
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const MONTH_ALT = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const MONTH_DAY = new RegExp(
  `\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?:\\s*,)?(?:\\s*(\\d{4}))?`,
  'gi',
);
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})[a-z]*\\.?(?:\\s*,)?\\s*(\\d{4})?`, 'i');

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "December 30, 2026" | "Dec 30, 2026" | "Sept. 30, 2026" | "1 February 2027" -> ISO date. */
export function parseUsDate(input: string, defaultYear?: number): string | undefined {
  MONTH_DAY.lastIndex = 0;
  const md = MONTH_DAY.exec(input);
  if (md) {
    const year = md[3] ? Number.parseInt(md[3], 10) : defaultYear;
    if (year === undefined) return undefined;
    return iso(year, MONTHS[md[1].toLowerCase().slice(0, 3)], Number.parseInt(md[2], 10));
  }
  const dm = DAY_MONTH.exec(input);
  if (dm) {
    const year = dm[3] ? Number.parseInt(dm[3], 10) : defaultYear;
    if (year === undefined) return undefined;
    return iso(year, MONTHS[dm[2].toLowerCase().slice(0, 3)], Number.parseInt(dm[1], 10));
  }
  return undefined;
}

/**
 * Two dates in one sentence: "June 3 - August 31, 2026", "February 1-28, 2027",
 * "opened July 1, 2026 and closes September 30, 2026", "May 1 through July 31".
 * A trailing year applies to both ends when the first end omits it.
 */
export function parseDateRange(
  input: string,
  defaultYear?: number,
): { opensAt?: string; closesAt?: string } | undefined {
  const found: Array<{ month: number; day: number; year?: number }> = [];
  MONTH_DAY.lastIndex = 0;
  for (let m = MONTH_DAY.exec(input); m !== null; m = MONTH_DAY.exec(input)) {
    found.push({
      month: MONTHS[m[1].toLowerCase().slice(0, 3)],
      day: Number.parseInt(m[2], 10),
      year: m[3] ? Number.parseInt(m[3], 10) : undefined,
    });
  }

  // Same-month shorthand: "February 1-28, 2027" yields one month-day plus a bare day.
  if (found.length === 1) {
    const bare = new RegExp(
      `\\b${MONTH_ALT.split('|').join('|')}[a-z]*\\.?\\s+\\d{1,2}\\s*[\\-\\u2013\\u2014]\\s*(\\d{1,2})\\b`,
      'i',
    ).exec(input);
    if (bare) found.push({ month: found[0].month, day: Number.parseInt(bare[1], 10) });
  }

  if (found.length < 2) return undefined;
  const trailingYear = found[found.length - 1].year ?? defaultYear;
  const open = found[0];
  const close = found[found.length - 1];
  const openYear = open.year ?? trailingYear;
  const closeYear = close.year ?? trailingYear;
  if (openYear === undefined || closeYear === undefined) return undefined;
  return {
    opensAt: iso(openYear, open.month, open.day),
    closesAt: iso(closeYear, close.month, close.day),
  };
}
```

Create `packages/server/src/sources/util/ids.ts`:

```ts
import { createHash } from 'node:crypto';

export function slugId(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Deterministic and stable: the same externalKey from the same source always yields the same
 * Program id, which is what lets diffPrograms match last night's record to tonight's.
 */
export function programIdFor(sourceId: string, externalKey: string): string {
  const digest = createHash('sha256').update(`${sourceId}|${externalKey}`).digest('hex').slice(0, 8);
  return `${sourceId}--${slugId(externalKey)}--${digest}`;
}
```

Create `packages/server/src/sources/util/payload.ts`:

```ts
import type { FetchedPayload } from '@grantspotter/core';

export function pickPayload(
  payloads: FetchedPayload[],
  urlPart: string,
): FetchedPayload | undefined {
  return payloads.find((p) => p.url.includes(urlPart) && p.status >= 200 && p.status < 300);
}

export function requirePayload(payloads: FetchedPayload[], urlPart: string): FetchedPayload {
  const found = pickPayload(payloads, urlPart);
  if (!found) throw new Error(`no successful payload matching "${urlPart}"`);
  return found;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/util/ && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/util packages/server/package.json package-lock.json
git commit -m "feat(sources): shared flattening, loose-label, date and id utilities"
```

---

### Task 6: Source registry, fixture harness, and `capture-fixture`

**Files:**
- Create: `packages/server/src/sources/registry.ts`
- Create: `packages/server/src/sources/types.ts`
- Create: `packages/server/test/fixtures.ts`
- Create: `scripts/capture-fixture.ts`
- Create: `fixtures/.gitkeep`
- Test: `packages/server/src/sources/registry.test.ts`
- Modify: `package.json` (root) — add `"capture-fixture": "tsx scripts/capture-fixture.ts"` to `scripts`

**Interfaces:**
- Consumes: `SourceModule`, `FetchRequest`, `FetchedPayload`, `SourceTier`, `OpportunityClass`, `RawOpportunity` from `@grantspotter/core`; `createFetcher` (Task 4).
- Produces:
  ```ts
  // sources/types.ts   (all plan-local)
  export interface FollowUpContext { sinceISO?: string }
  export interface FollowUpSource extends SourceModule {
    followUp(payloads: FetchedPayload[], ctx?: FollowUpContext): FetchRequest[];
  }
  export interface SignalSource extends SourceModule {
    signalOnly: true;
    isRelevant(raw: RawOpportunity): boolean;
  }
  export function hasFollowUp(m: SourceModule): m is FollowUpSource;
  export function isSignalSource(m: SourceModule): m is SignalSource;
  export function resolveRequests(m: SourceModule): Promise<FetchRequest[]>;
  // sources/registry.ts
  export const SOURCES: readonly SourceModule[];
  export function getSource(id: string): SourceModule;
  export function listSourceIds(): string[];
  // packages/server/test/fixtures.ts
  export const FIXTURE_ROOT: string;
  export function hasFixture(sourceId: string, file: string): boolean;
  export function loadFixture(sourceId: string, file: string): string;
  export function fixturePayload(sourceId: string, file: string, url: string, contentType?: string): FetchedPayload;
  ```

**Registry policy (asserted by the test):** ids are unique, kebab-case, and equal to the fixture directory name; `expectedMinRecords >= 0`; every module's `notes` explains any non-obvious choice; and **no `sources/*` file contains the string `globalThis.fetch`, `node-fetch`, `node:https`, or `better-sqlite3`** — sources are pure.

The registry starts empty and Tasks 7–15, 24, 27 and 28 push into it. That is deliberate: the invariant test is written once, up front, and every later task re-runs it.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/sources/registry.test.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FIXTURE_ROOT } from '../../test/fixtures.js';
import { SOURCES, getSource, listSourceIds } from './registry.js';
import { hasFollowUp, isSignalSource, resolveRequests } from './types.js';

const SOURCES_DIR = path.dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = ['globalThis.fetch', 'node-fetch', 'node:https', 'node:http', 'better-sqlite3'];

describe('source registry invariants', () => {
  it('has unique kebab-case ids', () => {
    const ids = listSourceIds();
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('gives every module a funderId, label, tier, klass and a non-negative expectedMinRecords', () => {
    for (const m of SOURCES) {
      expect(m.funderId).not.toBe('');
      expect(m.label).not.toBe('');
      expect(['A', 'B', 'C', 'D']).toContain(m.tier);
      expect(['ham_grant', 'ham_scholarship', 'adjacent_stem', 'equipment_in_kind']).toContain(
        m.klass,
      );
      expect(m.expectedMinRecords).toBeGreaterThanOrEqual(0);
    }
  });

  it('resolves every requests list without touching the network', async () => {
    for (const m of SOURCES) {
      const requests = await resolveRequests(m);
      for (const r of requests) {
        expect(['GET', 'POST']).toContain(r.method);
        expect(['html', 'json', 'xml', 'binary']).toContain(r.accept);
        expect(() => new URL(r.url)).not.toThrow();
        expect(new URL(r.url).protocol).toMatch(/^https?:$/);
      }
    }
  });

  it('getSource throws a useful error for an unknown id', () => {
    expect(() => getSource('nope')).toThrow(/nope/);
  });

  it('type guards agree with the shape of each module', () => {
    for (const m of SOURCES) {
      if (hasFollowUp(m)) expect(typeof m.followUp).toBe('function');
      if (isSignalSource(m)) expect(m.signalOnly).toBe(true);
    }
  });

  it('every registered source has a fixture directory', async () => {
    for (const m of SOURCES) {
      if (m.expectedMinRecords === 0 && (await resolveRequests(m)).length === 0) continue;
      const dir = path.join(FIXTURE_ROOT, m.id);
      const entries = await readdir(dir).catch(() => [] as string[]);
      expect(entries.length, `missing fixtures for source "${m.id}" at ${dir}`).toBeGreaterThan(0);
    }
  });

  it('no source module performs I/O — the fetcher is the only egress path', async () => {
    const files = (await readdir(SOURCES_DIR, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
      .map((e) => path.join(e.parentPath ?? SOURCES_DIR, e.name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = await readFile(file, 'utf8');
      for (const forbidden of FORBIDDEN) {
        expect(src, `${file} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
```

Create `packages/server/test/fixtures.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchedPayload } from '@grantspotter/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** <repo>/fixtures — committed real (and synthetic pathological) payloads. */
export const FIXTURE_ROOT = path.resolve(HERE, '../../..', 'fixtures');

export function fixtureFile(sourceId: string, file: string): string {
  return path.join(FIXTURE_ROOT, sourceId, file);
}

export function hasFixture(sourceId: string, file: string): boolean {
  return existsSync(fixtureFile(sourceId, file));
}

export function loadFixture(sourceId: string, file: string): string {
  return readFileSync(fixtureFile(sourceId, file), 'utf8');
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/rss+xml; charset=utf-8',
};

export function fixturePayload(
  sourceId: string,
  file: string,
  url: string,
  contentType?: string,
): FetchedPayload {
  return {
    url,
    status: 200,
    contentType: contentType ?? CONTENT_TYPE_BY_EXT[path.extname(file)] ?? 'text/plain',
    body: loadFixture(sourceId, file),
    fetchedAt: '2026-08-02T00:00:00.000Z',
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/registry.test.ts
```

Expected failure: `Failed to resolve import "./registry.js"` and `Failed to resolve import "./types.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/sources/types.ts`:

```ts
import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';

/**
 * Some sources cannot express their real request set statically. ARDC is the canonical case:
 * the child-page query needs a parent page ID that must be resolved at runtime (ARDC has no
 * grant custom-post-type; grants are hierarchical WordPress pages, and hardcoding the ID
 * breaks the moment they re-publish the page).
 *
 * A follow-up source is still pure: followUp() is a pure function of the first-phase payloads.
 * The crawl runner performs the second fetch.
 */
export interface FollowUpContext {
  /** Last successful poll for this source, used for `modified_after`-style incremental queries. */
  sinceISO?: string;
}

export interface FollowUpSource extends SourceModule {
  followUp(payloads: FetchedPayload[], ctx?: FollowUpContext): FetchRequest[];
}

/**
 * A change-signal source. arrl.org/news/rss carries grant and deadline announcements but no
 * structured opportunities, so it produces ChangeEvents for a human to read and never
 * produces candidate Programs.
 */
export interface SignalSource extends SourceModule {
  signalOnly: true;
  isRelevant(raw: RawOpportunity): boolean;
}

export function hasFollowUp(m: SourceModule): m is FollowUpSource {
  return typeof (m as Partial<FollowUpSource>).followUp === 'function';
}

export function isSignalSource(m: SourceModule): m is SignalSource {
  return (m as Partial<SignalSource>).signalOnly === true;
}

export async function resolveRequests(m: SourceModule): Promise<FetchRequest[]> {
  return typeof m.requests === 'function' ? m.requests() : m.requests;
}
```

Create `packages/server/src/sources/registry.ts`:

```ts
import type { SourceModule } from '@grantspotter/core';

/**
 * The complete source registry. 27 modules (Tasks 7-15, 24, 27 and 28 push into it).
 *
 * DO NOT add any Grants.gov RSS feed here. All four advertised feeds
 * (https://grants.gov/rss/GGRSSSynopsisNew.xml and siblings) return HTTP 200 with
 * content-type text/html — a ~27 KB single-page-app shell, not XML. A naive poller finds
 * zero items forever and never errors. Use POST https://api.grants.gov/v1/api/search2,
 * which is key-free and returns real JSON (see sources/grants-gov-federal.ts).
 *
 * DO NOT add farweb.org, candid.org, fconline.foundationcenter.org, grantwatch.com,
 * grantstation.com or instrumentl.com. They are refused inside the fetcher.
 */
const MODULES: SourceModule[] = [];

export const SOURCES: readonly SourceModule[] = MODULES;

export function listSourceIds(): string[] {
  return MODULES.map((m) => m.id);
}

export function getSource(id: string): SourceModule {
  const found = MODULES.find((m) => m.id === id);
  if (!found) {
    throw new Error(`unknown source id "${id}"; known ids: ${listSourceIds().join(', ') || '(none)'}`);
  }
  return found;
}
```

Create the fixtures root so the directory is tracked:

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && mkdir -p fixtures && touch fixtures/.gitkeep
```

Create `scripts/capture-fixture.ts`:

```ts
/**
 * Capture a committed fixture for one source, THROUGH THE FETCHER, so the blocklist,
 * robots.txt handling and per-host crawl delay all apply exactly as they do in production.
 *
 *   npm run capture-fixture -- <sourceId>
 *
 * Writes fixtures/<sourceId>/NN-<slug>.<ext>. Review the diff before committing: refreshing a
 * fixture is a deliberate, reviewable act, never a silent drift. This script is never run by
 * CI and never run by a test.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchRequest, FetchedPayload } from '@grantspotter/core';
import { buildUserAgent } from '../packages/server/src/config.js';
import { createFetcher } from '../packages/server/src/fetcher/index.js';
import { getSource } from '../packages/server/src/sources/registry.js';
import { hasFollowUp, resolveRequests } from '../packages/server/src/sources/types.js';
import { slugId } from '../packages/server/src/sources/util/ids.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT: Record<FetchRequest['accept'], string> = {
  html: 'html',
  json: 'json',
  xml: 'xml',
  binary: 'bin',
};

function nameFor(index: number, req: FetchRequest): string {
  const u = new URL(req.url);
  const stem = slugId(`${u.hostname}${u.pathname}${u.search}`) || 'index';
  return `${String(index).padStart(2, '0')}-${stem}.${EXT[req.accept]}`;
}

async function main(): Promise<void> {
  const sourceId = process.argv[2];
  if (!sourceId) {
    console.error('usage: npm run capture-fixture -- <sourceId>');
    process.exitCode = 2;
    return;
  }
  const contactUrl = process.env.CONTACT_URL;
  if (!contactUrl) {
    console.error('CONTACT_URL must be set — it goes in the crawler User-Agent.');
    process.exitCode = 2;
    return;
  }

  const source = getSource(sourceId);
  const fetcher = createFetcher({ userAgent: buildUserAgent(contactUrl), contactUrl });
  const outDir = path.join(REPO_ROOT, 'fixtures', source.id);
  await mkdir(outDir, { recursive: true });

  const requests = await resolveRequests(source);
  const payloads: FetchedPayload[] = [];
  let index = 0;

  for (const req of requests) {
    const payload = await fetcher.fetch(req);
    payloads.push(payload);
    const file = path.join(outDir, nameFor(index, req));
    await writeFile(file, payload.body, 'utf8');
    console.log(`${payload.status}  ${req.url}\n      -> ${path.relative(REPO_ROOT, file)}`);
    index += 1;
  }

  if (hasFollowUp(source)) {
    for (const req of source.followUp(payloads)) {
      const payload = await fetcher.fetch(req);
      payloads.push(payload);
      const file = path.join(outDir, nameFor(index, req));
      await writeFile(file, payload.body, 'utf8');
      console.log(`${payload.status}  ${req.url}  (follow-up)\n      -> ${path.relative(REPO_ROOT, file)}`);
      index += 1;
    }
  }

  const parsed = source.parse(payloads);
  console.log(`\nparsed ${parsed.length} record(s); expectedMinRecords=${source.expectedMinRecords}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
```

Add the script to the root `package.json` `scripts` block:

```json
"capture-fixture": "tsx scripts/capture-fixture.ts"
```

If `tsx` is not already a root devDependency (Plan 1 needs it for `verify-sources`), install it:

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npm ls tsx >/dev/null 2>&1 || npm install -D tsx@^4.19.0
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/registry.test.ts && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/registry.ts packages/server/src/sources/types.ts \
  packages/server/src/sources/registry.test.ts packages/server/test/fixtures.ts \
  scripts/capture-fixture.ts fixtures/.gitkeep package.json package-lock.json
git commit -m "feat(sources): registry, purity invariants, fixture harness and capture-fixture script"
```

---

### Task 7: `arrl-scholarship-descriptions` — the 111-entry catalog

**Files:**
- Create: `packages/server/src/sources/arrl-scholarship-descriptions.ts`
- Create: `fixtures/arrl-scholarship-descriptions/pathological.html` (synthetic, hand-authored below)
- Create: `fixtures/arrl-scholarship-descriptions/00-www-arrl-org-scholarship-descriptions.html` (captured live)
- Test: `packages/server/src/sources/arrl-scholarship-descriptions.test.ts`
- Modify: `packages/server/src/sources/registry.ts` — register the module

**Interfaces:**
- Consumes: `flattenHtml`, `normalizeText`, `splitByLabels` (Task 5); `requirePayload` (Task 5); `SourceModule`, `RawOpportunity`, `FetchedPayload` from core.
- Produces:
  ```ts
  export const ARRL_SCHOLARSHIP_LABELS: Record<string, string[]>;
  export interface ScholarshipParseResult { entries: RawOpportunity[]; stubCount: number; accordionCount: number }
  export function parseScholarshipCatalog(html: string, sourceUrl: string): ScholarshipParseResult;
  export const arrlScholarshipDescriptions: SourceModule;
  ```

**This is the single highest-yield parser in the product — roughly 75% of the entire corpus.** Everything below is a fact established by live fetch on 2026-08-02:

- URL: `http://www.arrl.org/scholarship-descriptions` (ARRL serves this over plain HTTP; the fetcher follows the redirect to HTTPS if one appears).
- The page contains **five** `div.tabArea.f-widget.f-accordion` blocks. Four are the catalog, headed `A - D`, `E - L`, `M - R`, `S - Z`. **The fifth is headed "EXPLORE ARRL" and is site chrome — it must be excluded** or you get navigation links as scholarships.
- Entries are `ul.accordion > li`. There are **114** of them; **3 are stubs** (an `li` with a heading and effectively no body), leaving **111 real entries**.
- Each `li` has `p.title > a` (the scholarship name) and `div.content` (the body).
- **Body markup is inconsistent.** Some entries are flat `<p>• Label: value</p>`; others are `<ul><li><strong>Label:</strong> value</li></ul>`. Some are invalid HTML with a `<ul>` opened inside a `<p>`. `\xa0` appears throughout. Labels are typo'd in the wild: **`R egion`**, **`License   Requirement`**, **`Scholarshp`**.
- Therefore: **entry boundaries come from the DOM, field values come from label regex over flattened text.** Never key a field off a `<strong>`, a `<li>` position, or a bullet character.
- Label frequency across the 111 entries: Field of Study 111 · License Requirement 110 · Region 109 · Institution 107 · Award Amount 101 · Number of Awards 100 · Other 65 · Age 4.
- `expectedMinRecords: 100` — well below 111 so ordinary editorial churn does not fire the alarm, well above 0 so a parser that breaks does.
- All 111 entries **share one deadline** (opens ~Oct 30, closes ~Dec 30 12:00 EST, moved from Jan 31 — never hardcode it here). Deadline inheritance is applied in `normalize/` (Task 16), not in this parser.

**Fixture strategy.** Two fixtures, both offline:
1. `pathological.html` — hand-authored, committed, ~60 lines, reproducing every documented defect. **All deterministic assertions run against this file.** It exists so the suite is green on a machine with no network and so a future ARRL redesign does not silently delete our regression coverage.
2. `00-www-arrl-org-scholarship-descriptions.html` — the real captured page. Assertions against it are looser (≥100 entries, every entry named, 4 accordions) and the whole `describe` block is **skipped when the file is absent**, so an engineer without network access can still finish this task.

- [ ] **Step 1: Write the pathological fixture**

Create `fixtures/arrl-scholarship-descriptions/pathological.html` exactly as follows. Every oddity here was observed on the live page.

```html
<!DOCTYPE html>
<html><head><title>Scholarship Descriptions</title></head>
<body>
<div id="nav"><a href="/">Home</a> <a href="/membership">Join ARRL</a></div>

<div class="tabArea f-widget f-accordion">
  <h3 class="tab">A - D</h3>
  <ul class="accordion">
    <li>
      <p class="title"><a href="#">ARDC Scholarships</a></p>
      <div class="content">
        <p>Funded by Amateur Radio Digital Communications.</p>
        <ul>
          <li><strong>Field of Study:</strong> Any</li>
          <li><strong>License&nbsp;&nbsp;Requirement:</strong> Any class, licensed at least one year</li>
          <li><strong>R egion:</strong> Any &mdash; worldwide, US licensure not required</li>
          <li><strong>Institution:</strong> Accredited two-year, four-year or graduate program</li>
          <li><strong>Award Amount:</strong> $25,000, $15,000, $10,000 and $5,000</li>
          <li><strong>Number of Scholarshps:</strong> 45</li>
          <li><strong>Other:</strong> Three references required. Preference to applicants with a GPA over 3.5.</li>
        </ul>
      </div>
    </li>
    <li>
      <p class="title"><a href="#">Challenge Met Scholarship</a></p>
      <div class="content">
        <p>&bull; Field of Study: Any<br>
        &bull; License Requirement: Technician or higher<br>
        &bull; Region: Any<br>
        &bull; Institution: Any accredited institution<br>
        &bull; Award Amount: $1,000<br>
        &bull; Number of Awards: 1 per year<br>
        &bull; Other: Applicant must provide documentation of a diagnosed learning disability.</p>
      </div>
    </li>
    <li>
      <p class="title"><a href="#">Chicago FM Club Scholarship</a></p>
      <div class="content"><p>&nbsp;</p></div>
    </li>
  </ul>
</div>

<div class="tabArea f-widget f-accordion">
  <h3 class="tab">E - L</h3>
  <ul class="accordion">
    <li>
      <p class="title"><a href="#">Edmond A. Metzger Scholarship</a></p>
      <div class="content">
        <p>Administered for the Edmond A. Metzger fund.
        <ul>
          <li>Field of Study: Electrical Engineering</li>
          <li>License Requirement: Novice or higher</li>
          <li>Region: ARRL Central Division (IL, IN, WI)</li>
          <li>Institution: Undergraduate, accredited</li>
          <li>Award Amount: $1,000</li>
          <li>Number of Awards: 1</li>
          <li>Age: 17 to 25</li>
        </ul></p>
      </div>
    </li>
    <li>
      <p class="title"><a href="#">Larry Hodges Memorial Scholarship</a></p>
      <div class="content">
        <p>&bull; Field of Study: Any, except for Liberal Arts<br>
        &bull; License Requirement: Any<br>
        &bull; Region: Residing within 250 miles of Seaford, Delaware<br>
        &bull; Institution: Any<br>
        &bull; Award Amount: $2,000<br>
        &bull; Number of Awards: Multiple per year<br>
        &bull; Other: Preference will be given to applicants residing in Louisiana. If no qualified
        applicant is identified, the award is open to any eligible applicant. A letter describing an
        at-risk-youth turnaround is required.</p>
      </div>
    </li>
    <li><p class="title"><a href="#">&nbsp;</a></p><div class="content"></div></li>
  </ul>
</div>

<div class="tabArea f-widget f-accordion">
  <h3 class="tab">M - R</h3>
  <ul class="accordion">
    <li>
      <p class="title"><a href="#">QCWA Memorial Scholarship</a></p>
      <div class="content">
        <p>&bull; Field of Study: Any<br>
        &bull; License Requirement: Any<br>
        &bull; Region: Any<br>
        &bull; Institution: Accredited degree program<br>
        &bull; Award Amount: $3,000<br>
        &bull; Number of Awards: 19<br>
        &bull; Other: Applicant must be sponsored by an active QCWA member.</p>
      </div>
    </li>
  </ul>
</div>

<div class="tabArea f-widget f-accordion">
  <h3 class="tab">S - Z</h3>
  <ul class="accordion">
    <li>
      <p class="title"><a href="#">YASME Foundation Scholarship</a></p>
      <div class="content">
        <p>&bull; Field of Study: Sciences or Engineering<br>
        &bull; License Requirement: General or higher, licensed at least two years<br>
        &bull; Region: Any<br>
        &bull; Institution: Any accredited institution<br>
        &bull; Award Amount: $5,000<br>
        &bull; Number of Awards: Three<br>
        &bull; Other: Applicant must rank in the top 5 to 10 percent of the class and submit a
        year-end activity report.</p>
      </div>
    </li>
    <li><p class="title"><a href="#">Placeholder</a></p><div class="content"><p>TBA</p></div></li>
  </ul>
</div>

<div class="tabArea f-widget f-accordion">
  <h3 class="tab">EXPLORE ARRL</h3>
  <ul class="accordion">
    <li><p class="title"><a href="/membership">Membership</a></p><div class="content"><p>Join or renew today.</p></div></li>
    <li><p class="title"><a href="/shop">ARRL Store</a></p><div class="content"><p>Books and gear.</p></div></li>
  </ul>
</div>
</body></html>
```

This fixture has 4 catalog accordions + 1 chrome accordion, 9 catalog `li`, of which **3 are stubs** (`Chicago FM Club Scholarship` with an `&nbsp;`-only body, the untitled `li`, and `Placeholder` with a body of `TBA`), leaving **6 real entries**.

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/sources/arrl-scholarship-descriptions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixturePayload, hasFixture, loadFixture } from '../../test/fixtures.js';
import {
  arrlScholarshipDescriptions,
  parseScholarshipCatalog,
} from './arrl-scholarship-descriptions.js';

const SOURCE_ID = 'arrl-scholarship-descriptions';
const URL = 'http://www.arrl.org/scholarship-descriptions';
const LIVE = '00-www-arrl-org-scholarship-descriptions.html';

const pathological = () => parseScholarshipCatalog(loadFixture(SOURCE_ID, 'pathological.html'), URL);

describe('parseScholarshipCatalog against the pathological fixture', () => {
  it('reads exactly the four catalog accordions and excludes EXPLORE ARRL chrome', () => {
    const result = pathological();
    expect(result.accordionCount).toBe(4);
    const names = result.entries.map((e) => e.name);
    expect(names).not.toContain('Membership');
    expect(names).not.toContain('ARRL Store');
  });

  it('drops the stub entries and keeps the real ones', () => {
    const result = pathological();
    expect(result.stubCount).toBe(3);
    expect(result.entries).toHaveLength(6);
    expect(result.entries.map((e) => e.name)).toEqual([
      'ARDC Scholarships',
      'Challenge Met Scholarship',
      'Edmond A. Metzger Scholarship',
      'Larry Hodges Memorial Scholarship',
      'QCWA Memorial Scholarship',
      'YASME Foundation Scholarship',
    ]);
  });

  it('reads the typo’d labels: "R egion", "License   Requirement", "Number of Scholarshps"', () => {
    const ardc = pathological().entries.find((e) => e.name === 'ARDC Scholarships');
    expect(ardc?.rawFields.Region).toContain('worldwide');
    expect(ardc?.rawFields['License Requirement']).toBe('Any class, licensed at least one year');
    expect(ardc?.rawFields['Number of Awards']).toBe('45');
  });

  it('parses a flat <p>• Label: value<br> body identically to a <ul><li><strong>…</strong></li> body', () => {
    const flat = pathological().entries.find((e) => e.name === 'Challenge Met Scholarship');
    expect(flat?.rawFields['Field of Study']).toBe('Any');
    expect(flat?.rawFields['Award Amount']).toBe('$1,000');
    expect(flat?.rawFields['Number of Awards']).toBe('1 per year');
    expect(flat?.rawFields.Other).toContain('diagnosed learning disability');
  });

  it('recovers fields from invalid HTML with a <ul> opened inside a <p>', () => {
    const metzger = pathological().entries.find((e) => e.name === 'Edmond A. Metzger Scholarship');
    expect(metzger?.rawFields['Field of Study']).toBe('Electrical Engineering');
    expect(metzger?.rawFields.Region).toBe('ARRL Central Division (IL, IN, WI)');
    expect(metzger?.rawFields.Age).toBe('17 to 25');
  });

  it('normalises \\xa0 out of every value', () => {
    for (const entry of pathological().entries) {
      for (const value of Object.values(entry.rawFields)) {
        expect(value).not.toContain(' ');
      }
    }
  });

  it('preserves the whole flattened entry verbatim in rawText', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    expect(hodges?.rawText).toContain('If no qualified');
    expect(hodges?.rawText).toContain('at-risk-youth turnaround');
  });

  it('keeps the "Any, except for Liberal Arts" exclusion verbatim', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    expect(hodges?.rawFields['Field of Study']).toBe('Any, except for Liberal Arts');
  });

  it('keeps the radius region verbatim so the geography extractor can read it', () => {
    const hodges = pathological().entries.find((e) => e.name === 'Larry Hodges Memorial Scholarship');
    expect(hodges?.rawFields.Region).toBe('Residing within 250 miles of Seaford, Delaware');
  });

  it('uses the scholarship name as a stable externalKey and stamps the sourceUrl', () => {
    const entry = pathological().entries[0];
    expect(entry.externalKey).toBe('ARDC Scholarships');
    expect(entry.sourceId).toBe(SOURCE_ID);
    expect(entry.sourceUrl).toBe(URL);
  });
});

describe('the SourceModule wrapper', () => {
  it('declares the contract fields the runner needs', () => {
    expect(arrlScholarshipDescriptions.id).toBe(SOURCE_ID);
    expect(arrlScholarshipDescriptions.tier).toBe('C');
    expect(arrlScholarshipDescriptions.klass).toBe('ham_scholarship');
    expect(arrlScholarshipDescriptions.expectedMinRecords).toBe(100);
    expect(arrlScholarshipDescriptions.requests).toEqual([
      { url: URL, method: 'GET', accept: 'html' },
    ]);
  });

  it('parses from a FetchedPayload array', () => {
    const payload = fixturePayload(SOURCE_ID, 'pathological.html', URL);
    expect(arrlScholarshipDescriptions.parse([payload])).toHaveLength(6);
  });

  it('returns [] rather than throwing when the payload is missing', () => {
    expect(arrlScholarshipDescriptions.parse([])).toEqual([]);
  });
});

describe.skipIf(!hasFixture(SOURCE_ID, LIVE))('against the captured live page', () => {
  it('finds four accordions and at least 100 real entries', () => {
    const result = parseScholarshipCatalog(loadFixture(SOURCE_ID, LIVE), URL);
    expect(result.accordionCount).toBe(4);
    expect(result.entries.length).toBeGreaterThanOrEqual(100);
  });

  it('names every entry and gives almost all of them a Field of Study', () => {
    const { entries } = parseScholarshipCatalog(loadFixture(SOURCE_ID, LIVE), URL);
    for (const e of entries) expect(e.name.length).toBeGreaterThan(2);
    const withField = entries.filter((e) => e.rawFields['Field of Study'] !== undefined);
    expect(withField.length / entries.length).toBeGreaterThan(0.9);
  });

  it('does not contain the discontinued Chicago FM Club Scholarship', () => {
    const { entries } = parseScholarshipCatalog(loadFixture(SOURCE_ID, LIVE), URL);
    expect(entries.map((e) => e.name).join('|')).not.toMatch(/Chicago FM Club/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/arrl-scholarship-descriptions.test.ts
```

Expected failure: `Failed to resolve import "./arrl-scholarship-descriptions.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/sources/arrl-scholarship-descriptions.ts`:

```ts
import * as cheerio from 'cheerio';
import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { pickPayload } from './util/payload.js';
import { flattenHtml, splitByLabels } from './util/text.js';

const SOURCE_ID = 'arrl-scholarship-descriptions';
const URL = 'http://www.arrl.org/scholarship-descriptions';

/**
 * Canonical label -> alternates seen on the page. Whitespace typos ("R egion",
 * "License   Requirement") are absorbed by looseLabelPattern; typos that DROP a letter
 * ("Scholarshp") must be listed explicitly. Order inside a key does not matter — the matcher
 * sorts every alternate longest-first so "License Requirement" beats "License".
 */
export const ARRL_SCHOLARSHIP_LABELS: Record<string, string[]> = {
  'Field of Study': ['Field of Study', 'Fields of Study', 'Field of Studies'],
  'License Requirement': ['License Requirement', 'License Requirements', 'License'],
  Region: ['Region', 'Regions'],
  Institution: ['Institution', 'Institutions'],
  'Award Amount': ['Award Amount', 'Award Amounts', 'Amount'],
  'Number of Awards': [
    'Number of Awards',
    'Number of Award',
    'Number of Scholarships',
    'Number of Scholarshps',
  ],
  Age: ['Age Requirement', 'Age'],
  Other: ['Other Requirements', 'Additional Requirements', 'Other'],
};

const FIELD_KEYS = Object.keys(ARRL_SCHOLARSHIP_LABELS);

export interface ScholarshipParseResult {
  entries: RawOpportunity[];
  stubCount: number;
  accordionCount: number;
}

/**
 * Entry boundaries come from the DOM (`div.tabArea.f-widget.f-accordion` -> `ul.accordion > li`).
 * Field values come from a label regex over the FLATTENED text of each li, never from DOM shape:
 * some entries are flat `<p>• Label: value<br></p>`, some are `<ul><li><strong>Label:</strong></li></ul>`,
 * and some open a `<ul>` inside a `<p>`, which is invalid HTML.
 */
export function parseScholarshipCatalog(html: string, sourceUrl: string): ScholarshipParseResult {
  const $ = cheerio.load(html);
  const entries: RawOpportunity[] = [];
  let stubCount = 0;
  let accordionCount = 0;

  $('div.tabArea.f-widget.f-accordion').each((_, accordion) => {
    const $accordion = $(accordion);
    const heading = $accordion.find('h3.tab').first().text().trim();
    // The fifth accordion on the live page is headed "EXPLORE ARRL" and is site chrome.
    if (/explore\s*arrl/i.test(heading)) return;
    const items = $accordion.find('ul.accordion > li');
    if (items.length === 0) return;
    accordionCount += 1;

    items.each((__, li) => {
      const $li = $(li);
      const name = $li.find('p.title').first().text().replace(/ /g, ' ').trim();
      const bodyHtml = $li.find('div.content').first().html() ?? '';
      const rawText = flattenHtml(bodyHtml);
      const split = splitByLabels(rawText, ARRL_SCHOLARSHIP_LABELS);

      const rawFields: Record<string, string> = {};
      for (const key of FIELD_KEYS) {
        const value = split[key];
        if (value !== undefined && value !== '') rawFields[key] = value;
      }
      const preamble = split.__preamble;
      if (preamble !== undefined && preamble !== '') rawFields.__preamble = preamble;

      // A stub is an li with no usable name, or with no recognised label and a body too short to
      // carry any requirement. 3 of the 114 li on the live page are stubs.
      const isStub =
        name === '' || (Object.keys(rawFields).length === 0 && rawText.length < 40) ||
        (Object.keys(rawFields).filter((k) => k !== '__preamble').length === 0 && rawText.length < 40);
      if (isStub) {
        stubCount += 1;
        return;
      }

      entries.push({
        sourceId: SOURCE_ID,
        externalKey: name,
        name,
        rawFields,
        sourceUrl,
        rawText,
      });
    });
  });

  return { entries, stubCount, accordionCount };
}

export const arrlScholarshipDescriptions: SourceModule = {
  id: SOURCE_ID,
  funderId: 'arrl-foundation',
  label: 'ARRL Foundation Scholarship catalog',
  tier: 'C',
  klass: 'ham_scholarship',
  requests: [{ url: URL, method: 'GET', accept: 'html' }],
  expectedMinRecords: 100,
  notes:
    'Highest-yield source in the product: ~75% of the corpus. 114 li minus 3 stubs = 111 real ' +
    'entries across 4 accordions; a 5th "EXPLORE ARRL" accordion is chrome and is excluded. ' +
    'Parsed by label regex over flattened text because body markup is inconsistent, includes ' +
    'invalid HTML (<ul> inside <p>), \\xa0, and typos ("R egion", "License   Requirement", ' +
    '"Scholarshp"). All 111 share ONE deadline, applied by normalize/ via deadline inheritance. ' +
    'arrl.org sends Cache-Control: nocache with no ETag and no Last-Modified, and its sitemap ' +
    '<lastmod> is frozen at 2010 — change detection must hash parsed entries, never headers.',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const payload = pickPayload(payloads, '/scholarship-descriptions');
    if (!payload) return [];
    return parseScholarshipCatalog(payload.body, payload.url).entries;
  },
};
```

Register it in `packages/server/src/sources/registry.ts` — add the import at the top and the entry to `MODULES`:

```ts
import { arrlScholarshipDescriptions } from './arrl-scholarship-descriptions.js';
```

```ts
const MODULES: SourceModule[] = [arrlScholarshipDescriptions];
```

- [ ] **Step 5: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/ && npm run typecheck
```

- [ ] **Step 6: Capture the live fixture (network; skip if unreachable)**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter
CONTACT_URL=https://grantspotter.example.test/about npm run capture-fixture -- arrl-scholarship-descriptions
npx vitest run packages/server/src/sources/arrl-scholarship-descriptions.test.ts
```

Expected console output ends with `parsed 111 record(s); expectedMinRecords=100`. If the host is unreachable, skip this step — the `describe.skipIf` block stays skipped and the task is still complete.

- [ ] **Step 7: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/arrl-scholarship-descriptions.ts \
  packages/server/src/sources/arrl-scholarship-descriptions.test.ts \
  packages/server/src/sources/registry.ts fixtures/arrl-scholarship-descriptions
git commit -m "feat(sources): ARRL scholarship catalog parser (label-regex over flattened text)"
```

---

### Task 8: The six single-page ARRL sources, via a config-driven parser

**Files:**
- Create: `packages/server/src/sources/util/singlePage.ts`
- Create: `packages/server/src/sources/arrl-pages.ts`
- Create: `fixtures/arrl-amateur-radio-grants/pathological.html`
- Create: `fixtures/arrl-club-grant/pathological.html`
- Create: `fixtures/arrl-etp-grants/pathological.html`
- Create: `fixtures/arrl-foundation-special-funds/pathological.html`
- Create: `fixtures/arrl-scholarship-program/pathological.html`
- Create: `fixtures/arrl-summary-of-scholarship-requirements/pathological.html`
- Test: `packages/server/src/sources/util/singlePage.test.ts`
- Test: `packages/server/src/sources/arrl-pages.test.ts`
- Modify: `packages/server/src/sources/registry.ts`

**Interfaces:**
- Consumes: `flattenHtml`, `firstMatch`, `pickPayload` (Task 5).
- Produces:
  ```ts
  export interface SinglePageConfig {
    id: string; funderId: string; label: string;
    tier: SourceTier; klass: OpportunityClass;
    url: string; name: string; externalKey: string;
    /** rawFields key -> pattern run over the flattened page text. Group 1 wins, else group 0. */
    fieldPatterns: Record<string, RegExp>;
    /** If any of these keys fails to match, parse() returns [] so the yield alarm fires. */
    requiredFields: string[];
    expectedMinRecords: number;
    notes?: string;
    /** Optional extra records mined from the same page (e.g. the Club Grant recipient list). */
    extraParse?: (flatText: string, html: string, sourceUrl: string) => RawOpportunity[];
  }
  export function makeSinglePageSource(cfg: SinglePageConfig): SourceModule;
  export function parseClubGrantRecipients(flatText: string, sourceUrl: string): RawOpportunity[];
  export const arrlAmateurRadioGrants: SourceModule;
  export const arrlClubGrant: SourceModule;
  export const arrlEtpGrants: SourceModule;
  export const arrlFoundationSpecialFunds: SourceModule;
  export const arrlScholarshipProgram: SourceModule;
  export const arrlSummaryOfScholarshipRequirements: SourceModule;
  ```

**Per-source table.** Each row is one `SinglePageConfig`. `EMR` = `expectedMinRecords`. Fixture path is `fixtures/<id>/pathological.html` (plus `00-*.html` after a live capture).

| `id` | URL | Required field patterns (over flattened text) | EMR | Domain note |
|---|---|---|---|---|
| `arrl-amateur-radio-grants` | `http://www.arrl.org/amateur-radio-grants` | `windows`: `/(February\s+1[^.]*?October\s+31)/i` · `amount`: `/(generally[^.]*?\$[\d,]+[^.]*\.)/i` · `restrictions`: `/(do(?:es)? not fund[^.]*\.)/i` · `applicant`: `/(organizations?[^.]*not[^.]*individuals?[^.]*\.)/i` | 1 | Three fixed windows per year: **Feb 1–28, Jun 1–30, Oct 1–31**. US organizations only, never individuals. Excludes emergency-communications equipment and ongoing operating expenses; prefers co-funded projects. "Generally do not exceed $3,000", up to $5,000 in 2026 ("Year of the Club"). Best-structured ARRL deadline page. |
| `arrl-club-grant` | `https://www.arrl.org/club-grant-program` | `amount`: `/\$1,000[^.]*\$25,000/i` · `eligibility`: `/(ARRL[- ]affiliated[^.]*\.)/i` — **no deadline pattern: the page has never published one** | 1 | ARDC-funded. $1,000–$25,000; 2024: $500,502 to 37 of 110 applicants. Deadline is **disputed** — three researchers reached three different conclusions and the page carries no deadline field. Ships `disputed` (populated in Task 16), never a guessed date. `extraParse` also mines the recipient block. |
| `arrl-etp-grants` | `http://www.arrl.org/etp-grants` | `window`: `/(Oct(?:ober)?\.?\s*1\s*[–-]\s*(?:Oct(?:ober)?\.?\s*)?31[^.]*\.)/i` · `jotformId`: `/jotform\.com\/(?:form\/)?(\d{8,})/i` · `applicant`: `/(teachers?[^.]*\.)/i` | 1 | Teachers Institute / school-station equipment grants for **US K-12 schools and teachers**, not colleges. Applicant must be an ARRL member and must file a signed antenna-approval form. **Cash amount is genuinely unpublished** — leave `amountRaw` verbatim and `amountMin/Max` undefined. URL is year-agnostic but the Jotform id and attachments change underneath, which is why the Jotform id is captured as a field. |
| `arrl-foundation-special-funds` | `http://www.arrl.org/arrl-foundation-special-funds` | `summary`: `/(special funds?[^.]*\.)/i` | 1 | Named endowments and special funds. Low volume, prose page; used mostly for provenance and the funder record. |
| `arrl-scholarship-program` | `http://www.arrl.org/scholarship-program` | `window`: `/(open[^.]*?clos[^.]*\.)/i` · `closeTime`: `/(\d{1,2}:\d{2}\s*(?:AM|PM)\s*E[SD]T)/i` | 1 | **This page owns the deadline that all 111 catalog entries inherit.** Opens ~Oct 30, closes ~Dec 30 12:00 PM EST — moved from Jan 31, so never hardcode it. A single application covers the whole catalog. |
| `arrl-summary-of-scholarship-requirements` | `http://www.arrl.org/summary-of-scholarship-requirements` | none | **0** | 80-row table, easiest page on the site to parse **and stale**: 79 entries vs the catalog's 111, abbreviated non-joinable keys, still lists dropped scholarships. `EMR: 0` and `tags: ['crosscheck']` — it is a secondary geography cross-check only and **must never publish a Program**. |

- [ ] **Step 1: Write the six pathological fixtures**

Each is a minimal page carrying the exact sentences the patterns above must find. Create them verbatim.

`fixtures/arrl-amateur-radio-grants/pathological.html`:

```html
<!DOCTYPE html><html><body><div id="nav"><a href="/">Home</a></div>
<h1>Amateur Radio Grants</h1>
<p>The ARRL Foundation accepts applications during three windows each year:
February 1&nbsp;-&nbsp;28, June 1 - 30, and October 1 - 31.</p>
<p>Grants generally do not exceed $3,000; for 2026, the Year of the Club, awards of up to
$5,000 may be considered.</p>
<p>Awards are made to organizations, including clubs and schools, and not to individuals.</p>
<p>The Foundation does not fund emergency communications equipment or ongoing operating
expenses, and prefers projects that are co-funded.</p>
</body></html>
```

`fixtures/arrl-club-grant/pathological.html`:

```html
<!DOCTYPE html><html><body>
<h1>Club Grant Program</h1>
<p>Grants range from $1,000 to $25,000 and are funded by Amateur Radio Digital Communications.</p>
<p>Applicants must be an ARRL-affiliated club in good standing.</p>
<h2>2024 Recipients</h2>
<ul>
  <li>Kansas State University Amateur Radio Club, KS &mdash; $18,000</li>
  <li>Missouri S&amp;T Amateur Radio Club, MO &mdash; $12,500</li>
  <li>Oklahoma State University ARC, OK &mdash; $9,000</li>
  <li>Baylor University WA5BU, TX &mdash; $7,400</li>
  <li>City Tech Amateur Radio Club, NY &mdash; $5,000</li>
</ul>
</body></html>
```

`fixtures/arrl-etp-grants/pathological.html`:

```html
<!DOCTYPE html><html><body>
<h1>ETP Grants</h1>
<p>Applications are accepted October 1 - 31 of 2025.</p>
<p>Grants are available to teachers at US K-12 schools; the applicant must be an ARRL member
and must submit a signed antenna approval form.</p>
<p><a href="https://form.jotform.com/form/243456789012345">Apply on Jotform</a></p>
</body></html>
```

`fixtures/arrl-foundation-special-funds/pathological.html`:

```html
<!DOCTYPE html><html><body>
<h1>ARRL Foundation Special Funds</h1>
<p>The Foundation administers special funds established by donors to support amateur radio
education and public service.</p>
</body></html>
```

`fixtures/arrl-scholarship-program/pathological.html`:

```html
<!DOCTYPE html><html><body>
<h1>Scholarship Program</h1>
<p>The application opens October 30 and closes December 30 at 12:00 PM EST.</p>
<p>One application covers every scholarship in the catalog.</p>
</body></html>
```

`fixtures/arrl-summary-of-scholarship-requirements/pathological.html`:

```html
<!DOCTYPE html><html><body>
<h1>Summary of Scholarship Requirements</h1>
<table>
  <tr><th>Scholarship</th><th>Region</th><th>License</th></tr>
  <tr><td>ARDC</td><td>Any</td><td>Any</td></tr>
  <tr><td>Metzger</td><td>Central Div</td><td>Novice+</td></tr>
</table>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/sources/util/singlePage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeSinglePageSource } from './singlePage.js';

const cfg = {
  id: 'demo-source',
  funderId: 'demo-funder',
  label: 'Demo',
  tier: 'C' as const,
  klass: 'ham_grant' as const,
  url: 'https://example.test/demo',
  name: 'Demo Program',
  externalKey: 'demo-program',
  fieldPatterns: {
    windows: /(February\s+1[^.]*?October\s+31)/i,
    amount: /(\$[\d,]+)/,
  },
  requiredFields: ['windows'],
  expectedMinRecords: 1,
};

const page = (body: string) => ({
  url: 'https://example.test/demo',
  status: 200,
  contentType: 'text/html',
  body,
  fetchedAt: '2026-08-02T00:00:00.000Z',
});

describe('makeSinglePageSource', () => {
  it('produces a SourceModule with the contract fields', () => {
    const m = makeSinglePageSource(cfg);
    expect(m.id).toBe('demo-source');
    expect(m.requests).toEqual([{ url: cfg.url, method: 'GET', accept: 'html' }]);
    expect(m.expectedMinRecords).toBe(1);
  });

  it('extracts every matching field over the flattened text', () => {
    const m = makeSinglePageSource(cfg);
    const raws = m.parse([page('<p>February 1 - 28, June 1 - 30, and October 31.</p><p>$3,000</p>')]);
    expect(raws).toHaveLength(1);
    expect(raws[0].rawFields.windows).toContain('October 31');
    expect(raws[0].rawFields.amount).toBe('$3,000');
    expect(raws[0].externalKey).toBe('demo-program');
    expect(raws[0].name).toBe('Demo Program');
    expect(raws[0].rawText).toContain('February 1');
  });

  it('returns [] when a required field does not match, so the yield alarm fires', () => {
    const m = makeSinglePageSource(cfg);
    expect(m.parse([page('<p>nothing useful here</p>')])).toEqual([]);
  });

  it('returns [] when the payload is missing entirely', () => {
    expect(makeSinglePageSource(cfg).parse([])).toEqual([]);
  });

  it('omits an optional field that does not match rather than storing an empty string', () => {
    const m = makeSinglePageSource(cfg);
    const raws = m.parse([page('<p>February 1 - 28 ... October 31.</p>')]);
    expect(raws[0].rawFields.amount).toBeUndefined();
  });

  it('appends extraParse records after the main record', () => {
    const m = makeSinglePageSource({
      ...cfg,
      extraParse: (flat, _html, sourceUrl) =>
        flat.includes('Recipients')
          ? [
              {
                sourceId: cfg.id,
                externalKey: 'award:demo',
                name: 'Demo Award',
                rawFields: { recordType: 'past_award' },
                sourceUrl,
                rawText: 'Demo Award',
              },
            ]
          : [],
    });
    const raws = m.parse([page('<p>February 1 - 28 ... October 31.</p><h2>Recipients</h2>')]);
    expect(raws).toHaveLength(2);
    expect(raws[1].rawFields.recordType).toBe('past_award');
  });
});
```

Create `packages/server/src/sources/arrl-pages.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import {
  arrlAmateurRadioGrants,
  arrlClubGrant,
  arrlEtpGrants,
  arrlFoundationSpecialFunds,
  arrlScholarshipProgram,
  arrlSummaryOfScholarshipRequirements,
  parseClubGrantRecipients,
} from './arrl-pages.js';

const p = (id: string, url: string) => fixturePayload(id, 'pathological.html', url);

describe('arrl-amateur-radio-grants', () => {
  const raws = arrlAmateurRadioGrants.parse([
    p('arrl-amateur-radio-grants', 'http://www.arrl.org/amateur-radio-grants'),
  ]);

  it('captures all three application windows in one field', () => {
    expect(raws).toHaveLength(1);
    const windows = raws[0].rawFields.windows;
    expect(windows).toMatch(/February\s*1/);
    expect(windows).toMatch(/June\s*1/);
    expect(windows).toMatch(/October\s*1\s*-\s*31/);
  });

  it('captures the $3,000 / $5,000 amount sentence verbatim', () => {
    expect(raws[0].rawFields.amount).toContain('$3,000');
    expect(raws[0].rawFields.amount).toContain('$5,000');
  });

  it('captures the funding restrictions and the organizations-only rule', () => {
    expect(raws[0].rawFields.restrictions).toMatch(/emergency communications/i);
    expect(raws[0].rawFields.restrictions).toMatch(/operating expenses/i);
    expect(raws[0].rawFields.applicant).toMatch(/not to individuals/i);
  });
});

describe('arrl-club-grant', () => {
  const raws = arrlClubGrant.parse([p('arrl-club-grant', 'https://www.arrl.org/club-grant-program')]);

  it('captures the $1,000-$25,000 range and the affiliation requirement', () => {
    expect(raws[0].rawFields.amount).toContain('$25,000');
    expect(raws[0].rawFields.eligibility).toMatch(/ARRL-affiliated/i);
  });

  it('has NO deadline field, because the page has never published one', () => {
    expect(raws[0].rawFields.window).toBeUndefined();
    expect(raws[0].rawFields.deadline).toBeUndefined();
  });

  it('mines the recipient list as past-award records', () => {
    const awards = raws.filter((r) => r.rawFields.recordType === 'past_award');
    expect(awards).toHaveLength(5);
    expect(awards[0].rawFields.recipient).toBe('Kansas State University Amateur Radio Club');
    expect(awards[0].rawFields.state).toBe('KS');
    expect(awards[0].rawFields.amountRaw).toBe('$18,000');
    expect(awards[0].externalKey).toContain('Kansas State');
  });
});

describe('parseClubGrantRecipients', () => {
  it('ignores lines that are not recipient rows', () => {
    expect(parseClubGrantRecipients('Just some prose about grants.', 'https://x.test')).toEqual([]);
  });
});

describe('arrl-etp-grants', () => {
  const raws = arrlEtpGrants.parse([p('arrl-etp-grants', 'http://www.arrl.org/etp-grants')]);

  it('captures the October window and the year-specific Jotform id', () => {
    expect(raws[0].rawFields.window).toMatch(/October 1 - 31/);
    expect(raws[0].rawFields.jotformId).toBe('243456789012345');
  });

  it('captures the teacher/K-12 applicant sentence', () => {
    expect(raws[0].rawFields.applicant).toMatch(/teachers/i);
  });
});

describe('arrl-scholarship-program', () => {
  it('captures the open/close sentence and the 12:00 PM EST close time', () => {
    const raws = arrlScholarshipProgram.parse([
      p('arrl-scholarship-program', 'http://www.arrl.org/scholarship-program'),
    ]);
    expect(raws[0].rawFields.window).toMatch(/opens October 30/i);
    expect(raws[0].rawFields.closeTime).toBe('12:00 PM EST');
  });
});

describe('arrl-foundation-special-funds', () => {
  it('parses a single prose record', () => {
    const raws = arrlFoundationSpecialFunds.parse([
      p('arrl-foundation-special-funds', 'http://www.arrl.org/arrl-foundation-special-funds'),
    ]);
    expect(raws).toHaveLength(1);
    expect(raws[0].rawFields.summary).toMatch(/special funds/i);
  });
});

describe('arrl-summary-of-scholarship-requirements', () => {
  it('is a cross-check source: expectedMinRecords 0 and it never publishes', () => {
    expect(arrlSummaryOfScholarshipRequirements.expectedMinRecords).toBe(0);
    expect(arrlSummaryOfScholarshipRequirements.notes).toMatch(/stale/i);
    const raws = arrlSummaryOfScholarshipRequirements.parse([
      p(
        'arrl-summary-of-scholarship-requirements',
        'http://www.arrl.org/summary-of-scholarship-requirements',
      ),
    ]);
    for (const raw of raws) expect(raw.rawFields.recordType).toBe('crosscheck');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/util/singlePage.test.ts packages/server/src/sources/arrl-pages.test.ts
```

Expected failure: `Failed to resolve import "./singlePage.js"` and `Failed to resolve import "./arrl-pages.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/sources/util/singlePage.ts`:

```ts
import type {
  FetchedPayload,
  OpportunityClass,
  RawOpportunity,
  SourceModule,
  SourceTier,
} from '@grantspotter/core';
import { pickPayload } from './payload.js';
import { flattenHtml } from './text.js';

export interface SinglePageConfig {
  id: string;
  funderId: string;
  label: string;
  tier: SourceTier;
  klass: OpportunityClass;
  url: string;
  name: string;
  externalKey: string;
  /** rawFields key -> pattern run over the flattened page text. Group 1 wins, else group 0. */
  fieldPatterns: Record<string, RegExp>;
  /** If any of these keys fails to match, parse() returns [] so the yield alarm fires. */
  requiredFields: string[];
  expectedMinRecords: number;
  notes?: string;
  extraParse?: (flatText: string, html: string, sourceUrl: string) => RawOpportunity[];
}

/**
 * Most Tier C ham funders publish exactly one opportunity on one prose page, and the useful
 * facts are sentences rather than markup. This turns a config into a SourceModule that runs
 * label-free regexes over the FLATTENED page text — the same discipline as the ARRL catalog
 * parser, for the same reason: these pages are hand-edited and their markup is not stable.
 */
export function makeSinglePageSource(cfg: SinglePageConfig): SourceModule {
  const pathPart = new URL(cfg.url).pathname;
  return {
    id: cfg.id,
    funderId: cfg.funderId,
    label: cfg.label,
    tier: cfg.tier,
    klass: cfg.klass,
    requests: [{ url: cfg.url, method: 'GET', accept: 'html' }],
    expectedMinRecords: cfg.expectedMinRecords,
    notes: cfg.notes,
    parse(payloads: FetchedPayload[]): RawOpportunity[] {
      const payload = pickPayload(payloads, pathPart);
      if (!payload) return [];
      const flat = flattenHtml(payload.body);

      const rawFields: Record<string, string> = {};
      for (const [key, pattern] of Object.entries(cfg.fieldPatterns)) {
        const re = new RegExp(pattern.source, pattern.flags.replace('g', ''));
        const m = re.exec(flat);
        if (!m) continue;
        const value = (m[1] ?? m[0]).replace(/\s+/g, ' ').trim();
        if (value !== '') rawFields[key] = value;
      }

      const missing = cfg.requiredFields.filter((k) => rawFields[k] === undefined);
      const main: RawOpportunity[] =
        missing.length > 0
          ? []
          : [
              {
                sourceId: cfg.id,
                externalKey: cfg.externalKey,
                name: cfg.name,
                rawFields,
                sourceUrl: payload.url,
                rawText: flat,
              },
            ];

      const extra = cfg.extraParse ? cfg.extraParse(flat, payload.body, payload.url) : [];
      return [...main, ...extra];
    },
  };
}
```

Create `packages/server/src/sources/arrl-pages.ts`:

```ts
import type { RawOpportunity, SourceModule } from '@grantspotter/core';
import { type SinglePageConfig, makeSinglePageSource } from './util/singlePage.js';

/**
 * "Kansas State University Amateur Radio Club, KS — $18,000" on the Club Grant page.
 * Em dash, en dash and hyphen all appear in the wild; the amount is optional because some
 * years list recipients without figures.
 */
const RECIPIENT_LINE =
  /^(.+?),\s*([A-Z]{2})\s*[—–-]\s*(\$[\d,]+)?\s*$/;

export function parseClubGrantRecipients(
  flatText: string,
  sourceUrl: string,
): RawOpportunity[] {
  const out: RawOpportunity[] = [];
  for (const line of flatText.split('\n')) {
    const m = RECIPIENT_LINE.exec(line.trim());
    if (!m) continue;
    const recipient = m[1].trim();
    const state = m[2];
    const amountRaw = m[3] ?? '';
    if (recipient.length < 4) continue;
    out.push({
      sourceId: 'arrl-club-grant',
      externalKey: `past-award:${recipient}:${state}`,
      name: `${recipient} (ARRL Club Grant recipient)`,
      rawFields: { recordType: 'past_award', recipient, state, amountRaw },
      sourceUrl,
      rawText: line.trim(),
    });
  }
  return out;
}

const CONFIGS: SinglePageConfig[] = [
  {
    id: 'arrl-amateur-radio-grants',
    funderId: 'arrl-foundation',
    label: 'ARRL Amateur Radio Grants',
    tier: 'C',
    klass: 'ham_grant',
    url: 'http://www.arrl.org/amateur-radio-grants',
    name: 'ARRL Amateur Radio Grants',
    externalKey: 'amateur-radio-grants',
    fieldPatterns: {
      windows: /(February\s*1[^.]*?October\s*1\s*[-–]\s*31)/i,
      amount: /(generally do not exceed[^.]*\.(?:[^.]*\$[\d,]+[^.]*\.)?)/i,
      restrictions: /(does not fund[^.]*\.)/i,
      applicant: /(made to organizations[^.]*\.)/i,
    },
    requiredFields: ['windows'],
    expectedMinRecords: 1,
    notes:
      'Three fixed windows per year: Feb 1-28, Jun 1-30, Oct 1-31, stated inline. US ' +
      'organizations only, never individuals. Excludes emergency-communications equipment and ' +
      'ongoing operating expenses; prefers co-funded projects. Generally <= $3,000, up to ' +
      '$5,000 in 2026 ("Year of the Club").',
  },
  {
    id: 'arrl-club-grant',
    funderId: 'arrl-foundation',
    label: 'ARRL Club Grant Program',
    tier: 'C',
    klass: 'ham_grant',
    url: 'https://www.arrl.org/club-grant-program',
    name: 'ARRL Club Grant Program',
    externalKey: 'club-grant-program',
    fieldPatterns: {
      amount: /(\$1,000\s*to\s*\$25,000)/i,
      eligibility: /(ARRL[-\s]affiliated[^.]*\.)/i,
    },
    requiredFields: ['amount'],
    expectedMinRecords: 1,
    extraParse: (flat, _html, sourceUrl) => parseClubGrantRecipients(flat, sourceUrl),
    notes:
      'ARDC-funded; $1,000-$25,000; 2024 awarded $500,502 to 37 of 110 applicants. There is ' +
      'deliberately NO deadline pattern here: the page has never published a deadline field, ' +
      'and three researchers reached three different conclusions on 2026-08-02 (dormant / ' +
      'autumn window / Feb-Jun-Oct, the last probably conflating it with the separate Amateur ' +
      'Radio Grants cycle). The record ships `disputed` rather than a guessed date. The ' +
      'application portal is a JS SPA and returns no server-side text, so open/closed status ' +
      'cannot be determined programmatically.',
  },
  {
    id: 'arrl-etp-grants',
    funderId: 'arrl',
    label: 'ARRL Teachers Institute / ETP Grants',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'http://www.arrl.org/etp-grants',
    name: 'ARRL ETP Grants (School Station and Progress)',
    externalKey: 'etp-grants',
    fieldPatterns: {
      window: /(Oct(?:ober)?\.?\s*1\s*[-–]\s*(?:Oct(?:ober)?\.?\s*)?31[^.]*\.)/i,
      jotformId: /jotform\.com\/(?:form\/)?(\d{8,})/i,
      applicant: /(available to teachers[^.]*\.)/i,
    },
    requiredFields: ['window'],
    expectedMinRecords: 1,
    notes:
      'US K-12 schools and teachers, not colleges. Applicant must be an ARRL member and must ' +
      'file a signed antenna-approval form. Cash amount is genuinely unpublished — keep ' +
      'amountRaw verbatim and leave amountMin/amountMax undefined. The URL is year-agnostic ' +
      'but the Jotform id and the attached xlsx/pdf change underneath, so the Jotform id is ' +
      'captured as a change signal. Page text still said "of 2025" on 2026-08-02 — stale.',
  },
  {
    id: 'arrl-foundation-special-funds',
    funderId: 'arrl-foundation',
    label: 'ARRL Foundation Special Funds',
    tier: 'C',
    klass: 'ham_grant',
    url: 'http://www.arrl.org/arrl-foundation-special-funds',
    name: 'ARRL Foundation Special Funds',
    externalKey: 'foundation-special-funds',
    fieldPatterns: { summary: /(special funds?[^.]*\.)/i },
    requiredFields: ['summary'],
    expectedMinRecords: 1,
    notes: 'Named donor endowments. Prose page; low volume, used for funder provenance.',
  },
  {
    id: 'arrl-scholarship-program',
    funderId: 'arrl-foundation',
    label: 'ARRL Foundation Scholarship Program (cycle owner)',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'http://www.arrl.org/scholarship-program',
    name: 'ARRL Foundation Scholarship Program',
    externalKey: 'scholarship-program',
    fieldPatterns: {
      window: /(opens?[^.]*?clos[^.]*\.)/i,
      closeTime: /(\d{1,2}:\d{2}\s*(?:AM|PM)\s*E[SD]T)/i,
    },
    requiredFields: ['window'],
    expectedMinRecords: 1,
    notes:
      'THIS PAGE OWNS THE DEADLINE that all 111 catalog entries inherit (see normalize/, ' +
      'DeadlineSource.inherited). Opens ~Oct 30, closes ~Dec 30 12:00 PM EST. It MOVED from ' +
      'Jan 31, so the date is read from the page every night and never hardcoded.',
  },
  {
    id: 'arrl-summary-of-scholarship-requirements',
    funderId: 'arrl-foundation',
    label: 'ARRL summary-of-requirements table (cross-check only)',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'http://www.arrl.org/summary-of-scholarship-requirements',
    name: 'ARRL summary of scholarship requirements',
    externalKey: 'summary-of-scholarship-requirements',
    fieldPatterns: { table: /(Scholarship[\s\S]{0,4000})/i },
    requiredFields: [],
    expectedMinRecords: 0,
    notes:
      'STALE. 80-row table, easiest page on the site to parse and the most misleading: 79 ' +
      'entries against the catalog’s 111, abbreviated non-joinable keys, and it still lists ' +
      'dropped scholarships. expectedMinRecords is 0 and every record is tagged crosscheck so ' +
      'normalize/ refuses to publish it. Secondary geography cross-check only.',
  },
];

function withCrosscheckTag(module: SourceModule): SourceModule {
  const inner = module.parse.bind(module);
  return {
    ...module,
    parse: (payloads) =>
      inner(payloads).map((raw) => ({
        ...raw,
        rawFields: { ...raw.rawFields, recordType: 'crosscheck' },
      })),
  };
}

const [amateur, club, etp, special, program, summary] = CONFIGS.map(makeSinglePageSource);

export const arrlAmateurRadioGrants = amateur;
export const arrlClubGrant = club;
export const arrlEtpGrants = etp;
export const arrlFoundationSpecialFunds = special;
export const arrlScholarshipProgram = program;
export const arrlSummaryOfScholarshipRequirements = withCrosscheckTag(summary);

export const ARRL_PAGE_SOURCES: SourceModule[] = [
  arrlAmateurRadioGrants,
  arrlClubGrant,
  arrlEtpGrants,
  arrlFoundationSpecialFunds,
  arrlScholarshipProgram,
  arrlSummaryOfScholarshipRequirements,
];
```

Register them in `packages/server/src/sources/registry.ts`:

```ts
import { ARRL_PAGE_SOURCES } from './arrl-pages.js';
```

```ts
const MODULES: SourceModule[] = [arrlScholarshipDescriptions, ...ARRL_PAGE_SOURCES];
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/ && npm run typecheck
```

- [ ] **Step 6: Capture the live fixtures (network; skip if unreachable)**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter
for s in arrl-amateur-radio-grants arrl-club-grant arrl-etp-grants \
         arrl-foundation-special-funds arrl-scholarship-program \
         arrl-summary-of-scholarship-requirements; do
  CONTACT_URL=https://grantspotter.example.test/about npm run capture-fixture -- "$s" || true
done
```

arrl.org publishes `Crawl-delay: 5`, so this loop takes about half a minute. That is correct behaviour, not a hang.

- [ ] **Step 7: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/util/singlePage.ts packages/server/src/sources/util/singlePage.test.ts \
  packages/server/src/sources/arrl-pages.ts packages/server/src/sources/arrl-pages.test.ts \
  packages/server/src/sources/registry.ts fixtures/arrl-amateur-radio-grants \
  fixtures/arrl-club-grant fixtures/arrl-etp-grants fixtures/arrl-foundation-special-funds \
  fixtures/arrl-scholarship-program fixtures/arrl-summary-of-scholarship-requirements
git commit -m "feat(sources): config-driven single-page parser and the six ARRL pages"
```

---

### Task 9: `ardc-grants` — the only real ham API, with runtime parent-ID resolution

**Files:**
- Create: `packages/server/src/sources/ardc-grants.ts`
- Create: `fixtures/ardc-grants/00-discovery.json`
- Create: `fixtures/ardc-grants/01-children.json`
- Test: `packages/server/src/sources/ardc-grants.test.ts`
- Modify: `packages/server/src/sources/registry.ts`

**Interfaces:**
- Consumes: `FollowUpSource`, `FollowUpContext` (Task 6); `requirePayload`, `pickPayload` (Task 5).
- Produces: `export function resolveGrantsParentId(discoveryJson: string): number | undefined`, `export function buildChildrenRequest(parentId: number, sinceISO?: string): FetchRequest`, `export const ardcGrants: FollowUpSource`.

**Domain facts (all verified live 2026-08-02):**
- ARDC (`ardc.net`) runs stock WordPress with an **open, key-free REST API**. It is the only ham-relevant source in existence with a real API.
- **ARDC has no grant custom-post-type.** `GET /wp-json/wp/v2/types` returns only `post`, `page`, `attachment`. Grants are hierarchical **pages** under `/apply/grants/`.
- **The parent page ID must be resolved at runtime.** Hardcoding it breaks the moment ARDC re-publishes the page. Phase 1 asks for `?slug=grants`, phase 2 asks for `?parent=<id>`.
- `modified_after=<ISO8601>` is **confirmed working** and is the incremental lever. The runner supplies `sinceISO` from the source's last successful poll; on a first run there is no `sinceISO` and the full child list is fetched.
- `robots.txt` on ardc.net blocks only `/wp-admin/`, so `/wp-json/` is allowed.
- ARDC's four fixed application cycles are **Feb 1, Apr 1, Jul 1, Sep 1**; anything after Sep 1 rolls to the next Feb 1. Evaluation takes 60–120 days, which is what drives the calendar's prep-lead-time overlay in Plan 3.
- ARDC's own `/feed/` carries news only and **zero grant announcements** — do not add it as a source.

- [ ] **Step 1: Write the fixtures**

`fixtures/ardc-grants/00-discovery.json` — the phase-1 slug lookup. WordPress returns an array, and more than one page can share a slug, so the resolver must pick by `link`:

```json
[
  {"id": 4821, "slug": "grants", "link": "https://www.ardc.net/apply/grants/", "parent": 118, "title": {"rendered": "Grants"}, "modified": "2026-07-19T18:02:11"},
  {"id": 9001, "slug": "grants", "link": "https://www.ardc.net/news/grants/", "parent": 55, "title": {"rendered": "Grants News"}, "modified": "2026-02-02T10:00:00"}
]
```

`fixtures/ardc-grants/01-children.json` — the phase-2 child pages:

```json
[
  {"id": 5511, "slug": "2026-grants", "link": "https://www.ardc.net/apply/grants/2026-grants/", "parent": 4821, "title": {"rendered": "2026 Grants"}, "date": "2026-01-08T09:00:00", "modified": "2026-07-30T14:21:00", "excerpt": {"rendered": "<p>Grants awarded in 2026.</p>"}},
  {"id": 5290, "slug": "2025-grants", "link": "https://www.ardc.net/apply/grants/2025-grants/", "parent": 4821, "title": {"rendered": "2025 Grants"}, "date": "2025-01-06T09:00:00", "modified": "2026-01-04T11:00:00", "excerpt": {"rendered": "<p>Grants awarded in 2025.</p>"}},
  {"id": 6402, "slug": "grant-hamsci-psws-expansion", "link": "https://www.ardc.net/apply/grants/grant-hamsci-psws-expansion/", "parent": 4821, "title": {"rendered": "HamSCI Personal Space Weather Station Expansion"}, "date": "2026-04-02T09:00:00", "modified": "2026-04-02T09:00:00", "excerpt": {"rendered": "<p>$77,000 to expand the PSWS network.</p>"}}
]
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/sources/ardc-grants.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
import { ardcGrants, buildChildrenRequest, resolveGrantsParentId } from './ardc-grants.js';

const DISCOVERY_URL =
  'https://www.ardc.net/wp-json/wp/v2/pages?slug=grants&per_page=100&_fields=id,slug,link,parent,title,modified';
const CHILDREN_URL_PART = 'parent=4821';

const discovery = () => fixturePayload('ardc-grants', '00-discovery.json', DISCOVERY_URL);
const children = () =>
  fixturePayload(
    'ardc-grants',
    '01-children.json',
    'https://www.ardc.net/wp-json/wp/v2/pages?parent=4821&per_page=100',
  );

describe('resolveGrantsParentId', () => {
  it('picks the page whose link is the /apply/grants/ page, not another page with the same slug', () => {
    expect(resolveGrantsParentId(loadFixture('ardc-grants', '00-discovery.json'))).toBe(4821);
  });

  it('returns undefined when nothing matches rather than guessing an id', () => {
    expect(resolveGrantsParentId('[]')).toBeUndefined();
    expect(resolveGrantsParentId('{"code":"rest_no_route"}')).toBeUndefined();
    expect(resolveGrantsParentId('not json')).toBeUndefined();
  });
});

describe('buildChildrenRequest', () => {
  it('asks for the child pages of the resolved parent with the fields we need', () => {
    const req = buildChildrenRequest(4821);
    expect(req.method).toBe('GET');
    expect(req.accept).toBe('json');
    expect(req.url).toContain('parent=4821');
    expect(req.url).toContain('per_page=100');
    expect(req.url).toContain('_fields=id,slug,link,title,date,modified,parent,excerpt');
    expect(req.url).not.toContain('modified_after');
  });

  it('adds modified_after for an incremental poll — the confirmed working lever', () => {
    const req = buildChildrenRequest(4821, '2026-07-01T00:00:00.000Z');
    expect(req.url).toContain('modified_after=2026-07-01T00%3A00%3A00.000Z');
  });
});

describe('ardcGrants source module', () => {
  it('is Tier A and starts with the discovery request only', async () => {
    expect(ardcGrants.tier).toBe('A');
    const requests = Array.isArray(ardcGrants.requests) ? ardcGrants.requests : [];
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toContain('slug=grants');
    expect(requests[0].url).not.toMatch(/parent=\d/);
  });

  it('never hardcodes a parent page id anywhere in its requests', async () => {
    const requests = Array.isArray(ardcGrants.requests) ? ardcGrants.requests : [];
    expect(requests[0].url).not.toContain('4821');
  });

  it('followUp resolves the parent at runtime and asks for its children', () => {
    const [req] = ardcGrants.followUp([discovery()]);
    expect(req.url).toContain(CHILDREN_URL_PART);
  });

  it('followUp passes sinceISO through as modified_after', () => {
    const [req] = ardcGrants.followUp([discovery()], { sinceISO: '2026-07-01T00:00:00.000Z' });
    expect(req.url).toContain('modified_after=');
  });

  it('followUp returns [] when discovery failed, rather than throwing mid-crawl', () => {
    expect(ardcGrants.followUp([])).toEqual([]);
  });

  it('parses child pages into RawOpportunity records', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    expect(raws).toHaveLength(3);
    const psws = raws.find((r) => r.name.includes('HamSCI'));
    expect(psws?.externalKey).toBe('6402');
    expect(psws?.sourceUrl).toBe('https://www.ardc.net/apply/grants/grant-hamsci-psws-expansion/');
    expect(psws?.rawFields.modified).toBe('2026-04-02T09:00:00');
    expect(psws?.rawFields.slug).toBe('grant-hamsci-psws-expansion');
    expect(psws?.rawText).toContain('$77,000');
  });

  it('strips HTML out of the WordPress excerpt but keeps the text verbatim', () => {
    const raws = ardcGrants.parse([discovery(), children()]);
    for (const raw of raws) expect(raw.rawText).not.toContain('<p>');
  });

  it('returns [] when the children payload is missing', () => {
    expect(ardcGrants.parse([discovery()])).toEqual([]);
  });

  it('documents the four fixed cycles and the no-custom-post-type finding in notes', () => {
    expect(ardcGrants.notes).toMatch(/Feb 1/);
    expect(ardcGrants.notes).toMatch(/custom-post-type/i);
    expect(ardcGrants.notes).toMatch(/never hardcode/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/ardc-grants.test.ts
```

Expected failure: `Failed to resolve import "./ardc-grants.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/sources/ardc-grants.ts`:

```ts
import type { FetchRequest, FetchedPayload, RawOpportunity } from '@grantspotter/core';
import type { FollowUpContext, FollowUpSource } from './types.js';
import { pickPayload } from './util/payload.js';
import { flattenHtml } from './util/text.js';

const SOURCE_ID = 'ardc-grants';
const API = 'https://www.ardc.net/wp-json/wp/v2/pages';
const DISCOVERY_URL = `${API}?slug=grants&per_page=100&_fields=id,slug,link,parent,title,modified`;
const CHILD_FIELDS = 'id,slug,link,title,date,modified,parent,excerpt';

interface WpPage {
  id?: number;
  slug?: string;
  link?: string;
  parent?: number;
  title?: { rendered?: string };
  date?: string;
  modified?: string;
  excerpt?: { rendered?: string };
}

function parseJsonArray(json: string): WpPage[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? (value as WpPage[]) : [];
  } catch {
    return [];
  }
}

/**
 * ARDC has NO grant custom-post-type (wp/v2/types returns post/page/attachment only) — grants
 * are hierarchical PAGES under /apply/grants/. The parent id must be resolved at runtime;
 * hardcoding it breaks the moment ARDC re-publishes the page. More than one page can carry
 * the slug "grants", so we match on the link path, not on the slug alone.
 */
export function resolveGrantsParentId(discoveryJson: string): number | undefined {
  for (const page of parseJsonArray(discoveryJson)) {
    if (typeof page.id !== 'number' || typeof page.link !== 'string') continue;
    if (new URL(page.link).pathname.replace(/\/$/, '') === '/apply/grants') return page.id;
  }
  return undefined;
}

export function buildChildrenRequest(parentId: number, sinceISO?: string): FetchRequest {
  const params = new URLSearchParams({
    parent: String(parentId),
    per_page: '100',
    _fields: CHILD_FIELDS,
  });
  // modified_after is confirmed working on ardc.net and is the whole point of using the API.
  if (sinceISO) params.set('modified_after', sinceISO);
  return { url: `${API}?${params.toString()}`, method: 'GET', accept: 'json' };
}

export const ardcGrants: FollowUpSource = {
  id: SOURCE_ID,
  funderId: 'ardc',
  label: 'ARDC Grants Program (WordPress REST API)',
  tier: 'A',
  klass: 'ham_grant',
  requests: [{ url: DISCOVERY_URL, method: 'GET', accept: 'json' }],
  expectedMinRecords: 1,
  notes:
    'The only ham-relevant source in existence with a real, key-free API. ARDC has no grant ' +
    'custom-post-type (wp/v2/types = post/page/attachment only): grants are hierarchical ' +
    'PAGES under /apply/grants/, so the parent page id is resolved at runtime and never ' +
    'hardcoded. modified_after is the confirmed working incremental lever. Four fixed ' +
    'application cycles: Feb 1, Apr 1, Jul 1, Sep 1; anything after Sep 1 rolls to the next ' +
    'Feb 1, and evaluation takes 60-120 days. All ARDC output must be open-source/open-access ' +
    'and indirect costs are capped at 20%. ardc.net/feed/ carries news only and zero grant ' +
    'announcements — deliberately not a source.',

  followUp(payloads: FetchedPayload[], ctx?: FollowUpContext): FetchRequest[] {
    const discovery = pickPayload(payloads, 'slug=grants');
    if (!discovery) return [];
    const parentId = resolveGrantsParentId(discovery.body);
    if (parentId === undefined) return [];
    return [buildChildrenRequest(parentId, ctx?.sinceISO)];
  },

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const children = payloads.find((p) => p.url.includes('parent=') && p.status === 200);
    if (!children) return [];
    const out: RawOpportunity[] = [];
    for (const page of parseJsonArray(children.body)) {
      if (typeof page.id !== 'number' || typeof page.link !== 'string') continue;
      const name = flattenHtml(page.title?.rendered ?? '') || page.slug || String(page.id);
      const excerpt = flattenHtml(page.excerpt?.rendered ?? '');
      out.push({
        sourceId: SOURCE_ID,
        externalKey: String(page.id),
        name,
        rawFields: {
          slug: page.slug ?? '',
          link: page.link,
          date: page.date ?? '',
          modified: page.modified ?? '',
          excerpt,
        },
        sourceUrl: page.link,
        rawText: [name, excerpt].filter(Boolean).join('\n'),
      });
    }
    return out;
  },
};
```

Register in `registry.ts`: `import { ardcGrants } from './ardc-grants.js';` and add `ardcGrants` to `MODULES`.

- [ ] **Step 5: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/ && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/ardc-grants.ts packages/server/src/sources/ardc-grants.test.ts \
  packages/server/src/sources/registry.ts fixtures/ardc-grants
git commit -m "feat(sources): ARDC WordPress REST source with runtime parent-page resolution"
```

---

### Task 10: `ardc-award-tables` — eight years of per-year award tables

**Files:**
- Create: `packages/server/src/sources/ardc-award-tables.ts`
- Create: `fixtures/ardc-award-tables/pathological.html`
- Test: `packages/server/src/sources/ardc-award-tables.test.ts`
- Modify: `packages/server/src/sources/registry.ts`

**Interfaces:**
- Consumes: `flattenHtml` (Task 5), cheerio.
- Produces: `export function grantYearUrls(nowISO: string): string[]`, `export function parseAwardTable(html: string, year: number, sourceUrl: string): RawOpportunity[]`, `export const ardcAwardTables: SourceModule`.

**Domain facts:** `ardc.net/apply/grants/{YYYY}-grants/` exists for **2019 through the current year**. Each page carries **one 4-column table: Date | Grantee | Project | Amount**. Some rows link to a `/grant-{slug}/` detail page, some do not. **2026 amounts are partly the literal string `TBD`** — preserve it verbatim, never coerce it to 0. Roughly 40–80 rows per year. These are **past awards, not opportunities**: they carry `recordType: 'past_award'`, and `normalize/` gives them `status: 'closed'` so they never appear as live deadlines. They exist because a funder's actual grant history is the single best evidence of what that funder funds.

- [ ] **Step 1: Write the fixture**

`fixtures/ardc-award-tables/pathological.html` — one year page with a linked row, an unlinked row, a `TBD` amount, and a footer table that must not be mistaken for the award table:

```html
<!DOCTYPE html><html><body>
<h1>2026 Grants</h1>
<table>
  <thead><tr><th>Date</th><th>Grantee</th><th>Project</th><th>Amount</th></tr></thead>
  <tbody>
    <tr><td>2026-04-02</td><td><a href="/apply/grants/grant-hamsci-psws-expansion/">HamSCI</a></td><td>Personal Space Weather Station expansion</td><td>$77,000</td></tr>
    <tr><td>2026-02-14</td><td>Kansas State University ARC</td><td>Campus station rebuild</td><td>$12,500</td></tr>
    <tr><td>2026-07-01</td><td>Open Research Institute</td><td>Open-source satellite modem</td><td>TBD</td></tr>
    <tr><td></td><td></td><td></td><td></td></tr>
  </tbody>
</table>
<table><tr><th>Footer</th></tr><tr><td>Contact us</td></tr></table>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/sources/ardc-award-tables.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
import { ardcAwardTables, grantYearUrls, parseAwardTable } from './ardc-award-tables.js';

const URL_2026 = 'https://www.ardc.net/apply/grants/2026-grants/';
const html = () => loadFixture('ardc-award-tables', 'pathological.html');

describe('grantYearUrls', () => {
  it('covers 2019 through the current year inclusive', () => {
    const urls = grantYearUrls('2026-08-02T00:00:00.000Z');
    expect(urls).toHaveLength(8);
    expect(urls[0]).toBe('https://www.ardc.net/apply/grants/2019-grants/');
    expect(urls[7]).toBe(URL_2026);
  });

  it('grows automatically with the calendar — no annual code change', () => {
    expect(grantYearUrls('2031-01-01T00:00:00.000Z')).toHaveLength(13);
  });
});

describe('parseAwardTable', () => {
  const rows = () => parseAwardTable(html(), 2026, URL_2026);

  it('reads only the 4-column award table and skips the footer table', () => {
    expect(rows()).toHaveLength(3);
    expect(rows().map((r) => r.rawFields.grantee)).not.toContain('Contact us');
  });

  it('skips empty rows', () => {
    for (const r of rows()) expect(r.rawFields.grantee).not.toBe('');
  });

  it('captures date, grantee, project and amount verbatim', () => {
    const hamsci = rows()[0];
    expect(hamsci.rawFields.date).toBe('2026-04-02');
    expect(hamsci.rawFields.grantee).toBe('HamSCI');
    expect(hamsci.rawFields.project).toBe('Personal Space Weather Station expansion');
    expect(hamsci.rawFields.amountRaw).toBe('$77,000');
    expect(hamsci.rawFields.year).toBe('2026');
  });

  it('preserves the literal string TBD instead of coercing it to a number', () => {
    const ori = rows().find((r) => r.rawFields.grantee === 'Open Research Institute');
    expect(ori?.rawFields.amountRaw).toBe('TBD');
  });

  it('resolves a relative detail link to an absolute URL, and tolerates rows with no link', () => {
    expect(rows()[0].rawFields.detailUrl).toBe(
      'https://www.ardc.net/apply/grants/grant-hamsci-psws-expansion/',
    );
    expect(rows()[1].rawFields.detailUrl).toBeUndefined();
  });

  it('marks every row as a past award so it never shows up as a live deadline', () => {
    for (const r of rows()) expect(r.rawFields.recordType).toBe('past_award');
  });

  it('builds a stable externalKey from year, grantee and project', () => {
    expect(rows()[0].externalKey).toBe('2026|HamSCI|Personal Space Weather Station expansion');
  });
});

describe('ardcAwardTables source module', () => {
  it('is Tier C with an expectedMinRecords tuned to eight years of tables', () => {
    expect(ardcAwardTables.tier).toBe('C');
    expect(ardcAwardTables.expectedMinRecords).toBe(40);
  });

  it('resolves its requests lazily from the current date', async () => {
    const requests = typeof ardcAwardTables.requests === 'function'
      ? await ardcAwardTables.requests()
      : ardcAwardTables.requests;
    expect(requests.length).toBeGreaterThanOrEqual(8);
    expect(requests[0].accept).toBe('html');
  });

  it('parses every year payload it is given', () => {
    const raws = ardcAwardTables.parse([
      fixturePayload('ardc-award-tables', 'pathological.html', URL_2026),
      fixturePayload('ardc-award-tables', 'pathological.html', 'https://www.ardc.net/apply/grants/2025-grants/'),
    ]);
    expect(raws).toHaveLength(6);
    expect(raws.filter((r) => r.rawFields.year === '2025')).toHaveLength(3);
  });

  it('ignores a 404 year page instead of failing the whole source', () => {
    const missing = {
      url: 'https://www.ardc.net/apply/grants/2019-grants/',
      status: 404,
      contentType: 'text/html',
      body: '<h1>Not found</h1>',
      fetchedAt: '2026-08-02T00:00:00.000Z',
    };
    expect(ardcAwardTables.parse([missing])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/ardc-award-tables.test.ts
```

Expected failure: `Failed to resolve import "./ardc-award-tables.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/sources/ardc-award-tables.ts`:

```ts
import * as cheerio from 'cheerio';
import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';

const SOURCE_ID = 'ardc-award-tables';
const FIRST_YEAR = 2019;

export function grantYearUrls(nowISO: string): string[] {
  const currentYear = new Date(nowISO).getUTCFullYear();
  const urls: string[] = [];
  for (let year = FIRST_YEAR; year <= currentYear; year += 1) {
    urls.push(`https://www.ardc.net/apply/grants/${year}-grants/`);
  }
  return urls;
}

const YEAR_FROM_URL = /\/(\d{4})-grants\/?$/;

/**
 * One 4-column table per year: Date | Grantee | Project | Amount. Some rows link to a
 * /grant-{slug}/ detail page, some do not. 2026 amounts are partly the literal string "TBD" —
 * kept verbatim, never coerced to a number.
 */
export function parseAwardTable(html: string, year: number, sourceUrl: string): RawOpportunity[] {
  const $ = cheerio.load(html);
  const out: RawOpportunity[] = [];

  $('table').each((_, table) => {
    const rows = $(table).find('tr');
    // Only the award table has four cells per row.
    const isAwardTable = rows.toArray().some((tr) => $(tr).find('td, th').length === 4);
    if (!isAwardTable) return;

    rows.each((__, tr) => {
      const cells = $(tr).find('td');
      if (cells.length !== 4) return; // skips the header row, which uses <th>
      const date = $(cells[0]).text().trim();
      const grantee = $(cells[1]).text().trim();
      const project = $(cells[2]).text().trim();
      const amountRaw = $(cells[3]).text().trim();
      if (grantee === '' && project === '') return;

      const href = $(cells[1]).find('a').attr('href');
      const rawFields: Record<string, string> = {
        recordType: 'past_award',
        year: String(year),
        date,
        grantee,
        project,
        amountRaw,
      };
      if (href) rawFields.detailUrl = new URL(href, sourceUrl).toString();

      out.push({
        sourceId: SOURCE_ID,
        externalKey: `${year}|${grantee}|${project}`,
        name: `${grantee} — ${project} (${year})`,
        rawFields,
        sourceUrl,
        rawText: [date, grantee, project, amountRaw].filter(Boolean).join(' | '),
      });
    });
  });

  return out;
}

export const ardcAwardTables: SourceModule = {
  id: SOURCE_ID,
  funderId: 'ardc',
  label: 'ARDC per-year award tables',
  tier: 'C',
  klass: 'ham_grant',
  requests: (): Promise<FetchRequest[]> =>
    Promise.resolve(
      grantYearUrls(new Date().toISOString()).map((url) => ({
        url,
        method: 'GET' as const,
        accept: 'html' as const,
      })),
    ),
  expectedMinRecords: 40,
  notes:
    'Past awards, not opportunities: every record carries recordType=past_award and normalize/ ' +
    'gives it status=closed, so it never appears as a live deadline. Eight-plus years of ' +
    '4-column tables (Date | Grantee | Project | Amount) at /apply/grants/{YYYY}-grants/. ' +
    'Some rows link to a /grant-{slug}/ detail page, some do not. 2026 amounts are partly the ' +
    'literal string "TBD" and are kept verbatim. A funder’s actual grant history is the best ' +
    'available evidence of what that funder funds.',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const out: RawOpportunity[] = [];
    for (const payload of payloads) {
      if (payload.status !== 200) continue;
      const m = YEAR_FROM_URL.exec(new URL(payload.url).pathname);
      if (!m) continue;
      out.push(...parseAwardTable(payload.body, Number.parseInt(m[1], 10), payload.url));
    }
    return out;
  },
};
```

Register in `registry.ts`.

- [ ] **Step 5: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/ && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/ardc-award-tables.ts packages/server/src/sources/ardc-award-tables.test.ts \
  packages/server/src/sources/registry.ts fixtures/ardc-award-tables
git commit -m "feat(sources): ARDC per-year award tables with verbatim TBD amounts"
```

---

### Task 11: RSS — `arrl-news-rss` (the key change signal) and the three NSF feeds

**Files:**
- Create: `packages/server/src/sources/util/rss.ts`
- Create: `packages/server/src/sources/arrl-news-rss.ts`
- Create: `packages/server/src/federal/nsf.ts`
- Create: `packages/server/src/sources/nsf-funding-rss.ts`
- Create: `fixtures/arrl-news-rss/pathological.xml`
- Create: `fixtures/nsf-funding-rss/pathological.xml`
- Test: `packages/server/src/sources/util/rss.test.ts`
- Test: `packages/server/src/sources/arrl-news-rss.test.ts`
- Test: `packages/server/src/federal/nsf.test.ts`
- Modify: `packages/server/src/sources/registry.ts`

**Interfaces:**
- Consumes: `flattenHtml` (Task 5); `SignalSource` (Task 6).
- Produces:
  ```ts
  // util/rss.ts
  export interface RssItem { title: string; link: string; guid: string; description: string; pubDate: string }
  export function parseRssItems(xml: string): RssItem[];
  // sources/arrl-news-rss.ts
  export const GRANT_SIGNAL_PATTERNS: readonly RegExp[];
  export function isGrantRelevantText(text: string): boolean;
  export const arrlNewsRss: SignalSource;
  // federal/nsf.ts
  export const NSF_FEED_URLS: readonly string[];
  export interface NsfItem extends RssItem { feedUrl: string }
  export function parseNsfFeed(xml: string, feedUrl: string): NsfItem[];
  // sources/nsf-funding-rss.ts
  export const nsfFundingRss: SourceModule;
  ```

**Why `arrl-news-rss` is a `SignalSource` and not an opportunity source.** `http://www.arrl.org/news/rss` returns real `application/rss+xml` and is **the single most important change signal in the ham space** — roughly 10–20 actionable deadline events a year, and it is also the only practical way to hear about **Yasme Foundation** announcements, because `yasme.org` 301s `/feed/` and `/wp-json/` to a 403 page for non-browser clients and we will not spoof a browser to get around a deliberate access policy. It carries **zero structured opportunities**, so it emits `ChangeEvent`s for a human to read and never a candidate `Program`. `parse()` returns **every** item (so `expectedMinRecords: 5` catches a broken feed), and the runner filters with `isRelevant`.

**The NSF feed URL that everyone gets wrong.** The third feed is `https://www.nsf.gov/rss/rss_www_funding-upcoming/rss.xml` — **hyphen in `funding-upcoming`, and a `/rss.xml` path segment**. The URL NSF publishes 301-chains twice before landing here. A test asserts the literal string so nobody "fixes" it back.

- [ ] **Step 1: Write the fixtures**

`fixtures/arrl-news-rss/pathological.xml` — includes a grant item, a Yasme relay, an irrelevant contest item, and a CDATA description:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>ARRL News</title>
  <link>http://www.arrl.org/news</link>
  <item>
    <title>ARRL Foundation Scholarship Applications Open October 30</title>
    <link>http://www.arrl.org/news/scholarship-applications-open</link>
    <guid isPermaLink="false">arrl-news-88121</guid>
    <description><![CDATA[<p>Applications close <strong>December 30</strong> at 12:00 PM EST.</p>]]></description>
    <pubDate>Mon, 27 Oct 2026 14:00:00 -0400</pubDate>
  </item>
  <item>
    <title>Yasme Foundation Announces Supporting Grants</title>
    <link>http://www.arrl.org/news/yasme-supporting-grants</link>
    <guid isPermaLink="false">arrl-news-88099</guid>
    <description>The Yasme Foundation has announced supporting grants to youth programs.</description>
    <pubDate>Tue, 14 Jul 2026 09:30:00 -0400</pubDate>
  </item>
  <item>
    <title>November Sweepstakes Results Posted</title>
    <link>http://www.arrl.org/news/sweepstakes-results</link>
    <guid isPermaLink="false">arrl-news-88010</guid>
    <description>Full results are now available in the contest database.</description>
    <pubDate>Fri, 06 Feb 2026 08:00:00 -0500</pubDate>
  </item>
  <item>
    <title>Club Grant Program Deadline Extended</title>
    <link>http://www.arrl.org/news/club-grant-deadline</link>
    <description>The application window has been extended.</description>
    <pubDate>Wed, 15 Apr 2026 12:00:00 -0400</pubDate>
  </item>
</channel></rss>
```

`fixtures/nsf-funding-rss/pathological.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>NSF Upcoming Funding Opportunities</title>
  <item>
    <title>Advanced Technological Education (ATE)</title>
    <link>https://www.nsf.gov/funding/opportunities/ate</link>
    <guid>https://www.nsf.gov/funding/opportunities/ate</guid>
    <description>Supports two-year college technician education programs.</description>
    <pubDate>Tue, 21 Jul 2026 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Geospace Facilities</title>
    <link>https://www.nsf.gov/funding/opportunities/geospace-facilities</link>
    <guid>https://www.nsf.gov/funding/opportunities/geospace-facilities</guid>
    <description>Ionospheric and space weather observing facilities.</description>
    <pubDate>Mon, 06 Jul 2026 00:00:00 GMT</pubDate>
  </item>
</channel></rss>
```

- [ ] **Step 2: Write the failing tests**

Create `packages/server/src/sources/util/rss.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../../test/fixtures.js';
import { parseRssItems } from './rss.js';

const xml = () => loadFixture('arrl-news-rss', 'pathological.xml');

describe('parseRssItems', () => {
  it('reads every item in document order', () => {
    const items = parseRssItems(xml());
    expect(items).toHaveLength(4);
    expect(items[0].title).toBe('ARRL Foundation Scholarship Applications Open October 30');
  });

  it('unwraps CDATA and strips HTML out of the description', () => {
    const items = parseRssItems(xml());
    expect(items[0].description).toBe('Applications close December 30 at 12:00 PM EST.');
  });

  it('falls back to the link when an item has no guid', () => {
    const items = parseRssItems(xml());
    expect(items[3].guid).toBe('http://www.arrl.org/news/club-grant-deadline');
  });

  it('keeps pubDate verbatim', () => {
    expect(parseRssItems(xml())[0].pubDate).toBe('Mon, 27 Oct 2026 14:00:00 -0400');
  });

  it('returns [] for an HTML page masquerading as a feed', () => {
    expect(parseRssItems('<!DOCTYPE html><html><body><div id="root"></div></body></html>')).toEqual(
      [],
    );
  });

  it('returns [] for empty or malformed input', () => {
    expect(parseRssItems('')).toEqual([]);
    expect(parseRssItems('<rss><channel>')).toEqual([]);
  });
});
```

Create `packages/server/src/sources/arrl-news-rss.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { arrlNewsRss, isGrantRelevantText } from './arrl-news-rss.js';

const FEED = 'http://www.arrl.org/news/rss';
const payload = () => fixturePayload('arrl-news-rss', 'pathological.xml', FEED);

describe('isGrantRelevantText', () => {
  it('matches grant, scholarship, deadline, funding and award language', () => {
    expect(isGrantRelevantText('Club Grant Program Deadline Extended')).toBe(true);
    expect(isGrantRelevantText('Scholarship applications open')).toBe(true);
    expect(isGrantRelevantText('Yasme Foundation announces supporting grants')).toBe(true);
    expect(isGrantRelevantText('ARDC funding for the Teachers Institute')).toBe(true);
  });

  it('does not match ordinary club news', () => {
    expect(isGrantRelevantText('November Sweepstakes Results Posted')).toBe(false);
    expect(isGrantRelevantText('Field Day logs are due')).toBe(false);
  });
});

describe('arrlNewsRss', () => {
  it('is a signal-only Tier B source', () => {
    expect(arrlNewsRss.signalOnly).toBe(true);
    expect(arrlNewsRss.tier).toBe('B');
    expect(arrlNewsRss.expectedMinRecords).toBe(5);
  });

  it('parses EVERY item so a broken feed trips the yield alarm', () => {
    expect(arrlNewsRss.parse([payload()])).toHaveLength(4);
  });

  it('uses the guid as externalKey so an item is never re-signalled', () => {
    const raws = arrlNewsRss.parse([payload()]);
    expect(raws[0].externalKey).toBe('arrl-news-88121');
    expect(new Set(raws.map((r) => r.externalKey)).size).toBe(4);
  });

  it('marks the grant, Yasme and deadline items relevant and the contest item not', () => {
    const raws = arrlNewsRss.parse([payload()]);
    expect(raws.filter((r) => arrlNewsRss.isRelevant(r)).map((r) => r.name)).toEqual([
      'ARRL Foundation Scholarship Applications Open October 30',
      'Yasme Foundation Announces Supporting Grants',
      'Club Grant Program Deadline Extended',
    ]);
  });

  it('explains in notes why this feed carries Yasme', () => {
    expect(arrlNewsRss.notes).toMatch(/Yasme/);
    expect(arrlNewsRss.notes).toMatch(/403/);
  });

  it('returns [] when the feed serves HTML instead of XML', () => {
    expect(
      arrlNewsRss.parse([
        { url: FEED, status: 200, contentType: 'text/html', body: '<html></html>', fetchedAt: '2026-08-02T00:00:00.000Z' },
      ]),
    ).toEqual([]);
  });
});
```

Create `packages/server/src/federal/nsf.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/fixtures.js';
import { NSF_FEED_URLS, parseNsfFeed } from './nsf.js';

describe('NSF_FEED_URLS', () => {
  it('lists exactly the three working NSF funding feeds', () => {
    expect(NSF_FEED_URLS).toHaveLength(3);
  });

  it('pins the upcoming feed to the hyphen + /rss.xml form — the published URL 301-chains twice', () => {
    expect(NSF_FEED_URLS).toContain('https://www.nsf.gov/rss/rss_www_funding-upcoming/rss.xml');
    for (const url of NSF_FEED_URLS) expect(url.startsWith('https://www.nsf.gov/rss/')).toBe(true);
  });
});

describe('parseNsfFeed', () => {
  it('stamps every item with the feed it came from', () => {
    const items = parseNsfFeed(
      loadFixture('nsf-funding-rss', 'pathological.xml'),
      NSF_FEED_URLS[0],
    );
    expect(items).toHaveLength(2);
    expect(items[0].feedUrl).toBe(NSF_FEED_URLS[0]);
    expect(items[0].title).toBe('Advanced Technological Education (ATE)');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/util/rss.test.ts packages/server/src/sources/arrl-news-rss.test.ts packages/server/src/federal/nsf.test.ts
```

Expected failure: `Failed to resolve import "./rss.js"`, `"./arrl-news-rss.js"`, `"./nsf.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/sources/util/rss.ts`:

```ts
import * as cheerio from 'cheerio';
import { flattenHtml } from './text.js';

export interface RssItem {
  title: string;
  link: string;
  guid: string;
  description: string;
  pubDate: string;
}

export function parseRssItems(xml: string): RssItem[] {
  if (!/<\s*(rss|feed|channel)\b/i.test(xml)) return [];
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: RssItem[] = [];
  $('item').each((_, el) => {
    const $el = $(el);
    const title = flattenHtml($el.find('title').first().text());
    const link = $el.find('link').first().text().trim();
    const guid = $el.find('guid').first().text().trim() || link;
    const description = flattenHtml($el.find('description').first().text());
    const pubDate = $el.find('pubDate').first().text().trim();
    if (title === '' && link === '') return;
    items.push({ title, link, guid, description, pubDate });
  });
  return items;
}
```

Create `packages/server/src/sources/arrl-news-rss.ts`:

```ts
import type { FetchedPayload, RawOpportunity } from '@grantspotter/core';
import type { SignalSource } from './types.js';
import { parseRssItems } from './util/rss.js';

const SOURCE_ID = 'arrl-news-rss';
const FEED = 'http://www.arrl.org/news/rss';

export const GRANT_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\bgrants?\b/i,
  /\bscholarships?\b/i,
  /\bdeadlines?\b/i,
  /\bfunding\b/i,
  /\bapplications?\s+(?:open|close|due|period|window)\b/i,
  /\bawards?\s+(?:announced|recipients)\b/i,
  /\bARDC\b/,
  /\bYasme\b/i,
  /\bTeachers Institute\b/i,
];

export function isGrantRelevantText(text: string): boolean {
  return GRANT_SIGNAL_PATTERNS.some((re) => re.test(text));
}

export const arrlNewsRss: SignalSource = {
  id: SOURCE_ID,
  funderId: 'arrl',
  label: 'ARRL news RSS (change signal)',
  tier: 'B',
  klass: 'ham_grant',
  signalOnly: true,
  requests: [{ url: FEED, method: 'GET', accept: 'xml' }],
  expectedMinRecords: 5,
  notes:
    'The single most important change signal in the ham space: ~10-20 actionable deadline ' +
    'events a year, and the only practical way to hear Yasme Foundation announcements, ' +
    'because yasme.org 301s /feed/ and /wp-json/ to a 403 page for non-browser clients and we ' +
    'do not spoof a browser to defeat a deliberate access policy. Carries ZERO structured ' +
    'opportunities, so it is signalOnly: the runner emits ChangeEvents for a human and never ' +
    'a candidate Program. parse() returns EVERY item so expectedMinRecords catches a broken ' +
    'feed; relevance filtering happens afterwards via isRelevant.',
  isRelevant(raw: RawOpportunity): boolean {
    return isGrantRelevantText(`${raw.name}\n${raw.rawText}`);
  },
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const payload = payloads.find((p) => p.url.includes('/news/rss') && p.status === 200);
    if (!payload) return [];
    return parseRssItems(payload.body).map((item) => ({
      sourceId: SOURCE_ID,
      externalKey: item.guid,
      name: item.title,
      rawFields: { link: item.link, pubDate: item.pubDate, description: item.description },
      sourceUrl: item.link || FEED,
      rawText: [item.title, item.description].filter(Boolean).join('\n'),
    }));
  },
};
```

Create `packages/server/src/federal/nsf.ts`:

```ts
import { type RssItem, parseRssItems } from '../sources/util/rss.js';

/**
 * The only working .gov funding RSS found in the whole research pass.
 *
 * The third URL is deliberately the hyphenated `funding-upcoming` form WITH a `/rss.xml` path
 * segment. The URL NSF publishes 301-chains twice before landing here; pointing at the
 * published form costs two redirects on every poll and breaks the moment the chain changes.
 * Do not "fix" it.
 */
export const NSF_FEED_URLS: readonly string[] = Object.freeze([
  'https://www.nsf.gov/rss/rss_www_funding.xml',
  'https://www.nsf.gov/rss/rss_www_funding_pgm_annc_inf.xml',
  'https://www.nsf.gov/rss/rss_www_funding-upcoming/rss.xml',
]);

export interface NsfItem extends RssItem {
  feedUrl: string;
}

export function parseNsfFeed(xml: string, feedUrl: string): NsfItem[] {
  return parseRssItems(xml).map((item) => ({ ...item, feedUrl }));
}
```

Create `packages/server/src/sources/nsf-funding-rss.ts`:

```ts
import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { NSF_FEED_URLS, parseNsfFeed } from '../federal/nsf.js';

const SOURCE_ID = 'nsf-funding-rss';

export const nsfFundingRss: SourceModule = {
  id: SOURCE_ID,
  funderId: 'nsf',
  label: 'NSF funding RSS (3 feeds)',
  tier: 'B',
  klass: 'adjacent_stem',
  requests: NSF_FEED_URLS.map((url) => ({ url, method: 'GET' as const, accept: 'xml' as const })),
  expectedMinRecords: 10,
  notes:
    'The only working .gov funding RSS. The upcoming feed is pinned to the hyphenated ' +
    'funding-upcoming/rss.xml form because the published URL 301-chains twice. Items are ' +
    'scored by federal/adjacency.ts before they reach the review queue — the genuinely ' +
    'winnable federal money is adjacent (geospace, ECCS, ATE, Noyce), not "amateur radio".',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const out: RawOpportunity[] = [];
    for (const payload of payloads) {
      if (payload.status !== 200) continue;
      if (!NSF_FEED_URLS.some((url) => payload.url === url)) continue;
      for (const item of parseNsfFeed(payload.body, payload.url)) {
        out.push({
          sourceId: SOURCE_ID,
          externalKey: item.guid || item.link,
          name: item.title,
          rawFields: { link: item.link, pubDate: item.pubDate, feedUrl: item.feedUrl },
          sourceUrl: item.link,
          rawText: [item.title, item.description].filter(Boolean).join('\n'),
        });
      }
    }
    return out;
  },
};
```

Register `arrlNewsRss` and `nsfFundingRss` in `registry.ts`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/ && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/util/rss.ts packages/server/src/sources/util/rss.test.ts \
  packages/server/src/sources/arrl-news-rss.ts packages/server/src/sources/arrl-news-rss.test.ts \
  packages/server/src/sources/nsf-funding-rss.ts packages/server/src/federal/nsf.ts \
  packages/server/src/federal/nsf.test.ts packages/server/src/sources/registry.ts \
  fixtures/arrl-news-rss fixtures/nsf-funding-rss
git commit -m "feat(sources): RSS parsing, ARRL news change signal and the three NSF funding feeds"
```

---

### Task 12: Tier C group A — QCWA, YLRL, Austin ARC, SARA

**Files:**
- Create: `packages/server/src/sources/tier-c-a.ts`
- Create: `fixtures/qcwa/pathological.html`, `fixtures/ylrl/pathological.html`, `fixtures/austin-arc/pathological.html`, `fixtures/austin-arc/empty-window.html`, `fixtures/sara/pathological.html`
- Test: `packages/server/src/sources/tier-c-a.test.ts`
- Modify: `packages/server/src/sources/registry.ts`

**Interfaces:**
- Consumes: `makeSinglePageSource`, `SinglePageConfig` (Task 8); `flattenHtml` (Task 5).
- Produces: `export function parseYlrlScholarships(flatText: string, sourceUrl: string): RawOpportunity[]`, `export const qcwa`, `export const ylrl`, `export const austinArc`, `export const sara`, `export const TIER_C_A_SOURCES: SourceModule[]`.

**Per-source table.** All four are `SinglePageConfig` rows except YLRL, which needs an `extraParse` because one page carries three distinct scholarships.

| `id` | URL | Field patterns over flattened text | Required | EMR | Fixture | Domain note |
|---|---|---|---|---|---|---|
| `qcwa` | `https://www.qcwa.org/scholarship-program.htm` | `amount`: `/(\$3,000)/` · `sponsor`: `/(sponsored by an active QCWA member[^.]*\.)/i` · `deadlineNote`: `/(before the first week of January[^.]*\.)/i` · `applyNote`: `/(ARRL[^.]*(?:portal|application)[^.]*\.)/i` | `amount` | 1 | `pathological.html` | Static `.htm`. $3,000 each; 2024: 15 awards / $57,000; 624+ students / $930,350+ since 1978. **Intake is ARRL's portal, not QCWA's** — the deadline is *inherited* from `arrl-scholarship-program`, and a sponsoring active QCWA member is a hard requirement. QCWA's page still points at farweb.org for one historical fund; that link is refused inside the fetcher. |
| `ylrl` | `https://ylrl.net/Scholarships/` | `eligibility`: `/(licensed[^.]*(?:women|female|YL)[^.]*\.)/i` | `eligibility` | 3 | `pathological.html` | **Female licensed hams only** — the only gender-scoped record in the corpus and the reason `ConstraintAxis` has a `gender` axis at all. Three named scholarships on one page: Ethel Smith K4LMB ($2,500), Mary Lou Brown NM7N ($2,500), Marte Wessel K0EPE ($1,500, targets part-time students working full-time). Non-US applicants eligible; YLRL membership is a preference, not a bar. |
| `austin-arc` | `https://austinhams.org/scholarships/` | `window`: `/(May\s*1[^.]*?Jul(?:y)?\s*31)/i` · `counties`: `/((?:Travis|Williamson|Hays|Bastrop|Caldwell|Burnet|Blanco)[^.]*\.)/i` | none | **0** | `pathological.html`, `empty-window.html` | **`expectedMinRecords` is deliberately 0.** `grants.austinhams.org` legitimately shows "No opportunities available" between **Aug 1 and Apr 30** — an empty scrape here is the correct answer for eight months of the year, not a failure. Window is May 1 – Jul 31; search engines still show a stale "March 25, 2026" that contradicts the live page. Central Texas, seven named counties. Amounts unpublished since the site rebuild. The self-hosted portal has no public JSON (`/api*` probes return 404). |
| `sara` | `https://www.radio-astronomy.org/grants` | `amount`: `/(\$200[^.]*\.)/ i` · `audience`: `/((?:5th grade|fifth grade)[^.]*college[^.]*\.)/i` · `applyNote`: `/(grants@radio-astronomy\.org)/i` | `audience` | 1 | `pathological.html` | Society of Amateur Radio Astronomers. Students **5th grade through college** plus teachers, **international**. Typically **≤$200** ("or more with committee approval"), one $500 outlier; often kits (Radio JOVE, SuperSID) rather than cash, so `instrument: in_kind_equipment`. **Rolling — no deadline appears anywhere on the page**, so `DeadlineKind: 'rolling'`. Apply by emailing a Word/PDF form to `grants@radio-astronomy.org`. |

- [ ] **Step 1: Write the fixtures**

`fixtures/qcwa/pathological.html`:

```html
<!DOCTYPE html><html><body><h1>QCWA Memorial Scholarship Fund</h1>
<p>Each scholarship is $3,000.</p>
<p>The applicant must be sponsored by an active QCWA member in good standing.</p>
<p>Requests are accepted from October 31 and must reach ARRL before the first week of January.</p>
<p>Applications are submitted through the ARRL Foundation scholarship application, not to QCWA.</p>
<p>Historical funds were previously administered at the FAR website.</p>
</body></html>
```

`fixtures/ylrl/pathological.html`:

```html
<!DOCTYPE html><html><body><h1>YLRL Scholarships</h1>
<p>Open to licensed women amateur radio operators worldwide.</p>
<h2>Ethel Smith K4LMB Memorial Scholarship</h2><p>Award: $2,500.</p>
<h2>Mary Lou Brown NM7N Scholarship</h2><p>Award: $2,500.</p>
<h2>Marte Wessel K0EPE Scholarship</h2><p>Award: $1,500. For part-time students working full-time.</p>
</body></html>
```

`fixtures/austin-arc/pathological.html`:

```html
<!DOCTYPE html><html><body><h1>Scholarships</h1>
<p>Applications are accepted May 1 through July 31 each year.</p>
<p>Applicants must reside in Travis, Williamson, Hays, Bastrop, Caldwell, Burnet or Blanco county.</p>
</body></html>
```

`fixtures/austin-arc/empty-window.html`:

```html
<!DOCTYPE html><html><body><h1>Scholarships</h1>
<p>No opportunities available.</p>
</body></html>
```

`fixtures/sara/pathological.html`:

```html
<!DOCTYPE html><html><body><h1>Student and Teacher Project Grants</h1>
<p>Open to students from 5th grade through college, and to their teachers, worldwide.</p>
<p>Grants are typically $200 or less, or more with committee approval.</p>
<p>Email the completed form to grants@radio-astronomy.org.</p>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/sources/tier-c-a.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { TIER_C_A_SOURCES, austinArc, qcwa, sara, ylrl } from './tier-c-a.js';

describe('qcwa', () => {
  const raws = qcwa.parse([
    fixturePayload('qcwa', 'pathological.html', 'https://www.qcwa.org/scholarship-program.htm'),
  ]);

  it('captures the $3,000 award and the mandatory QCWA sponsor', () => {
    expect(raws[0].rawFields.amount).toBe('$3,000');
    expect(raws[0].rawFields.sponsor).toMatch(/active QCWA member/i);
  });

  it('captures that the intake is ARRL’s portal, not QCWA’s', () => {
    expect(raws[0].rawFields.applyNote).toMatch(/ARRL/);
    expect(raws[0].rawFields.deadlineNote).toMatch(/first week of January/i);
  });
});

describe('ylrl', () => {
  const raws = ylrl.parse([fixturePayload('ylrl', 'pathological.html', 'https://ylrl.net/Scholarships/')]);

  it('emits one record per named scholarship plus the page record', () => {
    const names = raws.map((r) => r.name);
    expect(names).toContain('Ethel Smith K4LMB Memorial Scholarship');
    expect(names).toContain('Mary Lou Brown NM7N Scholarship');
    expect(names).toContain('Marte Wessel K0EPE Scholarship');
    expect(raws.length).toBeGreaterThanOrEqual(3);
  });

  it('captures each award amount', () => {
    const wessel = raws.find((r) => r.name.includes('Wessel'));
    expect(wessel?.rawFields.amount).toBe('$1,500');
  });

  it('carries the female-only eligibility that drives the gender constraint axis', () => {
    expect(raws.some((r) => /women|female|YL/i.test(r.rawText))).toBe(true);
  });

  it('has expectedMinRecords 3, one per named scholarship', () => {
    expect(ylrl.expectedMinRecords).toBe(3);
  });
});

describe('austin-arc', () => {
  const url = 'https://austinhams.org/scholarships/';

  it('captures the May 1 - Jul 31 window and the seven Central Texas counties', () => {
    const raws = austinArc.parse([fixturePayload('austin-arc', 'pathological.html', url)]);
    expect(raws[0].rawFields.window).toMatch(/May 1 through July 31/i);
    expect(raws[0].rawFields.counties).toMatch(/Travis/);
  });

  it('has expectedMinRecords 0 — an empty scrape here is CORRECT for eight months a year', () => {
    expect(austinArc.expectedMinRecords).toBe(0);
    expect(austinArc.notes).toMatch(/No opportunities available/i);
    expect(austinArc.notes).toMatch(/Aug(?:ust)? 1/);
  });

  it('returns [] on the closed-window page without throwing', () => {
    expect(austinArc.parse([fixturePayload('austin-arc', 'empty-window.html', url)])).toEqual([]);
  });
});

describe('sara', () => {
  const raws = sara.parse([
    fixturePayload('sara', 'pathological.html', 'https://www.radio-astronomy.org/grants'),
  ]);

  it('captures the 5th-grade-through-college audience and the email intake', () => {
    expect(raws[0].rawFields.audience).toMatch(/5th grade/i);
    expect(raws[0].rawFields.applyNote).toBe('grants@radio-astronomy.org');
  });

  it('records that there is no deadline anywhere on the page', () => {
    expect(sara.notes).toMatch(/rolling/i);
    expect(raws[0].rawFields.window).toBeUndefined();
  });
});

describe('the group', () => {
  it('exports all four modules with unique ids', () => {
    expect(TIER_C_A_SOURCES.map((m) => m.id).sort()).toEqual([
      'austin-arc',
      'qcwa',
      'sara',
      'ylrl',
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/tier-c-a.test.ts
```

Expected failure: `Failed to resolve import "./tier-c-a.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/sources/tier-c-a.ts`:

```ts
import type { RawOpportunity, SourceModule } from '@grantspotter/core';
import { type SinglePageConfig, makeSinglePageSource } from './util/singlePage.js';

const YLRL_HEADING =
  /^((?:Ethel Smith|Mary Lou Brown|Marte Wessel)[^\n]*Scholarship)$/gim;

/** One YLRL page carries three distinct named scholarships; each becomes its own record. */
export function parseYlrlScholarships(flatText: string, sourceUrl: string): RawOpportunity[] {
  const out: RawOpportunity[] = [];
  const lines = flatText.split('\n');
  lines.forEach((line, i) => {
    YLRL_HEADING.lastIndex = 0;
    if (!YLRL_HEADING.test(line.trim())) return;
    const body = lines.slice(i + 1, i + 4).join('\n');
    const amount = /\$[\d,]+/.exec(body)?.[0];
    const rawFields: Record<string, string> = { scope: 'named_scholarship' };
    if (amount) rawFields.amount = amount;
    out.push({
      sourceId: 'ylrl',
      externalKey: line.trim(),
      name: line.trim(),
      rawFields,
      sourceUrl,
      rawText: [line.trim(), body].join('\n').trim(),
    });
  });
  return out;
}

const CONFIGS: SinglePageConfig[] = [
  {
    id: 'qcwa',
    funderId: 'qcwa',
    label: 'QCWA Memorial Scholarship Fund',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://www.qcwa.org/scholarship-program.htm',
    name: 'QCWA Memorial Scholarship',
    externalKey: 'qcwa-memorial-scholarship',
    fieldPatterns: {
      amount: /(\$3,000)/,
      sponsor: /(sponsored by an active QCWA member[^.]*\.)/i,
      deadlineNote: /(before the first week of January[^.]*\.)/i,
      applyNote: /(ARRL[^.]*(?:portal|application|Foundation)[^.]*\.)/i,
    },
    requiredFields: ['amount'],
    expectedMinRecords: 1,
    notes:
      '$3,000 each; 2024: 15 awards / $57,000; 624+ students / $930,350+ since 1978. Intake is ' +
      'the ARRL Foundation portal, NOT QCWA — the deadline is INHERITED from ' +
      'arrl-scholarship-program. A sponsoring active QCWA member is a hard requirement. The ' +
      'page still references the FAR website for a historical fund; farweb.org is refused ' +
      'inside the fetcher because that domain now redirects to a gambling site.',
  },
  {
    id: 'ylrl',
    funderId: 'ylrl',
    label: 'Young Ladies Radio League scholarships',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://ylrl.net/Scholarships/',
    name: 'YLRL Scholarships',
    externalKey: 'ylrl-scholarships',
    fieldPatterns: { eligibility: /(licensed[^.]*(?:women|female|YL)[^.]*\.)/i },
    requiredFields: ['eligibility'],
    expectedMinRecords: 3,
    extraParse: (flat, _html, sourceUrl) => parseYlrlScholarships(flat, sourceUrl),
    notes:
      'Female licensed hams only — the ONLY gender-scoped record in the corpus, and the reason ' +
      'ConstraintAxis has a gender axis. Three named scholarships on one page: Ethel Smith ' +
      'K4LMB ($2,500), Mary Lou Brown NM7N ($2,500), Marte Wessel K0EPE ($1,500, aimed at ' +
      'part-time students working full-time). Non-US applicants eligible; YLRL membership is a ' +
      'preference, not a bar. One of only two verified non-ARRL US ham scholarship application ' +
      'paths.',
  },
  {
    id: 'austin-arc',
    funderId: 'austin-arc',
    label: 'Austin Amateur Radio Club scholarships',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://austinhams.org/scholarships/',
    name: 'Austin ARC Copeland and Greenwood Scholarships',
    externalKey: 'austin-arc-scholarships',
    fieldPatterns: {
      window: /(May\s*1[^.]*?Jul(?:y)?\s*31)/i,
      counties: /((?:Travis|Williamson|Hays|Bastrop|Caldwell|Burnet|Blanco)[^.]*\.)/i,
    },
    requiredFields: ['window'],
    expectedMinRecords: 0,
    notes:
      'expectedMinRecords is deliberately 0. grants.austinhams.org legitimately shows "No ' +
      'opportunities available" between August 1 and April 30 — an empty scrape here is the ' +
      'correct answer for eight months of the year, not a failure, and diff/ must not emit ' +
      'vanished events for it. Window is May 1 - Jul 31; search engines still show a stale ' +
      '"March 25, 2026" that contradicts the live page. Central Texas, seven named counties. ' +
      'Amounts unpublished since the site rebuild. The self-hosted portal exposes no public ' +
      'JSON — /api* probes return 404. Best verified example of a regional non-ARRL program.',
  },
  {
    id: 'sara',
    funderId: 'sara',
    label: 'SARA Student and Teacher Project Grants',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'https://www.radio-astronomy.org/grants',
    name: 'SARA Student and Teacher Project Grants',
    externalKey: 'sara-student-teacher-grants',
    fieldPatterns: {
      amount: /(\$200[^.]*\.)/i,
      audience: /((?:5th|fifth) grade[^.]*college[^.]*\.)/i,
      applyNote: /([\w.+-]+@radio-astronomy\.org)/i,
    },
    requiredFields: ['audience'],
    expectedMinRecords: 1,
    notes:
      'Society of Amateur Radio Astronomers. Students 5th grade through college plus teachers, ' +
      'international. Typically <= $200 ("or more with committee approval"), one $500 outlier; ' +
      'often kits (Radio JOVE, SuperSID) rather than cash, so the instrument is ' +
      'in_kind_equipment. ROLLING — no deadline appears anywhere on the page, so DeadlineKind ' +
      'is rolling, never a guessed date. Apply by emailing a Word/PDF form to the address on ' +
      'the page.',
  },
];

const [qcwaModule, ylrlModule, austinModule, saraModule] = CONFIGS.map(makeSinglePageSource);

export const qcwa = qcwaModule;
export const ylrl = ylrlModule;
export const austinArc = austinModule;
export const sara = saraModule;
export const TIER_C_A_SOURCES: SourceModule[] = [qcwa, ylrl, austinArc, sara];
```

Register `...TIER_C_A_SOURCES` in `registry.ts`.

- [ ] **Step 5: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/ && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/tier-c-a.ts packages/server/src/sources/tier-c-a.test.ts \
  packages/server/src/sources/registry.ts fixtures/qcwa fixtures/ylrl fixtures/austin-arc fixtures/sara
git commit -m "feat(sources): QCWA, YLRL, Austin ARC and SARA parsers"
```

---

### Task 13: Tier C group B — NCDXF ×2, ARISS, IEEE ×2, NASA CSLI

**Files:**
- Create: `packages/server/src/sources/tier-c-b.ts`
- Create: `fixtures/ncdxf-grants/pathological.html`, `fixtures/ncdxf-scholarships/pathological.html`, `fixtures/ariss/pathological.html`, `fixtures/ieee-mtts/pathological.html`, `fixtures/ieee-student-branch-rebate/pathological.html`, `fixtures/nasa-csli/pathological.html`
- Test: `packages/server/src/sources/tier-c-b.test.ts`
- Modify: `packages/server/src/sources/registry.ts`

**Interfaces:**
- Consumes: `makeSinglePageSource`, `SinglePageConfig` (Task 8); `parseDateRange` (Task 5).
- Produces: `export function parseArissWindow(flatText: string): { opensAt?: string; closesAt?: string } | undefined`, `export const ncdxfGrants`, `export const ncdxfScholarships`, `export const ariss`, `export const ieeeMtts`, `export const ieeeStudentBranchRebate`, `export const nasaCsli`, `export const TIER_C_B_SOURCES: SourceModule[]`.

**Per-source table.**

| `id` | URL | Field patterns over flattened text | Required | EMR | Domain note |
|---|---|---|---|---|---|
| `ncdxf-grants` | `https://www.ncdxf.org/pages/grant-app.html` | `audience`: `/(individuals? and groups[^.]*\.)/i` · `leadTime`: `/(two months[^.]*\.)/i` · `applyNote`: `/(treasurer[^.]*\.)/i` · `stake`: `/(financial stake[^.]*\.)/i` | `applyNote` | 1 | Northern California DX Foundation. **Rolling**, allow ~2 months lead. In practice DXpedition teams to top-100 DXCC entities — **not a collegiate program**, and the app should say so rather than implying eligibility. Amounts unpublished (~$1.2M total over ~48 years, so many small awards). Applicant must have a personal financial stake. Apply by emailing a downloadable form + budget spreadsheet to the treasurer. **`ncdxf.org` 403s both its `robots.txt` and its `sitemap.xml`** — Task 2's `robotsFromResponse` treats that 403 as "no rules published", which is what keeps this source alive. |
| `ncdxf-scholarships` | `https://www.ncdxf.org/pages/scholarships.html` | `age`: `/(25 (?:years )?or (?:younger|under)[^.]*\.)/i` · `benefit`: `/(tuition[^.]*\.)/i` | `benefit` | 1 | W6EEN Memorial Scholarship + Youth Grant. Licensed hams **≤25**, any class. Benefit is **full tuition at DX University / Contest University**, with no dollar figure — `instrument: 'tuition_coverage'`. **No published deadlines**; it tracks course schedules, so `DeadlineKind: 'unpublished'`. The Youth Grant page renders as nav + title only, with no terms at all — low-value polling target, kept for completeness. |
| `ariss` | `https://ariss-usa.org/proposal-overview/` | `window`: `/(proposal window[^.]*?\.)/i` | `window` | 1 | ARISS-USA arranges a scheduled **ISS crew contact** for a school — `instrument: 'in_kind_service'`, **no cash at all**. Four windows a year, **rewritten quarterly at a stable URL**, which makes it a genuinely good scrape target. Verified live: opened Jul 1, closes Sep 30, for Jan–Jun 2027 contacts. ⚠️ Eligibility says "US schools and educational organizations" — **colleges and universities are not explicitly named** and K-12 dominates; that ambiguity goes in `rawOtherText`, never resolved by guessing. |
| `ieee-mtts` | `https://mtt.org/chapter-support/` | `deadline`: `/(Oct(?:ober)?\s*1\b[^.]*\.)/i` · `amount`: `/(\$1,000[^.]*\.)/i` · `requirements`: `/((?:five|5) members[^.]*\.)/i` | `deadline` | 1 | IEEE Microwave Theory and Technology Society — the most RF-relevant IEEE money. **Oct 1** annual, stated inline. $1,000/yr single-society Student Branch Chapter, $500 joint; plus 10×$1,500 undergraduate scholarships and 3×$6,000 fellowships. Requires ≥5 members, a vTools officer roster, and ≥2 reported meetings. Jotform application. |
| `ieee-student-branch-rebate` | `https://students.ieee.org/topics/submit-your-student-branch-annual-plan/` | `deadline`: `/(15 March\|March 15)/i` | `deadline` | 1 | Annual Plan due **15 March**. `instrument: 'per_member_rebate'`: $50/yr under 50 members, $100/yr at 50+, plus $2/member and $1/chapter member. ⚠️ **The amounts page `mga.ieee.org/.../rebates` returns HTTP 418 to bots**, so the figures are search-snippet-sourced and the record ships with lower confidence. We do not spoof a browser to read it. |
| `nasa-csli` | `https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/` | `status`: `/((?:anticipates?\|expects?)[^.]*\d{4}[^.]*\.)/i` · `benefit`: `/(launch[^.]*services[^.]*\.)/i` | `benefit` | 1 | CubeSat Launch Initiative. **No cash** — launch and deployment services only; the team funds its own hardware. `instrument: 'in_kind_service'`. Historically an August release with a November due date, but the page currently says NASA "anticipates an update in spring 2026" — **no confirmed open window**, so `status: 'unknown'` is the honest rendered state. NSPIRES has no API/RSS/XML/JSON/CSV (session-stateful Struts/JSF `.do` app); **Grants.gov is the only machine route to NASA opportunities**. |

- [ ] **Step 1: Write the six fixtures**

```html
<!-- fixtures/ncdxf-grants/pathological.html -->
<!DOCTYPE html><html><body><h1>Grant Application</h1>
<p>NCDXF makes grants to individuals and groups advancing education and science through amateur radio.</p>
<p>Please allow approximately two months lead time before your planned activity.</p>
<p>Email the completed application and budget spreadsheet to the treasurer.</p>
<p>The applicant is expected to have a personal financial stake in the project.</p>
</body></html>
```

```html
<!-- fixtures/ncdxf-scholarships/pathological.html -->
<!DOCTYPE html><html><body><h1>Scholarships</h1>
<p>Open to licensed amateurs 25 or younger, any license class.</p>
<p>The award covers full tuition at DX University or Contest University.</p>
</body></html>
```

```html
<!-- fixtures/ariss/pathological.html -->
<!DOCTYPE html><html><body><h1>Proposal Overview</h1>
<p>The proposal window opened July 1, 2026 and closes September 30, 2026 for contacts scheduled
January through June 2027.</p>
<p>Proposals are accepted from US schools and educational organizations.</p>
</body></html>
```

```html
<!-- fixtures/ieee-mtts/pathological.html -->
<!DOCTYPE html><html><body><h1>Chapter Support</h1>
<p>Applications are due October 1 each year.</p>
<p>Single-society Student Branch Chapters may receive $1,000 per year; joint chapters $500.</p>
<p>Chapters must have at least five members, a current vTools officer roster, and at least two
reported meetings.</p>
</body></html>
```

```html
<!-- fixtures/ieee-student-branch-rebate/pathological.html -->
<!DOCTYPE html><html><body><h1>Submit Your Student Branch Annual Plan</h1>
<p>The Annual Plan is due 15 March.</p>
</body></html>
```

```html
<!-- fixtures/nasa-csli/pathological.html -->
<!DOCTYPE html><html><body><h1>CubeSat Launch Initiative</h1>
<p>CSLI provides launch and deployment services to US educational institutions and nonprofits.</p>
<p>NASA anticipates an update in spring 2026.</p>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/sources/tier-c-b.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import {
  TIER_C_B_SOURCES,
  ariss,
  ieeeMtts,
  ieeeStudentBranchRebate,
  nasaCsli,
  ncdxfGrants,
  ncdxfScholarships,
  parseArissWindow,
} from './tier-c-b.js';

describe('ncdxf-grants', () => {
  const raws = ncdxfGrants.parse([
    fixturePayload('ncdxf-grants', 'pathological.html', 'https://www.ncdxf.org/pages/grant-app.html'),
  ]);

  it('captures the rolling lead time, the email intake and the financial-stake rule', () => {
    expect(raws[0].rawFields.leadTime).toMatch(/two months/i);
    expect(raws[0].rawFields.applyNote).toMatch(/treasurer/i);
    expect(raws[0].rawFields.stake).toMatch(/financial stake/i);
  });

  it('records in notes that this is not a collegiate program', () => {
    expect(ncdxfGrants.notes).toMatch(/not a collegiate program/i);
    expect(ncdxfGrants.notes).toMatch(/403/);
  });
});

describe('ncdxf-scholarships', () => {
  it('captures the age cap and the tuition-coverage benefit', () => {
    const raws = ncdxfScholarships.parse([
      fixturePayload('ncdxf-scholarships', 'pathological.html', 'https://www.ncdxf.org/pages/scholarships.html'),
    ]);
    expect(raws[0].rawFields.age).toMatch(/25 or younger/i);
    expect(raws[0].rawFields.benefit).toMatch(/tuition/i);
  });
});

describe('parseArissWindow', () => {
  it('reads both ends of the quarterly-rewritten window sentence', () => {
    expect(parseArissWindow('The proposal window opened July 1, 2026 and closes September 30, 2026.')).toEqual({
      opensAt: '2026-07-01',
      closesAt: '2026-09-30',
    });
  });

  it('returns undefined rather than half a window', () => {
    expect(parseArissWindow('The proposal window will reopen soon.')).toBeUndefined();
  });
});

describe('ariss', () => {
  const raws = ariss.parse([
    fixturePayload('ariss', 'pathological.html', 'https://ariss-usa.org/proposal-overview/'),
  ]);

  it('captures the window sentence and the resolved dates', () => {
    expect(raws[0].rawFields.window).toMatch(/proposal window/i);
    expect(raws[0].rawFields.opensAt).toBe('2026-07-01');
    expect(raws[0].rawFields.closesAt).toBe('2026-09-30');
  });

  it('flags the unresolved college eligibility question rather than guessing', () => {
    expect(ariss.notes).toMatch(/not explicitly named/i);
  });
});

describe('ieee-mtts', () => {
  it('captures the Oct 1 deadline, the $1,000 amount and the chapter requirements', () => {
    const raws = ieeeMtts.parse([
      fixturePayload('ieee-mtts', 'pathological.html', 'https://mtt.org/chapter-support/'),
    ]);
    expect(raws[0].rawFields.deadline).toMatch(/October 1/);
    expect(raws[0].rawFields.amount).toContain('$1,000');
    expect(raws[0].rawFields.requirements).toMatch(/five members/i);
  });
});

describe('ieee-student-branch-rebate', () => {
  it('captures the 15 March annual-plan deadline', () => {
    const raws = ieeeStudentBranchRebate.parse([
      fixturePayload(
        'ieee-student-branch-rebate',
        'pathological.html',
        'https://students.ieee.org/topics/submit-your-student-branch-annual-plan/',
      ),
    ]);
    expect(raws[0].rawFields.deadline).toMatch(/15 March/i);
  });

  it('records the HTTP 418 amount-page caveat', () => {
    expect(ieeeStudentBranchRebate.notes).toMatch(/418/);
  });
});

describe('nasa-csli', () => {
  it('captures the in-kind launch benefit and the ambiguous status sentence', () => {
    const raws = nasaCsli.parse([
      fixturePayload(
        'nasa-csli',
        'pathological.html',
        'https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/',
      ),
    ]);
    expect(raws[0].rawFields.benefit).toMatch(/launch/i);
    expect(raws[0].rawFields.status).toMatch(/spring 2026/i);
  });

  it('records that NSPIRES has no machine route', () => {
    expect(nasaCsli.notes).toMatch(/NSPIRES/);
  });
});

describe('the group', () => {
  it('exports all six modules with unique ids', () => {
    expect(TIER_C_B_SOURCES.map((m) => m.id).sort()).toEqual([
      'ariss',
      'ieee-mtts',
      'ieee-student-branch-rebate',
      'nasa-csli',
      'ncdxf-grants',
      'ncdxf-scholarships',
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/tier-c-b.test.ts
```

Expected failure: `Failed to resolve import "./tier-c-b.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/sources/tier-c-b.ts`:

```ts
import type { RawOpportunity, SourceModule } from '@grantspotter/core';
import { parseDateRange } from './util/dates.js';
import { type SinglePageConfig, makeSinglePageSource } from './util/singlePage.js';

/** ARISS rewrites one window sentence quarterly at a stable URL. Both ends or nothing. */
export function parseArissWindow(
  flatText: string,
): { opensAt?: string; closesAt?: string } | undefined {
  const sentence = /proposal window[^.]*\./i.exec(flatText)?.[0];
  if (!sentence) return undefined;
  return parseDateRange(sentence);
}

const CONFIGS: SinglePageConfig[] = [
  {
    id: 'ncdxf-grants',
    funderId: 'ncdxf',
    label: 'NCDXF Grant Program',
    tier: 'C',
    klass: 'ham_grant',
    url: 'https://www.ncdxf.org/pages/grant-app.html',
    name: 'NCDXF Grant Program',
    externalKey: 'ncdxf-grant-program',
    fieldPatterns: {
      audience: /(individuals and groups[^.]*\.)/i,
      leadTime: /(two months[^.]*\.)/i,
      applyNote: /([^.]*treasurer[^.]*\.)/i,
      stake: /([^.]*financial stake[^.]*\.)/i,
    },
    requiredFields: ['applyNote'],
    expectedMinRecords: 1,
    notes:
      'Rolling, allow ~2 months lead. In practice DXpedition teams to top-100 DXCC entities — ' +
      'NOT a collegiate program, and the record says so rather than implying eligibility. ' +
      'Amounts unpublished (~$1.2M over ~48 years, so many small awards). Applicant must have ' +
      'a personal financial stake. Apply by emailing a form + budget spreadsheet to the ' +
      'treasurer. ncdxf.org 403s BOTH its robots.txt and its sitemap.xml; the fetcher treats a ' +
      '403 robots.txt as "no rules published", which is what keeps this source reachable ' +
      'without spoofing a browser.',
  },
  {
    id: 'ncdxf-scholarships',
    funderId: 'ncdxf',
    label: 'NCDXF W6EEN Memorial Scholarship and Youth Grant',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://www.ncdxf.org/pages/scholarships.html',
    name: 'NCDXF W6EEN Memorial Scholarship',
    externalKey: 'ncdxf-w6een-scholarship',
    fieldPatterns: {
      age: /(25 (?:years )?or (?:younger|under)[^.]*\.)/i,
      benefit: /([^.]*tuition[^.]*\.)/i,
    },
    requiredFields: ['benefit'],
    expectedMinRecords: 1,
    notes:
      'Licensed hams 25 or younger, any class. Benefit is full tuition at DX University or ' +
      'Contest University with no dollar figure, so the instrument is tuition_coverage. No ' +
      'published deadlines — it tracks course schedules, so DeadlineKind is unpublished. The ' +
      'companion Youth Grant page renders as nav + title only with no terms at all.',
  },
  {
    id: 'ariss',
    funderId: 'ariss-usa',
    label: 'ARISS-USA ISS Contact Proposals',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'https://ariss-usa.org/proposal-overview/',
    name: 'ARISS-USA ISS Contact Proposal',
    externalKey: 'ariss-iss-contact-proposal',
    fieldPatterns: { window: /(proposal window[^.]*\.)/i },
    requiredFields: ['window'],
    expectedMinRecords: 1,
    extraParse: (): RawOpportunity[] => [],
    notes:
      'No cash at all: a scheduled ISS crew contact plus technical mentoring, so the instrument ' +
      'is in_kind_service. Four windows a year, rewritten quarterly at a STABLE URL, which ' +
      'makes it one of the better scrape targets in the corpus. Eligibility reads "US schools ' +
      'and educational organizations" — colleges and universities are NOT explicitly named and ' +
      'K-12 dominates; that ambiguity is preserved in rawOtherText and never resolved by ' +
      'guessing.',
  },
  {
    id: 'ieee-mtts',
    funderId: 'ieee-mtts',
    label: 'IEEE MTT-S Chapter Support',
    tier: 'C',
    klass: 'adjacent_stem',
    url: 'https://mtt.org/chapter-support/',
    name: 'IEEE MTT-S Chapter Support',
    externalKey: 'ieee-mtts-chapter-support',
    fieldPatterns: {
      deadline: /(due October 1[^.]*\.)/i,
      amount: /([^.]*\$1,000[^.]*\.)/i,
      requirements: /([^.]*five members[^.]*\.)/i,
    },
    requiredFields: ['deadline'],
    expectedMinRecords: 1,
    notes:
      'The most RF-relevant IEEE money. Oct 1 annual, stated inline. $1,000/yr single-society ' +
      'Student Branch Chapter, $500 joint; plus 10 x $1,500 undergraduate scholarships and ' +
      '3 x $6,000 fellowships. Requires >= 5 members, a current vTools officer roster and >= 2 ' +
      'reported meetings. Jotform application.',
  },
  {
    id: 'ieee-student-branch-rebate',
    funderId: 'ieee',
    label: 'IEEE Student Branch Rebate',
    tier: 'C',
    klass: 'adjacent_stem',
    url: 'https://students.ieee.org/topics/submit-your-student-branch-annual-plan/',
    name: 'IEEE Student Branch Rebate',
    externalKey: 'ieee-student-branch-rebate',
    fieldPatterns: { deadline: /((?:15 March|March 15)[^.]*\.)/i },
    requiredFields: ['deadline'],
    expectedMinRecords: 1,
    notes:
      'Annual Plan due 15 March. Instrument is per_member_rebate: $50/yr under 50 members, ' +
      '$100/yr at 50+, plus $2/member and $1/chapter member. The amounts page ' +
      'mga.ieee.org/.../rebates returns HTTP 418 to bots, so those figures are ' +
      'search-snippet-sourced and the record ships with lower confidence. We do not spoof a ' +
      'browser to read it.',
  },
  {
    id: 'nasa-csli',
    funderId: 'nasa',
    label: 'NASA CubeSat Launch Initiative',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/',
    name: 'NASA CubeSat Launch Initiative (CSLI)',
    externalKey: 'nasa-csli',
    fieldPatterns: {
      status: /((?:anticipates?|expects?)[^.]*\d{4}[^.]*\.)/i,
      benefit: /([^.]*launch[^.]*services[^.]*\.)/i,
    },
    requiredFields: ['benefit'],
    expectedMinRecords: 1,
    notes:
      'No cash: launch and deployment services only; the team funds its own hardware, so the ' +
      'instrument is in_kind_service. Historically an August release with a November due date, ' +
      'but the page currently says NASA "anticipates an update in spring 2026" — there is NO ' +
      'confirmed open window, so status: unknown is the honest rendered state. NSPIRES has no ' +
      'API, RSS, XML, JSON or CSV (session-stateful Struts/JSF .do app); Grants.gov is the only ' +
      'machine route to NASA opportunities.',
  },
];

const modules = CONFIGS.map(makeSinglePageSource);

/** ARISS additionally resolves its window sentence into ISO dates for normalize/. */
function withArissDates(module: SourceModule): SourceModule {
  const inner = module.parse.bind(module);
  return {
    ...module,
    parse: (payloads) =>
      inner(payloads).map((raw) => {
        const range = parseArissWindow(raw.rawText);
        if (!range?.opensAt || !range.closesAt) return raw;
        return {
          ...raw,
          rawFields: { ...raw.rawFields, opensAt: range.opensAt, closesAt: range.closesAt },
        };
      }),
  };
}

export const ncdxfGrants = modules[0];
export const ncdxfScholarships = modules[1];
export const ariss = withArissDates(modules[2]);
export const ieeeMtts = modules[3];
export const ieeeStudentBranchRebate = modules[4];
export const nasaCsli = modules[5];

export const TIER_C_B_SOURCES: SourceModule[] = [
  ncdxfGrants,
  ncdxfScholarships,
  ariss,
  ieeeMtts,
  ieeeStudentBranchRebate,
  nasaCsli,
];
```

Register `...TIER_C_B_SOURCES` in `registry.ts`.

- [ ] **Step 5: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/ && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/tier-c-b.ts packages/server/src/sources/tier-c-b.test.ts \
  packages/server/src/sources/registry.ts fixtures/ncdxf-grants fixtures/ncdxf-scholarships \
  fixtures/ariss fixtures/ieee-mtts fixtures/ieee-student-branch-rebate fixtures/nasa-csli
git commit -m "feat(sources): NCDXF, ARISS, IEEE and NASA CSLI parsers"
```

---

### Task 14: `yaesu-dr2x` — window dates that exist only in a PDF filename

**Files:**
- Create: `packages/server/src/sources/yaesu-dr2x.ts`
- Create: `fixtures/yaesu-dr2x/pathological.html`
- Test: `packages/server/src/sources/yaesu-dr2x.test.ts`
- Modify: `packages/server/src/sources/registry.ts`

**Interfaces:**
- Consumes: `flattenHtml`, `parseDateRange` (Task 5); cheerio.
- Produces: `export interface Dr2xLink { href: string; text: string; uploadYear?: number; uploadMonth?: number }`, `export function findDr2xPdfLinks(html: string, baseUrl: string): Dr2xLink[]`, `export function windowFromPdfLink(link: Dr2xLink): { opensAt?: string; closesAt?: string } | undefined`, `export const yaesuDr2x: SourceModule`.

**The gotcha this task exists for.** `systemfusion.yaesu.com` publishes the System Fusion DR-2X repeater program as a **discounted purchase, not a grant** ($1,450 for the DR-2X, $1,860 with the LAN-01A), open to "clubs, groups, organizations or individuals in North America" — collegiate clubs qualify. Windows are ad-hoc, roughly 2–4 a year; the current one is **Jun 3 – Aug 31, 2026**.

**The window dates appear nowhere in the page body.** They exist only in the **title line of a dated fillable PDF** linked from the landing page, under `/wp-content/uploads/{YYYY}/{MM}/`. So: parse the landing page HTML for the PDF anchor, read the dates out of the anchor text and, failing that, out of the filename; use the `{YYYY}/{MM}` upload path as the fallback year. **We never download or parse the PDF binary** — there is no PDF dependency in this project. The repeater must stay on-air for 12 months, which is a `sustainmentObligation`.

- [ ] **Step 1: Write the fixture**

`fixtures/yaesu-dr2x/pathological.html` — one current PDF with dates in the anchor text, one older PDF with dates only in the filename, and a decoy PDF that is not the program form:

```html
<!DOCTYPE html><html><body>
<h1>System Fusion Repeater Program</h1>
<p>Program pricing: DR-2X $1,450, or $1,860 with the LAN-01A.</p>
<p>Open to clubs, groups, organizations or individuals in North America. The repeater must remain
on the air for twelve months.</p>
<ul>
  <li><a href="/wp-content/uploads/2026/06/DR-2X-Repeater-Program-June-3-August-31-2026-Fillable.pdf">DR-2X Repeater Program June 3 - August 31, 2026 (Fillable)</a></li>
  <li><a href="/wp-content/uploads/2025/09/DR-2X-Program-September-2-November-30-2025.pdf">Previous program form</a></li>
  <li><a href="/wp-content/uploads/2024/01/System-Fusion-Brochure.pdf">System Fusion brochure</a></li>
</ul>
</body></html>
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/sources/yaesu-dr2x.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixturePayload, loadFixture } from '../../test/fixtures.js';
import { findDr2xPdfLinks, windowFromPdfLink, yaesuDr2x } from './yaesu-dr2x.js';

const BASE = 'https://systemfusion.yaesu.com/';
const html = () => loadFixture('yaesu-dr2x', 'pathological.html');

describe('findDr2xPdfLinks', () => {
  it('finds only the repeater-program PDFs under /wp-content/uploads/{YYYY}/{MM}/', () => {
    const links = findDr2xPdfLinks(html(), BASE);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.href)).not.toContain(
      'https://systemfusion.yaesu.com/wp-content/uploads/2024/01/System-Fusion-Brochure.pdf',
    );
  });

  it('resolves relative hrefs and reads the upload year and month from the path', () => {
    const [current] = findDr2xPdfLinks(html(), BASE);
    expect(current.href).toBe(
      'https://systemfusion.yaesu.com/wp-content/uploads/2026/06/DR-2X-Repeater-Program-June-3-August-31-2026-Fillable.pdf',
    );
    expect(current.uploadYear).toBe(2026);
    expect(current.uploadMonth).toBe(6);
  });

  it('orders newest upload first', () => {
    expect(findDr2xPdfLinks(html(), BASE)[0].uploadYear).toBe(2026);
  });
});

describe('windowFromPdfLink', () => {
  it('reads the window out of the anchor text', () => {
    const [current] = findDr2xPdfLinks(html(), BASE);
    expect(windowFromPdfLink(current)).toEqual({ opensAt: '2026-06-03', closesAt: '2026-08-31' });
  });

  it('falls back to the filename when the anchor text is generic', () => {
    const links = findDr2xPdfLinks(html(), BASE);
    expect(windowFromPdfLink(links[1])).toEqual({ opensAt: '2025-09-02', closesAt: '2025-11-30' });
  });

  it('falls back to the upload path year when the dates carry no year', () => {
    expect(
      windowFromPdfLink({
        href: 'https://systemfusion.yaesu.com/wp-content/uploads/2027/02/DR-2X-Program-March-1-May-31.pdf',
        text: 'Program form',
        uploadYear: 2027,
        uploadMonth: 2,
      }),
    ).toEqual({ opensAt: '2027-03-01', closesAt: '2027-05-31' });
  });

  it('returns undefined rather than half a window', () => {
    expect(
      windowFromPdfLink({ href: 'https://x.test/DR-2X-Program.pdf', text: 'Program form' }),
    ).toBeUndefined();
  });
});

describe('yaesuDr2x', () => {
  const raws = yaesuDr2x.parse([fixturePayload('yaesu-dr2x', 'pathological.html', BASE)]);

  it('emits one record with the current window', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].rawFields.opensAt).toBe('2026-06-03');
    expect(raws[0].rawFields.closesAt).toBe('2026-08-31');
    expect(raws[0].rawFields.formUrl).toContain('June-3-August-31-2026');
  });

  it('captures the discounted purchase prices and the 12-month on-air obligation', () => {
    expect(raws[0].rawFields.pricing).toContain('$1,450');
    expect(raws[0].rawFields.pricing).toContain('$1,860');
    expect(raws[0].rawFields.sustainment).toMatch(/twelve months/i);
  });

  it('never downloads the PDF — every request is html', async () => {
    const requests = Array.isArray(yaesuDr2x.requests) ? yaesuDr2x.requests : [];
    for (const r of requests) expect(r.accept).toBe('html');
  });

  it('says in notes that this is a discounted purchase, not a grant', () => {
    expect(yaesuDr2x.notes).toMatch(/discounted purchase, not a grant/i);
    expect(yaesuDr2x.notes).toMatch(/PDF title/i);
  });

  it('returns [] when no program PDF is linked, so the yield alarm fires', () => {
    expect(
      yaesuDr2x.parse([
        { url: BASE, status: 200, contentType: 'text/html', body: '<p>Coming soon.</p>', fetchedAt: '2026-08-02T00:00:00.000Z' },
      ]),
    ).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/yaesu-dr2x.test.ts
```

Expected failure: `Failed to resolve import "./yaesu-dr2x.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/sources/yaesu-dr2x.ts`:

```ts
import * as cheerio from 'cheerio';
import type { FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { parseDateRange } from './util/dates.js';
import { flattenHtml } from './util/text.js';

const SOURCE_ID = 'yaesu-dr2x';
const LANDING = 'https://systemfusion.yaesu.com/';
const UPLOAD_PATH = /\/wp-content\/uploads\/(\d{4})\/(\d{2})\//;
const PROGRAM_PDF = /(dr-?2x|repeater[-\s]?program)/i;

export interface Dr2xLink {
  href: string;
  text: string;
  uploadYear?: number;
  uploadMonth?: number;
}

export function findDr2xPdfLinks(html: string, baseUrl: string): Dr2xLink[] {
  const $ = cheerio.load(html);
  const links: Dr2xLink[] = [];
  $('a[href]').each((_, a) => {
    const raw = $(a).attr('href');
    if (!raw || !/\.pdf(?:$|\?)/i.test(raw)) return;
    const href = new URL(raw, baseUrl).toString();
    const path = new URL(href).pathname;
    if (!UPLOAD_PATH.test(path)) return;
    const text = $(a).text().replace(/\s+/g, ' ').trim();
    if (!PROGRAM_PDF.test(`${path} ${text}`)) return;
    const m = UPLOAD_PATH.exec(path);
    links.push({
      href,
      text,
      uploadYear: m ? Number.parseInt(m[1], 10) : undefined,
      uploadMonth: m ? Number.parseInt(m[2], 10) : undefined,
    });
  });
  return links.sort(
    (a, b) =>
      (b.uploadYear ?? 0) - (a.uploadYear ?? 0) || (b.uploadMonth ?? 0) - (a.uploadMonth ?? 0),
  );
}

/**
 * The window dates exist ONLY in the title of the dated fillable PDF — never in the page body.
 * Read them from the anchor text first, then from the filename, using the /{YYYY}/{MM}/ upload
 * path as the fallback year. We deliberately never download or parse the PDF binary.
 */
export function windowFromPdfLink(
  link: Dr2xLink,
): { opensAt?: string; closesAt?: string } | undefined {
  const filename = decodeURIComponent(new URL(link.href).pathname.split('/').pop() ?? '')
    .replace(/\.pdf$/i, '')
    .replace(/[-_]+/g, ' ');
  for (const candidate of [link.text, filename]) {
    const range = parseDateRange(candidate, link.uploadYear);
    if (range?.opensAt && range.closesAt) return range;
  }
  return undefined;
}

export const yaesuDr2x: SourceModule = {
  id: SOURCE_ID,
  funderId: 'yaesu-usa',
  label: 'Yaesu System Fusion DR-2X Repeater Program',
  tier: 'C',
  klass: 'equipment_in_kind',
  requests: [{ url: LANDING, method: 'GET', accept: 'html' }],
  expectedMinRecords: 1,
  notes:
    'A DISCOUNTED PURCHASE, NOT A GRANT: $1,450 for the DR-2X, $1,860 with the LAN-01A. Open to ' +
    'clubs, groups, organizations or individuals in North America; collegiate clubs qualify. ' +
    'Ad-hoc windows, roughly 2-4 a year. The window dates exist ONLY in the PDF title line of a ' +
    'dated fillable form under /wp-content/uploads/{YYYY}/{MM}/ — they appear nowhere in the ' +
    'page body — so we read them from the anchor text and filename and never download the PDF ' +
    'binary. The repeater must stay on the air for 12 months (sustainmentObligation).',
  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const payload = payloads.find((p) => p.url.includes('systemfusion.yaesu.com') && p.status === 200);
    if (!payload) return [];
    const flat = flattenHtml(payload.body);
    const links = findDr2xPdfLinks(payload.body, payload.url);

    for (const link of links) {
      const range = windowFromPdfLink(link);
      if (!range?.opensAt || !range.closesAt) continue;
      const rawFields: Record<string, string> = {
        opensAt: range.opensAt,
        closesAt: range.closesAt,
        formUrl: link.href,
        formTitle: link.text,
      };
      const pricing = /([^.]*\$1,[0-9]{3}[^.]*\.)/.exec(flat)?.[1]?.trim();
      if (pricing) rawFields.pricing = pricing;
      const sustainment = /([^.]*(?:twelve months|12 months)[^.]*\.)/i.exec(flat)?.[1]?.trim();
      if (sustainment) rawFields.sustainment = sustainment;

      return [
        {
          sourceId: SOURCE_ID,
          externalKey: 'yaesu-dr2x-repeater-program',
          name: 'Yaesu System Fusion DR-2X Repeater Program',
          rawFields,
          sourceUrl: payload.url,
          rawText: flat,
        },
      ];
    }
    return [];
  },
};
```

Register in `registry.ts`.

- [ ] **Step 5: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/ && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/yaesu-dr2x.ts packages/server/src/sources/yaesu-dr2x.test.ts \
  packages/server/src/sources/registry.ts fixtures/yaesu-dr2x
git commit -m "feat(sources): Yaesu DR-2X window dates read from the dated PDF title"
```

---

### Task 15: `manual-tier-d` — hand-curated records, verified negatives, and the FAR safety warning

**Files:**
- Create: `packages/server/src/sources/manual-tier-d.ts`
- Test: `packages/server/src/sources/manual-tier-d.test.ts`
- Modify: `packages/server/src/sources/registry.ts`

**Interfaces:**
- Consumes: `SourceModule`, `RawOpportunity` from core.
- Produces: `export const TIER_D_RECORDS: readonly RawOpportunity[]`, `export const manualTierD: SourceModule`.

**Why a source module with no requests.** Five sites deliberately block non-browser clients (`yasme.org` 301s `/feed/` and `/wp-json/` to a 403; `ncdxf.org` 403s robots and sitemap; `radioclubofamerica.org` 403s its sitemap and only serves ClubExpress `module_id` query strings; `mga.ieee.org` returns HTTP **418** to bots; `k9ona.com` 403s). Each is worth **1–2 records that a human curates in five minutes and re-verifies quarterly.** UA-spoofing to defeat a deliberate access policy turns a clean project into an argument. Two more — NASA Space Grant's 52 independent consortia and campus SGA's ~4,000 independent sites — are structurally non-aggregatable and ship as guided workflows in Plan 3, with a standing record here so they are discoverable.

`requests: []` means the crawl runner fetches nothing and `parse()` ignores its argument, so these records still flow through the *entire* normal pipeline: they normalize, they diff, they age, they go amber past 90 days, and **Verify now** works on them.

**Boundary with Plan 5:** Plan 2 owns these ~16 standing Tier D records. Plan 5's `data/seed/*.json` corpus (~150 records) **must dedupe against them by `externalKey`** and must not restate them.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/sources/manual-tier-d.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TIER_D_RECORDS, manualTierD } from './manual-tier-d.js';

describe('manualTierD module', () => {
  it('is Tier D and fetches nothing', () => {
    expect(manualTierD.tier).toBe('D');
    expect(manualTierD.requests).toEqual([]);
  });

  it('returns the same records regardless of what it is handed', () => {
    expect(manualTierD.parse([])).toEqual([...TIER_D_RECORDS]);
    expect(manualTierD.parse([{ url: 'x', status: 200, contentType: '', body: '', fetchedAt: '' }])).toEqual(
      [...TIER_D_RECORDS],
    );
  });

  it('has at least 15 records and expectedMinRecords matches', () => {
    expect(TIER_D_RECORDS.length).toBeGreaterThanOrEqual(15);
    expect(manualTierD.expectedMinRecords).toBe(15);
  });

  it('gives every record a unique externalKey, a name and a verbatim rawText', () => {
    const keys = TIER_D_RECORDS.map((r) => r.externalKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of TIER_D_RECORDS) {
      expect(r.sourceId).toBe('manual-tier-d');
      expect(r.name.length).toBeGreaterThan(2);
      expect(r.rawText.length).toBeGreaterThan(20);
      expect(r.rawFields.recordType).toBeDefined();
    }
  });
});

describe('the FAR safety record', () => {
  const far = TIER_D_RECORDS.find((r) => r.externalKey === 'far-farweb-org-compromised');

  it('exists and is typed as a safety warning', () => {
    expect(far).toBeDefined();
    expect(far?.rawFields.recordType).toBe('safety_warning');
  });

  it('states the takeover, the window, and that other sites still send applicants there', () => {
    expect(far?.rawText).toMatch(/gambling/i);
    expect(far?.rawText).toMatch(/2025-10-17/);
    expect(far?.rawText).toMatch(/2026-02-10/);
    expect(far?.rawText).toMatch(/still (?:tell|instruct|point)/i);
  });

  it('does NOT contain a live link to the compromised domain', () => {
    expect(far?.sourceUrl).not.toContain('farweb.org');
    expect(far?.rawFields.sourceUrl).toBeUndefined();
  });

  it('records that FAR’s portfolio appears absorbed into the ARRL Foundation', () => {
    expect(far?.rawText).toMatch(/ARRL Foundation/);
  });
});

describe('the verified-negative records', () => {
  const negatives = TIER_D_RECORDS.filter((r) => r.rawFields.recordType === 'verified_negative');

  it('covers every §2.1 finding so nobody re-researches them', () => {
    const keys = negatives.map((r) => r.externalKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'negative-arrl-cari',
        'negative-amsat',
        'negative-flexradio',
        'negative-icom-dxengineering-kenwood',
        'negative-dara-hamvention',
        'negative-chicago-fm-club',
      ]),
    );
  });

  it('gives each negative a reason a human can act on', () => {
    for (const n of negatives) expect(n.rawFields.reason.length).toBeGreaterThan(20);
  });

  it('flags Chicago FM Club as a stale-mirror case', () => {
    const chicago = negatives.find((r) => r.externalKey === 'negative-chicago-fm-club');
    expect(chicago?.rawFields.staleMirrorWarning).toMatch(/aggregator/i);
  });
});

describe('the blocked-client records', () => {
  it('covers the five sites that block non-browser clients and says we do not spoof', () => {
    const keys = TIER_D_RECORDS.map((r) => r.externalKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        'yasme-supporting-grants',
        'yasme-excellence-award',
        'rca-scholarship-program',
        'rca-youth-activities',
      ]),
    );
    const yasme = TIER_D_RECORDS.find((r) => r.externalKey === 'yasme-supporting-grants');
    expect(yasme?.rawFields.whyManual).toMatch(/403/);
    expect(yasme?.rawFields.whyManual).toMatch(/do not spoof/i);
  });

  it('records that Yasme has no application and no deadline at all', () => {
    const yasme = TIER_D_RECORDS.find((r) => r.externalKey === 'yasme-supporting-grants');
    expect(yasme?.rawFields.deadlineKind).toBe('no_application_exists');
  });

  it('records that RCA nominates rather than accepting student applications', () => {
    const rca = TIER_D_RECORDS.find((r) => r.externalKey === 'rca-scholarship-program');
    expect(rca?.rawText).toMatch(/university selects/i);
    expect(rca?.rawFields.applicantEntity).toBe('nominated_by_institution');
  });
});

describe('the non-aggregatable guided-workflow records', () => {
  it('ships NASA Space Grant and campus SGA as standing records', () => {
    const keys = TIER_D_RECORDS.map((r) => r.externalKey);
    expect(keys).toEqual(
      expect.arrayContaining(['nasa-space-grant-consortia', 'campus-sga-playbook']),
    );
  });

  it('carries the FSU capital-equipment trap, which is the most valuable advice in the corpus', () => {
    const sga = TIER_D_RECORDS.find((r) => r.externalKey === 'campus-sga-playbook');
    expect(sga?.rawText).toMatch(/capital equipment/i);
    expect(sga?.rawText).toMatch(/programming/i);
  });

  it('records that there is no national Space Grant deadline', () => {
    const sg = TIER_D_RECORDS.find((r) => r.externalKey === 'nasa-space-grant-consortia');
    expect(sg?.rawText).toMatch(/52/);
    expect(sg?.rawFields.deadlineKind).toBe('unpublished');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/manual-tier-d.test.ts
```

Expected failure: `Failed to resolve import "./manual-tier-d.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/sources/manual-tier-d.ts`:

```ts
import type { RawOpportunity, SourceModule } from '@grantspotter/core';

const SOURCE_ID = 'manual-tier-d';

function record(
  externalKey: string,
  name: string,
  sourceUrl: string,
  rawFields: Record<string, string>,
  rawText: string,
): RawOpportunity {
  return { sourceId: SOURCE_ID, externalKey, name, rawFields, sourceUrl, rawText };
}

/**
 * Hand-curated records for sources that cannot or must not be polled. Verified 2026-08-02;
 * re-verify quarterly. Every record still flows through the normal pipeline — it normalizes,
 * it diffs, it ages, it goes amber past 90 days, and "Verify now" works on it.
 */
export const TIER_D_RECORDS: readonly RawOpportunity[] = Object.freeze([
  record(
    'far-farweb-org-compromised',
    'Foundation for Amateur Radio (FAR) — domain compromised, do not apply',
    'https://www.arrl.org/scholarship-program',
    { recordType: 'safety_warning', status: 'discontinued' },
    'SAFETY WARNING. The Foundation for Amateur Radio’s domain no longer belongs to FAR: it ' +
      'now redirects to an Indonesian online-gambling site. Wayback pins the takeover between ' +
      '2025-10-17 and 2026-02-10. QCWA pages, ARRL pages and club pages still tell applicants ' +
      'to "apply at the FAR website", so this record exists to intercept that instruction. Do ' +
      'not visit the domain. FAR’s historical portfolio (10-10, QCWA, YASME, K3IVO, CARA) ' +
      'appears absorbed into the ARRL Foundation — apply through the ARRL Foundation ' +
      'scholarship application instead. The domain is hard-blocklisted in the fetcher and no ' +
      'link to it appears anywhere in this application.',
  ),
  record(
    'yasme-supporting-grants',
    'Yasme Foundation Supporting Grants',
    'https://www.yasme.org/news-releases/',
    {
      recordType: 'manual',
      deadlineKind: 'no_application_exists',
      whyManual:
        'yasme.org 301s /feed/ and /wp-json/ to a 403 page for non-browser clients and a ' +
        'browser-UA curl hits a redirect loop. We do not spoof a browser to defeat a ' +
        'deliberate access policy. Tracked instead through the ARRL news RSS feed, which ' +
        'relays Yasme announcements.',
    },
    'Board-initiated grants of roughly $5,000 to $7,500 to youth programs, developing-country ' +
      'societies, Reverse Beacon Network nodes and other foundations’ scholarship funds. There ' +
      'is no application and no deadline: the board selects recipients and announces them ' +
      'retrospectively about twice a year. A year-end activity report is expected of ' +
      'recipients.',
  ),
  record(
    'yasme-excellence-award',
    'Yasme Excellence Award',
    'https://www.yasme.org/news-releases/',
    { recordType: 'manual', deadlineKind: 'no_application_exists', whyManual: 'See yasme-supporting-grants: yasme.org 403s non-browser clients and we do not spoof.' },
    'Board-selected recognition award announced retrospectively. There is no application path ' +
      'and no deadline. Listed so a user searching for Yasme finds an accurate answer instead ' +
      'of a dead application link.',
  ),
  record(
    'rca-scholarship-program',
    'Radio Club of America Scholarship Program',
    'https://www.radioclubofamerica.org/',
    {
      recordType: 'manual',
      applicantEntity: 'nominated_by_institution',
      deadlineKind: 'unpublished',
      whyManual:
        'radioclubofamerica.org runs ClubExpress: sitemap.xml 403s, WebFetch 403s, pretty URLs ' +
        '404, and only content.aspx query-string URLs work — and only with a browser UA, which ' +
        'we do not send. It also breaks silently whenever RCA renumbers a module id.',
    },
    'Rappaport, Carr, Cooper and 13 further named funds for undergraduate and graduate students ' +
      'on a wireless career track. A ham licence is NOT required. Only students at roughly nine ' +
      'participating schools are eligible, and the university selects recipients — the student ' +
      'never applies to RCA. Per-award amounts are unpublished; about $15,000 a year is ' +
      'distributed in total, each May. The action for a student is to ask their department ' +
      'whether their school participates.',
  ),
  record(
    'rca-youth-activities',
    'Radio Club of America Youth Activities Program',
    'https://www.radioclubofamerica.org/',
    { recordType: 'manual', deadlineKind: 'rolling', whyManual: 'ClubExpress module_id query strings only; see rca-scholarship-program.' },
    'In-kind support only — books, equipment and curriculum for schools, scouting groups and ' +
      'museums. No cash, no published deadline. Permanent contact-only entry; do not poll.',
  ),
  record(
    'nasa-space-grant-consortia',
    'NASA National Space Grant — 52 state consortia',
    'https://www.nasa.gov/learning-resources/national-space-grant-college-and-fellowship-project/',
    { recordType: 'guided_workflow', deadlineKind: 'unpublished' },
    'The most common real route to a campus ground station or cubesat, and structurally ' +
      'non-aggregatable: 52 independent consortia, 52 independent calendars, no national ' +
      'deadline, and heterogeneous university-hosted sites. Consortium-level student awards are ' +
      'typically $1,000 to $10,000 and are not published nationally. GrantSpotter ships this as ' +
      'a state-keyed consortium picker rather than pretending it is a feed.',
  ),
  record(
    'campus-sga-playbook',
    'Campus student government / student activity fee funding',
    'https://sga.fsu.edu/accounting/funding-your-rso',
    { recordType: 'guided_workflow', deadlineKind: 'rolling' },
    'Where a typical collegiate club’s money actually comes from, and impossible to aggregate: ' +
      'roughly 4,000 campuses on Qualtrics, CampusGroups, Presence and Engage. The ham club ' +
      'applies like any other registered student organization. FSU, taken as representative: ' +
      'programming up to $3,000 (up to $5,000 extraordinary), travel $250 per student and ' +
      '$5,000 per organization, Development Fund up to $300 per fiscal year, with a rolling ' +
      'event and travel process needing at least six weeks’ lead and a maximum of three ' +
      'requests per year, plus an annual A&S budget cycle. THE TRAP: capital equipment is ' +
      'frequently barred outright by student-activity-fee rules, so a radio must be framed as ' +
      'programming or funded externally. That framing advice is worth more than most of the ' +
      'opportunity index.',
  ),
  record(
    'ncdxf-youth-grant',
    'NCDXF Youth Grant',
    'https://www.ncdxf.org/pages/scholarships.html',
    { recordType: 'manual', deadlineKind: 'unpublished' },
    'The Youth Grant page renders as navigation and a title only — it publishes no terms, no ' +
      'amount and no deadline. Recorded as a contact-only entry so the app gives an honest ' +
      'answer instead of an empty page. Low-value polling target.',
  ),
  record(
    'hamsci-participation',
    'HamSCI — participate with a funded principal investigator',
    'https://hamsci.org/',
    { recordType: 'manual', deadlineKind: 'no_application_exists' },
    'HamSCI has no club-facing application. It is a research collaboration funded by NSF ' +
      'awards held by university PIs (for example the Personal Space Weather Station network ' +
      'and the Scranton CAREER award on amateur radio and travelling ionospheric ' +
      'disturbances). A collegiate club participates by contacting a funded PI, not by ' +
      'applying for a grant.',
  ),
  record(
    'ieee-society-funding-pages',
    'IEEE society funding pages (~39 societies)',
    'https://www.ieee.org/communities/societies/',
    { recordType: 'manual', deadlineKind: 'unpublished' },
    'Roughly 39 IEEE societies each publish their own chapter and student funding page on ' +
      'different templates and calendars. MTT-S is polled directly because it is the most ' +
      'RF-relevant; the rest are a hand-curated pointer so a student branch knows to check ' +
      'their own society.',
  ),
  record(
    'negative-arrl-cari',
    'ARRL Collegiate Amateur Radio Initiative (CARI) — not a funding program',
    'http://www.arrl.org/cari',
    {
      recordType: 'verified_negative',
      reason:
        'CARI is Zoom meetups, the Collegiate QSO Party and Hamvention networking. It is not a ' +
        'funding program. The W1YSM Snyder endowment funds CARI activities but has no open ' +
        'application. Confirmed independently by two researchers on 2026-08-02.',
    },
    'Recorded as a verified negative so a future maintainer does not re-research it and so the ' +
      'UI never renders an empty "CARI grants" category.',
  ),
  record(
    'negative-amsat',
    'AMSAT — no grants program',
    'https://www.amsat.org/university-participation/',
    {
      recordType: 'verified_negative',
      reason:
        'AMSAT is a grant RECIPIENT, not a grantmaker. /university-participation/ is a ' +
        'near-empty stub listing one RIT project. Confirmed by two researchers.',
    },
    'Recorded as a verified negative. Students searching for "AMSAT grant" get an accurate ' +
      'answer instead of an empty result.',
  ),
  record(
    'negative-flexradio',
    'FlexRadio — no education or nonprofit purchasing tier',
    'https://www.flexradio.com/purchasing-programs/',
    {
      recordType: 'verified_negative',
      reason:
        'The purchasing-programs page was fetched specifically to check. Only a CPO programme ' +
        'and a trade-in exist; there is no education, student, club or nonprofit tier.',
    },
    'Recorded as a verified negative so the equipment category does not imply a discount that ' +
      'does not exist.',
  ),
  record(
    'negative-icom-dxengineering-kenwood',
    'Icom America, DX Engineering, Kenwood — relationship-driven, no application path',
    'https://www.icomamerica.com/',
    {
      recordType: 'verified_negative',
      reason:
        'Genuine collegiate giving happens — IC-7610s reached CMU W3VC, Penn State K3CR and ' +
        'Pitt W3YI — but there is no application programme, no page and no deadline. Kenwood ' +
        'has nothing at all.',
    },
    'Shipped as a relationship playbook rather than an opportunity: identify the regional rep, ' +
      'lead with the students and the on-air result, and ask for a specific model. There is no ' +
      'form to fill in.',
  ),
  record(
    'negative-dara-hamvention',
    'DARA / Hamvention — grantmaker only through the ARRL catalog',
    'https://hamvention.org/',
    {
      recordType: 'verified_negative',
      reason:
        'Zero hrefs containing "scholar" or "grant" on w8bi.org; hamvention.org has no ' +
        'scholarship page; daytonhamvention.org did not resolve. Only the DARA entry inside ' +
        'the ARRL catalog is real ($1,500, multiple per year, any licence class).',
    },
    'Apply through the ARRL Foundation scholarship application. Do not look for a DARA form.',
  ),
  record(
    'negative-chicago-fm-club',
    'Chicago FM Club Scholarship — discontinued',
    'https://www.chicagofmclub.org/',
    {
      recordType: 'verified_negative',
      reason:
        'Zero hits in the live ARRL scholarship catalog, and 325 KB of chicagofmclub.org ' +
        'contains no occurrence of the word "scholarship".',
      staleMirrorWarning:
        'Still listed by seven or more third-party aggregators — direct proof that they mirror ' +
        'stale ARRL data rather than re-reading the source.',
    },
    'Recorded as discontinued with an explicit stale-mirror warning, because a student who ' +
      'finds it on an aggregator needs to be told why it is not in the live catalog.',
  ),
]);

export const manualTierD: SourceModule = {
  id: SOURCE_ID,
  funderId: 'various',
  label: 'Manually curated Tier D records',
  tier: 'D',
  klass: 'ham_grant',
  requests: [],
  expectedMinRecords: 15,
  notes:
    'No network access at all. Covers the five sites that deliberately block non-browser ' +
    'clients (yasme.org 403, ncdxf.org robots+sitemap 403, radioclubofamerica.org 403, ' +
    'mga.ieee.org HTTP 418, k9ona.com 403) — each worth 1-2 records a human curates in five ' +
    'minutes and re-verifies quarterly, and none worth spoofing a browser for. Also carries ' +
    'the two structurally non-aggregatable guided workflows (52 NASA Space Grant consortia, ' +
    '~4,000 campus SGAs), the verified negatives so nobody re-researches them, and the FAR ' +
    'safety warning. Plan 5 seed data must dedupe against these externalKeys.',
  parse(): RawOpportunity[] {
    return [...TIER_D_RECORDS];
  },
};
```

Register in `registry.ts`. At this point the registry holds all 24 modules; re-run the registry invariants test to confirm.

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/ && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/manual-tier-d.ts packages/server/src/sources/manual-tier-d.test.ts \
  packages/server/src/sources/registry.ts
git commit -m "feat(sources): manual Tier D records, verified negatives and the FAR safety warning"
```

---

### Task 16: `normalize/` core — `RawOpportunity` → `Program`

**Files:**
- Create: `packages/server/src/normalize/index.ts`
- Create: `packages/server/src/normalize/deadline.ts`
- Create: `packages/server/src/normalize/disputed.ts`
- Test: `packages/server/src/normalize/index.test.ts`

**Interfaces:**
- Consumes: `parseAmount`, `hashProgram` and `RECURRENCE_PREFIX` from `@grantspotter/core`; every type in CONTRACT §3. **It does not import `programIdFor`** — see "`normalize/` is pure" below.
- Produces:
  ```ts
  export interface NormalizeContext {   // plan-local
    sourceId: string; funderId: string; klass: OpportunityClass; tier: SourceTier;
    nowISO: string;
    /** Program id whose cycle this source's records inherit, if any. */
    deadlineInheritsFrom?: string;
    verificationMethod: VerificationMethod;
    /** Injected id minter (Task 5's programIdFor). Injected, not imported: it uses node:crypto. */
    mintId: (sourceId: string, externalKey: string) => string;
    /**
     * RESOLUTIONS R9. Resolves the id of an ALREADY-STORED program with this source key, so a
     * nightly crawl updates the seeded record instead of minting a fresh id and duplicating the
     * entire corpus every night. Wired in Task 25 to Plan 1's
     * `createProgramRepo(db).findBySourceKey(sourceId, externalKey)`.
     */
    existingIdFor?: (sourceId: string, externalKey: string) => string | undefined;
  }
  export function normalizeRaw(raw: RawOpportunity, ctx: NormalizeContext): Program;
  // deadline.ts
  export function inferDeadline(raw: RawOpportunity, ctx: NormalizeContext): DeadlineSpec;
  export function inferStatus(raw: RawOpportunity, ctx: NormalizeContext): ProgramStatus;
  export function inferInstrument(raw: RawOpportunity, ctx: NormalizeContext): Instrument;
  export const DEADLINE_INHERITANCE: Readonly<Record<string, string>>;
  export const RECURRENCE_BY_SOURCE: Readonly<Record<string, string>>;
  // disputed.ts
  export function sourceKeyOf(sourceId: string, externalKey: string): string;   // `${sourceId}::${externalKey}`
  export const DISPUTED_OVERRIDES: Readonly<Record<string, Disputed>>;          // keyed by sourceKeyOf
  ```
  `contextForSource` is **not** here. It moved to `packages/server/src/crawl/context.ts` (Task 25) because it has to reach the registry, the id minter and the database — all three of which are exactly what `normalize/` must not import.

**`normalize/` is pure (spec §14, coverage finding #12).** No file under `packages/server/src/normalize/` may contain a `node:` import, read a file, read the clock, or import anything from `../sources/` or `../db/`. The clock arrives as `ctx.nowISO`, the id minter as `ctx.mintId`, and the seeded-id lookup as `ctx.existingIdFor`. Task 17 Step 1 adds the grep test that enforces this over the whole directory.

**The three rules this task exists to enforce:**

1. **`rawOtherText` is ALWAYS populated** — `''` when there is genuinely nothing, never `undefined`. No schema captures *"preference to a student ham from a ham family"*, learning-disability documentation, or an at-risk-youth turnaround letter, so the verbatim text is the only place those survive.
2. **Deadline inheritance.** All 111 ARRL catalog entries and QCWA's record share **one** cycle, owned by the program whose canonical id is **`arrl-foundation-scholarships`** (RESOLUTIONS R9 — Plan 4's list is canonical and Plan 5's seed uses it). Without `DeadlineSource: { kind: 'inherited', fromProgramId }` you write 111 empty date fields and QCWA's real deadline disappears.
3. **`trust.contentHash` is `hashProgram(program)`, computed last.** `hashProgram` excludes `TrustFields` by contract, which is load-bearing: `lastVerifiedAt` changes on every crawl, so including it would mark every record changed every night.
4. **The `RECUR:` micro-format is actually emitted** (RESOLUTIONS R12 / CONTRACT §10.1). `expandCycles` projects nothing at all unless `DeadlineSpec.note` starts with the `RECUR ` directive Plan 1 Task 5 defines. Three programs carry one: ARDC (four fixed dates), ARRL Amateur Radio Grants (three windows), ARRL Foundation Scholarships (one annual window). Without them the calendar is silently empty for the three most important programs in the corpus.
5. **Crawled ids reconcile with seeded ids** (RESOLUTIONS R9). `normalizeRaw` asks `ctx.existingIdFor` before minting. Otherwise every seeded program fires `vanished` and every crawled program fires `new`, every night, forever.

`amountRaw` and `awardCountRaw` are copied verbatim from `rawFields` and only *then* passed to `parseAmount`. This is what keeps the **$100,000-endowment trap** out of `amountMax`: one catalog entry mentions $100,000 as an endowment figure, not an award, and `parseAmount` (Plan 1) is the single place that decides.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/normalize/index.test.ts`:

```ts
import type { Program, RawOpportunity } from '@grantspotter/core';
import { expandCycles, hashProgram, parseRecurrence } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { programIdFor } from '../sources/util/ids.js';
import { DEADLINE_INHERITANCE } from './deadline.js';
import { DISPUTED_OVERRIDES, sourceKeyOf } from './disputed.js';
import { type NormalizeContext, normalizeRaw } from './index.js';

const NOW = '2026-08-02T00:00:00.000Z';

const ctx = (over: Partial<NormalizeContext> = {}): NormalizeContext => ({
  sourceId: 'arrl-scholarship-descriptions',
  funderId: 'arrl-foundation',
  klass: 'ham_scholarship',
  tier: 'C',
  nowISO: NOW,
  verificationMethod: 'live_fetch',
  deadlineInheritsFrom: DEADLINE_INHERITANCE['arrl-scholarship-descriptions'],
  mintId: programIdFor,
  ...over,
});

const raw = (over: Partial<RawOpportunity> = {}): RawOpportunity => ({
  sourceId: 'arrl-scholarship-descriptions',
  externalKey: 'YASME Foundation Scholarship',
  name: 'YASME Foundation Scholarship',
  rawFields: {
    'Field of Study': 'Sciences or Engineering',
    'License Requirement': 'General or higher, licensed at least two years',
    Region: 'Any',
    Institution: 'Any accredited institution',
    'Award Amount': '$5,000',
    'Number of Awards': 'Three',
    Other: 'Top 5 to 10 percent of the class; year-end activity report required.',
  },
  sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
  rawText: 'YASME Foundation Scholarship body text',
  ...over,
});

describe('normalizeRaw identity and provenance', () => {
  it('builds a deterministic id from sourceId and externalKey', () => {
    const a = normalizeRaw(raw(), ctx());
    const b = normalizeRaw(raw(), ctx());
    expect(a.id).toBe(b.id);
    expect(a.id).toContain('arrl-scholarship-descriptions--');
  });

  it('reuses an already-stored id instead of minting a duplicate — RESOLUTIONS R9', () => {
    const seeded = normalizeRaw(
      raw({ sourceId: 'ardc-grants', externalKey: 'grants', name: 'ARDC Grants Program' }),
      ctx({
        sourceId: 'ardc-grants',
        funderId: 'ardc',
        klass: 'ham_grant',
        tier: 'A',
        deadlineInheritsFrom: undefined,
        existingIdFor: (sourceId, externalKey) =>
          sourceId === 'ardc-grants' && externalKey === 'grants' ? 'ardc-grants' : undefined,
      }),
    );
    expect(seeded.id).toBe('ardc-grants');
    expect(seeded.id).not.toContain('--');
  });

  it('falls back to minting when nothing is stored under that source key', () => {
    const fresh = normalizeRaw(
      raw({ sourceId: 'ardc-grants', externalKey: 'grants' }),
      ctx({
        sourceId: 'ardc-grants',
        funderId: 'ardc',
        klass: 'ham_grant',
        tier: 'A',
        deadlineInheritsFrom: undefined,
        existingIdFor: () => undefined,
      }),
    );
    expect(fresh.id).toBe(programIdFor('ardc-grants', 'grants'));
  });

  it('stamps the ingest identity into tags so approval can persist the source key', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.tags).toContain('source:arrl-scholarship-descriptions');
    expect(p.tags).toContain('key:YASME Foundation Scholarship');
  });

  it('carries funderId, klass and the source URL through', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.funderId).toBe('arrl-foundation');
    expect(p.klass).toBe('ham_scholarship');
    expect(p.trust.sourceUrl).toBe('http://www.arrl.org/scholarship-descriptions');
    expect(p.trust.lastVerifiedAt).toBe(NOW);
    expect(p.trust.verificationMethod).toBe('live_fetch');
  });

  it('sets contentHash to hashProgram of itself, computed last', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.trust.contentHash).toBe(hashProgram(p));
    expect(p.trust.contentHash).not.toBe('');
  });

  it('produces the same hash on two consecutive nights when only lastVerifiedAt moves', () => {
    const a = normalizeRaw(raw(), ctx());
    const b = normalizeRaw(raw(), ctx({ nowISO: '2026-08-03T00:00:00.000Z' }));
    expect(hashProgram(a)).toBe(hashProgram(b));
  });
});

describe('rawOtherText is always populated', () => {
  it('carries the Other field verbatim, newlines and all', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.rawOtherText).toContain('Top 5 to 10 percent');
    expect(p.rawOtherText).toContain('year-end activity report');
  });

  it('falls back to the whole rawText rather than losing unmodelled requirements', () => {
    const p = normalizeRaw(
      raw({ rawFields: { 'Award Amount': '$1,000' }, rawText: 'A long-tail requirement sentence.' }),
      ctx(),
    );
    expect(p.rawOtherText).toContain('A long-tail requirement sentence.');
  });

  it('is an empty string, never undefined, when there is genuinely nothing', () => {
    const p = normalizeRaw(raw({ rawFields: {}, rawText: '' }), ctx());
    expect(p.rawOtherText).toBe('');
  });
});

describe('amounts', () => {
  it('keeps amountRaw and awardCountRaw verbatim', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.amount.amountRaw).toBe('$5,000');
    expect(p.amount.awardCountRaw).toBe('Three');
  });

  it('keeps a non-numeric award count verbatim', () => {
    const p = normalizeRaw(raw({ rawFields: { ...raw().rawFields, 'Number of Awards': 'Multiple per year' } }), ctx());
    expect(p.amount.awardCountRaw).toBe('Multiple per year');
  });

  it('keeps the literal string TBD verbatim and leaves min/max undefined', () => {
    const p = normalizeRaw(raw({ rawFields: { amountRaw: 'TBD' } }), ctx());
    expect(p.amount.amountRaw).toBe('TBD');
    expect(p.amount.amountMin).toBeUndefined();
    expect(p.amount.amountMax).toBeUndefined();
  });

  it('uses empty strings, not undefined, when a source publishes no amount at all', () => {
    const p = normalizeRaw(raw({ rawFields: {} }), ctx());
    expect(p.amount.amountRaw).toBe('');
    expect(p.amount.awardCountRaw).toBe('');
  });
});

describe('deadline inheritance', () => {
  it('points at the canonical program ids, not minted ones — RESOLUTIONS R9', () => {
    expect(DEADLINE_INHERITANCE['arrl-scholarship-descriptions']).toBe(
      'arrl-foundation-scholarships',
    );
    expect(DEADLINE_INHERITANCE.qcwa).toBe('arrl-foundation-scholarships');
    for (const id of Object.values(DEADLINE_INHERITANCE)) {
      expect(id).not.toContain('--'); // a minted id would carry the `--<hash>` suffix
    }
  });

  it('makes every ARRL catalog entry inherit the one shared cycle', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.deadline.kind).toBe('inherited');
    expect(p.deadline.source).toEqual({
      kind: 'inherited',
      fromProgramId: DEADLINE_INHERITANCE['arrl-scholarship-descriptions'],
    });
  });

  it('makes QCWA inherit the same ARRL cycle, because its intake is ARRL’s portal', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'qcwa', externalKey: 'qcwa-memorial-scholarship' }),
      ctx({ sourceId: 'qcwa', funderId: 'qcwa', deadlineInheritsFrom: DEADLINE_INHERITANCE.qcwa }),
    );
    expect(p.deadline.kind).toBe('inherited');
    expect(p.deadline.source).toEqual({ kind: 'inherited', fromProgramId: DEADLINE_INHERITANCE.qcwa });
  });

  it('gives a self-owned source kind self', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ardc-grants' }),
      ctx({ sourceId: 'ardc-grants', funderId: 'ardc', klass: 'ham_grant', tier: 'A', deadlineInheritsFrom: undefined }),
    );
    expect(p.deadline.source).toEqual({ kind: 'self' });
  });

  it('marks a source with no published deadline as unpublished, never as a guessed date', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', externalKey: 'club-grant-program', rawFields: { amount: '$1,000 to $25,000' } }),
      ctx({ sourceId: 'arrl-club-grant', funderId: 'arrl-foundation', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.deadline.kind).toBe('unpublished');
    expect(p.deadline.note).toMatch(/never published/i);
  });

  it('marks rolling sources rolling', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'sara', externalKey: 'sara-student-teacher-grants' }),
      ctx({ sourceId: 'sara', funderId: 'sara', klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
    );
    expect(p.deadline.kind).toBe('rolling');
  });
});

describe('the RECUR micro-format is actually emitted — RESOLUTIONS R12', () => {
  /** The three recurring programs, normalized exactly as the crawler produces them. */
  const recurring = (): Record<'ardc' | 'grants' | 'scholarships', Program> => ({
    ardc: normalizeRaw(
      raw({ sourceId: 'ardc-grants', externalKey: 'grants', name: 'ARDC Grants Program' }),
      ctx({
        sourceId: 'ardc-grants',
        funderId: 'ardc',
        klass: 'ham_grant',
        tier: 'A',
        deadlineInheritsFrom: undefined,
        existingIdFor: () => 'ardc-grants',
      }),
    ),
    grants: normalizeRaw(
      raw({
        sourceId: 'arrl-amateur-radio-grants',
        externalKey: 'amateur-radio-grants',
        name: 'ARRL Amateur Radio Grants',
      }),
      ctx({
        sourceId: 'arrl-amateur-radio-grants',
        funderId: 'arrl-foundation',
        klass: 'ham_grant',
        deadlineInheritsFrom: undefined,
        existingIdFor: () => 'arrl-amateur-radio-grants',
      }),
    ),
    scholarships: normalizeRaw(
      raw({
        sourceId: 'arrl-scholarship-program',
        externalKey: 'scholarship-program',
        name: 'ARRL Foundation Scholarship Program',
      }),
      ctx({
        sourceId: 'arrl-scholarship-program',
        funderId: 'arrl-foundation',
        deadlineInheritsFrom: undefined,
        existingIdFor: () => 'arrl-foundation-scholarships',
      }),
    ),
  });

  it('emits a parseable directive whose kind matches DeadlineSpec.kind', () => {
    for (const p of Object.values(recurring())) {
      expect(p.deadline.note.startsWith('RECUR ')).toBe(true);
      const parsed = parseRecurrence(p.deadline.note);
      expect(parsed.kind).toBe(p.deadline.kind);
    }
  });

  it('emits ARDC Feb 1 / Apr 1 / Jul 1 / Sep 1 in Pacific time', () => {
    const parsed = parseRecurrence(recurring().ardc.deadline.note);
    expect(parsed).toMatchObject({
      kind: 'n_fixed_dates',
      timezone: 'America/Los_Angeles',
      dates: [
        { month: 2, day: 1 },
        { month: 4, day: 1 },
        { month: 7, day: 1 },
        { month: 9, day: 1 },
      ],
    });
  });

  it('emits the three ARRL grant windows in Eastern time', () => {
    const parsed = parseRecurrence(recurring().grants.deadline.note);
    expect(parsed).toMatchObject({
      kind: 'n_fixed_windows',
      timezone: 'America/New_York',
      windows: [
        { open: { month: 2, day: 1 }, close: { month: 2, day: 28 } },
        { open: { month: 6, day: 1 }, close: { month: 6, day: 30 } },
        { open: { month: 10, day: 1 }, close: { month: 10, day: 31 } },
      ],
    });
  });

  it('emits the scholarship annual window closing Dec 30 at 12:00 Eastern', () => {
    const parsed = parseRecurrence(recurring().scholarships.deadline.note);
    expect(parsed).toMatchObject({
      kind: 'annual_window',
      timezone: 'America/New_York',
      window: { open: { month: 10, day: 30 }, close: { month: 12, day: 30 } },
      closeTime: { hour: 12, minute: 0 },
    });
  });

  it('expandCycles returns a NON-EMPTY result for all three — the whole point of R12', () => {
    const all = Object.values(recurring());
    for (const p of all) {
      const cycles = expandCycles(p, all, '2027-01-01T00:00:00.000Z', '2027-12-31T23:59:59.999Z');
      expect(cycles.length, `${p.id} projected no cycles`).toBeGreaterThan(0);
      expect(cycles.every((c) => c.programId === p.id)).toBe(true);
    }
  });

  it('lets the 111 inheriting catalog entries ride the scholarship cycle', () => {
    const all = Object.values(recurring());
    const catalogEntry = normalizeRaw(raw(), ctx());
    const cycles = expandCycles(
      catalogEntry,
      [...all, catalogEntry],
      '2027-01-01T00:00:00.000Z',
      '2027-12-31T23:59:59.999Z',
    );
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles.every((c) => c.programId === catalogEntry.id)).toBe(true);
  });

  it('never attaches a directive to a non-projectable kind', () => {
    const clubGrant = normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', externalKey: 'club-grant-program' }),
      ctx({ sourceId: 'arrl-club-grant', funderId: 'arrl-foundation', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(clubGrant.deadline.kind).toBe('unpublished');
    expect(clubGrant.deadline.note.startsWith('RECUR ')).toBe(false);
  });
});

describe('status and instrument', () => {
  it('marks a past-award record closed so it never renders as a live deadline', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ardc-award-tables', rawFields: { recordType: 'past_award', amountRaw: '$77,000' } }),
      ctx({ sourceId: 'ardc-award-tables', funderId: 'ardc', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.trust.status).toBe('closed');
    expect(p.tags).toContain('past_award');
  });

  it('marks a verified-negative record discontinued', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'manual-tier-d', rawFields: { recordType: 'verified_negative', reason: 'no programme exists' } }),
      ctx({ sourceId: 'manual-tier-d', funderId: 'various', tier: 'D', verificationMethod: 'manual_curation', deadlineInheritsFrom: undefined }),
    );
    expect(p.trust.status).toBe('discontinued');
  });

  it('marks a no-application record no_application', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'manual-tier-d', rawFields: { recordType: 'manual', deadlineKind: 'no_application_exists' } }),
      ctx({ sourceId: 'manual-tier-d', funderId: 'yasme', tier: 'D', verificationMethod: 'manual_curation', deadlineInheritsFrom: undefined }),
    );
    expect(p.trust.status).toBe('no_application');
    expect(p.deadline.kind).toBe('no_application_exists');
  });

  it('marks the Yaesu record a discounted purchase, not a cash grant', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'yaesu-dr2x', rawFields: { pricing: '$1,450 or $1,860.' } }),
      ctx({ sourceId: 'yaesu-dr2x', funderId: 'yaesu-usa', klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
    );
    expect(p.amount.instrument).toBe('discounted_purchase');
  });

  it('marks ARISS and NASA CSLI in-kind service', () => {
    for (const sourceId of ['ariss', 'nasa-csli']) {
      const p = normalizeRaw(
        raw({ sourceId }),
        ctx({ sourceId, funderId: sourceId, klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
      );
      expect(p.amount.instrument).toBe('in_kind_service');
    }
  });

  it('refuses to publish a crosscheck record', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'arrl-summary-of-scholarship-requirements', rawFields: { recordType: 'crosscheck' } }),
      ctx({ sourceId: 'arrl-summary-of-scholarship-requirements', deadlineInheritsFrom: undefined }),
    );
    expect(p.tags).toContain('crosscheck');
    expect(p.tags).toContain('do_not_publish');
  });
});

describe('disputed claims ship populated', () => {
  it('attaches all three ARRL Club Grant readings instead of picking one', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', externalKey: 'club-grant-program', name: 'ARRL Club Grant Program', rawFields: { amount: '$1,000 to $25,000' } }),
      ctx({ sourceId: 'arrl-club-grant', funderId: 'arrl-foundation', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.trust.disputed).toBeDefined();
    expect(p.trust.disputed?.claims).toHaveLength(3);
    for (const claim of p.trust.disputed?.claims ?? []) {
      expect(claim.claim.length).toBeGreaterThan(20);
      expect(() => new URL(claim.sourceUrl)).not.toThrow();
    }
  });

  it('keys the override on the source key, so it survives id reconciliation', () => {
    // RESOLUTIONS R9 means the same record can carry a minted id on a fresh database and the
    // seeded id `arrl-club-grant` once Plan 5's corpus is imported. Keying on (sourceId,
    // externalKey) is the only key that is the same in both worlds.
    expect(Object.keys(DISPUTED_OVERRIDES)).toContain(
      sourceKeyOf('arrl-club-grant', 'club-grant-program'),
    );
    const minted = normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', externalKey: 'club-grant-program' }),
      ctx({ sourceId: 'arrl-club-grant', deadlineInheritsFrom: undefined }),
    );
    const seeded = normalizeRaw(
      raw({ sourceId: 'arrl-club-grant', externalKey: 'club-grant-program' }),
      ctx({
        sourceId: 'arrl-club-grant',
        deadlineInheritsFrom: undefined,
        existingIdFor: () => 'arrl-club-grant',
      }),
    );
    expect(minted.id).not.toBe(seeded.id);
    expect(minted.trust.disputed?.claims).toHaveLength(3);
    expect(seeded.trust.disputed?.claims).toHaveLength(3);
  });
});

describe('obligations and restrictions', () => {
  it('applies ARDC’s open-source obligation and 20% indirect cap', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ardc-grants' }),
      ctx({ sourceId: 'ardc-grants', funderId: 'ardc', klass: 'ham_grant', tier: 'A', deadlineInheritsFrom: undefined }),
    );
    expect(p.obligations.licenseObligation).toMatch(/open-source/i);
    expect(p.obligations.indirectCostCapPct).toBe(20);
  });

  it('applies ARRL’s exclusions and co-funder preference', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'arrl-amateur-radio-grants', externalKey: 'amateur-radio-grants' }),
      ctx({ sourceId: 'arrl-amateur-radio-grants', funderId: 'arrl-foundation', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.fundingRestrictions.join(' ')).toMatch(/emergency communications/i);
    expect(p.fundingRestrictions.join(' ')).toMatch(/operating expenses/i);
    expect(p.obligations.coFunderPreference).toBe(true);
  });

  it('applies Yaesu’s 12-month on-air sustainment obligation', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'yaesu-dr2x' }),
      ctx({ sourceId: 'yaesu-dr2x', funderId: 'yaesu-usa', klass: 'equipment_in_kind', deadlineInheritsFrom: undefined }),
    );
    expect(p.obligations.sustainmentObligation).toMatch(/12 months|twelve months/i);
  });

  it('applies YASME’s year-end reporting obligation from the Tier D record', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'manual-tier-d', externalKey: 'yasme-supporting-grants', name: 'YASME Foundation Supporting Grants' }),
      ctx({
        sourceId: 'manual-tier-d',
        funderId: 'yasme',
        klass: 'ham_grant',
        tier: 'D',
        verificationMethod: 'manual_curation',
        deadlineInheritsFrom: undefined,
      }),
    );
    expect(p.obligations.reportingObligation).toMatch(/year-end activity report/i);
  });

  it('applies NCDXF’s cost-share requirement', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ncdxf-grants', externalKey: 'ncdxf-dxpedition-grants', name: 'NCDXF DXpedition Grants' }),
      ctx({ sourceId: 'ncdxf-grants', funderId: 'ncdxf', klass: 'ham_grant', deadlineInheritsFrom: undefined }),
    );
    expect(p.obligations.costShareRequired).toBe(true);
  });

  it('carries every §4.6 obligation field — all six are reachable through normalizeRaw', () => {
    // spec §4.6: licenseObligation, indirectCostCapPct, costShareRequired, coFunderPreference,
    // sustainmentObligation, reportingObligation. Seed records re-enter this same pipeline on
    // "Verify now" (Plan 3 Task 10), so a field no source produces is a field silently dropped.
    const produced = new Set<string>();
    const cases: Array<[string, Partial<NormalizeContext>, string]> = [
      ['ardc-grants', { funderId: 'ardc', klass: 'ham_grant', tier: 'A' }, 'grants'],
      ['arrl-amateur-radio-grants', { funderId: 'arrl-foundation', klass: 'ham_grant' }, 'amateur-radio-grants'],
      ['yaesu-dr2x', { funderId: 'yaesu-usa', klass: 'equipment_in_kind' }, 'dr2x-repeater'],
      ['ncdxf-grants', { funderId: 'ncdxf', klass: 'ham_grant' }, 'ncdxf-dxpedition-grants'],
      ['manual-tier-d', { funderId: 'yasme', klass: 'ham_grant', tier: 'D', verificationMethod: 'manual_curation' }, 'yasme-supporting-grants'],
    ];
    for (const [sourceId, over, externalKey] of cases) {
      const p = normalizeRaw(
        raw({ sourceId, externalKey }),
        ctx({ sourceId, deadlineInheritsFrom: undefined, ...over }),
      );
      for (const [field, value] of Object.entries(p.obligations)) {
        if (value !== undefined && value !== false) produced.add(field);
      }
    }
    expect([...produced].sort()).toEqual([
      'coFunderPreference',
      'costShareRequired',
      'indirectCostCapPct',
      'licenseObligation',
      'reportingObligation',
      'sustainmentObligation',
    ]);
  });
});

describe('AI policy ships populated', () => {
  it('quotes ARDC’s permission-plus-diagnosis stance with its URL', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'ardc-grants' }),
      ctx({ sourceId: 'ardc-grants', funderId: 'ardc', klass: 'ham_grant', tier: 'A', deadlineInheritsFrom: undefined }),
    );
    expect(p.aiPolicy.stance).toBe('permitted');
    expect(p.aiPolicy.quote).toMatch(/extremely long and hard to understand/i);
    expect(p.aiPolicy.url).toContain('ardc.net');
  });

  it('records the ARRL Foundation stance as unaddressed rather than inventing one', () => {
    const p = normalizeRaw(raw(), ctx());
    expect(p.aiPolicy.stance).toBe('unaddressed');
  });

  it('records NSF’s encouraged-disclosure stance', () => {
    const p = normalizeRaw(
      raw({ sourceId: 'nsf-funding-rss' }),
      ctx({ sourceId: 'nsf-funding-rss', funderId: 'nsf', klass: 'adjacent_stem', tier: 'B', deadlineInheritsFrom: undefined }),
    );
    expect(p.aiPolicy.stance).toBe('permitted_with_disclosure');
    expect(p.aiPolicy.url).toContain('nsf.gov');
  });
});

describe('the resulting Program is complete', () => {
  it('populates every non-optional field of the contract shape', () => {
    const p: Program = normalizeRaw(raw(), ctx());
    expect(typeof p.summary).toBe('string');
    expect(Array.isArray(p.applicantEntities)).toBe(true);
    expect(Array.isArray(p.constraints)).toBe(true);
    expect(Array.isArray(p.fundingRestrictions)).toBe(true);
    expect(Array.isArray(p.tags)).toBe(true);
    expect(typeof p.obligations.costShareRequired).toBe('boolean');
    expect(typeof p.obligations.coFunderPreference).toBe('boolean');
    expect(typeof p.rawOtherText).toBe('string');
  });

  it('never emits a summary that is a full text dump', () => {
    const long = 'x'.repeat(5000);
    const p = normalizeRaw(raw({ rawText: long }), ctx());
    expect(p.summary.length).toBeLessThanOrEqual(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/normalize/
```

Expected failure: `Failed to resolve import "./index.js" from "packages/server/src/normalize/index.test.ts"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/normalize/disputed.ts`:

```ts
import type { Disputed } from '@grantspotter/core';

/**
 * Stable key for a record, independent of how its Program id was decided. RESOLUTIONS R9 means
 * the same record carries a minted id on a fresh database and the seeded id once Plan 5's corpus
 * is imported, so an id is NOT a safe key for a curated override. (sourceId, externalKey) is.
 * Pure by construction — no import, no hashing, no node: anything.
 */
export function sourceKeyOf(sourceId: string, externalKey: string): string {
  return `${sourceId}::${externalKey}`;
}

/**
 * Ships populated, per spec §8. The ARRL Club Grant cycle is the one record where three
 * researchers reached three different conclusions on 2026-08-02 and the page publishes no
 * deadline field at all. The record shows every reading with its source instead of picking one.
 */
export const DISPUTED_OVERRIDES: Readonly<Record<string, Disputed>> = Object.freeze({
  [sourceKeyOf('arrl-club-grant', 'club-grant-program')]: {
    note:
      'Three independent readings of the ARRL Club Grant cycle on 2026-08-02, and the page ' +
      'publishes no deadline field. Shown unresolved rather than guessed, because a ' +
      'confidently-displayed wrong deadline is worse than no deadline.',
    claims: [
      {
        claim:
          'Dormant: the page shows only 2024 results, with no open cycle and no application link.',
        sourceUrl: 'https://www.arrl.org/club-grant-program',
      },
      {
        claim:
          'Autumn window: historically September 7 to November 4, with 2022 wording "open until November 4".',
        sourceUrl: 'https://www.arrl.org/club-grant-program',
      },
      {
        claim:
          'February 1-28 / June 1-30 / October 1-31, which is probably a conflation with the separate ARRL Amateur Radio Grants cycle.',
        sourceUrl: 'http://www.arrl.org/amateur-radio-grants',
      },
    ],
  },
});
```

Create `packages/server/src/normalize/deadline.ts`:

```ts
import type {
  DeadlineKind,
  DeadlineSpec,
  Instrument,
  ProgramStatus,
  RawOpportunity,
} from '@grantspotter/core';
import { RECURRENCE_PREFIX } from '@grantspotter/core';
import type { NormalizeContext } from './index.js';

/**
 * sourceId -> the CANONICAL Program id whose cycle its records inherit (RESOLUTIONS R9: Plan 4's
 * id list is canonical and Plan 5's seed corpus owns identity, so these are literals, never
 * minted ids). All 111 ARRL catalog entries share ONE deadline, owned by the ARRL Foundation
 * Scholarship Program. QCWA's intake is that same ARRL portal, so QCWA's real deadline lives
 * inside the ARRL cycle too.
 *
 * This only resolves if the seeded `arrl-foundation-scholarships` record carries
 * `sourceKey: { sourceId: 'arrl-scholarship-program', externalKey: 'scholarship-program' }`,
 * which is what makes `ctx.existingIdFor` hand this crawler that id instead of minting one.
 */
export const DEADLINE_INHERITANCE: Readonly<Record<string, string>> = Object.freeze({
  'arrl-scholarship-descriptions': 'arrl-foundation-scholarships',
  qcwa: 'arrl-foundation-scholarships',
});

/**
 * sourceId -> the RECUR directive that goes in DeadlineSpec.note (CONTRACT §10.1, RESOLUTIONS
 * R12). CONTRACT §3 freezes DeadlineSpec as { kind, source, note } with nowhere to put "which
 * four dates", so Plan 1 Task 5 defines this micro-format inside `note` and `parseRecurrence`
 * reads it back. THESE ARE LOAD-BEARING: `expandCycles` projects nothing without a directive,
 * so omitting them silently empties the calendar for the three programs that matter most.
 *
 * Everything after the first ` | ` is human prose the parser ignores. The directive kind MUST
 * equal the DeadlineKind we emit, or Plan 1 ignores it by design (a copy-paste accident must
 * not be able to invent deadlines) — `noteFor` below enforces that.
 */
export const RECURRENCE_BY_SOURCE: Readonly<Record<string, string>> = Object.freeze({
  'ardc-grants':
    'RECUR n_fixed_dates tz=America/Los_Angeles dates=02-01,04-01,07-01,09-01 | ' +
    'Applications arriving after Sep 1 roll to the next Feb 1 cycle. ARDC evaluates for 60–120 days.',
  'arrl-amateur-radio-grants':
    'RECUR n_fixed_windows tz=America/New_York windows=02-01..02-28,06-01..06-30,10-01..10-31 | ' +
    'Three windows a year. Generally not more than $3,000, up to $5,000 in 2026.',
  'arrl-scholarship-program':
    'RECUR annual_window tz=America/New_York window=10-30..12-30 close=12:00 | ' +
    'Opens about Oct 30 and closes Dec 30 at 12:00 PM Eastern. Moved from Jan 31 — never ' +
    'hardcode the old date.',
});

const KIND_BY_SOURCE: Readonly<Record<string, DeadlineKind>> = Object.freeze({
  'ardc-grants': 'n_fixed_dates',           // Feb 1, Apr 1, Jul 1, Sep 1
  'arrl-amateur-radio-grants': 'n_fixed_windows', // Feb 1-28, Jun 1-30, Oct 1-31
  'arrl-scholarship-program': 'annual_window',    // opens ~Oct 30, closes ~Dec 30 12:00 EST
  'arrl-etp-grants': 'annual_window',             // Oct 1-31
  'arrl-club-grant': 'unpublished',
  ariss: 'quarterly_rewritten',
  'yaesu-dr2x': 'ad_hoc',
  'ncdxf-grants': 'rolling',
  'ncdxf-scholarships': 'unpublished',
  sara: 'rolling',
  'austin-arc': 'annual_window',
  ylrl: 'annual_window',
  'ieee-mtts': 'annual_window',
  'ieee-student-branch-rebate': 'annual_window',
  'nasa-csli': 'unpublished',
  'ardc-award-tables': 'dormant',
});

const NOTE_BY_KIND: Readonly<Record<DeadlineKind, string>> = Object.freeze({
  n_fixed_dates: 'Fixed application dates published by the funder.',
  n_fixed_windows: 'Fixed application windows published by the funder.',
  annual_window: 'A single annual window with an open date and a close date.',
  rolling: 'Applications are accepted at any time; the funder publishes no deadline.',
  quarterly_rewritten: 'One window sentence rewritten quarterly at a stable URL.',
  ad_hoc: 'Irregular windows announced by the funder with no fixed schedule.',
  inherited: 'This record has no deadline of its own; it rides another program’s cycle.',
  unpublished:
    'The funder has never published a deadline for this program. Deliberately left unresolved ' +
    'rather than guessed.',
  no_application_exists: 'There is no application and no deadline; the funder selects recipients.',
  dormant: 'Historical record; no live cycle.',
});

/**
 * The RECUR directive when this source has one AND it describes the kind we are about to emit;
 * the plain human note otherwise. The kind check is what stops a directive from leaking onto a
 * record whose kind was overridden by `rawFields.deadlineKind`.
 */
function noteFor(sourceId: string, kind: DeadlineKind): string {
  const directive = RECURRENCE_BY_SOURCE[sourceId];
  if (directive !== undefined && directive.startsWith(`${RECURRENCE_PREFIX}${kind} `)) {
    return directive;
  }
  return NOTE_BY_KIND[kind] ?? '';
}

export function inferDeadline(raw: RawOpportunity, ctx: NormalizeContext): DeadlineSpec {
  const declared = raw.rawFields.deadlineKind as DeadlineKind | undefined;
  if (declared) {
    return { kind: declared, source: { kind: 'self' }, note: noteFor(ctx.sourceId, declared) };
  }
  if (ctx.deadlineInheritsFrom) {
    return {
      kind: 'inherited',
      source: { kind: 'inherited', fromProgramId: ctx.deadlineInheritsFrom },
      note: NOTE_BY_KIND.inherited,
    };
  }
  const kind = KIND_BY_SOURCE[ctx.sourceId] ?? 'unpublished';
  return { kind, source: { kind: 'self' }, note: noteFor(ctx.sourceId, kind) };
}

export function inferStatus(raw: RawOpportunity, ctx: NormalizeContext): ProgramStatus {
  switch (raw.rawFields.recordType) {
    case 'past_award':
      return 'closed';
    case 'verified_negative':
      return 'discontinued';
    case 'crosscheck':
      return 'unknown';
    default:
      break;
  }
  if (raw.rawFields.deadlineKind === 'no_application_exists') return 'no_application';
  if (ctx.sourceId === 'rca-scholarship-program' || raw.rawFields.applicantEntity === 'nominated_by_institution') {
    return 'contact_only';
  }
  if (ctx.sourceId === 'nasa-csli' || ctx.sourceId === 'arrl-club-grant') return 'unknown';
  return 'open';
}

const INSTRUMENT_BY_SOURCE: Readonly<Record<string, Instrument>> = Object.freeze({
  'yaesu-dr2x': 'discounted_purchase',
  ariss: 'in_kind_service',
  'nasa-csli': 'in_kind_service',
  sara: 'in_kind_equipment',
  'arrl-etp-grants': 'in_kind_equipment',
  'ieee-student-branch-rebate': 'per_member_rebate',
  'ncdxf-scholarships': 'tuition_coverage',
});

export function inferInstrument(raw: RawOpportunity, ctx: NormalizeContext): Instrument {
  const bySource = INSTRUMENT_BY_SOURCE[ctx.sourceId];
  if (bySource) return bySource;
  const amountRaw = raw.rawFields['Award Amount'] ?? raw.rawFields.amountRaw ?? raw.rawFields.amount ?? '';
  if (amountRaw === '' || /^TBD$/i.test(amountRaw.trim())) return 'unknown';
  // 20 x $25,000, 4 x $15,000 ... — ARDC's tiered block is the only one in the corpus.
  if (/\$[\d,]+\s*,\s*\$[\d,]+\s*,\s*\$[\d,]+/.test(amountRaw)) return 'cash_tiered_blocks';
  if (/\bto\b|[-–]/.test(amountRaw) && (amountRaw.match(/\$/g) ?? []).length >= 2) return 'cash_range';
  if (amountRaw.includes('$')) return 'cash_fixed';
  return 'unknown';
}
```

Create `packages/server/src/normalize/index.ts`:

```ts
import type {
  AiPolicy,
  AmountSpec,
  ApplicantEntity,
  ApplyVia,
  OpportunityClass,
  Obligations,
  Program,
  RawOpportunity,
  SourceTier,
  VerificationMethod,
} from '@grantspotter/core';
import { hashProgram, parseAmount } from '@grantspotter/core';
import { extractConstraints } from './axes/index.js';
import { inferDeadline, inferInstrument, inferStatus } from './deadline.js';
import { DISPUTED_OVERRIDES, sourceKeyOf } from './disputed.js';

export interface NormalizeContext {
  sourceId: string;
  funderId: string;
  klass: OpportunityClass;
  tier: SourceTier;
  nowISO: string;
  deadlineInheritsFrom?: string;
  verificationMethod: VerificationMethod;
  /**
   * Injected, not imported: `programIdFor` lives in ../sources/util/ids.ts and uses node:crypto,
   * and spec §14 requires normalize/ to be pure. Task 25's crawl/context.ts supplies it.
   */
  mintId: (sourceId: string, externalKey: string) => string;
  /**
   * RESOLUTIONS R9. Returns the id of an already-stored program with this source key, if any.
   * Task 25 wires it to Plan 1's createProgramRepo(db).findBySourceKey(). Without it the crawler
   * mints a fresh id every night, `diffPrograms` sees the whole seeded corpus vanish and the
   * whole crawled corpus appear, and it does that forever.
   */
  existingIdFor?: (sourceId: string, externalKey: string) => string | undefined;
}

const OBLIGATIONS_BY_SOURCE: Readonly<Record<string, Partial<Obligations>>> = Object.freeze({
  'ardc-grants': {
    licenseObligation:
      'All output must be open-source or open-access (GPL, MIT, BSD, CERN-OHL, Creative Commons).',
    indirectCostCapPct: 20,
  },
  'ardc-award-tables': { indirectCostCapPct: 20 },
  'arrl-amateur-radio-grants': { coFunderPreference: true },
  'arrl-club-grant': { coFunderPreference: true },
  'yaesu-dr2x': { sustainmentObligation: 'The repeater must remain on the air for 12 months.' },
  // NCDXF expects the applicant to have a personal stake in the DXpedition it part-funds.
  'ncdxf-grants': { costShareRequired: true },
});

/**
 * Per-record obligations, keyed by sourceKeyOf(sourceId, externalKey). `manual-tier-d` carries
 * many different funders' records under one source id, so a source-level entry cannot express
 * "YASME reports, the others do not".
 *
 * This exists because seed records re-enter this same pipeline whenever a human presses
 * "Verify now" (Plan 3 Task 10). An obligation that only ever existed as a literal in Plan 5's
 * seed JSON is an obligation that gets silently dropped on the first re-verify.
 */
const OBLIGATIONS_BY_RECORD: Readonly<Record<string, Partial<Obligations>>> = Object.freeze({
  [sourceKeyOf('manual-tier-d', 'yasme-supporting-grants')]: {
    reportingObligation: 'Year-end activity report to the YASME Foundation board.',
  },
  [sourceKeyOf('manual-tier-d', 'ncdxf-dxpedition-grants')]: { costShareRequired: true },
});

const RESTRICTIONS_BY_SOURCE: Readonly<Record<string, string[]>> = Object.freeze({
  'arrl-amateur-radio-grants': [
    'Does not fund emergency communications equipment.',
    'Does not fund ongoing operating expenses.',
  ],
  'arrl-club-grant': ['Does not fund ongoing operating expenses.'],
  'ncdxf-grants': ['Does not fund commercial transport.'],
});

const AI_POLICY_BY_FUNDER: Readonly<Record<string, AiPolicy>> = Object.freeze({
  ardc: {
    stance: 'permitted',
    quote:
      'If you choose to use AI when writing your proposal be sure to thoroughly edit for ' +
      'clarity, brevity, and accuracy. If the proposal is extremely long and hard to ' +
      'understand, we can’t evaluate or support it.',
    url: 'https://www.ardc.net/apply/grant-application-instructions/',
  },
  nsf: {
    stance: 'permitted_with_disclosure',
    quote:
      'Proposers are encouraged to indicate in the project description the extent to which, if ' +
      'any, generative AI technology was used.',
    url: 'https://www.nsf.gov/policies/ai/merit-review',
  },
  'arrl-foundation': {
    stance: 'unaddressed',
    quote: undefined,
    url: 'https://www.arrl.org/files/file/Foundation/Grant%20Application%20Form.pdf',
  },
  arrl: { stance: 'unaddressed', url: 'http://www.arrl.org/' },
});

const APPLY_VIA_BY_SOURCE: Readonly<Record<string, ApplyVia>> = Object.freeze({
  'ardc-grants': 'external_spa_portal',
  'arrl-scholarship-descriptions': 'external_spa_portal',
  'arrl-scholarship-program': 'external_spa_portal',
  qcwa: 'external_spa_portal',
  'arrl-club-grant': 'external_spa_portal',
  'arrl-etp-grants': 'jotform_year_keyed',
  'ieee-mtts': 'jotform_year_keyed',
  'austin-arc': 'self_hosted_portal',
  'ncdxf-grants': 'email_pdf_packet',
  sara: 'email_pdf_packet',
  'manual-tier-d': 'contact_person',
  'ardc-award-tables': 'none',
});

const ENTITIES_BY_SOURCE: Readonly<Record<string, ApplicantEntity[]>> = Object.freeze({
  'ardc-grants': ['club_via_fiscal_sponsor', 'club_501c3', 'school_lea', 'university', 'university_dept'],
  'arrl-amateur-radio-grants': ['club_unincorporated', 'club_501c3', 'school_lea', 'university'],
  'arrl-club-grant': ['club_unincorporated', 'club_501c3'],
  'arrl-etp-grants': ['teacher', 'school_lea'],
  'arrl-scholarship-descriptions': ['individual'],
  'arrl-scholarship-program': ['individual'],
  qcwa: ['individual'],
  ylrl: ['individual'],
  'austin-arc': ['individual'],
  'ncdxf-scholarships': ['individual'],
  ariss: ['school_lea', 'university'],
  'ieee-mtts': ['ieee_student_branch_chapter'],
  'ieee-student-branch-rebate': ['ieee_student_branch_chapter'],
  'nasa-csli': ['university', 'school_lea'],
  'yaesu-dr2x': ['club_unincorporated', 'club_501c3', 'individual'],
  sara: ['individual', 'teacher', 'school_lea'],
});

function firstOf(fields: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const value = fields[key];
    if (value !== undefined && value.trim() !== '') return value;
  }
  return '';
}

function buildSummary(raw: RawOpportunity): string {
  // Our own short excerpt, never a full text dump. Facts are not copyrightable; long verbatim
  // descriptions are a different matter.
  const source = firstOf(raw.rawFields, ['summary', 'audience', 'eligibility', '__preamble']) || raw.rawText;
  const oneLine = source.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 400 ? oneLine : `${oneLine.slice(0, 397)}...`;
}

function buildAmount(raw: RawOpportunity, ctx: NormalizeContext): AmountSpec {
  const amountRaw = firstOf(raw.rawFields, ['Award Amount', 'amountRaw', 'amount', 'pricing']);
  const awardCountRaw = firstOf(raw.rawFields, ['Number of Awards', 'awardCountRaw']);
  const parsed = amountRaw === '' ? {} : parseAmount(amountRaw);
  return {
    instrument: inferInstrument(raw, ctx),
    amountMin: parsed.amountMin,
    amountMax: parsed.amountMax,
    tiers: parsed.tiers,
    amountRaw,
    awardCountRaw,
  };
}

function buildRawOtherText(raw: RawOpportunity): string {
  const parts = [raw.rawFields.Other, raw.rawFields.rawOtherText].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  if (parts.length > 0) return parts.join('\n');
  // No modelled Other field: keep the whole flattened body rather than losing an unmodelled
  // requirement such as "preference to a student ham from a ham family".
  return raw.rawText.trim();
}

function buildTags(raw: RawOpportunity, ctx: NormalizeContext): string[] {
  // `source:` and `key:` together ARE the ingest identity (RESOLUTIONS R1/R9). CONTRACT §3's
  // Program has no field for them, and review/index.ts reads them back out of here on approval
  // so the record lands in programs.source_id / programs.external_key. diffPrograms ignores
  // tags-only changes, so carrying them costs nothing.
  const tags = new Set<string>([
    `tier:${ctx.tier}`,
    `source:${ctx.sourceId}`,
    `key:${raw.externalKey}`,
  ]);
  const recordType = raw.rawFields.recordType;
  if (recordType) tags.add(recordType);
  if (recordType === 'crosscheck') tags.add('do_not_publish');
  if (raw.rawFields.year) tags.add(`year:${raw.rawFields.year}`);
  return [...tags];
}

export function normalizeRaw(raw: RawOpportunity, ctx: NormalizeContext): Program {
  // RESOLUTIONS R9: the SEED CORPUS owns identity. Ask for an already-stored id under this
  // source key before minting a new one, or every night's crawl duplicates every seeded record.
  const id = ctx.existingIdFor?.(ctx.sourceId, raw.externalKey)
    ?? ctx.mintId(ctx.sourceId, raw.externalKey);
  const recordKey = sourceKeyOf(ctx.sourceId, raw.externalKey);
  const obligations: Obligations = {
    costShareRequired: false,
    coFunderPreference: false,
    ...OBLIGATIONS_BY_SOURCE[ctx.sourceId],
    ...OBLIGATIONS_BY_RECORD[recordKey],
  };

  const program: Program = {
    id,
    funderId: ctx.funderId,
    name: raw.name,
    klass: ctx.klass,
    summary: buildSummary(raw),
    applicantEntities: ENTITIES_BY_SOURCE[ctx.sourceId] ?? [],
    amount: buildAmount(raw, ctx),
    deadline: inferDeadline(raw, ctx),
    applyVia: APPLY_VIA_BY_SOURCE[ctx.sourceId] ?? 'page_form',
    applyUrl: raw.rawFields.formUrl ?? raw.rawFields.detailUrl ?? raw.sourceUrl,
    applyContact: raw.rawFields.applyNote,
    constraints: extractConstraints(raw),
    fundingRestrictions: RESTRICTIONS_BY_SOURCE[ctx.sourceId] ?? [],
    obligations,
    aiPolicy: AI_POLICY_BY_FUNDER[ctx.funderId] ?? { stance: 'unaddressed' },
    trust: {
      status: inferStatus(raw, ctx),
      sourceUrl: raw.sourceUrl,
      lastVerifiedAt: ctx.nowISO,
      verificationMethod: ctx.verificationMethod,
      contentHash: '',
      disputed: DISPUTED_OVERRIDES[recordKey],
      staleMirrorWarning: raw.rawFields.staleMirrorWarning,
    },
    rawOtherText: buildRawOtherText(raw),
    tags: buildTags(raw, ctx),
  };

  // Computed LAST, and hashProgram excludes TrustFields by contract — lastVerifiedAt moves
  // every night, so including it would mark every record changed every night.
  program.trust.contentHash = hashProgram(program);
  return program;
}
```

`extractConstraints` does not exist yet — Task 17 creates it. Create a temporary stub so this task's tests can run, and Task 17 replaces its body:

```ts
// packages/server/src/normalize/axes/index.ts  (stub; Task 17 fills this in)
import type { Constraint, RawOpportunity } from '@grantspotter/core';

export function extractConstraints(_raw: RawOpportunity): Constraint[] {
  return [];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/normalize/ && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/normalize
git commit -m "feat(normalize): RawOpportunity to Program with deadline inheritance and populated disputed claims"
```

---

### Task 17: `normalize/axes/` part 1 — license, geography, field of study, institution, GPA

**Files:**
- Create: `packages/server/src/normalize/axes/index.ts` (replaces the Task 16 stub)
- Create: `packages/server/src/normalize/axes/license.ts`
- Create: `packages/server/src/normalize/axes/geography.ts`
- Create: `packages/server/src/normalize/axes/fieldOfStudy.ts`
- Create: `packages/server/src/normalize/axes/institution.ts`
- Create: `packages/server/src/normalize/axes/gpa.ts`
- Create: `packages/server/src/normalize/axes/preference.ts`
- Create: `packages/server/src/normalize/axes/radiusCenters.ts` (inlined frozen constant — the *code* copy)
- Create: `data/reference/radius-centers.json` (the reviewable *data* copy)
- Test: `packages/server/src/normalize/axes/part1.test.ts`
- Test: `packages/server/src/normalize/purity.test.ts`

**Interfaces:**
- Consumes: `Constraint`, `ConstraintSpec`, `GeoSpec`, `LicenseClass`, `DegreeLevel`, `RawOpportunity` from core.
- Produces:
  ```ts
  export type AxisExtractor = (raw: RawOpportunity) => Constraint[];
  export function extractConstraints(raw: RawOpportunity): Constraint[];   // runs every extractor
  export function isPreferenceText(text: string): boolean;
  export function cascadeRank(text: string): number;
  export function makeConstraint(axis: string, rawText: string, spec: ConstraintSpec, index: number): Constraint;
  export function stableSuffix(input: string): string;   // pure FNV-1a; no node:crypto
  export function extractLicense(raw: RawOpportunity): Constraint[];
  export function extractGeography(raw: RawOpportunity): Constraint[];
  export function extractFieldOfStudy(raw: RawOpportunity): Constraint[];
  export function extractInstitution(raw: RawOpportunity): Constraint[];
  export function extractGpa(raw: RawOpportunity): Constraint[];
  export const RADIUS_CENTERS: Readonly<Record<string, { lat: number; lon: number }>>;   // radiusCenters.ts
  ```

**`normalize/` is pure and this task is where that gets enforced** (spec §14, coverage finding #12). `core/` has a purity gate in Plan 1 Task 1 and `normalize/` gets the same treatment here: **no file under `packages/server/src/normalize/` may contain a `node:` import.** That has two concrete consequences, both implemented below:

- `RADIUS_CENTERS` is an **inlined frozen TS constant** in `axes/radiusCenters.ts`, mirroring Plan 1's `arrlSections.ts` pattern, instead of `readFileSync`-ing `data/reference/radius-centers.json` at module load. The JSON file stays as the reviewable source of truth and a test asserts the two agree entry-for-entry, so an edit to one that is not mirrored into the other fails the suite.
- `makeConstraint` derives its id suffix with a **pure FNV-1a hash**, not `node:crypto`. Constraint ids are namespacing, not security: they only have to be stable and collision-resistant within one program's constraint list.

**The rule that makes or breaks the matcher.** Every constraint carries `hard: boolean` and `fallbackRank: number`, because **nearly every axis appears in both requirement and preference form**, frequently as an explicit cascade: *"Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, …"*. Treating that as a hard filter wrongly excludes eligible students. `isPreferenceText` detects the preference form; `cascadeRank` orders the cascade (0 = primary preference, 1 = the "if no qualified applicant" fallback, and so on).

**Geography has five incompatible shapes** and the radius examples are real: *"within 250 miles of Seaford, Delaware"*, *"within 70 miles of Schenectady, NY"*, *"within 175 miles of Erving, MA"*. We do **not** geocode at runtime — there is no network on the read path — so `data/reference/radius-centers.json` (mirrored into `axes/radiusCenters.ts`, which is what the code imports) ships approximate place centroids for the known centres, and an unknown centre yields a `GeoSpec` with `centerLabel` set and `centerLat`/`centerLon` left undefined, which the matcher (Plan 1) reports as `unknown` rather than `ineligible`.

- [ ] **Step 1: Write the reference data**

Create `data/reference/radius-centers.json`. Coordinates are approximate US Census place centroids, and the file says so:

```json
{
  "_note": "Approximate place centroids for the radius-based scholarship regions observed in the ARRL catalog. Used only to test radius membership; never rendered as an exact location.",
  "_source": "US Census Gazetteer place centroids (approximate, rounded to 4 decimals)",
  "seaford, delaware": { "lat": 38.6412, "lon": -75.6116 },
  "schenectady, ny": { "lat": 42.8142, "lon": -73.9396 },
  "erving, ma": { "lat": 42.5987, "lon": -72.4009 }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/normalize/axes/part1.test.ts`:

```ts
import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import {
  cascadeRank,
  extractConstraints,
  extractFieldOfStudy,
  extractGpa,
  extractInstitution,
  extractLicense,
  isPreferenceText,
} from './index.js';
import { extractGeography } from './geography.js';

const raw = (fields: Record<string, string>, rawText = ''): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: rawText || Object.values(fields).join('\n'),
});

describe('isPreferenceText and cascadeRank', () => {
  it('detects preference language in all its observed forms', () => {
    expect(isPreferenceText('Preference will be given to applicants residing in Louisiana.')).toBe(true);
    expect(isPreferenceText('Preferred: General class or higher.')).toBe(true);
    expect(isPreferenceText('Applicants who prefer CW are encouraged to apply.')).toBe(true);
    expect(isPreferenceText('ARDC gives preference to a GPA over 3.5.')).toBe(true);
  });

  it('does not treat a plain requirement as a preference', () => {
    expect(isPreferenceText('Applicant must hold a General class license.')).toBe(false);
    expect(isPreferenceText('Any accredited institution.')).toBe(false);
  });

  it('ranks an explicit cascade after the primary preference', () => {
    expect(cascadeRank('Preference will be given to applicants residing in Louisiana.')).toBe(0);
    expect(
      cascadeRank(
        'Preference to Louisiana. If no qualified applicant is identified, the award is open to any eligible applicant.',
      ),
    ).toBe(1);
  });
});

describe('extractLicense', () => {
  it('reads the four license classes', () => {
    expect(extractLicense(raw({ 'License Requirement': 'Any' }))[0].spec).toMatchObject({
      axis: 'license',
      licenseMin: 'NONE',
    });
    expect(extractLicense(raw({ 'License Requirement': 'Technician or higher' }))[0].spec).toMatchObject({
      licenseMin: 'TECH',
    });
    expect(extractLicense(raw({ 'License Requirement': 'General or higher' }))[0].spec).toMatchObject({
      licenseMin: 'GENERAL',
    });
    expect(extractLicense(raw({ 'License Requirement': 'Amateur Extra' }))[0].spec).toMatchObject({
      licenseMin: 'EXTRA',
    });
  });

  it('treats Novice as Technician, the modern equivalent floor', () => {
    expect(extractLicense(raw({ 'License Requirement': 'Novice or higher' }))[0].spec).toMatchObject({
      licenseMin: 'TECH',
    });
  });

  it('reads a held-duration requirement in years and months', () => {
    expect(extractLicense(raw({ 'License Requirement': 'licensed at least one year' }))[0].spec).toMatchObject({
      heldMonthsMin: 12,
    });
    expect(extractLicense(raw({ 'License Requirement': 'licensed at least two years' }))[0].spec).toMatchObject({
      heldMonthsMin: 24,
    });
    expect(extractLicense(raw({ 'License Requirement': 'licensed for 18 months' }))[0].spec).toMatchObject({
      heldMonthsMin: 18,
    });
  });

  it('flags a foreign licence as acceptable when the text says so', () => {
    const c = extractLicense(raw({ 'License Requirement': 'Any class; US licensure not required, worldwide' }));
    expect(c[0].spec).toMatchObject({ foreignLicenseOK: true });
  });

  it('marks a preference-form licence soft, never a bar', () => {
    const c = extractLicense(raw({ 'License Requirement': 'Preference given to General class or higher.' }));
    expect(c[0].hard).toBe(false);
    expect(c[0].spec).toMatchObject({ licenseMin: 'GENERAL' });
  });

  it('always preserves the source text verbatim on the constraint', () => {
    const text = 'General or higher, licensed at least two years';
    expect(extractLicense(raw({ 'License Requirement': text }))[0].rawText).toBe(text);
  });

  it('returns [] when the source publishes no licence field', () => {
    expect(extractLicense(raw({}))).toEqual([]);
  });
});

describe('extractGeography — five incompatible shapes', () => {
  it('reads "Any" as type any', () => {
    expect(extractGeography(raw({ Region: 'Any' }))[0].spec).toMatchObject({
      axis: 'geography',
      geo: { type: 'any' },
    });
  });

  it('reads a state list', () => {
    const spec = extractGeography(raw({ Region: 'Illinois, Indiana and Wisconsin' }))[0].spec;
    expect(spec).toMatchObject({ geo: { type: 'state' } });
    expect((spec as { geo: { values: string[] } }).geo.values.sort()).toEqual(['IL', 'IN', 'WI']);
  });

  it('reads an ARRL Division', () => {
    expect(extractGeography(raw({ Region: 'ARRL Central Division (IL, IN, WI)' }))[0].spec).toMatchObject({
      geo: { type: 'arrl_division', values: ['Central'] },
    });
  });

  it('reads an ARRL Section', () => {
    expect(extractGeography(raw({ Region: 'Northern Florida Section' }))[0].spec).toMatchObject({
      geo: { type: 'arrl_section', values: ['Northern Florida'] },
    });
  });

  it('reads a county list', () => {
    const spec = extractGeography(
      raw({ Region: 'Travis, Williamson or Hays county, Texas' }),
    )[0].spec as { geo: { type: string; values: string[] } };
    expect(spec.geo.type).toBe('county');
    expect(spec.geo.values.length).toBeGreaterThanOrEqual(3);
  });

  it('reads a call district', () => {
    expect(extractGeography(raw({ Region: 'Applicants in the 5th call district' }))[0].spec).toMatchObject({
      geo: { type: 'call_district', values: ['5'] },
    });
  });

  it('reads all three real radius forms and fills coordinates from the gazetteer', () => {
    const cases: Array<[string, number, string]> = [
      ['Residing within 250 miles of Seaford, Delaware', 250, 'Seaford, Delaware'],
      ['Within 70 miles of Schenectady, NY', 70, 'Schenectady, NY'],
      ['within 175 miles of Erving, MA', 175, 'Erving, MA'],
    ];
    for (const [text, miles, label] of cases) {
      const spec = extractGeography(raw({ Region: text }))[0].spec as {
        geo: { type: string; radiusMiles?: number; centerLabel?: string; centerLat?: number };
      };
      expect(spec.geo.type).toBe('radius');
      expect(spec.geo.radiusMiles).toBe(miles);
      expect(spec.geo.centerLabel).toBe(label);
      expect(typeof spec.geo.centerLat).toBe('number');
    }
  });

  it('leaves coordinates undefined for an unknown centre rather than inventing them', () => {
    const spec = extractGeography(raw({ Region: 'within 30 miles of Nowhereville, ZZ' }))[0].spec as {
      geo: { centerLat?: number; centerLon?: number; centerLabel?: string };
    };
    expect(spec.geo.centerLat).toBeUndefined();
    expect(spec.geo.centerLon).toBeUndefined();
    expect(spec.geo.centerLabel).toBe('Nowhereville, ZZ');
  });

  it('marks the Louisiana cascade soft with fallbackRank 1 on the fallback clause', () => {
    const cs = extractGeography(
      raw({
        Region:
          'Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, the award is open to any eligible applicant.',
      }),
    );
    expect(cs[0].hard).toBe(false);
    expect(cs[0].fallbackRank).toBe(1);
  });
});

describe('extractFieldOfStudy', () => {
  it('reads a plain field list', () => {
    expect(extractFieldOfStudy(raw({ 'Field of Study': 'Electrical Engineering' }))[0].spec).toMatchObject({
      axis: 'field_of_study',
      fields: ['Electrical Engineering'],
      excludedFields: [],
    });
  });

  it('reads "Any" as an empty required list, which means unconstrained', () => {
    expect(extractFieldOfStudy(raw({ 'Field of Study': 'Any' }))[0].spec).toMatchObject({
      fields: [],
      excludedFields: [],
    });
  });

  it('reads the one real exclusion: "Any, except for Liberal Arts"', () => {
    expect(
      extractFieldOfStudy(raw({ 'Field of Study': 'Any, except for Liberal Arts' }))[0].spec,
    ).toMatchObject({ fields: [], excludedFields: ['Liberal Arts'] });
  });

  it('splits a multi-field list on commas, slashes and "or"', () => {
    const spec = extractFieldOfStudy(
      raw({ 'Field of Study': 'Sciences, Engineering or Computer Science' }),
    )[0].spec as { fields: string[] };
    expect(spec.fields).toEqual(['Sciences', 'Engineering', 'Computer Science']);
  });
});

describe('extractInstitution', () => {
  it('reads degree levels, trade school, part-time and accreditation', () => {
    const spec = extractInstitution(
      raw({ Institution: 'Accredited two-year, four-year or graduate program; trade schools accepted; part-time OK' }),
    )[0].spec as {
      degreeLevels: string[];
      tradeSchoolOK: boolean;
      partTimeOK: boolean;
      accreditationRequired: boolean;
    };
    expect(spec.degreeLevels.sort()).toEqual(['ASSOC', 'BACH', 'GRAD']);
    expect(spec.tradeSchoolOK).toBe(true);
    expect(spec.partTimeOK).toBe(true);
    expect(spec.accreditationRequired).toBe(true);
  });

  it('defaults part-time to false and accreditation to false when unstated', () => {
    const spec = extractInstitution(raw({ Institution: 'Any institution' }))[0].spec as {
      partTimeOK: boolean;
      accreditationRequired: boolean;
    };
    expect(spec.partTimeOK).toBe(false);
    expect(spec.accreditationRequired).toBe(false);
  });
});

describe('extractGpa', () => {
  it('reads a hard GPA floor', () => {
    const c = extractGpa(raw({ Other: 'A minimum GPA of 3.0 is required.' }));
    expect(c[0].hard).toBe(true);
    expect(c[0].spec).toMatchObject({ axis: 'gpa', min: 3 });
  });

  it('reads ARDC’s soft "preference over 3.5" as a preference, not a bar', () => {
    const c = extractGpa(raw({ Other: 'Preference is given to applicants with a GPA over 3.5.' }));
    expect(c[0].hard).toBe(false);
    expect(c[0].spec).toMatchObject({ min: 3.5 });
  });

  it('reads YASME’s class-rank proxy instead of a GPA', () => {
    const c = extractGpa(raw({ Other: 'Applicant must rank in the top 5 to 10 percent of the class.' }));
    expect(c[0].spec).toMatchObject({ axis: 'gpa', classRankTopPct: 10 });
  });

  it('returns [] when there is no GPA language at all', () => {
    expect(extractGpa(raw({ Other: 'Applicant must own a soldering iron.' }))).toEqual([]);
  });
});

describe('extractConstraints', () => {
  it('runs every part-1 extractor and gives each constraint a unique id', () => {
    const cs = extractConstraints(
      raw({
        'License Requirement': 'General or higher',
        Region: 'Any',
        'Field of Study': 'Engineering',
        Institution: 'Accredited four-year',
        Other: 'Minimum GPA of 2.5.',
      }),
    );
    const axes = cs.map((c) => (c.spec as { axis: string }).axis);
    expect(axes).toEqual(
      expect.arrayContaining(['license', 'geography', 'field_of_study', 'institution', 'gpa']),
    );
    expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length);
  });

  it('gives every constraint a non-empty verbatim rawText', () => {
    for (const c of extractConstraints(raw({ Region: 'Any', 'License Requirement': 'Any' }))) {
      expect(c.rawText.length).toBeGreaterThan(0);
    }
  });
});
```

Create `packages/server/src/normalize/purity.test.ts` — spec §14's "`core/` and `normalize/` are pure and get heavy unit coverage", made checkable:

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RADIUS_CENTERS } from './axes/radiusCenters.js';

const NORMALIZE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(NORMALIZE_DIR, '../../../..');

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(NORMALIZE_DIR, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
    .map((e) => path.join(e.parentPath ?? NORMALIZE_DIR, e.name));
}

describe('normalize/ is pure', () => {
  it('finds the modules it is about to check', async () => {
    expect((await sourceFiles()).length).toBeGreaterThan(5);
  });

  it('imports nothing from node:', async () => {
    for (const file of await sourceFiles()) {
      const src = await readFile(file, 'utf8');
      expect(src, `${file} must not import from node:`).not.toMatch(/from\s+'node:/);
      expect(src, `${file} must not require node:`).not.toMatch(/require\(['"]node:/);
    }
  });

  it('reads no file, no clock and no environment', async () => {
    for (const file of await sourceFiles()) {
      const src = await readFile(file, 'utf8');
      for (const forbidden of ['readFileSync', 'process.env', 'Date.now()', 'new Date(']) {
        expect(src, `${file} must not use ${forbidden} — inject it through NormalizeContext`)
          .not.toContain(forbidden);
      }
    }
  });

  it('reaches outside normalize/ only for @grantspotter/core', async () => {
    for (const file of await sourceFiles()) {
      const src = await readFile(file, 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) {
        const spec = m[1];
        if (spec === '@grantspotter/core') continue;
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\.?\//);
        expect(path.resolve(path.dirname(file), spec).startsWith(NORMALIZE_DIR)).toBe(true);
      }
    }
  });

  it('keeps radiusCenters.ts and data/reference/radius-centers.json in agreement', async () => {
    const json = JSON.parse(
      await readFile(path.join(REPO_ROOT, 'data/reference/radius-centers.json'), 'utf8'),
    ) as Record<string, unknown>;
    const fromJson = Object.fromEntries(
      Object.entries(json).filter(([key]) => !key.startsWith('_')),
    );
    expect(RADIUS_CENTERS).toEqual(fromJson);
    expect(Object.isFrozen(RADIUS_CENTERS)).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/normalize/axes/part1.test.ts
```

Expected failure: `Failed to resolve import "./geography.js"` and `Failed to resolve import "./axes/radiusCenters.js"`, plus assertion failures from the Task 16 stub returning `[]`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/normalize/axes/preference.ts`:

```ts
import type { Constraint, ConstraintSpec } from '@grantspotter/core';

const PREFERENCE = /\b(preference|preferred|prefers?|preferably|is given to|encouraged)\b/i;
const CASCADE = /\bif no (?:other )?qualified applicant/i;

/** Nearly every axis appears in both requirement and preference form. Soft never excludes. */
export function isPreferenceText(text: string): boolean {
  return PREFERENCE.test(text);
}

/** 0 = primary preference; 1 = the explicit "if no qualified applicant is identified" fallback. */
export function cascadeRank(text: string): number {
  return CASCADE.test(text) ? 1 : 0;
}

/**
 * FNV-1a, 32-bit, hex. Deliberately NOT node:crypto — normalize/ is pure (spec §14) and a
 * constraint id is namespacing, not security: it only has to be stable across runs and
 * collision-resistant inside one program's short constraint list.
 */
export function stableSuffix(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function makeConstraint(
  axis: string,
  rawText: string,
  spec: ConstraintSpec,
  index: number,
): Constraint {
  const soft = isPreferenceText(rawText);
  return {
    id: `${axis}-${index}-${stableSuffix(`${axis}|${rawText}`)}`,
    hard: !soft,
    fallbackRank: soft ? cascadeRank(rawText) : 0,
    rawText,
    spec,
  };
}
```

Create `packages/server/src/normalize/axes/license.ts`:

```ts
import type { Constraint, LicenseClass, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const WORD_MONTHS: Record<string, number> = { one: 12, two: 24, three: 36, four: 48, five: 60 };

function licenseMinFrom(text: string): LicenseClass {
  if (/\bextra\b/i.test(text)) return 'EXTRA';
  if (/\bgeneral\b/i.test(text)) return 'GENERAL';
  // Novice is a legacy class; Technician is the modern equivalent floor.
  if (/\b(technician|tech|novice)\b/i.test(text)) return 'TECH';
  return 'NONE';
}

function heldMonthsFrom(text: string): number | undefined {
  const numeric = /(\d+)\s*(year|month)s?/i.exec(text);
  if (numeric) {
    const n = Number.parseInt(numeric[1], 10);
    return /year/i.test(numeric[2]) ? n * 12 : n;
  }
  const worded = /\b(one|two|three|four|five)\s+(year|month)s?/i.exec(text);
  if (worded) {
    const base = WORD_MONTHS[worded[1].toLowerCase()];
    return /year/i.test(worded[2]) ? base : base / 12;
  }
  return undefined;
}

export function extractLicense(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields['License Requirement'] ?? raw.rawFields.license;
  if (!text || text.trim() === '') return [];
  const heldMonthsMin = heldMonthsFrom(text);
  const foreignLicenseOK =
    /\b(worldwide|foreign|international|US licensure (?:is )?not required|any country)\b/i.test(text) ||
    undefined;
  return [
    makeConstraint(
      'license',
      text,
      {
        axis: 'license',
        licenseMin: licenseMinFrom(text),
        ...(heldMonthsMin !== undefined ? { heldMonthsMin } : {}),
        ...(foreignLicenseOK ? { foreignLicenseOK } : {}),
      },
      0,
    ),
  ];
}
```

Create `packages/server/src/normalize/axes/radiusCenters.ts` — the inlined code copy of `data/reference/radius-centers.json`, mirroring Plan 1's `arrlSections.ts` pattern:

```ts
/**
 * Approximate place centroids for the radius-based scholarship regions observed in the ARRL
 * catalog ("within 250 miles of Seaford, Delaware", "within 70 miles of Schenectady, NY",
 * "within 175 miles of Erving, MA"). We never geocode at runtime — there is no network on this
 * path, and `normalize/` is pure (spec §14), so this is inlined rather than read from disk.
 *
 * `data/reference/radius-centers.json` is the reviewable copy of the same data. The two are
 * asserted equal by packages/server/src/normalize/purity.test.ts — edit BOTH or the suite fails.
 *
 * Source: US Census Gazetteer place centroids, rounded to 4 decimals. Used only to test radius
 * membership; never rendered as an exact location.
 */
export const RADIUS_CENTERS: Readonly<Record<string, { lat: number; lon: number }>> = Object.freeze({
  'seaford, delaware': { lat: 38.6412, lon: -75.6116 },
  'schenectady, ny': { lat: 42.8142, lon: -73.9396 },
  'erving, ma': { lat: 42.5987, lon: -72.4009 },
});
```

Create `packages/server/src/normalize/axes/geography.ts`:

```ts
import type { Constraint, GeoSpec, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';
import { RADIUS_CENTERS } from './radiusCenters.js';

const STATE_BY_NAME: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO',
  connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA',
  maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD',
  tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

const RADIUS = /within\s+(\d+)\s+miles\s+of\s+([A-Z][A-Za-z. ]*(?:,\s*[A-Za-z. ]+)?)/i;
const DIVISION = /\b(?:ARRL\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+Division\b/;
const SECTION = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+Section\b/;
const CALL_DISTRICT = /\b(\d)(?:st|nd|rd|th)?\s+call\s+(?:district|area)\b/i;
const COUNTY = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+count(?:y|ies)\b/i;

function geoFrom(text: string): GeoSpec {
  const radius = RADIUS.exec(text);
  if (radius) {
    const centerLabel = radius[2].replace(/\s+/g, ' ').trim().replace(/[.,]$/, '');
    const center = RADIUS_CENTERS[centerLabel.toLowerCase()];
    return {
      type: 'radius',
      values: [centerLabel],
      radiusMiles: Number.parseInt(radius[1], 10),
      centerLabel,
      ...(center ? { centerLat: center.lat, centerLon: center.lon } : {}),
    };
  }

  const callDistrict = CALL_DISTRICT.exec(text);
  if (callDistrict) return { type: 'call_district', values: [callDistrict[1]] };

  const division = DIVISION.exec(text);
  if (division) return { type: 'arrl_division', values: [division[1].trim()] };

  const section = SECTION.exec(text);
  if (section) return { type: 'arrl_section', values: [section[1].trim()] };

  if (COUNTY.test(text)) {
    const before = text.slice(0, COUNTY.exec(text)?.index ?? text.length);
    const names = `${before} ${COUNTY.exec(text)?.[1] ?? ''}`
      .split(/,|\bor\b|\band\b/i)
      .map((s) => s.replace(/[^A-Za-z ]/g, '').trim())
      .filter((s) => s.length > 2);
    return { type: 'county', values: [...new Set(names)] };
  }

  const states = new Set<string>();
  for (const [name, code] of Object.entries(STATE_BY_NAME)) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(text)) states.add(code);
  }
  for (const m of text.matchAll(/\b([A-Z]{2})\b/g)) {
    if (Object.values(STATE_BY_NAME).includes(m[1])) states.add(m[1]);
  }
  if (states.size > 0) return { type: 'state', values: [...states] };

  return { type: 'any', values: [] };
}

export function extractGeography(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields.Region ?? raw.rawFields.counties ?? raw.rawFields.region;
  if (!text || text.trim() === '') return [];
  return [makeConstraint('geography', text, { axis: 'geography', geo: geoFrom(text) }, 0)];
}
```

Create `packages/server/src/normalize/axes/fieldOfStudy.ts`:

```ts
import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const EXCEPT = /\bexcept(?:\s+for)?\b\s*(.+)$/i;

function splitFields(text: string): string[] {
  return text
    .split(/,|\/|\bor\b|\band\b/i)
    .map((s) => s.replace(/[.;]/g, '').trim())
    .filter((s) => s !== '' && !/^any$/i.test(s));
}

export function extractFieldOfStudy(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields['Field of Study'];
  if (!text || text.trim() === '') return [];
  const except = EXCEPT.exec(text);
  const excludedFields = except ? splitFields(except[1]) : [];
  const requiredPart = except ? text.slice(0, except.index) : text;
  const fields = /^\s*any\b/i.test(requiredPart) ? [] : splitFields(requiredPart);
  return [
    makeConstraint('field_of_study', text, { axis: 'field_of_study', fields, excludedFields }, 0),
  ];
}
```

Create `packages/server/src/normalize/axes/institution.ts`:

```ts
import type { Constraint, DegreeLevel, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

export function extractInstitution(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields.Institution;
  if (!text || text.trim() === '') return [];
  const levels = new Set<DegreeLevel>();
  if (/\b(certificate|certification|vocational|trade)\b/i.test(text)) levels.add('CERT');
  if (/\b(two[- ]year|associate|community college)\b/i.test(text)) levels.add('ASSOC');
  if (/\b(four[- ]year|bachelor|undergraduate|baccalaureate)\b/i.test(text)) levels.add('BACH');
  if (/\b(graduate|master|doctoral|phd|post[- ]graduate)\b/i.test(text)) levels.add('GRAD');
  return [
    makeConstraint(
      'institution',
      text,
      {
        axis: 'institution',
        degreeLevels: [...levels],
        tradeSchoolOK: /\b(trade|vocational|technical school)\b/i.test(text),
        partTimeOK: /\bpart[- ]time\b/i.test(text),
        accreditationRequired: /\baccredit/i.test(text),
      },
      0,
    ),
  ];
}
```

Create `packages/server/src/normalize/axes/gpa.ts`:

```ts
import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const GPA = /\bGPA\b[^0-9]{0,20}(\d(?:\.\d+)?)/i;
const GPA_OVER = /\b(?:over|above|at least|minimum of)\s+(\d\.\d+)\b/i;
const CLASS_RANK = /top\s+(\d+)(?:\s*(?:to|[-–])\s*(\d+))?\s*(?:percent|%)/i;

export function extractGpa(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawFields.gpa, raw.rawText].filter(Boolean).join('\n');
  const rank = CLASS_RANK.exec(text);
  if (rank) {
    // "top 5 to 10 percent" — take the widest bound so the matcher is inclusive, not exclusive.
    const pct = Number.parseInt(rank[2] ?? rank[1], 10);
    const sentence = /[^.]*top\s+\d+[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
    return [makeConstraint('gpa', sentence, { axis: 'gpa', classRankTopPct: pct }, 0)];
  }
  const gpa = GPA.exec(text) ?? GPA_OVER.exec(text);
  if (!gpa) return [];
  const sentence = /[^.]*GPA[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  return [makeConstraint('gpa', sentence, { axis: 'gpa', min: Number.parseFloat(gpa[1]) }, 0)];
}
```

Replace `packages/server/src/normalize/axes/index.ts` (the Task 16 stub) with:

```ts
import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { extractFieldOfStudy } from './fieldOfStudy.js';
import { extractGeography } from './geography.js';
import { extractGpa } from './gpa.js';
import { extractInstitution } from './institution.js';
import { extractLicense } from './license.js';

export type AxisExtractor = (raw: RawOpportunity) => Constraint[];

export { cascadeRank, isPreferenceText, makeConstraint, stableSuffix } from './preference.js';
export { extractFieldOfStudy, extractGeography, extractGpa, extractInstitution, extractLicense };
export { RADIUS_CENTERS } from './radiusCenters.js';

/** Task 18 appends the remaining eight extractors to this list. */
export const AXIS_EXTRACTORS: AxisExtractor[] = [
  extractLicense,
  extractGeography,
  extractFieldOfStudy,
  extractInstitution,
  extractGpa,
];

export function extractConstraints(raw: RawOpportunity): Constraint[] {
  const out: Constraint[] = [];
  for (const extractor of AXIS_EXTRACTORS) out.push(...extractor(raw));
  return out;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/normalize/ && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/normalize/axes packages/server/src/normalize/purity.test.ts \
  data/reference/radius-centers.json
git commit -m "feat(normalize): license, geography, field-of-study, institution and GPA axis extractors"
```

---

### Task 18: `normalize/axes/` part 2 — the remaining eight axes

**Files:**
- Create: `packages/server/src/normalize/axes/membership.ts`
- Create: `packages/server/src/normalize/axes/recommendation.ts`
- Create: `packages/server/src/normalize/axes/citizenship.ts`
- Create: `packages/server/src/normalize/axes/ageStage.ts`
- Create: `packages/server/src/normalize/axes/hamActivity.ts`
- Create: `packages/server/src/normalize/axes/financialNeed.ts`
- Create: `packages/server/src/normalize/axes/gender.ts`
- Create: `packages/server/src/normalize/axes/other.ts`
- Modify: `packages/server/src/normalize/axes/index.ts` — append the eight extractors to `AXIS_EXTRACTORS`
- Test: `packages/server/src/normalize/axes/part2.test.ts`

**Interfaces:**
- Consumes: `makeConstraint`, `isPreferenceText` (Task 17).
- Produces: `extractArrlMembership`, `extractRecommendation`, `extractCitizenship`, `extractAgeStage`, `extractHamActivity`, `extractFinancialNeed`, `extractGender`, `extractOther` — each `(raw: RawOpportunity) => Constraint[]`.

**Domain facts these encode:** ARRL membership appears in exactly two intensities (member, member ≥1 year). ARDC needs **3** references; QCWA needs an **active QCWA member** as sponsor; Goldwater needs a sitting club officer's letter. Citizenship appears on 26 entries and includes the form *"or within three months of citizenship"*. Explicit `Age` appears on only 4 entries (17–25; YCCC "22 or younger as of June 1"), while ~15 more gate on stage instead; Chick Allen and Frankford RC explicitly include veterans. **CWops requires ARRL Code Proficiency ≥15 wpm within 24 months** — the only `cwProficiencyWpmMin` in the corpus. Financial need appears 4 times and **is always a weighting, never a bar** — so its constraint is always `hard: false`. **Gender is YLRL only**; there is no equivalent anywhere in the ARRL catalog. `extractOther` is the catch-all that keeps *"preference to a student ham from a ham family"*, learning-disability documentation and at-risk-youth turnaround letters from vanishing.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/normalize/axes/part2.test.ts`:

```ts
import type { RawOpportunity } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { extractConstraints } from './index.js';
import { extractAgeStage } from './ageStage.js';
import { extractCitizenship } from './citizenship.js';
import { extractFinancialNeed } from './financialNeed.js';
import { extractGender } from './gender.js';
import { extractHamActivity } from './hamActivity.js';
import { extractArrlMembership } from './membership.js';
import { extractOther } from './other.js';
import { extractRecommendation } from './recommendation.js';

const raw = (fields: Record<string, string>, rawText = ''): RawOpportunity => ({
  sourceId: 's',
  externalKey: 'k',
  name: 'n',
  rawFields: fields,
  sourceUrl: 'https://example.test/x',
  rawText: rawText || Object.values(fields).join('\n'),
});

describe('extractArrlMembership', () => {
  it('reads plain membership', () => {
    expect(extractArrlMembership(raw({ Other: 'Applicant must be an ARRL member.' }))[0].spec).toMatchObject({
      axis: 'arrl_membership',
      required: true,
      minYears: 0,
    });
  });

  it('reads the second intensity: member for at least one year', () => {
    expect(
      extractArrlMembership(raw({ Other: 'Applicant must be an ARRL member for at least one year.' }))[0].spec,
    ).toMatchObject({ required: true, minYears: 1 });
  });

  it('returns [] when ARRL membership is not mentioned', () => {
    expect(extractArrlMembership(raw({ Other: 'Any licensed amateur.' }))).toEqual([]);
  });
});

describe('extractRecommendation', () => {
  it('reads ARDC’s three references', () => {
    expect(extractRecommendation(raw({ Other: 'Three references are required.' }))[0].spec).toMatchObject({
      axis: 'recommendation',
      count: 3,
    });
  });

  it('reads QCWA’s active-member sponsor', () => {
    expect(
      extractRecommendation(raw({ Other: 'Applicant must be sponsored by an active QCWA member.' }))[0].spec,
    ).toMatchObject({ recommenderType: 'sponsor_org_member', count: 1 });
  });

  it('reads Goldwater’s sitting club officer', () => {
    expect(
      extractRecommendation(
        raw({ Other: 'A letter from a sitting officer of an ARRL-affiliated club is required.' }),
      )[0].spec,
    ).toMatchObject({ recommenderType: 'arrl_affiliated_club_officer' });
  });

  it('reads a teacher recommendation', () => {
    expect(
      extractRecommendation(raw({ Other: 'A letter of recommendation from a teacher is required.' }))[0].spec,
    ).toMatchObject({ recommenderType: 'teacher' });
  });
});

describe('extractCitizenship', () => {
  it('reads US citizen', () => {
    expect(extractCitizenship(raw({ Other: 'Applicant must be a US citizen.' }))[0].spec).toMatchObject({
      axis: 'citizenship',
      allowed: ['US_CITIZEN'],
    });
  });

  it('reads permanent resident as US_RESIDENT', () => {
    expect(
      extractCitizenship(raw({ Other: 'Applicant must be a US citizen or permanent resident.' }))[0].spec,
    ).toMatchObject({ allowed: expect.arrayContaining(['US_CITIZEN', 'US_RESIDENT']) });
  });

  it('reads the "within three months of citizenship" variant', () => {
    expect(
      extractCitizenship(
        raw({ Other: 'Applicant must be a US citizen, or within three months of citizenship.' }),
      )[0].spec,
    ).toMatchObject({ withinMonthsOfCitizenship: 3 });
  });

  it('reads worldwide eligibility as ANY', () => {
    expect(
      extractCitizenship(raw({ Region: 'Any', Other: 'Open worldwide; US residence is not required.' }))[0].spec,
    ).toMatchObject({ allowed: ['ANY'] });
  });
});

describe('extractAgeStage', () => {
  it('reads an explicit age range', () => {
    expect(extractAgeStage(raw({ Age: '17 to 25' }))[0].spec).toMatchObject({
      axis: 'age_stage',
      ageMin: 17,
      ageMax: 25,
    });
  });

  it('reads YCCC’s "22 or younger as of June 1" including the asOf date', () => {
    const spec = extractAgeStage(raw({ Age: '22 or younger as of June 1' }))[0].spec as {
      ageMax?: number;
      asOf?: string;
    };
    expect(spec.ageMax).toBe(22);
    expect(spec.asOf).toBe('June 1');
  });

  it('reads stages when there is no explicit age', () => {
    const spec = extractAgeStage(
      raw({ Other: 'Open to high school seniors, undergraduates and graduate students.' }),
    )[0].spec as { stages: string[] };
    expect(spec.stages.sort()).toEqual(['GRAD', 'HS_SENIOR', 'UNDERGRAD']);
  });

  it('reads veterans, explicitly included by Chick Allen and Frankford RC', () => {
    const spec = extractAgeStage(raw({ Other: 'Veterans are explicitly encouraged to apply.' }))[0].spec as {
      stages: string[];
    };
    expect(spec.stages).toContain('VETERAN');
  });

  it('reads retraining adults', () => {
    const spec = extractAgeStage(
      raw({ Other: 'Open to adults retraining for a new career.' }),
    )[0].spec as { stages: string[] };
    expect(spec.stages).toContain('RETRAINING_ADULT');
  });
});

describe('extractHamActivity', () => {
  it('reads CWops’ 15 wpm within 24 months — the only CW requirement in the corpus', () => {
    const spec = extractHamActivity(
      raw({ Other: 'Applicant must hold an ARRL Code Proficiency certificate at 15 wpm earned within 24 months.' }),
    )[0].spec as { cwProficiencyWpmMin?: number; proofRequired: boolean };
    expect(spec.cwProficiencyWpmMin).toBe(15);
    expect(spec.proofRequired).toBe(true);
  });

  it('reads the activity kinds', () => {
    const spec = extractHamActivity(
      raw({ Other: 'Documented participation in ARES, SKYWARN, Field Day and club teaching is required.' }),
    )[0].spec as { activityKinds: string[] };
    expect(spec.activityKinds).toEqual(
      expect.arrayContaining(['ares_races_skywarn', 'field_day', 'teaching', 'club_member']),
    );
  });

  it('reads contesting and public service', () => {
    const spec = extractHamActivity(
      raw({ Other: 'Preference to applicants active in contesting and public service events.' }),
    )[0].spec as { activityKinds: string[] };
    expect(spec.activityKinds).toEqual(expect.arrayContaining(['contesting', 'public_service']));
  });

  it('returns [] when no activity is mentioned', () => {
    expect(extractHamActivity(raw({ Other: 'Any accredited institution.' }))).toEqual([]);
  });
});

describe('extractFinancialNeed', () => {
  it('is ALWAYS soft — financial need is a weighting, never a bar', () => {
    const c = extractFinancialNeed(raw({ Other: 'Demonstrated financial need is considered.' }));
    expect(c[0].hard).toBe(false);
    expect(c[0].spec).toMatchObject({ axis: 'financial_need', weighted: true });
  });

  it('stays soft even when the source words it as a requirement', () => {
    const c = extractFinancialNeed(raw({ Other: 'Applicants must demonstrate financial need.' }));
    expect(c[0].hard).toBe(false);
  });
});

describe('extractGender', () => {
  it('reads YLRL’s female-only scope — the only gender constraint in the corpus', () => {
    expect(
      extractGender(raw({ eligibility: 'Open to licensed women amateur radio operators worldwide.' }))[0].spec,
    ).toMatchObject({ axis: 'gender', allowed: ['female'] });
  });

  it('returns [] for everything else, because no ARRL entry has a gender constraint', () => {
    expect(extractGender(raw({ Other: 'Open to all licensed amateurs.' }))).toEqual([]);
  });
});

describe('extractOther', () => {
  it('keeps a long-tail requirement no schema captures', () => {
    const c = extractOther(
      raw({ Other: 'Preference to a student ham from a ham family.' }),
    );
    expect(c[0].spec).toMatchObject({ axis: 'other' });
    expect(c[0].rawText).toBe('Preference to a student ham from a ham family.');
    expect(c[0].hard).toBe(false);
  });

  it('keeps learning-disability documentation verbatim', () => {
    const c = extractOther(
      raw({ Other: 'Applicant must provide documentation of a diagnosed learning disability.' }),
    );
    expect((c[0].spec as { note: string }).note).toMatch(/learning disability/i);
  });

  it('returns [] when there is no Other field', () => {
    expect(extractOther(raw({ Region: 'Any' }))).toEqual([]);
  });
});

describe('extractConstraints with all thirteen axes wired', () => {
  it('produces a constraint for every axis present in a rich entry', () => {
    const cs = extractConstraints(
      raw({
        'License Requirement': 'General or higher, licensed at least two years',
        Region: 'Any',
        'Field of Study': 'Sciences or Engineering',
        Institution: 'Any accredited institution',
        Age: '17 to 25',
        Other:
          'US citizen. ARRL member for at least one year. Three references required. Demonstrated ' +
          'financial need is considered. Applicant must rank in the top 10 percent of the class. ' +
          'Documented Field Day participation. Preference to a student ham from a ham family.',
      }),
    );
    const axes = new Set(cs.map((c) => (c.spec as { axis: string }).axis));
    for (const axis of [
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
      'other',
    ]) {
      expect(axes, `missing axis ${axis}`).toContain(axis);
    }
  });

  it('gives every constraint a unique id and a verbatim rawText', () => {
    const cs = extractConstraints(
      raw({ 'License Requirement': 'Any', Region: 'Any', Other: 'US citizen. Financial need considered.' }),
    );
    expect(new Set(cs.map((c) => c.id)).size).toBe(cs.length);
    for (const c of cs) expect(c.rawText.trim()).not.toBe('');
  });

  it('never marks a preference-form constraint hard', () => {
    const cs = extractConstraints(
      raw({
        Region:
          'Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, the award is open to any eligible applicant.',
        Other: 'Financial need is considered.',
      }),
    );
    for (const c of cs) expect(c.hard).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/normalize/axes/part2.test.ts
```

Expected failure: `Failed to resolve import "./ageStage.js"` and seven sibling resolution failures.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/normalize/axes/membership.ts`:

```ts
import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const ARRL_MEMBER = /\bARRL\s+member(?:ship)?\b/i;
const AT_LEAST_YEARS = /(?:at least|for)\s+(one|two|three|\d+)\s+years?/i;
const WORD_YEARS: Record<string, number> = { one: 1, two: 2, three: 3 };

export function extractArrlMembership(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawFields.eligibility, raw.rawText].filter(Boolean).join('\n');
  if (!ARRL_MEMBER.test(text)) return [];
  const sentence = /[^.]*ARRL\s+member[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  const years = AT_LEAST_YEARS.exec(sentence);
  const minYears = years ? (WORD_YEARS[years[1].toLowerCase()] ?? Number.parseInt(years[1], 10)) : 0;
  return [
    makeConstraint('arrl_membership', sentence, { axis: 'arrl_membership', required: true, minYears }, 0),
  ];
}
```

Create `packages/server/src/normalize/axes/recommendation.ts`:

```ts
import type { Constraint, RawOpportunity, RecommenderType } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const WORD_COUNT: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const COUNT = /\b(one|two|three|four|five|\d+)\s+(?:letters? of )?(?:references?|recommendations?)/i;
const SIGNAL = /\b(reference|recommendation|sponsor(?:ed|ship)?|letter from)\b/i;

function recommenderTypeFrom(text: string): RecommenderType {
  if (/\bofficer of an ARRL[- ]affiliated club|ARRL[- ]affiliated club officer|sitting officer\b/i.test(text)) {
    return 'arrl_affiliated_club_officer';
  }
  if (/\bactive\s+\w+\s+member\b|\bsponsored by an active\b/i.test(text)) return 'sponsor_org_member';
  if (/\bteacher|instructor|faculty|professor\b/i.test(text)) return 'teacher';
  return 'any';
}

export function extractRecommendation(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawFields.sponsor, raw.rawText].filter(Boolean).join('\n');
  if (!SIGNAL.test(text)) return [];
  const sentence =
    /[^.]*(?:reference|recommendation|sponsor|letter from)[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  const countMatch = COUNT.exec(sentence);
  const count = countMatch
    ? (WORD_COUNT[countMatch[1].toLowerCase()] ?? Number.parseInt(countMatch[1], 10))
    : 1;
  return [
    makeConstraint(
      'recommendation',
      sentence,
      { axis: 'recommendation', recommenderType: recommenderTypeFrom(sentence), count },
      0,
    ),
  ];
}
```

Create `packages/server/src/normalize/axes/citizenship.ts`:

```ts
import type { Citizenship, Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const WORD_MONTHS: Record<string, number> = { one: 1, two: 2, three: 3, six: 6, twelve: 12 };
const WITHIN = /within\s+(one|two|three|six|twelve|\d+)\s+months?\s+of\s+citizenship/i;
const WORLDWIDE = /\b(worldwide|any country|US (?:residence|licensure|citizenship) (?:is )?not required|international applicants)\b/i;

export function extractCitizenship(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawFields.Region, raw.rawFields.eligibility, raw.rawText]
    .filter(Boolean)
    .join('\n');
  const hasCitizen = /\bcitizen(?:ship)?\b/i.test(text);
  const worldwide = WORLDWIDE.test(text);
  if (!hasCitizen && !worldwide) return [];

  if (worldwide && !/must be a US citizen/i.test(text)) {
    const sentence = /[^.]*(?:worldwide|not required|any country)[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
    return [makeConstraint('citizenship', sentence, { axis: 'citizenship', allowed: ['ANY'] }, 0)];
  }

  const sentence = /[^.]*citizen[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  const allowed: Citizenship[] = ['US_CITIZEN'];
  if (/\b(permanent resident|lawful resident|US resident)\b/i.test(sentence)) allowed.push('US_RESIDENT');
  const within = WITHIN.exec(sentence);
  const withinMonthsOfCitizenship = within
    ? (WORD_MONTHS[within[1].toLowerCase()] ?? Number.parseInt(within[1], 10))
    : undefined;
  return [
    makeConstraint(
      'citizenship',
      sentence,
      {
        axis: 'citizenship',
        allowed,
        ...(withinMonthsOfCitizenship !== undefined ? { withinMonthsOfCitizenship } : {}),
      },
      0,
    ),
  ];
}
```

Create `packages/server/src/normalize/axes/ageStage.ts`:

```ts
import type { Constraint, RawOpportunity, Stage } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const RANGE = /\b(\d{2})\s*(?:to|through|[-–])\s*(\d{2})\b/;
const MAX_AGE = /\b(\d{2})\s*(?:years old )?or (?:younger|under)\b/i;
const MIN_AGE = /\bat least\s+(\d{2})\s*(?:years old)?\b/i;
const AS_OF = /\bas of\s+([A-Z][a-z]+\.?\s+\d{1,2})/;

function stagesFrom(text: string): Stage[] {
  const stages = new Set<Stage>();
  if (/\bhigh school senior|graduating senior\b/i.test(text)) stages.add('HS_SENIOR');
  if (/\bundergraduate|baccalaureate|four[- ]year student\b/i.test(text)) stages.add('UNDERGRAD');
  if (/\bgraduate student|master|doctoral|phd\b/i.test(text)) stages.add('GRAD');
  if (/\bveterans?\b/i.test(text)) stages.add('VETERAN');
  if (/\bretrain|returning to school|career chang|adults? (?:re)?entering\b/i.test(text)) {
    stages.add('RETRAINING_ADULT');
  }
  return [...stages];
}

export function extractAgeStage(raw: RawOpportunity): Constraint[] {
  const ageText = raw.rawFields.Age ?? raw.rawFields.age ?? '';
  const otherText = [raw.rawFields.Other, raw.rawFields.Institution, raw.rawText].filter(Boolean).join('\n');
  const text = [ageText, otherText].filter(Boolean).join('\n');

  const range = RANGE.exec(ageText);
  const maxAge = MAX_AGE.exec(ageText);
  const minAge = MIN_AGE.exec(ageText);
  const stages = stagesFrom(otherText);

  if (!range && !maxAge && !minAge && stages.length === 0) return [];

  const asOf = AS_OF.exec(ageText)?.[1];
  const rawText = ageText.trim() !== '' ? ageText.trim() : (/[^.]*(?:senior|undergraduate|graduate student|veteran|retrain)[^.]*\./i.exec(otherText)?.[0]?.trim() ?? text);

  return [
    makeConstraint(
      'age_stage',
      rawText,
      {
        axis: 'age_stage',
        ...(range ? { ageMin: Number.parseInt(range[1], 10), ageMax: Number.parseInt(range[2], 10) } : {}),
        ...(!range && maxAge ? { ageMax: Number.parseInt(maxAge[1], 10) } : {}),
        ...(!range && minAge ? { ageMin: Number.parseInt(minAge[1], 10) } : {}),
        ...(asOf ? { asOf } : {}),
        stages,
      },
      0,
    ),
  ];
}
```

Create `packages/server/src/normalize/axes/hamActivity.ts`:

```ts
import type { ActivityKind, Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const CW_WPM = /\b(\d{1,3})\s*(?:wpm|words per minute)\b/i;

const KIND_PATTERNS: Array<[ActivityKind, RegExp]> = [
  ['club_member', /\bclub (?:member|membership|teaching|activit)\w*\b/i],
  ['ares_races_skywarn', /\b(ARES|RACES|SKYWARN)\b/],
  ['teaching', /\b(teach|instruct|licensing class|Elmer)\w*\b/i],
  ['on_air', /\bon[- ]air\b|\boperating activit\w*\b/i],
  ['field_day', /\bField Day\b/i],
  ['contesting', /\bcontest(?:ing|s)?\b/i],
  ['public_service', /\bpublic service\b/i],
];

export function extractHamActivity(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawFields.eligibility, raw.rawText].filter(Boolean).join('\n');
  const activityKinds = KIND_PATTERNS.filter(([, re]) => re.test(text)).map(([kind]) => kind);
  const cw = CW_WPM.exec(text);
  if (activityKinds.length === 0 && !cw) return [];
  const sentence =
    /[^.]*(?:ARES|RACES|SKYWARN|Field Day|contest|public service|club|teach|wpm)[^.]*\./i.exec(text)?.[0]?.trim() ??
    text;
  return [
    makeConstraint(
      'ham_activity',
      sentence,
      {
        axis: 'ham_activity',
        activityKinds,
        ...(cw ? { cwProficiencyWpmMin: Number.parseInt(cw[1], 10) } : {}),
        proofRequired: /\b(documented|documentation|proof|certificate|verified)\b/i.test(sentence),
      },
      0,
    ),
  ];
}
```

Create `packages/server/src/normalize/axes/financialNeed.ts`:

```ts
import type { Constraint, RawOpportunity } from '@grantspotter/core';

const NEED = /\bfinancial(?:ly)?\s+need\b|\bneed[- ]based\b|\bdemonstrated need\b/i;

/**
 * Financial need is ALWAYS a weighting and NEVER a bar — all four occurrences in the corpus
 * read that way, so this constraint is hard-coded soft rather than going through
 * makeConstraint's preference detection.
 */
export function extractFinancialNeed(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawText].filter(Boolean).join('\n');
  if (!NEED.test(text)) return [];
  const sentence = /[^.]*financial[^.]*\.|[^.]*need[- ]based[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  return [
    {
      id: 'financial_need-0',
      hard: false,
      fallbackRank: 0,
      rawText: sentence,
      spec: { axis: 'financial_need', weighted: true },
    },
  ];
}
```

Create `packages/server/src/normalize/axes/gender.ts`:

```ts
import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const FEMALE = /\b(women|woman|female|YL|young lad(?:y|ies))\b/i;

/** YLRL only. There is no gender constraint anywhere in the ARRL catalog. */
export function extractGender(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.eligibility, raw.rawFields.Other, raw.rawText].filter(Boolean).join('\n');
  if (!FEMALE.test(text)) return [];
  const sentence = /[^.]*(?:women|woman|female|YL)[^.]*\./i.exec(text)?.[0]?.trim() ?? text;
  return [makeConstraint('gender', sentence, { axis: 'gender', allowed: ['female'] }, 0)];
}
```

Create `packages/server/src/normalize/axes/other.ts`:

```ts
import type { Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

/**
 * The catch-all. No schema captures "preference to a student ham from a ham family",
 * learning-disability documentation, or an at-risk-youth turnaround letter — and 65 of the 111
 * catalog entries have an Other field. It is kept verbatim, always.
 */
export function extractOther(raw: RawOpportunity): Constraint[] {
  const text = raw.rawFields.Other;
  if (!text || text.trim() === '') return [];
  return [makeConstraint('other', text.trim(), { axis: 'other', note: text.trim() }, 0)];
}
```

Append the eight extractors in `packages/server/src/normalize/axes/index.ts`:

```ts
import { extractAgeStage } from './ageStage.js';
import { extractCitizenship } from './citizenship.js';
import { extractFinancialNeed } from './financialNeed.js';
import { extractGender } from './gender.js';
import { extractHamActivity } from './hamActivity.js';
import { extractArrlMembership } from './membership.js';
import { extractOther } from './other.js';
import { extractRecommendation } from './recommendation.js';

export {
  extractAgeStage,
  extractArrlMembership,
  extractCitizenship,
  extractFinancialNeed,
  extractGender,
  extractHamActivity,
  extractOther,
  extractRecommendation,
};

export const AXIS_EXTRACTORS: AxisExtractor[] = [
  extractLicense,
  extractGeography,
  extractFieldOfStudy,
  extractInstitution,
  extractGpa,
  extractArrlMembership,
  extractRecommendation,
  extractCitizenship,
  extractAgeStage,
  extractHamActivity,
  extractFinancialNeed,
  extractGender,
  extractOther,
];
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/normalize/ && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/normalize/axes
git commit -m "feat(normalize): membership, recommendation, citizenship, age/stage, activity, need, gender and other axes"
```

---

### Task 19: `diff/` — change detection over parsed entries

**Files:**
- Create: `packages/server/src/diff/index.ts`
- Test: `packages/server/src/diff/index.test.ts`

**Interfaces:**
- Consumes: `hashProgram` from `@grantspotter/core`; `Program`, `ChangeEvent`, `ChangeKind`.
- Produces:
  ```ts
  export function diffPrograms(previous: Program[], next: Program[], sourceId: string, nowISO: string): ChangeEvent[];
  export function detectYieldDrop(sourceId: string, parsedCount: number, expectedMinRecords: number, nowISO: string): ChangeEvent | null;   // plan-local
  export function shouldSuppressVanished(nextCount: number, expectedMinRecords: number): boolean;  // plan-local
  ```

**Why we hash parsed entries and nothing else.** `arrl.org` serves `Cache-Control: nocache` with **no `ETag` and no `Last-Modified`** (Apache 2.2.15/CentOS), and **every `<lastmod>` in its sitemap is frozen at 2010** — actively misleading rather than merely absent. So header-based conditional requests are useless and sitemap-based change detection is worse than useless. Raw-HTML hashing is equally useless: the page's nav, footer and membership banners churn independently of the catalog, and every night would report 111 changes. `hashProgram` runs over normalized `Program` fields with `TrustFields` excluded, so nav churn is invisible and a moved deadline is not.

**All seven `ChangeKind` values are emitted:** `new`, `deadline_changed`, `amount_changed`, `eligibility_changed`, `status_changed`, `vanished` (all six from `diffPrograms`) and `parse_yield_dropped` (from `detectYieldDrop`, which the runner calls with the module's `expectedMinRecords`).

**A summary-only reword produces NO event, deliberately.** `summary` is our own short excerpt; emitting an event every time it is reworded would flood the inbox with noise and train the reviewer to click Approve without reading. A change in `rawOtherText` **does** emit `eligibility_changed`, because that field is where unmodelled requirements live.

**`parse_yield_dropped` never fires when `expectedMinRecords` is 0**, and `vanished` is suppressed on a fully-empty scrape from such a source — `grants.austinhams.org` legitimately shows "No opportunities available" between Aug 1 and Apr 30.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/diff/index.test.ts`:

```ts
import type { Program } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { detectYieldDrop, diffPrograms, shouldSuppressVanished } from './index.js';

const NOW = '2026-08-02T00:00:00.000Z';

function program(over: Partial<Program> = {}): Program {
  return {
    id: 'src--entry--abcdef12',
    funderId: 'arrl-foundation',
    name: 'YASME Foundation Scholarship',
    klass: 'ham_scholarship',
    summary: 'A scholarship.',
    applicantEntities: ['individual'],
    amount: { instrument: 'cash_fixed', amountMin: 5000, amountMax: 5000, amountRaw: '$5,000', awardCountRaw: 'Three' },
    deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'owner' }, note: '' },
    applyVia: 'external_spa_portal',
    constraints: [
      { id: 'license-0-aaaa', hard: true, fallbackRank: 0, rawText: 'General or higher', spec: { axis: 'license', licenseMin: 'GENERAL' } },
    ],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'http://www.arrl.org/scholarship-descriptions',
      lastVerifiedAt: NOW,
      verificationMethod: 'live_fetch',
      contentHash: 'hash-a',
    },
    rawOtherText: 'Top 5 to 10 percent of the class.',
    tags: [],
    ...over,
  };
}

describe('diffPrograms — new and vanished', () => {
  it('emits new for a record that was not there last night', () => {
    const events = diffPrograms([], [program()], 'src', NOW);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('new');
    expect(events[0].programId).toBe(program().id);
    expect(events[0].sourceId).toBe('src');
    expect(events[0].detectedAt).toBe(NOW);
    expect(events[0].after).toEqual(program());
    expect(events[0].before).toBeUndefined();
  });

  it('emits vanished for a record that disappeared', () => {
    const events = diffPrograms([program()], [], 'src', NOW);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('vanished');
    expect(events[0].before).toEqual(program());
    expect(events[0].after).toBeUndefined();
  });

  it('emits nothing at all when nothing changed', () => {
    expect(diffPrograms([program()], [program()], 'src', NOW)).toEqual([]);
  });

  it('ignores a lastVerifiedAt-only change — otherwise every record changes every night', () => {
    const before = program();
    const after = program({ trust: { ...program().trust, lastVerifiedAt: '2026-08-03T00:00:00.000Z' } });
    expect(diffPrograms([before], [after], 'src', NOW)).toEqual([]);
  });

  it('gives every event a unique id', () => {
    const events = diffPrograms([], [program(), program({ id: 'src--other--bbbb1111' })], 'src', NOW);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });
});

describe('diffPrograms — field-level classification', () => {
  it('emits deadline_changed when the deadline spec moves', () => {
    const after = program({
      deadline: { kind: 'annual_window', source: { kind: 'self' }, note: 'moved' },
    });
    const events = diffPrograms([program()], [after], 'src', NOW);
    expect(events.map((e) => e.kind)).toEqual(['deadline_changed']);
    expect(events[0].fieldPath).toBe('deadline');
    expect(events[0].before).toEqual(program().deadline);
    expect(events[0].after).toEqual(after.deadline);
  });

  it('emits amount_changed when any part of the amount spec moves', () => {
    const after = program({ amount: { ...program().amount, amountMax: 7500, amountRaw: '$7,500' } });
    const events = diffPrograms([program()], [after], 'src', NOW);
    expect(events.map((e) => e.kind)).toEqual(['amount_changed']);
    expect(events[0].fieldPath).toBe('amount');
  });

  it('emits eligibility_changed when a constraint changes', () => {
    const after = program({
      constraints: [
        { id: 'license-0-aaaa', hard: true, fallbackRank: 0, rawText: 'Extra only', spec: { axis: 'license', licenseMin: 'EXTRA' } },
      ],
    });
    const events = diffPrograms([program()], [after], 'src', NOW);
    expect(events.map((e) => e.kind)).toEqual(['eligibility_changed']);
    expect(events[0].fieldPath).toBe('constraints');
  });

  it('emits eligibility_changed for a rawOtherText change, because unmodelled rules live there', () => {
    const after = program({ rawOtherText: 'Top 5 percent of the class, and a new essay requirement.' });
    const events = diffPrograms([program()], [after], 'src', NOW);
    expect(events.map((e) => e.kind)).toEqual(['eligibility_changed']);
    expect(events[0].fieldPath).toBe('rawOtherText');
  });

  it('emits status_changed when the trust status moves', () => {
    const after = program({ trust: { ...program().trust, status: 'closed' } });
    const events = diffPrograms([program()], [after], 'src', NOW);
    expect(events.map((e) => e.kind)).toEqual(['status_changed']);
    expect(events[0].fieldPath).toBe('trust.status');
    expect(events[0].before).toBe('open');
    expect(events[0].after).toBe('closed');
  });

  it('emits several events when several axes move at once', () => {
    const after = program({
      amount: { ...program().amount, amountRaw: '$6,000' },
      deadline: { kind: 'annual_window', source: { kind: 'self' }, note: '' },
      trust: { ...program().trust, status: 'closed' },
    });
    const kinds = diffPrograms([program()], [after], 'src', NOW).map((e) => e.kind);
    expect(kinds.sort()).toEqual(['amount_changed', 'deadline_changed', 'status_changed']);
  });

  it('emits NO event for a summary-only reword — that would flood the inbox with noise', () => {
    const after = program({ summary: 'A scholarship for licensed students.' });
    expect(diffPrograms([program()], [after], 'src', NOW)).toEqual([]);
  });

  it('emits NO event for a tags-only change', () => {
    expect(diffPrograms([program()], [program({ tags: ['x'] })], 'src', NOW)).toEqual([]);
  });
});

describe('detectYieldDrop', () => {
  it('fires when the parse yield falls below expectedMinRecords', () => {
    const event = detectYieldDrop('arrl-scholarship-descriptions', 42, 100, NOW);
    expect(event?.kind).toBe('parse_yield_dropped');
    expect(event?.sourceId).toBe('arrl-scholarship-descriptions');
    expect(event?.before).toEqual({ expectedMinRecords: 100 });
    expect(event?.after).toEqual({ parsedCount: 42 });
    expect(event?.programId).toBeUndefined();
  });

  it('fires hardest on a silent zero — the most likely way this app rots', () => {
    expect(detectYieldDrop('arrl-scholarship-descriptions', 0, 100, NOW)?.kind).toBe(
      'parse_yield_dropped',
    );
  });

  it('does not fire when the yield is at or above the floor', () => {
    expect(detectYieldDrop('s', 100, 100, NOW)).toBeNull();
    expect(detectYieldDrop('s', 111, 100, NOW)).toBeNull();
  });

  it('NEVER fires for a source whose expectedMinRecords is 0 — Austin ARC is legitimately empty', () => {
    expect(detectYieldDrop('austin-arc', 0, 0, NOW)).toBeNull();
  });
});

describe('shouldSuppressVanished', () => {
  it('suppresses vanished on a fully-empty scrape from a legitimately-empty source', () => {
    expect(shouldSuppressVanished(0, 0)).toBe(true);
  });

  it('does not suppress when the source is supposed to return records', () => {
    expect(shouldSuppressVanished(0, 100)).toBe(false);
  });

  it('does not suppress a single record vanishing from a non-empty scrape', () => {
    expect(shouldSuppressVanished(110, 100)).toBe(false);
    expect(shouldSuppressVanished(3, 0)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/diff/
```

Expected failure: `Failed to resolve import "./index.js" from "packages/server/src/diff/index.test.ts"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/diff/index.ts`:

```ts
import { createHash } from 'node:crypto';
import type { ChangeEvent, ChangeKind, Program } from '@grantspotter/core';
import { hashProgram } from '@grantspotter/core';

function eventId(sourceId: string, kind: ChangeKind, key: string, nowISO: string): string {
  return createHash('sha256').update(`${sourceId}|${kind}|${key}|${nowISO}`).digest('hex').slice(0, 24);
}

function make(
  sourceId: string,
  kind: ChangeKind,
  nowISO: string,
  extra: Partial<ChangeEvent>,
): ChangeEvent {
  return {
    id: eventId(sourceId, kind, `${extra.programId ?? ''}|${extra.fieldPath ?? ''}`, nowISO),
    sourceId,
    kind,
    detectedAt: nowISO,
    ...extra,
  };
}

const stable = (value: unknown): string => JSON.stringify(value ?? null);

/**
 * Change detection hashes the PARSED ENTRIES, never the raw HTML and never response headers.
 *
 * arrl.org serves Cache-Control: nocache with NO ETag and NO Last-Modified, and every
 * <lastmod> in its sitemap is frozen at 2010 — actively misleading rather than merely absent.
 * Header-based conditional requests therefore tell us nothing, and sitemap-based detection is
 * worse than nothing. Raw-HTML hashing is equally useless: nav, footer and membership banners
 * churn independently of the catalog and would report 111 changes every night.
 *
 * hashProgram excludes TrustFields by contract, so lastVerifiedAt moving nightly is invisible.
 */
export function diffPrograms(
  previous: Program[],
  next: Program[],
  sourceId: string,
  nowISO: string,
): ChangeEvent[] {
  const before = new Map(previous.map((p) => [p.id, p]));
  const after = new Map(next.map((p) => [p.id, p]));
  const events: ChangeEvent[] = [];

  for (const [id, program] of after) {
    if (!before.has(id)) {
      events.push(make(sourceId, 'new', nowISO, { programId: id, after: program }));
    }
  }

  for (const [id, program] of before) {
    if (!after.has(id)) {
      events.push(make(sourceId, 'vanished', nowISO, { programId: id, before: program }));
    }
  }

  for (const [id, nextProgram] of after) {
    const prevProgram = before.get(id);
    if (!prevProgram) continue;
    if (hashProgram(prevProgram) === hashProgram(nextProgram)) continue;

    if (stable(prevProgram.deadline) !== stable(nextProgram.deadline)) {
      events.push(
        make(sourceId, 'deadline_changed', nowISO, {
          programId: id,
          fieldPath: 'deadline',
          before: prevProgram.deadline,
          after: nextProgram.deadline,
        }),
      );
    }
    if (stable(prevProgram.amount) !== stable(nextProgram.amount)) {
      events.push(
        make(sourceId, 'amount_changed', nowISO, {
          programId: id,
          fieldPath: 'amount',
          before: prevProgram.amount,
          after: nextProgram.amount,
        }),
      );
    }
    if (stable(prevProgram.constraints) !== stable(nextProgram.constraints)) {
      events.push(
        make(sourceId, 'eligibility_changed', nowISO, {
          programId: id,
          fieldPath: 'constraints',
          before: prevProgram.constraints,
          after: nextProgram.constraints,
        }),
      );
    }
    if (prevProgram.rawOtherText !== nextProgram.rawOtherText) {
      // rawOtherText is where unmodelled eligibility lives, so it is an eligibility change.
      events.push(
        make(sourceId, 'eligibility_changed', nowISO, {
          programId: id,
          fieldPath: 'rawOtherText',
          before: prevProgram.rawOtherText,
          after: nextProgram.rawOtherText,
        }),
      );
    }
    if (prevProgram.trust.status !== nextProgram.trust.status) {
      events.push(
        make(sourceId, 'status_changed', nowISO, {
          programId: id,
          fieldPath: 'trust.status',
          before: prevProgram.trust.status,
          after: nextProgram.trust.status,
        }),
      );
    }
    // A summary or tags reword deliberately emits nothing: summary is our own short excerpt,
    // and an event per reword would flood the inbox and train the reviewer to stop reading.
  }

  return events;
}

/**
 * A parser that silently starts returning zero records is the most likely way this app rots,
 * so this is a first-class alarm rather than a log line. It never fires for a source whose
 * expectedMinRecords is 0 — grants.austinhams.org legitimately shows "No opportunities
 * available" between August 1 and April 30, and an empty scrape there is the right answer.
 */
export function detectYieldDrop(
  sourceId: string,
  parsedCount: number,
  expectedMinRecords: number,
  nowISO: string,
): ChangeEvent | null {
  if (expectedMinRecords <= 0) return null;
  if (parsedCount >= expectedMinRecords) return null;
  return make(sourceId, 'parse_yield_dropped', nowISO, {
    fieldPath: 'parsedCount',
    before: { expectedMinRecords },
    after: { parsedCount },
  });
}

/** A legitimately-empty source must not report every past record as vanished. */
export function shouldSuppressVanished(nextCount: number, expectedMinRecords: number): boolean {
  return nextCount === 0 && expectedMinRecords === 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/diff/ && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/diff
git commit -m "feat(diff): change detection over parsed entries emitting all seven ChangeKinds"
```

---

### Task 20: Ingestion schema and repositories

**Files:**
- Create: `packages/server/src/db/ingestSchema.ts`
- Create: `packages/server/src/db/repositories/ingestion.ts`
- Test: `packages/server/src/db/repositories/ingestion.test.ts`

**Interfaces:**
- Consumes: `better-sqlite3`; `Program`, `ChangeEvent`, `ReviewItem`, `FetchedPayload`, `programSchema` from core; **`createProgramRepo` and `ProgramSourceKey` from `../repositories/programs.js` (Plan 1 Task 13)**; the `programs`, `snapshots`, `sources`, `change_events`, `review_items` and `audit_log` DDL from Plan 1 Task 12's `001-init.sql`.
- Produces:
  ```ts
  // ingestSchema.ts
  export function ensureIngestionSchema(db: Database.Database): void;
  export class MissingSchemaError extends Error { table: string; column?: string }
  // repositories/ingestion.ts   (plan-local)
  export interface SourceHealthRow {
    sourceId: string; lastPolledAt?: string; lastSuccessAt?: string; lastError?: string;
    lastRecordCount?: number; expectedMinRecords: number; consecutiveFailures: number;
  }
  export function upsertProgram(db, p: Program, sourceKey?: ProgramSourceKey): void;
  export function listProgramsBySource(db, sourceId: string): Program[];
  export function deleteProgram(db, id: string): void;
  export function insertSnapshot(db, sourceId: string, payload: FetchedPayload, filePath?: string): void;
  export function insertChangeEvents(db, events: ChangeEvent[]): void;
  export function listChangeEvents(db, limit: number): ChangeEvent[];
  export function insertReviewItem(db, item: ReviewItem): void;
  export function listReviewItems(db, decision?: ReviewDecision): ReviewItem[];
  export function getReviewItem(db, id: string): ReviewItem | undefined;
  export function setReviewDecision(db, id: string, decision: ReviewDecision, decidedBy: string, decidedAtISO: string, candidate?: Program): void;
  export function rememberReject(db, rejectKey: string, decidedBy: string, atISO: string): void;
  export function isRejected(db, rejectKey: string): boolean;
  export function recordPollStart(db, source: SourceModule, atISO: string): void;
  export function recordPollSuccess(db, sourceId: string, lastRecordCount: number, atISO: string): void;
  export function recordPollFailure(db, sourceId: string, error: string, atISO: string): void;
  export function listSourceHealth(db): SourceHealthRow[];
  export function appendAuditLog(db, entry: { userId: string; action: string; entityType: string; entityId: string; detail: string; atISO: string }): void;
  export function listAuditLog(db, entityId: string): Array<{ userId: string; action: string; detail: string; atISO: string }>;
  ```

**Plan 1's DDL is authoritative — this task creates exactly one table** (RESOLUTIONS R1/R3/R4, type-audit findings #1 and #4). Plan 1 Task 12's `001-init.sql` owns `programs`, `snapshots`, `sources`, `change_events`, `review_items` and `audit_log`, including the `source_id`/`external_key` columns on `programs` and the health columns on `sources`. `ensureIngestionSchema` therefore:

1. **Creates `review_rejects`**, the one plan-local table (CONTRACT §6 lists it), with `CREATE TABLE IF NOT EXISTS`.
2. **Asserts** that every Plan-1 table and every column the ingestion path writes actually exists, via `PRAGMA table_info`, and throws `MissingSchemaError` naming the table and column when one does not.
3. Creates the ingestion-only indexes, all `IF NOT EXISTS`, and **only under names Plan 1 does not
   already use** (RESOLUTIONS R23). `idx_snapshots_source` is Plan 1's; a second
   `CREATE INDEX IF NOT EXISTS idx_snapshots_source … DESC` matches on the name, no-ops, and leaves
   you believing in an index that does not exist. `idx_audit_entity` is the only one left here,
   and Plan 1's `001-init.sql` does not declare it (it declares `idx_audit_at`).

It **never** issues `CREATE TABLE IF NOT EXISTS` for a Plan 1 table and **never** `ALTER TABLE … ADD COLUMN`s one. The old version did, and that was the single worst defect in this plan: `CREATE TABLE IF NOT EXISTS programs (...)` silently no-ops against Plan 1's real table, so a shadow column list survived typechecking and the first crawl write died on `SQLITE_CONSTRAINT: NOT NULL constraint failed: programs.summary`. Loud assertion at boot beats a silent divergence that only shows up at 03:17.

**There is no `programs` document column and no `programDoc.ts`.** `programs` is Plan 1's fully normalized shape (CONTRACT §6 names `programs.amount` and `programs.obligations` as columns), and every read and write of it goes through `createProgramRepo(db)` — `upsert(program, sourceKey?)`, `get(id)`, `findBySourceKey(sourceId, externalKey)`, `list(filter)`, `remove(id)`. `upsertProgram` / `listProgramsBySource` / `deleteProgram` survive as thin named wrappers because the crawl runner reads them by source, which is the one query `ProgramRepo` does not expose; they hold no shape knowledge of their own.

**There is no `source_health` table.** Plan 1's `sources` already carries `last_polled_at`, `last_success_at`, `last_record_count`, `consecutive_failures`, `last_error` and `expected_min_records`, and Plan 3's Sources page reads exactly those. A second table meant health was written to one place and read from another, so the page rendered permanently empty. Note the canonical spellings: `last_polled_at` (**not** `last_poll_at`) and `last_record_count` (**not** `parse_yield`).

**`sources.enabled` is asserted here because Task 25 gates on it** (RESOLUTIONS R20). Plan 3 ships `PATCH /api/sources/:id` writing `enabled`, and an admin toggle that greys out a paused source. `runCrawl` reads the same column and refuses to poll a disabled source, so `enabled` is load-bearing rather than decorative — it belongs in `REQUIRED_COLUMNS.sources` alongside the health columns. `recordPollStart` deliberately does **not** list `enabled` in its `ON CONFLICT DO UPDATE SET` clause: a pause set by a human survives every subsequent crawl and every registry refresh.

**Review-item candidates are validated with core's zod schema.** `review_items.candidate_json` is parsed through `programSchema.parse` (RESOLUTIONS R2 and R7), which is the same validation `createProgramRepo` applies on read — one validator, not two.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/db/repositories/ingestion.test.ts`:

```ts
import Database from 'better-sqlite3';
import type { ChangeEvent, Program, ReviewItem, SourceModule } from '@grantspotter/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { MissingSchemaError, ensureIngestionSchema } from '../ingestSchema.js';
import {
  appendAuditLog,
  deleteProgram,
  getReviewItem,
  insertChangeEvents,
  insertReviewItem,
  insertSnapshot,
  isRejected,
  listAuditLog,
  listChangeEvents,
  listProgramsBySource,
  listReviewItems,
  listSourceHealth,
  recordPollFailure,
  recordPollStart,
  recordPollSuccess,
  rememberReject,
  setReviewDecision,
  upsertProgram,
} from './ingestion.js';

const NOW = '2026-08-02T00:00:00.000Z';

function program(over: Partial<Program> = {}): Program {
  return {
    id: 'qcwa--qcwa-memorial-scholarship--11223344',
    funderId: 'qcwa',
    name: 'QCWA Memorial Scholarship',
    klass: 'ham_scholarship',
    summary: 'A $3,000 scholarship requiring a QCWA sponsor.',
    applicantEntities: ['individual'],
    amount: { instrument: 'cash_fixed', amountMin: 3000, amountMax: 3000, amountRaw: '$3,000', awardCountRaw: '19' },
    deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'owner' }, note: '' },
    applyVia: 'external_spa_portal',
    applyUrl: 'https://www.qcwa.org/scholarship-program.htm',
    constraints: [],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.qcwa.org/scholarship-program.htm',
      lastVerifiedAt: NOW,
      verificationMethod: 'live_fetch',
      contentHash: 'hash-1',
    },
    rawOtherText: 'Applicant must be sponsored by an active QCWA member.',
    tags: ['source:qcwa'],
    ...over,
  };
}

const KEY = { sourceId: 'qcwa', externalKey: 'qcwa-memorial-scholarship' };

const qcwaSource: SourceModule = {
  id: 'qcwa',
  funderId: 'qcwa',
  label: 'QCWA Scholarship Program',
  tier: 'C',
  klass: 'ham_scholarship',
  requests: [],
  parse: () => [],
  expectedMinRecords: 1,
};

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  // Plan 1's migrations own every CONTRACT §6 table. Plan 2 never recreates one.
  migrate(db);
  ensureIngestionSchema(db);
  db.prepare('INSERT INTO funders (id, name, homepage) VALUES (?, ?, ?)').run(
    'qcwa',
    'Quarter Century Wireless Association',
    'https://www.qcwa.org/',
  );
});

describe('ensureIngestionSchema', () => {
  it('is idempotent — running it three times is harmless', () => {
    expect(() => {
      ensureIngestionSchema(db);
      ensureIngestionSchema(db);
    }).not.toThrow();
  });

  it('creates the one plan-local table and no CONTRACT §6 table', () => {
    const fresh = new Database(':memory:');
    migrate(fresh);
    const before = new Set(
      (fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>).map((r) => r.name),
    );
    ensureIngestionSchema(fresh);
    const after = (
      fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(after.filter((n) => !before.has(n))).toEqual(['review_rejects']);
    expect(after).not.toContain('source_health'); // RESOLUTIONS R4
  });

  it('throws MissingSchemaError instead of silently shadowing a Plan 1 table', () => {
    const bare = new Database(':memory:');
    let thrown: unknown;
    try {
      ensureIngestionSchema(bare);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MissingSchemaError);
    expect((thrown as MissingSchemaError).table).toBe('programs');
  });

  it('names the missing column when a Plan 1 table lost one', () => {
    const partial = new Database(':memory:');
    migrate(partial);
    partial.exec('ALTER TABLE sources DROP COLUMN last_record_count');
    expect(() => ensureIngestionSchema(partial)).toThrow(/sources\.last_record_count/);
  });

  it('requires sources.enabled — the column runCrawl gates on (RESOLUTIONS R20)', () => {
    const partial = new Database(':memory:');
    migrate(partial);
    partial.exec('ALTER TABLE sources DROP COLUMN enabled');
    expect(() => ensureIngestionSchema(partial)).toThrow(/sources\.enabled/);
  });

  it('does not re-declare an index Plan 1 already owns (RESOLUTIONS R23)', () => {
    const fresh = new Database(':memory:');
    migrate(fresh);
    const sqlFor = (name: string): string =>
      (
        fresh.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name = ?").get(name) as
          | { sql: string | null }
          | undefined
      )?.sql ?? '';
    const plan1Definition = sqlFor('idx_snapshots_source');
    expect(plan1Definition).toContain('snapshots'); // Plan 1 really created it
    expect(plan1Definition).not.toMatch(/DESC/);
    ensureIngestionSchema(fresh);
    // Unchanged: SQLite matches IF NOT EXISTS on the name, so a second definition under the same
    // name would be a silent no-op. Plan 2 must not ship one.
    expect(sqlFor('idx_snapshots_source')).toBe(plan1Definition);
  });
});

describe('program repository — delegates to Plan 1 (RESOLUTIONS R1)', () => {
  it('upserts through createProgramRepo and reads back by source_id', () => {
    upsertProgram(db, program(), KEY);
    const rows = listProgramsBySource(db, 'qcwa');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(program());
  });

  it('writes the source key into programs.source_id / programs.external_key', () => {
    upsertProgram(db, program(), KEY);
    const row = db.prepare('SELECT source_id, external_key FROM programs WHERE id = ?').get(
      program().id,
    ) as { source_id: string; external_key: string };
    expect(row).toEqual({ source_id: 'qcwa', external_key: 'qcwa-memorial-scholarship' });
  });

  it('populates every normalized column — there is no doc/data blob', () => {
    upsertProgram(db, program(), KEY);
    const cols = (db.pragma('table_info(programs)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['summary', 'amount', 'obligations', 'trust']));
    expect(cols).not.toContain('doc');
    expect(cols).not.toContain('data');
    const row = db.prepare('SELECT summary, amount FROM programs WHERE id = ?').get(program().id) as {
      summary: string;
      amount: string;
    };
    expect(row.summary).toContain('$3,000');
    expect(JSON.parse(row.amount).amountRaw).toBe('$3,000');
  });

  it('upsert replaces rather than duplicating, and keeps the source key when omitted', () => {
    upsertProgram(db, program(), KEY);
    upsertProgram(db, program({ name: 'QCWA Memorial Scholarship (renamed)' }));
    const rows = listProgramsBySource(db, 'qcwa');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toContain('renamed');
  });

  it('deletes', () => {
    upsertProgram(db, program(), KEY);
    deleteProgram(db, program().id);
    expect(listProgramsBySource(db, 'qcwa')).toEqual([]);
  });
});

describe('snapshots', () => {
  it('stores the fetch envelope and the on-disk path, not the body twice', () => {
    recordPollStart(db, qcwaSource, NOW); // snapshots.source_id references sources(id)
    insertSnapshot(
      db,
      'qcwa',
      { url: 'https://www.qcwa.org/scholarship-program.htm', status: 200, contentType: 'text/html', body: '<p>x</p>', fetchedAt: NOW },
      '/data/snapshots/qcwa/abc/2026.html',
    );
    const row = db.prepare('SELECT * FROM snapshots').get() as Record<string, unknown>;
    expect(row.source_id).toBe('qcwa');
    expect(row.status).toBe(200);
    expect(row.file_path).toBe('/data/snapshots/qcwa/abc/2026.html');
    expect(row.body_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('change events', () => {
  const event: ChangeEvent = {
    id: 'evt-1',
    sourceId: 'qcwa',
    programId: program().id,
    kind: 'deadline_changed',
    before: { kind: 'annual_window' },
    after: { kind: 'inherited' },
    detectedAt: NOW,
    fieldPath: 'deadline',
  };

  it('inserts and reads back with before/after JSON intact', () => {
    insertChangeEvents(db, [event]);
    const rows = listChangeEvents(db, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(event);
  });

  it('is idempotent on the same event id', () => {
    insertChangeEvents(db, [event, event]);
    expect(listChangeEvents(db, 10)).toHaveLength(1);
  });

  it('returns newest first', () => {
    insertChangeEvents(db, [
      { ...event, id: 'a', detectedAt: '2026-08-01T00:00:00.000Z' },
      { ...event, id: 'b', detectedAt: '2026-08-02T00:00:00.000Z' },
    ]);
    expect(listChangeEvents(db, 10).map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('review items and reject memory', () => {
  const item: ReviewItem = {
    id: 'ri-1',
    changeEventId: 'evt-1',
    candidate: program(),
    decision: 'pending',
    confidence: 0.75,
    rejectKey: 'rk-1',
  };

  beforeEach(() => {
    // review_items.change_event_id REFERENCES change_events(id) in Plan 1's DDL.
    insertChangeEvents(db, [
      { id: 'evt-1', sourceId: 'qcwa', kind: 'deadline_changed', detectedAt: NOW },
    ]);
  });

  it('inserts, lists and filters by decision', () => {
    insertReviewItem(db, item);
    expect(listReviewItems(db)).toHaveLength(1);
    expect(listReviewItems(db, 'pending')).toHaveLength(1);
    expect(listReviewItems(db, 'approved')).toHaveLength(0);
    expect(getReviewItem(db, 'ri-1')?.candidate).toEqual(program());
  });

  it('records a decision with who and when', () => {
    insertReviewItem(db, item);
    setReviewDecision(db, 'ri-1', 'approved', 'user-1', NOW);
    const after = getReviewItem(db, 'ri-1');
    expect(after?.decision).toBe('approved');
    expect(after?.decidedBy).toBe('user-1');
    expect(after?.decidedAt).toBe(NOW);
  });

  it('stores an edited candidate when the reviewer changed it', () => {
    insertReviewItem(db, item);
    setReviewDecision(db, 'ri-1', 'edited', 'user-1', NOW, program({ name: 'Corrected name' }));
    expect(getReviewItem(db, 'ri-1')?.candidate.name).toBe('Corrected name');
  });

  it('remembers a rejection so an identical candidate never resurfaces', () => {
    expect(isRejected(db, 'rk-1')).toBe(false);
    rememberReject(db, 'rk-1', 'user-1', NOW);
    expect(isRejected(db, 'rk-1')).toBe(true);
    expect(isRejected(db, 'rk-2')).toBe(false);
  });

  it('tolerates remembering the same reject twice', () => {
    rememberReject(db, 'rk-1', 'user-1', NOW);
    expect(() => rememberReject(db, 'rk-1', 'user-1', NOW)).not.toThrow();
  });
});

describe('source health lives on the `sources` table — RESOLUTIONS R4', () => {
  const other = (id: string, expectedMinRecords = 1): SourceModule => ({
    ...qcwaSource,
    id,
    label: id,
    expectedMinRecords,
  });

  it('writes to the same columns Plan 3’s Sources page reads', () => {
    recordPollStart(db, qcwaSource, NOW);
    recordPollSuccess(db, 'qcwa', 1, NOW);
    const row = db
      .prepare(
        `SELECT last_polled_at, last_success_at, last_record_count, consecutive_failures,
                expected_min_records, last_error FROM sources WHERE id = ?`,
      )
      .get('qcwa') as Record<string, unknown>;
    expect(row.last_polled_at).toBe(NOW);
    expect(row.last_success_at).toBe(NOW);
    expect(row.last_record_count).toBe(1);
    expect(row.expected_min_records).toBe(1);
    expect(row.consecutive_failures).toBe(0);
    expect(row.last_error).toBeNull();
  });

  it('records a poll start, then a success, and clears the failure counter', () => {
    recordPollStart(db, qcwaSource, NOW);
    recordPollSuccess(db, 'qcwa', 1, NOW);
    const [row] = listSourceHealth(db);
    expect(row.sourceId).toBe('qcwa');
    expect(row.lastPolledAt).toBe(NOW);
    expect(row.lastSuccessAt).toBe(NOW);
    expect(row.lastRecordCount).toBe(1);
    expect(row.expectedMinRecords).toBe(1);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.lastError).toBeUndefined();
  });

  it('registers a source it has never seen, and refreshes label/tier on the next poll', () => {
    recordPollStart(db, other('ncdxf-grants'), NOW);
    expect(
      db.prepare('SELECT label, tier, funder_id, klass FROM sources WHERE id = ?').get('ncdxf-grants'),
    ).toEqual({ label: 'ncdxf-grants', tier: 'C', funder_id: 'qcwa', klass: 'ham_scholarship' });
  });

  it('counts consecutive failures and keeps the last error', () => {
    recordPollStart(db, other('ncdxf-grants'), NOW);
    recordPollFailure(db, 'ncdxf-grants', 'HTTP 500', NOW);
    recordPollFailure(db, 'ncdxf-grants', 'timeout', NOW);
    const [row] = listSourceHealth(db);
    expect(row.consecutiveFailures).toBe(2);
    expect(row.lastError).toBe('timeout');
    expect(row.lastSuccessAt).toBeUndefined();
  });

  it('resets the failure counter on the next success', () => {
    recordPollStart(db, other('s'), NOW);
    recordPollFailure(db, 's', 'boom', NOW);
    recordPollSuccess(db, 's', 3, NOW);
    expect(listSourceHealth(db)[0].consecutiveFailures).toBe(0);
  });

  it('lists every tracked source', () => {
    recordPollStart(db, other('a'), NOW);
    recordPollStart(db, other('b', 2), NOW);
    expect(listSourceHealth(db).map((r) => r.sourceId).sort()).toEqual(['a', 'b']);
  });
});

describe('audit log', () => {
  it('appends and reads back the provenance trail for one entity', () => {
    appendAuditLog(db, {
      userId: 'user-1',
      action: 'review.approve',
      entityType: 'review_item',
      entityId: 'ri-1',
      detail: 'approved deadline_changed for QCWA',
      atISO: NOW,
    });
    const rows = listAuditLog(db, 'ri-1');
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('review.approve');
    expect(rows[0].userId).toBe('user-1');
  });

  it('writes Plan 1’s column name — the column is actor_user_id, not user_id', () => {
    appendAuditLog(db, { userId: 'u', action: 'a', entityType: 't', entityId: 'x', detail: 'd', atISO: NOW });
    const row = db.prepare('SELECT actor_user_id FROM audit_log WHERE entity_id = ?').get('x') as {
      actor_user_id: string;
    };
    expect(row.actor_user_id).toBe('u');
  });

  it('does not return another entity’s entries', () => {
    appendAuditLog(db, { userId: 'u', action: 'a', entityType: 't', entityId: 'x', detail: 'd', atISO: NOW });
    expect(listAuditLog(db, 'y')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/db/repositories/ingestion.test.ts
```

Expected failure: `Failed to resolve import "../ingestSchema.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/db/ingestSchema.ts`:

```ts
import type Database from 'better-sqlite3';

/**
 * RESOLUTIONS R1/R3/R4. Plan 1 Task 12's 001-init.sql owns every CONTRACT §6 table. This module
 * creates exactly ONE table — `review_rejects`, Plan 2's only plan-local table — and otherwise
 * ASSERTS that Plan 1's shape is present.
 *
 * The previous version of this file ran `CREATE TABLE IF NOT EXISTS programs (...)` with its own
 * column list. Against a migrated database that is a silent no-op, so a divergent shape survived
 * typechecking and the first nightly crawl died on
 * `SQLITE_CONSTRAINT: NOT NULL constraint failed: programs.summary`. Never re-declare a table
 * another plan owns; assert it instead.
 */
export class MissingSchemaError extends Error {
  readonly table: string;
  readonly column?: string;
  constructor(table: string, column?: string) {
    super(
      column === undefined
        ? `Missing table "${table}". Run Plan 1's migrations (migrate(db)) before ensureIngestionSchema().`
        : `Missing column "${table}.${column}". packages/server/src/db/migrations/001-init.sql owns this shape.`,
    );
    this.name = 'MissingSchemaError';
    this.table = table;
    if (column !== undefined) this.column = column;
  }
}

/** Plan-local tables this module owns outright. CONTRACT §6 lists `review_rejects`. */
const PLAN_LOCAL_TABLES = [
  `CREATE TABLE IF NOT EXISTS review_rejects (
     reject_key  TEXT PRIMARY KEY,
     decided_by  TEXT NOT NULL,
     decided_at  TEXT NOT NULL
   )`,
];

/**
 * Plan 1 tables and the columns the ingestion path actually reads or writes. Asserted, never
 * created and never altered. `sources` carries source health (R4): there is no `source_health`.
 */
const REQUIRED_COLUMNS: Record<string, string[]> = {
  programs: [
    'id', 'funder_id', 'name', 'klass', 'summary', 'applicant_entities', 'amount', 'deadline',
    'apply_via', 'apply_url', 'apply_contact', 'funding_restrictions', 'obligations', 'ai_policy',
    'trust', 'raw_other_text', 'tags', 'source_id', 'external_key', 'content_hash', 'status',
    'last_verified_at',
  ],
  // `enabled` is in this list on purpose (RESOLUTIONS R20): `runCrawl` refuses to poll a source
  // whose row says `enabled = 0`, so if the column ever went missing the crawler would silently
  // start ignoring every admin pause. Assert it at boot instead.
  sources: [
    'id', 'funder_id', 'label', 'tier', 'klass', 'enabled', 'expected_min_records',
    'last_record_count', 'last_polled_at', 'last_success_at', 'last_error',
    'consecutive_failures',
  ],
  snapshots: ['source_id', 'url', 'status', 'content_type', 'body_sha256', 'body_bytes', 'file_path', 'fetched_at'],
  change_events: ['id', 'source_id', 'program_id', 'kind', 'field_path', 'before_json', 'after_json', 'detected_at'],
  review_items: ['id', 'change_event_id', 'candidate_json', 'decision', 'decided_by', 'decided_at', 'confidence', 'reject_key'],
  audit_log: ['at', 'actor_user_id', 'action', 'entity_type', 'entity_id', 'detail'],
};

/**
 * Ingestion-only indexes. Plan 1 owns the rest; these are additive, IF NOT EXISTS, and — the
 * point — carry names Plan 1 does not already use.
 *
 * RESOLUTIONS R23: there is deliberately NO `idx_snapshots_source` here. Plan 1's 001-init.sql
 * already creates an index of that exact name (`ON snapshots(source_id, fetched_at)`), and SQLite
 * matches `IF NOT EXISTS` on the NAME alone — so a second declaration with a different definition
 * (`… fetched_at DESC`) is a silent no-op and the index you think you added never exists. That is
 * the same two-definitions-one-name trap as the `CREATE TABLE IF NOT EXISTS programs` defect
 * above, just with a performance rather than a correctness consequence. Plan 1 owns snapshot
 * indexing; if the crawl ever needs a descending variant, it gets a distinct name and a comment
 * saying it complements Plan 1's rather than replacing it.
 */
const INDEXES = ['CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_id)'];

/** Idempotent. Call once at boot, AFTER migrate(db). */
export function ensureIngestionSchema(db: Database.Database): void {
  for (const ddl of PLAN_LOCAL_TABLES) db.exec(ddl);

  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    const info = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
    if (info.length === 0) throw new MissingSchemaError(table);
    const existing = new Set(info.map((c) => c.name));
    for (const column of columns) {
      if (!existing.has(column)) throw new MissingSchemaError(table, column);
    }
  }

  for (const ddl of INDEXES) db.exec(ddl);
}
```

Create `packages/server/src/db/repositories/ingestion.ts`:

```ts
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ChangeEvent,
  ChangeKind,
  FetchedPayload,
  Program,
  ReviewDecision,
  ReviewItem,
  SourceModule,
} from '@grantspotter/core';
import { programSchema } from '@grantspotter/core';
import type { ProgramSourceKey } from './programs.js';
import { createProgramRepo } from './programs.js';

/**
 * RESOLUTIONS R4. Source health lives on Plan 1's `sources` table — there is no `source_health`.
 * Field names track the columns exactly: lastPolledAt (last_polled_at), lastRecordCount
 * (last_record_count).
 */
export interface SourceHealthRow {
  sourceId: string;
  lastPolledAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  lastRecordCount?: number;
  expectedMinRecords: number;
  consecutiveFailures: number;
}

const orUndefined = (v: unknown): string | undefined =>
  typeof v === 'string' && v !== '' ? v : undefined;

/** JSON Program column (review_items.candidate_json) — validated with core's schema, not a hand-rolled one. */
const parseCandidate = (json: string): Program => programSchema.parse(JSON.parse(json));
const serializeCandidate = (p: Program): string => JSON.stringify(p);

/**
 * RESOLUTIONS R1: `programs` is Plan 1's normalized table and `createProgramRepo` is the only
 * thing that knows its column list. These three wrappers exist because the crawl runner needs a
 * by-source query, which ProgramRepo does not expose; they add no shape knowledge of their own.
 */
export function upsertProgram(
  db: Database.Database,
  p: Program,
  sourceKey?: ProgramSourceKey,
): void {
  createProgramRepo(db).upsert(p, sourceKey);
}

export function listProgramsBySource(db: Database.Database, sourceId: string): Program[] {
  const repo = createProgramRepo(db);
  const ids = db
    .prepare('SELECT id FROM programs WHERE source_id = ? ORDER BY id')
    .all(sourceId) as Array<{ id: string }>;
  const out: Program[] = [];
  for (const { id } of ids) {
    const program = repo.get(id);
    if (program !== undefined) out.push(program);
  }
  return out;
}

export function deleteProgram(db: Database.Database, id: string): void {
  createProgramRepo(db).remove(id);
}

export function insertSnapshot(
  db: Database.Database,
  sourceId: string,
  payload: FetchedPayload,
  filePath?: string,
): void {
  db.prepare(
    `INSERT INTO snapshots (source_id, url, status, content_type, body_sha256, body_bytes, file_path, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sourceId,
    payload.url,
    payload.status,
    payload.contentType,
    createHash('sha256').update(payload.body).digest('hex'),
    Buffer.byteLength(payload.body, 'utf8'),
    filePath ?? null,
    payload.fetchedAt,
  );
}

export function insertChangeEvents(db: Database.Database, events: ChangeEvent[]): void {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO change_events (id, source_id, program_id, kind, before_json, after_json, field_path, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows: ChangeEvent[]) => {
    for (const e of rows) {
      stmt.run(
        e.id,
        e.sourceId,
        e.programId ?? null,
        e.kind,
        e.before === undefined ? null : JSON.stringify(e.before),
        e.after === undefined ? null : JSON.stringify(e.after),
        e.fieldPath ?? null,
        e.detectedAt,
      );
    }
  });
  tx(events);
}

export function listChangeEvents(db: Database.Database, limit: number): ChangeEvent[] {
  const rows = db
    .prepare('SELECT * FROM change_events ORDER BY detected_at DESC, id LIMIT ?')
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const event: ChangeEvent = {
      id: r.id as string,
      sourceId: r.source_id as string,
      kind: r.kind as ChangeKind,
      detectedAt: r.detected_at as string,
    };
    if (r.program_id) event.programId = r.program_id as string;
    if (r.field_path) event.fieldPath = r.field_path as string;
    if (r.before_json) event.before = JSON.parse(r.before_json as string);
    if (r.after_json) event.after = JSON.parse(r.after_json as string);
    return event;
  });
}

function toReviewItem(r: Record<string, unknown>): ReviewItem {
  const item: ReviewItem = {
    id: r.id as string,
    changeEventId: r.change_event_id as string,
    candidate: parseCandidate(r.candidate_json as string),
    decision: r.decision as ReviewDecision,
    confidence: r.confidence as number,
  };
  const decidedBy = orUndefined(r.decided_by);
  if (decidedBy) item.decidedBy = decidedBy;
  const decidedAt = orUndefined(r.decided_at);
  if (decidedAt) item.decidedAt = decidedAt;
  const rejectKey = orUndefined(r.reject_key);
  if (rejectKey) item.rejectKey = rejectKey;
  return item;
}

export function insertReviewItem(db: Database.Database, item: ReviewItem): void {
  db.prepare(
    `INSERT OR REPLACE INTO review_items (id, change_event_id, candidate_json, decision, decided_by, decided_at, confidence, reject_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.changeEventId,
    serializeCandidate(item.candidate),
    item.decision,
    item.decidedBy ?? null,
    item.decidedAt ?? null,
    item.confidence,
    item.rejectKey ?? null,
  );
}

export function listReviewItems(db: Database.Database, decision?: ReviewDecision): ReviewItem[] {
  const rows = (
    decision
      ? db.prepare('SELECT * FROM review_items WHERE decision = ? ORDER BY id').all(decision)
      : db.prepare('SELECT * FROM review_items ORDER BY id').all()
  ) as Array<Record<string, unknown>>;
  return rows.map(toReviewItem);
}

export function getReviewItem(db: Database.Database, id: string): ReviewItem | undefined {
  const row = db.prepare('SELECT * FROM review_items WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? toReviewItem(row) : undefined;
}

export function setReviewDecision(
  db: Database.Database,
  id: string,
  decision: ReviewDecision,
  decidedBy: string,
  decidedAtISO: string,
  candidate?: Program,
): void {
  if (candidate) {
    db.prepare(
      'UPDATE review_items SET decision=?, decided_by=?, decided_at=?, candidate_json=? WHERE id=?',
    ).run(decision, decidedBy, decidedAtISO, serializeCandidate(candidate), id);
    return;
  }
  db.prepare('UPDATE review_items SET decision=?, decided_by=?, decided_at=? WHERE id=?').run(
    decision,
    decidedBy,
    decidedAtISO,
    id,
  );
}

export function rememberReject(
  db: Database.Database,
  rejectKey: string,
  decidedBy: string,
  atISO: string,
): void {
  db.prepare(
    'INSERT OR REPLACE INTO review_rejects (reject_key, decided_by, decided_at) VALUES (?, ?, ?)',
  ).run(rejectKey, decidedBy, atISO);
}

export function isRejected(db: Database.Database, rejectKey: string): boolean {
  return (
    db.prepare('SELECT 1 FROM review_rejects WHERE reject_key = ?').get(rejectKey) !== undefined
  );
}

/**
 * RESOLUTIONS R4. Health is written to `sources`, which is where Plan 3's Sources page reads it
 * from. `recordPollStart` also REGISTERS the source, so a module added to the registry appears on
 * the health page after its first poll without anyone hand-seeding a row.
 */
export function recordPollStart(
  db: Database.Database,
  source: SourceModule,
  atISO: string,
): void {
  db.prepare(
    `INSERT INTO sources (id, label, tier, funder_id, klass, expected_min_records, last_polled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label=excluded.label,
       tier=excluded.tier,
       funder_id=excluded.funder_id,
       klass=excluded.klass,
       expected_min_records=excluded.expected_min_records,
       last_polled_at=excluded.last_polled_at`,
  ).run(
    source.id,
    source.label,
    source.tier,
    source.funderId,
    source.klass,
    source.expectedMinRecords,
    atISO,
  );
}

export function recordPollSuccess(
  db: Database.Database,
  sourceId: string,
  lastRecordCount: number,
  atISO: string,
): void {
  db.prepare(
    `UPDATE sources
       SET last_success_at = ?, last_record_count = ?, consecutive_failures = 0, last_error = NULL
     WHERE id = ?`,
  ).run(atISO, lastRecordCount, sourceId);
}

export function recordPollFailure(
  db: Database.Database,
  sourceId: string,
  error: string,
  _atISO: string,
): void {
  db.prepare(
    `UPDATE sources
       SET last_error = ?, consecutive_failures = consecutive_failures + 1
     WHERE id = ?`,
  ).run(error, sourceId);
}

export function listSourceHealth(db: Database.Database): SourceHealthRow[] {
  const rows = db
    .prepare(
      `SELECT id, expected_min_records, consecutive_failures, last_polled_at, last_success_at,
              last_error, last_record_count
         FROM sources ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => {
    const row: SourceHealthRow = {
      sourceId: r.id as string,
      expectedMinRecords: (r.expected_min_records as number) ?? 0,
      consecutiveFailures: (r.consecutive_failures as number) ?? 0,
    };
    const lastPolledAt = orUndefined(r.last_polled_at);
    if (lastPolledAt) row.lastPolledAt = lastPolledAt;
    const lastSuccessAt = orUndefined(r.last_success_at);
    if (lastSuccessAt) row.lastSuccessAt = lastSuccessAt;
    const lastError = orUndefined(r.last_error);
    if (lastError) row.lastError = lastError;
    if (typeof r.last_record_count === 'number') row.lastRecordCount = r.last_record_count;
    return row;
  });
}

export function appendAuditLog(
  db: Database.Database,
  entry: {
    userId: string;
    action: string;
    entityType: string;
    entityId: string;
    detail: string;
    atISO: string;
  },
): void {
  // Plan 1's column is `actor_user_id` and the timestamp column is `at`.
  db.prepare(
    'INSERT INTO audit_log (at, actor_user_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(entry.atISO, entry.userId, entry.action, entry.entityType, entry.entityId, entry.detail);
}

export function listAuditLog(
  db: Database.Database,
  entityId: string,
): Array<{ userId: string; action: string; detail: string; atISO: string }> {
  const rows = db
    .prepare(
      'SELECT actor_user_id, action, detail, at FROM audit_log WHERE entity_id = ? ORDER BY id',
    )
    .all(entityId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    userId: r.actor_user_id as string,
    action: r.action as string,
    detail: r.detail as string,
    atISO: r.at as string,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/db/ && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/db
git commit -m "feat(db): idempotent ingestion schema and repositories for snapshots, events, review and health"
```

---

### Task 21: `review/` — the Inbox with reject memory and a provenance trail

**Files:**
- Create: `packages/server/src/review/index.ts`
- Test: `packages/server/src/review/index.test.ts`

**Interfaces:**
- Consumes: everything from Task 20; `hashProgram` from core; `diffPrograms` output.
- Produces:
  ```ts
  export function rejectKeyFor(sourceId: string, program: Program): string;
  export function sourceKeyFor(program: Program): ProgramSourceKey | undefined;
  export function confidenceFor(tier: SourceTier, kind: ChangeKind, adjacencyScore?: number): number;
  export function buildReviewItems(db, events: ChangeEvent[], candidatesById: Map<string, Program>, tier: SourceTier, sourceId: string): ReviewItem[];
  // NOTE: Task 29 adds an optional trailing `assist?: AiAssist` and makes this async
  // (`Promise<ReviewItem[]>`), so the optional spec §9 pre-scoring can refine `confidence`.
  export function approveReviewItem(db, itemId: string, userId: string, nowISO: string): Program;
  export function rejectReviewItem(db, itemId: string, userId: string, nowISO: string, reason: string): void;
  export function editReviewItem(db, itemId: string, userId: string, nowISO: string, edited: Program): Program;
  export function listInbox(db, decision?: ReviewDecision): ReviewItem[];
  export function provenanceFor(db, itemId: string): Array<{ userId: string; action: string; detail: string; atISO: string }>;
  ```

**Reject memory.** `rejectKey = sha256(sourceId | program.id | hashProgram(program))`. Because `hashProgram` excludes `TrustFields`, a candidate that is *content-identical* to one a reviewer already rejected is suppressed forever, while a candidate whose deadline, amount, eligibility or status actually moved gets a **new** key and correctly resurfaces. Without this, a source the reviewer has judged noise reappears in the inbox every single night and the inbox stops being read.

**Nothing publishes unreviewed.** `approveReviewItem` is the only path that writes into `programs`. The federal sweep enters at exactly the same step.

**Approval carries the source key through** (RESOLUTIONS R1/R9). `CONTRACT §3`'s `Program` has no field naming the source record it came from, and `ReviewItem` has none either, so `normalizeRaw` stamps `source:<sourceId>` and `key:<externalKey>` into `Program.tags` and `sourceKeyFor` reads them back. Without that, an approved candidate lands in `programs` with `source_id` NULL, `listProgramsBySource` returns nothing for that source the next night, `diffPrograms` sees an empty `previous`, and the record fires `new` again every night forever — the same duplication bug R9 fixes for ids, one step later in the pipeline.

**Provenance.** Every approve, reject and edit writes an `audit_log` row naming the user, the action, the change kind and the field path.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/review/index.test.ts`:

```ts
import Database from 'better-sqlite3';
import type { ChangeEvent, Program } from '@grantspotter/core';
import { hashProgram } from '@grantspotter/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { ensureIngestionSchema } from '../db/ingestSchema.js';
import { migrate } from '../db/migrate.js';
import { isRejected, listProgramsBySource, listReviewItems } from '../db/repositories/ingestion.js';
import {
  approveReviewItem,
  buildReviewItems,
  confidenceFor,
  editReviewItem,
  listInbox,
  provenanceFor,
  rejectKeyFor,
  rejectReviewItem,
  sourceKeyFor,
} from './index.js';

const NOW = '2026-08-02T00:00:00.000Z';

function program(over: Partial<Program> = {}): Program {
  return {
    id: 'qcwa--qcwa-memorial-scholarship--11223344',
    funderId: 'qcwa',
    name: 'QCWA Memorial Scholarship',
    klass: 'ham_scholarship',
    summary: 'A $3,000 scholarship.',
    applicantEntities: ['individual'],
    amount: { instrument: 'cash_fixed', amountRaw: '$3,000', awardCountRaw: '19' },
    deadline: { kind: 'inherited', source: { kind: 'inherited', fromProgramId: 'owner' }, note: '' },
    applyVia: 'external_spa_portal',
    constraints: [],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.qcwa.org/scholarship-program.htm',
      lastVerifiedAt: NOW,
      verificationMethod: 'live_fetch',
      contentHash: 'h',
    },
    rawOtherText: 'Sponsored by an active QCWA member.',
    tags: ['source:qcwa', 'key:qcwa-memorial-scholarship'],
    ...over,
  };
}

const event = (over: Partial<ChangeEvent> = {}): ChangeEvent => ({
  id: 'evt-1',
  sourceId: 'qcwa',
  programId: program().id,
  kind: 'new',
  after: program(),
  detectedAt: NOW,
  ...over,
});

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  migrate(db); // Plan 1 owns every CONTRACT §6 table
  ensureIngestionSchema(db);
  db.prepare('INSERT INTO funders (id, name, homepage) VALUES (?, ?, ?)').run(
    'qcwa',
    'Quarter Century Wireless Association',
    'https://www.qcwa.org/',
  );
  // review_items.change_event_id references change_events(id).
  db.prepare(
    'INSERT INTO change_events (id, source_id, program_id, kind, detected_at) VALUES (?, ?, ?, ?, ?)',
  ).run('evt-1', 'qcwa', program().id, 'new', NOW);
  db.prepare(
    'INSERT INTO change_events (id, source_id, program_id, kind, detected_at) VALUES (?, ?, ?, ?, ?)',
  ).run('evt-v', 'qcwa', program().id, 'vanished', NOW);
});

describe('sourceKeyFor', () => {
  it('reads the source key back out of the tags normalizeRaw stamped', () => {
    expect(sourceKeyFor(program())).toEqual({
      sourceId: 'qcwa',
      externalKey: 'qcwa-memorial-scholarship',
    });
  });

  it('returns undefined for a hand-curated record that no source produced', () => {
    expect(sourceKeyFor(program({ tags: [] }))).toBeUndefined();
    expect(sourceKeyFor(program({ tags: ['source:qcwa'] }))).toBeUndefined();
  });
});

describe('rejectKeyFor', () => {
  it('is stable for identical content', () => {
    expect(rejectKeyFor('qcwa', program())).toBe(rejectKeyFor('qcwa', program()));
  });

  it('ignores lastVerifiedAt, so an unchanged candidate stays suppressed', () => {
    const later = program({ trust: { ...program().trust, lastVerifiedAt: '2026-09-01T00:00:00.000Z' } });
    expect(rejectKeyFor('qcwa', later)).toBe(rejectKeyFor('qcwa', program()));
  });

  it('changes when the content actually changes, so a real change resurfaces', () => {
    const moved = program({ amount: { ...program().amount, amountRaw: '$4,000' } });
    expect(rejectKeyFor('qcwa', moved)).not.toBe(rejectKeyFor('qcwa', program()));
    expect(hashProgram(moved)).not.toBe(hashProgram(program()));
  });

  it('is namespaced by source', () => {
    expect(rejectKeyFor('other-source', program())).not.toBe(rejectKeyFor('qcwa', program()));
  });
});

describe('confidenceFor', () => {
  it('trusts a real API more than a scraped page and a human most of all', () => {
    expect(confidenceFor('D', 'new')).toBeGreaterThan(confidenceFor('A', 'new'));
    expect(confidenceFor('A', 'new')).toBeGreaterThan(confidenceFor('C', 'new'));
    expect(confidenceFor('C', 'new')).toBeGreaterThan(confidenceFor('B', 'new'));
  });

  it('drops confidence for a parse_yield_dropped alarm, which always needs a human', () => {
    expect(confidenceFor('C', 'parse_yield_dropped')).toBeLessThan(0.3);
  });

  it('scales a federal candidate by its adjacency score and clamps to 0..1', () => {
    expect(confidenceFor('A', 'new', 0)).toBe(0);
    expect(confidenceFor('A', 'new', 6)).toBeCloseTo(0.5, 5);
    expect(confidenceFor('A', 'new', 100)).toBe(1);
  });

  it('always returns a value in 0..1', () => {
    for (const tier of ['A', 'B', 'C', 'D'] as const) {
      for (const kind of ['new', 'vanished', 'deadline_changed'] as const) {
        const c = confidenceFor(tier, kind);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('buildReviewItems', () => {
  const candidates = () => new Map([[program().id, program()]]);

  it('creates one pending item per event that has a candidate', () => {
    const items = buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    expect(items).toHaveLength(1);
    expect(items[0].decision).toBe('pending');
    expect(items[0].changeEventId).toBe('evt-1');
    expect(items[0].candidate).toEqual(program());
    expect(listReviewItems(db, 'pending')).toHaveLength(1);
  });

  it('creates NO review item for a signal-style event with no candidate', () => {
    const items = buildReviewItems(db, [event({ programId: undefined, after: undefined })], new Map(), 'B', 'arrl-news-rss');
    expect(items).toEqual([]);
  });

  it('creates NO review item for parse_yield_dropped — that is an alarm, not a candidate', () => {
    const items = buildReviewItems(
      db,
      [event({ id: 'evt-2', kind: 'parse_yield_dropped', programId: undefined, after: undefined })],
      new Map(),
      'C',
      'qcwa',
    );
    expect(items).toEqual([]);
  });

  it('suppresses a candidate whose rejectKey was already rejected', () => {
    const first = buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    rejectReviewItem(db, first[0].id, 'user-1', NOW, 'not relevant');
    const second = buildReviewItems(db, [event({ id: 'evt-9' })], candidates(), 'C', 'qcwa');
    expect(second).toEqual([]);
    expect(listReviewItems(db, 'pending')).toHaveLength(0);
  });

  it('does NOT suppress a candidate whose content actually changed', () => {
    const first = buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    rejectReviewItem(db, first[0].id, 'user-1', NOW, 'not relevant');
    const moved = program({ amount: { ...program().amount, amountRaw: '$4,000' } });
    const second = buildReviewItems(
      db,
      [event({ id: 'evt-9', kind: 'amount_changed', after: moved })],
      new Map([[moved.id, moved]]),
      'C',
      'qcwa',
    );
    expect(second).toHaveLength(1);
  });

  it('gives each item a deterministic id derived from the change event', () => {
    const a = buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    const b = buildReviewItems(db, [event()], candidates(), 'C', 'qcwa');
    expect(a[0].id).toBe(b[0].id);
    expect(listReviewItems(db)).toHaveLength(1);
  });
});

describe('approve / reject / edit', () => {
  const seed = () => buildReviewItems(db, [event()], new Map([[program().id, program()]]), 'C', 'qcwa')[0];

  it('approve is the ONLY path that writes into the published corpus', () => {
    const item = seed();
    expect(listProgramsBySource(db, 'qcwa')).toEqual([]);
    const published = approveReviewItem(db, item.id, 'user-1', NOW);
    expect(published).toEqual(program());
    expect(listProgramsBySource(db, 'qcwa')).toHaveLength(1);
  });

  it('approve writes the source key, so tomorrow’s crawl sees the record as existing', () => {
    approveReviewItem(db, seed().id, 'user-1', NOW);
    expect(
      db.prepare('SELECT source_id, external_key FROM programs WHERE id = ?').get(program().id),
    ).toEqual({ source_id: 'qcwa', external_key: 'qcwa-memorial-scholarship' });
    // The whole point: listProgramsBySource is what diffPrograms uses as `previous`.
    expect(listProgramsBySource(db, 'qcwa')).toHaveLength(1);
  });

  it('approve records who and when, and writes the provenance trail', () => {
    const item = seed();
    approveReviewItem(db, item.id, 'user-1', NOW);
    const trail = provenanceFor(db, item.id);
    expect(trail).toHaveLength(1);
    expect(trail[0].action).toBe('review.approve');
    expect(trail[0].userId).toBe('user-1');
    expect(trail[0].detail).toContain('new');
  });

  it('reject remembers the key and does not publish', () => {
    const item = seed();
    rejectReviewItem(db, item.id, 'user-1', NOW, 'past award, not an opportunity');
    expect(listProgramsBySource(db, 'qcwa')).toEqual([]);
    expect(isRejected(db, item.rejectKey ?? '')).toBe(true);
    expect(provenanceFor(db, item.id)[0].detail).toContain('past award');
  });

  it('edit publishes the corrected candidate and stores it back on the item', () => {
    const item = seed();
    const corrected = program({ name: 'QCWA Memorial Scholarship Fund' });
    const published = editReviewItem(db, item.id, 'user-1', NOW, corrected);
    expect(published.name).toBe('QCWA Memorial Scholarship Fund');
    expect(listProgramsBySource(db, 'qcwa')[0].name).toBe('QCWA Memorial Scholarship Fund');
    expect(listInbox(db, 'edited')).toHaveLength(1);
  });

  it('a vanished candidate is removed from the corpus on approval', () => {
    const item = seed();
    approveReviewItem(db, item.id, 'user-1', NOW);
    const vanish = buildReviewItems(
      db,
      [event({ id: 'evt-v', kind: 'vanished', before: program(), after: undefined })],
      new Map([[program().id, program()]]),
      'C',
      'qcwa',
    )[0];
    approveReviewItem(db, vanish.id, 'user-1', NOW);
    expect(listProgramsBySource(db, 'qcwa')).toEqual([]);
  });

  it('refuses to act on an unknown item id', () => {
    expect(() => approveReviewItem(db, 'nope', 'user-1', NOW)).toThrow(/nope/);
    expect(() => rejectReviewItem(db, 'nope', 'user-1', NOW, 'x')).toThrow(/nope/);
  });
});

describe('listInbox', () => {
  it('returns everything by default and filters when asked', () => {
    const item = buildReviewItems(db, [event()], new Map([[program().id, program()]]), 'C', 'qcwa')[0];
    expect(listInbox(db)).toHaveLength(1);
    expect(listInbox(db, 'pending')).toHaveLength(1);
    approveReviewItem(db, item.id, 'user-1', NOW);
    expect(listInbox(db, 'pending')).toHaveLength(0);
    expect(listInbox(db, 'approved')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/review/
```

Expected failure: `Failed to resolve import "./index.js" from "packages/server/src/review/index.test.ts"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/review/index.ts`:

```ts
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ChangeEvent,
  ChangeKind,
  Program,
  ReviewDecision,
  ReviewItem,
  SourceTier,
} from '@grantspotter/core';
import { hashProgram } from '@grantspotter/core';
import type { ProgramSourceKey } from '../db/repositories/programs.js';
import {
  appendAuditLog,
  deleteProgram,
  getReviewItem,
  insertReviewItem,
  isRejected,
  listAuditLog,
  listReviewItems,
  rememberReject,
  setReviewDecision,
  upsertProgram,
} from '../db/repositories/ingestion.js';

/**
 * RESOLUTIONS R1/R9. CONTRACT §3 gives neither Program nor ReviewItem a field for the source
 * record they came from, so normalizeRaw stamps `source:<sourceId>` and `key:<externalKey>` into
 * Program.tags and this reads them back on the way into `programs.source_id` /
 * `programs.external_key`. Hand-curated records that no source module produced have no `key:`
 * tag and correctly get `undefined`, which upsert treats as "leave whatever is stored".
 */
export function sourceKeyFor(program: Program): ProgramSourceKey | undefined {
  const sourceTag = program.tags.find((t) => t.startsWith('source:'));
  const keyTag = program.tags.find((t) => t.startsWith('key:'));
  if (sourceTag === undefined || keyTag === undefined) return undefined;
  return { sourceId: sourceTag.slice('source:'.length), externalKey: keyTag.slice('key:'.length) };
}

/**
 * Reject memory. hashProgram excludes TrustFields, so a candidate that is content-identical to
 * one the reviewer already rejected stays suppressed forever, while a candidate whose deadline,
 * amount, eligibility or status actually moved gets a NEW key and correctly resurfaces.
 * Without this, a source the reviewer judged noise reappears every single night and the inbox
 * stops being read — which defeats the entire trust design.
 */
export function rejectKeyFor(sourceId: string, program: Program): string {
  return createHash('sha256')
    .update(`${sourceId}|${program.id}|${hashProgram(program)}`)
    .digest('hex');
}

const TIER_CONFIDENCE: Record<SourceTier, number> = { A: 0.85, B: 0.5, C: 0.7, D: 0.95 };

export function confidenceFor(
  tier: SourceTier,
  kind: ChangeKind,
  adjacencyScore?: number,
): number {
  if (adjacencyScore !== undefined) {
    return Math.min(1, Math.max(0, adjacencyScore / 12));
  }
  if (kind === 'parse_yield_dropped') return 0.1;
  const base = TIER_CONFIDENCE[tier];
  if (kind === 'vanished') return Math.max(0, base - 0.2);
  return base;
}

const NO_CANDIDATE_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>(['parse_yield_dropped']);

function reviewItemId(event: ChangeEvent): string {
  return `ri-${createHash('sha256').update(`${event.id}|${event.fieldPath ?? ''}`).digest('hex').slice(0, 20)}`;
}

/**
 * Nothing publishes unreviewed. Every ChangeEvent that carries a candidate Program becomes a
 * pending ReviewItem, unless its rejectKey is already in the reject memory. Signal-only events
 * (ARRL news RSS) and alarms (parse_yield_dropped) carry no candidate and produce no item —
 * they are read directly from change_events by the Inbox.
 */
export function buildReviewItems(
  db: Database.Database,
  events: ChangeEvent[],
  candidatesById: Map<string, Program>,
  tier: SourceTier,
  sourceId: string,
): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const event of events) {
    if (NO_CANDIDATE_KINDS.has(event.kind)) continue;
    if (!event.programId) continue;
    const candidate = candidatesById.get(event.programId);
    if (!candidate) continue;

    const rejectKey = rejectKeyFor(sourceId, candidate);
    if (isRejected(db, rejectKey)) continue;

    const item: ReviewItem = {
      id: reviewItemId(event),
      changeEventId: event.id,
      candidate,
      decision: 'pending',
      confidence: confidenceFor(tier, event.kind),
      rejectKey,
    };
    insertReviewItem(db, item);
    out.push(item);
  }
  return out;
}

function require(db: Database.Database, itemId: string): ReviewItem {
  const item = getReviewItem(db, itemId);
  if (!item) throw new Error(`unknown review item "${itemId}"`);
  return item;
}

function kindOf(db: Database.Database, changeEventId: string): string {
  const row = db.prepare('SELECT kind FROM change_events WHERE id = ?').get(changeEventId) as
    | { kind: string }
    | undefined;
  return row?.kind ?? 'unknown';
}

/** The ONLY path that writes into the published corpus. */
export function approveReviewItem(
  db: Database.Database,
  itemId: string,
  userId: string,
  nowISO: string,
): Program {
  const item = require(db, itemId);
  const kind = kindOf(db, item.changeEventId);
  if (kind === 'vanished') {
    deleteProgram(db, item.candidate.id);
  } else {
    upsertProgram(db, item.candidate, sourceKeyFor(item.candidate));
  }
  setReviewDecision(db, itemId, 'approved', userId, nowISO);
  appendAuditLog(db, {
    userId,
    action: 'review.approve',
    entityType: 'review_item',
    entityId: itemId,
    detail: `approved ${kind} for ${item.candidate.name} (${item.candidate.id})`,
    atISO: nowISO,
  });
  return item.candidate;
}

export function rejectReviewItem(
  db: Database.Database,
  itemId: string,
  userId: string,
  nowISO: string,
  reason: string,
): void {
  const item = require(db, itemId);
  setReviewDecision(db, itemId, 'rejected', userId, nowISO);
  if (item.rejectKey) rememberReject(db, item.rejectKey, userId, nowISO);
  appendAuditLog(db, {
    userId,
    action: 'review.reject',
    entityType: 'review_item',
    entityId: itemId,
    detail: `rejected ${kindOf(db, item.changeEventId)} for ${item.candidate.name}: ${reason}`,
    atISO: nowISO,
  });
}

export function editReviewItem(
  db: Database.Database,
  itemId: string,
  userId: string,
  nowISO: string,
  edited: Program,
): Program {
  const item = require(db, itemId);
  upsertProgram(db, edited, sourceKeyFor(edited));
  setReviewDecision(db, itemId, 'edited', userId, nowISO, edited);
  appendAuditLog(db, {
    userId,
    action: 'review.edit',
    entityType: 'review_item',
    entityId: itemId,
    detail: `edited and published ${edited.name} (was "${item.candidate.name}")`,
    atISO: nowISO,
  });
  return edited;
}

export function listInbox(db: Database.Database, decision?: ReviewDecision): ReviewItem[] {
  return listReviewItems(db, decision);
}

export function provenanceFor(
  db: Database.Database,
  itemId: string,
): Array<{ userId: string; action: string; detail: string; atISO: string }> {
  return listAuditLog(db, itemId);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/review/ && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/review
git commit -m "feat(review): inbox with reject memory, provenance trail and approve-only publishing"
```

---

### Task 22: `federal/grantsGov.ts` — `search2` and `fetchOpportunity`

**Files:**
- Create: `packages/server/src/federal/grantsGov.ts`
- Create: `fixtures/grants-gov-federal/search2-response.json`
- Create: `fixtures/grants-gov-federal/fetch-opportunity-354102.json`
- Test: `packages/server/src/federal/grantsGov.test.ts`

**Interfaces:**
- Consumes: `Fetcher` (Task 4); `FetchRequest`, `RawOpportunity` from core.
- Produces:
  ```ts
  export const GRANTS_GOV_SEARCH_URL = 'https://api.grants.gov/v1/api/search2';
  export const GRANTS_GOV_FETCH_URL = 'https://api.grants.gov/v1/api/fetchOpportunity';
  export const GRANTS_GOV_KEYWORDS: readonly string[];
  export interface GrantsGovHit { id: string; number: string; title: string; agency: string; agencyCode: string; openDate: string; closeDate: string; oppStatus: string; docType: string; cfdaList: string[] }
  export interface GrantsGovDetail { opportunityId: string; awardCeiling?: number; awardFloor?: number; applicantTypes: string[]; responseDate?: string; postingDate?: string; lastUpdatedDate?: string; description: string }
  export function buildSearchRequest(keyword: string, rows: number, startRecordNum: number): FetchRequest;
  export function buildFetchOpportunityRequest(opportunityId: string): FetchRequest;
  export function parseGrantsGovMoney(value: unknown): number | undefined;
  export function parseSearchResponse(json: string): GrantsGovHit[];
  export function parseOpportunityDetail(json: string): GrantsGovDetail | undefined;
  export function toRawOpportunity(hit: GrantsGovHit, detail?: GrantsGovDetail): RawOpportunity;
  ```

**Two facts that will cost you a day each if you skip them:**

1. **`awardCeiling` and `awardFloor` are frequently the literal string `"none"`.** So is `"0"` in places. `parseGrantsGovMoney` must return `undefined` for `"none"`, `""`, `null` and non-numeric junk — never `NaN`, never `0`. A `0` here would render as "$0 award" in the UI, which is a wrong number, which is the product's primary failure mode.
2. **All four advertised Grants.gov RSS feeds return HTTP 200 with `text/html`** — a ~27 KB SPA shell, not XML. A naive poller finds zero items forever and never errors. `search2` is key-free and returns real JSON; use it. This warning appears in the module header, in `sources/registry.ts`, and in a test.

`search2` returns roughly 5,000 posted federal opportunities. `"amateur radio"` yields 57 hits and `"cubesat"` yields **1**. The genuinely winnable money is *adjacent* — which is Task 23's job, not this one's.

- [ ] **Step 1: Write the fixtures**

`fixtures/grants-gov-federal/search2-response.json` — note the `"none"` ceilings and a mixed bag of relevance:

```json
{
  "errorcode": 0,
  "msg": "success",
  "data": {
    "hitCount": 3,
    "oppHits": [
      {"id": "354102", "number": "NSF 26-512", "title": "Geospace Facilities", "agencyCode": "NSF", "agency": "National Science Foundation", "openDate": "07/06/2026", "closeDate": "11/14/2026", "oppStatus": "posted", "docType": "synopsis", "cfdaList": ["47.050"]},
      {"id": "354199", "number": "NSF 26-540", "title": "Advanced Technological Education (ATE)", "agencyCode": "NSF", "agency": "National Science Foundation", "openDate": "05/01/2026", "closeDate": "10/02/2026", "oppStatus": "posted", "docType": "synopsis", "cfdaList": ["47.076"]},
      {"id": "351020", "number": "HHS-2026-RAD", "title": "Radiation Oncology Outcomes Research", "agencyCode": "HHS", "agency": "Department of Health and Human Services", "openDate": "03/01/2026", "closeDate": "09/01/2026", "oppStatus": "posted", "docType": "synopsis", "cfdaList": ["93.395"]}
    ]
  }
}
```

`fixtures/grants-gov-federal/fetch-opportunity-354102.json`:

```json
{
  "errorcode": 0,
  "msg": "success",
  "data": {
    "id": 354102,
    "opportunityNumber": "NSF 26-512",
    "opportunityTitle": "Geospace Facilities",
    "synopsis": {
      "opportunityId": 354102,
      "awardCeiling": "none",
      "awardFloor": "none",
      "responseDate": "Nov 14, 2026",
      "postingDate": "Jul 06, 2026",
      "lastUpdatedDate": "Jul 21, 2026",
      "synopsisDesc": "<p>Supports facilities for ionospheric and space weather observation, including incoherent scatter radar and distributed instrument networks engaging undergraduate researchers.</p>",
      "applicantTypes": [
        {"id": "25", "description": "Others (see text field entitled \"Additional Information on Eligibility\" for clarification)"},
        {"id": "06", "description": "Public and State controlled institutions of higher education"}
      ]
    }
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/federal/grantsGov.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/fixtures.js';
import {
  GRANTS_GOV_FETCH_URL,
  GRANTS_GOV_KEYWORDS,
  GRANTS_GOV_SEARCH_URL,
  buildFetchOpportunityRequest,
  buildSearchRequest,
  parseGrantsGovMoney,
  parseOpportunityDetail,
  parseSearchResponse,
  toRawOpportunity,
} from './grantsGov.js';

const search = () => loadFixture('grants-gov-federal', 'search2-response.json');
const detail = () => loadFixture('grants-gov-federal', 'fetch-opportunity-354102.json');

describe('endpoints', () => {
  it('uses the key-free search2 and fetchOpportunity endpoints', () => {
    expect(GRANTS_GOV_SEARCH_URL).toBe('https://api.grants.gov/v1/api/search2');
    expect(GRANTS_GOV_FETCH_URL).toBe('https://api.grants.gov/v1/api/fetchOpportunity');
  });

  it('never references an RSS feed — all four return HTML, not XML', async () => {
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./grantsGov.ts', import.meta.url), 'utf8'),
    );
    expect(src).not.toMatch(/GGRSS|rss.*\.xml/i);
    expect(src).toMatch(/text\/html/);
  });

  it('carries a keyword set aimed at the adjacent money, not just "amateur radio"', () => {
    expect(GRANTS_GOV_KEYWORDS).toContain('amateur radio');
    expect(GRANTS_GOV_KEYWORDS.join('|')).toMatch(/spectrum|wireless|geospace|STEM/i);
  });
});

describe('buildSearchRequest', () => {
  it('POSTs a JSON body with the keyword, paging and posted/forecasted statuses', () => {
    const req = buildSearchRequest('amateur radio', 25, 0);
    expect(req.method).toBe('POST');
    expect(req.accept).toBe('json');
    expect(req.url).toBe(GRANTS_GOV_SEARCH_URL);
    expect(req.body).toMatchObject({
      keyword: 'amateur radio',
      rows: 25,
      startRecordNum: 0,
      oppStatuses: 'posted|forecasted',
    });
  });
});

describe('buildFetchOpportunityRequest', () => {
  it('POSTs the numeric opportunityId', () => {
    const req = buildFetchOpportunityRequest('354102');
    expect(req.url).toBe(GRANTS_GOV_FETCH_URL);
    expect(req.body).toEqual({ opportunityId: 354102 });
  });
});

describe('parseGrantsGovMoney', () => {
  it('returns undefined for the literal string "none", which Grants.gov emits constantly', () => {
    expect(parseGrantsGovMoney('none')).toBeUndefined();
    expect(parseGrantsGovMoney('None')).toBeUndefined();
  });

  it('returns undefined for empty, null and junk — never NaN and never 0', () => {
    expect(parseGrantsGovMoney('')).toBeUndefined();
    expect(parseGrantsGovMoney(null)).toBeUndefined();
    expect(parseGrantsGovMoney(undefined)).toBeUndefined();
    expect(parseGrantsGovMoney('not a number')).toBeUndefined();
  });

  it('parses real figures with and without separators', () => {
    expect(parseGrantsGovMoney('500000')).toBe(500000);
    expect(parseGrantsGovMoney('$1,250,000')).toBe(1250000);
    expect(parseGrantsGovMoney(75000)).toBe(75000);
  });

  it('keeps a genuine zero as 0, distinct from "none"', () => {
    expect(parseGrantsGovMoney('0')).toBe(0);
  });
});

describe('parseSearchResponse', () => {
  it('reads every hit with its dates, agency and CFDA list', () => {
    const hits = parseSearchResponse(search());
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({
      id: '354102',
      number: 'NSF 26-512',
      title: 'Geospace Facilities',
      agencyCode: 'NSF',
      closeDate: '11/14/2026',
      oppStatus: 'posted',
    });
    expect(hits[0].cfdaList).toEqual(['47.050']);
  });

  it('returns [] for an error envelope rather than throwing mid-crawl', () => {
    expect(parseSearchResponse('{"errorcode":1,"msg":"bad request"}')).toEqual([]);
    expect(parseSearchResponse('not json')).toEqual([]);
  });

  it('returns [] when handed the HTML SPA shell the RSS feeds serve', () => {
    expect(parseSearchResponse('<!DOCTYPE html><html><div id="root"></div></html>')).toEqual([]);
  });
});

describe('parseOpportunityDetail', () => {
  const d = () => parseOpportunityDetail(detail());

  it('turns "none" ceilings and floors into undefined', () => {
    expect(d()?.awardCeiling).toBeUndefined();
    expect(d()?.awardFloor).toBeUndefined();
  });

  it('reads the structured applicant types', () => {
    expect(d()?.applicantTypes).toEqual(
      expect.arrayContaining(['Public and State controlled institutions of higher education']),
    );
  });

  it('reads lastUpdatedDate, which is the cheap change-detection lever', () => {
    expect(d()?.lastUpdatedDate).toBe('Jul 21, 2026');
  });

  it('strips HTML out of the synopsis description', () => {
    expect(d()?.description).not.toContain('<p>');
    expect(d()?.description).toContain('ionospheric');
  });

  it('returns undefined for an error envelope', () => {
    expect(parseOpportunityDetail('{"errorcode":1}')).toBeUndefined();
  });
});

describe('toRawOpportunity', () => {
  it('builds a RawOpportunity keyed on the Grants.gov opportunity id', () => {
    const hit = parseSearchResponse(search())[0];
    const raw = toRawOpportunity(hit, parseOpportunityDetail(detail()));
    expect(raw.sourceId).toBe('grants-gov-federal');
    expect(raw.externalKey).toBe('354102');
    expect(raw.name).toBe('Geospace Facilities');
    expect(raw.sourceUrl).toContain('354102');
    expect(raw.rawFields.agency).toBe('National Science Foundation');
    expect(raw.rawFields.closeDate).toBe('11/14/2026');
    expect(raw.rawFields.applicantTypes).toContain('higher education');
    expect(raw.rawText).toContain('ionospheric');
  });

  it('omits amountRaw entirely when the ceiling is "none" rather than writing $0', () => {
    const hit = parseSearchResponse(search())[0];
    const raw = toRawOpportunity(hit, parseOpportunityDetail(detail()));
    expect(raw.rawFields.amountRaw ?? '').not.toContain('0');
  });

  it('works with no detail at all', () => {
    const raw = toRawOpportunity(parseSearchResponse(search())[1]);
    expect(raw.externalKey).toBe('354199');
    expect(raw.rawText).toContain('Advanced Technological Education');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/federal/grantsGov.test.ts
```

Expected failure: `Failed to resolve import "./grantsGov.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/federal/grantsGov.ts`:

```ts
import type { FetchRequest, RawOpportunity } from '@grantspotter/core';
import { flattenHtml } from '../sources/util/text.js';

/**
 * Grants.gov, key-free.
 *
 * DO NOT USE THE ADVERTISED RSS FEEDS. All four return HTTP 200 with content-type text/html —
 * a ~27 KB single-page-app shell, not XML. A naive poller finds zero items forever and never
 * errors, which is the worst possible failure mode. search2 below is key-free and returns real
 * JSON.
 *
 * Relevance note: "amateur radio" returns 57 hits and "cubesat" returns exactly 1. The
 * genuinely winnable federal money is ADJACENT — NSF geospace/ECCS/ATE/Noyce, NASA Space Grant
 * and MUREP, NTIA PWSCIF — which is why federal/adjacency.ts exists and why a keyword match
 * alone is not enough.
 */
export const GRANTS_GOV_SEARCH_URL = 'https://api.grants.gov/v1/api/search2';
export const GRANTS_GOV_FETCH_URL = 'https://api.grants.gov/v1/api/fetchOpportunity';
const OPPORTUNITY_PAGE = 'https://www.grants.gov/search-results-detail/';

export const GRANTS_GOV_KEYWORDS: readonly string[] = Object.freeze([
  'amateur radio',
  'radio frequency spectrum wireless STEM education',
  'geospace ionosphere space weather',
  'undergraduate radio science instrumentation',
  'technician education wireless communications',
]);

export interface GrantsGovHit {
  id: string;
  number: string;
  title: string;
  agency: string;
  agencyCode: string;
  openDate: string;
  closeDate: string;
  oppStatus: string;
  docType: string;
  cfdaList: string[];
}

export interface GrantsGovDetail {
  opportunityId: string;
  awardCeiling?: number;
  awardFloor?: number;
  applicantTypes: string[];
  responseDate?: string;
  postingDate?: string;
  lastUpdatedDate?: string;
  description: string;
}

export function buildSearchRequest(
  keyword: string,
  rows: number,
  startRecordNum: number,
): FetchRequest {
  return {
    url: GRANTS_GOV_SEARCH_URL,
    method: 'POST',
    accept: 'json',
    body: {
      keyword,
      rows,
      startRecordNum,
      oppStatuses: 'posted|forecasted',
      sortBy: 'openDate|desc',
    },
  };
}

export function buildFetchOpportunityRequest(opportunityId: string): FetchRequest {
  return {
    url: GRANTS_GOV_FETCH_URL,
    method: 'POST',
    accept: 'json',
    body: { opportunityId: Number.parseInt(opportunityId, 10) },
  };
}

/**
 * awardCeiling and awardFloor are FREQUENTLY the literal string "none". Returning 0 here would
 * render "$0 award" in the UI, and a confidently-displayed wrong number is this product's
 * primary failure mode. A genuine "0" is preserved and is distinct from "none".
 */
export function parseGrantsGovMoney(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || /^none$/i.test(trimmed)) return undefined;
  const digits = trimmed.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(digits)) return undefined;
  const n = Number.parseFloat(digits);
  return Number.isFinite(n) ? n : undefined;
}

function safeJson(json: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function parseSearchResponse(json: string): GrantsGovHit[] {
  const root = safeJson(json);
  if (!root || root.errorcode !== 0) return [];
  const data = root.data as { oppHits?: unknown } | undefined;
  if (!data || !Array.isArray(data.oppHits)) return [];
  return (data.oppHits as Array<Record<string, unknown>>).map((h) => ({
    id: String(h.id ?? ''),
    number: String(h.number ?? ''),
    title: String(h.title ?? ''),
    agency: String(h.agency ?? ''),
    agencyCode: String(h.agencyCode ?? ''),
    openDate: String(h.openDate ?? ''),
    closeDate: String(h.closeDate ?? ''),
    oppStatus: String(h.oppStatus ?? ''),
    docType: String(h.docType ?? ''),
    cfdaList: Array.isArray(h.cfdaList) ? (h.cfdaList as unknown[]).map(String) : [],
  }));
}

export function parseOpportunityDetail(json: string): GrantsGovDetail | undefined {
  const root = safeJson(json);
  if (!root || root.errorcode !== 0) return undefined;
  const data = root.data as Record<string, unknown> | undefined;
  const synopsis = data?.synopsis as Record<string, unknown> | undefined;
  if (!synopsis) return undefined;

  const applicantTypes = Array.isArray(synopsis.applicantTypes)
    ? (synopsis.applicantTypes as Array<Record<string, unknown>>).map((t) =>
        String(t.description ?? t.id ?? ''),
      )
    : [];

  const detail: GrantsGovDetail = {
    opportunityId: String(synopsis.opportunityId ?? data?.id ?? ''),
    awardCeiling: parseGrantsGovMoney(synopsis.awardCeiling),
    awardFloor: parseGrantsGovMoney(synopsis.awardFloor),
    applicantTypes,
    description: flattenHtml(String(synopsis.synopsisDesc ?? '')),
  };
  if (typeof synopsis.responseDate === 'string') detail.responseDate = synopsis.responseDate;
  if (typeof synopsis.postingDate === 'string') detail.postingDate = synopsis.postingDate;
  if (typeof synopsis.lastUpdatedDate === 'string') detail.lastUpdatedDate = synopsis.lastUpdatedDate;
  return detail;
}

export function toRawOpportunity(hit: GrantsGovHit, detail?: GrantsGovDetail): RawOpportunity {
  const rawFields: Record<string, string> = {
    opportunityNumber: hit.number,
    agency: hit.agency,
    agencyCode: hit.agencyCode,
    openDate: hit.openDate,
    closeDate: hit.closeDate,
    oppStatus: hit.oppStatus,
    docType: hit.docType,
    cfda: hit.cfdaList.join(', '),
  };
  if (detail) {
    if (detail.applicantTypes.length > 0) rawFields.applicantTypes = detail.applicantTypes.join('; ');
    if (detail.lastUpdatedDate) rawFields.lastUpdatedDate = detail.lastUpdatedDate;
    if (detail.responseDate) rawFields.responseDate = detail.responseDate;
    // Only write amountRaw when there is a real figure. "none" must not become "$0".
    const floor = detail.awardFloor;
    const ceiling = detail.awardCeiling;
    if (floor !== undefined || ceiling !== undefined) {
      rawFields.amountRaw = [
        floor !== undefined ? `$${floor.toLocaleString('en-US')}` : undefined,
        ceiling !== undefined ? `$${ceiling.toLocaleString('en-US')}` : undefined,
      ]
        .filter(Boolean)
        .join(' to ');
    }
  }

  return {
    sourceId: 'grants-gov-federal',
    externalKey: hit.id,
    name: hit.title,
    rawFields,
    sourceUrl: `${OPPORTUNITY_PAGE}${hit.id}`,
    rawText: [hit.title, hit.agency, detail?.description ?? ''].filter(Boolean).join('\n'),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/federal/ && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/federal/grantsGov.ts packages/server/src/federal/grantsGov.test.ts \
  fixtures/grants-gov-federal
git commit -m "feat(federal): Grants.gov search2 and fetchOpportunity with literal-none money handling"
```

---

### Task 23: `federal/adjacency.ts` — a weighted vocabulary scorer, not a keyword match

**Files:**
- Create: `packages/server/src/federal/adjacency.ts`
- Test: `packages/server/src/federal/adjacency.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface AdjacencyTerm { term: string; weight: number }
  export const ADJACENCY_VOCABULARY: readonly AdjacencyTerm[];
  export const ADJACENCY_THRESHOLD: 6;
  export function scoreAdjacency(text: string): { score: number; hits: string[] };   // CONTRACT §5
  export function isAdjacent(text: string): boolean;
  ```

**Why a scorer and not a keyword match.** `"amateur radio"` returns 57 Grants.gov hits; `"cubesat"` returns **1**. The federal money a collegiate ham club can actually win is *adjacent*: NSF **geospace**, **ECCS**, **ATE**, **Noyce**; NASA **Space Grant** and **MUREP**; NTIA **PWSCIF**. A bare keyword match on "radio" fires on radiology, radiotherapy and public broadcasting; a match on "STEM education" fires on thousands of irrelevant awards. So: a weighted vocabulary of multi-word phrases, with negative weights for the classic false-positive families, summed over **distinct** matched terms (a term repeated ten times still counts once, so a verbose abstract cannot inflate its own score).

**The scoring rule, stated exactly:**

| Tier | Weight | What it captures | Terms |
|---|---|---|---|
| 1 | **+5** | Direct ham / radio-science signal | `amateur radio`, `ham radio`, `shortwave`, `ionospheric`, `ionosphere`, `HF propagation`, `radio science`, `spectrum monitoring`, `software-defined radio`, `software defined radio`, `SDR`, `cubesat`, `ground station`, `radio astronomy`, `reverse beacon` |
| 2 | **+3** | The named adjacent programs that are genuinely winnable | `geospace`, `space weather`, `heliophysics`, `ECCS`, `Electrical, Communications and Cyber Systems`, `Advanced Technological Education`, `ATE`, `Noyce`, `MUREP`, `Space Grant`, `PWSCIF`, `Public Wireless Supply Chain Innovation Fund`, `spectrum sharing`, `wireless innovation`, `RF engineering`, `antenna`, `telemetry`, `radio frequency spectrum` |
| 3 | **+2** | Audience fit for a collegiate or K-12 club | `undergraduate research`, `community college`, `minority serving institution`, `HBCU`, `Hispanic-Serving Institution`, `Tribal College`, `student organization`, `student branch`, `K-12 STEM`, `teacher professional development`, `informal science education`, `makerspace` |
| 4 | **+1** | Generic STEM context — never enough on its own | `STEM education`, `workforce development`, `broadening participation`, `curriculum development`, `laboratory equipment`, `hands-on learning`, `experiential learning`, `outreach` |
| — | **−4** | The false-positive families that a naive "radio" match hits | `radiation oncology`, `radiotherapy`, `radiopharmaceutical`, `radiology`, `radiologist`, `radioactive`, `radiocarbon`, `radiofrequency ablation`, `public broadcasting`, `broadcast television` |

**Threshold: `ADJACENCY_THRESHOLD = 6`.** One Tier-1 term (5) plus any Tier-4 term (1) clears it; two Tier-2 terms (3+3) clear it; one Tier-2 plus two Tier-3 (3+2+2) clear it. A lone `STEM education` (1) or a lone `antenna` (3) does not. The score is clamped at a floor of 0, so a negative-weighted document scores 0 rather than going negative.

Matching is case-insensitive with non-alphanumeric boundaries, so `SDR` does not match inside `SDRAM` and `ATE` does not match inside `CANDIDATE`.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/federal/adjacency.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ADJACENCY_THRESHOLD, ADJACENCY_VOCABULARY, isAdjacent, scoreAdjacency } from './adjacency.js';

describe('the vocabulary itself', () => {
  it('pins the threshold at 6', () => {
    expect(ADJACENCY_THRESHOLD).toBe(6);
  });

  it('has no duplicate terms and every weight is a non-zero integer', () => {
    const terms = ADJACENCY_VOCABULARY.map((t) => t.term.toLowerCase());
    expect(new Set(terms).size).toBe(terms.length);
    for (const t of ADJACENCY_VOCABULARY) {
      expect(Number.isInteger(t.weight)).toBe(true);
      expect(t.weight).not.toBe(0);
    }
  });

  it('carries the four named adjacent programs the research identified', () => {
    const joined = ADJACENCY_VOCABULARY.map((t) => t.term).join('|');
    for (const term of ['geospace', 'Advanced Technological Education', 'Noyce', 'MUREP', 'Space Grant', 'PWSCIF']) {
      expect(joined).toContain(term);
    }
  });

  it('carries negative weights for the radiology family', () => {
    const negatives = ADJACENCY_VOCABULARY.filter((t) => t.weight < 0).map((t) => t.term);
    expect(negatives).toEqual(expect.arrayContaining(['radiation oncology', 'radiology', 'radiotherapy']));
  });
});

describe('scoreAdjacency', () => {
  it('scores a direct ham signal plus context above the threshold', () => {
    const r = scoreAdjacency('Amateur radio ionospheric sounding with a distributed STEM education component.');
    expect(r.score).toBeGreaterThanOrEqual(ADJACENCY_THRESHOLD);
    expect(r.hits).toEqual(expect.arrayContaining(['amateur radio', 'ionospheric', 'STEM education']));
  });

  it('scores the real NSF geospace case as adjacent', () => {
    expect(
      isAdjacent(
        'Geospace Facilities supports incoherent scatter radar and space weather instrumentation engaging undergraduate research.',
      ),
    ).toBe(true);
  });

  it('scores the real ATE community-college case as adjacent', () => {
    expect(
      isAdjacent(
        'Advanced Technological Education supports technician education at community college programs in wireless innovation.',
      ),
    ).toBe(true);
  });

  it('scores NASA Space Grant plus MUREP as adjacent', () => {
    expect(isAdjacent('The Space Grant consortium partners with MUREP on student projects.')).toBe(true);
  });

  it('does NOT clear the threshold on generic STEM language alone', () => {
    const r = scoreAdjacency('This program supports STEM education and workforce development.');
    expect(r.score).toBeLessThan(ADJACENCY_THRESHOLD);
    expect(isAdjacent('This program supports STEM education and workforce development.')).toBe(false);
  });

  it('does NOT fire on a single generic term', () => {
    expect(isAdjacent('An outreach program.')).toBe(false);
    expect(isAdjacent('Antenna design coursework.')).toBe(false);
  });

  it('rejects the radiology family that a naive "radio" match would catch', () => {
    const r = scoreAdjacency(
      'Radiation Oncology Outcomes Research: radiotherapy dosimetry and radiopharmaceutical STEM education training.',
    );
    expect(r.score).toBe(0);
    expect(isAdjacent(r.hits.join(' '))).toBe(false);
  });

  it('rejects public broadcasting', () => {
    expect(isAdjacent('Grants for public broadcasting and broadcast television station upgrades.')).toBe(false);
  });

  it('counts a repeated term only once, so a verbose abstract cannot inflate itself', () => {
    const once = scoreAdjacency('amateur radio');
    const tenTimes = scoreAdjacency(Array(10).fill('amateur radio').join(' '));
    expect(tenTimes.score).toBe(once.score);
    expect(tenTimes.hits).toEqual(['amateur radio']);
  });

  it('is case-insensitive', () => {
    expect(scoreAdjacency('AMATEUR RADIO').score).toBe(scoreAdjacency('amateur radio').score);
  });

  it('respects word boundaries: SDR does not match SDRAM, ATE does not match CANDIDATE', () => {
    expect(scoreAdjacency('SDRAM memory modules').hits).not.toContain('SDR');
    expect(scoreAdjacency('the successful CANDIDATE will').hits).not.toContain('ATE');
    expect(scoreAdjacency('an SDR receiver').hits).toContain('SDR');
  });

  it('clamps to a floor of zero rather than going negative', () => {
    expect(scoreAdjacency('radiology radiotherapy radioactive radiocarbon').score).toBe(0);
  });

  it('returns zero and no hits for empty input', () => {
    expect(scoreAdjacency('')).toEqual({ score: 0, hits: [] });
  });

  it('returns hits in descending weight order so the UI can explain itself', () => {
    const r = scoreAdjacency('STEM education using amateur radio and geospace data.');
    expect(r.hits[0]).toBe('amateur radio');
    expect(r.hits[r.hits.length - 1]).toBe('STEM education');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/federal/adjacency.test.ts
```

Expected failure: `Failed to resolve import "./adjacency.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/federal/adjacency.ts`:

```ts
export interface AdjacencyTerm {
  term: string;
  weight: number;
}

/**
 * A WEIGHTED VOCABULARY, not a keyword match.
 *
 * "amateur radio" returns 57 Grants.gov hits and "cubesat" returns exactly 1. The federal money
 * a collegiate ham club can actually win is ADJACENT: NSF geospace / ECCS / ATE / Noyce, NASA
 * Space Grant and MUREP, NTIA PWSCIF. Meanwhile a bare "radio" match fires on radiology,
 * radiotherapy and public broadcasting, and a bare "STEM education" match fires on thousands of
 * irrelevant awards. Hence multi-word phrases with weights, negative weights for the classic
 * false-positive families, and a threshold that generic language alone cannot clear.
 */
export const ADJACENCY_VOCABULARY: readonly AdjacencyTerm[] = Object.freeze([
  // Tier 1 (+5) — direct ham / radio-science signal
  { term: 'amateur radio', weight: 5 },
  { term: 'ham radio', weight: 5 },
  { term: 'shortwave', weight: 5 },
  { term: 'ionospheric', weight: 5 },
  { term: 'ionosphere', weight: 5 },
  { term: 'HF propagation', weight: 5 },
  { term: 'radio science', weight: 5 },
  { term: 'spectrum monitoring', weight: 5 },
  { term: 'software-defined radio', weight: 5 },
  { term: 'software defined radio', weight: 5 },
  { term: 'SDR', weight: 5 },
  { term: 'cubesat', weight: 5 },
  { term: 'ground station', weight: 5 },
  { term: 'radio astronomy', weight: 5 },
  { term: 'reverse beacon', weight: 5 },

  // Tier 2 (+3) — the named adjacent programs that are genuinely winnable
  { term: 'geospace', weight: 3 },
  { term: 'space weather', weight: 3 },
  { term: 'heliophysics', weight: 3 },
  { term: 'ECCS', weight: 3 },
  { term: 'Electrical, Communications and Cyber Systems', weight: 3 },
  { term: 'Advanced Technological Education', weight: 3 },
  { term: 'ATE', weight: 3 },
  { term: 'Noyce', weight: 3 },
  { term: 'MUREP', weight: 3 },
  { term: 'Space Grant', weight: 3 },
  { term: 'PWSCIF', weight: 3 },
  { term: 'Public Wireless Supply Chain Innovation Fund', weight: 3 },
  { term: 'spectrum sharing', weight: 3 },
  { term: 'wireless innovation', weight: 3 },
  { term: 'RF engineering', weight: 3 },
  { term: 'antenna', weight: 3 },
  { term: 'telemetry', weight: 3 },
  { term: 'radio frequency spectrum', weight: 3 },

  // Tier 3 (+2) — audience fit
  { term: 'undergraduate research', weight: 2 },
  { term: 'community college', weight: 2 },
  { term: 'minority serving institution', weight: 2 },
  { term: 'HBCU', weight: 2 },
  { term: 'Hispanic-Serving Institution', weight: 2 },
  { term: 'Tribal College', weight: 2 },
  { term: 'student organization', weight: 2 },
  { term: 'student branch', weight: 2 },
  { term: 'K-12 STEM', weight: 2 },
  { term: 'teacher professional development', weight: 2 },
  { term: 'informal science education', weight: 2 },
  { term: 'makerspace', weight: 2 },

  // Tier 4 (+1) — generic STEM context, never enough on its own
  { term: 'STEM education', weight: 1 },
  { term: 'workforce development', weight: 1 },
  { term: 'broadening participation', weight: 1 },
  { term: 'curriculum development', weight: 1 },
  { term: 'laboratory equipment', weight: 1 },
  { term: 'hands-on learning', weight: 1 },
  { term: 'experiential learning', weight: 1 },
  { term: 'outreach', weight: 1 },

  // Negative (-4) — the false-positive families a naive "radio" match hits
  { term: 'radiation oncology', weight: -4 },
  { term: 'radiotherapy', weight: -4 },
  { term: 'radiopharmaceutical', weight: -4 },
  { term: 'radiology', weight: -4 },
  { term: 'radiologist', weight: -4 },
  { term: 'radioactive', weight: -4 },
  { term: 'radiocarbon', weight: -4 },
  { term: 'radiofrequency ablation', weight: -4 },
  { term: 'public broadcasting', weight: -4 },
  { term: 'broadcast television', weight: -4 },
]);

/**
 * One Tier-1 term (5) plus any Tier-4 term (1) clears this; two Tier-2 terms (3+3) clear it;
 * one Tier-2 plus two Tier-3 (3+2+2) clear it. A lone "STEM education" or a lone "antenna"
 * does not.
 */
export const ADJACENCY_THRESHOLD = 6 as const;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Non-alphanumeric boundaries, so SDR does not match SDRAM and ATE does not match CANDIDATE.
const MATCHERS: ReadonlyArray<{ term: AdjacencyTerm; re: RegExp }> = ADJACENCY_VOCABULARY.map(
  (term) => ({
    term,
    re: new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(term.term)}(?![A-Za-z0-9])`, 'i'),
  }),
);

/** CONTRACT §5. Distinct terms only: a term repeated ten times still counts once. */
export function scoreAdjacency(text: string): { score: number; hits: string[] } {
  if (text.trim() === '') return { score: 0, hits: [] };
  const matched: AdjacencyTerm[] = [];
  for (const { term, re } of MATCHERS) {
    if (re.test(text)) matched.push(term);
  }
  const score = Math.max(0, matched.reduce((sum, t) => sum + t.weight, 0));
  const hits = matched
    .slice()
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .map((t) => t.term);
  return { score, hits };
}

export function isAdjacent(text: string): boolean {
  return scoreAdjacency(text).score >= ADJACENCY_THRESHOLD;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/federal/ && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/federal/adjacency.ts packages/server/src/federal/adjacency.test.ts
git commit -m "feat(federal): weighted adjacency vocabulary scorer with negative false-positive terms"
```

---

### Task 24: `sources/grants-gov-federal.ts` — the federal sweep as a source module

**Files:**
- Create: `packages/server/src/sources/grants-gov-federal.ts`
- Create: `packages/server/src/federal/simplerGrants.ts`
- Create: `fixtures/grants-gov-federal/simpler-search-response.json`
- Test: `packages/server/src/sources/grants-gov-federal.test.ts`
- Test: `packages/server/src/federal/simplerGrants.test.ts`
- Modify: `packages/server/src/sources/registry.ts`
- Modify: `packages/server/src/fetcher/index.ts` — honour `FetchOptions.headersByHost`
- Modify: `packages/server/src/index.ts` — pass the Simpler auth header into `createFetcher`

**Interfaces:**
- Consumes: `buildSearchRequest`, `buildFetchOpportunityRequest`, `parseSearchResponse`, `parseOpportunityDetail`, `toRawOpportunity`, `GRANTS_GOV_KEYWORDS` (Task 22); `scoreAdjacency`, `ADJACENCY_THRESHOLD` (Task 23); `FollowUpSource` (Task 6).
- Produces:
  ```ts
  export const grantsGovFederal: FollowUpSource;
  // federal/simplerGrants.ts
  export const SIMPLER_GRANTS_SEARCH_URL = 'https://api.simpler.grants.gov/v1/opportunities/search';
  export interface SimplerGrantsHit { opportunityNumber: string; title: string; agency: string; summary: string; relevancy: number }
  export function simplerGrantsApiKey(): string | undefined;
  export function simplerAuthHeaders(): Record<string, Record<string, string>>;   // for FetchOptions.headersByHost
  export function simplerSearchRequests(keywords: readonly string[]): FetchRequest[];
  export function parseSimplerResponse(json: string): SimplerGrantsHit[];
  export function blendSimplerRelevance(base: { score: number; hits: string[] }, hit: SimplerGrantsHit | undefined): { score: number; hits: string[] };
  ```

**Shape.** Phase 1 issues one `search2` POST per keyword in `GRANTS_GOV_KEYWORDS` (5 requests, all to one host, so the fetcher serializes them automatically). `followUp` scores every hit with `scoreAdjacency` over `title + agency`, keeps those at or above `ADJACENCY_THRESHOLD`, caps the follow-up at **25 detail fetches per night** so a broad keyword cannot turn into a 250-request crawl, and issues one `fetchOpportunity` POST each. `parse` re-scores using the *hydrated* description — which is much richer than the title — and emits only the survivors, stamping the score and hits into `rawFields` so the reviewer can see *why* a federal record is in the inbox.

Nothing here publishes: federal candidates enter the same review queue as everything else (spec §3.2).

**Simpler.Grants.gov is optional and never a hard dependency** (spec §7.5, coverage finding #10). `SIMPLER_GRANTS_API_KEY` is a free Login.gov-issued key. When it is set, `requests` additionally issues `POST https://api.simpler.grants.gov/v1/opportunities/search` per keyword and `parse` blends that API's own `relevancy` into the deterministic adjacency score, producing better *ranking*. When it is absent, `simplerSearchRequests` returns `[]`, no Simpler request is ever made, and the module behaves exactly as the search2-only path always did. **The key never gates whether federal opportunities are found — only how well they are ordered.** Both branches are tested offline against fixtures.

The key travels as an `X-Auth` header, and `FetchRequest` (CONTRACT §3) has no header field, so it is supplied at the transport layer: `FetchOptions` gains the additive optional `headersByHost?: Record<string, Record<string, string>>` and `createFetcher` merges the entry whose key equals the request's hostname. `federal/simplerGrants.ts` is the single place that reads `process.env.SIMPLER_GRANTS_API_KEY`; `sources/` stays free of environment reads.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/sources/grants-gov-federal.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { GRANTS_GOV_SEARCH_URL } from '../federal/grantsGov.js';
import { SIMPLER_GRANTS_SEARCH_URL } from '../federal/simplerGrants.js';
import { resolveRequests } from './types.js';
import { grantsGovFederal } from './grants-gov-federal.js';

const searchPayload = () =>
  fixturePayload('grants-gov-federal', 'search2-response.json', GRANTS_GOV_SEARCH_URL);
const detailPayload = () =>
  fixturePayload(
    'grants-gov-federal',
    'fetch-opportunity-354102.json',
    'https://api.grants.gov/v1/api/fetchOpportunity#354102',
  );

describe('grantsGovFederal module shape', () => {
  it('is Tier A, adjacent_stem, and issues one search per keyword', async () => {
    delete process.env.SIMPLER_GRANTS_API_KEY; // the search2-only baseline
    expect(grantsGovFederal.tier).toBe('A');
    expect(grantsGovFederal.klass).toBe('adjacent_stem');
    // `requests` is a function (the optional Simpler leg is decided at resolve time), so it is
    // resolved rather than read as an array.
    const requests = await resolveRequests(grantsGovFederal);
    expect(requests.length).toBeGreaterThanOrEqual(5);
    for (const r of requests) {
      expect(r.url).toBe(GRANTS_GOV_SEARCH_URL);
      expect(r.method).toBe('POST');
    }
  });

  it('warns in notes about the four HTML-serving RSS feeds', () => {
    expect(grantsGovFederal.notes).toMatch(/RSS/);
    expect(grantsGovFederal.notes).toMatch(/text\/html/);
    expect(grantsGovFederal.notes).toMatch(/never errors/i);
  });
});

describe('followUp', () => {
  it('hydrates only the hits that clear the adjacency threshold', () => {
    const requests = grantsGovFederal.followUp([searchPayload()]);
    const ids = requests.map((r) => (r.body as { opportunityId: number }).opportunityId);
    expect(ids).toContain(354102); // Geospace Facilities
    expect(ids).toContain(354199); // Advanced Technological Education
    expect(ids).not.toContain(351020); // Radiation Oncology
  });

  it('caps the nightly detail fetches so a broad keyword cannot become a 250-request crawl', () => {
    const many = {
      ...searchPayload(),
      body: JSON.stringify({
        errorcode: 0,
        data: {
          hitCount: 60,
          oppHits: Array.from({ length: 60 }, (_, i) => ({
            id: String(400000 + i),
            number: `N-${i}`,
            title: 'Amateur radio ionospheric STEM education',
            agency: 'NSF',
            agencyCode: 'NSF',
            openDate: '',
            closeDate: '',
            oppStatus: 'posted',
            docType: 'synopsis',
            cfdaList: [],
          })),
        },
      }),
    };
    expect(grantsGovFederal.followUp([many]).length).toBeLessThanOrEqual(25);
  });

  it('returns [] when the search payload is missing or errored', () => {
    expect(grantsGovFederal.followUp([])).toEqual([]);
    expect(
      grantsGovFederal.followUp([{ ...searchPayload(), body: '{"errorcode":1}' }]),
    ).toEqual([]);
  });

  it('deduplicates ids that appear under more than one keyword', () => {
    const requests = grantsGovFederal.followUp([searchPayload(), searchPayload()]);
    const ids = requests.map((r) => (r.body as { opportunityId: number }).opportunityId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parse', () => {
  it('emits only adjacent records and stamps the score and hits for the reviewer', () => {
    const raws = grantsGovFederal.parse([searchPayload(), detailPayload()]);
    const geospace = raws.find((r) => r.externalKey === '354102');
    expect(geospace).toBeDefined();
    expect(Number(geospace?.rawFields.adjacencyScore)).toBeGreaterThanOrEqual(6);
    expect(geospace?.rawFields.adjacencyHits).toMatch(/ionospheric|geospace/);
  });

  it('drops the radiology hit even though it reached the parse stage', () => {
    const raws = grantsGovFederal.parse([searchPayload(), detailPayload()]);
    expect(raws.map((r) => r.externalKey)).not.toContain('351020');
  });

  it('re-scores using the hydrated description, which is far richer than the title', () => {
    const withDetail = grantsGovFederal.parse([searchPayload(), detailPayload()]);
    const withoutDetail = grantsGovFederal.parse([searchPayload()]);
    const a = withDetail.find((r) => r.externalKey === '354102');
    const b = withoutDetail.find((r) => r.externalKey === '354102');
    expect(Number(a?.rawFields.adjacencyScore)).toBeGreaterThan(Number(b?.rawFields.adjacencyScore ?? 0));
  });

  it('returns [] when there is no search payload', () => {
    expect(grantsGovFederal.parse([])).toEqual([]);
  });
});
```

Create `fixtures/grants-gov-federal/simpler-search-response.json` — a real-shaped Simpler.Grants.gov response for the same two opportunities:

```json
{
  "data": [
    {
      "opportunity_number": "NSF 26-512",
      "opportunity_title": "Geospace Facilities",
      "agency_name": "National Science Foundation",
      "summary": {
        "summary_description": "Support for the operation of geospace observing facilities, including incoherent scatter radar and ionospheric sounding instrumentation."
      },
      "relevancy_score": 0.91
    },
    {
      "opportunity_number": "NSF 26-540",
      "opportunity_title": "Advanced Technological Education (ATE)",
      "agency_name": "National Science Foundation",
      "summary": {
        "summary_description": "Technician education in advanced technology fields, including electronics and telecommunications, at two-year colleges."
      },
      "relevancy_score": 0.42
    }
  ],
  "pagination_info": { "page_offset": 1, "page_size": 25, "total_records": 2 }
}
```

Create `packages/server/src/federal/simplerGrants.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/fixtures.js';
import {
  SIMPLER_GRANTS_SEARCH_URL,
  blendSimplerRelevance,
  parseSimplerResponse,
  simplerAuthHeaders,
  simplerSearchRequests,
} from './simplerGrants.js';

afterEach(() => {
  delete process.env.SIMPLER_GRANTS_API_KEY;
});

describe('the key is optional and never a hard dependency', () => {
  it('issues no request at all when SIMPLER_GRANTS_API_KEY is absent', () => {
    delete process.env.SIMPLER_GRANTS_API_KEY;
    expect(simplerSearchRequests(['amateur radio'])).toEqual([]);
    expect(simplerAuthHeaders()).toEqual({});
  });

  it('treats an empty or whitespace key as absent', () => {
    process.env.SIMPLER_GRANTS_API_KEY = '   ';
    expect(simplerSearchRequests(['amateur radio'])).toEqual([]);
  });

  it('issues one POST per keyword when the key is present', () => {
    process.env.SIMPLER_GRANTS_API_KEY = 'test-key';
    const requests = simplerSearchRequests(['amateur radio', 'cubesat']);
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r.url).toBe(SIMPLER_GRANTS_SEARCH_URL);
      expect(r.method).toBe('POST');
      expect(r.accept).toBe('json');
    }
    expect(JSON.stringify(requests[0].body)).toContain('amateur radio');
  });

  it('supplies the X-Auth header by host, because FetchRequest has no header field', () => {
    process.env.SIMPLER_GRANTS_API_KEY = 'test-key';
    expect(simplerAuthHeaders()).toEqual({
      'api.simpler.grants.gov': { 'X-Auth': 'test-key' },
    });
  });
});

describe('parseSimplerResponse', () => {
  const body = () => loadFixture('grants-gov-federal', 'simpler-search-response.json');

  it('reads the opportunity number, title, agency, summary and relevancy', () => {
    const hits = parseSimplerResponse(body());
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      opportunityNumber: 'NSF 26-512',
      title: 'Geospace Facilities',
      agency: 'National Science Foundation',
      relevancy: 0.91,
    });
    expect(hits[0].summary).toMatch(/incoherent scatter radar/);
  });

  it('returns [] for junk instead of throwing — this path must never break a crawl', () => {
    expect(parseSimplerResponse('not json')).toEqual([]);
    expect(parseSimplerResponse('{}')).toEqual([]);
    expect(parseSimplerResponse('{"data":"nope"}')).toEqual([]);
  });
});

describe('blendSimplerRelevance', () => {
  const base = { score: 6, hits: ['ionospheric'] };

  it('is the identity when there is no Simpler hit — the deterministic score stands alone', () => {
    expect(blendSimplerRelevance(base, undefined)).toEqual(base);
  });

  it('lifts a highly-relevant record and names the reason', () => {
    const blended = blendSimplerRelevance(base, {
      opportunityNumber: 'NSF 26-512',
      title: 'Geospace Facilities',
      agency: 'NSF',
      summary: '',
      relevancy: 0.91,
    });
    expect(blended.score).toBeGreaterThan(base.score);
    expect(blended.hits).toContain('simpler:0.91');
  });

  it('never lowers the deterministic score, so the key cannot hide an opportunity', () => {
    const blended = blendSimplerRelevance(base, {
      opportunityNumber: 'X',
      title: 'X',
      agency: 'X',
      summary: '',
      relevancy: 0,
    });
    expect(blended.score).toBeGreaterThanOrEqual(base.score);
  });
});
```

Add to `packages/server/src/sources/grants-gov-federal.test.ts`:

```ts
describe('Simpler.Grants.gov is optional (spec §7.5)', () => {
  const simplerPayload = () =>
    fixturePayload('grants-gov-federal', 'simpler-search-response.json', SIMPLER_GRANTS_SEARCH_URL);

  afterEach(() => {
    delete process.env.SIMPLER_GRANTS_API_KEY;
  });

  it('without a key: search2 only, and every federal record is still found', async () => {
    delete process.env.SIMPLER_GRANTS_API_KEY;
    const requests = await resolveRequests(grantsGovFederal);
    expect(requests.every((r) => r.url === GRANTS_GOV_SEARCH_URL)).toBe(true);
    const raws = grantsGovFederal.parse([searchPayload(), detailPayload()]);
    expect(raws.map((r) => r.externalKey)).toContain('354102');
  });

  it('with a key: Simpler searches are added and relevance is blended, not gated', async () => {
    process.env.SIMPLER_GRANTS_API_KEY = 'test-key';
    const requests = await resolveRequests(grantsGovFederal);
    expect(requests.some((r) => r.url === SIMPLER_GRANTS_SEARCH_URL)).toBe(true);

    const withoutSimpler = grantsGovFederal.parse([searchPayload(), detailPayload()]);
    const withSimpler = grantsGovFederal.parse([searchPayload(), detailPayload(), simplerPayload()]);
    // Same records either way — the key changes ranking, never membership.
    expect(withSimpler.map((r) => r.externalKey).sort()).toEqual(
      withoutSimpler.map((r) => r.externalKey).sort(),
    );
    const a = withSimpler.find((r) => r.externalKey === '354102');
    const b = withoutSimpler.find((r) => r.externalKey === '354102');
    expect(Number(a?.rawFields.adjacencyScore)).toBeGreaterThan(Number(b?.rawFields.adjacencyScore));
    expect(a?.rawFields.adjacencyHits).toContain('simpler:');
  });
});
```

(the imports for `afterEach`, `resolveRequests` and `SIMPLER_GRANTS_SEARCH_URL` are already in the header written in Step 1.)

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/grants-gov-federal.test.ts \
  packages/server/src/federal/simplerGrants.test.ts
```

Expected failure: `Failed to resolve import "./grants-gov-federal.js"` and `"./simplerGrants.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/federal/simplerGrants.ts`:

```ts
import type { FetchRequest } from '@grantspotter/core';

/**
 * Spec §7.5. Simpler.Grants.gov is the modern rewrite of the Grants.gov API. Its key is free
 * (Login.gov issues it), and it is OPTIONAL AND NEVER A HARD DEPENDENCY: with a key the federal
 * sweep ranks better, without one it behaves exactly as it always did. Nothing about which
 * opportunities are discovered depends on it — only their ordering.
 *
 * This is the single module in the server that reads SIMPLER_GRANTS_API_KEY. It is read at call
 * time, never at module load, so a test can set and unset it.
 */
export const SIMPLER_GRANTS_SEARCH_URL = 'https://api.simpler.grants.gov/v1/opportunities/search';
const SIMPLER_GRANTS_HOST = 'api.simpler.grants.gov';

export interface SimplerGrantsHit {
  opportunityNumber: string;
  title: string;
  agency: string;
  summary: string;
  relevancy: number; // 0..1 as reported by the API
}

export function simplerGrantsApiKey(): string | undefined {
  const key = process.env.SIMPLER_GRANTS_API_KEY ?? '';
  return key.trim() === '' ? undefined : key.trim();
}

/**
 * FetchRequest (CONTRACT §3) carries no headers, so the X-Auth credential is supplied at the
 * transport layer through FetchOptions.headersByHost. Empty object when there is no key, which
 * means the fetcher adds nothing.
 */
export function simplerAuthHeaders(): Record<string, Record<string, string>> {
  const key = simplerGrantsApiKey();
  return key === undefined ? {} : { [SIMPLER_GRANTS_HOST]: { 'X-Auth': key } };
}

/** [] when there is no key — no key means no call, ever. */
export function simplerSearchRequests(keywords: readonly string[]): FetchRequest[] {
  if (simplerGrantsApiKey() === undefined) return [];
  return keywords.map((keyword) => ({
    url: SIMPLER_GRANTS_SEARCH_URL,
    method: 'POST',
    accept: 'json',
    body: {
      query: keyword,
      filters: { opportunity_status: { one_of: ['posted', 'forecasted'] } },
      pagination: {
        page_offset: 1,
        page_size: 25,
        sort_order: [{ order_by: 'relevancy', sort_direction: 'descending' }],
      },
    },
  }));
}

/** Junk in, [] out. A malformed optional response must never break a crawl. */
export function parseSimplerResponse(json: string): SimplerGrantsHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: SimplerGrantsHit[] = [];
  for (const entry of data) {
    const row = entry as Record<string, unknown>;
    const summary = (row.summary ?? {}) as Record<string, unknown>;
    const relevancy = Number(row.relevancy_score);
    out.push({
      opportunityNumber: String(row.opportunity_number ?? ''),
      title: String(row.opportunity_title ?? ''),
      agency: String(row.agency_name ?? ''),
      summary: String(summary.summary_description ?? ''),
      relevancy: Number.isFinite(relevancy) ? Math.min(1, Math.max(0, relevancy)) : 0,
    });
  }
  return out;
}

/**
 * Blends the API's own relevancy into the deterministic adjacency score. Additive and
 * non-negative BY CONSTRUCTION: supplying a key can only raise a record's rank, never lower it,
 * so a missing or degraded Simpler response can never hide an opportunity a user would have seen.
 */
export function blendSimplerRelevance(
  base: { score: number; hits: string[] },
  hit: SimplerGrantsHit | undefined,
): { score: number; hits: string[] } {
  if (hit === undefined) return base;
  const bonus = Math.round(hit.relevancy * 4 * 100) / 100; // 0..4, two decimals
  if (bonus <= 0) return base;
  return {
    score: base.score + bonus,
    hits: [...base.hits, `simpler:${hit.relevancy}`],
  };
}
```

Add `headersByHost` to `packages/server/src/fetcher/index.ts` — one new optional field on `FetchOptions`, and one merge where the request headers are built:

```ts
export interface FetchOptions {
  // ... existing fields ...
  /**
   * Extra request headers keyed by exact hostname. FetchRequest (CONTRACT §3) has no header
   * field, and the optional Simpler.Grants.gov key must travel as `X-Auth`. Never used to spoof
   * a User-Agent: the UA is set unconditionally and is not overridable from here.
   */
  headersByHost?: Record<string, Record<string, string>>;
}

// where the per-request headers are assembled:
const extra = (opts.headersByHost ?? {})[new URL(url).hostname.toLowerCase()] ?? {};
const headers: Record<string, string> = { ...extra, 'user-agent': opts.userAgent, accept: acceptHeader };
```

The spread order matters: `user-agent` is written **after** `extra`, so `headersByHost` cannot override it.

Create `packages/server/src/sources/grants-gov-federal.ts`:

```ts
import type { FetchRequest, FetchedPayload, RawOpportunity } from '@grantspotter/core';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import {
  SIMPLER_GRANTS_SEARCH_URL,
  type SimplerGrantsHit,
  blendSimplerRelevance,
  parseSimplerResponse,
  simplerSearchRequests,
} from '../federal/simplerGrants.js';
import {
  GRANTS_GOV_KEYWORDS,
  GRANTS_GOV_SEARCH_URL,
  type GrantsGovDetail,
  type GrantsGovHit,
  buildFetchOpportunityRequest,
  buildSearchRequest,
  parseOpportunityDetail,
  parseSearchResponse,
  toRawOpportunity,
} from '../federal/grantsGov.js';
import type { FollowUpSource } from './types.js';

const SOURCE_ID = 'grants-gov-federal';
/** Hard cap on nightly detail fetches so a broad keyword cannot become a 250-request crawl. */
const MAX_DETAIL_FETCHES = 25;

function hitsFrom(payloads: FetchedPayload[]): GrantsGovHit[] {
  const byId = new Map<string, GrantsGovHit>();
  for (const payload of payloads) {
    if (!payload.url.startsWith(GRANTS_GOV_SEARCH_URL) || payload.status !== 200) continue;
    for (const hit of parseSearchResponse(payload.body)) {
      if (hit.id !== '') byId.set(hit.id, hit);
    }
  }
  return [...byId.values()];
}

function detailsFrom(payloads: FetchedPayload[]): Map<string, GrantsGovDetail> {
  const out = new Map<string, GrantsGovDetail>();
  for (const payload of payloads) {
    if (!payload.url.includes('fetchOpportunity') || payload.status !== 200) continue;
    const detail = parseOpportunityDetail(payload.body);
    if (detail?.opportunityId) out.set(detail.opportunityId, detail);
  }
  return out;
}

/**
 * Optional (spec §7.5). Keyed by opportunity NUMBER, which is the only identifier the two APIs
 * share — Simpler does not echo the legacy numeric opportunity id. Empty map when no key is set
 * or no Simpler payload arrived, and every caller must behave identically in that case.
 */
function simplerHitsFrom(payloads: FetchedPayload[]): Map<string, SimplerGrantsHit> {
  const out = new Map<string, SimplerGrantsHit>();
  for (const payload of payloads) {
    if (!payload.url.startsWith(SIMPLER_GRANTS_SEARCH_URL) || payload.status !== 200) continue;
    for (const hit of parseSimplerResponse(payload.body)) {
      if (hit.opportunityNumber !== '') out.set(hit.opportunityNumber, hit);
    }
  }
  return out;
}

export const grantsGovFederal: FollowUpSource = {
  id: SOURCE_ID,
  funderId: 'federal',
  label: 'Grants.gov federal adjacency sweep',
  tier: 'A',
  klass: 'adjacent_stem',
  // A function, not a literal array: the optional Simpler.Grants.gov leg is decided at resolve
  // time. With no SIMPLER_GRANTS_API_KEY this is exactly the search2-only list it always was.
  requests: async (): Promise<FetchRequest[]> => [
    ...GRANTS_GOV_KEYWORDS.map((keyword) => buildSearchRequest(keyword, 50, 0)),
    ...simplerSearchRequests(GRANTS_GOV_KEYWORDS),
  ],
  expectedMinRecords: 1,
  notes:
    'Federal sweep via the key-free POST search2 endpoint. DO NOT ADD ANY GRANTS.GOV RSS FEED: ' +
    'all four advertised feeds return HTTP 200 with content-type text/html — a ~27 KB SPA ' +
    'shell, not XML — so a naive poller finds zero items forever and never errors. Relevance ' +
    'is scored, not keyword-matched: "amateur radio" returns 57 hits and "cubesat" returns 1, ' +
    'while the genuinely winnable money is adjacent (NSF geospace/ECCS/ATE/Noyce, NASA Space ' +
    'Grant and MUREP, NTIA PWSCIF). awardCeiling and awardFloor are frequently the literal ' +
    'string "none" and are never coerced to 0. Nothing here publishes: federal candidates ' +
    'enter the same human review queue as everything else.',

  followUp(payloads: FetchedPayload[]): FetchRequest[] {
    return hitsFrom(payloads)
      .filter((hit) => scoreAdjacency(`${hit.title}\n${hit.agency}`).score >= ADJACENCY_THRESHOLD)
      .slice(0, MAX_DETAIL_FETCHES)
      .map((hit) => buildFetchOpportunityRequest(hit.id));
  },

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const details = detailsFrom(payloads);
    const simpler = simplerHitsFrom(payloads);
    const out: RawOpportunity[] = [];
    for (const hit of hitsFrom(payloads)) {
      const detail = details.get(hit.id);
      // Re-score with the hydrated description, which is far richer than the title alone.
      const deterministic = scoreAdjacency(
        [hit.title, hit.agency, detail?.description ?? '', detail?.applicantTypes.join(' ') ?? ''].join('\n'),
      );
      // Optional lift only (spec §7.5): with no key `simpler` is empty and this is the identity.
      const scored = blendSimplerRelevance(deterministic, simpler.get(hit.number));
      if (deterministic.score < ADJACENCY_THRESHOLD) continue;
      const raw = toRawOpportunity(hit, detail);
      out.push({
        ...raw,
        rawFields: {
          ...raw.rawFields,
          adjacencyScore: String(scored.score),
          adjacencyHits: scored.hits.join(', '),
        },
      });
    }
    return out;
  },
};
```

Pass the header through in `packages/server/src/index.ts`, alongside the existing crawler wiring:

```ts
import { simplerAuthHeaders } from './federal/simplerGrants.js';

// inside the createFetcher({ ... }) call added by Task 25:
headersByHost: simplerAuthHeaders(),   // {} when SIMPLER_GRANTS_API_KEY is unset
```

Register `grantsGovFederal` in `registry.ts`. The registry now holds **24** modules; tighten the registry test with an explicit count assertion (Tasks 27 and 28 raise it to 27):

```ts
it('holds all 24 source modules registered so far', () => {
  expect(SOURCES).toHaveLength(24);
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/ && npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/sources/grants-gov-federal.ts \
  packages/server/src/sources/grants-gov-federal.test.ts \
  packages/server/src/federal/simplerGrants.ts packages/server/src/federal/simplerGrants.test.ts \
  packages/server/src/fetcher/index.ts packages/server/src/index.ts \
  fixtures/grants-gov-federal/simpler-search-response.json \
  packages/server/src/sources/registry.ts packages/server/src/sources/registry.test.ts
git commit -m "feat(sources): Grants.gov federal adjacency sweep with optional Simpler.Grants.gov ranking"
```

---

### Task 25: `crawl/` — the runner, source health, and the nightly jittered scheduler

**Files:**
- Create: `packages/server/src/crawl/context.ts`
- Create: `packages/server/src/crawl/runner.ts`
- Create: `packages/server/src/crawl/scheduler.ts`
- Create: `packages/server/src/crawl/index.ts`
- Test: `packages/server/src/crawl/runner.test.ts`
- Test: `packages/server/src/crawl/scheduler.test.ts`
- Modify: `packages/server/src/index.ts` — start the scheduler when `CRAWL_ENABLED !== 'false'`

**Interfaces:**
- Consumes: `createFetcher` (Task 4); registry + `resolveRequests` / `hasFollowUp` / `isSignalSource` (Task 6); `programIdFor` (Task 5); `normalizeRaw` + `NormalizeContext` + `DEADLINE_INHERITANCE` (Task 16); `diffPrograms` / `detectYieldDrop` / `shouldSuppressVanished` (Task 19); every repository from Task 20; `createProgramRepo(db).findBySourceKey` from Plan 1 Task 13; `buildReviewItems` (Task 21); the `sources.enabled` column from Plan 1 Task 12's `001-init.sql`, which Plan 3's `PATCH /api/sources/:id` writes and `runCrawl` reads (RESOLUTIONS R20).
- Produces:
  ```ts
  // context.ts  — the impure half of normalization, which is why it is HERE and not in normalize/
  export function contextForSource(m: SourceModule, nowISO: string, db?: Database.Database): NormalizeContext;
  // runner.ts
  export interface CrawlDeps { db: Database.Database; fetcher: Fetcher; nowISO: () => string }
  export interface SourceRunResult { sourceId: string; parsedCount: number; events: number; reviewItems: number; error?: string }
  export function runSource(deps: CrawlDeps, sourceId: string): Promise<SourceRunResult>;
  export function runCrawl(deps: CrawlDeps, sourceIds?: string[]): Promise<SourceRunResult[]>;
  // scheduler.ts
  export function cronMatches(expr: string, date: Date): boolean;
  export function nextCronTime(expr: string, from: Date): Date;
  export function jitterMs(rand: () => number, maxMs?: number): number;
  export interface SchedulerOptions { cron: string; enabled: boolean; rand?: () => number; now?: () => Date; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void }
  export function startScheduler(opts: SchedulerOptions, run: () => Promise<unknown>): { stop(): void; nextRunAt(): Date | undefined };
  ```

**`runCrawl` skips disabled sources before it does anything else** (RESOLUTIONS R20). Plan 3 ships `PATCH /api/sources/:id` writing `sources.enabled` and an admin toggle on the Sources page; this is the only place that flag means anything. One `SELECT id FROM sources WHERE enabled = 0` at the top of `runCrawl` removes those ids from the run list — **including when the caller named them explicitly**, because Plan 3's manual "crawl now" button calls this same function and must not resurrect a source somebody deliberately paused. A source with no `sources` row yet is not in the disabled set and runs normally; the default is enabled, matching Plan 1's `enabled INTEGER NOT NULL DEFAULT 1`. `recordPollStart` never writes `enabled`, so the pause outlives every subsequent crawl. Without this the toggle is decorative and the nightly run keeps hammering a 500ing site — which matters, because this crawl walks ~25 small-nonprofit sites and "please stop" is usually why the flag got flipped.

**Runner behaviour, in order, per source, strictly serially:**
1. `recordPollStart(db, module, now)` — registers the source row and stamps `sources.last_polled_at`. A disabled source never reaches this line, so it gets no `last_polled_at` update and no `snapshots` row.
2. Resolve `requests`; fetch each through the fetcher (which serializes per host and honours `Crawl-delay: 5` on arrl.org). Persist a `snapshots` row per payload.
3. If the module has a `followUp`, call it with the payloads and a `sinceISO` taken from `sources.last_success_at`, then fetch and persist those payloads too.
4. `parse(payloads)`.
5. Emit `detectYieldDrop(sourceId, parsedCount, expectedMinRecords, now)`.
6. **Signal-only source** (`arrl-news-rss`): emit one `new` `ChangeEvent` per *relevant* item that has not been seen before, and **no** `ReviewItem`. The Inbox reads these directly from `change_events`.
7. **Normal source:** build the `NormalizeContext` with `contextForSource(module, now, db)` — which is where `mintId` and the R9 `existingIdFor` lookup get injected — normalize each raw to a `Program`, load the previously-published programs for that source, `diffPrograms`, drop `vanished` events when `shouldSuppressVanished`, persist the events, and build review items.
8. `recordPollSuccess` — or, on any throw, `recordPollFailure` with the message. **One source failing never aborts the crawl.**

**Why `contextForSource` lives here and not in `normalize/`** (coverage finding #12). Spec §14 requires `normalize/` to be pure, and a `NormalizeContext` needs three impure things: the clock, `programIdFor` (which uses `node:crypto`), and a database handle for the R9 seeded-id lookup. So `normalize/` declares what it needs on the context and `crawl/context.ts` supplies it. `contextForSource(m, nowISO)` with no `db` is the offline form used by tests and by `verify-sources`; it mints ids and reconciles nothing.

**Scheduler.** `CRAWL_CRON` defaults to `17 3 * * *`; `nextCronTime` walks forward minute by minute (bounded at 366 days) against a pure `cronMatches`, which supports `*`, `N`, `a,b`, `a-b` and `*/n`. Once the cron minute arrives, the run is delayed by `jitterMs` — a uniform 0 to 45 minutes — so ~25 small nonprofit sites do not all get hit at 03:17:00 sharp by every deployment of this app. `CRAWL_ENABLED=false` starts nothing at all.

- [ ] **Step 1: Write the failing tests**

Create `packages/server/src/crawl/scheduler.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { cronMatches, jitterMs, nextCronTime, startScheduler } from './scheduler.js';

const at = (iso: string) => new Date(iso);

describe('cronMatches', () => {
  it('matches the default nightly 17 3 * * *', () => {
    expect(cronMatches('17 3 * * *', at('2026-08-02T03:17:00Z'))).toBe(true);
    expect(cronMatches('17 3 * * *', at('2026-08-02T03:18:00Z'))).toBe(false);
    expect(cronMatches('17 3 * * *', at('2026-08-02T04:17:00Z'))).toBe(false);
  });

  it('matches a wildcard minute', () => {
    expect(cronMatches('* 3 * * *', at('2026-08-02T03:59:00Z'))).toBe(true);
  });

  it('matches a list and a range', () => {
    expect(cronMatches('0 1,3,5 * * *', at('2026-08-02T03:00:00Z'))).toBe(true);
    expect(cronMatches('0 1,3,5 * * *', at('2026-08-02T02:00:00Z'))).toBe(false);
    expect(cronMatches('0 1-5 * * *', at('2026-08-02T04:00:00Z'))).toBe(true);
  });

  it('matches a step', () => {
    expect(cronMatches('*/15 * * * *', at('2026-08-02T03:30:00Z'))).toBe(true);
    expect(cronMatches('*/15 * * * *', at('2026-08-02T03:31:00Z'))).toBe(false);
  });

  it('matches day-of-week', () => {
    expect(cronMatches('0 0 * * 0', at('2026-08-02T00:00:00Z'))).toBe(true); // a Sunday
    expect(cronMatches('0 0 * * 1', at('2026-08-02T00:00:00Z'))).toBe(false);
  });

  it('rejects a malformed expression', () => {
    expect(() => cronMatches('17 3 * *', at('2026-08-02T03:17:00Z'))).toThrow(/five fields/i);
  });
});

describe('nextCronTime', () => {
  it('finds tonight’s run when it has not happened yet', () => {
    expect(nextCronTime('17 3 * * *', at('2026-08-02T01:00:00Z')).toISOString()).toBe(
      '2026-08-02T03:17:00.000Z',
    );
  });

  it('rolls to tomorrow when tonight’s run has passed', () => {
    expect(nextCronTime('17 3 * * *', at('2026-08-02T05:00:00Z')).toISOString()).toBe(
      '2026-08-03T03:17:00.000Z',
    );
  });

  it('never returns the current minute — it always advances', () => {
    const from = at('2026-08-02T03:17:00Z');
    expect(nextCronTime('17 3 * * *', from).getTime()).toBeGreaterThan(from.getTime());
  });
});

describe('jitterMs', () => {
  it('spreads uniformly across the window', () => {
    expect(jitterMs(() => 0)).toBe(0);
    expect(jitterMs(() => 1)).toBe(45 * 60 * 1000);
    expect(jitterMs(() => 0.5)).toBe(45 * 60 * 1000 * 0.5);
  });

  it('honours a custom window', () => {
    expect(jitterMs(() => 1, 60_000)).toBe(60_000);
  });
});

describe('startScheduler', () => {
  it('starts nothing when CRAWL_ENABLED is false', () => {
    const setTimer = vi.fn();
    const handle = startScheduler(
      { cron: '17 3 * * *', enabled: false, setTimer, now: () => at('2026-08-02T01:00:00Z') },
      async () => undefined,
    );
    expect(setTimer).not.toHaveBeenCalled();
    expect(handle.nextRunAt()).toBeUndefined();
  });

  it('schedules the next cron time plus jitter', () => {
    const setTimer = vi.fn();
    const handle = startScheduler(
      {
        cron: '17 3 * * *',
        enabled: true,
        rand: () => 0.5,
        now: () => at('2026-08-02T03:00:00Z'),
        setTimer,
      },
      async () => undefined,
    );
    expect(setTimer).toHaveBeenCalledTimes(1);
    const delay = setTimer.mock.calls[0][1] as number;
    // 17 minutes to the cron minute, plus half of the 45-minute jitter window.
    expect(delay).toBe(17 * 60 * 1000 + 45 * 60 * 1000 * 0.5);
    expect(handle.nextRunAt()?.toISOString()).toBe('2026-08-02T03:17:00.000Z');
  });

  it('runs the job when the timer fires and reschedules afterwards', async () => {
    let fire: (() => void) | undefined;
    const setTimer = vi.fn((fn: () => void) => {
      fire = fn;
      return 1;
    });
    const run = vi.fn(async () => undefined);
    let now = at('2026-08-02T03:00:00Z');
    startScheduler(
      { cron: '17 3 * * *', enabled: true, rand: () => 0, now: () => now, setTimer },
      run,
    );
    now = at('2026-08-02T03:17:00Z');
    fire?.();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(setTimer).toHaveBeenCalledTimes(2);
  });

  it('reschedules even when the job throws', async () => {
    let fire: (() => void) | undefined;
    const setTimer = vi.fn((fn: () => void) => {
      fire = fn;
      return 1;
    });
    startScheduler(
      { cron: '17 3 * * *', enabled: true, rand: () => 0, now: () => at('2026-08-02T03:00:00Z'), setTimer },
      async () => {
        throw new Error('crawl blew up');
      },
    );
    fire?.();
    await vi.waitFor(() => expect(setTimer).toHaveBeenCalledTimes(2));
  });

  it('stop() clears the pending timer', () => {
    const clearTimer = vi.fn();
    const handle = startScheduler(
      {
        cron: '17 3 * * *',
        enabled: true,
        now: () => at('2026-08-02T03:00:00Z'),
        setTimer: () => 42,
        clearTimer,
      },
      async () => undefined,
    );
    handle.stop();
    expect(clearTimer).toHaveBeenCalledWith(42);
  });
});
```

Create `packages/server/src/crawl/runner.test.ts`:

```ts
import Database from 'better-sqlite3';
import type { FetchRequest, FetchedPayload } from '@grantspotter/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { ensureIngestionSchema } from '../db/ingestSchema.js';
import { migrate } from '../db/migrate.js';
import {
  listChangeEvents,
  listProgramsBySource,
  listReviewItems,
  listSourceHealth,
  upsertProgram,
} from '../db/repositories/ingestion.js';
import { approveReviewItem } from '../review/index.js';
import { SOURCES } from '../sources/registry.js';
import { runCrawl, runSource } from './runner.js';

const NOW = '2026-08-02T00:00:00.000Z';
let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db); // Plan 1 owns every CONTRACT §6 table
  ensureIngestionSchema(db);
  // programs.funder_id references funders(id); seed every funder the registry names.
  const insertFunder = db.prepare(
    'INSERT OR IGNORE INTO funders (id, name, homepage) VALUES (?, ?, ?)',
  );
  for (const m of SOURCES) insertFunder.run(m.funderId, m.funderId, 'https://example.test/');
});

/** Serves committed fixtures instead of the network. */
function fixtureFetcher(map: Record<string, FetchedPayload>) {
  const fetched: string[] = [];
  return {
    fetched,
    fetcher: {
      async fetch(req: FetchRequest): Promise<FetchedPayload> {
        fetched.push(req.url);
        for (const [part, payload] of Object.entries(map)) {
          if (req.url.includes(part)) return { ...payload, url: req.url };
        }
        return { url: req.url, status: 404, contentType: 'text/html', body: '', fetchedAt: NOW };
      },
    },
  };
}

const deps = (fetcher: { fetch(req: FetchRequest): Promise<FetchedPayload> }) => ({
  db,
  fetcher,
  nowISO: () => NOW,
});

describe('runSource on a normal Tier C source', () => {
  const map = {
    '/scholarship-descriptions': fixturePayload(
      'arrl-scholarship-descriptions',
      'pathological.html',
      'http://www.arrl.org/scholarship-descriptions',
    ),
  };

  it('parses, diffs, records health, and queues review items on the first run', async () => {
    const { fetcher } = fixtureFetcher(map);
    const result = await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(result.parsedCount).toBe(6);
    expect(result.error).toBeUndefined();
    expect(listReviewItems(db, 'pending')).toHaveLength(6);
    expect(listChangeEvents(db, 50).every((e) => e.kind === 'new' || e.kind === 'parse_yield_dropped')).toBe(true);
  });

  it('publishes nothing until a human approves', async () => {
    const { fetcher } = fixtureFetcher(map);
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(listProgramsBySource(db, 'arrl-scholarship-descriptions')).toEqual([]);
    const first = listReviewItems(db, 'pending')[0];
    approveReviewItem(db, first.id, 'user-1', NOW);
    expect(listProgramsBySource(db, 'arrl-scholarship-descriptions')).toHaveLength(1);
  });

  it('emits nothing new on a second identical run after approval', async () => {
    const { fetcher } = fixtureFetcher(map);
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    for (const item of listReviewItems(db, 'pending')) approveReviewItem(db, item.id, 'user-1', NOW);
    const before = listChangeEvents(db, 100).length;
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(listChangeEvents(db, 100).length).toBe(before);
  });

  it('fires parse_yield_dropped when the page stops parsing', async () => {
    const { fetcher } = fixtureFetcher(map);
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    const alarms = listChangeEvents(db, 100).filter((e) => e.kind === 'parse_yield_dropped');
    // The pathological fixture yields 6 against expectedMinRecords 100, so the alarm must fire.
    expect(alarms).toHaveLength(1);
    expect(alarms[0].after).toEqual({ parsedCount: 6 });
  });

  it('records a snapshot row per fetched payload', async () => {
    const { fetcher } = fixtureFetcher(map);
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    const count = (db.prepare('SELECT COUNT(*) AS n FROM snapshots').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('records poll start, success and record count on the sources table', async () => {
    const { fetcher } = fixtureFetcher(map);
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    const [health] = listSourceHealth(db);
    expect(health.lastPolledAt).toBe(NOW);
    expect(health.lastSuccessAt).toBe(NOW);
    expect(health.lastRecordCount).toBe(6);
    expect(health.expectedMinRecords).toBe(100);
    expect(health.consecutiveFailures).toBe(0);
  });

  it('reconciles with a seeded record instead of duplicating it — RESOLUTIONS R9', async () => {
    const { fetcher } = fixtureFetcher(map);
    // First crawl + approve everything: the corpus now holds this source's records with their
    // (source_id, external_key) written.
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    for (const item of listReviewItems(db, 'pending')) approveReviewItem(db, item.id, 'user-1', NOW);
    const published = listProgramsBySource(db, 'arrl-scholarship-descriptions');
    expect(published).toHaveLength(6);

    // Re-seed one of them under a HAND-WRITTEN id, exactly as Plan 5's seed corpus does, and
    // drop the crawler-minted row. Tonight's crawl must find it by source key.
    const seeded = { ...published[0], id: 'arrl-foundation-scholarships' };
    const key = { sourceId: 'arrl-scholarship-descriptions', externalKey: published[0].tags.find((t) => t.startsWith('key:'))?.slice(4) ?? '' };
    db.prepare('DELETE FROM programs WHERE id = ?').run(published[0].id);
    upsertProgram(db, seeded, key);

    const idsBefore = new Set(listChangeEvents(db, 500).map((e) => e.id));
    await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    const fresh = listChangeEvents(db, 500).filter((e) => !idsBefore.has(e.id));
    expect(fresh.filter((e) => e.kind === 'new')).toEqual([]);
    expect(fresh.filter((e) => e.kind === 'vanished')).toEqual([]);
    expect(listProgramsBySource(db, 'arrl-scholarship-descriptions')).toHaveLength(6);
  });
});

describe('runSource failure handling', () => {
  it('records the failure and does not throw', async () => {
    const fetcher = {
      async fetch(): Promise<FetchedPayload> {
        throw new Error('ECONNREFUSED');
      },
    };
    const result = await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
    expect(result.error).toContain('ECONNREFUSED');
    const [health] = listSourceHealth(db);
    expect(health.consecutiveFailures).toBe(1);
    expect(health.lastError).toContain('ECONNREFUSED');
    expect(health.lastSuccessAt).toBeUndefined();
  });
});

describe('runSource on a legitimately empty source', () => {
  it('records success with a zero yield and emits no alarm and no vanished events', async () => {
    const { fetcher } = fixtureFetcher({
      'austinhams.org': fixturePayload('austin-arc', 'empty-window.html', 'https://austinhams.org/scholarships/'),
    });
    const result = await runSource(deps(fetcher), 'austin-arc');
    expect(result.parsedCount).toBe(0);
    expect(result.error).toBeUndefined();
    expect(listChangeEvents(db, 50).filter((e) => e.kind === 'parse_yield_dropped')).toEqual([]);
    expect(listChangeEvents(db, 50).filter((e) => e.kind === 'vanished')).toEqual([]);
    expect(listSourceHealth(db)[0].lastSuccessAt).toBe(NOW);
  });
});

describe('runSource on a signal-only source', () => {
  it('emits ChangeEvents for relevant items and NO review items', async () => {
    const { fetcher } = fixtureFetcher({
      '/news/rss': fixturePayload('arrl-news-rss', 'pathological.xml', 'http://www.arrl.org/news/rss'),
    });
    const result = await runSource(deps(fetcher), 'arrl-news-rss');
    expect(result.parsedCount).toBe(4);
    expect(listReviewItems(db)).toEqual([]);
    const news = listChangeEvents(db, 50).filter((e) => e.sourceId === 'arrl-news-rss');
    expect(news).toHaveLength(3); // the contest item is filtered out by isRelevant
  });

  it('does not re-signal the same item on a second run', async () => {
    const { fetcher } = fixtureFetcher({
      '/news/rss': fixturePayload('arrl-news-rss', 'pathological.xml', 'http://www.arrl.org/news/rss'),
    });
    await runSource(deps(fetcher), 'arrl-news-rss');
    const first = listChangeEvents(db, 50).length;
    await runSource(deps(fetcher), 'arrl-news-rss');
    expect(listChangeEvents(db, 50).length).toBe(first);
  });
});

describe('runSource on a follow-up source', () => {
  it('fetches the discovery request, then the follow-up request it produces', async () => {
    const { fetcher, fetched } = fixtureFetcher({
      'slug=grants': fixturePayload('ardc-grants', '00-discovery.json', 'https://www.ardc.net/wp-json/wp/v2/pages?slug=grants'),
      'parent=4821': fixturePayload('ardc-grants', '01-children.json', 'https://www.ardc.net/wp-json/wp/v2/pages?parent=4821'),
    });
    const result = await runSource(deps(fetcher), 'ardc-grants');
    expect(fetched.some((u) => u.includes('slug=grants'))).toBe(true);
    expect(fetched.some((u) => u.includes('parent=4821'))).toBe(true);
    expect(result.parsedCount).toBe(3);
  });
});

describe('runCrawl', () => {
  it('runs the named sources serially and returns one result each', async () => {
    const { fetcher } = fixtureFetcher({});
    const results = await runCrawl(deps(fetcher), ['manual-tier-d', 'austin-arc']);
    expect(results.map((r) => r.sourceId)).toEqual(['manual-tier-d', 'austin-arc']);
  });

  it('keeps going when one source fails', async () => {
    const fetcher = {
      calls: 0,
      async fetch(req: FetchRequest): Promise<FetchedPayload> {
        this.calls += 1;
        if (req.url.includes('austinhams')) throw new Error('boom');
        return { url: req.url, status: 200, contentType: 'text/html', body: '<p>x</p>', fetchedAt: NOW };
      },
    };
    const results = await runCrawl(deps(fetcher), ['austin-arc', 'manual-tier-d']);
    expect(results[0].error).toContain('boom');
    expect(results[1].error).toBeUndefined();
  });

  it('runs every registered source when no ids are given', async () => {
    const { fetcher } = fixtureFetcher({});
    const results = await runCrawl(deps(fetcher));
    // Registry-derived on purpose: Tasks 27 and 28 add three more Tier A modules and this
    // assertion must not need editing to stay honest.
    expect(results).toHaveLength(SOURCES.length);
  });

  it('handles manual-tier-d, which fetches nothing at all', async () => {
    const fetcher = {
      async fetch(): Promise<FetchedPayload> {
        throw new Error('should not fetch');
      },
    };
    const [result] = await runCrawl(deps(fetcher), ['manual-tier-d']);
    expect(result.error).toBeUndefined();
    expect(result.parsedCount).toBeGreaterThanOrEqual(15);
  });
});

describe('runCrawl honours sources.enabled — RESOLUTIONS R20', () => {
  /** Exactly what Plan 3's `PATCH /api/sources/:id` writes when an admin flips the toggle off. */
  function pause(sourceId: string): void {
    db.prepare(
      `INSERT INTO sources (id, label, tier, klass, expected_min_records, enabled)
       VALUES (?, ?, 'C', 'ham_scholarship', 0, 0)
       ON CONFLICT(id) DO UPDATE SET enabled = 0`,
    ).run(sourceId, sourceId);
  }

  const snapshotCount = (sourceId: string): number =>
    (
      db.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE source_id = ?').get(sourceId) as {
        n: number;
      }
    ).n;

  it('skips a paused source during a full crawl: no fetch, no last_polled_at, no snapshot', async () => {
    pause('austin-arc');
    const { fetcher, fetched } = fixtureFetcher({});
    const results = await runCrawl(deps(fetcher), ['manual-tier-d', 'austin-arc']);
    expect(results.map((r) => r.sourceId)).toEqual(['manual-tier-d']);
    expect(fetched.some((u) => u.includes('austinhams'))).toBe(false);
    expect(listSourceHealth(db).find((h) => h.sourceId === 'austin-arc')?.lastPolledAt).toBeUndefined();
    expect(snapshotCount('austin-arc')).toBe(0);
  });

  it('skips a paused source even when it is the only id asked for', async () => {
    pause('austin-arc');
    const { fetcher, fetched } = fixtureFetcher({});
    expect(await runCrawl(deps(fetcher), ['austin-arc'])).toEqual([]);
    expect(fetched).toEqual([]);
    expect(listSourceHealth(db).find((h) => h.sourceId === 'austin-arc')?.lastPolledAt).toBeUndefined();
    expect(snapshotCount('austin-arc')).toBe(0);
  });

  it('drops a paused source from the no-arguments nightly crawl', async () => {
    pause('austin-arc');
    const { fetcher } = fixtureFetcher({});
    const results = await runCrawl(deps(fetcher));
    expect(results).toHaveLength(SOURCES.length - 1);
    expect(results.map((r) => r.sourceId)).not.toContain('austin-arc');
  });

  it('runs a source that has no sources row yet — the default is enabled', async () => {
    const { fetcher } = fixtureFetcher({});
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number },
    ).toEqual({ n: 0 });
    const [result] = await runCrawl(deps(fetcher), ['manual-tier-d']);
    expect(result.sourceId).toBe('manual-tier-d');
    expect(result.error).toBeUndefined();
  });

  it('re-enabling restores the source, and recordPollStart never clears the pause', async () => {
    pause('austin-arc');
    const { fetcher } = fixtureFetcher({});
    await runCrawl(deps(fetcher), ['manual-tier-d', 'austin-arc']);
    // recordPollStart upserts `sources` for every source it DOES poll; the paused row must still
    // read enabled = 0 afterwards, or the pause would last exactly one night.
    expect(
      (db.prepare('SELECT enabled FROM sources WHERE id = ?').get('austin-arc') as {
        enabled: number;
      }).enabled,
    ).toBe(0);

    db.prepare('UPDATE sources SET enabled = 1 WHERE id = ?').run('austin-arc');
    const results = await runCrawl(deps(fetcher), ['austin-arc']);
    expect(results.map((r) => r.sourceId)).toEqual(['austin-arc']);
    expect(listSourceHealth(db).find((h) => h.sourceId === 'austin-arc')?.lastPolledAt).toBe(NOW);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/crawl/
```

Expected failure: `Failed to resolve import "./scheduler.js"` and `"./runner.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/crawl/scheduler.ts`:

```ts
const FIELD_MAX = [59, 23, 31, 12, 6];
const DEFAULT_JITTER_MS = 45 * 60 * 1000;

function fieldMatches(field: string, value: number, max: number): boolean {
  for (const part of field.split(',')) {
    if (part === '*') return true;
    const step = /^(\*|\d+-\d+)\/(\d+)$/.exec(part);
    if (step) {
      const n = Number.parseInt(step[2], 10);
      if (n <= 0) continue;
      if (step[1] === '*') {
        if (value % n === 0) return true;
        continue;
      }
      const [lo, hi] = step[1].split('-').map((s) => Number.parseInt(s, 10));
      if (value >= lo && value <= hi && (value - lo) % n === 0) return true;
      continue;
    }
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const lo = Number.parseInt(range[1], 10);
      const hi = Number.parseInt(range[2], 10);
      if (value >= lo && value <= Math.min(hi, max)) return true;
      continue;
    }
    if (/^\d+$/.test(part) && Number.parseInt(part, 10) === value) return true;
  }
  return false;
}

/** Supports `*`, `N`, `a,b`, `a-b` and `*/n` in all five fields. UTC. */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron expression must have five fields: "${expr}"`);
  const values = [
    date.getUTCMinutes(),
    date.getUTCHours(),
    date.getUTCDate(),
    date.getUTCMonth() + 1,
    date.getUTCDay(),
  ];
  return fields.every((field, i) => fieldMatches(field, values[i], FIELD_MAX[i]));
}

/** Walks forward minute by minute, bounded at 366 days. Always strictly after `from`. */
export function nextCronTime(expr: string, from: Date): Date {
  const cursor = new Date(from.getTime());
  cursor.setUTCSeconds(0, 0);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i += 1) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
    if (cronMatches(expr, cursor)) return cursor;
  }
  throw new Error(`cron expression "${expr}" never matches within 366 days`);
}

/**
 * Uniform 0..45 minutes. ~25 small nonprofit sites should not all be hit at 03:17:00 sharp by
 * every deployment of this app.
 */
export function jitterMs(rand: () => number, maxMs: number = DEFAULT_JITTER_MS): number {
  return Math.round(rand() * maxMs);
}

export interface SchedulerOptions {
  cron: string;
  enabled: boolean;
  rand?: () => number;
  now?: () => Date;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function startScheduler(
  opts: SchedulerOptions,
  run: () => Promise<unknown>,
): { stop(): void; nextRunAt(): Date | undefined } {
  const now = opts.now ?? (() => new Date());
  const rand = opts.rand ?? Math.random;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));

  let handle: unknown;
  let scheduled: Date | undefined;
  let stopped = !opts.enabled;

  function schedule(): void {
    if (stopped) return;
    scheduled = nextCronTime(opts.cron, now());
    const delay = Math.max(0, scheduled.getTime() - now().getTime()) + jitterMs(rand);
    handle = setTimer(() => {
      void run()
        .catch(() => undefined)
        .finally(() => schedule());
    }, delay);
  }

  if (opts.enabled) schedule();

  return {
    stop(): void {
      stopped = true;
      if (handle !== undefined) clearTimer(handle);
    },
    nextRunAt: () => (opts.enabled ? scheduled : undefined),
  };
}
```

Create `packages/server/src/crawl/context.ts`:

```ts
import type Database from 'better-sqlite3';
import type { SourceModule } from '@grantspotter/core';
import { createProgramRepo } from '../db/repositories/programs.js';
import type { NormalizeContext } from '../normalize/index.js';
import { DEADLINE_INHERITANCE } from '../normalize/deadline.js';
import { programIdFor } from '../sources/util/ids.js';

/**
 * Builds the NormalizeContext. This lives in crawl/ rather than normalize/ because it needs the
 * three things normalize/ must not import (spec §14): the registry, `programIdFor` (node:crypto)
 * and a database handle.
 *
 * `db` is optional. With it, RESOLUTIONS R9's reconciliation is active: an already-stored record
 * with this (sourceId, externalKey) keeps its id, so the nightly crawl updates Plan 5's seeded
 * corpus instead of minting parallel ids and duplicating every record every night. Without it —
 * parser tests, `verify-sources` — ids are simply minted.
 */
export function contextForSource(
  m: SourceModule,
  nowISO: string,
  db?: Database.Database,
): NormalizeContext {
  const ctx: NormalizeContext = {
    sourceId: m.id,
    funderId: m.funderId,
    klass: m.klass,
    tier: m.tier,
    nowISO,
    deadlineInheritsFrom: DEADLINE_INHERITANCE[m.id],
    verificationMethod: m.tier === 'A' ? 'api' : m.tier === 'D' ? 'manual_curation' : 'live_fetch',
    mintId: programIdFor,
  };
  if (db !== undefined) {
    const programs = createProgramRepo(db);
    ctx.existingIdFor = (sourceId, externalKey) =>
      programs.findBySourceKey(sourceId, externalKey)?.id;
  }
  return ctx;
}
```

Create `packages/server/src/crawl/runner.ts`:

```ts
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ChangeEvent, FetchedPayload, Program, RawOpportunity } from '@grantspotter/core';
import { insertChangeEvents, insertSnapshot, listProgramsBySource, listSourceHealth, recordPollFailure, recordPollStart, recordPollSuccess } from '../db/repositories/ingestion.js';
import { detectYieldDrop, diffPrograms, shouldSuppressVanished } from '../diff/index.js';
import type { Fetcher } from '../fetcher/index.js';
import { normalizeRaw } from '../normalize/index.js';
import { buildReviewItems } from '../review/index.js';
import { SOURCES, getSource } from '../sources/registry.js';
import { hasFollowUp, isSignalSource, resolveRequests } from '../sources/types.js';
import { contextForSource } from './context.js';

export interface CrawlDeps {
  db: Database.Database;
  fetcher: Fetcher;
  nowISO: () => string;
}

export interface SourceRunResult {
  sourceId: string;
  parsedCount: number;
  events: number;
  reviewItems: number;
  error?: string;
}

function signalEventId(sourceId: string, externalKey: string): string {
  return createHash('sha256').update(`signal|${sourceId}|${externalKey}`).digest('hex').slice(0, 24);
}

export async function runSource(deps: CrawlDeps, sourceId: string): Promise<SourceRunResult> {
  const module = getSource(sourceId);
  const now = deps.nowISO();
  recordPollStart(deps.db, module, now);

  try {
    const payloads: FetchedPayload[] = [];
    for (const request of await resolveRequests(module)) {
      const payload = await deps.fetcher.fetch(request);
      payloads.push(payload);
      insertSnapshot(deps.db, sourceId, payload);
    }

    if (hasFollowUp(module)) {
      const sinceISO = listSourceHealth(deps.db).find((h) => h.sourceId === sourceId)?.lastSuccessAt;
      for (const request of module.followUp(payloads, { sinceISO })) {
        const payload = await deps.fetcher.fetch(request);
        payloads.push(payload);
        insertSnapshot(deps.db, sourceId, payload);
      }
    }

    const raws: RawOpportunity[] = module.parse(payloads);
    const events: ChangeEvent[] = [];

    const yieldAlarm = detectYieldDrop(sourceId, raws.length, module.expectedMinRecords, now);
    if (yieldAlarm) events.push(yieldAlarm);

    let reviewItemCount = 0;

    if (isSignalSource(module)) {
      // Signal sources produce ChangeEvents for a human to read and never a candidate Program.
      // The event id is derived from the item's externalKey, and insertChangeEvents uses
      // INSERT OR IGNORE, so an item is signalled exactly once, ever.
      for (const raw of raws) {
        if (!module.isRelevant(raw)) continue;
        events.push({
          id: signalEventId(sourceId, raw.externalKey),
          sourceId,
          kind: 'new',
          fieldPath: 'news',
          after: { name: raw.name, sourceUrl: raw.sourceUrl, rawFields: raw.rawFields },
          detectedAt: now,
        });
      }
      insertChangeEvents(deps.db, events);
    } else {
      // `deps.db` is what turns on RESOLUTIONS R9's seeded-id reconciliation.
      const ctx = contextForSource(module, now, deps.db);
      const next: Program[] = raws.map((raw) => normalizeRaw(raw, ctx));
      const previous = listProgramsBySource(deps.db, sourceId);
      const diffed = diffPrograms(previous, next, sourceId, now);
      const suppressVanished = shouldSuppressVanished(next.length, module.expectedMinRecords);
      events.push(...diffed.filter((e) => !(suppressVanished && e.kind === 'vanished')));
      insertChangeEvents(deps.db, events);

      const byId = new Map<string, Program>();
      for (const program of [...previous, ...next]) byId.set(program.id, program);
      reviewItemCount = buildReviewItems(deps.db, events, byId, module.tier, sourceId).length;
    }

    recordPollSuccess(deps.db, sourceId, raws.length, now);
    return { sourceId, parsedCount: raws.length, events: events.length, reviewItems: reviewItemCount };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordPollFailure(deps.db, sourceId, message, now);
    return { sourceId, parsedCount: 0, events: 0, reviewItems: 0, error: message };
  }
}

/**
 * Sources run strictly serially. One source failing never aborts the crawl.
 *
 * RESOLUTIONS R20 — `sources.enabled = 0` really pauses a source. Plan 3 ships
 * `PATCH /api/sources/:id` writing that column and an admin toggle on the Sources page; without
 * this filter the toggle is decorative and the nightly crawl keeps hammering a site the operator
 * deliberately backed off from. That is a politeness failure, not just a UI bug: this crawl walks
 * ~25 small-nonprofit sites, and the reason an admin pauses one is almost always that it is
 * 500ing, rate-limiting, or asked us to stop.
 *
 * The filter applies to an explicit `sourceIds` request too. "Run just this one" from the admin
 * console must not resurrect a source someone paused — Plan 3's manual crawl trigger calls exactly
 * this function, so the pause has to hold on both paths.
 *
 * A source that has never been polled has no `sources` row at all, so it is not in the disabled
 * set and runs normally. The default is enabled, and Plan 1's column default (`1`) agrees.
 */
export async function runCrawl(deps: CrawlDeps, sourceIds?: string[]): Promise<SourceRunResult[]> {
  const disabled = new Set(
    (
      deps.db.prepare('SELECT id FROM sources WHERE enabled = 0').all() as Array<{ id: string }>
    ).map((r) => r.id),
  );
  const ids = (sourceIds ?? SOURCES.map((m) => m.id)).filter((id) => !disabled.has(id));
  const results: SourceRunResult[] = [];
  for (const id of ids) results.push(await runSource(deps, id));
  return results;
}
```

Create `packages/server/src/crawl/index.ts`:

```ts
export { contextForSource } from './context.js';
export { runCrawl, runSource, type CrawlDeps, type SourceRunResult } from './runner.js';
export {
  cronMatches,
  jitterMs,
  nextCronTime,
  startScheduler,
  type SchedulerOptions,
} from './scheduler.js';
```

Wire the scheduler into `packages/server/src/index.ts`. Add these imports and this block after the Express app is created and the database is open (leave the existing bootstrap intact):

```ts
import { buildUserAgent } from './config.js';
import { createFetcher } from './fetcher/index.js';
import { ensureIngestionSchema } from './db/ingestSchema.js';
import { runCrawl, startScheduler } from './crawl/index.js';

const CONTACT_URL = process.env.CONTACT_URL;
if (!CONTACT_URL) {
  throw new Error('CONTACT_URL is required: it goes in the crawler User-Agent.');
}

// AFTER migrate(db) — ensureIngestionSchema asserts Plan 1's shape and would throw
// MissingSchemaError against an unmigrated database.
ensureIngestionSchema(db);

const crawlScheduler = startScheduler(
  {
    cron: process.env.CRAWL_CRON ?? '17 3 * * *',
    enabled: process.env.CRAWL_ENABLED !== 'false',
  },
  () =>
    runCrawl({
      db,
      fetcher: createFetcher({
        userAgent: buildUserAgent(CONTACT_URL),
        contactUrl: CONTACT_URL,
        dataDir: process.env.DATA_DIR ?? '/data',
      }),
      nowISO: () => new Date().toISOString(),
    }),
);

process.on('SIGTERM', () => crawlScheduler.stop());
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/ && npm run typecheck && npm run build
```

- [ ] **Step 5: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/crawl packages/server/src/index.ts packages/server/src/normalize/index.ts
git commit -m "feat(crawl): serial nightly runner with source health and a jittered cron scheduler"
```

---

### Task 26: `scripts/verify-sources.ts` — LIVE, warn-only, never a CI gate

**Files:**
- Create: `scripts/verify-sources.ts`
- Test: `packages/server/src/crawl/verifySources.test.ts`
- Create: `packages/server/src/crawl/verify.ts`
- Modify: `package.json` (root) — confirm `"verify-sources": "tsx scripts/verify-sources.ts"` exists per CONTRACT §8

**Interfaces:**
- Consumes: registry + `resolveRequests` / `hasFollowUp` (Task 6); `createFetcher` (Task 4).
- Produces:
  ```ts
  // crawl/verify.ts
  export interface VerifyRow { sourceId: string; tier: SourceTier; url: string; status: number | 'error'; parsedCount: number; expectedMinRecords: number; ok: boolean; note: string }
  export function verifyRowFor(sourceId: string, status: number | 'error', parsedCount: number, expectedMinRecords: number, url: string, tier: SourceTier): VerifyRow;
  export function formatVerifyReport(rows: VerifyRow[]): string;
  export function verifyExitCode(): 0;
  export async function verifySources(fetcher: Fetcher, sourceIds?: string[]): Promise<VerifyRow[]>;
  ```

**The rule, restated because it is easy to get wrong:** `npm run verify-sources` hits the real internet and reports what it finds. It **always exits 0**, even when every source is down, and it is **never** wired into CI, a pre-commit hook, or `npm test`. The network is not a build dependency. Its job is to tell a maintainer "arrl.org changed and the catalog parser now yields 4 records", not to fail a pipeline in a coffee shop.

The formatting and the exit code are unit-testable offline; only the actual fetching is live.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/crawl/verifySources.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchRequest, FetchedPayload } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { formatVerifyReport, verifyExitCode, verifyRowFor, verifySources } from './verify.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('verifyRowFor', () => {
  it('marks a source ok when the yield meets its floor', () => {
    const row = verifyRowFor('qcwa', 200, 1, 1, 'https://www.qcwa.org/scholarship-program.htm', 'C');
    expect(row.ok).toBe(true);
    expect(row.note).toBe('');
  });

  it('marks a source not-ok and explains when the yield drops', () => {
    const row = verifyRowFor('arrl-scholarship-descriptions', 200, 4, 100, 'http://www.arrl.org/x', 'C');
    expect(row.ok).toBe(false);
    expect(row.note).toMatch(/expected at least 100/);
  });

  it('treats a legitimately empty source as ok', () => {
    expect(verifyRowFor('austin-arc', 200, 0, 0, 'https://austinhams.org/scholarships/', 'C').ok).toBe(true);
  });

  it('marks a transport error not-ok without throwing', () => {
    const row = verifyRowFor('ncdxf-grants', 'error', 0, 1, 'https://www.ncdxf.org/x', 'C');
    expect(row.ok).toBe(false);
    expect(row.note).toMatch(/fetch failed/i);
  });

  it('flags a non-2xx status', () => {
    const row = verifyRowFor('s', 403, 0, 1, 'https://example.test/x', 'C');
    expect(row.ok).toBe(false);
    expect(row.note).toMatch(/403/);
  });
});

describe('formatVerifyReport', () => {
  const rows = [
    verifyRowFor('qcwa', 200, 1, 1, 'https://www.qcwa.org/scholarship-program.htm', 'C'),
    verifyRowFor('arrl-scholarship-descriptions', 200, 4, 100, 'http://www.arrl.org/x', 'C'),
  ];

  it('prints one line per source with the yield against the floor', () => {
    const out = formatVerifyReport(rows);
    expect(out).toContain('qcwa');
    expect(out).toContain('1/1');
    expect(out).toContain('4/100');
  });

  it('says WARN, never FAIL — this is not a gate', () => {
    const out = formatVerifyReport(rows);
    expect(out).toContain('WARN');
    expect(out).not.toMatch(/\bFAIL\b/);
  });

  it('summarises the warning count', () => {
    expect(formatVerifyReport(rows)).toMatch(/1 warning/);
  });

  it('handles an empty run', () => {
    expect(formatVerifyReport([])).toContain('0 sources');
  });
});

describe('verifyExitCode', () => {
  it('is always 0, even when everything is down — the network is not a build dependency', () => {
    expect(verifyExitCode()).toBe(0);
  });
});

describe('verifySources', () => {
  it('reports a row per source and never throws when a fetch fails', async () => {
    const fetcher = {
      async fetch(req: FetchRequest): Promise<FetchedPayload> {
        if (req.url.includes('austinhams')) throw new Error('ECONNRESET');
        return { url: req.url, status: 200, contentType: 'text/html', body: '<p>x</p>', fetchedAt: '2026-08-02T00:00:00.000Z' };
      },
    };
    const rows = await verifySources(fetcher, ['austin-arc', 'manual-tier-d']);
    expect(rows).toHaveLength(2);
    expect(rows[0].status).toBe('error');
    expect(rows[1].ok).toBe(true);
  });
});

describe('the script is never a CI gate', () => {
  it('always exits 0 in the CLI wrapper', async () => {
    const src = await readFile(path.join(REPO_ROOT, 'scripts/verify-sources.ts'), 'utf8');
    expect(src).toMatch(/process\.exitCode\s*=\s*verifyExitCode\(\)/);
    expect(src).not.toMatch(/process\.exit\(1\)|exitCode\s*=\s*1/);
  });

  it('is not referenced by any GitHub Actions workflow', async () => {
    const dir = path.join(REPO_ROOT, '.github/workflows');
    const fs = await import('node:fs/promises');
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      const yaml = await fs.readFile(path.join(dir, file), 'utf8');
      expect(yaml, `${file} must not run verify-sources`).not.toContain('verify-sources');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/crawl/verifySources.test.ts
```

Expected failure: `Failed to resolve import "./verify.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/server/src/crawl/verify.ts`:

```ts
import type { FetchedPayload, SourceTier } from '@grantspotter/core';
import type { Fetcher } from '../fetcher/index.js';
import { SOURCES, getSource } from '../sources/registry.js';
import { hasFollowUp, resolveRequests } from '../sources/types.js';

export interface VerifyRow {
  sourceId: string;
  tier: SourceTier;
  url: string;
  status: number | 'error';
  parsedCount: number;
  expectedMinRecords: number;
  ok: boolean;
  note: string;
}

export function verifyRowFor(
  sourceId: string,
  status: number | 'error',
  parsedCount: number,
  expectedMinRecords: number,
  url: string,
  tier: SourceTier,
): VerifyRow {
  if (status === 'error') {
    return { sourceId, tier, url, status, parsedCount, expectedMinRecords, ok: false, note: 'fetch failed' };
  }
  if (status < 200 || status >= 300) {
    return { sourceId, tier, url, status, parsedCount, expectedMinRecords, ok: false, note: `HTTP ${status}` };
  }
  if (expectedMinRecords > 0 && parsedCount < expectedMinRecords) {
    return {
      sourceId,
      tier,
      url,
      status,
      parsedCount,
      expectedMinRecords,
      ok: false,
      note: `parsed ${parsedCount}, expected at least ${expectedMinRecords}`,
    };
  }
  return { sourceId, tier, url, status, parsedCount, expectedMinRecords, ok: true, note: '' };
}

export function formatVerifyReport(rows: VerifyRow[]): string {
  const lines = rows.map((r) => {
    const flag = r.ok ? ' ok  ' : 'WARN ';
    const yieldText = `${r.parsedCount}/${r.expectedMinRecords}`;
    return `${flag} ${r.sourceId.padEnd(40)} ${String(r.status).padStart(5)} ${yieldText.padStart(9)}  ${r.note}`.trimEnd();
  });
  const warnings = rows.filter((r) => !r.ok).length;
  lines.push('');
  lines.push(
    `${rows.length} sources checked, ${warnings} warning${warnings === 1 ? '' : 's'}. ` +
      'This check is warn-only and never gates a build.',
  );
  return lines.join('\n');
}

/** ALWAYS 0. The network is not a build dependency. */
export function verifyExitCode(): 0 {
  return 0;
}

export async function verifySources(fetcher: Fetcher, sourceIds?: string[]): Promise<VerifyRow[]> {
  const ids = sourceIds ?? SOURCES.map((m) => m.id);
  const rows: VerifyRow[] = [];

  for (const id of ids) {
    const module = getSource(id);
    const payloads: FetchedPayload[] = [];
    let status: number | 'error' = 200;
    let url = '';

    try {
      for (const request of await resolveRequests(module)) {
        url = url || request.url;
        const payload = await fetcher.fetch(request);
        payloads.push(payload);
        if (payload.status < 200 || payload.status >= 300) status = payload.status;
      }
      if (hasFollowUp(module)) {
        for (const request of module.followUp(payloads)) {
          const payload = await fetcher.fetch(request);
          payloads.push(payload);
          if (payload.status < 200 || payload.status >= 300) status = payload.status;
        }
      }
    } catch {
      status = 'error';
    }

    let parsedCount = 0;
    try {
      parsedCount = module.parse(payloads).length;
    } catch {
      status = 'error';
    }

    rows.push(verifyRowFor(id, status, parsedCount, module.expectedMinRecords, url, module.tier));
  }

  return rows;
}
```

Create `scripts/verify-sources.ts`:

```ts
/**
 * npm run verify-sources
 *
 * LIVE check against the real sites, mirroring the arrl-calendar live-crosscheck pattern.
 * WARN-ONLY, and NEVER a CI gate: it always exits 0, even when every source is down. The
 * network is not a build dependency, and a maintainer on a coffee-shop connection should not
 * see a red build.
 *
 * Its job is to say "arrl.org changed and the catalog parser now yields 4 records instead of
 * 111" so a human refreshes the fixture and fixes the parser deliberately.
 */
import { buildUserAgent } from '../packages/server/src/config.js';
import { createFetcher } from '../packages/server/src/fetcher/index.js';
import { simplerAuthHeaders } from '../packages/server/src/federal/simplerGrants.js';
import {
  formatVerifyReport,
  verifyExitCode,
  verifySources,
} from '../packages/server/src/crawl/verify.js';

async function main(): Promise<void> {
  const contactUrl = process.env.CONTACT_URL;
  if (!contactUrl) {
    console.error('CONTACT_URL must be set — it goes in the crawler User-Agent.');
    process.exitCode = verifyExitCode();
    return;
  }
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const fetcher = createFetcher({
    userAgent: buildUserAgent(contactUrl),
    contactUrl,
    headersByHost: simplerAuthHeaders(), // {} when SIMPLER_GRANTS_API_KEY is unset
  });

  console.log('GrantSpotter live source check (warn-only, never a CI gate)\n');
  const rows = await verifySources(fetcher, only.length > 0 ? only : undefined);
  console.log(formatVerifyReport(rows));
  process.exitCode = verifyExitCode();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = verifyExitCode();
});
```

Add both Plan 2 scripts to the root `package.json` `scripts` block, exactly per CONTRACT §8 (RESOLUTIONS R13 — Plan 1 deliberately created neither, because at that point they would have pointed at files that did not exist; this is a recorded CONTRACT §8 deviation, the same one Plan 1 recorded for `typecheck`). `capture-fixture` was added in Task 6; confirm both are present and that neither is referenced by `build`, `test` or CI:

```json
"verify-sources": "tsx scripts/verify-sources.ts",
"capture-fixture": "tsx scripts/capture-fixture.ts"
```

Also pass the optional Simpler.Grants.gov credential through, so a maintainer who has set the key does not get a spurious 401 warning:

```ts
// scripts/verify-sources.ts
import { simplerAuthHeaders } from '../packages/server/src/federal/simplerGrants.js';

const fetcher = createFetcher({
  userAgent: buildUserAgent(contactUrl),
  contactUrl,
  headersByHost: simplerAuthHeaders(),
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/crawl/ && npm run typecheck
```

- [ ] **Step 5: Interim verification** (the full end-of-plan verification is Task 29 Step 6)

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter
npm run typecheck && npm run build && npm test
```

All three must be green. Then, optionally and only if this machine has network access, run the live check — it is expected to take a few minutes because arrl.org publishes `Crawl-delay: 5`:

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter
CONTACT_URL=https://grantspotter.example.test/about npm run verify-sources
```

Read the output. Warnings are information, not failures. If `arrl-scholarship-descriptions` reports anything under 100, refresh its fixture with `npm run capture-fixture -- arrl-scholarship-descriptions`, inspect the diff, and fix the parser deliberately.

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add scripts/verify-sources.ts packages/server/src/crawl/verify.ts \
  packages/server/src/crawl/verifySources.test.ts package.json
git commit -m "feat(crawl): live warn-only verify-sources check that never gates a build"
```

---

### Task 27: `nsf-awards` and `usaspending` — the two Tier A corroboration APIs

**Files:**
- Modify: `packages/server/src/federal/nsf.ts` — append the Awards API (it currently holds the three Tier B funding RSS feeds only)
- Create: `packages/server/src/federal/usaSpending.ts`
- Create: `packages/server/src/sources/nsf-awards.ts`
- Create: `packages/server/src/sources/usaspending.ts`
- Create: `fixtures/nsf-awards/awards-response.json`
- Create: `fixtures/usaspending/spending-by-award.json`
- Test: `packages/server/src/sources/nsf-awards.test.ts`
- Test: `packages/server/src/sources/usaspending.test.ts`
- Modify: `packages/server/src/sources/registry.ts`

**Interfaces:**
- Consumes: `scoreAdjacency`, `ADJACENCY_THRESHOLD` (Task 23); `FetchRequest`, `FetchedPayload`, `RawOpportunity`, `SourceModule` from core.
- Produces:
  ```ts
  // federal/nsf.ts   (appended)
  export const NSF_AWARDS_URL = 'https://api.nsf.gov/services/v1/awards.json';
  export const NSF_AWARDS_PRINT_FIELDS: readonly string[];
  export const NSF_AWARDS_MAX_RPP = 25;
  export interface NsfAwardItem { id: string; title: string; abstractText: string; awardeeName: string; startDate: string; expDate: string; fundProgramName: string; agency: string }
  export function buildNsfAwardsRequest(keyword: string, offset: number): FetchRequest;
  export function parseNsfAwards(json: string): NsfAwardItem[];
  // federal/usaSpending.ts
  export const USASPENDING_SEARCH_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
  export const USASPENDING_GRANT_TYPE_CODES: readonly string[];   // ['02','03','04','05']
  export interface UsaSpendingAward { awardId: string; recipientName: string; description: string; awardingAgency: string; amount?: number; startDate: string; endDate: string }
  export function buildUsaSpendingRequest(keyword: string, page: number): FetchRequest;
  export function parseUsaSpending(json: string): UsaSpendingAward[];
  // sources
  export const nsfAwards: SourceModule;
  export const usaSpending: SourceModule;
  ```

**What these two are for, and what they are NOT.** Spec §7.5 lists both as Tier A. Neither publishes *open* opportunities — they publish **awarded history**. Their value is corroboration: "NSF has funded ionospheric-instrumentation work at community colleges eleven times since 2019" is what tells a reviewer that an adjacent NSF programme is genuinely winnable, and what lets a user see the realistic award size. Every record they produce therefore carries `recordType: 'past_award'`, which `inferStatus` (Task 16) maps to `status: 'closed'` and `buildTags` tags `past_award` — so **an award record can never render as a live deadline.** That is the same treatment `ardc-award-tables` already gets.

**Three API facts that are not in the documentation and will cost you a day each:**

1. **`printFields` works on `api.nsf.gov/services/v1/awards.json` even though the docs imply it does not.** Without it the response carries only `id`, `title`, `agency` and a couple more, and `abstractText` — the only field with enough text to score adjacency against — is missing entirely. Ask for it explicitly.
2. **`rpp` is hard-capped at 25.** Asking for 100 does not error; it silently returns 25, so a paginator that advances by its *requested* page size skips three quarters of the results and never notices. Page with `offset` in steps of exactly 25. `offset` is **1-based**, not 0-based.
3. **USAspending's `award_type_codes` must be `["02","03","04","05"]`** — block grants, formula grants, project grants and cooperative agreements. Omitting the filter returns *contracts* (codes `A`–`D`, plus IDVs), which are procurement, not grants, and would flood the inbox with defence-electronics purchase orders that no ham club can apply for.

Neither API is rate-limit-documented. Both go through the same fetcher, which serializes per host and backs off on 429 — absence of documentation is not absence of limits.

- [ ] **Step 1: Write the fixtures**

Create `fixtures/nsf-awards/awards-response.json` — a real-shaped response with one clearly adjacent award and one clearly irrelevant one:

```json
{
  "response": {
    "award": [
      {
        "id": "2334891",
        "title": "Collaborative Research: Ionospheric Sounding Instrumentation for Undergraduate Research",
        "abstractText": "This project supports the development of low-cost ionosonde receivers operated by undergraduate students, including amateur radio licensees, at four regional universities. Students build HF antennas, characterize propagation, and publish open datasets.",
        "awardeeName": "University of Example",
        "startDate": "09/01/2024",
        "expDate": "08/31/2027",
        "fundProgramName": "Aeronomy",
        "agency": "NSF"
      },
      {
        "id": "2210044",
        "title": "Mechanisms of Protein Folding in Thermophilic Archaea",
        "abstractText": "This project investigates chaperone-assisted folding pathways in extremophile organisms.",
        "awardeeName": "Example Medical College",
        "startDate": "07/01/2022",
        "expDate": "06/30/2026",
        "fundProgramName": "Molecular Biophysics",
        "agency": "NSF"
      }
    ]
  }
}
```

Create `fixtures/usaspending/spending-by-award.json`:

```json
{
  "limit": 25,
  "page_metadata": { "page": 1, "hasNext": false },
  "results": [
    {
      "Award ID": "2334891",
      "Recipient Name": "UNIVERSITY OF EXAMPLE",
      "Description": "IONOSPHERIC SOUNDING INSTRUMENTATION FOR UNDERGRADUATE RESEARCH; HF PROPAGATION; AMATEUR RADIO STUDENT OPERATORS",
      "Awarding Agency": "National Science Foundation",
      "Award Amount": 412500,
      "Start Date": "2024-09-01",
      "End Date": "2027-08-31"
    },
    {
      "Award ID": "SP070023D0001",
      "Recipient Name": "EXAMPLE DEFENSE SYSTEMS INC",
      "Description": "RADIO SETS AND ACCESSORIES, BULK PROCUREMENT",
      "Awarding Agency": "Department of Defense",
      "Award Amount": 98000000,
      "Start Date": "2023-01-01",
      "End Date": "2028-01-01"
    }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/server/src/sources/nsf-awards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { NSF_AWARDS_MAX_RPP, NSF_AWARDS_URL, buildNsfAwardsRequest, parseNsfAwards } from '../federal/nsf.js';
import { resolveRequests } from './types.js';
import { nsfAwards } from './nsf-awards.js';

const payload = () => fixturePayload('nsf-awards', 'awards-response.json', `${NSF_AWARDS_URL}?keyword=ionosphere`);

describe('buildNsfAwardsRequest', () => {
  it('asks for printFields explicitly — it works despite the docs', () => {
    const url = new URL(buildNsfAwardsRequest('ionosphere', 1).url);
    const fields = (url.searchParams.get('printFields') ?? '').split(',');
    expect(fields).toContain('abstractText');
    expect(fields).toContain('awardeeName');
    expect(fields).toContain('fundProgramName');
  });

  it('never requests more than 25 rows — rpp is hard-capped and silently truncates', () => {
    const url = new URL(buildNsfAwardsRequest('ionosphere', 1).url);
    expect(Number(url.searchParams.get('rpp'))).toBe(NSF_AWARDS_MAX_RPP);
    expect(NSF_AWARDS_MAX_RPP).toBe(25);
  });

  it('pages with a 1-based offset in steps of exactly 25', () => {
    expect(new URL(buildNsfAwardsRequest('x', 1).url).searchParams.get('offset')).toBe('1');
    expect(new URL(buildNsfAwardsRequest('x', 2).url).searchParams.get('offset')).toBe('26');
    expect(new URL(buildNsfAwardsRequest('x', 3).url).searchParams.get('offset')).toBe('51');
  });

  it('is a GET for JSON', () => {
    const req = buildNsfAwardsRequest('ionosphere', 1);
    expect(req.method).toBe('GET');
    expect(req.accept).toBe('json');
  });
});

describe('parseNsfAwards', () => {
  it('reads every printField back', () => {
    const items = parseNsfAwards(payload().body);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: '2334891', awardeeName: 'University of Example', fundProgramName: 'Aeronomy' });
    expect(items[0].abstractText).toMatch(/ionosonde/);
  });

  it('returns [] for junk rather than throwing', () => {
    expect(parseNsfAwards('not json')).toEqual([]);
    expect(parseNsfAwards('{"response":{}}')).toEqual([]);
  });
});

describe('nsfAwards module', () => {
  it('is Tier A adjacent_stem and issues one request per keyword', async () => {
    expect(nsfAwards.tier).toBe('A');
    expect(nsfAwards.klass).toBe('adjacent_stem');
    const requests = await resolveRequests(nsfAwards);
    expect(requests.length).toBeGreaterThanOrEqual(3);
    for (const r of requests) expect(r.url.startsWith(NSF_AWARDS_URL)).toBe(true);
  });

  it('keeps only the adjacent award and marks it a past award, never a live deadline', () => {
    const raws = nsfAwards.parse([payload()]);
    expect(raws.map((r) => r.externalKey)).toEqual(['2334891']);
    expect(raws[0].rawFields.recordType).toBe('past_award');
    expect(Number(raws[0].rawFields.adjacencyScore)).toBeGreaterThanOrEqual(6);
  });

  it('drops the protein-folding award', () => {
    expect(nsfAwards.parse([payload()]).map((r) => r.externalKey)).not.toContain('2210044');
  });

  it('deduplicates an award that matched more than one keyword', () => {
    expect(nsfAwards.parse([payload(), payload()])).toHaveLength(1);
  });

  it('returns [] with no payloads', () => {
    expect(nsfAwards.parse([])).toEqual([]);
  });
});
```

Create `packages/server/src/sources/usaspending.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import {
  USASPENDING_GRANT_TYPE_CODES,
  USASPENDING_SEARCH_URL,
  buildUsaSpendingRequest,
  parseUsaSpending,
} from '../federal/usaSpending.js';
import { resolveRequests } from './types.js';
import { usaSpending } from './usaspending.js';

const payload = () => fixturePayload('usaspending', 'spending-by-award.json', USASPENDING_SEARCH_URL);

describe('buildUsaSpendingRequest', () => {
  it('filters to grants and cooperative agreements, EXCLUDING contracts', () => {
    const body = buildUsaSpendingRequest('amateur radio', 1).body as {
      filters: { award_type_codes: string[] };
    };
    expect(body.filters.award_type_codes).toEqual(['02', '03', '04', '05']);
    expect(USASPENDING_GRANT_TYPE_CODES).toEqual(['02', '03', '04', '05']);
    // A, B, C, D are procurement contracts. A ham club cannot apply for a contract.
    for (const contractCode of ['A', 'B', 'C', 'D']) {
      expect(body.filters.award_type_codes).not.toContain(contractCode);
    }
  });

  it('is a POST for JSON and pages explicitly', () => {
    const req = buildUsaSpendingRequest('amateur radio', 3);
    expect(req.url).toBe(USASPENDING_SEARCH_URL);
    expect(req.method).toBe('POST');
    expect(req.accept).toBe('json');
    expect((req.body as { page: number }).page).toBe(3);
  });
});

describe('parseUsaSpending', () => {
  it('reads the award rows', () => {
    const rows = parseUsaSpending(payload().body);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ awardId: '2334891', amount: 412500 });
  });

  it('returns [] for junk rather than throwing', () => {
    expect(parseUsaSpending('not json')).toEqual([]);
    expect(parseUsaSpending('{"results":"nope"}')).toEqual([]);
  });
});

describe('usaSpending module', () => {
  it('is Tier A adjacent_stem', async () => {
    expect(usaSpending.tier).toBe('A');
    expect(usaSpending.klass).toBe('adjacent_stem');
    expect((await resolveRequests(usaSpending)).length).toBeGreaterThanOrEqual(3);
  });

  it('keeps the adjacent grant and drops the defence procurement line', () => {
    const raws = usaSpending.parse([payload()]);
    expect(raws.map((r) => r.externalKey)).toEqual(['2334891']);
  });

  it('marks every record a past award so it never renders as a live deadline', () => {
    for (const raw of usaSpending.parse([payload()])) {
      expect(raw.rawFields.recordType).toBe('past_award');
    }
  });

  it('carries the award amount verbatim for the reviewer', () => {
    expect(usaSpending.parse([payload()])[0].rawFields.amountRaw).toBe('$412,500');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/nsf-awards.test.ts \
  packages/server/src/sources/usaspending.test.ts
```

Expected failure: `Failed to resolve import "./nsf-awards.js"` and `"../federal/usaSpending.js"`.

- [ ] **Step 4: Write minimal implementation**

Append to `packages/server/src/federal/nsf.ts` (and add `import type { FetchRequest } from '@grantspotter/core';` at the top — the file previously needed no core import):

```ts
/**
 * NSF Awards API — AWARDED HISTORY, not open opportunities. Tier A (spec §7.5).
 *
 * Two undocumented facts:
 *  - `printFields` DOES work here despite what the documentation implies. Without it the
 *    response omits abstractText, which is the only field with enough prose to score adjacency.
 *  - `rpp` is HARD-CAPPED AT 25. Asking for 100 does not error; it silently returns 25, so a
 *    paginator that advances by its requested page size skips three quarters of the results and
 *    never notices. `offset` is 1-based.
 */
export const NSF_AWARDS_URL = 'https://api.nsf.gov/services/v1/awards.json';
export const NSF_AWARDS_MAX_RPP = 25;

export const NSF_AWARDS_PRINT_FIELDS: readonly string[] = Object.freeze([
  'id',
  'title',
  'abstractText',
  'awardeeName',
  'startDate',
  'expDate',
  'fundProgramName',
  'agency',
]);

export interface NsfAwardItem {
  id: string;
  title: string;
  abstractText: string;
  awardeeName: string;
  startDate: string;
  expDate: string;
  fundProgramName: string;
  agency: string;
}

export function buildNsfAwardsRequest(keyword: string, page: number): FetchRequest {
  const url = new URL(NSF_AWARDS_URL);
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('printFields', NSF_AWARDS_PRINT_FIELDS.join(','));
  url.searchParams.set('rpp', String(NSF_AWARDS_MAX_RPP));
  // 1-based, in steps of exactly NSF_AWARDS_MAX_RPP.
  url.searchParams.set('offset', String((Math.max(1, page) - 1) * NSF_AWARDS_MAX_RPP + 1));
  return { url: url.toString(), method: 'GET', accept: 'json' };
}

export function parseNsfAwards(json: string): NsfAwardItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const awards = ((parsed as { response?: { award?: unknown } }).response ?? {}).award;
  if (!Array.isArray(awards)) return [];
  return awards.map((entry) => {
    const row = entry as Record<string, unknown>;
    return {
      id: String(row.id ?? ''),
      title: String(row.title ?? ''),
      abstractText: String(row.abstractText ?? ''),
      awardeeName: String(row.awardeeName ?? ''),
      startDate: String(row.startDate ?? ''),
      expDate: String(row.expDate ?? ''),
      fundProgramName: String(row.fundProgramName ?? ''),
      agency: String(row.agency ?? ''),
    };
  });
}
```

Create `packages/server/src/federal/usaSpending.ts`:

```ts
import type { FetchRequest } from '@grantspotter/core';

/**
 * USAspending v2 — AWARDED HISTORY for corroboration. Tier A (spec §7.5).
 *
 * award_type_codes 02/03/04/05 are block grants, formula grants, project grants and cooperative
 * agreements. Codes A-D (and the IDV codes) are PROCUREMENT CONTRACTS: omitting this filter
 * floods the inbox with defence-electronics purchase orders that no ham club can apply for.
 */
export const USASPENDING_SEARCH_URL =
  'https://api.usaspending.gov/api/v2/search/spending_by_award/';

export const USASPENDING_GRANT_TYPE_CODES: readonly string[] = Object.freeze([
  '02',
  '03',
  '04',
  '05',
]);

const FIELDS = [
  'Award ID',
  'Recipient Name',
  'Description',
  'Awarding Agency',
  'Award Amount',
  'Start Date',
  'End Date',
];

export interface UsaSpendingAward {
  awardId: string;
  recipientName: string;
  description: string;
  awardingAgency: string;
  amount?: number;
  startDate: string;
  endDate: string;
}

export function buildUsaSpendingRequest(keyword: string, page: number): FetchRequest {
  return {
    url: USASPENDING_SEARCH_URL,
    method: 'POST',
    accept: 'json',
    body: {
      filters: {
        keywords: [keyword],
        award_type_codes: [...USASPENDING_GRANT_TYPE_CODES],
        time_period: [{ start_date: '2019-01-01', end_date: '2030-12-31' }],
      },
      fields: FIELDS,
      page,
      limit: 25,
      sort: 'Award Amount',
      order: 'desc',
      subawards: false,
    },
  };
}

export function parseUsaSpending(json: string): UsaSpendingAward[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const results = (parsed as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.map((entry) => {
    const row = entry as Record<string, unknown>;
    const amount = Number(row['Award Amount']);
    const award: UsaSpendingAward = {
      awardId: String(row['Award ID'] ?? ''),
      recipientName: String(row['Recipient Name'] ?? ''),
      description: String(row.Description ?? ''),
      awardingAgency: String(row['Awarding Agency'] ?? ''),
      startDate: String(row['Start Date'] ?? ''),
      endDate: String(row['End Date'] ?? ''),
    };
    if (Number.isFinite(amount) && amount > 0) award.amount = amount;
    return award;
  });
}
```

Create `packages/server/src/sources/nsf-awards.ts`:

```ts
import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import { NSF_AWARDS_URL, buildNsfAwardsRequest, parseNsfAwards } from '../federal/nsf.js';

const SOURCE_ID = 'nsf-awards';
const KEYWORDS = ['ionosphere', 'amateur radio', 'radio science', 'cubesat', 'spectrum education'];

export const nsfAwards: SourceModule = {
  id: SOURCE_ID,
  funderId: 'nsf',
  label: 'NSF Awards API (awarded history)',
  tier: 'A',
  klass: 'adjacent_stem',
  requests: KEYWORDS.map((keyword): FetchRequest => buildNsfAwardsRequest(keyword, 1)),
  expectedMinRecords: 1,
  notes:
    'AWARDED HISTORY, not open opportunities — every record is stamped recordType=past_award so ' +
    'it can never render as a live deadline. Two undocumented API facts: printFields DOES work ' +
    'here despite the docs (without it abstractText is missing, and abstractText is the only ' +
    'field with enough prose to score adjacency), and rpp is HARD-CAPPED AT 25 — asking for 100 ' +
    'silently returns 25, so a paginator advancing by its requested page size skips three ' +
    'quarters of the results and never notices. offset is 1-based.',

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const byId = new Map<string, RawOpportunity>();
    for (const payload of payloads) {
      if (!payload.url.startsWith(NSF_AWARDS_URL) || payload.status !== 200) continue;
      for (const item of parseNsfAwards(payload.body)) {
        if (item.id === '' || byId.has(item.id)) continue;
        const scored = scoreAdjacency(
          [item.title, item.abstractText, item.fundProgramName].join('\n'),
        );
        if (scored.score < ADJACENCY_THRESHOLD) continue;
        byId.set(item.id, {
          sourceId: SOURCE_ID,
          externalKey: item.id,
          name: item.title,
          sourceUrl: `https://www.nsf.gov/awardsearch/showAward?AWD_ID=${item.id}`,
          rawText: item.abstractText,
          rawFields: {
            recordType: 'past_award',
            deadlineKind: 'dormant',
            awardee: item.awardeeName,
            program: item.fundProgramName,
            startDate: item.startDate,
            endDate: item.expDate,
            adjacencyScore: String(scored.score),
            adjacencyHits: scored.hits.join(', '),
          },
        });
      }
    }
    return [...byId.values()];
  },
};
```

Create `packages/server/src/sources/usaspending.ts`:

```ts
import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import {
  USASPENDING_SEARCH_URL,
  buildUsaSpendingRequest,
  parseUsaSpending,
} from '../federal/usaSpending.js';

const SOURCE_ID = 'usaspending';
const KEYWORDS = ['amateur radio', 'ionospheric', 'radio spectrum education', 'cubesat ground station'];

const money = (n: number): string => `$${n.toLocaleString('en-US')}`;

export const usaSpending: SourceModule = {
  id: SOURCE_ID,
  funderId: 'federal',
  label: 'USAspending awarded-grant history',
  tier: 'A',
  klass: 'adjacent_stem',
  requests: KEYWORDS.map((keyword): FetchRequest => buildUsaSpendingRequest(keyword, 1)),
  expectedMinRecords: 1,
  notes:
    'AWARDED HISTORY for corroboration: it answers "has anyone like me ever actually won this?" ' +
    'and "how big is a realistic award?". award_type_codes is pinned to 02/03/04/05 (block, ' +
    'formula and project grants plus cooperative agreements); omitting it returns PROCUREMENT ' +
    'CONTRACTS (codes A-D), which no ham club can apply for. Every record is stamped ' +
    'recordType=past_award so it can never render as a live deadline.',

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    const byId = new Map<string, RawOpportunity>();
    for (const payload of payloads) {
      if (!payload.url.startsWith(USASPENDING_SEARCH_URL) || payload.status !== 200) continue;
      for (const award of parseUsaSpending(payload.body)) {
        if (award.awardId === '' || byId.has(award.awardId)) continue;
        const scored = scoreAdjacency([award.description, award.awardingAgency].join('\n'));
        if (scored.score < ADJACENCY_THRESHOLD) continue;
        byId.set(award.awardId, {
          sourceId: SOURCE_ID,
          externalKey: award.awardId,
          name: `${award.awardingAgency}: ${award.description.slice(0, 120)}`,
          sourceUrl: `https://www.usaspending.gov/award/${encodeURIComponent(award.awardId)}`,
          rawText: award.description,
          rawFields: {
            recordType: 'past_award',
            deadlineKind: 'dormant',
            awardee: award.recipientName,
            startDate: award.startDate,
            endDate: award.endDate,
            adjacencyScore: String(scored.score),
            adjacencyHits: scored.hits.join(', '),
            ...(award.amount === undefined ? {} : { amountRaw: money(award.amount) }),
          },
        });
      }
    }
    return [...byId.values()];
  },
};
```

Register both in `registry.ts`: `import { nsfAwards } from './nsf-awards.js';`, `import { usaSpending } from './usaspending.js';`, and add `nsfAwards` and `usaSpending` to `MODULES`.

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/ && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/federal/nsf.ts packages/server/src/federal/usaSpending.ts \
  packages/server/src/sources/nsf-awards.ts packages/server/src/sources/usaspending.ts \
  packages/server/src/sources/nsf-awards.test.ts packages/server/src/sources/usaspending.test.ts \
  packages/server/src/sources/registry.ts \
  fixtures/nsf-awards fixtures/usaspending
git commit -m "feat(sources): NSF Awards and USAspending Tier A corroboration sources"
```

---

### Task 28: `grants-gov-extract` — the daily XML extract as the bulk backbone

**Files:**
- Create: `packages/server/src/federal/grantsGovExtract.ts`
- Create: `packages/server/src/sources/grants-gov-extract.ts`
- Create: `fixtures/grants-gov-extract/00-extract.zip.b64`
- Create: `scripts/make-extract-fixture.mjs` (dev-only, regenerates the fixture)
- Test: `packages/server/src/sources/grants-gov-extract.test.ts`
- Modify: `packages/server/src/sources/registry.ts`
- Modify: `packages/server/src/sources/registry.test.ts` — raise the count to 27

**Interfaces:**
- Consumes: `scoreAdjacency`, `ADJACENCY_THRESHOLD` (Task 23); `FetchRequest`, `FetchedPayload`, `RawOpportunity`, `SourceModule` from core; `cheerio` for the XML.
- Produces:
  ```ts
  export const GRANTS_GOV_EXTRACT_BASE = 'https://prod-grants-gov-chatbot.s3.amazonaws.com/extracts/';
  export const GRANTS_GOV_EXTRACT_RETENTION_DAYS = 7;
  export function extractUrlFor(date: Date): string;              // GrantsDBExtract{YYYYMMDD}v2.zip
  export function extractUrlsFor(today: Date, days?: number): string[];
  export function unzipFirstEntry(base64: string): string;        // node:zlib inflateRaw + ZIP walk
  export interface ExtractOpportunity { opportunityId: string; opportunityNumber: string; title: string; agencyName: string; description: string; postDate: string; closeDate: string; oppStatus: string }
  export function parseExtractXml(xml: string): ExtractOpportunity[];
  export const grantsGovExtract: SourceModule;
  ```

**Why the extract exists at all.** Spec §7.4 names it as the replacement for the four broken RSS feeds: *"We use search2 and the daily XML extract instead."* Task 22 built the `search2` half. `search2` is keyword-driven, so it can only find what we thought to ask for; the extract is the **whole posted corpus in one file**, which is what makes the adjacency scorer able to surface a programme nobody wrote a keyword for. It is the bulk backbone; `search2` is the targeted probe. Disagreement between the two is itself a signal, and the module records it.

**Four facts about the file:**
1. It is **~77.85 MB** compressed. Fetching it nightly per source is fine (one request, one host, off-peak); fetching it per *keyword* would not be. This module issues **one** request.
2. Retention is a **~7-day rolling window** — yesterday's URL 404s eventually and there is no index page. `extractUrlsFor` therefore produces today's URL first and walks back up to 7 days; the module's `parse` reads whichever payload actually arrived with status 200 and ignores the 404s. A single 404 is not a failure.
3. The URL is date-stamped **UTC**, format `GrantsDBExtract{YYYYMMDD}v2.zip`. The `v2` suffix is part of the filename, not a query parameter.
4. `accept` is `'binary'`, so `FetchedPayload.body` is **base64** (CONTRACT §3). The unzip is a minimal ZIP local-header walk plus `node:zlib.inflateRawSync` — the archive holds exactly one XML member, and no zip dependency enters the tree. This lives in `federal/`, not `sources/`, because `sources/*` stays free of `node:` imports.

- [ ] **Step 1: Build the committed fixture**

The real archive is 77.85 MB and is not committable. Create `scripts/make-extract-fixture.mjs`, which builds a byte-real 3-opportunity ZIP deterministically:

```js
// node scripts/make-extract-fixture.mjs
// Dev-only. Regenerates fixtures/grants-gov-extract/00-extract.zip.b64 — a real ZIP archive
// containing one XML member, small enough to commit and review. The production file is 77.85 MB.
// NOTE: node:zlib's crc32 export landed in Node 20.15; this host runs 20.11, so CRC-32 is
// computed here rather than imported. Twelve lines beats a version floor.
import { deflateRawSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<Grants xmlns="http://apply.grants.gov/system/OpportunityDetail-V1.0">
  <OpportunitySynopsisDetail_1_0>
    <OpportunityID>354102</OpportunityID>
    <OpportunityNumber>NSF 26-512</OpportunityNumber>
    <OpportunityTitle>Geospace Facilities</OpportunityTitle>
    <AgencyName>National Science Foundation</AgencyName>
    <Description>Operation of geospace observing facilities including incoherent scatter radar and ionospheric sounding instrumentation for radio science research.</Description>
    <PostDate>07062026</PostDate>
    <CloseDate>11142026</CloseDate>
    <OppStatus>posted</OppStatus>
  </OpportunitySynopsisDetail_1_0>
  <OpportunitySynopsisDetail_1_0>
    <OpportunityID>354777</OpportunityID>
    <OpportunityNumber>NTIA-26-PWSCIF</OpportunityNumber>
    <OpportunityTitle>Public Wireless Supply Chain Innovation Fund</OpportunityTitle>
    <AgencyName>National Telecommunications and Information Administration</AgencyName>
    <Description>Open radio access network testbeds, spectrum sharing research, and amateur radio spectrum education partnerships.</Description>
    <PostDate>02012026</PostDate>
    <CloseDate>05012026</CloseDate>
    <OppStatus>posted</OppStatus>
  </OpportunitySynopsisDetail_1_0>
  <OpportunitySynopsisDetail_1_0>
    <OpportunityID>351020</OpportunityID>
    <OpportunityNumber>HHS-2026-RAD</OpportunityNumber>
    <OpportunityTitle>Radiation Oncology Outcomes Research</OpportunityTitle>
    <AgencyName>Department of Health and Human Services</AgencyName>
    <Description>Clinical outcomes research in radiation oncology and survivorship care.</Description>
    <PostDate>03012026</PostDate>
    <CloseDate>09012026</CloseDate>
    <OppStatus>posted</OppStatus>
  </OpportunitySynopsisDetail_1_0>
</Grants>
`;

const name = Buffer.from('GrantsDBExtract20260802v2.xml', 'ascii');
const raw = Buffer.from(XML, 'utf8');
const deflated = deflateRawSync(raw, { level: 9 });
const crc = crc32(raw);

const local = Buffer.alloc(30);
local.writeUInt32LE(0x04034b50, 0);
local.writeUInt16LE(20, 4);           // version needed
local.writeUInt16LE(0, 6);            // flags
local.writeUInt16LE(8, 8);            // method: deflate
local.writeUInt16LE(0, 10);           // time
local.writeUInt16LE(0x2101, 12);      // date (fixed, so the file is byte-deterministic)
local.writeUInt32LE(crc, 14);
local.writeUInt32LE(deflated.length, 18);
local.writeUInt32LE(raw.length, 22);
local.writeUInt16LE(name.length, 26);
local.writeUInt16LE(0, 28);

const central = Buffer.alloc(46);
central.writeUInt32LE(0x02014b50, 0);
central.writeUInt16LE(20, 4);
central.writeUInt16LE(20, 6);
central.writeUInt16LE(0, 8);
central.writeUInt16LE(8, 10);
central.writeUInt16LE(0, 12);
central.writeUInt16LE(0x2101, 14);
central.writeUInt32LE(crc, 16);
central.writeUInt32LE(deflated.length, 20);
central.writeUInt32LE(raw.length, 24);
central.writeUInt16LE(name.length, 28);
central.writeUInt32LE(0, 42);         // local header offset

const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(1, 8);
end.writeUInt16LE(1, 10);
end.writeUInt32LE(central.length + name.length, 12);
end.writeUInt32LE(local.length + name.length + deflated.length, 16);

const zip = Buffer.concat([local, name, deflated, central, name, end]);
mkdirSync('fixtures/grants-gov-extract', { recursive: true });
writeFileSync('fixtures/grants-gov-extract/00-extract.zip.b64', zip.toString('base64'));
console.log(`wrote ${zip.length} bytes of ZIP as base64`);
```

Run it once:

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && node scripts/make-extract-fixture.mjs
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/src/sources/grants-gov-extract.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../../test/fixtures.js';
import {
  GRANTS_GOV_EXTRACT_BASE,
  GRANTS_GOV_EXTRACT_RETENTION_DAYS,
  extractUrlFor,
  extractUrlsFor,
  parseExtractXml,
  unzipFirstEntry,
} from '../federal/grantsGovExtract.js';
import { resolveRequests } from './types.js';
import { grantsGovExtract } from './grants-gov-extract.js';

const NOW = '2026-08-02T00:00:00.000Z';
const zipBase64 = () => loadFixture('grants-gov-extract', '00-extract.zip.b64');

const payload = (over: { status?: number; body?: string } = {}) => ({
  url: extractUrlFor(new Date(NOW)),
  status: over.status ?? 200,
  contentType: 'application/zip',
  body: over.body ?? zipBase64(),
  fetchedAt: NOW,
});

describe('extractUrlFor', () => {
  it('builds the date-stamped v2 filename in UTC', () => {
    expect(extractUrlFor(new Date('2026-08-02T23:30:00.000Z'))).toBe(
      `${GRANTS_GOV_EXTRACT_BASE}GrantsDBExtract20260802v2.zip`,
    );
  });

  it('zero-pads the month and day', () => {
    expect(extractUrlFor(new Date('2026-01-05T00:00:00.000Z'))).toContain('GrantsDBExtract20260105v2.zip');
  });
});

describe('extractUrlsFor', () => {
  it('walks back over the seven-day rolling retention window, newest first', () => {
    const urls = extractUrlsFor(new Date(NOW));
    expect(urls).toHaveLength(GRANTS_GOV_EXTRACT_RETENTION_DAYS);
    expect(urls[0]).toContain('20260802');
    expect(urls[1]).toContain('20260801');
    expect(urls[6]).toContain('20260727');
  });
});

describe('unzipFirstEntry', () => {
  it('inflates the single XML member without a zip dependency', () => {
    const xml = unzipFirstEntry(zipBase64());
    expect(xml).toContain('<OpportunityID>354102</OpportunityID>');
    expect(xml).toContain('Geospace Facilities');
  });

  it('throws a named error on something that is not a ZIP', () => {
    expect(() => unzipFirstEntry(Buffer.from('nope').toString('base64'))).toThrow(/ZIP/i);
  });
});

describe('parseExtractXml', () => {
  it('reads every opportunity in the archive', () => {
    const rows = parseExtractXml(unzipFirstEntry(zipBase64()));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      opportunityId: '354102',
      opportunityNumber: 'NSF 26-512',
      agencyName: 'National Science Foundation',
      oppStatus: 'posted',
    });
  });

  it('returns [] for junk rather than throwing', () => {
    expect(parseExtractXml('')).toEqual([]);
    expect(parseExtractXml('<html><body>nope</body></html>')).toEqual([]);
  });
});

describe('grantsGovExtract module', () => {
  it('is Tier A and issues exactly one request per retention day, no keywords involved', async () => {
    expect(grantsGovExtract.tier).toBe('A');
    expect(grantsGovExtract.klass).toBe('adjacent_stem');
    const requests = await resolveRequests(grantsGovExtract);
    expect(requests).toHaveLength(GRANTS_GOV_EXTRACT_RETENTION_DAYS);
    for (const r of requests) {
      expect(r.method).toBe('GET');
      expect(r.accept).toBe('binary');
      expect(r.url.startsWith(GRANTS_GOV_EXTRACT_BASE)).toBe(true);
    }
  });

  it('keeps the adjacent opportunities and drops the radiation-oncology one', () => {
    const raws = grantsGovExtract.parse([payload()]);
    const keys = raws.map((r) => r.externalKey);
    expect(keys).toContain('354102');
    expect(keys).toContain('354777');
    expect(keys).not.toContain('351020');
  });

  it('uses only the newest payload that actually arrived — a 404 on today is not a failure', () => {
    const stale = { ...payload(), url: `${GRANTS_GOV_EXTRACT_BASE}GrantsDBExtract20260801v2.zip` };
    const missingToday = { ...payload({ status: 404, body: '' }) };
    const raws = grantsGovExtract.parse([missingToday, stale]);
    expect(raws.length).toBeGreaterThan(0);
  });

  it('returns [] when every retention day 404s, without throwing', () => {
    expect(grantsGovExtract.parse([payload({ status: 404, body: '' })])).toEqual([]);
  });

  it('marks records with the extract as their provenance so a reviewer can tell them apart', () => {
    for (const raw of grantsGovExtract.parse([payload()])) {
      expect(raw.rawFields.federalSource).toBe('daily-extract');
      expect(raw.sourceUrl).toContain('grants.gov/search-results-detail/');
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/sources/grants-gov-extract.test.ts
```

Expected failure: `Failed to resolve import "../federal/grantsGovExtract.js"`.

- [ ] **Step 4: Write minimal implementation**

Create `packages/server/src/federal/grantsGovExtract.ts`:

```ts
import { inflateRawSync } from 'node:zlib';
import * as cheerio from 'cheerio';

/**
 * The Grants.gov DAILY XML EXTRACT — spec §7.4's replacement for the four broken RSS feeds,
 * and the bulk backbone behind the targeted `search2` probe in federal/grantsGov.ts.
 *
 * search2 is keyword-driven, so it can only find what we thought to ask for. The extract is the
 * whole posted corpus in one file, which is what lets the adjacency scorer surface a programme
 * nobody wrote a keyword for.
 *
 * Facts: ~77.85 MB compressed, so ONE request per night, never one per keyword. Retention is a
 * ~7-day rolling window with no index page, so we walk back day by day and treat 404s as normal.
 * The name is UTC-date-stamped and the `v2` is part of the filename.
 *
 * This lives in federal/, not sources/, because it needs node:zlib and `sources/*` must not.
 */
export const GRANTS_GOV_EXTRACT_BASE =
  'https://prod-grants-gov-chatbot.s3.amazonaws.com/extracts/';
export const GRANTS_GOV_EXTRACT_RETENTION_DAYS = 7;

export function extractUrlFor(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${GRANTS_GOV_EXTRACT_BASE}GrantsDBExtract${yyyy}${mm}${dd}v2.zip`;
}

/** Newest first. Yesterday's file is still there; last week's is not. */
export function extractUrlsFor(today: Date, days = GRANTS_GOV_EXTRACT_RETENTION_DAYS): string[] {
  const out: string[] = [];
  for (let back = 0; back < days; back += 1) {
    out.push(extractUrlFor(new Date(today.getTime() - back * 86_400_000)));
  }
  return out;
}

/**
 * Minimal ZIP reader: the archive holds exactly one deflated member, so we read the first local
 * file header and inflate. No zip dependency enters the tree for one known-shape archive.
 */
export function unzipFirstEntry(base64: string): string {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 30 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('not a ZIP archive: missing local file header signature');
  }
  const method = buf.readUInt16LE(8);
  const compressedSize = buf.readUInt32LE(18);
  const nameLength = buf.readUInt16LE(26);
  const extraLength = buf.readUInt16LE(28);
  const start = 30 + nameLength + extraLength;
  const body = buf.subarray(start, start + compressedSize);
  if (method === 0) return body.toString('utf8');
  if (method !== 8) throw new Error(`unsupported ZIP compression method ${method}`);
  return inflateRawSync(body).toString('utf8');
}

export interface ExtractOpportunity {
  opportunityId: string;
  opportunityNumber: string;
  title: string;
  agencyName: string;
  description: string;
  postDate: string;
  closeDate: string;
  oppStatus: string;
}

export function parseExtractXml(xml: string): ExtractOpportunity[] {
  if (!/<\s*OpportunitySynopsisDetail_1_0\b/i.test(xml)) return [];
  const $ = cheerio.load(xml, { xmlMode: true });
  const out: ExtractOpportunity[] = [];
  $('OpportunitySynopsisDetail_1_0').each((_, el) => {
    const $el = $(el);
    const text = (tag: string): string => $el.find(tag).first().text().trim();
    const opportunityId = text('OpportunityID');
    if (opportunityId === '') return;
    out.push({
      opportunityId,
      opportunityNumber: text('OpportunityNumber'),
      title: text('OpportunityTitle'),
      agencyName: text('AgencyName'),
      description: text('Description'),
      postDate: text('PostDate'),
      closeDate: text('CloseDate'),
      oppStatus: text('OppStatus'),
    });
  });
  return out;
}
```

Create `packages/server/src/sources/grants-gov-extract.ts`:

```ts
import type { FetchRequest, FetchedPayload, RawOpportunity, SourceModule } from '@grantspotter/core';
import { ADJACENCY_THRESHOLD, scoreAdjacency } from '../federal/adjacency.js';
import {
  GRANTS_GOV_EXTRACT_BASE,
  extractUrlsFor,
  parseExtractXml,
  unzipFirstEntry,
} from '../federal/grantsGovExtract.js';

const SOURCE_ID = 'grants-gov-extract';

/** `MMDDYYYY` as published in the extract, to ISO `YYYY-MM-DD`. '' when absent or malformed. */
function isoDate(mmddyyyy: string): string {
  if (!/^\d{8}$/.test(mmddyyyy)) return '';
  return `${mmddyyyy.slice(4)}-${mmddyyyy.slice(0, 2)}-${mmddyyyy.slice(2, 4)}`;
}

export const grantsGovExtract: SourceModule = {
  id: SOURCE_ID,
  funderId: 'federal',
  label: 'Grants.gov daily XML extract (bulk backbone)',
  tier: 'A',
  klass: 'adjacent_stem',
  // A function so the date window is computed at crawl time, not at module load.
  requests: async (): Promise<FetchRequest[]> =>
    extractUrlsFor(new Date()).map((url) => ({ url, method: 'GET', accept: 'binary' })),
  expectedMinRecords: 1,
  notes:
    'Spec §7.4 names this file as the replacement for the four broken Grants.gov RSS feeds, ' +
    'alongside search2. search2 is keyword-driven and can only find what we thought to ask for; ' +
    'this is the whole posted corpus in one ~77.85 MB file, which is what lets the adjacency ' +
    'scorer surface a programme nobody wrote a keyword for. Retention is a ~7-day rolling ' +
    'window with no index page, so the module requests today and walks back a week and treats ' +
    '404s as normal — a missing day is not a failure. ONE request per day of the window, never ' +
    'one per keyword.',

  parse(payloads: FetchedPayload[]): RawOpportunity[] {
    // Newest successful payload wins; the rest of the retention window is redundant.
    const usable = payloads
      .filter((p) => p.url.startsWith(GRANTS_GOV_EXTRACT_BASE) && p.status === 200 && p.body !== '')
      .sort((a, b) => b.url.localeCompare(a.url));
    for (const payload of usable) {
      let rows: ReturnType<typeof parseExtractXml>;
      try {
        rows = parseExtractXml(unzipFirstEntry(payload.body));
      } catch {
        continue; // a truncated or non-ZIP body is just a day we skip
      }
      const out: RawOpportunity[] = [];
      for (const row of rows) {
        const scored = scoreAdjacency([row.title, row.agencyName, row.description].join('\n'));
        if (scored.score < ADJACENCY_THRESHOLD) continue;
        out.push({
          sourceId: SOURCE_ID,
          externalKey: row.opportunityId,
          name: row.title,
          sourceUrl: `https://grants.gov/search-results-detail/${row.opportunityId}`,
          rawText: row.description,
          rawFields: {
            federalSource: 'daily-extract',
            opportunityNumber: row.opportunityNumber,
            agency: row.agencyName,
            postDate: isoDate(row.postDate),
            closeDate: isoDate(row.closeDate),
            oppStatus: row.oppStatus,
            adjacencyScore: String(scored.score),
            adjacencyHits: scored.hits.join(', '),
          },
        });
      }
      if (out.length > 0) return out;
    }
    return [];
  },
};
```

Register `grantsGovExtract` in `registry.ts`, and raise the count assertion in `registry.test.ts` — the registry is now complete:

```ts
it('holds all 27 source modules', () => {
  expect(SOURCES).toHaveLength(27);
});
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/ && npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/federal/grantsGovExtract.ts \
  packages/server/src/sources/grants-gov-extract.ts \
  packages/server/src/sources/grants-gov-extract.test.ts \
  packages/server/src/sources/registry.ts packages/server/src/sources/registry.test.ts \
  scripts/make-extract-fixture.mjs fixtures/grants-gov-extract
git commit -m "feat(sources): Grants.gov daily XML extract as the federal bulk backbone"
```

---

### Task 29: `ai/assist.ts` — the strictly-optional `ANTHROPIC_API_KEY` parse assist

**Files:**
- Create: `packages/server/src/ai/assist.ts`
- Test: `packages/server/src/ai/assist.test.ts`
- Modify: `packages/server/src/review/index.ts` — let `preScore` override `confidenceFor`, only when it returns a value
- Modify: `packages/server/src/crawl/runner.ts` — offer failed-parse pages to `parseAssist`
- Modify: `packages/server/package.json` — add `@anthropic-ai/sdk` as a dependency

**Interfaces:**
- Consumes: `AppConfig` from `../config.js` (Plan 1 Task 11 reads `ANTHROPIC_API_KEY` into `config.anthropicApiKey`); `RawOpportunity`, `Program`, `SourceTier`, `ChangeKind` from core.
- Produces:
  ```ts
  export const AI_ASSIST_MODEL = 'claude-sonnet-5';
  export interface AiAssist {
    isEnabled(): boolean;
    parseAssist(html: string, hint: ParseHint): Promise<RawOpportunity[]>;
    preScore(candidate: Program): Promise<number | undefined>;
  }
  export interface ParseHint { sourceId: string; sourceUrl: string; expectedFields: string[] }
  export function createAiAssist(config: Pick<AppConfig, 'anthropicApiKey'>, deps?: { client?: AiClient }): AiAssist;
  export interface AiClient { complete(system: string, user: string, schema: unknown): Promise<string> }
  export function parseAssistResponse(text: string, sourceId: string, sourceUrl: string): RawOpportunity[];
  export function parsePreScoreResponse(text: string): number | undefined;
  ```

**Spec §9, stated exactly.** *"If `ANTHROPIC_API_KEY` is present, the crawler additionally uses it to parse messy pages and pre-score review-queue items."* Plan 1 already reads the key into `config.anthropicApiKey`, Plan 5's `.env.example`, `docker-compose.yml` and README already describe the behaviour, and a README test asserts that text. Until this task, **nothing consumed the key** — the shipped README would have described a feature that does not exist, which is precisely the honesty failure this whole product is built to avoid.

**Five rules, each asserted by a test:**

1. **Absent key ⇒ zero calls.** `isEnabled()` is `false`, `parseAssist` resolves to `[]`, `preScore` resolves to `undefined`, and no client is ever constructed. Not "falls back gracefully" — *no network call is made at all*.
2. **Never on a read path.** `ai/` is imported by `crawl/` and `review/` only. A test greps `packages/server/src/api/` and asserts it never imports `ai/`. A page view must never wait on a model, and a browsing user must never trigger a paid call.
3. **Never required.** Every behaviour of the crawl is identical with and without the key **except** the confidence number and the salvage of pages the deterministic parsers already failed on. `parseAssist` is only ever called when `module.parse()` returned **zero** records for a source whose `expectedMinRecords > 0` — it is a salvage path, never the primary one.
4. **Never drafts prose.** Enforced twice: the system prompt forbids composing narrative text, **and** the request pins `output_config.format` to a `json_schema`, so the model cannot return anything but the extraction envelope. Spec §9 is explicit that the app does not write the applicant's essay; the AI assist reads pages, it does not author them. `parseAssistResponse` still validates the result independently — the schema is a guardrail, not a reason to trust the output.
5. **Model id is `claude-sonnet-5`** — cheap, fast, and strong at structured extraction, which is the entire job here. It is a constant, not a configurable knob, so a deployment cannot silently switch to a model whose extraction behaviour has not been tested. **Thinking is explicitly disabled** and `effort` is `low`: on `claude-sonnet-5` an omitted `thinking` field runs *adaptive* thinking, and `max_tokens` caps thinking **plus** response text — a 4k budget would then truncate the JSON envelope mid-object. Extraction does not need reasoning depth; it needs the whole envelope to arrive.

- [ ] **Step 1: Write the failing test**

Create `packages/server/src/ai/assist.test.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AI_ASSIST_MODEL,
  createAiAssist,
  parseAssistResponse,
  parsePreScoreResponse,
} from './assist.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const hint = {
  sourceId: 'qcwa',
  sourceUrl: 'https://www.qcwa.org/scholarship-program.htm',
  expectedFields: ['Award Amount', 'Number of Awards', 'License Requirement'],
};

const program = () =>
  ({
    id: 'p',
    funderId: 'qcwa',
    name: 'QCWA Memorial Scholarship',
    klass: 'ham_scholarship',
    summary: 's',
    applicantEntities: ['individual'],
    amount: { instrument: 'cash_fixed', amountRaw: '$3,000', awardCountRaw: '19' },
    deadline: { kind: 'rolling', source: { kind: 'self' }, note: '' },
    applyVia: 'page_form',
    constraints: [],
    fundingRestrictions: [],
    obligations: { costShareRequired: false, coFunderPreference: false },
    aiPolicy: { stance: 'unaddressed' },
    trust: {
      status: 'open',
      sourceUrl: 'https://www.qcwa.org/scholarship-program.htm',
      lastVerifiedAt: '2026-08-02T00:00:00.000Z',
      verificationMethod: 'live_fetch',
      contentHash: 'h',
    },
    rawOtherText: '',
    tags: [],
  }) as const;

describe('no key means no calls at all', () => {
  it('is disabled, returns nothing, and never constructs a client', async () => {
    const client = { complete: vi.fn() };
    const assist = createAiAssist({ anthropicApiKey: undefined }, { client });
    expect(assist.isEnabled()).toBe(false);
    await expect(assist.parseAssist('<html></html>', hint)).resolves.toEqual([]);
    await expect(assist.preScore(program())).resolves.toBeUndefined();
    expect(client.complete).not.toHaveBeenCalled();
  });

  it('treats an empty or whitespace key as absent', async () => {
    const client = { complete: vi.fn() };
    const assist = createAiAssist({ anthropicApiKey: '   ' }, { client });
    expect(assist.isEnabled()).toBe(false);
    await assist.parseAssist('<html></html>', hint);
    expect(client.complete).not.toHaveBeenCalled();
  });
});

describe('with a key', () => {
  const enabled = (complete: (s: string, u: string, schema: unknown) => Promise<string>) =>
    createAiAssist({ anthropicApiKey: 'sk-test' }, { client: { complete } });

  it('extracts fields into RawOpportunity records', async () => {
    const assist = enabled(async () =>
      JSON.stringify({
        records: [
          {
            externalKey: 'qcwa-memorial-scholarship',
            name: 'QCWA Memorial Scholarship',
            rawFields: { 'Award Amount': '$3,000', 'Number of Awards': '19' },
            rawText: 'Sponsored by an active QCWA member.',
          },
        ],
      }),
    );
    const raws = await assist.parseAssist('<html>messy</html>', hint);
    expect(raws).toHaveLength(1);
    expect(raws[0].sourceId).toBe('qcwa');
    expect(raws[0].rawFields['Award Amount']).toBe('$3,000');
    expect(raws[0].sourceUrl).toBe(hint.sourceUrl);
  });

  it('uses the pinned model id', async () => {
    let seenSystem = '';
    const assist = enabled(async (system) => {
      seenSystem = system;
      return '{"records":[]}';
    });
    await assist.parseAssist('<html></html>', hint);
    expect(AI_ASSIST_MODEL).toBe('claude-sonnet-5');
    expect(seenSystem).toContain('extract');
  });

  it('pins the reply to a JSON schema, so prose is not even representable', async () => {
    let seenSchema: unknown;
    const assist = enabled(async (_system, _user, schema) => {
      seenSchema = schema;
      return '{"records":[]}';
    });
    await assist.parseAssist('<html></html>', hint);
    const schema = seenSchema as { properties: { records: unknown }; additionalProperties: boolean };
    expect(schema.properties.records).toBeDefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it('forbids drafting narrative prose in the system prompt', async () => {
    let seenSystem = '';
    const assist = enabled(async (system) => {
      seenSystem = system;
      return '{"records":[]}';
    });
    await assist.parseAssist('<html></html>', hint);
    expect(seenSystem).toMatch(/never (write|compose|draft)/i);
    expect(seenSystem).toMatch(/prose|narrative|essay/i);
  });

  it('returns a 0..1 confidence from preScore', async () => {
    const assist = enabled(async () => '{"confidence":0.42,"reason":"amount and deadline agree"}');
    await expect(assist.preScore(program())).resolves.toBeCloseTo(0.42, 5);
  });

  it('swallows a transport failure and degrades to deterministic-only', async () => {
    const assist = enabled(async () => {
      throw new Error('429 overloaded');
    });
    await expect(assist.parseAssist('<html></html>', hint)).resolves.toEqual([]);
    await expect(assist.preScore(program())).resolves.toBeUndefined();
  });
});

describe('response parsing is strict', () => {
  it('rejects anything that is not the JSON envelope', () => {
    expect(parseAssistResponse('I found three scholarships on this page!', 'qcwa', 'u')).toEqual([]);
    expect(parseAssistResponse('{"records":"nope"}', 'qcwa', 'u')).toEqual([]);
    expect(parseAssistResponse('', 'qcwa', 'u')).toEqual([]);
  });

  it('drops a record with no externalKey rather than minting one', () => {
    expect(
      parseAssistResponse('{"records":[{"name":"x","rawFields":{},"rawText":"y"}]}', 'qcwa', 'u'),
    ).toEqual([]);
  });

  it('clamps and validates the pre-score', () => {
    expect(parsePreScoreResponse('{"confidence":0.5}')).toBe(0.5);
    expect(parsePreScoreResponse('{"confidence":9}')).toBe(1);
    expect(parsePreScoreResponse('{"confidence":-4}')).toBe(0);
    expect(parsePreScoreResponse('{"confidence":"high"}')).toBeUndefined();
    expect(parsePreScoreResponse('not json')).toBeUndefined();
  });
});

describe('the assist is never on a read path', () => {
  it('is not imported anywhere under api/', async () => {
    const apiDir = path.join(SERVER_SRC, 'api');
    const files = await readdir(apiDir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.ts')) continue;
      const src = await readFile(path.join(apiDir, file), 'utf8');
      expect(src, `${file} must not import the AI assist`).not.toMatch(/ai\/assist/);
    }
  });

  it('is imported only by crawl/ and review/', async () => {
    const dirs = await readdir(SERVER_SRC, { recursive: true, withFileTypes: true });
    for (const entry of dirs) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
      const full = path.join(entry.parentPath ?? SERVER_SRC, entry.name);
      if (full.includes(`${path.sep}ai${path.sep}`)) continue;
      const src = await readFile(full, 'utf8');
      if (!/ai\/assist/.test(src)) continue;
      expect(
        full.includes(`${path.sep}crawl${path.sep}`) || full.includes(`${path.sep}review${path.sep}`),
        `${full} must not import the AI assist`,
      ).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/ai/
```

Expected failure: `Failed to resolve import "./assist.js"`.

- [ ] **Step 3: Write minimal implementation**

Add the SDK to `packages/server/package.json` `dependencies` (exact, non-caret, matching the house style):

```json
"@anthropic-ai/sdk": "0.110.0"
```

Create `packages/server/src/ai/assist.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import type { Program, RawOpportunity } from '@grantspotter/core';
import type { AppConfig } from '../config.js';

/**
 * Spec §9's OPTIONAL server-side assist. Everything about this module is defensive:
 *
 *  - No ANTHROPIC_API_KEY => isEnabled() is false, no client is constructed, and NO NETWORK CALL
 *    IS EVER MADE. Not "degrades gracefully" — it does not call.
 *  - Never on a read path. Only crawl/ and review/ import this; api/ never does, and a test in
 *    assist.test.ts enforces that. A page view must never wait on a model.
 *  - Never required. parseAssist is a SALVAGE path, invoked only when the deterministic parser
 *    already returned zero records for a source that expects some. preScore only ever refines a
 *    confidence number that has a deterministic value already.
 *  - Never drafts prose. This extracts fields from pages. Spec §9 is explicit that the product
 *    does not write the applicant's essay, and the system prompt says so.
 *
 * Model: claude-sonnet-5. Cheap, fast and strong at structured extraction, which is the whole
 * job. Pinned as a constant rather than configured, so a deployment cannot silently swap in a
 * model whose extraction behaviour nobody has tested here.
 */
export const AI_ASSIST_MODEL = 'claude-sonnet-5';
const MAX_HTML_CHARS = 60_000;
const MAX_TOKENS = 4_096;

/**
 * On claude-sonnet-5 an OMITTED `thinking` field runs adaptive thinking, and max_tokens caps
 * thinking + response text together — a 4k budget would truncate the envelope mid-object.
 * Extraction needs the whole envelope, not reasoning depth, so thinking is disabled explicitly
 * and effort is `low`. (Disabling thinking is accepted on Sonnet 5 at any effort.)
 */
const THINKING = { type: 'disabled' } as const;
const EFFORT = 'low' as const;

export interface ParseHint {
  sourceId: string;
  sourceUrl: string;
  expectedFields: string[];
}

export interface AiClient {
  /** `schema` is a JSON Schema passed as output_config.format — the reply cannot be prose. */
  complete(system: string, user: string, schema: unknown): Promise<string>;
}

export interface AiAssist {
  isEnabled(): boolean;
  parseAssist(html: string, hint: ParseHint): Promise<RawOpportunity[]>;
  preScore(candidate: Program): Promise<number | undefined>;
}

const PARSE_SYSTEM = [
  'You extract published grant and scholarship facts from a web page into strict JSON.',
  'You NEVER write, compose or draft prose, narrative, summaries in your own voice, or essay',
  'text of any kind. You copy what the page says, verbatim, into fields.',
  'If a field is not on the page, omit it. Never infer a deadline, an amount or an eligibility',
  'rule that the page does not state.',
].join(' ');

const PARSE_SCHEMA = {
  type: 'object',
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          externalKey: { type: 'string' },
          name: { type: 'string' },
          rawFields: { type: 'object', additionalProperties: { type: 'string' } },
          rawText: { type: 'string' },
        },
        required: ['externalKey', 'name', 'rawFields', 'rawText'],
        additionalProperties: false,
      },
    },
  },
  required: ['records'],
  additionalProperties: false,
} as const;

const SCORE_SYSTEM = [
  'You judge how likely a scraped grant record is to be correct, given its own fields.',
  'You NEVER write prose for a user and NEVER invent facts.',
  'confidence is a number from 0 to 1.',
].join(' ');

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['confidence', 'reason'],
  additionalProperties: false,
} as const;

/** Strict: junk, prose, or a wrong shape all yield []. Never throws. */
export function parseAssistResponse(
  text: string,
  sourceId: string,
  sourceUrl: string,
): RawOpportunity[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const records = (parsed as { records?: unknown }).records;
  if (!Array.isArray(records)) return [];
  const out: RawOpportunity[] = [];
  for (const entry of records) {
    const row = entry as Record<string, unknown>;
    const externalKey = typeof row.externalKey === 'string' ? row.externalKey.trim() : '';
    if (externalKey === '') continue; // never mint an identity the model made up
    const rawFields: Record<string, string> = {};
    for (const [key, value] of Object.entries((row.rawFields ?? {}) as Record<string, unknown>)) {
      if (typeof value === 'string') rawFields[key] = value;
    }
    rawFields.aiAssisted = 'true';
    out.push({
      sourceId,
      externalKey,
      name: typeof row.name === 'string' ? row.name : externalKey,
      rawFields,
      sourceUrl,
      rawText: typeof row.rawText === 'string' ? row.rawText : '',
    });
  }
  return out;
}

export function parsePreScoreResponse(text: string): number | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const value = (parsed as { confidence?: unknown }).confidence;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function realClient(apiKey: string): AiClient {
  const anthropic = new Anthropic({ apiKey });
  return {
    async complete(system, user, schema) {
      const message = await anthropic.messages.create({
        model: AI_ASSIST_MODEL,
        max_tokens: MAX_TOKENS,
        thinking: THINKING,
        output_config: { effort: EFFORT, format: { type: 'json_schema', schema } },
        system,
        messages: [{ role: 'user', content: user }],
      });
      // content is a discriminated union — narrow on .type before reading .text.
      return message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('')
        .trim();
    },
  };
}

export function createAiAssist(
  config: Pick<AppConfig, 'anthropicApiKey'>,
  deps: { client?: AiClient } = {},
): AiAssist {
  const key = (config.anthropicApiKey ?? '').trim();
  const enabled = key !== '';
  // Constructed lazily and ONLY when enabled: no key means no client and no call.
  let client: AiClient | undefined;
  const getClient = (): AiClient => {
    client ??= deps.client ?? realClient(key);
    return client;
  };

  return {
    isEnabled: () => enabled,

    async parseAssist(html, hint) {
      if (!enabled) return [];
      const user = [
        `Source id: ${hint.sourceId}`,
        `Source URL: ${hint.sourceUrl}`,
        `Fields this source usually publishes: ${hint.expectedFields.join(', ')}`,
        'Page HTML follows. Extract every distinct grant or scholarship it publishes.',
        html.slice(0, MAX_HTML_CHARS),
      ].join('\n\n');
      try {
        const text = await getClient().complete(PARSE_SYSTEM, user, PARSE_SCHEMA);
        return parseAssistResponse(text, hint.sourceId, hint.sourceUrl);
      } catch {
        return []; // a rate limit or an outage degrades to deterministic-only, silently
      }
    },

    async preScore(candidate) {
      if (!enabled) return undefined;
      const user = JSON.stringify({
        name: candidate.name,
        amount: candidate.amount,
        deadline: candidate.deadline,
        constraints: candidate.constraints.map((c) => c.rawText),
        rawOtherText: candidate.rawOtherText.slice(0, 4_000),
        sourceUrl: candidate.trust.sourceUrl,
      });
      try {
        return parsePreScoreResponse(await getClient().complete(SCORE_SYSTEM, user, SCORE_SCHEMA));
      } catch {
        return undefined;
      }
    },
  };
}
```

- [ ] **Step 4: Wire it into `review/index.ts`, as an override only**

Add an optional `assist` argument to `buildReviewItems` and let it refine, never replace, the deterministic confidence:

```ts
// packages/server/src/review/index.ts
import type { AiAssist } from '../ai/assist.js';

export async function buildReviewItems(
  db: Database.Database,
  events: ChangeEvent[],
  candidatesById: Map<string, Program>,
  tier: SourceTier,
  sourceId: string,
  assist?: AiAssist,
): Promise<ReviewItem[]> {
  // ... unchanged loop up to the confidence line ...
  const deterministic = confidenceFor(tier, event.kind);
  // Optional (spec §9). undefined whenever ANTHROPIC_API_KEY is absent or the call failed,
  // and then the deterministic number stands exactly as it did before this task existed.
  const assisted = assist === undefined ? undefined : await assist.preScore(candidate);
  const item: ReviewItem = {
    id: reviewItemId(event),
    changeEventId: event.id,
    candidate,
    decision: 'pending',
    confidence: assisted ?? deterministic,
    rejectKey,
  };
  // ... unchanged ...
}
```

Update the existing Task 21 tests to `await buildReviewItems(...)` — the function is now async. Add one test proving the override is optional:

```ts
it('uses the deterministic confidence when no assist is supplied', async () => {
  const [item] = await buildReviewItems(db, [event()], new Map([[program().id, program()]]), 'C', 'qcwa');
  expect(item.confidence).toBe(confidenceFor('C', 'new'));
});

it('lets an enabled assist refine the confidence, and ignores it when it returns undefined', async () => {
  const refining = { isEnabled: () => true, parseAssist: async () => [], preScore: async () => 0.33 };
  const silent = { isEnabled: () => true, parseAssist: async () => [], preScore: async () => undefined };
  db.exec('DELETE FROM review_items');
  const [a] = await buildReviewItems(db, [event()], new Map([[program().id, program()]]), 'C', 'qcwa', refining);
  expect(a.confidence).toBeCloseTo(0.33, 5);
  db.exec('DELETE FROM review_items');
  const [b] = await buildReviewItems(db, [event()], new Map([[program().id, program()]]), 'C', 'qcwa', silent);
  expect(b.confidence).toBe(confidenceFor('C', 'new'));
});
```

- [ ] **Step 5: Wire it into `crawl/runner.ts`, as a salvage path only**

```ts
// packages/server/src/crawl/runner.ts
import { createAiAssist, type AiAssist } from '../ai/assist.js';

export interface CrawlDeps {
  db: Database.Database;
  fetcher: Fetcher;
  nowISO: () => string;
  /** Optional (spec §9). Defaults to a disabled assist, i.e. exactly the old behaviour. */
  assist?: AiAssist;
}

// inside runSource, immediately after `const raws: RawOpportunity[] = module.parse(payloads);`
let raws: RawOpportunity[] = module.parse(payloads);
// SALVAGE ONLY: the deterministic parser found nothing on a source that should have records.
// With no ANTHROPIC_API_KEY this branch calls nothing and raws stays [].
if (raws.length === 0 && module.expectedMinRecords > 0 && deps.assist?.isEnabled()) {
  const html = payloads.find((p) => p.status === 200 && p.body !== '')?.body ?? '';
  if (html !== '') {
    raws = await deps.assist.parseAssist(html, {
      sourceId,
      sourceUrl: payloads[0]?.url ?? '',
      expectedFields: ['Award Amount', 'Number of Awards', 'License Requirement', 'Field of Study', 'Region'],
    });
  }
}

// and where review items are built:
reviewItemCount = (await buildReviewItems(deps.db, events, byId, module.tier, sourceId, deps.assist)).length;
```

Construct it once in `packages/server/src/index.ts` alongside the fetcher:

```ts
import { createAiAssist } from './ai/assist.js';

// inside the runCrawl({ ... }) call:
assist: createAiAssist(config),   // disabled, and calls nothing, when ANTHROPIC_API_KEY is unset
```

Add one runner test proving the crawl is byte-identical without a key:

```ts
it('behaves identically with a disabled assist and with none at all — spec §9 is optional', async () => {
  const { fetcher } = fixtureFetcher(map);
  const disabled = { isEnabled: () => false, parseAssist: async () => [], preScore: async () => undefined };
  const a = await runSource({ ...deps(fetcher), assist: disabled }, 'arrl-scholarship-descriptions');
  db.exec('DELETE FROM review_items; DELETE FROM change_events; DELETE FROM programs;');
  const b = await runSource(deps(fetcher), 'arrl-scholarship-descriptions');
  expect(a.parsedCount).toBe(b.parsedCount);
  expect(a.reviewItems).toBe(b.reviewItems);
});
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
export PATH="/home/kasm-user/.local/node/bin:$PATH"
cd /home/kasm-user/grantspotter && npx vitest run packages/server/src/ && npm run typecheck && npm run build
```

- [ ] **Step 7: Commit**

```bash
cd /home/kasm-user/grantspotter
git add packages/server/src/ai packages/server/src/review/index.ts \
  packages/server/src/review/index.test.ts packages/server/src/crawl/runner.ts \
  packages/server/src/crawl/runner.test.ts packages/server/src/index.ts \
  packages/server/package.json
git commit -m "feat(ai): strictly-optional Anthropic parse assist and review pre-scoring"
```

---

## Plan 2 is done when

- [ ] `npm run typecheck`, `npm run build` and `npm test` are all green.
- [ ] All **27** source modules are registered, and every one has a committed fixture directory and an offline parser test.
- [ ] The blocklist test proves the six required hosts are refused **inside the fetcher, before any transport call**, across subdomains, schemes, ports, trailing dots, userinfo and redirect targets, and that no configuration can re-enable them.
- [ ] `arrl-scholarship-descriptions` parses the pathological fixture into exactly 6 records from 4 accordions with 3 stubs dropped and the `EXPLORE ARRL` chrome excluded, reading `R egion`, `License   Requirement` and `Number of Scholarshps`.
- [ ] All seven `ChangeKind` values are emitted and unit-tested, `parse_yield_dropped` never fires for `austin-arc`, and an empty Austin ARC scrape produces no `vanished` events.
- [ ] `scoreAdjacency` scores the NSF geospace and ATE cases above 6 and the radiation-oncology case at 0.
- [ ] The review inbox publishes only on approval, and a rejected candidate with unchanged content does not resurface.
- [ ] **`programs` has exactly one shape** (RESOLUTIONS R1): `createProgramRepo` is the only reader and writer, `packages/server/src/db/programDoc.ts` does not exist, and no `doc` or `data` column exists anywhere. `ensureIngestionSchema` creates only `review_rejects` and throws `MissingSchemaError` against an unmigrated database.
- [ ] **There is no `source_health` table** (RESOLUTIONS R4). `recordPollStart` / `recordPollSuccess` / `recordPollFailure` write `sources.last_polled_at`, `sources.last_success_at`, `sources.last_record_count`, `sources.consecutive_failures` and `sources.last_error` — the exact columns Plan 3's Sources page reads.
- [ ] **Pausing a source actually pauses it** (RESOLUTIONS R20). `runCrawl` filters out every id with `sources.enabled = 0`, including one named explicitly in `sourceIds`, so a paused source gets no fetch, no `sources.last_polled_at` update and no `snapshots` row; `enabled` is in `REQUIRED_COLUMNS.sources`; and `recordPollStart` never overwrites the flag. Verify with:

```bash
cd /home/kasm-user/grantspotter && grep -n "enabled = 0" packages/server/src/crawl/runner.ts
```

- [ ] **No index name is declared twice** (RESOLUTIONS R23). `ensureIngestionSchema` adds only `idx_audit_entity`; `idx_snapshots_source` belongs to Plan 1's `001-init.sql` and Plan 2 does not re-declare it under a different definition. Verify with:

```bash
cd /home/kasm-user/grantspotter && grep -rn "CREATE INDEX.*idx_snapshots_source" packages/server/src \
  | grep -v "db/migrations/001-init.sql"
```

(expected: no output — the only `CREATE INDEX … idx_snapshots_source` in the tree is Plan 1's)
- [ ] **A second crawl over an already-seeded program emits no `new` and no `vanished`** (RESOLUTIONS R9). `DEADLINE_INHERITANCE` names the canonical id `arrl-foundation-scholarships`, `normalizeRaw` consults `ctx.existingIdFor`, and approval writes `programs.source_id` / `programs.external_key`.
- [ ] **`expandCycles` returns a non-empty result for ARDC, ARRL Amateur Radio Grants and ARRL Foundation Scholarships** (RESOLUTIONS R12) — the `RECUR:` directive is really emitted in `DeadlineSpec.note`, and its kind matches the emitted `DeadlineKind`.
- [ ] **`normalize/` is pure**: no file under it imports `node:`, reads a file, reads the clock or reaches outside `@grantspotter/core`, and `radiusCenters.ts` matches `data/reference/radius-centers.json`.
- [ ] **`buildUserAgent` has exactly one definition**, in `packages/server/src/config.ts` (RESOLUTIONS R10). `fetcher/index.ts` does not export one.
- [ ] **Every §4.6 obligation field is reachable through `normalizeRaw`**, including `reportingObligation` (YASME) and `costShareRequired` (NCDXF).
- [ ] **With no `ANTHROPIC_API_KEY` and no `SIMPLER_GRANTS_API_KEY`, the crawl makes zero calls to either service and behaves exactly as it does without the modules.** Both are optional; neither ever gates whether an opportunity is found.
- [ ] `npm run verify-sources` exits 0 and is referenced by no workflow file; `verify-sources` and `capture-fixture` are both in the root `package.json` and neither is part of `build`, `test` or CI.
- [ ] **Every commit is local. `git log origin/master..HEAD` is non-empty and nothing has been pushed.** Verify with:

```bash
cd /home/kasm-user/grantspotter && git log --oneline -30 && git status --short
```

Plan 3 consumes from here: `SOURCES`, `runCrawl`, `runSource`, `listSourceHealth`, `listInbox`, `approveReviewItem`, `rejectReviewItem`, `editReviewItem`, `provenanceFor`, `listChangeEvents`, `listProgramsBySource`, `normalizeRaw`, `contextForSource`, `diffPrograms`, `scoreAdjacency`.


