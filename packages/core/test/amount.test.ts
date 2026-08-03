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
