---
id: funder-arrl-foundation-scholarships
title: ARRL Foundation Scholarships — funder overlay
layer: funder
order: 40
appliesTo: [ham_scholarship]
funderId: arrl-foundation
programIds: [arrl-foundation-scholarships]
requires: [scholarship-personal-essay, recommendation-request-email, thank-you-letter]
lengthTarget: essay 400-600 words; the rest is a form
sources:
  - label: ARRL — Scholarship Descriptions (the catalog, and the cycle dates)
    url: https://www.arrl.org/scholarship-descriptions
  - label: ARRL — Scholarship Program (the portal, and the current cycle status)
    url: https://www.arrl.org/scholarship-program
  - label: ARRL — Summary of Scholarship Requirements (geography, award by award)
    url: https://www.arrl.org/summary-of-scholarship-requirements
  - label: QCWA — Scholarship Program, awarded through this cycle with an extra step
    url: https://www.qcwa.org/scholarship-program.htm
---

## One application form — and the question ARRL's pages do not answer

Both ARRL pages state the same instruction: "All applicants must submit a completed online
application", after which "The ARRL Foundation Scholarship Committee will review all applicants
for eligibility and award decisions."

What applicants actually want to know is whether that one application is matched against the whole
catalog, or whether each award needs its own. **The captured ARRL pages do not say**, and
GrantSpotter will not print an answer it cannot quote. The nearest thing to a ruling is on the
Summary of Scholarship Requirements page — "Applicants should only apply for those awards for which
they qualify" — which reads as selection inside the application rather than a separate application
per award. That is a reading, not a statement. Ask ARRL if the answer changes what you would do.

One instruction survives both readings, so act on it: **answer every optional eligibility field.**
A blank field cannot match. Awards in this catalog are keyed to geography, licence class, field of
study, institution type and academic standing, and several are keyed narrowly enough that one
unanswered question removes you. The Six Meter Club of Chicago Scholarship, to take a published
example, is open to a "Resident of IL or ARRL Central Division (Indiana, Wisconsin)" — an
applicant who leaves their state or Section blank is invisible to it.

## How large the catalog is, and why two numbers appear

GrantSpotter parses **111** distinct entries from the Scholarship Descriptions page, and that
is the number the app works from. ARRL's own two pages, captured the same day, describe the
portfolio differently. The descriptions page: "The ARRL Foundation manages more than 150
scholarships established by generous donors ranging from $500 to $25,000." The scholarship program
page: "The ARRL Foundation manages more than 170 scholarships established by generous donors
ranging from $500 to $25,000." Both sentences are ARRL's. GrantSpotter shows both rather than picking the
one that sounds better, because an entry in a catalog and an award paid out are not the same unit
and neither page says which it is counting.

## Dates, and the detail ARRL does not publish

"The 2026 scholarship cycle runs from October 30, 2025 to December 30, 2025."

The portal currently reads shut: "The 2026 Scholarship Cycle is now closed."

**ARRL publishes no closing TIME on either captured page.** Third-party sites do, and a time of day
is the highest-consequence detail on this whole page: an applicant who assumes midnight when the
form shuts earlier loses a year. GrantSpotter states no hour, and neither should you — ask ARRL
what time the form closes, in writing, in the week you intend to submit.

This one cycle carries more than its own weight. **112 records in GrantSpotter's corpus inherit
their deadline from it**, so when ARRL moves this date, a large part of the ham scholarship
calendar moves with it. That is why the app shows this programme's `lastVerifiedAt` beside the
date, and why a date you remember from last year is not evidence.

After the close: recipients "will tentatively be notified in June via email", and "Awards are
mailed directly to recipients' schools and will be awarded in July." Plan your funding gap around
July, not around June.

## What every applicant must supply

- "All applicants must be an active, FCC-licensed amateur radio operators." Your licence must be
  current on the day you submit, not merely once held.
- "Transcripts and any additional required documents must be submitted WITH the application and
  not emailed separately." The page repeats the consequence: "Applications without accompanying
  transcripts and additional required documents (if applicable) will not be considered."
- "A number of scholarships require additional documents, such as a letter of recommendation from
  a sitting Officer of an ARRL-affiliated club." Use the recommendation request component, and ask
  in October rather than in December.

The two ARRL pages differ on one point worth checking before you rely on it: the descriptions page
notes that "Active foreign amateur radio operators are eligible for some scholarships", while the
program page narrows the same note to the ARDC scholarships. Neither is safe to assume; ask.

## Entries that ride this cycle

Several funders run no application of their own and are awarded through this catalog.

- **ARDC.** A single catalog entry with "Award Amounts: 20 @ $25,000, 4 @ $15,000, 17 @ $10,000,
  4 @ $5,000" — forty-five awards in one entry, by GrantSpotter's arithmetic on ARRL's list, and
  the largest block in the catalog. It is "open to all radio amateurs. US licensure, US residence
  and US citizenship are not requirements", and requires that the "applicant must be licensed for
  at least one year prior to the date of submission of the application."
- **YASME Foundation**, the **Dayton Amateur Radio Association**, and the **Six Meter Club of
  Chicago** each appear as their own catalog entries with their own conditions.
- **QCWA has an extra step, and it starts before the ARRL window does.** Its own page states that
  "Applications should be requested by interested licensed radio amateurs on or after October 31
  of each year from the ARRL Foundation Committee", that "Each applicant must be recommended by an
  active QCWA member", and that "applications must be received by the ARRL Foundation before the
  first week in January each year". Finding a sponsor is the long pole; start that conversation in
  October. QCWA publishes scholarship@qcwa.org for questions.

## A domain not to visit

Older club pages and scholarship guides still send applicants to "the FAR website" for the
Foundation for Amateur Radio's awards. That domain left FAR's control and now redirects to an
unrelated commercial site; GrantSpotter's fetcher hard-blocks it and no template here links it.
Apply through ARRL. GrantSpotter makes no claim about where FAR's historical awards went — nothing
in the captured pages says.

## The essay

> {{student.name}} ({{student.callsign}}), {{student.licenseClass}} since
> {{student.licensedSince}}, studying {{student.fieldOfStudy}} at {{student.institution}},
> graduating {{student.gradYear}}.

Use the scholarship personal essay component for the rest. Selection committees in this catalog
read for demonstrated amateur radio activity rather than enthusiasm about amateur radio — the ARDC
entry asks outright for "proof of amateur radio activity during the previous year". A named Field
Day, a licensing class you taught, a repeater you helped maintain, a satellite contact with a date:
those are the sentences that survive a second reader.

## Overlay checklist

- [ ] Every optional eligibility field answered — Section, division, state, county, class standing
- [ ] Licence active and matching FCC records on the day of submission
- [ ] Transcripts and every extra document attached to the application itself, not emailed
- [ ] Recommenders asked in October, with the date their letter must reach ARRL
- [ ] QCWA sponsor secured separately, if you are applying for that award
- [ ] Closing date **and closing time** confirmed with ARRL this cycle, not remembered
