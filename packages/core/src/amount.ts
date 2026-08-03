import type { AmountSpec, AwardTier } from './types.js';

/*
 * ============================================================================
 * parseAmount — award-vs-capital-pool classification by noun-phrase attachment
 * ============================================================================
 *
 * WHY THIS FILE LOOKS THE WAY IT DOES (fix round 4, 2026-08-06)
 *
 * Rounds 1-3 classified each dollar figure with a growing alternation of rescue
 * anchors: a poison-term word list, an "award of $X" before-anchor, an "$X award"
 * after-anchor with three branches, a one-word filler allowance scoped to two of
 * those three branches, and a separate `receivesRescue` side-channel with a
 * single-token lookback. Every round closed its own finding and reopened the
 * identical hole in a neighbouring branch, because a character window plus an
 * n-word filler budget has no idea WHICH mention an anchor phrase belongs to.
 *
 * This round replaces all of that with one structure. Every dollar mention is
 * classified by the grammar around it, resolved in a fixed order, on TOKENS —
 * never on character windows and never on a filler-word budget:
 *
 *   1. cumulative-total marker in the clause        -> capital  (lifetime totals)
 *   2. left attachment  "<head> of $N"              -> head noun decides
 *   3. right attachment "$N <noun compound>"        -> compound decides
 *        3a. compound is claimed by a following "of $M"  -> capital
 *        3b. compound contains a capital/total noun      -> capital
 *        3c. compound head is an award/person noun       -> award
 *   4. predicate: trailing award predicate, or the nearest governing verb
 *        outflow verb (money leaving a pool)             -> award
 *        inflow verb  (money entering a pool)            -> subject head decides
 *   5. clause-level capital vocabulary                  -> capital
 *   6. default                                          -> award
 *
 * The load-bearing invariant, and the one that closes the whole class of leak
 * the previous rounds kept reopening:
 *
 *   A noun-phrase attachment BINDS. Once "$50,000 trust" resolves as capital by
 *   rule 3b, no predicate, anchor phrase or recipient noun anywhere else in the
 *   clause can rescue it. Anchor phrases can only ever be reached by a mention
 *   whose own noun phrase did not already answer the question — so an anchor
 *   that belongs to a later mention can no longer be borrowed by an earlier one.
 *
 * The two supporting structural rules, both of which replace a filler budget:
 *
 *   - A noun run is consumed strictly: consecutive tokens that are all in the
 *     noun lexicon, with only whitespace between them, and never across another
 *     dollar mention. Unknown words STOP the run instead of being skipped.
 *   - A trailing predicate is only visible from the mention itself or from the
 *     far end of its own kept noun phrase. It is never reached by hopping over
 *     an arbitrary word.
 *
 * Direction of error: when nothing resolves affirmatively, prefer omission.
 * Publishing a $100,000 endowment as an award sends a student to spend limited
 * application effort on a scholarship that does not exist.
 */

/* ------------------------------------------------------------------ *
 * 1. Lexicons — the vocabulary the structure is built out of.
 *
 * These are word CLASSES, not rescue phrases. A word's class is a fact about
 * the word; the structure above decides what to do with it. Adding a word here
 * never changes the shape of the algorithm, which is the property rounds 1-3
 * lacked.
 * ------------------------------------------------------------------ */

/** Nouns naming a pool of money that GENERATES awards. Never an award itself. */
const CAPITAL_NOUNS: ReadonlySet<string> = new Set([
  'endowment',
  'endowments',
  'endowed',
  'fund',
  'funds',
  'funding',
  'trust',
  'trusts',
  'corpus',
  'corpora',
  'estate',
  'estates',
  'principal',
  'bequest',
  'bequests',
  'legacy',
  'legacies',
  'asset',
  'assets',
  'portfolio',
  'portfolios',
  'reserve',
  'reserves',
  'annuity',
  'annuities',
  'capital',
  'treasury',
]);

/** Nouns naming an aggregate rather than a single award. */
const TOTAL_NOUNS: ReadonlySet<string> = new Set([
  'total',
  'totals',
  'sum',
  'sums',
  'balance',
  'aggregate',
  'proceeds',
]);

