/**
 * Lexicons for the offline generic-prose analyzer.
 *
 * IMPORTANT: STYLE_WORDS is NOT a blacklist and the analyzer never bans a word.
 * These are ordinary English words that appear in excellent proposals. They are
 * drawn from the excess-vocabulary finding in Kobak et al., Science Advances
 * 2025 (DOI 10.1126/sciadv.adt3813), whose load-bearing result is grammatical:
 * 2024's excess vocabulary was 66% verbs and 14% adjectives — style words —
 * against 79% nouns in the Covid-era baseline — content words. A real event
 * changes the nouns; a language model changes the verbs and adjectives.
 *
 * The analyzer therefore reports STYLE-WORD DENSITY RELATIVE TO PROPER NOUNS
 * AND FIGURES. A paragraph full of these words next to callsigns, dates and
 * dollar amounts is fine. The same words with nothing referential nearby are
 * the signal.
 *
 * Matching is by stem, so only base forms are listed; features.ts derives
 * plural, past, gerund and adverbial forms.
 *
 * HOW THIS LIST IS KEPT FROM DRIFTING. The failure mode is obvious and it is
 * seductive: the list grows into "words that sound AI-ish", which is a vibe, is
 * unbounded, and is mostly nouns — and nouns are precisely the class the
 * finding says a REAL event moves. Three rules hold the line, and
 * features.test.ts asserts all three so an edit that breaks them turns red:
 *   1. Every entry belongs to exactly one of the four grammatical classes
 *      below, and verbs + adjectives + adverbs stay the clear majority.
 *   2. No entry is a referent — no callsign, model number, organization, place,
 *      role, unit or number word. Those are the counterweight the analyzer
 *      measures style AGAINST; putting one here would have the module flagging
 *      the specificity it exists to reward.
 *   3. Base forms only, lowercase. A list of inflections is a list that grows
 *      by conjugation rather than by evidence.
 * Adding a word means naming its grammatical class, which is a far harder thing
 * to do casually than appending to a flat array of things that sounded wrong.
 */

/** Verbs — the largest class in the 2024 finding. */
export const STYLE_VERBS: readonly string[] = [
  'delve', 'underscore', 'showcase', 'leverage', 'foster', 'facilitate', 'harness',
  'streamline', 'unveil', 'spearhead', 'cultivate', 'augment', 'amplify', 'elucidate',
  'encompass', 'garner', 'bolster', 'empower', 'enhance', 'enable', 'align', 'drive',
  'unlock', 'navigate', 'illuminate', 'exemplify', 'highlight', 'emphasize', 'reinforce',
  'exhibit', 'reflect', 'demonstrate', 'ensure', 'strive', 'embark', 'transform',
];

/** Adjectives and their adverbial forms — the second class in the finding. */
export const STYLE_ADJECTIVES: readonly string[] = [
  'transformative', 'comprehensive', 'robust', 'seamless', 'meticulous', 'noteworthy',
  'commendable', 'holistic', 'nuanced', 'invaluable', 'unwavering', 'vibrant', 'dynamic',
  'innovative', 'strategic', 'impactful', 'meaningful', 'crucial', 'vital', 'pivotal',
  'intricate', 'groundbreaking', 'cutting-edge', 'state-of-the-art', 'profound',
  'remarkable', 'exceptional', 'compelling', 'significant', 'substantial', 'multifaceted',
  'unprecedented', 'unparalleled', 'diverse', 'inclusive', 'sustainable', 'scalable',
];

/**
 * Abstract nouns that do reference work in name only. Deliberately the SMALLEST
 * class here, and it must stay that way: a noun-heavy excess vocabulary is the
 * signature of a real event, not of a language model, so a list that grows on
 * this side is a list that has stopped measuring what it claims to measure.
 */
export const STYLE_NOUNS: readonly string[] = [
  'potential', 'insight', 'finding', 'realm', 'landscape', 'tapestry', 'paradigm',
  'endeavor', 'endeavour', 'myriad', 'plethora', 'framework', 'initiative', 'synergy',
  'ecosystem', 'journey', 'commitment', 'dedication', 'passion', 'excellence',
  'engagement', 'awareness', 'capacity', 'resilience', 'innovation', 'opportunity',
  'impact', 'outcome', 'stakeholder', 'utilization', 'implementation', 'optimization',
];

/**
 * Hedges and intensifiers flagged in the same study. Only the ones whose
 * adjective is not already listed above, or whose stem the -ly rule cannot
 * reach ("holistically" does not stem to "holistic").
 */
export const STYLE_ADVERBS: readonly string[] = [
  'notably', 'particularly', 'significantly', 'substantially', 'crucially', 'importantly',
  'effectively', 'seamlessly', 'holistically', 'ultimately', 'fundamentally', 'increasingly',
];

export const STYLE_WORDS: ReadonlySet<string> = new Set([
  ...STYLE_VERBS,
  ...STYLE_ADJECTIVES,
  ...STYLE_NOUNS,
  ...STYLE_ADVERBS,
]);

/** Banned outright by the style ruleset. None of these carries information. */
export const BANNED_TRANSITIONS: readonly string[] = [
  'Furthermore',
  'Moreover',
  'Additionally',
  'It is important to note that',
];

/** Reported but not banned: common, and sometimes legitimate. */
export const WATCH_TRANSITIONS: readonly string[] = [
  'In addition',
  'It is worth noting',
  'Notably',
  'Importantly',
  'In conclusion',
  'Overall',
  'Ultimately',
  'That being said',
];

export const STOCK_OPENERS: readonly string[] = [
  "In today's rapidly evolving landscape",
  "In today's fast-paced world",
  'In an era of',
  'In the ever-evolving world of',
  'Since the dawn of',
  'It is no secret that',
  'In recent years, there has been a growing',
  'Now more than ever',
];

export const STOCK_CLOSERS: readonly string[] = [
  'ensuring long-term impact for years to come',
  'for years to come',
  'we look forward to partnering with you',
  'a lasting impact',
  'make a difference in the lives of',
  'In conclusion',
];

/** Counted as figures: a claim of scale with a number word in it is still a figure. */
export const NUMBER_WORDS: ReadonlySet<string> = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'dozen', 'hundred', 'thousand', 'million',
]);

/** Participles after a comma that are prepositional rather than the stylistic tail. */
export const PARTICIPLE_ALLOWLIST: ReadonlySet<string> = new Set([
  'including', 'regarding', 'concerning', 'following', 'featuring', 'pending',
  'during', 'notwithstanding', 'excluding', 'depending', 'starting', 'beginning',
  'ranging', 'using', 'covering', 'spanning', 'according',
]);

/**
 * Lowercased, without the trailing period, for the sentence splitter.
 *
 * A whole-word list cannot reach a DOTTED abbreviation — the word before the
 * final period of "Ph.D." is "Ph.D", never "D" — so "Ph.D.", "U.S.A." and
 * "J. Hall" are handled structurally in features.ts by the single-capital
 * initial rule instead, exactly as normalize/axes/clauses.ts does. Listing
 * "u.s" here is belt and braces for the one case common enough to be worth it.
 */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'ave', 'inc', 'co', 'vs', 'etc', 'no',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'approx', 'fig', 'dept', 'e.g', 'i.e', 'u.s',
]);
