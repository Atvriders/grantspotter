# How this catalogue can be wrong

Read this before changing an extractor in `packages/server/src/normalize/axes/`, a rule in
`packages/core/src/matcher.ts`, or a record in `data/seed/`.

This is not a changelog. It is the list of ways GrantSpotter has actually told students something
untrue, which guard now stops each one, **over which corpus**, and — the useful half — which ones
nothing stops.

## Is it complete?

**No, and it cannot be.** That is the honest one-line answer, and the rest of this file is what
makes it useful rather than a shrug.

Three separate things are being asked when somebody asks that:

1. **Is every defect this project has already produced now either fixed, or held by a rule that
   re-measures it on every run?** — **Yes but one**, as of 2026-08-20. Every failure shape in the
   history below has a rule; every rule names the corpus it ran over; every register of
   live-but-unfixed defects is asserted by equality against a live sweep, so an entry cannot
   outlive the defect it describes. The exception is `arrl-foundation-special-funds`, which is
   written down here and in `data/seed/MAINTAINER-NOTES.md` and measured by nothing — see §"What is
   still unguarded" item 1. Note the weaker claim this makes than it looks: *held by a rule* is not
   *fixed*. **Five record-level defects and eighteen unread funder statements are live on
   grant.waterburp.com right now**, every one of them named in §"What cannot be closed from inside
   this repository": the Fisher and Cothran geography over-claims, the `arrl-foundation-special-funds`
   entity refusal, the MARCO graduate demotion, the unenforced ETP K-12 audience, and the 18
   `rawFields` keys a live source writes that nothing consumes.
2. **Is every defect the corpus could contain now guarded?** — **No, and the gap is measured.**
   Taking the worst-costing question — *does this record refuse somebody its own sentence
   admits?* — **110 of the 696 seed constraints (16%) sit on an axis that can refuse, under a
   sentence no arm of W13 can stand an applicant on.** They are counted by axis in `SEED_SILENT`
   and reproduced in §"What is still unguarded" item 2. Five more of W13's fourteen arms are live
   rules over a population that currently cannot refuse anybody at all. A rule that is silent about
   a record is not evidence that the record is right.
3. **Will the catalogue stay correct?** — **No.** It tracks about 150 pages that other people
   rewrite without telling us. A funder can change an eligibility sentence tonight and every guard
   in this repository stays green, because every guard compares our record against **a capture we
   took**, not against the page as it stands today. Nothing here can close that, and §"What cannot
   be closed from inside this repository" is the list of what a person has to do instead.

The useful form of "make it complete" is therefore: **close what a capture can decide, register
what it cannot with the specific act that would close it, and never let a green suite be read as an
answer to question 2 or 3.** That is what this file is for.

---

Two facts organise all of it.

> **1. Every defect below was invisible to a green test suite at the moment it shipped.** Ten
> consecutive rounds of hardening found them, and each was found by *running the product over the
> corpus and reading the output*, never by a suite going red. A green suite is evidence that the
> defects we have already met have not come back. It is not evidence about this one.

> **2. A guard is only true of the population it ran over.** For nine rounds every "does the spec
> say what the sentence says?" rule read the **fixture** corpus, and the fixture corpus is not what
> the deployment serves. The rules were green, and they were green about records no student has
> ever seen. This is now the first thing to check about any rule you write, and it is the column
> added to every table below.

---

## The distinction that makes the corpus column matter

Not every test needs a corpus column, and pretending otherwise turns this document into noise.
There are two kinds of claim in this repository:

| kind | example | does the corpus matter? |
| --- | --- | --- |
| **A claim about CODE** | "a record with no constraints yields `unknown`, never `eligible`" (`recordStatesNothing`) | **No.** It is a branch. Any corpus that reaches the branch proves it, and the branch behaves the same on records nobody has written yet. |
| **A claim about DATA** | "no allow-list admits a value its own sentence never names" | **Yes, totally.** It is a statement about 696 particular rows. Running it over a *different* 652 rows says precisely nothing about them. |

Every regression in the history below is the second kind. `a5dda09` — three sentences no funder
wrote, printed under *"ONE REQUIREMENT, AS THE FUNDER WROTE IT"* — was a data defect on records
the guards did not read. The guard was fine. It was pointed at the wrong people.

**When you write a rule, ask which kind it is. If it is a claim about data, it must name its
corpus, and it must count per corpus rather than reporting a sum** — a sum lets a rule that has
gone blind to one population hide inside the other.

---

## The two corpora, measured

Measured on 2026-08-16 through `packages/server/src/test/axesCorpora.ts`, which is the loader both
axis guards now share. Re-counted directly off `data/seed/*.json` on 2026-08-20: unchanged —
144 programmes, 696 constraints (545 hard, 151 soft), 12 with no constraints. `87c656c` changed
what several specs *say* and repaired three prose panels; it added and removed no constraints.

| | FIXTURE | SEED |
| --- | --- | --- |
| built by | re-running the real parsers + `normalize/axes/` over `fixtures/` | hand-written by a curator in `data/seed/*.json` |
| publishable programmes | 150 | 144 |
| constraints | 652 (523 hard, 129 soft) | 696 (545 hard, 151 soft) |
| programmes with **no** constraints | 28 | 12 |
| who sees it | `npm run profile-corpus`, the e2e database | **every fresh install, including grant.waterburp.com** |
| a constraint's `spec` was decided by | an extractor | a human |

