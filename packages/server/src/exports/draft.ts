/**
 * THE DRAFT DOCUMENT MODEL — the shape an application draft takes on its way out of the product.
 *
 * PLAN-LOCAL TYPES. The CONTRACT defines no application-draft shape; these live in the exports
 * package and are consumed only by `docx.ts` and `zip.ts`.
 *
 * This module answers one question — what did the applicant write, block by block — so that the
 * DOCX writer, the Markdown writer and the ZIP packet cannot answer it three different ways. The
 * two things it will not do are the whole reason it exists:
 *
 *   1. IT NEVER CLOSES A GAP. `[TODO: …]` markers travel through untouched, and `docx.ts` renders
 *      them bold, red and highlighted. `templates/fill.ts` exports `stripTodoMarkers`, and its own
 *      doc comment says it is an ANALYSIS helper that nothing applicant-facing may use to make
 *      gaps disappear. Nothing here imports it. A marker carries an EXAMPLE ("e.g. W8UM"); strip
 *      the brackets and that example is left sitting in a sentence as though the applicant had
 *      supplied it, which is the fabricated-specific pattern NIH/ORI enumerate as misconduct.
 *   2. IT NEVER REPEATS A BLOCKLISTED ADDRESS. `redactBlockedLinks` is the product's existing
 *      answer to `farweb.org` — a hijacked ham-radio domain that now redirects to a gambling site
 *      and is still linked from live ARRL and QCWA pages — and this is its second call site.
 */
// The redaction primitive, imported rather than restated. `api/notify.ts` owns it because Plan 3
// needed it first; it reads `BLOCKED_HOSTS` from `fetcher/blocklist.ts`, which is the only list
// with teeth and is deliberately not configurable. A second copy here would be a second thing to
// forget, which is precisely how the suppression boundary in this repo leaked four times.
import { redactBlockedLinks } from '../api/notify.js';

export type DraftBlock =
  | { kind: 'p'; text: string }
  | { kind: 'bullet'; items: string[] }
  | { kind: 'ordered'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'todo'; text: string };

export interface DraftSection {
  heading: string;
  blocks: DraftBlock[];
}

export interface DraftDocument {
  title: string;
  subtitle?: string;
  sections: DraftSection[];
  factChecklist: string[];
  disclosure?: string;
  provenanceNote: string;
}

export interface DraftMeta {
  title: string;
  subtitle?: string;
  factChecklist?: string[];
  disclosure?: string;
  provenanceNote: string;
}

/**
 * WHAT THE CHECKLIST CANNOT COVER, said out loud in the artefact itself.
 *
 * `extractFactAssertions` finds the specifics a funder can look up: figures, dates, callsigns,
 * URLs, citations. It cannot find a claim made entirely in words, and a document that presented a
 * ticked list as a verified draft would be making exactly the assertion the list cannot support.
 *
 * PARITY: `packages/web/src/components/FactChecklist.tsx` says the same thing on screen, and
 * `prose/facts.ts`'s header enumerates the same four classes. Web may not import server, so the
 * sentence is restated; if the two ever drift, `facts.ts` is the one that describes the extractor.
 */
export const CHECKLIST_SCOPE_NOTE =
  'This lists the specifics a funder can look up. It cannot list a claim made only in words — a ' +
  'superlative such as “the only collegiate club in the state”, a universal such as “every member ' +
  'is licensed”, a causal claim such as “attendance rose after we bought the radio”, or the job ' +
  'title in “Elena Ruiz, faculty advisor”. Those are yours to check; a ticked list here is not a ' +
  'checked draft.';

/** Who the funder holds responsible. Every funder AI policy reviewed answers: the human. */
export const CHECKLIST_ACCOUNTABILITY_NOTE =
  'Every funder policy reviewed makes the human applicant, never the tool, accountable for each ' +
  'number, claim and citation below. Confirm every one before submitting.';

/** What a `[TODO: …]` block means, printed beside the first one so a reader cannot mistake it. */
export const TODO_LEGEND =
  'Highlighted text below is a GAP, not an answer. The words inside the brackets are the question ' +
  'and an example of the KIND of answer wanted — never a fact about this applicant. A funder that ' +
  'receives one has received a sentence that asserts nothing.';

