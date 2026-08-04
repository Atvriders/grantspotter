/**
 * THE APPLICATION DRAFT AS A WORD DOCUMENT — the artefact the applicant actually sends a funder.
 *
 * Spec §10.1 requires that an unknown template slot render as an explicit `[TODO: …]` and never as
 * plausible filler, because a fabricated specific is the misconduct pattern NIH and ORI enumerate.
 * That requirement does not end at the markdown: a gap that silently vanishes on the way into Word
 * is WORSE than an ugly one, because the applicant then sends a sentence that asserts nothing while
 * looking complete. So every gap — whole-line or mid-sentence — is set bold, red and highlighted,
 * and a legend above the document says what the highlight means and that the example inside the
 * brackets is not a fact about this applicant.
 *
 * Nothing here calls `stripTodoMarkers`. It exists in `templates/fill.ts` for the prose analyzer
 * and the fact checklist, and its own comment forbids exactly this use.
 */
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  CHECKLIST_ACCOUNTABILITY_NOTE,
  CHECKLIST_SCOPE_NOTE,
  TODO_LEGEND,
  type DraftBlock,
  type DraftDocument,
  draftHasTodo,
  splitRuns,
} from './draft.js';

export interface DocxOptions {
  /**
   * The instant this document was generated. Supplying it does two things: the DOCX records that
   * instant in `docProps/core.xml` instead of the wall clock, and the archive becomes BYTE-STABLE
   * for the same input, which is what lets `buildApplicationPacket` promise a diffable packet.
   *
   * Omit it and the `docx` library's own wall-clock stamp is kept and the bytes vary run to run.
   */
  generatedAtISO?: string;
}

/** Dark red. Loud in print and loud in greyscale, where a yellow highlight alone would vanish. */
const TODO_COLOR = 'B00020';
const MUTED = '555555';

interface RunStyle {
  bold?: boolean;
  italics?: boolean;
  color?: string;
  size?: number;
}

/**
 * A line of the draft as Word runs, with every `[TODO: …]` broken out into its own loud run.
 * `fillTemplate` substitutes a slot IN PLACE, so the common gap is mid-sentence; a renderer that
 * only knew whole-line gaps would set "The station operates from [TODO: club.venue — …] on campus."
 * entirely in body type.
 */
function textRuns(text: string, style: RunStyle = {}): TextRun[] {
  return splitRuns(text).map((run) =>
    run.todo
      ? new TextRun({ text: run.text, bold: true, color: TODO_COLOR, highlight: 'yellow' })
      : new TextRun({ text: run.text, ...style }),
  );
}

function paragraph(text: string, style: RunStyle = {}): Paragraph {
  return new Paragraph({ children: textRuns(text, style) });
}

function blockToDocx(block: DraftBlock): Array<Paragraph | Table> {
  switch (block.kind) {
    case 'p':
      return [paragraph(block.text)];
    case 'todo':
      return [paragraph(block.text)];
    case 'heading':
      return [
        new Paragraph({
          children: textRuns(block.text),
          heading: block.level <= 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
        }),
      ];
    case 'bullet':
      return block.items.map(
        (item) => new Paragraph({ children: textRuns(item), bullet: { level: 0 } }),
      );
    case 'ordered':
      // The number is literal text rather than a Word numbering definition. An exported draft is
      // read and edited, not appended to, and a hand-rolled numbering.xml that a later edit
      // renumbers is a worse failure than a visible "1." the applicant can retype.
      return block.items.map(
        (item, i) =>
          new Paragraph({
            children: [new TextRun({ text: `${i + 1}. ` }), ...textRuns(item)],
            indent: { left: 360 },
          }),
      );
    case 'quote':
      // Template guidance arrives as a blockquote — "Do not write: …", worked examples with
      // invented names and callsigns. Set as body text it becomes indistinguishable from the
      // applicant's own prose, so it stays visibly quoted.
      return block.lines.map(
        (line) =>
          new Paragraph({ children: textRuns(line, { italics: true, color: MUTED }), indent: { left: 720 } }),
      );
    case 'table':
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: block.rows.map(
            (row, rowIndex) =>
              new TableRow({
                children: row.map(
                  (cell) =>
                    new TableCell({
                      children: [paragraph(cell, rowIndex === 0 ? { bold: true } : {})],
                    }),
                ),
              }),
          ),
        }),
      ];
  }
}

