/**
 * Fact checklist.
 *
 * Every funder policy reviewed makes the human applicant — never the tool — accountable for every
 * number, claim and citation, and NIH/ORI name non-existent AI-generated references among the
 * misconduct patterns. So a draft cannot be exported until a person has explicitly confirmed every
 * assertion this module detects.
 *
 * THE FAILURE THIS EXISTS TO PREVENT, three times over, in this codebase:
 *   - a Yaesu "repeater must remain on the air for 12 months" obligation that appears ZERO times
 *     in the funder's captured page — it lived in a hand-written fixture and was repeated as fact;
 *   - 148 records asserting "no cost share required" when no funder had said so in words;
 *   - 345 awards advertising a stranger's Facebook page as the place to apply.
 * Every one was a plausible value that nobody checked. This module's job is to make "nobody
 * checked" impossible inside the applicant's own document.
 *
 * TWO RULES SHAPE EVERY DECISION HERE.
 *   1. SURFACE, NEVER ASSERT. Nothing here marks anything confirmed, and nothing here decides a
 *      claim is true. `origin` says who a value MATCHES, not that it is right — a value read off
 *      a funder's page still has to be checked against that page by the person signing.
 *   2. A GAP IS NOT A FACT. Text inside a `[TODO: …]` marker is a hole the applicant must fill,
 *      and the vocabulary hints inside those markers carry fact-shaped examples (`e.g. W8UM`,
 *      `e.g. 1909`). Listing one as an assertion awaiting confirmation would put an invented
 *      specific on the checklist — the exact defect above. Markers are blanked before matching and
 *      counted separately as `openTodos`, which block export on their own.
 *
 * Completeness is the point: an assertion that never reaches the checklist is the failure mode.
 * The matchers therefore err toward over-inclusion — a false positive costs one checkbox, a false
 * negative costs the applicant's signature on something nobody read.
 *
 * WHAT THIS CANNOT ENUMERATE, stated here rather than discovered later. Every class below is a
 * factual assertion a funder could check and this module does NOT list as its own item. A
 * checklist that looked complete and was not would be worse than no checklist, so:
 *   - VERBAL CLAIMS WITH NO TOKEN IN THEM. "We are the only collegiate club in the state", "every
 *     member is licensed", "attendance rose after we bought the radio" — superlatives, universals,
 *     causal and comparative claims. They have no lexical shape to match, and a keyword list
 *     ("only", "first", "all") would fire on ordinary prose while still missing most of them,
 *     which is how a subset gets mistaken for the whole. `analyzeProse` flags a paragraph carrying
 *     no proper noun and no figure, which is the closest signal the offline tools have; the
 *     applicant, not this module, is the reader of last resort.
 *   - A BARE NUMBERED REFERENCE — "[3]", "(see 12)". It is listed as a figure, so it is on the
 *     checklist, but it is not identified as a citation and the work it cites is not named.
 *   - AN AUTHOR-YEAR CITATION WITHOUT PARENTHESES OR "et al." — "Smith & Jones, 2024" arrives as
 *     two names and a year rather than as one citation.
 *   - A ROLE ATTACHED TO A NAME. "Elena Ruiz, faculty advisor" lists the person; the claim that
 *     she is the faculty advisor is ordinary lowercase prose.
 *   - ANYTHING OUTSIDE THE TEXT IT IS GIVEN: an attached budget, a letter of support, a figure in
 *     an image.
 *
 * Pure: no I/O, no network, no imports outside `prose/` (features.test.ts asserts that on disk).
 */

import { buildDocIndex, isFigureToken } from './features.js';
import { NUMBER_WORDS } from './lexicon.js';

export type FactKind =
  | 'citation'
  | 'url'
  | 'contact'
  | 'money'
  | 'percent'
  | 'date'
  | 'callsign'
  | 'name'
  | 'entity'
  | 'figure';

/**
 * Who stated the value this text matches. The first three mirror `SlotOrigin` in
 * `templates/slots.ts` — mirrored rather than imported because `prose/` is import-sealed, and
 * pinned against the real thing by facts.test.ts.
 */
export type FactOrigin = 'profile' | 'program' | 'answer' | 'unattributed';