const HEADING_LINE = /^(#{1,6})\s+(.*)$/;
const TODO_LINE = /^\s*\[TODO:[^\]]*\]\s*$/;
const BULLET_LINE = /^\s*[-*]\s+(.*)$/;
const ORDERED_LINE = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_LINE = /^\s*>\s?(.*)$/;
const TABLE_LINE = /^\s*\|/;
const TABLE_RULE_CELL = /^:?-+:?$/;

/** The gap marker, restated from `templates/fill.ts`'s `TODO_MARKER_SCAN` (server may not import
 * across that boundary in the direction that would matter here). Fresh per call: a shared /g
 * regex carries `lastIndex` between callers. */
export const TODO_SCAN = (): RegExp => /\[TODO:[^\]]*\]/g;

/** One piece of a line: ordinary prose, or a gap that must be rendered loudly. */
export interface DraftRun {
  text: string;
  todo: boolean;
}

/**
 * Splits a line into prose and gaps. `fillTemplate` substitutes a slot IN PLACE, so the common
 * gap is mid-sentence — "The station operates from [TODO: club.venue — …] on campus." A renderer
 * that only knew whole-line gaps would set that sentence in body type and the applicant would
 * send it.
 */
export function splitRuns(text: string): DraftRun[] {
  const out: DraftRun[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TODO_SCAN())) {
    const at = match.index ?? 0;
    if (at > cursor) out.push({ text: text.slice(cursor, at), todo: false });
    out.push({ text: match[0], todo: true });
    cursor = at + match[0].length;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), todo: false });
  return out.length > 0 ? out : [{ text, todo: false }];
}

/** True when this line, or any line in this block, holds a gap. */
export function hasTodo(text: string): boolean {
  return TODO_SCAN().test(text);
}

type Pending =
  | { kind: 'p'; lines: string[] }
  | { kind: 'bullet'; items: string[] }
  | { kind: 'ordered'; items: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'table'; rows: string[][] }
  | null;

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * The heading level that divides this document into sections is the SHALLOWEST one it uses, not
 * `#`. Every template under `content/` — 120 headings across 13 components and every funder
 * overlay — is written with `##` and not one `#`. A splitter hard-wired to `#` turns a filled
 * template into a single untitled section whose section titles have silently become body
 * paragraphs, which is the entire document.
 */
function sectionLevel(lines: readonly string[]): number {
  let shallowest = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const m = HEADING_LINE.exec(line);
    if (m) shallowest = Math.min(shallowest, (m[1] as string).length);
  }
  return shallowest;
}

export function markdownToDraft(markdown: string, meta: DraftMeta): DraftDocument {
  // ONE redaction, at the boundary where stored text becomes a document that leaves the building,
  // so every downstream format inherits it and none of them has to remember.
  const lines = redactBlockedLinks(markdown).split(/\r?\n/);
  const splitAt = sectionLevel(lines);

  const sections: DraftSection[] = [];
  let current: DraftSection = { heading: '', blocks: [] };
  let pending: Pending = null;

  const flush = (): void => {
    if (pending === null) return;
    if (pending.kind === 'p') {
      const text = pending.lines.join(' ').trim();
      if (text !== '') current.blocks.push({ kind: 'p', text });
    } else if (pending.kind === 'bullet') {
      current.blocks.push({ kind: 'bullet', items: pending.items });
    } else if (pending.kind === 'ordered') {
      current.blocks.push({ kind: 'ordered', items: pending.items });
    } else if (pending.kind === 'quote') {
      current.blocks.push({ kind: 'quote', lines: pending.lines });
    } else {
      // The alignment rule (`|---|---|`) is punctuation, not data. Kept, it prints as a row of
      // dashes in Word; dropped here, the table is a table.
      const rows = pending.rows.filter((row) => !row.every((cell) => TABLE_RULE_CELL.test(cell)));
      if (rows.length > 0) current.blocks.push({ kind: 'table', rows });
    }
    pending = null;
  };

  const closeSection = (): void => {
    flush();
    if (current.heading !== '' || current.blocks.length > 0) sections.push(current);
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');

    const heading = HEADING_LINE.exec(line);
    if (heading) {
      const level = (heading[1] as string).length;
      const text = (heading[2] as string).trim();
      if (level <= splitAt) {
        closeSection();
        current = { heading: text, blocks: [] };
      } else {
        flush();
        current.blocks.push({ kind: 'heading', level, text });
      }
      continue;
    }

    if (line.trim() === '') {
      flush();
      continue;
    }

    if (TABLE_LINE.test(line)) {
      if (pending?.kind !== 'table') {
        flush();
        pending = { kind: 'table', rows: [] };
      }
      pending.rows.push(tableCells(line));
      continue;
    }

    // A whole-line gap becomes its own block so the whole paragraph can be set loudly. An INLINE
    // gap stays in its sentence and is split into runs by the renderer; see `splitRuns`.
    if (TODO_LINE.test(line)) {
      flush();
      current.blocks.push({ kind: 'todo', text: line.trim() });
      continue;
    }

    const quote = QUOTE_LINE.exec(line);
    if (quote) {
      if (pending?.kind !== 'quote') {
        flush();
        pending = { kind: 'quote', lines: [] };
      }
      pending.lines.push((quote[1] as string).trim());
      continue;
    }

    const bullet = BULLET_LINE.exec(line);
    if (bullet) {
      if (pending?.kind !== 'bullet') {
        flush();
        pending = { kind: 'bullet', items: [] };
      }
      pending.items.push((bullet[1] as string).trim());
      continue;
    }

    const ordered = ORDERED_LINE.exec(line);
    if (ordered) {
      if (pending?.kind !== 'ordered') {
        flush();
        pending = { kind: 'ordered', items: [] };
      }
      pending.items.push((ordered[1] as string).trim());
      continue;
    }

    if (pending?.kind !== 'p') {
      flush();
      pending = { kind: 'p', lines: [] };
    }
    pending.lines.push(line.trim());
  }
  closeSection();

  const document: DraftDocument = {
    title: redactBlockedLinks(meta.title),
    sections,
    factChecklist: (meta.factChecklist ?? []).map(redactBlockedLinks),
    provenanceNote: redactBlockedLinks(meta.provenanceNote),
  };
  if (meta.subtitle !== undefined) document.subtitle = redactBlockedLinks(meta.subtitle);
  if (meta.disclosure !== undefined) document.disclosure = redactBlockedLinks(meta.disclosure);
  return document;
}

