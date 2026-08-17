# How this catalogue can be wrong

Read this before changing an extractor in `packages/server/src/normalize/axes/`, a rule in
`packages/core/src/matcher.ts`, or a record in `data/seed/`.

This is not a changelog. It is the list of ways GrantSpotter has actually told students something
untrue, which guard now stops each one, **over which corpus**, and — the useful half — which ones
nothing stops.

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
axis guards now share.

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
the promise in **two** separate panels, and they were guarded very differently.

| surface | what it prints | guard | corpus |
| --- | --- | --- | --- |
| `<p className="verbatim">{constraint.rawText}</p>`, and the ineligibility drawer's "Quoted below in the funder's own wording" | each constraint's sentence | `seed/constraintProvenance.test.ts` — every constraint must be ONE contiguous verbatim run of its own record's captured page | **both.** Seed through `loadSeedCorpus`, fixtures through `loadCorpus` |
| `spec.orUnrepresented`, rendered by `VerdictBadge` "in the funder's own terms" | the funder's phrase for a route the schema cannot model | `normalize/axes/unadjudicable.test.ts` — every route must appear verbatim in its own `rawText` | **both, since 2026-08-16.** Fixture 90 routes, seed 91. Before that date, fixture only — the 91 seed routes had never been read by it |
| `<h2>Unstructured requirements, verbatim</h2>` — "reproduced exactly, because paraphrasing is where a requirement that was never written down gets invented" | `program.rawOtherText` | `seed/constraintProvenance.test.ts`, added 2026-08-16 | **seed.** 118 records carry the field; 115 are verbatim; **3 are not — see below** |

**Three live defects, registered not fixed.** On 2026-08-16 the third rule was written and went red
on three records that are on the deployment right now:

- **`ariss-iss-contact`** — *"SPARKI is named once on this page as a companion programme, and the
  proposal-window sentence is rewritten each quarter at a stable URL."* A sentence **about the
  funder's page**, in GrantSpotter's voice, printed as the funder's text. Its own next clause,
  "Selection timing, in ARISS's words:", concedes that what precedes it is not.
- **`ieee-mtts-chapter-support`** — *"In addition to the chapter activity support above, MTT-S
  offers…"*. "In addition to … above" is a cross-reference to another part of **our** record. No
  funder's page can contain a reference to a GrantSpotter layout.
- **`ardc-grants`** — a paragraph of ARDC guidance about proposal scope and roadmaps that reads as
  genuine ARDC copy but appears nowhere in the page this record is keyed to. Most likely real text
  from a *different* ARDC page. That is a provenance failure rather than an invention, and it is
  indistinguishable from one here — which is the point. Under a heading that says "reproduced
  exactly", unverifiable and false cost the reader the same thing.

They are listed in `NOT_VERBATIM` in that test rather than deleted, because **inventing a
replacement sentence for a funder is the defect itself**, and it needs somebody who can read the
three funders' pages. The rule fails if a fourth appears or a listed one is fixed without being
removed from the register.

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

**Covered on the institution axis, both corpora.** `sentence-vs-spec.test.ts` **W12** probes every
credential rung against every institution sentence and requires that no rung the sentence leaves
unsettled is ever refused. Its mutation proof replays the round-nine state and goes red on all 40
refusals it produced.

**Not covered on the other twelve axes.** W12 reads `institution` and nothing else. That is **130
of the 696 seed constraints — 19%. The other 566 have no false-refusal rule at all.** A geography,
citizenship, age/stage, licence, GPA, field-of-study, activity, membership, recommendation,
financial-need, gender or `other` constraint that refuses somebody its own sentence admits will not
be caught by anything in this repository. **This is the single largest hole in this document**, and
the shape to copy is already written.

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

| direction | rule | what it asks |
| --- | --- | --- |
| spec too WIDE (false include) | W1–W9, W10, W11 | does the spec admit a value / pass an applicant the sentence never named? |
| spec too NARROW (false exclude) | **W12** | does the spec refuse an applicant the sentence admits? |

Before W12 every rule in `sentence-vs-spec.test.ts` measured the same direction. A change whose
entire content was 1,456 new refusals passed the file green — and *raised* W10's coverage figure by
24, which was written into the commit message as evidence the fix was working.

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

