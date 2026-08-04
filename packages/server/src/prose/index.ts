import {
  buildDocIndex,
  countFigures,
  countProperNouns,
  splitParagraphs,
  splitSentences,
  styleWordHits,
  tokenize,
  variance,
} from './features.js';
import {
  BANNED_TRANSITIONS,
  PARTICIPLE_ALLOWLIST,
  STOCK_CLOSERS,
  STOCK_OPENERS,
  WATCH_TRANSITIONS,
} from './lexicon.js';

/**
 * The offline generic-prose analyzer's contract function.
 *
 * PURE by contract: zero I/O, zero network, no API key, no `node:` imports, and no import
 * outside this directory. `features.test.ts` walks the directory and asserts that against the
 * files on disk, this one included.
 *
 * WHAT THIS REPORTS, AND WHAT IT MUST NEVER CLAIM. It reports, it does not score: there is no
 * single number, and no paragraph is ever labelled "AI-written". The grounding is Kobak et al.,
 * Science Advances 2025 — 2024's excess vocabulary was 66% verbs and 14% adjectives (style
 * words), where the Covid-era excess vocabulary was 79% nouns (content words):
 *
 *   A real event changes the NOUNS in your prose. An LLM changes the VERBS and ADJECTIVES.
 *
 * So what is surfaced is prose that is stylistically busy and factually empty — paragraphs with
 * zero proper nouns and zero figures — so the applicant can replace vagueness with specifics
 * they already know. That is also just better grant writing, which is the point: a human writing
 * in a hurry produces the same signal, this does not defeat a detector, and it does not claim to.
 *
 * NOTHING HERE REWRITES THE USER'S TEXT. Every field is a count, or a span of the user's own
 * characters sliced back out of their own paragraph. Synonym-swapping and injected typos are
 * excluded by the spec on purpose and are not to be added.
 */

export interface ParagraphReport {
  index: number;
  text: string;
  styleWordHits: string[];
  properNounCount: number;
  figureCount: number;
  tricolonCount: number;
  trailingParticipialCount: number;
  stockTransitionHits: string[];
  verdict: 'specific' | 'thin' | 'generic';
}

export interface ProseReport {
  paragraphs: ParagraphReport[];
  sentenceLengthVariance: number;
  documentTricolonCount: number;
  stockOpenerHits: string[];
  stockCloserHits: string[];
  paragraphsWithNoProperNounOrFigure: number[];
}

/** Plan-local: the two densities the UI renders beside each paragraph. */
export interface ParagraphDensity {
  words: number;
  styleDensity: number;
  referentDensity: number;
}

const GENERIC_REFERENT_DENSITY = 1.5;
const SPECIFIC_REFERENT_DENSITY = 5;
const STYLE_DENSITY_ALARM = 4;
const EDGE_WINDOW = 120;

/**
 * Below this many words a paragraph is measured but NOT judged: its verdict is `thin` and it
 * never enters `paragraphsWithNoProperNounOrFigure`.
 *
 * A density over a handful of words is noise, and it is noise in BOTH directions, which is why
 * the gate has to suppress the flag and the `specific` verdict together:
 *   - "Statement of Need" standing alone as a heading scores one proper noun in three words —
 *     a referentDensity of 33 — and would be called `specific`, which is meaningless praise;
 *   - "Our approach" scores zero in two words — a referentDensity of 0 — and would be called
 *     `generic` AND flagged for having no proper noun, which is a false positive on a heading.
 * Zero false positives on good prose is the load-bearing property of this module, and a heading
 * is not bad prose. Twelve words sits comfortably above any heading and below any real
 * sentence-paragraph. Consumers that want to render shortness themselves can read
 * `paragraphDensities(p).words`; the `ParagraphReport` shape is frozen by the plan's contract
 * and gains no field for it.
 */
const MIN_JUDGED_WORDS = 12;