They are not the same records, and the differences are not cosmetic: the seed corpus carries 103
`other` constraints to the fixture corpus's 64, because a curator records what a parser cannot.

Seed constraints by axis, which is the denominator for every "covered on one axis" claim below:

| geography | institution | license | field_of_study | other | citizenship | gpa | age_stage | ham_activity | arrl_membership | recommendation | financial_need | gender |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 133 | 130 | 116 | 115 | 103 | 27 | 18 | 15 | 11 | 10 | 8 | 6 | 4 |

---

## The three verdicts, and what each costs the student

| verdict | cost when wrong |
| --- | --- |
| `ineligible` | The money is hidden forever, silently. They never apply and never learn there was anything to apply for. |
| `eligible` | An application fee, transcript fees, three recommendation letters and a month of waiting, on money the funder was never going to give them. They find out by silence. |
| `unknown` | Nothing. The door stays open and nothing is claimed on anybody's behalf. |

`unknown` is not a cop-out and it is not a tie-break between the other two. **When the funder's
sentence does not settle the question, it is the correct answer.** Both of this project's worst
regressions happened by reaching for a verdict instead:

- **Round eight** read an opened list (`"…Field Day, etc."`) as a `pass`, and three programmes told
  applicants they qualified on activities the funder never named.
- **Round nine** wrote a *school tier* into the applicant's *credential* field and made 1,456
  (applicant, programme) pairs `ineligible` on sentences those applicants satisfy verbatim.

Both were corrections to a real defect. Both overshot. Neither author re-measured the direction
their correction came from — because until round ten there was no rule that measured it.

---

## The failure shapes, what covers each, and over which corpus

### 1. Fabricated funder text — a value published as the funder's words that the funder did not write

This is the defect family that has recurred most and cost the most rounds. The record page makes
the promise on **three** separate surfaces, and until 2026-08-16 they were guarded very
differently — one of them not at all.

| surface | what it prints | guard | corpus |
| --- | --- | --- | --- |
| `<p className="verbatim">{constraint.rawText}</p>`, and the ineligibility drawer's "Quoted below in the funder's own wording" | each constraint's sentence | `seed/constraintProvenance.test.ts` — every constraint must be ONE contiguous verbatim run of its own record's captured page | **both.** Seed through `loadSeedCorpus`, fixtures through `loadCorpus` |
| `spec.orUnrepresented`, rendered by `VerdictBadge` "in the funder's own terms" | the funder's phrase for a route the schema cannot model | `normalize/axes/unadjudicable.test.ts` — every route must appear verbatim in its own `rawText` | **both, since 2026-08-16.** Fixture 90 routes, seed **95** (91 until `87c656c` added four). Before that date, fixture only — the seed routes had never been read by it |
| `<h2>Unstructured requirements, verbatim</h2>` — "reproduced exactly, because paraphrasing is where a requirement that was never written down gets invented" | `program.rawOtherText` | `seed/constraintProvenance.test.ts`, added 2026-08-16 | **seed.** 117 records carry the field and **all 117 are verbatim**. 118/115 on 2026-08-16 — see below |

**The middle row is one link weaker than the other two, and the difference matters.** The
`orUnrepresented` rule checks a route against its own constraint's **`rawText`**, not against the
funder's captured page. On a record that has a capture that is a chain — `rawText` is itself held
verbatim to the capture by the top row — so the route inherits the capture's authority. **On a
record with no capture there is no chain.** `rca-track`'s new route, "wireless career track", is
verbatim in a `rawText` that is GrantSpotter's own research brief, because `rca-scholarship-program`
is `manual-tier-d` and ships no page. What that rule proves there is internal consistency, not
provenance. Four of the corpus's records are in that position; they are named in §"What cannot be
closed from inside this repository" item 2.

**Three live defects, found 2026-08-16 and repaired 2026-08-20.** This is the one worked example in
this file of a register doing its whole job, so it is written out rather than deleted.

When the third rule was written it went red on three records that were on the deployment at the
time. They were put in a register called `NOT_VERBATIM` rather than "fixed", because **inventing a
replacement sentence for a funder is the defect itself** and the agent that found them could not
read the three funders' pages. Four days later a round that could read the committed captures
repaired all three:

- **`ariss-iss-contact`** — carried *"SPARKI is named once on this page as a companion programme,
  and the proposal-window sentence is rewritten each quarter at a stable URL."* A sentence **about
  the funder's page**, in GrantSpotter's voice, printed as the funder's text. Its own next clause,
  "Selection timing, in ARISS's words:", conceded that what preceded it was not. **Now**: the two
  ARISS sentences that clause was introducing, and nothing else.
- **`ieee-mtts-chapter-support`** — carried *"In addition to the chapter activity support above,
  MTT-S offers…"*. "In addition to … above" is a cross-reference to another part of **our** record;
  no funder's page can contain a reference to a GrantSpotter layout. **Now**: the single MTT-S
  sentence about Chapter Officer travel support, as MTT-S wrote it.
- **`ardc-grants`** — carried a paragraph of ARDC guidance about proposal scope and roadmaps that
  reads as genuine ARDC copy but appears nowhere in the page this record is keyed to. Most likely
  real text from a *different* ARDC page. That is a provenance failure rather than an invention,
  and it is indistinguishable from one here — which is the point. Under a heading that says
  "reproduced exactly", unverifiable and false cost the reader the same thing. **Now**: empty.
  Nothing is the only honest answer to text nobody can pair to the page it is filed under.