export interface FactAssertion {
  /** Stable across re-extractions of identical text: `${kind}:${start}`. */
  id: string;
  kind: FactKind;
  text: string;
  start: number;
  end: number;
  /** Roughly ±60 characters, whitespace collapsed to a single line. */
  context: string;
  /**
   * A hash of the kind and the text. `id` is positional, so an edit that swaps one value for
   * another of the same width reuses it; the fingerprint moves with the words instead.
   */
  fingerprint: string;
}

export interface FactConfirmation {
  confirmed: boolean;
  note: string;
  /**
   * The fingerprint of the fact that was confirmed, if the caller stored one. When it disagrees
   * with the fact now at that id, the confirmation does not apply. Optional so that a caller which
   * stores only `{confirmed, note}` keeps working — but a caller that persists confirmations
   * across edits SHOULD store it.
   */
  fingerprint?: string;
}

/** A value somebody stated, and who stated it. Built from `describeSlotKnowledge`. */
export interface FactSource {
  /** Dotted slot path, e.g. `club.callsign`. */
  slot: string;
  origin: 'profile' | 'program' | 'answer';
  /** The value as it would be rendered into the document. */
  value: string;
}

/**
 * `Omit<FactConfirmation, 'fingerprint'>` because both halves name the same field and only one of
 * them may leave it optional: on a STORED confirmation the fingerprint is optional (a caller that
 * has not been taught to persist it still works), while on a live item it is always known, since
 * the item was just extracted from the text. An item is still assignable to `FactConfirmation`.
 */
export interface FactChecklistItem extends FactAssertion, Omit<FactConfirmation, 'fingerprint'> {
  origin: FactOrigin;
  /** Every slot whose stated value covers this span, sorted. Empty when nothing accounts for it. */
  slots: string[];
  /** One sentence a reviewer can read: who said so, and what confirming it means. */
  provenance: string;
  /** A stored confirmation was discarded because the text under it changed. */
  staleConfirmation: boolean;
}

export interface ExportReadiness {
  ready: boolean;
  unconfirmed: number;
  openTodos: number;
  /**
   * Occurrences of a raw, unfilled `{{slot.path}}` placeholder — the shape `templates/fill.ts`
   * leaves behind when a slot has no value AND was never routed through `fillTemplate` at all, as
   * when an applicant pastes template markdown straight into the draft editor. Counted the same
   * way `openTodos` is: once per occurrence, not deduplicated, because two unfilled placeholders
   * are two things to go fix even when they name the same slot.
   */
  rawSlots: number;
  /** Every distinct slot path found by `rawSlots`, sorted — what the export-blocked message names. */
  rawSlotPaths: string[];
  items: FactChecklistItem[];
}

const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December|' +
  'Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';

/**
 * The gap marker `fill.ts` writes, restated because `prose/` may not import it. facts.test.ts
 * pins the two against each other, so a change to `TODO_MARKER_SCAN` that is not mirrored here
 * turns red rather than quietly letting hint text onto the checklist.
 */
const TODO_MARKER = /\[TODO:[^\]]*\]/g;

/**
 * A raw, unfilled template placeholder — `{{club.callsign}}` reaching the checklist because the
 * text never went through `fillTemplate` at all, as when an applicant pastes template markdown
 * straight into the draft editor. `fillTemplate` replaces every slot it can resolve and leaves
 * only the ones it cannot as `[TODO: …]`; a literal `{{…}}` in a draft's body means the pipeline
 * that writes `[TODO: …]` never ran, so `TODO_MARKER` alone cannot see the gap.
 *
 * Restated from `templates/fill.ts`'s `slotRe` — for the same reason `TODO_MARKER` restates
 * `TODO_MARKER_SCAN`, `prose/` may not import outside itself — and pinned against the real thing
 * by facts.test.ts via the exported `extractSlots`, so the two cannot drift silently apart.
 *
 * THE SHAPE IS DELIBERATE, and NARROWER than `slotRe` in one respect. This is prose an applicant
 * writes freely, and a bare `\{\{[^}]*\}\}` scan would also catch a doubled brace in mathematics
 * or in a quoted code sample. `slotRe` itself would accept a single bare segment — `{{x}}` — but
 * every one of Task 2's 66 real slots is a DOTTED path (`club.callsign`, `project.awardAmount`);
 * none is a single word. So this requires at least one `.segment`, which `slotRe` treats as
 * optional: `{{x}}` in a maths aside is left alone, `{{club.callsign}}` from the real vocabulary
 * is not. Matching the vocabulary's actual shape, rather than the parser's most permissive one,
 * is what keeps a legitimate document from losing a checkbox to this matcher.
 */
