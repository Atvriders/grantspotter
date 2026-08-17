# Maintainer notes on the seed corpus

**Read this before editing a record in `data/seed/`. A student never sees this file.**

## Why this file exists

`Program.rawOtherText` is rendered on the opportunity page under the heading **"Unstructured
requirements, verbatim"**, introduced with:

> Text from the source that no field on this page models. It is reproduced exactly, because
> paraphrasing is where a requirement that was never written down gets invented.

That is a promise about whose words those are. On 2026-08-13 the shipped ARRL Club Grant record
answered that promise with GrantSpotter's own development notes — spec section numbers, the
ingestion pipeline's override behaviour, a `(sourceId, externalKey)` pair, "NOT ASSERTED HERE" —
in the same monospaced `verbatim` box the product uses for a funder's sentence. A reader has no
way to tell that block from the funder's own text, so they read our rationale as ARRL's terms.

It was not one record. Twenty-nine of the thirty-two hand-curated records carried the same shape,
every one of them in `rawOtherText`; the 111 generated ARRL catalogue records carried none, because
their text is a function of the capture rather than something anybody typed. The notes were all
real and worth keeping; the field they were written into was the defect.

So: **the curation rationale lives here, and the funder's page content lives in the record.**

**ROUND TWO, the same day.** The fix above moved the machine tokens and left the voice. The ARRL
Club Grant panel then read *"This programme is funded by ARDC: the page thanks Amateur Radio Digital
Communications for providing the funding … If you want an ARRL organisation grant with a published,
verifiable window right now, the ARRL Amateur Radio Grants programme is the one with dates on its
page."* Sentence one is a description OF the page; sentence two is GrantSpotter recommending a
different programme — inside a panel that says it is quoting the funder. Not one machine token in
either, so the guard passed it. Re-scanning the shipped corpus with a detector built for voice
rather than vocabulary found **68 fields on 31 records** in the same shape — 31 of the 32
hand-curated records, and **none of the 111 generated ARRL catalogue records**, which is what makes
this a defect of curation both times. Zero of the 68 carried a machine tell: round one really had
removed all of those.

`packages/server/src/seed/funderVoice.test.ts` enforces that. It fails the build if any field the
product renders as the funder's own words — `rawOtherText`, a constraint's `rawText`, an
`aiPolicy.quote`, `amount.amountRaw` / `awardCountRaw`, a `fundingRestrictions` entry, a prose
obligation, or a sidecar `evidence` quote — is GrantSpotter talking rather than the funder. Read its
header before editing: it says exactly which four families it can see and the five things it
**cannot**. When it fails, move the sentence rather than rewording it until the detector stops
noticing — rewording is what produced round two.

**Fields that are GrantSpotter's own voice and are not policed:** `summary`, `deadline.note`,
`trust.disputed.note` and `trust.staleMirrorWarning`. The page does not present those as anybody
else's words. A curation note that a *student* needs — "the cycle could not be resolved and this
record does not guess" — belongs in one of those, not in this file and not in `rawOtherText`.

**The other attributed channel is the writing desk.** `content/templates/funders/*.md` are rendered
as GrantSpotter's own overlays and say so in their own text ("GrantSpotter cannot list yours and
will not pretend to"). Advice belongs there. Two of the three playbooks that used to sit in
`rawOtherText` were already duplicated there in fuller form, which is why removing them cost the
student nothing.

**An empty string is a legal, and usually the correct, value.** `amount.amountRaw` and
`awardCountRaw` render through `orNotStated`, so an empty field prints the app's own *"Not stated"*
— GrantSpotter's voice, correctly attributed — while `"Not published."` typed into the field prints
as something the funder wrote. The generated ARRL catalogue has kept that convention since it was
written: *"an entry whose page states no count keeps the empty string rather than a sentence we
wrote."* Twenty-four award fields were brought into line with it in round two.

## Editing a record is two steps, and the second one is not optional

```bash
# 1. edit data/seed/*.json
# 2.
npm run seed:shipped-values
```

**Why.** The seed import runs once, into an empty database, and then refuses forever — which is
what stops an image upgrade from destroying an operator's curation. It also meant, until
2026-08-14, that a *correction* could never reach a running deployment: the 31 records above were
fixed, released, pulled, and stayed wrong on every live instance, because nothing in the boot path
was allowed to write into a database that already held programs.

`packages/server/src/seed/corrections.ts` now reconciles at boot under one rule: **a field is
rewritten only when it still holds, byte for byte, exactly the text we shipped.** The proof that a
value is ours is `data/seed/shipped-values.tsv` — a SHA-256 per value, unioned across every release
this corpus has ever had. Step 2 is what adds the values you just wrote to it. It never removes a
digest, so the text you are replacing stays provable, which is the only reason it can be corrected
out on somebody else's disk.

`shippedValues.test.ts` fails, naming the record, if you skip step 2. Do not "fix" it by editing
the `.tsv` by hand; run the script.

**What the reconcile will not do for you**, so plan the edit accordingly:

- It will not change anything the matcher or the calendar reads. Only `summary`, `rawOtherText`,
  `amount.amountRaw`, `amount.awardCountRaw`, `deadline.note`, `aiPolicy.quote` and
  `fundingRestrictions` can be corrected, and a `deadline.note` whose `RECUR` directive or
  funder-stated dates would move is refused. **Deleting or rewriting a `constraint` is a change to
  what a record means**, so it is reported to the operator and left for them — the three
  constraints round two deleted are still on every deployment that had them, by design.
- It will not touch a field somebody there has edited. That is the point, and it means a record an
  operator has curated keeps whatever they wrote, correction or no correction.

Notes below are ordered by seed file, then by record id. Each is the text that was removed from
that record's `rawOtherText`, verbatim.

---

## `programs.curated.json`

### `ardc-grants`

> NOT ASSERTED HERE: whether cost sharing is required. The only cost-share sentence on the
> instructions page is conditional — an organisation whose indirect rate exceeds 20% is asked to
> cover the excess — so `true` over-states it for an organisation at or under 20% and `false`
> contradicts the page for one above it. The obligation is therefore unstated, which is the honest
> third answer.

### `arrl-amateur-radio-grants`

> The June window shut on June 30 and the next opens October 1, which is what the ingestion
> pipeline computes from the same three windows.
>
> NOT ASSERTED HERE: whether cost sharing is required — the page states a co-funding PREFERENCE,
> which is a different claim, and says nothing about a required match.

### `arrl-etp-grants`

