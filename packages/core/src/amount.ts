import type { AmountSpec, AwardTier } from './types.js';

/**
 * Vocabulary that marks a dollar figure as something OTHER than an award.
 * Two groups: endowment/capital-pool vocabulary, and cumulative-total vocabulary.
 * Grounded in real ARRL catalogue and QCWA text — see the tests — plus fix-round-1
 * hardening (2026-08-03) that broadened several fixture-exact phrases into bare,
 * shape-based terms ('fund', 'estate', 'gift', 'principal', 'trust', 'seeded',
 * 'in memory of') after an adversarial probe found the narrow phrasing didn't
 * generalize past the literal fixture strings. See amount.test.ts, describe
 * block "parseAmount — fix round 1 hardening".
 */
export const NON_AWARD_CONTEXT_TERMS: readonly string[] = [
  // endowment / gift / capital-pool
  'endowment',
  'endowed',
  'endowing',
  'bequest',
  'bequeathed',
  'estate of',
  'estate',
  'corpus',
  'principal',
  'trust',
  'fund',
  'seeded',
  'fund was established',
  'was established with',
  'established with',
  'gift of',
  'gift',
  'donated',
  'donation of',
  'contributed',
  'memorial fund of',
  'in memory of',
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
 * Rescues a per-award figure that shares a sentence with a non-award figure when
 * the award language precedes the amount: "A $100,000 endowment funds awards of
 * $2,500." / "...which provides $500 to each licensed student."
 */
export const AWARD_ANCHOR =
  /\b(awards?|scholarships?|grants?|prizes?|stipends?|gives|give|provides|provide|offers?|presents?)\s+(?:of|to|:)?\s*$/i;

/**
 * Companion to AWARD_ANCHOR for the equally common trailing phrasing the brief's
 * original mechanism missed: "$1,000 award", "$2,000 scholarship each year",
 * "$500 to each licensed student". Tested against the text immediately following
 * a mention rather than immediately preceding it.
 */
export const AWARD_ANCHOR_AFTER =
  /^\s*(?:(?:awards?|scholarships?|grants?|prizes?|stipends?)\b|to\s+(?:one|each|every|a|an|the|\d+)(?:\s+\S+){0,2}?\s+students?\b)/i;

const MAGNITUDE_MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  m: 1_000_000,
  million: 1_000_000,
  b: 1_000_000_000,
  billion: 1_000_000_000,
};

const MONEY = /\$\s?([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(K|M|B|thousand|million|billion)?\b/gi;
const TIER_RE = /([0-9]+)\s+(?:awards?\s+)?of\s+\$\s?([0-9][0-9,]*)/gi;
const RANGE_RE = /\$\s?([0-9][0-9,]*)\s*(?:-|–|—|to|through)\s*\$?\s?([0-9][0-9,]*)/i;
const UP_TO =
  /(?:\b(?:up to|not to exceed|does not exceed|do not exceed|no more than|maximum of|maximum|max|under)|≤|<=)\s*$/i;
const AT_LEAST = /(?:\b(?:at least|minimum of|starting at)|≥|>=)\s*$/i;

function toNumber(raw: string): number {
  return Number(raw.replace(/,/g, ''));
}

/**
 * Parses a MONEY match's numeric text plus optional magnitude suffix (K/M/B or
 * thousand/million/billion) into a scaled amount. Returns undefined — never a
 * silently-stripped digit — if the base number can't be parsed or the suffix
 * isn't a recognized magnitude, so the caller can skip the mention entirely
 * rather than emit a nonsense value like "$2M" -> 2.
 */
function toAmount(rawValue: string, rawSuffix: string | undefined): number | undefined {
  const base = Number(rawValue.replace(/,/g, ''));
  if (!Number.isFinite(base)) return undefined;
  if (!rawSuffix) return base;
  const multiplier = MAGNITUDE_MULTIPLIERS[rawSuffix.toLowerCase()];
  if (multiplier === undefined) return undefined;
  return base * multiplier;
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
      const amount = toAmount(m[1], m[2]);
      // Can't determine the magnitude with confidence: skip rather than emit a
      // stripped/garbled number. Under-claiming beats over-claiming.
      if (amount === undefined) continue;
      const before = text.slice(Math.max(0, m.index - 25), m.index);
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 30);
      const rescued = AWARD_ANCHOR.test(before) || AWARD_ANCHOR_AFTER.test(after);
      mentions.push({
        value: amount,
        isAward: !sentenceIsNonAward || rescued,
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
