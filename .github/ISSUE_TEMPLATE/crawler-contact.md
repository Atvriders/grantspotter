---
name: A GrantSpotter crawler is polling my site
about: For site owners who found this repository through the User-Agent in their logs
title: 'Crawler: '
labels: crawler
---

You are probably here because you saw this in a log:

```
GrantSpotter/0.1.0 (+https://github.com/Atvriders/grantspotter/issues; nightly grant-deadline change detector; open an issue there to contact the maintainers)
```

**If you just want it to stop, you do not need us and you do not need to wait for us.**
GrantSpotter honours `robots.txt` and matches on the agent token `GrantSpotter`, so this stops
every deployment of it, not only the one that visited you:

```
User-agent: GrantSpotter
Disallow: /
```

The token is matched **case-insensitively**, and a version or suffix after it is fine — so
`GrantSpotter`, `grantspotter`, `GrantSpotter/0.1.0` (the exact string in the log line above) and
`grantspotter-bot` all work. `User-agent: *` works too, and so does a `Crawl-delay:` if you would
rather slow it down than block it. What does *not* match is a longer word that merely starts the
same way, like `grantspotterbot`, because that is somebody else's crawler.

How long that takes, so you can tell whether it worked: an instance re-reads your `robots.txt` at
the start of every nightly crawl, and any copy it is holding expires after six hours, so the
polling should stop within a day. It is not instant, and until 2026-08-04 it was not guaranteed at
all — an instance read a site's `robots.txt` once per server process and cached it for the life of
the process, so a container that had been running for months never noticed a new file.

**If requests keep arriving after a day, that on its own does not mean anything is broken.** Five
things that are all normal:

1. **`/robots.txt` itself is still fetched.** `Disallow: /` stops us reading your pages; it cannot
   stop us reading the file that says so. Expect one request per night, forever. That is the whole
   footprint of a blocked site.
2. **We could not read your `robots.txt`.** If it 404s, 403s, or is blocked by the same WAF rule
   that blocks the crawler, we read that as "this site publishes no rules" and keep polling — and
   keep collecting your 403s. If you have blocked us at the edge, allow `/robots.txt` through and
   the block becomes the real thing rather than a wall we keep walking into.
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

If none of those fit, please do open an issue. A log line with a date and the full User-Agent is
enough for us to tell you which of the five it is.

Blocking or 403ing the User-Agent token `GrantSpotter` at your edge takes effect immediately and
depends on nobody — this crawler never spoofs a browser User-Agent, so blocking it by name works
and keeps working.

**What we can and cannot do.** GrantSpotter is self-hosted software: anyone can run their own
instance, and we do not operate, control or even know about most of them. If the polling came from
somebody else's deployment, we cannot switch it off. What we *do* control is the list of sources
this software ships with — so if your site is on that list, we can take it off, and installs that
update will stop polling you. Tell us and we will.

If you would rather just tell us it is a nuisance, that is a legitimate issue too. This crawler
exists to track grant deadlines for volunteer radio clubs, it fetches a handful of pages once a
night, and it is not supposed to cost anybody anything.

Useful if you have it, all optional:

- the domain or URL being fetched
- a log line or two, with the date, time and full User-Agent
- the source IP, if the polling looks heavier than "a few pages, once a night"
