import type { AmountSpec, AwardTier } from './types.js';

/**
 * Vocabulary that marks a dollar figure as something OTHER than an award.
 * Two groups: endowment/gift vocabulary, and cumulative-total vocabulary.
 * Grounded in real ARRL catalogue and QCWA text — see the tests.
 */
export const NON_AWARD_CONTEXT_TERMS: readonly string[] = [
  // endowment / gift
  'endowment',
  'endowed',
  'endowing',
  'bequest',
  'bequeathed',
  'estate of',
  'corpus',
  'fund was established',
  'was established with',
  'established with',
  'gift of',
  'donated',
  'donation of',
  'contributed',
  'memorial fund of',
  // cumulative totals
  'total assets',
  'has awarded',
  'have awarded',
  'awarded since',
  'distributed since',
  'since 19',
  'since 20',
  'to date',
  'cumulative',
  'in total',
  'raised',
  'totaling',
  'totalling',
  'in awards',
];

/**
 * Rescues a per-award figure that shares a sentence with an endowment figure:
 * "A $100,000 endowment funds awards of $2,500."
 */
export const AWARD_ANCHOR =
  /\b(awards?|scholarships?|grants?|prizes?|stipends?)\s+(?:of|:)?\s*$/i;

const MONEY = /\$\s?([0-9][0-9,]*(?:\.[0-9]{2})?)/g;
const TIER_RE = /([0-9]+)\s+(?:awards?\s+)?of\s+\$\s?([0-9][0-9,]*)/gi;
const RANGE_RE = /\$\s?([0-9][0-9,]*)\s*(?:-|–|—|to|through)\s*\$?\s?([0-9][0-9,]*)/i;
const UP_TO =
  /(?:\b(?:up to|not to exceed|does not exceed|do not exceed|no more than|maximum of|maximum|max|under)|≤|<=)\s*$/i;
const AT_LEAST = /(?:\b(?:at least|minimum of|starting at)|≥|>=)\s*$/i;

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

interface Mention {
  value: number;
  isAward: boolean;
  sentence: string;
  offsetInSentence: number;
}

function splitSentences(raw: string): Array<{ text: string }> {
  const out: Array<{ text: string }> = [];
  const re = /(?<=[.;])\s+|\n+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out.push({ text: raw.slice(start, m.index) });
    start = re.lastIndex;
  }
  out.push({ text: raw.slice(start) });
  return out;
}

function collectMentions(raw: string): Mention[] {
  const mentions: Mention[] = [];
  for (const { text } of splitSentences(raw)) {
    const lower = text.toLowerCase();
    const sentenceIsNonAward = NON_AWARD_CONTEXT_TERMS.some((t) => lower.includes(t));
    MONEY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MONEY.exec(text)) !== null) {
      const before = text.slice(Math.max(0, m.index - 25), m.index);
      mentions.push({
        value: toNumber(m[1]),
        isAward: !sentenceIsNonAward || AWARD_ANCHOR.test(before),
        sentence: text,
        offsetInSentence: m.index,
      });
    }
  }
  return mentions;
}

export function parseAmount(raw: string): Pick<AmountSpec, 'amountMin' | 'amountMax' | 'tiers'> {
  const awardMentions = collectMentions(raw).filter((m) => m.isAward);
  if (awardMentions.length === 0) return {};

  TIER_RE.lastIndex = 0;
  const tiers: AwardTier[] = [];
  let t: RegExpExecArray | null;
  while ((t = TIER_RE.exec(raw)) !== null) {
    const amount = toNumber(t[2]);
    if (awardMentions.some((m) => m.value === amount)) {
      tiers.push({ count: Number(t[1]), amount });
    }
  }
  if (tiers.length >= 2) {
    const amounts = tiers.map((x) => x.amount);
    return { amountMin: Math.min(...amounts), amountMax: Math.max(...amounts), tiers };
  }

  const range = RANGE_RE.exec(raw);
  if (range) {
    const a = toNumber(range[1]);
    const b = toNumber(range[2]);
    if (awardMentions.some((m) => m.value === a) && awardMentions.some((m) => m.value === b)) {
      return { amountMin: Math.min(a, b), amountMax: Math.max(a, b) };
    }
  }

  const qualifiers = awardMentions.map((m) => {
    const before = m.sentence
      .slice(Math.max(0, m.offsetInSentence - 30), m.offsetInSentence)
      .replace(/\$\s*$/, '');
    if (UP_TO.test(before)) return 'up_to';
    if (AT_LEAST.test(before)) return 'at_least';
    return 'exact';
  });
  const values = awardMentions.map((m) => m.value);
  if (qualifiers.every((q) => q === 'up_to')) return { amountMax: Math.max(...values) };
  if (qualifiers.every((q) => q === 'at_least')) return { amountMin: Math.min(...values) };

  return { amountMin: Math.min(...values), amountMax: Math.max(...values) };
}