/** Nouns naming what a student actually receives. */
const AWARD_NOUNS: ReadonlySet<string> = new Set([
  'award',
  'awards',
  'scholarship',
  'scholarships',
  'grant',
  'grants',
  'prize',
  'prizes',
  'stipend',
  'stipends',
  'fellowship',
  'fellowships',
  'bursary',
  'bursaries',
  'honorarium',
  'honoraria',
]);

/**
 * Nouns that name an award in one construction and a capital pool in another:
 * "a $1,000 gift is made to one recipient" (award) vs "a $100,000 gift from the
 * estate of W1ABC" (capital). These never decide on their own — they defer to
 * the predicate (rule 4) and then to clause context (rule 5).
 */
const AMBIGUOUS_NOUNS: ReadonlySet<string> = new Set([
  'gift',
  'gifts',
  'donation',
  'donations',
  'contribution',
  'contributions',
  'memorial',
  'memorials',
]);

/**
 * Nouns naming a PERSON WHO CAN RECEIVE AN AWARD.
 *
 * Deliberately excludes people who ADMINISTER money — trustee, board, committee,
 * director, officer, treasurer. That distinction is the whole content of the
 * "The fund's board of trustees receives $500,000" / "The committee of trustees
 * receives $500,000" probes: both have a human subject, neither is a payee.
 */
const PERSON_NOUNS: ReadonlySet<string> = new Set([
  'recipient',
  'recipients',
  'applicant',
  'applicants',
  'winner',
  'winners',
  'member',
  'members',
  'student',
  'students',
  'scholar',
  'scholars',
  'awardee',
  'awardees',
  'beneficiary',
  'beneficiaries',
  'fellow',
  'fellows',
  'candidate',
  'candidates',
  'nominee',
  'nominees',
  'honoree',
  'honorees',
  'investigator',
  'investigators',
  'researcher',
  'researchers',
  'participant',
  'participants',
  'licensee',
  'licensees',
  'operator',
  'operators',
  'amateur',
  'amateurs',
  'entrant',
  'entrants',
  'finalist',
  'finalists',
  'graduate',
  'graduates',
  'undergraduate',
  'undergraduates',
  'youth',
  'individual',
  'individuals',
  'person',
  'persons',
]);

/**
 * Verbs describing money leaving a pool. Direction alone settles these.
 *
 * Fix round 5 (2026-08-06): past-tense and participle forms were missing, so
 * `governingVerb` silently saw no verb at all in "the club has provided over
 * $930,350" or "Total distributed: $1.2M" and fell through to rule 6's award
 * default. Every form of every verb here and in `INFLOW_VERBS` is listed.
 */
const OUTFLOW_VERBS: ReadonlySet<string> = new Set([
  'gives',
  'give',
  'gave',
  'given',
  'provides',
  'provide',
  'provided',
  'providing',
  'offers',
  'offer',
  'offered',
  'presents',
  'present',
  'presented',
  'pays',
  'pay',
  'paid',
  'payable',
  'distributes',
  'distribute',
  'distributed',
  'awards',
  'award',
  'awarded',
  'grants',
  'grant',
  'granted',
  'disburses',
  'disburse',
  'disbursed',
  'confers',
  'confer',
  'conferred',
  'bestows',
  'bestow',
  'bestowed',
  'issues',
  'issue',
  'issued',
]);

/**
 * Verbs describing money ENTERING something. Symmetric between "the endowment
 * receives $500,000 in gifts" and "the scholar receives $2,000" — direction
 * cannot settle these, so the SUBJECT does (see `subjectHead`), and when the
 * subject is a payee the money's own object gets the last word (see
 * `INFLOW_OBJECT`).
 */
const INFLOW_VERBS: ReadonlySet<string> = new Set([
  'receives',
  'receive',
  'received',
  'receiving',
  'accepts',
  'accept',
  'accepted',
  'collects',
  'collect',
  'collected',
  'holds',
  'hold',
  'held',
  'contains',
  'contain',
  'contained',
  'earns',
  'earn',
  'earned',
  'accrues',
  'accrue',
  'accrued',
]);

