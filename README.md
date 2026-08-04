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

**What a fresh install actually contains is smaller than that, and the difference is not a bug.**
The table above measures the committed fixtures — every page ever captured, past-award tables
included. What ships in the container is the curated seed, and a first boot prints exactly what it
imported. Measured on a clean `DATA_DIR` at 0.1.0: **143 programmes (143 publishable, 0 suppressed)
from 26 funders**, 111 of them from `arrl.org/scholarship-descriptions`, and **7 of the 143 badged
open** — the rest are `closed`, `contact_only`, `dormant`, `discontinued`, `no_application` or
`unknown`, inherited from the funder's own page. The 553 suppressed rows arrive with the first
crawl that reads a past-award table, not with the seed, so a new installation has none of them.

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
- `robots.txt` honoured, including `Crawl-delay: 5` on arrl.org. The agent token is
  `GrantSpotter`, so any site can stop any deployment of this with `User-agent: GrantSpotter` and
  `Disallow: /`.
- A User-Agent that says what this is and how to reach a human, in words rather than by the `+URL`
  convention alone. A deployment that has not set `CONTACT_URL` sends, on every request:

  ```
  GrantSpotter/0.1.0 (+https://github.com/Atvriders/grantspotter/issues; nightly grant-deadline change detector; open an issue there to contact the maintainers)
  ```

  Set `CONTACT_URL` to an address of your own and that clause becomes *contact the operator at that
  page* — the instruction always matches the URL beside it. [Environment](#environment) says when
  you should.
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
| Deadlines | a subscribable **ICS feed** at a per-user token URL — two URLs, one for every deadline and one for your watchlist — plus a one-off `.ics` |
| Application draft | DOCX and Markdown |
| Application packet | ZIP: draft, budget worksheet, requirements checklist, source links |
| Opportunity brief / eligibility report | print stylesheet → your browser's Save as PDF |
| Eligibility report | CSV — "here is what I am eligible for, and why not for the rest" |
| Full backup | JSON, admin only, restoreable |

Every row has a control: **Exports** in the left rail for the corpus, the calendar and the
eligibility report; an export row on **Browse** for the filtered view you are looking at; DOCX,
Markdown and ZIP on an open draft under **Applications**; **Print brief** on any opportunity; and
backup/restore under **Admin**. The three draft exports are gated by the fact checklist above.

**About the calendar.** Almost every dated event in this corpus is this pipeline's **projection**
from a recurrence rule, not a date a funder published. Exactly three seed records declare a window
their funder actually printed — ARISS, Yaesu, and an ARRL window that has since closed — and how
many of those still resolve into a future cycle depends on the day you ask, which is why no count
is quoted here. (An earlier version of this paragraph quoted one, and it was wrong three ways: it
named "two federal NOFOs" that do not exist, its total drifted with the clock, and its ratio was
measured against a corpus that is not the one you install.) Every
projected event is marked four ways in the file — an "(estimated)" title prefix, a tentative status,
a custom property and a note in the description — so nothing in your calendar reads as a promise the
funder made. The feed is the useful one: a one-off `.ics` is a snapshot that rots the moment a
funder moves a date, whereas a token URL your phone re-reads every twelve hours is what actually
stops you missing a deadline. Only a hash of the token is stored, and you can revoke it.

**Two feed URLs, and each one always means the same thing.** The plain token URL carries every
publishable deadline, however long your watchlist gets; the same URL with `?watched=1` carries only
the programmes you have starred, and an empty watchlist there means an empty calendar rather than a
silent fallback to everything. That separation is deliberate and was a bug first: the feed used to
infer its scope from whether your watchlist happened to be empty, so starring a single opportunity
silently cut a live subscription from every deadline down to one — remotely, days later, in a
calendar app, with nothing on screen to explain it.

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

There is one file and nothing to copy. Open `docker-compose.yml`, replace the one value marked
`EDIT THIS`, and bring it up:

```bash
# in docker-compose.yml, under environment:
#   SESSION_SECRET: <the output of `openssl rand -hex 32`>
docker compose pull
docker compose up -d
```

`SESSION_SECRET` ships as a placeholder containing `CHANGE_ME`, and **the server refuses to start
while it is still there**, saying what it found and what to do about it. That refusal is not
politeness: this repository is public, so a placeholder session secret left in place would be a
signing key everyone can read, and it is enforced by value in `packages/server/src/config.ts`
rather than by the compose file, because the compose file is the thing being shipped.

`CONTACT_URL` used to be a second must-edit value and is not one now — it defaults to this
project's issue tracker, which is enough to get you running. If you are deploying anything more
than a personal instance, read the note under [Environment](#environment) before you leave it
alone: the default identifies the *software*, not *you*.

Then read the container log for the one-time admin bootstrap token. There is still no sign-up form
for the public, but there **is** a first-run screen: open the app and, because no accounts exist yet,
it offers **Set up GrantSpotter** instead of a sign-in box, asking for that token, an email address
and a password of at least 12 characters. On success you are signed in as an administrator. There
is no password reset for the first administrator, so store it somewhere you can find it again.

If you would rather do it over the API:

```bash
# Brackets the banner by its own `====` delimiters rather than counting lines: this printed
# nothing useful for a while, because it was `grep -A4` and the banner had grown past four.
docker compose logs grantspotter | awk '/GrantSpotter first-run setup/,/====$/'
curl -X POST http://127.0.0.1:3030/api/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"token":"<the token from the log>","email":"you@example.org","password":"<a long passphrase>"}'
```

A fresh token is printed on every restart until an account exists. Now open
`http://127.0.0.1:3030` (or whatever you set `HOST_PORT` to) and sign in with those credentials;
every further account is created from **Admin → User accounts**.

`HOST_PORT` is the one setting still interpolated rather than written out, because **3030** is a
popular default and is frequently already claimed on a busy host. Change the left-hand number of the
`ports:` mapping in `docker-compose.yml`, or set `HOST_PORT` in the environment
(`HOST_PORT=8080 docker compose up -d`) if you would rather not touch a tracked file. It has a
default, so it can never stop the stack from starting.

If you are upgrading from a version of this repository that had you copy an example file to `.env`:
that example file no longer exists. Compose still reads a `.env` beside the compose file, and
`HOST_PORT` still comes from it — but a literal in `docker-compose.yml` beats it, so the
`SESSION_SECRET` in your old `.env` is now ignored and the server will refuse to start until you
paste it into `docker-compose.yml`.

**If you keep your copy of this repository under git — a fork you push — note what that means for
the file you just pasted a secret into.** `docker-compose.yml` is tracked and is not in
`.gitignore`; a `git add -A && git push` publishes your session secret, which is the same accident
the placeholder refusal exists to prevent, arriving from the other direction. Deploying from an
untracked download, or from a clone you never push, and it does not arise. If it does, the escape
hatch is the `.env` that is still ignored: change the `SESSION_SECRET:` line so the value is
interpolated from the environment — written exactly the way the `HOST_PORT` line above it is
written — and keep the secret in `.env` beside the compose file. That is the two-file arrangement
this layout was meant to be rid of, so it is the answer for a tracked fork rather than the default.

**CI note:** a freshly created or forked repository sometimes will not run its first push-triggered
workflow. The build workflow includes `workflow_dispatch` for exactly that case — trigger it once by
hand from the Actions tab, and subsequent pushes behave normally.

### Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `HOST_PORT` | no | `3030` | compose host port only; the only interpolated value left |
| `PORT` | no | `3030` | in-container listen port |
| `SESSION_SECRET` | **yes** | **no default** | at least **32 characters**; the server refuses to start without it, and refuses the shipped `CHANGE_ME` placeholder by value |
| `CONTACT_URL` | no | `https://github.com/Atvriders/grantspotter/issues` | an `http(s)` URL; goes in the crawler User-Agent. The default reaches this project's maintainers, **not you** — see below for when to override it. A `CHANGE_ME` value or a reserved documentation domain is still refused by value |
| `DATA_DIR` | no | `/data` | SQLite, snapshots, fixture cache |
| `CRAWL_ENABLED` | no | `true` | |
| `CRAWL_CRON` | no | `17 3 * * *` | nightly, jittered in code |
| `ANTHROPIC_API_KEY` | no | none | optional parse assist only |
| `SIMPLER_GRANTS_API_KEY` | no | none | optional federal ranking |

One variable fails loudly on startup, and one carries a caveat rather than a requirement:

- **`SESSION_SECRET` has no default because a shipped default session secret is a shared secret,
  which is not a secret.** Generate one with `openssl rand -hex 32`. The value in
  `docker-compose.yml` is a placeholder that the server rejects on sight — including if you paste
  yours *beside* it rather than over it, and including if you delete the `CHANGE_ME_` prefix and
  leave the rest, which is just as natural an edit and just as published. The rule is that no
  eight-character run of the shipped placeholder may appear in your value; `openssl rand -hex 32`
  emits `[0-9a-f]` only and the placeholder's longest all-hex run is two characters, so a secret
  generated that way can never trip it.
- **`CONTACT_URL` defaults to this project's issue tracker, which makes the crawler identifiable
  but not necessarily answerable.** Read both halves of that.

  It goes into the crawler's User-Agent. Most of the ~25 sources this polls are small,
  volunteer-run organisations — club sites, a foundation run by retirees, a scholarship page
  maintained by one person — and they should be able to see who is polling them and get in touch.
  With the default, they can: the software has a name, a public source tree and an issue tracker a
  human reads, and the User-Agent says so in words rather than leaving them to know the `+URL`
  convention.

  **What the default does not do is make your deployment answerable for itself.** Every deployment
  that keeps it points at the *same* tracker — this project's, not yours. A site owner who wants
  *your* instance in particular to stop polling them will reach maintainers who do not run it and
  cannot stop it. There is one remedy that works no matter who is running what, and it is
  `robots.txt`: every instance honours it, matched on the `GrantSpotter` token, so
  `User-agent: GrantSpotter` + `Disallow: /` stops all of them — with the caveat that an instance
  reads a given site's `robots.txt` once per server process, so a container that has been up for
  months acts on a new file at its next restart. That is the first thing
  [the issue template](.github/ISSUE_TEMPLATE/crawler-contact.md) tells an arriving site owner,
  before it asks them for anything.

  **Override it if a complaint should reach you rather than us** — you are running a modified fork,
  a large or long-running deployment, or an instance polling on behalf of an institution. Point it
  at an `http(s)` page you control and can be reached through. The reserved documentation domains
  are rejected (`example.com`, `example.net`, `example.org`, and the `.invalid`, `.test` and
  `.example` TLDs): they exist precisely so that they reach nobody, and a crawler identifying
  itself with one is anonymous while looking identified. A value still containing `CHANGE_ME` is
  rejected too — nobody has to edit this any more, but a half-finished edit is not an address.

  This variable used to be required with no default, on the reasoning that *an anonymous crawler is
  one nobody can ask to stop*. That was right about anonymity and wrong about the remedy: it made
  the first run of a self-hosted app depend on the operator inventing a contact page, and an
  operator who has none picks between finding one and pasting something that parses. The second is
  what happens, and it yields a plausible-looking address that reaches nobody — the exact failure
  the requirement existed to prevent, now wearing a name tag.

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

The Playwright suite boots two corpora, deliberately. Most specs run against the committed
fixtures — 703 records, 553 of them suppressed — which is the only corpus that can exercise the
suppression boundary, since the shipped seed contains nothing suppressed to leak.
`e2e/shippedSeed.spec.ts` additionally boots a second server on an empty `DATA_DIR`, so a browser
also opens what a fresh install actually gets: the shipped seed, its canonical ids such as
`/o/ardc-grants`, and a restart that imports nothing a second time. The two disagree on programme
ids by design, and only the second can test that the first-run import is idempotent.

Captured fixtures are redacted: contact emails and phone numbers found in real pages were replaced
before they were committed. There are no real LAN addresses, hostnames or host paths anywhere in
this repository — placeholders and documentation ranges only.

## Data and licensing

The seed corpus is **structured facts plus short excerpts**: funder, programme, amounts, deadlines,
eligibility axes, obligations, source URL, `lastVerifiedAt` and provenance. Facts are not
copyrightable; long verbatim descriptions are a different matter, so there are no page dumps here.
Every record links back to its source and re-verifies through the normal pipeline.

Code is MIT licensed. See [`LICENSE`](LICENSE).

## How this was built

GrantSpotter was written by **Claude Opus 5** (Anthropic), working from a spec and five
implementation plans in [`docs/superpowers/`](docs/superpowers/), directed by a human owner who set
the goals and the constraints and reviewed the result. Most of the work was carried out by parallel
subagents holding disjoint sets of files, with a separate adversarial reviewer for each change whose
instructions were to *refute* it rather than confirm it.

Measured over the whole build — one session, from the first sentence of the brief to the published
image:

| | |
|---|---|
| Wall clock | 38 h 42 m (2026-08-02 to 2026-08-04) |
| Commits | 230 |
| Assistant turns | 34,353 |
| Subagent transcripts | 290 |
| **Tokens written (output)** | **17,787,418** |
| Tokens processed, total | 4,913,894,439 |
| — of which prompt-cache reads | 4,766,093,732 (97.0%) |
| Tests at completion | 4,270 unit and integration, 35 end-to-end |

**Read those two token figures carefully, because one of them flatters.** The 17.8 million output
tokens are what was actually composed: code, tests, comments, commit messages, reports. The 4.91
billion is everything the model read *and re-read* — 97% of it is prompt-cache reads, the same
context handed back on each of 34,353 turns. Quoting the larger number alone would suggest roughly
275 times more writing than happened. This file argues elsewhere that a projected date must not be
dressed up as a published one; the same rule applies to a statistic about the project itself.

Both figures come from the session transcripts under `~/.claude/projects/`, summing
`message.usage` over the main loop and all 290 subagent files, counting each record's top-level
fields once and ignoring the `iterations` array that repeats them.

Unlike the corpus counts this README deliberately does **not** quote, these numbers describe a
finished event rather than live data, so they cannot drift: nothing that happens to the corpus, the
clock or the deployment can make them untrue.

What that effort mostly went on is worth knowing, because it is not the feature list. The recurring
work was finding places where a green test or a confident sentence was pointing at something untrue:
a suppression boundary that leaked seven separate times, each from one read path using its own
filter instead of the shared gate; a byte-identity proof that passed only because two runs landed
inside the same two-second timestamp tick; three redundant gates that made a fourth one's failure
invisible to every response-level test; a `npm run typecheck` that worked for a year only because
every checkout had a stale build directory; and a README assertion that *required* a false
statistic to stay on this page. Those are recorded where they happened, in the comments and commit
messages, on the theory that the reason a line exists is worth more than the line.
