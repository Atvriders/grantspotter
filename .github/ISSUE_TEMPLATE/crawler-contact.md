---
name: A GrantSpotter crawler is polling my site
about: For site owners who found this repository by searching the name in their logs
title: 'Crawler: '
labels: crawler
---

**Start here: the crawler did not send you to this page, and we probably do not run the instance
that visited you.** GrantSpotter is self-hosted software. Every deployment puts its own operator's
contact page in its User-Agent — the address in the log line you are holding belongs to whoever runs
that instance, and that is the person who can switch it off. This repository is where the software
is written, not where the crawlers are.

You are probably here because you searched the name out of a log line shaped like this, where the
URL is somebody's own:

```
GrantSpotter/0.1.0 (+https://example-club.org/about; nightly grant-deadline change detector; contact the operator of this instance at that page)
```

**If you just want it to stop, you do not need us, you do not need them, and you do not need to
wait for anybody.** GrantSpotter honours `robots.txt` and matches on the agent token
`GrantSpotter`, so this stops every deployment of it, not only the one that visited you:

```
User-agent: GrantSpotter
Disallow: /
```

The token is matched **case-insensitively**, and a version or suffix after it is fine — so
`GrantSpotter`, `grantspotter`, `GrantSpotter/0.1.0` (the exact string in the log line above) and
`grantspotter-bot` all work. `User-agent: *` works too, and so does a `Crawl-delay:` if you would
rather slow it down than block it. What does *not* match is a longer word that merely starts the
same way, like `grantspotterbot`, because that is somebody else's crawler.

Consecutive `User-agent:` lines are one group, so it is fine to name us alongside other agents, and
a blank line, a comment or a `Sitemap:` line between them changes nothing. (That was not true until
2026-08-04: any of those three split the group and the rules landed only in the last one.)

How long that takes, so you can tell whether it worked: an instance re-reads your `robots.txt` at
the start of every nightly crawl, and any copy it is holding expires after six hours, so the
polling should stop within a day. It is not instant, and until 2026-08-04 it was not guaranteed at
all — an instance read a site's `robots.txt` once per server process and cached it for the life of
the process, so a container that had been running for months never noticed a new file.

**If requests keep arriving after a day, that on its own does not mean anything is broken.** Five
things that are all normal:

1. **`/robots.txt` itself is still fetched.** `Disallow: /` stops us reading your pages; it cannot
   stop us reading the file that says so. A blocked site should see **one request per night** per
   origin we poll it under, and that is the whole footprint — but the honest bound is a little
   higher than one, and here is exactly where the extras come from, so that seeing three does not
   look like the block failing:
   - **"Per origin" is doing real work in that sentence,** because rules are per origin and we have
     genuinely not read yours for `https://` until we ask `https://`. If our shipped source list
     names your site under two spellings — `http://` and `https://`, or apex and `www` — you will
     see **two** `/robots.txt` requests a night, one per origin, and both will be obeyed. One of
     the sites this ships with is in exactly that state today, so this is a measured fact and not a
     hypothetical (`npm run measure-pacing twoOriginsOneHost`). And if the `http://` one *redirects*
     to the `https://` one, as most sites that still answer `http://` do, it is **three**: the
     redirect, the file at the far end, and then the `https://` origin's own copy — because rules we
     fetched across a redirect belong to the origin we asked, not to the one that answered
     (`npm run measure-pacing twoOriginsRedirectingRobots`). Serving the file directly on every host
     and scheme you answer on is what makes each of them a single, final request.
   - **A redirect is followed.** If `/robots.txt` 301s — apex to `www`, `http` to `https` — each hop
     is a request, up to five of them. Serving the file directly on every host and scheme you answer
     on removes this entirely.
   - **A failed read is retried,** up to four attempts, if the connection drops or you answer 429 or
     5xx. That is the same budget any other request gets, and it is deliberate: a file that governs
     a whole origin should not be the least-retried thing we ask for.
   - **Nine requests is the hard ceiling, and it covers everything one page fetch can cost —
     you, and anywhere you redirect us to.** The `/robots.txt` read, every redirect hop, and every
     retry of any of them spend **one** shared budget, so they cannot multiply: a `/robots.txt` that
     redirects five times *and* answers 429 at every hop costs **nine** requests, not 5 x 4 = 24,
     and when the budget runs out we stop and skip your site for the night. Every one of the nine is
     at least a second after the one before it, and longer if you send `Retry-After` or publish a
     `Crawl-delay` — whichever of the three is longest wins, and they are never added together.

     **Until 2026-08-04 the two budgets multiplied and this paragraph did not say so.** Measured
     against a test server that redirected five times and 429'd at every hop: 19 requests in 6052
     ms, 12 of the 18 gaps under 5 ms. The same scenario now costs 9 requests over about 8 seconds
     with every gap over a second (`npm run measure-pacing redirectChainThat429s`).

     **And then twice more the same day, because "nine to whom" turned out to be the hard part.**
     First the ceiling was nine for the page and another nine for the `robots.txt` that authorised
     it, and a fresh nine again for every scheme or port your one machine answered on — counted, one
     page fetch: **18** for a plain host, **20** where `http://` redirected to `https://`, and
     **63** across six origins of one machine. Then, after that was fixed, it was still a fresh nine
     for every NAME your machine answered to — so an apex that 301s to `www`, which is the commonest
     redirect there is, cost **18**, and the handover from one of your names to the other arrived
     4 ms after the redirect instead of a second later. Both are fixed, and the fix was to stop
     trying to work out which of your names are yours: the budget now belongs to the **fetch**, not
     to a host, so it is nine requests wherever they land. A redirect to somebody *else's* host
     spends the same nine rather than opening a new one.

     Those are real numbers off real sockets, and **you can reproduce every one of them on your own
     machine** — that is the point of publishing them. In a clone of this repository:

     ```
     npm run measure-pacing twoNamesOneMachine   # apex -> www, both names in distress:   9
     npm run measure-pacing nameChangeHealthy    # apex -> www, healthy:                   4
     npm run measure-pacing schemeChange         # http -> https, over real TLS:           9
     npm run measure-pacing ceilingManyOrigins   # five redirects, six origins:            9
     npm run measure-pacing                      # all of it, about two minutes
     ```

     It drives the real crawler against throwaway servers on your loopback interface and prints the
     millisecond gap between every request each one actually received. The `schemeChange` line
     generates its own certificate with `openssl` and deletes it afterwards; the two `Name` lines
     bind `127.0.0.2` as well as `127.0.0.1`, which is how two hostnames are put in front of one
     machine. Any scenario that cannot get what it needs says so and skips instead of failing.

     The "before" figures above are the exception and are labelled as one: the 19 requests in 6052
     ms, and the 18 and 20 and 63, were measured at commits `2c098d9` and `8ec9873`, and cannot be
     re-measured from the current code because the code that produced them is gone. Everything in
     the block above is what this software does today.

     One of those numbers was worse than unreproducible and it is worth saying so on the page that
     asks you to trust the others: the `20` was taken with a throwaway script and a self-signed
     certificate that was **never committed**, while this paragraph said you could reproduce it with
     `npm run measure-pacing`. You could not — the harness had no way to serve https. It makes its
     own certificate now, which is what the `schemeChange` line above runs.
   - Nothing else. There is no second file, no probing, and no request at all to a path you have
     disallowed. (One request in this software is not the crawler and is not governed by
     `robots.txt`. It goes to `callook.info` and to no other host in the world, so unless you run
     `callook.info` it is not what you are looking at. It is described at the bottom of this page
     anyway.)