const RAW_SLOT_MARKER = /\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\s*\}\}/g;

/** All-caps organization names: `ARRL`, `ARDC`, `NASA`, `IEEE`. Two characters minimum. */
const ACRONYM_RE = /^[A-Z][A-Z0-9-]+$/;
/** Model designations: `IC-7300`, `DR-2X`, `FT991A`. Mirrors `MODEL_RE` in features.ts. */
const MODEL_RE = /^[A-Z]{1,4}-?\d{2,5}[A-Z]?$/;

interface MatchContext {
  /** The text being scanned, with gap markers blanked. */
  scan: string;
  start: number;
  end: number;
  /** Tokens seen capitalized mid-sentence anywhere in the draft, from Task 12. */
  properNouns: ReadonlySet<string>;
}

interface Matcher {
  kind: FactKind;
  re: RegExp;
  /** Trailing sentence punctuation is not part of a URL or a DOI. */
  trimTrailing?: boolean;
  accept?: (matched: string, ctx: MatchContext) => boolean;
}

/** The word before the span, lowercased — for the two idioms where "one" carries no scale. */
function wordBefore(scan: string, start: number): string | undefined {
  return /([A-Za-z]+)[^A-Za-z]*$/.exec(scan.slice(Math.max(0, start - 32), start))?.[1]?.toLowerCase();
}

function wordAfter(scan: string, end: number): string | undefined {
  return /^[^A-Za-z]*([A-Za-z]+)/.exec(scan.slice(end, end + 32))?.[1]?.toLowerCase();
}

/**
 * Order is priority: an earlier matcher wins any overlapping span. So a DOI is a citation rather
 * than a URL, `$1,450` is money rather than a bare figure, and `IC-7300` is a model designation
 * rather than the number 7300.
 *
 * Every separator inside a pattern is `[ \t]`, never `\s`. A span that swallowed a newline would
 * put a line break inside a checklist item and inside its own single-line context.
 */