> The October month looks stable across years but the year on the page does not, so this record
> projects nothing forward.
>
> NOT ASSERTED HERE: any sustainment or reporting obligation. The page's only text about what
> happens after an award is an anecdote about a school that stopped using its station — an anecdote
> is not a term.

### `arrl-foundation-scholarships`

> This record owns the deadline that every entry in the catalogue inherits, including scholarships
> administered by other organisations whose intake runs through ARRL: QCWA, YASME, DARA and the Six
> Meter Club of Chicago among them.
>
> NOT ASSERTED HERE: a closing TIME, and any earlier date this deadline 'moved from'. '12:00 PM
> EST' and 'January 31' appear zero times across every captured ARRL scholarship page; the 12:00 in
> the directive above is this corpus's own projection assumption, carried so the calendar has an
> instant to draw, and it is not a published fact. Also not asserted: '2024: 135 awards, more than
> $715,000', which appears on no captured page.

### `arrl-foundation-special-funds`

> ONE RECORD FOR THREE FUNDS, because the page is one page and `arrl-pages.ts` parses it into one
> `RawOpportunity` (`externalKey: foundation-special-funds`). Splitting it into three seed records
> would mint two crawler identities no parser emits, which is the duplication `SeedSourceKey`
> exists to prevent. So every field on this record has to be read as "the page's answer", and where
> the page's three funds answer differently the split is stated in `summary` and `deadline.note` —
> both GrantSpotter's own voice, both rendered to the student.
>
> Every value is taken from
> `fixtures/arrl-foundation-special-funds/00-www-arrl-org-arrl-foundation-special-funds.html`. All
> four constraint sentences are one contiguous verbatim run of that capture.
>
> THE AUDIENCE IS THE LOAD-BEARING FIELD. The sentence it comes from is *"Groups that qualify for
> mini-grants will include, **but not be limited to**, high school radio clubs, youth groups, and
> general-interest radio clubs…"* — an explicitly open list. A model reading it returned
> `['club_unincorporated']` alone, which would have turned an honest `unknown` into a hard
> `ineligible` for a club that is its own 501(c)(3): the record already carries constraints, so the
> empty entity list was the only thing keeping it at `unknown`, and narrowing it is the one edit
> here that can move a verdict. Seeded as
> `['club_unincorporated', 'club_501c3', 'school_lea']`.
>
> NOT ASSERTED HERE: `amountMin` / `amountMax`. ARRL prints one figure on the page — *"Minigrants,
> not to exceed $1,000 per grant"* — and it belongs to the Victor C. Clark fund alone; the Alfred E.
> Friend fund publishes no floor and no cap. A record-level maximum of $1,000 would be a cap ARRL
> never put on the Friend fund, so the sentence is kept in `amountRaw` (where the reader sees the
> real number and, from `summary`, whose number it is) and the numeric bounds are left unset, which
> prints the app's own *"Not stated"*.
>
> NOT ASSERTED HERE: a reporting obligation. *"Grant awards may be renewed based on a performance
> report by the award winner"* conditions a report on seeking RENEWAL. `reportingObligation` would
> read as a term of the original award, which is a stronger claim than ARRL made.
>
> NOT ASSERTED HERE: status `open`. The page states no cycle status and carries no year. `unknown`
> is the honest badge; the Friend fund's *"the application deadline for each year is October 1st"*
> is a recurrence rule with no year attached, so it is `dates.basis: projected` with a `RECUR`
> directive rather than a window anybody published.

---

## `programs.ham-orgs.json`

### `ylrl-ethel-smith-k4lmb`

> One of only two verified non-ARRL US ham scholarship application paths; its intake does not run
> through the ARRL catalog. Every fact in this record is quoted from
> `fixtures/ylrl/00-ylrl-net-scholarships.html`. Status is `unknown` rather than `open` because the
> page states no cycle at all: an unpublished deadline cannot support an open badge.
>
> Three of its five constraints quote the shared requirements block, not the paragraph naming this
> award. See "The ten YLRL quotations" below for why they stay where they are and what was added
> instead.

### `ylrl-mary-lou-brown-nm7n`

> Quoted from `fixtures/ylrl/00-ylrl-net-scholarships.html`. Same shared-block attribution as
> `ylrl-ethel-smith-k4lmb`, on the same three constraints.

### `ylrl-marte-wessel-k0epe`

> The one award in this corpus written FOR part-time students. `partTimeOK` is true and
> `degreeLevels` is empty on purpose: YLRL restricts neither, and an empty allow-list here means the
> funder set no level, not that no level qualifies.
>
> Four of its six constraints quote the shared requirements block — this record's `institution`
> constraint quotes the page's footnote (*"\*What qualifies as an educational institution?"*), which
> is attached to no award's paragraph at all.

### `austin-arc-copeland`

> Status is `closed` because 2026-08-02 falls after July 31, outside the club's own stated window;
> that is a point-in-time fact and must be re-derived, not merely re-stamped, whenever this corpus
> is re-verified. The portal's "No opportunities available" between August 1 and April 30 is the
> closed state, not an error, and the reason the source module's `expectedMinRecords` is 0.
>
> No licence requirement appears anywhere on the captured page, so none is asserted here: a hard
> licence bar nobody published would exclude eligible students.

### `austin-arc-greenwood`

> DELIBERATELY HAS NO `sourceKey`, and is one of exactly two records in the corpus that does not.
> The austin-arc source module emits ONE page-level record keyed `austin-arc-scholarships`, which
> `austin-arc-copeland` owns; duplicating that pair here would violate the partial unique index on
> `(source_id, external_key)`, and inventing a key no parser emits would fail to reconcile while
> looking correct.

**This record's `rawOtherText` is now empty**, which is the honest state: nothing on the funder's
page went unmodelled. The verbatim panel does not render for it.

### `yasme-supporting-grants`

> yasme.org 301s /feed/ and /wp-json/ to a 403 page for non-browser clients, so GrantSpotter does
> not poll it and no capture of that site exists in this repository. We do not spoof a browser user
> agent to defeat a deliberate access policy; Yasme announcements are relayed by the ARRL news RSS
> feed, which is what the change detector watches instead.
>
> NOT ASSERTED HERE: a reporting obligation. Earlier drafts stated one for recipients of the
> associated YASME scholarship, but with no fetchable page there is no funder sentence to quote, and
> an obligation with a fabricated citation is worse than an unstated one.

### `ncdxf-grant-program`

