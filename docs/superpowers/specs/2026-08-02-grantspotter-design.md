# GrantSpotter — Design

**Date:** 2026-08-02
**Status:** Approved (design); implementation plan to follow
**Research backing:** [`docs/research/2026-08-02-grant-landscape.md`](../../research/2026-08-02-grant-landscape.md) — 6 parallel research passes, ~380 live fetches, 2026-08-02

---

## 1. Purpose

A self-hosted funding desk for collegiate and educational amateur radio. It answers four questions for a club officer, faculty advisor, or student:

1. What funding exists that I am actually eligible for?
2. When is it due, and when must I start?
3. What do I write, and what does this specific funder care about?
4. Has anything changed since I last looked?

### 1.1 The product thesis

The addressable corpus is roughly **150 records**, about **75% of which come from a single ARRL page**. Exactly **one** ham-relevant source (ARDC) exposes a real API. Federal APIs are excellent and nearly ham-free — `"amateur radio"` returns 57 Grants.gov hits; `"cubesat"` returns 1.

Therefore: **GrantSpotter is a curated database with a change-detection layer and an eligibility matcher, not a spider.** Every architectural decision below follows from that sentence. Building a general-purpose crawler here would consume the engineering budget and return noise.

### 1.2 Non-goals

- Not a general grant search engine. No attempt to cover non-ham, non-education funding beyond a targeted federal adjacency sweep.
- Not a submission portal. Every funder's intake is their own (Kaleidoscope, Jotform, email-a-PDF); GrantSpotter deep-links out and never proxies a submission.
- Not an AI writing service. The server does not draft narratives. It composes prompts the user runs in their own assistant, and optionally uses an LLM for parsing assistance only (§9).
- Not a mirror of commercial aggregators. See §7.2.

---

## 2. Scope

Four opportunity classes, all first-class:

| Class | Examples | Applicant |
|---|---|---|
| **Ham grants** | ARDC Grants Program, ARRL Amateur Radio Grants, ARRL Club Grant, ARRL ETP, NCDXF, SARA | organization |
| **Ham scholarships** | ARRL Foundation catalog (111 entries / 170+ awards), ARDC Scholarships (45 awards), QCWA, YLRL, DARA, Six Meter Club of Chicago | individual |
| **Adjacent STEM/RF** | Grants.gov federal sweep (NSF geospace/ECCS/ATE/Noyce, NASA MUREP, NTIA PWSCIF), NASA Space Grant, IEEE MTT-S | mixed |
| **Equipment & in-kind** | Yaesu DR-2X repeater program, ARISS ISS contact, NASA CSLI launch services, SARA kits, RCA Youth Activities | mixed |

### 2.1 Verified negatives — do not build UI categories around these

Confirmed non-existent or non-applicable by live fetch. Recorded in the seed data as explicit negative entries so a future maintainer does not re-research them:

- **ARRL CARI** is not a funding program — it is meetups, a QSO party, and Hamvention networking.
- **AMSAT** has no grants program; it is a grant *recipient*.
- **FlexRadio** has no education/student/club/nonprofit purchasing tier.
- **Icom America, DX Engineering, Kenwood** give real equipment to collegiate clubs but have **no application path, no page, no deadline** — relationship-driven only. Shipped as a playbook, not an opportunity.
- **DARA/Hamvention** is a grantmaker only via its ARRL catalog entry; its own sites have no scholarship page.
- **Chicago FM Club Scholarship** is discontinued (0 hits in the live ARRL catalog), yet still listed by 7+ third-party aggregators — proof they mirror stale data.

### 2.2 Safety finding — FAR / farweb.org

The Foundation for Amateur Radio's domain **301s to `batualam.org`, an Indonesian gambling site** (`<title>TARGET88…</title>`). Wayback pins the takeover between 2025-10-17 and 2026-02-10. QCWA, ARRL, and club pages still instruct applicants to "apply at the FAR website."

`farweb.org` is **hard-blocklisted in the fetcher layer** (§7.3), and the seed data carries an explicit warning record so a user who searches "FAR" is told what happened rather than being sent there. FAR's historical portfolio (10-10, QCWA, YASME, K3IVO, CARA) appears absorbed into the ARRL Foundation.

---

## 3. Architecture

Single Node process serving the API and the built SPA, with an in-process scheduler for the nightly crawl. SQLite (WAL) for storage. One multi-arch container image.