export async function draftToDocx(draft: DraftDocument, options: DocxOptions = {}): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [
    new Paragraph({ text: draft.title, heading: HeadingLevel.TITLE }),
  ];
  if (draft.subtitle !== undefined && draft.subtitle !== '') {
    children.push(paragraph(draft.subtitle, { italics: true }));
  }
  if (draftHasTodo(draft)) {
    children.push(paragraph(TODO_LEGEND, { italics: true, color: TODO_COLOR }));
  }

  for (const section of draft.sections) {
    if (section.heading !== '') {
      children.push(new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 }));
    }
    for (const block of section.blocks) children.push(...blockToDocx(block));
  }

  if (draft.factChecklist.length > 0) {
    children.push(new Paragraph({ text: 'Fact checklist', heading: HeadingLevel.HEADING_1 }));
    children.push(paragraph(CHECKLIST_ACCOUNTABILITY_NOTE, { italics: true }));
    children.push(paragraph(CHECKLIST_SCOPE_NOTE, { italics: true }));
    for (const fact of draft.factChecklist) {
      children.push(new Paragraph({ children: [new TextRun('☐ '), ...textRuns(fact)], bullet: { level: 0 } }));
    }
  }

  if (draft.disclosure !== undefined && draft.disclosure !== '') {
    children.push(new Paragraph({ text: 'AI-use disclosure', heading: HeadingLevel.HEADING_1 }));
    children.push(paragraph(draft.disclosure));
  }

  children.push(paragraph(draft.provenanceNote, { size: 18, color: MUTED }));

  const doc = new Document({
    title: draft.title,
    description: draft.provenanceNote,
    sections: [{ children }],
  });
  const buffer = await Packer.toBuffer(doc);
  return options.generatedAtISO === undefined
    ? buffer
    : withStatedTimestamp(buffer, options.generatedAtISO);
}

/**
 * REPRODUCIBILITY, and why it has to be done by hand.
 *
 * `docx@9.7.1` builds `docProps/core.xml` with `new Date()` hard-wired into both `dcterms:created`
 * and `dcterms:modified` — `CoreProperties` accepts no date option, so two calls a second apart
 * produce different bytes, and every archive containing one inherits that. The task brief's hint
 * that the library "writes a fixed created date unless one is supplied" does not hold against this
 * version; verified by reading `node_modules/docx/dist/index.mjs` and by two runs of the packer.
 *
 * So the package is reopened, the two timestamps are replaced with the caller's stated instant,
 * and it is rewritten with a fixed archive mtime. Every other part is copied through byte for
 * byte, so this changes the document's metadata and nothing a reader sees. Directory entries are
 * dropped: they carry no data, and a ZIP without them is what every OOXML reader already handles.
 */
const CREATED_RE = /(<dcterms:created[^>]*>)[^<]*(<\/dcterms:created>)/;
const MODIFIED_RE = /(<dcterms:modified[^>]*>)[^<]*(<\/dcterms:modified>)/;
/**
 * The fixed archive mtime, just above the floor of the DOS timestamp ZIP stores.
 *
 * A STRING, AND THAT IS THE ENTIRE POINT. This was `new Date(Date.UTC(1980, 0, 2))` — one INSTANT —
 * and fflate packs the DOS stamp with `getHours()`, `getDate()` and friends, every one of them
 * LOCAL. One instant is a different wall clock in every zone, so one draft produced a different
 * document on every machine: the stamp measured 0x220000 under UTC, 0x219800 in New York, 0x224800
 * in Tokyo, and 0x216000 under Etc/GMT+12 — where the DATE half had moved too, because midnight
 * UTC on the 2nd is noon on the 1st there. The BYTE-STABILITY this function is here to provide
 * therefore held on one machine and not between two, and it carried into every packet that embeds
 * this file. A date-time string with no offset is parsed as LOCAL time, which pins those getters to
 * the same wall clock everywhere. Same fix, same reason, as `XLSX_ARCHIVE_MTIME` in `xlsx.ts`.
 *
 * The 2nd and not the 1st: fflate 0.8.3 throws "date not in range 1980-2099" below 1980, and read
 * as a local wall clock the 1st would fall back into 1979 anywhere behind UTC.
 */
const ARCHIVE_MTIME = '1980-01-02T00:00:00';

function withStatedTimestamp(buffer: Buffer, generatedAtISO: string): Buffer {
  const entries = unzipSync(new Uint8Array(buffer));
  const rewritten: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith('/')) continue;
    if (name === 'docProps/core.xml') {
      const xml = strFromU8(data)
        .replace(CREATED_RE, `$1${generatedAtISO}$2`)
        .replace(MODIFIED_RE, `$1${generatedAtISO}$2`);
      rewritten[name] = strToU8(xml);
      continue;
    }
    rewritten[name] = data;
  }
  return Buffer.from(zipSync(rewritten, { level: 6, mtime: ARCHIVE_MTIME }));
}