> ncdxf.org returns 403 for both robots.txt and sitemap.xml, so this record is re-verified by hand
> each quarter rather than crawled aggressively.
>
> NOT ASSERTED HERE: the "roughly $1.2M distributed over about 48 years" figure from the 2026-08-02
> research pass, which appears nowhere on the captured guidelines page and is therefore not
> published as an amount. NOT ASSERTED HERE either: an emailed intake to a treasurer — the word
> "treasurer" appears zero times on the page.

### `ncdxf-youth-grant`

> A low-value polling target, and part of why ncdxf.org is treated as Tier D.

### `sara-student-teacher-grants`

> The fifth-grade-through-college rule is soft, so it cannot exclude anybody. `klass` stays
> `equipment_in_kind` to match the source module's browse category, and the instrument is
> `cash_range`, which is what the page describes.
>
> NOT ASSERTED HERE: a $500 outlier award, and an explicit welcome to international applicants —
> neither appears on the captured page.

### `rca-scholarship-program`

> That ClubExpress behaviour is why this record is curated by hand and re-verified quarterly rather
> than crawled, and why `applyUrl` is the club's root rather than a deep link that breaks silently.
> The wireless-track constraint is SOFT on purpose: it is our research on an unfetchable page, and a
> hard field bar built on that would exclude students RCA might well fund.

### `rca-youth-activities`

> Recorded as a permanent contact-only entry and deliberately excluded from the nightly crawl, for
> the ClubExpress reasons set out on the RCA scholarship record.

**This record's `rawOtherText` is now empty.** Its whole content was a note about crawl scheduling.

---

## `programs.institutional.json`

### `ariss-iss-contact`

> Because the window sentence is rewritten each quarter at a stable URL, this is one of the better
> change-detection targets in the corpus: match "proposal window" and the open/close sentence that
> follows it. This is one of only four records in the whole corpus whose dates the funder actually
> printed rather than our projecting them, which is why `dates.basis` is `funder_published` here and
> `projected` almost everywhere else.

### `nasa-csli`

> Grants.gov is the only machine-readable route to NASA opportunities and this record is polled by
> watching the announcement page for a status change. Status is `unknown`, not `open` or `closed`:
> the page states no cycle, and neither badge would be defensible. `club_501c3` is included in
> `applicantEntities` even though the ingestion pipeline's per-source table lists only universities
> and schools, because the page's own sentence names non-profit organisations — barring a 501(c)(3)
> club from a programme NASA opens to it is the false-exclude direction, which hides a live
> opportunity. Expect one eligibility diff for review on the first crawl.

### `nasa-space-grant`

> GUIDED WORKFLOW, NOT A FEED — one of the two structurally non-aggregatable sources in this space.
>
> NOT ASSERTED HERE: a reporting obligation or a cost-share requirement. Both vary by consortium and
> no national page states either, so both keys are absent, which means unstated rather than not
> required.

### `ieee-mtts-chapter-support`

> A 2026-08-02 research summary that said "requires >=5 members" flatly stated the exception as the
> rule; the page says ten. The two further pots on the same page are not modelled as separate
> records.

### `ieee-mtt-s-student-awards`

> DELIBERATELY HAS NO `sourceKey`, and is one of exactly two records in the corpus that does not:
> the ieee-mtts source module emits only its chapter-support record, which owns that crawler
> identity, and inventing a second key no parser emits would fail to reconcile while looking
> correct. It also has no `applyUrl`: the scholarships live on a page this project has never
> captured, reachable from the MTT-S site navigation under Undergrad Scholarships and Grad
> Fellowships. The field constraint is SOFT because it rests on an unverified research line rather
> than a funder sentence — and the same line misstated the chapter member minimum as five when the
> page says ten, which is why none of its figures are published as numbers here.

### `ieee-student-branch-rebate`

> The rebate amounts are deliberately kept out of the numeric amount fields so that no filter, sort
> or export treats an unverified figure as money. MTT-S is polled directly because it is the most
> RF-relevant of roughly 39 IEEE societies, and the rest are a hand-curated pointer.

### `yaesu-dr2x-repeater`

The removed block is the single most valuable audit note in the corpus. Keep it.

> FOUR CLAIMS THAT USED TO BE ON THIS RECORD AND ARE NOT ON THE FUNDER'S PAGE. A byte-level audit of
> the 145,639-byte capture found each of these zero times, case-insensitively: a twelve-month on-air
> obligation (`12 month`, `12-month`, `twelve`, `on the air`, `on-air`, `obligat`, `remain`); the
> LAN-01A pairing that supposedly explains the higher price (`lan-01a`, `network module`); a North
> America eligibility limit (`north america`); and a June 3 opening date (`june 3`). The 12-month
> figure traced to a hand-written fixture and the June date to a synthetic parser fixture, not to
> any live page. None is asserted here, and the eligibility constraint list is empty because the
> page states no eligibility at all.
>
> WHY `applyUrl` IS THE LANDING PAGE: the actual form is a window-dated PDF under
> `/wp-content/uploads/{YYYY}/{MM}/`, so a seed shipped to every installation must point at the
> stable page and let the crawler substitute the current form. Expect this record to need manual
> re-verification each time a new window opens.

### `campus-sga-playbook`

> NOT ASSERTED HERE: a reporting obligation. Most student governments do require receipts and a
> post-event report, but that is our generalisation across roughly 4,000 campuses rather than a
> sentence any one funder published, so the key is absent, which means unstated.

---

## `programs.negatives.json`

### `arrl-club-grant`

This is the block the walkthrough found. It was rendered to signed-in members as the funder's own
unstructured requirements.

> Spec §8's shipped example of the disputed surface, and the disputed block above is byte-identical
> to the curated override the ingestion pipeline applies to the same (sourceId, externalKey) pair,
> so a re-crawl cannot produce a phantom difference.
>
> NOT ASSERTED HERE: a co-funder preference. That sentence is on the Amateur Radio Grants page, not
> this one, and carrying it across would be cross-contamination between two records.

### `arrl-cari-not-a-funding-program`

> Recorded as an explicit negative so that a future maintainer does not spend another research pass
> looking for a CARI grant, and so the UI never renders an empty "CARI grants" category. Status is
> `no_application` rather than `discontinued`: CARI is running right now, it simply was never a
> funding programme, and telling a student that an active ARRL programme has shut down would be a
> different falsehood.

### `amsat-no-grants-program`

> Status is `no_application`, not `discontinued`: AMSAT is thriving and is simply not a grantmaker.
> The alternative routes named on the record are the ones in this corpus.

