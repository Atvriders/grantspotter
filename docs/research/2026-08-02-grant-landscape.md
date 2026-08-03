# Ham Radio Grant Finder — Research Synthesis (Decision-Grade)

**Compiled 2026-08-02 from 6 parallel research passes.** All URLs below were live-fetched by at least one researcher unless explicitly marked. Where researchers disagreed, the conflict is stated rather than averaged.

---

## 1. Source inventory

### 1a. Ham-specific and adjacent funders (the actual product corpus)

| Funder | Program | Audience | Amount | Deadline pattern | URL | Discovery method | Confidence |
|---|---|---|---|---|---|---|---|
| **ARDC** | Grants Program (Support & Growth / Education / R&D) | US 501(c)(3), govt, **schools & universities**; intl nonprofits/universities. Clubs & individuals need a fiscal sponsor. For-profits ineligible. **All output must be open-source/open-access.** ≤20% indirect. | No cap. 2026 page range **$1,285–$258,000**; verified collegiate awards **$2,000–$77,000**; ~$3.4–3.8M/yr, ~30% approval | 4 fixed cycles: **Feb 1, Apr 1, Jul 1, Sep 1**. Post-Sep-1 → next Feb 1. Eval 60–120 days | https://www.ardc.net/apply/ | **Tier A.** WP REST API open (`/wp-json/wp/v2/pages` with `parent=`, `modified_after=`, `_fields=`) + RSS + `wp-sitemap.xml`; per-year award tables at `/apply/grants/{YYYY}-grants/` with per-grant child pages | Verified (4 researchers) |
| **ARRL Foundation** | Amateur Radio Grants (org grants) | **US organizations only**, never individuals. Clubs, schools, youth programs. Excludes emcomm equipment and ongoing operating expenses. Prefers co-funded projects | "generally do not exceed **$3,000**"; **up to $5,000 in 2026** (Year of the Club) | 3 fixed windows/yr: **Feb 1–28, Jun 1–30, Oct 1–31** | http://www.arrl.org/amateur-radio-grants | **Tier C.** Best-structured ARRL deadline page; windows stated inline. Hash-diff | Verified (3) |
| **ARRL Foundation** | **Club Grant Program** (ARDC-funded) | ARRL-affiliated clubs **incl. collegiate** — 2024 recipients include Kansas State, Missouri S&T, Oklahoma State, Baylor WA5BU, City Tech | **$1,000–$25,000**. 2024: $500,502 to 37 of 110 applicants (~$1.6M requested) | ⚠️ **DISPUTED — see §6.** Page shows only 2024 results, no open cycle, no application link. Historically an autumn window (Sep 7–Nov 4 2022; "open until November 4"). Two researchers asserted Feb/Jun/Oct — a third argues that conflates it with the separate Amateur Radio Grants cycle | https://www.arrl.org/club-grant-program | **Tier C+B.** Recipient list is parseable inline; **deadline is never published on the page**. Only signal = ARRL news RSS. Portal is a JS SPA (unpollable) | Verified page / **deadline unverified** |
| **ARRL** | ETP Grants (School Station + Progress) | US **K-12 schools & teachers**; applicant must be ARRL member; requires signed antenna-approval form. Not aimed at colleges | Equipment/software/classroom resources; **cash amount genuinely unpublished** | Annual single window: **Oct 1–31** (page text still says "of 2025" — stale) | http://www.arrl.org/etp-grants | **Tier C.** Year-agnostic URL; year-specific Jotform ID + `.xlsx`/`.pdf` attachments change underneath. Regex the Jotform ID + the Oct sentence | Verified (2) |
| **ARRL Foundation** | Scholarship Program — **111 catalog entries / "170+" awards** | Individual FCC-licensed students in higher ed; some entries open to foreign licensees | **$500–$25,000**. 2024 actual: **135 awards, >$715,000** | Annual: opens ~**Oct 30**, closes ~**Dec 30 12:00 PM EST**. (Moved from Jan 31 — do not hardcode) | http://www.arrl.org/scholarship-descriptions | **Tier C — highest-yield scrape in the entire space.** 4 accordions `div.tabArea.f-widget.f-accordion`, `ul.accordion > li`, 114 li − 3 stubs = **111 real entries** | Verified (2, with full DOM spec) |
| **ARDC** (via ARRL) | ARDC Scholarships | Any licensed ham **worldwide** (US licensure/residence/citizenship explicitly not required); licensed ≥1 yr; 3 references | **45 awards**: 20×$25,000, 4×$15,000, 17×$10,000, 4×$5,000 — largest block in the catalog | ARRL cycle | (ARRL catalog entry) | Tier C — one `li` in the A–D accordion | Verified |
| **QCWA** | Memorial Scholarship Fund | Licensed hams in accredited degree programs; **must be sponsored by an active QCWA member** | **$3,000** each; 2024: 15 awards / $57,000; 624+ students / $930,350+ since 1978 | Requests from Oct 31; must reach ARRL **before first week of January** (rides ARRL cycle) | https://www.qcwa.org/scholarship-program.htm | Tier C. Static `.htm` + real PDF (`scholarship-program.pdf`, "Ver. 04/2025"). Intake is ARRL's portal, not QCWA | Verified (2) |
| **YLRL** | Ethel Smith K4LMB / Mary Lou Brown NM7N / Marte Wessel K0EPE | **Female licensed hams**; non-US eligible; YLRL member preference. Wessel targets part-time students working full-time | $2,500 / $2,500 / $1,500 | Annual; exact date on `/apply/` (not fetched) | https://ylrl.net/Scholarships/ | Tier C. **One of only two verified non-ARRL US ham scholarship application paths** | Verified |
| **Austin ARC** | Copeland / Greenwood club scholarships | Central Texas (7 named counties); license historically required | Unpublished since site rebuild | **May 1 – Jul 31** annually (⚠️ search engines still show a stale "March 25, 2026") | https://austinhams.org/scholarships/ | Tier C + self-hosted portal at grants.austinhams.org (no public JSON; probed `/api*` → 404). Best verified example of a regional non-ARRL program | Verified |
| **Yasme Foundation** | Supporting Grants + Excellence Award | Board-selected: youth programs, developing-country societies, RBN nodes, other foundations' scholarship funds | **$5,000–$7,500** observed | **No application, no deadline.** Board-initiated, announced retrospectively ~semiannually | https://www.yasme.org/news-releases/ | **Tier D.** `/feed/` and `/wp-json/` 301→`/403.shtml` for non-browser clients. **Track via ARRL news RSS instead** | Verified (3) |
| Yasme Foundation | YASME Foundation Scholarship | Licensed ≥2 yrs, **General or higher**; sciences/engineering; top 5–10% of class | $5,000 | ARRL cycle | (ARRL catalog entry) | Tier C via ARRL. yasme.org has **no** scholarship page | Verified |
| **DARA (Hamvention)** | DARA Scholarship | Any license class, any region/field, accredited 4-yr | **$1,500**, multiple/yr | ARRL cycle | (ARRL catalog entry) | Tier C via ARRL only. w8bi.org and hamvention.org have **no** scholarship page; daytonhamvention.org did not resolve | Verified |
| **Six Meter Club of Chicago** | Scholarship | IL or ARRL Central Division (IN, WI); **part-time OR full-time** OK; soft GPA 2.5 floor | $500, 1/yr | ARRL cycle | (ARRL catalog entry) | Tier C via ARRL. k9ona.com returns 403 to non-browsers | Verified |
| **NCDXF** | Grant Program (DXpedition / radio science) | Individuals & groups advancing education/science via ham radio — in practice DXpedition teams to top-100 DXCC. **Not a collegiate program** | Unpublished; ~$1.2M total over ~48 yrs → many small awards. Applicant must have personal financial stake | **Rolling**, allow ~2 months lead | https://www.ncdxf.org/pages/grant-app.html | Tier C/D. `robots.txt` **and** `sitemap.xml` both **403**. Application is a downloadable form + budget spreadsheet emailed to treasurer | Verified |
| NCDXF | W6EEN Memorial Scholarship + Youth Grant | Licensed hams **≤25**, any class | Full tuition at DX University / Contest University (no $ figure) | No published deadlines; tracks course schedules | https://www.ncdxf.org/pages/scholarships.html | Tier D. Youth Grant page renders as nav + title only — no terms. Low-value polling target | Verified |
| **SARA** | Student and Teacher Project Grants | Students **5th grade through college** + teachers; international | **≤$200** typical ("or more with committee approval"); $500 outlier. Often kits (Radio JOVE, SuperSID) not cash | **Rolling**, no deadlines anywhere on the page | https://www.radio-astronomy.org/grants | Tier C. Downloadable Word/PDF forms → grants@radio-astronomy.org | Verified |
| **RCA** | Scholarship Program (Rappaport, Carr, Cooper + 13 named funds) | Undergrad/grad on a **wireless career** track — **ham license NOT required**. Only students at ~9 participating schools; **the university selects recipients, students don't apply to RCA** | Per-award unpublished; ~$15,000/yr total distributed | **Not published.** Awards distributed each May | `content.aspx?page_id=22&club_id=500767&module_id=460976` | **Tier D.** ClubExpress. `sitemap.xml` 403, WebFetch 403, pretty URLs 404. Only query-string URLs work; breaks silently if RCA renumbers modules | Verified |
| RCA | Youth Activities Program | Schools, scouts, museums | **In-kind only** — books, equipment, curriculum | Rolling / none | `...module_id=493230` | Tier D — record as permanent contact-only entry, do not poll | Verified |
| **ARISS-USA** | ISS Contact Proposals + SPARKI | "US schools and educational organizations" — ⚠️ **colleges/universities not explicitly named**; K-12 dominates | **No cash.** Scheduled ISS crew contact + technical mentoring | 4 windows/yr (quarterly). Verified live: opened **Jul 1**, closes **Sep 30** for Jan–Jun 2027 contacts | https://ariss-usa.org/proposal-overview/ | **Tier C — good.** Window dates are server-rendered inline and rewritten quarterly at a stable URL. Regex "Proposal window" + date sentence | Verified (2) |
| **NASA** | CubeSat Launch Initiative (CSLI) | US educational institutions, nonprofits | **No cash** — launch/deployment services only; team funds its own hardware | ⚠️ Historically Aug release / Nov due. Page currently says NASA "anticipates an update in spring 2026" — **no confirmed open window** | https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/ | Tier D. Poll the AO page for status | Verified |
| **NASA** | National Space Grant (52 state consortia) | University students/faculty/teams — **the most common real route to campus ground stations & cubesats** | Consortium-level student awards typically $1k–$10k (not published nationally) | **No national deadline** — 52 independent calendars | .../consortium-directors/ | **Tier D — structurally non-aggregatable.** Stable HTML directory of 52 names + heterogeneous university-hosted sites | Verified |
| **IEEE MTT-S** | Chapter Support | IEEE MTT-S **Student Branch Chapters** — most RF-relevant IEEE money | **$1,000/yr** single-society chapter, $500 joint; + 10×$1,500 undergrad scholarships, 3×$6,000 fellowships | **Oct 1** annual, stated inline | https://mtt.org/chapter-support/ | Tier C. Jotform application. Requires ≥5 members, vTools officer roster, ≥2 reported meetings | Verified |
| **IEEE** | Student Branch Rebate | IEEE Student Branches | $50/yr (<50 members) or $100/yr (50+), + $2/member + $1/chapter member | Annual Plan due **15 March** | https://students.ieee.org/topics/submit-your-student-branch-annual-plan/ | Tier C for deadline. ⚠️ Amount page `mga.ieee.org/.../rebates` returns **HTTP 418** to bots — amounts are search-snippet only | Partial |
| **Yaesu USA** | System Fusion DR-2X Repeater Program | "clubs, groups, organizations or individuals in North America" — collegiate clubs qualify | **Discounted purchase, not a grant**: $1,450 (DR-2X) / $1,860 (with LAN-01A) | Ad-hoc windows ~2–4/yr. Current: **Jun 3 – Aug 31, 2026**. Repeater must be on-air 12 months | https://systemfusion.yaesu.com/ | **Tier C/D — PDF-only.** Window dates live in a dated fillable PDF title under `/wp-content/uploads/{YYYY}/{MM}/`; poll the landing page for the link | Verified |
| **Campus SGA / student activity fee** (per-campus; FSU verified as representative) | RSO Allocation, Development Fund, Senate Projects | Any registered student org — the ham club applies like anyone else | FSU: programming ≤$3,000 (≤$5,000 extraordinary); travel $250/student, $5,000/org; Development Fund ≤$300/FY | Hybrid: rolling event/travel (≥6 weeks lead, max 3/FY) + annual A&S budget cycle | https://sga.fsu.edu/accounting/funding-your-rso | **Tier D — not aggregatable at any scale** (~4,000 campuses, Qualtrics/CampusGroups/Presence/Engage). ⚠️ Capital equipment often barred by A&S rules | Verified |

