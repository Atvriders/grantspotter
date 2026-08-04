import { slotDef } from './slots.js';

export interface FilledTemplate {
  markdown: string;
  unresolvedSlots: string[];
}

/** Fresh regex per call: a shared /g regex carries lastIndex between callers. */
const slotRe = (): RegExp => /\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\}\}/g;

/**
 * The shape of a gap, and the shape Task 14's export gate counts
 * (`exportReadiness` refuses to release a draft while `openTodos > 0`).
 * Exported as a factory for the same lastIndex reason as `slotRe`.
 */
export const TODO_MARKER_SCAN = (): RegExp => /\[TODO:[^\]]*\]/g;

/**
 * Removes the gap markers and leaves the surrounding prose alone.
 *
 * This exists for the two readers that must NOT treat the inside of a gap as the applicant's own
 * words: the prose analyzer, which scores a paragraph on the proper nouns and figures it contains
 * (a hint's "e.g. W8UM" is an instruction, not a fact this club supplied), and the fact checklist,
 * which asks a human to confirm every assertion (an example must never appear on that list as
 * something to confirm). It is an ANALYSIS helper — nothing that produces applicant-facing text
 * may use it to make gaps disappear.
 */
export function stripTodoMarkers(markdown: string): string {
  return markdown.replace(TODO_MARKER_SCAN(), '');
}

export function extractSlots(markdown: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of markdown.matchAll(slotRe())) {
    const path = m[1] as string;
    if (!seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

function resolvePath(ctx: Record<string, unknown>, path: string): unknown {
  if (Object.prototype.hasOwnProperty.call(ctx, path)) return ctx[path];
  let cur: unknown = ctx;
  for (const seg of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Returns the rendered text, or undefined when the value counts as missing.
 * Objects never render: a template slot is a fact, and a fact is a scalar. A Date would arrive in
 * a grant application as `Fri Jan 15 2027 00:00:00 GMT-0500 (…)` and a function as its own source,
 * so both are gaps too. `0` and `false` are answers, not absences, and are rendered.
 */
export function renderSlotValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? undefined : t;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    const parts = value.map((v) => renderSlotValue(v)).filter((s): s is string => s !== undefined);
    return parts.length === 0 ? undefined : parts.join(', ');
  }
  return undefined;
}

/**
 * The marker for a missing fact. It is deliberately loud and deliberately empty
 * of content: a fabricated specific is worse than a visible gap, because the
 * funder holds the human applicant accountable for every number in the document.
 *
 * Three properties are load-bearing and are pinned by tests:
 *   - it opens with `[TODO:` and holds no `]`, so Task 14's export gate counts it exactly once;
 *   - it names the slot, so the applicant knows WHICH fact belongs in the hole;
 *   - it contains a space, which is what stops CommonMark reading `[text]({{slot}})` as a link
 *     once the slot is filled with a marker — a link destination may not contain a space unless it
 *     is wrapped in `<>`, so the gap renders as literal visible text instead of vanishing into a
 *     hyperlink target. That is why the marker also carries no `<`, `>` or invisible character:
 *     a gap has to still look like a gap after it is pasted into a word processor.
 *
 * @param hint overrides the vocabulary hint; used for the not-applicable state.
 */
export function todoFor(path: string, hint?: string): string {
  const text = hint ?? slotDef(path)?.hint;
  // The hint is only appended when it is genuinely a non-empty string. A blank hint would render
  // `[TODO: club.name — ]`, and a hint that is not a string at all renders whatever `String()` makes
  // of it: a `slotDef` backed by a plain object rather than a Map answers `slotDef('toString')` with
  // `Object.prototype.toString`, which lands in a grant application as
  // `[TODO: toString — function toString() { [native code] }]`. Caught by a scratch harness while
  // Task 2's real Map-backed vocabulary was still being written.
  if (typeof text !== 'string' || text.trim() === '') return `[TODO: ${path}]`;
  return `[TODO: ${path} — ${text.trim()}]`;
}

export function fillTemplate(templateMarkdown: string, ctx: Record<string, unknown>): FilledTemplate {
  const unresolvedSlots: string[] = [];
  const seen = new Set<string>();

  const markdown = templateMarkdown.replace(slotRe(), (_full: string, path: string) => {
    const rendered = renderSlotValue(resolvePath(ctx, path));
    if (rendered !== undefined) return rendered;
    if (!seen.has(path)) {
      seen.add(path);
      unresolvedSlots.push(path);
    }
    // The three states `describeSlotKnowledge` draws — known, unknown, not_applicable — reach this
    // function as two, and deliberately so: `buildSlotContext` is its `known` projection, so both
    // "nobody stated it" and "the applicant's own facts rule it out" arrive here as an absent key
    // and BOTH must leave a hole. A slot that does not apply still leaves a sentence built around a
    // fact that does not exist, and only a human can delete that sentence. Applicability is advice
    // for the slot form and the fact checklist; it is never authority to fill a gap silently.
    return todoFor(path);
  });

  return { markdown, unresolvedSlots };
}
