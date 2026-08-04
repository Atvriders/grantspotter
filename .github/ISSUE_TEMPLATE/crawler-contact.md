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

One caveat we would rather tell you than have you discover: an instance reads a site's
`robots.txt` once per server process and caches it, so a container that has been running for
months will not notice your new file until it restarts. Blocking or 403ing the User-Agent token
`GrantSpotter` at your edge takes effect immediately and depends on nobody — this crawler never
spoofs a browser User-Agent, so blocking it by name works and keeps working.

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
