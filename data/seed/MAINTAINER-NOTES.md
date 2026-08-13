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

`packages/server/src/seed/funderVoice.test.ts` enforces that. It fails the build if any field the
product renders as the funder's own words — `rawOtherText`, a constraint's `rawText`, an
`aiPolicy.quote`, `amount.amountRaw` / `awardCountRaw`, a `fundingRestrictions` entry, a prose
obligation, or a sidecar `evidence` quote — mentions GrantSpotter's own workings. When it fails,
move the sentence here rather than rewording it until the detector stops noticing.

**Fields that are GrantSpotter's own voice and are not policed:** `summary`, `deadline.note`,
`trust.disputed.note` and `trust.staleMirrorWarning`. The page does not present those as anybody
else's words. A curation note that a *student* needs — "the cycle could not be resolved and this
record does not guess" — belongs in one of those, not in this file and not in `rawOtherText`.

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

---

## `programs.ham-orgs.json`

### `ylrl-ethel-smith-k4lmb`

> One of only two verified non-ARRL US ham scholarship application paths; its intake does not run
> through the ARRL catalog. Every fact in this record is quoted from
> `fixtures/ylrl/00-ylrl-net-scholarships.html`. Status is `unknown` rather than `open` because the
> page states no cycle at all: an unpublished deadline cannot support an open badge.

### `ylrl-mary-lou-brown-nm7n`

> Quoted from `fixtures/ylrl/00-ylrl-net-scholarships.html`.

### `ylrl-marte-wessel-k0epe`

> The one award in this corpus written FOR part-time students. `partTimeOK` is true and
> `degreeLevels` is empty on purpose: YLRL restricts neither, and an empty allow-list here means the
> funder set no level, not that no level qualifies.

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

## Known residual, NOT fixed here

Three records — `campus-sga-playbook`, `vendor-equipment-relationship-playbook` and
`nasa-space-grant` — carry a numbered playbook in `rawOtherText` that is GrantSpotter's advice to an
applicant, not any funder's text. Nothing in it is about GrantSpotter's own workings, so the guard
does not flag it, and deleting it would delete the only value those three records have.

It is still under a heading that says "text from the source". The interim measure is in the field
itself — each playbook now opens by saying it is advice and not the funder's own text — which a
reader can at least see. The real fix is a rendering one: an authored-voice block, the same
`GrantSpotter's words, not the funder's` treatment `Opportunity.tsx` already gives a composed
constraint, and it belongs to whoever owns `packages/web/`. Do not "fix" it by deleting the
playbooks.

The interim wording deliberately does not say the product's name. It cannot: the guard reads that
as a note about this software leaking into a funder-voice field, and it is right to — the first
draft of this fix wrote "GrantSpotter's advice, not a vendor's text" into `rawOtherText` and the
guard failed it.
