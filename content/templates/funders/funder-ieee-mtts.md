---
id: funder-ieee-mtts
title: IEEE MTT-S Chapter Support — funder overlay
layer: funder
order: 60
appliesTo: [adjacent_stem, ham_grant]
funderId: ieee-mtts
programIds: [ieee-mtts-chapter-support]
lengthTarget: short; the application is a form, not a proposal
requires: [project-description, measurable-outcomes, activities-timeline, budget-justification]
sources:
  - label: IEEE MTT-S Chapter Support (captured to fixtures/ieee-mtts/00-mtt-org-chapter-support.html)
    url: https://mtt.org/chapter-support/
---

## Three published preconditions decide eligibility before anyone reads your request

The page gathers them under one sentence — chapters "must have fulfilled all the following requirements for an 'active' status to be eligible for any one of the below funding programs" — and then lists them:

**Members.**

> Minimum of ten (10) members; five (5) members for Student Branch Chapters

Both figures are the funder's. Which one applies to you depends on what kind of chapter you are, and a student group is normally a Student Branch Chapter, so confirm your chapter type in IEEE's records before relying on the lower figure. An earlier note inside this project stated only the lower one, which would have told a joint or section chapter it qualified when the page says it does not.

Members on the roll: {{chapter.memberCount}}

**Officer roster.**

> Complete up-to-date Chapter Officer roster reported via

vTools Officer Reporting. This is the precondition that fails silently: a roster nobody has updated since last year's officers graduated is invisible until somebody checks it, and the person who checks it is the one deciding your request.

vTools officer roster: {{chapter.officerRosterUrl}}

**Reported meetings.**

> Minimum of two (2) reported technical meetings via

vTools Events, and the page qualifies it: "in the previous year, Chapters less than one-year-old are exempt from this requirement". Reporting is a separate act from holding the meeting — an event that happened and was never reported did not happen as far as this gate is concerned, and the previous year is over, so this is the precondition you cannot fix in September.

Technical meetings reported: {{chapter.meetingCount}}

The page also puts a step before all three:

> Before a chapter applies for MTT-S financial support they should apply for support from the IEEE Section to which that chapter reports

so have an answer ready about what your Section did or did not give you.

## What the page publishes

- **Chapter Activity Support** — "$1,000 per year for single-society MTT-S Chapters or $500 per year for Joint Chapters which are associated with MTT-S".
- **Chapter Workshop/Symposium Support** — "The fund provides $500 seed money per chapter" toward a yearly workshop or symposium. Three conditions attach to the event itself: "The event must be at least four (4) hours in length", "An IEEE MTT-S membership booth must be present at the event", and "The MTT-S Regional Coordinator must endorse the proposed event".
- **Chapter Officer Travel Support** — "up to $2,250 per year to send a Chapter Officer" to a Chapter Chair Meeting. A separate programme behind the same active-status gate.

Both funding programmes are applied for through the Chapter Funding form, which is hosted on Jotform (`form.jotform.com/243523980737161`). Affinity-group sponsorship is a different route with a different form, and the page warns that "A sponsorship request usually requires a detailed description and mandatory post-event reporting".

What this page does **not** publish is any scholarship or fellowship amount. If you have seen figures quoted for MTT-S undergraduate scholarships or graduate fellowships, they came from a different page — cite that page, and do not carry the figures into an application written against this one.

## A deadline, not a window

> IMPORTANT: All requests for MTT chapter funding must be received by October 1 or the chapter may be asked to make its application in the following year.

That is the only date on the page. It is a receipt-by date with no opening date beside it, and GrantSpotter models it as a deadline for that reason: modelling a single date as a one-day window would make this programme read as `closed` on every other day of the year and would require inventing an opening date IEEE never printed.

Read the consequence clause as carefully as the date. "may be asked to make its application in the following year" is the funder's discretion, not a promise of a second chance and not a stated rejection. Submit before October 1 and you never have to find out which it is.

## What to ask for

Chapter support money pays for chapter activity: speakers, demonstrations, meeting costs, competition entry, and equipment tied to a technical programme with dates on it. Tie every budget line to an event with an expected attendance.

> {{club.name}} requests {{project.requestAmount}} for {{project.title}}, running {{project.startDate}} to {{project.endDate}} at {{project.venue}}.

An amateur radio programme sits naturally inside this society's scope, and it is worth describing in the society's own vocabulary — microwave theory and techniques, RF measurement, propagation, antenna work — rather than in club vocabulary. A spectrum demonstration, an antenna measurement session, a software-defined radio workshop or a direction-finding exercise are all recognisable to a reviewer whose society is about microwave and RF engineering.

## Overlay checklist

- [ ] Chapter type confirmed, and the member minimum that applies to that type is met
- [ ] vTools officer roster checked and updated today
- [ ] Technical meetings for the previous year reported in vTools, not merely held
- [ ] The IEEE Section has been asked first
- [ ] Every budget line tied to a dated event with an expected attendance
- [ ] Request submitted through the Chapter Funding form before October 1
