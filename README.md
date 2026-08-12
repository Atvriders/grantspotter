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

**And a written account of how it can still be wrong.**
[`docs/how-this-catalogue-can-be-wrong.md`](docs/how-this-catalogue-can-be-wrong.md) lists the ways
this app has actually told a student something untrue, which guard now covers each one, and — the
useful half — which are covered by nothing. Every defect in it was invisible to a green test suite
on the day it shipped. Read it before changing an extractor or the matcher.

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

There is a button beside the callsign field on the profile screen. Press it and this server makes
**one** request to `callook.info`, a free service that republishes the FCC amateur radio licence
database, and offers back what that licence says.

The first-run setup screen carried the same button until 2026-08-11 and no longer asks for a
callsign at all. Setting up a deployment and describing an operator are two jobs, and doing them on
one screen meant the very first page of the product was a six-field form with a network call in the
middle of it. The profile screen is one click past it, has the same button, and can show you what
was filled in.

**One at a time, for the whole deployment, not for the whole session.** While a request to
`callook.info` is in flight, a second press does not start a second one — it is refused with a
sentence saying so. The limit belongs to the SOURCE rather than to the person pressing, and that
distinction is the point: rationing per session would let a hundred accounts send a hundred
simultaneous requests, each individually well-behaved, which is how a polite rule produces an
impolite result. And when `callook.info` answers `429` or sends `Retry-After`, this server records
the wait and answers subsequent presses without asking again until it has passed. Both were
defects first — a race let eight concurrent presses through a limit meant to allow one, measured
at 24 requests from 24 members before the fix and 1 after.

**What it fills — six values, and only six**, named here by the form labels you will see them
under: **Callsign**; **State**; **License class**, on a personal licence;
**Organization name**, on a club licence; and **Latitude** and **Longitude**, which are
callook.info's own geocode of the address on the licence.
The list is short because the profile has nowhere to put the rest: there is no street field, no
city field, no ZIP field and no licensee-name field, so those values are shown and then dropped
rather than kept for later. Nothing is saved by
pressing the button — each value arrives in the form saying where it came from, and you accept or
overwrite it before you save anything.

The coordinate is the one that needs a caveat, and it carries one on screen as well as here.
callook geocodes the address post is sent to, so on a licence filed at a **PO box** the coordinate
is a post office — which is what a great many collegiate club stations file, and a post office can
be on the other side of a boundary from the club it serves. GrantSpotter therefore fills the two
boxes only from a **street address**; for a PO box it shows you the coordinate, says what it is,
and waits for a second press before putting it anywhere. It is also the one pair the profile
cannot mark: it can record that a callsign, a state, a licence class or an organisation name was
read from a source, and it has nowhere to record that about a number, so once saved a fetched
coordinate reads exactly like one you typed. Latitude and longitude are read by one kind of rule
only — "within 250 miles of Seaford, Delaware" — and leaving them empty leaves those rules
**unanswered** rather than answered against you.

**Call district** is filled in too, and is not on that list because nobody states it: it is the
digit in your callsign, worked out here rather than read anywhere, and it follows the callsign box
if you change it. The matcher does the same arithmetic when the field is empty, so leaving it
blank costs you nothing either.

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

**Who may press it.** You, signed in, for your own profile. That is the whole list. There is
no user parameter on the endpoint and a request that names one is refused rather than quietly
answered for the caller: an administrator creating somebody else's account may not look that
person's callsign up, because the result is a name and a home address and filling it into a third
party's profile would make GrantSpotter state facts on their behalf that they never gave it. One
press is one request; eight in ten minutes per person, which is a typist correcting a typo rather
than a batch. A callsign that is not a US prefix is refused **here**, before any request exists,
and costs neither a request nor a slice of that allowance.

**There is no unauthenticated way to reach it, and there was one until 2026-08-11.** While the
setup screen had a callsign field, this endpoint accepted the one-time first-run token in the
request body and answered a caller with no session at all. The field went; the privilege was left
behind it, reachable by anyone who could POST to a fresh deployment, serving a screen that no longer
existed. It is deleted — the token is not passed to the route, the request body has no field for
one, and a request that sends one is refused as an unknown key rather than answered. Nothing an
operator does brings it back and there is no setting for it.

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
writes a one-time token to a file in `DATA_DIR`, and sign-in is rate-limited.

**Three things can bring an account into existence, and the third is open to anyone who can reach
the instance.**