**Stack:** TypeScript (strict) · React 18 + Vite · Express · better-sqlite3 · Vitest · Playwright

### 3.1 Module boundaries

Each module has one purpose, a defined interface, and is testable alone.

| Module | Purpose | Depends on |
|---|---|---|
| `core/` | Domain types, eligibility matcher, deadline resolution, amount parsing. **Pure — zero I/O.** This is the executable spec | — |
| `server/fetcher/` | The **only** network egress path. Per-host serialization, robots.txt + `Crawl-delay`, hard domain blocklist, descriptive UA, exponential backoff, snapshot storage | — |
| `server/sources/*` | ~25 modules, one per funder. Each exports `{ id, funderId, fetchPlan, parse(payload) → RawOpportunity[] }` | `fetcher` types only |
| `server/normalize/` | `RawOpportunity` → `Opportunity`. Amount/deadline/eligibility extraction | `core` |
| `server/diff/` | Content-hash parsed entries, classify change events, emit `ReviewItem`s | `core` |
| `server/review/` | Inbox: approve / reject / edit, reject-memory, provenance trail | `diff` |
| `server/federal/` | Grants.gov `search2` + `fetchOpportunity`, NSF RSS, adjacency scorer | `fetcher` |
| `server/prose/` | Offline generic-prose analyzer (§10.3). Pure, zero I/O | — |
| `server/auth/` | Local accounts, argon2id, sessions, roles | — |
| `server/api/` | REST surface | all |
| `web/` | React SPA | `api` |
| `content/templates/`, `content/prompts/` | Templates and prompt fragments as versioned markdown + frontmatter **data**, not code | — |
| `data/seed/` | Curated corpus as JSON, with provenance | — |

**Rule:** `sources/*` modules never import each other and never touch the database. They are pure functions from a fetched payload to raw records. This is what makes 25 parsers testable against saved fixtures with no network.

### 3.2 Data flow

```
scheduler (nightly)
  → fetcher (polite, per-host serial, blocklist-enforced)
  → sources/<id>.parse()          → RawOpportunity[]
  → normalize                     → Opportunity (candidate)
  → diff vs. last approved state  → ChangeEvent[]
  → review queue (Inbox)
  → [human approve/edit/reject]
  → published corpus
  → matcher / calendar / watchlist / exports
```

Federal sweep enters at the same review-queue step; nothing from it publishes unreviewed.

---

## 4. Data model

### 4.1 Entities

`Funder` · `Program` · `Cycle` (a concrete dated deadline instance) · `Constraint` · `Source` · `Snapshot` · `ChangeEvent` · `ReviewItem` · `User` · `Profile` · `Watch` · `Application` · `TemplateInstance` · `AuditLog`

### 4.2 The four shape-conflicts — first-class, never special-cased

Sources are genuinely incompatible along four axes. Modeling any of them as a scalar guarantees rework.

