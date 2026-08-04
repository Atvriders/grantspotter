# GrantSpotter

A self-hosted funding desk for collegiate and educational amateur radio. One Docker image, one
SQLite file, port **3030** by default, and no external service required to run it.

It answers four questions for a club officer, a faculty advisor or a student:

1. What funding exists that I am actually eligible for?
2. When is it due, and when do I have to start?
3. What do I write, and what does this particular funder care about?
4. Has anything changed since I last looked?

---

## What this is

**GrantSpotter is a curated database with a change-detection layer, not a spider.**

That sentence is the design, and every number below is the reason for it. Measured against the
committed fixtures by `npm run profile-corpus`:

| Measure | Value |
|---|---|
| Publishable programme records | **150 records** |
| From one page — `arrl.org/scholarship-descriptions` | **111 of the 150**, roughly **three-quarters** (74%) |
| Ham-relevant sources exposing a real API | **exactly one** — ARDC's WordPress REST endpoint |
| Curated sources polled | ~25 (27 registered modules, one of them signal-only) |
| Funders | 26 |
| Records stored but never published | **553** |

The federal APIs are excellent and nearly ham-free: `"amateur radio"` returns 57 Grants.gov hits
and `"cubesat"` returns one. So GrantSpotter re-reads about 25 hand-curated sources nightly, hashes
the *parsed entries* rather than the raw HTML, and puts every change in front of a human before it
is published. It does not crawl the open web, and it does not pretend "auto-discovery" would find
anything if it did.

