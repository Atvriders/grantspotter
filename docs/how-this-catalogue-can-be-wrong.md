# How this catalogue can be wrong

Read this before changing an extractor in `packages/server/src/normalize/axes/` or a rule in
`packages/core/src/matcher.ts`.

This is not a changelog. It is the list of ways GrantSpotter has actually told students something
untrue, which guard now stops each one, and — the useful half — **which ones nothing stops.**

The one fact that organises all of it:

> **Every defect below was invisible to a green test suite at the moment it shipped.** Nine
> consecutive rounds of hardening found nine of them, and each was found by *running the product
> over the corpus and reading the output*, never by a suite going red. A green suite is evidence
> that the defects we have already met have not come back. It is not evidence about this one.

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

## The failure shapes, and what covers each

### 1. Fabricated funder quotations

A value published as the funder's words that the funder did not write.

**Covered.** `normalize/axes/unadjudicable.test.ts` asserts every `orUnrepresented` route appears
*verbatim as a substring* of its own constraint's `rawText`, over the whole corpus (90 routes
today). `sentence-vs-spec.test.ts` W1–W9 assert the same property for every allow-list.

### 2. A gate that refuses everybody over an empty list

An empty allow-list read as "nothing is permitted" rather than "the funder said nothing".

**Covered.** `matcher.ts` treats an empty list as silence; `sentence-vs-spec.test.ts` W10 asserts
that a constraint which refuses *everybody it can build an applicant for* is a defect, with an
empty-equality offender list that names the record in the diff.

### 3. A programme refusing an applicant its own quoted sentence admits

Six programmes did this at once, on the geography axis, when a cascade's last rung was discarded.

**Covered, on the institution axis only.** `sentence-vs-spec.test.ts` **W12** is the rule, and it
is one round old. It probes every credential rung against every institution sentence and requires
that no rung the sentence leaves unsettled is ever refused. Its mutation proof replays the
round-nine state and goes red on all 40 refusals it produced.

**Not covered on the other eight axes.** W12 reads `institution` and nothing else. A geography,
citizenship, age/stage, licence, GPA, field-of-study, activity or membership constraint that
refuses somebody its own sentence admits will not be caught by any rule in this repository. That
is the single largest hole listed here.

### 4. A render crash that ate unsaved work

**Covered.** e2e, plus error boundaries. Not a data problem; it is here because it was invisible
to unit tests for the same reason as the rest.

### 5. A refusal that promised 1 second for a 15-minute lockout

Copy that contradicted the mechanism behind it.

**Partly covered.** e2e asserts the message against the real server. Nothing generally checks that
user-facing copy matches the rule it describes.

### 6. Two overshoots in opposite directions

**Covered as of round ten**, and this is the pairing that matters more than either rule alone:

| direction | rule | what it asks |
| --- | --- | --- |
| spec too WIDE (false include) | W1–W9, W10, W11 | does the spec admit a value / pass an applicant the sentence never named? |
| spec too NARROW (false exclude) | **W12** | does the spec refuse an applicant the sentence admits? |

Before W12 every rule in `sentence-vs-spec.test.ts` measured the same direction. A change whose
entire content was 1,456 new refusals passed the file green — and *raised* W10's coverage figure by
24, which was written into the commit message as evidence the fix was working.

---

## What is still unguarded

Be specific here or the section is worthless. These are holes, today, with nothing standing in
them.

1. **W12 covers one axis of nine.** See shape 3 above. A false refusal on `geography`,
   `citizenship`, `age_stage`, `license`, `gpa`, `field_of_study`, `ham_activity` or
   `arrl_membership` has no rule. Extending W12 is the highest-value next piece of work in this
   file, and the shape to copy is already written.

2. **Ten institution constraints are checked by nothing.** `sentence-vs-spec.test.ts`'s
   `typeOnly` bucket. Eight of them say only "4-year college or university" — no accreditation
   clause, no enrolment clause — so there is no statement about the *applicant* the schema can
   test, and W10 builds no probe at all. Counting them is honest; it is not coverage.

3. **The schema has no field for the school's tier.** `StudentProfile.degreeLevel` is the
   credential the applicant is pursuing; `institution` is free text no axis reads. So "must attend
   a 4-year college or university" can never be answered, only quoted back. Adding such a field
   would convert ~34 `unknown`s into real verdicts — and would be the single most dangerous change
   anyone could make to this codebase, because it invites exactly the conflation that produced the
   1,456. If you add it, extend W12 in the same commit.

4. **Nothing measures verdict movement automatically.** Every "measured both directions" figure in
   this repository's commit messages was produced by hand, with a throwaway script over
   `scripts/profile-corpus.ts`'s loader. There is no committed harness and no committed baseline,
   so the next author has to rebuild the instrument before they can check themselves. **Rebuild it
   anyway.** The recipe: census `matchProgram` over every profile × credential rung × state ×
   publishable programme, before and after, and diff the pairs. Anything other than
   `ineligible -> unknown` in bulk deserves a paragraph in the commit message.

5. **A parse pinned by a value is a parse, not a rule.** `spec-vs-sentence.test.ts` protects one
   geography record with `toHaveLength(10)`. That guards one record and teaches nothing.

6. **The corpus is ~150 publishable records from a handful of sources.** Every count in every test
   is a fact about *these fixtures*. A rule that is silent today may be silent because the shape it
   catches is not in the corpus yet, not because the product handles it.

7. **A record that is wrong on a deployment can only be corrected where nobody has touched it.**
   `seed/corrections.ts` rewrites a shipped value at boot only when the stored bytes hash to
   something in `data/seed/shipped-values.tsv`, which proves we wrote them. Three consequences,
   all of them live:

   - a record an operator has **edited** keeps their text, correction or no correction. That is
     the right default — it is their instance — but it means a fixed defect can survive on a
     deployment indefinitely, and the only thing that tells them so is a boot line and an
     `audit_log` row.
   - a correction that **deletes** something is never applied. The three invented eligibility
     constraints round two removed (`club-grant-affiliated`, `sga-rso`, `mtts-field`) are still
     on every instance that had them, being reasoned over by the matcher, and will be until an
     operator acts. The alternative — deleting a hard constraint on somebody else's database at
     boot, silently changing who is told they are eligible — is worse, but "reported" is not
     "fixed".
   - a database seeded by a release **older than the ledger's oldest recorded revision** cannot be
     corrected at all: nothing proves what it holds is ours. The ledger currently reaches back to
     the first commit of `data/seed`, so this is theoretical today and stops being theoretical the
     moment somebody prunes the file.

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
applicant, and the schema usually has a field for only one of them.** The same file already
declines this inference in the geography direction — "Accredited 4-year college or university in
NC, VA, WV, MD or TN" names where the *school* is, and `state` is where the *applicant* lives, so
it is not read as a residence bar. When one rule in this repository declines an inference, go and
make the mirrored rule answer for its own.

## The habit that would have prevented all of it

Before committing a change to a verdict:

1. Run the corpus census **both ways** and report both numbers, even when one is zero.
2. Say which direction the change moves and which direction it *came from*, and re-check the
   second one explicitly.
3. Prefer `unknown` to any verdict the funder's sentence does not settle.
4. When you delete a rule's exemption or allowlist, delete the comment that justified it in the
   same edit. A doctrine that outlives its evidence is how this project reintroduced the same
   defect family nine times.