const MATCHERS: readonly Matcher[] = [
  { kind: 'citation', re: /\b(?:doi:[ \t]*|https?:\/\/doi\.org\/)10\.\d{4,9}\/[^\s,;)]+/gi, trimTrailing: true },
  // `(?:\(\d{4}\)|\d{4})` and not `\(?\d{4}\)?`: the optional-either-side form matches a closing
  // parenthesis it never opened, so the extremely common "(Kobak et al., 2025)" was listed as
  // `Kobak et al., 2025)` — a citation with a stray bracket, which is what a reference invented by
  // a model looks like. Balanced or bare, never half.
  { kind: 'citation', re: /\b[A-Z][A-Za-z'-]+[ \t]+et al\.,?[ \t]*(?:\(\d{4}\)|\d{4})/g },
  { kind: 'citation', re: /\([A-Z][A-Za-z'-]+(?:[ \t]+(?:and|&)[ \t]+[A-Z][A-Za-z'-]+)?,[ \t]*\d{4}\)/g },
  { kind: 'url', re: /\bhttps?:\/\/[^\s<>"')\]]+/gi, trimTrailing: true },
  { kind: 'url', re: /\bwww\.[A-Za-z0-9-]+\.[A-Za-z]{2,}(?:\/[^\s<>"')\]]*)?/gi, trimTrailing: true },
  // Where to apply is a fact, and three of the funder routes in this corpus publish an address or
  // a phone number rather than a URL. `345 awards linking a stranger's Facebook page` is what an
  // unchecked where-to-apply looks like.
  { kind: 'contact', re: /\b(?:mailto:)?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: 'contact', re: /(?:\+1[ .-]?)?(?:\(\d{3}\)[ .-]?|\b\d{3}[ .-])\d{3}[ .-]?\d{4}\b/g },
  // `\d(?:[\d,]*\d)?` rather than `\d[\d,]*`: the greedy character class ends happily on the
  // COMMA, so "Room 214, Engineering Building" listed the amount as `214,` and "$1,450, plus" as
  // `$1,450,`. The item then reads as a value nobody wrote, and it changes fingerprint the moment
  // a comma is added or removed elsewhere in the sentence.
  { kind: 'money', re: /\$[ ]?\d(?:[\d,]*\d)?(?:\.\d{2})?(?:[ ]?(?:million|billion|k|K))?/g },
  { kind: 'percent', re: /\b\d(?:[\d,]*\d)?(?:\.\d+)?[ ]?%/g },
  // A clock time and a nine-digit EIN are single facts made of digits and punctuation, and the
  // bare-number matcher shreds both: "Saturdays 10:00-12:00" listed `10`, `00`, `12`, `00` — two
  // of them the same meaningless checkbox — and the EIN `38-1234567` listed `38` and `1234567`.
  // A checklist line has to be a thing the applicant can look up.
  { kind: 'date', re: /\b\d{1,2}:\d{2}(?::\d{2})?(?:[ ]?[ap]\.?m\.?)?/gi },
  { kind: 'figure', re: /\b\d{2}-\d{7}\b/g },
  { kind: 'date', re: new RegExp(`\\b(?:${MONTHS})\\.?[ \\t]+\\d{1,2}(?:,[ \\t]*\\d{4})?`, 'g') },
  { kind: 'date', re: /\b\d{4}-\d{2}-\d{2}\b/g },
  { kind: 'date', re: /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g },
  { kind: 'date', re: /\b(?:19|20)\d{2}\b/g },
  { kind: 'callsign', re: /\b[A-Z]{1,2}\d{1,2}[A-Z]{1,4}\b/g },
  { kind: 'name', re: /\b[A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)+\b/g },
  // Single-token named things: `ARRL`, `Icom`, `IC-7300`, `GP-3`, a surname after `Dr.`. The
  // multi-word `name` matcher above cannot see any of them, and a model number is precisely the
  // kind of specific a reviewer checks. Evidence is required — an ordinary sentence-opening
  // capital is not a named thing — and it is Task 12's: all-caps, model-shaped, or seen
  // capitalized mid-sentence somewhere in this draft.
  {
    kind: 'entity',
    re: /\b[A-Z][A-Za-z0-9'’-]*\b/g,
    accept: (matched, ctx) =>
      !isFigureToken(matched) &&
      (ACRONYM_RE.test(matched) || MODEL_RE.test(matched) || ctx.properNouns.has(matched)),
  },
  { kind: 'figure', re: /(?<![\w$.,])\d(?:[\d,]*\d)?(?:\.\d+)?(?![\w%])/g },
  // A count written as a word is still a count: "four sessions" is as checkable as "4 sessions",
  // and a digit-only matcher lists neither. The exception is Task 12's, for the same reason it
  // exists there: in "no one is left behind" and "one of the goals", "one" carries no scale at
  // all, and listing it hands the applicant a checkbox over nothing.
  {
    kind: 'figure',
    re: /\b[A-Za-z]+\b/g,
    accept: (matched, ctx) => {
      if (!NUMBER_WORDS.has(matched.toLowerCase())) return false;
      if (matched.toLowerCase() !== 'one') return true;
      return wordBefore(ctx.scan, ctx.start) !== 'no' && wordAfter(ctx.scan, ctx.end) !== 'of';
    },
  },
];

const TRAILING_PUNCTUATION = '.,;:';

/** FNV-1a. A hash, not a checksum: it only has to move when the words move. */
function fingerprintOf(kind: FactKind, text: string): string {
  const input = `${kind}|${text}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Gap markers become runs of spaces of the same length, so offsets still point into the original
 * text while nothing inside a marker can match. Blanking rather than deleting is what keeps
 * `text.slice(start, end) === fact.text` true for the caller.
 *
 * Both gap shapes are blanked here, `[TODO: …]` and raw `{{slot.path}}`: a gap is a gap
 * regardless of which pipeline stage left it unfilled, and neither one's contents — a hint's
 * `e.g. W8UM`, or a dotted path that happens to look like a proper noun — is prose the applicant
 * wrote.
 */
function blankGapMarkers(text: string): string {
  return text
    .replace(TODO_MARKER, (marker) => ' '.repeat(marker.length))
    .replace(RAW_SLOT_MARKER, (marker) => ' '.repeat(marker.length));
}

/**
 * Context is built from the ORIGINAL text — the applicant should see the neighbouring gap if there
 * is one — with whitespace collapsed on either side of the match and the match itself left
 * untouched, so that `context` always contains `text` and never contains a newline.
 */
function contextAround(text: string, start: number, end: number): string {
  const before = text.slice(Math.max(0, start - 60), start).replace(/\s+/g, ' ');
  const after = text.slice(end, Math.min(text.length, end + 60)).replace(/\s+/g, ' ');
  return `${before}${text.slice(start, end)}${after}`.trim();
}

export function extractFactAssertions(text: string): FactAssertion[] {
  const scan = blankGapMarkers(text);
  const properNouns = buildDocIndex(scan).midSentenceCapitalized;
  const taken: Array<{ start: number; end: number }> = [];
  const out: FactAssertion[] = [];

  const overlaps = (start: number, end: number): boolean =>
    taken.some((t) => start < t.end && end > t.start);

  for (const matcher of MATCHERS) {
    for (const m of scan.matchAll(matcher.re)) {
      const start = m.index ?? 0;
      let end = start + (m[0] as string).length;
      if (matcher.trimTrailing === true) {
        while (end > start && TRAILING_PUNCTUATION.includes(scan[end - 1] as string)) end--;
      }
      const matched = scan.slice(start, end);
      if (matched.length === 0) continue;
      // A span that reaches into a blanked gap is not a span of the real document.
      if (text.slice(start, end) !== matched) continue;
      if (overlaps(start, end)) continue;
      if (matcher.accept !== undefined && !matcher.accept(matched, { scan, start, end, properNouns })) {
        continue;
      }
      taken.push({ start, end });
      out.push({
        id: `${matcher.kind}:${start}`,
        kind: matcher.kind,
        text: matched,
        start,
        end,
        context: contextAround(text, start, end),
        fingerprint: fingerprintOf(matcher.kind, matched),
      });
    }
  }

  return out.sort((a, b) => a.start - b.start);
}

/**
 * The `known` half of a `SlotKnowledgeMap`, as sources.
 *
 * `renderValue` is injected rather than reimplemented: it is `renderSlotValue` from
 * `templates/fill.ts`, the same function that decided how the value appears in the document. A
 * second copy of that logic here would drift, and a drifted copy would attribute a value to the
 * wrong slot or fail to attribute it at all.
 *
 * The parameter type is structural so that `prose/` need not import `templates/slots.ts`: a
 * `SlotKnowledgeMap` satisfies it exactly.
 */
export function factSourcesFromKnowledge(
  knowledge: Record<string, { state: string; value?: unknown; origin?: string }>,
  renderValue: (value: unknown) => string | undefined,
): FactSource[] {
  const out: FactSource[] = [];
  for (const [slot, entry] of Object.entries(knowledge)) {
    if (entry.state !== 'known') continue;
    const origin = entry.origin;
    if (origin !== 'profile' && origin !== 'program' && origin !== 'answer') continue;
    const value = renderValue(entry.value);
    if (value === undefined || value.trim() === '') continue;
    out.push({ slot, origin, value });
  }
  return out.sort((a, b) => a.slot.localeCompare(b.slot));
}

function isWordCharacter(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/** Every whole-word occurrence of a stated value in the draft. */
function occurrences(text: string, value: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  if (value.length === 0) return spans;
  let from = 0;
  for (;;) {
    const at = text.indexOf(value, from);
    if (at === -1) return spans;
    const end = at + value.length;
    const boundedLeft = !isWordCharacter(text[at - 1]) || !isWordCharacter(value[0]);
    const boundedRight = !isWordCharacter(text[end]) || !isWordCharacter(value[value.length - 1]);
    if (boundedLeft && boundedRight) spans.push({ start: at, end });
    from = at + 1;
  }
}

function provenanceSentence(origin: FactOrigin, slots: string[]): string {
  const where = slots.join(', ');
  switch (origin) {
    case 'answer':
      return `Matches an answer you typed (${where}). Confirm it is still what you mean to promise.`;
    case 'profile':
      return `Matches your saved profile (${where}). Confirm the profile itself is current — this tool copied it, it did not check it.`;
    case 'program':
      return `Matches the funder's opportunity record (${where}). Confirm it against the funder's own published page before you sign.`;
    default:
      return slots.length > 0
        ? `Matches more than one stated value (${where}), from different sources, so this tool cannot say which one it came from. Confirm it yourself.`
        : 'Not traceable to any stated value — this is prose you or a model wrote. Confirm it against a source you can point to.';
  }
}

/**
 * Attribution, deliberately unwilling to guess.
 *
 * A fact inside exactly one stated value gets that value's origin. A fact inside two stated values
 * that disagree about who said so gets `unattributed` and a sentence naming both, because
 * asserting the wrong origin is the same class of error as asserting the wrong fact.
 */
function attribute(
  fact: FactAssertion,
  spans: ReadonlyArray<{ start: number; end: number; source: FactSource }>,
): { origin: FactOrigin; slots: string[]; provenance: string } {
  const covering = spans.filter((s) => fact.start >= s.start && fact.end <= s.end);
  const slots = [...new Set(covering.map((c) => c.source.slot))].sort();
  if (covering.length === 0) {
    return { origin: 'unattributed', slots: [], provenance: provenanceSentence('unattributed', []) };
  }
  const origins = new Set(covering.map((c) => c.source.origin));
  const origin: FactOrigin = origins.size === 1 ? ([...origins][0] as FactOrigin) : 'unattributed';
  return { origin, slots, provenance: provenanceSentence(origin, slots) };
}

export function buildFactChecklist(
  text: string,
  confirmations: Record<string, FactConfirmation> = {},
  sources: readonly FactSource[] = [],
): FactChecklistItem[] {
  const spans = sources.flatMap((source) =>
    occurrences(text, source.value).map((span) => ({ ...span, source })),
  );

  return extractFactAssertions(text).map((fact) => {
    const stored = confirmations[fact.id];
    // A confirmation that names a different fact is not a confirmation of this one. The note is
    // kept: the applicant wrote it, and it is evidence about the item even after the value moved.
    const stale =
      stored !== undefined &&
      stored.fingerprint !== undefined &&
      stored.fingerprint !== fact.fingerprint;
    return {
      ...fact,
      ...attribute(fact, spans),
      confirmed: stale ? false : stored?.confirmed === true,
      note: stored?.note ?? '',
      staleConfirmation: stale,
    };
  });
}

export function unconfirmedCount(items: FactChecklistItem[]): number {
  return items.filter((i) => !i.confirmed).length;
}

/**
 * A leftover `[TODO: …]` marker blocks export just as an unconfirmed fact does — and it is counted
 * rather than confirmed, because a hole is not an assertion a person can affirm.
 *
 * A raw `{{slot.path}}` placeholder blocks it the same way, for the same reason: it is a hole,
 * just one left by a different route. `fillTemplate` never ran over this text — or the applicant
 * pasted template markdown into the editor after it did — so no `[TODO: …]` marker was ever
 * written to say so. Left uncounted, it is arguably the worse gap of the two: `[TODO: club.callsign
 * — your club's FCC callsign, e.g. W8UM]` at least reads as unfinished, where `{{club.callsign}}`
 * can look like a stray formatting artefact the reader is meant to ignore.
 */
export function exportReadiness(
  text: string,
  confirmations: Record<string, FactConfirmation> = {},
  sources: readonly FactSource[] = [],
): ExportReadiness {
  const items = buildFactChecklist(text, confirmations, sources);
  const unconfirmed = unconfirmedCount(items);
  const openTodos = [...text.matchAll(TODO_MARKER)].length;
  const rawSlotMatches = [...text.matchAll(RAW_SLOT_MARKER)];
  const rawSlots = rawSlotMatches.length;
  const rawSlotPaths = [...new Set(rawSlotMatches.map((m) => m[1] as string))].sort();
  return {
    ready: unconfirmed === 0 && openTodos === 0 && rawSlots === 0,
    unconfirmed,
    openTodos,
    rawSlots,
    rawSlotPaths,
    items,
  };
}