/**
 * The prepositional object of a money mention naming what the money IS, when
 * that is capital inflow: "receive $50,000 in membership dues", "$500,000 in
 * annual dues", "$10,000 in program funding".
 *
 * Fix round 5 (2026-08-06), CRITICAL over-claim: rule 4 resolved an inflow verb
 * on its subject head alone. `members` is a genuine payee-class noun, so "The
 * Society's student members receive $50,000 in membership dues each year"
 * passed the subject test and published dues income as a $50,000 award. The
 * subject says who; this says what — and "what" wins when they disagree.
 *
 * DELIBERATELY EXCLUDES `grants` and `support`, which the finding listed:
 * "students receive $10,000 in grants" is ordinary award phrasing, so including
 * them would trade this over-claim for an under-claim on the commonest shape in
 * the corpus. Every word kept here is unambiguously money entering a pool.
 */
const INFLOW_OBJECT =
  /^in\s+(?:(?!\$)\S+\s+){0,2}?(?:dues|contributions?|donations?|gifts?|funding|revenues?|income|fees?|pledges?|bequests?|endowments?|assets?|earnings|interest|proceeds|capital|principal)\b/i;

/**
 * A duration span: "$1.2M over 48 years", "over the past twenty years". The
 * span makes the figure an accumulation, not one award.
 *
 * Fix round 5: consulted at rule 5, NOT rule 1. A legitimate multi-year award
 * ("a $5,000 scholarship paid over four years") resolves at rule 2/3 from its
 * own noun phrase and never reaches here; only a figure nothing else explains
 * is read as a cumulative span.
 */
const CUMULATIVE_SPAN = /\bover\s+(?:the\s+(?:past|last)\s+)?[\w-]+\s+(?:years?|decades?)\b/i;

/** Phrases marking a figure as a lifetime/cumulative total rather than one award. */
const CUMULATIVE_TERMS: readonly string[] = [
  'has awarded',
  'have awarded',
  'awarded since',
  'distributed since',
  'since 19',
  'since 20',
  'to date',
  'cumulative',
  'in total',
  'total assets',
  'totaling',
  'totalling',
  'raised',
  'in awards',
  'over the years',
  'lifetime',
  'all-time',
];

/** Clause-level capital vocabulary — the last-resort tiebreak before defaulting. */
const CAPITAL_CONTEXT_TERMS: readonly string[] = [
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
  'capital',
];

/**
 * PLAN-LOCAL export (CONTRACT §4) consumed by `index.ts` and, per the task-4
 * brief, by Plan 2's normalizer when it explains a parse in the review queue.
 * Kept as the union of the two non-award vocabularies above so it cannot drift
 * from the classifier's own lexicons.
 */
export const NON_AWARD_CONTEXT_TERMS: readonly string[] = [
  ...CAPITAL_CONTEXT_TERMS,
  ...CUMULATIVE_TERMS,
];

function alternation(words: ReadonlySet<string>): string {
  return [...words].sort((a, b) => b.length - a.length).join('|');
}

/**
 * PLAN-LOCAL export, retained for the frozen interface. Describes the
 * left-attachment shape rule 2 recognizes ("award of $X", "scholarship: $X").
 * Generated from `AWARD_NOUNS` so it stays in sync; the classifier itself walks
 * tokens rather than testing this against a character window, which is exactly
 * what made rounds 1-3 leak.
 */
export const AWARD_ANCHOR = new RegExp(
  `\\b(${alternation(AWARD_NOUNS)})\\s+(?:of|:)?\\s*$`,
  'i',
);

/**
 * PLAN-LOCAL export, retained for the frozen interface. Describes the
 * right-attachment and trailing-predicate shapes rules 3 and 4 recognize
 * ("$X award", "$X goes to each winner"). Generated from the lexicons for the
 * same reason as `AWARD_ANCHOR`.
 */
export const AWARD_ANCHOR_AFTER = new RegExp(
  `^\\s*(?:(?:${alternation(AWARD_NOUNS)})\\b|${TRAILING_PREDICATE_SOURCE()})`,
  'i',
);

