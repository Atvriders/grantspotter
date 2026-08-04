---
id: funder-campus-sga
title: Campus student government playbook
layer: funder
order: 80
appliesTo: []
alwaysAvailable: true
funderId: campus-sga
programIds: []
requires: [need-statement, project-description, budget-justification, activities-timeline]
lengthTarget: most SGA forms cap the narrative at 200-500 words
sources:
  - label: Florida State University SGA, funding your RSO — one representative campus, read on 2026-08-02
    url: https://sga.fsu.edu/accounting/funding-your-rso
---

## Why this playbook exists

Student government is the most reliably available money a collegiate club can reach, and it is the one funder in this app that is not in the index. There are roughly 4,000 campuses running their own forms on their own software under their own rules, so GrantSpotter cannot list yours and will not pretend to. What it can do is tell you which rule decides most amateur radio requests before anyone reads the merits, and how to find out whether that rule is yours.

## The trap: capital equipment is frequently barred

Student activity fee money — often called A&S funds — is usually restricted to **programming**: events, activities and services that reach students. Most such rulesets exclude **capital equipment**, meaning durable goods the organization keeps afterwards. A transceiver is durable goods.

The consequence is blunt. A ham club that asks student government for a radio is often refused on a category rule rather than on merit, and its officers conclude that student government does not fund ham radio. That conclusion is wrong twice over. Student government funds what ham clubs *do* even where it will not buy what ham clubs *own* — and the category list is your own campus's, not the one described here.

**The reframe, where the rule turns out to apply to you: fund the programme from student government, and fund the capital from somewhere else.**

## Find your own rule before you write a word

Everything below this line is a pattern, not your policy. Ten minutes of reading turns it into your policy or discards it:

1. Search your student government's site for "RSO funding", "A&S funds", "allocation request", or "student organization budget". Ask for the **allocation manual or funding policy**, not the web summary — the caps and the category list live in the manual.
2. Find the section that lists **unallowable expenses**. That list is the real ruleset, and it is the answer to whether any of this applies to you.
3. Write down, word for word, the sentence about equipment. Quote it in your own request: a committee recognises its own document, and quoting it shows you read the thing they wrote.
4. Note the lead time, the per-request cap, the per-year cap, and how many requests an organization may make in a year. These are the numbers that decide your calendar.
5. Note who sits on the committee and when it meets. Attending in person changes outcomes more than the form does.
6. Find last year's funded requests where they are published, and match your language to the ones that were approved.

> If your manual has no equipment restriction, ask for the radio and skip the reframe. Where it does, quote the rule that bars it and then ask for the programme instead — the same paragraph both proves you read the policy and explains why your request looks the way it does.

## Reframes you can copy

| Instead of asking for | Ask for | Why it can clear a programming-only rule |
|---|---|---|
| A transceiver for the club station | A licensing class: instructor honorarium, room booking, printed study manuals, VE exam session fees, refreshments | Every line is programming that reaches a countable number of students |
| An antenna and feedline | A Field Day or public demonstration: site fee, generator rental, safety equipment, food, printed materials | It is a dated public event with attendance you can report |
| A software-defined radio for the shack | A workshop series with consumable kits students take home, instructor time, and a room | Consumables that students keep are often treated differently from equipment the club retains |
| A tower or a repeater | Travel to a hamfest, conference or contest: registration, transport, lodging | Travel is usually its own category with its own cap |
| "General operating support" | A named event on a named date with an attendance estimate | Operating support is rarely fundable anywhere; events usually are |
| Equipment the club keeps | Equipment bought **by the department** and loaned to the club | The asset sits on the department's inventory, which is where capital belongs |

Read every row as a hypothesis to check against your own manual. A reframe that your campus treats as equipment anyway is a reframe that fails, and the manual is the only place that answers it.

## The capital still has to come from somewhere

Run these in parallel with the student government request, and say in that request that you are doing so — a committee funds a programme more readily when the hardware is somebody else's problem:

- **Your academic department or college.** ECE, physics and engineering departments buy lab equipment routinely and can hold the asset on their own inventory. This is the most common way a collegiate station actually gets a radio.
- **The dean's office or a student success fund**, which often holds discretionary money outside the activity fee rules.
- **Alumni.** A club with a callsign has alumni who hold licences, and the development office can usually find them.
- **The grant programmes in this index.** Several of them do fund equipment. Open the funder overlay for each one and read what that funder published, rather than taking it from this page.
- **Manufacturer relationships.** GrantSpotter's own source review found no published application, no page and no deadline for equipment donations at the major amateur radio manufacturers, so treat this as relationship work rather than an application: a named person at the company, and an introduction from your faculty advisor.

## One representative campus, for calibration

These are Florida State University's published figures, read on 2026-08-02, and they are FSU's alone. **Your campus will differ** — treat them as an indication of scale while you go and read your own manual:

- Programming requests up to **$3,000**, or up to **$5,000** for an extraordinary request
- Travel at **$250 per student** and **$5,000 per organization**
- A Development Fund capped at **$300 per fiscal year**
- Rolling event and travel requests requiring at least **six weeks** of lead time, with a maximum of three per fiscal year
- A separate annual A&S budget cycle for the following year's baseline

The lead-time rule is the one that most often catches clubs. Where a campus requires six weeks, a Field Day request submitted in May for a June event is dead on arrival regardless of quality — and the number on your campus is in your own manual, not on this page.

## Draft skeleton

**Request to {{sga.fundingBody}}**

{{club.name}} ({{club.callsign}}) requests {{project.requestAmount}} for {{project.title}}, a {{project.deliverable}} open to all students, held at {{project.venue}} on {{sga.eventDate}}.

**Who attends.** {{sga.attendanceEstimate}}

> Say how you got that number. Last year's attendance, current membership, or the capacity of the room are all defensible; a guess is not.

**What the money buys.**

> Line items only, each one clearly programming rather than equipment the club retains, with a unit price and a source for each.

**Which rule this request is written against.**

> Quote your own allocation manual here, word for word, with the section it comes from — then one sentence on how this request sits inside it.

**Who does the work.** {{team.leadName}}, {{team.leadRole}}, with {{club.memberCount}} club members volunteering.

**How students hear about it.**

> Committees fund events students will actually attend. Name the channels and the dates you will post.

## Common failure

The club asks for a radio, is refused, and never applies again — or the club reads a page like this one, assumes its own rules match, and reframes a request that never needed reframing. Both are the same mistake: acting on somebody else's policy. Read your manual, quote it, and let it decide which of these you are.

## Overlay checklist

- [ ] Read your campus's own allocation manual, including the unallowable-expense list
- [ ] The rule your request is written against is quoted in the request, with its source
- [ ] Nothing in the request is durable equipment the club keeps, if your own manual excludes that
- [ ] Submitted with more lead time than your published minimum
- [ ] Attendance estimate has a stated basis
- [ ] A parallel route identified for any capital you still need
