# GrantSpotter — Shared Implementation Contract

**This file is the single source of truth for names, types, and layout across all five plans.**
Every plan consumes it verbatim. If a plan needs a type not defined here, it defines it inside
its own package and says so explicitly — it never invents a shared name.

Spec: [`../specs/2026-08-02-grantspotter-design.md`](../specs/2026-08-02-grantspotter-design.md)

---

## 1. Toolchain (verified on this host)

- Node **v20.11.0**, npm **10.2.4** (`export PATH="/path/to/node20/bin:$PATH"`)
- TypeScript strict, `"module": "NodeNext"`, `"target": "ES2022"`
- Vitest for unit/integration, Playwright for e2e
- **No Docker on this host.** The image is built and verified by GitHub Actions, not locally.
  Local verification stops at `typecheck + build + test + test:e2e`.

## 2. Repository layout

```
grantspotter/
├── package.json                    # npm workspaces root
├── tsconfig.base.json
├── vitest.workspace.ts
├── playwright.config.ts
├── Dockerfile
├── docker-compose.yml              # carries the deployment config inline; there is no .env.example
├── .github/workflows/build.yml
├── packages/
│   ├── core/                       # PURE. No I/O. No node: imports. No deps but zod.
│   │   ├── package.json            # name: "@grantspotter/core"
│   │   └── src/
│   │       ├── types.ts            # every shared type (§3)
│   │       ├── schema.ts           # zod schemas mirroring types.ts
│   │       ├── amount.ts           # parseAmount
│   │       ├── deadline.ts         # resolveDeadline, expandCycles
│   │       ├── geo.ts              # ARRL division/section resolution, radius test
│   │       ├── matcher.ts          # matchProgram
│   │       ├── hash.ts             # hashProgram (pure, deterministic)
│   │       └── index.ts            # barrel: re-exports all of the above
│   ├── server/                     # name: "@grantspotter/server"
│   │   └── src/
│   │       ├── index.ts            # entrypoint: express + scheduler
│   │       ├── db/                 # schema.sql, migrate.ts, repositories/*.ts
│   │       ├── fetcher/            # index.ts, blocklist.ts, robots.ts, hostQueue.ts
│   │       ├── sources/            # registry.ts + one module per funder
│   │       ├── normalize/          # index.ts + per-axis extractors
│   │       ├── diff/               # index.ts
│   │       ├── review/             # index.ts
│   │       ├── federal/            # grantsGov.ts, nsf.ts, adjacency.ts
│   │       ├── prose/              # index.ts  (PURE, no I/O)
│   │       ├── prompts/            # compose.ts
│   │       ├── templates/          # load.ts, fill.ts
│   │       ├── exports/            # csv.ts, xlsx.ts, ics.ts, docx.ts, zip.ts, json.ts
│   │       ├── auth/               # password.ts, session.ts, middleware.ts
│   │       └── api/                # one router file per resource
│   └── web/                        # name: "@grantspotter/web" — React + Vite
│       └── src/
│           ├── main.tsx, App.tsx, api/client.ts, store/
│           ├── routes/             # Browse, Opportunity, Calendar, Watchlist,
│           │                       # Inbox, Profile, Templates, Applications,
│           │                       # Sources, Login, Admin
│           ├── components/
│           └── styles/             # includes print.css
├── content/
│   ├── templates/components/*.md   # funder-agnostic
│   ├── templates/funders/*.md      # funder overlays
│   └── prompts/*.md                # prompt fragments
├── data/
│   ├── seed/*.json                 # curated corpus
│   └── reference/arrl-sections.json
├── fixtures/<sourceId>/*.html|json # committed real payloads for parser tests
└── docs/
```

**Import direction is one-way:** `web → core`, `server → core`. `core` imports nothing of ours.
A test in Plan 1 asserts `packages/core` has zero runtime dependencies beyond `zod` and no
`node:` imports.

## 3. Shared types — `packages/core/src/types.ts`

These names are **frozen**. Plans 2–5 import them; they do not redefine them.