/* ------------------------------------------------------------------ *
 * 2. Structural patterns.
 * ------------------------------------------------------------------ */

/**
 * A recipient prepositional phrase, optionally introduced by an award-directional
 * verb phrase: "to one recipient", "is made to one recipient", "goes to each
 * member", "paid to the top applicant".
 *
 * The 0-2 token gap between the determiner and the recipient noun is bounded
 * INSIDE the phrase (it exists for "to one licensed student"), and `(?!\$)`
 * forbids it from stepping over another dollar mention — so unlike round 2's
 * filler budget it cannot bridge to a different mention's anchor.
 */
function TRAILING_PREDICATE_SOURCE(): string {
  const person = alternation(PERSON_NOUNS);
  return (
    '(?:' +
    '(?:(?:is|are|was|were|shall\\s+be|will\\s+be)\\s+)?' +
    '(?:made|awarded|given|presented|paid|payable|granted|issued|distributed)\\s+to' +
    '|(?:goes|go|went)\\s+to' +
    '|to' +
    ')' +
    `\\s+(?:one|each|every|all|a|an|the|\\d+)?\\s*(?:(?!\\$)\\S+\\s+){0,2}?(?:${person})\\b`
  );
}

const TRAILING_RECIPIENT_PREDICATE = new RegExp(`^${TRAILING_PREDICATE_SOURCE()}`, 'i');

/**
 * A passive award predicate with no explicit recipient: "$2,000 is awarded
 * annually". Restricted to award-specific participles — `made` and `given` are
 * excluded because "is given to the endowment" is a capital inflow.
 */
const TRAILING_PASSIVE_AWARD = /^(?:is|are|was|were)\s+(?:awarded|granted|presented)\b/i;

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