### `flexradio-no-education-tier`

> Recorded so the equipment category does not imply a discount that does not exist. Status is
> `no_application`, not `discontinued`: FlexRadio exists and sells radios. The Yaesu DR-2X programme
> is the one verified discounted-hardware route in this corpus.

### `vendor-equipment-relationship-playbook`

> NOT ASSERTED HERE: a sustainment obligation. Donors plainly do expect visible use, but that is our
> characterisation of a relationship rather than a term any vendor published, so the key is absent,
> which means unstated.

### `dara-grantmaker-only-via-arrl`

> This record exists so that a search for "Hamvention scholarship" returns the finding rather than a
> dead end. `partTimeOK` is true because DARA states no full-time requirement, and defaulting it to
> false is a named defect class in this repository — it once barred a part-time adult learner from
> 104 of 112 candidates. The ingestion pipeline's own manual-tier-d record for this finding carries
> status `no_application`, meaning there is no DARA-HOSTED application; this record keeps `unknown`
> and the ARRL apply destination, because the money is real and reachable and the terminal statuses
> would strip the one link that gets an applicant to it.

### `chicago-fm-club-scholarship-discontinued`

> The one negative in this batch that is genuinely `discontinued`, which is also why it is the one
> that carries a stale-mirror warning. Kept as the worked example of the stale-mirror problem.

### `far-domain-compromised`

> WHAT HAPPENED, IN FULL, so that nobody has to research it again.
>
> Both domains are hard-blocklisted in the fetcher itself rather than in configuration, so no crawl,
> no "Verify now" click and no user-supplied source can reach either of them, and this record
> carries no link to either in any URL field — deliberately, and there is a test that proves it
> (`negatives.test.ts`). The domain names appear in the record's prose only, because a record whose
> whole purpose is to intercept the instruction "apply at the FAR website" has to be findable by
> somebody searching for exactly that; `blocked-host-in-prose` exempts records tagged
> `safety_warning` for that reason.

---

## Round two, 2026-08-13: what moved and where it went

The 67 fields the voice scan found, by family (a field can carry more than one):

| Family | Fields | Records | What it looked like |
|---|---|---|---|
| META — describes the page or the record | 61 | 28 | "the page thanks…", "the captured page lists 2024 recipients", "the word *treasurer* appears zero times on it", "Not published." |
| PIPELINE — hedges about how the record was made | 18 | 13 | "the 2026-08-02 research pass", "could not be checked", "robots.txt and sitemap.xml both 403 non-browser clients" |
| ADVICE — second person aimed at the applicant | 16 | 13 | "do not infer one", "Confirm on the MTT-S scholarships page before you budget", "Your campus will differ" |
| CROSSREF — recommends another programme in this corpus | 5 | 5 | "the ARRL Amateur Radio Grants programme is the one with dates on its page" |
| MACHINE — round one's tells | 0 | 0 | — |

Totals are 68 distinct fields on 31 records; a field can belong to more than one family. Seventy-
seven fields changed in all, because a companion field ("Not published." sitting beside a flagged
`amountRaw`) was brought into line at the same time.

Where each kind went:

* **Facts a student needs** → `summary`, `deadline.note`, `trust.staleMirrorWarning`. The ARRL ETP
  Jotform-id warning and the Austin ARC "No opportunities available" closed state are now in
  `deadline.note`; the FAR takeover window and the two hijacked domains are now in
  `trust.staleMirrorWarning`; the FSU figures are now inside the campus-SGA warning that already
  said they were one campus's.
* **Advice** → already in `content/templates/funders/`. `funder-campus-sga.md` and
  `funder-nasa-space-grant.md` carry the two playbooks in fuller, attributed form. The vendor
  playbook has **no** template — its method is compressed into `summary`, and a
  `funder-vendor-relationships.md` overlay is the right permanent home for it. That file belongs to
  whoever owns `content/`.
* **Fetch and provenance notes** → this file, under the record.
* **Nothing** → where the sentence only restated `summary`, `deadline.note` or a constraint that
  already quoted the funder. Roughly half of the removed `rawOtherText` was in that state.

### Three constraints were DELETED, not reworded

`club-grant-affiliated` (arrl-club-grant), `sga-rso` (campus-sga-playbook) and `mtts-field`
(ieee-mtt-s-student-awards) each carried a sentence GrantSpotter composed, with an inline
"(2026-08-02 research pass; the captured page publishes no terms)" admitting as much — inside the
`.verbatim` quote block. The ARRL Club Grant capture really does carry no eligibility text at all:
it is a 2024 recipient list and a thank-you to ARDC.

The product's own doctrine for this is written in `matcher.ts`: *"A constraint GrantSpotter composed
at match time has no such sentence, and the honest representation of 'no funder said this' is an
EMPTY `rawText` — not a plausible sentence written in the funder's voice."* `Opportunity.tsx` and
`IneligibilityDrawer` both branch on `hasFunderWording` and print *"No funder sentence was recorded
for this one"* in the authored-voice block.

**That representation is not reachable from seed data today.** `validate.ts`'s `constraint-shape`
rule rejects an empty `rawText` outright, so `loadSeedCorpus` throws. Keeping the rule with an
invented quotation was the worse of the two remaining options, so the constraints are gone and the
fact each encoded is now in `summary` in GrantSpotter's voice. Three records lost a matcher rule
that no funder ever published.

**The real fix belongs to whoever owns `packages/server/src/seed/validate.ts`:** allow an empty
`rawText` on a constraint (the renderers already handle it), and these three become
empty-`rawText` constraints instead of deletions.

---

## Round three, 2026-08-17: the record that was never seeded, and the ten quotations that point at the wrong paragraph

### `arrl-foundation-special-funds` existed only in the fixture corpus

The source module has parsed that page since Plan 2 and `scripts/profile-corpus.ts` has counted the
record it produces, so every sweep taken with the fixture corpus saw it. `data/seed/` never carried
it, and `data/seed/` is what a fresh install serves. Consequence: the audience decision above was
adjudicated and then applied to nothing.

It is seeded now, curated from the committed capture; the per-field reasoning is under
`programs.curated.json` above. **Measured over the seed corpus** (144 records, all publishable),
matching all seven shipped profiles plus an unincorporated club, this record is the ONLY programme
whose verdict moves, and it moves because it did not exist before:

| profile | before | after |
| --- | --- | --- |
| the five student profiles | (no record) | `ineligible` |
| `radio-club` (501(c)(3)) | (no record) | `eligible` |
| `school-org` (school district) | (no record) | `eligible` |
| an unincorporated club | (no record) | `eligible` |

