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