const WORD_RE = /[A-Za-z][A-Za-z'’]*/g;

/** Hard clause boundaries: sentence enders, semicolons, newlines. Never re-joined. */
const HARD_BOUNDARY = /(?<=[.;])\s+|\n+/;

/** Soft clause boundaries: commas and subordinators. Subject to the re-join below. */
const SOFT_BOUNDARY = /(?<=,)\s+|\s+(?=(?:while|whereas|although|though|however|but)\b)/i;

/** Cheap "does this fragment hold a dollar figure of its own" test. Non-global on purpose. */
const MONEY_PRESENT = /\$\s?[0-9]/;

/**
 * Finite verbs and auxiliaries. Only used to tell a fronted adverbial ("Since
 * 1978,") from a real clause ("The fund was established in 1980,").
 */
const FINITE_VERB_MARKERS: ReadonlySet<string> = new Set([
  'is',
  'are',
  'am',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
  'does',
  'do',
  'did',
  'will',
  'shall',
  'may',
  'might',
  'can',
  'could',
  'would',
  'should',
  'must',
  'makes',
  'make',
  'made',
  'supports',
  'support',
  'supported',
  'funds',
  'funded',
  'remains',
  'remain',
  'exceeds',
  'exceed',
  'ranges',
  'range',
  'totals',
  'totaling',
  'totalling',
]);

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

/* ------------------------------------------------------------------ *
 * 3. Tokenized clause model. Everything downstream reads tokens, not
 *    character windows.
 * ------------------------------------------------------------------ */

interface Token {
  readonly lower: string;
  readonly start: number;
  readonly end: number;
}

interface MoneySpan {
  readonly start: number;
  readonly end: number;
  readonly value: number;
}

interface Clause {
  readonly text: string;
  readonly lower: string;
  readonly tokens: readonly Token[];
  readonly money: readonly MoneySpan[];
}

type NounRole = 'capital' | 'total' | 'award' | 'person' | 'ambiguous';

function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[’']s$/, '');
}

function nounRole(word: string): NounRole | undefined {
  const w = normalizeWord(word);
  if (CAPITAL_NOUNS.has(w)) return 'capital';
  if (TOTAL_NOUNS.has(w)) return 'total';
  if (AWARD_NOUNS.has(w)) return 'award';
  if (PERSON_NOUNS.has(w)) return 'person';
  if (AMBIGUOUS_NOUNS.has(w)) return 'ambiguous';
  return undefined;
}

/**
 * A fronted adverbial is a leading phrase with no finite verb and no dollar
 * figure of its own: "Since 1978,", "In 2024,", "Each year,", "To date,",
 * "In memory of W1XYZ,". It is a modifier, not a clause.
 */
function isFrontedAdverbial(fragment: string): boolean {
  if (MONEY_PRESENT.test(fragment)) return false;
  const words = fragment.match(WORD_RE);
  if (!words || words.length === 0 || words.length > 6) return false;
  return !words.some((w) => {
    const lower = w.toLowerCase();
    return (
      FINITE_VERB_MARKERS.has(lower) || OUTFLOW_VERBS.has(lower) || INFLOW_VERBS.has(lower)
    );
  });
}

/**
 * Clause segmentation.
 *
 * Fix round 5 (2026-08-06), CRITICAL over-claim: a bare comma used to be a hard
 * clause boundary, which severed a FRONTED ADVERBIAL from the clause it
 * modifies. "Since 1978, the club has provided over $930,350 in scholarships"
 * split into "Since 1978," and a remainder holding the figure but none of the
 * cumulative vocabulary, so rule 1 never fired and rule 6 defaulted a lifetime
 * total to an award. That is QCWA's real catalogue phrasing, and fronted
 * adverbials recur throughout this prose.
 *
 * Sentence enders and semicolons stay hard boundaries. A comma-delimited
 * leading fragment is re-joined to the clause it modifies when it carries no
 * finite verb and no figure of its own — i.e. when it was never a clause.
 */
function splitClauses(raw: string): string[] {
  const out: string[] = [];
  for (const sentence of raw.split(HARD_BOUNDARY)) {
    if (sentence.length === 0) continue;
    const parts = sentence.split(SOFT_BOUNDARY).filter((p) => p.length > 0);
    while (parts.length >= 2 && isFrontedAdverbial(parts[0])) {
      parts.splice(0, 2, `${parts[0]} ${parts[1]}`);
    }
    out.push(...parts);
  }
  return out;
}

function buildClause(text: string): Clause {
  const money: MoneySpan[] = [];
  MONEY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MONEY.exec(text)) !== null) {
    const value = toAmount(m[1], m[2]);
    // Magnitude unresolvable: skip rather than emit a garbled number.
    if (value === undefined) continue;
    money.push({ start: m.index, end: m.index + m[0].length, value });
  }

  const tokens: Token[] = [];
  WORD_RE.lastIndex = 0;
  let w: RegExpExecArray | null;
  while ((w = WORD_RE.exec(text)) !== null) {
    const start = w.index;
    const end = start + w[0].length;
    // Words consumed by a money match ("million" in "$2 million") are not tokens.
    if (money.some((s) => start >= s.start && end <= s.end)) continue;
    tokens.push({ lower: w[0].toLowerCase(), start, end });
  }

  return { text, lower: text.toLowerCase(), tokens, money };
}

function tokenIndexAfter(clause: Clause, pos: number): number {
  return clause.tokens.findIndex((t) => t.start >= pos);
}

function tokenIndexBefore(clause: Clause, pos: number): number {
  for (let i = clause.tokens.length - 1; i >= 0; i -= 1) {
    if (clause.tokens[i].end <= pos) return i;
  }
  return -1;
}

/* ------------------------------------------------------------------ *
 * 4. Attachment resolution.
 * ------------------------------------------------------------------ */

/**
 * Rule 2 — the head noun of an explicit "<head> of $N" (or "<head>: $N")
 * attachment. English compounds are right-headed, so the head is the noun
 * ADJACENT to "of": in "endowment funds awards of $2,500" the $2,500 measures
 * an award, not the endowment. Adjacency is enforced with a whitespace-only gap,
 * which is why the elided "4 of $15,000" in a tier list finds no head at all.
 */