**Applicant entity** (`applicantEntities[]`)
`individual` · `club_unincorporated` · `club_501c3` · `club_via_fiscal_sponsor` (ARDC's requirement for clubs and individuals) · `school_lea` · `university` · `university_dept` · `ieee_student_branch_chapter` · `teacher` · `nominated_by_institution` (RCA — the university selects; the student never applies)

**Award instrument** (`instrument`)
`cash_range` · `cash_fixed` · `cash_tiered_blocks` (ARDC scholarships: 20×$25k, 4×$15k, 17×$10k, 4×$5k) · `in_kind_equipment` (ETP, SARA kits, RCA Youth) · `in_kind_service` (ARISS ISS contact, NASA CSLI launch) · `discounted_purchase` (Yaesu DR-2X, $1,450 / $1,860) · `per_member_rebate` (IEEE: $50–100 + $2/member) · `tuition_coverage` (NCDXF W6EEN) · `unknown`

**Deadline** (`Cycle` + `deadlineSource`)
`n_fixed_dates` (ARDC ×4: Feb 1, Apr 1, Jul 1, Sep 1) · `n_fixed_windows` (ARRL Amateur Radio Grants ×3: Feb 1–28, Jun 1–30, Oct 1–31) · `annual_window` (ARRL scholarships: opens ~Oct 30, closes ~Dec 30 12:00 EST) · `rolling` (NCDXF, SARA) · `quarterly_rewritten` (ARISS) · `ad_hoc` (Yaesu) · `inherited` · `unpublished` · `no_application_exists` (Yasme) · `dormant`

**Apply-via** (`applyVia`)
`page_form` · `external_spa_portal` (Kaleidoscope, grants.ardc.net, Salesforce — all return zero server-side text) · `jotform_year_keyed` · `self_hosted_portal` · `email_pdf_packet` (NCDXF, SARA) · `contact_person` · `none`

### 4.3 Two decisions that break the matcher if skipped

**Every `Constraint` carries `hard: boolean` and `fallbackRank: number`.**
Nearly every eligibility axis appears in both requirement and preference form, frequently as an explicit cascade: *"Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, …"*. Treating that as a hard filter wrongly excludes eligible students. `fallbackRank` orders the cascade.

**`deadlineSource: 'self' | { inheritedFrom: programId }`.**
All 111 ARRL scholarship catalog entries share one deadline. Without inheritance you write 111 empty date fields, and QCWA's real deadline — which lives inside ARRL's cycle — disappears.

### 4.4 Amounts and counts

- `amountMin`, `amountMax`, `amountRaw` (verbatim). A naive max-regex is wrong: one catalog entry contains **$100,000**, which is an *endowment* figure, not an award.
- `awardCountRaw` is a string. Real values include `"1 per year"`, `"Three"`, `"Multiple per year"`, `"19"`. `entryCount ≠ awardCount` — 111 catalog entries yield 170+ awards.
- Grants.gov `awardCeiling`/`awardFloor` are frequently the literal string `"none"`.

### 4.5 Eligibility axes

Derived from all 111 ARRL entries plus non-ARRL programs. Label frequency across the catalog: Field of Study 111 · License Requirement 110 · Region 109 · Institution 107 · Award Amount 101 · Number of Awards 100 · Other 65 · Age 4.

1. **License** — `licenseMin: NONE|TECH|GENERAL|EXTRA`, `licenseHeldMonthsMin`, `foreignLicenseOK`, `licenseIsPreference`
2. **Geography** — five incompatible shapes: `{ type: any|state|arrl_division|arrl_section|county|radius|call_district, values[], centerLatLon?, radiusMiles? }`. Radius examples are real: *"within 250 miles of Seaford, Delaware"*, *"within 70 miles of Schenectady, NY"*, *"within 175 miles of Erving, MA"*. **Ships with an ARRL Division/Section ↔ state lookup table as data.**
3. **Field of study** — `fields[]` + `excludedFields[]` (one entry reads *"Any, except for Liberal Arts"*)
4. **Institution / degree level** — `degreeLevels: [CERT|ASSOC|BACH|GRAD]`, `tradeSchoolOK`, `partTimeOK`, `accreditationRequired`
5. **GPA / standing** — hard floors (2.5, 3.0, 3.2) *and* soft preferences (ARDC: "preference … over 3.5"); non-GPA proxies like class rank (YASME: top 5–10%)
6. **ARRL membership** — two intensities: member, member ≥1 year
7. **Sponsor / recommendation** — `recommenderType`, `recommendationCount` (ARDC needs 3; QCWA needs an active QCWA member; Goldwater needs a sitting club officer)
8. **Citizenship** — `US_CITIZEN | US_RESIDENT | ANY`, plus "or within three months of citizenship"
9. **Age / stage** — explicit ages (17–25; YCCC "22 or younger as of June 1") and `stages: [HS_SENIOR|UNDERGRAD|GRAD|VETERAN|RETRAINING_ADULT]`
10. **Demonstrated ham activity** — `activityKinds[]` (club, ARES/RACES/SKYWARN, teaching, on-air, Field Day), `cwProficiencyWpmMin` (CWops: ≥15 wpm within 24 months)
11. **Financial need** — always a weighting, never a bar
12. **Gender** — YLRL only
13. **`rawOtherText`, preserved verbatim, always.** No schema captures *"preference to a student ham from a ham family"*, learning-disability documentation, or at-risk-youth turnaround letters.

### 4.6 Obligation and restriction fields

`fundingRestrictions[]` (ARRL: no emcomm equipment, no ongoing operating expenses) · `licenseObligation` (ARDC: **all output must be open-source/open-access** — GPL/MIT/BSD/CERN-OHL/CC) · `indirectCostCapPct` (ARDC 20%) · `costShareRequired` · `coFunderPreference` (ARRL prefers not to be sole funder) · `sustainmentObligation` (Yaesu: repeater on-air 12 months) · `reportingObligation` (YASME: year-end activity report)

### 4.7 Trust fields

`status: open|closed|dormant|discontinued|contact_only|no_application|unknown` · `sourceUrl` · `lastVerifiedAt` · `verificationMethod` · `contentHash` · `disputed: { claims[], sources[] }` · `aiPolicy: { stance, quote, url }`

---

## 5. Eligibility matcher

Pure function: `match(profile, program) → Verdict`.

```
Verdict =
  | { kind: 'eligible' }
  | { kind: 'eligible_preferred', rank }
  | { kind: 'ineligible', reasons: Constraint[] }
  | { kind: 'unknown', missingProfileFields: string[] }
```

Design rules:

- **Soft constraints never exclude.** They rank. A `fallbackRank` cascade is applied only after hard filters pass.
- **Missing profile data yields `unknown`, not `ineligible`.** The UI asks for the one field that would resolve it.
- **The matcher explains itself.** "You are ineligible for 41 of these, and here is the specific constraint for each" is the feature that makes this a professional tool rather than a list.
- A `Profile` is either a **student profile** or a **club/org profile**; both may exist per user, and programs are matched against whichever entity types they accept.

---

## 6. Change detection

Nightly, never hourly — nothing in this corpus changes faster than weekly, and most sources change 3–4 times a year.

**Hash the parsed entries, not the raw HTML.** arrl.org serves `Cache-Control: nocache` with **no ETag and no Last-Modified**, and every `<lastmod>` in its sitemap is frozen at 2010 — actively misleading. Nav and footer churn would false-positive forever against raw-HTML hashing.

Change classes emitted as `ChangeEvent`: `new` · `deadline_changed` · `amount_changed` · `eligibility_changed` · `status_changed` · `vanished` · `parse_yield_dropped`.

`parse_yield_dropped` is a first-class alarm. A parser that silently starts returning zero records is the most likely way this app rots.

**An empty scrape is not a failure.** `grants.austinhams.org` legitimately shows "No opportunities available" between Aug 1 and Apr 30.

---

## 7. Crawl behavior and the legal perimeter

### 7.1 Polite crawling

1. Per-host serialization. Never parallelize within a host.
2. Honor robots.txt, including `Crawl-delay: 5` on arrl.org.
3. Descriptive User-Agent naming the app with a contact URL.
4. Exponential backoff. No rate limits are published for Grants.gov, NSF, or USAspending, but absence of documentation is not absence of limits.
5. Nightly cadence, jittered.

### 7.2 Hard blocklist — enforced in the fetcher, not in config

| Domain | Reason |
|---|---|
| `farweb.org` | Compromised — redirects to a gambling site (§2.2) |
| `candid.org`, `fconline.foundationcenter.org` | License prohibits republishing and prohibits use for "artificial intelligence, large language models, machine learning, or similar applications" — **and that restriction survives termination** |
| `grantwatch.com` | "Automated access, including scripts, bots, or data scraping tools, is prohibited"; "We do not offer or authorize any API access" |
| `grantstation.com` | EULA bans robots/spiders and use for training large language models |
| `instrumentl.com` | ToS bans crawling; **robots.txt explicitly names `anthropic-ai`, `ClaudeBot`, `Claude-Web`** and disallows `/grants`, `/foundations`, `/990-report` |

We deep-link out to the commercial aggregators where they are genuinely useful to a human. We never store their text.

### 7.3 Sites that block non-browser clients — we do not spoof

`yasme.org` (feed/wp-json → 403), `ncdxf.org` (robots.txt and sitemap both 403), `radioclubofamerica.org` (ClubExpress, sitemap 403), `mga.ieee.org` (HTTP 418 to bots), `k9ona.com` (403).

Each is worth 1–2 records that a human curates in five minutes and re-verifies quarterly. UA-spoofing to defeat a deliberate access policy turns a clean project into an argument. These are `Tier D` manual records.

### 7.4 Known trap

All four advertised Grants.gov RSS feeds return **HTTP 200 with `text/html`** (a ~27 KB SPA shell), not XML. A naive poller finds zero items forever and never errors. We use `search2` and the daily XML extract instead, and the source registry carries a comment saying why.

### 7.5 Data sources by tier

- **Tier A — real APIs (key-free):** `POST api.grants.gov/v1/api/search2`, `fetchOpportunity`, the daily `GrantsDBExtract{YYYYMMDD}v2.zip`, ARDC's `wp-json/wp/v2/pages` (`modified_after` confirmed working — resolve the parent page ID at runtime, never hardcode), `api.nsf.gov/services/v1/awards.json` (`printFields` works despite docs; `rpp` capped at 25), USAspending v2.
- **Tier B — RSS change triggers:** `arrl.org/news/rss` is the single most important change signal in the ham space (~10–20 actionable deadline events/yr) and also relays Yasme announcements. Plus three NSF funding feeds.
- **Tier C — stable server-rendered HTML (~130–150 records):** headlined by `arrl.org/scholarship-descriptions` — 4 accordions, `ul.accordion > li`, 114 `li` minus 3 stubs = **111 real entries**. **Parse by label regex over flattened text, never by DOM shape** — body markup is inconsistent, includes invalid HTML (`<ul>` opened inside `<p>`), `\xa0`, and typo'd labels observed in the wild (`R egion`, `License   Requirement`, `Scholarshp`).
- **Tier D — manual curation:** Yasme, RCA, NCDXF Youth, NASA Space Grant's 52 consortia, campus SGA.

`Simpler.Grants.gov` requires a free Login.gov key. It is **optional and never a hard dependency** — better ranking if the user supplies a key, absent otherwise.

---

## 8. Honesty surfaces

The primary product failure mode is a confidently-displayed wrong deadline. An app that shows a wrong date is worse than no app. Countermeasures are UI-visible, not internal:

- **`lastVerifiedAt` badge on every record.** Older than 90 days renders amber "unverified," with a one-click **Verify now** that refetches and shows the diff.
- **`status: unknown` is a rendered state**, never a blank field.
- **Field-level provenance** — which source, which fetch, and the raw text the value came from.
- **`disputed` flag.** Ships populated: the **ARRL Club Grant cycle**, where three researchers reached three different conclusions (dormant / spring window / Feb-Jun-Oct, the last probably conflating it with the separate Amateur Radio Grants cycle). The record shows every reading with its source instead of picking one.
- **Sources health page** — last poll, last success, parse yield vs. baseline, consecutive failures.
- **Stale-mirror warning.** Where a third-party aggregator is known to list a discontinued program (e.g. Chicago FM Club), the record says so.

---

## 9. AI usage policy inside the app

**Key finding: no funder found prohibits applicants from using AI.** Policies are far stricter on reviewers than applicants. Applicant rules are disclosure-encouragement plus an originality/misconduct backstop.

| Funder | Applicant stance |
|---|---|
| **ARDC** | Permitted with a diagnosis: *"If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy. If the proposal is extremely long and hard to understand, we can't evaluate or support it."* The concern is **bloat**, not ethics |
| **NSF** | *"Proposers are encouraged to indicate in the project description the extent to which, if any, generative AI technology was used."* |
| **NIH** | Will not consider applications "substantially developed by AI" to be the applicant's original ideas. No disclosure field exists; the hook is originality + research misconduct |
| **Spencer Foundation** | Permitted, **disclosure mandatory**; may not submit verbatim AI drafts |
| **Wenner-Gren** | Not prohibited; responsibility for originality and accuracy rests entirely with the applicant |
| **ARRL Foundation** | **Unaddressed** — zero mentions of AI in the Club Grant page or the Grant Application Form PDF |

`aiPolicy` is a populated per-program field, shown next to the prompt button with the quote and the source URL.

**Server-side AI is optional.** With no key, everything works: deterministic parsers, rule-based scoring, and the copy-prompt flow. If `ANTHROPIC_API_KEY` is present, the crawler additionally uses it to parse messy pages and pre-score review-queue items. It is never required, never on the read path, and never drafts a narrative.

---

## 10. Application writing tools

### 10.1 Templates

**Layer 1 — components (funder-agnostic).** Need statement · project description · measurable outcomes · activities & timeline · budget + justification · sustainability · evaluation plan · organizational capacity · letter of inquiry · scholarship personal essay · recommendation-request email · thank-you letter · interim/final report.

**Layer 2 — funder overlays**, written against each funder's actual published criteria:

- **ARDC** — including the two requirements applicants miss: all output must be open-source/open-access, and indirect costs are capped at 20%. Plus the brevity mandate.
- **ARRL Amateur Radio Grants** — no emcomm equipment, no ongoing operating expenses, co-funding preferred, generally ≤$3,000 (up to $5,000 in 2026, "Year of the Club").
- **ARRL Club Grant** ($1,000–$25,000; 2024: $500,502 to 37 of 110 applicants).
- **ARRL Foundation Scholarship** (single application across the catalog).
- **ARISS proposal**, **IEEE MTT-S Chapter Support** (needs ≥5 members, vTools officer roster, ≥2 reported meetings), **Yaesu DR-2X** (12-month on-air obligation).
- **Campus SGA playbook** — including the trap FSU's published rules expose: *capital equipment is frequently barred by student-activity-fee rules, so radios must be framed as programming or funded externally.* Per the research, this framing advice may be worth more than the entire opportunity index.
- **NASA State Space Grant** — a 52-consortium picker keyed to the user's state, because there is no national deadline.

Templates are markdown with frontmatter and typed slots (`{{club.callsign}}`, `{{project.budgetTotal}}`), filled from the user's Profile where known. Unknown slots render as explicit `[TODO: …]` and **never** as plausible filler.

### 10.2 AI prompt composer

Button label: **"Copy AI Prompt — includes AI-detection avoidance"**, with a subtitle enumerating what is included.

The prompt is assembled per-opportunity from: the funder's real criteria, restrictions, and obligations; the funder's quoted AI policy with URL; the user's profile facts; and the style ruleset below.

**Grounding.** Kobak et al., *Science Advances* 2025 (DOI 10.1126/sciadv.adt3813) analyzed >15M PubMed abstracts and found 379 excess-vocabulary words in 2024. The load-bearing finding is not the word list but the grammar of the shift: 2024's excess vocabulary was **66% verbs and 14% adjectives** — style words — whereas Covid-era excess vocabulary was **79% nouns** — content words.

> A real event changes the **nouns** in your prose. An LLM changes the **verbs and adjectives.**

The signal is style-word density *without referential counterweight* — not any individual word. The ruleset therefore is **not a blacklist**:

**Negative rules**
- Stock transitions banned outright: Furthermore, Moreover, Additionally, It is important to note that.
- Stock openers and closers banned: "In today's rapidly evolving landscape", "ensuring long-term impact for years to come".
- ≤1 trailing participial clause per paragraph (*", ensuring that…"*, *", allowing us to…"*, *", thereby fostering…"*).
- ≤1 tricolon per document (*"educate, empower, and inspire"*).
- Enforced sentence-length variance.

**Positive rules**
- Every sentence in activities/methods takes a **named human or named organization** as its grammatical subject. *"Three of our members will teach a Saturday class"*, not *"The implementation of an educational outreach initiative"*.
- Force proper nouns: callsigns (W8UM, K5UTD), club names, model numbers (IC-7610, DR-2X), place names, named people with roles. A paragraph with zero proper nouns is flagged.
- Force numbers and dates. Every claim of scale needs a figure.
- The adjective-deletion test: delete every adjective and adverb; if the paragraph still says what will happen, it is specific. If it collapses, it is tone.
- **Interview before drafting.** The model must ask for specifics — who does the work, what breaks today, what changes, what the money buys line by line — before producing prose. Missing answers become `[TODO: …]`.
- **Never generate a citation, statistic, or URL the user did not supply.** Highest-consequence rule: fabricated references are precisely the misconduct pattern NIH/ORI enumerate.
- A dedicated brevity pass, because ARDC's stated concern is length.

**Deliberately excluded:** synonym-swapping, injected typos, invisible characters, and other classifier-gaming tricks. They degrade prose, and a reviewer notices bad writing faster than a classifier notices AI. The prompt achieves its stated goal by making the writing genuinely specific.

**Companion:** an editable **AI-use disclosure sentence**, default on. NSF, Spencer, and Wenner-Gren all affirmatively welcome it; it costs nothing.

### 10.3 Generic-prose check (offline)

Paste a draft, get a local heuristic report with no API key:

- Style-word density vs. proper-noun/number density, per paragraph
- Stock transition and stock opener/closer hits, located
- Tricolon count, trailing-participial-clause count
- Sentence-length variance
- Paragraphs containing zero proper nouns and zero figures

It reports *why* a passage reads generic and where, rather than emitting a score. Implemented in `server/prose/` as a pure module.

### 10.4 Fact checklist

Every policy reviewed makes the human applicant — never the tool — accountable for every number, claim, and citation. Before an application draft can be exported, GrantSpotter surfaces a **checklist of every factual assertion it detected** (figures, dates, names, citations, URLs) for explicit human confirmation.

---

## 11. Calendar, watchlist, exports

### 11.1 Calendar

Month and agenda views over concrete dated `Cycle` instances. Colored by instrument and applicant entity. Includes a **prep-lead-time overlay** — ARDC evaluates for 60–120 days; NCDXF asks for ~2 months' lead — so the calendar shows when to *start*, not only when it is due.

### 11.2 Watchlist

Starring a program subscribes the user to **change events**, not just its deadline. Given that stale deadlines are the primary failure mode, *"ARRL moved the scholarship close from Jan 31 to Dec 30"* is the most valuable notification the app can produce.

Delivery: in-app digest by default; optional webhook/ntfy; SMTP optional and never required.

### 11.3 Exports

| Export | Format | Notes |
|---|---|---|
| Filtered opportunity list | CSV, XLSX | any view, current filters |
| Deadlines | subscribable **ICS feed** (per-user token URL) + one-off `.ics` | feed is the useful one |
| Application draft | DOCX, Markdown | DOCX via the `docx` library — no Office dependency |
| Opportunity brief | PDF | via a designed `@media print` stylesheet + "Print / Save as PDF". No headless Chromium in the image |
| Application packet | ZIP | draft + budget worksheet + requirements checklist + source links |
| Full backup | JSON | admin only; restoreable; portability guarantee |
| Eligibility report | CSV, PDF | "here is what I am eligible for and why not for the rest". PDF via the same print path |

---

## 12. Accounts

Local accounts with argon2id password hashing and httpOnly session cookies.

| Capability | admin | member |
|---|---|---|
| Browse, match, calendar, watchlist, applications, exports | ✅ | ✅ |
| **Verify now** on a single record | ✅ | ✅ (rate-limited per user) |
| Review queue (Inbox): approve / reject / edit | ✅ | read-only |
| Source configuration, crawl trigger, sources health | ✅ | read-only |
| User management, full JSON backup/restore | ✅ | ❌ |

Members see the Inbox read-only deliberately: knowing that a deadline change is *pending review* is useful, and hiding it invites the "why is this list wrong" complaint the trust surfaces exist to prevent.

First-run admin bootstrap via a one-time token printed to the container log. No public signup by default. Login is rate-limited. Per-user data: profiles, watchlists, application drafts, ICS token.

---

## 13. Seed corpus

The repository ships `data/seed/*.json` — approximately 150 records curated from the 2026-08-02 research pass, so day one is useful rather than empty.

- **Structured facts only**: funder, program, amounts, deadlines, eligibility axes, obligations, source URL, `lastVerifiedAt: 2026-08-02`, `verificationMethod`, provenance.
- **Short excerpts only, never full text dumps.** Facts are not copyrightable; long verbatim descriptions are a different matter.
- Includes the **verified-negative** records from §2.1 and the **FAR warning** record from §2.2.
- Every seed record enters the normal trust pipeline: it ages, it can go amber, and **Verify now** refetches it.

---

## 14. Testing

- **`core/` and `normalize/` are pure** and get heavy unit coverage — the matcher's constraint cascade, deadline inheritance, amount parsing (including the $100,000-endowment trap), and every geography shape.
- **Every source parser is tested against committed HTML/JSON fixtures** — real saved payloads. All 25 parsers verify with zero network, and refreshing a fixture is a deliberate, reviewable act rather than a silent drift.
- **`prose/` is pure** and unit-tested against known-generic and known-specific passages.
- API integration tests over a temp SQLite database.
- Playwright e2e on the core flows: log in → set profile → browse with matcher verdicts → star → calendar → export ICS → open a template → copy an AI prompt → run the prose check.
- **`npm run verify-sources`** — a live, warn-only check against real sites, mirroring the `arrl-calendar` `live-crosscheck` pattern. **Never a CI gate**; the network is not a build dependency.

---

## 15. Deployment

- Multi-stage Dockerfile; multi-arch `linux/amd64,linux/arm64` via GitHub Actions buildx.
- Publishes `ghcr.io/atvriders/grantspotter:latest` — **repository and package public**.
- `docker-compose.yml` pulls the published image (does not build locally). `HOST_PORT=3030` via `.env`, so the port is a one-line change — 3030 is already claimed in the `fps-game` and `youtube-clicker` compose files on this host.
- Named volume for the SQLite database, snapshots, and fixture cache.
- Environment: `HOST_PORT`, `SESSION_SECRET` (**required**, no default), `ANTHROPIC_API_KEY` (optional), `SIMPLER_GRANTS_API_KEY` (optional), `CRAWL_ENABLED`, `CRAWL_CRON`, `CONTACT_URL` (for the User-Agent).
- **No real LAN IPs, hostnames, or host paths anywhere in the repo** — placeholders and RFC 5737 ranges only.

---

## 16. Risks

1. **Two funders own the market, and one funds the other.** ARDC underwrites ARRL's club grants, scholarships, and Teachers Institute ($2.1M/3yr). That is one leg with a splint, not two legs. Mitigation: the app is honest about its corpus size and does not pad it with empty categories.
2. **Auto-discovery is narrower than the phrase suggests.** Mitigated by scoping to curated sources plus change detection (§1.1) and saying so in the README rather than implying a spider.
3. **Stale deadlines.** Mitigated by §8 in full — this is the one risk the UI is designed around.
4. **The legal perimeter is sharp and names ClaudeBot explicitly.** Mitigated by a fetcher-level blocklist (§7.2) that cannot be disabled by configuration.
5. **The most winnable money is un-aggregatable.** Campus SGA (~4,000 campuses) and NASA Space Grant (52 consortia) are where a typical collegiate club's money actually comes from. Mitigated by shipping them as **guided workflows** — a state-keyed consortium picker and an SGA playbook — rather than pretending they are feeds.

---

## 17. Implementation decomposition

This spec is deliberately one document — the modules share a data model, and splitting the spec would fragment it. It is too large for one implementation plan, so it yields **five**, executed in order, each independently verifiable:

| Plan | Scope | Done when |
|---|---|---|
| **1 — Foundation** | `core/` types + eligibility matcher + normalize + amount/deadline parsing; SQLite schema + migrations; auth and roles; API skeleton | Matcher unit suite green against hand-built fixtures covering all 13 eligibility axes and all 4 shape-conflicts |
| **2 — Ingestion** | `fetcher/` with blocklist and politeness; ~25 `sources/*` parsers against committed fixtures; `diff/`; `review/` inbox; federal sweep + adjacency scorer; sources health | Every parser green offline against its fixture; blocklist provably un-bypassable; `verify-sources` runs live warn-only |
| **3 — Product surface** | Browse + filters + matcher verdicts; opportunity detail with provenance and trust badges; calendar with lead-time overlay; watchlist + change notifications; profiles | e2e: log in → profile → browse → star → calendar |
| **4 — Writing tools** | Template library (components + funder overlays); slot filling; AI prompt composer; `prose/` analyzer; fact checklist; disclosure sentence | Prose analyzer unit-tested on known-generic vs. known-specific passages; every overlay traced to a cited funder requirement |
| **5 — Exports, seed, deploy** | CSV/XLSX/ICS/DOCX/ZIP/JSON exports + print stylesheet; `data/seed/` corpus (~150 records incl. verified negatives and the FAR warning); Dockerfile; GitHub Actions multi-arch → GHCR; compose | Full verification: typecheck + build + unit + e2e, image builds multi-arch, compose comes up on `HOST_PORT` |

**Delivery discipline for this project:** commits stay local through all five plans; a completeness audit and a debug audit run before anything leaves the machine; **one push at the end**, after full verification.

## 18. Open items for the implementation plan

- Exact parser strategy per Tier C source, with a fixture captured for each at plan time.
- Adjacency-vocabulary weighting for the federal sweep — the term list and scoring thresholds.
- ARRL Division/Section ↔ state lookup table sourcing.
- Whether the ARRL Club Grant cycle can be resolved before launch, or ships `disputed` (current expectation: ships `disputed`).