**What that episode proves about registers, and it is the reason to keep writing them this way.**
The register was asserted with `toEqual`, not containment. So on the day the three were repaired the
suite went **red** — "expected `[]` to deeply equal `['ardc-grants', …]`" — and the fix could not be
merged without deleting the register in the same pass. A register asserted with `toContain` or a
`>=` count would have gone green on the repair and left three names sitting in a test file
describing defects that no longer existed.

This repository has met the other outcome. `KNOWN_TOOTHLESS` once held 26 records that a previous
agent pinned rather than fixed, over the note "it is reported in the round summary". Twenty were a
real defect that stayed live behind the pin; six were the rule crying wolf and had never been
defects at all. Nobody re-read which was which for a round. The comment retiring that list is the
sentence this file exists to repeat: **an allowlist that outlives its defect is how a fixed bug
comes back** — and its mirror, that an allowlist which cannot go red when its defect is fixed is
not a register at all, but a comment that costs a test run.

The three names did not simply vanish either. They moved into
`THE_THREE_THAT_WERE_NOT_VERBATIM` in the same file, where each is asserted **by name** to be in
the repaired state — the meta-commentary words gone from ARISS, the layout cross-reference gone
from MTT-S, and ARDC's panel empty. The ARDC pin is a deliberate over-pin, and the test says so:
emptying the field removes the record from the sweep's population entirely, so a corpus-wide rule
can no longer see it at all, and only a by-name assertion keeps it in view.

Both halves were **watched failing** rather than argued for. Restoring ARDC's old paragraph to
`data/seed/programs.curated.json` and running the file takes the sweep red with
`expected [ 'ardc-grants' ] to deeply equal []` and the scar red on its emptiness pin; the seed file
was restored byte-identical afterwards. Every structurally blind guard this project has found was a
working predicate over a sweep that never handed it the record, so **a guard nobody has watched fail
is a guard nobody has tested.**

**Named exclusions, which are honest but are not coverage.** The constraint rule cannot reach
records with no captured funder page: four `manual-tier-d` records (`yasme-supporting-grants`,
`rca-scholarship-program`, `nasa-space-grant`, `dara-grantmaker-only-via-arrl`) whose `rawText` is
GrantSpotter's own research brief, so a "match" would be our prose agreeing with our prose; and
`austin-arc-greenwood`, which names no source at all. They are asserted **by name**, so the day one
gets a real capture it moves into the checked set rather than staying quietly outside it.

### 2. A gate that refuses everybody over an empty list

An empty allow-list read as "nothing is permitted" rather than "the funder said nothing".

**Covered, both corpora.** `matcher.ts` treats an empty list as silence — a claim about *code*.
`sentence-vs-spec.test.ts` W10 asserts that a constraint refusing *everybody it can build an
applicant for* is a defect, with an empty-equality offender list that names the record in the diff.

### 3. A programme refusing an applicant its own quoted sentence admits

Six programmes did this at once, on the geography axis, when a cascade's last rung was discarded.
Then round nine did it to 1,456 (applicant, programme) pairs on the institution axis at a stroke.

**Covered on ten of the thirteen axes, both corpora, since `edb4a38`.** The question — *does this
spec refuse somebody the funder's own sentence admits?* — is asked by **W13** in
`sentence-vs-spec.test.ts` on **fourteen dimensions**: `geography.state`, `license.class`,
`license.duration`, `field_of_study.major`, `institution.accreditation`, `institution.partTime`,
`gpa.floor`, `arrl_membership.duration`, `citizenship.status`, `age_stage.stage`, `age_stage.age`,
`ham_activity.kinds`, `ham_activity.cwWpm`, `gender.allowed`. Each arm builds an applicant standing
on a value **the funder's sentence itself names**, maximally qualified on every other dimension,
and runs it through the real `evaluateConstraint`. `refusesTheAdmitted` is asserted **empty** on
both corpora — no register at all — and the soft half carries exactly one entry.

**W12 is still the institution-specific rule** and still worth its own existence: it replays the
round-nine state and goes red on all 40 refusals that change produced. W13 is the general form.

**The three axes with no arm are the three that cannot refuse anybody, and that is asserted rather
than assumed.** `other` (103 seed constraints), `recommendation` (8) and `financial_need` (6) —
117 seed and 83 fixture constraints — are run against five deliberately adversarial applicants,
including one who has answered every question with its least generous answer. None is refused.
A rule that had merely *probed* those axes would have reported all 117 as covered.

**What W13 does not reach, stated as a number.** Its `SEED_SILENT` census counts every constraint
no arm could read, by axis:

| geography | field_of_study | institution | gpa | arrl_membership | *(recommendation)* | *(financial_need)* | *(other)* |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 42 | 60 | 6 | 1 | 1 | *8* | *6* | *103* |

The three italic columns are the harmless axes above. **The first five are the hole: 110 of 696
seed constraints — 16% — sit on an axis that CAN refuse, under a sentence this file's vocabularies
cannot stand an applicant on.** A bare "Any", a county, a circle drawn round a clubhouse, a field
list written as a career track. W13 is silent about all 110, and its silence is not evidence.