## What is still unguarded

Be specific here or the section is worthless. These are holes, today, with nothing standing in
them.

1. **W12 covers 130 of 696 seed constraints.** See shape 3. Extending it is the highest-value next
   piece of work in this file.

2. **Three live `rawOtherText` records are registered, not repaired.** See shape 1. This needs
   somebody who can read the ARISS, IEEE MTT-S and ARDC pages.

3. **Only two prose fields on the record page have any provenance rule at all.**
   `constraints[].rawText` and `rawOtherText` are checked against the funder's capture. `summary`,
   `fundingRestrictions[]`, `obligations`, `deadline.note`, `amount.amountRaw` and
   `amount.awardCountRaw` are **not** — every one of them is displayed, and every one is curator
   text on the seed corpus. They do not sit under a "verbatim" heading, which is the only reason
   this is a lower-grade hole than shape 1 rather than the same one.

4. **Ten institution constraints are checked by nothing.** `sentence-vs-spec.test.ts`'s `typeOnly`
   bucket. Eight say only "4-year college or university" — no accreditation clause, no enrolment
   clause — so there is no statement about the *applicant* the schema can test, and W10 builds no
   probe. Counting them is honest; it is not coverage.

5. **The schema has no field for the school's tier.** `StudentProfile.degreeLevel` is the credential
   the applicant is pursuing; `institution` is free text no axis reads. So "must attend a 4-year
   college or university" can never be answered, only quoted back. Adding such a field would convert
   ~34 `unknown`s into real verdicts — and would be the single most dangerous change anyone could
   make to this codebase, because it invites exactly the conflation that produced the 1,456. If you
   add it, extend W12 in the same commit.

6. **Nothing measures verdict movement automatically.** Every "measured both directions" figure in
   this repository's commit messages was produced by hand, with a throwaway script over
   `scripts/profile-corpus.ts`'s loader. There is no committed harness and no committed baseline, so
   the next author has to rebuild the instrument before they can check themselves. **Rebuild it
   anyway.** The recipe: census `matchProgram` over every profile × credential rung × state ×
   publishable programme, before and after, and diff the pairs. Anything other than
   `ineligible -> unknown` in bulk deserves a paragraph in the commit message.

7. **A parse pinned by a value is a parse, not a rule.** `spec-vs-sentence.test.ts` protects one
   geography record with `toHaveLength(10)`. That guards one record and teaches nothing.

8. **The corpus is ~150 records from a handful of sources.** Every count in every test is a fact
   about *these* records. A rule that is silent today may be silent because the shape it catches is
   not in the corpus yet, not because the product handles it.

9. **A record that is wrong on a deployment can only be corrected where nobody has touched it.**
   `seed/corrections.ts` rewrites a shipped value at boot only when the stored bytes hash to
   something in `data/seed/shipped-values.tsv`, which proves we wrote them. Three consequences, all
   of them live:

   - a record an operator has **edited** keeps their text, correction or no correction. That is the
     right default — it is their instance — but a fixed defect can survive on a deployment
     indefinitely, and the only thing that tells them so is a boot line and an `audit_log` row.
   - a correction that **deletes** something is never applied. The three invented eligibility
     constraints round two removed (`club-grant-affiliated`, `sga-rso`, `mtts-field`) are still on
     every instance that had them, being reasoned over by the matcher, until an operator acts. The
     alternative — deleting a hard constraint on somebody else's database at boot, silently changing
     who is told they are eligible — is worse, but "reported" is not "fixed".
   - `constraints` is in the reconcile's `WITNESSED_ONLY_PATHS`. **A `docker compose pull` does not
     repair a corrected constraint sentence**; it reports it. Every fix to a funder quotation is a
     fix to the *next* install and a notification to the existing ones.
   - a database seeded by a release **older than the ledger's oldest recorded revision** cannot be
     corrected at all: nothing proves what it holds is ours. The ledger reaches back to the first
     commit of `data/seed`, so this is theoretical today and stops being theoretical the moment
     somebody prunes the file.

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

The lesson is not "check `rawOtherText`" — that is now done. It is: **every place the UI promises
somebody else's words is a place this defect will appear, and the list of such places is not
written down anywhere but here.** Before adding a panel that quotes a source, add the rule that
proves it quotes.

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