function leftHead(clause: Clause, span: MoneySpan): string | undefined {
  const prevIdx = tokenIndexBefore(clause, span.start);
  if (prevIdx < 0) return undefined;
  const prev = clause.tokens[prevIdx];
  if (!/^[\s:]*$/.test(clause.text.slice(prev.end, span.start))) return undefined;

  if (prev.lower !== 'of') {
    // "grant: $2,000" — a colon attaches the head directly.
    return clause.text.slice(prev.end, span.start).includes(':') ? prev.lower : undefined;
  }
  const headIdx = prevIdx - 1;
  if (headIdx < 0) return undefined;
  const head = clause.tokens[headIdx];
  if (!/^\s*$/.test(clause.text.slice(head.end, prev.start))) return undefined;
  return head.lower;
}

/**
 * Rule 3 — the noun compound premodified by the amount: "$100,000 endowment",
 * "$2,000 prize fund total". Consumption is strict: only tokens the noun lexicon
 * knows, separated by whitespace (or a hyphen) only, and never across another
 * dollar mention. An unknown word ENDS the run rather than being skipped, which
 * is what a filler budget got wrong.
 */
function rightRun(clause: Clause, span: MoneySpan): Token[] {
  const out: Token[] = [];
  let i = tokenIndexAfter(clause, span.end);
  if (i < 0) return out;
  let cursor = span.end;
  for (; i < clause.tokens.length; i += 1) {
    const t = clause.tokens[i];
    if (!/^[\s\-–]*$/.test(clause.text.slice(cursor, t.start))) break;
    if (clause.money.some((s) => s.start >= cursor && s.end <= t.start)) break;
    if (nounRole(t.lower) === undefined) break;
    out.push(t);
    cursor = t.end;
  }
  return out;
}

/**
 * Rule 3a — a compound whose value is stated by a FOLLOWING "of $M" belongs to
 * that later mention, not to this one: "$50,000 gift scholarship of $2,000" says
 * the scholarship is worth $2,000, so $50,000 is not the award. A head noun can
 * carry exactly one value; when two compete, omit.
 *
 * This single rule replaces round 3's per-branch filler scoping and covers every
 * "$CAPITAL <capital-noun> <award-noun> of $AWARD" shape at once, at any compound
 * length, without caring which noun happens to sit where.
 */
function claimedByLaterMention(clause: Clause, run: readonly Token[]): boolean {
  const last = run[run.length - 1];
  const idx = clause.tokens.findIndex((t) => t.start === last.start);
  const next = clause.tokens[idx + 1];
  if (!next || next.lower !== 'of') return false;
  if (!/^\s*$/.test(clause.text.slice(last.end, next.start))) return false;
  return clause.money.some(
    (s) => s.start >= next.end && /^\s*$/.test(clause.text.slice(next.end, s.start)),
  );
}

/**
 * Rule 4 — the verb governing this mention. Bounded to the three tokens before
 * the amount and never allowed to reach past another dollar mention, so a verb
 * belonging to a different clause constituent cannot govern this one.
 */
function governingVerb(clause: Clause, span: MoneySpan): Token | undefined {
  let boundary = 0;
  for (const s of clause.money) {
    if (s.end <= span.start && s.end > boundary) boundary = s.end;
  }
  const startIdx = tokenIndexBefore(clause, span.start);
  for (let i = startIdx, seen = 0; i >= 0 && seen < 3; i -= 1, seen += 1) {
    const t = clause.tokens[i];
    if (t.start < boundary) break;
    if (OUTFLOW_VERBS.has(t.lower) || INFLOW_VERBS.has(t.lower)) return t;
  }
  return undefined;
}

/**
 * The head noun of an inflow verb's subject noun phrase. Handles multi-word
 * subjects the way English does: a postmodifying "of" phrase does not move the
 * head, so "the fund's board of trustees" heads on "board" and "the committee of
 * trustees" heads on "committee" — neither of which is a payee. "The Principal
 * Investigator" heads on "Investigator", so the adjectival "Principal" never
 * poisons it.
 */
function subjectHead(clause: Clause, verb: Token): string | undefined {
  const subject = clause.text.slice(0, verb.start).split(/\s+of\s+/i)[0];
  const words = subject.match(WORD_RE);
  if (!words || words.length === 0) return undefined;
  return normalizeWord(words[words.length - 1]);
}