**And five of the fourteen arms are live rules over an unarmed population** — `institution.partTime`
(122 seed probes, 0 that could be refused), `institution.accreditation` (67/0), `license.duration`
(103/0), `arrl_membership.duration` (9/0), `ham_activity.cwWpm` (1/0). Every `institution` spec in
both corpora carries `partTimeOK: true`, so no record can refuse a part-time applicant *today*.
That is a fact about the corpus, not about the rule, and the census prints `couldRefuse` beside
`probes` precisely so the two cannot be confused. Each of the five has a planted proof that arms it
on a real seed record and watches it speak — the difference between "found nothing" and "cannot
see".

**The refusal that W13 structurally cannot see is one level up from a constraint.** `matchProgram`
hard-refuses on `program.applicantEntities` with a plain `includes()`, before any constraint is
evaluated (`matcher.ts`, `applicantEntitiesUnrecorded`). W13 sweeps `constraints`; nothing sweeps
`applicantEntities` against the funder's sentence. See §"What is still unguarded" item 1 for the
live record this costs.

### 4. A record that states nothing, publishing a permission

**Covered, and it is a claim about code, so the corpus is not the issue.** `recordStatesNothing` in
`matcher.ts` forces `unknown` when `constraints.length === 0`. It fires on 28 fixture and **12 seed**
records. Note what this means for every rule in this file that sweeps *constraints*: those 12 seed
records are **invisible to all of them**, because they contribute no constraint to sweep. Their
correctness rests entirely on the matcher branch, not on any data rule.

### 5. A render crash that ate unsaved work

**Covered.** e2e, plus error boundaries. Not a data problem; it is here because it was invisible to
unit tests for the same reason as the rest.

### 6. A refusal that promised 1 second for a 15-minute lockout

Copy that contradicted the mechanism behind it.

**Partly covered.** e2e asserts the message against the real server. Nothing generally checks that
user-facing copy matches the rule it describes.

### 7. Two overshoots in opposite directions

**Covered as of round ten**, and this pairing matters more than either rule alone:

| direction | rule | what it asks | reach |
| --- | --- | --- | --- |
| spec too WIDE (false include) | W1–W9, W10, W11 | does the spec admit a value / pass an applicant the sentence never named? | every axis it can build a probe for, both corpora |
| spec too NARROW (false exclude) | **W12** | does the spec refuse an applicant the sentence admits? | `institution` only — 130 of 696 seed constraints |
| spec too NARROW (false exclude) | **W13**, `edb4a38` | the same question on every axis a sentence can name a value on | 14 dimensions across 10 axes; the other 3 axes proved unable to refuse anybody |

Before W12 every rule in `sentence-vs-spec.test.ts` measured the same direction. A change whose
entire content was 1,456 new refusals passed the file green — and *raised* W10's coverage figure by
24, which was written into the commit message as evidence the fix was working. **A rise in a
coverage count measures how much a rule ASKS, not how much of it is worth asking**, which is why
W13's census prints `couldRefuse` next to `probes` and why five of its arms are named as unarmed
rather than counted as covered.

### 8. A test harness that cannot run

Not a lie told to a student, but it is how a lie survives. Until 2026-08-16 `e2e/` pinned five
hardcoded loopback ports. An unrelated project on this machine held one of them and answered
`/api/health` on it, so the second-boot spec — the only proof that a container restart does not
duplicate every record — could not execute, and the failure message blamed "an orphaned
`node packages/server/dist/index.js`". The suite reported `62 passed, 1 failed` and the honest
remedies were to edit a committed constant per machine or stop somebody else's service.

**Covered.** Every harness boot that is not forced to publish its port at module scope now takes an
OS-assigned one (`reserveLoopbackPort`). The "refuse a port somebody else is on" check is kept, and
is now unreachable rather than merely watchful.

---

## The registers, and what a register is for

A **register** in this repository is a list of things that are *wrong right now*, asserted against
a live measurement so that it goes red in **both** directions: red when a new offender appears, and
red when a listed one is fixed and the entry is left behind. It is the opposite of an exemption,
which is silent forever.

Census, `da204cc` → `HEAD`, counting only lists whose entries assert a live defect:

| register | file | at `da204cc` | now |
| --- | --- | --- | --- |
| `KNOWN_GEO_OVERCLAIMS` | `axes/sentence-vs-spec.test.ts` | 2 | 2 |
| `KNOWN_SEED_GEO_OVERCLAIMS` | " | 2 | 2 |
| `KNOWN_SEED_LEVEL_OVERCLAIMS` | " | 1 | **0** |
| `KNOWN_SEED_INVENTED_FIELDS` | " | 1 | **0** |
| `KNOWN_SEED_WIDENING_PASSES` | " | 3 | **0** |
| `KNOWN_TOOTHLESS` | " | 0 | 0 |
| `KNOWN_NOTED_ONLY` | " | 2 | 2 |
| `KNOWN_SEED_TOOTHLESS` | " | 1 | 1 |
| `KNOWN_SEED_NOTED_ONLY` | " | 3 | 3 |
| `KNOWN_SOFT_DEMOTIONS` | " | *(did not exist)* | 1 |
| `NOT_VERBATIM` | `seed/constraintProvenance.test.ts` | 3 | **0** |
| `NO_FLOOR_KNOWN_DEFECTS` | `licenseFloorContract.test.ts` | 0 | 0 |
| `WRITE_ONLY_KNOWN_DEFECTS` | `rawFieldsContract.test.ts` | 18 | 18 |
| **total** | | **36** | **29** |