/**
 * An unfilled template slot, exactly as `fillTemplate` renders it:
 * `[TODO: <path> — <hint>]`, or `[TODO: <path>]` for a slot outside the 66-slot vocabulary.
 *
 * THE HINT IS NOT THE APPLICANT'S PROSE, AND COUNTING IT SILENCES THIS MODULE. The hints carry
 * worked examples — `[TODO: club.callsign — your club's FCC callsign, e.g. W8UM]` — so a raw
 * count over a filled template hands every gap a proper noun, a figure, or both, and donates
 * them to the very paragraph the gap was supposed to flag. A draft that is nothing but gaps
 * then scores as richly specific and the zero-referent check goes silent exactly when the prose
 * is emptiest. (`TODO` is itself all-caps, so even a bare `[TODO: club.callsign]` scores a
 * proper noun.) This is the same failure Task 12 found when `countFigures` counted the vague
 * quantifier "one" — the emptiness check switched off by emptiness, reached by a second path.
 *
 * DUPLICATED, NOT IMPORTED, AND THAT IS DELIBERATE. `stripTodoMarkers` and this exact scan
 * regex live in `templates/fill.ts`, and Task 14's export gate counts markers with the same
 * pattern. `prose/` cannot import it: the Global Constraint makes this directory pure, and
 * `features.test.ts` walks the directory and fails any import specifier that does not start
 * with `./` — while `templates/fill.js` reaches `templates/slots.js` and on to the bare
 * specifier `@grantspotter/core`. Importing it would trade a Global Constraint for a
 * three-line regex. Instead `index.test.ts` — which the purity walk excludes — imports the real
 * `stripTodoMarkers` and asserts this module agrees with it, so drift turns red.
 */
const TODO_MARKER_SCAN = (): RegExp => /\[TODO:[^\]]*\]/g;

/** Analysis-only. Nothing here produces applicant-facing text, so no gap is ever made to disappear. */
function stripTodoMarkers(markdown: string): string {
  return markdown.replace(TODO_MARKER_SCAN(), '');
}

/** Curly apostrophes and dashes normalised so phrase matching is stable. Length-preserving, so
 * a span found in the normalised text indexes the ORIGINAL text unchanged. */