2. **We could not read your `robots.txt`.** If it 404s or 403s we read that as "this site publishes
   no rules" and keep polling — that is what a 403 means when ncdxf.org does it deliberately, so we
   cannot treat it as a block. If the connection is *dropped*, or you answer 429 or 5xx, we now stop
   crawling that origin instead: we did not read your rules, so we do not act as though they permit
   us. (Until 2026-08-04 a dropped connection was read as "no rules published", and the site was
   crawled.) If you have blocked us at the edge, allowing `/robots.txt` through turns the block into
   the real thing rather than a wall we keep walking into.
3. **Rules are per origin, and `www` is a different origin.** A file at
   `https://www.example.org/robots.txt` says nothing about `https://example.org/` or about
   `http://`. Serve it from every host and scheme you answer on.
4. **It is a different instance.** This is self-hosted software; whoever is polling you may have
   started last week. `robots.txt` stops all of them, but each one only notices on its own next
   run, and an instance that is switched off, paused, or scheduled for something other than nightly
   notices later than one that runs every night.
5. **It is not us at all.** Our User-Agent string is published in this repository, and nothing
   stops another program from sending it. If the volume looks nothing like "a handful of pages once
   a night", suspect that first — and tell us, because we would like to know.

Blocking or 403ing the User-Agent token `GrantSpotter` at your edge takes effect immediately and
depends on nobody — this crawler never spoofs a browser User-Agent, so blocking it by name works
and keeps working.

**What we can and cannot do, said plainly.** We cannot stop somebody else's deployment. We do not
operate it, cannot inspect it, and in almost every case do not know it exists — which is why the
crawler carries its operator's address rather than ours, and why this page is not linked from the
User-Agent. Writing to us about an instance we do not run gets you an apology and a delay.

What we *do* control is the list of sources this software ships with. If your site is on that list,
we can take it off, and every install that updates will stop polling you. That is a real remedy and
it is the reason this template exists — tell us and we will.

If you would rather just tell us it is a nuisance, that is a legitimate issue too. This crawler
exists to track grant deadlines for volunteer radio clubs, it fetches a handful of pages once a
night, and it is not supposed to cost anybody anything.

**One request in this software is not the crawler, and `robots.txt` does not stop it.** It is put
here, unprompted, because a page that tells you `robots.txt` stops everything and is wrong about
one case has taught you to discount the rest of it.

GrantSpotter has a button that fills a user's own amateur licence details into their own profile.
Pressing it makes **one** request to `callook.info` — the free republisher of the FCC amateur
licence database — and to no other host, ever. It is not scheduled, follows no redirect, retries
nothing, stores no copy of the page and enumerates no URLs; with nobody typing a callsign and
pressing the button, it never runs at all. **So unless you run `callook.info`, this is not what is
in your log**, and the paragraphs above are the whole story for your site.

The honest part: `callook.info/robots.txt` says `Disallow: /`, and its own API reference says *"The
callook.info API is publicly available and is free to use however you wish."* Both documents belong
to that site owner and they address different clients — RFC 9309 scopes `robots.txt` to automatic
clients that go looking for URLs, which a person pressing a button about their own licence record
is not. We think that reading is right; we also know it is a reading, and the argument is set out
in full, including the part that cuts against us, in the project README under "The callsign
lookup". Every operator can switch the feature off with one line of configuration, and the default
is documented rather than silent.

**If you are callook.info:** that is the request you are seeing, it carries the operator's own
contact page in its User-Agent like everything else this software sends, and asking us to stop is a
change to the shipped software rather than to somebody's private deployment — which is the kind of
remedy we can actually deliver. Tell us and we will.

Useful if you have it, all optional:

- the domain or URL being fetched
- a log line or two, with the date, time and full User-Agent — **including the `+https://…` part**,
  which names the operator you actually want and which we can read even when we cannot act on it
- the source IP, if the polling looks heavier than "a few pages, once a night"