`figureProvenance.test.ts`'s `REGISTER` is deliberately **not** in that total and is worth naming
separately: its 14 entries are figures a record prints that its own capture does not carry, and each
one is *accounted for* rather than wrong — 9 `quoted-from` a named sibling capture, 2 `derived` and
**recomputed from the captures on every run**, 2 `not-a-quantity` (the "12" inside "K-12"), and 1
`off-capture` whose field discloses where the number came from. Counting them as defects would
overstate the backlog; counting them as coverage would understate what they are. They have the same
staleness guard as everything else: a figure that appears on its own page must leave the register.

Eight entries went and one arrived. All eight went because the defect went, and in every case the
data fix and the register deletion are visible as separate acts: `87c656c` repaired the records
against the funders' own committed captures, which turned five register entries red, and `edb4a38`
deleted them; the same commit added `KNOWN_SOFT_DEMOTIONS` with the one record W13 found.
`NOT_VERBATIM`'s three were repaired by `87c656c` too and deleted here.

**Every surviving entry was re-checked against a live measurement rather than against its comment**,
and the check is the register's own assertion: each of the lists above is compared with
`toEqual` to a set computed by sweeping the corpus on this run, or — for `WRITE_ONLY_KNOWN_DEFECTS`
and the figure `REGISTER` — has an explicit companion test that fails when a listed item stops being
an offender (`'has a register whose every entry is still needed'`, `'no listed field has since
gained a reader'`). There is no register in this repository whose entries are believed rather than
measured, and the `NOT_VERBATIM` episode is the proof that the mechanism fires: the suite was red
about those three names before anybody went looking.

The same staleness discipline covers the **by-design exemption** lists too — `WRITE_ONLY_BY_DESIGN`,
`NO_FLOOR_BY_DESIGN`, `NOT_IN_THE_AUDITED_POPULATION`, `NO_CAPTURE_BY_DESIGN`, `EGRESS_EXEMPTIONS`,
`NOT_A_FIGURE_SURFACE`, `SKIPPED_BY_DESIGN`, `NOT_A_VITEST_FILE`, `NOT_TYPECHECKED`,
`DECORATIVE_BORDER`, `UNMEASURABLE_BY_DESIGN` — each has a test that fails when an entry stops being
needed. If you add a list, add that test in the same commit.

**`WRITE_ONLY_KNOWN_DEFECTS` is the one register that is deliberately not silent.** Its 18 entries
are emitted as `it.todo`, so every run of `npm test` prints `18 todo` on its summary line. `todo` is
the one result vitest never counts as passing. There is no run of this suite in which those 18 are
invisible, and no "all green" that includes them.

---

## What is still unguarded

Be specific here or the section is worthless. These are holes, today, with nothing standing in
them.

1. **A programme-level refusal that no rule reads: `arrl-foundation-special-funds`.** The record
   publishes `applicantEntities: ['club_unincorporated', 'club_501c3', 'school_lea']`, seeded
   exactly as adjudicated. `matchProgram` gates on that list with a plain `includes()`, so measured
   against the seeded record **seven of the ten `ApplicantEntity` values are a hard `ineligible`**.
   One of the seven, `individual`, is refused correctly — this is a grant to clubs and schools. The
   other six are the question: `club_via_fiscal_sponsor`, `university`, `university_dept`,
   `ieee_student_branch_chapter`, `teacher`, `nominated_by_institution`. For four of them ARRL's
   page really is silent. For
   `university` and `university_dept` it is worse than silent: *"general-interest radio clubs that
   sponsor subgroups of young people"* plainly describes a collegiate radio club — **this product's
   primary audience** — and *"but not be limited to"* is ARRL saying the list does not close. No
   sentence on that page excludes a university club.

   This is shape 3 exactly, pointed at a field shape 3's rule does not sweep. It is written down
   rather than patched because widening an adjudicated value unilaterally is how a curation round
   becomes unreviewable. **No shipped profile is affected — none of the seven is a university org —
   which is precisely why it would otherwise go unmeasured.** The general fix is an
   `applicantEntities` arm for W13; the specific fix is a curator's decision on one record.

2. **110 of 696 seed constraints are on a refusal-capable axis that W13 cannot probe.** Shape 3
   has the table. Geography (42) and field_of_study (60) are almost all of it. Extending the
   vocabularies — counties, radii, `type: 'any'`, career-track field lists — is the highest-value
   next piece of work in this file, and the shape to copy is already written fourteen times over.

3. **Only two prose fields on the record page have any provenance rule at all.**
   `constraints[].rawText` and `rawOtherText` are checked against the funder's capture. `summary`,
   `fundingRestrictions[]`, `obligations`, `deadline.note`, `amount.amountRaw` and
   `amount.awardCountRaw` are **not** — every one of them is displayed, and every one is curator
   text on the seed corpus. They do not sit under a "verbatim" heading, which is the only reason
   this is a lower-grade hole than shape 1 rather than the same one. Note what *is* covered:
   `figureProvenance.test.ts` reads every **number** on those fields and requires each to be on the
   record's own capture or in its register of 14 — so the figures are held and the sentences around
   them are not.

4. **Ten institution constraints are checked by nothing.** `sentence-vs-spec.test.ts`'s `typeOnly`
   bucket. Eight say only "4-year college or university" — no accreditation clause, no enrolment
   clause — so there is no statement about the *applicant* the schema can test, and W10 builds no
   probe. Counting them is honest; it is not coverage.