```ts
// ---------- enums ----------
export type LicenseClass = 'NONE' | 'TECH' | 'GENERAL' | 'EXTRA';
export type DegreeLevel = 'CERT' | 'ASSOC' | 'BACH' | 'GRAD';
export type Stage = 'HS_SENIOR' | 'UNDERGRAD' | 'GRAD' | 'VETERAN' | 'RETRAINING_ADULT';
export type Citizenship = 'US_CITIZEN' | 'US_RESIDENT' | 'ANY';
export type ActivityKind = 'club_member' | 'ares_races_skywarn' | 'teaching' | 'on_air' | 'field_day' | 'contesting' | 'public_service';
export type RecommenderType = 'none' | 'arrl_affiliated_club_officer' | 'sponsor_org_member' | 'teacher' | 'any';

export type ApplicantEntity =
  | 'individual' | 'club_unincorporated' | 'club_501c3' | 'club_via_fiscal_sponsor'
  | 'school_lea' | 'university' | 'university_dept' | 'ieee_student_branch_chapter'
  | 'teacher' | 'nominated_by_institution';

export type Instrument =
  | 'cash_range' | 'cash_fixed' | 'cash_tiered_blocks' | 'in_kind_equipment'
  | 'in_kind_service' | 'discounted_purchase' | 'per_member_rebate'
  | 'tuition_coverage' | 'unknown';

export type DeadlineKind =
  | 'n_fixed_dates' | 'n_fixed_windows' | 'annual_window' | 'rolling'
  | 'quarterly_rewritten' | 'ad_hoc' | 'inherited' | 'unpublished'
  | 'no_application_exists' | 'dormant';

export type ApplyVia =
  | 'page_form' | 'external_spa_portal' | 'jotform_year_keyed' | 'self_hosted_portal'
  | 'email_pdf_packet' | 'contact_person' | 'none';

export type ProgramStatus =
  | 'open' | 'closed' | 'dormant' | 'discontinued' | 'contact_only' | 'no_application' | 'unknown';

export type AiStance =
  | 'permitted' | 'permitted_with_disclosure' | 'discouraged' | 'prohibited' | 'unaddressed';

export type VerificationMethod = 'live_fetch' | 'api' | 'manual_curation' | 'seed_import';

export type OpportunityClass = 'ham_grant' | 'ham_scholarship' | 'adjacent_stem' | 'equipment_in_kind';

export type ConstraintAxis =
  | 'license' | 'geography' | 'field_of_study' | 'institution' | 'gpa'
  | 'arrl_membership' | 'recommendation' | 'citizenship' | 'age_stage'
  | 'ham_activity' | 'financial_need' | 'gender' | 'other';

// ---------- geography ----------
export interface GeoSpec {
  type: 'any' | 'state' | 'arrl_division' | 'arrl_section' | 'county' | 'radius' | 'call_district';
  values: string[];              // e.g. ['TX'] | ['Roanoke'] | ['Travis County, TX'] | ['5']
  centerLat?: number;            // radius only
  centerLon?: number;
  radiusMiles?: number;
  centerLabel?: string;          // e.g. 'Seaford, Delaware'
}

// ---------- constraints ----------
export type ConstraintSpec =
  | { axis: 'license'; licenseMin: LicenseClass; heldMonthsMin?: number; foreignLicenseOK?: boolean }
  | { axis: 'geography'; geo: GeoSpec }
  | { axis: 'field_of_study'; fields: string[]; excludedFields: string[] }
  | { axis: 'institution'; degreeLevels: DegreeLevel[]; tradeSchoolOK: boolean; partTimeOK: boolean; accreditationRequired: boolean }
  | { axis: 'gpa'; min?: number; classRankTopPct?: number }
  | { axis: 'arrl_membership'; required: boolean; minYears: number }
  | { axis: 'recommendation'; recommenderType: RecommenderType; count: number }
  | { axis: 'citizenship'; allowed: Citizenship[]; withinMonthsOfCitizenship?: number }
  | { axis: 'age_stage'; ageMin?: number; ageMax?: number; asOf?: string; stages: Stage[] }
  | { axis: 'ham_activity'; activityKinds: ActivityKind[]; cwProficiencyWpmMin?: number; proofRequired: boolean }
  | { axis: 'financial_need'; weighted: true }
  | { axis: 'gender'; allowed: Array<'female' | 'male' | 'any'> }
  | { axis: 'other'; note: string };

export interface Constraint {
  id: string;
  hard: boolean;          // false => ranks, never excludes
  fallbackRank: number;   // 0 = primary preference; higher = later in the cascade
  rawText: string;        // verbatim source text, ALWAYS populated
  spec: ConstraintSpec;
}

// ---------- money ----------
export interface AwardTier { count: number; amount: number }

export interface AmountSpec {
  instrument: Instrument;
  amountMin?: number;
  amountMax?: number;
  tiers?: AwardTier[];        // cash_tiered_blocks only
  amountRaw: string;          // verbatim, ALWAYS populated
  awardCountRaw: string;      // verbatim: '1 per year' | 'Three' | 'Multiple per year' | '19'
}

// ---------- deadlines ----------
export type DeadlineSource = { kind: 'self' } | { kind: 'inherited'; fromProgramId: string };

export interface DeadlineSpec {
  kind: DeadlineKind;
  source: DeadlineSource;
  note: string;   // MAY carry the RECUR: micro-format — see the amendment note below
}

export interface Cycle {
  id: string;
  programId: string;
  opensAt?: string;      // ISO 8601 date or datetime
  closesAt?: string;
  timezone: string;      // IANA, e.g. 'America/New_York'
  label: string;         // e.g. 'Feb 2027 window'
  isEstimated: boolean;  // true when projected from a recurrence rule, not observed
}

// ---------- trust ----------
export interface DisputedClaim { claim: string; sourceUrl: string }
export interface Disputed { claims: DisputedClaim[]; note: string }

export interface TrustFields {
  status: ProgramStatus;
  sourceUrl: string;
  lastVerifiedAt: string;          // ISO 8601
  verificationMethod: VerificationMethod;
  contentHash: string;
  disputed?: Disputed;
  staleMirrorWarning?: string;
}

export interface AiPolicy { stance: AiStance; quote?: string; url?: string }

export interface Obligations {
  licenseObligation?: string;      // ARDC: open-source/open-access requirement
  indirectCostCapPct?: number;     // ARDC: 20
  costShareRequired: boolean;
  coFunderPreference: boolean;
  sustainmentObligation?: string;  // e.g. a funder's own "must stay in service N months"
                                    // term — NOT Yaesu: the captured DR-2X page states no such
                                    // term (any obligation would live only in a linked PDF this
                                    // crawler never downloads; see docs/research/2026-08-02-
                                    // grant-landscape.md §6.6). Leave unset when the funder's
                                    // page states nothing, rather than inferring one.
  reportingObligation?: string;    // YASME: year-end activity report
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
  summary: string;                 // our words or a short excerpt; never a full text dump
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
  rawOtherText: string;            // verbatim long-tail requirements, ALWAYS populated ('' if none)
  tags: string[];
}

// ---------- profiles ----------
export interface StudentProfile {
  kind: 'student';
  callsign?: string;
  licenseClass?: LicenseClass;
  licensedSince?: string;          // ISO date
  state?: string;                  // 2-letter
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
  | { kind: 'eligible_preferred'; rank: number; met: string[] }        // met = Constraint ids
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
  body: string;                    // binary is base64
  fetchedAt: string;
}

export interface RawOpportunity {
  sourceId: string;
  externalKey: string;             // stable per-source identity, e.g. the scholarship name
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
  expectedMinRecords: number;      // drives the parse_yield_dropped alarm
  notes?: string;                  // e.g. why we do NOT use the advertised RSS
}

// ---------- change detection ----------
export type ChangeKind =
  | 'new' | 'deadline_changed' | 'amount_changed' | 'eligibility_changed'
  | 'status_changed' | 'vanished' | 'parse_yield_dropped';

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
  confidence: number;              // 0..1
  rejectKey?: string;              // reject-memory: suppresses identical future candidates
}
```