/** True when any block anywhere in the draft still holds a gap. */
export function draftHasTodo(draft: DraftDocument): boolean {
  return draft.sections.some((section) =>
    section.blocks.some((block) => {
      if (block.kind === 'todo') return true;
      if (block.kind === 'p' || block.kind === 'heading') return hasTodo(block.text);
      if (block.kind === 'bullet' || block.kind === 'ordered') return block.items.some(hasTodo);
      if (block.kind === 'quote') return block.lines.some(hasTodo);
      return block.rows.some((row) => row.some(hasTodo));
    }),
  );
}

function tableMarkdown(rows: readonly string[][]): string[] {
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (row: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
  const [header, ...rest] = rows;
  return [
    pad(header as string[]),
    `|${' --- |'.repeat(width)}`,
    ...rest.map((row) => pad(row)),
  ];
}

export function draftToMarkdown(draft: DraftDocument): string {
  const out: string[] = [`# ${draft.title}`, ''];
  if (draft.subtitle !== undefined && draft.subtitle !== '') out.push(draft.subtitle, '');

  for (const section of draft.sections) {
    if (section.heading !== '') out.push(`# ${section.heading}`, '');
    for (const block of section.blocks) {
      switch (block.kind) {
        case 'p':
        case 'todo':
          out.push(block.text, '');
          break;
        case 'heading':
          out.push(`${'#'.repeat(Math.min(6, block.level))} ${block.text}`, '');
          break;
        case 'bullet':
          out.push(...block.items.map((item) => `- ${item}`), '');
          break;
        case 'ordered':
          out.push(...block.items.map((item, i) => `${i + 1}. ${item}`), '');
          break;
        case 'quote':
          out.push(...block.lines.map((line) => `> ${line}`), '');
          break;
        case 'table':
          out.push(...tableMarkdown(block.rows), '');
          break;
      }
    }
  }

  if (draft.factChecklist.length > 0) {
    out.push('## Fact checklist', '');
    out.push(CHECKLIST_ACCOUNTABILITY_NOTE, '');
    out.push(CHECKLIST_SCOPE_NOTE, '');
    out.push(...draft.factChecklist.map((fact) => `- [ ] ${fact}`), '');
  }
  if (draft.disclosure !== undefined && draft.disclosure !== '') {
    out.push('## AI-use disclosure', '', draft.disclosure, '');
  }
  out.push('---', '', draft.provenanceNote, '');
  return out.join('\n');
}