5. **The schema has no field for the school's tier.** `StudentProfile.degreeLevel` is the credential
   the applicant is pursuing; `institution` is free text no axis reads. So "must attend a 4-year
   college or university" can never be answered, only quoted back. Adding such a field would convert
   ~34 `unknown`s into real verdicts — and would be the single most dangerous change anyone could
   make to this codebase, because it invites exactly the conflation that produced the 1,456. If you
   add it, extend W12 **and** W13 in the same commit.

6. **Nothing measures verdict movement automatically.** Every "measured both directions" figure in
   this repository's commit messages was produced by hand, with a throwaway script over
   `scripts/profile-corpus.ts`'s loader — including the "659 (profile, program) pairs, zero
   differences" that signs off `87c656c`. There is no committed harness and no committed baseline,
   so the next author has to rebuild the instrument before they can check themselves. **Rebuild it
   anyway.** The recipe: census `matchProgram` over every profile × credential rung × state ×
   publishable programme, before and after, and diff the pairs. Anything other than
   `ineligible -> unknown` in bulk deserves a paragraph in the commit message. (The one committed
   thing in this shape is `seed/consentedCorrections.ts`, which computes a verdict movement per
   proposed correction for the operator to read — per correction, not per corpus.)

7. **A parse pinned by a value is a parse, not a rule.** `spec-vs-sentence.test.ts` protects one
   geography record with `toHaveLength(10)`. That guards one record and teaches nothing.

8. **The corpus is ~150 records from a handful of sources.** Every count in every test is a fact
   about *these* records. A rule that is silent today may be silent because the shape it catches is
   not in the corpus yet, not because the product handles it.

9. **`funderVoice.test.ts` cannot see a fluent invention.** It catches a field that is visibly
   GrantSpotter talking — machine tokens, cross-references to our own layout, absence claims. A
   green tick there means "no field is visibly us"; it does not mean "every quotation in this corpus
   is real". Its own header lists all five blind spots. The rule that *can* catch a paraphrase is
   `constraintProvenance.test.ts`, and it only reaches records that have a committed capture.

10. **A record that is wrong on a deployment can only be corrected where nobody has touched it.**
   `seed/corrections.ts` rewrites a shipped value at boot only when the stored bytes hash to
   something in `data/seed/shipped-values.tsv`, which proves we wrote them. Three consequences, all
   of them live:

   - a record an operator has **edited** keeps their text, correction or no correction. That is the
     right default — it is their instance — but a fixed defect can survive on a deployment
     indefinitely, and the only thing that tells them so is a boot line and an `audit_log` row.
   - a correction that **deletes** something is never applied automatically. The three invented
     eligibility constraints round two removed (`club-grant-affiliated`, `sga-rso`, `mtts-field`)
     are still on every instance that had them, being reasoned over by the matcher, until an
     operator acts.
   - `constraints` is in the reconcile's `WITNESSED_ONLY_PATHS`. **A `docker compose pull` does not
     repair a corrected constraint sentence**; it reports it. Every fix to a funder quotation is a
     fix to the *next* install and a notification to the existing ones.
   - a database seeded by a release **older than the ledger's oldest recorded revision** cannot be
     corrected at all: nothing proves what it holds is ours. The ledger reaches back to the first
     commit of `data/seed`, so this is theoretical today and stops being theoretical the moment
     somebody prunes the file.

   **Since `b23ddb8` there is a second door for the first two**, and it does not close them by
   itself. Admin → "Pending changes from the image" shows an operator every correction the boot
   path computed and refused, each with its rule diff and the verdict movement it would cause, and
   applies them on consent with the operator's id in the audit row. Measured on a database seeded
   from the corpus of `8d5c0a2`, that is 88 records whose eligibility rules the corpus has changed
   (one of them `dara-grantmaker-only-via-arrl`, hard-refusing every graduate applicant on a
   sentence about the *school*), one record whose `deadline.note` asserts a noon close ARRL never
   published, and one record the corpus has added that `importSeedIfEmpty` will never write.
   **The cost is stated rather than hidden: until somebody presses it, the defect stays live.**
   A screen nobody opens is exactly as effective as the boot report nobody reads, and the boot
   report has already been measured failing on this operator.

---

## What cannot be closed from inside this repository

This is the section that matters, and it is the reason "is it complete?" has no yes.

Every guard in this repository compares a record against **a capture committed under
`fixtures/<sourceId>/`**. That is the whole of its authority. It follows that:

> **No test in this repository can tell you whether a funder's page still says what our capture says
> it said.** Every green run is a statement about the day the capture was taken. The catalogue
> tracks about 150 pages that other people rewrite without telling us, and a scholarship whose
> eligibility sentence changed last night is green here and wrong on the screen.

Re-capturing is a network act, done by `scripts/capture-fixture.ts` and the crawl scheduler, and its
output has to be **read** — the review inbox exists for that. That work has no end state. Anyone who
writes "the catalogue is now correct" is describing a moment, and should date it.

Beyond that standing condition, five specific things are open right now, and each needs a person
rather than a patch. They are ranked by what they cost a student.

### 1. Somebody has to open a web page: the Charles N. Fisher Memorial Scholarship