## 4. Core function signatures (Plan 1 produces, Plans 2–5 consume)

```ts
// amount.ts
export function parseAmount(raw: string): Pick<AmountSpec, 'amountMin' | 'amountMax' | 'tiers'>;

// deadline.ts
export function expandCycles(program: Program, allPrograms: Program[], fromISO: string, toISO: string): Cycle[];
export function resolveDeadlineOwner(program: Program, allPrograms: Program[]): Program;

// geo.ts
export function statesForArrlDivision(division: string): string[];
export function statesForArrlSection(section: string): string[];
export function withinRadius(lat: number, lon: number, geo: GeoSpec): boolean;

// matcher.ts  — nowISO is additive and optional; age and licence-holding checks need a clock
export function matchProgram(profile: Profile, program: Program, nowISO?: string): Verdict;
export function matchAll(profile: Profile, programs: Program[], nowISO?: string): Map<string, Verdict>;

// hash.ts
export function hashProgram(p: Program): string;   // SHA-256 over normalized fields, EXCLUDING TrustFields
```

`hashProgram` excluding `TrustFields` is load-bearing: `lastVerifiedAt` changes on every crawl,
so including it would mark every record changed every night.

## 5. Server module signatures

```ts
// fetcher/index.ts
export interface FetchOptions { userAgent: string; contactUrl: string; timeoutMs?: number }
export function createFetcher(opts: FetchOptions): Fetcher;
export interface Fetcher { fetch(req: FetchRequest): Promise<FetchedPayload> }
// fetcher/blocklist.ts
export const BLOCKED_HOSTS: readonly string[];
export function assertNotBlocked(url: string): void;   // throws BlockedHostError

// diff/index.ts
export function diffPrograms(previous: Program[], next: Program[], sourceId: string, nowISO: string): ChangeEvent[];

// federal/adjacency.ts
export function scoreAdjacency(text: string): { score: number; hits: string[] };

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

## 6. Database

SQLite via `better-sqlite3`, WAL. Plain `.sql` migrations in `packages/server/src/db/migrations/NNN-*.sql`,
applied in order by `migrate.ts`. No ORM.

Tables: `funders` · `programs` · `constraints` · `cycles` · `sources` · `snapshots` ·
`change_events` · `review_items` · `users` · `sessions` · `profiles` · `watches` ·
`applications` · `template_instances` · `audit_log` · `review_rejects` (Plan 2) ·
`ics_tokens` (Plan 5)

`programs` additionally carries `source_id TEXT` and `external_key TEXT` with a partial unique
index on `(source_id, external_key)`. These exist so the nightly crawler resolves an existing
seeded record instead of minting a fresh id and duplicating the entire corpus every night
(RESOLUTIONS R9). `review_items` stores its candidate in `candidate_json`.

JSON-shaped fields (`constraints.spec`, `programs.amount`, `programs.obligations`) are stored
as TEXT containing JSON and validated through the zod schemas in `core/schema.ts` on read.

## 7. Environment variables

| Var | Required | Default | Notes |
|---|---|---|---|
| `HOST_PORT` | no | `3030` | compose host port only |
| `PORT` | no | `3030` | in-container listen port |
| `SESSION_SECRET` | **yes** | none | server refuses to start without it |
| `CONTACT_URL` | **yes** | none | goes in the crawler User-Agent |
| `DATA_DIR` | no | `/data` | sqlite + snapshots |
| `CRAWL_ENABLED` | no | `true` | |
| `CRAWL_CRON` | no | `17 3 * * *` | nightly, jittered in code |
| `ANTHROPIC_API_KEY` | no | none | optional parse assist only |
| `SIMPLER_GRANTS_API_KEY` | no | none | optional |

`SESSION_SECRET` having no default is deliberate — same rule as ham-net-assistant's `JWT_SECRET`.

**Amended 2026-08-04.** `CONTACT_URL` is no longer required: it defaults to
`https://github.com/Atvriders/grantspotter/issues`, so a self-hoster does not have to invent a
contact page to start the server. The guard on an explicit value is unchanged (a `CHANGE_ME` value
or a reserved documentation domain is still refused). The row above is left as written because
these five plans were implemented against it; the live documentation is README → Environment,
which also records what the default does not buy.