The five `ineligible` answers are the applicant-entity gate, and the two sentences behind them are
on the record, verbatim, for the reader to check: *"Groups that qualify for mini-grants will
include, but not be limited to, high school radio clubs, youth groups, and general-interest radio
clubs…"* and *"Endowed by the estate of Alfred E. Friend, Jr., W4CF, this fund is intended to
provide grants for educational programs and activities of Amateur Radio organizations."* Neither
fund on that page describes an award to a person applying alone; the third thing on it, the Bill
Orr, W6SAI, Technical Writing Award, goes to an individual but is *selected* from the year's QST
articles, not applied for, which is why `summary` says so rather than the record offering a student
a route that does not exist.

### The ten YLRL quotations that come from a sibling record's page

`ylrl.net/Scholarships/` states its rules ONCE, in a block headed **"Scholarship Requirements:"**,
and `tier-c-a.ts` parses that block into a fourth record (`ylrl-scholarships`) while the three named
awards get only the paragraph that names them. Ten constraints on the three named records therefore
quote a sentence that `constraintProvenance.test.ts` can only find on the sibling — which is what
its `VERBATIM_ON_SIBLING` register says, and why it says a weaker claim is a weaker claim.

**What was decided: the quotations stay, and each record now says where its sentences come from.**

They stay because the reader's page and the parser's record are not the same object. All four
records carry `trust.sourceUrl: https://ylrl.net/Scholarships/`, and every one of the ten sentences
is on that page, in the block that governs all three awards. The record boundary is an artefact of
how one HTML page was split, not a boundary the funder drew or the reader can see. What was
genuinely missing was the statement of WHERE on that page to look, so a reader who goes to check a
requirement against the paragraph naming their award does not find it there and concludes we made
it up. Each of the three summaries now names the shared block.

The sentence went into `summary` and not into the constraint, deliberately, and this is the part
worth keeping: `summary` is a `CORRECTABLE_PATH`, so this fix can actually reach a deployment that
was seeded before it existed. A fix nobody can receive is not a fix.

**A constraint used to be unable to receive one at all, and half of it now can.** When this was
written, `constraints` was a single witnessed-only path, which is exactly why the three fabricated
quotations of 2026-08-13 stayed live for days after they were fixed here. That path has since been
split: `constraints[<id>].rawText` — the sentence a record DISPLAYS — is correctable, per
constraint, under the same byte-for-byte rule as `summary`, while `constraints.rules` (the id,
`hard`, the fallback rank and the `spec`) stays witnessed-only, because that half is what decides
who is eligible. So a corrected QUOTATION now reaches a running deployment and a changed RULE still
does not. Rewriting a sentence is fenced at write time against the one thing the matcher reads out
of it (see `seed/matcherReading.ts`), so it cannot move a verdict; changing a rule is still yours
to decide. The reasoning above — that moving these constraints to a parent record would never reach
an existing install — is unchanged, because moving a constraint is a rules change.

**The two shapes that were rejected, and why:**

- *Attach the shared block to each record.* That is a change to `tier-c-a.ts`'s parser. It would
  move what the guard measures without changing one word a reader sees, and it is not a curation
  act.
- *Move the constraints to the parent.* There is no `ylrl-scholarships` seed record, and the three
  named records are the ones a student opens. Moving the rules off them would take the female-only
  bar, the licence floor and the full-time requirement off the three pages where they decide
  something — and `corrections.ts` refuses constraint changes, so no existing deployment would ever
  receive the move anyway. The corpus and every live install would simply disagree.

Both alternatives also require rewriting `VERBATIM_ON_SIBLING`, whose entries are asserted in both
directions: a constraint that becomes verbatim, or stops existing, fails the register-is-current
rule. That register is a guard, not a mute list, and it is doing its job here — it is the reason
anybody knew about this at all.

### Two bookkeeping constants in `packages/` had to follow the data

Neither is an assertion; both are registers of what `data/seed/` contains, and both fail loudly and
by name when it changes, which is the design:

- `SEED_RECORD_COUNT` in `validate.ts`, 143 → 144. Its own failure message is *"update
  SEED_RECORD_COUNT / SEED_FUNDER_PUBLISHED_RECORDS in validate.ts to these values"*.
  `SEED_FUNDER_PUBLISHED_RECORDS` stays 3 — the new record is `projected`, not `funder_published`.
- The hand-maintained `known` set in `seed.test.ts`'s "names only source ids Plan 2 actually
  registers", which gains `arrl-foundation-special-funds`. That source **is** registered
  (`arrl-pages.ts`); the set had simply never needed the id because no seed record named it.

---

## Known residual, NOT fixed here

**The playbooks are out of `rawOtherText`.** The previous round left three there and asked that they
not be deleted. They were not deleted — `campus-sga-playbook` and `nasa-space-grant` already had
richer, attributed copies in `content/templates/funders/`, and the vendor playbook's method is now
in that record's `summary`. The "advice, not the funder's own text" preamble is gone with them; it
was an interim measure that asked the reader to disbelieve a heading the product had just printed.

**What remains open, in order of how much it matters:**

1. `validate.ts` forbids the empty constraint `rawText` that `matcher.ts` calls the honest
   representation. Until that is reconciled, a constraint with no funder sentence has to be deleted
   rather than marked. See the section above.
2. There is no `content/templates/funders/funder-vendor-relationships.md`, so the vendor-relationship
   method is compressed into a 600-character `summary` instead of being written out where it can be
   attributed properly.
3. The guard cannot see a fluent invention, a paraphrase, or a quote lifted from the wrong page.
   `funderVoice.test.ts`'s header lists all five blind spots. Do not read a green tick there as
   "every quotation in this corpus is real" — it means "no field is visibly GrantSpotter talking".
4. **`arrl-foundation-special-funds` refuses six of the ten applicant entities on the strength of a
   list ARRL wrote as open.** The adjudicated audience is
   `['club_unincorporated', 'club_501c3', 'school_lea']`, and it was seeded exactly as adjudicated.
   But the entity gate is an `includes()`, so measured against the seeded record every other entity
   is a hard `ineligible`: `club_via_fiscal_sponsor`, `university`, `university_dept`,
   `ieee_student_branch_chapter`, `teacher`, `nominated_by_institution`. For four of those the page
   really is silent. For `university` and `university_dept` it is worse than silent — *"general-
   interest radio clubs that sponsor subgroups of young people"* plainly describes a collegiate
   radio club, which is this product's primary audience, and *"but not be limited to"* is ARRL
   saying the list does not close. No sentence on that page excludes a university club, so this is
   the same defect the audience fix corrects, pointed at a different applicant. It is written down
   rather than fixed here because widening an adjudicated value unilaterally is how a curation
   round becomes unreviewable; it needs a decision, not a patch. No shipped profile is affected —
   none of the seven is a university org — which is precisely why it would go unmeasured.

