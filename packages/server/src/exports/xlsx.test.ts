import { beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { DO_NOT_PUBLISH_TAG } from '../normalize/index.js';
import { programsToXlsx, OPPORTUNITIES_SHEET, PROVENANCE_SHEET, XLSX_NUMERIC_FIELDS } from './xlsx.js';
import { DEADLINE_BASIS_PROJECTED, EXPORT_FIELDS, EXPORT_FIELD_LABELS } from './rows.js';
import { makeCycle, makeFunder, makeProgram, makeSuppressedProgram } from './testFixtures.js';
import { loadExportCorpus, type ExportCorpus } from './testCorpus.js';

async function readBack(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

/** 1-based column number of a field, so no assertion hard-codes a position that can drift. */
function columnOf(field: string): number {
  return EXPORT_FIELDS.indexOf(field as (typeof EXPORT_FIELDS)[number]) + 1;
}

const CYCLES = new Map([['ardc-grants', [makeCycle()]]]);

describe('programsToXlsx', () => {
  it('produces a real xlsx (a ZIP container) with Opportunities and Provenance sheets', async () => {
    const buf = await programsToXlsx([makeProgram()], [makeFunder()], CYCLES);
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK');
    const wb = await readBack(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual([OPPORTUNITIES_SHEET, PROVENANCE_SHEET]);
  });

  it('writes the shared column vocabulary as its header, freezes it, and filters on it', async () => {
    const wb = await readBack(await programsToXlsx([makeProgram()], [makeFunder()], CYCLES));
    const sheet = wb.getWorksheet(OPPORTUNITIES_SHEET)!;
    const header = (sheet.getRow(1).values as unknown[]).slice(1);
    // The reader-facing labels, in `EXPORT_FIELDS` order. `rows.ts` states that XLSX, DOCX and
    // Markdown label the shared vocabulary with `EXPORT_FIELD_LABELS`; the CSV keeps the raw keys
    // because a parser reads it.
    expect(header).toEqual(EXPORT_FIELDS.map((f) => EXPORT_FIELD_LABELS[f]));
    const view = sheet.views[0] as { state?: string; ySplit?: number } | undefined;
    expect(view?.state).toBe('frozen');
    expect(view?.ySplit).toBe(1);
    expect(sheet.autoFilter).toBeTruthy();
    expect(sheet.getRow(1).font?.bold).toBe(true);
  });

  it('writes one data row per program, in the shared vocabulary’s order', async () => {
    const wb = await readBack(await programsToXlsx([makeProgram()], [makeFunder()], CYCLES));
    const sheet = wb.getWorksheet(OPPORTUNITIES_SHEET)!;
    expect(sheet.rowCount).toBe(2);
    expect(sheet.getCell(2, columnOf('id')).value).toBe('ardc-grants');
    expect(sheet.getCell(2, columnOf('funder')).value).toBe('Amateur Radio Digital Communications');
    expect(sheet.getCell(2, columnOf('name')).value).toBe('ARDC Grants Program');
  });

  it('writes numeric amounts as numbers, not strings, so they sum in the sheet', async () => {
    const wb = await readBack(await programsToXlsx([makeProgram()], [makeFunder()], CYCLES));
    const sheet = wb.getWorksheet(OPPORTUNITIES_SHEET)!;
    expect(sheet.getCell(2, columnOf('amountMin')).value).toBe(1285);
    expect(sheet.getCell(2, columnOf('amountMax')).value).toBe(258000);
    expect(sheet.getCell(2, columnOf('amountMin')).numFmt).toBe('#,##0');
    // A field the funder never stated must stay EMPTY, never 0. `Number('')` is 0, and a 0 in an
    // amount column is a claim ("this award is worth nothing") that no funder made.
    const noAmount = makeProgram({
      amount: { instrument: 'unknown', amountRaw: 'Not stated', awardCountRaw: 'Not stated' },
    });
    const bare = await readBack(await programsToXlsx([noAmount], [makeFunder()], new Map()));
    expect(bare.getWorksheet(OPPORTUNITIES_SHEET)!.getCell(2, columnOf('amountMin')).value).toBe(null);
  });

  it('keeps every date a TEXT cell, so no serial-number round trip can move a deadline', async () => {
    const wb = await readBack(await programsToXlsx([makeProgram()], [makeFunder()], CYCLES));
    const sheet = wb.getWorksheet(OPPORTUNITIES_SHEET)!;
    for (const field of ['nextCloses', 'nextClosesUtc', 'lastVerifiedAt']) {
      const value = sheet.getCell(2, columnOf(field)).value;
      expect(typeof value, field).toBe('string');
      expect(value instanceof Date, field).toBe(false);
    }
    expect(sheet.getCell(2, columnOf('lastVerifiedAt')).value).toBe('2026-08-02');
    // Exactly three fields are numeric; everything else, dates included, stays text.
    expect([...XLSX_NUMERIC_FIELDS].sort()).toEqual(['amountMax', 'amountMin', 'indirectCostCapPct']);
  });

  it('carries the projected-deadline wording verbatim from the shared row model', async () => {
    const wb = await readBack(
      await programsToXlsx([makeProgram()], [makeFunder()], new Map([['ardc-grants', [makeCycle({ isEstimated: true })]]])),
    );
    const sheet = wb.getWorksheet(OPPORTUNITIES_SHEET)!;
    expect(sheet.getCell(2, columnOf('deadlineBasis')).value).toBe(DEADLINE_BASIS_PROJECTED);
  });

  it('never renders an unstated obligation as "not required"', async () => {
    const wb = await readBack(await programsToXlsx([makeProgram()], [makeFunder()], CYCLES));
    const sheet = wb.getWorksheet(OPPORTUNITIES_SHEET)!;
    expect(sheet.getCell(2, columnOf('costShareRequired')).value).toBe('unstated');
  });

  it('carries lastVerifiedAt, the source URL, disputes and a stale-mirror warning to Provenance', async () => {
    const program = makeProgram({
      trust: {
        ...makeProgram().trust,
        staleMirrorWarning: 'This page mirrors a 2019 summary.',
        disputed: {
          note: 'Two funder pages disagree about the deadline.',
          claims: [{ claim: 'Closes 1 February', sourceUrl: 'https://example.com/a' }],
        },
      },
    });
    const wb = await readBack(await programsToXlsx([program], [makeFunder()], CYCLES));
    const sheet = wb.getWorksheet(PROVENANCE_SHEET)!;
    expect(sheet.getRow(1).values).toContain('Last verified');
    const values = JSON.stringify(sheet.getRow(2).values);
    expect(values).toContain('2026-08-02');
    expect(values).toContain('https://www.ardc.net/apply/');
    expect(values).toContain('seed_import');
    expect(values).toContain('Closes 1 February <https://example.com/a>');
    expect(values).toContain('This page mirrors a 2019 summary.');
  });

  it('writes the same bytes for the same input, which is what makes the proofs below bytes', async () => {
    const once = await programsToXlsx([makeProgram()], [makeFunder()], CYCLES);
    const twice = await programsToXlsx([makeProgram()], [makeFunder()], CYCLES);
    expect(once.equals(twice)).toBe(true);
  });
});

/**
 * THE SUPPRESSION BOUNDARY, PROVEN THE WAY TASK 1 PROVED IT: the workbook built from the
 * publishable set plus every suppressed record must be BYTE-IDENTICAL to the workbook built from
 * the publishable set alone. Not "contains no suppressed id" — identical. A gate that filters ids
 * but leaves a row height, a shared-string table entry or a sheet dimension behind has still let
 * the record shape out of the building, and only the bytes can say so.
 */
describe('no suppressed record can leave the building, in a workbook either', () => {
  it('is byte-identical with the suppressed fixtures appended', async () => {
    const funders = [makeFunder()];
    const clean = await programsToXlsx([makeProgram()], funders, CYCLES);
    const mixed = await programsToXlsx(
      [makeProgram(), makeSuppressedProgram(), makeSuppressedProgram({ id: 'ardc-2020-award-1' })],
      funders,
      CYCLES,
    );
    expect(mixed.equals(clean)).toBe(true);
  });
});

describe('the real corpus, as a workbook', () => {
  let corpus: ExportCorpus;
  let book: Buffer;
  let wb: ExcelJS.Workbook;

  beforeAll(async () => {
    corpus = await loadExportCorpus();
    book = await programsToXlsx(corpus.programs, corpus.funders, corpus.cyclesByProgramId);
    wb = await readBack(book);
  }, 120_000);

  it('writes one data row per publishable programme on both sheets', () => {
    expect(corpus.programs).toHaveLength(150);
    expect(wb.getWorksheet(OPPORTUNITIES_SHEET)!.rowCount).toBe(151); // header + 150
    expect(wb.getWorksheet(PROVENANCE_SHEET)!.rowCount).toBe(151);
  });

  it('is byte-identical with all 553 suppressed records handed to the writer', async () => {
    expect(corpus.suppressedPrograms).toHaveLength(553);
    const mixed = await programsToXlsx(
      [...corpus.programs, ...corpus.suppressedPrograms],
      corpus.funders,
      corpus.cyclesByProgramId,
    );
    expect(mixed.length).toBe(book.length);
    expect(mixed.equals(book)).toBe(true);
  }, 120_000);

  it('writes no suppressed id, name or tag anywhere in the sheet XML', async () => {
    const sheetXml = await readSheetXml(book);
    const publishable = new Set(corpus.programs.map((p) => p.name));
    expect(corpus.suppressedPrograms.filter((p) => sheetXml.includes(p.id)).map((p) => p.id)).toEqual([]);
    expect(
      corpus.suppressedPrograms
        .filter((p) => !publishable.has(p.name))
        .filter((p) => sheetXml.includes(p.name))
        .map((p) => p.name),
    ).toEqual([]);
    expect(sheetXml).not.toContain(DO_NOT_PUBLISH_TAG);
  });

  it('labels 4 deadlines as the funder’s own, 118 as projected, and 28 not at all', () => {
    const sheet = wb.getWorksheet(OPPORTUNITIES_SHEET)!;
    const counts: Record<string, number> = {};
    for (let r = 2; r <= sheet.rowCount; r += 1) {
      const value = String(sheet.getCell(r, columnOf('deadlineBasis')).value ?? '');
      counts[value] = (counts[value] ?? 0) + 1;
    }
    expect(counts['funder-published']).toBe(4);
    expect(counts[DEADLINE_BASIS_PROJECTED]).toBe(118);
    expect(counts['']).toBe(28);
  });

  it('carries the funder’s own calendar day, not the UTC instant’s, for the ARRL grant', () => {
    const sheet = wb.getWorksheet(OPPORTUNITIES_SHEET)!;
    let found = 0;
    for (let r = 2; r <= sheet.rowCount; r += 1) {
      const id = String(sheet.getCell(r, columnOf('id')).value ?? '');
      if (!id.startsWith('arrl-amateur-radio-grants--')) continue;
      found += 1;
      expect(sheet.getCell(r, columnOf('nextClosesUtc')).value).toBe('2026-11-01T03:59:00.000Z');
      expect(sheet.getCell(r, columnOf('nextCloses')).value).toBe('2026-10-31');
    }
    expect(found).toBe(1);
  });

  it('never renders an unstated obligation as "not required", across all 150', () => {
    const sheet = wb.getWorksheet(OPPORTUNITIES_SHEET)!;
    const counts: Record<string, number> = {};
    for (let r = 2; r <= sheet.rowCount; r += 1) {
      const value = String(sheet.getCell(r, columnOf('costShareRequired')).value ?? '');
      counts[value] = (counts[value] ?? 0) + 1;
    }
    expect(counts['unstated']).toBe(148);
    expect(counts['required']).toBe(2);
    expect(counts['not required'] ?? 0).toBe(0);
  });
});

/** The sheet XML out of the ZIP, so the leak assertions read the container, not the writer. */
async function readSheetXml(buf: Buffer): Promise<string> {
  const { unzipSync, strFromU8 } = await import('fflate');
  const files = unzipSync(new Uint8Array(buf));
  return Object.entries(files)
    .filter(([name]) => name.endsWith('.xml'))
    .map(([, bytes]) => strFromU8(bytes))
    .join('\n');
}