| Path | Who starts it | What it produces |
|---|---|---|
| The first-run token, written to a file in `DATA_DIR` | the operator, once, against a database with no accounts | the first **administrator** |
| **Admin → User accounts**, which generates a password shown once | an administrator | a member or an administrator, whichever is chosen |
| [Sign up](#signing-up), from **Create an account** on the sign-in screen | the person joining, unaided | a **member**, always |

Only the third lets a person create their own account, and it needs nothing from you: **anybody who
can reach this deployment can create a member account.** That is a change — see
[Signing up](#signing-up) for what it replaced and what it does not give away.

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

### Signing up

**Anybody who can reach this deployment can create a member account.** The sign-in screen offers
**Create an account**, which swaps the sign-in box for a sign-up form. It asks for an email address,
a password and an optional display name — no callsign, and nothing that has to be issued to you
first — then makes the account and signs the person in.

#### What this replaced, because the argument is worth knowing was made

Until 2026-08-11 there was a third credential here called an **enrollment code**. An administrator
issued one under *Admin → Enrollment codes* with a label, a use limit and an expiry, gave it to the
people it was for, and each of them created their own account with it; an operator could also set
one on an `ENROLLMENT_CODE` line in `docker-compose.yml`. The argument for it was that a club's
instance should not be joinable by whoever finds the URL, and that a code an officer can read out at
a meeting is the one credential a club can actually distribute. Four database migrations, a digest
keyed from `SESSION_SECRET`, three rate-limit rungs and a long section of this README went into
making that bounded rather than merely convenient.

It was answered by the person who runs the deployment: the locked door cost more than it bought.
Every legitimate member waited on an officer to be available, and the officer had to be taught what
character folding was before they could choose a code that would work. So the whole apparatus is
deleted — the screen, the routes, the compose variables, the redemption path.

Two things survive it. The `enrollment_codes` table is still in the schema, as a **closed record**:
your existing rows keep their labels, use counts and expiries, nothing can redeem one, and no screen
shows them. And the `user.enroll` rows in the audit log still say which intake each of your existing
members arrived through. `packages/server/src/db/migrations/095-enrollment-codes-are-a-closed-record.sql`
sets out why the table was not dropped. **If you are upgrading, you have nothing to do**: an old
`docker-compose.yml` that still carries the three `ENROLLMENT_CODE*` lines starts fine, because
nothing reads them.

#### What open sign-up does not give away

- **A new account is always a member. The role is not a parameter of the request**, so there is
  nothing to tamper with: the handler passes the literal `member`, and the only way to a second
  administrator is an existing administrator promoting one. A body carrying `"role":"admin"` reaches
  the handler with that key already stripped.
- **A member can read and cannot decide.** The capability table above is the whole of it: browse,
  match, watch, apply, export, and the review queue read-only. Source configuration, the crawl
  trigger, user management and backup/restore are admin-only.
- **The first administrator still comes from the first-run token, and sign-up cannot stand in for
  it.** Until that account exists, nothing here creates an account at all — the sign-up form is not
  offered and the route refuses — so a fresh container left running on a public address cannot be
  claimed by whoever finds it first. See [Deploying](#deploying).
- **The password is the person's own choice and is held to the same 12-character floor** as every
  other password here, checked by the same policy. There is no password-reset email, because there
  is no SMTP anywhere in this product; a member who forgets theirs needs an administrator to reset
  it from *Admin → User accounts*.

#### What it does give away, said plainly

- **There is no email verification.** Nothing in this product sends mail, so an address on an
  account is a string somebody typed. It is the login identifier and nothing else rests on it.
- **Signing up with an address that already has an account is told so.** That is a disclosure — it
  answers "does this instance have an account for this address?" — and it is deliberate, because the
  alternative is somebody who signed up last term unable to work out why the form will not take
  them. On an instance anybody may join, that trade is a smaller one than it was when a code was
  needed to ask the question at all, and it is not a leak worth pretending about.
- **Anybody may join means anybody may join.** If you need the door shut, put this instance behind
  something that can actually shut it — a VPN, an SSO proxy, an IP allow-list. A shared code could
  not, once it had been read out in a room; a proxy can. This software has no setting that
  substitutes for one.

#### The registration budget, and what no setting of it can do

Registration is rate-limited on three rungs, every one of them a **15-minute** sliding window: **200
sign-ups per connection**, **400 per source network**, and **800 across the whole server**. The
first is keyed on the address your proxy reports, which behind a single documented hop is a
building's NAT rather than one person; the second on the TCP peer's own address coarsened to a /24
or /48, which no header can change; the third on nothing at all.

**Behind a Cloudflare Tunnel — the deployment this is written for — only the first two of those can
ever fire, and they mean this:** every request arrives on one TCP connection from `cloudflared`, so
the second rung is your *whole instance*, and `cloudflared` reports each caller's own public address,
so the first rung is *one building*. The two ceilings you will meet are therefore **200 accounts per
public address per fifteen minutes** and **400 accounts for the whole deployment per fifteen
minutes**. A lecture hall of 130 students on one campus NAT signs up in one sitting. If you are
running an intake of more than 200 people in one room, split it across two sittings a quarter of an
hour apart, or have the overflow sign up from a phone on mobile data, which is a different public
address. Nobody who already has an account is affected: signing in is not rationed at all.

**Every account created is counted, not every attempt**, because here the successes *are* the
abuse — a budget that counted only mistakes would let somebody who never makes one create accounts
without limit. A request that a rung refuses, that is told the address already has an account, that
the hash queue sheds, or that loses the duplicate-address race, leaves no mark on any of the three.
It does hold its place while it is in flight: the slot is claimed *before* the password hash and
only converted into a recorded registration once the row exists, because a counter read before an
`await` and written after it is not a counter — measured on 2026-08-05, 240 concurrent requests
against a budget of ten produced 240 hashes and 10.2 s of CPU.

That sentence read **"every attempt is counted, not every failure"** until 2026-08-11, and it was
true of the route that then shipped. What it bought was a bound on the polite wording of something
the status line gives away for free — 409 for an address that has an account, 201 for one that does
not — and what it cost was that a stranger's questions spent the students' budget: measured, 120
probes that created nothing closed sign-up for the whole tunnel in 147 ms. What is bounded now is
what a probe *leaves behind*, and a probe that lands on a free address is a real account and is
charged like one.

And these numbers moved from bounding an attack to bounding an afternoon, which is the whole change:
they used to be charged only on the branch that answered "that enrollment code is not valid", so a
person holding a real code never read them and could not be refused by them however hard a stranger
had been knocking. That branch is gone. **This budget is now on the path of every legitimate
registration**, so each rung is derived from the busiest honest window this product is for — a room
full of people signing up at once — rather than from a stranger. The connection rung was **10** while
it counted wrong codes, then **60**, which was "thirty students doubled for the retries a real form
produces". Both parts of that were wrong by 2026-08-12: retries are free (only a created account is
charged, so a mistyped password, a taken address, a shed request and a reload all cost nothing), and
"thirty" was a club committee rather than a room. Measured against the built server in the shape that
ships — 130 students behind one campus NAT, six submits at a time — sixty produced 60 accounts and 70
refusals. The rungs are counts of *people* now: **200** is a full lecture hall with half again over
it, **400** is two of them in the same quarter of an hour and is the deployment ceiling behind a
tunnel, and the server-wide **800** keeps the 2:1 the paragraph below rests on.

**A public instance cannot separate a hundred people signing up from one person signing up a hundred
times.** The only signals this process has are a header the caller writes and a TCP peer that is one
value for everybody behind your tunnel, and there is no email verification to stand in for an
identity. So mass registration and denial of registration are the same act here, and a ceiling only
chooses which of the two an attacker gets. What is left is to make either one **bounded, loud and
reversible**: bounded by the three numbers, loud because closing a rung writes an audit row naming
which rung and roughly where from, and reversible because an administrator can delete the accounts
and the refusal lasts fifteen minutes rather than forever. An operator who needs more than that needs
a signal this process does not have, which means an authenticating proxy in front of it.

**What an attacker can still reach, rather than a reassurance:** 800 accounts per fifteen minutes
sustained is 76,800 a day, or **38,400 a day behind the tunnel**, where the network rung is the real
ceiling. At a measured 983 bytes of checkpointed SQLite per account — three rows, not two, because
registration signs the new member in — that is roughly 75 MB of database a day and an *Admin →
Users* screen with a day of junk in it. That is the price of the refusal being honest and of a
lecture hall fitting in one sitting, and the trade is the point: the same 800 is what somebody must
genuinely *create*, every window, to hold registration closed for everyone else, where the first
version of this ladder let 240 requests that created nothing do it. A rung that refuses charges
nothing, so one network can only ever put its own 400 into the server-wide 800: **closing that one
takes at least two networks acting together.** Behind a tunnel, where every caller shares the network
rung, that arithmetic protects less than it sounds, and it is stated rather than assumed.

**Two people signing up with the same address at the same instant get one account, not two.** The
uniqueness of `users.email_normalized` is enforced by the database rather than by a check the handler
does first, so the limit holds under concurrency rather than only in a demo. That is stated because
the opposite has shipped here before, one floor down: the [callsign lookup](#the-callsign-lookup)'s
guard against two simultaneous requests to one host could not see a request that had not answered
yet, and eight simultaneous presses produced eight requests where one was intended — measured on
2026-08-04, with the guard present and every one of its own tests green. A limit checked before an
`await` and written after it is not a limit.

| Route | Who | What it does |
|---|---|---|
| `POST /api/auth/enroll` | public | creates the member account and signs them in |
| `GET /api/auth/bootstrap-status` | public | `{ required: boolean }` — whether this instance still has no accounts |
| `POST /api/auth/bootstrap` | public, once | spends the first-run token and makes the first administrator |
| `POST /api/admin/users` | admin | creates an account with a chosen role and a generated password shown once |
| `DELETE /api/admin/users/:id` | admin | deletes the account and everything keyed to it; the audit trail stays |

The sign-up route keeps its old path. Renaming it would have broken a browser tab left open across
the upgrade for no gain, and the same reasoning is why a body that still carries a `code` field is
not refused: zod strips the key, so the old form posts successfully instead of meeting a validation
error it has no wording for.

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

Then read the one-time admin bootstrap token out of the file the container wrote it to. The
**first administrator always comes from that token**: until it is spent this instance has no
accounts, the sign-up form is not offered and the route refuses, so [signing up](#signing-up)
cannot bootstrap an instance. What you get is a first-run screen: open the app and, because no
accounts exist yet, it offers **Set up GrantSpotter** instead of a sign-in box, asking for that
token, an email address and a password of at least 12 characters. On success you are signed in as
an administrator. There is no password reset for the first administrator, so store it somewhere you
can find it again.

**The token is not in `docker compose logs`.** It is written to `first-run-token.txt` in your
`DATA_DIR`, readable only by the user this server runs as, and deleted the moment it is spent. A
log is the wrong place for a live credential: `docker logs` keeps the line for the life of the
container, and it gets pasted into issues and shipped to aggregators by people who were never given
the database. The container log carries a banner telling you the path instead — and if the file
could not be written (a read-only volume, a full disk), the banner shouts that and prints the token,
because a deployment nobody can set up is worse.

```bash
# The banner, bracketed by its own `====` delimiters rather than by counting lines: this printed
# nothing useful for a while, because it was `grep -A4` and the banner had grown past four.
docker compose logs grantspotter | awk '/GrantSpotter first-run setup/,/====$/'
docker compose exec grantspotter cat /data/first-run-token.txt
curl -X POST http://127.0.0.1:3030/api/auth/bootstrap \
  -H 'content-type: application/json' \
  -d '{"token":"<the token from that file>","email":"you@example.org","password":"<a long passphrase>"}'
```

A fresh token is written on every restart until an account exists. Now open
`http://127.0.0.1:3030` (or whatever you set `HOST_PORT` to) and sign in with those credentials.
From here an account is made one of two ways: you create it from **Admin → User accounts**, with the
role you choose and a generated password you hand over, or somebody creates their own at the
[sign-up form](#signing-up), which always makes a member.

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
| `CONTACT_URL` | **yes** | **no default** | an `http(s)` page **you** control and a stranger can reach; goes in the crawler User-Agent. The server refuses to start without it, and refuses by value: a `CHANGE_ME` placeholder, a reserved documentation name or address, an address nobody outside your network can reach, and anything that is not printable ASCII |
| `DATA_DIR` | no | `/data` | SQLite, snapshots, fixture cache |
| `CRAWL_ENABLED` | no | `true` | |
| `CRAWL_CRON` | no | `17 3 * * *` | nightly, jittered in code |
| `CALLSIGN_LOOKUP_ENABLED` | no | `true` | the one user-initiated request this product makes. `false` and the route is not registered, so this deployment never contacts `callook.info` — see [The callsign lookup](#the-callsign-lookup) |
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

**A third variable used to be able to stop the boot and no longer exists.** `ENROLLMENT_CODE` — with
`ENROLLMENT_CODE_MAX_USES` and `ENROLLMENT_CODE_DAYS` beside it — carried a code an operator could
set in the file instead of issuing one in the app, and `loadConfig` refused to start rather than
issue a code that broke one of the rules for a chosen code. All three are gone with the feature
([Signing up](#signing-up)). An old `docker-compose.yml` that still names them starts normally:
nothing reads them, so they are ignored rather than refused, and only the two above can stop a boot.

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