/**
 * The trailing predicate, read from `scanFrom` — which is the token right after
 * the amount, or right after the amount's own kept noun phrase. Never from an
 * arbitrary offset, so a predicate belonging to a neighbouring mention is
 * unreachable.
 */
function trailingText(clause: Clause, scanFrom: number): string {
  if (scanFrom < 0 || scanFrom >= clause.tokens.length) return '';
  return clause.text.slice(clause.tokens[scanFrom].start);
}

function trailingAwardPredicate(clause: Clause, scanFrom: number): boolean {
  const tail = trailingText(clause, scanFrom);
  return TRAILING_RECIPIENT_PREDICATE.test(tail) || TRAILING_PASSIVE_AWARD.test(tail);
}

type Verdict = 'award' | 'capital';

/**
 * The whole classifier. Six ordered rules, first one that resolves wins.
 * Everything above this line exists to feed it.
 */
function classify(clause: Clause, span: MoneySpan): Verdict {
  // 1. Lifetime / cumulative totals are never a single award. A clause that
  //    NAMES an aggregate ("Total distributed: $1.2M", "the $2,000 prize fund
  //    total") is reporting a sum, whatever else it says — fix round 5 lifted
  //    TOTAL_NOUNS out of the noun-compound rules to clause level so that
  //    "Total distributed:" is seen before `distributed` can read as an outflow
  //    verb at rule 4.
  if (CUMULATIVE_TERMS.some((t) => clause.lower.includes(t))) return 'capital';
  if (clause.tokens.some((t) => nounRole(t.lower) === 'total')) return 'capital';

  // 2. Explicit "<head> of $N" attachment.
  const left = leftHead(clause, span);
  const leftRole = left === undefined ? undefined : nounRole(left);
  if (leftRole === 'capital' || leftRole === 'total') return 'capital';
  if (leftRole === 'award' || leftRole === 'person') return 'award';

  // 3. "$N <noun compound>" attachment.
  let scanFrom = tokenIndexAfter(clause, span.end);
  const run = rightRun(clause, span);
  if (run.length > 0) {
    if (claimedByLaterMention(clause, run)) return 'capital';
    const roles = run.map((t) => nounRole(t.lower));
    if (roles.includes('capital') || roles.includes('total')) return 'capital';
    const head = roles[roles.length - 1];
    if (head === 'award' || head === 'person') return 'award';
    scanFrom = tokenIndexAfter(clause, run[run.length - 1].end);
  }

  // 4. Predicate: which way is the money moving, and for an inflow, into what.
  if (trailingAwardPredicate(clause, scanFrom)) return 'award';
  const verb = governingVerb(clause, span);
  if (verb) {
    if (OUTFLOW_VERBS.has(verb.lower)) return 'award';
    const subject = subjectHead(clause, verb);
    if (subject === undefined || !PERSON_NOUNS.has(subject)) return 'capital';
    // The subject is a payee, but the money's own object can still say the
    // money is capital income rather than an award: "student members receive
    // $50,000 in membership dues". Who receives it does not settle what it is.
    return INFLOW_OBJECT.test(trailingText(clause, scanFrom)) ? 'capital' : 'award';
  }

  // 5. Clause-level capital vocabulary, or an accumulation spanning years —
  //    last chance to omit before the default.
  if (CAPITAL_CONTEXT_TERMS.some((t) => clause.lower.includes(t))) return 'capital';
  if (CUMULATIVE_SPAN.test(clause.text)) return 'capital';

  // 6. Nothing suggests a capital pool: a bare figure in this corpus is an award.
  return 'award';
}

interface Mention {
  readonly value: number;
  readonly isAward: boolean;
  readonly clause: string;
  readonly offsetInClause: number;
}

function collectMentions(raw: string): Mention[] {
  const mentions: Mention[] = [];
  for (const text of splitClauses(raw)) {
    const clause = buildClause(text);
    for (const span of clause.money) {
      mentions.push({
        value: span.value,
        isAward: classify(clause, span) === 'award',
        clause: clause.text,
        offsetInClause: span.start,
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
    const before = m.clause
      .slice(Math.max(0, m.offsetInClause - 30), m.offsetInClause)
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