---

## Round-two removals, verbatim

Every string below was rendered to a reader as the funder's own words and is not. Kept here so
that nothing researched is lost and so the next reviewer can see what the voice looked like.

### `programs.curated.json`

**`ardc-grants`**

* `rawOtherText` → trimmed
  > ARDC asks applicants to be thorough but brief and to avoid unnecessary jargon. Two requirements applicants most often miss: every funded output must be open-source or open-access, and indirect costs are capped at 20%. The only cost-share sentence on the instructions page is conditional — an organisation whose indirect rate exceeds 20% is asked to cover the excess.

* `amount.amountRaw` → trimmed
  > No published cap. Lowest and highest figures in ARDC's own 2026 award table: $1,285 and $258,000. Verified collegiate awards run $2,000 to $77,000.

**`arrl-amateur-radio-grants`**

* `rawOtherText` → empty
  > Status as of the 2026-08-02 research pass: between cycles. The June window shut on June 30 and the next opens October 1. The ARRL Foundation published no AI policy: the grants page and the Grant Application Form PDF were both read in full and contain zero mentions of AI, ChatGPT or large language models. Terms inside the Kaleidoscope application portal are a JavaScript single-page app and could not be checked. The page states a co-funding PREFERENCE and says nothing about a required match.

* `amount.amountRaw` → trimmed
  > Awarded grants generally do not exceed $3,000; award amounts may be up to $5,000 in 2026. No floor is published — do not infer one.

**`arrl-etp-grants`**

* `rawOtherText` → trimmed
  > The window above is the one ARRL printed, verbatim in the page's own capitals: 'APPLICATIONS WILL ONLY BE ACCEPTED FOR REVIEW BETWEEN OCTOBER 1ST AND OCTOBER 31ST of 2025.' It is the most recent window the funder has published and it has closed; the October month looks stable across years but the year on the page does not. The application packet includes a signed Antenna Installation Approval form (Section 11). The only text on the page about what happens after an award is an anecdote about a school that stopped using its station. The application is a Jotform whose form id changes every year, and the attached .xlsx and .pdf files change underneath a year-agnostic URL; verify the current form id before applying.

* `amount.amountRaw` → empty
  > Equipment, software and classroom resources. ARRL publishes no cash value for either track; do not infer one.

* `amount.awardCountRaw` → empty
  > Not published.

**`arrl-foundation-scholarships`**

* `rawOtherText` → empty
  > Scholarships administered by other organisations but applied for through ARRL — QCWA, YASME, DARA and the Six Meter Club of Chicago among them — are on ARRL's cycle. QCWA additionally asks that requests start from October 31 and reach ARRL before the first week of January. Status as of 2026-08-02: the scholarship-program page states, twice, that the 2026 scholarship cycle is closed, and the window above is a projection of the rule the funder stated for the last cycle it dated ('The 2026 scholarship cycle runs from October 30, 2025 to December 30, 2025', on the scholarship-descriptions page). No closing TIME is published: '12:00 PM EST' and 'January 31' appear zero times across every captured ARRL scholarship page, and '2024: 135 awards, more than $715,000' appears on no captured page either.