**Amended again 2026-08-04, same day, after two verifiers went at the change above.** The guard was
being skipped: `scripts/verify-sources.ts` and `scripts/capture-fixture.ts` read
`process.env.CONTACT_URL` directly and never called `loadConfig`, so every value it refuses went
onto the wire of a live nonprofit site from those two commands. There is now one predicate,
`assertUsableContactUrl` in `server/src/config.ts`, reached from `loadConfig`, from
`resolveContactUrl` (which both scripts use), from `buildUserAgent`, and from `createFetcher`,
which refuses a User-Agent that `buildUserAgent` did not produce from the contact URL beside it.
`packages/server/test/contactUrlEntryPointContract.test.ts` fails if a new entry point skips it.
Two rules were added to the predicate in the same pass: a contact URL must be printable ASCII
(`new URL()` deletes tabs and line breaks from anywhere in its input, so the value validated and
the value sent were not the same string), and it must not be an address that cannot be reached from
the public internet (loopback, RFC 1918, link-local, carrier NAT, single-label names, `.local` /
`.internal` / `.home.arpa`, and the RFC 5737 / RFC 3849 documentation ranges) — which is what the
reserved-name rule always claimed to be enforcing.

## 8. npm scripts (root)

```
npm run typecheck      type-check every workspace, no emit          (Plan 1)
npm run build          core → server → web                          (Plan 1)
npm test               vitest run (all workspaces)                  (Plan 1)
npm run test:e2e       playwright test                              (Plan 3 adds)
npm run verify-sources tsx scripts/verify-sources.ts                (Plan 2 adds)
                       # LIVE, warn-only, NEVER a CI gate
npm run dev            concurrent server + vite                     (Plan 1)
npm run capture-fixture tsx scripts/capture-fixture.ts              (Plan 2, dev-only)
npm run seed:arrl      tsx scripts/generate-arrl-seed.ts            (Plan 5, dev-only)
```

