---
id: funder-arrl-club-grant
title: ARRL Club Grant Program — funder overlay
layer: funder
order: 30
appliesTo: [ham_grant]
funderId: arrl-foundation
programIds: [arrl-club-grant]
requires: [need-statement, project-description, measurable-outcomes, activities-timeline, budget-justification, sustainability, evaluation-plan, organizational-capacity]
lengthTarget: 1200-2000 words total
sources:
  - label: ARRL — Club Grant Program (the 2024 results page, and the only page this programme has)
    url: https://www.arrl.org/club-grant-program
  - label: ARRL news feed — the only reliable signal for this programme's cycle
    url: http://www.arrl.org/news/rss
---

## Read this first: the cycle is disputed

GrantSpotter does not know when this programme's next window opens, and it will not guess.

The programme page shows the 2024 results, no open cycle, and no application link. The application
portal is a JavaScript application that serves no text to a non-browser client, so open and closed
states cannot be read programmatically. Research on 2026-08-02 produced **three different**
conclusions from three passes:

- the programme is dormant between cycles;
- the programme runs an autumn window, on the pattern of an observed 2022 cycle;
- the programme runs February, June and October windows — which is almost certainly a conflation
  with the separate **ARRL Amateur Radio Grants** programme, which does publish those three
  windows, and which is a different programme with a different application.

Treat all three as unresolved. GrantSpotter's ingestion layer ships this programme's record marked
`disputed` for exactly this reason, and publishes no date.

The reliable signal is the **ARRL news feed**, which carries grant and deadline announcements
through the year. Star this programme so a change event reaches you, and read the programme page
yourself before you commit any effort.

## What is known, because the page states it

"The ARRL Foundation is pleased to report that 37 Amateur Radio Clubs benefitted from $500,502 in
grants through the Club Grant Program to implement projects that educate, recruit, train, and
promote Amateur Radio in their communities."

"There were 110 applicants to the 2024 ARRL Club Grant Program, with applicants from all ARRL
Divisions and 40 states, requesting nearly $1.6 million in support, in amounts as small as $1,000
to as large as the maximum $25,000."

Read together: **37 of 110** applicants were funded, and the average award works out at about
$13,500 — that average is GrantSpotter's arithmetic on ARRL's two figures, not a number ARRL
published. This is the largest club-scale grant in US amateur radio, and roughly two applications
in three went home with nothing.

The money comes from the same place as most of this sector's: "The ARRL Foundation is grateful for
the generosity of Amateur Radio Digital Communications (ARDC) which provided the funding for this
grant program." That does **not** import ARDC's own conditions — the open-access requirement and
the indirect-cost ceiling in the ARDC overlay are terms of an ARDC grant, and this is an ARRL
grant. It does mean both programmes depend on one funder.

Collegiate clubs are squarely in scope. The published 2024 recipient list includes the Kansas State
University Amateur Radio Club, the Missouri S&T Amateur Radio Club, the Oklahoma State University
Amateur Radio Club, the WA5BU Amateur Radio Club at Baylor University, and the City Tech Radio
Club.

Those 37 clubs are **past awards, not opportunities.** GrantSpotter records them as `past_award`
and never shows them as something you can apply to. Use them the way they are useful: as evidence
of what this programme funds, and as clubs whose officers will take your call.

## What the page does not say, and what GrantSpotter will not invent

**Eligibility is unresolved.** The capture of this page taken on 2026-08-02 contains
no occurrence of "affiliat" or "eligib" anywhere in its HTML, in any form.
Older guidance elsewhere describes an
ARRL affiliation condition; this page does not state one, so GrantSpotter states none. Omission is
the safer error here — a missing constraint under-restricts, and an applicant who reads the
funder's page can correct it, while an invented constraint would quietly hide a grant from a club
it may be for.

State your own status rather than guessing at theirs, and confirm the rest with the one address the
page does publish: "Questions about the Club Grant Program can be sent to clubgrants@arrl.org."

> {{club.name}} ({{club.callsign}}) at {{club.institution}} is an ARRL-affiliated club:
> {{club.arrlAffiliated}}.

**No published deadline, no published page limit, no published attachment list, and no AI policy.**
The captured page mentions AI, ChatGPT and language models exactly zero times. GrantSpotter reports
each of these as unaddressed rather than inferring one.

## What an ask at this scale has to carry

At the top of this range the application is a real proposal rather than a form, which is why this
overlay expects every component — including the evaluation plan, which most club applications skip.

> {{club.name}} ({{club.callsign}}) has {{club.memberCount}} members and requests
> {{project.requestAmount}} of a {{project.budgetTotal}} project.

Two figures on that line will be read against each other. If the request is the whole project cost,
the sustainability section has to explain who pays afterwards; if it is part, name the rest.

## Overlay checklist

- [ ] Cycle confirmed **on the programme page**, not from this app and not from a search snippet
- [ ] Programme starred in GrantSpotter so a cycle announcement reaches you
- [ ] Affiliation status confirmed with ARRL rather than assumed in either direction
- [ ] Request sits inside the published range and is justified line by line
- [ ] Evaluation plan present, with instruments and the dates you will collect them
- [ ] Sustainability answers who pays and who maintains after {{project.endDate}}
- [ ] Any comparison to a 2024 recipient's project is described as theirs, not implied as yours
