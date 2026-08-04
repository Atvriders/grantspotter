import { ABBREVIATIONS, NUMBER_WORDS, STYLE_WORDS } from './lexicon.js';

/**
 * Measurement primitives for the offline generic-prose analyzer. Task 13 assembles these into
 * `analyzeProse`; nothing here decides anything, it only counts.
 *
 * PURE by contract: zero I/O, zero network, no API key, no `node:` imports, and no import outside
 * this directory. features.test.ts asserts that against the files on disk.
 *
 * The two heuristics a reviewer will question, stated up front:
 *  - A sentence-initial capital is NOT evidence of a proper noun. Every sentence has one.
 *  - A number word IS a figure. "Three of our members will teach" is a claim of scale with a
 *    number in it, and the analyzer should say so rather than demanding digits.
 */

/** `W8UM`, `K5UTD`, `KD9XYZ` — one or two letters, one or two digits, one to four letters. */
const CALLSIGN_RE = /^[A-Z]{1,2}\d{1,2}[A-Z]{1,4}$/;
/** `IC-7300`, `DR-2X`, `FT991A`. */
const MODEL_RE = /^[A-Z]{1,4}-?\d{2,5}[A-Z]?$/;
const FIGURE_RE = /^\$?\d[\d,]*(?:\.\d+)?%?$/;
/** `I`, `I'm`, `I've`, `I'll`, `I'd` — capitalized mid-sentence, and not a named actor. */
const FIRST_PERSON_RE = /^I(?:['’](?:m|ve|ll|d))?$/;

export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Sentence splitter. Deliberately conservative: it will under-split rather than
 * split inside "3.5", "Dr. Ruiz", "Ph.D." or "J. Hall", because an over-split sentence
 * corrupts both the length-variance figure and the sentence-initial rule that
 * proper-noun counting depends on.
 *
 * The three rules are the ones `normalize/axes/clauses.ts` derived from the scholarship corpus,
 * where the naive `[^.]*\.` idiom silently truncated six different extractors:
 *  - a period between two digits is a decimal point ("a 3.5 GPA");
 *  - a period after a SINGLE CAPITAL that itself follows start-of-text, whitespace or another
 *    period is an initial ("J. Hall", "U.S.", "Ph.D.") — this is structural on purpose, because a
 *    list of abbreviations cannot hold "Ph.D": the word before that final period is "Ph.D", not
 *    "D", so no whole-word list will ever match it;
 *  - a period after a known abbreviation ("Dr.", "Sept.") is not a sentence end.
 * A word merely ENDING in a capital is not an initial, so "…is W8UM. Members meet" still splits.
 *
 * The initial rule has to be structural — "is the character before the period a lone capital?" —
 * and NOT "is the last WORD a single letter?". The word-shaped version reads the last run of
 * `[A-Za-z.]`, which for "DR-2X." is "X", because the digit breaks the run; it therefore treats
 * every model number ending in a single letter as an initial and glues the sentence to the next
 * one. A test asserts DR-2X and W8UM both still terminate.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;

    let j = i + 1;
    while (j < text.length && '.!?"\')]'.includes(text[j] as string)) j++;
    if (j < text.length && !/\s/.test(text[j] as string)) continue; // e.g. "3.5"

    if (ch === '.') {
      const before = text[i - 1];
      const beforeBefore = text[i - 2];
      const isInitial =
        before !== undefined &&
        /[A-Z]/.test(before) &&
        (beforeBefore === undefined || beforeBefore === '.' || /\s/.test(beforeBefore));
      if (isInitial) continue;

      const preceding = text.slice(start, i);
      const lastWord = (/([A-Za-z.]+)$/.exec(preceding)?.[1] ?? '').toLowerCase();
      if (ABBREVIATIONS.has(lastWord)) continue;
    }

    const sentence = text.slice(start, j).trim();
    if (sentence) out.push(sentence);
    start = j;
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

export function tokenize(text: string): string[] {
  const raw = text.match(/[A-Za-z0-9$][A-Za-z0-9'’$%.,\-]*/g) ?? [];
  return raw.map((t) => t.replace(/[.,;:'’\-]+$/, '')).filter((t) => t.length > 0);
}

export function isFigureToken(token: string): boolean {
  return FIGURE_RE.test(token) || NUMBER_WORDS.has(token.toLowerCase());
}

/** Base forms this token could inflect from, so the lexicon lists base forms only. */
function stemCandidates(token: string): string[] {
  const t = token.toLowerCase().replace(/[^a-z-]/g, '');
  const out = [t];
  const strip = (suffix: string): void => {
    if (t.length <= suffix.length + 2 || !t.endsWith(suffix)) return;
    const base = t.slice(0, t.length - suffix.length);
    out.push(base, base + 'e');
    if (base.length > 2 && base[base.length - 1] === base[base.length - 2]) out.push(base.slice(0, -1));
  };
  strip('s');
  strip('es');
  strip('ed');
  strip('ing');
  strip('ly');
  return out;
}

/** Returns the ORIGINAL tokens that hit the style lexicon, in order. */
export function styleWordHits(tokens: string[]): string[] {
  const hits: string[] = [];
  for (const token of tokens) {
    if (stemCandidates(token).some((c) => STYLE_WORDS.has(c))) hits.push(token);
  }
  return hits;
}

export interface DocIndex {
  /** Tokens observed capitalized in a non-initial position anywhere in the document. */
  midSentenceCapitalized: Set<string>;
}

export function buildDocIndex(text: string): DocIndex {
  const midSentenceCapitalized = new Set<string>();
  for (const para of splitParagraphs(text)) {
    for (const sentence of splitSentences(para)) {
      const tokens = tokenize(sentence);
      for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i] as string;
        if (/^[A-Z]/.test(t) && !isFigureToken(t) && !FIRST_PERSON_RE.test(t)) {
          midSentenceCapitalized.add(t);
        }
      }
    }
  }
  return { midSentenceCapitalized };
}

/**
 * The all-caps branch subsumes CALLSIGN_RE and MODEL_RE as written today — every callsign and
 * every model number in this domain is upper-case letters, digits and hyphens. They are kept
 * named because they are the intent (the spec names callsigns and model numbers specifically),
 * and because a mixed-case model designation would need them.
 */
function isStrongProperNoun(token: string): boolean {
  if (CALLSIGN_RE.test(token)) return true;
  if (MODEL_RE.test(token)) return true;
  return token.length >= 2 && /^[A-Z][A-Z0-9-]*$/.test(token);
}

/**
 * A sentence-initial capital is not evidence of a proper noun — every sentence
 * starts with one. It counts only when it is all-caps, a callsign, a model
 * number, or a token seen capitalized mid-sentence elsewhere in the document.
 * That keeps "Members who want to operate…" from scoring as a named actor.
 *
 * The cost is real and deliberate: a given name that only ever opens a sentence goes uncounted.
 * Under-counting pushes a paragraph toward "flag me", which is the safe direction for a tool whose
 * whole job is to ask the applicant for a specific they already know.
 */
export function countProperNouns(paragraph: string, doc: DocIndex): number {
  let n = 0;
  for (const sentence of splitSentences(paragraph)) {
    const tokens = tokenize(sentence);
    tokens.forEach((token, i) => {
      if (!/^[A-Z]/.test(token)) return;
      if (isFigureToken(token) || FIRST_PERSON_RE.test(token)) return;
      if (i === 0) {
        if (isStrongProperNoun(token) || doc.midSentenceCapitalized.has(token)) n++;
        return;
      }
      n++;
    });
  }
  return n;
}

/**
 * Figures in a token sequence.
 *
 * `isFigureToken` is a LEXICAL predicate and has no context; this is the REFERENTIAL count, and
 * the difference is one word. "one" is a number word, so `isFigureToken('one')` is true — but in
 * "one of the most exciting opportunities" and "no one is left behind" it is a vague quantifier
 * carrying no scale at all, and counting it there hands a paragraph with nothing in it a
 * figureCount of 1. That silences `paragraphsWithNoProperNounOrFigure` on exactly the prose the
 * flag exists for, which is the same defect as a flag that fires on good writing, seen from the
 * other side. Measured on a real generic passage before this rule existed: 8 style words, 0 proper
 * nouns, and 1 "figure" — the word "one".
 *
 * The rule is deliberately narrow, and scoped to "one" ALONE, because the two idioms it reads are
 * unambiguous and no other number word shares them. In particular it must NOT generalise to
 * "<number> of", since "Three of our members will teach a Saturday class" is the spec's own
 * example of a GOOD sentence and its figure has to survive.
 *
 * Not caught, and left alone rather than guessed at: the impersonal pronoun in "one can see" and
 * "one might argue".
 */
export function countFigures(tokens: string[]): number {
  let n = 0;
  tokens.forEach((token, i) => {
    if (!isFigureToken(token)) return;
    if (token.toLowerCase() === 'one') {
      const previous = tokens[i - 1]?.toLowerCase();
      const next = tokens[i + 1]?.toLowerCase();
      if (previous === 'no' || next === 'of') return;
    }
    n++;
  });
  return n;
}

/** Population variance. Zero for an empty list. */
export function variance(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}