`typecheck` is **not** literally `tsc -b --noEmit` — that fails on this host with TS6310
("Referenced project may not disable emit"). Plan 1 keeps the script name and effect and
implements it over a non-composite root project. `capture-fixture` and `seed:arrl` are
developer-only and never part of `build`, `test`, or CI.

## 9. Conventions

- **TDD**: failing test → run it → minimal implementation → run it → commit.
- **Commits stay local.** No push until after the completeness audit and debug audit at the end
  of Plan 5. Conventional-commit prefixes (`feat:`, `fix:`, `test:`, `chore:`).
- **No real LAN IPs, hostnames, or host paths** anywhere — placeholders and RFC 5737
  (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`) only. This includes fixtures and seed data.
- **Fixtures are committed real payloads.** Parser tests never hit the network.
- Every user-facing date renders with its `lastVerifiedAt` provenance; no bare dates.
- Copy rule: the AI prompt button reads exactly
  **`Copy AI Prompt — includes AI-detection avoidance`**.

## 10. Amendments (2026-08-02, post-audit)

Recorded after the spec-coverage and type-consistency audits. See
[`RESOLUTIONS.md`](./RESOLUTIONS.md) for the full decision record.

1. **`DeadlineSpec.note` may carry a `RECUR:` micro-format.** §3 freezes `DeadlineSpec` as
   `{kind, source, note}` with no recurrence parameters, so Plan 1 Task 5 defines a `RECUR:`
   grammar carried in `note` and `parseRecurrence` reads it. This is blessed rather than
   changed, because adding a field would churn Plan 1's schema, Plan 2's emitters, and Plan 5's
   seed. **Plans 2 and 5 must actually emit it** for ARDC, ARRL Amateur Radio Grants, and ARRL
   Foundation Scholarships — otherwise `expandCycles` returns nothing and the calendar is
   silently empty for the three most important programs in the corpus.
2. **`matchProgram`/`matchAll` take an optional trailing `nowISO`.** Additive; existing call
   shapes still typecheck.
3. **`AppDeps` gains `mountRoutes?: (app: Express) => void`**, invoked immediately before
   `notFoundHandler()`. Every router from Plans 3–5 mounts through it. Calling `app.use(...)`
   after `createApp` returns is forbidden — the app is sealed by its 404 handler.
4. **One error envelope**, Plan 1's: `{ error: { code, message, details? }, requestId }`,
   422 for zod failures. No plan invents a second.
5. **Repositories are factories** (`createProgramRepo(db)`, …), zod schemas are lower-camel
   (`programSchema`, …), and `buildUserAgent` is defined once, in `server/src/config.ts`.
6. **`packages/web`'s scaffold and typed API client belong to Plan 1 Task 18.** Plan 3 modifies
   those files; it never re-creates them.
7. **`Obligations.costShareRequired` and `Obligations.coFunderPreference` are OPTIONAL, and their
   absence means UNSTATED.** §3 declared both as non-optional `boolean`, so `normalize/index.ts`
   had to open every record with `costShareRequired: false, coFunderPreference: false` — and 148
   of the 150 publishable records therefore published the positive claim *"this funder does not
   require cost sharing"*, which no funder had made. Three states are now distinguished and must
   be kept distinct by every consumer: `true` (the funder requires it), `false` (the funder said
   it is **not** required — a real answer, worth publishing), and **absent** (no page we fetched
   addressed it). **Absent must never render as "not required" anywhere downstream**, in Plan 3's
   detail view or anywhere else: a blank prompts an applicant to check, and a false negative does
   not. Read them through `obligationState(value): 'yes' | 'no' | 'unstated'` (exported from
   `@grantspotter/core`), never as a bare boolean — `x ? … : 'not required'` collapses the third
   state and does not look wrong at the call site. This is the same silence-as-assertion class as
   `licenseMin` defaulting to `'NONE'` past a matcher that skips the licence check at `NONE`,
   `partTimeOK` defaulting to `false`, and `ENTITIES_BY_SOURCE[…] ?? []` meaning "accepts nobody";
   it surfaced because Grants.gov's NTIA PWSCIF capture carries `"costSharing":true` while the
   product published `false`.