**What is wrong.** The record admits **every Californian**. Its own sentence names the ARRL
**Southwestern Division** — the Los Angeles, Orange, San Diego and Santa Barbara **sections**. A
student in Eureka is currently told they are eligible for an award whose funder's sentence is about
southern California. Registered as `KNOWN_SEED_GEO_OVERCLAIMS` /
`arrl-cat-the-charles-n-fisher-memorial-scholarship`, constraint `geography-0-e0bd5c90`.

**Why nothing in here can fix it.** ARRL section boundaries are drawn by county, and **the county
lists are not in this repository.** Narrowing the record without them means either guessing (which
manufactures false *excludes* — the expensive direction, §"The three verdicts") or collapsing
forty-eight states into `maybe`.

**What a person has to do.** Open <http://www.arrl.org/sections>, and write down which **counties**
ARRL places in the Los Angeles, Orange, San Diego and Santa Barbara sections. With those four lists
committed, the extractor can emit `geo: county[...]` plus `anyOf state[AZ]` and the register entry
closes. This is the only open item in the whole set that requires a browser.

### 2. Somebody has to make a curation decision, on a page that is already captured

Four of these. The capture settles the facts; it does not settle what the record should say.

- **`arrl-foundation-special-funds` — the six refused entities.** §"What is still unguarded" item 1.
  A decision about whether *"clubs … including but not be limited to"* admits a university radio
  club. It changes who is refused, so it is a curator's call, not an agent's.
- **MARCO, `age_stage`, `KNOWN_SOFT_DEMOTIONS`.** *"Preference will be given to undergraduate
  students and those in certificate programs, but graduate students may apply."* The funder made
  **two** statements — a preference and a permission — and one soft `age_stage` constraint holds
  only the first, so a graduate applicant reads as missing a criterion. Widening `stages` to
  `['UNDERGRAD','GRAD']` would express the permission and **destroy** the preference: every graduate
  would then read as meeting a preference the sentence gives to somebody else. **The record needs
  two constraints, not a wider one.** It is soft, so no verdict turns on it — what is lost is an
  `eligible_preferred` ranking.
- **ARRL Teachers Institute / ETP, `KNOWN_SEED_NOTED_ONLY`.** The record's audience bar lives in
  `etp-k12`, whose spec is `axis: 'other'` — and an `other` constraint enforces nothing at all
  (asserted, §shape 3). So a college student is refused by nothing on a programme ARRL states is for
  K-12 classrooms. **No axis in the schema can express "the applicant teaches K-12".** This one
  needs a schema decision before it can need a curation decision.
- **`rca-scholarship-program` and the three other `manual-tier-d` records.** `yasme-supporting-grants`,
  `rca-scholarship-program`, `nasa-space-grant`, `dara-grantmaker-only-via-arrl` ship **no captured
  funder page at all**, so their `rawText` is GrantSpotter's own research brief and a provenance
  "match" would be our prose agreeing with our prose. They are excluded **by name** from
  `constraintProvenance.test.ts`, so the day one gets a real capture it moves into the checked set.
  Capturing those four pages is the single cheapest way to grow the audited population.

### 3. Somebody has to write code, and the capture already decided the answer

Two, both fully specified:

- **The James Cothran, KD3NI, Scholarship geography** (`KNOWN_SEED_GEO_OVERCLAIMS`). The record
  admits Puerto Rico and the Virgin Islands under a sentence that lists its states by hand. Unlike
  Fisher, **the capture settles it** — this is an extractor fix in `normalize/axes/geography.ts`,
  not a research question.
- **The NCDXF W6EEN stage probe** (`KNOWN_SEED_TOOTHLESS`). A false alarm, not a record defect:
  `STAGE_SAYS.UNDERGRAD` matches the word "university", which on that page appears in a clause about
  **how to apply**, not about who may. The rule then demands a refusal the funder never wrote. The
  fix is to split the stage vocabulary the way the level vocabularies are already split — and it
  changes what W10 probes across **both** corpora, so it is a rule change with its own measurements.

### 4. Eighteen funder statements are parsed and read by nothing

`WRITE_ONLY_KNOWN_DEFECTS`, printed as `18 todo` on every run. These are not provenance failures —
the text is real and the funder wrote it — they are facts an applicant acts on that never reach the
matcher, because the pipeline reads a fixed handful of key names. The most expensive:

- **`window`, `windows`, `deadline`, `requestWindow`, `deadlineNote`, `applicationCycle`, `cadence`
  — seven keys, all deadlines.** ARRL ETP's *"BETWEEN OCTOBER 1ST AND OCTOBER 31ST of 2025"*, the
  ARRL scholarship page's *"Scholarship Cycle is now closed."*, ARRL Amateur Radio Grants' three
  annual windows, IEEE MTT-S's *"must be received by October 1"*. **Records whose own page states a
  closed or elapsed window still publish `open`.** That is a student budgeting an application fee
  against a deadline that has passed.
- **`applicant`** — *"Grants are awarded only to organizations, not individuals"* and ETP's
  *"applicants must be a current ARRL member"*, reaching the matcher only if they happen to survive
  in `rawText`.
- **`restrictions`** — ARRL's *"requests for emergency communications equipment … will not be
  considered"*. What an applicant needs to read **before** writing a proposal.

Each entry names the consumer that ought to exist. Consuming a key deletes its entry, and the
orphan check is asserted by equality, so an entry cannot outlive its defect.

### 5. Nobody can prove a fluent invention is not there

The absence claims in this file are only as good as the completeness of what was searched, and the
presence claims only as good as the authenticity of what was searched. Both halves have been
violated in this project inside the last month:

