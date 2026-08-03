import { describe, expect, it } from 'vitest';
import { parseAmount } from '../src/amount.js';

describe('parseAmount', () => {
  it('parses a single fixed amount', () => {
    expect(parseAmount('$1,000')).toEqual({ amountMin: 1000, amountMax: 1000 });
    expect(parseAmount('$500, 1 per year')).toEqual({ amountMin: 500, amountMax: 500 });
  });

  it('parses ranges with hyphens, en dashes and the word "to"', () => {
    expect(parseAmount('$500-$5,000')).toEqual({ amountMin: 500, amountMax: 5000 });
    expect(parseAmount('$1,000–$25,000')).toEqual({ amountMin: 1000, amountMax: 25000 });
    expect(parseAmount('Awards range from $1,000 to $25,000.')).toEqual({
      amountMin: 1000,
      amountMax: 25000,
    });
  });

  // ARDC's block of 45 scholarships, the largest single entry in the ARRL catalogue.
  it('parses tiered blocks', () => {
    expect(
      parseAmount('20 awards of $25,000, 4 of $15,000, 17 of $10,000, 4 of $5,000'),
    ).toEqual({
      amountMin: 5000,
      amountMax: 25000,
      tiers: [
        { count: 20, amount: 25000 },
        { count: 4, amount: 15000 },
        { count: 17, amount: 10000 },
        { count: 4, amount: 5000 },
      ],
    });
  });

  // THE TRAP. A naive max-regex answers 100000 for all three of these.
  it('ignores endowment figures across sentences', () => {
    expect(
      parseAmount(
        'The fund was established with a $100,000 endowment from the estate of Dr. Jane Doe, W1ABC. One award of $1,000 is made annually.',
      ),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('ignores endowment figures inside a single sentence', () => {
    expect(parseAmount('A $100,000 endowment supports one award of $1,000 per year.')).toEqual({
      amountMin: 1000,
      amountMax: 1000,
    });
  });

  it('rescues an award figure that shares a sentence with an endowment figure', () => {
    expect(parseAmount('A $100,000 endowment funds awards of $2,500.')).toEqual({
      amountMin: 2500,
      amountMax: 2500,
    });
  });

  it('returns nothing when the only figure is an endowment', () => {
    expect(parseAmount('Funded by a $100,000 endowment.')).toEqual({});
  });

  // QCWA: "$3,000 each; 624+ students and $930,350+ since 1978".
  it('ignores lifetime and cumulative totals', () => {
    expect(parseAmount('Awards of $1,000 each; the program has awarded $930,350 since 1978.')).toEqual(
      { amountMin: 1000, amountMax: 1000 },
    );
    expect(parseAmount('$3,000 each; 15 awards in 2024 totaling $57,000.')).toEqual({
      amountMin: 3000,
      amountMax: 3000,
    });
  });

  it('spans several discrete awards', () => {
    expect(parseAmount('$2,500 / $2,500 / $1,500')).toEqual({ amountMin: 1500, amountMax: 2500 });
    expect(parseAmount('$1,450 (DR-2X) / $1,860 (with LAN-01A)')).toEqual({
      amountMin: 1450,
      amountMax: 1860,
    });
  });

  // ARRL Amateur Radio Grants: "generally do not exceed $3,000", "up to $5,000 in 2026".
  it('records a ceiling with no floor when every figure is capped', () => {
    expect(parseAmount('up to $5,000')).toEqual({ amountMax: 5000 });
    expect(parseAmount('Grants generally do not exceed $3,000; up to $5,000 in 2026.')).toEqual({
      amountMax: 5000,
    });
    expect(parseAmount('≤$200 typical, or more with committee approval')).toEqual({
      amountMax: 200,
    });
  });

  it('records a floor with no ceiling when every figure is a minimum', () => {
    expect(parseAmount('at least $500')).toEqual({ amountMin: 500 });
  });

  // Grants.gov returns the literal string "none" for awardCeiling/awardFloor.
  it('returns an empty object when there is no money in the text', () => {
    expect(parseAmount('none')).toEqual({});
    expect(parseAmount('Unpublished')).toEqual({});
    expect(parseAmount('')).toEqual({});
    expect(parseAmount('In-kind equipment only')).toEqual({});
  });
});

// Fix round 1 (2026-08-03): an adversarial probe past the fixtures found three
// Important findings in the brief's own algorithm. The project owner ruled that
// the findings govern over the brief's literal algorithm, authorizing the
// mechanism to be extended beyond what the brief prescribed. These tests cover
// the exact probe strings quoted in that finding, plus independent adversarial
// cases. All 12 tests above must stay green.
describe('parseAmount — fix round 1 hardening', () => {
  // Finding 1: NON_AWARD_CONTEXT_TERMS did not generalize past fixture phrasing.
  // "seeded with... fund" is the same class of trap as "established with...
  // endowment" but worded differently.
  it('ignores a capital pool described as "seeded with a ... fund" (Finding 1 probe)', () => {
    expect(
      parseAmount(
        'The scholarship was seeded with a $1,000,000 fund. One award of $2,000 is made annually.',
      ),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  // Finding 2: AWARD_ANCHOR only matched pre-figure phrasing ("award of $X"),
  // silently dropping the equally common "$X award" / "gives $X to" shapes and
  // returning {} instead of the real award.
  it('rescues an award figure whose anchor word follows it: "gives $X to ... student" (Finding 2 probe 1)', () => {
    expect(
      parseAmount(
        'A $100,000 endowment supports the program, which gives $1,000 to one student.',
      ),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('rescues an award figure whose anchor word trails it: "$X award" (Finding 2 probe 2)', () => {
    expect(
      parseAmount('The program gives one $1,000 award annually, funded by a $100,000 endowment.'),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('rescues "$X award" against a "corpus of $Y" non-award figure (Finding 2 probe 3)', () => {
    expect(
      parseAmount("The fund's corpus of $500,000 supports a single $2,000 award each year."),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  // Finding 3: the MONEY regex silently discarded magnitude suffixes, turning
  // "$1.5K" into 1 and "$2M" / "$2 million" into 2 — a nonsense amount that is
  // worse than an omission.
  it('scales a "K" suffix instead of truncating it (Finding 3 probe 1)', () => {
    expect(parseAmount('$1.5K')).toEqual({ amountMin: 1500, amountMax: 1500 });
  });

  it('scales an "M" suffix instead of truncating it (Finding 3 probe 2)', () => {
    expect(parseAmount('$2M')).toEqual({ amountMin: 2_000_000, amountMax: 2_000_000 });
  });

  it('scales a spelled-out "million" suffix instead of truncating it (Finding 3 probe 3)', () => {
    expect(parseAmount('$2 million')).toEqual({ amountMin: 2_000_000, amountMax: 2_000_000 });
  });

  // --- Independent adversarial cases beyond the three quoted findings ---

  it('excludes a "principal"/"trust" capital figure with no rescue anchor nearby', () => {
    // Genuine conflict with no anchor to resolve it: prefer omission over a guess.
    expect(parseAmount("The trust's principal of $2M supports the program.")).toEqual({});
  });

  it('combines magnitude scaling with poisoned-sentence exclusion and after-anchor rescue', () => {
    expect(
      parseAmount(
        "The trust's principal of $2M supports one $3,000 scholarship each year.",
      ),
    ).toEqual({ amountMin: 3000, amountMax: 3000 });
  });

  it('rescues "scholarship of $X" (before-anchor) against a bequest figure', () => {
    expect(
      parseAmount('A $60,000 bequest funds a scholarship of $2,200 each year.'),
    ).toEqual({ amountMin: 2200, amountMax: 2200 });
  });

  it('rescues "$X scholarship" (after-anchor) against a bequest figure', () => {
    expect(
      parseAmount('A $60,000 bequest funds a $2,200 scholarship each year.'),
    ).toEqual({ amountMin: 2200, amountMax: 2200 });
  });

  it('rescues "$X grant" (after-anchor) against an endowment figure', () => {
    expect(
      parseAmount('A $75,000 endowment provides one $1,500 grant yearly.'),
    ).toEqual({ amountMin: 1500, amountMax: 1500 });
  });

  it('rescues "$X prize" (after-anchor) against a trust/fund figure', () => {
    expect(
      parseAmount('A $50,000 trust funds a $2,000 prize annually.'),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('poisons a memorial-fund sentence via "in memory of ... fund" and rescues via a before-anchor verb', () => {
    expect(
      parseAmount('In memory of W1XYZ, the fund gives a $1,000 scholarship annually.'),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('scales a "B"/"billion" suffix and combines it with a decimal', () => {
    expect(parseAmount('$3.25B')).toEqual({ amountMin: 3_250_000_000, amountMax: 3_250_000_000 });
  });
});

// Fix round 2 (2026-08-04): the scoped re-review confirmed all three round-1
// findings addressed, but flagged that round-1's own bare poison terms (gift,
// principal, trust, and fund by extension) silently drop an unambiguous award
// when the sentence's only recipient noun isn't literally "student(s)" — the
// same class of bug as the original endowment trap, just pointed the other
// way. These tests cover the three failing strings quoted in that finding,
// plus the coordinator's required fourth case and independent adversarial
// cases in the same shape. All tests above (the 12 original fixtures and the
// 15 round-1 hardening tests) must stay green.
describe('parseAmount — fix round 2 hardening (recipient verbs and nouns)', () => {
  it('rescues a trailing "is made to one recipient" verb-phrase past an intervening poison noun', () => {
    // Regression: pre-round-2 this returned {} because "gift" poisoned the
    // sentence and AWARD_ANCHOR_AFTER only recognized "student(s)".
    expect(
      parseAmount('A $1,000 gift is made to one recipient annually.'),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('rescues via the "receives" before-anchor against a "principal" poison term', () => {
    expect(parseAmount('The Principal Investigator receives $5,000.')).toEqual({
      amountMin: 5000,
      amountMax: 5000,
    });
  });

  it('rescues via the "pays" before-anchor against a "trust" poison term, recipient noun "recipient"', () => {
    expect(parseAmount('The trust pays $1,000 to each recipient.')).toEqual({
      amountMin: 1000,
      amountMax: 1000,
    });
  });

  it('rescues via the "distributes" before-anchor against a "trust" poison term, recipient noun "winner"', () => {
    expect(parseAmount('The trustee distributes $2,000 to each winner.')).toEqual({
      amountMin: 2000,
      amountMax: 2000,
    });
  });

  it('rescues the generalized "to one winner" trailing noun against a bequest figure', () => {
    // Exercises the plain "to <qualifier> <noun>" branch (no verb-phrase, no
    // before-anchor) with the broadened recipient noun list.
    expect(
      parseAmount('A $60,000 bequest funds $2,000 to one winner each year.'),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('rescues the "goes to each member" verb-phrase while the poisoned figure three tokens away stays excluded', () => {
    // The poison figure ($100,000) sits far enough from "goes to each member"
    // that the 1-word filler budget in AWARD_ANCHOR_AFTER cannot reach it —
    // this is the guard against the cross-mention leakage regression noted in
    // the AWARD_ANCHOR_AFTER doc comment.
    expect(
      parseAmount('A $100,000 trust provides that $500 goes to each member annually.'),
    ).toEqual({ amountMin: 500, amountMax: 500 });
  });

  it('does not let a same-sentence award noun three tokens away rescue an endowment figure (round-1 regression guard)', () => {
    // Re-verifies the original round-1 "rescues an award figure that shares a
    // sentence with an endowment figure" fixture still excludes $100,000 even
    // with the wider AWARD_ANCHOR_AFTER vocabulary from this round.
    expect(parseAmount('A $100,000 endowment funds awards of $2,500.')).toEqual({
      amountMin: 2500,
      amountMax: 2500,
    });
  });
});

// Fix round 2: re-verification that every round-1 probe this ruling depends on
// is still correct after the AWARD_ANCHOR / AWARD_ANCHOR_AFTER changes above.
describe('parseAmount — round 1 probes re-verified after round 2', () => {
  it('Finding 1 probe: "seeded with a $1,000,000 fund" still excludes the fund, keeps the award', () => {
    expect(
      parseAmount(
        'The scholarship was seeded with a $1,000,000 fund. One award of $2,000 is made annually.',
      ),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('Finding 2 probe 1: before-anchor "gives $X to one student" still rescues', () => {
    expect(
      parseAmount(
        'A $100,000 endowment supports the program, which gives $1,000 to one student.',
      ),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('Finding 2 probe 2: after-anchor "$X award" still rescues', () => {
    expect(
      parseAmount('The program gives one $1,000 award annually, funded by a $100,000 endowment.'),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('Finding 2 probe 3: after-anchor "$X award" against a "corpus of $Y" figure still rescues', () => {
    expect(
      parseAmount("The fund's corpus of $500,000 supports a single $2,000 award each year."),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('Finding 3 probes: K/M/million magnitude suffixes still scale correctly', () => {
    expect(parseAmount('$1.5K')).toEqual({ amountMin: 1500, amountMax: 1500 });
    expect(parseAmount('$2M')).toEqual({ amountMin: 2_000_000, amountMax: 2_000_000 });
    expect(parseAmount('$2 million')).toEqual({ amountMin: 2_000_000, amountMax: 2_000_000 });
  });
});

// Fix round 3 (2026-08-05): the scoped re-review confirmed round 2's open
// finding addressed and every earlier probe still passing, but found the
// round-2 diff itself introduced two new CRITICAL over-claim regressions.
//
// Bug A: round 2's "(?:\S+\s+)?" filler prefix was applied to the entire
// AWARD_ANCHOR_AFTER alternation, including the bare-noun branch that round 1
// correctly required to match with zero-word adjacency. One filler word could
// hop over a poison noun (even the poison word itself, e.g. "endowment") and
// match an anchor word that actually belongs to a different, later mention —
// reopening the endowment trap.
//
// Bug B: `receives` as a before-anchor verb is symmetric — "the endowment
// receives $500,000" and "the Investigator receives $5,000" put the
// capital-pool noun and the recipient noun in the identical grammatical slot,
// so a bare verb-list membership check can't tell them apart.
describe('parseAmount — fix round 3 hardening (scoped filler + receives subject check)', () => {
  it('Bug A probe 1: a same-sentence "award of" anchor for a later mention no longer rescues the earlier trust figure', () => {
    expect(
      parseAmount('A $100,000 trust award of $2,500 is made annually.'),
    ).toEqual({ amountMin: 2500, amountMax: 2500 });
  });

  it('Bug A probe 2: a same-sentence "scholarship of" anchor for a later mention no longer rescues the earlier gift figure', () => {
    expect(
      parseAmount('A $50,000 gift scholarship of $2,000 is made annually.'),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('Bug A probe 3: a same-sentence "grant of" anchor for a later mention no longer rescues the earlier fund figure', () => {
    expect(
      parseAmount('A $50,000 fund grant of $2,000 is made annually.'),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('Bug A probe 4: a same-sentence "award of" anchor for a later mention no longer rescues the earlier endowment figure', () => {
    expect(
      parseAmount('A $100,000 endowment award of $2,500 is made annually.'),
    ).toEqual({ amountMin: 2500, amountMax: 2500 });
  });

  it('Bug A regression-guard, one-word variant: deleting "funds" from the round-2 guard fixture must not reopen the trap', () => {
    // The round-2 guard ("...endowment funds awards of $2,500.") needed two
    // filler words to reach "awards" and so accidentally passed even with the
    // Bug A defect present. This one-word variant is the real boundary case.
    expect(parseAmount('A $100,000 endowment awards of $2,500.')).toEqual({
      amountMin: 2500,
      amountMax: 2500,
    });
  });

  it('Bug B probe 1: "the endowment receives" does not rescue, but a clean second-sentence award still counts', () => {
    expect(
      parseAmount(
        'The endowment receives $500,000 in gifts each year. One award of $1,000 is made.',
      ),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('Bug B probe 2: "the endowment receives $N" alone returns nothing', () => {
    expect(parseAmount('The endowment receives $500,000 in gifts each year.')).toEqual({});
  });

  it('Bug B probe 3: "the fund receives $N" returns nothing', () => {
    expect(parseAmount('The fund receives $250,000 in donations annually.')).toEqual({});
  });

  it('Bug B probe 4: "the trust receives $N" returns nothing', () => {
    expect(parseAmount('The trust receives $500,000 from the estate.')).toEqual({});
  });

  // --- Independent adversarial cases beyond the eight quoted probes ---

  it('a same-sentence "goes to each winner" anchor several tokens away does not rescue the poisoned figure, but still rescues its real target', () => {
    expect(
      parseAmount(
        "A $50,000 endowment principal remains untouched, while $2,000 goes to each winner.",
      ),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('"receives" still rescues normally when the subject is a person, not a capital pool, even with an unrelated poison term in the sentence', () => {
    expect(
      parseAmount("The scholar receives $2,000 each year from the fund's earnings."),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('Bug A pattern with a third bare-noun word ("prize") and a different poison term ("corpus") stays excluded on the poisoned figure', () => {
    expect(
      parseAmount('A $75,000 corpus prize of $1,000 is given each year.'),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });
});

// Fix round 3: re-verification that every prior round's load-bearing probe is
// still correct after the AWARD_ANCHOR / AWARD_ANCHOR_AFTER / receivesRescue
// changes above.
describe('parseAmount — rounds 1 and 2 probes re-verified after round 3', () => {
  it('round 1 Finding 1: "seeded with a $1,000,000 fund" still excludes the fund, keeps the award', () => {
    expect(
      parseAmount(
        'The scholarship was seeded with a $1,000,000 fund. One award of $2,000 is made annually.',
      ),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('round 1 Finding 2 probe 1: before-anchor "gives $X to one student" still rescues', () => {
    expect(
      parseAmount(
        'A $100,000 endowment supports the program, which gives $1,000 to one student.',
      ),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('round 1 Finding 2 probe 2: after-anchor "$X award" still rescues', () => {
    expect(
      parseAmount('The program gives one $1,000 award annually, funded by a $100,000 endowment.'),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('round 1 Finding 2 probe 3: after-anchor "$X award" against a "corpus of $Y" figure still rescues', () => {
    expect(
      parseAmount("The fund's corpus of $500,000 supports a single $2,000 award each year."),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('round 1 Finding 3 probes: K/M/million magnitude suffixes still scale correctly', () => {
    expect(parseAmount('$1.5K')).toEqual({ amountMin: 1500, amountMax: 1500 });
    expect(parseAmount('$2M')).toEqual({ amountMin: 2_000_000, amountMax: 2_000_000 });
    expect(parseAmount('$2 million')).toEqual({ amountMin: 2_000_000, amountMax: 2_000_000 });
  });

  it('round 2 probe 1: "gift is made to one recipient" still rescues past an intervening poison noun', () => {
    expect(
      parseAmount('A $1,000 gift is made to one recipient annually.'),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('round 2 probe 2: "Principal Investigator receives $X" still rescues (subject is Investigator, not a capital-pool noun)', () => {
    expect(parseAmount('The Principal Investigator receives $5,000.')).toEqual({
      amountMin: 5000,
      amountMax: 5000,
    });
  });

  it('round 2 probe 3: "the trust pays $X to each recipient" still rescues via the pays before-anchor', () => {
    expect(parseAmount('The trust pays $1,000 to each recipient.')).toEqual({
      amountMin: 1000,
      amountMax: 1000,
    });
  });
});

// Fix round 4 (2026-08-06): rounds 1-3 each closed their finding and reopened
// the identical hole in an adjacent branch, because a character window plus an
// n-word filler budget cannot tell WHICH mention an anchor phrase belongs to.
// The classifier was restructured around noun-phrase attachment resolved on
// tokens (see the header comment in amount.ts): every mention is classified by
// its own governing noun phrase, and only when that does not answer the
// question does a predicate — and then clause context — get consulted.
//
// The invariant these tests exist to police: a noun-phrase attachment BINDS.
// Once "$50,000 trust" resolves as capital, nothing anywhere else in the clause
// can rescue it. These test the SHAPE, not the string: word-order swaps,
// multi-word subjects, and cross-mention gaps at 0, 1 and 2 words.
describe('parseAmount — fix round 4 restructure (noun-phrase attachment)', () => {
  // --- The four remaining over-claim leaks: the one-word filler was removed
  // only from the bare-noun branch; the verb-phrase and to-phrase branches
  // still carried it, so a capital figure could borrow a later mention's
  // recipient phrase.
  it('leak 1: a trailing "is made to one recipient" cannot rescue a "$N trust" (was {50000,50000})', () => {
    expect(
      parseAmount('A $50,000 trust is made to one recipient of $1,000 annually.'),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('leak 2: a trailing "goes to one recipient" cannot rescue a "$N fund" (was {1000,50000})', () => {
    expect(
      parseAmount(
        'A $50,000 fund goes to one recipient; a separate $1,000 prize is issued each term.',
      ),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('leak 3: a trailing "to one recipient" cannot rescue a "$N trust" (was {1000,50000})', () => {
    expect(
      parseAmount('A $50,000 trust to one recipient near a $1,000 stipend awarded elsewhere.'),
    ).toEqual({ amountMin: 1000, amountMax: 1000 });
  });

  it('leak 4: a trailing "to each winner" cannot rescue a "$N endowment", and a "prize fund total" is not an award either (was {2000,75000})', () => {
    // Both figures are capital: $75,000 is the endowment, $2,000 is a pool
    // total. Omission is the correct answer — over-claiming is worse.
    expect(
      parseAmount('A $75,000 endowment to each winner, separate from the $2,000 prize fund total.'),
    ).toEqual({});
  });

  // --- The two `receivesRescue` over-claims: a single-token lookback is not a
  // subject. Both of these have a HUMAN subject; neither subject is a payee.
  it('receives probe 1: multi-word subject "the fund\'s board of trustees" is not a payee (was {500000,500000})', () => {
    expect(parseAmount("The fund's board of trustees receives $500,000 in gifts each year.")).toEqual(
      {},
    );
  });

  it('receives probe 2: multi-word subject "the committee of trustees" is not a payee (was {500000,500000})', () => {
    expect(parseAmount('The committee of trustees receives $500,000 in annual contributions.')).toEqual(
      {},
    );
  });

  // --- Shape: word-order swaps. The attachment rule is order-independent, so
  // the same two figures classify the same way whichever comes first.
  it('shape — word order: award figure first, capital figure second', () => {
    expect(parseAmount('A $1,000 award is funded by a $50,000 endowment.')).toEqual({
      amountMin: 1000,
      amountMax: 1000,
    });
  });

  it('shape — word order: a "<person> of $N" left attachment ahead of a capital noun', () => {
    expect(parseAmount('One recipient of $1,000 is chosen from a $50,000 trust.')).toEqual({
      amountMin: 1000,
      amountMax: 1000,
    });
  });

  it('shape — word order: both figures coordinated in one clause', () => {
    expect(parseAmount('The $50,000 endowment and the $1,000 award are separate.')).toEqual({
      amountMin: 1000,
      amountMax: 1000,
    });
  });

  // --- Shape: cross-mention gaps at 0, 1 and 2 words. Rounds 1-3 each passed
  // their literal probe and failed one word away; the gap must not matter.
  it('shape — 0-word gap: "$N trust award of $M" excludes the trust figure', () => {
    expect(parseAmount('A $50,000 trust award of $2,000 is made annually.')).toEqual({
      amountMin: 2000,
      amountMax: 2000,
    });
  });

  it('shape — 1-word gap: "$N trust annual award of $M" excludes the trust figure', () => {
    expect(parseAmount('A $50,000 trust annual award of $2,000 is made.')).toEqual({
      amountMin: 2000,
      amountMax: 2000,
    });
  });

  it('shape — 2-word gap: "$N trust makes an annual award of $M" excludes the trust figure', () => {
    expect(parseAmount('A $50,000 trust makes an annual award of $2,000.')).toEqual({
      amountMin: 2000,
      amountMax: 2000,
    });
  });

  it('shape — 4-noun compound: "$N endowment prize fund award of $M" excludes the endowment figure', () => {
    expect(parseAmount('A $50,000 endowment prize fund award of $2,000 is made.')).toEqual({
      amountMin: 2000,
      amountMax: 2000,
    });
  });

  it('shape — separated mentions: a bare "$M award" later in the clause does not pull the trust figure in', () => {
    expect(parseAmount('A $50,000 trust supports the $2,000 award.')).toEqual({
      amountMin: 2000,
      amountMax: 2000,
    });
  });

  it('shape — across a clause boundary: "$N trust; the $M award is annual"', () => {
    expect(parseAmount('A $50,000 trust; the $2,000 award is annual.')).toEqual({
      amountMin: 2000,
      amountMax: 2000,
    });
  });

  // --- Shape: multi-word subjects of an inflow verb. The head noun of the
  // subject decides, and administrators are not payees.
  it('shape — subject head: "the board of directors of the trust" is an administrator, not a payee', () => {
    expect(parseAmount('The board of directors of the trust receives $250,000 annually.')).toEqual({});
  });

  it('shape — subject head: "the scholarship committee" is an administrator despite the award word in it', () => {
    expect(parseAmount('The scholarship committee receives $10,000 in donations.')).toEqual({});
  });

  it('shape — subject head: "the endowment\'s trustees" is an administrator', () => {
    expect(parseAmount("The endowment's trustees receive $500,000 in gifts.")).toEqual({});
  });

  it('shape — subject head: "the treasurer of the club" is an administrator', () => {
    expect(parseAmount('The treasurer of the club receives $25,000 in dues.')).toEqual({});
  });

  it('shape — subject head: a bare recipient noun IS a payee', () => {
    expect(parseAmount('Each winner receives $2,500.')).toEqual({
      amountMin: 2500,
      amountMax: 2500,
    });
  });

  it('shape — subject head: a postmodifying "of" phrase does not move the head off a payee', () => {
    expect(parseAmount('The winner of the essay contest receives $1,000.')).toEqual({
      amountMin: 1000,
      amountMax: 1000,
    });
  });

  // --- Shape: the genuinely ambiguous nouns defer to the predicate, and omit
  // when the predicate does not settle it.
  it('shape — ambiguous "gift" with an outflow predicate to a payee is an award', () => {
    expect(parseAmount('A $1,000 gift goes to each winner.')).toEqual({
      amountMin: 1000,
      amountMax: 1000,
    });
  });

  it('shape — ambiguous "gift" with no outflow predicate and capital context is omitted', () => {
    expect(parseAmount('A $100,000 gift from the estate of W1ABC supports the program.')).toEqual({});
  });

  it('shape — a compound containing a capital noun is capital whatever its head is', () => {
    expect(parseAmount('The $2,000 prize fund is divided among winners.')).toEqual({});
  });

  // --- Shape: tier assembly still runs underneath a poisoned capital figure.
  it('shape — the ARDC tier block still assembles when it sits under a $1,000,000 endowment', () => {
    expect(
      parseAmount(
        'A $1,000,000 endowment funds 20 awards of $25,000, 4 of $15,000, 17 of $10,000, 4 of $5,000.',
      ),
    ).toEqual({
      amountMin: 5000,
      amountMax: 25000,
      tiers: [
        { count: 20, amount: 25000 },
        { count: 4, amount: 15000 },
        { count: 17, amount: 10000 },
        { count: 4, amount: 5000 },
      ],
    });
  });

  // --- Shape: cumulative markers still beat everything else in their clause.
  it('shape — a cumulative clause is excluded even when the award clause is clean', () => {
    expect(parseAmount('Awards of $1,000 each; $2,000,000 has been raised to date.')).toEqual({
      amountMin: 1000,
      amountMax: 1000,
    });
  });

  it('shape — "the fund has awarded $N since 19xx" is a lifetime total, not an award', () => {
    expect(parseAmount('$3,000 each; the fund has awarded $930,350 since 1978.')).toEqual({
      amountMin: 3000,
      amountMax: 3000,
    });
  });
});

// Fix round 4: the explicitly required re-verification set. These are the
// load-bearing probes from every prior round, re-run verbatim against the
// restructured classifier.
describe('parseAmount — rounds 1-3 probes re-verified after round 4', () => {
  it('cross-sentence capital pool: "seeded with a $1,000,000 fund"', () => {
    expect(
      parseAmount(
        'The scholarship was seeded with a $1,000,000 fund. One award of $2,000 is made annually.',
      ),
    ).toEqual({ amountMin: 2000, amountMax: 2000 });
  });

  it('same-sentence capital pool: "A $100,000 endowment award of $2,500"', () => {
    expect(parseAmount('A $100,000 endowment award of $2,500 is made annually.')).toEqual({
      amountMin: 2500,
      amountMax: 2500,
    });
  });

  it('inflow to a capital pool: "The endowment receives $500,000 in gifts each year."', () => {
    expect(parseAmount('The endowment receives $500,000 in gifts each year.')).toEqual({});
  });

  it('inflow to a person: "The Principal Investigator receives $5,000."', () => {
    expect(parseAmount('The Principal Investigator receives $5,000.')).toEqual({
      amountMin: 5000,
      amountMax: 5000,
    });
  });

  it('ambiguous noun settled by an outflow predicate: "A $1,000 gift is made to one recipient annually."', () => {
    expect(parseAmount('A $1,000 gift is made to one recipient annually.')).toEqual({
      amountMin: 1000,
      amountMax: 1000,
    });
  });

  it('magnitude suffixes: $1.5K / $2M / $2 million', () => {
    expect(parseAmount('$1.5K')).toEqual({ amountMin: 1500, amountMax: 1500 });
    expect(parseAmount('$2M')).toEqual({ amountMin: 2_000_000, amountMax: 2_000_000 });
    expect(parseAmount('$2 million')).toEqual({ amountMin: 2_000_000, amountMax: 2_000_000 });
  });

  it("ARDC's tier string still yields 4 tiers and 45 awards", () => {
    const parsed = parseAmount('20 awards of $25,000, 4 of $15,000, 17 of $10,000, 4 of $5,000');
    expect(parsed).toEqual({
      amountMin: 5000,
      amountMax: 25000,
      tiers: [
        { count: 20, amount: 25000 },
        { count: 4, amount: 15000 },
        { count: 17, amount: 10000 },
        { count: 4, amount: 5000 },
      ],
    });
    expect(parsed.tiers?.reduce((n, t) => n + t.count, 0)).toBe(45);
  });
});
