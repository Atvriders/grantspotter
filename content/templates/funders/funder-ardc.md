---
id: funder-ardc
title: ARDC Grants Program — funder overlay
layer: funder
order: 10
appliesTo: [ham_grant, adjacent_stem]
funderId: ardc
programIds: [ardc-grants]
requires: [need-statement, project-description, measurable-outcomes, activities-timeline, budget-justification, sustainability, organizational-capacity]
lengthTarget: keep the whole application short; ARDC says so explicitly
sources:
  - label: ARDC — Apply for a Grant (deadlines, eligibility, open access requirement)
    url: https://www.ardc.net/apply/
  - label: ARDC — Grant Application Instructions (budget, indirect costs, brevity, AI)
    url: https://www.ardc.net/apply/grant-application-instructions/
  - label: ARDC — 2026 Grants (the awards actually made this year)
    url: https://www.ardc.net/apply/grants/2026-grants/
---

Every requirement below is quoted from one of the two ARDC pages cited above. Where ARDC is
silent, this overlay says so rather than filling the silence.

## The two requirements applicants most often miss

**1. What you produce has to be free for the public to use.** The eligibility line is blunt:
"projects that are not open source and open access are not eligible". The condition lands on the
OUTPUT, not on the paperwork — "all technology, documentation, and other materials produced using
ARDC funds must be made freely available to the public, ideally using one of the below open source
licenses":

- Software: GPL licenses (esp. AGPLv3), MIT, BSD, LGPL
- Hardware: CERN Open Hardware License — CERN-OHL for short, and the version matters, so name it
- Media, writing, images etc.: Free Culture subset of the Creative Commons licenses, particularly
  CC-BY-SA, as well as CC-BY and CC0

ARDC presents that list as its preference — "ideally" — and invites you to email if you would
rather use a different open licence. The freely-available condition itself is not a preference. A
project that intends to keep its firmware, board files or course materials private is ineligible,
and no amount of narrative quality repairs that at review time.

Name the licence and say where the work will live:

> All software, board files and documentation produced under this grant will be published under
> {{project.openLicense}} in a public repository.

ARDC publishes no deadline for that publication, so do not promise one you invented. Promise the
licence and the venue, which are yours to control.

**2. Indirect costs stop at twenty percent.** "You may include up to 20% for indirect costs, such
as phone, internet, rent, accountants, software, bank fees, human resources, lawyers, small
supplies, contingency for unexpected project costs, and anything else that can be hard to
itemize."

If your institution's negotiated rate is higher, ARDC states its own remedy, and it is not a
renegotiation: "If your organization's indirect cost rate is more than 20%, we ask that you
cost-share any indirect amount over 20% to allow us to maximize the funds we can distribute to
others." Put the arithmetic in the budget so a reviewer never has to do it:

> Indirect costs are charged at {{project.indirectPct}}% of direct costs, at or below the ceiling
> ARDC states in its application instructions.

## Who may apply

Eligible organizations, in ARDC's words: "U.S.-based 501(c)(3) public charity, government agency,
school, or university" and "International charity, nonprofit, school, or university". Also in
ARDC's words: "US & international for-profit businesses are currently not eligible for ARDC
grants."

Clubs and individuals go through a sponsor — "Radio clubs and groups who are NOT nonprofits, as
well as individual applicants, are not eligible for a grant unless they have a nonprofit fiscal
sponsor." The instructions page adds who can be one: "Fiscal sponsors must be 501(c)(3)'s, local
government organizations, universities, or schools", and warns that "ARDC usually cannot find a
fiscal sponsor for you". Name yours early:

> Funds would be received and administered by {{club.fiscalSponsor}} on behalf of {{club.name}}
> ({{club.callsign}}).

## When

You may submit at any time — "You can apply for a grant at any time during the year. Four times a
year, we review applications." The apply page then states the review dates: "The 2026 application
deadlines are":

- **February 1**
- **April 1**
- **July 1**
- **September 1** (and the window ARDC asks scholarship programmes to use: "Organizations looking
  to apply in this category should apply during our September 1st funding window.")

"Applications received after September 1, 2026 will be reviewed February 1, 2027", and
"applications generally take 60-120 days to evaluate". Read those two sentences together before
you commit to a start date: work that must begin a month after a review date is not fundable on
this calendar, however good the proposal is.

## How much, and what the odds are

ARDC publishes no maximum award. The awards it published for the current year run from $1,285
(Delta Amateur Radio Club, Kraken SDR Education Project) to $258,000 (GNU Radio), with several
rows still listed as TBD.

Two numbers ARDC states about itself: "in 2026 we aim to fund approximately $3.8 million" and
"As of 2025, we fund about 30% of the submitted proposals". The first is ARDC's annual grantmaking
budget, not an award size — do not read it as what you could receive. Ask for what your line items
add up to.

## Brevity, and ARDC's stated view of AI

"We want you to be thorough, but please keep your application brief." That is a review criterion,
not a courtesy. ARDC's guidance on writing with AI is permission with a diagnosis attached: "If
you choose to use AI when writing your proposal be sure to thoroughly edit for clarity, brevity,
and accuracy. If the proposal is extremely long and hard to understand, we can't evaluate or
support it." The stated concern is bloat, not ethics.

The R&D guidance adds the other half of the same instruction — "Avoid unnecessary jargon.
Introduce the goals of the project in a way that avoids jargon or undefined acronyms."

## Where applications fail

ARDC names its own most common rejection: "Lack of detail in the project plan is the most common
reason applications are rejected." Detail here means the work schedule, who does each part, and
enough specificity that a reviewer can tell your team knows how to do the work.

Apply at <https://grants.ardc.net>, which requires an account before you can start the form.

## Overlay checklist

- [ ] Open licence named, with the public venue the work will be published at
- [ ] Indirect at or below 20%, shown as arithmetic, with any excess cost-shared
- [ ] Fiscal sponsor named, if the applicant is a club that is not a nonprofit, or an individual
- [ ] Submitted against one of the four review dates, with 60-120 days of evaluation before work
      must start
- [ ] Project plan detailed enough to answer "does this team know how to do the work"
- [ ] Jargon and undefined acronyms removed; the brevity pass run
- [ ] Every budget figure traceable to a quote or a catalog price