- A round globbed `fixtures/<sourceId>/` whole, read `pathological.*` — the **synthetic
  parser-torture pages** that live in the same directory as the real captures — as ARRL's page, and
  produced six confident "contradicted" findings that were all false. One would have replaced a
  correct `$500` with an invented `$1,000` and barred Technician-class applicants from a scholarship
  open to any class. **Only files matching `/^\d\d-/` are the funder's words**, and the safe route
  is not to glob at all: read the parsed capture through `loadRawOpportunities`, which is what
  `constraintProvenance.test.ts` and `figureProvenance.test.ts` do.
- Nine consecutive rounds of "does the spec say what the sentence says?" ran over the **fixture**
  corpus and were green about records no student has ever seen.

There is no rule that can be written here to close this one, because it is a claim about what a
guard did not look at. The only remedy is procedural, and it is the checklist at the end of this
file.

---

## The recurring defect class, stated once

Three separate places in this codebase have confused **the school the applicant attends** with
**the credential the applicant is pursuing**, and each one cost a round:

- `institution.ts` wrote a school tier into `degreeLevels` — 1,456 false refusals.
- `sentence-vs-spec.test.ts`'s `levelsNamed` fed a tier into a refusal floor, so the *test* was
  demanding the refusal the product had just shipped.
- `LEVEL_SAYS.CERT` reads "technical school" as a credential, which made the first draft of W12
  accuse a record of refusing a certificate student its own sentence refuses in the funder's words.

The general form: **a phrase that describes the applicant's context is not a statement about the
applicant, and the schema usually has a field for only one of them.** The same file already declines
this inference in the geography direction — "Accredited 4-year college or university in NC, VA, WV,
MD or TN" names where the *school* is, and `state` is where the *applicant* lives, so it is not read
as a residence bar. When one rule in this repository declines an inference, go and make the mirrored
rule answer for its own.

## The second recurring class: our voice in their box

`a5dda09` removed three sentences from `constraints[].rawText`: four ARDC sentences compressed into
three of ours; an **absence claim** ("names no college or university track") presented as a
quotation; and a sentence about **this product's own catalogue** inside a box promising the funder's
words. On 2026-08-16 the identical three shapes were found in `rawOtherText`, one field over, on a
surface nobody had ever checked.

The lesson is not "check `rawOtherText`" — that is now done, and on 2026-08-20 the last three
records it caught were repaired. It is: **every place the UI promises somebody else's words is a
place this defect will appear, and the list of such places is not written down anywhere but here.**
Before adding a panel that quotes a source, add the rule that proves it quotes.

The three surfaces that make the promise today, and the rule on each, are the table in shape 1.
There is a fourth family that makes no such promise and is therefore checked differently: the six
curator-prose fields (`summary`, `deadline.note`, `amount.amountRaw`, `amount.awardCountRaw`,
`fundingRestrictions[]`, `obligations.*`). Those are legitimately the curator's own words — which
is exactly why a verbatim rule is the wrong instrument for them, and why they went unread for four
rounds of work on fabricated funder text. What `figureProvenance.test.ts` holds them to is narrower
and non-negotiable: **every number, money amount and date they state must appear in the capture of
that record's own funder page.** The curator's licence covers the words around a figure. It has
never covered the figure.

## The habit that would have prevented all of it

Before committing a change to a verdict:

1. Name the corpus. If the claim is about data, run it over `data/seed` — that is what a student is
   served — and report per corpus, never a sum.
2. Run the corpus census **both ways** and report both numbers, even when one is zero.
3. Say which direction the change moves and which direction it *came from*, and re-check the second
   one explicitly.
4. Prefer `unknown` to any verdict the funder's sentence does not settle.
5. When you delete a rule's exemption or allowlist, delete the comment that justified it in the same
   edit. A doctrine that outlives its evidence is how this project reintroduced the same defect
   family ten times.
6. **Assert a register with `toEqual`, never `toContain` and never a count.** A register that
   cannot go red when its defect is *fixed* is a comment that costs a test run, and the fixed
   defect walks back in behind it. If you cannot repair an entry, leave it — but leave it somewhere
   that fails the day somebody else does.
7. **`fixtures/<sourceId>/` is not a corpus of funder pages.** It also holds `pathological.*`,
   synthetic parser-torture pages written to break extractors. Only files matching `/^\d\d-/` are
   the funder's words. Better: do not glob the directory at all — read the parsed capture through
   `loadRawOpportunities`, the way `constraintProvenance.test.ts` and `figureProvenance.test.ts`
   do. Reading one torture fixture as ARRL's real page cost this project six confident, entirely
   false findings, one of which would have replaced a correct `$500` with an invented `$1,000`.
8. **State what you did not check.** An absence claim is only as good as the completeness of what
   you searched; a presence claim only as good as the authenticity of what you searched. Both are
   in this file because both have been violated here, four days apart.

---

## As of

Every count in this file was measured on **2026-08-20** against the tree at the commit that added
this line, with `npm test` and `npx playwright test`. Corpus figures come from `data/seed/*.json`
and from the censuses inside `sentence-vs-spec.test.ts` and `constraintProvenance.test.ts`, not from
memory.

**Date the next revision too.** A catalogue that tracks pages other people rewrite is never "done",
and a file that claims otherwise is more dangerous than one that says so plainly.
