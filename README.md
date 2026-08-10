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
| Records stored but never published | **553** |

<!--
  There was a "Funders | 26" row here, under a heading that says these figures are what
  `npm run profile-corpus` measures against the committed fixtures. That command prints no funder
  count at all — `npm run profile-corpus | grep -ci funder` returns 0 — and 26 is the SEED corpus's
  funder count, which is a different corpus. A true number filed under a false attribution is the
  same defect as a false number, because a reader who checks finds nothing where they were told to
  look. The seed figure is stated below, where the seed is what is being described.
-->


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
| `qrz.com` | Its Terms of Service forbid automated access **and** forbid storing what the database returns. Either half alone would rule it out. |
| `hamcall.net`, `buckmasterinternational.com` | HamCall's `robots.txt` names `ClaudeBot`, `Claude-Web` and `anthropic-ai` in turn and then closes with `User-agent: *` / `Disallow: /`. The second domain is the same operator, listed so that a redirect or a rebrand is not a way round a decision made about the operator. |

We deep-link out to the commercial aggregators where they are genuinely useful to a human. We never
store their text.

The last three are callsign directories rather than funding sites, and nothing in this software has
any reason to fetch them. They are on the list precisely because of that: GrantSpotter does look one
US callsign up when a person presses a button ([below](#the-callsign-lookup)), and the obvious next
idea is "add a second source for when the first is down". These are the second sources, each has
said no in writing, and a list is the only form of "no" that outlives the person who read it.

Separately, five sites deliberately block non-browser clients — `yasme.org`, `ncdxf.org`,
`radioclubofamerica.org`, `mga.ieee.org` (HTTP 418) and `k9ona.com`. **We do not spoof a user agent
to get around them.** Each is worth one or two records that a human curates in five minutes and
re-verifies quarterly.

## Polite crawling

- Per-host serialisation, **at least 1000 ms between requests to one host**, and the gate is
  entered once per **HTTP request** — first attempt, every retry, every redirect hop, and the
  `/robots.txt` read itself. That distinction is the whole of it: until 2026-08-04 the whole retry
  loop sat *inside* one gate slot, so a site answering `429 Retry-After: 0` was measured getting
  gaps of 2, 5 and 3 ms.
- **A `Retry-After` and the host interval compose by MAX; they never replace each other.** Ask for
  30 s and you get 30 s. Ask for 0 s and you still get the host interval. Publish a `Crawl-delay`
  and the longest of the three wins — nothing here adds two waits together, and nothing here lets a
  server talk us *below* our own floor.
- **One page fetch costs at most nine HTTP requests in total, the `/robots.txt` read included** —
  and *in total* now means what it says: to you, and to anywhere the chain is redirected to.
  Redirect hops, retries and the `robots.txt` read at each origin spend one shared budget rather
  than budgets that multiply, so a chain that redirects five times *and* fails at every hop costs
  nine requests and not 5 x 4 = 24. When the budget runs out we stop and skip the source for that
  run.

  **That bound has been wrong twice in the same way, and the second time was found after the first
  fix had shipped.** It was once *per origin*, so every scheme or port one machine answered on
  bought a fresh nine. It was then *per hostname*, so an apex that redirects to `www` — the
  commonest redirect there is — bought a fresh nine: **measured at 18 requests to one machine**, and
  the handover between the two names came 4 ms after the redirect against a 1000 ms floor. There is
  no third key that would have been right, because a URL does not say who owns what:
  `example.org` and `www.example.org` are two hostnames and one server almost always, while
  `alice.github.io` and `bob.github.io` are two strangers that any "registrable domain" rule
  computed without a public-suffix list would merge into one. Guessing wrong in that direction
  would throttle somebody who could never find out why. So the budget is not keyed by anything at
  all: **one fetch, nine requests, wherever they land.** A chain that crosses to somebody else's
  host spends the same nine instead of opening a second one — which can cost *us* a source for a
  night when a chain is long and troubled, and cannot cost a stranger a request.

  Here is the whole ceiling, per shape, with the command that measures each one **on your machine,
  against real sockets**:

  | one page fetch against… | requests | measure it yourself |
  |---|---|---|
  | one origin, `/robots.txt` and page both in distress | 9 | `npm run measure-pacing ceilingOneOrigin` |
  | `http://` redirecting to `https://` on one machine, over real TLS | 9 | `npm run measure-pacing schemeChange` |
  | five redirects across six origins of one machine | 9 | `npm run measure-pacing ceilingManyOrigins` |
  | an apex redirecting to `www`, both names in distress | 9 | `npm run measure-pacing twoNamesOneMachine` |
  | an apex redirecting to `www`, healthy | 4 | `npm run measure-pacing nameChangeHealthy` |
  | a page redirecting to another port, healthy | 4 | `npm run measure-pacing portChangeHealthy` |

  Every gap in every one of those runs was over a second. Before the two fixes the first four
  measured **18, 20, 63 and 18**; those figures were taken at commits `2c098d9` and `8ec9873` and
  **cannot be reproduced from this tree**, because the code that produced them is gone. The column
  above can be, by anyone, in about a minute each.

  That distinction is not pedantry, and it is here because this page got it wrong: the `20` was
  measured with a throwaway script and a self-signed certificate that was **never committed**, while
  both this file and the crawler-contact template said the figure was reproducible with
  `npm run measure-pacing`. The shipped harness could not speak https at all. It generates its own
  certificate now, so the claim and the capability arrive together.
- **A site that answers on more than one origin has its `robots.txt` read once per origin, and
  that is deliberate.** Rules are per origin: `https://www.example.org/robots.txt` says nothing
  about `http://` or about another port, so we have genuinely not read your rules for an origin
  until we ask that origin. A site publishing `Disallow: /` therefore costs **one request per
  origin we poll it under, per run**, not one flat. Today `www.arrl.org` is that case: of the eight
  ARRL URLs this software polls, six are spelled `https://` and two are still `http://`, so a
  `Disallow: /` there would cost two requests a night rather than one.
  `npm run measure-pacing twoOriginsOneHost` prints that exact shape — 2 requests, both
  `/robots.txt`, one per origin. Reusing one origin's file for another would be cheaper and would
  be us obeying rules nobody gave us, which is the one thing this project will not do.

  **Two is what we measure, and three is what we would expect in production, so both are printed
  here rather than only the flattering one.** A site that still answers `http://` in 2026 very
  likely redirects it to `https://`, and if arrl.org does, the nightly cost of a `Disallow: /`
  there is **three** requests: the `http` origin's read is a redirect plus the file at the far end,
  and the `https` origin still reads its own copy, because rules fetched across a redirect are
  attributed to the origin we *asked*. `npm run measure-pacing twoOriginsRedirectingRobots` prints
  that shape — 3 requests. Which of the two shapes arrl.org actually has is **inferred, not
  measured**: this project will not poll them to settle a footnote.
- These are measurements, not intentions. `npm run measure-pacing` drives the real fetcher against
  throwaway loopback servers — happy path, `429` with `Retry-After` 0/1/30, `503` with no header, a
  five-hop redirect chain, a chain that also 429s, a host publishing `Crawl-delay: 5`, and each of
  the ceiling shapes tabled above — and prints the millisecond gap between every request the
  server actually received, against the floor that applies to each one. It takes about two minutes.

  Two of those scenarios need something of the machine you run them on, and say so and skip rather
  than failing if they do not get it: `schemeChange` needs an `openssl` binary, to generate the
  throwaway certificate that lets one origin speak https (nothing is committed and nothing outlives
  the run); `twoNamesOneMachine` and `nameChangeHealthy` need `127.0.0.2` to be bindable, which is
  how two hostnames are put in front of one machine without asking you to edit `/etc/hosts`. Linux
  needs nothing; macOS needs `sudo ifconfig lo0 alias 127.0.0.2 up`.
- `robots.txt` honoured, including `Crawl-delay: 5` on arrl.org, **from the first request it
  governs** — the page fetched immediately after reading the file, not the one after that. The agent token is
  `GrantSpotter`, so any site can stop any deployment of this with `User-agent: GrantSpotter` and
  `Disallow: /`. The token is matched case-insensitively and a version or suffix after it is
  accepted, so `grantspotter`, `GrantSpotter/0.1.0` — the form that appears in a log — and
  `grantspotter-bot` all match; `grantspotterbot`, a different name that merely starts the same
  way, does not. Every group whose agent matches applies, not just the first one, and a
  `robots.txt` that redirects is followed.
- A User-Agent that says what this is and how to reach a human, in words rather than by the `+URL`
  convention alone. Every request carries the address of whoever runs *that* instance — there is no
  shared default and the server will not start without one — so a deployment run by the W9XYZ radio
  club sends, on every request:

  ```
  GrantSpotter/0.1.0 (+https://w9xyz-radio-club.org/grantspotter; nightly grant-deadline change detector; contact the operator of this instance at that page)
  ```

  The clause is the same for every deployment and the URL is never the same twice, which is the
  point: the page named belongs to somebody who can actually switch that instance off.
  [Environment](#environment) has the rules the value has to pass.
- Exponential backoff. No rate limits are published for Grants.gov, NSF or USAspending, but absence
  of documentation is not absence of limits.
- Nightly, jittered. Nothing here changes faster than weekly, and most sources change three or four
  times a year.
- An empty scrape is not a failure: `grants.austinhams.org` legitimately shows "No opportunities
  available" between 1 August and 30 April.
- **Everything above is about the crawler, and the crawler is not the only thing here that opens a
  socket.** There is exactly one other, it is not scheduled and it is not a crawl, and it is
  written up in full rather than left for somebody to find in a log:
  [The callsign lookup](#the-callsign-lookup).

---

## The callsign lookup

There is a button beside the callsign field on the profile screen and on the first-run setup
screen. Press it and this server makes **one** request to `callook.info`, a free service that
republishes the FCC amateur radio licence database, and offers back what that licence says.

**One at a time, for the whole deployment, not for the whole session.** While a request to
`callook.info` is in flight, a second press does not start a second one — it is refused with a
sentence saying so. The limit belongs to the SOURCE rather than to the person pressing, and that
distinction is the point: rationing per session would let a hundred accounts send a hundred
simultaneous requests, each individually well-behaved, which is how a polite rule produces an
impolite result. And when `callook.info` answers `429` or sends `Retry-After`, this server records
the wait and answers subsequent presses without asking again until it has passed. Both were
defects first — a race let eight concurrent presses through a limit meant to allow one, measured
at 24 requests from 24 members before the fix and 1 after.

**What it fills — four values, and only four**, named here by the form labels you will see them
under: **Callsign**; **State**; **License class**, on a personal licence; and
**Organization name**, on a club licence.
The list is short because the profile has nowhere to put the rest: there is no street field, no
city field, no ZIP field and no licensee-name field, so those values are shown and then dropped
rather than kept for later. Nothing is saved by
pressing the button — each of the four arrives in the form marked as read from callook.info rather
than stated by you, and you accept or overwrite it before you save anything.

The callsign is a special case worth knowing about: it counts as the source's answer only when it
**differs** from what you typed. callook answers a lookup of a *superseded* callsign with the
licensee's current record, so `K9OLD` can come back as `W5NEW` — and that is also what a typo
landing on a stranger's callsign looks like. You are asked to confirm the swap before anything is
filled, rather than having your input quietly replaced.

**What it deliberately does not fill.** `licensedSince` — "first licensed" — is not filled and
cannot be. The only date-shaped field in the answer is `grantDate`, which is the date the **current**
licence was granted; it resets on every renewal and on every vanity callsign change. That number
feeds "held a licence for at least N months" in the eligibility matcher, so filling it from
`grantDate` would print a confident ELIGIBLE or NOT ELIGIBLE on an award your real licence date
decides differently. It is shown, labelled *current licence granted*, and it stays there.
Three legacy operator classes — Novice, Advanced, Technician Plus, still held by roughly 212,000
people — map onto none of the four classes this software knows, so they arrive unmapped and you
pick. The nearest neighbour is always upward and guessing upward manufactures an ELIGIBLE verdict
on an award the holder cannot enter.

**The address.** The licence's mailing address — street, city and ZIP — comes back with the record
and is **shown to you**, because reading it is how you confirm the record is yours and not
somebody else's with a similar callsign. It is **not stored**: there is no field in this product
that holds a street address and nothing here reads one. Of that block only the **state** is kept,
because eligibility rules are written in terms of states, ARRL Divisions and ARRL Sections. A PO
box is flagged where the record gives one, since a few funders will not post a cheque to one.

**Who may press it.** You, for your own profile, or the operator during first-run setup. There is
no user parameter on the endpoint and a request that names one is refused rather than quietly
answered for the caller: an administrator creating somebody else's account may not look that
person's callsign up, because the result is a name and a home address and filling it into a third
party's profile would make GrantSpotter state facts on their behalf that they never gave it. One
press is one request; eight in ten minutes per person, which is a typist correcting a typo rather
than a batch. A callsign that is not a US prefix is refused **here**, before any request exists,
and costs neither a request nor a slice of that allowance.

**If you are not licensed in the United States**, this button cannot help you and says so in those
words. callook.info holds FCC records and nothing else. Told "not found" while creating an account,
a licensed operator reads "your licence is invalid", so a non-US callsign gets its own message and
its own reasoning: nothing in GrantSpotter works differently for you, and your licence is no less
valid for being issued somewhere this lookup cannot reach.

### `callook.info/robots.txt` says `Disallow: /`, and we query it anyway

Both halves of that sentence are true and neither is hidden, because the honest version is the only
one worth publishing.

- `https://callook.info/robots.txt`, read 2026-08-04, is 26 bytes: `User-agent: *` / `Disallow: /`.
- The same site's API reference, read the same day, says under Usage Terms: *"The callook.info API
  is publicly available and is free to use however you wish."*

Those are both the site owner's documents and they address different clients. RFC 9309 §1 scopes
the Robots Exclusion Protocol to "automatic clients known as crawlers" — a browser fetching a page
because a person asked for it has never been in scope, and neither is this. What makes that a claim
worth believing rather than a convenient reading is the shape of the code: nothing on this path runs
without a person supplying a callsign, nothing enumerates URLs, nothing follows a redirect, nothing
retries, nothing is cached and nothing is scheduled. One press, one request, one host, about the
presser's own public licence record.

**The nightly crawler is a different thing and obeys `robots.txt` absolutely, everywhere, with no
exception of any kind.** The paragraph above is not a hole in that and is not a precedent for one.
`qrz.com`, `hamcall.net` and `buckmasterinternational.com` — the obvious "second source when
callook is down" — are on the [hard blocklist](#the-blocklist-and-why-each-host-is-on-it) and
cannot be contacted by anything in this software, including this button.

**And there is a switch.** `CALLSIGN_LOOKUP_ENABLED=false` in `docker-compose.yml` and the route is
not registered at all: your deployment never contacts callook.info. It defaults to **on**. If you
read the argument above and are not persuaded by it, that line is the answer, and the cost of using
it is that people type four fields — which is what everyone outside the United States does anyway.

**Attribution, which is required rather than polite.** The underlying records are the **United
States Federal Communications Commission**'s and are public-domain US Government work; `callook.info`
is the service that republishes them in a form this software can read. The interface names
callook.info as the source of every marked value, with the date it was read and the sentence *"They
are values GrantSpotter read, not values you stated"*, and — where the record carries one — links
the FCC's own ULS page for that licence, so you can check us against the FCC rather than against us.
We never request that ULS page ourselves: `wireless2.fcc.gov` answers 403 to non-browser clients,
including on its own `robots.txt`, which is exactly why the link is for you and not for us.

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
prints a one-time token to the container log, and sign-in is rate-limited.

**Three things can bring an account into existence, and not one of them is open registration.**

| Path | Who starts it | What it produces |
|---|---|---|
| The first-run token, printed to the container log | the operator, once, against a database with no accounts | the first **administrator** |
| **Admin → User accounts**, which generates a password shown once | an administrator | a member or an administrator, whichever is chosen |
| An [enrollment code](#enrollment-codes), redeemed by whoever holds it | the person joining, using a code an administrator issued — from the admin screen, or from the `ENROLLMENT_CODE` line in `docker-compose.yml` | a **member**, always |

Only the third lets a person create their own account, and the distinction it turns on is the
entire design: **there is no open sign-up.** The form exists and it is inert without a code that an
administrator issued, bounded with whatever limits they set, and revocable the moment they change
their mind. Registration for whoever finds the URL was never available here and still is not.

Setting the code in the compose file is the *same* third path and not a fourth: it produces the
same row, with the same limits and the same revoke button, and it cannot produce one at all until
an administrator exists — see [Enrollment codes](#enrollment-codes).

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

### Enrollment codes

A club officer bringing fifteen new members onto an instance does not want to type fifteen
passwords and hand them over one at a time, and the fifteen do not want to be handed one. An
enrollment code is the third path: an administrator issues one, gives it to the people it is for,
and each of them creates their own account with it.

An administrator issues a code under **Admin → Enrollment codes** with a label saying what it is for —
"W1MX autumn 2026 intake" — and two bounds, both optional and both worth setting:

- **A use limit.** How many accounts this code may create. Leave it empty for no limit; even then
  the code is still bounded by its expiry and by your ability to revoke it. (For a code you *type*,
  both bounds stop being optional — see below.)
- **An expiry**, given as a number of days. A code with no limit and no expiry is a permanent
  password to your instance held by everyone you ever gave it to, so set at least one of the two.

Leave the code box empty and GrantSpotter generates one — twenty characters, 2^100, unguessable.

**You can also type your own**, so that an officer can read `W1MX-FALL-2026` out at a meeting
instead of spelling twenty random characters down a phone. That is a real trade and the console
says so at the moment you make it, not here:

- **A code you choose can be guessed, and the product is built around that rather than around a
  rule about length.** Nothing stops somebody who has heard of your club trying your callsign with
  a season and a year: in testing, `W1MX-SPRING-2027` was found on the seventh attempt. So three
  other things do the work. GrantSpotter answers **at most 240 wrong codes every fifteen minutes
  across the whole server** — 23,040 a day, however many addresses a caller claims, and a code your
  students really hold is never held up by it. It writes a line to the audit log when somebody is
  working through codes, and another when an account is created from somewhere that has just been
  getting them wrong. And the two bounds below cap what a guessed code is worth.
- **A code you choose must be at least 12 characters** once capitals, dashes, spaces and `U` are
  taken out. All that buys is ruling out somebody working through every possible code: at the
  ceiling above, a year of guessing gets through eight characters with about one chance in 130,745
  and twelve with about one in 137 billion. **Clearing the floor does not make a code hard to
  guess** — `W1MX-SPRING-2027` clears it by two characters — so treat a chosen code as a
  convenience with a deadline, not as a secret.
- **A code you choose must say how many accounts it may create, up to 200.** This is the bound on
  the day one of these is guessed: before it existed, a guessed code went on making member accounts
  until somebody noticed. Thirty is the usual answer for a club intake, and issuing another code
  takes ten seconds. A generated code keeps its 10,000, or no limit at all.
- **A code you choose must expire, within 365 days.** Not because of guessing — no expiry short
  enough to matter would help there — but because a code worth reading out is a code that gets read
  out, photographed and forwarded, and an expiry is the only bound on that which does not depend on
  somebody remembering to revoke it. A generated code may still live for ten years, or forever.
- **Codes are compared after they are folded.** Capitals, dashes and spaces are ignored, `O` counts
  as `0`, `I` and `L` count as `1`, and **`U` is dropped entirely** — that is what lets a student
  type a code off a whiteboard and still get in, and it is why `W1MX-AUTUMN-2026` is stored as
  `W1MXATMN2026`, twelve characters rather than the fourteen you typed. The console shows you the
  stored form before you save. It also means `W1MX-FALL-2026` and `WIMX-FA11-2O26` are *the same code*, so the
  console shows you the folded form before you save, and a second code that folds onto an existing
  one is refused and tells you which one it clashed with. Revoking the old one does not free the
  text: the two would still be the same code, and anyone still holding the old one could use the
  new one.
- The list marks every code **Chosen** or **Generated**, because after the fact only a hash is
  stored and the two are not equally strong.

**You can set one in `docker-compose.yml` instead, on the `ENROLLMENT_CODE` line**, if you would
rather edit one file than sign in and fill in a form. It is not a different kind of credential and
it gets no shortcuts: at boot it becomes an ordinary row in the same table, listed in
**Admin → Enrollment codes** as `Set in docker-compose.yml (ENROLLMENT_CODE)`, marked **Chosen**,
with the same use count, the same expiry, the same revoke button and the same audit trail. Every
rule above applies to it, and the server refuses to start rather than issue a code that breaks one.

- **It has to state its bounds, and the compose file states them for you.** `ENROLLMENT_CODE_MAX_USES`
  defaults to **30** — a club intake, and what this product already calls the usual answer — and
  `ENROLLMENT_CODE_DAYS` to **90**, one academic term rather than the 365 the ceiling allows,
  because a default that takes the maximum is a default nobody chose. Both are written out in the
  file next to the code, so you can see what you are handing out. Both are read *only when the code
  is created*: changing one of them alone does nothing until you change the code itself, and the
  container log prints the limits the row actually carries.
- **Restarting changes nothing.** The row keeps the uses it has spent and the expiry it was created
  with, because a container that restarts every week must not hold a code that never expires.
- **Changing the value withdraws the old code** and issues the new one; **deleting the value
  withdraws it** and issues nothing. In both cases the old row stays, with its label, its count and
  its history, and anyone still holding that code is told it was withdrawn rather than that it is
  not valid.
- **A withdrawn code never comes back.** Revoke it in the app and a restart leaves it revoked — a
  restart must not undo somebody's deliberate act. Putting an old code back on the line does not
  reopen it either, and that one is doing real work rather than being consistent: everyone who was
  read that code out while it was live still has it. To open a new door, use a code this instance
  has not used before. The log says so on every boot that finds one.
- **A code an administrator already issued is left alone.** If the value names a code that exists on
  the instance, GrantSpotter does not take it over: its limits, its expiry and its issuer stay as
  they were, and removing the line will not withdraw it. The log says all three, because the natural
  assumption is the opposite.
- **It cannot go first.** A code names the administrator who issued it, and nothing self-serve may
  exist before an administrator does, so on a brand-new database the code is created the moment you
  finish the first-run setup rather than at that first boot. No restart needed; the log says which
  of the two happened.
- **Rotating `SESSION_SECRET` fixes this one for you.** Every other outstanding code stops redeeming
  when that secret changes (see below) and has to be reissued by hand. The compose-set code is
  reissued on the next boot, because the file still says what it is.

> **`docker-compose.yml` is tracked by git, and this is the value that will not feel like a secret.**
> A session secret looks like one, so you think before you push. An enrollment code is *meant* to be
> shared — read out at a meeting, chalked on a whiteboard, printed on a flyer — so it does not feel
> like something to protect while you are typing it, and it still makes accounts. Push a fork with a
> live code on that line and anybody reading your repository can create accounts on your instance
> until you notice and revoke it. If you keep this repository under git, do not put the code on that
> line: change it so the value is interpolated from the environment, written exactly the way the
> `HOST_PORT` line is written, and keep the code in the `.env` beside the compose file, which
> `.gitignore` already ignores. Deploying from a download, or from a clone you never push, and it
> does not arise. For the same reason there is **no example code printed in the compose file or
> here**: a code published in a public repository is a code every deployment that copied it shares.

**The code is shown exactly once, on the screen that issues it.** After that only a hash of it is
stored, so a copy of `grantspotter.sqlite`, a backup or the JSON export does not hand out working
credentials. For a code *you* typed, a plain hash would not have been enough — a dictionary of
callsigns, seasons and years recovered `W1MX-AUTUMN-2026` from its stored digest in 32 seconds on
one CPU core — so the stored value is an HMAC keyed with a secret derived from your
`SESSION_SECRET`, which lives in your environment and is in no backup this software writes. **Two
consequences worth knowing before they surprise you:** if you rotate or lose `SESSION_SECRET`, every
outstanding enrolment code stops working (the rows stay, with their labels and counts — issue a new
code for each open intake), and restoring a backup onto a host with a *different* `SESSION_SECRET`
brings the records back but not the codes. Codes issued by a build older than migration 093 keep
their original digest and go on working; they are all generated 20-character codes, which no
dictionary reaches. The list
of codes shows you the label, the use count, the expiry, who created it and when it was last
redeemed, and it cannot show you the code itself, because the instance no longer has it. If you
lose it, revoke it and issue another; that is cheaper than any recovery path and it is the one that
leaves a record. Revocation stamps the row rather than deleting it, so what remains is the evidence
that this code existed and when it was switched off.

**Enrolment produces a member. The role is not a parameter of the request**, so there is nothing to
tamper with: an enrolled account gets `member`, and the only way to a second administrator is an
existing administrator promoting one. The account's password is the enroller's own choice and is
held to the same 12-character floor as every other password here, checked by the same policy.

**A wrong code and a code that was never issued get the same answer.** Enrolment tells you nothing
about codes you do not hold: not whether one exists, not how many there are, not who has one.
Expired, revoked and used-up codes *do* say which they are, because those are the three states a
legitimate holder needs explained before they give up and email somebody. Guessing is rationed by
three counters rather than one: **10 wrong codes per address, 120 per source network, and 240
across the whole server**, each per 15 minutes. Only a wrong code is charged to any of them, and
only a wrong code ever reads one: redeeming a code this instance really issued does not consult
them at all, so nothing a stranger does with wrong codes can stop your students enrolling. A code
that has expired, been revoked or run out is a holder failing, not an attacker probing, and locking
them out for it teaches nobody anything.

**That promise is about codes, and not about email addresses.** Enrolling with an address that
already has an account is told so, plainly, because the alternative is someone who signed up last
term being unable to work out why the form will not take them. On an instance where every account
needs a code you issued, that is a trade worth making and not a leak worth pretending about.

**Why three counters and not one.** The first knows callers apart only by the address your proxy
reports, which behind a tunnel is the real client and is the precise signal — a club whose students
all leave through one campus NAT shares one budget, so after 10 mistyped codes from that building
the next mistype from it is answered "wait" rather than "that code is not valid", and typing the
code correctly still enrols them. But a caller who can reach the instance directly writes that
address themselves, and until 2026-08-10 that was the only counter: measured on the shipped build,
one machine rotating the header was answered **20,008 wrong codes in 10.12 seconds** and left
nothing in the audit log. That was an accepted trade while every code was 2^100 and it stopped
being one the day an administrator could type `W1MX-FALL-2026`. The two counters underneath it are
keyed on the TCP connection's own address, coarsened to a /24 or /48, and on nothing at all — there
is no header that changes either. Behind your tunnel they are one value for the whole deployment,
which is exactly the deployment-wide switch that ten wrong codes from a stranger used to flip on
2026-08-05; it is affordable now only because a correct code never touches these counters. And a
refused request charges nothing, so one source can only ever contribute its own 120 to the
server-wide 240: **closing that one takes at least two networks acting together**, and the worst it
does even then is answer a wrong code with "wait" instead of "not valid" for fifteen minutes.

**What an attacker can still reach, stated rather than rounded off.** 240 wrong codes per fifteen
minutes, deployment-wide, sustained: 23,040 a day. That is 1/8,000th of what was measured before,
and it is still enormous next to a phrase somebody can think of, which is why the audit trail and
the use limit above matter as much as the ceiling does.

**Two people redeeming a single-use code at the same instant get one account, not two.** The use
count and the new account are written in one transaction, so the limit holds under concurrency
rather than only in a demo. That is stated because the opposite has shipped here before, one floor
down: the [callsign lookup](#the-callsign-lookup)'s guard against two simultaneous requests to one
host could not see a request that had not answered yet, and eight simultaneous presses produced
eight requests where one was intended — measured on 2026-08-04, with the guard present and every
one of its own tests green. A limit checked before an `await` and written after it is not a limit.

| Route | Who | What it does |
|---|---|---|
| `GET /api/admin/enrollment-codes` | admin | lists codes; carries no plaintext, ever |
| `POST /api/admin/enrollment-codes` | admin | issues one from `{ label, code, maxUses, expiresInDays }`; `code: null` generates one, a string is the code you chose; the only response in the product that carries `plaintext`, and it carries `normalized` beside it — what was actually hashed |
| `POST /api/admin/enrollment-codes/:id/revoke` | admin | stamps `revokedAt`; the row stays |
| `GET /api/auth/enrollment-open` | public | `{ open: boolean }` — whether *some* usable code exists, and nothing else |
| `POST /api/auth/enroll` | public | redeems a code, creates the member, signs them in |

`maxUses: null` means no limit, `expiresAt: null` means no expiry, and a code is usable only while
it is unrevoked, unexpired and under its limit. The sign-in screen offers the enrolment path only
when `GET /api/auth/enrollment-open` says yes, which is a single boolean about the instance and not
a fact about any particular code — an instance with no usable codes looks exactly like an instance
that has never issued one.

**Enrolment does not replace the first-run token and cannot stand in for it.** Issuing a code takes
an administrator, and on a fresh database there is no administrator to take it, so the first one
still comes out of the container log exactly as [below](#deploying).

---

## Deploying

The image is built by GitHub Actions for `linux/amd64` and `linux/arm64` and published to
`ghcr.io/atvriders/grantspotter:latest`. The repository and the package are public.

There is one file and nothing to copy. Open `docker-compose.yml`, replace the **two** values marked
`EDIT THIS`, and bring it up:

```bash
# in docker-compose.yml, under environment:
#   SESSION_SECRET: <the output of `openssl rand -hex 32`>
#   CONTACT_URL:    <an https page you control, that a stranger can reach>
docker compose pull
docker compose up -d
```

Both ship as placeholders containing `CHANGE_ME`, and **the server refuses to start while either is
still there**, saying what it found and what to do about it. Neither has a default and neither can
have one, for two different reasons:

- `SESSION_SECRET` — this repository is public, so a placeholder session secret left in place would
  be a signing key everyone can read. It is enforced by value in `packages/server/src/config.ts`
  rather than by the compose file, because the compose file is the thing being shipped.
- `CONTACT_URL` — this goes in the crawler's User-Agent, and it has to name **you**. For one day
  this project shipped its own issue tracker here as a working default. That was removed, and the
  reason is the whole of it: a shared default makes the maintainers of the *software* the contact
  for every deployment of it, including the ones they do not run, cannot inspect and cannot stop. A
  site owner who wrote in would have got an apology instead of a result.

The requirement costs you one edit and buys more politeness than the default did: no deployment of
this can poll anonymously, and the address every request carries belongs to somebody who can
actually switch that instance off. It does not have to be elaborate, and it does not have to be the
instance itself — a club page, a department page or a personal page that says who runs this and how
to reach you is enough. [Environment](#environment) has the rules it must pass.

Then read the container log for the one-time admin bootstrap token. The **first administrator always
comes from the log**: a fresh database has no accounts, so it has nobody who could issue an
[enrollment code](#enrollment-codes), and enrolment therefore cannot bootstrap an instance. What you
get is a first-run screen: open the app and, because no accounts exist yet, it offers **Set up
GrantSpotter** instead of a sign-in box, asking for that token, an email address and a password of
at least 12 characters. On success you are signed in as an administrator. There is no password reset
for the first administrator, so store it somewhere you can find it again.

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
`http://127.0.0.1:3030` (or whatever you set `HOST_PORT` to) and sign in with those credentials.
From here an account is made one of two ways: you create it from **Admin → User accounts**, with the
role you choose and a generated password you hand over, or somebody creates their own by redeeming
an [enrollment code](#enrollment-codes) you issued, which always makes a member. Nobody arrives
without an administrator having done something first.

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

**The same applies to `ENROLLMENT_CODE`, and it is the line likelier to catch you out.** A session
secret announces itself as a secret; an [enrollment code](#enrollment-codes) is *meant* to be shared,
so it does not feel like one while you are typing it — and it still creates accounts. A fork pushed
with a live code on that line lets strangers enrol on your instance until you revoke it. Same escape
hatch, same `.env`, and it is empty as it ships so it costs you nothing to leave alone.

**CI note:** a freshly created or forked repository sometimes will not run its first push-triggered
workflow. The build workflow includes `workflow_dispatch` for exactly that case — trigger it once by
hand from the Actions tab, and subsequent pushes behave normally.

### Environment

| Var | Required | Default | Notes |
|---|---|---|---|
| `HOST_PORT` | no | `3030` | compose host port only; the only interpolated value left |
| `PORT` | no | `3030` | in-container listen port |
| `SESSION_SECRET` | **yes** | **no default** | at least **32 characters**; the server refuses to start without it, and refuses the shipped `CHANGE_ME` placeholder by value |
| `CONTACT_URL` | **yes** | **no default** | an `http(s)` page **you** control and a stranger can reach; goes in the crawler User-Agent. The server refuses to start without it, and refuses by value: a `CHANGE_ME` placeholder, a reserved documentation name or address, an address nobody outside your network can reach, and anything that is not printable ASCII |
| `DATA_DIR` | no | `/data` | SQLite, snapshots, fixture cache |
| `CRAWL_ENABLED` | no | `true` | |
| `CRAWL_CRON` | no | `17 3 * * *` | nightly, jittered in code |
| `CALLSIGN_LOOKUP_ENABLED` | no | `true` | the one user-initiated request this product makes. `false` and the route is not registered, so this deployment never contacts `callook.info` — see [The callsign lookup](#the-callsign-lookup) |
| `ENROLLMENT_CODE` | no | empty, and the feature is off | an [enrollment code](#enrollment-codes) you set in the file instead of in the app. At boot it becomes an ordinary code row with the same limits, revoke button and audit trail. Held to the same rules as one you type into the console, and the server refuses to start if it breaks one. **The value is a credential in a tracked file — read the warning below** |
| `ENROLLMENT_CODE_MAX_USES` | no | `30` | how many accounts that code may create, up to the 200 any chosen code may have. Read only when the code is created |
| `ENROLLMENT_CODE_DAYS` | no | `90` | how long it lives, up to the 365 any chosen code may have. Read only when the code is created, so a restart never extends it |
| `ANTHROPIC_API_KEY` | no | none | optional parse assist only |
| `SIMPLER_GRANTS_API_KEY` | no | none | optional federal ranking |

Two variables fail loudly on startup for being absent or unedited, and neither of them can be given
a default:

- **`SESSION_SECRET` has no default because a shipped default session secret is a shared secret,
  which is not a secret.** Generate one with `openssl rand -hex 32`. The value in
  `docker-compose.yml` is a placeholder that the server rejects on sight — including if you paste
  yours *beside* it rather than over it, and including if you delete the `CHANGE_ME_` prefix and
  leave the rest, which is just as natural an edit and just as published. The rule is that no
  eight-character run of the shipped placeholder may appear in your value; `openssl rand -hex 32`
  emits `[0-9a-f]` only and the placeholder's longest all-hex run is two characters, so a secret
  generated that way can never trip it.
- **`CONTACT_URL` has no default because a shared contact address makes somebody else answerable
  for your crawler, and they cannot switch it off.** The server refuses to start without one.

  It goes into the crawler's User-Agent. Most of the ~25 sources this polls are small,
  volunteer-run organisations — club sites, a foundation run by retirees, a scholarship page
  maintained by one person — and they should be able to see who is polling them and get in touch
  with the person doing it. That last clause is the requirement. This project shipped its own issue
  tracker here as a working default for exactly one day, and it was removed because every
  deployment that kept it pointed at the *same* tracker: this project's, **not yours**. A site owner
  who wanted *your* instance in particular to stop would have reached maintainers who do not run it,
  cannot inspect it and cannot stop it, and would have got an apology instead of a result. Pointing
  at the repository without the words "open an issue" would not have helped — a repository is a
  place where people open issues.

  So it is required, and the requirement is *stronger for politeness than the default was*: no
  deployment of this software can poll anonymously, and the address every request carries belongs to
  somebody with their hand on the switch.

  **The one remedy that works no matter who is running what is `robots.txt`, and that matters more
  now, not less** — with no shared contact point it is the thing a site owner can use without
  finding, trusting or waiting for any particular operator. Every instance honours it, matched
  case-insensitively on the `GrantSpotter` token (with or without a `/version` or `-suffix` after
  it), so

  ```
  User-agent: GrantSpotter
  Disallow: /
  ```

  stops the crawler in every deployment of this software, and the crawler is the thing that visits
  you. It takes effect on the next nightly crawl — each run re-reads every site's
  `robots.txt` before it fetches anything, and a cached copy expires after six hours regardless, so
  no instance acts on rules more than a day old. A `robots.txt` that redirects is followed; one we
  fail to *reach* — a dropped connection, or a 429 or 5xx after four attempts — stops the crawl of
  that origin rather than being read as permission (a 404 or 403 still means "this site publishes no
  rules", because that is what a 403 on `/robots.txt` deliberately means at some sites); and a
  `Disallow: /` is obeyed even when the file names other agents around it. (Until 2026-08-04 none of
  those three was true, and the file was read once per server process besides, so a long-running
  container never noticed a new one. If you are running an instance older than that, restart it.)
  That is the first thing
  [the issue template](.github/ISSUE_TEMPLATE/crawler-contact.md) tells an arriving site owner,
  before it asks them for anything.

  **The one thing that sentence does not cover, stated here rather than discovered later.** There
  is exactly one request in this product that a `Disallow: /` does not stop, and it is not the
  crawler: the [callsign lookup](#the-callsign-lookup) goes to `callook.info` — one request, to
  that one host, when a person presses a button about their own public licence record. It visits
  nobody else, ever, so unless you run `callook.info` this paragraph is not about your site. It is
  written down anyway, because the alternative is a sentence up there that is true of everything
  except the case somebody eventually finds. callook.info's own API reference grants that use in
  writing, RFC 9309 scopes `robots.txt` to automatic clients that go looking for URLs, and the
  tension between those two documents is set out in full in that section rather than resolved in
  our favour and left there. An operator who disagrees turns it off with one line.

  **What to put in it.** An `http(s)` page you control **and that can be reached from outside your
  own network**. It does not have to be this instance and it does not have to be much: a club page,
  a university department page, a personal site, anything that says who runs this and how to reach
  you. The only reader of this value is a stranger at a site you are polling, so the loader refuses
  everything that is guaranteed not to reach you from where they are standing.

  - The reserved documentation names (`example.com`, `example.net`, `example.org`, and the
    `.invalid`, `.test` and `.example` TLDs) and the reserved documentation addresses (RFC 5737's
    `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, and `2001:db8::/32`). They exist precisely
    so that they reach nobody; a crawler identifying itself with one is anonymous while looking
    identified.
  - Loopback and private space — `127.0.0.1`, `localhost`, `::1`, `10.x`, `172.16–31.x`,
    `192.168.x`, link-local, carrier NAT — and single-label names like `intranet`, and `.local` /
    `.internal` / `.home.arpa`. To the sysadmin reading your User-Agent at 2am these point at their
    own machine or their own LAN, which is less useful than no address at all, and they publish how
    your network is numbered to ~25 third parties. **If your only web page is on your LAN, this is
    the one edit you have to make somewhere else**: any public page naming you will do.
  - A value still containing `CHANGE_ME`, because a half-finished edit is not an address — and
    anything that is not printable ASCII, because this string is copied verbatim into an HTTP header
    and a URL parser silently deletes tabs and line breaks from anywhere inside it (percent-encode,
    and use the punycode form of an international domain).

  The shipped placeholder is refused twice over, and the two rules are independent on purpose:
  change `example.org` to your own host and `CHANGE_ME` still catches it; delete `CHANGE_ME` and
  `example.org` still does. Only replacing the whole value gets past both.

**A third variable can stop the boot, and only if you asked it to.** `ENROLLMENT_CODE` is optional
and empty as it ships, so this paragraph is about nobody until you type something between the
quotes. Once you do, a value that breaks one of the rules for a code you choose — under 12
characters folded, more than 200 uses, longer than 365 days — stops the server instead of starting
one that quietly has no door behind the code you just read out at a meeting. Every one of those
messages names the rule, says why the rule exists, and ends with the way out: **delete the
`ENROLLMENT_CODE` line and the server starts again**, because the feature is optional and "off" is
always one keystroke away. Nothing that depends on the *database* — a code that is already here, or
one that has been withdrawn — ever stops a boot, because that can become true on a Sunday reboot
nobody asked for; those are reported in the container log and the server starts. See
[Enrollment codes](#enrollment-codes) for what a boot then does with the value.

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
| Tests at that commit | 4,270 unit and integration, 35 end-to-end |

**Read those two token figures carefully, because one of them flatters.** The 17.8 million output
tokens are what was actually composed: code, tests, comments, commit messages, reports. The 4.91
billion is everything the model read *and re-read* — 97% of it is prompt-cache reads, the same
context handed back on each of 34,353 turns. Quoting the larger number alone would suggest roughly
275 times more writing than happened. This file argues elsewhere that a projected date must not be
dressed up as a published one; the same rule applies to a statistic about the project itself.

Both figures come from the session transcripts under `~/.claude/projects/`, summing
`message.usage` over the main loop and all 290 subagent files, counting each record's top-level
fields once and ignoring the `iterations` array that repeats them.

**Every figure above is a snapshot taken at commit `7c3fd9d`, and the work did not stop there.**

That sentence replaces one claiming these numbers "describe a finished event rather than live data,
so they cannot drift: nothing that happens to the corpus, the clock or the deployment can make them
untrue." It was written in the same commit that removed other numbers from this file *for* drifting,
and it was wrong within the hour. An adversarial review measured it: commits 230 → 247, wall clock
38 h 42 m → over 47 h, tests 4,270 → 4,668 and moving. The reasoning failed because the event was
not finished — it was merely finished *so far*, which is not the same thing and is the easier thing
to believe about your own work.

So: the table is true of `7c3fd9d` and is not maintained. Recompute it yourself if you want the
current numbers — the method is above, and it is why the method is stated rather than only the
result.

What that effort mostly went on is worth knowing, because it is not the feature list. The recurring
work was finding places where a green test or a confident sentence was pointing at something untrue:
a suppression boundary that leaked seven separate times, each from one read path using its own
filter instead of the shared gate; a byte-identity proof that passed only because two runs landed
inside the same two-second timestamp tick; three redundant gates that made a fourth one's failure
invisible to every response-level test; a `npm run typecheck` that worked for a year only because
every checkout had a stale build directory; and a README assertion that *required* a false
statistic to stay on this page. Those are recorded where they happened, in the comments and commit
messages, on the theory that the reason a line exists is worth more than the line.