### 1b. Federal opportunity channels (aggregators, not funders)

| Channel | What it actually yields for ham | Key? | Endpoint | Confidence |
|---|---|---|---|---|
| **Grants.gov Search2** | 57 hits on `"amateur radio"`; **253** on `"radio frequency spectrum wireless STEM education"` + `fundingCategories:"ST\|ED"`. Real relevance is *adjacent*: NSF geospace/ECCS/ATE/Noyce, NASA Space Grant + MUREP (3 open), NTIA PWSCIF | **No key** | `POST https://api.grants.gov/v1/api/search2` | Verified (3, live-executed) |
| **Grants.gov fetchOpportunity** | Structured eligibility (`synopsis.applicantTypes[]`), deadlines, `lastUpdatedDate` for cheap change-detection. ⚠️ `awardCeiling`/`awardFloor` frequently literal `"none"` | No key | `POST .../v1/api/fetchOpportunity` `{"opportunityId":N}` | Verified (2) |
| **Grants.gov daily XML extract** | Entire federal opportunity DB, 77.85 MB zip, ~7-day rolling retention. **Better backbone than polling** if you want your own relevance scoring | No key | `https://prod-grants-gov-chatbot.s3.amazonaws.com/extracts/GrantsDBExtract{YYYYMMDD}v2.zip` | Verified (2, incl. 206 range request) |
| **NSF Funding RSS ×3** | Only working `.gov` funding RSS found. Small (10–20 items) | No key | `rss_www_funding.xml`, `rss_www_funding_pgm_annc_inf.xml`, and **`https://www.nsf.gov/rss/rss_www_funding-upcoming/rss.xml`** (hyphen + `/rss.xml`; the published URL 301-chains twice) | Verified |
| **NSF Awards API** | Retrospective prospecting: HamSCI Workshop $49,966; CAREER Amateur Radio/TIDs (Scranton) $715,457; PSWS DASI $692,730; CubeSat Ideas Lab $330,956 | No key | `https://api.nsf.gov/services/v1/awards.json` | Verified |
| **USAspending v2** | Cross-agency retrospective; found the NSF CHART (Completely Hackable Amateur Radio Telescope) award at $993,364 | No key | `POST https://api.usaspending.gov/api/v2/search/spending_by_award/` | Verified |
| **Simpler.Grants.gov** | Same corpus, better ranking/filters | **Free key required** (Login.gov self-serve) | `POST https://api.simpler.grants.gov/v1/opportunities/search`; spec at `/openapi.json` | Verified (401 confirms auth) |
| SAM.gov | **Procurement, not grants.** Low value | Key required | `https://api.sam.gov/opportunities/v2/search` | Docs-only (api.sam.gov 404'd from sandbox at every path incl. root) |

### 1c. Nonprofit-data infrastructure (for funder discovery, not opportunities)

| Source | Use | Key? | Constraint |
|---|---|---|---|
| **IRS 990 XML bulk** | **Only** machine-readable source of 990-PF Part XV grantee lists. Public domain | No | `https://apps.irs.gov/pub/epostcard/990/xml/{YEAR}/{YEAR}_TEOS_XML_{MM}{A}.zip`. Old AWS `irs-form-990` bucket **dead since 2021-12-31** |
| **IRS EO BMF** | Cheapest grantmaker-universe build: NTEE_CD (A34 = radio/TV) + FOUNDATION code, 1,983,563 orgs | No | Per-state CSVs at `https://www.irs.gov/pub/irs-soi/` |
| **GivingTuesday 990 Data Lake** | Free redistributable substitute for ProPublica; 300 req / 5 min | No | `https://990-infrastructure.gtdata.org/irs_data/{bmf,efilexml,...}` — ⚠️ docs read, endpoints **not live-tested** |
| **ProPublica Nonprofit Explorer** | Live lookups/enrichment. ARDC = EIN 45-3751971, NTEE A34, assets $142,886,749 | No | ⚠️ **ToS forbids bulk redistribution, paywalling, ad-monetization.** `ntee[id]` filters major group 1–10 only |
| **Grantmakers.io** | Proof that free full-text search over ~3.3M 990-PF grant descriptions is legal & cheap. **Grant-purpose text search finds ham funders that org-name search misses** | No | CC BY-SA; use their open-source pipeline, not their Algolia index |

### 1d. Verified negatives — do not build UI or crawler budget around these

| Thing | Finding |
|---|---|
| **ARRL CARI** (Collegiate Amateur Radio Initiative) | **Not a funding program.** Zoom meetups, Collegiate QSO Party, Hamvention networking. The W1YSM Snyder endowment funds CARI activities but has no open application. Confirmed by 2 researchers |
| **AMSAT** | **No grants program.** `/university-participation/` is a near-empty stub (one RIT project). AMSAT is a grant *recipient* (via ARISS/ARDC), not a grantmaker. Confirmed by 2 |
| **FlexRadio** | `/purchasing-programs/` fetched specifically to check — **no education/student/club/nonprofit tier exists.** Only CPO + trade-in |
| **Icom America / DX Engineering / Kenwood** | Genuine collegiate giving happens (IC-7610s to CMU W3VC, Penn State K3CR, Pitt W3YI) but **no application program, no page, no deadline** — relationship-driven only. Kenwood: nothing at all |
| **DARA/Hamvention as a grantmaker** | Zero hrefs containing "scholar" or "grant" on w8bi.org. Only their ARRL catalog entry is real |
| **Chicago FM Club Scholarship** | **Discontinued.** 0 hits in live `/scholarship-descriptions`; chicagofmclub.org (325 KB fetched) contains no occurrence of "scholarship". Still listed by 7+ third-party aggregators — proof they mirror stale ARRL data |
| **FAR / farweb.org** | ☠️ **DOMAIN COMPROMISED.** 301 → `https://www.batualam.org/` (Indonesian gambling, `<title>TARGET88…</title>`). Wayback pins takeover between 2025-10-17 and 2026-02-10. **Hard-blocklist the domain.** FAR's portfolio (10-10, QCWA, YASME, K3IVO, CARA) appears absorbed into the ARRL Foundation. Confirmed by 3 |
| **Grants.gov RSS ×4** | All four advertised feeds return **HTTP 200 + `text/html`** (~27 KB SPA shell), not XML. Confirmed independently by 2. A naive poller finds zero items forever and never errors |
| **Philanthropy News Digest RFP feed** | **Dead.** `/`, `/rfps/`, `/feeds/rfp`, `/rss/rfp`, `/feed` all 301 into candid.org's paid funnel. This used to be the best free RFP feed |
| **NASA NSPIRES** | No API/RSS/XML/JSON/CSV. Session-stateful Struts/JSF `.do` app. Grants.gov is the **only** machine route to NASA opportunities |
| **`arrl.org/summary-of-scholarship-requirements`** | Easiest page to parse (80-row table), **and stale**: 79 entries vs 111, abbreviated non-joinable keys, still lists dropped scholarships. Secondary geo cross-check only |
| **`arrl.org/grant-application`** | 302, dead |

---

## 2. Auto-discovery tiers

### Tier A — True machine-readable APIs (key-free unless noted)

| Endpoint | Key | Incremental lever | Yield |
|---|---|---|---|
| `POST https://api.grants.gov/v1/api/search2` | none | `dateRange` (3–56 days), `sortBy=openDate\|desc` | ~5,000 posted federal opps; **~250 RF/STEM-adjacent**; realistically **10–30/yr** a ham club could actually win |
| `POST https://api.grants.gov/v1/api/fetchOpportunity` | none | `synopsis.lastUpdatedDate` | detail hydration only |
| `GET .../extracts/GrantsDBExtract{YYYYMMDD}v2.zip` | none | daily filename | full federal DB, 77.85 MB/day |
| `GET https://www.ardc.net/wp-json/wp/v2/pages?parent=<GRANTS_YEAR_PAGE_ID>&modified_after=<ISO8601>&_fields=id,slug,link,title,date,modified,parent` | none | **`modified_after` confirmed working** | ~40–80 award records/yr + 1 live apply page. ⚠️ Resolve the parent page ID at runtime — do not hardcode; ARDC has **no** grant custom-post-type (`wp/v2/types` = post/page/attachment only), grants are hierarchical **pages** |
| `GET https://api.nsf.gov/services/v1/awards.json` | none | `startDateStart/End` | retrospective prospecting. **`printFields` works despite docs saying it doesn't** — mandatory for cheap polling; `rpp` hard-capped at 25 |
| `POST https://api.usaspending.gov/api/v2/search/spending_by_award/` | none | `time_period` | retrospective; use `award_type_codes ["02","03","04","05"]` to exclude contracts |
| ProPublica / IRS bulk / GivingTuesday | none | monthly drops | funder-universe construction (see §1c) |
| `POST https://api.simpler.grants.gov/v1/opportunities/search` | **free key** | `post_date` sort | same corpus, better ranking. **Gate behind an optional user-supplied key — never a hard dependency** |

**Tier A total ham-relevant yield: essentially ARDC only, plus a low-signal federal firehose.**

### Tier B — RSS/Atom (change triggers, not opportunity sources)

| Feed | Content-Type verified | Role | Yield |
|---|---|---|---|
| `http://www.arrl.org/news/rss` (and `/news/rss/all`) | `application/rss+xml` | **The single most important change signal in the ham space.** Carries grant/deadline/window announcements; also relays Yasme announcements | ~10–20 actionable deadline events/yr; 0 structured opportunities |
| `https://www.ardc.net/feed/` | `application/rss+xml`, 63 KB | ARDC news only — **no grant announcements** | 0 opportunities |
| NSF ×3 (see §1b) | `application/rss+xml` | Only working `.gov` funding RSS | ~45 rolling items |

### Tier C — Stable server-rendered HTML worth scraping

| Page | Structure | Records |
|---|---|---|
| `arrl.org/scholarship-descriptions` | 4 × `div.tabArea.f-widget.f-accordion` (`h3.tab` = A-D/E-L/M-R/S-Z, a 5th "EXPLORE ARRL" is chrome). Each `li` = `p.title > a` + `div.content`. **Body markup is inconsistent** — some flat `<p>• Label: value</p>`, some `<ul><li><strong>Label:</strong></li></ul>`. **Parse by label regex over flattened text, never by DOM shape.** Handle invalid HTML (`<ul>` opened inside `<p>`), `\xa0`, and typo'd labels seen in the wild: `R egion`, `License   Requirement`, `Scholarshp` | **111** |
| `ardc.net/apply/grants/{2019..2026}-grants/` | One 4-column `<table>` per year: Date \| Grantee \| Project \| Amount. Some rows link to `/grant-{slug}/` detail pages, some don't. 2026 amounts partly "TBD" | ~40–80/yr, 8 years |
| `arrl.org/amateur-radio-grants` | 3 windows + exclusions stated inline | 1 |
| `arrl.org/club-grant-program` | Recipient list as a plain block (club + state); **no deadline field** | 1 + 37 past awards |
| `arrl.org/etp-grants`, `/arrl-foundation-special-funds`, `/scholarship-program` | Prose with dates inline | 4 |
| `ariss-usa.org/proposal-overview/` | Window sentence rewritten quarterly at a stable URL | 1 |
| `mtt.org/chapter-support/` | Oct 1 inline | 1 (+3 sub-awards) |
| `radio-astronomy.org/grants`, `qcwa.org/scholarship-program.htm`, `ylrl.net/Scholarships/`, `austinhams.org/scholarships/`, `ncdxf.org/pages/*.html` | Flat static HTML | ~7 |
| `systemfusion.yaesu.com/` | Landing page → dated fillable PDF; **window dates exist only in the PDF title line** | 1 |

**Tier C total: ~130–150 opportunity records, ~75% of them from one ARRL page.**

### Tier D — Manual curation only

Yasme (board-initiated, no application, site 403s non-browsers) · RCA Scholarship + Youth (ClubExpress `module_id` query strings, sitemap 403) · NCDXF Youth Grant (page has no terms) · Icom / DX Engineering / Kenwood (no program) · DARA (no page) · NASA CSLI (status ambiguous) · **NASA Space Grant — 52 independent consortium sites** · **Campus SGA — ~4,000 independent sites** · HamSCI (no club-facing application; participate with a funded PI) · IEEE's ~39 society funding pages.

**Tier D yield: ~10 standing curated records + an uncountable long tail that is, ironically, where the most reliably-available club money actually is.**

---

## 3. Data model implications

### 3.1 The four shape-conflicts that must be first-class, not special-cased

| Axis | Observed variants |
|---|---|
| **Applicant entity** | individual student · unincorporated club · 501(c)(3) club · club **via fiscal sponsor** (ARDC) · school/LEA · university (as institution) · university dept/PI · **IEEE Student Branch Chapter** · teacher as individual · **institution nominates, student never applies** (RCA) |
| **Award instrument** | cash range (min/max) · fixed cash · **tiered blocks** (ARDC: 20×$25k, 4×$15k, 17×$10k, 4×$5k) · in-kind equipment (ETP, SARA kits, RCA Youth) · **in-kind service** (ARISS ISS contact, NASA CSLI launch) · **discounted purchase** (Yaesu $1,450) · **per-member rebate** (IEEE $2/member) · tuition coverage (NCDXF W6EEN) · **genuinely unknown** (ETP, RCA) · **literal `"none"`** (Grants.gov ceiling/floor) |
| **Deadline** | N fixed dates/yr (ARDC ×4) · N fixed windows/yr (ARRL ×3) · single annual window with open+close (Oct 30→Dec 30) · rolling/none (NCDXF, SARA) · quarterly-rewritten window (ARISS) · ad-hoc irregular (Yaesu) · **inherited from another org's cycle** (QCWA→ARRL) · unpublished (RCA, Club Grant) · **no application exists** (Yasme) · **dormant/unknown** (Club Grant) · per-record from API (Grants.gov) |
| **Apply-via** | direct page form · **external SPA portal** (Kaleidoscope, grants.ardc.net, Salesforce) · Jotform with year-specific ID · self-hosted portal (grants.austinhams.org) · **email a PDF + budget spreadsheet** (NCDXF, SARA) · contact a named person (RCA Youth) · none |

### 3.2 Eligibility axes (derived from all 111 ARRL entries + non-ARRL programs)

ARRL's own schema is regular enough to model directly. Label frequency across 111 entries: `Field of Study` 111 · `License Requirement` 110 · `Region` 109 · `Institution` 107 · `Award Amount` 101 · `Number of Awards` 100 · `Other` 65 · `Age` 4.

1. **License** — `licenseMin: NONE|TECH|GENERAL|EXTRA` (~55 any, ~17 Tech+, ~14 General+), `licenseHeldMonthsMin`, `foreignLicenseOK: bool` (only 10-10 and ARDC), `licenseIsPreferenceNotRequirement: bool`.
2. **Geography — the hardest axis; five incompatible shapes.** `{type: any|state|arrlDivision|arrlSection|county|radius|callDistrict, values[], centerLatLon?, radiusMiles?}`. Radius examples are real: "within 250 miles of Seaford, Delaware", "within 70 miles of Schenectady, NY", "within 175 miles of Erving, MA". **You need an ARRL Division/Section ↔ state lookup table.**
3. **Field of study** — "Any" (39) + STEM spelled 4 different ways + one-offs (Journalism, International Studies, Business) + **one exclusion** ("Any, except for Liberal Arts"). Needs `excludedFields[]`.
4. **Institution / degree level** — `degreeLevels: [CERT|ASSOC|BACH|GRAD]`, `tradeSchoolOK`, `partTimeOK`, `accreditationRequired`.
5. **GPA / academic standing** — 16 entries. Hard floors (2.5, 3.0, 3.2) *and* soft preferences (ARDC "preference … over 3.5"). Plus non-GPA proxies: class rank (YASME top 5–10%).
6. **ARRL membership** — only ~5 entries; two intensities (member vs member ≥1 yr).
7. **Sponsor/recommendation** — `recommenderType: none|arrlAffiliatedClubOfficer|sponsorOrgMember|teacher|any`, `recommendationCount` (**ARDC needs 3**; QCWA needs a QCWA member; Goldwater needs a sitting club officer's letter).
8. **Citizenship** — 26 entries. `US_CITIZEN | US_RESIDENT | ANY` (+ "or within three months of citizenship").
9. **Age / stage** — explicit `Age` on 4 entries (17–25; YCCC "22 or younger as of June 1"); ~15 more gate on `stages: [HS_SENIOR|UNDERGRAD|GRAD|VETERAN|RETRAINING_ADULT]`. Veterans explicitly included by Chick Allen and Frankford RC.
10. **Demonstrated ham activity** — its own axis. `activityProofRequired`, `activityKinds[]` (club membership, ARES/RACES/SKYWARN, teaching, on-air, Field Day), `cwProficiencyWpmMin` (CWops: ARRL Code Proficiency ≥15 wpm within 24 months).
11. **Financial need** — 4 entries, always a weighting not a bar.
12. **Gender** — YLRL only; **no equivalent in the ARRL catalog**.
13. **`rawOtherText` verbatim, always.** Long-tail requirements no schema will capture: learning-disability documentation (Challenge Met); at-risk-youth turnaround letters (Hodges); "preference to a student ham from a ham family" (K2TEO/K2PLF); year-end activity report required (YASME).

### 3.3 The four modeling decisions that will bite you if you skip them

- **`hard: bool` + `fallbackRank: int` on EVERY constraint.** Nearly every axis appears in both requirement and preference form, often with an explicit cascade: *"Preference will be given to applicants residing in Louisiana. If no qualified applicant is identified, …"*. Without this, your matcher wrongly excludes eligible students.
- **`entryCount` ≠ `awardCount`.** 111 catalog entries → "170+" awards. The single ARDC entry carries 45; QCWA 19; many say "Multiple per year". Store `awardCountRaw` (values are non-numeric: "1 per year", "Three", "Multiple per year", "19").
- **`amountMin` / `amountMax` / `amountRaw`.** Naive max-regex is wrong — one entry contains **$100,000** which is an *endowment* figure, not an award. Distribution: $1,000×50, $2,000×16, $500×15, $5,000×8, $2,500×7, $3,000×6, $1,500×4, $750×3, $10,000×2.
- **Deadline ownership.** 111 ARRL entries share ONE deadline. Model it as `deadlineSource: self | inheritedFrom(<programId>)` or you'll write 111 empty date fields — and QCWA's real deadline lives in ARRL's cycle.

### 3.4 Additional required fields observed

`fundingRestrictions[]` (ARRL: **no** emcomm equipment, **no** ongoing operating expenses; NCDXF: no commercial transport) · `licenseObligation` (ARDC: **all output must be open-source/open-access** — GPL/MIT/BSD/CERN-OHL/CC) · `indirectCostCapPct` (ARDC 20%) · `costShareRequired` (NTIA true) · `coFunderPreference` (ARRL: doesn't want to be sole funder) · `sustainmentObligation` (Yaesu: repeater on-air 12 months) · `reportingObligation` (YASME year-end activity report) · `status: open|closed|dormant|discontinued|contact-only|no-application` · `sourceUrl` + `lastVerifiedAt` + `contentHash` + `verificationMethod`.

---

## 4. Legal / ToS constraints

### 4.1 Hard NO — do not ingest, do not cache, do not train on

| Source | Prohibition (verbatim-ish) |
|---|---|
| **Candid** (API License Agreement) | Prohibits republishing/distributing including "by posting it on any third-party website"; prohibits "data mining, robots or similar data gathering and extraction methods" to create competing databases; **specifically prohibits use for "artificial intelligence ('A.I.'), large language models, machine learning, or similar applications" — and that restriction SURVIVES TERMINATION.** Mandatory "Powered by Candid" attribution. A cached, re-served ham grant finder **is** a competing database |
| **GrantWatch** | "Automated access, including scripts, bots, or data scraping tools, is prohibited" and "**We do not offer or authorize any API access to our data or platform.**" Also bans use for training/fine-tuning/evaluating AI models |
| **GrantStation** | EULA bans robots/spiders/automatic devices, bans use "for the purposes of training large language models", bans "web scraping, or data mining technologies" |
| **Instrumentl** | ToS bans crawling/scraping/spidering. **robots.txt explicitly names `anthropic-ai`, `ClaudeBot`, `Claude-Web`, `GPTBot`, `CCBot`, `PerplexityBot`** and Disallows `/grants`, `/foundations`, `/990-report`. Their SEO pages rank for ham searches (e.g. `/grants/amateur-radio-digital-communications-grants`) — **link out, never ingest** |
| **farweb.org** | Not a ToS issue — a safety issue. **Hard-blocklist.** Redirects to a gambling site; a naive crawler will surface it to students |

### 4.2 Restricted / conditional

- **ProPublica Nonprofit Explorer** — keyless API, but the Data Terms forbid republishing the raw data in whole or part, charging for access, selling ads against it, or sub-licensing; citation required. `robots.txt` disallows `/nonprofits/search*`, `/full_text_search*`, `/download-xml*`, `/download-filing*` but **leaves `/nonprofits/api/` open** — a clear signal about intended access mode. **Use for live lookups + enrichment; use IRS/GivingTuesday for anything you mirror.**
- **Grantmakers.io** — CC BY-SA 4.0 content, but there is no documented public REST API and their FAQ doesn't address using their front-end Algolia index. Use their open-source pipeline against IRS XML instead.
- **arrl.org** — `robots.txt` **`Crawl-delay: 5`**. Disallows `/files/file/protected`, `/attachments/download`, `/admin`, `/results-database`, `/volunteer-monitor-resources`. **All grant and scholarship pages are allowed.**
- **ardc.net** — `robots.txt` blocks only `/wp-admin/`. Sitemap at `/wp-sitemap.xml` (note: `/sitemap_index.xml` 404s).

### 4.3 Sites that actively block non-browser clients (a policy decision, not a bug)

- **yasme.org** — `/feed/` and `/wp-json/` 301 → `/403.shtml`; curl with browser UA hit a redirect loop. (One researcher reached the homepage via WebFetch — treat as inconsistently gated.)
- **ncdxf.org** — `robots.txt` **and** `sitemap.xml` both 403 with a meta-refresh back to the homepage.
- **radioclubofamerica.org** — `sitemap.xml` 403; WebFetch 403; only ClubExpress `content.aspx?...&module_id=NNN` query-string URLs work, and only with a browser UA.
- **mga.ieee.org** — HTTP **418** to bots.
- **k9ona.com** — 403 to non-browsers.

**Recommendation: do not UA-spoof to defeat these.** For all five, the payoff is 1–2 records that can be hand-curated in five minutes and re-verified quarterly. Spoofing turns a clean project into an argument.

### 4.4 What a polite scraper must do

1. **Per-host serialization + honor `Crawl-delay: 5` on arrl.org.** Never parallelize within a host.
2. **Nightly, not hourly.** Nothing in this corpus changes faster than weekly, and most change 3–4 times a year.
3. **Descriptive User-Agent with a contact URL.** You are a hobbyist app polling ~25 small nonprofits; be identifiable.
4. **Change detection by normalized content hash, not headers.** arrl.org serves `Cache-Control: nocache` with **no ETag and no Last-Modified** (Apache 2.2.15/CentOS), and its `sitemap.xml` has **every `<lastmod>` frozen at 2010** — actively misleading. Hash the *parsed entries*, not the raw HTML (nav/footer churn will false-positive).
5. **Domain blocklist enforced at the fetcher layer**, not in config: `farweb.org`, plus every aggregator in §4.1.
6. **Deep-link out to commercial aggregators; never store their text.**
7. **Prefer the Grants.gov daily XML extract over API pagination** for bulk work — sidesteps any undocumented rate limiting. No rate limits are published for Grants.gov, NSF, or USAspending (and none were hit across ~25 live calls), but absence of documentation is not absence of limits: implement exponential backoff anyway. Simpler.Grants.gov confirms 429s exist with no published number.
8. **Tolerate empty windows.** grants.austinhams.org legitimately shows "No opportunities available" between Aug 1 and Apr 30. An empty scrape is not a failure.

---

## 5. AI policy findings

### 5.1 What funders actually say

**The structural fact that most secondary coverage gets wrong: policies are far stricter on REVIEWERS than on APPLICANTS.** Reviewer prohibitions are flat (confidentiality logic). Applicant rules are disclosure-encouragement plus an originality/misconduct backstop. **No funder found prohibits applicants from using AI.**

| Funder | Position on applicants | Citation |
|---|---|---|
| **NSF** | *"Proposers are **encouraged** to indicate in the project description the extent to which, if any, generative AI technology was used."* Encouraged, not required. Proposers own accuracy/authenticity; misconduct definition covers misconduct committed via AI tools. Reviewers: **prohibited** from uploading proposal content to non-approved tools ("considered to be entering the public domain") | https://www.nsf.gov/policies/ai/merit-review (issued 2023-12-14, page updated 2026-05-21) |
| **NIH** | *"NIH will not consider applications that are either **substantially developed by AI**, or contain sections substantially developed by AI, to be original ideas of applicants."* **There is no NIH AI-disclosure form field and no formal disclosure requirement** — the enforceable hook is originality + research misconduct | NOT-OD-25-132, 2025-07-17 |
| **NIH** (reviewers) | Flat prohibition on LLMs "for analyzing and formulating peer review critiques"; extends to Advisory Council members | NOT-OD-23-149, 2023-06-23 |
| **NIH / ORI** | *"Clearly describe in applications … the use of the AI tools and how they may have been used."* Enumerates the misconduct patterns: fabricated data, wholly AI-generated applications with inaccurate information, **non-existent AI-generated references**, unattributed copying | Extramural Nexus, 2026-05-14 |
| **ARDC** ⭐ | **The most relevant policy for this app's users, and it is permission plus a diagnosis:** *"If you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity, and accuracy. **If the proposal is extremely long and hard to understand, we can't evaluate or support it.**"* ARDC's stated concern is not ethics — it's **bloat** | https://www.ardc.net/apply/grant-application-instructions/ |
| **Spencer Foundation** | Most granular. Use permitted, but **disclosure is MANDATORY**: *"Applicants and grantees must disclose the use of generative AI"* with "a brief summary of how and where". *"may not submit verbatim drafts of content generated by AI."* Applicants "held accountable even in the case of unintentional plagiarism." Reviewers barred, on pain of losing both reviewing and applying privileges | https://www.spencer.org/resources/policy-on-the-use-of-generative-ai-at-the-spencer-foundation |
| **Wenner-Gren** | *"While use is not prohibited, responsibility for the originality and accuracy of content rests entirely with the applicant."* Disclosure encouraged in a confidential section. Reviewers: *"Uploading application materials to any Generative AI platform is strictly forbidden."* | https://wennergren.org/article/the-wenner-gren-foundation-generative-ai-policy/ |
| **ARRL Foundation** | ⚠️ **Unaddressed.** The Club Grant page and the Grant Application Form PDF were both read in full — zero mentions of AI, ChatGPT, or LLMs. (Caveat: the Kaleidoscope portal is a JS SPA; terms inside it are unchecked) | https://www.arrl.org/files/file/Foundation/Grant%20Application%20Form.pdf |
| **Grant Professionals Association** | *"the tool itself is not unethical. However, the application/use of the tool creates potential ethical dilemmas."* Three hooks: confidentiality (know retention terms), accuracy (verify sources — "documented instances … generated responses with inaccurate and/or outdated information including fabricated sources"), plagiarism (cite AI-provided language) | GPA Board, 2023-06-09 (PDF on cdn.ymaws.com) |

**Product implication:** a one-sentence AI-use disclosure costs nothing and is affirmatively welcomed by NSF, Spencer, and Wenner-Gren. **Ship a disclosure-sentence generator, default-on, editable.** And every policy makes the *human applicant* — never the tool — accountable for every number, claim, and citation. Any draft feature must therefore surface a **fact-checklist of every factual assertion** for human confirmation before export.

### 5.2 What makes proposal prose specific vs. generic — actionable prompt guidance

**The evidence.** Kobak et al. (*Science Advances* 2025, DOI 10.1126/sciadv.adt3813; arXiv 2406.07016; word lists at github.com/berenslab/llm-excess-vocab) analyzed >15M PubMed abstracts 2010–2024 and found 379 "excess vocabulary" words in 2024, implying ≥13.5% of 2024 abstracts were LLM-processed. **The finding that matters is not the word list — it's the grammar of the shift:**

- 2024 excess vocabulary: **66% verbs, 14% adjectives** — "almost entirely style words."
- Covid-era (2020–22) excess vocabulary: **79.2% nouns**, "almost entirely content words (respiratory, remdesivir)."

> **A real event changes the NOUNS in your prose. An LLM changes the VERBS AND ADJECTIVES.** If a paragraph's distinctive words are all doing tone work rather than reference work, it is generic — regardless of who wrote it.

Highest-ratio markers: *delves* (28.0×), *underscores* (13.8×), *showcasing* (10.7×). Highest absolute excess: *potential*, *findings*, *crucial*. Also flagged: *across, additionally, comprehensive, enhancing, exhibited, insights, notably, particularly, within*.

**Do NOT turn this into a blacklist.** These are ordinary English words. The signal is **density plus the absence of counterweight** — style words with no proper nouns, numbers, or dates near them.

**The three failure modes, each with a mechanism and a fix:**

| Failure mode | Mechanism | Fix (encode as a prompt rule) |
|---|---|---|
| **Abstraction substituted for actors** | Helen Sword's "zombie nouns" — nominalizations that "cannibalize active verbs … and substitute abstract entities for human beings." Orwell's "verbal false limbs." *"The implementation of an educational outreach initiative"* has no one in it | **Every sentence in the activities/methods section must have a named human or named organization as its grammatical subject.** "Three of our members will teach a Saturday class" |
| **Prefabricated phrasing** | Orwell: prose "consists less and less of words chosen for the sake of their meaning, and more of phrases tacked together like the sections of a prefabricated hen-house." Stock openers ("In today's rapidly evolving landscape"), stock transitions (Furthermore/Moreover/Additionally/It is important to note that), stock closers ("ensuring long-term impact for years to come") | **Ban the transition-word class outright in the system prompt.** None of these carry information; all are free to produce, which is exactly why they appear |
| **Uniform rhythm** | Low sentence-length variance; repetitive clause architecture — especially the trailing participial tail (*", ensuring that…"*, *", allowing us to…"*, *", thereby fostering…"*) and the compulsive tricolon (*"educate, empower, and inspire"*) | **Hard cap: ≤1 trailing participial clause per paragraph; ≤1 tricolon per document.** Enforce sentence-length variance |

**Positive rules to encode (the specificity anchors):**

1. **Force proper nouns.** Callsigns (W8UM, K5UTD), club names, model numbers (IC-7610, DR-2X), place names, named people with roles. A paragraph with zero proper nouns is a red flag.
2. **Force numbers and dates.** Headcounts, dollar line items, dates, frequencies, distances. Every claim of scale needs a figure.
3. **Force the nouns to carry the information.** If you delete every adjective and adverb and the paragraph still says what will happen, it's specific. If it collapses, it's tone.
4. **Interview before drafting.** The app must not let the user skip to "generate." Ask for: who specifically does the work, what specifically breaks today, what specifically changes, what the money buys line by line. **Missing answers must produce `[TODO: …]` placeholders, never plausible filler** — fabricated specifics are exactly the NIH/ORI misconduct pattern.
5. **Optimize for brevity, explicitly, because ARDC says so.** ARDC: "We want you to be thorough, but please keep your application brief"; "Avoid unnecessary jargon." Make word-count-down a first-class editing pass, not an afterthought.
6. **Never generate a citation, statistic, or URL the user did not supply.** Flag every one for verification. This is the single highest-consequence rule.

---

## 6. Top 5 risks for this app

**1. The addressable corpus is ~150 records and two funders own most of it.**
ARDC and the ARRL Foundation are effectively the entire US ham funding market — and **ARDC underwrites ARRL's club grants, scholarships, and Teachers Institute** ($2.1M/3yr announced Dec 2023). That is not two legs, it is one leg with a splint. If ARDC redirects funding or redesigns its site, the app loses most of its value simultaneously in both places. Meanwhile the premise categories are thinner than they look: **CARI is not funding, AMSAT has no grants program, FlexRadio has no education tier, Icom/DX Engineering/Kenwood have no application path at all.** Do not build browsable UI categories that will render empty.

**2. "Auto-discovery" is largely a fiction here, and building for it will misallocate the whole engineering budget.**
Exactly **one** ham-relevant source (ARDC) has a real API. The federal side has excellent APIs and near-zero ham signal — `"amateur radio"` returns 57 Grants.gov hits, `"cubesat"` returns **1**, and the genuinely winnable federal money is *adjacent* (NSF geospace/ECCS/ATE/Noyce, NASA Space Grant, NTIA PWSCIF) requiring an adjacency-vocabulary scorer, not a keyword match. **This app is a curated database with a change-detection layer, not a crawler.** Price it that way: ~25 hand-seeded sources, nightly hash-diff, a human triage queue.

**3. Stale deadlines are the primary product failure mode, and the corpus is hostile to change detection.**
arrl.org has **no ETag, no Last-Modified, `Cache-Control: nocache`, and sitemap `<lastmod>` frozen at 2010**. Application portals (Kaleidoscope, grants.ardc.net, NTIA's Salesforce) are all SPAs that return zero server-side text — **you cannot determine open/closed status programmatically for the single most collegiate-relevant ARRL program.** Concretely, right now: three researchers gave three different answers for the ARRL Club Grant cycle (dormant / spring-launched / Feb-Jun-Oct), and the Feb/Jun/Oct answer is probably a conflation with the separate Amateur Radio Grants program. Search-engine snippets in this space are months stale (the "Copeland March 25, 2026" result contradicts the live page's May 1–Jul 31). **Ship `lastVerifiedAt` and `status: unknown` as visible UI states, and treat any deadline older than 90 days as unverified.** An app that confidently shows a wrong deadline is worse than no app.

**4. The legal perimeter is sharp, explicitly names ClaudeBot, and extends to LLM use — not just crawling.**
Candid's license bans AI/ML use of its data **and survives termination**. GrantWatch bans automated access and states it authorizes no API. GrantStation bans LLM training. Instrumentl's robots.txt names `anthropic-ai`/`ClaudeBot`/`Claude-Web` and disallows `/grants` and `/foundations`. This is not a gray area for an LLM-in-the-loop product. Separately: **farweb.org now serves an Indonesian gambling site**, and QCWA/ARRL/club pages still tell applicants to "apply at the FAR website" — an unguarded pipeline will walk a student into it. Hard-blocklist at the fetcher layer, and prefer IRS/GivingTuesday (public domain) over ProPublica for anything you mirror.

**5. The two most reliably-winnable funding sources are the two you cannot aggregate.**
Campus SGA/student-activity-fee money (~4,000 campuses, heterogeneous Qualtrics/CampusGroups/Presence/Engage forms) and NASA State Space Grant (52 independent consortium calendars) are, per the research, where a typical collegiate club's money actually comes from — and neither is automatable at any scale. **If success is defined as "find me money," a human who emails their SGA beats this app.** The mitigation is to stop pretending these are feeds and ship them as *guided workflows*: a Space Grant consortium picker keyed to the user's state (52 curated links), and an SGA playbook that includes the trap FSU exposed — **capital equipment is often barred by student-activity-fee rules, so radios must be framed as programming or funded externally.** That framing advice may be worth more than the entire opportunity index.