The 553 hidden records are real data that is not an opportunity: **past awards** already handed out
(ARDC's award tables, the ~37 previously funded ARRL clubs, NSF and USAspending award rows) plus one
stale cross-check page. A funder's grant history is good evidence about who that funder funds, so it
is stored and queryable, and it is never shown as something you can apply for. One predicate,
`isDoNotPublish`, is the only implementation of that boundary; every export and every read path
calls it.

### What it is not

- Not a general grant search engine.
- Not a submission portal. Every funder's intake is their own — Kaleidoscope, Jotform,
  email-a-PDF. GrantSpotter deep-links out and never proxies a submission.
- Not an AI writing service. It **does not draft** your application. See
  [The AI feature, described accurately](#the-ai-feature-described-accurately).
- Not a mirror of commercial aggregators. See [the blocklist](#the-blocklist-and-why-each-host-is-on-it).
- Not a verifier. It cannot tell you a funder's page still says what it said. It quotes captures
  and tells you which page each value came from.

---

## The failure mode this app is designed around

An app that confidently shows a wrong deadline is worse than no app. `arrl.org` serves
`Cache-Control: nocache` with **no ETag and no Last-Modified**, and every `<lastmod>` in its sitemap
is frozen at 2010. Application portals are JavaScript apps that return zero server-side text, so
open/closed status often cannot be determined at all.

The countermeasures are visible in the UI, not buried in the code:

- **`lastVerifiedAt` on every record.** Older than 90 days renders amber, with a one-click
  **Verify now** that refetches and shows the diff.
- **`status: unknown` is a rendered state**, never a blank field.
- **Field-level provenance**: which source, which fetch, and the raw text a value came from.
- **`disputed`**, and it ships populated. Three researchers reached three different conclusions
  about the **ARRL Club Grant** cycle on the same day — dormant, an autumn window, or a
  February/June/October pattern that is probably a conflation with the separate Amateur Radio
  Grants windows. The record shows all three with their sources instead of picking one.
- **Stale-mirror warnings** where a third-party aggregator is known to list something that no
  longer exists.

---

## Verified negatives — things that look like funding and are not

Each was checked by live fetch during the 2026-08-02 research pass, and each ships as an explicit
record, so searching for it returns the finding rather than an empty list.

| Thing | Finding |
|---|---|
| ARRL **CARI** | Not a funding program. Meetups, a QSO party, Hamvention networking. |
| **AMSAT** | No grants program. It is a grant *recipient*, via ARISS and ARDC. |
| **FlexRadio** | No education, student, club or nonprofit purchasing tier exists. |
| **Icom** America, **DX Engineering**, Kenwood | Real equipment does reach collegiate clubs, but there is no application path, no page and no deadline. Relationship-driven only; ships as a playbook, not an opportunity. |
| **DARA / Hamvention** | A grantmaker only through its ARRL catalog entry. Its own sites have no scholarship page. |
| **Chicago FM Club** Scholarship | Discontinued — zero hits in the live ARRL catalog, yet still listed by seven or more third-party aggregators. |

## A safety note about FAR

The Foundation for Amateur Radio's domain is compromised: `farweb.org` 301-redirects to an
Indonesian gambling site, with the takeover pinned by the Internet Archive between 2025-10-17 and
2026-02-10. QCWA, ARRL and club pages still tell applicants to "apply at the FAR website".

`farweb.org` — and the redirect target itself — are **hard-blocklisted in the fetcher**, so no
crawl, no **Verify now** and no user-supplied URL can reach them. The seed corpus carries an
explicit warning record, so a student searching for "FAR" is told what happened rather than being
sent there. FAR's historical portfolio (10-10, QCWA, YASME, K3IVO, CARA) appears to have been
absorbed into the ARRL Foundation.

## The blocklist, and why each host is on it

Enforced inside the fetcher. It is **not configurable** — there is no environment variable, no
constructor option and no second list that can re-permit any host named here.

| Host | Reason |
|---|---|
| `farweb.org`, `batualam.org` | Compromised; redirects to a **gambling** site. |
| `candid.org`, `fconline.foundationcenter.org` | The licence prohibits republishing and prohibits use for "artificial intelligence, large language models, machine learning, or similar applications" — and that restriction **survives termination**. |
| `grantwatch.com` | "Automated access, including scripts, bots, or data scraping tools, is prohibited"; "We do not offer or authorize any API access". |
| `grantstation.com` | The EULA bans robots and spiders, and bans use for training large language models. |
| `instrumentl.com` | The ToS bans crawling, and `robots.txt` explicitly names `anthropic-ai`, `ClaudeBot` and `Claude-Web`, disallowing `/grants`, `/foundations` and `/990-report`. |

We deep-link out to the commercial aggregators where they are genuinely useful to a human. We never
store their text.

Separately, five sites deliberately block non-browser clients — `yasme.org`, `ncdxf.org`,
`radioclubofamerica.org`, `mga.ieee.org` (HTTP 418) and `k9ona.com`. **We do not spoof a user agent
to get around them.** Each is worth one or two records that a human curates in five minutes and
re-verifies quarterly.

## Polite crawling

- Per-host serialisation. Never parallel within a host.
- `robots.txt` honoured, including `Crawl-delay: 5` on arrl.org.
- A descriptive User-Agent naming the app and your `CONTACT_URL`.
- Exponential backoff. No rate limits are published for Grants.gov, NSF or USAspending, but absence
  of documentation is not absence of limits.
- Nightly, jittered. Nothing here changes faster than weekly, and most sources change three or four
  times a year.
- An empty scrape is not a failure: `grants.austinhams.org` legitimately shows "No opportunities
  available" between 1 August and 30 April.

---

## Writing tools

| Ships | Count |
|---|---|
| Application **13 components** — need statement, project description, measurable outcomes, activities and timeline, budget and justification, sustainability, evaluation plan, organisational capacity, letter of inquiry, scholarship personal essay, recommendation-request email, thank-you letter, interim/final report | 13 |
| **Nine funder overlays** written against published criteria — ARDC, ARRL Amateur Radio Grants, ARRL Club Grant, ARRL Foundation Scholarships, ARISS, IEEE MTT-S, Yaesu DR-2X, **Campus SGA playbook**, **NASA State Space Grant picker** | 9 |
| Offline prose analyser, AI prompt composer, fact checklist | — |

Templates are markdown with frontmatter and typed slots (`{{club.callsign}}`,
`{{project.budgetTotal}}`), filled from your profile where known. An unknown slot renders as an
explicit `[TODO: …]` and never as plausible filler.

Two overlays are guided workflows rather than opportunity records, because the money behind them
cannot be aggregated at any scale: campus student government (roughly 4,000 independent campuses)
and NASA State Space Grant (**52** independent consortium calendars, no national deadline). Per the
research behind this app, that is where a typical collegiate club's money actually comes from. The
SGA playbook carries the trap Florida State's published rules expose — *student-activity-fee rules
frequently bar capital equipment, so a radio has to be framed as programming or funded from
outside*. That framing advice may be worth more than the entire opportunity index.

**The shipped NASA consortium list is unverified.** The 52 names were curated offline and have not
been confirmed by a live fetch, so they carry the amber unverified treatment, and no website,
deadline, award size or eligibility rule is recorded for any consortium.

### The fact checklist, and what it cannot do

Before an application draft can be exported, GrantSpotter lists every factual assertion it detected
— figures, dates, names, callsigns, citations, URLs — for explicit human confirmation. The gate is
enforced on the server, so a direct `POST` cannot skip it, and an unresolved `[TODO: …]` blocks the
export too. Every funder policy reviewed makes the human applicant, never the tool, accountable for
each number in the document; this is that rule expressed as code.

It **cannot list** a claim made only in words: a superlative such as "the only collegiate club in
the state", a universal such as "every member is licensed", a causal claim such as "attendance rose
after we bought the radio", or the role in "Elena Ruiz, faculty advisor". Those are yours to check.
A ticked checklist is not a checked draft.

## The AI feature, described accurately

**The server does not draft your application.** There is no "generate my proposal" button and it
never writes a narrative.

What exists is a prompt composer. The button reads
**`Copy AI Prompt — includes AI-detection avoidance`**. It assembles a prompt from the funder's real
criteria, restrictions and obligations, the funder's own quoted AI policy with its source URL, and
your profile facts — and *you* run it in your own assistant.

**It does not defeat AI detectors, and the prompt says so in its own words:**

> Nothing in this brief will make an AI-detection classifier report "human", no claim of that kind
> is made anywhere in it, and no such claim should be made on its behalf.

The technique is forcing **specificity**. It is grounded in Kobak et al., *Science Advances* 2025
(DOI 10.1126/sciadv.adt3813), which found that 2024's excess vocabulary across 15M PubMed abstracts
was **66% verbs** and 14% adjectives — style words — where Covid-era excess vocabulary was
**79% nouns**, content words. A real event changes the nouns in your prose; an LLM changes the verbs
and adjectives. So the ruleset forces proper nouns, figures and named human subjects, caps trailing
participial clauses and tricolons, runs a brevity pass, and refuses to generate any citation,
statistic or URL you did not supply. Synonym-swapping, injected typos and invisible characters are
deliberately excluded: they degrade prose, and a reviewer notices bad writing faster than a
classifier notices AI.

There is also an **offline prose check** that needs no API key: paste a draft and get a per-paragraph
report on style-word density against proper-noun and figure density, stock transitions, tricolons,
trailing participials and sentence-length variance. It reports *why* a passage reads generic and
where, rather than emitting a score.

On the funders: **no funder found prohibits applicants from using AI.** Policies are far stricter on
reviewers than on applicants. NSF *encourages* disclosure, Spencer *requires* it, ARDC permits it
and names **bloat** as the risk ("If the proposal is extremely long and hard to understand, we can't
evaluate or support it"), and the ARRL Foundation has not addressed it at all. Each programme's
`aiPolicy` is shown next to the prompt button with the quote and the URL, and an editable
one-sentence AI-use disclosure is generated by default.

**Server-side AI is optional.** With no `ANTHROPIC_API_KEY`, everything works: deterministic
parsers, rule-based scoring and the copy-prompt flow. If a key is present, the crawler additionally
uses it to parse messy pages and pre-score review-queue items. It is never required, it is
**never on the read path**, and it never drafts a narrative.

---

## Exports

| Export | Format |
|---|---|
| Filtered opportunity list | CSV, XLSX (with a Provenance sheet) |
| Deadlines | a subscribable **ICS feed** at a per-user token URL, plus a one-off `.ics` |
| Application draft | DOCX and Markdown |
| Application packet | ZIP: draft, budget worksheet, requirements checklist, source links |
| Opportunity brief / eligibility report | print stylesheet → your browser's Save as PDF |
| Eligibility report | CSV — "here is what I am eligible for, and why not for the rest" |
| Full backup | JSON, admin only, restoreable |

Every row has a control: **Exports** in the left rail for the corpus, the calendar and the
eligibility report; an export row on **Browse** for the filtered view you are looking at; DOCX,
Markdown and ZIP on an open draft under **Applications**; **Print brief** on any opportunity; and
backup/restore under **Admin**. The three draft exports are gated by the fact checklist above.

**About the calendar.** The corpus yields **243** dated cycles over 18 months, and only
**4 of the 243** are dates a funder has actually published (ARISS 2026-07-01..09-30, Yaesu
2026-08-31 and two federal NOFOs). The other 239 are this pipeline's **projection** from a
recurrence rule. Every
projected event is marked four ways in the file — an "(estimated)" title prefix, a tentative status,
a custom property and a note in the description — so nothing in your calendar reads as a promise the
funder made. The feed is the useful one: a one-off `.ics` is a snapshot that rots the moment a
funder moves a date, whereas a token URL your phone re-reads every twelve hours is what actually
stops you missing a deadline. Only a hash of the token is stored, and you can revoke it.

**PDF is your browser's own Print / Save as PDF** against a designed `@media print` stylesheet.
There is deliberately **no headless Chromium in the image**: it would add roughly **400 MB**, needs
a second supervised process, and its arm64 build under emulation is a recurring CI failure.

## Accounts

Local accounts, argon2id password hashing, httpOnly session cookies. First-run admin bootstrap
prints a one-time token to the container log. No public signup by default, and login is
rate-limited.

| Capability | admin | member |
|---|---|---|
| Browse, match, calendar, watchlist, applications, exports | yes | yes |
| Verify now on a single record | yes | yes, rate-limited |
| Review queue: approve / reject / edit | yes | read-only |
| Source configuration, crawl trigger, sources health | yes | read-only |
| User management, JSON backup and restore | yes | no |

Members see the review queue read-only on purpose: knowing that a deadline change is *pending
review* is useful, and hiding it invites the "why is this list wrong" complaint the trust surfaces
exist to prevent.

---

## Deploying

The image is built by GitHub Actions for `linux/amd64` and `linux/arm64` and published to
`ghcr.io/atvriders/grantspotter:latest`. The repository and the package are public.

```bash
cp .env.example .env
# fill in SESSION_SECRET and CONTACT_URL — neither has a default
docker compose pull
docker compose up -d
```

Then open `http://127.0.0.1:3030` (or whatever you set `HOST_PORT` to) and read the container log
for the one-time admin bootstrap token.

`HOST_PORT` is a variable because **3030** is a popular default and is frequently already claimed on
a busy host. Change it in `.env`, never in `docker-compose.yml`.

**CI note:** a freshly created or forked repository sometimes will not run its first push-triggered
workflow. The build workflow includes `workflow_dispatch` for exactly that case — trigger it once by
hand from the Actions tab, and subsequent pushes behave normally.

### Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `HOST_PORT` | no | `3030` | compose host port only |
| `PORT` | no | `3030` | in-container listen port |
| `SESSION_SECRET` | **yes** | **no default** | at least **32 characters**; the server refuses to start without it |
| `CONTACT_URL` | **yes** | **no default** | an `http(s)` URL; goes in the crawler User-Agent |
| `DATA_DIR` | no | `/data` | SQLite, snapshots, fixture cache |
| `CRAWL_ENABLED` | no | `true` | |
| `CRAWL_CRON` | no | `17 3 * * *` | nightly, jittered in code |
| `ANTHROPIC_API_KEY` | no | none | optional parse assist only |
| `SIMPLER_GRANTS_API_KEY` | no | none | optional federal ranking |

Both required variables fail loudly on startup, and that is deliberate:

- **`SESSION_SECRET` has no default because a shipped default session secret is a shared secret,
  which is not a secret.** Generate one with `openssl rand -hex 32`.
- **`CONTACT_URL` has no default because an anonymous crawler is one nobody can ask to stop.** It
  goes into the crawler's User-Agent. Most of the ~25 sources this polls are small, volunteer-run
  organisations — club sites, a foundation run by retirees, a scholarship page maintained by one
  person — and they should be able to see who is polling them and get in touch. Use a page you
  control, for example `https://www.example.org/grantspotter`.

---

## Development

```bash
npm ci
npm run dev            # server plus Vite
npm run typecheck
npm run build
npm test               # unit and integration, no network
npm run test:e2e       # Playwright
npm run profile-corpus # print the corpus profile the numbers above come from
npm run verify-sources # LIVE, warn-only, never a CI gate
npm run seed:arrl      # regenerate the ARRL catalog seed from the committed fixture
```

Every source parser is tested against committed real payloads under `fixtures/`. All of them verify
with zero network access, and refreshing a fixture is a deliberate, reviewable act rather than
silent drift. `verify-sources` is the only thing that touches the live network, and it never gates a
build.

Captured fixtures are redacted: contact emails and phone numbers found in real pages were replaced
before they were committed. There are no real LAN addresses, hostnames or host paths anywhere in
this repository — placeholders and documentation ranges only.

## Data and licensing

The seed corpus is **structured facts plus short excerpts**: funder, programme, amounts, deadlines,
eligibility axes, obligations, source URL, `lastVerifiedAt` and provenance. Facts are not
copyrightable; long verbatim descriptions are a different matter, so there are no page dumps here.
Every record links back to its source and re-verifies through the normal pipeline.

Code is MIT licensed. See [`LICENSE`](LICENSE).