* `amount.amountRaw` → trimmed
  > More than 170 scholarships ranging from $500 to $25,000 (ARRL's own words on the scholarship-program page).

* `amount.awardCountRaw` → trimmed
  > ARRL states 'more than 170' awards; its scholarship-descriptions page says 'more than 150' and lists 111 catalogue entries.

### `programs.ham-orgs.json`

**`ylrl-ethel-smith-k4lmb`**

* `rawOtherText` → empty
  > The YLRL scholarships page states no cycle at all: it publishes no application window for this award.

* `amount.awardCountRaw` → empty
  > Not published. The page names three scholarships and states an amount for each; it states no award count.

**`ylrl-mary-lou-brown-nm7n`**

* `rawOtherText` → empty
  > The female-only and licence bullets are document-level on the YLRL scholarships page and apply to all three YLRL awards.

* `amount.awardCountRaw` → empty
  > Not published.

**`ylrl-marte-wessel-k0epe`**

* `rawOtherText` → empty
  > The one award here written FOR part-time students: YLRL restricts neither enrolment intensity nor degree level, so an unlisted degree level is one the funder never named rather than one that fails to qualify.

* `amount.awardCountRaw` → empty
  > Not published.

**`austin-arc-copeland`**

* `rawOtherText` → empty
  > The club's portal at grants.austinhams.org legitimately displays "No opportunities available" between August 1 and April 30 — the closed state, not an error. No licence requirement appears anywhere on the captured page.

* `amount.amountRaw` → empty
  > Not published. There is not a single dollar figure on the club's scholarships page. Do not infer an amount.

* `amount.awardCountRaw` → empty
  > Not published.

**`austin-arc-greenwood`**

* `amount.amountRaw` → empty
  > Not published. There is not a single dollar figure on the club's scholarships page. Do not infer an amount.

* `amount.awardCountRaw` → empty
  > Not published.

**`yasme-supporting-grants`**

* `rawOtherText` → empty
  > yasme.org 301s /feed/ and /wp-json/ to a 403 page for non-browser clients, so the site publishes nothing a reader can subscribe to; Yasme announcements are relayed by the ARRL news RSS feed. No page states a reporting obligation for recipients of the associated YASME scholarship.

* `amount.amountRaw` → empty
  > $5,000 to $7,500 observed. Yasme publishes no award schedule; these are the figures the 2026-08-02 research pass observed in announcements.

**`ncdxf-grant-program`**

* `rawOtherText` → trimmed
  > ncdxf.org returns 403 for both robots.txt and sitemap.xml. The guidelines page's own instruction is to complete a Budget Worksheet and an Application Form and submit both to NCDXF; the word "treasurer" appears zero times on it, and the "roughly $1.2M distributed over about 48 years" figure from the 2026-08-02 research pass appears nowhere on it.

* `amount.amountRaw` → empty
  > Not published. The guidelines page states no amount, no cap and no total; it distinguishes only "major support" for expeditions to the most-wanted locations from "a smaller amount of support" for other projects.

* `amount.awardCountRaw` → empty
  > Not published.

**`ncdxf-w6een-scholarship`**

* `rawOtherText` → empty
  > The page's apply instruction is to contact DX University or Contest University directly; NCDXF publishes their contact pages and does not take the application itself. "There is no restriction as to class of license" means ANY CLASS QUALIFIES — a floor of TECH — and never "no licence needed": the same sentence begins "If you are a licensed amateur radio operator". The page also carries a Previous ARRL Foundation Scholarship Program table marked No Longer Active; those rows are history, not an open award.

* `amount.amountRaw` → trimmed
  > Full tuition at DX University or Contest University sessions held in North America. No dollar figure is published.

* `amount.awardCountRaw` → empty
  > Not published.

**`ncdxf-youth-grant`**

* `rawOtherText` → empty
  > Verified in the 2026-08-02 research pass: the Youth Grant page contains a title and navigation and no programme terms. ncdxf.org's robots.txt and sitemap.xml both 403 non-browser clients.

* `amount.amountRaw` → empty
  > No amount is published anywhere on the page.

* `amount.awardCountRaw` → empty
  > Not published.

**`sara-student-teacher-grants`**

* `rawOtherText` → empty
  > THE FIFTH-GRADE-THROUGH-COLLEGE RULE IS A PREFERENCE, NOT A BAR — the page's own word is "Preference". THE AWARD IS CASH, not a kit: the page says SARA "provides funds" and that the aim is that "the money reaches the largest number of students". Radio JOVE, SuperSID and INSPIRE appear on that page only as example projects an applicant might BUILD with the money, never as what SARA hands over. The address is written "grants at radio-astronomy.org" here because that is how the page spells it, as an anti-spam measure. Neither a $500 outlier award nor an explicit welcome to international applicants appears on the captured page.

* `amount.amountRaw` → trimmed
  > The funds will be divided up into several small grants of no more than $200 each or more, with the approval of the grant committee, to ensure that the money reaches the largest number of students. A ceiling with explicit committee discretion above it, so no maximum is asserted.

* `amount.awardCountRaw` → trimmed
  > Not published; "several small grants".

**`rca-scholarship-program`**

* `rawOtherText` → empty
  > RCA runs on ClubExpress: sitemap.xml 403s, pretty URLs 404, and only content.aspx query-string URLs resolve — and the module id inside them changes without notice whenever RCA renumbers a module, so start from the club's root rather than from a deep link, which breaks silently.

* `amount.amountRaw` → empty
  > Per-award amounts are not published. About $15,000 a year is distributed in total, per the 2026-08-02 research pass.

* `amount.awardCountRaw` → empty
  > Not published; awards are distributed each May.

**`rca-youth-activities`**

* `amount.amountRaw` → empty
  > In-kind only — books, equipment and curriculum. No cash amount is published.

* `amount.awardCountRaw` → empty
  > Not published.

### `programs.institutional.json`

**`ariss-iss-contact`**

* `amount.awardCountRaw` → empty
  > Not published. Proposals are accepted in four windows a year.

**`nasa-csli`**

* `rawOtherText` → empty
  > The announcement page states no cycle. Its own eligibility sentence names non-profit organisations alongside universities and schools. NASA's NSPIRES system exposes no API, RSS, XML, JSON or CSV and is session-stateful, so Grants.gov is the only machine-readable route to NASA opportunities.

* `amount.amountRaw` → trimmed
  > No cash award is described. NASA provides "a low-cost pathway to conduct scientific investigations and technology demonstrations in space"; the page describes teams obtaining hands-on flight hardware design, development, and build experience.

* `amount.awardCountRaw` → empty
  > Not published per cycle. NASA states it has launched over 150 CubeSats through CSLI.

* `fundingRestrictions[0]` → empty
  > The captured page describes launch and deployment opportunities and no hardware funding. Budget for building the spacecraft separately.

**`nasa-space-grant`**

* `rawOtherText` → empty
  > Space Grant money is not one published call: it reaches students through state consortia, each on its own calendar. Steps that work — advice, not NASA's own text. 1) Look up your state's Space Grant consortium in NASA's consortium directory. 2) Find the affiliate institution nearest you; consortium money usually flows through affiliates. 3) Ask the consortium director for the current student-award and mini-grant calendar, which is rarely posted more than a semester ahead. 4) Frame the ask in the consortium's own language: STEM workforce development, student research, K-12 outreach. A campus ground station is fundable as student research infrastructure and is rarely fundable as radio equipment. Reporting obligations and cost-share requirements vary by consortium and no national page states either.

* `amount.amountRaw` → empty
  > Consortium-level student awards typically $1,000 to $10,000. Not published nationally; every consortium sets its own, and yours may differ.

* `amount.awardCountRaw` → empty
  > Not published nationally; varies by consortium.

**`ieee-mtts-chapter-support`**

* `rawOtherText` → trimmed
  > THE MEMBER MINIMUM IS TEN, not five: five is the reduced figure for a Student Branch Chapter specifically. The two-reported-meetings requirement is the one chapters actually fail — report meetings in vTools as they happen rather than reconstructing them in September. Two further pots live on the same page: $500 seed money per chapter for a workshop or symposium (an IEEE MTT-S membership booth must be present at the event), and up to $2,250 a year of Chapter Officer travel support to a Chapter Chair Meeting.

**`ieee-mtt-s-student-awards`**

* `rawOtherText` → empty
  > MTT-S links its Undergrad Scholarships and Grad Fellowships from its site navigation; the chapter-support page that was read names neither an amount nor a deadline for them. An amateur radio licence is not required; this is engineering-society money and a ham student in an EE programme is a natural fit.

* `amount.amountRaw` → empty
  > Not published on any captured page. The 2026-08-02 research pass recorded ten undergraduate scholarships at $1,500 and three graduate fellowships at $6,000; the captured chapter-support page carries only navigation links to the two programmes and states neither figure, so no numeric amount is published here. Confirm on the MTT-S scholarships page before you budget.

* `amount.awardCountRaw` → empty
  > Not published on any captured page.

* `constraints[mtts-field].rawText` → empty
  > MTT-S undergraduate scholarships and graduate fellowships are for students working in microwave theory and technology or a directly related RF field (2026-08-02 research pass; the captured page links to the programmes but publishes no terms).

**`ieee-student-branch-rebate`**

* `rawOtherText` → empty
  > The deadline and the qualifying condition were both read live off the captured page; the rebate amounts on it were not verified. Roughly 39 IEEE societies each publish their own chapter and student funding page, on different templates and calendars.

* `amount.amountRaw` → empty
  > Not published on any captured page. The 2026-08-02 research pass recorded $50 a year for a branch under 50 members, $100 at 50 or more, plus $2 per member and $1 per chapter member — figures taken from search snippets, not from a live read, because mga.ieee.org returns HTTP 418 to non-browser clients and we do not spoof a user agent. No numeric amount is published here; confirm the current schedule with your branch counsellor.

**`yaesu-dr2x-repeater`**

* `rawOtherText` → empty
  > The page states no eligibility at all. Yaesu publishes the application as a window-dated PDF under /wp-content/uploads/{YYYY}/{MM}/, so its address changes each time a new window opens.

* `amount.amountRaw` → trimmed
  > The new program price is either $1,450.00 or $1,860.00. This is a price the buyer pays, not an award, and the page does not say what distinguishes the two figures.

* `amount.awardCountRaw` → empty
  > Not published.

**`campus-sga-playbook`**

* `rawOtherText` → empty
  > PLAYBOOK — advice, not a student government's own text — and the single most valuable line in it is step 3. 1) Get the allocation manual, not the web summary; the caps and the barred-category list live in the manual. 2) Check whether capital equipment is barred. It usually is. 3) If it is barred, do not ask for a radio: ask for the programme the radio makes possible. A licence class, a Field Day event, a public-service demonstration, a school visit. Budget the consumables, the room, the food and the printing, and fund the radio itself from ARRL, ARDC or a departmental source. 4) Respect the lead-time rule; at FSU a request inside six weeks is simply not heard. 5) Track your request count. 6) Go to the annual activity-and-service budget cycle for anything recurring; the rolling process is for one-off events. Most student governments do require receipts and a post-event report, but that is a generalisation across roughly 4,000 campuses rather than a sentence any one of them published.

* `amount.amountRaw` → empty
  > Representative figures from one campus, FSU, read in the 2026-08-02 research pass: programming up to $3,000 and up to $5,000 in extraordinary cases, travel $250 per student and $5,000 per organisation, development fund up to $300 per fiscal year. Your campus will differ, sometimes by an order of magnitude.

* `constraints[sga-rso].rawText` → empty
  > The club must be a registered student organisation in good standing at the institution (2026-08-02 research pass; every campus states this in its own allocation manual).

### `programs.negatives.json`

**`arrl-club-grant`**

* `rawOtherText` → trimmed
  > This programme is funded by ARDC: the page thanks Amateur Radio Digital Communications for providing the funding, the same single-donor dependency that runs through the ARRL scholarships. If you want an ARRL organisation grant with a published, verifiable window right now, the ARRL Amateur Radio Grants programme is the one with dates on its page.

* `constraints[club-grant-affiliated].rawText` → empty
  > ARRL Foundation Club Grants go to ARRL-affiliated clubs (2026-08-02 research pass; the captured page lists 2024 recipients and carries no eligibility text of its own).

**`arrl-cari-not-a-funding-program`**

* `rawOtherText` → empty
  > CARI is running right now; it simply was never a funding programme, and no ARRL page offers a CARI grant. If you want ARRL money for a collegiate club the routes are the Club Grant Program and the ARRL Amateur Radio Grants programme.

* `amount.amountRaw` → empty
  > No money is awarded to applicants. CARI is a community programme, not a grant.

**`amsat-no-grants-program`**

* `rawOtherText` → empty
  > AMSAT is thriving and is simply not a grantmaker. If your project is satellite-adjacent, the real routes are ARISS-USA for a scheduled ISS contact, NASA CSLI for launch services, and your state's NASA Space Grant consortium for cash.

* `amount.amountRaw` → empty
  > No grants are made.

**`flexradio-no-education-tier`**

* `rawOtherText` → empty
  > FlexRadio exists and sells radios; it publishes no education, student, club or nonprofit purchasing tier. For genuinely discounted radio hardware the one verified route is the Yaesu System Fusion DR-2X repeater programme, which is a purchase at a program price rather than a grant.

* `amount.amountRaw` → empty
  > No education, student, club or nonprofit pricing exists.

**`vendor-equipment-relationship-playbook`**

* `rawOtherText` → empty
  > PLAYBOOK — advice, not a vendor's own text. 1) Do not send a cold form; there is no form. 2) Build the record first — a contest score, a Field Day writeup, a licence class you taught, students named. 3) Approach at a hamfest or at Hamvention, in person, with a one-page ask naming the exact model and what students will do with it. 4) Bring your faculty advisor and your callsign history. 5) Offer what a vendor actually wants: photographs, a results writeup, students at their booth, and the club callsign attached to a story worth repeating. 6) Ask your ARRL Section Manager for an introduction. Documented outcomes: IC-7610s at Carnegie Mellon W3VC, Penn State K3CR and Pitt W3YI. Kenwood: nothing found at all in the 2026-08-02 pass. Donors plainly do expect visible use, but no vendor has published that as a term.

* `amount.amountRaw` → empty
  > Equipment donations of real value have been made, but no programme, price list or award schedule is published by any of the three vendors.

* `amount.awardCountRaw` → empty
  > No published count.

**`dara-grantmaker-only-via-arrl`**

* `rawOtherText` → empty
  > DARA hosts no application of its own: the award is applied for through the ARRL Foundation, and the ARRL catalog entry is the authoritative statement of its terms. DARA states no full-time requirement, so a part-time student is not barred.

**`chicago-fm-club-scholarship-discontinued`**

* `rawOtherText` → empty
  > The scholarship really did end. A student who finds it on an aggregator is reading a stale mirror of a programme that no longer accepts applications.

* `amount.amountRaw` → empty
  > Not awarded. The programme no longer exists.

**`far-domain-compromised`**

* `rawOtherText` → empty
  > The former FAR domain, farweb.org, issues an HTTP 301 to batualam.org, an Indonesian online-gambling site whose page title begins TARGET88. Do not visit either domain. The Internet Archive pins the takeover between 2025-10-17 and 2026-02-10, and three researchers confirmed the redirect independently in the 2026-08-02 pass. If you are looking for one of FAR's former scholarships, search the ARRL Foundation catalog: the 10-10, QCWA, YASME, K3IVO and CARA funds all appear there now.

* `amount.amountRaw` → empty
  > No award is available through this organisation's former website.