function normalize(text: string): string {
  return text.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Which lexicon a phrase hit came from. Used to bucket the hit into its report field and, for
 * two hits covering the SAME span, to decide which field claims it.
 */
type HitCategory = 'banned' | 'opener' | 'closer' | 'watch';

interface PhraseHit {
  text: string;
  start: number;
  end: number;
  category: HitCategory;
}

/**
 * Precedence for two hits over an identical span. The only collision the lexicons actually
 * contain is `In conclusion`, which is both a WATCH_TRANSITION and a STOCK_CLOSER; the closer
 * wins because by the time overlaps are resolved the closer has already had to pass its
 * positional gate, so it only claims the phrase when the phrase really is closing something.
 */
const CATEGORY_PRECEDENCE: readonly HitCategory[] = ['banned', 'opener', 'closer', 'watch'];

/**
 * Every occurrence of every phrase, with the span it covers.
 *
 * Both boundaries are anchored. A leading `\b` alone lets `In addition` match the front of
 * "in additional funding", which is an ordinary English phrase and not a stock transition.
 */
function phraseHits(text: string, phrases: readonly string[], category: HitCategory): PhraseHit[] {
  const hay = normalize(text);
  const out: PhraseHit[] = [];
  for (const phrase of phrases) {
    const needle = normalize(phrase);
    const tail = /[A-Za-z0-9]$/.test(needle) ? '\\b' : '';
    const re = new RegExp(`\\b${escapeRe(needle)}${tail}`, 'gi');
    for (const m of hay.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + (m[0] as string).length;
      // Slice from the ORIGINAL text, so the report shows the user their own characters.
      out.push({ text: text.slice(start, end), start, end, category });
    }
  }
  return out;
}

/**
 * One phrase, one report. Hits are taken longest-first at each starting position, so
 * `for years to come` never fires as a second hit inside
 * `ensuring long-term impact for years to come`; a hit that overlaps an already-accepted hit is
 * dropped, which is also what keeps a phrase out of two report fields at once.
 *
 * Partial (non-nesting) overlap between two different phrases does not occur in the shipped
 * lexicons; if one is ever added, the earlier-starting phrase wins and the later one is dropped.
 */
function resolveOverlaps(hits: readonly PhraseHit[]): PhraseHit[] {
  const sorted = [...hits].sort(
    (a, b) =>
      a.start - b.start ||
      b.end - b.start - (a.end - a.start) ||
      CATEGORY_PRECEDENCE.indexOf(a.category) - CATEGORY_PRECEDENCE.indexOf(b.category),
  );
  const accepted: PhraseHit[] = [];
  let lastEnd = -1;
  for (const hit of sorted) {
    if (hit.start < lastEnd) continue;
    accepted.push(hit);
    lastEnd = hit.end;
  }
  return accepted;
}

/**
 * Blanks out the accepted phrase spans, preserving every other character AND the length, so the
 * style-word pass cannot count a word that has already been reported as part of a phrase.
 * `Notably` is a watch transition and a style adverb; the stock closer
 * `ensuring long-term impact for years to come` carries `ensure` and `impact`; the stock opener
 * `In today's rapidly evolving landscape` carries `landscape`. Counting those twice overstates
 * `styleWordHits.length`, which is a density numerator — so a double report moves the verdict.
 */
function maskSpans(text: string, spans: readonly PhraseHit[]): string {
  if (spans.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start) + ' '.repeat(span.end - span.start);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/** "educate, empower, and inspire". Items must be lowercase, so "Ann Arbor, Michigan, and Ohio" is not a tricolon. */
function countTricolons(text: string): number {
  const re = /\b([a-z][a-z-]+)\s*,\s*([a-z][a-z-]+)\s*,\s*(?:and|or)\s+([a-z][a-z-]+)\b/g;
  return [...normalize(text).matchAll(re)].length;
}

/**
 * ", ensuring that…" / ", allowing us to…" / ", thereby fostering…"
 *
 * Deliberately counted on the UNMASKED paragraph. A trailing participial is a structural
 * observation about a clause, not a lexicon hit, so the `, thereby ensuring…` that opens the
 * stock closer is a real trailing participial as well as part of a real stock closer. The two
 * findings are independent rules in the spec (≤1 trailing participial per paragraph; stock
 * closers banned) and suppressing one because the other fired would hide a defect, which is
 * the opposite failure from double-reporting the same count.
 */
function countTrailingParticipials(text: string): number {
  const re = /,\s+(?:thereby\s+|thus\s+|further\s+|hereby\s+)?([a-z]+ing)\b/g;
  let n = 0;
  for (const m of normalize(text).matchAll(re)) {
    if (!PARTICIPLE_ALLOWLIST.has(m[1] as string)) n++;
  }
  return n;
}

/**
 * `words` counts the applicant's own prose, with unfilled gaps removed — a hint is not writing
 * the applicant did, and leaving it in the denominator dilutes both densities toward silence.
 */
export function paragraphDensities(p: ParagraphReport): ParagraphDensity {
  const words = Math.max(tokenize(stripTodoMarkers(p.text)).length, 1);
  return {
    words,
    styleDensity: (p.styleWordHits.length / words) * 100,
    referentDensity: ((p.properNounCount + p.figureCount) / words) * 100,
  };
}

/**
 * Three-way, evaluated in order, and driven by DENSITIES rather than by counts — because
 * "reflected power" is a real ham-radio term that legitimately hits the style word `reflect`,
 * and prose thick with callsigns, model numbers and figures has earned its verbs.
 */
function verdictFor(d: ParagraphDensity, bannedHits: number, judged: boolean): ParagraphReport['verdict'] {
  if (!judged) return 'thin';
  if (d.referentDensity < GENERIC_REFERENT_DENSITY) return 'generic';
  if (d.styleDensity >= STYLE_DENSITY_ALARM && d.referentDensity < d.styleDensity) return 'generic';
  if (d.referentDensity >= SPECIFIC_REFERENT_DENSITY && d.styleDensity <= d.referentDensity && bannedHits === 0) {
    return 'specific';
  }
  return 'thin';
}

/**
 * Reports why a passage reads generic and where. It never emits a score and it
 * never claims a passage was machine-written: the measurable signal is
 * style-word density without referential counterweight, which a human writing
 * in a hurry produces just as readily as a model does.
 */
export function analyzeProse(text: string): ProseReport {
  // Paragraphs are split on the document AS WRITTEN, so indices line up with what the applicant
  // sees and a paragraph made only of gaps still appears in the report to be flagged.
  const paragraphs = splitParagraphs(text);
  // Once, on the WHOLE document: `countProperNouns` needs to know which tokens appear
  // capitalized mid-sentence ANYWHERE, and calling it on multi-paragraph text over-counts
  // because `splitSentences` does not break on a blank line. Gaps are stripped first, or a
  // hint's "e.g. Ann Arbor Amateur Radio Club" would teach the index four proper nouns the
  // applicant never wrote and license them at the head of every sentence in the draft.
  const doc = buildDocIndex(stripTodoMarkers(text));

  const stockOpenerHits: string[] = [];
  const stockCloserHits: string[] = [];
  const paragraphsWithNoProperNounOrFigure: number[] = [];
  const allSentenceLengths: number[] = [];

  const reports: ParagraphReport[] = paragraphs.map((paragraph, index) => {
    // Everything downstream measures `prose`, the paragraph minus its gaps. `text` on the report
    // stays the paragraph as written, markers and all, because the UI renders it back and the
    // applicant needs to see the hole.
    const prose = stripTodoMarkers(paragraph);
    const tokens = tokenize(prose);
    for (const sentence of splitSentences(prose)) {
      allSentenceLengths.push(tokenize(sentence).length);
    }

    // The minimum-length gate asks a STRUCTURAL question — is this a paragraph or a heading? —
    // so it is measured on the paragraph as written. A paragraph that is thirty words of
    // placeholder is a paragraph, and it is exactly the one that has to be flagged; only a
    // genuinely tiny block is a heading.
    const judged = tokenize(paragraph).length >= MIN_JUDGED_WORDS;

    // A stock opener only opens, and a stock closer only closes. The positional gate runs
    // BEFORE overlap resolution: a closer that fails its window is not a closer at all, so
    // `In conclusion` at the head of a long paragraph falls through to the transition bucket
    // rather than being claimed by the closer and then silently dropped.
    const candidates = [
      ...phraseHits(prose, BANNED_TRANSITIONS, 'banned'),
      ...phraseHits(prose, WATCH_TRANSITIONS, 'watch'),
      ...phraseHits(prose, STOCK_OPENERS, 'opener').filter((h) => h.start < EDGE_WINDOW),
      ...phraseHits(prose, STOCK_CLOSERS, 'closer').filter(
        (h) => h.end > prose.length - EDGE_WINDOW,
      ),
    ];
    const hits = resolveOverlaps(candidates);

    const bannedHits = hits.filter((h) => h.category === 'banned');
    const stockTransitionHits = hits
      .filter((h) => h.category === 'banned' || h.category === 'watch')
      .map((h) => h.text);
    for (const hit of hits) {
      if (hit.category === 'opener') stockOpenerHits.push(hit.text);
      if (hit.category === 'closer') stockCloserHits.push(hit.text);
    }

    const properNounCount = countProperNouns(prose, doc);
    const figureCount = countFigures(tokens);

    const partial = {
      index,
      text: paragraph,
      styleWordHits: styleWordHits(tokenize(maskSpans(prose, hits))),
      properNounCount,
      figureCount,
      tricolonCount: countTricolons(prose),
      trailingParticipialCount: countTrailingParticipials(prose),
      stockTransitionHits,
    };

    if (properNounCount === 0 && figureCount === 0 && judged) {
      paragraphsWithNoProperNounOrFigure.push(index);
    }

    const densities = paragraphDensities({ ...partial, verdict: 'thin' });
    return { ...partial, verdict: verdictFor(densities, bannedHits.length, judged) };
  });

  return {
    paragraphs: reports,
    sentenceLengthVariance: variance(allSentenceLengths),
    documentTricolonCount: reports.reduce((sum, p) => sum + p.tricolonCount, 0),
    stockOpenerHits,
    stockCloserHits,
    paragraphsWithNoProperNounOrFigure,
  };
}
