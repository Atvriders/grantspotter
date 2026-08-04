---
id: funder-yaesu-dr2x
title: Yaesu USA DR-2X Program — funder overlay
layer: funder
order: 70
appliesTo: [equipment_in_kind]
funderId: yaesu-usa
programIds: [yaesu-dr2x-repeater]
lengthTarget: the application is a fillable PDF; keep any supporting narrative under 400 words
requires: [project-description, activities-timeline, budget-justification, sustainability]
sources:
  - label: Yaesu System Fusion landing page (captured to fixtures/yaesu-dr2x/00-systemfusion-yaesu-com.html)
    url: https://systemfusion.yaesu.com/
---

## A price, not an award

**This is a discounted purchase, not a grant.** Money moves from your club to Yaesu, not the other way. The captured page states:

> The new program price is either $1,450.00 or $1,860.00.

"Discounted purchase" is GrantSpotter's classification of the funding instrument. It is not Yaesu's wording: the captured page uses neither the word grant nor the word discount, and prints no list price to compare the program price against. If you need to show a saving to a treasurer or a student government committee, get a current dealer quote and do that arithmetic yourself rather than repeating a number this page never printed.

The page publishes two figures and does not say what distinguishes them. Do not guess which configuration each price buys. Ask Yaesu or read the application form before either number goes into a budget — this project's own earlier notes paired the higher figure with a network accessory, and those words appear nowhere in the captured page, so this overlay does not assert it.

## What the page does not say

The landing page states no ongoing obligation of any kind: no service term, no reporting requirement, no clawback, no coverage commitment. The application is a fillable PDF, and GrantSpotter deliberately never downloads that PDF, so whatever terms it carries are unknown to this tool.

That gap is worth naming, because this codebase has already fallen into it. A sustainment obligation for this exact programme was repeated as established fact for days; it came from a hand-written test fixture rather than from Yaesu, and a grep of the funder's real page finds it zero times. Nobody had quoted it, and nobody had checked.

So: open the current application PDF, read the terms yourself, and quote them into your own paperwork with the date you read them. An obligation nobody published is not an obligation. One you have not read is not one you can plan around, and the fact that a requirement sounds plausible is not evidence that a funder imposed it.

## The window

> Yaesu USA is please to offer this DR-2X Program offering to our loyal customers once again through August 31st, 2026.

The typo is the page's. That sentence carries the close date, printed in prose above the application button, and it is the only date the page states in words. No opening date is published: the current application is named `DR-2X_Jun-thru-Aug_2026-FILLABLE.pdf`, which is month-granular, and a month name is not a date. GrantSpotter records the close date and leaves the opening unset rather than inventing a day number to fill the field.

The page labels the offer "LIMITED TIME PROGRAM" and says Yaesu is offering it "once again", so treat the programme as recurring but not scheduled. Star it in GrantSpotter so a change event reaches you, and read the page before assuming a window is open.

## Have all of this before you apply

A repeater is the hardest equipment project a student club takes on, and the box is the easy part. The purchase price buys a repeater, not a station.

> {{club.name}} ({{club.callsign}}) will install the repeater at {{repeater.site}} on the pair {{repeater.frequency}}, coordinated by {{repeater.coordinator}}.

- [ ] Written permission for {{repeater.site}}, from whoever controls the roof, tower or room, with power and access spelled out
- [ ] A coordinated pair issued by {{repeater.coordinator}}
- [ ] Antenna, feedline and duplexer priced in the same budget as the repeater
- [ ] Internet at the site if you intend to link it, priced and permitted like everything else
- [ ] A named person answerable for the machine after {{project.endDate}}, and a successor arrangement written into the club's bylaws or a signed handover

The last item is the one that decides whether this purchase is still working in a few years. Officers turn over annually in a collegiate club, and a repeater outlives every officer who bought it — write the handover down now, while the people who care about it are still in the room. The `sustainability` component is where that argument belongs.

## Overlay checklist

- [ ] Site permission is in writing
- [ ] The frequency pair is coordinated, not merely chosen
- [ ] The budget covers the full installed cost, not the program price alone
- [ ] The application PDF has been read, and any term it imposes is quoted with the date it was read
- [ ] A named owner and a written successor arrangement exist for the repeater
- [ ] The current page has been checked today for whether the programme is open
